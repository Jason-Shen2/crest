// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface AgentEventPayload {
    sessionPath: string;
    workspaceId: string;
    generation: number;
    event: unknown;
}

export interface AgentEventWorkspaceIdentity {
    workspaceId: string;
    generation: number;
}

export function makeAgentEventPayload(
    canonicalSessionPath: string,
    rendererSessionPath: string | undefined,
    identity: AgentEventWorkspaceIdentity,
    event: unknown
): AgentEventPayload {
    return {
        sessionPath: rendererSessionPath || canonicalSessionPath,
        workspaceId: identity.workspaceId,
        generation: identity.generation,
        event,
    };
}

export function makeAgentSubscriptionKey(
    senderId: number,
    canonicalSessionPath: string,
    rendererSessionPath: string | undefined,
    identity: AgentEventWorkspaceIdentity
): string {
    return JSON.stringify([
        senderId,
        identity.workspaceId,
        identity.generation,
        canonicalSessionPath,
        rendererSessionPath || canonicalSessionPath,
    ]);
}
