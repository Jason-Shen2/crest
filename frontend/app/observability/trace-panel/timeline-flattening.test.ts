// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceTimeline/timeline-flattening.ts.

import { describe, expect, it } from "vitest";

import { flattenTimelineRows } from "./timeline-flattening";
import { flattenTraceTree } from "./tree-building";
import type { TraceNode } from "./types";

function makeNode(
    id: string,
    startTime: string,
    options: {
        children?: TraceNode[];
        endTime?: string | null;
    } = {}
): TraceNode {
    const { children = [], endTime = null } = options;
    return {
        id,
        type: "SPAN",
        name: id,
        startTime: new Date(startTime),
        endTime: endTime == null ? null : new Date(endTime),
        children,
        startTimeSinceTrace: 0,
        startTimeSinceParentStart: null,
        depth: 0,
        childrenDepth: 0,
    };
}

describe("timeline flattening", () => {
    it("uses the trace tree hierarchy and collapse metadata", () => {
        const origin = new Date("2026-07-20T08:00:00Z");
        const turn1 = makeNode("turn-1", "2026-07-20T08:00:01Z", {
            children: [makeNode("generation-1", "2026-07-20T08:00:02Z"), makeNode("tool-1", "2026-07-20T08:00:03Z")],
        });
        const turn2 = makeNode("turn-2", "2026-07-20T08:00:04Z", {
            children: [makeNode("generation-2", "2026-07-20T08:00:05Z")],
        });
        const agentNode = makeNode("agent", "2026-07-20T08:00:00Z", {
            children: [turn2, turn1],
        });
        const collapsedNodes = new Set(["turn-2"]);

        const treeRows = flattenTraceTree([agentNode], collapsedNodes);
        const timelineRows = flattenTimelineRows([agentNode], collapsedNodes, origin, 10);

        expect(
            timelineRows.map(({ node, depth, treeLines, isLastSibling }) => ({
                id: node.id,
                depth,
                treeLines,
                isLastSibling,
            }))
        ).toEqual(
            treeRows.map(({ node, depth, treeLines, isLastSibling }) => ({
                id: node.id,
                depth,
                treeLines,
                isLastSibling,
            }))
        );
        expect(timelineRows.map((row) => [row.node.id, row.depth])).toEqual([
            ["agent", 0],
            ["turn-1", 1],
            ["generation-1", 2],
            ["tool-1", 2],
            ["turn-2", 1],
        ]);
    });

    it("keeps invalid-time nodes in the gutter with zero geometry", () => {
        const origin = new Date("2026-07-20T08:00:00Z");
        const invalidNode = makeNode("invalid", "not-a-date", {
            endTime: "also-not-a-date",
        });

        const [row] = flattenTimelineRows([invalidNode], new Set(), origin, 10);

        expect(row.node).toBe(invalidNode);
        expect(row).toMatchObject({
            duration: 0,
            startOffset: 0,
            width: 0,
        });
    });
});
