// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceTimeline/timeline-calculations.ts.

import type { SelectionScrollArgs } from "./timeline-types";
import type { TraceNode } from "./types";

export const ScaleWidth = 900;
export const StepSize = 100;

export const PredefinedStepSizes = [
    0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 35, 40, 45, 50, 100, 150, 200, 250, 300,
    350, 400, 450, 500, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400, 21600, 43200, 86400,
];

export const RevealMarginPx = 16;
export const RevealLeftFraction = 0.2;

function finiteDateValue(date: Date): number | null {
    const value = date.getTime();
    return Number.isFinite(value) ? value : null;
}

export function findEarliestStartTime(roots: TraceNode[]): Date | null {
    let earliest = Number.POSITIVE_INFINITY;
    const stack = [...roots];

    while (stack.length > 0) {
        const node = stack.pop()!;
        const start = finiteDateValue(node.startTime);
        if (start != null && start < earliest) {
            earliest = start;
        }
        stack.push(...node.children);
    }

    return Number.isFinite(earliest) ? new Date(earliest) : null;
}

export function calculateTraceDuration(roots: TraceNode[], origin: Date): number {
    const originMs = finiteDateValue(origin);
    if (roots.length === 0 || originMs == null) {
        return 0;
    }

    let latestEndMs = Number.NEGATIVE_INFINITY;
    const stack = [...roots];

    while (stack.length > 0) {
        const node = stack.pop()!;
        const end = node.endTime == null ? null : finiteDateValue(node.endTime);
        const start = finiteDateValue(node.startTime);
        const effectiveEnd = end ?? start;
        if (effectiveEnd != null && effectiveEnd > latestEndMs) {
            latestEndMs = effectiveEnd;
        }
        stack.push(...node.children);
    }

    const spanFromEnds = Number.isFinite(latestEndMs) ? (latestEndMs - originMs) / 1000 : 0;
    let maxRootLatencySpan = 0;

    for (const root of roots) {
        const start = finiteDateValue(root.startTime);
        const latency = root.latency;
        if (start == null || latency == null || !Number.isFinite(latency) || latency < 0) {
            continue;
        }
        maxRootLatencySpan = Math.max(maxRootLatencySpan, (start - originMs) / 1000 + latency);
    }

    const duration = Math.max(0, spanFromEnds, maxRootLatencySpan);
    return Number.isFinite(duration) ? duration : 0;
}

export function calculateTimelineOffset(
    nodeStartTime: Date,
    traceStartTime: Date,
    totalScaleSpan: number,
    scaleWidth: number = ScaleWidth
): number {
    const nodeStartMs = finiteDateValue(nodeStartTime);
    const traceStartMs = finiteDateValue(traceStartTime);
    if (
        nodeStartMs == null ||
        traceStartMs == null ||
        !Number.isFinite(totalScaleSpan) ||
        totalScaleSpan <= 0 ||
        !Number.isFinite(scaleWidth) ||
        scaleWidth <= 0
    ) {
        return 0;
    }

    const offset = ((nodeStartMs - traceStartMs) / 1000 / totalScaleSpan) * scaleWidth;
    return Number.isFinite(offset) ? offset : 0;
}

export function calculateTimelineWidth(
    duration: number,
    totalScaleSpan: number,
    scaleWidth: number = ScaleWidth
): number {
    if (
        !Number.isFinite(duration) ||
        duration < 0 ||
        !Number.isFinite(totalScaleSpan) ||
        totalScaleSpan <= 0 ||
        !Number.isFinite(scaleWidth) ||
        scaleWidth <= 0
    ) {
        return 0;
    }

    const width = (duration / totalScaleSpan) * scaleWidth;
    return Number.isFinite(width) ? width : 0;
}

export function calculateStepSize(traceDuration: number, scaleWidth: number = ScaleWidth): number {
    if (!Number.isFinite(traceDuration) || traceDuration <= 0 || !Number.isFinite(scaleWidth) || scaleWidth <= 0) {
        return 0;
    }

    const calculatedStepSize = traceDuration / (scaleWidth / StepSize);
    const predefined = PredefinedStepSizes.find((step) => step >= calculatedStepSize);
    if (predefined != null) {
        return predefined;
    }

    const DayInSeconds = 86_400;
    const step = Math.ceil(calculatedStepSize / DayInSeconds) * DayInSeconds;
    return Number.isFinite(step) ? step : 0;
}

export function getPredefinedStepSizes(): number[] {
    return [...PredefinedStepSizes];
}

export function computeSelectionScrollTarget(args: SelectionScrollArgs): { top: number; left: number } {
    const { index, rowHeight, scrollTop, scrollLeft, clientHeight, clientWidth, barStart, isInitial } = args;

    const rowTop = index * rowHeight;
    let top = scrollTop;
    if (isInitial) {
        top = rowTop - (clientHeight - rowHeight) / 2;
    } else if (rowTop < scrollTop) {
        top = rowTop;
    } else if (rowTop + rowHeight > scrollTop + clientHeight) {
        top = rowTop - clientHeight + rowHeight;
    }

    let left = scrollLeft;
    if (barStart != null) {
        const viewRight = scrollLeft + clientWidth;
        if (barStart < scrollLeft + RevealMarginPx || barStart > viewRight - RevealMarginPx) {
            left = Math.max(0, barStart - clientWidth * RevealLeftFraction);
        }
    }

    return { top: Math.max(0, top), left };
}
