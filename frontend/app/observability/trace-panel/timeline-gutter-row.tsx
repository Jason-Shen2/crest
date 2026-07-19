// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceTimeline/TimelineGutterRow.tsx.

import type { TimelineTraceNode } from "./timeline-types";
import { VirtualizedTreeNodeWrapper } from "./virtualized-tree-node-wrapper";

export function TimelineGutterRow({
    row,
    isSelected,
    isCollapsed,
    onSelect,
    onToggleCollapse,
}: {
    row: TimelineTraceNode;
    isSelected: boolean;
    isCollapsed: boolean;
    onSelect: (nodeId: string) => void;
    onToggleCollapse: (nodeId: string) => void;
}) {
    const { node, depth, treeLines, isLastSibling } = row;

    return (
        <div data-testid="timeline-gutter-row" className="h-full w-full">
            <VirtualizedTreeNodeWrapper
                metadata={{ depth, treeLines, isLastSibling }}
                nodeType={node.type}
                hasChildren={node.children.length > 0}
                isCollapsed={isCollapsed}
                onToggleCollapse={() => onToggleCollapse(node.id)}
                isSelected={isSelected}
                onSelect={() => onSelect(node.id)}
                className="h-full items-center"
            >
                <span className="min-w-0 flex-1 truncate py-1.5 pr-2 text-xs" title={node.name}>
                    {node.name || `Unnamed ${node.type.toLowerCase()}`}
                </span>
            </VirtualizedTreeNodeWrapper>
        </div>
    );
}
