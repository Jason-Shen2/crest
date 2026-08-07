// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureWorkspaceOptions, WorkspaceSnapshotStore } from "./snapshot-store";
import { encodeCanonicalStoredJson } from "./stored-manifest";
import type { WorkspacePathChangeV1, WorkspaceSnapshotCoverage, WorkspaceSnapshotRefV1 } from "./types";

export interface WorkspaceCheckpointHead {
    ref: WorkspaceSnapshotRefV1;
    coverage: WorkspaceSnapshotCoverage;
}

export interface WorkspaceOwnedTurnCapture {
    after: WorkspaceSnapshotRefV1;
    changes: WorkspacePathChangeV1[];
    coverage: WorkspaceSnapshotCoverage;
}

export interface WorkspaceCheckpointSnapshotSource {
    readHead(signal?: AbortSignal): Promise<WorkspaceCheckpointHead>;
    synchronizeExternal(signal?: AbortSignal): Promise<WorkspaceCheckpointHead>;
    captureOwnedTurn(input: {
        base: WorkspaceSnapshotRefV1;
        sessionId: string;
        turnId: string;
        signal?: AbortSignal;
    }): Promise<WorkspaceOwnedTurnCapture>;
}

export interface LegacyWorkspaceSnapshotCapture {
    capture(options: CaptureWorkspaceOptions): Promise<WorkspaceCheckpointHead>;
}

const WorkspaceSourceInitializations = new Map<string, Promise<void>>();

export async function initializeWorkspaceCheckpointSnapshotSource(input: {
    store: WorkspaceSnapshotStore;
    legacyCapture: LegacyWorkspaceSnapshotCapture;
}): Promise<WorkspaceCheckpointSnapshotSource> {
    const source = new CommitBackedWorkspaceCheckpointSnapshotSource(input.store, input.legacyCapture);
    const key = `${input.store.storeRoot}:${input.store.identity.workspaceIdentity}:${input.store.identity.workspaceIncarnation}`;
    let initialization = WorkspaceSourceInitializations.get(key);
    if (!initialization) {
        initialization = source.initialize();
        WorkspaceSourceInitializations.set(key, initialization);
        void initialization.then(
            () => {
                if (WorkspaceSourceInitializations.get(key) === initialization) {
                    WorkspaceSourceInitializations.delete(key);
                }
            },
            () => {
                if (WorkspaceSourceInitializations.get(key) === initialization) {
                    WorkspaceSourceInitializations.delete(key);
                }
            }
        );
    }
    await initialization;
    return source;
}

class CommitBackedWorkspaceCheckpointSnapshotSource implements WorkspaceCheckpointSnapshotSource {
    readonly store: WorkspaceSnapshotStore;
    readonly legacyCapture: LegacyWorkspaceSnapshotCapture;

    constructor(store: WorkspaceSnapshotStore, legacyCapture: LegacyWorkspaceSnapshotCapture) {
        this.store = store;
        this.legacyCapture = legacyCapture;
    }

    async initialize(): Promise<void> {
        const head = await this.store.mutationLog.readHead();
        if (head) {
            await this.readCommitHead(head);
            return;
        }
        const captured = await this.legacyCapture.capture({ profile: "terminal" });
        try {
            await this.appendCapturedMutation({ captured, kind: "external" });
        } catch (error) {
            const concurrentHead = await this.store.mutationLog.readHead();
            if (!concurrentHead) throw error;
            await this.readCommitHead(concurrentHead);
        }
    }

    async readHead(signal?: AbortSignal): Promise<WorkspaceCheckpointHead> {
        signal?.throwIfAborted();
        const head = await this.store.mutationLog.readHead();
        signal?.throwIfAborted();
        if (!head) throw new Error("Workspace mutation head is not initialized");
        return await this.readCommitHead(head);
    }

