// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SessionTreeEntry } from "@crest/agent/harness/types";

import { encodeDurableJson } from "./durability";
import { applyCapturedPath, reconcileInterruptedCapturedPathArtifacts } from "./filesystem-apply";
import { inspectLivePath, type LiveCapturedPathState } from "./live-path-state";
import {
    PendingWorkspaceRestoreStore,
    type PendingWorkspaceRestoreV2,
    type ScannedPendingWorkspaceRestore,
} from "./pending-restore-store";
import type { WorkspaceSnapshotStore } from "./snapshot-store";
import { WorkspaceControlCustomTypes, type CapturedPathStateV1 } from "./types";
import { verifyCanonicalWorkspaceIdentity, type CanonicalWorkspaceIdentity } from "./workspace-identity";
import { deriveWorkspaceRestoreState, type DerivedWorkspaceRestoreState } from "./workspace-restore-state";
import { ProcessWorkspaceWriterLeases, type WorkspaceWriterLeaseRegistry } from "./workspace-writer-lease";

export interface WorkspaceRecoveryView {
    operationId: string;
    corrupt: boolean;
    message: string;
    paths: Array<{ path: string; classification?: "before" | "target" | "unknown" }>;
    allowedActions: Array<"retry">;
}

export type WorkspaceRecoveryDecision =
    | { state: "none" }
    | { state: "committed"; operationId: string }
    | { state: "not-committed"; operationId: string }
    | { state: "needs-user"; view: WorkspaceRecoveryView };

export interface WorkspaceRecoverySession {
    getLeafId(): Promise<string | null>;
    getEntry(id: string): Promise<SessionTreeEntry | undefined>;
    appendEntries?(entries: SessionTreeEntry[], options: { expectedLeafId: string | null }): Promise<void>;
}

export interface WorkspaceRecoveryStore {
    storeRoot: string;
    identity: CanonicalWorkspaceIdentity;
    mutationLog: Pick<WorkspaceSnapshotStore["mutationLog"], "readHead">;
    readCommitSnapshot: WorkspaceSnapshotStore["readCommitSnapshot"];
    readBlob: WorkspaceSnapshotStore["readBlob"];
    readPathState: WorkspaceSnapshotStore["readPathState"];
    withWorkspaceLock?<T>(operation: () => Promise<T>): Promise<T>;
}

export interface WorkspaceRecoveryOptions {
    workspace: CanonicalWorkspaceIdentity;
    store: WorkspaceRecoveryStore;
    pending?: PendingWorkspaceRestoreStore;
    locateSession(sessionId: string, sessionPath: string): Promise<WorkspaceRecoverySession | undefined>;
    inspectPath?: (path: string) => Promise<CapturedPathStateV1 | "unknown">;
    applyPath?: (input: {
        operationId: string;
        path: string;
        expectedCurrent: CapturedPathStateV1;
        target: CapturedPathStateV1;
    }) => Promise<void>;
    verifyWorkspace?: (workspace: CanonicalWorkspaceIdentity) => Promise<void>;
    writerLeases?: Pick<WorkspaceWriterLeaseRegistry, "acquire">;
    withSessionMutation?<T>(sessionPath: string, operation: () => Promise<T>): Promise<T>;
    assertCurrent?: () => Promise<void>;
}

interface RecoveryFacts {
    record: PendingWorkspaceRestoreV2;
    head?: string;
    derived: DerivedWorkspaceRestoreState;
}

interface ClassifiedPath {
    path: string;
    source: CapturedPathStateV1;
    planned: CapturedPathStateV1;
    classification: "before" | "target" | "unknown";
}

export class WorkspaceFrozenError extends Error {
    readonly operationId: string;

    constructor(operationId: string, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "WorkspaceFrozenError";
        this.operationId = operationId;
    }
}

export class WorkspaceRecovery {
    readonly workspace: CanonicalWorkspaceIdentity;
    readonly store: WorkspaceRecoveryStore;
    readonly pending: PendingWorkspaceRestoreStore;
    readonly locateSession: WorkspaceRecoveryOptions["locateSession"];
    readonly inspectPath: NonNullable<WorkspaceRecoveryOptions["inspectPath"]>;
    readonly applyPath: NonNullable<WorkspaceRecoveryOptions["applyPath"]>;
    readonly verifyWorkspace: NonNullable<WorkspaceRecoveryOptions["verifyWorkspace"]>;
    readonly writerLeases: Pick<WorkspaceWriterLeaseRegistry, "acquire">;
    readonly withSessionMutation: NonNullable<WorkspaceRecoveryOptions["withSessionMutation"]>;
    readonly assertCurrent: NonNullable<WorkspaceRecoveryOptions["assertCurrent"]>;
    readonly reconcileArtifacts: boolean;

