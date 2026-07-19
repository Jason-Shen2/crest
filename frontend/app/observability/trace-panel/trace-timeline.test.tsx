// @vitest-environment jsdom

import type { VirtualItem } from "@tanstack/react-virtual";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TimelineBar } from "./timeline-bar";
import { TimelineRows } from "./timeline-rows";
import { TimelineScale } from "./timeline-scale";
import type { TimelineTraceNode } from "./timeline-types";
import type { TraceNode } from "./types";

afterEach(cleanup);

function makeNode(
    id: string,
    type: TraceNode["type"],
    startTime: string,
    endTime: string,
    options: Partial<TraceNode> = {}
): TraceNode {
    return {
        id,
        type,
        name: id,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        children: [],
        startTimeSinceTrace: 0,
        startTimeSinceParentStart: null,
        depth: 0,
        childrenDepth: 0,
        ...options,
    };
}

function makeObservation(id: string, overrides: Partial<Observation> = {}): Observation {
    return {
        id,
        traceId: "trace-1",
        type: "GENERATION",
        name: id,
        startTime: "2026-07-20T08:00:01.000Z",
        endTime: "2026-07-20T08:00:03.000Z",
        parentObservationId: null,
        level: "DEFAULT",
        statusMessage: null,
        version: null,
        model: null,
        input: null,
        output: null,
        metadata: {},
        latency: 2,
        timeToFirstToken: null,
        usageDetails: {},
        costDetails: {},
        toolCalls: null,
        toolCallNames: null,
        ...overrides,
    };
}

function makeRow(node: TraceNode, depth: number, startOffset: number, width: number): TimelineTraceNode {
    return {
        node,
        depth,
        treeLines: Array.from({ length: depth }, () => false),
        isLastSibling: true,
        startOffset,
        width,
        duration: Math.max(0, (node.endTime!.getTime() - node.startTime.getTime()) / 1000),
    };
}

function makeVirtualItem(index: number): VirtualItem {
    return {
        index,
        key: index,
        start: index * 26,
        end: (index + 1) * 26,
        size: 26,
        lane: 0,
    };
}

function TimelineRowsHarness({ onSelect = vi.fn() }: { onSelect?: (nodeId: string) => void } = {}) {
    const generation = makeNode(
        "assistant-response",
        "GENERATION",
        "2026-07-20T08:00:01.000Z",
        "2026-07-20T08:00:03.000Z",
        { totalTokens: 2_418, totalCost: 0.012 }
    );
    const rows = [
        makeRow(makeNode("agent-run", "TRACE", "2026-07-20T08:00:00.000Z", "2026-07-20T08:00:04.000Z"), 0, 0, 900),
        makeRow(makeNode("turn-1", "SPAN", "2026-07-20T08:00:00.500Z", "2026-07-20T08:00:03.500Z"), 1, 112.5, 675),
        makeRow(generation, 2, 225, 450),
        makeRow(
            makeNode("read-file", "TOOL", "2026-07-20T08:00:02.000Z", "2026-07-20T08:00:02.500Z", {
                level: "ERROR",
            }),
            2,
            450,
            112.5
        ),
    ];
    const observationMap = new Map([
        [
            generation.id,
            makeObservation(generation.id, {
                model: "claude-sonnet",
                timeToFirstToken: 0.61,
                usageDetails: { totalTokens: 2_418 },
                costDetails: { total: 0.012 },
                metadata: {
                    comment: "comment should not render",
                    score: "score should not render",
                    playhead: "playhead should not render",
                },
            }),
        ],
    ]);

    return (
        <TimelineRows
            rows={rows}
            virtualItems={rows.map((_, index) => makeVirtualItem(index))}
            totalSize={rows.length * 26}
            observationMap={observationMap}
            selectedNodeId={generation.id}
            hoveredNodeId={null}
            collapsedNodes={new Set()}
            onSelect={onSelect}
            onHover={vi.fn()}
            onToggleCollapse={vi.fn()}
        />
    );
}

describe("timeline rows", () => {
    it("renders matching gutter and chart rows with Crest-supported badges", () => {
        render(<TimelineRowsHarness />);

        expect(screen.getAllByTestId("timeline-gutter-row")).toHaveLength(4);
        expect(screen.getAllByTestId("timeline-chart-row")).toHaveLength(4);
        expect(screen.getByText("TTFT 610ms")).toBeTruthy();
        expect(screen.getByText("2,418 tokens")).toBeTruthy();
        expect(screen.queryByText(/comment/i)).toBeNull();
        expect(screen.queryByText(/score/i)).toBeNull();
        expect(screen.queryByText(/playhead/i)).toBeNull();
    });

    it("exposes a focusable tree with keyboard-selectable treeitems", () => {
        const onSelect = vi.fn();
        render(<TimelineRowsHarness onSelect={onSelect} />);

        const tree = screen.getByRole("tree", { name: "Trace timeline rows" });
        const treeItems = screen.getAllByRole("treeitem");
        const selectedItem = treeItems[2];
        expect(tree.contains(selectedItem)).toBe(true);
        expect(selectedItem.getAttribute("aria-selected")).toBe("true");
        expect(selectedItem.tabIndex).toBe(0);

        selectedItem.focus();
        expect(document.activeElement).toBe(selectedItem);
        fireEvent.keyDown(selectedItem, { key: "Enter" });
        fireEvent.keyDown(selectedItem, { key: " " });
        expect(onSelect).toHaveBeenNthCalledWith(1, "assistant-response");
        expect(onSelect).toHaveBeenNthCalledWith(2, "assistant-response");
    });
});

describe("timeline bar", () => {
    it("calculates TTFT against the final minimum bar width", () => {
        const node = makeNode("short-generation", "GENERATION", "2026-07-20T08:00:01.000Z", "2026-07-20T08:00:03.000Z");
        const row = makeRow(node, 0, 0, 0);
        const observation = makeObservation(node.id, { timeToFirstToken: 0.5 });

        render(<TimelineBar row={row} observation={observation} isSelected={false} isHovered={false} />);

        const bar = screen.getByTestId("timeline-bar");
        expect(bar.style.width).toBe("4px");
        expect(screen.getByTestId("timeline-ttft-segment").getAttribute("style")).toContain("width: 1px");
    });
});

describe("timeline scale", () => {
    it("uses the calculated step size across the shared scale width", () => {
        render(<TimelineScale traceDuration={8} />);

        const scale = screen.getByTestId("timeline-scale");
        const ticks = screen.getAllByTestId("timeline-scale-tick");
        expect(scale.style.width).toBe("900px");
        expect(ticks).toHaveLength(9);
        expect(ticks[8].style.left).toBe("900px");
        expect(screen.getByText("8.00s")).toBeTruthy();
    });
});
