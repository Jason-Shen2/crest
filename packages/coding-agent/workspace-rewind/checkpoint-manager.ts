// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes, randomUUID } from "node:crypto";

import type { AgentHarness } from "@crest/agent/harness/agent-harness";
import type {
    AgentHarnessEvent,
    Session,
    SessionTreeEntry,
    SessionUserTurnTerminalEvent,
} from "@crest/agent/harness/types";

import type { SessionMutationBarrier } from "../session-mutation-barrier";
import { PendingBoundaryStore, type PendingWorkspaceBoundaryV1 } from "./pending-boundary-store";
import type { ProcessOwnerIdentity } from "./process-owner";
import { decodeWorkspaceCheckpointEntry } from "./session-state";
import { WorkspaceSnapshotStoreError, type WorkspaceSnapshotStore } from "./snapshot-store";
import {
    WorkspaceControlCustomTypes,
    type WorkspaceCheckpointFailureCode,
    type WorkspaceCheckpointV1,
    type WorkspaceSnapshotCoverage,
    type WorkspaceSnapshotRefV1,
} from "./types";

interface ActiveBoundary {
    token: string;
    before?: WorkspaceSnapshotRefV1;
    beforeFailure?: CheckpointFailure;
    userEntryId?: string;
    pending: boolean;
}

interface CheckpointFailure {
    reasonCode: WorkspaceCheckpointFailureCode;
    message: string;
    coverage?: WorkspaceSnapshotCoverage;
}

export interface WorkspaceCheckpointManager {
    isBusy(): boolean;
    recover(): Promise<void>;
    dispose(): Promise<void>;
}

export interface WorkspaceCheckpointManagerDependencies {
    pendingStore?: PendingBoundaryStore;
    now?: () => string;
}