    constructor(options: WorkspaceRecoveryOptions) {
        this.workspace = options.workspace;
        this.store = options.store;
        this.pending = options.pending ?? new PendingWorkspaceRestoreStore(options.store as WorkspaceSnapshotStore);
        this.locateSession = options.locateSession;
        this.reconcileArtifacts = options.inspectPath == null;
        this.inspectPath =
            options.inspectPath ??
            (async (path) => capturedFromLive(await inspectLivePath(this.workspace.canonicalRoot, path)));
        this.applyPath =
            options.applyPath ??
            (async ({ operationId, path, expectedCurrent, target }) => {
                await applyCapturedPath({
                    root: this.workspace.canonicalRoot,
                    path,
                    expectedCurrent,
                    target,
                    readBlob: (oid) => this.store.readBlob(oid),
                    progress: {
                        operationId,
                        createdParentDirectories: new Set(),
                        onPathReplaced: async () => {},
                    },
                });
            });
        this.verifyWorkspace = options.verifyWorkspace ?? verifyCanonicalWorkspaceIdentity;
        this.writerLeases = options.writerLeases ?? ProcessWorkspaceWriterLeases;
        this.withSessionMutation =
            options.withSessionMutation ??
            (async () => {
                throw new Error("Workspace recovery requires an exclusive Session mutation lease");
            });
        this.assertCurrent = options.assertCurrent ?? (async () => {});
    }

    inspectPending(): Promise<WorkspaceRecoveryDecision> {
        return this.runPublic(false);
    }

    resolvePending(expectedOperationId?: string): Promise<WorkspaceRecoveryDecision> {
        return this.runPublic(true, expectedOperationId);
    }

    resolvePendingUnderLease(record: PendingWorkspaceRestoreV2): Promise<WorkspaceRecoveryDecision> {
        return this.resolveRecord(record, true, undefined, true);
    }

    async assertWorkspaceWritable(): Promise<void> {
        const decision = await this.resolvePending();
        if (decision.state !== "needs-user") return;
        throw new WorkspaceFrozenError(decision.view.operationId, decision.view.message);
    }

    async runPublic(resolve: boolean, expectedOperationId?: string): Promise<WorkspaceRecoveryDecision> {
        const candidate = await this.pending.readCandidate();
        if (candidate.kind === "none") return { state: "none" };
        const operationId = operationIdOf(candidate);
        if (expectedOperationId && operationId !== expectedOperationId) {
            throw new Error("Pending restore belongs to another operation");
        }
        if (candidate.kind === "corrupt") return this.corruptDecision(candidate);
        if (!resolve) return this.resolveRecord(candidate.record, false, expectedOperationId);
        return this.withSessionMutation(candidate.record.sessionPath, async () => {
            const lease = await this.writerLeases.acquire({
                workspaceKey: `${this.workspace.workspaceIdentity}:${this.workspace.workspaceIncarnation}`,
                sessionId: candidate.record.sessionId,
                boundaryToken: `recovery-${candidate.record.operationId}`,
            });
            try {
                return await this.resolveRecord(candidate.record, resolve, expectedOperationId, true);
            } finally {
                lease.release();
            }
        });
    }

    async resolveRecord(
        candidate: PendingWorkspaceRestoreV2,
        resolve: boolean,
        expectedOperationId?: string,
        sessionMutationHeld = false
    ): Promise<WorkspaceRecoveryDecision> {
        const facts = await this.readFacts(candidate, expectedOperationId);
        if (!facts) return { state: "none" };
        if (facts.head === facts.record.sourceCommit) {
            if (resolve) await this.reconcileInterruptedArtifacts(facts);
            const paths = await this.classifyPaths(facts);
            if (paths.some((path) => path.classification === "unknown")) {
                return this.needsUser(facts.record, paths, "Workspace paths do not match either restore commit");
            }
            if (resolve) {
                await this.restoreSourcePaths(facts.record, paths);
                await this.verifyClassifications(facts, "before");
                await this.clearPending(facts.record, facts.record.sourceCommit);
            }
            return { state: "not-committed", operationId: facts.record.operationId };
        }
        if (facts.head === facts.record.plannedCommit) {
            if (resolve && !sessionMutationHeld) {
                throw new Error("Planned workspace recovery requires an exclusive Session mutation lease");
            }
            return this.completePlanned(facts, resolve);
        }
        const paths = await this.classifyPaths(facts);
        return this.needsUser(facts.record, paths, "Workspace mutation head does not match the pending restore");
    }

