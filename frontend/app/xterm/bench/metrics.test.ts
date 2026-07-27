// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { summarizeFrameSamples } from "./metrics";

describe("summarizeFrameSamples", () => {
    it("uses the calibrated refresh interval instead of a fixed 16.7ms budget", () => {
        expect(
            summarizeFrameSamples({
                refreshFrameTimesMs: [16.6, 16.7, 16.8, 16.7, 16.6],
                frameTimesMs: [16.7, 17.7, 18.6],
                totalMs: 1250,
                heapBeforeBytes: null,
                heapAfterBytes: null,
                completed: true,
                timedOut: false,
            })
        ).toMatchObject({
            refreshIntervalMs: 16.7,
            frameBudgetMs: 19.2,
            p99FrameMs: 18.6,
            meetsFrameBudget: true,
        });
    });

    it("rejects a p99 beyond one calibrated refresh interval plus tolerance", () => {
        expect(
            summarizeFrameSamples({
                refreshFrameTimesMs: [8.2, 8.3, 8.4, 8.3, 8.2],
                frameTimesMs: [8.3, 9.1, 12],
                totalMs: 1250,
                heapBeforeBytes: null,
                heapAfterBytes: null,
                completed: true,
                timedOut: false,
            })
        ).toMatchObject({
            refreshIntervalMs: 8.3,
            frameBudgetMs: 10.8,
            p99FrameMs: 12,
            meetsFrameBudget: false,
        });
    });

    it("reports nearest-rank frame percentiles and memory delta", () => {
        expect(
            summarizeFrameSamples({
                frameTimesMs: [8, 10, 20, 4],
                totalMs: 1250,
                heapBeforeBytes: 100,
                heapAfterBytes: 160,
                completed: true,
                timedOut: false,
            })
        ).toEqual({
            completed: true,
            timedOut: false,
            frames: 4,
            totalMs: 1250,
            p50FrameMs: 8,
            p99FrameMs: 20,
            maxFrameMs: 20,
            refreshIntervalMs: null,
            frameBudgetMs: 16.7,
            heapBeforeBytes: 100,
            heapAfterBytes: 160,
            heapDeltaBytes: 60,
            meetsFrameBudget: false,
        });
    });

    it("keeps missing frame and heap measurements explicit", () => {
        expect(
            summarizeFrameSamples({
                frameTimesMs: [],
                totalMs: 5,
                heapBeforeBytes: null,
                heapAfterBytes: null,
                completed: false,
                timedOut: true,
            })
        ).toMatchObject({
            frames: 0,
            p50FrameMs: null,
            p99FrameMs: null,
            maxFrameMs: null,
            heapDeltaBytes: null,
            meetsFrameBudget: false,
        });
    });
});
