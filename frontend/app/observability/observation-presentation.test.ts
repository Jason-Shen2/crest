import { describe, expect, it } from "vitest";

export function makeObservation(
    overrides: Partial<AgentObservabilityObservation> = {}
): AgentObservabilityObservation {
    return {
        id: "obs-1",
        traceId: "trace-1",
        type: "TOOL",
        name: "read",
        startTime: "2026-07-19T00:00:01.000Z",
        endTime: "2026-07-19T00:00:01.042Z",
        parentObservationId: "root-1",
        level: "DEFAULT",
        statusMessage: null,
        version: null,
        model: null,
        input: { path: "README.md" },
        output: "contents",
        metadata: {},
        latency: 0.042,
        timeToFirstToken: null,
        usageDetails: {},
        costDetails: {},
        toolCalls: ["call-1"],
        toolCallNames: ["read"],
        ...overrides,
    };
}

describe("AgentObservabilityObservation renderer contract", () => {
    it("contains the Langfuse observation fields used by the dashboard", () => {
        const observation = makeObservation();
        expect(observation.toolCallNames).toEqual(["read"]);
        expect(observation.latency).toBe(0.042);
    });
});
