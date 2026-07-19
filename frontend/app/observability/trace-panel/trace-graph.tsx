// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceGraphView and trace-graph-view.

import { useMemo } from "react";

import { buildExpandedGraph } from "./build-expanded-graph";
import { ElkGraphRenderer } from "./elk-graph-renderer";
import { useTraceData, useTraceSelection } from "./trace-context";

export function TraceGraph() {
    const { detail } = useTraceData();
    const { selectedNodeId, setSelectedNodeId } = useTraceSelection();
    const graph = useMemo(
        () =>
            buildExpandedGraph(
                detail.observations
                    .filter((observation) => observation.type !== "EVENT")
                    .map((observation) => ({
                        id: observation.id,
                        parentObservationId: observation.parentObservationId,
                        name: observation.name ?? observation.type,
                        startTime: observation.startTime,
                        endTime: observation.endTime ?? undefined,
                        observationType: observation.type,
                    }))
            ),
        [detail.observations]
    );

    return (
        <div role="region" aria-label="Trace graph" className="h-full overflow-auto bg-fg-overlay-1/10 p-3">
            {graph.nodes.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    No graph data available
                </div>
            ) : (
                <ElkGraphRenderer graph={graph} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} />
            )}
        </div>
    );
}
