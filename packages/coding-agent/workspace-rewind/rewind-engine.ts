// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, Session, SessionTreeEntry } from "@crest/agent/harness/types";

import { textFromContent } from "../commands/session-views";
import type { AgentRewindFileRowView, AgentRewindPreviewResult } from "./api-types";
import {
    assertRestorePlanMatchesConfirmation,
    type ConfirmedRestorePlanV1,
    type RewindConfirmationRegistry,
} from "./confirmation-token";
import { projectWorkspacePathDiff, WorkspaceDiffPreviewBudget } from "./diff-preview";
import { applyCapturedPath, verifyCapturedPath } from "./filesystem-apply";
import { inspectLivePath, inspectLivePaths, type LiveCapturedPathState } from "./live-path-state";
import type { WorkspaceRecoveryJournal } from "./recovery-journal";
import {
    planRedo,
    planRewind,
    type PlanRedoInput,
    type PlanRewindInput,
    type RestorePlanV1,
    type RestoreTargetV1,
} from "./restore-plan";
import { foldWorkspaceSessionState } from "./session-state";
import type { WorkspaceSnapshotStore } from "./snapshot-store";
import { planTurnRedo, planTurnUndo, type PlanTurnRedoInput, type PlanTurnUndoInput } from "./turn-restore-plan";
import type { WorkspaceStateV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import type { WorkspaceRecovery } from "./workspace-recovery";
import { WorkspaceRestoreExecutor, workspaceStateFromJournal } from "./workspace-restore-executor";

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
    journal: WorkspaceRecoveryJournal;
    recovery: Pick<WorkspaceRecovery, "recoverRecord" | "isExactOperationLeaf">;
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
    const targetTurnId = plan.target.kind === "rewind" ? plan.target.targetTurnId : rewindState?.rewind.targetTurnId;
    const leafId = plan.target.kind === "rewind" ? plan.semanticLeafId : rewindState?.rewind.fromLeafId;
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
    private readonly planTurnUndoImpl: NonNullable<WorkspaceRewindEngineOptions["planTurnUndo"]>;
    private readonly planTurnRedoImpl: NonNullable<WorkspaceRewindEngineOptions["planTurnRedo"]>;
    private readonly inspectPath: NonNullable<WorkspaceRewindEngineOptions["inspectLivePath"]>;
    private readonly inspectPaths: NonNullable<WorkspaceRewindEngineOptions["inspectLivePaths"]>;
    readonly executor: WorkspaceRestoreExecutor;

    constructor(options: WorkspaceRewindEngineOptions) {
        this.store = options.store;
        this.journal = options.journal;
        this.recovery = options.recovery;
        this.confirmations = options.confirmations;
        this.planRewindImpl = options.planRewind ?? planRewind;
        this.planRedoImpl = options.planRedo ?? planRedo;
        this.planTurnUndoImpl = options.planTurnUndo ?? planTurnUndo;
        this.planTurnRedoImpl = options.planTurnRedo ?? planTurnRedo;
        this.inspectPath =
            options.inspectLivePath ?? ((path) => inspectLivePath(this.store.identity.canonicalRoot, path));
        this.inspectPaths =
            options.inspectLivePaths ?? ((paths) => inspectLivePaths(this.store.identity.canonicalRoot, paths));
        this.executor = new WorkspaceRestoreExecutor({
            store: options.store,
            journal: options.journal,
            recovery: options.recovery,
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
                    target: { kind: "redo" },
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
            verifySnapshot: (snapshot) => this.store.verify(snapshot),
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
            verifySnapshot: (snapshot) => this.store.verify(snapshot),
        });
        return { entries, plan };
    }

    private async applyTurn(
        input: ApplyTurnUndoInput | (ApplyTurnRedoInput & { mode: "normal" }),
        compute: () => Promise<PlannedRestore>
    ): Promise<WorkspaceRewindCommitResult> {
        this.assertWorkspace(input.workspace);
        const operation = async () => {
            const planned = await compute();
            assertRestorePlanMatchesConfirmation({
                confirmation: input.confirmation,
                plan: planned.plan,
                mode: input.mode,
            });
            return this.executor.execute({
                session: input.session,
                workspace: input.workspace,
                plan: planned.plan,
                confirmation: input.confirmation,
                mode: input.mode,
                assertCurrent: input.assertCurrent,
                commit: {
                    makeWorkspaceState: workspaceStateFromJournal,
                    makeResult: ({ folded, sessionMetadata }) => ({
                        sessionMetadata,
                        semanticLeafId: folded.semanticLeafId,
                        displayLeafId: folded.displayLeafId,
                    }),
                },
            });
        };
        return this.store.withWorkspaceLock ? this.store.withWorkspaceLock(operation) : operation();
    }

    private async apply(input: ApplyRestoreInput): Promise<WorkspaceRewindCommitResult> {
        this.assertWorkspace(input.workspace);
        const operation = async () => {
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
        };
        return this.store.withWorkspaceLock ? this.store.withWorkspaceLock(operation) : operation();
    }

    private async applyPlanned(
        input: ApplyRestoreInput,
        planned: PlannedRestore
    ): Promise<WorkspaceRewindCommitResult> {
        return this.executor.execute({
            session: input.session,
            workspace: input.workspace,
            plan: planned.plan,
            confirmation: input.confirmation,
            mode: input.mode,
            assertCurrent: input.assertCurrent,
            commit: {
                makeWorkspaceState: (record) => workspaceStateFromJournal(record),
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