export function registerWorkspaceCheckpointManager(input: {
    harness: AgentHarness;
    session: Session;
    sessionId: string;
    workspaceRoot: string;
    store: WorkspaceSnapshotStore;
    mutationBarrier: SessionMutationBarrier;
    hasRunningHostedCommands: () => boolean;
    processOwner: ProcessOwnerIdentity;
    onCheckpointCommitted: () => Promise<void>;
    dependencies?: WorkspaceCheckpointManagerDependencies;
}): WorkspaceCheckpointManager {
    const pendingStore = input.dependencies?.pendingStore ?? new PendingBoundaryStore(input.store);
    const now = input.dependencies?.now ?? (() => new Date().toISOString());
    const boundaries = new Map<string, ActiveBoundary>();
    const inFlight = new Set<Promise<unknown>>();
    let disposed = false;

    const track = <T>(running: Promise<T>): Promise<T> => {
        inFlight.add(running);
        void running.then(
            () => inFlight.delete(running),
            () => inFlight.delete(running)
        );
        return running;
    };

    const run = <T>(operation: () => Promise<T>): Promise<T> => {
        if (disposed) {
            return Promise.resolve(undefined as T);
        }
        return track(input.mutationBarrier.run(operation));
    };

    const notifyCheckpointCommitted = async (): Promise<void> => {
        await input.mutationBarrier.waitForIdle();
        if (!disposed) {
            await input.onCheckpointCommitted();
        }
    };

    const runAndNotifyCheckpointCommitted = (operation: () => Promise<boolean>): Promise<void> =>
        track(
            (async () => {
                const committed = await run(operation);
                if (committed) {
                    await notifyCheckpointCommitted();
                }
            })()
        );

    const appendCheckpoint = async (checkpoint: WorkspaceCheckpointV1): Promise<void> => {
        const expectedSemanticLeafId = await input.session.getLeafId();
        const checkpointEntry: SessionTreeEntry = {
            type: "custom",
            id: randomUUID(),
            parentId: expectedSemanticLeafId,
            timestamp: now(),
            customType: WorkspaceControlCustomTypes.checkpoint,
            data: checkpoint,
        };
        await input.session.appendEntries([checkpointEntry], { expectedLeafId: expectedSemanticLeafId });
    };

    const appendUnavailable = async (turnId: string, failure: CheckpointFailure): Promise<void> => {
        await appendCheckpoint({
            schemaVersion: 1,
            status: "unavailable",
            originSessionId: input.sessionId,
            turnId,
            workspaceIdentity: input.store.identity.workspaceIdentity,
            workspaceIncarnation: input.store.identity.workspaceIncarnation,
            reasonCode: failure.reasonCode,
            message: failure.message,
            ...(failure.coverage ? { coverage: failure.coverage } : {}),
        });
    };

    const onBefore = async (boundaryToken: string): Promise<void> => {
        const boundary: ActiveBoundary = { token: boundaryToken, pending: false };
        boundaries.set(boundaryToken, boundary);
        try {
            const captured = await input.store.capture({ profile: "pre-turn" });
            boundary.before = captured.ref;
            await pendingStore.begin({
                boundaryToken,
                sessionId: input.sessionId,
                workspaceIdentity: input.store.identity.workspaceIdentity,
                workspaceIncarnation: input.store.identity.workspaceIncarnation,
                processOwner: input.processOwner,
                nonce: randomBytes(32).toString("hex"),
                before: captured.ref,
            });
            boundary.pending = true;
        } catch (error) {
            boundary.beforeFailure = classifyCheckpointFailure(error);
        }
    };

    const onCommitted = async (boundaryToken: string, userEntryId: string): Promise<void> => {
        const boundary = boundaries.get(boundaryToken);
        if (!boundary) {
            return;
        }
        boundary.userEntryId = userEntryId;
        if (!boundary.pending) {
            return;
        }
        await pendingStore.bind(boundaryToken, userEntryId);
    };

    const retirePendingAfterUnavailable = async (boundary: ActiveBoundary): Promise<void> => {
        if (!boundary.pending) {
            return;
        }
        await pendingStore.retireUnavailable(boundary.token);
    };

    const onTerminal = async (
        boundaryToken: string,
        reason: SessionUserTurnTerminalEvent["reason"]
    ): Promise<boolean> => {
        const boundary = boundaries.get(boundaryToken);
        if (!boundary) {
            return false;
        }
        try {
            if (!boundary.userEntryId) {
                if (boundary.pending) {
                    await pendingStore.retireUnbound(boundaryToken, input.processOwner);
                }
                return false;
            }
            if (boundary.beforeFailure) {
                await appendUnavailable(boundary.userEntryId, boundary.beforeFailure);
                return true;
            }
            if (!boundary.before) {
                await appendUnavailable(boundary.userEntryId, {
                    reasonCode: "corrupt_snapshot",
                    message: `Workspace checkpoint preparation did not retain a before snapshot (${reason})`,
                });
                await retirePendingAfterUnavailable(boundary);
                return true;
            }
            if (input.hasRunningHostedCommands()) {
                await appendUnavailable(boundary.userEntryId, {
                    reasonCode: "hosted_pty_running",
                    message: "A hosted PTY command was still running at the user-turn boundary",
                });
                await retirePendingAfterUnavailable(boundary);
                return true;
            }
            let captured;
            try {
                captured = await input.store.capture({ profile: "terminal" });
            } catch (error) {
                await appendUnavailable(boundary.userEntryId, classifyCheckpointFailure(error));
                await retirePendingAfterUnavailable(boundary);
                return true;
            }
            await pendingStore.recordAfter(boundaryToken, captured.ref);
            let changes;
            try {
                changes = await input.store.diff(boundary.before, captured.ref);
            } catch (error) {
                await appendUnavailable(boundary.userEntryId, classifyCheckpointFailure(error));
                await retirePendingAfterUnavailable(boundary);
                return true;
            }
            await appendCheckpoint({
                schemaVersion: 1,
                status: "available",
                originSessionId: input.sessionId,
                turnId: boundary.userEntryId,
                workspaceIdentity: input.store.identity.workspaceIdentity,
                workspaceIncarnation: input.store.identity.workspaceIncarnation,
                before: boundary.before,
                after: captured.ref,
                changes,
                coverage: captured.coverage,
            });
            await pendingStore.complete(boundaryToken);
            return true;
        } finally {
            boundaries.delete(boundaryToken);
        }
    };

    const onEvent = (event: AgentHarnessEvent): Promise<void> | undefined => {
        if (event.type === "session_before_user_turn") {
            return run(() => onBefore(event.boundaryToken));
        }
        if (event.type === "session_user_turn_committed") {
            return run(() => onCommitted(event.boundaryToken, event.userEntryId));
        }
        if (event.type === "session_user_turn_terminal") {
            return runAndNotifyCheckpointCommitted(() => onTerminal(event.boundaryToken, event.reason));
        }
        return undefined;
    };

    const unsubscribe = input.harness.subscribe(onEvent);

    return {
        isBusy: () => input.mutationBarrier.isBusy(),
        recover: () =>
            runAndNotifyCheckpointCommitted(async () => {
                let committed = false;
                const entries = await input.session.getEntries();
                const finalizedTurns = new Set(
                    entries
                        .map(decodeWorkspaceCheckpointEntry)
                        .filter((checkpoint) => checkpoint != null)
                        .map((c) => c.turnId)
                );
                const recovered = await pendingStore.recover(entries);
                for (const item of recovered) {
                    if (item.record.sessionId !== input.sessionId || item.disposition === "owner-still-live") {
                        continue;
                    }
                    if (item.disposition === "retire-unbound") {
                        await pendingStore.retireRecoveredUnbound(item.record.boundaryToken);
                        continue;
                    }
                    const userEntryId = item.record.userEntryId;
                    if (!userEntryId) {
                        continue;
                    }
                    if (!finalizedTurns.has(userEntryId)) {
                        await appendUnavailable(userEntryId, {
                            reasonCode: "process_crash_before_finalization",
                            message: "The agent process exited before the workspace checkpoint was finalized",
                        });
                        committed = true;
                    }
                    await retireRecoveredBoundary(pendingStore, item.record);
                }
                return committed;
            }),
        async dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            unsubscribe();
            await Promise.allSettled([...inFlight]);
        },
    };
}

export function makeDisabledWorkspaceCheckpointManager(): WorkspaceCheckpointManager {
    return {
        isBusy: () => false,
        recover: async () => undefined,
        dispose: async () => undefined,
    };
}

async function retireRecoveredBoundary(
    pendingStore: PendingBoundaryStore,
    record: PendingWorkspaceBoundaryV1
): Promise<void> {
    await pendingStore.retireUnavailable(record.boundaryToken);
}

function classifyCheckpointFailure(error: unknown): CheckpointFailure {
    if (error instanceof WorkspaceSnapshotStoreError) {
        return {
            reasonCode: error.code,
            message: error.message,
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
        reasonCode: "git_unavailable",
        message,
    };
}
