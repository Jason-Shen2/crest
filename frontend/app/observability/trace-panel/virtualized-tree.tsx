// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Source: https://github.com/langfuse/langfuse/blob/1cb1bbcf6b269fd887a6667796f1a15417cca336/web/src/components/trace/components/_shared/VirtualizedTree.tsx

/**
 * Generic virtualized tree component using @tanstack/react-virtual.
 *
 * Renders large trees efficiently with dynamic row heights.
 * Uses render prop pattern for node customization.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import {
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
    type Ref,
} from "react";

import { cn } from "@/util/util";
import { getTreeNavigationAction } from "./roving-navigation";
import { flattenTree } from "./tree-flattening";
import type { TreeNodeMetadata } from "./virtualized-tree-node-wrapper";
import { computeMaxVisualDepth, TreeVisualDepth } from "./visual-depth";

interface VirtualizedTreeProps<T extends { id: string; children: T[] }> {
    roots: T[];
    collapsedNodes: Set<string>;
    selectedNodeId: string | null;
    renderNode: (params: {
        node: T;
        treeMetadata: TreeNodeMetadata;
        isSelected: boolean;
        isTabStop: boolean;
        isCollapsed: boolean;
        onToggleCollapse: () => void;
        onSelect: () => void;
        onNavigate: (event: KeyboardEvent<HTMLDivElement>) => void;
        itemRef: Ref<HTMLDivElement>;
    }) => ReactNode;
    onToggleCollapse: (nodeId: string) => void;
    onSelectNode: (nodeId: string | null) => void;
    estimateSize?: (node: T, index: number) => number;
    overscan?: number;
    defaultRowHeight?: number;
    className?: string;
}

export function VirtualizedTree<T extends { id: string; children: T[] }>({
    roots,
    collapsedNodes,
    selectedNodeId,
    renderNode,
    onToggleCollapse,
    onSelectNode,
    estimateSize,
    overscan = 16,
    defaultRowHeight = 37,
    className,
}: VirtualizedTreeProps<T>) {
    const parentRef = useRef<HTMLDivElement>(null);
    const treeItemsRef = useRef(new Map<string, HTMLDivElement>());
    const [maxVisualDepth, setMaxVisualDepth] = useState(TreeVisualDepth.maxDepth);

    useLayoutEffect(() => {
        const element = parentRef.current;
        if (!element || typeof ResizeObserver === "undefined") {
            return;
        }
        const measure = () => {
            setMaxVisualDepth(computeMaxVisualDepth(element.clientWidth, TreeVisualDepth));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const flattenedItems = useMemo(() => flattenTree(roots, collapsedNodes), [roots, collapsedNodes]);
    const rowVirtualizer = useVirtualizer({
        count: flattenedItems.length,
        getScrollElement: () => parentRef.current,
        initialRect: { width: 800, height: 600 },
        estimateSize: estimateSize
            ? (index) => estimateSize(flattenedItems[index].node, index)
            : () => defaultRowHeight,
        getItemKey: (index) => flattenedItems[index].node.id,
        overscan,
        measureElement: typeof window !== "undefined" ? (element) => element.getBoundingClientRect().height : undefined,
    });
    const prevSelectedIdRef = useRef<string | null | undefined>(undefined);

    useLayoutEffect(() => {
        if (!selectedNodeId || selectedNodeId === prevSelectedIdRef.current) {
            prevSelectedIdRef.current = selectedNodeId;
            return;
        }

        const index = flattenedItems.findIndex((item) => item.node.id === selectedNodeId);
        if (index === -1) {
            return;
        }

        const isInitial = prevSelectedIdRef.current === undefined;
        prevSelectedIdRef.current = selectedNodeId;
        rowVirtualizer.scrollToIndex(index, {
            align: isInitial ? "center" : "auto",
            behavior: isInitial ? "auto" : "smooth",
        });
    }, [selectedNodeId, flattenedItems, rowVirtualizer]);
    const virtualItems = rowVirtualizer.getVirtualItems();
    const renderedItems =
        virtualItems.length > 0
            ? virtualItems
            : flattenedItems.slice(0, Math.min(flattenedItems.length, 32)).map((_, index) => ({
                  index,
                  key: flattenedItems[index].node.id,
                  start: index * defaultRowHeight,
              }));
    const selectedNodeIsVisible =
        selectedNodeId != null && flattenedItems.some((item) => item.node.id === selectedNodeId);
    const focusNodeId = selectedNodeIsVisible
        ? selectedNodeId
        : flattenedItems.length > 0
          ? flattenedItems[0].node.id
          : null;
    const focusVirtualItemKey =
        focusNodeId == null
            ? null
            : (renderedItems.find((item) => flattenedItems[item.index]?.node.id === focusNodeId)?.key ?? null);

    useEffect(() => {
        if (focusNodeId != null && focusVirtualItemKey != null) {
            treeItemsRef.current.get(focusNodeId)?.focus();
        }
    }, [focusNodeId, focusVirtualItemKey]);

    const registerTreeItem = (nodeId: string, element: HTMLDivElement | null) => {
        if (element == null) {
            treeItemsRef.current.delete(nodeId);
            return;
        }
        treeItemsRef.current.set(nodeId, element);
    };

    const onNavigate = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft", "ArrowRight"].includes(event.key)) {
            return;
        }
        event.preventDefault();
        const action = getTreeNavigationAction(
            event.key,
            index,
            flattenedItems.map((item) => ({
                id: item.node.id,
                depth: item.depth,
                children: item.node.children,
            })),
            collapsedNodes
        );
        if (action?.type === "toggle") {
            onToggleCollapse(action.id);
        } else if (action?.type === "select") {
            onSelectNode(flattenedItems[action.index].node.id);
        }
    };

    return (
        <div ref={parentRef} role="tree" aria-label="Trace tree" className={cn("h-full overflow-y-auto", className)}>
            <div
                style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                }}
            >
                {renderedItems.map((virtualRow) => {
                    const item = flattenedItems[virtualRow.index];
                    const isSelected = item.node.id === selectedNodeId;
                    const isCollapsed = collapsedNodes.has(item.node.id);

                    return (
                        <div
                            key={item.node.id}
                            data-index={virtualRow.index}
                            ref={rowVirtualizer.measureElement}
                            style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                transform: `translateY(${virtualRow.start}px)`,
                            }}
                        >
                            {renderNode({
                                node: item.node,
                                treeMetadata: {
                                    depth: item.depth,
                                    treeLines: item.treeLines,
                                    isLastSibling: item.isLastSibling,
                                    maxVisualDepth,
                                },
                                isSelected,
                                isTabStop: item.node.id === focusNodeId,
                                isCollapsed,
                                onToggleCollapse: () => onToggleCollapse(item.node.id),
                                onSelect: () => onSelectNode(item.node.id),
                                onNavigate: (event) => onNavigate(event, virtualRow.index),
                                itemRef: (element) => registerTreeItem(item.node.id, element),
                            })}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
