// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type AgentSlashCommandName =
    | "tree"
    | "fork"
    | "clone"
    | "model"
    | "new"
    | "resume"
    | "compact"
    | "session"
    | "info"
    | "copy"
    | "export"
    | "import"
    | "reload";

export type AgentSlashCommandRoute =
    | { handled: false }
    | { handled: true; command: AgentSlashCommandName; argsText: string };

const RoutedAgentSlashCommands = new Set<AgentSlashCommandName>([
    "tree",
    "fork",
    "clone",
    "model",
    "new",
    "resume",
    "compact",
    "session",
    "info",
    "copy",
    "export",
    "import",
    "reload",
]);

export function resolveAgentSlashCommandRoute(input: string): AgentSlashCommandRoute {
    const trimmed = input.trimEnd();
    if (!trimmed.startsWith("/") || trimmed === "/") {
        return { handled: false };
    }
    const match = /^\/([A-Za-z][\w-]*)(?:\s+(.*))?$/.exec(trimmed);
    if (!match) {
        return { handled: false };
    }
    const command = match[1] as AgentSlashCommandName;
    if (!RoutedAgentSlashCommands.has(command)) {
        return { handled: false };
    }
    if (command === "resume") {
        return {
            handled: true,
            command: "session",
            argsText: "",
        };
    }
    return {
        handled: true,
        command,
        argsText: (match[2] ?? "").trim(),
    };
}
