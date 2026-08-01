// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, Session, SessionTreeEntry } from "@crest/agent/harness/types";
import { createHash, randomUUID } from "node:crypto";

import { textFromContent } from "../commands/session-views";
import type { AgentRewindFileRowView, AgentRewindPreviewResult } from "./api-types";
import {
    assertRestorePlanMatchesConfirmation,
    type ConfirmedRestorePlanV1,
    type RewindConfirmationRegistry,
} from "./confirmation-token";
import { projectWorkspacePathDiff, WorkspaceDiffPreviewBudget } from "./diff-preview";
import { applyCapturedPath, verifyCapturedPath, type WorkspacePathApplyProgress } from "./filesystem-apply";
import { inspectLivePath, inspectLivePaths, type LiveCapturedPathState } from "./live-path-state";
import type { WorkspaceOperationJournalV1, WorkspaceRecoveryJournal } from "./recovery-journal";
import { planRedo, planRewind, type PlanRedoInput, type PlanRewindInput, type RestorePlanV1 } from "./restore-plan";
import { foldWorkspaceSessionState } from "./session-state";
import type { WorkspaceSnapshotStore } from "./snapshot-store";
import {
    WorkspaceControlCustomTypes,
    type CapturedPathStateV1,
    type WorkspaceStateBaseV1,
    type WorkspaceStateV1,
} from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import type { WorkspaceRecovery } from "./workspace-recovery";

type WorkspaceRewindMarkerV1 = Extract<WorkspaceStateV1, { kind: "rewind" }>;

export interface PreviewRewindInput {
    session: Session<JsonlSessionMetadata>;
    sessionId: string;
    workspace: CanonicalWorkspaceIdentity;
    semanticLeafId: string | null;
    targetTurnId: string;
}

export interface PreviewRedoInput {
    session: Session<JsonlSessionMetadata>;
    sessionId: string;
    workspace: CanonicalWorkspaceIdentity;
    semanticLeafId: string | null;
}

export interface ApplyRewindInput extends PreviewRewindInput {
    mode: "normal" | "force-drift";
    confirmation: ConfirmedRestorePlanV1;
    assertCurrent?: () => Promise<void>;
}

export interface ApplyRedoInput extends PreviewRedoInput {
    confirmation: ConfirmedRestorePlanV1;
    assertCurrent?: () => Promise<void>;
}

export interface WorkspaceRewindCommitResult {
    sessionMetadata: JsonlSessionMetadata;
    semanticLeafId: string | null;
    displayLeafId: string | null;
    editorText?: string;
}

type ApplyPath = typeof applyCapturedPath;
type VerifyPath = typeof verifyCapturedPath;

export interface WorkspaceRewindEngineOptions {
    store: WorkspaceSnapshotStore;
    journal: WorkspaceRecoveryJournal;
    recovery: Pick<WorkspaceRecovery, "recoverRecord" | "isExactOperationLeaf">;
    confirmations: RewindConfirmationRegistry;
    planRewind?: (input: PlanRewindInput) => Promise<RestorePlanV1>;
    planRedo?: (input: PlanRedoInput) => Promise<RestorePlanV1>;
    inspectLivePath?: (path: string) => Promise<LiveCapturedPathState>;
    inspectLivePaths?: (paths: readonly string[]) => Promise<ReadonlyMap<string, LiveCapturedPathState>>;
    applyPath?: ApplyPath;
    verifyPath?: VerifyPath;
    createOperationId?: () => string;
    now?: () => Date;
    onCommitted?: (sessionId: string) => Promise<void>;
}

interface PlannedRestore {
    entries: SessionTreeEntry[];
    plan: RestorePlanV1;
    rewindState?: WorkspaceRewindMarkerV1;
    targetEntry?: Extract<SessionTreeEntry, { type: "message" }>;
}

interface ApplyRestoreInput {
    session: Session<JsonlSessionMetadata>;
    sessionId: string;
    workspace: CanonicalWorkspaceIdentity;
    semanticLeafId: string | null;
    kind: "rewind" | "redo";
    targetTurnId?: string;
    mode: "normal" | "force-drift";
    confirmation: ConfirmedRestorePlanV1;
    assertCurrent?: () => Promise<void>;
}

