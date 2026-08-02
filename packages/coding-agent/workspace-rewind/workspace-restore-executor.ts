// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, Session, SessionTreeEntry } from "@crest/agent/harness/types";
import { createHash, randomUUID } from "node:crypto";

import { assertRestorePlanMatchesConfirmation, type ConfirmedRestorePlanV1 } from "./confirmation-token";
import { applyCapturedPath, verifyCapturedPath, type WorkspacePathApplyProgress } from "./filesystem-apply";
import { inspectLivePaths, type LiveCapturedPathState } from "./live-path-state";
import { PendingWorkspaceRestoreStore, type PendingWorkspaceRestoreV1 } from "./pending-restore-store";
import type { RestorePlanV1 } from "./restore-plan";
import type { WorkspaceRewindCommitResult } from "./rewind-engine";
import { foldWorkspaceSessionState } from "./session-state";
import type { WorkspaceSnapshotStore } from "./snapshot-store";
import {
    WorkspaceControlCustomTypes,
    type CapturedPathStateV1,
    type FoldedWorkspaceSessionState,
    type WorkspaceSnapshotRefV1,
    type WorkspaceStateBaseV1,
    type WorkspaceStateV1,
} from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import { WorkspaceFrozenError, type WorkspaceRecovery } from "./workspace-recovery";

type ApplyPath = typeof applyCapturedPath;
type VerifyPath = typeof verifyCapturedPath;

export interface WorkspaceRestoreCommitStrategy {
    makeWorkspaceState(pending: PendingWorkspaceRestoreV1, resultSnapshot: WorkspaceSnapshotRefV1): WorkspaceStateV1;
    makeResult(input: {
        entries: SessionTreeEntry[];
        folded: FoldedWorkspaceSessionState;
        sessionMetadata: JsonlSessionMetadata;
    }): WorkspaceRewindCommitResult;
}

export interface WorkspaceRestoreExecutorOptions {
    store: WorkspaceSnapshotStore;
    pending?: PendingWorkspaceRestoreStore;
    recovery: Pick<WorkspaceRecovery, "resolvePendingLocked">;
    inspectLivePaths?: (paths: readonly string[]) => Promise<ReadonlyMap<string, LiveCapturedPathState>>;
    applyPath?: ApplyPath;
    verifyPath?: VerifyPath;
    createOperationId?: () => string;
    now?: () => Date;
    onCommitted?: (sessionId: string, operationId: string) => Promise<void>;
}

export interface ExecuteWorkspaceRestoreInput {
    session: Session<JsonlSessionMetadata>;
    workspace: CanonicalWorkspaceIdentity;
    plan: RestorePlanV1;
    confirmation: ConfirmedRestorePlanV1;
    mode: "normal" | "force-drift";
    assertCurrent?: () => Promise<void>;
    commit: WorkspaceRestoreCommitStrategy;
}

export function workspaceStateFromPending(
    pending: PendingWorkspaceRestoreV1,
    resultSnapshot: WorkspaceSnapshotRefV1
): WorkspaceStateV1 {
    const base = {
        schemaVersion: 1,
        sessionId: pending.sessionId,
        operationId: pending.operationId,
        workspaceIdentity: pending.workspaceIdentity,
        workspaceIncarnation: pending.workspaceIncarnation,
        applyMode: pending.applyMode,
        forcedPaths: pending.forcedPaths,
        currentSnapshot: resultSnapshot,
        currentStates: pending.paths.map((path) => ({ path: path.path, state: path.target })),
    } satisfies WorkspaceStateBaseV1;
    if (pending.target.kind === "redo") return { ...base, kind: "redo" };
    if (pending.target.kind === "turn-undo") {
        return { ...base, kind: "turn-undo", sourceTurnId: pending.target.sourceTurnId };
    }
    if (pending.target.kind === "turn-redo") {
        return {
            ...base,
            kind: "turn-redo",
            sourceTurnId: pending.target.sourceTurnId,
            undoOperationId: pending.target.undoOperationId,
        };
    }
    return {
        ...base,
        kind: "rewind",
        rewind: {
            fromLeafId: pending.expectedSemanticLeafId,
            targetTurnId: pending.target.targetTurnId,
            targetBoundaryId: pending.commitParentId,
            redoSnapshot: pending.safetySnapshot,
            redoStates: pending.paths.map((path) => ({ path: path.path, state: path.before })),
        },
    };
}

