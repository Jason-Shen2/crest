// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for TerminalModel's agent surface (P0.2 acceptance).
//
// The model's constructor wires wps subscriptions + an async kickoff that
// hits wshrpc.  Both are mocked at the module boundary so the constructor
// is side-effect-free in tests; agent methods can then be exercised
// directly against the resulting instance.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { RpcApi } from "@/app/store/wshclientapi";

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

    it("rehydrates persisted agent rows from GetCmdBlocksCommand", async () => {
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
        expect(block).toBeDefined();
        expect(block!.kind).toBe("agent");
        expect(block!.agentRef?.runId).toBe("run-123");
        expect(block!.agentRef?.sessionPath).toBe("/tmp/session.jsonl");
        expect(model.getFirstAgentSessionPath()).toBe("/tmp/session.jsonl");
    });

    it("keys agent block on agentuserentryid", async () => {
        model.dispose();
        vi.mocked(RpcApi.GetCmdBlocksCommand).mockResolvedValueOnce([
            {
                oid: "agent-row-2",
                blockid: "outer-1",
                seq: 1,
                kind: "agent",
                state: "static",
                agentuserentryid: "entry-2",
                agentsessionpath: "/tmp/session.jsonl",
                promptoffset: 0,
                tspromptns: 1,
                createdat: 1,
            } as unknown as CmdBlock,
        ]);

        model = new TerminalModel("outer-1", 80);
        await flush();

        const block = model.getBlocks().findById("agent-row-2");
        expect(block).toBeDefined();
        expect(block!.agentRef?.runId).toBe("entry-2");
    });

    it("getRecentCommands returns the last N entries from commandHistoryAtom", () => {
        globalStore.set(model.commandHistoryAtom, ["a", "b", "c", "d", "e"]);
        expect(model.getRecentCommands(3)).toEqual(["c", "d", "e"]);
        expect(model.getRecentCommands(10)).toEqual(["a", "b", "c", "d", "e"]);
        expect(model.getRecentCommands(0)).toEqual([]);
    });
});
