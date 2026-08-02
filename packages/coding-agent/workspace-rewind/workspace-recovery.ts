// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SessionTreeEntry } from "@crest/agent/harness/types";

import { removeCreatedWorkspaceDirectories } from "./created-directory-cleanup";
import { encodeDurableJson } from "./durability";
import {
    applyCapturedPath,
    reconcileInterruptedCapturedPathArtifacts,
    type WorkspacePathApplyProgress,
} from "./filesystem-apply";
import { inspectLivePath, type LiveCapturedPathState } from "./live-path-state";
import {
    PendingWorkspaceRestoreStore,
    type PendingWorkspaceRestoreV1,
    type ScannedPendingWorkspaceRestore,
} from "./pending-restore-store";
import { decodeWorkspaceStateEntry } from "./session-state";
import type { CapturedPathStateV1, WorkspaceSnapshotRefV1 } from "./types";
import { verifyCanonicalWorkspaceIdentity, type CanonicalWorkspaceIdentity } from "./workspace-identity";
import { workspaceStateFromPending } from "./workspace-restore-executor";

export interface WorkspaceRecoveryView {
    operationId: string;
    corrupt: boolean;
    message: string;
    paths: Array<{ path: string; classification?: "before" | "target" | "unknown" }>;
    allowedActions: Array<"retry" | "abandon-current" | "quarantine-corrupt">;
}

export type WorkspaceRecoveryDecision =
    | { state: "none" }
    | { state: "committed"; operationId: string }
    | { state: "not-committed"; operationId: string }
    | { state: "needs-user"; view: WorkspaceRecoveryView };

export type WorkspaceRecoveryMutationGuard = () => Promise<void>;

export interface WorkspaceRecoverySession {
    getLeafId(): Promise<string | null>;
    getEntry(id: string): Promise<SessionTreeEntry | undefined>;
}

export interface WorkspaceRecoveryStore {
    storeRoot: string;
    identity: CanonicalWorkspaceIdentity;
    readBlob(oid: string): Promise<Buffer>;
    readPathState(snapshot: WorkspaceSnapshotRefV1, path: string): Promise<CapturedPathStateV1>;
    verify(snapshot: WorkspaceSnapshotRefV1): Promise<void>;
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
        progress: WorkspacePathApplyProgress;
    }) => Promise<void>;
    verifyWorkspace?: (workspace: CanonicalWorkspaceIdentity) => Promise<void>;
    withSessionLease?: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
    assertCurrent?: () => Promise<void>;
}

interface ClassifiedPending {
    record: PendingWorkspaceRestoreV1;
    leafId: string | null;
    markerExists: boolean;
    exactMarker: boolean;
    markerFailure?: string;
    paths: Array<{
        path: PendingWorkspaceRestoreV1["paths"][number];
        classification: "before" | "target" | "unknown";
    }>;
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
    readonly withSessionLease: NonNullable<WorkspaceRecoveryOptions["withSessionLease"]>;
    readonly assertCurrent: NonNullable<WorkspaceRecoveryOptions["assertCurrent"]>;
    readonly reconcileFilesystemArtifacts: boolean;

    constructor(options: WorkspaceRecoveryOptions) {
        this.workspace = options.workspace;
        this.store = options.store;
        this.pending = options.pending ?? new PendingWorkspaceRestoreStore(options.store as never);
        this.locateSession = options.locateSession;
        this.reconcileFilesystemArtifacts = options.inspectPath == null;
        this.inspectPath =
            options.inspectPath ??
            (async (path) => capturedFromLive(await inspectLivePath(this.workspace.canonicalRoot, path)));
        this.applyPath =
            options.applyPath ??
            (async ({ operationId, path, expectedCurrent, target, progress }) => {
                await applyCapturedPath({
                    root: this.workspace.canonicalRoot,
                    path,
                    expectedCurrent,
                    target,
                    readBlob: (oid) => this.store.readBlob(oid),
                    progress: { ...progress, operationId },
                });
            });
        this.verifyWorkspace = options.verifyWorkspace ?? verifyCanonicalWorkspaceIdentity;
        this.withSessionLease = options.withSessionLease ?? (async (_sessionId, operation) => operation());
        this.assertCurrent = options.assertCurrent ?? (async () => {});
    }

