// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Ported from Langfuse web/src/features/trace-graph-view/types.ts.

export type GraphNodeData = {
    id: string;
    label: string;
    type: string;
};

export type GraphCanvasData = {
    nodes: GraphNodeData[];
    edges: Array<{ from: string; to: string }>;
};

export type GraphObservation = {
    id: string;
    parentObservationId: string | null;
    name: string;
    startTime: string;
    endTime?: string;
    observationType: string;
};

export const LangfuseStartNodeName = "__start__";
export const LangfuseEndNodeName = "__end__";
