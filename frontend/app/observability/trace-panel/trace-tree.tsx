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
import { resolveTraceSelectionNodeId, useTraceData, useTraceSelection } from "./trace-context";
import type { TraceNode } from "./types";
import { VirtualizedTree } from "./virtualized-tree";
import { type TreeNodeMetadata, VirtualizedTreeNodeWrapper } from "./virtualized-tree-node-wrapper";

const TraceTreeRow = memo(function TraceTreeRow({
    node,
    treeMetadata,
    isSelected,
    isTabStop,
    isCollapsed,
    onToggleCollapse,
    onSelect,
    onNavigate,
    itemRef,
    rootTotalCost,
    rootTotalDuration,
}: {
    node: TraceNode;
    treeMetadata: TreeNodeMetadata;
    isSelected: boolean;
    isTabStop: boolean;
    isCollapsed: boolean;
    onToggleCollapse: () => void;
    onSelect: () => void;
    onNavigate: React.ComponentProps<typeof VirtualizedTreeNodeWrapper>["onNavigate"];
    itemRef: React.ComponentProps<typeof VirtualizedTreeNodeWrapper>["itemRef"];
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
                isTabStop={isTabStop}
                onSelect={onSelect}
                onNavigate={onNavigate}
                itemRef={itemRef}
            >
                <SpanContent
                    node={node}
                    parentTotalCost={rootTotalCost}
                    parentTotalDuration={rootTotalDuration}
                    onSelect={onSelect}
                    tabIndex={-1}
                />
            </VirtualizedTreeNodeWrapper>
        </div>
    );
});

TraceTreeRow.displayName = "TraceTreeRow";

export function TraceTree() {
    const { roots, nodeMap } = useTraceData();
    const { selectedNodeId, setSelectedNodeId, collapsedNodes, toggleCollapsed } = useTraceSelection();
    const displayedSelectedNodeId = resolveTraceSelectionNodeId(roots, selectedNodeId);
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
            selectedNodeId={displayedSelectedNodeId}
            onToggleCollapse={toggleCollapsed}
            onSelectNode={(id) => setSelectedNodeId(id != null && nodeMap.get(id)?.type !== "TRACE" ? id : null)}
            renderNode={({
                node,
                treeMetadata,
                isSelected,
                isTabStop,
                isCollapsed,
                onToggleCollapse,
                onSelect,
                onNavigate,
                itemRef,
            }) => (
                <TraceTreeRow
                    node={node}
                    treeMetadata={treeMetadata}
                    isSelected={isSelected}
                    isTabStop={isTabStop}
                    isCollapsed={isCollapsed}
                    onToggleCollapse={onToggleCollapse}
                    onSelect={onSelect}
                    onNavigate={onNavigate}
                    itemRef={itemRef}
                    rootTotalCost={rootTotalCost}
                    rootTotalDuration={rootTotalDuration}
                />
            )}
        />
    );
}
