// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for TerminalModel's agent surface (P0.2 acceptance).
//
// The model's constructor wires wps subscriptions + an async kickoff that
// hits wshrpc.  Both are mocked at the module boundary so the constructor
// is side-effect-free in tests; agent methods can then be exercised
// directly against the resulting instance.

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
import { RpcApi } from "@/app/store/wshclientapi";
import { stringToBase64 } from "@/util/util";

import { TerminalModel } from "./terminal-model";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TerminalModel agent surface", () => {
    let model: TerminalModel;

    beforeEach(() => {
        model = new TerminalModel("outer-1", 80);
    });

    afterEach(() => {
        model.dispose();
    });

    it("ignores persisted agent rows from the old timeline marker flow", async () => {
        model.dispose();
        vi.mocked(RpcApi.GetCmdBlocksCommand).mockResolvedValueOnce([
            {
                oid: "agent-row-1",
                blockid: "outer-1",
                seq: 1,
                kind: "agent",
                state: "static",
                agentuserentryid: "run-123",
                agentsessionpath: "/tmp/session.jsonl",
                promptoffset: 0,
                tspromptns: 1,
                createdat: 1,
            } as unknown as CmdBlock,
        ]);

        model = new TerminalModel("outer-1", 80);
        await flush();

        const block = model.getBlocks().findById("agent-row-1");
        expect(block).toBeUndefined();
    });

    it("rehydrates running shell rows from GetCmdBlocksCommand", async () => {
        model.dispose();
        vi.mocked(RpcApi.GetCmdBlocksCommand).mockResolvedValueOnce([
            {
                oid: "shell-row-1",
                blockid: "outer-1",
                seq: 1,
                kind: "shell",
                state: "running",
                cmd: "pi",
                cwd: "/repo",
                promptoffset: 0,
                outputstartoffset: 0,
                tspromptns: 1,
                tscmdns: 1,
                createdat: 1,
            } as unknown as CmdBlock,
        ]);

        model = new TerminalModel("outer-1", 80);
        await flush();

        const block = model.getBlocks().findById("shell-row-1");
        expect(block).toBeDefined();
        expect(block!.kind).toBe("shell");
        expect(block!.state).toBe("running");
        expect(block!.commandText()).toBe("pi");
        expect(block!.pwd).toBe("/repo");
    });

    it("getRecentCommands returns the last N entries from commandHistoryAtom", () => {
        globalStore.set(model.commandHistoryAtom, ["a", "b", "c", "d", "e"]);
        expect(model.getRecentCommands(3)).toEqual(["c", "d", "e"]);
        expect(model.getRecentCommands(10)).toEqual(["a", "b", "c", "d", "e"]);
        expect(model.getRecentCommands(0)).toEqual([]);
    });

    it("does not surface OSC notifications through the terminal-local toast atom", () => {
        (model as any).applyChunk({
            blockid: "outer-1",
            oid: "cmd-row-osc",
            offset: 0,
            data64: stringToBase64("\x1b]9;task finished\x07"),
        } as CmdBlockChunkEvent);

        expect(globalStore.get(model.notificationAtom)).toBe("");
    });

    it("ignores transient not-ready errors from resize RPCs", async () => {
        vi.mocked(RpcApi.ControllerInputCommand).mockRejectedValueOnce(
            new Error('no shell input chan (block "outer-1" not ready)')
        );

        await expect(model.sendResize(24, 80)).resolves.toBeUndefined();
    });
});
