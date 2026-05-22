// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// P0.7 smoke checks at the engine layer.  Verifies that the chain
// `appendAgentBlock → appendAgentText → setAgentStatus` produces the
// state shape that AgentBlockElement consumes.  Run-time SSE smoke
// (real backend + ai-sdk + dev server) is manual.

import { describe, expect, it } from "vitest";

import { Block } from "./block";
import { Blocks } from "./blocks";

describe("agent block flow (smoke)", () => {
    it("typical exchange: append → stream deltas → status=done", () => {
        const blocks = new Blocks();
        const a = blocks.appendAgentBlock("exc-smoke", "show me ls");
        a.appendAgentText("Sure, ");
        a.appendAgentText("here you go:\n\n");
        a.appendAgentText("```\nfoo.txt\nbar.txt\n```");
        a.setAgentStatus("done");
        expect(a.agentPayload?.assistantText).toBe(
            "Sure, here you go:\n\n```\nfoo.txt\nbar.txt\n```"
        );
        expect(a.agentPayload?.status).toBe("done");
        expect(a.agentPayload?.errorMessage).toBeUndefined();
    });

    it("setAgentText snapshot path replaces (does not append)", () => {
        const blocks = new Blocks();
        const a = blocks.appendAgentBlock("exc-snapshot", "q");
        a.setAgentText("Hello");
        a.setAgentText("Hello world");
        a.setAgentText("Hello world!");
        expect(a.agentPayload?.assistantText).toBe("Hello world!");
    });

    it("error path: setAgentStatus stamps errorMessage; subsequent done clears it", () => {
        const blocks = new Blocks();
        const a = blocks.appendAgentBlock("exc-err", "q");
        a.setAgentStatus("error", "rate limited");
        expect(a.agentPayload?.errorMessage).toBe("rate limited");
        a.setAgentStatus("done");
        expect(a.agentPayload?.errorMessage).toBeUndefined();
    });

    it("shell block immunity: appendAgentText / setAgentStatus are no-ops on shell blocks", () => {
        const shell = new Block({ id: "s1", seq: 0, cols: 80 });
        shell.appendAgentText("noise");
        shell.setAgentText("noise");
        shell.setAgentStatus("done");
        expect(shell.agentPayload).toBeUndefined();
        expect(shell.kind).toBe("shell");
    });

    it("mixed shell + agent + shell timeline preserves order", () => {
        const blocks = new Blocks();
        const s1 = new Block({ id: "s1", seq: 0, cols: 80 });
        blocks.push(s1);
        blocks.appendAgentBlock("exc-1", "hi");
        const s2 = new Block({ id: "s2", seq: 99, cols: 80 });
        blocks.push(s2);
        blocks.appendAgentBlock("exc-2", "another");
        const kinds = blocks.all().map((b) => b.kind);
        expect(kinds).toEqual(["shell", "agent", "shell", "agent"]);
    });
});