    async completePlanned(facts: RecoveryFacts, resolve: boolean): Promise<WorkspaceRecoveryDecision> {
        if (resolve) await this.reconcileInterruptedArtifacts(facts);
        const paths = await this.classifyPaths(facts);
        if (paths.some((path) => path.classification !== "target")) {
            return this.needsUser(facts.record, paths, "Published restore commit does not match live paths");
        }
        const marker = await this.classifyMarker(facts);
        if (marker === "unknown") {
            return this.needsUser(facts.record, paths, "Session leaf does not match the pending restore");
        }
        if (resolve) {
            if (marker === "expected") await this.appendMarker(facts);
            await this.verifyExactMarker(facts);
            await this.verifyClassifications(facts, "target");
            await this.clearPending(facts.record, facts.record.plannedCommit);
        }
        return { state: "committed", operationId: facts.record.operationId };
    }

    async readFacts(
        candidate: PendingWorkspaceRestoreV2,
        expectedOperationId?: string
    ): Promise<RecoveryFacts | undefined> {
        return this.withWorkspaceLock(async () => {
            await this.assertCurrent();
            const current = await this.pending.readLocked();
            if (current.kind === "none" && expectedOperationId == null) return undefined;
            if (current.kind !== "valid" || current.record.operationId !== candidate.operationId) {
                throw new Error("Pending restore operation changed before authoritative reread");
            }
            if (expectedOperationId && current.record.operationId !== expectedOperationId) {
                throw new Error("Pending restore belongs to another operation");
            }
            await this.verifyWorkspace(this.workspace);
            const [head, derived] = await Promise.all([
                this.store.mutationLog.readHead(),
                deriveWorkspaceRestoreState(this.store as never, current.record),
            ]);
            return { record: current.record, head, derived };
        });
    }

    async reconcileInterruptedArtifacts(facts: RecoveryFacts): Promise<void> {
        if (!this.reconcileArtifacts) return;
        const desired = facts.head === facts.record.plannedCommit ? facts.derived.plannedStates : facts.derived.sourceStates;
        const alternate = facts.head === facts.record.plannedCommit ? facts.derived.sourceStates : facts.derived.plannedStates;
        for (let index = 0; index < facts.record.affectedPaths.length; index++) {
            const live = await this.inspectPath(facts.record.affectedPaths[index]!);
            if (live === "unknown" || live.state === "excluded") continue;
            await reconcileInterruptedCapturedPathArtifacts({
                root: this.workspace.canonicalRoot,
                path: facts.record.affectedPaths[index]!,
                live,
                desired: desired[index]!.state,
                alternate: alternate[index]!.state,
                operationId: facts.record.operationId,
                onPathRecovered: async () => {},
            });
        }
    }

    async classifyPaths(facts: RecoveryFacts): Promise<ClassifiedPath[]> {
        const paths: ClassifiedPath[] = [];
        for (let index = 0; index < facts.record.affectedPaths.length; index++) {
            const path = facts.record.affectedPaths[index]!;
            const source = facts.derived.sourceStates[index]!.state;
            const planned = facts.derived.plannedStates[index]!.state;
            const live = await this.inspectPath(path);
            paths.push({ path, source, planned, classification: classifyWorkspaceRecoveryPath(live, source, planned) });
        }
        return paths;
    }

    async restoreSourcePaths(record: PendingWorkspaceRestoreV2, paths: ClassifiedPath[]): Promise<void> {
        for (const path of [...paths].reverse()) {
            if (path.classification !== "target") continue;
            await this.applyPath({
                operationId: record.operationId,
                path: path.path,
                expectedCurrent: path.planned,
                target: path.source,
            });
        }
    }

    async classifyMarker(facts: RecoveryFacts): Promise<"expected" | "exact" | "unknown"> {
        const session = await this.locateSession(facts.record.sessionId, facts.record.sessionPath);
        if (!session) return "unknown";
        const leaf = await session.getLeafId();
        if (leaf === facts.record.expectedSemanticLeafId) return "expected";
        if (leaf !== facts.record.workspaceStateEntryId) return "unknown";
        return (await this.isExactMarker(facts, session)) ? "exact" : "unknown";
    }

    async appendMarker(facts: RecoveryFacts): Promise<void> {
        const session = await this.locateSession(facts.record.sessionId, facts.record.sessionPath);
        if (!session?.appendEntries) {
            throw new Error("Owning Session cannot append the pending restore marker");
        }
        await session.appendEntries([makeMarkerEntry(facts)], {
            expectedLeafId: facts.record.expectedSemanticLeafId,
        });
    }