    inspectPending(): Promise<WorkspaceRecoveryDecision> {
        return this.runPublic(false);
    }

    resolvePending(expectedOperationId?: string): Promise<WorkspaceRecoveryDecision> {
        return this.runPublic(true, expectedOperationId);
    }

    async resolvePendingLocked(record: PendingWorkspaceRestoreV1): Promise<WorkspaceRecoveryDecision> {
        const session = await this.locateSession(record.sessionId, record.sessionPath);
        if (!session) {
            return this.needsUser(
                record,
                undefined,
                "Owning Session is missing; keep the current workspace explicitly"
            );
        }
        return this.classifyLocked(record, session, true);
    }

    async keepCurrent(operationId: string, assertCurrent?: WorkspaceRecoveryMutationGuard): Promise<void> {
        const candidate = await this.pending.readCandidate();
        if (candidate.kind !== "valid") {
            throw new Error("Only a decoded pending restore can keep the current workspace");
        }
        this.assertOperation(candidate.record.operationId, operationId);
        const session = await this.locateSession(candidate.record.sessionId, candidate.record.sessionPath);
        const mutate = () =>
            this.withWorkspaceLock(async () => {
                const current = await this.pending.readLocked();
                if (current.kind !== "valid") throw new Error("Pending restore changed before keep current");
                this.assertOperation(current.record.operationId, operationId);
                await assertCurrent?.();
                await this.pending.resolveToAuditLocked(operationId, "keep-current");
            });
        if (!session) {
            await mutate();
            return;
        }
        await this.withSessionLease(candidate.record.sessionId, mutate);
    }

    async quarantine(operationId: string, assertCurrent?: WorkspaceRecoveryMutationGuard): Promise<void> {
        const candidate = await this.pending.readCandidate();
        if (candidate.kind !== "corrupt") throw new Error("Only a corrupt pending restore can be quarantined");
        this.assertOperation(candidate.operationId, operationId);
        await this.withWorkspaceLock(async () => {
            const current = await this.pending.readLocked();
            if (current.kind !== "corrupt") throw new Error("Pending restore changed before quarantine");
            this.assertOperation(current.operationId, operationId);
            await assertCurrent?.();
            await this.pending.resolveToAuditLocked(operationId, "quarantine");
        });
    }

    async assertWorkspaceWritable(): Promise<void> {
        const decision = await this.resolvePending();
        if (decision.state !== "needs-user") return;
        throw new WorkspaceFrozenError(decision.view.operationId, decision.view.message);
    }

    async runPublic(resolve: boolean, expectedOperationId?: string): Promise<WorkspaceRecoveryDecision> {
        const candidate = await this.pending.readCandidate();
        if (candidate.kind === "none") return { state: "none" };
        if (expectedOperationId) this.assertOperation(operationIdOf(candidate), expectedOperationId);
        if (candidate.kind === "corrupt") {
            return this.withWorkspaceLock(async () => {
                const current = await this.pending.readLocked();
                if (current.kind === "none" && expectedOperationId == null) return { state: "none" } as const;
                this.assertSameCandidate(candidate, current, expectedOperationId);
                return this.decisionForCorrupt(current as Extract<ScannedPendingWorkspaceRestore, { kind: "corrupt" }>);
            });
        }
        const session = await this.locateSession(candidate.record.sessionId, candidate.record.sessionPath);
        const classify = () =>
            this.withWorkspaceLock(async () => {
                const current = await this.pending.readLocked();
                if (current.kind === "none" && expectedOperationId == null) return { state: "none" } as const;
                this.assertSameCandidate(candidate, current, expectedOperationId);
                if (current.kind !== "valid") throw new Error("Pending restore changed before authoritative reread");
                await this.verifyWorkspace(this.workspace);
                if (!session) {
                    return this.needsUser(
                        current.record,
                        undefined,
                        "Owning Session is missing; keep the current workspace explicitly"
                    );
                }
                return this.classifyLocked(current.record, session, resolve);
            });
        if (!session) return classify();
        return this.withSessionLease(candidate.record.sessionId, classify);
    }

