// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// pty-write.ts — subagent-private tool: write input to a running hosted PTY
// command.

import { type Static, Type } from "typebox";
import type { AgentPtyCommandPort } from "@crest/coding-agent/agent-pty-host";
import type { AgentTool } from "@crest/agent/types";

const ptyWriteSchema = Type.Object({
    command_id: Type.Optional(
        Type.String({
            description:
                "Deprecated compatibility field; omit it. This tool is already bound to one hosted PTY command.",
        })
    ),
    input: Type.String({ description: "Bytes / text to send" }),
    mode: Type.Union([Type.Literal("raw"), Type.Literal("line"), Type.Literal("block")]),
});

export type PtyWriteInput = Static<typeof ptyWriteSchema>;

export interface PtyWriteGuardOptions {
    initialCommand?: string;
    cwd?: string;
}

// C0 / bracketed-paste constants, per Warp escape_sequences.
const SOH = "\x01"; // ^A — "beginning of line" for readline/prompt-toolkit editors.
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function normalizeStartupInput(input: string): string {
    return input
        .replace(/^\x01+/, "")
        .replace(/\r?\n$/, "")
        .trim();
}

function shellQuoteSingle(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isStartupCommandReplay(input: string, opts?: PtyWriteGuardOptions): boolean {
    const initialCommand = opts?.initialCommand?.trim();
    if (!initialCommand) return false;
    const normalized = normalizeStartupInput(input);
    if (normalized === initialCommand) return true;
    const cwd = opts?.cwd?.trim();
    if (!cwd) return false;
    return (
        normalized === `cd ${cwd} && ${initialCommand}` ||
        normalized === `cd ${shellQuoteSingle(cwd)} && ${initialCommand}`
    );
}

function decorateBytes(input: string, mode: PtyWriteInput["mode"]): string {
    switch (mode) {
        case "raw":
            return input;
        case "line": {
            // Move to beginning of line, write input, then submit (Enter).
            // POSIX submits with LF; Windows submits with CR.
            const submit = process.platform === "win32" ? "\r" : "\n";
            return `${SOH}${input}${submit}`;
        }
        case "block": {
            // Warp only wraps when is_bracketed_paste_enabled; first phase
            // defaults enabled (Warp's common path). Otherwise pass through.
            const isBracketedPasteEnabled = true;
            return isBracketedPasteEnabled ? `${BRACKETED_PASTE_START}${input}${BRACKETED_PASTE_END}` : input;
        }
    }
}

export function createPtyWriteTool(
    command: AgentPtyCommandPort,
    guardOptions?: PtyWriteGuardOptions
): AgentTool<typeof ptyWriteSchema, undefined> {
    return {
        name: "pty_write",
        label: "pty write",
        description:
            "Write input to the running PTY command. mode=raw sends bytes as-is (control keys like Ctrl-C=\\x03); mode=line goes to line start then submits the input with Enter (answer a prompt); mode=block wraps in bracketed-paste (multi-line paste without auto-run).",
        promptSnippet: "Write input to the running PTY command (raw / line / block).",
        parameters: ptyWriteSchema,
        async execute(_toolCallId, params) {
            if (isStartupCommandReplay(params.input, guardOptions)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "ignored duplicate startup command; the CLI is already running in this PTY",
                        },
                    ],
                    details: undefined,
                };
            }
            await command.write(decorateBytes(params.input, params.mode));
            return { content: [{ type: "text", text: `sent ${params.mode} input` }], details: undefined };
        },
    };
}
