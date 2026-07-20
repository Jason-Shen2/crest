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
    | "copy"
    | "export"
    | "import"
    | "reload";

export type AgentSlashCommandRoute =
    | { handled: false }
    | { handled: true; kind: "builtin"; command: AgentSlashCommandName; argsText: string }
    | { handled: true; kind: "extension"; name: string; argsText: string };

const RoutedAgentSlashCommands = new Set<AgentSlashCommandName>([
    "tree",
    "fork",
    "clone",
    "model",
    "new",
    "resume",
    "compact",
    "session",
    "copy",
    "export",
    "import",
    "reload",
]);

/**
 * Resolve a composer input to a slash-command route. Built-in commands are
 * matched against the static RoutedAgentSlashCommands set. When
 * `extensionCommandNames` is supplied, any command name in that set that isn't
 * a built-in resolves to an { kind: "extension" } route so extension-registered
 * commands (pi.registerCommand) are handled instead of sent as a prompt.
 * Unknown names stay unhandled (sent to the LLM as an ordinary prompt).
 */
export function resolveAgentSlashCommandRoute(
    input: string,
    extensionCommandNames?: ReadonlySet<string>
): AgentSlashCommandRoute {
    const trimmed = input.trimEnd();
    if (!trimmed.startsWith("/") || trimmed === "/") {
        return { handled: false };
    }
    const match = /^\/([A-Za-z][\w-]*)(?:\s+(.*))?$/.exec(trimmed);
    if (!match) {
        return { handled: false };
    }
    const name = match[1];
    const argsText = (match[2] ?? "").trim();
    if (RoutedAgentSlashCommands.has(name as AgentSlashCommandName)) {
        return { handled: true, kind: "builtin", command: name as AgentSlashCommandName, argsText };
    }
    if (extensionCommandNames?.has(name)) {
        return { handled: true, kind: "extension", name, argsText };
    }
    return { handled: false };
}
