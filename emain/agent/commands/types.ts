// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type AgentCommandSource = "builtin" | "skill" | "prompt";

export type AgentCommandAction =
    | { type: "backend"; command: "tree" | "fork" | "clone" | "compact" | "session" | "clear" | "new" | "help" }
    | { type: "frontend"; action: "openModelPicker" };

export interface AgentCommandInfo {
    name: string;
    description: string;
    argumentHint?: string;
    source: AgentCommandSource;
    action: AgentCommandAction;
}

export interface ParsedAgentCommandInput {
    commandName: string;
    argsText: string;
}
