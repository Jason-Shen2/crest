// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TraceDataProvider, TraceSelectionProvider, useTraceData, useTraceSelection } from "./trace-context";
import { TraceNavigationHeader } from "./trace-navigation-header";
import { TraceSearchList } from "./trace-search-list";
import { TraceTimeline } from "./trace-timeline";
import { TraceTree } from "./trace-tree";

const scrollToIndex = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
        const size = estimateSize();
        return {
            getTotalSize: () => count * size,
            measureElement: vi.fn(),
            scrollToIndex,
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

function makeObservation(id: string, overrides: Partial<Observation> = {}): Observation {
    return {
        id,
        traceId: "trace-1",
        type: "GENERATION",
        name: "assistant response",
        startTime: "2026-07-20T08:00:01.000Z",
        endTime: "2026-07-20T08:00:02.000Z",
        parentObservationId: null,
        level: "DEFAULT",
        statusMessage: null,
        version: null,
        model: "test-model",
        input: null,
        output: null,
        metadata: {},
        latency: null,
        timeToFirstToken: null,
        usageDetails: {},
        costDetails: {},
        toolCalls: null,
        toolCallNames: null,
        ...overrides,
    };
}

function makeDetail(observationIds: string[]): TraceDetail {
    return {
        trace: {
            id: "trace-1",
            name: "Trace",
            timestamp: "2026-07-20T08:00:00.000Z",
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
            endedAt: "2026-07-20T08:00:04.000Z",
        },
        observations: observationIds.map((id) => makeObservation(id)),
        scores: [],
        corrections: [],
    };
}

function makeNestedDetail(): TraceDetail {
    return {
        ...makeDetail([]),
        observations: [
            makeObservation("turn", {
                type: "SPAN",
                name: "result turn",
            }),
            makeObservation("generation", {
                name: "result generation",
                parentObservationId: "turn",
            }),
            makeObservation("tool", {
                type: "TOOL",
                name: "result tool",
                parentObservationId: "turn",
            }),
        ],
    };
}

function makeDetailWithInvalidObservationTime(): TraceDetail {
    return {
        ...makeDetail([]),
        observations: [
            makeObservation("generation-invalid", {
                startTime: "not-a-date",
                endTime: "also-not-a-date",
            }),
        ],
    };
}

function makeDetailWithAllInvalidTimes(): TraceDetail {
    return {
        ...makeDetailWithInvalidObservationTime(),
        trace: {
            ...makeDetail([]).trace,
            timestamp: "not-a-date",
            endedAt: "also-not-a-date",
        },
    };
}

function makeRunningDetailWithInvalidEndTime(): TraceDetail {
    const detail = makeDetail([]);
    return {
        ...detail,
        trace: {
            ...detail.trace,
            status: "running",
            endedAt: undefined,
        },
        observations: [
            makeObservation("generation-running", {
                startTime: "2026-07-20T08:00:01.000Z",
                endTime: "not-a-date",
            }),
        ],
    };
}

function ContextProbe({ detail }: { detail: TraceDetail }) {
    return (
        <TraceDataProvider detail={detail}>
            <TraceSelectionProvider traceId={detail.trace.id}>
                <Probe />
            </TraceSelectionProvider>
        </TraceDataProvider>
    );
}

function Probe() {
    const { selectedNodeId, setSelectedNodeId } = useTraceSelection();
    const { traceStartTime, traceDuration } = useTraceData();
    return (
        <>
            <button type="button" onClick={() => setSelectedNodeId("generation-1")}>
                select generation-1
            </button>
            <span data-testid="selection">{selectedNodeId ?? "trace"}</span>
            <span data-testid="trace-start">{traceStartTime?.toISOString() ?? "none"}</span>
            <span data-testid="trace-duration">{traceDuration}</span>
        </>
    );
}

function ViewHarness({ detail, children }: { detail: TraceDetail; children: React.ReactNode }) {
    return (
        <TraceDataProvider detail={detail}>
            <TraceSelectionProvider traceId={detail.trace.id}>{children}</TraceSelectionProvider>
        </TraceDataProvider>
    );
}

function SearchView() {
    const { setSearchQuery } = useTraceSelection();
    return (
        <>
            <button type="button" onClick={() => setSearchQuery("trace")}>
                search trace
            </button>
            <TraceSearchList />
        </>
    );
}

function SearchKeyboardView() {
    const { setSearchQuery } = useTraceSelection();
    return (
        <>
            <button type="button" onClick={() => setSearchQuery("result")}>
                search results
            </button>
            <TraceSearchList />
        </>
    );
}

function SearchHeaderView() {
    return (
        <>
            <TraceNavigationHeader />
            <TraceSearchList />
        </>
    );
}

describe("trace context", () => {
    it("uses null for trace selection and clears a removed observation", () => {
        const { rerender } = render(<ContextProbe detail={makeDetail(["generation-1"])} />);
        fireEvent.click(screen.getByRole("button", { name: "select generation-1" }));
        expect(screen.getByTestId("selection").textContent).toBe("generation-1");

        rerender(<ContextProbe detail={makeDetail([])} />);
        expect(screen.getByTestId("selection").textContent).toBe("trace");
    });

    it("ignores invalid dates when computing the trace time range", () => {
        render(<ContextProbe detail={makeDetailWithInvalidObservationTime()} />);
        expect(screen.getByTestId("trace-start").textContent).toBe("2026-07-20T08:00:00.000Z");
        expect(screen.getByTestId("trace-duration").textContent).toBe("4");
    });

    it("does not fabricate the Unix epoch when every time boundary is invalid", () => {
        render(<ContextProbe detail={makeDetailWithAllInvalidTimes()} />);
        expect(screen.getByTestId("trace-start").textContent).toBe("none");
        expect(screen.getByTestId("trace-duration").textContent).toBe("0.001");
    });

    it("skips timeline geometry when the trace has no valid start time", () => {
        const { container } = render(
            <ViewHarness detail={makeDetailWithAllInvalidTimes()}>
                <TraceTimeline />
            </ViewHarness>
        );
        expect(screen.getByRole("treeitem", { name: "Trace" })).not.toBeNull();
        const timelineBars = screen.getAllByTestId("timeline-bar");
        expect(timelineBars).toHaveLength(2);
        expect(timelineBars.every((bar) => bar.parentElement?.style.left === "0px")).toBe(true);
        expect(timelineBars.every((bar) => bar.style.width === "4px")).toBe(true);
        expect(container.innerHTML).not.toContain("NaN");
    });

    it("renders an invalid end time as a running zero-duration row without NaN", () => {
        const { container } = render(
            <ViewHarness detail={makeRunningDetailWithInvalidEndTime()}>
                <TraceTimeline />
            </ViewHarness>
        );
        const runningRow = screen.getAllByTestId("timeline-chart-row")[1];
        const geometry = screen.getAllByTestId("timeline-bar")[1];
        expect(runningRow.textContent).toContain("0ms");
        expect(geometry.style.width).toBe("4px");
        expect(container.textContent).not.toContain("NaN");
        const inlineStyles = Array.from(container.querySelectorAll<HTMLElement>("[style]"))
            .map((element) => element.style.cssText)
            .join(" ");
        expect(inlineStyles).not.toContain("NaN");
    });

    it("shows the synthetic trace root as selected in the tree", () => {
        const detail = makeDetail([]);
        render(
            <ViewHarness detail={detail}>
                <TraceTree />
            </ViewHarness>
        );
        expect(screen.getByRole("treeitem", { name: /^Trace/ }).getAttribute("aria-selected")).toBe("true");
    });

    it("shows the synthetic trace root as selected in search", () => {
        const detail = makeDetail([]);
        render(
            <ViewHarness detail={detail}>
                <SearchView />
            </ViewHarness>
        );
        fireEvent.click(screen.getByRole("button", { name: "search trace" }));
        expect(screen.getByRole("option", { name: /^Trace/ }).getAttribute("aria-selected")).toBe("true");
    });

    it("shows the synthetic trace root as selected in the timeline", () => {
        const detail = makeDetail([]);
        render(
            <ViewHarness detail={detail}>
                <TraceTimeline />
            </ViewHarness>
        );
        expect(screen.getByRole("treeitem", { name: "Trace" }).getAttribute("aria-selected")).toBe("true");
        expect(screen.getAllByTestId("timeline-chart-row")[0].className).toContain("bg-accent/10");
    });

    it("supports roving focus and complete tree keyboard navigation", () => {
        const detail = makeNestedDetail();
        render(
            <ViewHarness detail={detail}>
                <TraceTree />
            </ViewHarness>
        );
        const tree = screen.getByRole("tree", { name: "Trace tree" });
        expect(tree.querySelectorAll('button:not([tabindex="-1"])')).toHaveLength(0);

        const selectedItem = () =>
            screen.getAllByRole("treeitem").find((item) => item.getAttribute("aria-selected") === "true")!;
        const expectSelectedAndFocused = (name: string) => {
            const item = screen.getByRole("treeitem", { name: new RegExp(`^${name}`) });
            expect(selectedItem()).toBe(item);
            expect(document.activeElement).toBe(item);
            expect(item.tabIndex).toBe(0);
            expect(screen.getAllByRole("treeitem").filter((candidate) => candidate.tabIndex === 0)).toEqual([item]);
        };

        const generation = screen.getByRole("treeitem", { name: /^result generation/ });
        generation.focus();
        fireEvent.keyDown(generation, { key: "Enter" });
        expectSelectedAndFocused("result generation");

        fireEvent.keyDown(selectedItem(), { key: "ArrowDown" });
        expectSelectedAndFocused("result tool");

        fireEvent.keyDown(selectedItem(), { key: "ArrowUp" });
        expectSelectedAndFocused("result generation");

        fireEvent.keyDown(selectedItem(), { key: "Home" });
        expectSelectedAndFocused("Trace");

        fireEvent.keyDown(selectedItem(), { key: "End" });
        expectSelectedAndFocused("result tool");

        fireEvent.keyDown(selectedItem(), { key: "ArrowLeft" });
        expectSelectedAndFocused("result turn");

        fireEvent.keyDown(selectedItem(), { key: "ArrowLeft" });
        expect(screen.getByRole("treeitem", { name: /^result turn/ }).getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByRole("treeitem", { name: /^result generation/ })).toBeNull();
        expectSelectedAndFocused("result turn");

        fireEvent.keyDown(selectedItem(), { key: "ArrowRight" });
        expect(screen.getByRole("treeitem", { name: /^result turn/ }).getAttribute("aria-expanded")).toBe("true");
        expectSelectedAndFocused("result turn");

        fireEvent.keyDown(selectedItem(), { key: "ArrowRight" });
        expectSelectedAndFocused("result generation");

        fireEvent.keyDown(selectedItem(), { key: " " });
        expectSelectedAndFocused("result generation");

        const turn = screen.getByRole("treeitem", { name: /^result turn/ });
        fireEvent.click(turn.querySelector("[data-expand-button]")!);
        expect(screen.queryByRole("treeitem", { name: /^result generation/ })).toBeNull();
        const root = screen.getByRole("treeitem", { name: /^Trace/ });
        expect(root.tabIndex).toBe(0);
        expect(document.activeElement).toBe(root);
        expect(screen.getAllByRole("treeitem").filter((candidate) => candidate.tabIndex === 0)).toEqual([root]);
    });

    it("supports roving focus and linear search keyboard navigation without left or right actions", () => {
        const detail = makeNestedDetail();
        const renderSearch = (currentDetail: TraceDetail) => (
            <ViewHarness detail={currentDetail}>
                <SearchKeyboardView />
            </ViewHarness>
        );
        const { rerender } = render(renderSearch(detail));
        fireEvent.click(screen.getByRole("button", { name: "search results" }));

        const listbox = screen.getByRole("listbox", { name: "Trace search results" });
        expect(listbox.querySelectorAll('button:not([tabindex="-1"])')).toHaveLength(0);
        const options = () => screen.getAllByRole("option");
        expect(options().filter((option) => option.tabIndex === 0)).toEqual([options()[0]]);

        options()[0].focus();
        fireEvent.keyDown(options()[0], { key: "ArrowDown" });
        expect(options()[1].getAttribute("aria-selected")).toBe("true");
        expect(document.activeElement).toBe(options()[1]);

        fireEvent.keyDown(options()[1], { key: "End" });
        expect(options()[2].getAttribute("aria-selected")).toBe("true");
        expect(document.activeElement).toBe(options()[2]);
        expect(scrollToIndex).toHaveBeenLastCalledWith(2, { align: "auto" });
        const revealCount = scrollToIndex.mock.calls.length;
        rerender(renderSearch({ ...detail, observations: [...detail.observations] }));
        expect(scrollToIndex).toHaveBeenCalledTimes(revealCount);

        fireEvent.keyDown(options()[2], { key: "ArrowRight" });
        fireEvent.keyDown(options()[2], { key: "ArrowLeft" });
        expect(options()[2].getAttribute("aria-selected")).toBe("true");

        fireEvent.keyDown(options()[2], { key: "Home" });
        expect(options()[0].getAttribute("aria-selected")).toBe("true");
        expect(document.activeElement).toBe(options()[0]);

        fireEvent.keyDown(options()[0], { key: "ArrowUp" });
        expect(options()[0].getAttribute("aria-selected")).toBe("true");

        options()[1].focus();
        fireEvent.keyDown(options()[1], { key: "Enter" });
        expect(options()[1].getAttribute("aria-selected")).toBe("true");
        expect(document.activeElement).toBe(options()[1]);

        options()[2].focus();
        fireEvent.keyDown(options()[2], { key: " " });
        expect(options()[2].getAttribute("aria-selected")).toBe("true");
        expect(document.activeElement).toBe(options()[2]);
        expect(options().filter((option) => option.tabIndex === 0)).toEqual([options()[2]]);
    });

    it("keeps the real header search input focused while typing each character", () => {
        render(
            <ViewHarness detail={makeNestedDetail()}>
                <SearchHeaderView />
            </ViewHarness>
        );
        const input = screen.getByRole("textbox", { name: "Search trace" });
        input.focus();

        for (const query of ["r", "re", "res", "resu", "resul", "result"]) {
            fireEvent.change(input, { target: { value: query } });
            expect(document.activeElement).toBe(input);
        }
    });
});
