// @vitest-environment jsdom

import type { VirtualItem } from "@tanstack/react-virtual";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useMemo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TimelineBar } from "./timeline-bar";
import { flattenTimelineRows } from "./timeline-flattening";
import { TimelineRows } from "./timeline-rows";
import { TimelineScale } from "./timeline-scale";
import type { TimelineTraceNode } from "./timeline-types";
import { TraceDataProvider, TraceSelectionProvider } from "./trace-context";
import { TraceTimeline } from "./trace-timeline";
import type { TraceNode } from "./types";

vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
        const size = estimateSize();
        return {
            getTotalSize: () => count * size,
            getVirtualItems: () =>
                Array.from({ length: count }, (_, index) => ({
                    index,
                    key: index,
                    start: index * size,
                    end: (index + 1) * size,
                    size,
                    lane: 0,
                })),
        };
    },
}));

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

function TimelineRowsHarness({
    onSelect = vi.fn(),
    showGutter = true,
}: {
    onSelect?: (nodeId: string) => void;
    showGutter?: boolean;
} = {}) {
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
            showGutter={showGutter}
        />
    );
}

function TimelineKeyboardHarness({ showGutter = true }: { showGutter?: boolean } = {}) {
    const roots = useMemo(() => {
        const generation = makeNode(
            "generation",
            "GENERATION",
            "2026-07-20T08:00:01.000Z",
            "2026-07-20T08:00:02.000Z",
            { parentObservationId: "turn" }
        );
        const tool = makeNode("tool", "TOOL", "2026-07-20T08:00:02.000Z", "2026-07-20T08:00:03.000Z", {
            parentObservationId: "turn",
        });
        const turn = makeNode("turn", "SPAN", "2026-07-20T08:00:00.500Z", "2026-07-20T08:00:03.500Z", {
            parentObservationId: "agent",
            children: [generation, tool],
        });
        return [
            makeNode("agent", "TRACE", "2026-07-20T08:00:00.000Z", "2026-07-20T08:00:04.000Z", {
                children: [turn],
            }),
        ];
    }, []);
    const [selectedNodeId, setSelectedNodeId] = useState("generation");
    const [collapsedNodes, setCollapsedNodes] = useState(new Set<string>());
    const rows = flattenTimelineRows(roots, collapsedNodes, new Date("2026-07-20T08:00:00.000Z"), 4);

    return (
        <TimelineRows
            rows={rows}
            virtualItems={rows.map((_, index) => makeVirtualItem(index))}
            totalSize={rows.length * 26}
            observationMap={new Map()}
            selectedNodeId={selectedNodeId}
            hoveredNodeId={null}
            collapsedNodes={collapsedNodes}
            onSelect={setSelectedNodeId}
            onHover={vi.fn()}
            onToggleCollapse={(nodeId) => {
                setCollapsedNodes((current) => {
                    const next = new Set(current);
                    if (next.has(nodeId)) {
                        next.delete(nodeId);
                    } else {
                        next.add(nodeId);
                    }
                    return next;
                });
            }}
            showGutter={showGutter}
        />
    );
}

function TraceTimelineHarness({ showGutter = true }: { showGutter?: boolean } = {}) {
    const detail: TraceDetail = {
        trace: {
            id: "trace-1",
            name: "agent",
            timestamp: "2026-07-20T08:00:00.000Z",
            endedAt: "2026-07-20T08:00:04.000Z",
            environment: "test",
            tags: [],
            release: null,
            version: null,
            input: null,
            output: null,
            metadata: {},
            sessionId: "session-1",
            userId: null,
            status: "success",
        },
        observations: [
            makeObservation("turn", {
                type: "SPAN",
                name: "turn",
                startTime: "2026-07-20T08:00:00.500Z",
                endTime: "2026-07-20T08:00:03.500Z",
            }),
            makeObservation("generation", {
                name: "generation",
                parentObservationId: "turn",
            }),
        ],
        scores: [],
        corrections: [],
    };

    return (
        <TraceDataProvider detail={detail}>
            <TraceSelectionProvider traceId={detail.trace.id}>
                <TraceTimeline showGutter={showGutter} />
            </TraceSelectionProvider>
        </TraceDataProvider>
    );
}

