// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteTraceStore } from "./sqlite-trace-store";
import type { TraceDetail } from "./types";

function makeTraceDetail(sessionId: string): TraceDetail {
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
        corrections: [],
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
        store.saveTraceDetail(makeTraceDetail("session-a"));

        expect(store.getTraceDetail("trace-1", "session-b")).toBeUndefined();
        expect(store.getTraceDetail("trace-1", "session-a")?.trace.id).toBe("trace-1");
    });

    it("round-trips scores and corrections in trace detail", () => {
        store.saveTraceDetail({
            ...makeTraceDetail("session-a"),
            scores: [
                {
                    id: "score-1",
                    traceId: "trace-1",
                    observationId: null,
                    name: "quality",
                    source: "API",
                    dataType: "NUMERIC",
                    value: 0.9,
                    comment: "looks good",
                },
            ],
            corrections: [
                {
                    id: "correction-1",
                    traceId: "trace-1",
                    observationId: null,
                    name: "expected-output",
                    source: "ANNOTATION",
                    dataType: "CORRECTION",
                    value: "corrected answer",
                    comment: null,
                },
            ],
        });

        const detail = store.getTraceDetail("trace-1", "session-a");

        expect(detail?.scores).toHaveLength(1);
        expect(detail?.scores[0]).toMatchObject({ id: "score-1", dataType: "NUMERIC", value: 0.9 });
        expect(detail?.corrections).toHaveLength(1);
        expect(detail?.corrections[0]).toMatchObject({
            id: "correction-1",
            dataType: "CORRECTION",
            value: "corrected answer",
        });
    });
});
