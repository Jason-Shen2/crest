// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, Session, SessionTreeEntry } from "@crest/agent/harness/types";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { assertRestorePlanMatchesConfirmation, type ConfirmedRestorePlanV1 } from "./confirmation-token";
import { encodeDurableJson } from "./durability";
import { applyCapturedPath, verifyCapturedPath } from "./filesystem-apply";
import { inspectLivePaths, type LiveCapturedPathState } from "./live-path-state";
import { PendingWorkspaceRestoreStore, type PendingWorkspaceRestoreV2 } from "./pending-restore-store";
import type { RestorePlanV1 } from "./restore-plan";
import type { WorkspaceRewindCommitResult } from "./rewind-engine";
import { foldWorkspaceSessionState } from "./session-state";
import { ShadowWorkspaceIndex } from "./shadow-workspace-index";
import type { WorkspaceSnapshotStore } from "./snapshot-store";
import { WorkspaceControlCustomTypes, type CapturedPathStateV1, type WorkspaceSnapshotRefV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import { WorkspaceFrozenError, type WorkspaceRecovery } from "./workspace-recovery";
import {
    deriveWorkspaceRestoreState,
    makeWorkspaceRestoreState,
    type RestorableCapturedPathState,
} from "./workspace-restore-state";

type ApplyPath = typeof applyCapturedPath;
type VerifyPath = typeof verifyCapturedPath;

export interface WorkspaceRestoreCommitStrategy {
    makeResult(input: {
        entries: SessionTreeEntry[];
        folded: ReturnType<typeof foldWorkspaceSessionState>;
        sessionMetadata: JsonlSessionMetadata;
    }): WorkspaceRewindCommitResult;
}

export interface WorkspaceRestoreTiming {
    outcome: "committed" | "failed";
    pathCount: number;
    totalMs: number;
    prepareCommitMs: number;
    pendingPublishMs: number;
    applyFilesMs: number;
    verifyFilesMs: number;
    publishHeadMs: number;
    appendMarkerMs: number;
    pendingCleanupMs: number;
}

type WorkspaceRestorePhase = Exclude<keyof WorkspaceRestoreTiming, "outcome" | "pathCount" | "totalMs">;

export interface WorkspaceRestoreExecutorOptions {
    store: WorkspaceSnapshotStore;
    pending?: PendingWorkspaceRestoreStore;
    recovery: Pick<WorkspaceRecovery, "resolvePendingUnderLease">;
    inspectLivePaths?: (paths: readonly string[]) => Promise<ReadonlyMap<string, LiveCapturedPathState>>;
    applyPath?: ApplyPath;
    verifyPath?: VerifyPath;
    createOperationId?: () => string;
    now?: () => Date;
    onCommitted?: (sessionId: string, operationId: string) => Promise<void>;
    onTiming?: (timing: WorkspaceRestoreTiming) => void;
}

export interface ExecuteWorkspaceRestoreInput {
    session: Session<JsonlSessionMetadata>;
    workspace: CanonicalWorkspaceIdentity;
    source: WorkspaceSnapshotRefV1;
    plan: RestorePlanV1;
    confirmation: ConfirmedRestorePlanV1;
    mode: "normal" | "force-drift";
    assertCurrent?: () => Promise<void>;
    commit: WorkspaceRestoreCommitStrategy;
}

export async function workspaceStateFromPending(
    store: Pick<WorkspaceSnapshotStore, "readCommitSnapshot" | "readPathState">,
    pending: PendingWorkspaceRestoreV2
) {
    return (await deriveWorkspaceRestoreState(store, pending)).markerState;
}

export class WorkspaceRestoreExecutor {
    readonly store: WorkspaceSnapshotStore;
    readonly pending: PendingWorkspaceRestoreStore;
    readonly recovery: WorkspaceRestoreExecutorOptions["recovery"];
    readonly inspectPaths: NonNullable<WorkspaceRestoreExecutorOptions["inspectLivePaths"]>;
    readonly applyPath: ApplyPath;
    readonly verifyPath: VerifyPath;
    readonly applyPathIncludesVerification: boolean;
    readonly createOperationId: () => string;
    readonly now: () => Date;
    readonly onCommitted: NonNullable<WorkspaceRestoreExecutorOptions["onCommitted"]>;
    readonly onTiming: NonNullable<WorkspaceRestoreExecutorOptions["onTiming"]>;

    constructor(options: WorkspaceRestoreExecutorOptions) {
        this.store = options.store;
        this.pending = options.pending ?? new PendingWorkspaceRestoreStore(options.store);
        this.recovery = options.recovery;
        this.inspectPaths =
            options.inspectLivePaths ?? ((paths) => inspectLivePaths(this.store.identity.canonicalRoot, paths));
        this.applyPath = options.applyPath ?? applyCapturedPath;
        this.verifyPath = options.verifyPath ?? verifyCapturedPath;
        this.applyPathIncludesVerification =
            (options.applyPath == null || options.applyPath === applyCapturedPath) && options.verifyPath == null;
        this.createOperationId = options.createOperationId ?? randomUUID;
        this.now = options.now ?? (() => new Date());
        this.onCommitted = options.onCommitted ?? (async () => {});
        this.onTiming = options.onTiming ?? (() => {});
    }

    async execute(input: ExecuteWorkspaceRestoreInput): Promise<WorkspaceRewindCommitResult> {
        this.assertWorkspace(input.workspace);
        const started = performance.now();
        const timing = makeEmptyTiming(input.plan.paths.length);
        try {
            const committed = await this.executeUnderLease(input, timing);
            timing.outcome = "committed";
            try {
                await this.onCommitted(input.plan.sessionId, committed.operationId);
            } catch (error) {
                console.warn("Workspace restore committed but renderer refresh failed", error);
            }
            return this.makeResult(input, committed.sessionMetadata);
        } finally {
            timing.totalMs = performance.now() - started;
            try {
                this.onTiming(timing);
            } catch (error) {
                console.warn("Workspace restore timing observer failed", error);
            }
        }
    }

    async executeUnderLease(
        input: ExecuteWorkspaceRestoreInput,
        timing = makeEmptyTiming(input.plan.paths.length)
    ): Promise<{ sessionMetadata: JsonlSessionMetadata; operationId: string }> {
        const assertCurrent = input.assertCurrent ?? (async () => {});
        await assertCurrent();
        assertRestorePlanMatchesConfirmation({ confirmation: input.confirmation, plan: input.plan, mode: input.mode });
        this.store.assertSnapshotIdentity(input.source);
        if ((await this.store.mutationLog.readHead()) !== input.source.id) {
            throw new Error("Workspace mutation head moved before restore execution");
        }
        const orderedPaths = [...input.plan.paths].sort((left, right) => comparePathBytes(left.path, right.path));
        const forcedPaths =
            input.mode === "force-drift"
                ? orderedPaths.filter((path) => path.conflict === "forceable-drift").map((path) => path.path)
                : [];
        const sourceStates = new Map<string, RestorableCapturedPathState>();
        const capturedSourceStates =
            input.mode === "force-drift"
                ? await this.store.readPathStates(
                      input.source,
                      orderedPaths.map((path) => path.path)
                  )
                : new Map(orderedPaths.map((path) => [path.path, path.expectedCurrent]));
        for (const path of orderedPaths) {
            const state = capturedSourceStates.get(path.path)!;
            if (state.state === "excluded") {
                throw new Error(`Source commit excludes a restore path: ${path.path}`);
            }
            sourceStates.set(path.path, state);
        }
        await this.verifySourceStates(orderedPaths, sourceStates, new Set(forcedPaths));

        const operationId = this.createOperationId();
        const workspaceStateEntryId = await input.session.getStorage().createEntryId();
        const sessionMetadata = await input.session.getMetadata();
        const planned = await measurePhase(timing, "prepareCommitMs", () =>
            this.prepareResultCommit(input, operationId, orderedPaths)
        );
        const pending: PendingWorkspaceRestoreV2 = {
            schemaVersion: 2,
            operationId,
            workspaceIdentity: input.workspace.workspaceIdentity,
            workspaceIncarnation: input.workspace.workspaceIncarnation,
            sessionId: input.plan.sessionId,
            sessionPath: sessionMetadata.path,
            target: structuredClone(input.plan.target),
            applyMode: input.mode,
            forcedPaths,
            expectedSemanticLeafId: input.plan.semanticLeafId,
            commitParentId: input.plan.commitParentId,
            workspaceStateEntryId,
            workspaceStateTimestamp: this.now().toISOString(),
            sourceCommit: input.source.id,
            plannedCommit: planned.prepared.commit,
            affectedPaths: orderedPaths.map((path) => path.path),
        };
        let pendingVisible = false;
        try {
            await assertCurrent();
            await measurePhase(timing, "pendingPublishMs", () =>
                this.store.withWorkspaceLock(() => this.pending.publishPreparedLocked(pending))
            );
            pendingVisible = true;
            await measurePhase(timing, "applyFilesMs", async () => {
                for (const path of orderedPaths) {
                    await assertCurrent();
                    await this.applyPath({
                        root: input.workspace.canonicalRoot,
                        path: path.path,
                        expectedCurrent: sourceStates.get(path.path)!,
                        target: path.target,
                        readBlob: (oid) => this.store.readBlob(oid),
                        progress: {
                            operationId,
                            createdParentDirectories: new Set(),
                            onPathReplaced: async () => {},
                        },
                    });
                }
            });
            if (!this.applyPathIncludesVerification) {
                await measurePhase(timing, "verifyFilesMs", async () => {
                    for (const path of orderedPaths) {
                        await this.verifyPath({
                            root: input.workspace.canonicalRoot,
                            path: path.path,
                            expected: path.target,
                        });
                    }
                });
            }
            await assertCurrent();
            await measurePhase(timing, "publishHeadMs", () =>
                this.store.withWorkspaceLock(() => this.store.mutationLog.publishPrepared(planned.prepared))
            );
            const derived = makeWorkspaceRestoreState({
                pending,
                sourceSnapshot: input.source,
                plannedSnapshot: planned.snapshot,
                sourceStates: orderedPaths.map((path) => ({ path: path.path, state: sourceStates.get(path.path)! })),
                plannedStates: orderedPaths.map((path) => {
                    if (path.target.state === "excluded") {
                        throw new Error(`Restore target excludes an affected path: ${path.path}`);
                    }
                    return { path: path.path, state: path.target as RestorableCapturedPathState };
                }),
            });
            const entry: SessionTreeEntry = {
                type: "custom",
                id: pending.workspaceStateEntryId,
                parentId: pending.commitParentId,
                timestamp: pending.workspaceStateTimestamp,
                customType: WorkspaceControlCustomTypes.state,
                data: derived.markerState,
            };
            await measurePhase(timing, "appendMarkerMs", () =>
                input.session.appendEntries([entry], { expectedLeafId: pending.expectedSemanticLeafId })
            );
            await measurePhase(timing, "verifyFilesMs", () =>
                this.verifyCommittedState(input.session, pending, entry, derived.plannedStates)
            );
            await measurePhase(timing, "pendingCleanupMs", () => this.clearCommittedPending(pending));
            return { sessionMetadata, operationId };
        } catch (error) {
            if (!pendingVisible) {
                const current = await this.pending.readCandidate();
                if (current.kind !== "valid" || current.record.operationId !== operationId) throw error;
                pendingVisible = true;
            }
            if (!pendingVisible) throw error;
            let decision;
            try {
                decision = await this.recovery.resolvePendingUnderLease(pending);
            } catch (recoveryError) {
                throw new WorkspaceFrozenError(operationId, "Workspace recovery required", { cause: recoveryError });
            }
            if (decision.state === "committed") return { sessionMetadata, operationId };
            if (decision.state === "not-committed") throw error;
            throw this.recoveryRequired(pending, decision, error);
        }
    }

    async prepareResultCommit(input: ExecuteWorkspaceRestoreInput, operationId: string, paths: RestorePlanV1["paths"]) {
        const indexFile = join(this.store.storeRoot, "journal", `restore-index-${operationId}`);
        await mkdir(dirname(indexFile), { recursive: true, mode: 0o700 });
        try {
            const index = new ShadowWorkspaceIndex({
                git: this.store.git,
                gitDir: this.store.storeRoot,
                indexFile,
            });
            await index.load(input.source.tree);
            await index.apply(paths.map((path) => ({ path: path.path, state: path.target })));
            const tree = await index.writeTree();
            const prepared = await this.store.mutationLog.prepare({
                expectedHead: input.source.id,
                tree,
                metadata: {
                    schemaversion: 1,
                    workspaceidentity: input.workspace.workspaceIdentity,
                    workspaceincarnation: input.workspace.workspaceIncarnation,
                    kind: input.plan.target.kind,
                    sessionid: input.plan.sessionId,
                    operationid: operationId,
                    ...(turnIdFor(input.plan.target) ? { turnid: turnIdFor(input.plan.target) } : {}),
                    ...(sourceOperationIdFor(input.plan.target)
                        ? { sourceoperationid: sourceOperationIdFor(input.plan.target) }
                        : {}),
                    ...(linkedResultCommitIdFor(input.plan.target)
                        ? { linkedresultcommitid: linkedResultCommitIdFor(input.plan.target) }
                        : {}),
                },
            });
            const metadata = await this.store.deriveCandidateSnapshotMetadata(
                input.source,
                tree,
                paths.map((path) => ({ path: path.path, state: path.target }))
            );
            const snapshot = await this.store.publishCommitSnapshot({
                commit: prepared.commit,
                scope: metadata.scope,
                coverage: metadata.coverage,
            });
            return { prepared, snapshot };
        } finally {
            await Promise.all([rm(indexFile, { force: true }), rm(`${indexFile}.lock`, { force: true })]);
        }
    }

    async makeResult(
        input: ExecuteWorkspaceRestoreInput,
        sessionMetadata: JsonlSessionMetadata
    ): Promise<WorkspaceRewindCommitResult> {
        const entries = await input.session.getEntries();
        return input.commit.makeResult({
            entries,
            folded: foldWorkspaceSessionState(entries, input.plan.sessionId),
            sessionMetadata,
        });
    }

    recoveryRequired(
        pending: PendingWorkspaceRestoreV2,
        decision: Awaited<ReturnType<WorkspaceRecovery["resolvePendingUnderLease"]>>,
        cause?: unknown
    ): WorkspaceFrozenError {
        const message = decision.state === "needs-user" ? decision.view.message : "Workspace recovery required";
        return new WorkspaceFrozenError(pending.operationId, message || "Workspace recovery required", { cause });
    }

    async verifySourceStates(
        paths: RestorePlanV1["paths"],
        sourceStates: ReadonlyMap<string, CapturedPathStateV1>,
        forcedPaths: ReadonlySet<string>
    ): Promise<void> {
        const inspected = await this.inspectPaths(paths.map((path) => path.path));
        for (const path of paths) {
            const source = sourceStates.get(path.path)!;
            const live = inspected.get(path.path);
            const captured = live == null ? undefined : capturedFromLive(live);
            if (
                !live ||
                !captured ||
                live.fingerprint !== path.liveFingerprint ||
                !sameCapturedState(captured, source)
            ) {
                throw new Error(`Workspace changed after restore confirmation: ${path.path}`);
            }
            if (!forcedPaths.has(path.path) && !sameCapturedState(source, path.expectedCurrent)) {
                throw new Error(`Workspace changed after restore confirmation: ${path.path}`);
            }
            if (forcedPaths.has(path.path) && fingerprintCaptured(source) !== path.liveFingerprint) {
                throw new Error(`Force source commit does not match the confirmed bytes: ${path.path}`);
            }
        }
    }

    async verifyCommittedState(
        session: Session<JsonlSessionMetadata>,
        pending: PendingWorkspaceRestoreV2,
        expectedEntry: SessionTreeEntry,
        plannedStates: ReadonlyArray<{ path: string; state: RestorableCapturedPathState }>
    ): Promise<void> {
        const inspected = await this.inspectPaths(plannedStates.map((item) => item.path));
        for (const item of plannedStates) {
            const live = inspected.get(item.path);
            const captured = live == null ? undefined : capturedFromLive(live);
            if (!captured || !sameCapturedState(captured, item.state)) {
                throw new Error(`Workspace changed before restore completion: ${item.path}`);
            }
        }
        if ((await session.getLeafId()) !== pending.workspaceStateEntryId) {
            throw new Error("Session leaf changed before restore completion");
        }
        const storedEntry = await session.getEntry(pending.workspaceStateEntryId);
        if (!storedEntry || !encodeDurableJson(storedEntry).equals(encodeDurableJson(expectedEntry))) {
            throw new Error("Session marker changed before restore completion");
        }
    }

    async clearCommittedPending(pending: PendingWorkspaceRestoreV2): Promise<void> {
        await this.store.withWorkspaceLock(async () => {
            const current = await this.pending.readLocked();
            if (current.kind !== "valid" || current.record.operationId !== pending.operationId) {
                throw new Error("Pending restore changed before cleanup");
            }
            if ((await this.store.mutationLog.readHead()) !== pending.plannedCommit) {
                throw new Error("Workspace mutation head changed before pending cleanup");
            }
            await this.pending.removeLocked(pending.operationId);
        });
    }

    assertWorkspace(workspace: CanonicalWorkspaceIdentity): void {
        if (
            workspace.canonicalRoot !== this.store.identity.canonicalRoot ||
            workspace.workspaceIdentity !== this.store.identity.workspaceIdentity ||
            workspace.workspaceIncarnation !== this.store.identity.workspaceIncarnation
        ) {
            throw new Error("Workspace restore executor belongs to another workspace incarnation");
        }
    }
}

function makeEmptyTiming(pathCount: number): WorkspaceRestoreTiming {
    return {
        outcome: "failed",
        pathCount,
        totalMs: 0,
        prepareCommitMs: 0,
        pendingPublishMs: 0,
        applyFilesMs: 0,
        verifyFilesMs: 0,
        publishHeadMs: 0,
        appendMarkerMs: 0,
        pendingCleanupMs: 0,
    };
}

async function measurePhase<T>(
    timing: WorkspaceRestoreTiming,
    phase: WorkspaceRestorePhase,
    operation: () => Promise<T>
): Promise<T> {
    const started = performance.now();
    try {
        return await operation();
    } finally {
        timing[phase] += performance.now() - started;
    }
}

function turnIdFor(target: RestorePlanV1["target"]): string | undefined {
    if (target.kind === "rewind") return target.targetTurnId;
    if (target.kind === "turn-undo" || target.kind === "turn-redo") return target.sourceTurnId;
    return undefined;
}

function sourceOperationIdFor(target: RestorePlanV1["target"]): string | undefined {
    if (target.kind === "redo") return target.sourceRewindOperationId;
    if (target.kind === "turn-redo") return target.undoOperationId;
    return undefined;
}

function linkedResultCommitIdFor(target: RestorePlanV1["target"]): string | undefined {
    return target.kind === "redo" || target.kind === "turn-redo"
        ? target.linkedOperation.currentSnapshot.id
        : undefined;
}

function comparePathBytes(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
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

function capturedFromLive(live: LiveCapturedPathState): CapturedPathStateV1 | undefined {
    if (live.state === "absent") return { state: "absent" };
    if (live.state === "file") return { state: "file", oid: live.oid, executable: live.executable };
    if (live.state === "symlink") return { state: "symlink", oid: live.oid };
    return undefined;
}

function fingerprintCaptured(state: CapturedPathStateV1): string | undefined {
    let value: unknown;
    if (state.state === "absent") value = ["absent"];
    else if (state.state === "file") value = ["file", state.oid, state.executable];
    else if (state.state === "symlink") value = ["symlink", state.oid];
    else return undefined;
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
