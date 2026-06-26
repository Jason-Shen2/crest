// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata } from "../harness/types";

export type AgentCommandSource = "builtin" | "skill" | "prompt";

export type AgentBackendCommandName =
    | "tree"
    | "fork"
    | "clone"
    | "new"
    | "resume"
    | "compact"
    | "session"
    | "copy"
    | "export"
    | "import"
    | "reload";

export type AgentCommandAction =
    | { type: "backend"; command: AgentBackendCommandName }
    | { type: "frontend"; action: "openModelPicker" };

export interface AgentCommandInfo {
    name: string;
    description: string;
    argumentHint?: string;
    source: AgentCommandSource;
    action: AgentCommandAction;
}

export type AgentCommandExecutionStatus = "success" | "noop";

export interface AgentCommandExecutionResult {
    status: AgentCommandExecutionStatus;
    message: string;
    sessionMetadata?: JsonlSessionMetadata;
}

export interface AgentRunCommandInput {
    sessionMetadata?: JsonlSessionMetadata;
    cwd: string;
    command: AgentBackendCommandName;
    argsText: string;
}

export interface ParsedAgentCommandInput {
    commandName: string;
    argsText: string;
}

export interface AgentTreeEntryView {
    id: string;
    parentId?: string;
    type: string;
    role?: string;
    label?: string;
    preview: string;
    timestamp?: string;
    isLeaf: boolean;
    isCurrent: boolean;
}

export interface AgentForkPointView {
    entryId: string;
    preview: string;
    timestamp?: string;
}
