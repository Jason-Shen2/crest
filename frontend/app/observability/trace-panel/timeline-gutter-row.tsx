// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceTimeline/TimelineGutterRow.tsx.

import { ChevronRight } from "lucide-react";
import type { KeyboardEvent, Ref } from "react";

import { cn } from "@/util/util";
import { ItemBadge } from "./item-badge";
import type { TimelineTraceNode } from "./timeline-types";

export function TimelineGutterRow({
    row,
    isSelected,
    isCollapsed,
    onSelect,
    onToggleCollapse,
    onNavigate,
    itemRef,
}: {
    row: TimelineTraceNode;
    isSelected: boolean;
    isCollapsed: boolean;
    onSelect: (nodeId: string) => void;
    onToggleCollapse: (nodeId: string) => void;
    onNavigate: (event: KeyboardEvent<HTMLDivElement>, nodeId: string) => void;
    itemRef: Ref<HTMLDivElement>;
}) {
    const { node, depth, treeLines, isLastSibling } = row;
    const hasChildren = node.children.length > 0;

    return (
        <div
            ref={itemRef}
            data-testid="timeline-gutter-row"
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={isSelected}
            aria-expanded={hasChildren ? !isCollapsed : undefined}
            tabIndex={isSelected ? 0 : -1}
            className={cn(
                "relative flex h-full w-full cursor-pointer items-center",
                isSelected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-fg-overlay-1/50"
            )}
            onClick={() => onSelect(node.id)}
            onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                    onNavigate(event, node.id);
                    return;
                }
                event.preventDefault();
                onSelect(node.id);
            }}
        >
            <div className="flex min-w-0 flex-1 items-center pl-2">
                {depth > 0 ? (
                    <div className="flex shrink-0">
                        {Array.from({ length: Math.max(0, depth - 1) }, (_, index) => (
                            <div key={index} className="relative w-5">
                                {treeLines[index] ? (
                                    <div className="absolute top-0 bottom-0 left-3 w-px bg-border" />
                                ) : null}
                            </div>
                        ))}
                        <div className="relative w-5 shrink-0">
                            <div
                                className={cn(
                                    "absolute top-0 left-3 w-px bg-border",
                                    isLastSibling ? "h-1/2" : "bottom-0"
                                )}
                            />
                            <div className="absolute top-1/2 left-3 h-px w-2 bg-border" />
                        </div>
                    </div>
                ) : null}
                <div className="relative flex w-6 shrink-0 items-center justify-center">
                    <ItemBadge type={node.type} isSmall className="size-3" />
                    {hasChildren && !isCollapsed ? (
                        <div className="absolute top-1/2 bottom-[-13px] left-1/2 w-px bg-border" />
                    ) : null}
                </div>
                <span className="min-w-0 flex-1 truncate py-1.5 pr-2 text-xs" title={node.name}>
                    {node.name || `Unnamed ${node.type.toLowerCase()}`}
                </span>
            </div>
            {hasChildren ? (
                <button
                    type="button"
                    aria-label={isCollapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}
                    aria-expanded={!isCollapsed}
                    tabIndex={-1}
                    className="mr-1 h-6 w-6 shrink-0 cursor-pointer rounded hover:bg-accent/10"
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleCollapse(node.id);
                    }}
                >
                    <ChevronRight
                        className={cn(
                            "h-4 w-4 transition-transform duration-200",
                            isCollapsed ? "rotate-0" : "rotate-90"
                        )}
                    />
                </button>
            ) : null}
        </div>
    );
}
