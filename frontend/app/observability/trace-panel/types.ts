// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse web/src/components/trace/lib/types.ts.

export type TraceNode = {
    id: string;
    type: "TRACE" | Observation["type"];
    name: string;
    startTime: Date;
    endTime: Date | null;
    level?: Observation["level"];
    children: TraceNode[];
    inputUsage?: number | null;
    outputUsage?: number | null;
    totalUsage?: number | null;
    calculatedInputCost?: number | null;
    calculatedOutputCost?: number | null;
    calculatedTotalCost?: number | null;
    parentObservationId?: string | null;
    traceId?: string;
    totalCost?: number;
    totalTokens?: number;
    latency?: number | null;
    subtreeWallClockDurationMs?: number;
    startTimeSinceTrace: number;
    startTimeSinceParentStart: number | null;
    depth: number;
    childrenDepth: number;
};

export type TraceSearchListItem = {
    node: TraceNode;
    parentTotalCost?: number;
    parentTotalDuration?: number;
    observationId?: string;
};

export type FlatTraceNode = {
    node: TraceNode;
    depth: number;
    treeLines: boolean[];
    isLastSibling: boolean;
};

export type TraceNavigationMode = "tree" | "timeline";
