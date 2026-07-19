// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceTimeline and timeline-flattening.ts.

import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useRef } from "react";

import { resolveTraceSelectionNodeId, useTraceData, useTraceSelection } from "./trace-context";
import { flattenTraceTree } from "./tree-building";

const ScaleWidth = 900;

function formatTick(seconds: number): string {
    if (seconds < 1) {
        return `${Math.round(seconds * 1000)}ms`;
    }
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

export function TraceTimeline() {
    const { roots, traceStartTime, traceDuration } = useTraceData();
    const { collapsedNodes, toggleCollapsed, selectedNodeId, setSelectedNodeId, searchQuery } = useTraceSelection();
    const displayedSelectedNodeId = resolveTraceSelectionNodeId(roots, selectedNodeId);
    const rows = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        return flattenTraceTree(roots, collapsedNodes)
            .filter(({ node }) => !query || `${node.name} ${node.type}`.toLowerCase().includes(query))
            .map((item) => {
                const startTime = item.node.startTime.getTime();
                if (traceStartTime == null || !Number.isFinite(startTime)) {
                    return { ...item, startOffset: null, width: null, duration: null };
                }
                const endTime = item.node.endTime?.getTime();
                const duration =
                    endTime != null && Number.isFinite(endTime) ? Math.max(0, (endTime - startTime) / 1000) : 0;
                const startOffset = ((startTime - traceStartTime.getTime()) / 1000 / traceDuration) * ScaleWidth;
                return {
                    ...item,
                    startOffset,
                    width: Math.max(3, (duration / traceDuration) * ScaleWidth),
                    duration,
                };
            });
    }, [roots, collapsedNodes, traceStartTime, traceDuration, searchQuery]);
    const ticks = Array.from({ length: 10 }, (_, index) => ({
        left: index * 100,
        value: (traceDuration * index) / 9,
    }));
    const gutterRef = useRef<HTMLDivElement>(null);

    return (
        <div role="region" aria-label="Trace timeline" className="flex h-full min-h-0 overflow-hidden">
            <div className="w-52 shrink-0 overflow-hidden border-r border-border">
                <div className="relative z-10 flex h-7 items-center border-b border-border bg-panel px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Name
                </div>
                <div ref={gutterRef} className="will-change-transform">
                    {rows.map(({ node, depth }) => {
                        const hasChildren = node.children.length > 0;
                        const collapsed = collapsedNodes.has(node.id);
                        return (
                            <button
                                key={node.id}
                                type="button"
                                aria-pressed={displayedSelectedNodeId === node.id}
                                className={`flex h-7 w-full cursor-pointer items-center gap-1 border-l-2 pr-2 text-left text-xs ${
                                    displayedSelectedNodeId === node.id
                                        ? "border-accent bg-accent/10 text-foreground"
                                        : "border-transparent text-muted-foreground hover:bg-fg-overlay-1/50"
                                }`}
                                style={{ paddingLeft: `${8 + depth * 12}px` }}
                                onClick={() => setSelectedNodeId(node.type === "TRACE" ? null : node.id)}
                            >
                                <span
                                    className={hasChildren ? "cursor-pointer" : "invisible"}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        toggleCollapsed(node.id);
                                    }}
                                >
                                    {collapsed ? (
                                        <ChevronRight className="h-3 w-3" />
                                    ) : (
                                        <ChevronDown className="h-3 w-3" />
                                    )}
                                </span>
                                <span className="truncate">{node.name}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
            <div
                className="min-w-0 flex-1 overflow-auto"
                onScroll={(event) => {
                    if (gutterRef.current) {
                        gutterRef.current.style.transform = `translateY(${-event.currentTarget.scrollTop}px)`;
                    }
                }}
            >
                <div className="relative min-w-[900px]" style={{ width: `${ScaleWidth}px` }}>
                    <div className="sticky top-0 z-10 h-7 border-b border-border bg-panel">
                        {ticks.map((tick) => (
                            <span
                                key={tick.left}
                                className="absolute top-1 font-mono text-[9px] text-muted-foreground tabular-nums"
                                style={{ left: `${tick.left}px` }}
                            >
                                {formatTick(tick.value)}
                            </span>
                        ))}
                    </div>
                    {rows.map(({ node, startOffset, width, duration }) => (
                        <button
                            key={node.id}
                            type="button"
                            aria-label={`${node.name} timeline bar`}
                            aria-pressed={displayedSelectedNodeId === node.id}
                            className={`relative block h-7 w-full cursor-pointer border-b border-border/30 text-left ${
                                displayedSelectedNodeId === node.id ? "bg-accent/5" : "hover:bg-fg-overlay-1/30"
                            }`}
                            onClick={() => setSelectedNodeId(node.type === "TRACE" ? null : node.id)}
                        >
                            {startOffset != null && width != null && duration != null ? (
                                <>
                                    <span
                                        className={`absolute top-1/2 h-3 -translate-y-1/2 rounded-sm ${
                                            node.level === "ERROR"
                                                ? "bg-error/70"
                                                : node.type === "TOOL"
                                                  ? "bg-success/60"
                                                  : "bg-accent/60"
                                        }`}
                                        style={{ left: `${startOffset}px`, width: `${width}px` }}
                                    />
                                    <span
                                        className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[9px] text-muted-foreground tabular-nums"
                                        style={{ left: `${startOffset + width + 5}px` }}
                                    >
                                        {formatTick(duration)}
                                    </span>
                                </>
                            ) : null}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
