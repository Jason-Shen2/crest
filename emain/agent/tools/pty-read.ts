// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// pty-read.ts — subagent-private tool: read a running PTY command's
// output. Defaults to the Go backend transcript tail; only asks the
// renderer for a screen snapshot when the backend altScreen bit is set
// (mode=auto) or mode=screen is requested. Mirrors Warp's
// ReadShellCommandOutput / LongRunningCommandSnapshot. See spec §3, §6.2.

import { type Static, Type } from "typebox";
import type { AgentTool } from "../types";
import { getCmdBlockTail } from "./_pty-rpc";
import { getScreenSnapshot } from "./_pty-screen";

const ptyReadSchema = Type.Object({
    block_id: Type.String(),
    delay_ms: Type.Optional(Type.Number()),
    mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("transcript"), Type.Literal("screen")])),
    max_lines: Type.Optional(Type.Number()),
});

export type PtyReadInput = Static<typeof ptyReadSchema>;

export interface PtyReadDetails {
    block_id: string;
    source: "transcript_tail" | "screen_snapshot";
    is_running?: boolean;
    exit_code?: number;
    approximate?: true;
    is_alt_screen_active?: boolean;
    degraded?: boolean;
}

const DEFAULT_MAX_LINES = 60;

async function readTranscript(blockId: string, maxLines: number, degraded: boolean) {
    const tail = await getCmdBlockTail(blockId, { maxLines });
    const details: PtyReadDetails = {
        block_id: blockId,
        source: "transcript_tail",
        is_running: tail.isrunning,
        exit_code: tail.exitcode,
        approximate: true,
        is_alt_screen_active: tail.altscreen,
        ...(degraded ? { degraded: true } : {}),
    };
    return { content: [{ type: "text" as const, text: tail.text }], details, tail };
}

export function createPtyReadTool(blockId: string): AgentTool<typeof ptyReadSchema, PtyReadDetails> {
    return {
        name: "pty_read",
        label: "pty read",
        description:
            "Read the running PTY command's recent output. Defaults to the backend transcript tail; use mode=screen for a precise TUI screen snapshot (vim/top). mode=auto picks screen only when the command is in a full-screen (alt-screen) TUI.",
        promptSnippet: "Read the running PTY command's output (transcript tail / TUI screen).",
        parameters: ptyReadSchema,
        async execute(_toolCallId, params) {
            const id = params.block_id || blockId;
            const maxLines = params.max_lines ?? DEFAULT_MAX_LINES;
            if (params.delay_ms && params.delay_ms > 0) {
                await new Promise((r) => setTimeout(r, params.delay_ms));
            }
            const mode = params.mode ?? "auto";

            // Peek the tail first: it carries the authoritative altScreen bit.
            const first = await readTranscript(id, maxLines, false);
            const wantScreen = mode === "screen" || (mode === "auto" && first.tail.altscreen);
            if (!wantScreen) {
                return { content: first.content, details: first.details };
            }
            try {
                const snap = await getScreenSnapshot(id);
                const details: PtyReadDetails = {
                    block_id: id,
                    source: "screen_snapshot",
                    is_alt_screen_active: snap.is_alt_screen_active,
                    is_running: first.tail.isrunning,
                };
                return {
                    content: [{ type: "text", text: `${snap.grid_contents}\n[cursor: ${snap.cursor}]` }],
                    details,
                };
            } catch {
                // Renderer unavailable → degrade to transcript (spec §3a).
                const degraded = await readTranscript(id, maxLines, true);
                return { content: degraded.content, details: degraded.details };
            }
        },
    };
}
