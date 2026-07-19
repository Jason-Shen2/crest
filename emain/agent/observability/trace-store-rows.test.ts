// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { observationFromRow, observationToRow, traceFromRow, traceToRow } from "./trace-store-rows";
import type { LangfuseObservation, LangfuseTrace } from "./types";

describe("trace store row serialization", () => {
    it("round-trips trace JSON fields without changing Langfuse-compatible keys", () => {
        const trace: LangfuseTrace = {
            id: "trace-1",
            name: "agent_run",
            timestamp: "2026-07-18T08:00:00.000Z",
            endedAt: "2026-07-18T08:00:01.000Z",
            environment: "local",
            tags: ["crest", "agent"],
            release: null,
            version: "v1",
            input: { prompt: "hello" },
            output: { ok: true },
            metadata: { sessionPath: "/tmp/s.db" },
            sessionId: "/tmp/s.db",
            userId: null,
            status: "success",
        };

        const row = traceToRow(trace);

        expect(row.session_id).toBe("/tmp/s.db");
        expect(row.tags).toBe(JSON.stringify(["crest", "agent"]));
        expect(traceFromRow(row)).toEqual(trace);
    });

    it("round-trips observation usage, cost, and tool call arrays", () => {
        const observation: LangfuseObservation = {
            id: "obs-1",
            traceId: "trace-1",
            type: "TOOL",
            startTime: "2026-07-18T08:00:00.000Z",
            endTime: "2026-07-18T08:00:01.000Z",
            name: "read_file",
            metadata: { provider: "anthropic" },
            parentObservationId: "obs-root",
            level: "ERROR",
            statusMessage: "failed",
            version: null,
            model: null,
            input: { path: "README.md" },
            output: { text: "hello" },
            latency: 1000,
            timeToFirstToken: null,
            usageDetails: { input: 10 },
            costDetails: { total: 0.01 },
            toolCalls: ["call-1"],
            toolCallNames: ["read_file"],
        };

        const row = observationToRow(observation);

        expect(row.trace_id).toBe("trace-1");
        expect(row.parent_observation_id).toBe("obs-root");
        expect(row.usage_details).toBe(JSON.stringify({ input: 10 }));
        expect(observationFromRow(row)).toEqual(observation);
    });
});
