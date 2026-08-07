// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, Session, SessionTreeEntry } from "@crest/agent/harness/types";
import type { AgentRuntimeRegistry, RetainedSessionMutationLease } from "@crest/coding-agent/agent-runtime-registry";
import type { AgentSessionRuntime } from "@crest/coding-agent/agent-session-runtime";
import { textFromContent } from "@crest/coding-agent/commands/session-views";
import type {
    AgentApplyTurnMutationInput,
    AgentGetTurnFileDiffInput,
    AgentListRewindPointsInput,
    AgentListRewindPointsResult,
    AgentPreviewRewindInput,
    AgentPreviewTurnMutationInput,
    AgentRedoRewindInput,
    AgentReviewTurnChangesResult,
    AgentRewindMutationResult,
    AgentRewindPreviewResult,
    AgentRewindTreeInput,
    AgentTurnChangeSummaryView,
    AgentTurnFileDiffView,
    AgentTurnMutationPreviewResult,
    AgentTurnTargetInput,
} from "@crest/coding-agent/workspace-rewind/api-types";
import type { RewindConfirmationRegistry } from "@crest/coding-agent/workspace-rewind/confirmation-token";
import type {
    WorkspaceRestorePreviewResult,
    WorkspaceRewindEngine,
} from "@crest/coding-agent/workspace-rewind/rewind-engine";
import { foldWorkspaceSessionState } from "@crest/coding-agent/workspace-rewind/session-state";
import type { WorkspaceSnapshotStore } from "@crest/coding-agent/workspace-rewind/snapshot-store";
import type { CanonicalWorkspaceIdentity } from "@crest/coding-agent/workspace-rewind/workspace-identity";

import type { AgentSessionStateBroadcaster } from "./agent-session-state-broadcaster";

export interface AgentRewindResolvedWorkspace {
    workspace: CanonicalWorkspaceIdentity;
    store: Pick<WorkspaceSnapshotStore, "withWorkspaceLock">;
    engine: WorkspaceRewindEngine;
    release?: () => Promise<void>;
}

export type ResolveAgentRewindWorkspaceInput =
    | {
          mode: "read";
          sessionMetadata: JsonlSessionMetadata;
      }
    | {
          mode: "mutation";
          sessionMetadata: JsonlSessionMetadata;
          lease: RetainedSessionMutationLease<AgentSessionRuntime>;
          publishState(): Promise<void>;
      };

