// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse web/src/components/trace/lib/tree-building.ts.

import type { FlatTraceNode, TraceNode, TraceSearchListItem } from "./types";

type ProcessingNode = {
    observation: Observation;
    childrenIds: string[];
    pendingChildren: number;
    depth: number;
    treeNode?: TraceNode;
    subtreeMinStartMs?: number;
    subtreeMaxEndMs?: number;
};

function observationCost(observation: Observation): number {
    return (
        observation.costDetails.total ?? Object.values(observation.costDetails).reduce((sum, value) => sum + value, 0)
    );
}

function observationTokens(observation: Observation): number {
    return (
        observation.usageDetails.totalTokens ??
        Object.values(observation.usageDetails).reduce((sum, value) => sum + value, 0)
    );
}

function observationUsageValue(observation: Observation, keys: string[]): number | null {
    for (const key of keys) {
        const value = observation.usageDetails[key];
        if (typeof value === "number") {
            return value;
        }
    }
    return null;
}

export function buildTraceTree(detail: TraceDetail): {
    roots: TraceNode[];
    nodeMap: Map<string, TraceNode>;
    searchItems: TraceSearchListItem[];
} {
    const observations = [...new Map(detail.observations.map((observation) => [observation.id, observation])).values()]
        .map((observation) => ({
            ...observation,
            parentObservationId: detail.observations.some(
                (candidate) => candidate.id === observation.parentObservationId
            )
                ? observation.parentObservationId
                : null,
        }))
        .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
    const registry = new Map<string, ProcessingNode>();
    for (const observation of observations) {
        registry.set(observation.id, {
            observation,
            childrenIds: [],
            pendingChildren: 0,
            depth: 0,
        });
    }
    for (const observation of observations) {
        if (observation.parentObservationId) {
            registry.get(observation.parentObservationId)?.childrenIds.push(observation.id);
        }
    }

    const rootIds: string[] = [];
    const depthQueue: string[] = [];
    for (const [id, node] of registry) {
        node.pendingChildren = node.childrenIds.length;
        if (!node.observation.parentObservationId) {
            rootIds.push(id);
            depthQueue.push(id);
        }
    }
    const visited = new Set(depthQueue);
    for (let index = 0; index < depthQueue.length; index += 1) {
        const current = registry.get(depthQueue[index]);
        if (!current) {
            continue;
        }
        for (const childId of current.childrenIds) {
            if (visited.has(childId)) {
                continue;
            }
            visited.add(childId);
            const child = registry.get(childId);
            if (child) {
                child.depth = current.depth + 1;
                depthQueue.push(childId);
            }
        }
    }

    const nodeMap = new Map<string, TraceNode>();
    const queue = [...registry.entries()].filter(([, node]) => node.pendingChildren === 0).map(([id]) => id);
    for (let index = 0; index < queue.length; index += 1) {
        const id = queue[index];
        const current = registry.get(id);
        if (!current) {
            continue;
        }
        const observation = current.observation;
        const children = current.childrenIds.flatMap((childId) => {
            const child = registry.get(childId)?.treeNode;
            return child ? [child] : [];
        });
        let subtreeMinStartMs = Date.parse(observation.startTime);
        let subtreeMaxEndMs = observation.endTime ? Date.parse(observation.endTime) : Date.parse(observation.startTime);
        for (const childId of current.childrenIds) {
            const child = registry.get(childId);
            if (child?.subtreeMinStartMs != null) {
                subtreeMinStartMs = Math.min(subtreeMinStartMs, child.subtreeMinStartMs);
            }
            if (child?.subtreeMaxEndMs != null) {
                subtreeMaxEndMs = Math.max(subtreeMaxEndMs, child.subtreeMaxEndMs);
            }
        }
        current.subtreeMinStartMs = subtreeMinStartMs;
        current.subtreeMaxEndMs = subtreeMaxEndMs;
        const totalTokens =
            observationTokens(observation) + children.reduce((sum, child) => sum + (child.totalTokens ?? 0), 0);
        const totalCost =
            observationCost(observation) + children.reduce((sum, child) => sum + (child.totalCost ?? 0), 0);
        const node: TraceNode = {
            id,
            type: observation.type,
            name: observation.name ?? observation.type,
            startTime: new Date(observation.startTime),
            endTime: observation.endTime ? new Date(observation.endTime) : null,
            level: observation.level,
            children,
            inputUsage: observationUsageValue(observation, ["input", "inputTokens", "promptTokens"]),
            outputUsage: observationUsageValue(observation, ["output", "outputTokens", "completionTokens"]),
            totalUsage: totalTokens || null,
            calculatedTotalCost: observationCost(observation) || null,
            parentObservationId: observation.parentObservationId,
            traceId: observation.traceId,
            totalCost: totalCost || undefined,
            totalTokens,
            subtreeWallClockDurationMs: subtreeMaxEndMs - subtreeMinStartMs,
            startTimeSinceTrace: Date.parse(observation.startTime) - Date.parse(detail.trace.timestamp),
            startTimeSinceParentStart: observation.parentObservationId
                ? Date.parse(observation.startTime) -
                  Date.parse(
                      registry.get(observation.parentObservationId)?.observation.startTime ?? observation.startTime
                  )
                : null,
            depth: current.depth,
            childrenDepth: children.length > 0 ? Math.max(...children.map((child) => child.childrenDepth)) + 1 : 0,
        };
        current.treeNode = node;
        nodeMap.set(id, node);
        if (observation.parentObservationId) {
            const parent = registry.get(observation.parentObservationId);
            if (parent) {
                parent.pendingChildren -= 1;
                if (parent.pendingChildren === 0) {
                    queue.push(observation.parentObservationId);
                }
            }
        }
    }

    const observationRoots = rootIds.flatMap((id) => {
        const node = registry.get(id)?.treeNode;
        return node ? [node] : [];
    });
    const traceEnd = detail.trace.endedAt ? new Date(detail.trace.endedAt) : null;
    const traceTotalCost = observationRoots.reduce((sum, child) => sum + (child.totalCost ?? 0), 0);
    const traceTotalTokens = observationRoots.reduce((sum, child) => sum + (child.totalTokens ?? 0), 0);
    const traceRoot: TraceNode = {
        id: `trace-${detail.trace.id}`,
        type: "TRACE",
        name: detail.trace.name ?? "Trace",
        startTime: new Date(detail.trace.timestamp),
        endTime: traceEnd,
        children: observationRoots,
        totalCost: traceTotalCost || undefined,
        totalTokens: traceTotalTokens,
        latency: traceEnd ? (traceEnd.getTime() - Date.parse(detail.trace.timestamp)) / 1000 : null,
        startTimeSinceTrace: 0,
        startTimeSinceParentStart: null,
        depth: -1,
        childrenDepth:
            observationRoots.length > 0 ? Math.max(...observationRoots.map((child) => child.childrenDepth)) + 1 : 0,
    };
    nodeMap.set(traceRoot.id, traceRoot);
    const roots = [traceRoot];
    const parentTotalCost = traceRoot.totalCost;
    const parentTotalDuration = traceRoot.latency != null ? traceRoot.latency * 1000 : undefined;
    const searchItems: TraceSearchListItem[] = [];
    const stack = [...roots].reverse();
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) {
            continue;
        }
        searchItems.push({
            node,
            parentTotalCost,
            parentTotalDuration,
            observationId: node.type === "TRACE" ? undefined : node.id,
        });
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
            stack.push(node.children[index]);
        }
    }
    return { roots, nodeMap, searchItems };
}

export function flattenTraceTree(roots: TraceNode[], collapsedNodes: Set<string>): FlatTraceNode[] {
    const flattened: FlatTraceNode[] = [];
    const stack = [...roots].reverse().map((node, index) => ({
        node,
        depth: 0,
        treeLines: [] as boolean[],
        isLastSibling: index === 0,
    }));
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }
        flattened.push(current);
        if (collapsedNodes.has(current.node.id)) {
            continue;
        }
        const children = [...current.node.children].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
        for (let index = children.length - 1; index >= 0; index -= 1) {
            const isLastSibling = index === children.length - 1;
            stack.push({
                node: children[index],
                depth: current.depth + 1,
                treeLines: [...current.treeLines, !isLastSibling],
                isLastSibling,
            });
        }
    }
    return flattened;
}
