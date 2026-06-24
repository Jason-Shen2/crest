// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as jotai from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { Block } from "./engine";
import { TerminalModel } from "./terminal-model";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeRunningBlock(id: string, startedAt: number): Block {
    const block = new Block({ id, seq: 1, cols: 80 });
    block.state = "running";
    block.startTs = startedAt;
    return block;
}

describe("TerminalModel.getTerminalInputState", () => {
    let model: TerminalModel;

    beforeEach(async () => {
        model = new TerminalModel("outer-1", 80);
        await flush();
    });

    afterEach(() => {
        model.dispose();
    });

    it("returns input-editor after bootstrap when no command is running", () => {
        expect(model.getTerminalInputState()).toEqual({ kind: "input-editor" });
    });

    it("returns alt-screen before terminal capture and long-running states", () => {
        const block = makeRunningBlock("b1", 1000);
        block.enterAltScreen();
        model.getBlocks().push(block);
        Object.assign(model.getMode(), { appCursor: true });

        expect(model.getTerminalInputState(2000)).toEqual({
            kind: "alt-screen",
            blockId: "b1",
        });
    });

    it("returns terminal-capture before long-running state", () => {
        const block = makeRunningBlock("b1", 1000);
        model.getBlocks().push(block);
        Object.assign(model.getMode(), { mouseClick: true });

        expect(model.getTerminalInputState(2000)).toEqual({
            kind: "terminal-capture",
            blockId: "b1",
        });
    });

    it("returns long-running-command after the Warp threshold", () => {
        const block = makeRunningBlock("b1", 1000);
        model.getBlocks().push(block);

        expect(model.getTerminalInputState(1051)).toEqual({
            kind: "long-running-command",
            blockId: "b1",
        });
    });

    it("keeps input-editor before the Warp long-running threshold", () => {
        const block = makeRunningBlock("b1", 1000);
        model.getBlocks().push(block);

        expect(model.getTerminalInputState(1050)).toEqual({ kind: "input-editor" });
    });

    it("returns not-bootstrapped before initial rows finish loading", () => {
        globalStore.set(model.loadingAtom, true);

        expect(model.getTerminalInputState()).toEqual({ kind: "not-bootstrapped" });
    });
});
