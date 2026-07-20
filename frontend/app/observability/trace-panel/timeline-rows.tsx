// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceTimeline/TimelineRows.tsx.

import type { VirtualItem } from "@tanstack/react-virtual";
import { memo, useEffect, useRef, type KeyboardEvent, type RefObject, type UIEventHandler } from "react";

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
    gutterWidth?: number;
    scrollRef?: RefObject<HTMLDivElement>;
    gutterContentRef?: RefObject<HTMLDivElement>;
    onScroll?: UIEventHandler<HTMLDivElement>;
};

type RowShellProps = {
    row: TimelineTraceNode;
    virtualItem: VirtualItem;
    isSelected: boolean;
    isHovered: boolean;
    onSelect: (nodeId: string) => void;
    onHover: (nodeId: string | null) => void;
    onNavigate: (event: KeyboardEvent<HTMLDivElement>, nodeId: string) => void;
    registerTreeItem: (nodeId: string, element: HTMLDivElement | null) => void;
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
    onNavigate,
    registerTreeItem,
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
                onNavigate={onNavigate}
                itemRef={(element) => registerTreeItem(row.node.id, element)}
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
    gutterWidth = 208,
    scrollRef,
    gutterContentRef,
    onScroll,
}: TimelineRowsProps) {
    const treeItemsRef = useRef(new Map<string, HTMLDivElement>());
    const selectedVirtualItemKey =
        selectedNodeId == null
            ? null
            : (virtualItems.find((virtualItem) => rows[virtualItem.index]?.node.id === selectedNodeId)?.key ?? null);

    useEffect(() => {
        if (selectedNodeId != null && selectedVirtualItemKey != null) {
            treeItemsRef.current.get(selectedNodeId)?.focus();
        }
    }, [selectedNodeId, selectedVirtualItemKey]);

    const registerTreeItem = (nodeId: string, element: HTMLDivElement | null) => {
        if (element == null) {
            treeItemsRef.current.delete(nodeId);
            return;
        }
        treeItemsRef.current.set(nodeId, element);
    };

    const onNavigate = (event: KeyboardEvent<HTMLDivElement>, nodeId: string) => {
        const index = rows.findIndex((row) => row.node.id === nodeId);
        if (index < 0) {
            return;
        }

        const selectIndex = (nextIndex: number) => {
            const nextRow = rows[nextIndex];
            if (nextRow != null) {
                onSelect(nextRow.node.id);
            }
        };

        if (event.key === "ArrowDown") {
            event.preventDefault();
            selectIndex(index + 1);
            return;
        }
        if (event.key === "ArrowUp") {
            event.preventDefault();
            selectIndex(index - 1);
            return;
        }
        if (event.key === "Home") {
            event.preventDefault();
            selectIndex(0);
            return;
        }
        if (event.key === "End") {
            event.preventDefault();
            selectIndex(rows.length - 1);
            return;
        }

        const row = rows[index];
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            if (row.node.children.length > 0 && !collapsedNodes.has(nodeId)) {
                onToggleCollapse(nodeId);
                return;
            }
            for (let parentIndex = index - 1; parentIndex >= 0; parentIndex -= 1) {
                if (rows[parentIndex].depth < row.depth) {
                    selectIndex(parentIndex);
                    return;
                }
            }
            return;
        }
        if (event.key === "ArrowRight") {
            event.preventDefault();
            if (row.node.children.length === 0) {
                return;
            }
            if (collapsedNodes.has(nodeId)) {
                onToggleCollapse(nodeId);
                return;
            }
            if (rows[index + 1]?.depth > row.depth) {
                selectIndex(index + 1);
            }
        }
    };

    return (
        <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="shrink-0 overflow-hidden border-r border-border" style={{ width: gutterWidth }}>
                <div ref={gutterContentRef} data-testid="timeline-gutter-content" className="will-change-transform">
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
                                    onNavigate={onNavigate}
                                    registerTreeItem={registerTreeItem}
                                    onToggleCollapse={onToggleCollapse}
                                />
                            );
                        })}
                    </div>
                </div>
            </div>
            <div
                ref={scrollRef}
                data-testid="timeline-scroll"
                className="min-w-0 flex-1 overflow-auto"
                onScroll={onScroll}
            >
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
            </div>
        </div>
    );
}
