// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as electron from "electron";
import {
    _resetAgentObservabilityForTests,
    AgentObservabilityEventCoalescer,
    registerAgentObservabilityIpcHandlers,
} from "./agent-observability-ipc";
import { LangfuseTraceBuilder } from "./agent/observability/trace-builder";
import type { TraceGraph } from "./agent/observability/types";

vi.mock("electron", () => ({
    ipcMain: {
        handle: vi.fn(),
        on: vi.fn(),
    },
}));

const TraceStoreMock = vi.hoisted(() => ({
    getTraceGraph: vi.fn(),
    listTraces: vi.fn(() => []),
}));

vi.mock("./agent/observability/sqlite-trace-store", () => ({
    SqliteTraceStore: class {
        getTraceGraph = TraceStoreMock.getTraceGraph;
        listTraces = TraceStoreMock.listTraces;
    },
}));

interface Coalescer {
    handle(sessionPath: string, event: { type: string; [key: string]: unknown }): void;
    dispose(): void;
}

function makeCoalescer(saveGraph: (graph: TraceGraph) => void, publishGraph: (graph: TraceGraph) => void): Coalescer {
    return new AgentObservabilityEventCoalescer({
        builder: new LangfuseTraceBuilder(),
        saveGraph,
        publishGraph,
        updateIntervalMs: 50,
    });
}

function startGeneration(coalescer: Coalescer, sessionPath: string): void {
    coalescer.handle(sessionPath, { type: "agent_start" });
    coalescer.handle(sessionPath, {
        type: "message_start",
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
    });
}

function update(text: string): { type: string; [key: string]: unknown } {
    return {
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text }] },
        assistantMessageEvent: { type: "text_delta", delta: text },
    };
}

function generationOutput(graph: TraceGraph): unknown {
    return graph.observations.find((observation) => observation.type === "GENERATION")?.output;
}

describe("AgentObservabilityEventCoalescer", () => {
    afterEach(() => {
        vi.useRealTimers();
        _resetAgentObservabilityForTests();
        vi.clearAllMocks();
    });

    it("coalesces message updates independently per session and only publishes the latest graph", () => {
        vi.useFakeTimers();
        const saveGraph = vi.fn();
        const publishGraph = vi.fn();
        const coalescer = makeCoalescer(saveGraph, publishGraph);
        startGeneration(coalescer, "session-a");
        startGeneration(coalescer, "session-b");
        saveGraph.mockClear();
        publishGraph.mockClear();

        coalescer.handle("session-a", update("a1"));
        coalescer.handle("session-a", update("a2"));
        coalescer.handle("session-b", update("b1"));

        expect(saveGraph).not.toHaveBeenCalled();
        expect(publishGraph).not.toHaveBeenCalled();
        vi.advanceTimersByTime(49);
        expect(publishGraph).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);

        expect(saveGraph).not.toHaveBeenCalled();
        expect(publishGraph).toHaveBeenCalledTimes(2);
        expect(publishGraph.mock.calls.map(([graph]) => generationOutput(graph))).toEqual(["a2", "b1"]);
        coalescer.dispose();
    });

    it("flushes a pending update before message_end and persists the final graph", () => {
        vi.useFakeTimers();
        const saveGraph = vi.fn();
        const publishGraph = vi.fn();
        const coalescer = makeCoalescer(saveGraph, publishGraph);
        startGeneration(coalescer, "session-a");
        saveGraph.mockClear();
        publishGraph.mockClear();

        coalescer.handle("session-a", update("partial"));
        coalescer.handle("session-a", {
            type: "message_end",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "final" }],
                usage: { input: 3, output: 2 },
                stopReason: "stop",
            },
        });

        expect(publishGraph).toHaveBeenCalledTimes(2);
        expect(publishGraph.mock.calls.map(([graph]) => generationOutput(graph))).toEqual(["partial", "final"]);
        expect(saveGraph).toHaveBeenCalledTimes(1);
        expect(generationOutput(saveGraph.mock.calls[0][0])).toBe("final");
        vi.advanceTimersByTime(50);
        expect(publishGraph).toHaveBeenCalledTimes(2);
        coalescer.dispose();
    });

    it("flushes a pending update before any non-update event", () => {
        vi.useFakeTimers();
        const order: string[] = [];
        const coalescer = makeCoalescer(
            () => order.push("save"),
            (graph) => order.push(`publish:${generationOutput(graph) ?? graph.observations.at(-1)?.type}`)
        );
        startGeneration(coalescer, "session-a");
        order.length = 0;

        coalescer.handle("session-a", update("partial"));
        coalescer.handle("session-a", {
            type: "model_select",
            model: "claude-opus",
        });

        expect(order).toEqual(["publish:partial", "save", "publish:partial"]);
        coalescer.dispose();
    });
});

describe("agent observability IPC scope", () => {
    afterEach(() => {
        _resetAgentObservabilityForTests();
        vi.clearAllMocks();
    });

    it("forwards the same session scope to list and get", async () => {
        registerAgentObservabilityIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }

        await handlers.get("agent-observability:list-traces")?.({}, "session-a");
        await handlers.get("agent-observability:get-trace")?.({}, "trace-1", "session-a");

        expect(TraceStoreMock.listTraces).toHaveBeenCalledWith("session-a");
        expect(TraceStoreMock.getTraceGraph).toHaveBeenCalledWith("trace-1", "session-a");
    });

    it("rejects missing or blank session scope for list and get", async () => {
        registerAgentObservabilityIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }

        await expect(Promise.resolve().then(() => handlers.get("agent-observability:list-traces")?.({}))).rejects.toThrow(
            /sessionId must be a non-empty string/
        );
        await expect(
            Promise.resolve().then(() => handlers.get("agent-observability:list-traces")?.({}, "   "))
        ).rejects.toThrow(/sessionId must be a non-empty string/);
        await expect(
            Promise.resolve().then(() => handlers.get("agent-observability:get-trace")?.({}, "trace-1"))
        ).rejects.toThrow(/sessionId must be a non-empty string/);
        expect(TraceStoreMock.listTraces).not.toHaveBeenCalled();
        expect(TraceStoreMock.getTraceGraph).not.toHaveBeenCalled();
    });

    it("rejects subscription without a non-empty session scope", () => {
        registerAgentObservabilityIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.on).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const sender = {
            id: 7,
            once: vi.fn(),
        };
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        handlers.get("agent-observability:subscribe")?.({ sender });
        handlers.get("agent-observability:subscribe")?.({ sender }, " ");

        expect(sender.once).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledTimes(2);
        expect(errorSpy).toHaveBeenCalledWith(
            "[agent-observability] subscribe validation error:",
            expect.objectContaining({ message: expect.stringMatching(/sessionId must be a non-empty string/) })
        );
        errorSpy.mockRestore();
    });
});
