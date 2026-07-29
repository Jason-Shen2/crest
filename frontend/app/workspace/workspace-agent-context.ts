// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AgentRuntimeClient, type AgentRuntimeElectronApi } from "@/app/agent/agent-runtime-client";

export interface WorkspaceAgentContextInput {
    workspaceId: string;
    generation: number;
    workspaceDir: string;
    sessionPath?: string;
    environment?: Record<string, string>;
    gitBranch?: string;
}

export function buildWorkspaceAgentExecutionContext(input: WorkspaceAgentContextInput): AgentExecutionContext {
    return {
        workspaceId: input.workspaceId,
        workspaceDir: input.workspaceDir,
        sessionPath: input.sessionPath,
        environment: { ...(input.environment ?? {}) },
        gitBranch: input.gitBranch,
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
