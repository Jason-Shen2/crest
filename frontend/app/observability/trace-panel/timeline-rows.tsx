// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceTimeline/TimelineRows.tsx.

import type { VirtualItem } from "@tanstack/react-virtual";
import { memo } from "react";

import { cn } from "@/util/util";
import { TimelineBar } from "./timeline-bar";
import { ScaleWidth } from "./timeline-calculations";
import { TimelineGutterRow } from "./timeline-gutter-row";
import type { TimelineTraceNode } from "./timeline-types";

type TimelineRowsProps = {
    rows: TimelineTraceNode[];
    virtualItems: VirtualItem[];
    totalSize: number;
    observationMap: Map<string, Observation>;
    selectedNodeId: string | null;
    hoveredNodeId: string | null;
    collapsedNodes: Set<string>;
    onSelect: (nodeId: string) => void;
    onHover: (nodeId: string | null) => void;
    onToggleCollapse: (nodeId: string) => void;
    scaleWidth?: number;
};

type RowShellProps = {
    row: TimelineTraceNode;
    virtualItem: VirtualItem;
    isSelected: boolean;
    isHovered: boolean;
    onSelect: (nodeId: string) => void;
    onHover: (nodeId: string | null) => void;
};

type GutterRowShellProps = RowShellProps & {
    isCollapsed: boolean;
    onToggleCollapse: (nodeId: string) => void;
};

function TimelineGutterRowShellComponent({
    row,
    virtualItem,
    isSelected,
    isHovered,
    isCollapsed,
    onSelect,
    onHover,
    onToggleCollapse,
}: GutterRowShellProps) {
    return (
        <div
            className={cn("absolute top-0 left-0 w-full", isHovered && !isSelected && "bg-fg-overlay-1/50")}
            style={{ height: virtualItem.size, transform: `translateY(${virtualItem.start}px)` }}
            onMouseEnter={() => onHover(row.node.id)}
            onMouseLeave={() => onHover(null)}
        >
            <TimelineGutterRow
                row={row}
                isSelected={isSelected}
                isCollapsed={isCollapsed}
                onSelect={onSelect}
                onToggleCollapse={onToggleCollapse}
            />
        </div>
    );
}

const TimelineGutterRowShell = memo(TimelineGutterRowShellComponent);
TimelineGutterRowShell.displayName = "TimelineGutterRowShell";

type ChartRowShellProps = RowShellProps & {
    observation?: Observation;
    scaleWidth: number;
};

function TimelineChartRowShellComponent({
    row,
    virtualItem,
    observation,
    scaleWidth,
    isSelected,
    isHovered,
    onSelect,
    onHover,
}: ChartRowShellProps) {
    return (
        <div
            data-testid="timeline-chart-row"
            className={cn(
                "absolute top-0 left-0 cursor-pointer border-b border-border/30",
                isSelected ? "bg-accent/10" : isHovered ? "bg-fg-overlay-1/30" : ""
            )}
            style={{
                width: scaleWidth,
                height: virtualItem.size,
                transform: `translateY(${virtualItem.start}px)`,
            }}
            onClick={() => onSelect(row.node.id)}
            onMouseEnter={() => onHover(row.node.id)}
            onMouseLeave={() => onHover(null)}
        >
            <TimelineBar row={row} observation={observation} isSelected={isSelected} isHovered={isHovered} />
        </div>
    );
}

const TimelineChartRowShell = memo(TimelineChartRowShellComponent);
TimelineChartRowShell.displayName = "TimelineChartRowShell";

export function TimelineRows({
    rows,
    virtualItems,
    totalSize,
    observationMap,
    selectedNodeId,
    hoveredNodeId,
    collapsedNodes,
    onSelect,
    onHover,
    onToggleCollapse,
    scaleWidth = ScaleWidth,
}: TimelineRowsProps) {
    return (
        <>
            <div
                data-testid="timeline-gutter-rows"
                role="tree"
                aria-label="Trace timeline rows"
                className="relative w-full"
                style={{ height: totalSize }}
            >
                {virtualItems.map((virtualItem) => {
                    const row = rows[virtualItem.index];
                    if (row == null) {
                        return null;
                    }
                    return (
                        <TimelineGutterRowShell
                            key={virtualItem.key}
                            row={row}
                            virtualItem={virtualItem}
                            isSelected={selectedNodeId === row.node.id}
                            isHovered={hoveredNodeId === row.node.id}
                            isCollapsed={collapsedNodes.has(row.node.id)}
                            onSelect={onSelect}
                            onHover={onHover}
                            onToggleCollapse={onToggleCollapse}
                        />
                    );
                })}
            </div>
            <div
                data-testid="timeline-chart-rows"
                className="relative shrink-0"
                style={{ width: scaleWidth, height: totalSize }}
            >
                {virtualItems.map((virtualItem) => {
                    const row = rows[virtualItem.index];
                    if (row == null) {
                        return null;
                    }
                    return (
                        <TimelineChartRowShell
                            key={virtualItem.key}
                            row={row}
                            virtualItem={virtualItem}
                            observation={observationMap.get(row.node.id)}
                            scaleWidth={scaleWidth}
                            isSelected={selectedNodeId === row.node.id}
                            isHovered={hoveredNodeId === row.node.id}
                            onSelect={onSelect}
                            onHover={onHover}
                        />
                    );
                })}
            </div>
        </>
    );
}
