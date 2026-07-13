// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockId, mouseReportingActive, TermMode } from "./types";

export type TerminalInputState =
    | { kind: "not-bootstrapped" }
    | { kind: "input-editor" }
    | { kind: "long-running-command"; blockId: BlockId }
    | { kind: "alt-screen"; blockId: BlockId }
    | { kind: "terminal-capture"; blockId: BlockId };

export type CLIAgent = "claude" | "codex" | "gemini" | "pi" | "coco" | "unknown";

export type TerminalSurfaceState =
    | { kind: "normal-output"; blockId: BlockId }
    | { kind: "alt-screen"; blockId: BlockId }
    | { kind: "terminal-capture"; blockId: BlockId }
    | { kind: "long-running-pty"; blockId: BlockId }
    | { kind: "cli-agent"; blockId: BlockId; agent: CLIAgent };

export type CursorRenderState =
    | { kind: "hidden" }
    | { kind: "terminal" }
    | { kind: "suppressed"; reason: "cli-soft-cursor" | "rich-input-open" }
    | { kind: "cli-owned"; agent: CLIAgent };

export type CLIAgentSessionStatus = "starting" | "in-progress" | "idle" | "stopped" | "error";

export type CLIAgentInputState =
    | { kind: "closed" }
    | { kind: "pty-owned" }
    | { kind: "crest-rich-input-open"; entrypoint: "footer" | "shortcut" | "agent-event" };

export interface CLIAgentSession {
    blockId: BlockId;
    agent: CLIAgent;
    status: CLIAgentSessionStatus;
    inputState: CLIAgentInputState;
}

const CLIAgentNames = new Set<CLIAgent>(["claude", "codex", "gemini", "pi", "coco"]);

export function terminalCaptureActive(mode: TermMode | null | undefined): boolean {
    if (!mode) return false;
    return mouseReportingActive(mode);
}

export function detectCLIAgent(command: string | null | undefined): CLIAgent | null {
    const firstToken = command?.trim().split(/\s+/, 1)[0];
    if (!firstToken) return null;
    const basename = firstToken.split("/").pop() ?? "";
    return isCLIAgent(basename) ? basename : null;
}

function isCLIAgent(value: string): value is CLIAgent {
    return CLIAgentNames.has(value as CLIAgent);
}
