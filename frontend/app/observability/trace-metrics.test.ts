import { describe, expect, it } from "vitest";

import { computeTraceMetrics } from "./trace-metrics";

function makeObservation(id: string, type: Observation["type"], overrides: Partial<Observation> = {}): Observation {
    return {
        id,
        traceId: "trace-1",
        type,
        name: type.toLowerCase(),
        startTime: "2026-07-19T00:00:01.000Z",
        endTime: "2026-07-19T00:00:02.000Z",
        parentObservationId: "root-1",
        level: "DEFAULT",
        statusMessage: null,
        version: null,
        model: null,
        input: null,
        output: null,
        metadata: {},
        latency: null,
        timeToFirstToken: null,
        usageDetails: {},
        costDetails: {},
        toolCalls: null,
        toolCallNames: null,
        ...overrides,
    };
}

function makeTraceDetail(overrides: Partial<TraceDetail> = {}): TraceDetail {
    return {
        trace: {
            id: "trace-1",
            name: "Agent run",
            timestamp: "2026-07-19T00:00:00.000Z",
            endedAt: "2026-07-19T00:00:05.000Z",
            environment: "test",
            tags: [],
            release: null,
            version: null,
            input: "Start",
            output: "Finished",
            metadata: {},
            sessionId: "session-1",
            userId: null,
            status: "success",
        },
        observations: [],
        scores: [],
        corrections: [],
        ...overrides,
    };
}

describe("computeTraceMetrics", () => {
    it("aggregates duration, counts, usage, cost, and final output", () => {
        const detail = makeTraceDetail({
            observations: [
                makeObservation("root-1", "AGENT", { parentObservationId: null }),
                makeObservation("generation-1", "GENERATION", {
                    usageDetails: { input: 10, output: 5, cacheRead: 8, totalTokens: 23 },
                    costDetails: { input: 0.004, output: 0.006 },
                    output: "First",
                }),
                makeObservation("tool-1", "TOOL"),
                makeObservation("event-1", "EVENT"),
                makeObservation("generation-2", "GENERATION", {
                    usageDetails: { input: 20, output: 7, cacheWrite: 2, totalTokens: 29 },
                    costDetails: { total: 0.005 },
                    output: "Second",
                }),
                makeObservation("tool-2", "TOOL", {
                    level: "ERROR",
                    statusMessage: "command failed",
                }),
            ],
        });

        expect(computeTraceMetrics(detail)).toMatchObject({
            durationMs: 5000,
            generationCount: 2,
            toolCount: 2,
            lifecycleCount: 1,
            errorCount: 1,
            usage: {
                input: 30,
                output: 12,
                cacheRead: 8,
                cacheWrite: 2,
                totalTokens: 52,
            },
            totalCost: 0.015,
            finalOutput: "Finished",
        });
    });

    it("uses the latest observation boundary for a running trace duration", () => {
        const detail = makeTraceDetail({
            trace: {
                ...makeTraceDetail().trace,
                status: "running",
                endedAt: undefined,
            },
            observations: [
                makeObservation("completed", "TOOL", {
                    startTime: "2026-07-19T00:00:01.000Z",
                    endTime: "2026-07-19T00:00:02.500Z",
                }),
                makeObservation("running", "GENERATION", {
                    startTime: "2026-07-19T00:00:03.500Z",
                    endTime: null,
                }),
            ],
        });

        expect(computeTraceMetrics(detail).durationMs).toBe(3500);
    });

    it("treats missing or non-numeric usage and cost values as zero", () => {
        const malformedDetails = {
            input: "10",
            output: null,
            cacheRead: undefined,
            totalTokens: 4,
        } as unknown as Record<string, number>;
        const malformedCosts = {
            input: "0.01",
            output: null,
            total: 0.002,
        } as unknown as Record<string, number>;
        const detail = makeTraceDetail({
            observations: [
                makeObservation("generation-1", "GENERATION", {
                    usageDetails: malformedDetails,
                    costDetails: malformedCosts,
                }),
                makeObservation("generation-2", "GENERATION", {
                    usageDetails: null as unknown as Record<string, number>,
                    costDetails: undefined as unknown as Record<string, number>,
                }),
            ],
        });

        expect(computeTraceMetrics(detail)).toMatchObject({
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 4,
            },
            totalCost: 0.002,
        });
    });

    it("uses costDetails total instead of double-counting its component costs", () => {
        const detail = makeTraceDetail({
            observations: [
                makeObservation("generation-1", "GENERATION", {
                    costDetails: {
                        input: 0.004,
                        output: 0.006,
                        cacheRead: 0.001,
                        cacheWrite: 0.002,
                        total: 0.013,
                    },
                }),
                makeObservation("generation-2", "GENERATION", {
                    costDetails: {
                        input: 0.001,
                        output: 0.002,
                    },
                }),
            ],
        });

        expect(computeTraceMetrics(detail).totalCost).toBe(0.016);
    });

    it("falls back to the last generation output when trace output is absent", () => {
        const detail = makeTraceDetail({
            trace: {
                ...makeTraceDetail().trace,
                output: null,
            },
            observations: [
                makeObservation("generation-1", "GENERATION", { output: "First" }),
                makeObservation("tool-1", "TOOL", { output: "Tool result" }),
                makeObservation("generation-2", "GENERATION", { output: "Last generation" }),
            ],
        });

        expect(computeTraceMetrics(detail).finalOutput).toBe("Last generation");
    });

    it("ignores the finishTrace agent_end event and uses the last generation output", () => {
        const detail = makeTraceDetail({
            trace: {
                ...makeTraceDetail().trace,
                output: {
                    type: "agent_end",
                    messages: [
                        {
                            role: "assistant",
                            content: [{ type: "text", text: "Finished" }],
                        },
                    ],
                },
            },
            observations: [
                makeObservation("generation-1", "GENERATION", { output: "First" }),
                makeObservation("generation-2", "GENERATION", { output: "Finished" }),
            ],
        });

        expect(computeTraceMetrics(detail).finalOutput).toBe("Finished");
    });

    it("excludes the AGENT root from lifecycle and error counts", () => {
        const detail = makeTraceDetail({
            observations: [
                makeObservation("root-1", "AGENT", {
                    parentObservationId: null,
                    level: "ERROR",
                    statusMessage: "trace failed",
                }),
            ],
        });

        expect(computeTraceMetrics(detail)).toMatchObject({
            generationCount: 0,
            toolCount: 0,
            lifecycleCount: 0,
            errorCount: 0,
        });
    });
});
