// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { Block } from "./block";
import { BlockHandler } from "./block-handler";
import { Blocks } from "./blocks";

describe("BlockHandler agent-block defensive guard", () => {
    it("onText / CSI / OSC / ESC do not mutate an agent block's grid", () => {
        const blocks = new Blocks();
        const agent = blocks.appendAgentBlock("run-test");
        const handler = new BlockHandler(agent);

        // Capture grid state before feeding parser events.
        const before = agent.outputGrid.raw().rowCount();

        // A bunch of parser events that would normally write into the grid.
        handler.onText("hello world");
        handler.onLineFeed();
        handler.onCarriageReturn();
        handler.onBackspace();
        handler.onTab();
        handler.onShiftOut();
        handler.onShiftIn();
        handler.onCsi("H", [1, 1], "", false);
        handler.onOsc("0;some title");
        handler.onEsc("c", "");

        const after = agent.outputGrid.raw().rowCount();
        expect(after).toBe(before);
        // Agent block keeps its agentRef marker; nothing the parser
        // did changed the run binding.
        expect(agent.agentRef?.runId).toBe("run-test");
    });

    it("shell blocks still receive writes (regression check)", () => {
        const shell = new Block({ id: "s1", seq: 0, cols: 80 });
        const handler = new BlockHandler(shell);
        // A shell block sees its outputGrid only after startCommand().
        shell.startPrompt();
        shell.endPrompt();
        shell.startCommand();
        handler.onText("hi");
        const row0 = shell.outputGrid.raw().getRow(0);
        const text = row0
            .filter((c) => c.width > 0)
            .map((c) => c.char || " ")
            .join("")
            .trimEnd();
        expect(text).toBe("hi");
    });
});
