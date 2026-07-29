// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, Session } from "@crest/agent/harness/types";
import type { AgentMessage } from "@crest/agent/types";
import type { AgentPtySnapshot } from "@crest/coding-agent/agent-pty-host";
import type { AgentRuntimeRegistry, RetainedSessionMutationLease } from "@crest/coding-agent/agent-runtime-registry";
import {
    buildContextStateFromSessionEntries,
    buildPersistedTurnsFromSessionEntries,
    type AgentSessionRuntime,
    type AgentSessionRuntimeState,
    type AgentSessionRuntimeStatus,
    type AgentTurn,
    type AgentWorkspaceRewindState,
} from "@crest/coding-agent/agent-session-runtime";
import type { ContextProjectionReport } from "@crest/coding-agent/context/types";

export interface AgentAuthoritativeSessionState {
    type: "session_state";
    messages: AgentMessage[];
    turns: AgentTurn[];
    status: AgentSessionRuntimeStatus;
    errorMessage?: string;
    steer: AgentMessage[];
    followUp: AgentMessage[];
    contextReports: ContextProjectionReport[];
    commands: AgentPtySnapshot[];
    workspaceRewind: AgentWorkspaceRewindState;
}

export interface AgentSessionStatePublication {
    lease: RetainedSessionMutationLease<AgentSessionRuntime>;
    sessionMetadata: JsonlSessionMetadata;
    state: AgentAuthoritativeSessionState;
}

export interface AgentSessionStateBroadcasterOptions {
    registry: Pick<AgentRuntimeRegistry<AgentSessionRuntime>, "withMutationLeaseAccess">;
    openSession(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>>;
    publish(publication: AgentSessionStatePublication): Promise<void>;
    workspaceRewind:
        | AgentWorkspaceRewindState
        | ((metadata: JsonlSessionMetadata) => AgentWorkspaceRewindState | Promise<AgentWorkspaceRewindState>);
}

export function toAuthoritativeAgentSessionState(state: AgentSessionRuntimeState): AgentAuthoritativeSessionState {
    return {
        type: "session_state",
        messages: state.messages,
        turns: state.turns,
        status: state.status,
        errorMessage: state.errorMessage,
        steer: state.steerQueue,
        followUp: state.followUpQueue,
        contextReports: state.contextReports,
        commands: state.commands,
        workspaceRewind: state.workspaceRewind,
    };
}

export async function buildPersistedAgentSessionState(
    session: Pick<Session, "buildContext" | "getBranch">,
    workspaceRewind: AgentWorkspaceRewindState
): Promise<AgentAuthoritativeSessionState> {
    const branch = await session.getBranch();
    const context = await session.buildContext();
    return {
        type: "session_state",
        messages: context.messages,
        turns: buildPersistedTurnsFromSessionEntries(branch),
        status: "idle",
        errorMessage: undefined,
        steer: [],
        followUp: [],
        contextReports: buildContextStateFromSessionEntries(branch).contextReports,
        commands: [],
        workspaceRewind,
    };
}

/**
 * Publishes authoritative post-mutation state through a retained-lease-only
 * path. The injected publisher is responsible for the normal IPC sequencing;
 * it must not re-enter ordinary session access while the mutation tombstone is
 * active.
 */
export class AgentSessionStateBroadcaster {
    readonly registry: AgentSessionStateBroadcasterOptions["registry"];
    readonly openSession: AgentSessionStateBroadcasterOptions["openSession"];
    readonly publishState: AgentSessionStateBroadcasterOptions["publish"];
    readonly workspaceRewind: AgentSessionStateBroadcasterOptions["workspaceRewind"];

    constructor(options: AgentSessionStateBroadcasterOptions) {
        this.registry = options.registry;
        this.openSession = options.openSession;
        this.publishState = options.publish;
        this.workspaceRewind = options.workspaceRewind;
    }

    async publishForLease(
        lease: RetainedSessionMutationLease<AgentSessionRuntime>,
        sessionMetadata: JsonlSessionMetadata
    ): Promise<AgentAuthoritativeSessionState> {
        return this.registry.withMutationLeaseAccess(lease, async (runtime) => {
            const state = runtime
                ? toAuthoritativeAgentSessionState(
                      await runtime.refreshFromPersistedBranch({ discardCompletedPtyHistory: true })
                  )
                : await this.buildColdState(sessionMetadata);
            await this.publishState({ lease, sessionMetadata, state });
            return state;
        });
    }

    async buildColdState(sessionMetadata: JsonlSessionMetadata): Promise<AgentAuthoritativeSessionState> {
        const session = await this.openSession(sessionMetadata);
        try {
            return buildPersistedAgentSessionState(
                session,
                typeof this.workspaceRewind === "function"
                    ? await this.workspaceRewind(sessionMetadata)
                    : this.workspaceRewind
            );
        } finally {
            session.close();
        }
    }
}
