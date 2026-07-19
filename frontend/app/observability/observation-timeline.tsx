// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject, type UIEvent } from "react";

import {
    filterTimelineRows,
    getTimelineKeyboardIntent,
    isTimelineAtBottom,
    shouldHandleTimelineKeyboardIntent,
} from "./observability-view-state";
import { presentObservation, type ObservationCategory, type ObservationPresentation } from "./observation-presentation";
import { ObservationRow } from "./observation-row";

export interface TimelineRow {
    observation: AgentObservabilityObservation;
    presentation: ObservationPresentation;
    category: ObservationCategory;
    searchableText: string;
    relativeTime: string;
}

export interface TimelineRowsCache {
    traceId: string;
    sourceObservationIds: string[];
    rows: TimelineRow[];
}

interface ObservationTimelineProps {
    graph: AgentObservabilityTraceGraph;
    query: string;
    categories: Set<ObservationCategory>;
    expandedObservationIds: Set<string>;
    selectedObservationId?: string;
    followLive: boolean;
    scrollOffset: number;
    searchInputRef: RefObject<HTMLInputElement>;
    onSelectObservation: (observationId?: string) => void;
    onToggleExpanded: (observationId: string) => void;
    onCollapseObservation: (observationId: string) => void;
    onPauseFollowLive: () => void;
    onScrollOffsetChange: (scrollOffset: number) => void;
}

function formatRelativeTime(startTime: string, traceTimestamp: string): string {
    const offsetMs = new Date(startTime).getTime() - new Date(traceTimestamp).getTime();
    if (!Number.isFinite(offsetMs)) {
        return "+0.0s";
    }
    return `+${Math.max(0, offsetMs / 1000).toFixed(1)}s`;
}

function makeTimelineRow(observation: AgentObservabilityObservation, traceTimestamp: string): TimelineRow {
    const presentation = presentObservation(observation);
    return {
        observation,
        presentation,
        category: presentation.category,
        searchableText: presentation.searchableText,
        relativeTime: formatRelativeTime(observation.startTime, traceTimestamp),
    };
}

export function buildTimelineRows(
    graph: AgentObservabilityTraceGraph,
    previous?: TimelineRowsCache
): TimelineRowsCache {
    const observations = graph.observations.filter((observation) => observation.type !== "AGENT");
    const tailObservation = observations[observations.length - 1];
    const canReuseStreamingPrefix =
        previous?.traceId === graph.trace.id &&
        observations.length > 0 &&
        observations.length === previous.sourceObservationIds.length &&
        tailObservation.type === "GENERATION" &&
        tailObservation.endTime == null &&
        previous.rows[previous.rows.length - 1]?.observation.id === tailObservation.id &&
        previous.rows.slice(0, -1).every((row) => row.observation.endTime != null) &&
        observations.every((observation, index) => observation.id === previous.sourceObservationIds[index]);

    if (canReuseStreamingPrefix) {
        return {
            traceId: graph.trace.id,
            sourceObservationIds: previous.sourceObservationIds,
            rows: [...previous.rows.slice(0, -1), makeTimelineRow(tailObservation, graph.trace.timestamp)],
        };
    }

    const rows = observations
        .map((observation, index) => ({ observation, index }))
        .sort(
            (left, right) =>
                new Date(left.observation.startTime).getTime() - new Date(right.observation.startTime).getTime() ||
                left.index - right.index
        )
        .map(({ observation }) => makeTimelineRow(observation, graph.trace.timestamp));
    return {
        traceId: graph.trace.id,
        sourceObservationIds: observations.map((observation) => observation.id),
        rows,
    };
}