export class WorkspaceRestoreExecutor {
    readonly store: WorkspaceSnapshotStore;
    readonly pending: PendingWorkspaceRestoreStore;
    readonly recovery: WorkspaceRestoreExecutorOptions["recovery"];
    readonly inspectPaths: NonNullable<WorkspaceRestoreExecutorOptions["inspectLivePaths"]>;
    readonly applyPath: ApplyPath;
    readonly verifyPath: VerifyPath;
    readonly createOperationId: () => string;
    readonly now: () => Date;
    readonly onCommitted: NonNullable<WorkspaceRestoreExecutorOptions["onCommitted"]>;

    constructor(options: WorkspaceRestoreExecutorOptions) {
        this.store = options.store;
        this.pending = options.pending ?? new PendingWorkspaceRestoreStore(options.store);
        this.recovery = options.recovery;
        this.inspectPaths =
            options.inspectLivePaths ?? ((paths) => inspectLivePaths(this.store.identity.canonicalRoot, paths));
        this.applyPath = options.applyPath ?? applyCapturedPath;
        this.verifyPath = options.verifyPath ?? verifyCapturedPath;
        this.createOperationId = options.createOperationId ?? randomUUID;
        this.now = options.now ?? (() => new Date());
        this.onCommitted = options.onCommitted ?? (async () => {});
    }

    async execute(input: ExecuteWorkspaceRestoreInput): Promise<WorkspaceRewindCommitResult> {
        this.assertWorkspace(input.workspace);
        const operation = () => this.executeLocked(input);
        const committed = this.store.withWorkspaceLock
            ? await this.store.withWorkspaceLock(operation)
            : await operation();
        try {
            await this.onCommitted(input.plan.sessionId, committed.operationId);
        } catch (error) {
            console.warn("Workspace restore committed but renderer refresh failed", error);
        }
        return this.makeResult(input, committed.sessionMetadata);
    }