    async synchronizeExternal(signal?: AbortSignal): Promise<WorkspaceCheckpointHead> {
        const base = await this.readHead(signal);
        const captured = await this.legacyCapture.capture({ profile: "terminal", ...(signal ? { signal } : {}) });
        signal?.throwIfAborted();
        if (captured.ref.tree === base.ref.tree && (await this.hasEquivalentSemantics(base.ref, captured.ref))) {
            return { ref: base.ref, coverage: cloneCoverage(captured.coverage) };
        }
        return await this.appendCapturedMutation({
            expectedHead: base.ref.id,
            captured,
            kind: "external",
        });
    }

    async captureOwnedTurn(input: {
        base: WorkspaceSnapshotRefV1;
        sessionId: string;
        turnId: string;
        signal?: AbortSignal;
    }): Promise<WorkspaceOwnedTurnCapture> {
        assertNonEmpty("Session id", input.sessionId);
        assertNonEmpty("turn id", input.turnId);
        const current = await this.readHead(input.signal);
        if (current.ref.id !== input.base.id) {
            throw new Error("Workspace mutation head moved outside the active writer lease");
        }
        const captured = await this.legacyCapture.capture({
            profile: "terminal",
            ...(input.signal ? { signal: input.signal } : {}),
        });
        input.signal?.throwIfAborted();
        if (captured.ref.tree === input.base.tree && (await this.hasEquivalentSemantics(input.base, captured.ref))) {
            return { after: input.base, coverage: cloneCoverage(captured.coverage), changes: [] };
        }
        const after = await this.appendCapturedMutation({
            expectedHead: input.base.id,
            captured,
            kind: "agent-turn",
            sessionId: input.sessionId,
            turnId: input.turnId,
        });
        const changes = await this.store.diff(input.base, after.ref);
        return { after: after.ref, coverage: after.coverage, changes };
    }

    async readCommitHead(commit: string): Promise<WorkspaceCheckpointHead> {
        const ref = await this.store.readCommitSnapshot(commit);
        const metadata = await this.store.readSnapshotMetadata(ref);
        return {
            ref,
            coverage: { ...metadata.coverage, newlyHashedBytes: 0 },
        };
    }

    async hasEquivalentSemantics(left: WorkspaceSnapshotRefV1, right: WorkspaceSnapshotRefV1): Promise<boolean> {
        const [leftMetadata, rightMetadata] = await Promise.all([
            this.store.readSnapshotMetadata(left),
            this.store.readSnapshotMetadata(right),
        ]);
        return encodeCanonicalStoredJson(leftMetadata).equals(encodeCanonicalStoredJson(rightMetadata));
    }

    async appendCapturedMutation(input: {
        expectedHead?: string;
        captured: WorkspaceCheckpointHead;
        kind: "external" | "agent-turn";
        sessionId?: string;
        turnId?: string;
    }): Promise<WorkspaceCheckpointHead> {
        const metadata = await this.store.readSnapshotMetadata(input.captured.ref);
        const prepared = await this.store.mutationLog.prepare({
            ...(input.expectedHead ? { expectedHead: input.expectedHead } : {}),
            tree: input.captured.ref.tree,
            metadata: {
                schemaversion: 1,
                workspaceidentity: this.store.identity.workspaceIdentity,
                workspaceincarnation: this.store.identity.workspaceIncarnation,
                kind: input.kind,
                ...(input.sessionId ? { sessionid: input.sessionId } : {}),
                ...(input.turnId ? { turnid: input.turnId } : {}),
            },
        });
        const ref = await this.store.publishCommitSnapshot({
            commit: prepared.commit,
            scope: metadata.scope,
            coverage: metadata.coverage,
        });
        await this.store.mutationLog.publishPrepared(prepared);
        return { ref, coverage: cloneCoverage(input.captured.coverage) };
    }
}

function cloneCoverage(coverage: WorkspaceSnapshotCoverage): WorkspaceSnapshotCoverage {
    return {
        complete: coverage.complete,
        eligibleEntryCount: coverage.eligibleEntryCount,
        newlyHashedBytes: coverage.newlyHashedBytes,
        exclusions: coverage.exclusions.map((exclusion) => ({ ...exclusion })),
    };
}

function assertNonEmpty(label: string, value: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be non-empty`);
    }
}