    async classifyLocked(
        initialRecord: PendingWorkspaceRestoreV1,
        session: WorkspaceRecoverySession,
        resolve: boolean
    ): Promise<WorkspaceRecoveryDecision> {
        let record = initialRecord;
        if (resolve && this.reconcileFilesystemArtifacts) {
            for (const item of record.paths) {
                const live = await this.inspectPath(item.path);
                if (
                    live === "unknown" ||
                    live.state === "excluded" ||
                    item.before.state === "excluded" ||
                    item.target.state === "excluded"
                ) {
                    continue;
                }
                await reconcileInterruptedCapturedPathArtifacts({
                    root: this.workspace.canonicalRoot,
                    path: item.path,
                    live,
                    desired: item.before,
                    alternate: item.target,
                    operationId: record.operationId,
                    onPathRecovered: async () => {
                        record = await this.pending.updateCreatedParentDirectoriesLocked(
                            record.operationId,
                            item.path,
                            item.createdParentDirectories
                        );
                    },
                });
            }
        }
        const classified = await this.classifyAll(record, session);
        if (classified.exactMarker && classified.paths.every((path) => path.classification === "target")) {
            if (resolve) {
                await this.verifyTargets(classified.record);
                await this.pending.removeLocked(record.operationId);
            }
            return { state: "committed", operationId: record.operationId };
        }
        const canRollback =
            !classified.markerExists &&
            classified.leafId === record.expectedSemanticLeafId &&
            classified.paths.every((path) => path.classification !== "unknown");
        if (!canRollback) {
            return this.needsUser(
                record,
                classified,
                classified.markerFailure ?? "Pending workspace restore does not match a safe terminal state"
            );
        }
        if (resolve) await this.rollback(classified);
        return { state: "not-committed", operationId: record.operationId };
    }

    async classifyAll(
        record: PendingWorkspaceRestoreV1,
        session: WorkspaceRecoverySession
    ): Promise<ClassifiedPending> {
        const leafId = await session.getLeafId();
        const entry = await session.getEntry(record.workspaceStateEntryId);
        let exactMarker = false;
        let markerFailure: string | undefined;
        if (entry) {
            try {
                exactMarker = await this.isExactMarker(record, entry, leafId);
                if (!exactMarker) markerFailure = "Session marker does not exactly match the pending restore";
            } catch (error) {
                markerFailure = error instanceof Error ? error.message : "Session marker verification failed";
            }
        }
        const paths: ClassifiedPending["paths"] = [];
        for (const path of record.paths) {
            const live = await this.inspectPath(path.path);
            paths.push({ path, classification: classifyWorkspaceRecoveryPath(live, path.before, path.target) });
        }
        return { record, leafId, markerExists: entry != null, exactMarker, markerFailure, paths };
    }

    async isExactMarker(
        record: PendingWorkspaceRestoreV1,
        entry: SessionTreeEntry,
        leafId: string | null
    ): Promise<boolean> {
        if (leafId !== record.workspaceStateEntryId) throw new Error("Session marker is not the current leaf");
        if (entry.id !== record.workspaceStateEntryId)
            throw new Error("Session marker entry ID does not match pending");
        if (entry.parentId !== record.commitParentId) throw new Error("Session marker parent does not match pending");
        const state = decodeWorkspaceStateEntry(entry);
        if (!state) throw new Error("Session marker type or payload is invalid");
        await this.store.verify(state.currentSnapshot);
        for (const path of record.paths) {
            const captured = await this.store.readPathState(state.currentSnapshot, path.path);
            if (!sameCapturedState(captured, path.target)) {
                throw new Error(
                    `Session marker snapshot does not contain target state: ${path.path} (${JSON.stringify(captured)} != ${JSON.stringify(path.target)})`
                );
            }
        }
        if (!sameDurableValue(state, workspaceStateFromPending(record, state.currentSnapshot))) {
            throw new Error("Session marker payload does not match pending");
        }
        return true;
    }

