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
import type { WorkspaceCheckpointHead, WorkspaceCheckpointSnapshotSource } from "./snapshot-source";
import { WorkspaceSnapshotStoreError, type WorkspaceSnapshotStore } from "./snapshot-store";
import {
    WorkspaceControlCustomTypes,
    type WorkspaceCheckpointFailureCode,
    type WorkspaceCheckpointV1,
    type WorkspaceSnapshotCoverage,
} from "./types";
import { ProcessWorkspaceWriterLeases, type WorkspaceWriterLease } from "./workspace-writer-lease";

const ReadOnlyWorkspaceTools = new Set(["read", "grep", "find", "ls", "web_fetch"]);
interface ActiveBoundary {
    token: string;
    userEntryId?: string;
    base?: WorkspaceCheckpointHead;
    lease?: WorkspaceWriterLease;
    acquisition?: Promise<void>;
    acquisitionFailure?: unknown;
    beforeFailure?: CheckpointFailure;
    pending: boolean;
    pendingBound: boolean;
    controller: AbortController;
}

interface CheckpointFailure {
    reasonCode: WorkspaceCheckpointFailureCode;
    message: string;
    coverage?: WorkspaceSnapshotCoverage;
}

interface WorkspaceWriterLeaseAccess {
    acquire(input: {
        workspaceKey: string;
        sessionId: string;
        boundaryToken: string;
        signal?: AbortSignal;
    }): Promise<WorkspaceWriterLease>;
}

export interface WorkspaceCheckpointManager {
    isBusy(): boolean;
    beforeWorkspaceTool(toolName: string, signal?: AbortSignal): Promise<void>;
    beforeHostedCommand(signal?: AbortSignal): Promise<void>;
    recover(): Promise<void>;
    dispose(): Promise<void>;
}

export interface WorkspaceCheckpointManagerDependencies {
    pendingStore?: PendingBoundaryStore;
    writerLeases?: WorkspaceWriterLeaseAccess;
    now?: () => string;
}

