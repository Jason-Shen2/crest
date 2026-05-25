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

    it("inserts BEFORE a trailing waiting-for-input placeholder so the live prompt stays last", () => {
        // Repro for the ordering bug: when the timeline ends in the live
        // prompt placeholder, the agent block must land above it. Otherwise
        // the next `ls` (which fills the placeholder) renders above the agent
        // block and the following prompt below it.
        const blocks = new Blocks();
        blocks.push(makeShellBlock("s1", 0));
        blocks.push(makePromptPlaceholder("p", 1));

        blocks.appendAgentBlock("r1");

        const order = blocks.all().map((b) => ({ id: b.id, state: b.state }));
        expect(order).toEqual([
            { id: "s1", state: "done-with-execution" },
            { id: "agent_r1", state: "waiting-for-input" }, // agent block's own default; harmless
            { id: "p", state: "waiting-for-input" }, // live prompt remains last
        ]);
    });
});
