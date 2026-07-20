// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceTimeline/timeline-calculations.clienttest.ts.

import { describe, expect, it } from "vitest";

import {
    calculateStepSize,
    calculateTimelineOffset,
    calculateTimelineWidth,
    calculateTraceDuration,
    computeSelectionScrollTarget,
    findEarliestStartTime,
    getPredefinedStepSizes,
    PredefinedStepSizes,
    RevealLeftFraction,
    RevealMarginPx,
    ScaleWidth,
} from "./timeline-calculations";
import type { TraceNode } from "./types";

function makeNode(
    id: string,
    startTime: string,
    options: {
        children?: TraceNode[];
        endTime?: string | null;
        latency?: number;
    } = {}
): TraceNode {
    const { children = [], endTime = null, latency } = options;
    return {
        id,
        type: "SPAN",
        name: id,
        startTime: new Date(startTime),
        endTime: endTime == null ? null : new Date(endTime),
        latency,
        children,
        startTimeSinceTrace: 0,
        startTimeSinceParentStart: null,
        depth: 0,
        childrenDepth: 0,
    };
}

describe("timeline calculations", () => {
    describe("timeline origin and duration", () => {
        it("finds the earliest start across roots and descendants", () => {
            const root = makeNode("root", "2026-07-20T08:00:05Z", {
                endTime: "2026-07-20T08:00:10Z",
                children: [
                    makeNode("early-child", "2026-07-20T08:00:00Z"),
                    makeNode("late-child", "2026-07-20T08:00:07Z"),
                ],
            });

            expect(findEarliestStartTime([root])?.toISOString()).toBe("2026-07-20T08:00:00.000Z");
            expect(calculateTraceDuration([root], new Date("2026-07-20T08:00:00Z"))).toBe(10);
        });

        it("returns null and zero for an empty tree", () => {
            expect(findEarliestStartTime([])).toBeNull();
            expect(calculateTraceDuration([], new Date("2026-07-20T08:00:00Z"))).toBe(0);
        });

        it("uses the latest descendant end time", () => {
            const origin = new Date("2026-07-20T08:00:00Z");
            const root = makeNode("root", "2026-07-20T08:00:00Z", {
                endTime: "2026-07-20T08:00:10Z",
                children: [
                    makeNode("child", "2026-07-20T08:00:02Z", {
                        endTime: "2026-07-20T08:00:12Z",
                    }),
                ],
            });

            expect(calculateTraceDuration([root], origin)).toBe(12);
        });

        it("keeps the offset-aware root latency inside the scale", () => {
            const origin = new Date("2026-07-20T08:00:00Z");
            const root = makeNode("root", "2026-07-20T08:00:03Z", {
                latency: 10,
                children: [makeNode("early-child", "2026-07-20T08:00:00Z")],
            });

            const duration = calculateTraceDuration([root], origin);
            const offset = calculateTimelineOffset(root.startTime, origin, duration);
            const width = calculateTimelineWidth(root.latency!, duration);

            expect(duration).toBe(13);
            expect(offset + width).toBeCloseTo(ScaleWidth, 6);
        });

        it("ignores invalid node dates and returns safe empty values when none are valid", () => {
            const valid = makeNode("valid", "2026-07-20T08:00:02Z", {
                children: [makeNode("invalid-child", "not-a-date")],
            });
            const invalid = makeNode("invalid", "not-a-date");

            expect(findEarliestStartTime([valid])?.toISOString()).toBe("2026-07-20T08:00:02.000Z");
            expect(findEarliestStartTime([invalid])).toBeNull();
            expect(calculateTraceDuration([invalid], new Date("2026-07-20T08:00:00Z"))).toBe(0);
            expect(calculateTraceDuration([valid], new Date("not-a-date"))).toBe(0);
        });
    });

    describe("timeline geometry", () => {
        it("calculates proportional offsets and widths", () => {
            const origin = new Date("2026-07-20T08:00:00Z");
            const nodeStart = new Date("2026-07-20T08:00:02Z");

            expect(calculateTimelineOffset(nodeStart, origin, 10, 1000)).toBe(200);
            expect(calculateTimelineWidth(2, 10, 1000)).toBe(200);
        });

        it("supports fractional durations and custom scale widths", () => {
            const origin = new Date("2026-07-20T08:00:00Z");
            const nodeStart = new Date("2026-07-20T08:00:00.500Z");

            expect(calculateTimelineOffset(nodeStart, origin, 1, 1800)).toBe(900);
            expect(calculateTimelineWidth(0.5, 1, 1800)).toBe(900);
        });

        it("returns zero for invalid dates and non-positive spans", () => {
            const origin = new Date("2026-07-20T08:00:00Z");
            const invalidDate = new Date("not-a-date");

            expect(calculateTimelineOffset(invalidDate, origin, 0, 900)).toBe(0);
            expect(calculateTimelineOffset(origin, invalidDate, 10, 900)).toBe(0);
            expect(calculateTimelineOffset(origin, origin, -1, 900)).toBe(0);
            expect(calculateTimelineWidth(0, 0, 900)).toBe(0);
            expect(calculateTimelineWidth(2, -1, 900)).toBe(0);
        });

        it("returns zero for non-finite or invalid geometry inputs", () => {
            const origin = new Date("2026-07-20T08:00:00Z");

            expect(calculateTimelineOffset(origin, origin, Number.POSITIVE_INFINITY, 900)).toBe(0);
            expect(calculateTimelineOffset(origin, origin, 10, Number.NaN)).toBe(0);
            expect(calculateTimelineWidth(Number.NaN, 10, 900)).toBe(0);
            expect(calculateTimelineWidth(-1, 10, 900)).toBe(0);
            expect(calculateTimelineWidth(1, 10, 0)).toBe(0);
        });
    });

    describe("timeline steps", () => {
        it("selects a readable predefined step", () => {
            expect(calculateStepSize(8, 900)).toBe(1);
            expect(calculateStepSize(10_061)).toBe(1200);
        });

        it("keeps tick spacing readable for very long traces", () => {
            for (const duration of [10_000, 40_000, 86_400, 500_000, 1_000_000]) {
                const stepSize = calculateStepSize(duration);
                expect((stepSize / duration) * ScaleWidth).toBeGreaterThanOrEqual(100);
            }
        });

        it("returns zero for invalid durations or scale widths", () => {
            expect(calculateStepSize(0)).toBe(0);
            expect(calculateStepSize(-1)).toBe(0);
            expect(calculateStepSize(Number.NaN)).toBe(0);
            expect(calculateStepSize(8, 0)).toBe(0);
        });

        it("returns an isolated ordered copy of predefined steps", () => {
            const steps = getPredefinedStepSizes();
            const originalLength = steps.length;
            steps.push(999);

            expect(getPredefinedStepSizes()).toHaveLength(originalLength);
            expect(getPredefinedStepSizes()).not.toContain(999);
            expect(getPredefinedStepSizes()).toEqual([...PredefinedStepSizes].sort((left, right) => left - right));
        });
    });
});