    async rollback(classified: ClassifiedPending): Promise<void> {
        let record = classified.record;
        for (const item of [...classified.paths].reverse()) {
            if (item.classification !== "target") continue;
            const currentPath = record.paths.find((path) => path.path === item.path.path)!;
            const createdParentDirectories = new Set(currentPath.createdParentDirectories);
            const persistProgress = async () => {
                record = await this.pending.updateCreatedParentDirectoriesLocked(record.operationId, currentPath.path, [
                    ...createdParentDirectories,
                ]);
            };
            await this.applyPath({
                operationId: record.operationId,
                path: currentPath.path,
                expectedCurrent: currentPath.target,
                target: currentPath.before,
                progress: {
                    operationId: record.operationId,
                    createdParentDirectories,
                    onParentDirectoryCreated: persistProgress,
                    onPathReplaced: persistProgress,
                },
            });
        }
        for (const path of record.paths) {
            const live = await this.inspectPath(path.path);
            if (classifyWorkspaceRecoveryPath(live, path.before, path.before) !== "before") {
                throw new Error(`Workspace recovery verification failed: ${path.path}`);
            }
        }
        await removeCreatedWorkspaceDirectories(
            this.workspace.canonicalRoot,
            record.paths.flatMap((path) => path.createdParentDirectories)
        );
        await this.pending.removeLocked(record.operationId);
    }

    async verifyTargets(record: PendingWorkspaceRestoreV1): Promise<void> {
        for (const path of record.paths) {
            const live = await this.inspectPath(path.path);
            if (classifyWorkspaceRecoveryPath(live, path.target, path.target) !== "before") {
                throw new Error(`Committed workspace verification failed: ${path.path}`);
            }
        }
    }

    needsUser(
        record: PendingWorkspaceRestoreV1,
        classified: ClassifiedPending | undefined,
        message: string
    ): WorkspaceRecoveryDecision {
        return {
            state: "needs-user",
            view: {
                operationId: record.operationId,
                corrupt: false,
                message,
                paths: record.paths.map((path) => ({
                    path: path.path,
                    ...(classified == null
                        ? {}
                        : {
                              classification: classified.paths.find((item) => item.path.path === path.path)!
                                  .classification,
                          }),
                })),
                allowedActions: ["retry", "abandon-current"],
            },
        };
    }

    decisionForCorrupt(
        candidate: Extract<ScannedPendingWorkspaceRestore, { kind: "corrupt" }>
    ): WorkspaceRecoveryDecision {
        return {
            state: "needs-user",
            view: {
                operationId: candidate.operationId,
                corrupt: true,
                message: candidate.message,
                paths: [],
                allowedActions: ["quarantine-corrupt"],
            },
        };
    }

    withWorkspaceLock<T>(operation: () => Promise<T>): Promise<T> {
        const guarded = async () => {
            await this.assertCurrent();
            return operation();
        };
        return this.store.withWorkspaceLock ? this.store.withWorkspaceLock(guarded) : guarded();
    }

    assertSameCandidate(
        candidate: ScannedPendingWorkspaceRestore,
        current: ScannedPendingWorkspaceRestore,
        expectedOperationId?: string
    ): void {
        if (candidate.kind === "none") throw new Error("Pending restore candidate disappeared");
        if (current.kind === "none") throw new Error("Pending restore disappeared before authoritative reread");
        const candidateId = operationIdOf(candidate);
        const currentId = operationIdOf(current);
        if (candidateId !== currentId) throw new Error("Pending restore operation changed before authoritative reread");
        if (expectedOperationId) this.assertOperation(currentId, expectedOperationId);
    }

    assertOperation(actual: string, expected: string): void {
        if (actual !== expected) throw new Error("Pending restore belongs to another operation");
    }
}

export function classifyWorkspaceRecoveryPath(
    live: CapturedPathStateV1 | "unknown",
    before: CapturedPathStateV1,
    target: CapturedPathStateV1
): "before" | "target" | "unknown" {
    if (live === "unknown" || live.state === "excluded" || before.state === "excluded" || target.state === "excluded") {
        return "unknown";
    }
    if (sameCapturedState(live, before)) return "before";
    if (sameCapturedState(live, target)) return "target";
    return "unknown";
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

function sameDurableValue(left: unknown, right: unknown): boolean {
    return encodeDurableJson(left).equals(encodeDurableJson(right));
}

function operationIdOf(candidate: Exclude<ScannedPendingWorkspaceRestore, { kind: "none" }>): string {
    return candidate.kind === "valid" ? candidate.record.operationId : candidate.operationId;
}
