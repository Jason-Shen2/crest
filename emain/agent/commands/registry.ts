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