describe("trace timeline workspace", () => {
    it("uses the chart as the only scroll source and synchronizes gutter and scale", () => {
        render(<TraceTimelineHarness />);
        const chart = screen.getByTestId("timeline-scroll");

        expect(screen.getAllByTestId("timeline-scroll")).toHaveLength(1);
        fireEvent.scroll(chart, { target: { scrollTop: 78, scrollLeft: 240 } });

        expect(screen.getByTestId("timeline-gutter-content").style.transform).toBe("translateY(-78px)");
        expect(screen.getByTestId("timeline-scale-content").style.transform).toBe("translateX(-240px)");
    });

    it("flattens rows again when a timeline parent is collapsed", () => {
        render(<TraceTimelineHarness />);

        expect(screen.getAllByTestId("timeline-gutter-row")).toHaveLength(3);
        fireEvent.click(screen.getByRole("button", { name: "Collapse turn" }));
        expect(screen.getAllByTestId("timeline-gutter-row")).toHaveLength(2);
    });

    it("uses the full workspace for the chart when the gutter is hidden", () => {
        render(<TraceTimelineHarness showGutter={false} />);

        expect(screen.queryByText(/^Name$/i)).toBeNull();
        expect(screen.queryByTestId("timeline-gutter-content")).toBeNull();
        expect(screen.getByTestId("timeline-scroll").parentElement?.children).toHaveLength(1);
    });
});

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

    it("supports the complete ARIA tree keyboard flow and moves focus with selection", () => {
        render(<TimelineKeyboardHarness />);

        const selectedItem = () =>
            screen.getAllByRole("treeitem").find((item) => item.getAttribute("aria-selected") === "true")!;
        const expectSelectedAndFocused = (name: string) => {
            const item = screen.getByRole("treeitem", { name });
            expect(selectedItem()).toBe(item);
            expect(document.activeElement).toBe(item);
        };

        screen.getByRole("treeitem", { name: "generation" }).focus();

        fireEvent.keyDown(selectedItem(), { key: "ArrowDown" });
        expectSelectedAndFocused("tool");

        fireEvent.keyDown(selectedItem(), { key: "ArrowUp" });
        expectSelectedAndFocused("generation");

        fireEvent.keyDown(selectedItem(), { key: "Home" });
        expectSelectedAndFocused("agent");

        fireEvent.keyDown(selectedItem(), { key: "End" });
        expectSelectedAndFocused("tool");

        fireEvent.keyDown(selectedItem(), { key: "ArrowLeft" });
        expectSelectedAndFocused("turn");

        fireEvent.keyDown(selectedItem(), { key: "ArrowLeft" });
        expect(screen.getByRole("treeitem", { name: "turn" }).getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByRole("treeitem", { name: "generation" })).toBeNull();
        expectSelectedAndFocused("turn");

        fireEvent.keyDown(selectedItem(), { key: "ArrowRight" });
        expect(screen.getByRole("treeitem", { name: "turn" }).getAttribute("aria-expanded")).toBe("true");
        expectSelectedAndFocused("turn");

        fireEvent.keyDown(selectedItem(), { key: "ArrowRight" });
        expectSelectedAndFocused("generation");
    });

    it("moves the accessible tree interaction to chart rows when the gutter is hidden", () => {
        render(<TimelineKeyboardHarness showGutter={false} />);

        expect(screen.queryByTestId("timeline-gutter-row")).toBeNull();
        const tree = screen.getByRole("tree", { name: "Trace timeline rows" });
        const generation = screen.getByRole("treeitem", { name: "generation" });
        expect(tree.contains(generation)).toBe(true);
        expect(generation.getAttribute("aria-selected")).toBe("true");

        generation.focus();
        fireEvent.keyDown(generation, { key: "ArrowDown" });
        const tool = screen.getByRole("treeitem", { name: "tool" });
        expect(tool.getAttribute("aria-selected")).toBe("true");
        expect(document.activeElement).toBe(tool);

        fireEvent.keyDown(tool, { key: "ArrowLeft" });
        expect(screen.getByRole("treeitem", { name: "turn" }).getAttribute("aria-selected")).toBe("true");
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
