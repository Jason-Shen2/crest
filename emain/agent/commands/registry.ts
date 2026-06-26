// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentCommandInfo, ParsedAgentCommandInput } from "./types";

const BuiltInAgentCommands: AgentCommandInfo[] = [
    {
        name: "tree",
        description: "Navigate the current agent session tree",
        source: "builtin",
        action: { type: "backend", command: "tree" },
    },
    {
        name: "fork",
        description: "Fork a new agent session from a previous user message",
        source: "builtin",
        action: { type: "backend", command: "fork" },
    },
    {
        name: "clone",
        description: "Clone the current agent session branch",
        source: "builtin",
        action: { type: "backend", command: "clone" },
    },
    {
        name: "model",
        description: "Open the model picker",
        source: "builtin",
        action: { type: "frontend", action: "openModelPicker" },
    },
    {
        name: "new",
        description: "Create a fresh agent session",
        source: "builtin",
        action: { type: "backend", command: "new" },
    },
    {
        name: "resume",
        description: "Resume an existing agent session for this workspace",
        source: "builtin",
        action: { type: "backend", command: "resume" },
    },
    {
        name: "compact",
        description: "Compact the current session context",
        argumentHint: "[instructions]",
        source: "builtin",
        action: { type: "backend", command: "compact" },
    },
    {
        name: "session",
        description: "Show current agent session information",
        source: "builtin",
        action: { type: "backend", command: "session" },
    },
    {
        name: "copy",
        description: "Copy the last assistant response",
        source: "builtin",
        action: { type: "backend", command: "copy" },
    },
    {
        name: "export",
        description: "Export the current session as JSONL",
        argumentHint: "[path]",
        source: "builtin",
        action: { type: "backend", command: "export" },
    },
    {
        name: "import",
        description: "Import a JSONL session",
        argumentHint: "<path>",
        source: "builtin",
        action: { type: "backend", command: "import" },
    },
    {
        name: "reload",
        description: "Reload agent command metadata",
        source: "builtin",
        action: { type: "backend", command: "reload" },
    },
];

export function getBuiltInAgentCommands(): AgentCommandInfo[] {
    return BuiltInAgentCommands.map((command) => ({ ...command, action: { ...command.action } }));
}

export function parseAgentCommandInput(input: string): ParsedAgentCommandInput | undefined {
    if (!input.startsWith("/") || input === "/") {
        return undefined;
    }
    const trimmed = input.trimEnd();
    const spaceIndex = trimmed.search(/\s/);
    if (spaceIndex === -1) {
        return { commandName: trimmed.slice(1), argsText: "" };
    }
    const commandName = trimmed.slice(1, spaceIndex);
    if (!commandName) {
        return undefined;
    }
    return {
        commandName,
        argsText: trimmed.slice(spaceIndex + 1).trim(),
    };
}
