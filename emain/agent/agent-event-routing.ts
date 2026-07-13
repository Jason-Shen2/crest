// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface AgentEventPayload {
    sessionPath: string;
    event: unknown;
}

export function makeAgentEventPayload(
    canonicalSessionPath: string,
    rendererSessionPath: string | undefined,
    event: unknown
): AgentEventPayload {
    return {
        sessionPath: rendererSessionPath || canonicalSessionPath,
        event,
    };
}

export function makeAgentSubscriptionKey(
    senderId: number,
    canonicalSessionPath: string,
    rendererSessionPath: string | undefined = canonicalSessionPath
): string {
    return JSON.stringify([senderId, canonicalSessionPath, rendererSessionPath || canonicalSessionPath]);
}
