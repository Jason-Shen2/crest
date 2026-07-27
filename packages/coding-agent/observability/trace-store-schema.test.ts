// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { TraceStoreSchemaSql } from "./trace-store-schema";

describe("TraceStoreSchemaSql", () => {
    it("creates Langfuse-compatible trace, observation, and score tables", () => {
        expect(TraceStoreSchemaSql).toContain("CREATE TABLE IF NOT EXISTS traces");
        expect(TraceStoreSchemaSql).toContain("session_id TEXT");
        expect(TraceStoreSchemaSql).toContain("environment TEXT");
        expect(TraceStoreSchemaSql).toContain("version TEXT");

        expect(TraceStoreSchemaSql).toContain("CREATE TABLE IF NOT EXISTS observations");
        expect(TraceStoreSchemaSql).toContain("trace_id TEXT NOT NULL");
        expect(TraceStoreSchemaSql).toContain("parent_observation_id TEXT");
        expect(TraceStoreSchemaSql).toContain("time_to_first_token REAL");
        expect(TraceStoreSchemaSql).toContain("usage_details TEXT");
        expect(TraceStoreSchemaSql).toContain("cost_details TEXT");

        expect(TraceStoreSchemaSql).toContain("CREATE TABLE IF NOT EXISTS scores");
        expect(TraceStoreSchemaSql).toContain("source TEXT NOT NULL");
        expect(TraceStoreSchemaSql).toContain("data_type TEXT NOT NULL");
    });
});
