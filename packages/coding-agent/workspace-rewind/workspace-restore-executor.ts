// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, Session, SessionTreeEntry } from "@crest/agent/harness/types";
import { createHash, randomUUID } from "node:crypto";

import { assertRestorePlanMatchesConfirmation, type ConfirmedRestorePlanV1 } from "./confirmation-token";
import { applyCapturedPath, verifyCapturedPath, type WorkspacePathApplyProgress } from "./filesystem-apply";
import { inspectLivePaths, type LiveCapturedPathState } from "./live-path-state";
import type { WorkspaceOperationJournalV2, WorkspaceRecoveryJournal } from "./recovery-journal";
import type { RestorePlanV1 } from "./restore-plan";
import type { WorkspaceRewindCommitResult } from "./rewind-engine";
import { foldWorkspaceSessionState } from "./session-state";
import type { WorkspaceSnapshotStore } from "./snapshot-store";
import {
    WorkspaceControlCustomTypes,
    type CapturedPathStateV1,
    type FoldedWorkspaceSessionState,
    type WorkspaceStateBaseV1,
    type WorkspaceStateV1,
} from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import type { WorkspaceRecovery } from "./workspace-recovery";

type ApplyPath = typeof applyCapturedPath;
type VerifyPath = typeof verifyCapturedPath;

export interface WorkspaceRestoreCommitStrategy {
    makeWorkspaceState(record: WorkspaceOperationJournalV2): WorkspaceStateV1;
    makeResult(input: {
        entries: SessionTreeEntry[];
        folded: FoldedWorkspaceSessionState;
        sessionMetadata: JsonlSessionMetadata;
    }): WorkspaceRewindCommitResult;
}

export interface WorkspaceRestoreExecutorOptions {
    store: WorkspaceSnapshotStore;
    journal: WorkspaceRecoveryJournal;
    recovery: Pick<WorkspaceRecovery, "recoverRecord" | "isExactOperationLeaf">;
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

export function workspaceStateFromJournal(record: WorkspaceOperationJournalV2): WorkspaceStateV1 {
    if (!record.resultSnapshot) {
        throw new Error("Workspace operation marker requires a result snapshot");
    }
    const base = {
        schemaVersion: 1,
        sessionId: record.sessionId,
        operationId: record.operationId,
        workspaceIdentity: record.workspaceIdentity,
        workspaceIncarnation: record.workspaceIncarnation,
        applyMode: record.applyMode,
        forcedPaths: record.confirmedConflictFingerprints.map((item) => item.path),
        currentSnapshot: record.resultSnapshot,
        currentStates: record.paths.map((path) => ({ path: path.path, state: path.target })),
    } satisfies WorkspaceStateBaseV1;
    if (record.target.kind === "redo") return { ...base, kind: "redo" };
    if (record.target.kind === "turn-undo") {
        return { ...base, kind: "turn-undo", sourceTurnId: record.target.sourceTurnId };
    }
    if (record.target.kind === "turn-redo") {
        return {
            ...base,
            kind: "turn-redo",
            sourceTurnId: record.target.sourceTurnId,
            undoOperationId: record.target.undoOperationId,
        };
    }
    return {
        ...base,
        kind: "rewind",
        rewind: {
            fromLeafId: record.expectedSemanticLeafId,
            targetTurnId: record.target.targetTurnId,
            targetBoundaryId: record.commitParentId,
            redoSnapshot: record.safetySnapshot,
            redoStates: record.paths.map((path) => ({ path: path.path, state: path.preState })),
        },
    };
}

export class WorkspaceRestoreExecutor {
    readonly store: WorkspaceSnapshotStore;
    readonly journal: WorkspaceRecoveryJournal;
    readonly recovery: WorkspaceRestoreExecutorOptions["recovery"];
    readonly inspectPaths: NonNullable<WorkspaceRestoreExecutorOptions["inspectLivePaths"]>;
    readonly applyPath: ApplyPath;
    readonly verifyPath: VerifyPath;
    readonly createOperationId: () => string;
    readonly now: () => Date;
    readonly onCommitted: NonNullable<WorkspaceRestoreExecutorOptions["onCommitted"]>;

