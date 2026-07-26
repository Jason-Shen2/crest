// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// pty-transfer.ts — subagent-private tool: hand PTY control back to the
// user when stuck (password / decision). Sets terminate so the harness
// stops; spawn_cli_agent returns early and leaves the blockId for the
// user. Mirrors Warp's TransferShellCommandControlToUser. See spec §6.

import { type Static, Type } from "typebox";
import type { AgentTool } from "@crest/agent/types";

const ptyTransferSchema = Type.Object({
    block_id: Type.Optional(
        Type.String({
            description: "Deprecated compatibility field; omit it. This tool is already bound to one PTY block.",
        }),
    ),
    reason: Type.String({ description: "Why control is being handed back (e.g. needs a password)." }),
});

export type PtyTransferInput = Static<typeof ptyTransferSchema>;

export interface PtyTransferDetails {
    transferred: true;
    block_id: string;
    reason: string;
}

export function createPtyTransferTool(blockId: string): AgentTool<typeof ptyTransferSchema, PtyTransferDetails> {
    return {
        name: "pty_transfer_to_user",
        label: "transfer to user",
        description:
            "Hand PTY control back to the user when you cannot proceed (waiting for a password or a human decision). Stops the subagent and leaves the command for the user to continue.",
        promptSnippet: "Hand control back to the user when stuck (password / decision).",
        parameters: ptyTransferSchema,
        async execute(_toolCallId, params) {
            return {
                content: [{ type: "text", text: `Transferred control to user: ${params.reason}` }],
                details: { transferred: true, block_id: blockId, reason: params.reason },
                terminate: true,
            };
        },
    };
}
