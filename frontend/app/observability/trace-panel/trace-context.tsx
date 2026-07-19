// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceDataContext and SelectionContext.

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

import { buildTraceTree } from "./tree-building";
import type { TraceNavigationMode, TraceNode, TraceSearchListItem } from "./types";

type TraceDataContextValue = {
    detail: TraceDetail;
    roots: TraceNode[];
    nodeMap: Map<string, TraceNode>;
    searchItems: TraceSearchListItem[];
    observationMap: Map<string, Observation>;
    traceStartTime: Date;
    traceDuration: number;
};

type TraceSelectionContextValue = {
    selectedNodeId: string | null;
    setSelectedNodeId: (id: string | null) => void;
    collapsedNodes: Set<string>;
    toggleCollapsed: (id: string) => void;
    navigationMode: TraceNavigationMode;
    setNavigationMode: (mode: TraceNavigationMode) => void;
    searchQuery: string;
    setSearchQuery: (query: string) => void;
};

const TraceDataContext = createContext<TraceDataContextValue | null>(null);
const TraceSelectionContext = createContext<TraceSelectionContextValue | null>(null);

function finiteTimestamp(value: string | null | undefined): number | null {
    const timestamp = value == null ? Number.NaN : Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function calculateTraceTimeRange(detail: TraceDetail): { traceStartTime: Date; traceDuration: number } {
    const starts = [
        finiteTimestamp(detail.trace.timestamp),
        ...detail.observations.map((observation) => finiteTimestamp(observation.startTime)),
    ].filter((value): value is number => value != null);
    const fallbackStart = finiteTimestamp(detail.trace.timestamp) ?? 0;
    const start = starts.length > 0 ? Math.min(...starts) : fallbackStart;
    const ends = [
        finiteTimestamp(detail.trace.endedAt),
        ...detail.observations.map(
            (observation) => finiteTimestamp(observation.endTime) ?? finiteTimestamp(observation.startTime)
        ),
    ].filter((value): value is number => value != null);
    const end = ends.length > 0 ? Math.max(start, ...ends) : start;
    return { traceStartTime: new Date(start), traceDuration: Math.max(0.001, (end - start) / 1000) };
}

export function useTraceData(): TraceDataContextValue {
    const context = useContext(TraceDataContext);
    if (!context) {
        throw new Error("useTraceData must be used within TraceDataProvider");
    }
    return context;
}

export function useTraceSelection(): TraceSelectionContextValue {
    const context = useContext(TraceSelectionContext);
    if (!context) {
        throw new Error("useTraceSelection must be used within TraceSelectionProvider");
    }
    return context;
}

export function TraceDataProvider({ detail, children }: { detail: TraceDetail; children: ReactNode }) {
    const { roots, nodeMap, searchItems } = useMemo(() => buildTraceTree(detail), [detail]);
    const observationMap = useMemo(
        () => new Map(detail.observations.map((observation) => [observation.id, observation])),
        [detail.observations]
    );
    const { traceStartTime, traceDuration } = useMemo(() => calculateTraceTimeRange(detail), [detail]);
    const value = useMemo(
        () => ({ detail, roots, nodeMap, searchItems, observationMap, traceStartTime, traceDuration }),
        [detail, roots, nodeMap, searchItems, observationMap, traceStartTime, traceDuration]
    );

    return <TraceDataContext.Provider value={value}>{children}</TraceDataContext.Provider>;
}

export function TraceSelectionProvider({ traceId, children }: { traceId: string; children: ReactNode }) {
    const { observationMap } = useTraceData();
    const [selectedNodeByTrace, setSelectedNodeByTrace] = useState<Record<string, string | null>>({});
    const [collapsedByTrace, setCollapsedByTrace] = useState<Record<string, Set<string>>>({});
    const [navigationMode, setNavigationMode] = useState<TraceNavigationMode>("tree");
    const [searchQuery, setSearchQuery] = useState("");
    const storedSelectedNodeId = selectedNodeByTrace[traceId] ?? null;
    const selectedNodeId =
        storedSelectedNodeId != null && observationMap.has(storedSelectedNodeId) ? storedSelectedNodeId : null;
    const collapsedNodes = collapsedByTrace[traceId] ?? new Set<string>();
    const setSelectedNodeId = useCallback(
        (id: string | null) => {
            setSelectedNodeByTrace((current) => ({ ...current, [traceId]: id }));
        },
        [traceId]
    );
    const toggleCollapsed = useCallback(
        (id: string) => {
            setCollapsedByTrace((current) => {
                const next = new Set(current[traceId] ?? []);
                if (next.has(id)) {
                    next.delete(id);
                } else {
                    next.add(id);
                }
                return { ...current, [traceId]: next };
            });
        },
        [traceId]
    );
    const value = useMemo(
        () => ({
            selectedNodeId,
            setSelectedNodeId,
            collapsedNodes,
            toggleCollapsed,
            navigationMode,
            setNavigationMode,
            searchQuery,
            setSearchQuery,
        }),
        [selectedNodeId, setSelectedNodeId, collapsedNodes, toggleCollapsed, navigationMode, searchQuery]
    );

    return <TraceSelectionContext.Provider value={value}>{children}</TraceSelectionContext.Provider>;
}
