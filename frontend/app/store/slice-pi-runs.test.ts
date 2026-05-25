// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { indexRunsById, slicePiRuns } from "./slice-pi-runs";
import type { PiAgentMessage } from "./use-pi-chat";

function user(text: string): PiAgentMessage {
    return { role: "user", content: [{ type: "text", text }] };
}
function assistant(text: string, stopReason?: string, errorMessage?: string): PiAgentMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
}
function assistantWithToolCall(
    text: string,
    toolCall: { id: string; name: string; input: unknown },
    stopReason?: string,
): PiAgentMessage {
    return {
        role: "assistant",
        content: [
            { type: "text", text },
            { type: "toolCall", id: toolCall.id, name: toolCall.name, input: toolCall.input },
        ],
        ...(stopReason !== undefined ? { stopReason } : {}),
    };
}
function toolResult(toolUseId: string, text: string, isError = false): PiAgentMessage {
    return {
        role: "toolResult",
        content: [
            { type: "toolResult", toolUseId, content: [{ type: "text", text }], isError },
        ],
    };
}

describe("slicePiRuns", () => {
    it("returns [] for an empty messages array", () => {
        expect(slicePiRuns([])).toEqual([]);
    });

    it("ignores leading non-user messages (defensive)", () => {
        // Shouldn't happen in practice — pi messages always start with
        // a user — but the slicer shouldn't crash if it sees noise.
        const messages = [assistant("orphan"), user("real start")];
        const runs = slicePiRuns(messages);
        expect(runs).toHaveLength(1);
        expect(runs[0].userMessageIndex).toBe(1);
    });

    it("one user + no responses → one streaming run", () => {
        const runs = slicePiRuns([user("hi")]);
        expect(runs).toHaveLength(1);
        expect(runs[0].runId).toBe("run-0");
        expect(runs[0].status).toBe("streaming");
        expect(runs[0].responseMessages).toEqual([]);
        expect(runs[0].userMessage).toEqual(user("hi"));
    });

    it("user + completed assistant → done", () => {
        const runs = slicePiRuns([user("q"), assistant("a", "stop")]);
        expect(runs).toHaveLength(1);
        expect(runs[0].status).toBe("done");
        expect(runs[0].responseMessages).toHaveLength(1);
    });

    it("user + erroring assistant → error with message", () => {
        const runs = slicePiRuns([user("q"), assistant("", "error", "rate limited")]);
        expect(runs[0].status).toBe("error");
        expect(runs[0].errorMessage).toBe("rate limited");
    });

    it("user + assistant mid-stream (no stopReason) → streaming", () => {
        const runs = slicePiRuns([user("q"), assistant("partial answer...")]);
        expect(runs[0].status).toBe("streaming");
    });

    it("multiple user messages → multiple runs", () => {
        const messages = [
            user("q1"),
            assistant("a1", "stop"),
            user("q2"),
            assistant("a2", "stop"),
        ];
        const runs = slicePiRuns(messages);
        expect(runs).toHaveLength(2);
        expect(runs[0].runId).toBe("run-0");
        expect(runs[1].runId).toBe("run-2");
        expect(runs[0].responseMessages).toHaveLength(1);
        expect(runs[1].responseMessages).toHaveLength(1);
    });

    it("tool-call turn: user + assistant(toolCall) + toolResult + assistant final → all in one run", () => {
        const messages = [
            user("read foo"),
            assistantWithToolCall("I'll read it", { id: "tc1", name: "read_file", input: { path: "/x" } }),
            toolResult("tc1", "file contents"),
            assistant("here's what I found", "stop"),
        ];
        const runs = slicePiRuns(messages);
        expect(runs).toHaveLength(1);
        expect(runs[0].responseMessages).toHaveLength(3);
        expect(runs[0].responseMessages[0].role).toBe("assistant");
        expect(runs[0].responseMessages[1].role).toBe("toolResult");
        expect(runs[0].responseMessages[2].role).toBe("assistant");
        expect(runs[0].status).toBe("done");
    });

    it("error mid-tool-loop: user + assistant(toolCall) + toolResult + assistant(error) → error", () => {
        const messages = [
            user("q"),
            assistantWithToolCall("trying", { id: "tc1", name: "shell_exec", input: { command: "x" } }),
            toolResult("tc1", "boom", true),
            assistant("", "error", "tool crashed"),
        ];
        const runs = slicePiRuns(messages);
        expect(runs[0].status).toBe("error");
        expect(runs[0].errorMessage).toBe("tool crashed");
    });

    it("status reads the LAST assistant message, not the first", () => {
        // First turn: assistant requested tool (no stopReason yet on
        // older protocol shapes); second turn: final answer with stop.
        const messages = [
            user("q"),
            assistant("partial"), // streaming-looking
            toolResult("tc1", "data"),
            assistant("done", "stop"),
        ];
        const runs = slicePiRuns(messages);
        expect(runs[0].status).toBe("done");
    });

    it("run with only a toolResult after user (no assistant) → streaming", () => {
        // Edge case: somehow a toolResult arrives before an assistant
        // message — status stays streaming because no assistant has
        // signaled completion.
        const messages = [user("q"), toolResult("tc1", "early")];
        const runs = slicePiRuns(messages);
        expect(runs[0].status).toBe("streaming");
    });
});

describe("indexRunsById", () => {
    it("builds a Map keyed by runId", () => {
        const runs = slicePiRuns([user("a"), assistant("x", "stop"), user("b")]);
        const idx = indexRunsById(runs);
        expect(idx.size).toBe(2);
        expect(idx.get("run-0")?.userMessage).toEqual(user("a"));
        expect(idx.get("run-2")?.userMessage).toEqual(user("b"));
    });

    it("returns empty map for empty runs", () => {
        expect(indexRunsById([]).size).toBe(0);
    });
});

describe("runId stability (timestamp-keyed)", () => {
    function userAt(text: string, timestamp: number): PiAgentMessage {
        return { role: "user", content: [{ type: "text", text }], timestamp };
    }

    it("derives runId from the user message timestamp, not the index", () => {
        const runs = slicePiRuns([userAt("hi", 1000), assistant("yo", "stop")]);
        expect(runs[0].runId).toBe("run-1000");
    });

    it("keeps the same runId when the message is re-indexed", () => {
        // The bug: the agent_end snapshot (or a mid-stream subscribe)
        // shifts a user message's array index. A positional id would
        // change and desync the frozen timeline block; the timestamp id
        // must not.
        const u = userAt("question", 1234);
        const beforeShift = slicePiRuns([u, assistant("a", "stop")]);
        const afterShift = slicePiRuns([
            userAt("earlier", 500),
            assistant("b", "stop"),
            u, // same message, now at a later index
            assistant("a", "stop"),
        ]);
        const matchedBefore = beforeShift.find((r) => r.userMessage === u);
        const matchedAfter = afterShift.find((r) => r.userMessage === u);
        expect(matchedBefore?.runId).toBe("run-1234");
        expect(matchedAfter?.runId).toBe("run-1234"); // unchanged despite re-index
    });
});
