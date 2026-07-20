// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceTimeline/timeline-flattening.ts.

import { calculateTimelineOffset, calculateTimelineWidth } from "./timeline-calculations";
import type { TimelineTraceNode } from "./timeline-types";
import { flattenTraceTree } from "./tree-building";
import type { TraceNode } from "./types";

function validDurationSeconds(node: TraceNode): number {
    if (node.endTime == null) {
        return 0;
    }

    const duration = (node.endTime.getTime() - node.startTime.getTime()) / 1000;
    return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

export function flattenTimelineRows(
    roots: TraceNode[],
    collapsedNodes: Set<string>,
    traceStartTime: Date,
    traceDuration: number
): TimelineTraceNode[] {
    return flattenTraceTree(roots, collapsedNodes).map((flatNode) => {
        const duration = validDurationSeconds(flatNode.node);
        return {
            ...flatNode,
            duration,
            startOffset: calculateTimelineOffset(flatNode.node.startTime, traceStartTime, traceDuration),
            width: calculateTimelineWidth(duration, traceDuration),
        };
    });
}