    async executeLocked(
        input: ExecuteWorkspaceRestoreInput
    ): Promise<{ sessionMetadata: JsonlSessionMetadata; operationId: string }> {
        const assertCurrent = input.assertCurrent ?? (async () => {});
        await assertCurrent();
        assertRestorePlanMatchesConfirmation({ confirmation: input.confirmation, plan: input.plan, mode: input.mode });
        const orderedPaths = [...input.plan.paths].sort((left, right) => comparePathBytes(left.path, right.path));
        const forcedPaths =
            input.mode === "force-drift"
                ? orderedPaths.filter((path) => path.conflict === "forceable-drift").map((path) => path.path)
                : [];
        const safety = await this.store.capture({ profile: "safety", requiredPaths: forcedPaths });
        const beforeStates = new Map<string, CapturedPathStateV1>();
        for (const path of orderedPaths) {
            const state = await this.store.readPathState(safety.ref, path.path);
            if (state.state === "excluded") {
                throw new Error(`Safety snapshot could not capture the full path state: ${path.path}`);
            }
            beforeStates.set(path.path, state);
        }
        await this.verifySafetyCapture(orderedPaths, beforeStates, new Set(forcedPaths));

        const operationId = this.createOperationId();
        const workspaceStateEntryId = await input.session.getStorage().createEntryId();
        const sessionMetadata = await input.session.getMetadata();
        let pending: PendingWorkspaceRestoreV1 = {
            schemaVersion: 1,
            operationId,
            workspaceIdentity: input.workspace.workspaceIdentity,
            workspaceIncarnation: input.workspace.workspaceIncarnation,
            sessionId: input.plan.sessionId,
            sessionPath: sessionMetadata.path,
            target: structuredClone(input.plan.target),
            commitParentId: input.plan.commitParentId,
            applyMode: input.mode,
            forcedPaths,
            expectedSemanticLeafId: input.plan.semanticLeafId,
            workspaceStateEntryId,
            safetySnapshot: safety.ref,
            paths: orderedPaths.map((path) => {
                const before = beforeStates.get(path.path)!;
                if (sameCapturedState(before, path.target)) {
                    throw new Error(`Safety pre-state already equals the restore target: ${path.path}`);
                }
                return { path: path.path, before, target: path.target, createdParentDirectories: [] };
            }),
        };
        let publicationStarted = false;
        let publicationSucceeded = false;
        let resolutionAttempted = false;
        try {
            await assertCurrent();
            publicationStarted = true;
            await this.pending.publishLocked(pending);
            publicationSucceeded = true;
            for (const item of pending.paths) {
                await assertCurrent();
                const createdParentDirectories = new Set(item.createdParentDirectories);
                const persistProgress = async () => {
                    pending = await this.pending.updateCreatedParentDirectoriesLocked(operationId, item.path, [
                        ...createdParentDirectories,
                    ]);
                };
                const progress: WorkspacePathApplyProgress = {
                    operationId,
                    createdParentDirectories,
                    onParentDirectoryCreated: persistProgress,
                    onPathReplaced: persistProgress,
                };
                await this.applyPath({
                    root: input.workspace.canonicalRoot,
                    path: item.path,
                    expectedCurrent: item.before,
                    target: item.target,
                    readBlob: (oid) => this.store.readBlob(oid),
                    progress,
                });
            }
            const resultSnapshot = await this.store.capture({
                profile: "safety",
                requiredPaths: pending.paths.map((path) => path.path),
            });
            await this.store.verify(resultSnapshot.ref);
            for (const path of pending.paths) {
                const captured = await this.store.readPathState(resultSnapshot.ref, path.path);
                if (!sameCapturedState(captured, path.target)) {
                    throw new Error(`Post-apply snapshot verification failed: ${path.path}`);
                }
                await this.verifyPath({
                    root: input.workspace.canonicalRoot,
                    path: path.path,
                    expected: path.target,
                });
            }
            await assertCurrent();
            const entry: SessionTreeEntry = {
                type: "custom",
                id: workspaceStateEntryId,
                parentId: input.plan.commitParentId,
                timestamp: this.now().toISOString(),
                customType: WorkspaceControlCustomTypes.state,
                data: input.commit.makeWorkspaceState(pending, resultSnapshot.ref),
            };
            await input.session.appendEntries([entry], { expectedLeafId: input.plan.semanticLeafId });
            resolutionAttempted = true;
            const decision = await this.recovery.resolvePendingLocked(pending);
            if (decision.state !== "committed") {
                throw this.recoveryRequired(pending, decision);
            }
            return { sessionMetadata, operationId };
        } catch (error) {
            if (!publicationSucceeded) {
                if (!publicationStarted) throw error;
                let current;
                try {
                    current = await this.pending.readLocked();
                } catch (readError) {
                    throw new WorkspaceFrozenError(operationId, "Workspace recovery required", { cause: readError });
                }
                if (current.kind === "none") throw error;
                if (current.kind !== "valid" || current.record.operationId !== operationId) {
                    throw new WorkspaceFrozenError(operationId, "Workspace recovery required", { cause: error });
                }
                let decision;
                try {
                    decision = await this.recovery.resolvePendingLocked(current.record);
                } catch (recoveryError) {
                    throw new WorkspaceFrozenError(operationId, "Workspace recovery required", {
                        cause: recoveryError,
                    });
                }
                if (decision.state === "committed") return { sessionMetadata, operationId };
                if (decision.state === "not-committed") throw error;
                throw this.recoveryRequired(current.record, decision, error);
            }
            if (resolutionAttempted) {
                if (error instanceof WorkspaceFrozenError) throw error;
                throw new WorkspaceFrozenError(operationId, "Workspace recovery required", { cause: error });
            }
            let decision;
            try {
                decision = await this.recovery.resolvePendingLocked(pending);
            } catch (recoveryError) {
                throw new WorkspaceFrozenError(operationId, "Workspace recovery required", { cause: recoveryError });
            }
            if (decision.state === "committed") {
                return { sessionMetadata, operationId };
            }
            if (decision.state === "not-committed") throw error;
            throw this.recoveryRequired(pending, decision, error);
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
        pending: PendingWorkspaceRestoreV1,
        decision: Awaited<ReturnType<WorkspaceRecovery["resolvePendingLocked"]>>,
        cause?: unknown
    ): WorkspaceFrozenError {
        const message = decision.state === "needs-user" ? decision.view.message : "Workspace recovery required";
        return new WorkspaceFrozenError(pending.operationId, message || "Workspace recovery required", { cause });
    }

    async verifySafetyCapture(
        paths: RestorePlanV1["paths"],
        beforeStates: ReadonlyMap<string, CapturedPathStateV1>,
        conflictPaths: ReadonlySet<string>
    ): Promise<void> {
        const inspected = await this.inspectPaths(paths.map((path) => path.path));
        for (const path of paths) {
            const before = beforeStates.get(path.path)!;
            const live = inspected.get(path.path);
            const liveCaptured = live == null ? undefined : capturedFromLive(live);
            if (
                !live ||
                !liveCaptured ||
                live.fingerprint !== path.liveFingerprint ||
                !sameCapturedState(liveCaptured, before)
            ) {
                throw new Error(`Workspace changed after restore confirmation: ${path.path}`);
            }
            if (!conflictPaths.has(path.path) && !sameCapturedState(before, path.expectedCurrent)) {
                throw new Error(`Workspace changed after restore confirmation: ${path.path}`);
            }
            if (conflictPaths.has(path.path) && fingerprintCaptured(before) !== path.liveFingerprint) {
                throw new Error(`Force safety snapshot does not match the confirmed bytes: ${path.path}`);
            }
        }
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

function comparePathBytes(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
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