export function ObservationTimeline({
    graph,
    query,
    categories,
    expandedObservationIds,
    selectedObservationId,
    followLive,
    scrollOffset,
    searchInputRef,
    onSelectObservation,
    onToggleExpanded,
    onCollapseObservation,
    onPauseFollowLive,
    onScrollOffsetChange,
}: ObservationTimelineProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const autoScrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const rowsCacheRef = useRef<TimelineRowsCache>(undefined);
    const rowsCache = useMemo(() => buildTimelineRows(graph, rowsCacheRef.current), [graph]);
    rowsCacheRef.current = rowsCache;
    const rows = useMemo(() => filterTimelineRows(rowsCache.rows, query, categories), [rowsCache, query, categories]);
    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        getItemKey: (index) => rows[index].observation.id,
        estimateSize: () => 44,
        measureElement: (element) => element.getBoundingClientRect().height,
        overscan: 8,
        initialRect: { width: 320, height: 480 },
        initialOffset: scrollOffset,
    });
    const tailRow = rows[rows.length - 1];
    const tailContentVersion = tailRow
        ? [tailRow.searchableText, ...tailRow.presentation.badges.flatMap((badge) => [badge.label, badge.tone])].join(
              "\u0000"
          )
        : "";

    useEffect(() => {
        rowVirtualizer.measure();
    }, [expandedObservationIds, rowVirtualizer]);

    useEffect(() => {
        if (!followLive || rows.length === 0) {
            return;
        }
        rowVirtualizer.measure();
        const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        clearTimeout(autoScrollTimeoutRef.current);
        autoScrollTimeoutRef.current = setTimeout(
            () => {
                autoScrollTimeoutRef.current = undefined;
            },
            reducedMotion ? 0 : 300
        );
        rowVirtualizer.scrollToIndex(rows.length - 1, {
            align: "end",
            behavior: reducedMotion ? "auto" : "smooth",
        });
        return () => clearTimeout(autoScrollTimeoutRef.current);
    }, [followLive, rows.length, rowVirtualizer, tailContentVersion]);

    const selectIndex = (index: number) => {
        if (rows.length === 0) {
            return;
        }
        const boundedIndex = Math.max(0, Math.min(index, rows.length - 1));
        onSelectObservation(rows[boundedIndex].observation.id);
        rowVirtualizer.scrollToIndex(boundedIndex, { align: "auto" });
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement;
        const selectedIndex = rows.findIndex((row) => row.observation.id === selectedObservationId);
        const intent = getTimelineKeyboardIntent(event.key, event);
        if (!intent || !shouldHandleTimelineKeyboardIntent(intent, target.tagName)) {
            return;
        }
        event.preventDefault();
        switch (intent) {
            case "search":
                searchInputRef.current?.focus();
                return;
            case "next":
                selectIndex(selectedIndex < 0 ? 0 : selectedIndex + 1);
                return;
            case "previous":
                selectIndex(selectedIndex < 0 ? rows.length - 1 : selectedIndex - 1);
                return;
            case "first":
                selectIndex(0);
                return;
            case "last":
                selectIndex(rows.length - 1);
                return;
            case "toggle":
                if (selectedIndex >= 0) {
                    onToggleExpanded(rows[selectedIndex].observation.id);
                }
                return;
            case "collapse":
                if (selectedIndex >= 0) {
                    onCollapseObservation(rows[selectedIndex].observation.id);
                }
        }
    };

    const handleScroll = (event: UIEvent<HTMLDivElement>) => {
        onScrollOffsetChange(event.currentTarget.scrollTop);
        if (!followLive || autoScrollTimeoutRef.current != null) {
            return;
        }
        if (!isTimelineAtBottom(event.currentTarget)) {
            onPauseFollowLive();
        }
    };

    const handleUserScrollIntent = () => {
        clearTimeout(autoScrollTimeoutRef.current);
        autoScrollTimeoutRef.current = undefined;
    };

    const virtualItems = rowVirtualizer.getVirtualItems();
    return (
        <div
            ref={scrollRef}
            aria-label="Observation Timeline"
            className="min-h-0 flex-1 overflow-auto p-2 outline-none"
            role="listbox"
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onScroll={handleScroll}
            onWheel={handleUserScrollIntent}
        >
            {rows.length === 0 ? (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">No matching observations.</div>
            ) : (
                <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
                    {virtualItems.map((virtualItem) => {
                        const row = rows[virtualItem.index];
                        return (
                            <div
                                key={row.observation.id}
                                ref={rowVirtualizer.measureElement}
                                className="absolute left-0 top-0 w-full pb-1"
                                data-index={virtualItem.index}
                                style={{ transform: `translateY(${virtualItem.start}px)` }}
                            >
                                <ObservationRow
                                    observation={row.observation}
                                    presentation={row.presentation}
                                    relativeTime={row.relativeTime}
                                    expanded={expandedObservationIds.has(row.observation.id)}
                                    selected={selectedObservationId === row.observation.id}
                                    onToggle={() => {
                                        onSelectObservation(row.observation.id);
                                        onToggleExpanded(row.observation.id);
                                    }}
                                />
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
