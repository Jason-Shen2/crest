// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceTimeline and timeline-flattening.ts.

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { computeSelectionScrollTarget, ScaleWidth } from "./timeline-calculations";
import { flattenTimelineRows } from "./timeline-flattening";
import { TimelineRows } from "./timeline-rows";
import { TimelineScale } from "./timeline-scale";
import { resolveTraceSelectionNodeId, useTraceData, useTraceSelection } from "./trace-context";
import type { TraceNode } from "./types";

const TimelineGutterWidth = 208;
const TimelineRowHeight = 26;
const TimelineOverscan = 16;

function findCollapsedAncestors(roots: TraceNode[], selectedNodeId: string, collapsedNodes: Set<string>): string[] {
    const stack = roots.map((node) => ({ node, ancestors: [] as string[] }));
    while (stack.length > 0) {
        const current = stack.pop();
        if (current == null) {
            continue;
        }
        if (current.node.id === selectedNodeId) {
            return current.ancestors.filter((id) => collapsedNodes.has(id));
        }
        for (const child of current.node.children) {
            stack.push({ node: child, ancestors: [...current.ancestors, current.node.id] });
        }
    }
    return [];
}

export function TraceTimeline() {
    const { roots, nodeMap, observationMap, traceStartTime, traceDuration } = useTraceData();
    const { collapsedNodes, toggleCollapsed, selectedNodeId, setSelectedNodeId } = useTraceSelection();
    const displayedSelectedNodeId = resolveTraceSelectionNodeId(roots, selectedNodeId);
    const rows = useMemo(
        () => flattenTimelineRows(roots, collapsedNodes, traceStartTime ?? new Date(Number.NaN), traceDuration),
        [roots, collapsedNodes, traceStartTime, traceDuration]
    );
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const gutterContentRef = useRef<HTMLDivElement>(null);
    const scaleContentRef = useRef<HTMLDivElement>(null);
    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => TimelineRowHeight,
        overscan: TimelineOverscan,
    });
    const virtualItems = rowVirtualizer.getVirtualItems();
    const totalSize = rowVirtualizer.getTotalSize();
    const previousSelectedNodeIdRef = useRef<string | null | undefined>(undefined);

    useLayoutEffect(() => {
        if (selectedNodeId == null) {
            previousSelectedNodeIdRef.current = null;
            return;
        }
        const index = rows.findIndex((row) => row.node.id === selectedNodeId);
        if (index < 0) {
            for (const ancestorId of findCollapsedAncestors(roots, selectedNodeId, collapsedNodes)) {
                toggleCollapsed(ancestorId);
            }
            return;
        }
        if (selectedNodeId === previousSelectedNodeIdRef.current) {
            return;
        }
        const scrollElement = scrollRef.current;
        if (scrollElement == null) {
            return;
        }

        const { top, left } = computeSelectionScrollTarget({
            index,
            rowHeight: TimelineRowHeight,
            scrollTop: scrollElement.scrollTop,
            scrollLeft: scrollElement.scrollLeft,
            clientHeight: scrollElement.clientHeight,
            clientWidth: scrollElement.clientWidth,
            barStart: rows[index].startOffset,
            isInitial: previousSelectedNodeIdRef.current === undefined,
        });
        previousSelectedNodeIdRef.current = selectedNodeId;
        scrollElement.scrollTo({ top, left });
    }, [collapsedNodes, roots, rows, selectedNodeId, toggleCollapsed]);

    const handleScroll = useCallback<React.UIEventHandler<HTMLDivElement>>((event) => {
        const scrollElement = event.currentTarget;
        if (gutterContentRef.current != null) {
            gutterContentRef.current.style.transform = `translateY(${-scrollElement.scrollTop}px)`;
        }
        if (scaleContentRef.current != null) {
            scaleContentRef.current.style.transform = `translateX(${-scrollElement.scrollLeft}px)`;
        }
    }, []);

    const handleSelect = useCallback(
        (nodeId: string) => {
            setSelectedNodeId(nodeMap.get(nodeId)?.type === "TRACE" ? null : nodeId);
        },
        [nodeMap, setSelectedNodeId]
    );

    return (
        <div
            role="region"
            aria-label="Trace timeline"
            className="flex h-full min-h-0 flex-col overflow-hidden"
            onMouseLeave={() => setHoveredNodeId(null)}
        >
            <div className="flex shrink-0 border-b border-border">
                <div
                    className="flex h-7 shrink-0 items-center border-r border-border bg-panel px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                    style={{ width: TimelineGutterWidth }}
                >
                    Name
                </div>
                <div className="min-w-0 flex-1 overflow-hidden bg-panel">
                    <div ref={scaleContentRef} data-testid="timeline-scale-content" className="will-change-transform">
                        <TimelineScale traceDuration={traceDuration} />
                    </div>
                </div>
            </div>
            <TimelineRows
                rows={rows}
                virtualItems={virtualItems}
                totalSize={totalSize}
                observationMap={observationMap}
                selectedNodeId={displayedSelectedNodeId}
                hoveredNodeId={hoveredNodeId}
                collapsedNodes={collapsedNodes}
                onSelect={handleSelect}
                onHover={setHoveredNodeId}
                onToggleCollapse={toggleCollapsed}
                scaleWidth={ScaleWidth}
                gutterWidth={TimelineGutterWidth}
                scrollRef={scrollRef}
                gutterContentRef={gutterContentRef}
                onScroll={handleScroll}
            />
        </div>
    );
}
