// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export const FrameBudgetMs = 16.7;

export type FrameSampleInput = {
    frameTimesMs: number[];
    totalMs: number;
    heapBeforeBytes: number | null;
    heapAfterBytes: number | null;
    completed: boolean;
    timedOut: boolean;
};

export type FrameSummary = {
    completed: boolean;
    timedOut: boolean;
    frames: number;
    totalMs: number;
    p50FrameMs: number | null;
    p99FrameMs: number | null;
    maxFrameMs: number | null;
    heapBeforeBytes: number | null;
    heapAfterBytes: number | null;
    heapDeltaBytes: number | null;
    meetsFrameBudget: boolean;
};

function nearestRank(sorted: number[], percentile: number): number | null {
    if (sorted.length === 0) return null;
    const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
    return sorted[index];
}

export function summarizeFrameSamples(input: FrameSampleInput): FrameSummary {
    const sorted = input.frameTimesMs.filter(Number.isFinite).sort((a, b) => a - b);
    const p50FrameMs = nearestRank(sorted, 0.5);
    const p99FrameMs = nearestRank(sorted, 0.99);
    const maxFrameMs = sorted.at(-1) ?? null;
    const heapDeltaBytes =
        input.heapBeforeBytes == null || input.heapAfterBytes == null
            ? null
            : input.heapAfterBytes - input.heapBeforeBytes;

    return {
        completed: input.completed,
        timedOut: input.timedOut,
        frames: sorted.length,
        totalMs: input.totalMs,
        p50FrameMs,
        p99FrameMs,
        maxFrameMs,
        heapBeforeBytes: input.heapBeforeBytes,
        heapAfterBytes: input.heapAfterBytes,
        heapDeltaBytes,
        meetsFrameBudget: input.completed && p99FrameMs != null && p99FrameMs <= FrameBudgetMs,
    };
}
