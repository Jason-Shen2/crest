// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { summarizeFrameSamples } from "./metrics";

describe("summarizeFrameSamples", () => {
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
