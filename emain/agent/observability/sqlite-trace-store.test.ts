// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteTraceStore } from "./sqlite-trace-store";
import type { TraceGraph } from "./types";

function makeGraph(sessionId: string): TraceGraph {
    return {
        trace: {
            id: "trace-1",
            name: "agent_run",
            timestamp: "2026-07-19T08:00:00.000Z",
            environment: "test",
            tags: [],
            release: null,
            version: null,
            input: "Review the session scope",
            output: null,
            metadata: {},
            sessionId,
            userId: null,
            status: "running",
        },
        observations: [],
        scores: [],
    };
}

describe("SqliteTraceStore session scope", () => {
    let tmpDir: string;
    let store: SqliteTraceStore;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "crest-observability-store-"));
        store = new SqliteTraceStore(path.join(tmpDir, "traces.db"));
    });

    afterEach(async () => {
        store.close();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("does not return a trace outside the requested session", () => {
        store.saveGraph(makeGraph("session-a"));

        expect(store.getTraceGraph("trace-1", "session-b")).toBeUndefined();
        expect(store.getTraceGraph("trace-1", "session-a")?.trace.id).toBe("trace-1");
    });
});
