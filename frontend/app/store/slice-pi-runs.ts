// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// slice-pi-runs — split a flat pi AgentMessage[] into "runs", one per
// user-initiated send. A run is the natural unit for rendering an
// agent block in the timeline: user prompt + every subsequent
// non-user message until the next user message or end of array.
//
// Pure function. runId is derived from the user message's *timestamp*,
// not its array index, on purpose: an agent timeline block freezes the
// runId it was created with, while agentRunsById is rebuilt from the
// current array on every change. The `agent_end` event replaces the
// whole array with the authoritative session snapshot, and the renderer
// subscribes mid-stream — both can shift a message's index. A positional
// id ("run-0") then desyncs (frozen block id vs recomputed map key) and
// the block sticks on "…loading agent run…" forever. The timestamp is
// assigned once in the main process and travels unchanged through every
// event and the snapshot, so block id and map key always agree.

import type { PiAgentMessage } from "./use-pi-chat";

export type PiRunStatus = "streaming" | "done" | "error";

export interface PiRun {
    /** Stable id derived from the user message's timestamp. Format: "run-{ts}". */
    runId: string;
    /** Index of the user message within the source messages array. */
    userMessageIndex: number;
    /** The user message that initiated this run. */
    userMessage: PiAgentMessage;
    /** All non-user messages that followed (assistant + toolResult, in order). */
    responseMessages: PiAgentMessage[];
    /** Computed from the last assistant message's stopReason. */
    status: PiRunStatus;
    /** Set when status is "error". */
    errorMessage?: string;
}

/**
 * Slice messages into runs. Each user message starts a new run; the
 * run accumulates subsequent non-user messages until the next user
 * message or array end.
 *
 * Status derivation rules:
 *   - "streaming" — no assistant message yet OR last assistant has no
 *     stopReason (still being built up via message_update events)
 *   - "error"     — last assistant has stopReason === "error"
 *   - "done"      — last assistant has any other stopReason (stop /
 *                   max_tokens / aborted / tool_calls / ...)
 */
export function slicePiRuns(messages: PiAgentMessage[]): PiRun[] {
    const runs: PiRun[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== "user") continue;
        const responseMessages: PiAgentMessage[] = [];
        for (let j = i + 1; j < messages.length; j++) {
            const next = messages[j];
            if (next.role === "user") break;
            responseMessages.push(next);
        }
        const { status, errorMessage } = deriveStatus(responseMessages);
        runs.push({
            // Timestamp = stable identity (see file header). Fall back to
            // the index only if a message somehow lacks one — main always
            // stamps messages, so this is belt-and-suspenders.
            runId: `run-${msg.timestamp ?? i}`,
            userMessageIndex: i,
            userMessage: msg,
            responseMessages,
            status,
            errorMessage,
        });
    }
    return runs;
}

function deriveStatus(responseMessages: PiAgentMessage[]): {
    status: PiRunStatus;
    errorMessage?: string;
} {
    let lastAssistant: PiAgentMessage | undefined;
    for (let i = responseMessages.length - 1; i >= 0; i--) {
        if (responseMessages[i].role === "assistant") {
            lastAssistant = responseMessages[i];
            break;
        }
    }
    if (!lastAssistant) return { status: "streaming" };
    if (lastAssistant.stopReason === "error") {
        return { status: "error", errorMessage: lastAssistant.errorMessage };
    }
    if (lastAssistant.stopReason && lastAssistant.stopReason !== "") {
        return { status: "done" };
    }
    return { status: "streaming" };
}

/**
 * Build a Map<runId, PiRun> for O(1) lookup. Use when many
 * AgentBlockElement instances each need to find their own run on the
 * same messages snapshot.
 */
export function indexRunsById(runs: PiRun[]): Map<string, PiRun> {
    const map = new Map<string, PiRun>();
    for (const r of runs) map.set(r.runId, r);
    return map;
}
