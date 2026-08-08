// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, Session, SessionTreeEntry } from "@crest/agent/harness/types";
import { randomUUID } from "node:crypto";

import { textFromContent } from "../commands/session-views";
import type {
    AgentReviewTurnChangesResult,
    AgentRewindFileRowView,
    AgentRewindPreviewResult,
    AgentTurnChangeSummaryView,
    AgentTurnFileDiffView,
} from "./api-types";
import {
    assertRestorePlanMatchesConfirmation,
    type ConfirmedRestorePlanV1,
    type RewindConfirmationRegistry,
} from "./confirmation-token";
import { projectWorkspacePathDiff, WorkspaceDiffPreviewBudget } from "./diff-preview";
import { applyCapturedPath, verifyCapturedPath } from "./filesystem-apply";
import { inspectLivePath, inspectLivePaths, type LiveCapturedPathState } from "./live-path-state";
import { PendingWorkspaceRestoreStore } from "./pending-restore-store";
import {
    planRedo,
    planRewind,
    type PlanRedoInput,
    type PlanRewindInput,
    type RestorePlanV1,
    type RestoreTargetV1,
} from "./restore-plan";
import { countRevertedMessages, foldWorkspaceSessionState } from "./session-state";
import type { WorkspaceCheckpointSnapshotSource } from "./snapshot-source";
import type { WorkspaceSnapshotStore } from "./snapshot-store";
import { planTurnRedo, planTurnUndo, type PlanTurnRedoInput, type PlanTurnUndoInput } from "./turn-restore-plan";
import type { WorkspaceCheckpointV1, WorkspaceSnapshotRefV1, WorkspaceStateV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import { WorkspaceRecovery, type WorkspaceRecoveryOptions } from "./workspace-recovery";
import { WorkspaceRestoreExecutor } from "./workspace-restore-executor";
import { ProcessWorkspaceWriterLeases, type WorkspaceWriterLeaseRegistry } from "./workspace-writer-lease";

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

export interface PreviewTurnUndoInput extends PreviewRedoInput {
    sourceTurnId: string;
}

export type ReadTurnChangesInput = PreviewTurnUndoInput;

export interface ReadTurnFileDiffInput extends ReadTurnChangesInput {
    path: string;
}

export interface PreviewTurnRedoInput extends PreviewTurnUndoInput {
    undoOperationId: string;
}

export interface ApplyTurnUndoInput extends PreviewTurnUndoInput {
    mode: "normal" | "force-drift";
    confirmation: ConfirmedRestorePlanV1;
    assertCurrent?: () => Promise<void>;
}

export interface ApplyTurnRedoInput extends PreviewTurnRedoInput {
    confirmation: ConfirmedRestorePlanV1;
    assertCurrent?: () => Promise<void>;
}

export type WorkspaceRestorePreviewResult = Omit<AgentRewindPreviewResult, "target"> & {
    target: RestoreTargetV1;
};

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
    pending?: PendingWorkspaceRestoreStore;
    recovery?: WorkspaceRecovery;
    locateSession?: WorkspaceRecoveryOptions["locateSession"];
    snapshotSource?: WorkspaceCheckpointSnapshotSource;
    writerLeases?: Pick<WorkspaceWriterLeaseRegistry, "acquire">;
    confirmations: RewindConfirmationRegistry;
    planRewind?: (input: PlanRewindInput) => Promise<RestorePlanV1>;
    planRedo?: (input: PlanRedoInput) => Promise<RestorePlanV1>;
    planTurnUndo?: (input: PlanTurnUndoInput) => Promise<RestorePlanV1>;
    planTurnRedo?: (input: PlanTurnRedoInput) => Promise<RestorePlanV1>;
    inspectLivePath?: (path: string) => Promise<LiveCapturedPathState>;
    inspectLivePaths?: (paths: readonly string[]) => Promise<ReadonlyMap<string, LiveCapturedPathState>>;
    applyPath?: ApplyPath;
    verifyPath?: VerifyPath;
    createOperationId?: () => string;
    now?: () => Date;
    onCommitted?: (sessionId: string, operationId: string) => Promise<void>;
}

