// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// pty-read.ts — subagent-private tool: read a running hosted PTY command's
// output.

import { type Static, Type } from "typebox";
import type { AgentPtyCommandPort, AgentPtySnapshot } from "@crest/coding-agent/agent-pty-host";
import type { AgentTool } from "@crest/agent/types";

const ptyReadSchema = Type.Object({
    command_id: Type.Optional(
        Type.String({
            description:
                "Deprecated compatibility field; omit it. This tool is already bound to one hosted PTY command.",
        })
    ),
    delay_ms: Type.Optional(Type.Number()),
    mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("transcript"), Type.Literal("screen")])),
    max_lines: Type.Optional(Type.Number()),
});

export type PtyReadInput = Static<typeof ptyReadSchema>;

export interface PtyReadDetails {
    command_id: string;
    source: "transcript_tail" | "screen_snapshot";
    is_running?: boolean;
    exit_code?: number;
    approximate?: true;
    is_alt_screen_active?: boolean;
}

const DEFAULT_MAX_LINES = 60;

function tailLines(text: string, maxLines: number): string {
    const lines = text.split("\n");
    const hasTrailingNewline = text.endsWith("\n");
    const kept = lines.filter(Boolean).slice(-maxLines);
    return kept.join("\n") + (hasTrailingNewline && kept.length > 0 ? "\n" : "");
}

function readTranscript(command: AgentPtyCommandPort, snap: AgentPtySnapshot, maxLines: number) {
    const details: PtyReadDetails = {
        command_id: command.commandId,
        source: "transcript_tail",
        is_running: snap.running,
        exit_code: snap.exitCode,
        approximate: true,
        is_alt_screen_active: snap.screen.isAltScreenActive,
    };
    return { content: [{ type: "text" as const, text: tailLines(snap.tail, maxLines) }], details };
}

function formatScreen(snap: AgentPtySnapshot): string {
    return [
        snap.screen.rows.map((row) => row.text).join("\n"),
        `[cursor: row ${snap.screen.cursor.row + 1}, col ${snap.screen.cursor.col + 1}]`,
    ].join("\n");
}

export function createPtyReadTool(command: AgentPtyCommandPort): AgentTool<typeof ptyReadSchema, PtyReadDetails> {
    return {
        name: "pty_read",
        label: "pty read",
        description:
            "Read the running hosted PTY command's recent output. Defaults to transcript tail; use mode=screen for a precise TUI screen snapshot (vim/top). mode=auto picks screen only when the command is in a full-screen (alt-screen) TUI.",
        promptSnippet: "Read the running PTY command's output (transcript tail / TUI screen).",
        parameters: ptyReadSchema,
        async execute(_toolCallId, params) {
            const maxLines = params.max_lines ?? DEFAULT_MAX_LINES;
            if (params.delay_ms && params.delay_ms > 0) {
                await new Promise((r) => setTimeout(r, params.delay_ms));
            }
            const mode = params.mode ?? "auto";
            const snap = command.read();
            const wantScreen = mode === "screen" || (mode === "auto" && snap.screen.isAltScreenActive);
            if (!wantScreen) {
                return readTranscript(command, snap, maxLines);
            }
            return {
                content: [{ type: "text", text: formatScreen(snap) }],
                details: {
                    command_id: command.commandId,
                    source: "screen_snapshot",
                    is_alt_screen_active: snap.screen.isAltScreenActive,
                    is_running: snap.running,
                    exit_code: snap.exitCode,
                },
            };
        },
    };
}
