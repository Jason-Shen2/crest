// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Ported from Langfuse web/src/features/trace-graph-view/buildExpandedGraph.ts.

import { type GraphCanvasData, type GraphObservation, LangfuseEndNodeName, LangfuseStartNodeName } from "./graph-types";

type Edge = { from: string; to: string };

const MaxExpandedEdges = 10_000;

function startMs(observation: GraphObservation): number {
    return Date.parse(observation.startTime);
}

function endMs(observation: GraphObservation): number {
    const start = startMs(observation);
    return Math.max(start, observation.endTime ? Date.parse(observation.endTime) : start);
}

function byRunOrder(a: GraphObservation, b: GraphObservation): number {
    return startMs(a) - startMs(b) || endMs(a) - endMs(b) || a.id.localeCompare(b.id);
}

function buildFlowEdges(
    observations: GraphObservation[],
    ancestry: GraphObservation[]
): { edges: Edge[]; sinkIds: Set<string> } | null {
    const included = new Set(observations.map((observation) => observation.id));
    const ancestryById = new Map(ancestry.map((observation) => [observation.id, observation]));
    const resolveParent = (observation: GraphObservation): string | null => {
        const seen = new Set<string>();
        let parentId = observation.parentObservationId;
        while (parentId && !seen.has(parentId)) {
            if (included.has(parentId)) {
                return parentId;
            }
            seen.add(parentId);
            parentId = ancestryById.get(parentId)?.parentObservationId ?? null;
        }
        return null;
    };

    const groups = new Map<string | null, GraphObservation[]>();
    for (const observation of observations) {
        const parentId = resolveParent(observation);
        const group = groups.get(parentId);
        if (group) {
            group.push(observation);
        } else {
            groups.set(parentId, [observation]);
        }
    }

    const edges: Edge[] = [];
    const rootSiblingSources = new Set<string>();
    for (const [parentId, group] of groups) {
        const ordered = [...group].sort(byRunOrder);
        const starts = ordered.map(startMs);
        const ends = ordered.map(endMs);
        for (let index = 0; index < ordered.length; index += 1) {
            if (edges.length > MaxExpandedEdges) {
                return null;
            }
            let finishedCount = 0;
            let maxEnd = -Infinity;
            let latestFallback = -1;
            let maxStart = -Infinity;
            let maxStartIndex = -1;
            let secondMaxStart = -Infinity;
            for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
                if (ends[previousIndex] > starts[index]) {
                    continue;
                }
                finishedCount += 1;
                if (ends[previousIndex] >= maxEnd) {
                    maxEnd = ends[previousIndex];
                    latestFallback = previousIndex;
                }
                if (starts[previousIndex] > maxStart) {
                    secondMaxStart = maxStart;
                    maxStart = starts[previousIndex];
                    maxStartIndex = previousIndex;
                } else if (starts[previousIndex] > secondMaxStart) {
                    secondMaxStart = starts[previousIndex];
                }
            }
            if (finishedCount === 0) {
                if (parentId != null) {
                    edges.push({ from: parentId, to: ordered[index].id });
                }
                continue;
            }
            let emitted = false;
            for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
                if (ends[previousIndex] > starts[index]) {
                    continue;
                }
                const otherMaxStart = previousIndex === maxStartIndex ? secondMaxStart : maxStart;
                if (ends[previousIndex] > otherMaxStart) {
                    edges.push({ from: ordered[previousIndex].id, to: ordered[index].id });
                    if (parentId == null) {
                        rootSiblingSources.add(ordered[previousIndex].id);
                    }
                    emitted = true;
                }
            }
            if (!emitted) {
                edges.push({ from: ordered[latestFallback].id, to: ordered[index].id });
                if (parentId == null) {
                    rootSiblingSources.add(ordered[latestFallback].id);
                }
            }
        }
    }
    return {
        edges,
        sinkIds: new Set(
            (groups.get(null) ?? [])
                .filter((observation) => !rootSiblingSources.has(observation.id))
                .map((observation) => observation.id)
        ),
    };
}

export function buildExpandedGraph(data: GraphObservation[]): GraphCanvasData {
    const observations = [...new Map(data.map((observation) => [observation.id, observation])).values()].sort(
        byRunOrder
    );
    if (observations.length === 0) {
        return { nodes: [], edges: [] };
    }
    const built = buildFlowEdges(observations, data);
    if (!built) {
        return { nodes: [], edges: [] };
    }
    const nodes = observations.map((observation) => ({
        id: observation.id,
        label: observation.name,
        type: observation.observationType,
    }));
    const hasIncoming = new Set(built.edges.map((edge) => edge.to));
    const sources = observations.filter((observation) => !hasIncoming.has(observation.id));
    const sinks = observations.filter((observation) => built.sinkIds.has(observation.id));
    nodes.unshift({ id: LangfuseStartNodeName, label: LangfuseStartNodeName, type: "SYSTEM" });
    nodes.push({ id: LangfuseEndNodeName, label: LangfuseEndNodeName, type: "SYSTEM" });
    for (const source of sources) {
        built.edges.push({ from: LangfuseStartNodeName, to: source.id });
    }
    for (const sink of sinks) {
        built.edges.push({ from: sink.id, to: LangfuseEndNodeName });
    }
    return { nodes, edges: built.edges };
}
