// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata } from "../harness/types";

export type AgentCommandSource = "builtin" | "skill" | "prompt" | "extension";

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
    | { type: "frontend"; action: "openModelPicker" }
    // Command registered by an extension via pi.registerCommand(). `name` is the
    // dynamic command name; execution routes through the pane's live extension
    // ctx (see runAgentExtensionCommandForIpc), NOT the static backend switch.
    | { type: "extension"; name: string };

export interface AgentCommandInfo {
    name: string;
    description: string;
    argumentHint?: string;
    /**
     * Alternate names that resolve to this command. Used for compatibility
     * with other agents' command vocabularies (e.g. Claude Code's /clear is
     * an alias for /new). The frontend slash-command router normalizes an
     * alias to the canonical `name` before dispatch, so the backend only ever
     * sees the canonical command.
     */
    aliases?: string[];
    source: AgentCommandSource;
    action: AgentCommandAction;
}

/**
 * A keyboard shortcut an extension registered via pi.registerShortcut(),
 * surfaced to the renderer so it can bind the key and route activation back
 * through the pane's live extension ctx (agent:run-shortcut). `shortcut` is
 * pi's key string (e.g. "ctrl+k", "cmd+shift+p").
 */
export interface AgentShortcutInfo {
    shortcut: string;
    description?: string;
    extensionPath: string;
}

/**
 * A flag an extension registered via pi.registerFlag(). `value` is the live
 * value (from the pane's extension runtime when a session owns it, else the
 * registered default). The renderer renders a toggle (boolean) or text input
 * (string) and writes back via agent:set-flag.
 */
export interface AgentFlagInfo {
    name: string;
    description?: string;
    type: "boolean" | "string";
    default?: boolean | string;
    value?: boolean | string;
    extensionPath: string;
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
    /** Assistant stopReason, used by the renderer's FilterMode (Pi parity). */
    stopReason?: string;
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
