// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as electron from "electron";
import {
    _resetAgentObservabilityForTests,
    TraceEventCoalescer,
    registerAgentObservabilityIpcHandlers,
} from "./agent-observability-ipc";
import { TraceBuilder } from "./agent/observability/trace-builder";
import type { TraceDetail } from "./agent/observability/types";

vi.mock("electron", () => ({
    ipcMain: {
        handle: vi.fn(),
        on: vi.fn(),
    },
}));

const TraceStoreMock = vi.hoisted(() => ({
    getTraceDetail: vi.fn(),
    listTraces: vi.fn(() => []),
}));

vi.mock("./agent/observability/sqlite-trace-store", () => ({
    SqliteTraceStore: class {
        getTraceDetail = TraceStoreMock.getTraceDetail;
        listTraces = TraceStoreMock.listTraces;
    },
}));

interface Coalescer {
    handle(sessionPath: string, event: { type: string; [key: string]: unknown }): void;
    dispose(): void;
}

function makeCoalescer(saveTraceDetail: (detail: TraceDetail) => void, publishTraceDetail: (detail: TraceDetail) => void): Coalescer {
    return new TraceEventCoalescer({
        builder: new TraceBuilder(),
        saveTraceDetail,
        publishTraceDetail,
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

function generationOutput(detail: TraceDetail): unknown {
    return detail.observations.find((observation) => observation.type === "GENERATION")?.output;
}

describe("TraceEventCoalescer", () => {
    afterEach(() => {
        vi.useRealTimers();
        _resetAgentObservabilityForTests();
        vi.clearAllMocks();
    });

    it("coalesces message updates independently per session and only publishes the latest detail", () => {
        vi.useFakeTimers();
        const saveTraceDetail = vi.fn();
        const publishTraceDetail = vi.fn();
        const coalescer = makeCoalescer(saveTraceDetail, publishTraceDetail);
        startGeneration(coalescer, "session-a");
        startGeneration(coalescer, "session-b");
        saveTraceDetail.mockClear();
        publishTraceDetail.mockClear();

        coalescer.handle("session-a", update("a1"));
        coalescer.handle("session-a", update("a2"));
        coalescer.handle("session-b", update("b1"));

        expect(saveTraceDetail).not.toHaveBeenCalled();
        expect(publishTraceDetail).not.toHaveBeenCalled();
        vi.advanceTimersByTime(49);
        expect(publishTraceDetail).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);

        expect(saveTraceDetail).not.toHaveBeenCalled();
        expect(publishTraceDetail).toHaveBeenCalledTimes(2);
        expect(publishTraceDetail.mock.calls.map(([detail]) => generationOutput(detail))).toEqual(["a2", "b1"]);
        coalescer.dispose();
    });

    it("flushes a pending update before message_end and persists the final detail", () => {
        vi.useFakeTimers();
        const saveTraceDetail = vi.fn();
        const publishTraceDetail = vi.fn();
        const coalescer = makeCoalescer(saveTraceDetail, publishTraceDetail);
        startGeneration(coalescer, "session-a");
        saveTraceDetail.mockClear();
        publishTraceDetail.mockClear();

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

        expect(publishTraceDetail).toHaveBeenCalledTimes(2);
        expect(publishTraceDetail.mock.calls.map(([detail]) => generationOutput(detail))).toEqual(["partial", "final"]);
        expect(saveTraceDetail).toHaveBeenCalledTimes(1);
        expect(generationOutput(saveTraceDetail.mock.calls[0][0])).toBe("final");
        vi.advanceTimersByTime(50);
        expect(publishTraceDetail).toHaveBeenCalledTimes(2);
        coalescer.dispose();
    });

    it("flushes a pending update before any non-update event", () => {
        vi.useFakeTimers();
        const order: string[] = [];
        const coalescer = makeCoalescer(
            () => order.push("save"),
            (detail) => order.push(`publish:${generationOutput(detail) ?? detail.observations.at(-1)?.type}`)
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
        expect(TraceStoreMock.getTraceDetail).toHaveBeenCalledWith("trace-1", "session-a");
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
        expect(TraceStoreMock.getTraceDetail).not.toHaveBeenCalled();
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
