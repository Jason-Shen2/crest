// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Source: https://github.com/langfuse/langfuse/blob/1cb1bbcf6b269fd887a6667796f1a15417cca336/web/src/components/trace/components/_shared/VirtualizedTreeNodeWrapper.tsx

/**
 * TreeNodeWrapper - Generic tree structure renderer.
 *
 * Responsibilities:
 * - Render tree visual structure (indents, connector lines)
 * - Render collapse/expand button
 * - Handle selection state and click events
 */

import { ChevronRight } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type Ref } from "react";

import { cn } from "@/util/util";
import { ItemBadge } from "./item-badge";
import type { TraceNode } from "./types";

export interface TreeNodeMetadata {
    depth: number;
    treeLines: boolean[];
    isLastSibling: boolean;
    maxVisualDepth?: number;
}

interface TreeNodeWrapperProps {
    metadata: TreeNodeMetadata;
    nodeType: TraceNode["type"];
    hasChildren: boolean;
    isCollapsed: boolean;
    onToggleCollapse: () => void;
    isSelected: boolean;
    isTabStop: boolean;
    onSelect: () => void;
    onNavigate: (event: KeyboardEvent<HTMLDivElement>) => void;
    itemRef: Ref<HTMLDivElement>;
    children: ReactNode;
    className?: string;
}

export function VirtualizedTreeNodeWrapper({
    metadata,
    nodeType,
    hasChildren,
    isCollapsed,
    onToggleCollapse,
    isSelected,
    isTabStop,
    onSelect,
    onNavigate,
    itemRef,
    children,
    className,
}: TreeNodeWrapperProps) {
    const { depth, treeLines, isLastSibling } = metadata;
    const maxVisualDepth = metadata.maxVisualDepth ?? Infinity;
    const visualDepth = Math.min(depth, maxVisualDepth);
    const childrenAreCapped = depth >= maxVisualDepth;

    return (
        <div
            ref={itemRef}
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={isSelected}
            aria-expanded={hasChildren ? !isCollapsed : undefined}
            tabIndex={isTabStop ? 0 : -1}
            className={cn(
                "relative flex w-full cursor-pointer px-0",
                isSelected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-fg-overlay-1/50",
                className
            )}
            onClick={(event) => {
                if (!event.currentTarget.closest("[data-expand-button]")) {
                    onSelect();
                }
            }}
            onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                    onNavigate(event);
                    return;
                }
                event.preventDefault();
                onSelect();
            }}
        >
            <div className="flex w-full pl-2">
                {visualDepth > 0 && (
                    <div className="flex shrink-0">
                        {Array.from({ length: Math.max(0, visualDepth - 1) }, (_, index) => (
                            <div key={index} className="relative w-5">
                                {treeLines[index] && <div className="absolute top-0 bottom-0 left-3 w-px bg-border" />}
                            </div>
                        ))}
                    </div>
                )}

                {visualDepth > 0 && (
                    <div className="relative w-5 shrink-0">
                        <div
                            className={cn("absolute top-0 left-3 w-px bg-border", isLastSibling ? "h-3" : "bottom-3")}
                        />
                        {!isLastSibling && <div className="absolute top-3 bottom-0 left-3 w-px bg-border" />}
                        <div className="absolute top-3 left-3 h-px w-2 bg-border" />
                    </div>
                )}

                <div className="relative flex w-6 shrink-0 flex-col py-1.5">
                    <div className="relative z-10 flex h-4 items-center justify-center">
                        <ItemBadge type={nodeType} isSmall className="size-3" />
                    </div>
                    {hasChildren && !isCollapsed && !childrenAreCapped && (
                        <div className="absolute top-3 bottom-0 left-1/2 w-px bg-border" />
                    )}
                    {depth === 0 && hasChildren && !isCollapsed && !childrenAreCapped && (
                        <div className="absolute top-3 bottom-0 left-1/2 w-px bg-border" />
                    )}
                </div>

                <div className="flex min-w-0 flex-1">{children}</div>

                {hasChildren && (
                    <div className="flex items-center justify-end py-1 pr-1">
                        <button
                            type="button"
                            aria-expanded={!isCollapsed}
                            data-expand-button
                            tabIndex={-1}
                            onClick={(event) => {
                                event.stopPropagation();
                                onToggleCollapse();
                            }}
                            className="h-6 w-6 shrink-0 cursor-pointer rounded hover:bg-accent/10"
                        >
                            <span
                                className={cn(
                                    "inline-block h-4 w-4 transform transition-transform duration-200 ease-in-out",
                                    isCollapsed ? "rotate-0" : "rotate-90"
                                )}
                            >
                                <ChevronRight className="h-4 w-4" />
                            </span>
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
