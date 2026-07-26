// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// pty-transfer.ts — subagent-private tool: hand hosted PTY control back to the
// user when stuck (password / decision).

import { type Static, Type } from "typebox";
import type { AgentPtyCommandPort } from "../agent-pty-host";
import type { AgentTool } from "../types";

const ptyTransferSchema = Type.Object({
    command_id: Type.Optional(
        Type.String({
            description:
                "Deprecated compatibility field; omit it. This tool is already bound to one hosted PTY command.",
        })
    ),
    reason: Type.String({ description: "Why control is being handed back (e.g. needs a password)." }),
});

export type PtyTransferInput = Static<typeof ptyTransferSchema>;

export interface PtyTransferDetails {
    transferred: true;
    command_id: string;
    reason: string;
}

export function createPtyTransferTool(
    command: AgentPtyCommandPort
): AgentTool<typeof ptyTransferSchema, PtyTransferDetails> {
    return {
        name: "pty_transfer_to_user",
        label: "transfer to user",
        description:
            "Hand PTY control back to the user when you cannot proceed (waiting for a password or a human decision). Stops the subagent and leaves the command for the user to continue.",
        promptSnippet: "Hand control back to the user when stuck (password / decision).",
        parameters: ptyTransferSchema,
        async execute(_toolCallId, params) {
            command.requestUserInput(params.reason);
            return {
                content: [{ type: "text", text: `Transferred control to user: ${params.reason}` }],
                details: { transferred: true, command_id: command.commandId, reason: params.reason },
                terminate: true,
            };
        },
    };
}