    async verifyExactMarker(facts: RecoveryFacts): Promise<void> {
        const session = await this.locateSession(facts.record.sessionId, facts.record.sessionPath);
        if (!session || !(await this.isExactMarker(facts, session))) {
            throw new Error("Pending restore Session marker is not exact");
        }
    }

    async isExactMarker(facts: RecoveryFacts, session: WorkspaceRecoverySession): Promise<boolean> {
        if ((await session.getLeafId()) !== facts.record.workspaceStateEntryId) return false;
        const entry = await session.getEntry(facts.record.workspaceStateEntryId);
        return entry != null && encodeDurableJson(entry).equals(encodeDurableJson(makeMarkerEntry(facts)));
    }

    async verifyClassifications(facts: RecoveryFacts, expected: "before" | "target"): Promise<void> {
        const classified = await this.classifyPaths(facts);
        if (classified.some((path) => path.classification !== expected)) {
            throw new Error("Workspace restore verification no longer matches its commit facts");
        }
    }

    async clearPending(record: PendingWorkspaceRestoreV2, expectedHead: string): Promise<void> {
        await this.withWorkspaceLock(async () => {
            const current = await this.pending.readLocked();
            if (current.kind !== "valid" || current.record.operationId !== record.operationId) {
                throw new Error("Pending restore changed before cleanup");
            }
            if ((await this.store.mutationLog.readHead()) !== expectedHead) {
                throw new Error("Workspace mutation head changed before pending cleanup");
            }
            await this.pending.removeLocked(record.operationId);
        });
    }

    needsUser(record: PendingWorkspaceRestoreV2, paths: ClassifiedPath[], message: string): WorkspaceRecoveryDecision {
        return {
            state: "needs-user",
            view: {
                operationId: record.operationId,
                corrupt: false,
                message,
                paths: paths.map((path) => ({ path: path.path, classification: path.classification })),
                allowedActions: ["retry"],
            },
        };
    }

    corruptDecision(
        candidate: Extract<ScannedPendingWorkspaceRestore, { kind: "corrupt" }>
    ): WorkspaceRecoveryDecision {
        return {
            state: "needs-user",
            view: {
                operationId: candidate.operationId,
                corrupt: true,
                message: candidate.message,
                paths: [],
                allowedActions: ["retry"],
            },
        };
    }

    withWorkspaceLock<T>(operation: () => Promise<T>): Promise<T> {
        return this.store.withWorkspaceLock ? this.store.withWorkspaceLock(operation) : operation();
    }
}

export function classifyWorkspaceRecoveryPath(
    live: CapturedPathStateV1 | "unknown",
    source: CapturedPathStateV1,
    planned: CapturedPathStateV1
): "before" | "target" | "unknown" {
    if (
        live === "unknown" ||
        live.state === "excluded" ||
        source.state === "excluded" ||
        planned.state === "excluded"
    ) {
        return "unknown";
    }
    if (sameCapturedState(live, source)) return "before";
    if (sameCapturedState(live, planned)) return "target";
    return "unknown";
}

function makeMarkerEntry(facts: RecoveryFacts): SessionTreeEntry {
    return {
        type: "custom",
        id: facts.record.workspaceStateEntryId,
        parentId: facts.record.commitParentId,
        timestamp: facts.record.workspaceStateTimestamp,
        customType: WorkspaceControlCustomTypes.state,
        data: facts.derived.markerState,
    };
}

function capturedFromLive(live: LiveCapturedPathState): CapturedPathStateV1 | "unknown" {
    if (live.state === "absent") return { state: "absent" };
    if (live.state === "file") return { state: "file", oid: live.oid, executable: live.executable };
    if (live.state === "symlink") return { state: "symlink", oid: live.oid };
    return "unknown";
}

function sameCapturedState(left: CapturedPathStateV1, right: CapturedPathStateV1): boolean {
    if (left.state !== right.state) return false;
    if (left.state === "file" && right.state === "file") {
        return left.oid === right.oid && left.executable === right.executable;
    }
    if (left.state === "symlink" && right.state === "symlink") return left.oid === right.oid;
    if (left.state === "excluded" && right.state === "excluded") return left.reason === right.reason;
    return true;
}

function operationIdOf(candidate: Exclude<ScannedPendingWorkspaceRestore, { kind: "none" }>): string {
    return candidate.kind === "valid" ? candidate.record.operationId : candidate.operationId;
}
