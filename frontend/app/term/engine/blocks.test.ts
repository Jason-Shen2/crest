// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { Block } from "./block";
import { Blocks } from "./blocks";

function makeShellBlock(id: string, seq: number, cols: number = 80): Block {
    return new Block({ id, seq, cols });
}

describe("Blocks.appendAgentBlock", () => {
    it("appends to the end without reordering existing blocks", () => {
        const blocks = new Blocks();
        blocks.push(makeShellBlock("s1", 0));
        blocks.push(makeShellBlock("s2", 1));

        const agent = blocks.appendAgentBlock("exc-1", "hi there");

        expect(blocks.length()).toBe(3);
        expect(blocks.at(0)?.id).toBe("s1");
        expect(blocks.at(1)?.id).toBe("s2");
        expect(blocks.at(2)).toBe(agent);
        expect(agent.kind).toBe("agent");
        expect(agent.agentPayload?.exchangeId).toBe("exc-1");
        expect(agent.agentPayload?.userText).toBe("hi there");
        expect(agent.agentPayload?.status).toBe("streaming");
        expect(agent.agentPayload?.assistantText).toBe("");
    });

    it("preserves call order across mixed shell/agent appends", () => {
        const blocks = new Blocks();
        blocks.push(makeShellBlock("s1", 0));
        blocks.appendAgentBlock("e1", "first ask");
        blocks.push(makeShellBlock("s2", 99));
        blocks.appendAgentBlock("e2", "second ask");

        const order = blocks.all().map((b) => ({ id: b.id, kind: b.kind }));
        expect(order).toEqual([
            { id: "s1", kind: "shell" },
            { id: "agent_e1", kind: "agent" },
            { id: "s2", kind: "shell" },
            { id: "agent_e2", kind: "agent" },
        ]);
    });

    it("assigns seq from current list length so IDs share a single space", () => {
        const blocks = new Blocks();
        blocks.push(makeShellBlock("s1", 0));
        const a1 = blocks.appendAgentBlock("e1", "q1");
        const a2 = blocks.appendAgentBlock("e2", "q2");
        expect(a1.seq).toBe(1);
        expect(a2.seq).toBe(2);
    });

    it("inherits cols from the last block when present, defaults to 80 otherwise", () => {
        const empty = new Blocks();
        const lonely = empty.appendAgentBlock("e0", "alone");
        expect(lonely.outputGrid.cols()).toBe(80);

        const with120 = new Blocks();
        with120.push(makeShellBlock("s1", 0, 120));
        const a = with120.appendAgentBlock("e1", "q");
        expect(a.outputGrid.cols()).toBe(120);
    });
});

describe("Block.appendAgentText / setAgentStatus", () => {
    it("accumulates deltas into assistantText (no overwrite)", () => {
        const blocks = new Blocks();
        const a = blocks.appendAgentBlock("e1", "user msg");
        a.appendAgentText("Hello");
        a.appendAgentText(", ");
        a.appendAgentText("world");
        expect(a.agentPayload?.assistantText).toBe("Hello, world");
    });

    it("setAgentStatus(\"error\", msg) records the error message", () => {
        const blocks = new Blocks();
        const a = blocks.appendAgentBlock("e1", "q");
        a.setAgentStatus("error", "ratelimited");
        expect(a.agentPayload?.status).toBe("error");
        expect(a.agentPayload?.errorMessage).toBe("ratelimited");
    });

    it("setAgentStatus(\"done\") clears any prior errorMessage", () => {
        const blocks = new Blocks();
        const a = blocks.appendAgentBlock("e1", "q");
        a.setAgentStatus("error", "transient");
        a.setAgentStatus("done");
        expect(a.agentPayload?.status).toBe("done");
        expect(a.agentPayload?.errorMessage).toBeUndefined();
    });

    it("mutators are no-ops on shell blocks", () => {
        const s = makeShellBlock("s1", 0);
        s.appendAgentText("should not crash");
        s.setAgentStatus("done");
        expect(s.agentPayload).toBeUndefined();
        expect(s.kind).toBe("shell");
    });
});
