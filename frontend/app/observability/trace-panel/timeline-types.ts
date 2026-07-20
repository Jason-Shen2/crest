// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceTimeline.

import type { FlatTraceNode } from "./types";

export type TimelineTraceNode = FlatTraceNode & {
    startOffset: number;
    width: number;
    duration: number;
};

export type SelectionScrollArgs = {
    index: number;
    rowHeight: number;
    scrollTop: number;
    scrollLeft: number;
    clientHeight: number;
    clientWidth: number;
    barStart: number | null;
    isInitial: boolean;
};
