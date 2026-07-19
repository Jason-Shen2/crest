import { describe, expect, it } from "vitest";

import { computeTraceMetrics } from "./trace-metrics";

function makeObservation(
    id: string,
    type: AgentObservabilityObservation["type"],
    overrides: Partial<AgentObservabilityObservation> = {}
): AgentObservabilityObservation {
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

function makeGraph(overrides: Partial<AgentObservabilityTraceGraph> = {}): AgentObservabilityTraceGraph {
    return {
        trace: {
            id: "trace-1",
            name: "Agent run",
            timestamp: "2026-07-19T00:00:00.000Z",
            endedAt: "2026-07-19T00:00:05.000Z",
            environment: "test",
            tags: [],
            input: "Start",
            output: "Finished",
            metadata: {},
            sessionId: "session-1",
            status: "success",
        },
        observations: [],
        scores: [],
        ...overrides,
    };
}

describe("computeTraceMetrics", () => {
    it("aggregates duration, counts, usage, cost, and final output", () => {
        const graph = makeGraph({
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

        expect(computeTraceMetrics(graph)).toMatchObject({
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
        const graph = makeGraph({
            trace: {
                ...makeGraph().trace,
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

        expect(computeTraceMetrics(graph).durationMs).toBe(3500);
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
        const graph = makeGraph({
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

        expect(computeTraceMetrics(graph)).toMatchObject({
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

    it("falls back to the last generation output when trace output is absent", () => {
        const graph = makeGraph({
            trace: {
                ...makeGraph().trace,
                output: null,
            },
            observations: [
                makeObservation("generation-1", "GENERATION", { output: "First" }),
                makeObservation("tool-1", "TOOL", { output: "Tool result" }),
                makeObservation("generation-2", "GENERATION", { output: "Last generation" }),
            ],
        });

        expect(computeTraceMetrics(graph).finalOutput).toBe("Last generation");
    });

    it("excludes the AGENT root from lifecycle and error counts", () => {
        const graph = makeGraph({
            observations: [
                makeObservation("root-1", "AGENT", {
                    parentObservationId: null,
                    level: "ERROR",
                    statusMessage: "trace failed",
                }),
            ],
        });

        expect(computeTraceMetrics(graph)).toMatchObject({
            generationCount: 0,
            toolCount: 0,
            lifecycleCount: 0,
            errorCount: 0,
        });
    });
});
