// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { Block } from "./block";
import { Blocks } from "./blocks";

// A finished shell block (the realistic state of an "existing" block in the
// timeline). A fresh Block defaults to "waiting-for-input" — that state is
// reserved for the single live prompt placeholder at the tail.
function makeShellBlock(id: string, seq: number, cols: number = 80): Block {
    const b = new Block({ id, seq, cols });
    b.state = "done-with-execution";
    return b;
}

// The invisible live-prompt placeholder kept at the tail (mirrors the real
// shell's pending prompt; the visible input is the separate CmdBlockInput).
function makePromptPlaceholder(id: string, seq: number, cols: number = 80): Block {
    return new Block({ id, seq, cols }); // defaults to "waiting-for-input"
}

describe("Blocks.appendAgentBlock", () => {
    it("appends to the end without reordering existing blocks", () => {
        const blocks = new Blocks();
        blocks.push(makeShellBlock("s1", 0));
        blocks.push(makeShellBlock("s2", 1));

        const agent = blocks.appendAgentBlock("run-1");

        expect(blocks.length()).toBe(3);
        expect(blocks.at(0)?.id).toBe("s1");
        expect(blocks.at(1)?.id).toBe("s2");
        expect(blocks.at(2)).toBe(agent);
        expect(agent.kind).toBe("agent");
        expect(agent.agentRef?.runId).toBe("run-1");
        expect(typeof agent.agentRef?.createdAt).toBe("number");
        expect(agent.id).toBe("agent_run-1");
    });

    it("preserves call order across mixed shell/agent appends", () => {
        const blocks = new Blocks();
        blocks.push(makeShellBlock("s1", 0));
        blocks.appendAgentBlock("r1");
        blocks.push(makeShellBlock("s2", 99));
        blocks.appendAgentBlock("r2");

        const order = blocks.all().map((b) => ({ id: b.id, kind: b.kind }));
        expect(order).toEqual([
            { id: "s1", kind: "shell" },
            { id: "agent_r1", kind: "agent" },
            { id: "s2", kind: "shell" },
            { id: "agent_r2", kind: "agent" },
        ]);
    });

    it("assigns seq from current list length so IDs share a single space", () => {
        const blocks = new Blocks();
        blocks.push(makeShellBlock("s1", 0));
        const a1 = blocks.appendAgentBlock("r1");
        const a2 = blocks.appendAgentBlock("r2");
        expect(a1.seq).toBe(1);
        expect(a2.seq).toBe(2);
    });

    it("inherits cols from the last block when present, defaults to 80 otherwise", () => {
        const empty = new Blocks();
        const lonely = empty.appendAgentBlock("r0");
        expect(lonely.outputGrid.cols()).toBe(80);

        const with120 = new Blocks();
        with120.push(makeShellBlock("s1", 0, 120));
        const a = with120.appendAgentBlock("r1");
        expect(a.outputGrid.cols()).toBe(120);
    });

});

describe("Blocks.pinnedToBottom (warp pinned_to_bottom)", () => {
    it("keeps the pinned block last across appends — agent AND future block types", () => {
        // Repro for the ordering bug: the live prompt placeholder is pinned;
        // any block appended afterward must land ABOVE it. Otherwise the next
        // `ls` (which fills the placeholder) renders above the agent block and
        // the following prompt below it. The pin generalizes to every append,
        // so a future "notification"/"env"/"AI-suggestion" block is correct
        // for free — not just agent blocks.
        const blocks = new Blocks();
        blocks.push(makeShellBlock("s1", 0));
        blocks.push(makePromptPlaceholder("p", 1));
        blocks.setPinnedToBottom("p");

        blocks.appendAgentBlock("r1");
        blocks.push(makeShellBlock("future_notif", 2)); // simulate a future block type

        expect(blocks.all().map((b) => b.id)).toEqual(["s1", "agent_r1", "future_notif", "p"]);
    });

    it("setPinnedToBottom re-floats a block that already has items after it", () => {
        const blocks = new Blocks();
        blocks.push(makePromptPlaceholder("p", 0));
        blocks.push(makeShellBlock("s1", 1)); // appended after p, before the pin exists
        blocks.setPinnedToBottom("p");
        expect(blocks.all().map((b) => b.id)).toEqual(["s1", "p"]);
    });

    it("clearPinnedToBottom releases the pin so later appends go to the true tail", () => {
        const blocks = new Blocks();
        blocks.push(makePromptPlaceholder("p", 0));
        blocks.setPinnedToBottom("p");
        blocks.clearPinnedToBottom("p");
        blocks.push(makeShellBlock("s1", 1));
        expect(blocks.all().map((b) => b.id)).toEqual(["p", "s1"]);
    });

    it("clearPinnedToBottom ignores a non-matching id (can't clear a newer pin)", () => {
        const blocks = new Blocks();
        blocks.push(makePromptPlaceholder("p", 0));
        blocks.setPinnedToBottom("p");
        blocks.clearPinnedToBottom("stale-other-id"); // no-op
        blocks.push(makeShellBlock("s1", 1));
        expect(blocks.all().map((b) => b.id)).toEqual(["s1", "p"]); // still pinned
    });
});