export function registerWorkspaceCheckpointManager(input: {
    harness: AgentHarness;
    session: Session;
    sessionId: string;
    workspaceRoot: string;
    store: WorkspaceSnapshotStore;
    snapshotSource: WorkspaceCheckpointSnapshotSource;
    mutationBarrier: SessionMutationBarrier;
    hasRunningHostedCommands: () => boolean;
    processOwner: ProcessOwnerIdentity;
    onCheckpointCommitted: () => Promise<void>;
    dependencies?: WorkspaceCheckpointManagerDependencies;
}): WorkspaceCheckpointManager {
    const pendingStore = input.dependencies?.pendingStore ?? new PendingBoundaryStore(input.store);
    const writerLeases = input.dependencies?.writerLeases ?? ProcessWorkspaceWriterLeases;
    const now = input.dependencies?.now ?? (() => new Date().toISOString());
    const boundaries = new Map<string, ActiveBoundary>();
    const inFlight = new Set<Promise<unknown>>();
    const workspaceKey = `${input.store.identity.workspaceIdentity}:${input.store.identity.workspaceIncarnation}`;
    let activeBoundaryToken: string | undefined;
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
        if (disposed) return Promise.resolve(undefined as T);
        return track(input.mutationBarrier.run(operation));
    };

    const notifyCheckpointCommitted = async (): Promise<void> => {
        await input.mutationBarrier.waitForIdle();
        if (!disposed) await input.onCheckpointCommitted();
    };

    const runAndNotifyCheckpointCommitted = (operation: () => Promise<boolean>): Promise<void> =>
        track(
            (async () => {
                const committed = await run(operation);
                if (committed) await notifyCheckpointCommitted();
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

    const retireFailedPending = async (boundary: ActiveBoundary): Promise<void> => {
        if (!boundary.pending) return;
        if (boundary.pendingBound) {
            await pendingStore.retireUnavailable(boundary.token);
        } else {
            await pendingStore.retireUnbound(boundary.token, input.processOwner);
        }
        boundary.pending = false;
    };

    const acquireBoundary = async (boundary: ActiveBoundary, signal?: AbortSignal): Promise<void> => {
        if (boundary.acquisitionFailure) throw boundary.acquisitionFailure;
        if (boundary.lease && boundary.base) return;
        if (boundary.acquisition) return await boundary.acquisition;
        const acquisitionSignal = linkAbortSignal(boundary.controller, signal);
        const acquisition = (async () => {
            let lease: WorkspaceWriterLease | undefined;
            try {
                lease = await writerLeases.acquire({
                    workspaceKey,
                    sessionId: input.sessionId,
                    boundaryToken: boundary.token,
                    signal: acquisitionSignal,
                });
                boundary.lease = lease;
                boundary.base = await input.snapshotSource.synchronizeExternal(acquisitionSignal);
                await pendingStore.begin({
                    boundaryToken: boundary.token,
                    sessionId: input.sessionId,
                    workspaceIdentity: input.store.identity.workspaceIdentity,
                    workspaceIncarnation: input.store.identity.workspaceIncarnation,
                    processOwner: input.processOwner,
                    nonce: randomBytes(32).toString("hex"),
                    before: boundary.base.ref,
                });
                boundary.pending = true;
                if (boundary.userEntryId) {
                    await pendingStore.bind(boundary.token, boundary.userEntryId);
                    boundary.pendingBound = true;
                }
            } catch (error) {
                let failure = error;
                if (boundary.pending && !boundary.pendingBound) {
                    try {
                        await retireFailedPending(boundary);
                    } catch (cleanupError) {
                        failure = new AggregateError(
                            [error, cleanupError],
                            "Workspace writer acquisition and pending-boundary cleanup failed"
                        );
                    }
                }
                boundary.acquisitionFailure = failure;
                boundary.beforeFailure = classifyCheckpointFailure(failure);
                if (boundary.lease === lease) boundary.lease = undefined;
                lease?.release();
                throw failure;
            }
        })();
        boundary.acquisition = acquisition;
        try {
            await acquisition;
        } finally {
            if (boundary.acquisition === acquisition) boundary.acquisition = undefined;
        }
    };

    const releaseBoundary = (boundary: ActiveBoundary): void => {
        const lease = boundary.lease;
        boundary.lease = undefined;
        lease?.release();
    };

    const onBefore = async (boundaryToken: string): Promise<void> => {
        const existing = boundaries.get(boundaryToken);
        if (existing) {
            existing.controller.abort(new Error("Duplicate user-turn boundary"));
            releaseBoundary(existing);
        }
        boundaries.set(boundaryToken, {
            token: boundaryToken,
            pending: false,
            pendingBound: false,
            controller: new AbortController(),
        });
        activeBoundaryToken = boundaryToken;
    };

    const onCommitted = async (boundaryToken: string, userEntryId: string): Promise<void> => {
        const boundary = boundaries.get(boundaryToken);
        if (!boundary) return;
        boundary.userEntryId = userEntryId;
        if (boundary.pending) {
            try {
                await pendingStore.bind(boundaryToken, userEntryId);
                boundary.pendingBound = true;
            } catch (error) {
                boundary.acquisitionFailure = error;
                boundary.beforeFailure = classifyCheckpointFailure(error);
                releaseBoundary(boundary);
                await retireFailedPending(boundary);
                throw error;
            }
        }
    };

    const onTerminal = async (
        boundaryToken: string,
        reason: SessionUserTurnTerminalEvent["reason"]
    ): Promise<boolean> => {
        const boundary = boundaries.get(boundaryToken);
        if (!boundary) return false;
        let retirementAttempted = false;
        const retirePending = async (): Promise<void> => {
            retirementAttempted = true;
            await retireFailedPending(boundary);
        };
        try {
            if (!boundary.userEntryId) {
                await retirePending();
                return false;
            }
            if (boundary.beforeFailure) {
                await appendUnavailable(boundary.userEntryId, boundary.beforeFailure);
                await retirePending();
                return true;
            }
            if (input.hasRunningHostedCommands()) {
                await appendUnavailable(boundary.userEntryId, {
                    reasonCode: "hosted_pty_running",
                    message: "A hosted PTY command was still running at the user-turn boundary",
                });
                await retirePending();
                return true;
            }
            if (!boundary.lease) {
                try {
                    const current = await input.snapshotSource.readHead();
                    await appendCheckpoint({
                        schemaVersion: 1,
                        status: "available",
                        originSessionId: input.sessionId,
                        turnId: boundary.userEntryId,
                        workspaceIdentity: input.store.identity.workspaceIdentity,
                        workspaceIncarnation: input.store.identity.workspaceIncarnation,
                        before: current.ref,
                        after: current.ref,
                        changes: [],
                        coverage: current.coverage,
                    });
                } catch (error) {
                    await appendUnavailable(boundary.userEntryId, classifyCheckpointFailure(error));
                }
                return true;
            }
            if (!boundary.base) {
                await appendUnavailable(boundary.userEntryId, {
                    reasonCode: "corrupt_snapshot",
                    message: `Workspace writer acquisition did not retain a base checkpoint (${reason})`,
                });
                await retirePending();
                return true;
            }
            let captured;
            try {
                captured = await input.snapshotSource.captureOwnedTurn({
                    base: boundary.base.ref,
                    sessionId: input.sessionId,
                    turnId: boundary.userEntryId,
                });
            } catch (error) {
                await appendUnavailable(boundary.userEntryId, classifyCheckpointFailure(error));
                await retirePending();
                return true;
            }
            if (boundary.pending) await pendingStore.recordAfter(boundaryToken, captured.after);
            await appendCheckpoint({
                schemaVersion: 1,
                status: "available",
                originSessionId: input.sessionId,
                turnId: boundary.userEntryId,
                workspaceIdentity: input.store.identity.workspaceIdentity,
                workspaceIncarnation: input.store.identity.workspaceIncarnation,
                before: boundary.base.ref,
                after: captured.after,
                changes: captured.changes,
                coverage: captured.coverage,
            });
            if (boundary.pending) {
                await pendingStore.complete(boundaryToken);
                boundary.pending = false;
            }
            return true;
        } catch (error) {
            let failure = error;
            if (boundary.pending && !retirementAttempted) {
                try {
                    await retirePending();
                } catch (cleanupError) {
                    failure = new AggregateError(
                        [error, cleanupError],
                        "Workspace checkpoint persistence and pending-boundary cleanup failed"
                    );
                }
            }
            throw failure;
        } finally {
            releaseBoundary(boundary);
            if (!boundary.pending) boundaries.delete(boundaryToken);
            if (activeBoundaryToken === boundaryToken) activeBoundaryToken = undefined;
        }
    };

    const onEvent = (event: AgentHarnessEvent): Promise<void> | undefined => {
        if (event.type === "session_before_user_turn") return run(() => onBefore(event.boundaryToken));
        if (event.type === "session_user_turn_committed") {
            return run(() => onCommitted(event.boundaryToken, event.userEntryId));
        }
        if (event.type === "session_user_turn_terminal") {
            return runAndNotifyCheckpointCommitted(() => onTerminal(event.boundaryToken, event.reason));
        }
        return undefined;
    };

    const beforeWritingOperation = (signal?: AbortSignal): Promise<void> => {
        if (disposed) return Promise.reject(new Error("Workspace checkpoint manager is disposed"));
        return run(async () => {
            const boundary = activeBoundaryToken ? boundaries.get(activeBoundaryToken) : undefined;
            if (!boundary) throw new Error("Workspace-capable tool requires an active user-turn boundary");
            await acquireBoundary(boundary, signal);
        });
    };

    const unsubscribe = input.harness.subscribe(onEvent);

    return {
        isBusy: () =>
            input.mutationBarrier.isBusy() ||
            [...boundaries.values()].some((boundary) => boundary.acquisition != null || boundary.lease != null),
        beforeWorkspaceTool: (toolName, signal) => {
            if (ReadOnlyWorkspaceTools.has(toolName)) return Promise.resolve();
            return beforeWritingOperation(signal);
        },
        beforeHostedCommand: beforeWritingOperation,
        recover: () =>
            runAndNotifyCheckpointCommitted(async () => {
                let committed = false;
                const entries = await input.session.getEntries();
                const finalizedTurns = new Set(
                    entries
                        .map(decodeWorkspaceCheckpointEntry)
                        .filter((checkpoint) => checkpoint != null)
                        .map((checkpoint) => checkpoint.turnId)
                );
                const recovered = await pendingStore.recover(entries);
                for (const item of recovered) {
                    if (item.record.sessionId !== input.sessionId || item.disposition === "owner-still-live") continue;
                    if (item.disposition === "retire-unbound") {
                        await pendingStore.retireRecoveredUnbound(item.record.boundaryToken);
                        continue;
                    }
                    const userEntryId = item.record.userEntryId;
                    if (!userEntryId) continue;
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
            const firstDisposal = !disposed;
            disposed = true;
            if (firstDisposal) {
                unsubscribe();
                for (const boundary of boundaries.values()) {
                    boundary.controller.abort(new Error("Workspace checkpoint manager disposed"));
                }
                await Promise.allSettled([...inFlight]);
            }
            const failures: unknown[] = [];
            for (const [boundaryToken, boundary] of boundaries) {
                try {
                    await retireFailedPending(boundary);
                } catch (error) {
                    failures.push(error);
                }
                try {
                    releaseBoundary(boundary);
                } catch (error) {
                    failures.push(error);
                }
                if (!boundary.pending) boundaries.delete(boundaryToken);
            }
            activeBoundaryToken = undefined;
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
                throw new AggregateError(failures, "Workspace checkpoint manager disposal failed");
            }
        },
    };
}

export function makeDisabledWorkspaceCheckpointManager(): WorkspaceCheckpointManager {
    return {
        isBusy: () => false,
        beforeWorkspaceTool: async () => undefined,
        beforeHostedCommand: async () => undefined,
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
        return { reasonCode: error.code, message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { reasonCode: "git_unavailable", message };
}

function linkAbortSignal(controller: AbortController, signal?: AbortSignal): AbortSignal {
    if (!signal) return controller.signal;
    if (signal.aborted) controller.abort(signal.reason);
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    return controller.signal;
}