describe("selection scroll target", () => {
    const base = {
        index: 0,
        rowHeight: 26,
        scrollTop: 0,
        scrollLeft: 0,
        clientHeight: 260,
        clientWidth: 400,
        barStart: null,
        isInitial: false,
    };

    it("centers the selected row on initial load", () => {
        expect(computeSelectionScrollTarget({ ...base, index: 100, isInitial: true })).toEqual({
            top: 2483,
            left: 0,
        });
    });

    it("reveals a row below the fold and an off-screen-right bar", () => {
        expect(computeSelectionScrollTarget({ ...base, index: 20, barStart: 800 })).toEqual({
            top: 286,
            left: 720,
        });
    });

    it("keeps an already visible row and bar unchanged", () => {
        expect(
            computeSelectionScrollTarget({
                ...base,
                index: 5,
                scrollLeft: 100,
                barStart: 100 + RevealMarginPx,
            })
        ).toEqual({ top: 0, left: 100 });
    });

    it("clamps reveals above and to the left", () => {
        expect(
            computeSelectionScrollTarget({
                ...base,
                index: 1,
                scrollTop: 500,
                scrollLeft: 600,
                barStart: 10,
                isInitial: true,
            })
        ).toEqual({ top: 0, left: 0 });
    });

    it("uses the shared reveal fraction", () => {
        const target = computeSelectionScrollTarget({ ...base, barStart: 900 });
        expect(target.left).toBe(900 - base.clientWidth * RevealLeftFraction);
    });
});
