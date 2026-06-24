// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import * as jotai from "jotai";

vi.mock("@/store/global", () => ({
    atoms: {
        staticTabId: jotai.atom("test-tab"),
    },
}));

vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: () => () => {
        /* no-op unsub */
    },
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {},
}));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        ControllerResyncCommand: vi.fn().mockResolvedValue(undefined),
        ControllerInputCommand: vi.fn().mockResolvedValue(undefined),
        GetCmdBlocksCommand: vi.fn().mockResolvedValue([]),
        GetCmdBlockOutputCommand: vi.fn().mockResolvedValue(""),
    },
}));

import { globalStore } from "@/app/store/jotaiStore";
import { Block } from "./engine/block";
import { LONG_RUNNING_COMMAND_DURATION_MS } from "./engine/block";
import { TerminalModel } from "./terminal-model";

function addBlock(model: TerminalModel, block: Block): void {
    model.getBlocks().push(block);
}

function runningBlock(id: string, startTs: number): Block {
    const block = new Block({ id, seq: 1, cols: 80 });
    block.startCommand();
    block.startTs = startTs;
    return block;
}

function loadedModel(): TerminalModel {
    const model = new TerminalModel("outer");
    globalStore.set(model.loadingAtom, false);
    return model;
}

describe("TerminalModel terminal state", () => {
    it("returns not-bootstrapped while initial blocks are loading", () => {
        const model = new TerminalModel("outer");
        expect(model.getTerminalInputState(1_000)).toEqual({ kind: "not-bootstrapped" });
        expect(model.getActiveSurfaceState(1_000)).toBe(null);
    });

    it("returns input-editor when no running block owns input", () => {
        const model = loadedModel();
        expect(model.getTerminalInputState(1_000)).toEqual({ kind: "input-editor" });
        expect(model.getActiveSurfaceState(1_000)).toBe(null);
    });

    it("gives alt-screen priority over terminal capture and long-running", () => {
        const model = loadedModel();
        const block = runningBlock("b1", 1_000);
        block.enterAltScreen();
        addBlock(model, block);
        model.setModeForTest({ appCursor: true });

        expect(model.getTerminalInputState(2_000)).toEqual({ kind: "alt-screen", blockId: "b1" });
        expect(model.getActiveSurfaceState(2_000)).toEqual({ kind: "alt-screen", blockId: "b1" });
    });

    it("returns terminal-capture for running capture modes", () => {
        const model = loadedModel();
        addBlock(model, runningBlock("b1", 1_000));
        model.setModeForTest({ appCursor: true });

        expect(model.getTerminalInputState(1_010)).toEqual({ kind: "terminal-capture", blockId: "b1" });
        expect(model.getActiveSurfaceState(1_010)).toEqual({ kind: "terminal-capture", blockId: "b1" });
    });

    it("returns long-running-command after the Warp threshold", () => {
        const model = loadedModel();
        addBlock(model, runningBlock("b1", 1_000));

        expect(model.getTerminalInputState(1_000 + LONG_RUNNING_COMMAND_DURATION_MS)).toEqual({ kind: "input-editor" });
        expect(model.getTerminalInputState(1_000 + LONG_RUNNING_COMMAND_DURATION_MS + 1)).toEqual({
            kind: "long-running-command",
            blockId: "b1",
        });
        expect(model.getActiveSurfaceState(1_000 + LONG_RUNNING_COMMAND_DURATION_MS + 1)).toEqual({
            kind: "long-running-pty",
            blockId: "b1",
        });
    });
});
