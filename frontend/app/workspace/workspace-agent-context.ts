// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AgentRuntimeClient, type AgentRuntimeElectronApi } from "@/app/agent/agent-runtime-client";

export interface WorkspaceAgentContextInput {
    workspaceId: string;
    generation: number;
    workspaceDir: string;
    sessionPath?: string;
    connection?: string;
    environment?: Record<string, string>;
    preferredTerminalTabId?: string;
    gitBranch?: string;
    recentCmds?: string[];
}

export function buildWorkspaceAgentExecutionContext(input: WorkspaceAgentContextInput): AgentExecutionContext {
    return {
        workspaceId: input.workspaceId,
        workspaceDir: input.workspaceDir,
        sessionPath: input.sessionPath,
        connection: input.connection ?? "",
        environment: { ...(input.environment ?? {}) },
        preferredTerminalTabId: input.preferredTerminalTabId,
        gitBranch: input.gitBranch,
        recentCmds: [...(input.recentCmds ?? [])],
    };
}

export interface WorkspaceAgentContextValue {
    runtimeClient: AgentRuntimeClient;
    executionContext: AgentExecutionContext;
}

export function makeWorkspaceAgentContext(
    input: WorkspaceAgentContextInput,
    agentApi: AgentRuntimeElectronApi
): WorkspaceAgentContextValue {
    return {
        runtimeClient: new AgentRuntimeClient(agentApi, {
            workspaceId: input.workspaceId,
            generation: input.generation,
        }),
        executionContext: buildWorkspaceAgentExecutionContext(input),
    };
}
