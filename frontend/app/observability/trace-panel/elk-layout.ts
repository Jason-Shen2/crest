// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Ported from Langfuse web/src/features/trace-graph-view/layout/elkLayout.ts.

import type { ELK, ElkNode } from "elkjs";

import type { GraphCanvasData, GraphNodeData } from "./graph-types";
import { LangfuseEndNodeName, LangfuseStartNodeName } from "./graph-types";

export type GraphLayout = {
    nodes: Array<{ id: string; x: number; y: number; width: number; height: number }>;
    edges: Array<{
        id: string;
        source: string;
        target: string;
        points: Array<{ x: number; y: number }>;
    }>;
    width: number;
    height: number;
    tooLarge?: boolean;
};

const LayoutOptions: Record<string, string> = {
    "elk.algorithm": "org.eclipse.elk.layered",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.layered.mergeEdges": "true",
    "elk.layered.spacing.nodeNodeBetweenLayers": "52",
    "elk.spacing.nodeNode": "32",
    "elk.spacing.edgeNode": "20",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
    "elk.direction": "RIGHT",
};

function measureNode(node: GraphNodeData): { width: number; height: number } {
    const length = Math.min(28, node.label.length);
    return {
        width: Math.round(Math.min(240, Math.max(96, length * 6.6 + 44))),
        height: 34,
    };
}

function dedupeEdges(edges: GraphCanvasData["edges"]): GraphCanvasData["edges"] {
    const seen = new Set<string>();
    const result: GraphCanvasData["edges"] = [];
    for (const edge of edges) {
        const key = JSON.stringify([edge.from, edge.to]);
        if (edge.from === edge.to || seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(edge);
    }
    return result;
}

let elkInstance: Promise<ELK> | null = null;

function getElk(): Promise<ELK> {
    if (!elkInstance) {
        elkInstance = import("elkjs/lib/elk.bundled.js").then(
            (module) => new (module.default as unknown as { new (): ELK })()
        );
        elkInstance.catch(() => {
            elkInstance = null;
        });
    }
    return elkInstance;
}

export async function computeGraphLayout(graph: GraphCanvasData): Promise<GraphLayout> {
    if (graph.nodes.length === 0) {
        return { nodes: [], edges: [], width: 0, height: 0 };
    }
    const edges = dedupeEdges(graph.edges);
    if (edges.length > 10_000) {
        return { nodes: [], edges: [], width: 0, height: 0, tooLarge: true };
    }
    const elkGraph: ElkNode = {
        id: "root",
        layoutOptions: LayoutOptions,
        children: graph.nodes.map((node) => ({
            id: node.id,
            ...measureNode(node),
            layoutOptions:
                node.id === LangfuseStartNodeName
                    ? { "elk.layered.layering.layerConstraint": "FIRST" }
                    : node.id === LangfuseEndNodeName
                      ? { "elk.layered.layering.layerConstraint": "LAST" }
                      : undefined,
        })),
        edges: edges.map((edge, index) => ({
            id: `edge-${index}`,
            sources: [edge.from],
            targets: [edge.to],
        })),
    };
    const elk = await getElk();
    const result = await elk.layout(elkGraph);
    return {
        nodes: (result.children ?? []).map((node) => ({
            id: node.id,
            x: node.x ?? 0,
            y: node.y ?? 0,
            width: node.width ?? 0,
            height: node.height ?? 0,
        })),
        edges: (result.edges ?? []).flatMap((edge) => {
            const section = edge.sections?.[0];
            if (!section) {
                return [];
            }
            return [
                {
                    id: edge.id,
                    source: edge.sources?.[0] ?? "",
                    target: edge.targets?.[0] ?? "",
                    points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
                },
            ];
        }),
        width: result.width ?? 0,
        height: result.height ?? 0,
    };
}
