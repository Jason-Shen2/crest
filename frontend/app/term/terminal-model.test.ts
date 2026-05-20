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

    it("submitAgentMessage returns a non-empty exchangeId per call", () => {
        const id1 = model.submitAgentMessage("hi");
        const id2 = model.submitAgentMessage("again");
        expect(id1).toBeTruthy();
        expect(id2).toBeTruthy();
        expect(id1).not.toBe(id2);
    });

    it("submitAgentMessage appends an agent block keyed by `agent_${exchangeId}`", () => {
        const id = model.submitAgentMessage("explain the diff");
        const block = model.getBlocks().findById(`agent_${id}`);
        expect(block).toBeDefined();
        expect(block!.kind).toBe("agent");
        expect(block!.agentPayload?.userText).toBe("explain the diff");
        expect(block!.agentPayload?.status).toBe("streaming");
        // Status atom mirrors onto the model so the chrome can show a
        // global spinner without walking blocks.
        expect(globalStore.get(model.agentChatStatusAtom)).toBe("streaming");
    });

    it("applyAgentDelta accumulates text, does not overwrite", () => {
        const id = model.submitAgentMessage("q");
        model.applyAgentDelta(id, "Hello, ");
        model.applyAgentDelta(id, "world");
        model.applyAgentDelta(id, "!");
        const block = model.getBlocks().findById(`agent_${id}`);
        expect(block!.agentPayload?.assistantText).toBe("Hello, world!");
    });

    it("applyAgentDelta on an unknown exchangeId is a no-op", () => {
        // Build a baseline so we can detect spurious bumps.
        const id = model.submitAgentMessage("q");
        const baselineRev = globalStore.get(model.revisionAtom);
        model.applyAgentDelta("nonsense", "ignored");
        const block = model.getBlocks().findById(`agent_${id}`);
        expect(block!.agentPayload?.assistantText).toBe("");
        // No matching block ⇒ no revision bump.
        expect(globalStore.get(model.revisionAtom)).toBe(baselineRev);
    });

    it("applyAgentText snapshot replaces (does not append)", () => {
        const id = model.submitAgentMessage("q");
        model.applyAgentText(id, "Hello");
        model.applyAgentText(id, "Hello, world");
        const block = model.getBlocks().findById(`agent_${id}`);
        expect(block!.agentPayload?.assistantText).toBe("Hello, world");
    });

    it("applyAgentStatus flips block + mirrors onto agentChatStatusAtom", () => {
        const id = model.submitAgentMessage("q");
        model.applyAgentStatus(id, "done");
        const block = model.getBlocks().findById(`agent_${id}`);
        expect(block!.agentPayload?.status).toBe("done");
        expect(globalStore.get(model.agentChatStatusAtom)).toBe("idle");
    });

    it("applyAgentStatus error path carries the message and switches the chrome atom", () => {
        const id = model.submitAgentMessage("q");
        model.applyAgentStatus(id, "error", "429 rate limited");
        const block = model.getBlocks().findById(`agent_${id}`);
        expect(block!.agentPayload?.status).toBe("error");
        expect(block!.agentPayload?.errorMessage).toBe("429 rate limited");
        expect(globalStore.get(model.agentChatStatusAtom)).toBe("error");
    });

    it("getRecentCommands returns the last N entries from commandHistoryAtom", () => {
        globalStore.set(model.commandHistoryAtom, ["a", "b", "c", "d", "e"]);
        expect(model.getRecentCommands(3)).toEqual(["c", "d", "e"]);
        expect(model.getRecentCommands(10)).toEqual(["a", "b", "c", "d", "e"]);
        expect(model.getRecentCommands(0)).toEqual([]);
    });
});
