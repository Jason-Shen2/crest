/**
 * TraceTree - Composition of VirtualizedTree + TreeNodeWrapper + SpanContent.
 *
 * Connects three layers:
 * - VirtualizedTree (virtualization)
 * - TreeNodeWrapper (tree structure rendering)
 * - SpanContent (span-specific content)
 */

import { memo } from "react";

import { SpanContent } from "./span-content";
import { useTraceData, useTraceSelection } from "./trace-context";
import type { TraceNode } from "./types";
import { VirtualizedTree } from "./virtualized-tree";
import { type TreeNodeMetadata, VirtualizedTreeNodeWrapper } from "./virtualized-tree-node-wrapper";

const TraceTreeRow = memo(function TraceTreeRow({
    node,
    treeMetadata,
    isSelected,
    isCollapsed,
    onToggleCollapse,
    onSelect,
    rootTotalCost,
    rootTotalDuration,
}: {
    node: TraceNode;
    treeMetadata: TreeNodeMetadata;
    isSelected: boolean;
    isCollapsed: boolean;
    onToggleCollapse: () => void;
    onSelect: () => void;
    rootTotalCost?: number;
    rootTotalDuration?: number;
}) {
    return (
        <div className="transition-colors duration-150">
            <VirtualizedTreeNodeWrapper
                metadata={treeMetadata}
                nodeType={node.type}
                hasChildren={node.children.length > 0}
                isCollapsed={isCollapsed}
                onToggleCollapse={onToggleCollapse}
                isSelected={isSelected}
                onSelect={onSelect}
            >
                <SpanContent
                    node={node}
                    parentTotalCost={rootTotalCost}
                    parentTotalDuration={rootTotalDuration}
                    onSelect={onSelect}
                />
            </VirtualizedTreeNodeWrapper>
        </div>
    );
});

TraceTreeRow.displayName = "TraceTreeRow";

export function TraceTree() {
    const { roots, nodeMap } = useTraceData();
    const { selectedNodeId, setSelectedNodeId, collapsedNodes, toggleCollapsed } = useTraceSelection();
    const rootTotalCost = roots.reduce<number | undefined>((accumulator, root) => {
        if (!root.totalCost) {
            return accumulator;
        }
        return (accumulator ?? 0) + root.totalCost;
    }, undefined);
    const rootTotalDuration =
        roots.length > 0
            ? Math.max(
                  ...roots.map((root) =>
                      root.latency != null
                          ? root.latency * 1000
                          : root.endTime != null
                            ? root.endTime.getTime() - root.startTime.getTime()
                            : 0
                  )
              )
            : undefined;

    return (
        <VirtualizedTree
            roots={roots}
            collapsedNodes={collapsedNodes}
            selectedNodeId={selectedNodeId}
            onToggleCollapse={toggleCollapsed}
            onSelectNode={(id) => setSelectedNodeId(id != null && nodeMap.get(id)?.type !== "TRACE" ? id : null)}
            renderNode={({ node, treeMetadata, isSelected, isCollapsed, onToggleCollapse, onSelect }) => (
                <TraceTreeRow
                    node={node}
                    treeMetadata={treeMetadata}
                    isSelected={isSelected}
                    isCollapsed={isCollapsed}
                    onToggleCollapse={onToggleCollapse}
                    onSelect={onSelect}
                    rootTotalCost={rootTotalCost}
                    rootTotalDuration={rootTotalDuration}
                />
            )}
        />
    );
}