interface PlannedRestore {
    entries: SessionTreeEntry[];
    plan: RestorePlanV1;
    rewindState?: WorkspaceRewindMarkerV1;
    targetEntry?: Extract<SessionTreeEntry, { type: "message" }>;
}

type AvailableCheckpoint = Extract<WorkspaceCheckpointV1, { status: "available" }>;
type ProjectedTurnFile = AgentRewindFileRowView & {
    originalContent?: string;
    modifiedContent?: string;
};

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
    const targetTurnId = plan.target.kind === "rewind" ? plan.target.targetTurnId : rewindState?.rewind.targetTurnId;
    const leafId = plan.target.kind === "rewind" ? plan.semanticLeafId : rewindState?.rewind.fromLeafId;
    if (!targetTurnId) return 0;
    return countRevertedMessages(entries, targetTurnId, leafId ?? null);
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
    private readonly pending: PendingWorkspaceRestoreStore;
    private readonly recovery: WorkspaceRecovery;
    private readonly confirmations: RewindConfirmationRegistry;
    private readonly planRewindImpl: NonNullable<WorkspaceRewindEngineOptions["planRewind"]>;
    private readonly planRedoImpl: NonNullable<WorkspaceRewindEngineOptions["planRedo"]>;
    private readonly planTurnUndoImpl: NonNullable<WorkspaceRewindEngineOptions["planTurnUndo"]>;
    private readonly planTurnRedoImpl: NonNullable<WorkspaceRewindEngineOptions["planTurnRedo"]>;
    private readonly inspectPath: NonNullable<WorkspaceRewindEngineOptions["inspectLivePath"]>;
    private readonly inspectPaths: NonNullable<WorkspaceRewindEngineOptions["inspectLivePaths"]>;
    private readonly snapshotSource?: WorkspaceCheckpointSnapshotSource;
    private readonly writerLeases: Pick<WorkspaceWriterLeaseRegistry, "acquire">;
    readonly executor: WorkspaceRestoreExecutor;

    constructor(options: WorkspaceRewindEngineOptions) {
        this.store = options.store;
        if (options.pending && options.recovery && options.pending !== options.recovery.pending) {
            throw new Error("Workspace rewind engine pending store does not match its Resolver");
        }
        this.pending = options.pending ?? options.recovery?.pending ?? new PendingWorkspaceRestoreStore(options.store);
        if (!options.recovery && !options.locateSession) {
            throw new Error("Workspace rewind engine requires a Session locator for recovery");
        }
        this.recovery =
            options.recovery ??
            new WorkspaceRecovery({
                workspace: options.store.identity,
                store: options.store,
                pending: this.pending,
                locateSession: options.locateSession!,
                writerLeases: options.writerLeases,
            });
        this.confirmations = options.confirmations;
        this.planRewindImpl = options.planRewind ?? planRewind;
        this.planRedoImpl = options.planRedo ?? planRedo;
        this.planTurnUndoImpl = options.planTurnUndo ?? planTurnUndo;
        this.planTurnRedoImpl = options.planTurnRedo ?? planTurnRedo;
        this.inspectPath =
            options.inspectLivePath ?? ((path) => inspectLivePath(this.store.identity.canonicalRoot, path));
        this.inspectPaths =
            options.inspectLivePaths ?? ((paths) => inspectLivePaths(this.store.identity.canonicalRoot, paths));
        this.snapshotSource = options.snapshotSource;
        this.writerLeases = options.writerLeases ?? ProcessWorkspaceWriterLeases;
        this.executor = new WorkspaceRestoreExecutor({
            store: options.store,
            pending: this.pending,
            recovery: this.recovery,
            inspectLivePaths: this.inspectPaths,
            applyPath: options.applyPath,
            verifyPath: options.verifyPath,
            createOperationId: options.createOperationId,
            now: options.now,
            onCommitted: options.onCommitted,
        });
    }

    async previewRewind(input: PreviewRewindInput): Promise<AgentRewindPreviewResult> {
        this.assertWorkspace(input.workspace);
        return (await this.preview(await this.computeRewind(input))) as AgentRewindPreviewResult;
    }

    async previewRedo(input: PreviewRedoInput): Promise<AgentRewindPreviewResult> {
        this.assertWorkspace(input.workspace);
        return (await this.preview(await this.computeRedo(input))) as AgentRewindPreviewResult;
    }

    async previewTurnUndo(input: PreviewTurnUndoInput): Promise<WorkspaceRestorePreviewResult> {
        this.assertWorkspace(input.workspace);
        return this.preview(await this.computeTurnUndo(input));
    }

    async previewTurnRedo(input: PreviewTurnRedoInput): Promise<WorkspaceRestorePreviewResult> {
        this.assertWorkspace(input.workspace);
        return this.preview(await this.computeTurnRedo(input));
    }

    async getTurnChangeSummary(input: ReadTurnChangesInput): Promise<AgentTurnChangeSummaryView> {
        const projected = await this.projectTurnChanges(input);
        const files = projected.files.map((file) => ({
            path: file.path,
            operation: file.operation as "create" | "write" | "delete",
            additions: file.additions ?? null,
            deletions: file.deletions ?? null,
        }));
        const statisticsAvailable = files.every((file) => file.additions != null && file.deletions != null);
        return {
            turnId: input.sourceTurnId,
            semanticLeafId: projected.semanticLeafId,
            fileCount: files.length,
            additions: statisticsAvailable ? files.reduce((total, file) => total + (file.additions ?? 0), 0) : null,
            deletions: statisticsAvailable ? files.reduce((total, file) => total + (file.deletions ?? 0), 0) : null,
            files,
        };
    }

    async reviewTurnChanges(input: ReadTurnChangesInput): Promise<AgentReviewTurnChangesResult> {
        const projected = await this.projectTurnChanges(input);
        return {
            turnId: input.sourceTurnId,
            semanticLeafId: projected.semanticLeafId,
            files: projected.files,
        };
    }

    async getTurnFileDiff(input: ReadTurnFileDiffInput): Promise<AgentTurnFileDiffView> {
        const loaded = await this.loadTurnCheckpoint(input, "active-branch");
        const change = loaded.checkpoint.changes.find((candidate) => candidate.path === input.path);
        if (!change) throw new Error("Turn file is not present in the workspace checkpoint");
        const file = await projectWorkspacePathDiff({
            path: change.path,
            before: change.before,
            after: change.after,
            readBlob: (oid) => this.store.readBlob(oid),
            budget: new WorkspaceDiffPreviewBudget(),
        });
        const originalContent = file.originalContent ?? "";
        const modifiedContent = file.modifiedContent ?? "";
        return {
            turnId: input.sourceTurnId,
            path: file.path,
            operation: file.operation as "create" | "write" | "delete",
            additions: file.additions ?? 0,
            deletions: file.deletions ?? 0,
            originalContent,
            modifiedContent,
            isBinary: file.previewUnavailableReason === "binary file",
            fallbackPatch: file.diff ?? "",
            truncated:
                file.previewUnavailableReason === "file exceeds preview size limit" ||
                file.previewUnavailableReason === "request exceeds preview input limit",
            ...(file.previewUnavailableReason == null
                ? {}
                : { previewUnavailableReason: file.previewUnavailableReason }),
        };
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

    async applyTurnUndo(input: ApplyTurnUndoInput): Promise<WorkspaceRewindCommitResult> {
        return this.applyTurn(input, () => this.computeTurnUndo(input));
    }

    async applyTurnRedo(input: ApplyTurnRedoInput): Promise<WorkspaceRewindCommitResult> {
        return this.applyTurn({ ...input, mode: "normal" }, () => this.computeTurnRedo(input));
    }

    private async projectTurnChanges(input: ReadTurnChangesInput): Promise<{
        semanticLeafId: string | null;
        files: ProjectedTurnFile[];
    }> {
        const loaded = await this.loadTurnCheckpoint(input);
        const budget = new WorkspaceDiffPreviewBudget();
        const files: ProjectedTurnFile[] = [];
        for (const change of loaded.checkpoint.changes) {
            files.push(
                await projectWorkspacePathDiff({
                    path: change.path,
                    before: change.before,
                    after: change.after,
                    readBlob: (oid) => this.store.readBlob(oid),
                    budget,
                })
            );
        }
        return { semanticLeafId: loaded.semanticLeafId, files };
    }

    private async loadTurnCheckpoint(
        input: ReadTurnChangesInput,
        authority: "expected-leaf" | "active-branch" = "expected-leaf"
    ): Promise<{
        semanticLeafId: string | null;
        checkpoint: AvailableCheckpoint;
    }> {
        this.assertWorkspace(input.workspace);
        const entries = await input.session.getEntries();
        const folded = foldWorkspaceSessionState(entries, input.sessionId);
        if (authority === "expected-leaf" && folded.semanticLeafId !== input.semanticLeafId) {
            throw new Error("semantic leaf changed");
        }
        const checkpoint = folded.checkpointsByTurnId.get(input.sourceTurnId);
        if (checkpoint?.status !== "available") {
            throw new Error("workspace checkpoint is unavailable");
        }
        if (
            checkpoint.workspaceIdentity !== input.workspace.workspaceIdentity ||
            checkpoint.workspaceIncarnation !== input.workspace.workspaceIncarnation
        ) {
            throw new Error("checkpoint workspace identity or incarnation does not match");
        }
        await this.store.verifyUntrustedSnapshot(checkpoint.before);
        await this.store.verifyUntrustedSnapshot(checkpoint.after);
        return { semanticLeafId: folded.semanticLeafId, checkpoint };
    }

    private async preview(planned: PlannedRestore): Promise<WorkspaceRestorePreviewResult> {
        const { plan, entries, rewindState } = planned;
        const targetTurnId =
            plan.target.kind === "rewind" ? plan.target.targetTurnId : rewindState?.rewind.targetTurnId;
        const targetEntry = planned.targetEntry ?? selectedUserEntry(entries, targetTurnId);
        const folded = foldWorkspaceSessionState(entries, plan.sessionId);
        let confirmationToken: string | undefined;
        if (!plan.hardBlocked) {
            confirmationToken = this.confirmations.issue(plan);
        }
        const files = await fileRows(plan, (oid) => this.store.readBlob(oid));
        return {
            ...(confirmationToken == null ? {} : { confirmationToken }),
            target: plan.target,
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
            mutationLog: this.store.mutationLog,
            diffSnapshots: (before, after) => this.store.diff(before, after),
            readCommitSnapshot: (commit) => this.store.readCommitSnapshot(commit),
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
        const rewindState = folded.conversationRedoState;
        if (!rewindState) {
            return {
                entries,
                plan: {
                    target: { kind: "redo", sourceRewindOperationId: "unavailable" } as RestoreTargetV1,
                    sessionId: input.sessionId,
                    workspaceIdentity: input.workspace.workspaceIdentity,
                    workspaceIncarnation: input.workspace.workspaceIncarnation,
                    semanticLeafId: input.semanticLeafId,
                    commitParentId: null,
                    paths: [],
                    coverageWarnings: [
                        { path: "", reason: "redo requires the current raw leaf to be this session's rewind marker" },
                    ],
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
            mutationLog: this.store.mutationLog,
            diffSnapshots: (before, after) => this.store.diff(before, after),
            readCommitSnapshot: (commit) => this.store.readCommitSnapshot(commit),
        });
        return {
            entries,
            plan,
            rewindState,
            targetEntry: selectedUserEntry(entries, rewindState.rewind.targetTurnId),
        };
    }

    private async computeTurnUndo(input: PreviewTurnUndoInput): Promise<PlannedRestore> {
        const entries = await input.session.getEntries();
        const plan = await this.planTurnUndoImpl({
            sessionId: input.sessionId,
            workspace: input.workspace,
            rawEntries: entries,
            semanticLeafId: input.semanticLeafId,
            sourceTurnId: input.sourceTurnId,
            inspectLivePath: this.inspectPath,
            inspectLivePaths: this.inspectPaths,
            verifySnapshot: (snapshot) => this.store.verifyUntrustedSnapshot(snapshot),
            mutationLog: this.store.mutationLog,
            diffSnapshots: (before, after) => this.store.diff(before, after),
            readCommitSnapshot: (commit) => this.store.readCommitSnapshot(commit),
        });
        return { entries, plan };
    }

    private async computeTurnRedo(input: PreviewTurnRedoInput): Promise<PlannedRestore> {
        const entries = await input.session.getEntries();
        const plan = await this.planTurnRedoImpl({
            sessionId: input.sessionId,
            workspace: input.workspace,
            rawEntries: entries,
            semanticLeafId: input.semanticLeafId,
            sourceTurnId: input.sourceTurnId,
            undoOperationId: input.undoOperationId,
            inspectLivePath: this.inspectPath,
            inspectLivePaths: this.inspectPaths,
            verifySnapshot: (snapshot) => this.store.verifyUntrustedSnapshot(snapshot),
            mutationLog: this.store.mutationLog,
            diffSnapshots: (before, after) => this.store.diff(before, after),
            readCommitSnapshot: (commit) => this.store.readCommitSnapshot(commit),
        });
        return { entries, plan };
    }

    private async applyTurn(
        input: ApplyTurnUndoInput | (ApplyTurnRedoInput & { mode: "normal" }),
        compute: () => Promise<PlannedRestore>
    ): Promise<WorkspaceRewindCommitResult> {
        this.assertWorkspace(input.workspace);
        return this.withRestoreLease(input.sessionId, async (source) => {
            const planned = await compute();
            assertRestorePlanMatchesConfirmation({
                confirmation: input.confirmation,
                plan: planned.plan,
                mode: input.mode,
            });
            return this.executor.execute({
                session: input.session,
                workspace: input.workspace,
                source,
                plan: planned.plan,
                confirmation: input.confirmation,
                mode: input.mode,
                assertCurrent: input.assertCurrent,
                commit: {
                    makeResult: ({ folded, sessionMetadata }) => ({
                        sessionMetadata,
                        semanticLeafId: folded.semanticLeafId,
                        displayLeafId: folded.displayLeafId,
                    }),
                },
            });
        });
    }

    private async apply(input: ApplyRestoreInput): Promise<WorkspaceRewindCommitResult> {
        this.assertWorkspace(input.workspace);
        return this.withRestoreLease(input.sessionId, async (source) => {
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
            return this.applyPlanned(input, planned, source);
        });
    }

    private async applyPlanned(
        input: ApplyRestoreInput,
        planned: PlannedRestore,
        source: WorkspaceSnapshotRefV1
    ): Promise<WorkspaceRewindCommitResult> {
        return this.executor.execute({
            session: input.session,
            workspace: input.workspace,
            source,
            plan: planned.plan,
            confirmation: input.confirmation,
            mode: input.mode,
            assertCurrent: input.assertCurrent,
            commit: {
                makeResult: ({ entries, folded, sessionMetadata }) => {
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
                            : {
                                  editorText: textFromContent((targetEntry.message as { content?: unknown }).content),
                              }),
                    };
                },
            },
        });
    }

    private async withRestoreLease<T>(
        sessionId: string,
        operation: (source: WorkspaceSnapshotRefV1) => Promise<T>
    ): Promise<T> {
        if (!this.snapshotSource) {
            throw new Error("Workspace rewind mutation requires the shared checkpoint snapshot source");
        }
        const lease = await this.writerLeases.acquire({
            workspaceKey: `${this.store.identity.workspaceIdentity}:${this.store.identity.workspaceIncarnation}`,
            sessionId,
            boundaryToken: `restore-${randomUUID()}`,
        });
        try {
            return await operation((await this.snapshotSource.synchronizeExternal()).ref);
        } finally {
            lease.release();
        }
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
