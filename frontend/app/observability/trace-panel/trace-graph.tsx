// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceGraphView and trace-graph-view.

import { useMemo } from "react";

import { buildExpandedGraph } from "./build-expanded-graph";
import { ElkGraphRenderer } from "./elk-graph-renderer";
import type { GraphObservation } from "./graph-types";
import { useTraceData, useTraceSelection } from "./trace-context";

function graphTopology(observations: Observation[]): GraphObservation[] {
    return observations
        .filter((observation) => observation.type !== "EVENT")
        .map((observation) => ({
            id: observation.id,
            parentObservationId: observation.parentObservationId,
            name: observation.name ?? observation.type,
            startTime: observation.startTime,
            endTime: observation.endTime ?? undefined,
            observationType: observation.type,
        }));
}

export function TraceGraph() {
    const { detail } = useTraceData();
    const { selectedNodeId, setSelectedNodeId } = useTraceSelection();
    const topologyKey = JSON.stringify(graphTopology(detail.observations));
    const graph = useMemo(() => buildExpandedGraph(JSON.parse(topologyKey) as GraphObservation[]), [topologyKey]);

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
