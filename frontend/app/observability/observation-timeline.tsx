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

interface TimelineRow {
    observation: AgentObservabilityObservation;
    presentation: ObservationPresentation;
    category: ObservationCategory;
    searchableText: string;
    relativeTime: string;
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

function makeTimelineRows(graph: AgentObservabilityTraceGraph): TimelineRow[] {
    return graph.observations
        .map((observation, index) => ({ observation, index }))
        .filter(({ observation }) => observation.type !== "AGENT")
        .sort(
            (left, right) =>
                new Date(left.observation.startTime).getTime() - new Date(right.observation.startTime).getTime() ||
                left.index - right.index
        )
        .map(({ observation }) => {
            const presentation = presentObservation(observation);
            return {
                observation,
                presentation,
                category: presentation.category,
                searchableText: presentation.searchableText,
                relativeTime: formatRelativeTime(observation.startTime, graph.trace.timestamp),
            };
        });
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
    const rows = useMemo(
        () => filterTimelineRows(makeTimelineRows(graph), query, categories),
        [graph, query, categories]
    );
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
    const tailContentVersion = rows.length === 0 ? "" : rows[rows.length - 1].searchableText;

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