    constructor(options: WorkspaceRestoreExecutorOptions) {
        this.store = options.store;
        this.journal = options.journal;
        this.recovery = options.recovery;
        this.inspectPaths =
            options.inspectLivePaths ?? ((paths) => inspectLivePaths(this.store.identity.canonicalRoot, paths));
        this.applyPath = options.applyPath ?? applyCapturedPath;
        this.verifyPath = options.verifyPath ?? verifyCapturedPath;
        this.createOperationId = options.createOperationId ?? randomUUID;
        this.now = options.now ?? (() => new Date());
        this.onCommitted = options.onCommitted ?? (async () => {});
    }

    execute(input: ExecuteWorkspaceRestoreInput): Promise<WorkspaceRewindCommitResult> {
        this.assertWorkspace(input.workspace);
        const operation = () => this.executeLocked(input);
        return this.store.withWorkspaceLock ? this.store.withWorkspaceLock(operation) : operation();
    }

    async executeLocked(input: ExecuteWorkspaceRestoreInput): Promise<WorkspaceRewindCommitResult> {
        const assertCurrent = input.assertCurrent ?? (async () => {});
        await assertCurrent();
        assertRestorePlanMatchesConfirmation({
            confirmation: input.confirmation,
            plan: input.plan,
            mode: input.mode,
        });
        const orderedPaths = [...input.plan.paths].sort((left, right) => comparePathBytes(left.path, right.path));
        const conflictPaths =
            input.mode === "force-drift"
                ? orderedPaths.filter((path) => path.conflict === "forceable-drift").map((path) => path.path)
                : [];
        const safety = await this.store.capture({ profile: "safety", requiredPaths: conflictPaths });
        const preStates = new Map<string, CapturedPathStateV1>();
        for (const path of orderedPaths) {
            const state = await this.store.readPathState(safety.ref, path.path);
            if (state.state === "excluded") {
                throw new Error(`Safety snapshot could not capture the full path state: ${path.path}`);
            }
            preStates.set(path.path, state);
        }
        await this.verifySafetyCapture(orderedPaths, preStates, new Set(conflictPaths));

        const operationId = this.createOperationId();
        const workspaceStateEntryId = await input.session.getStorage().createEntryId();
        const sessionMetadata = await input.session.getMetadata();
        let record: WorkspaceOperationJournalV2 = {
            schemaVersion: 2,
            phase: "prepared",
            workspaceIdentity: input.workspace.workspaceIdentity,
            workspaceIncarnation: input.workspace.workspaceIncarnation,
            sessionId: input.plan.sessionId,
            sessionPath: sessionMetadata.path,
            operationId,
            target: structuredClone(input.plan.target),
            commitParentId: input.plan.commitParentId,
            applyMode: input.mode,
            expectedSemanticLeafId: input.plan.semanticLeafId,
            safetySnapshot: safety.ref,
            confirmedConflictFingerprints: conflictPaths.map((path) => ({
                path,
                fingerprint: orderedPaths.find((item) => item.path === path)!.liveFingerprint,
            })),
            paths: orderedPaths.map((path) => {
                const preState = preStates.get(path.path)!;
                if (sameCapturedState(preState, path.target)) {
                    throw new Error(`Safety pre-state already equals the restore target: ${path.path}`);
                }
                return {
                    path: path.path,
                    target: path.target,
                    preState,
                    expectedCurrent: path.expectedCurrent,
                    confirmedLiveFingerprint: path.liveFingerprint,
                    createdParentDirectories: [],
                };
            }),
            workspaceStateEntryId,
        };
        let journalAttempted = false;
        let completed = false;
        try {
            await assertCurrent();
            journalAttempted = true;
            await this.begin(record);
            record = await this.transition(operationId, "applying_files", {});
            for (const path of record.paths) {
                await assertCurrent();
                const createdParentDirectories = new Set(path.createdParentDirectories);
                const updateProgress = async () => {
                    record = await this.updatePathProgress(operationId, path.path, [...createdParentDirectories]);
                };
                const progress: WorkspacePathApplyProgress = {
                    operationId,
                    createdParentDirectories,
                    onParentDirectoryCreated: updateProgress,
                    onPathReplaced: updateProgress,
                };
                await this.applyPath({
                    root: input.workspace.canonicalRoot,
                    path: path.path,
                    expectedCurrent: path.preState,
                    target: path.target,
                    readBlob: (oid) => this.store.readBlob(oid),
                    progress,
                });
            }
            const result = await this.store.capture({
                profile: "safety",
                requiredPaths: record.paths.map((path) => path.path),
            });
            for (const path of record.paths) {
                const captured = await this.store.readPathState(result.ref, path.path);
                if (!sameCapturedState(captured, path.target)) {
                    throw new Error(`Post-apply snapshot verification failed: ${path.path}`);
                }
                await this.verifyPath({
                    root: input.workspace.canonicalRoot,
                    path: path.path,
                    expected: path.target,
                });
            }
            record = await this.transition(operationId, "files_verified", {
                resultSnapshot: result.ref,
            });
            await this.store.anchorSnapshot(safety.ref);
            await this.store.anchorSnapshot(result.ref);
            record = await this.transition(operationId, "committing_session", {});

            await assertCurrent();
            const entry: SessionTreeEntry = {
                type: "custom",
                id: workspaceStateEntryId,
                parentId: input.plan.commitParentId,
                timestamp: this.now().toISOString(),
                customType: WorkspaceControlCustomTypes.state,
                data: input.commit.makeWorkspaceState(record),
            };
            await input.session.appendEntries([entry], { expectedLeafId: input.plan.semanticLeafId });
            if (!(await this.recovery.isExactOperationLeaf(input.session, record, await input.session.getLeafId()))) {
                throw new Error("Committed workspace state is not the exact operation leaf");
            }
            record = await this.transition(operationId, "completed", {});
            completed = true;
            await assertCurrent();
            await this.onCommitted(input.plan.sessionId, operationId);
            await this.completeCleanup(operationId);
            return this.makeResult(input, sessionMetadata);
        } catch (error) {
            if (journalAttempted && !completed) {
                let current: WorkspaceOperationJournalV2;
                try {
                    current = await this.journal.read(operationId);
                } catch {
                    throw error;
                }
                await this.recovery.recoverRecord(current);
                if (await this.recovery.isExactOperationLeaf(input.session, current, await input.session.getLeafId())) {
                    return this.makeResult(input, sessionMetadata);
                }
            }
            throw error;
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

    async begin(record: WorkspaceOperationJournalV2): Promise<void> {
        if (typeof this.journal.beginUnlocked === "function") {
            await this.journal.beginUnlocked(record);
            return;
        }
        await this.journal.begin(record);
    }

    transition(
        operationId: string,
        phase: WorkspaceOperationJournalV2["phase"],
        patch: Pick<WorkspaceOperationJournalV2, "resultSnapshot">
    ): Promise<WorkspaceOperationJournalV2> {
        if (typeof this.journal.transitionUnlocked === "function") {
            return this.journal.transitionUnlocked(operationId, phase, patch);
        }
        return this.journal.transition(operationId, phase, patch);
    }

    updatePathProgress(
        operationId: string,
        path: string,
        createdParentDirectories: readonly string[]
    ): Promise<WorkspaceOperationJournalV2> {
        if (typeof this.journal.updatePathProgressUnlocked === "function") {
            return this.journal.updatePathProgressUnlocked(operationId, path, createdParentDirectories);
        }
        return this.journal.updatePathProgress(operationId, path, createdParentDirectories);
    }

    async completeCleanup(operationId: string): Promise<void> {
        if (typeof this.journal.completeCleanupUnlocked === "function") {
            await this.journal.completeCleanupUnlocked(operationId);
            return;
        }
        await this.journal.completeCleanup(operationId);
    }

    async verifySafetyCapture(
        paths: RestorePlanV1["paths"],
        preStates: ReadonlyMap<string, CapturedPathStateV1>,
        conflictPaths: ReadonlySet<string>
    ): Promise<void> {
        const inspected = await this.inspectPaths(paths.map((path) => path.path));
        for (const path of paths) {
            const preState = preStates.get(path.path)!;
            const live = inspected.get(path.path);
            const liveCaptured = live == null ? undefined : capturedFromLive(live);
            if (
                !live ||
                !liveCaptured ||
                live.fingerprint !== path.liveFingerprint ||
                !sameCapturedState(liveCaptured, preState)
            ) {
                throw new Error(`Workspace changed after restore confirmation: ${path.path}`);
            }
            if (!conflictPaths.has(path.path) && !sameCapturedState(preState, path.expectedCurrent)) {
                throw new Error(`Workspace changed after restore confirmation: ${path.path}`);
            }
            if (conflictPaths.has(path.path) && fingerprintCaptured(preState) !== path.liveFingerprint) {
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
