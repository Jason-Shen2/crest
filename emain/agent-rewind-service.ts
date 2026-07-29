// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, Session, SessionTreeEntry } from "@crest/agent/harness/types";
import type { AgentRuntimeRegistry, RetainedSessionMutationLease } from "@crest/coding-agent/agent-runtime-registry";
import type { AgentSessionRuntime } from "@crest/coding-agent/agent-session-runtime";
import { textFromContent } from "@crest/coding-agent/commands/session-views";
import type {
    AgentListRewindPointsInput,
    AgentListRewindPointsResult,
    AgentPreviewRewindInput,
    AgentRedoRewindInput,
    AgentRewindMutationResult,
    AgentRewindPreviewResult,
    AgentRewindTreeInput,
} from "@crest/coding-agent/workspace-rewind/api-types";
import type { RewindConfirmationRegistry } from "@crest/coding-agent/workspace-rewind/confirmation-token";
import type { WorkspaceRewindEngine } from "@crest/coding-agent/workspace-rewind/rewind-engine";
import { foldWorkspaceSessionState } from "@crest/coding-agent/workspace-rewind/session-state";
import type { WorkspaceSnapshotStore } from "@crest/coding-agent/workspace-rewind/snapshot-store";
import type { CanonicalWorkspaceIdentity } from "@crest/coding-agent/workspace-rewind/workspace-identity";

import type { AgentSessionStateBroadcaster } from "./agent-session-state-broadcaster";

export interface AgentRewindResolvedWorkspace {
    workspace: CanonicalWorkspaceIdentity;
    store: Pick<WorkspaceSnapshotStore, "withWorkspaceLock">;
    engine: WorkspaceRewindEngine;
}

export interface ResolveAgentRewindWorkspaceInput {
    sessionMetadata: JsonlSessionMetadata;
    lease: RetainedSessionMutationLease<AgentSessionRuntime>;
    publishState(): Promise<void>;
}

export interface AgentRewindServiceOptions {
    registry: Pick<AgentRuntimeRegistry<AgentSessionRuntime>, "withRetainedSessionMutation">;
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

    rewind(input: AgentRewindTreeInput): Promise<AgentRewindMutationResult> {
        return this.withLockedSession(input.sessionMetadata, ({ session, workspace, engine }) => {
            const confirmation = this.confirmations.take(input.confirmationToken);
            return engine.applyRewind({
                session,
                sessionId: input.sessionMetadata.id,
                workspace,
                semanticLeafId: input.expectedSemanticLeafId,
                targetTurnId: input.targetTurnId,
                mode: input.mode,
                confirmation,
            });
        });
    }

    redo(input: AgentRedoRewindInput): Promise<AgentRewindMutationResult> {
        return this.withLockedSession(input.sessionMetadata, ({ session, workspace, engine }) => {
            const confirmation = this.confirmations.take(input.confirmationToken);
            return engine.applyRedo({
                session,
                sessionId: input.sessionMetadata.id,
                workspace,
                semanticLeafId: input.expectedSemanticLeafId,
                confirmation,
            });
        });
    }

    private withLockedSession<T>(
        sessionMetadata: JsonlSessionMetadata,
        operation: (input: LockedSession) => Promise<T>
    ): Promise<T> {
        return this.registry.withRetainedSessionMutation(
            sessionMetadata.path,
            { rejectIfRunning: true },
            async (lease) => {
                const publishState = async () => {
                    await this.broadcaster.publishForLease(lease, sessionMetadata);
                };
                const resolved = await this.resolveWorkspace({
                    sessionMetadata,
                    lease,
                    publishState,
                });
                const session = await this.openSession(sessionMetadata);
                try {
                    return await resolved.store.withWorkspaceLock(() =>
                        operation({
                            session,
                            workspace: resolved.workspace,
                            engine: resolved.engine,
                        })
                    );
                } finally {
                    session.close();
                }
            }
        );
    }
}
