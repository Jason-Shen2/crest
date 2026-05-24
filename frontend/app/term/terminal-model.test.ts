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

import { TerminalModel } from "./terminal-model";

describe("TerminalModel agent surface", () => {
    let model: TerminalModel;

    beforeEach(() => {
        model = new TerminalModel("outer-1", 80);
    });

    afterEach(() => {
        model.dispose();
    });

    it("appendAgentRun appends an agent-kind block keyed by `agent_${runId}`", () => {
        model.appendAgentRun("run-0");
        const block = model.getBlocks().findById("agent_run-0");
        expect(block).toBeDefined();
        expect(block!.kind).toBe("agent");
        expect(block!.agentRef?.runId).toBe("run-0");
    });

    it("appendAgentRun is idempotent — second call with the same runId is a no-op", () => {
        model.appendAgentRun("run-0");
        const countBefore = model.getBlocks().length();
        model.appendAgentRun("run-0");
        expect(model.getBlocks().length()).toBe(countBefore);
    });

    it("appendAgentRun bumps revision so subscribers re-render", () => {
        const before = globalStore.get(model.revisionAtom);
        model.appendAgentRun("run-x");
        const after = globalStore.get(model.revisionAtom);
        expect(after).toBeGreaterThan(before);
    });

    it("appendAgentRun on an empty runId is a no-op", () => {
        const before = globalStore.get(model.revisionAtom);
        model.appendAgentRun("");
        const after = globalStore.get(model.revisionAtom);
        expect(after).toBe(before);
    });

    it("getRecentCommands returns the last N entries from commandHistoryAtom", () => {
        globalStore.set(model.commandHistoryAtom, ["a", "b", "c", "d", "e"]);
        expect(model.getRecentCommands(3)).toEqual(["c", "d", "e"]);
        expect(model.getRecentCommands(10)).toEqual(["a", "b", "c", "d", "e"]);
        expect(model.getRecentCommands(0)).toEqual([]);
    });
});