export interface AgentRewindServiceOptions {
    registry: Pick<AgentRuntimeRegistry<AgentSessionRuntime>, "withRetainedSessionMutation" | "withSessionAccess">;
    confirmations: RewindConfirmationRegistry;
    openSession(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>>;
    resolveWorkspace(input: ResolveAgentRewindWorkspaceInput): Promise<AgentRewindResolvedWorkspace>;
    broadcaster: Pick<AgentSessionStateBroadcaster, "publishForLease">;
}

interface LockedSession {
    session: Session<JsonlSessionMetadata>;
    workspace: CanonicalWorkspaceIdentity;
    engine: WorkspaceRewindEngine;
}

function turnMutationPreview(result: WorkspaceRestorePreviewResult): AgentTurnMutationPreviewResult {
    if (result.target.kind !== "turn-undo" && result.target.kind !== "turn-redo") {
        throw new Error("Turn mutation preview returned an invalid restore target");
    }
    return {
        ...(result.confirmationToken == null ? {} : { confirmationToken: result.confirmationToken }),
        target: result.target,
        semanticLeafId: result.semanticLeafId,
        displayLeafId: result.displayLeafId,
        expectedSemanticLeafId: result.expectedSemanticLeafId,
        fileCount: result.fileCount,
        files: result.files,
        coverageWarnings: result.coverageWarnings,
        forceRequired: result.forceRequired,
        hardBlocked: result.hardBlocked,
    };
}

function activeBranch(entries: SessionTreeEntry[], leafId: string | null): SessionTreeEntry[] {
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

export class AgentRewindService {
    private readonly registry: AgentRewindServiceOptions["registry"];
    private readonly confirmations: RewindConfirmationRegistry;
    private readonly openSession: AgentRewindServiceOptions["openSession"];
    private readonly resolveWorkspace: AgentRewindServiceOptions["resolveWorkspace"];
    private readonly broadcaster: AgentRewindServiceOptions["broadcaster"];

    constructor(options: AgentRewindServiceOptions) {
        this.registry = options.registry;
        this.confirmations = options.confirmations;
        this.openSession = options.openSession;
        this.resolveWorkspace = options.resolveWorkspace;
        this.broadcaster = options.broadcaster;
    }

    listPoints(input: AgentListRewindPointsInput): Promise<AgentListRewindPointsResult> {
        return this.withLockedSession(input.sessionMetadata, async ({ session }) => {
            const entries = await session.getEntries();
            const folded = foldWorkspaceSessionState(entries, input.sessionMetadata.id);
            const eligible = new Set(folded.eligibleTurnIds);
            const gaps = new Map(folded.checkpointGaps.map((gap) => [gap.turnId, gap.reason]));
            const points = activeBranch(entries, folded.semanticLeafId)
                .filter(
                    (entry): entry is Extract<SessionTreeEntry, { type: "message" }> =>
                        entry.type === "message" && entry.message.role === "user"
                )
                .map((entry) => ({
                    turnId: entry.id,
                    preview: textFromContent((entry.message as { content?: unknown }).content),
                    timestamp: entry.timestamp,
                    eligible: eligible.has(entry.id),
                    ...(eligible.has(entry.id)
                        ? {}
                        : { reason: gaps.get(entry.id) ?? "workspace checkpoint is unavailable" }),
                }));
            return {
                points,
                semanticLeafId: folded.semanticLeafId,
                displayLeafId: folded.displayLeafId,
            };
        });
    }

    preview(input: AgentPreviewRewindInput): Promise<AgentRewindPreviewResult> {
        return this.withLockedSession(input.sessionMetadata, ({ session, workspace, engine }) =>
            input.target.kind === "rewind"
                ? engine.previewRewind({
                      session,
                      sessionId: input.sessionMetadata.id,
                      workspace,
                      semanticLeafId: input.expectedSemanticLeafId,
                      targetTurnId: input.target.targetTurnId,
                  })
                : engine.previewRedo({
                      session,
                      sessionId: input.sessionMetadata.id,
                      workspace,
                      semanticLeafId: input.expectedSemanticLeafId,
                  })
        );
    }

    getTurnChangeSummary(input: AgentTurnTargetInput): Promise<AgentTurnChangeSummaryView> {
        return this.withReadSession(input.sessionMetadata, ({ session, workspace, engine }) =>
            engine.getTurnChangeSummary({
                session,
                sessionId: input.sessionMetadata.id,
                workspace,
                semanticLeafId: input.expectedSemanticLeafId,
                sourceTurnId: input.turnId,
            })
        );
    }

    getTurnFileDiff(input: AgentGetTurnFileDiffInput): Promise<AgentTurnFileDiffView> {
        return this.withReadSession(input.sessionMetadata, ({ session, workspace, engine }) =>
            engine.getTurnFileDiff({
                session,
                sessionId: input.sessionMetadata.id,
                workspace,
                semanticLeafId: input.expectedSemanticLeafId,
                sourceTurnId: input.turnId,
                path: input.path,
            })
        );
    }

    reviewTurnChanges(input: AgentTurnTargetInput): Promise<AgentReviewTurnChangesResult> {
        return this.withReadSession(input.sessionMetadata, ({ session, workspace, engine }) =>
            engine.reviewTurnChanges({
                session,
                sessionId: input.sessionMetadata.id,
                workspace,
                semanticLeafId: input.expectedSemanticLeafId,
                sourceTurnId: input.turnId,
            })
        );
    }

    previewTurnUndo(input: AgentPreviewTurnMutationInput): Promise<AgentTurnMutationPreviewResult> {
        return this.withLockedSession(input.sessionMetadata, async ({ session, workspace, engine }) => {
            const result = await engine.previewTurnUndo({
                session,
                sessionId: input.sessionMetadata.id,
                workspace,
                semanticLeafId: input.expectedSemanticLeafId,
                sourceTurnId: input.turnId,
            });
            return turnMutationPreview(result);
        });
    }

    async previewTurnRedo(input: AgentPreviewTurnMutationInput): Promise<AgentTurnMutationPreviewResult> {
        const undoOperationId = input.undoOperationId;
        if (!undoOperationId) throw new Error("turn redo requires undoOperationId");
        return await this.withLockedSession(input.sessionMetadata, async ({ session, workspace, engine }) => {
            const result = await engine.previewTurnRedo({
                session,
                sessionId: input.sessionMetadata.id,
                workspace,
                semanticLeafId: input.expectedSemanticLeafId,
                sourceTurnId: input.turnId,
                undoOperationId,
            });
            return turnMutationPreview(result);
        });
    }

    applyTurnUndo(
        input: AgentApplyTurnMutationInput,
        assertCurrent: () => Promise<void> = async () => {}
    ): Promise<AgentRewindMutationResult> {
        return this.withLockedSession(
            input.sessionMetadata,
            ({ session, workspace, engine }) => {
                const confirmation = this.confirmations.take(input.confirmationToken);
                return engine.applyTurnUndo({
                    session,
                    sessionId: input.sessionMetadata.id,
                    workspace,
                    semanticLeafId: input.expectedSemanticLeafId,
                    sourceTurnId: input.turnId,
                    mode: input.mode,
                    confirmation,
                    assertCurrent,
                });
            },
            assertCurrent
        );
    }

    async applyTurnRedo(
        input: AgentApplyTurnMutationInput,
        assertCurrent: () => Promise<void> = async () => {}
    ): Promise<AgentRewindMutationResult> {
        const undoOperationId = input.undoOperationId;
        if (!undoOperationId) throw new Error("turn redo requires undoOperationId");
        if (input.mode !== "normal") throw new Error("turn redo does not support force mode");
        return await this.withLockedSession(
            input.sessionMetadata,
            ({ session, workspace, engine }) => {
                const confirmation = this.confirmations.take(input.confirmationToken);
                return engine.applyTurnRedo({
                    session,
                    sessionId: input.sessionMetadata.id,
                    workspace,
                    semanticLeafId: input.expectedSemanticLeafId,
                    sourceTurnId: input.turnId,
                    undoOperationId,
                    confirmation,
                    assertCurrent,
                });
            },
            assertCurrent
        );
    }

    rewind(
        input: AgentRewindTreeInput,
        assertCurrent: () => Promise<void> = async () => {}
    ): Promise<AgentRewindMutationResult> {
        return this.withLockedSession(
            input.sessionMetadata,
            ({ session, workspace, engine }) => {
                const confirmation = this.confirmations.take(input.confirmationToken);
                return engine.applyRewind({
                    session,
                    sessionId: input.sessionMetadata.id,
                    workspace,
                    semanticLeafId: input.expectedSemanticLeafId,
                    targetTurnId: input.targetTurnId,
                    mode: input.mode,
                    confirmation,
                    assertCurrent,
                });
            },
            assertCurrent
        );
    }

    redo(
        input: AgentRedoRewindInput,
        assertCurrent: () => Promise<void> = async () => {}
    ): Promise<AgentRewindMutationResult> {
        return this.withLockedSession(
            input.sessionMetadata,
            ({ session, workspace, engine }) => {
                const confirmation = this.confirmations.take(input.confirmationToken);
                return engine.applyRedo({
                    session,
                    sessionId: input.sessionMetadata.id,
                    workspace,
                    semanticLeafId: input.expectedSemanticLeafId,
                    confirmation,
                    assertCurrent,
                });
            },
            assertCurrent
        );
    }

    private withLockedSession<T>(
        sessionMetadata: JsonlSessionMetadata,
        operation: (input: LockedSession) => Promise<T>,
        assertCurrent: () => Promise<void> = async () => {}
    ): Promise<T> {
        return this.registry.withRetainedSessionMutation(
            sessionMetadata.path,
            { rejectIfRunning: true },
            async (lease) => {
                const publishState = async () => {
                    await this.broadcaster.publishForLease(lease, sessionMetadata);
                };
                const resolved = await this.resolveWorkspace({
                    mode: "mutation",
                    sessionMetadata,
                    lease,
                    publishState,
                });
                const session = await this.openSession(sessionMetadata);
                try {
                    await assertCurrent();
                    return await operation({
                        session,
                        workspace: resolved.workspace,
                        engine: resolved.engine,
                    });
                } finally {
                    session.close();
                    await resolved.release?.();
                }
            }
        );
    }

    private withReadSession<T>(
        sessionMetadata: JsonlSessionMetadata,
        operation: (input: LockedSession) => Promise<T>
    ): Promise<T> {
        return this.registry.withSessionAccess(sessionMetadata.path, async () => {
            const resolved = await this.resolveWorkspace({ mode: "read", sessionMetadata });
            const session = await this.openSession(sessionMetadata);
            try {
                return await operation({
                    session,
                    workspace: resolved.workspace,
                    engine: resolved.engine,
                });
            } finally {
                session.close();
            }
        });
    }
}
