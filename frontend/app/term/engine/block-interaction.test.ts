// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { Block, LONG_RUNNING_COMMAND_DURATION_MS } from "./block";
import { DefaultTermMode } from "./types";

function makeRunningBlock(startTs: number): Block {
    const block = new Block({ id: "b1", seq: 1, cols: 80 });
    block.startCommand();
    block.startTs = startTs;
    return block;
}

describe("Block interaction state", () => {
    it("does not become long-running before the Warp threshold", () => {
        const block = makeRunningBlock(1_000);

        expect(block.isActiveAndLongRunning(1_000 + LONG_RUNNING_COMMAND_DURATION_MS)).toBe(false);
    });

    it("becomes long-running after the Warp threshold and stays cached while active", () => {
        const block = makeRunningBlock(1_000);

        expect(block.isActiveAndLongRunning(1_000 + LONG_RUNNING_COMMAND_DURATION_MS + 1)).toBe(true);
        expect(block.wasLongRunning).toBe(true);
        expect(block.isActiveAndLongRunning(1_010)).toBe(true);
    });

    it("does not report done blocks as active long-running commands", () => {
        const block = makeRunningBlock(1_000);

        expect(block.isActiveAndLongRunning(1_000 + LONG_RUNNING_COMMAND_DURATION_MS + 1)).toBe(true);
        block.finishCommand(0);

        expect(block.isActiveAndLongRunning(1_000 + LONG_RUNNING_COMMAND_DURATION_MS + 2)).toBe(false);
    });

    it("keeps alt-screen interaction state independent of block lifecycle", () => {
        const block = makeRunningBlock(1_000);

        block.finishCommand(0);
        block.enterAltScreen();

        expect(block.interactionMode(DefaultTermMode, 2_000)).toBe("alt-screen");
    });

    it("maps block interaction mode with alt-screen and terminal capture priority", () => {
        const block = makeRunningBlock(1_000);

        block.enterAltScreen();
        expect(block.interactionMode(DefaultTermMode, 2_000)).toBe("alt-screen");
        block.exitAltScreen();
        expect(block.interactionMode({ ...DefaultTermMode, appCursor: true }, 2_000)).toBe("long-running-command");
        expect(block.interactionMode({ ...DefaultTermMode, mouseClick: true }, 2_000)).toBe("terminal-capture");
        expect(block.interactionMode(DefaultTermMode, 2_000)).toBe("long-running-command");
    });
});
