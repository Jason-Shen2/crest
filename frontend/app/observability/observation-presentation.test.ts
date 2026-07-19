import { describe, expect, it } from "vitest";

import { presentObservation } from "./observation-presentation";

export function makeObservation(overrides: Partial<AgentObservabilityObservation> = {}): AgentObservabilityObservation {
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

describe("presentObservation", () => {
    it.each([
        ["GENERATION", "generation"],
        ["TOOL", "tool"],
        ["EVENT", "lifecycle"],
    ] as const)("maps %s to %s", (type, category) => {
        expect(presentObservation(makeObservation({ type })).category).toBe(category);
    });

    it("maps errors independently of observation type", () => {
        const result = presentObservation(
            makeObservation({
                type: "TOOL",
                level: "ERROR",
                statusMessage: "command failed",
            })
        );

        expect(result.category).toBe("error");
        expect(result.tone).toBe("error");
        expect(result.searchableText).toContain("command failed");
    });

    it("maps a status message to error category and tone", () => {
        const result = presentObservation(
            makeObservation({
                type: "TOOL",
                level: "DEFAULT",
                statusMessage: "command failed",
            })
        );

        expect(result.category).toBe("error");
        expect(result.tone).toBe("error");
    });

    it("summarizes tool arguments without dumping the entire payload", () => {
        const result = presentObservation(
            makeObservation({
                input: {
                    path: "README.md",
                    line_start: 1,
                    content: "x".repeat(300),
                },
            })
        );

        expect(result.summary).toContain("README.md");
        expect(result.summary.length).toBeLessThanOrEqual(160);
    });

    it("prefers textual generation output for its summary", () => {
        const result = presentObservation(
            makeObservation({
                type: "GENERATION",
                name: "assistant",
                input: "Explain the repository",
                output: "The repository contains an Electron application.",
            })
        );

        expect(result.summary).toBe("The repository contains an Electron application.");
        expect(result.tone).toBe("info");
    });

    it.each([
        ["model_change", "Model change"],
        ["compaction", "Compaction"],
        ["branch_nav", "Branch navigation"],
    ])("labels the %s lifecycle event as %s", (name, label) => {
        const result = presentObservation(makeObservation({ type: "EVENT", name }));

        expect(result.label).toBe(label);
    });

    it("builds duration, model, token, cost, and error badges when available", () => {
        const result = presentObservation(
            makeObservation({
                type: "GENERATION",
                model: "claude-sonnet-4",
                usageDetails: { input: 12, output: 4, totalTokens: 16 },
                costDetails: { total: 0.0125 },
                statusMessage: "rate limit recovered",
            })
        );

        expect(result.badges).toEqual(
            expect.arrayContaining([
                { label: "42 ms", tone: "neutral" },
                { label: "claude-sonnet-4", tone: "info" },
                { label: "16 tokens", tone: "neutral" },
                { label: "$0.0125", tone: "neutral" },
                { label: "rate limit recovered", tone: "error" },
            ])
        );
    });

    it("indexes label, summary, name, status, input, output, and metadata", () => {
        const result = presentObservation(
            makeObservation({
                name: "read_config",
                input: { path: "settings.json" },
                output: { result: "loaded" },
                statusMessage: "completed with fallback",
                metadata: { provider: "local" },
            })
        );

        for (const value of [
            "Read Config",
            "settings.json",
            "read_config",
            "completed with fallback",
            "loaded",
            "local",
        ]) {
            expect(result.searchableText).toContain(value);
        }
    });
});