function comparePathBytes(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameCapturedState(left: CapturedPathStateV1, right: CapturedPathStateV1): boolean {
    if (left.state !== right.state) return false;
    if (left.state === "file" && right.state === "file") {
        return left.oid === right.oid && left.executable === right.executable;
    }
    if (left.state === "symlink" && right.state === "symlink") {
        return left.oid === right.oid;
    }
    if (left.state === "excluded" && right.state === "excluded") {
        return left.reason === right.reason;
    }
    return true;
}

function capturedFromLive(live: LiveCapturedPathState): CapturedPathStateV1 | undefined {
    if (live.state === "absent") return { state: "absent" };
    if (live.state === "file") {
        return { state: "file", oid: live.oid, executable: live.executable };
    }
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

function rawActiveBranch(entries: SessionTreeEntry[], leafId: string | null): SessionTreeEntry[] {
    if (leafId == null) return [];
    const byId = new Map(entries.filter((entry) => entry.type !== "leaf").map((entry) => [entry.id, entry]));
    const reverse: SessionTreeEntry[] = [];
    const visited = new Set<string>();
    let cursor: string | null = leafId;
    while (cursor != null) {
        if (visited.has(cursor)) return [];
        const entry = byId.get(cursor);
        if (!entry) return [];
        reverse.push(entry);
        visited.add(cursor);
        cursor = entry.parentId;
    }
    return reverse.reverse();
}

function selectedUserEntry(
    entries: SessionTreeEntry[],
    targetTurnId: string | undefined
): Extract<SessionTreeEntry, { type: "message" }> | undefined {
    if (!targetTurnId) return undefined;
    return entries.find(
        (entry): entry is Extract<SessionTreeEntry, { type: "message" }> =>
            entry.type === "message" && entry.id === targetTurnId && entry.message.role === "user"
    );
}

function previewMessageCount(
    entries: SessionTreeEntry[],
    plan: RestorePlanV1,
    rewindState: WorkspaceRewindMarkerV1 | undefined
): number {
    const targetTurnId = plan.kind === "rewind" ? plan.targetTurnId : rewindState?.rewind.targetTurnId;
    const leafId = plan.kind === "rewind" ? plan.semanticLeafId : rewindState?.rewind.fromLeafId;
    const branch = rawActiveBranch(entries, leafId ?? null);
    const targetIndex = branch.findIndex((entry) => entry.id === targetTurnId);
    if (targetIndex < 0) return 0;
    return branch.slice(targetIndex).filter((entry) => entry.type === "message").length;
}

function baseFileRow(path: RestorePlanV1["paths"][number]): AgentRewindFileRowView {
    return {
        path: path.path,
        operation: path.operation,
        coverage:
            path.expectedCurrent.state === "excluded" || path.target.state === "excluded" ? "excluded" : "covered",
        conflict: path.conflict,
        ...(path.reason == null ? {} : { reason: path.reason }),
    };
}

async function fileRows(
    plan: RestorePlanV1,
    readBlob: (oid: string) => Promise<Buffer>
): Promise<AgentRewindFileRowView[]> {
    const budget = new WorkspaceDiffPreviewBudget();
    const rows: AgentRewindFileRowView[] = [];
    for (const path of plan.paths) {
        const base = baseFileRow(path);
        try {
            const projected = await projectWorkspacePathDiff({
                path: path.path,
                before: path.expectedCurrent,
                after: path.target,
                readBlob,
                budget,
            });
            rows.push({
                ...(projected.additions == null ? {} : { additions: projected.additions }),
                ...(projected.deletions == null ? {} : { deletions: projected.deletions }),
                ...(projected.diff == null ? {} : { diff: projected.diff }),
                ...(projected.previewUnavailableReason == null
                    ? {}
                    : { previewUnavailableReason: projected.previewUnavailableReason }),
                ...base,
            });
        } catch {
            rows.push({ ...base, previewUnavailableReason: "diff preview is unavailable" });
        }
    }
    return rows;
}

function warningText(plan: RestorePlanV1): string[] {
    return plan.coverageWarnings.map((warning) =>
        warning.path ? `${warning.path}: ${warning.reason}` : warning.reason
    );
}

export class WorkspaceRewindEngine {
    private readonly store: WorkspaceSnapshotStore;
    private readonly journal: WorkspaceRecoveryJournal;
    private readonly recovery: WorkspaceRewindEngineOptions["recovery"];
    private readonly confirmations: RewindConfirmationRegistry;
    private readonly planRewindImpl: NonNullable<WorkspaceRewindEngineOptions["planRewind"]>;
    private readonly planRedoImpl: NonNullable<WorkspaceRewindEngineOptions["planRedo"]>;
    private readonly inspectPath: NonNullable<WorkspaceRewindEngineOptions["inspectLivePath"]>;
    private readonly inspectPaths: NonNullable<WorkspaceRewindEngineOptions["inspectLivePaths"]>;
    private readonly applyPath: ApplyPath;
    private readonly verifyPath: VerifyPath;
    private readonly createOperationId: () => string;
    private readonly now: () => Date;
    private readonly onCommitted: NonNullable<WorkspaceRewindEngineOptions["onCommitted"]>;

    constructor(options: WorkspaceRewindEngineOptions) {
        this.store = options.store;
        this.journal = options.journal;
        this.recovery = options.recovery;
        this.confirmations = options.confirmations;
        this.planRewindImpl = options.planRewind ?? planRewind;
        this.planRedoImpl = options.planRedo ?? planRedo;
        this.inspectPath =
            options.inspectLivePath ?? ((path) => inspectLivePath(this.store.identity.canonicalRoot, path));
        this.inspectPaths =
            options.inspectLivePaths ?? ((paths) => inspectLivePaths(this.store.identity.canonicalRoot, paths));
        this.applyPath = options.applyPath ?? applyCapturedPath;
        this.verifyPath = options.verifyPath ?? verifyCapturedPath;
        this.createOperationId = options.createOperationId ?? randomUUID;
        this.now = options.now ?? (() => new Date());
        this.onCommitted = options.onCommitted ?? (async () => {});
    }

    async previewRewind(input: PreviewRewindInput): Promise<AgentRewindPreviewResult> {
        this.assertWorkspace(input.workspace);
        return this.preview(await this.computeRewind(input));
    }

    async previewRedo(input: PreviewRedoInput): Promise<AgentRewindPreviewResult> {
        this.assertWorkspace(input.workspace);
        return this.preview(await this.computeRedo(input));
    }

    async applyRewind(input: ApplyRewindInput): Promise<WorkspaceRewindCommitResult> {
        return this.apply({
            ...input,
            kind: "rewind",
        });
    }

    async applyRedo(input: ApplyRedoInput): Promise<WorkspaceRewindCommitResult> {
        return this.apply({
            ...input,
            kind: "redo",
            mode: "normal",
        });
    }

    private async preview(planned: PlannedRestore): Promise<AgentRewindPreviewResult> {
        const { plan, entries, rewindState } = planned;
        const targetTurnId = plan.kind === "rewind" ? plan.targetTurnId! : rewindState?.rewind.targetTurnId;
        const targetEntry = planned.targetEntry ?? selectedUserEntry(entries, targetTurnId);
        const folded = foldWorkspaceSessionState(entries, plan.sessionId);
        let confirmationToken: string | undefined;
        if (!plan.hardBlocked) {
            confirmationToken = this.confirmations.issue(plan);
        }
        const files = await fileRows(plan, (oid) => this.store.readBlob(oid));
        return {
            ...(confirmationToken == null ? {} : { confirmationToken }),
            target: plan.kind === "rewind" ? { kind: "rewind", targetTurnId: plan.targetTurnId! } : { kind: "redo" },
            ...(targetEntry == null
                ? {}
                : { targetPrompt: textFromContent((targetEntry.message as { content?: unknown }).content) }),
            semanticLeafId: folded.semanticLeafId,
            displayLeafId: folded.displayLeafId,
            expectedSemanticLeafId: plan.semanticLeafId,
            messageCount: previewMessageCount(entries, plan, rewindState),
            fileCount: plan.paths.length,
            files,
            coverageWarnings: warningText(plan),
            forceRequired: plan.forceRequired,
            hardBlocked: plan.hardBlocked,
        };
    }

    private async computeRewind(input: PreviewRewindInput): Promise<PlannedRestore> {
        const entries = await input.session.getEntries();
        const folded = foldWorkspaceSessionState(entries, input.sessionId);
        const plan = await this.planRewindImpl({
            sessionId: input.sessionId,
            workspace: input.workspace,
            rawEntries: entries,
            semanticLeafId: input.semanticLeafId,
            targetTurnId: input.targetTurnId,
            currentWorkspaceState: folded.activeWorkspaceState,
            inspectLivePath: this.inspectPath,
            inspectLivePaths: this.inspectPaths,
            verifySnapshot: (snapshot) => this.store.verify(snapshot),
        });
        return {
            entries,
            plan,
            targetEntry: selectedUserEntry(entries, input.targetTurnId),
        };
    }

    private async computeRedo(input: PreviewRedoInput): Promise<PlannedRestore> {
        const entries = await input.session.getEntries();
        const folded = foldWorkspaceSessionState(entries, input.sessionId);
        const rewindState = folded.activeWorkspaceState;
        if (rewindState?.kind !== "rewind") {
            return {
                entries,
                plan: {
                    kind: "redo",
                    sessionId: input.sessionId,
                    workspaceIdentity: input.workspace.workspaceIdentity,
                    workspaceIncarnation: input.workspace.workspaceIncarnation,
                    semanticLeafId: input.semanticLeafId,
                    targetBoundaryId: null,
                    paths: [],
                    coverageWarnings: [{ path: "", reason: "redo requires the current raw rewind marker" }],
                    forceRequired: false,
                    hardBlocked: true,
                },
            };
        }
        const plan = await this.planRedoImpl({
            sessionId: input.sessionId,
            workspace: input.workspace,
            rawEntries: entries,
            semanticLeafId: input.semanticLeafId,
            rewindState,
            inspectLivePath: this.inspectPath,
            inspectLivePaths: this.inspectPaths,
            verifySnapshot: (snapshot) => this.store.verify(snapshot),
        });
        return {
            entries,
            plan,
            rewindState,
            targetEntry: selectedUserEntry(entries, rewindState.rewind.targetTurnId),
        };
    }

    private async apply(input: ApplyRestoreInput): Promise<WorkspaceRewindCommitResult> {
        this.assertWorkspace(input.workspace);
        const planned =
            input.kind === "rewind"
                ? await this.computeRewind({
                      session: input.session,
                      sessionId: input.sessionId,
                      workspace: input.workspace,
                      semanticLeafId: input.semanticLeafId,
                      targetTurnId: input.targetTurnId!,
                  })
                : await this.computeRedo({
                      session: input.session,
                      sessionId: input.sessionId,
                      workspace: input.workspace,
                      semanticLeafId: input.semanticLeafId,
                  });
        assertRestorePlanMatchesConfirmation({
            confirmation: input.confirmation,
            plan: planned.plan,
            mode: input.mode,
        });
        return this.applyPlanned(input, planned);
    }

    private async applyPlanned(
        input: ApplyRestoreInput,
        planned: PlannedRestore
    ): Promise<WorkspaceRewindCommitResult> {
        const assertCurrent = input.assertCurrent ?? (async () => {});
        await assertCurrent();
        const orderedPaths = [...planned.plan.paths].sort((left, right) => comparePathBytes(left.path, right.path));
        const conflictPaths =
            input.mode === "force-drift"
                ? orderedPaths.filter((path) => path.conflict === "forceable-drift").map((path) => path.path)
                : [];
        const safety = await this.store.capture({
            profile: "safety",
            requiredPaths: conflictPaths,
        });
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
        const redoBoundary =
            input.kind === "redo" ? planned.rewindState?.rewind.fromLeafId : planned.plan.targetBoundaryId;
        if (input.kind === "redo" && !planned.rewindState) {
            throw new Error("Redo requires an authoritative rewind marker");
        }
        let record: WorkspaceOperationJournalV1 = {
            schemaVersion: 1,
            phase: "prepared",
            workspaceIdentity: input.workspace.workspaceIdentity,
            workspaceIncarnation: input.workspace.workspaceIncarnation,
            sessionId: input.sessionId,
            sessionPath: sessionMetadata.path,
            operationId,
            kind: input.kind,
            applyMode: input.mode,
            expectedSemanticLeafId: input.semanticLeafId,
            targetTurnId: input.kind === "rewind" ? input.targetTurnId! : null,
            targetBoundaryId: redoBoundary ?? null,
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
            await this.journal.begin(record);
            record = await this.journal.transition(operationId, "applying_files");
            for (const path of record.paths) {
                await assertCurrent();
                const createdParentDirectories = new Set(path.createdParentDirectories);
                const updateProgress = async () => {
                    record = await this.journal.updatePathProgress(operationId, path.path, [
                        ...createdParentDirectories,
                    ]);
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
            record = await this.journal.transition(operationId, "files_verified", {
                resultSnapshot: result.ref,
            });
            await this.store.anchorSnapshot(safety.ref);
            await this.store.anchorSnapshot(result.ref);
            record = await this.journal.transition(operationId, "committing_session");

            await assertCurrent();
            const state = this.workspaceState(record);
            const entry: SessionTreeEntry = {
                type: "custom",
                id: workspaceStateEntryId,
                parentId: record.targetBoundaryId,
                timestamp: this.now().toISOString(),
                customType: WorkspaceControlCustomTypes.state,
                data: state,
            };
            await input.session.appendEntries([entry], {
                expectedLeafId: input.semanticLeafId,
            });
            if (!(await this.recovery.isExactOperationLeaf(input.session, record, await input.session.getLeafId()))) {
                throw new Error("Committed workspace state is not the exact operation leaf");
            }
            record = await this.journal.transition(operationId, "completed");
            completed = true;
            await assertCurrent();
            await this.onCommitted(input.sessionId);
            await this.journal.completeCleanup(operationId);
            return this.commitResult(input, planned, sessionMetadata);
        } catch (error) {
            if (journalAttempted && !completed) {
                let current: WorkspaceOperationJournalV1;
                try {
                    current = await this.journal.read(operationId);
                } catch {
                    throw error;
                }
                await this.recovery.recoverRecord(current);
                if (await this.recovery.isExactOperationLeaf(input.session, current, await input.session.getLeafId())) {
                    return this.commitResult(input, planned, sessionMetadata);
                }
            }
            throw error;
        }
    }

    private async verifySafetyCapture(
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

    private workspaceState(record: WorkspaceOperationJournalV1): WorkspaceStateV1 {
        const currentStates = record.paths.map((path) => ({ path: path.path, state: path.target }));
        const base = {
            schemaVersion: 1,
            sessionId: record.sessionId,
            operationId: record.operationId,
            workspaceIdentity: record.workspaceIdentity,
            workspaceIncarnation: record.workspaceIncarnation,
            applyMode: record.applyMode,
            forcedPaths: record.confirmedConflictFingerprints.map((item) => item.path),
            currentSnapshot: record.resultSnapshot!,
            currentStates,
        } satisfies WorkspaceStateBaseV1;
        if (record.kind === "redo") {
            return { ...base, kind: "redo" };
        }
        return {
            ...base,
            kind: "rewind",
            rewind: {
                fromLeafId: record.expectedSemanticLeafId,
                targetTurnId: record.targetTurnId!,
                targetBoundaryId: record.targetBoundaryId,
                redoSnapshot: record.safetySnapshot,
                redoStates: record.paths.map((path) => ({
                    path: path.path,
                    state: path.preState,
                })),
            },
        };
    }

    private async commitResult(
        input: ApplyRestoreInput,
        planned: PlannedRestore,
        sessionMetadata: JsonlSessionMetadata
    ): Promise<WorkspaceRewindCommitResult> {
        const entries = await input.session.getEntries();
        const folded = foldWorkspaceSessionState(entries, input.sessionId);
        const targetEntry =
            input.kind === "rewind"
                ? (planned.targetEntry ?? selectedUserEntry(entries, input.targetTurnId))
                : undefined;
        return {
            sessionMetadata,
            semanticLeafId: folded.semanticLeafId,
            displayLeafId: folded.displayLeafId,
            ...(targetEntry == null
                ? {}
                : { editorText: textFromContent((targetEntry.message as { content?: unknown }).content) }),
        };
    }

    private assertWorkspace(workspace: CanonicalWorkspaceIdentity): void {
        if (
            workspace.canonicalRoot !== this.store.identity.canonicalRoot ||
            workspace.workspaceIdentity !== this.store.identity.workspaceIdentity ||
            workspace.workspaceIncarnation !== this.store.identity.workspaceIncarnation
        ) {
            throw new Error("Workspace rewind engine belongs to another workspace incarnation");
        }
    }
}
