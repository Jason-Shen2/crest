// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TraceDataProvider, TraceSelectionProvider, useTraceData, useTraceSelection } from "./trace-context";
import { TraceSearchList } from "./trace-search-list";
import { TraceTimeline } from "./trace-timeline";
import { TraceTree } from "./trace-tree";

vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
        const size = estimateSize();
        return {
            getTotalSize: () => count * size,
            measureElement: vi.fn(),
            scrollToIndex: vi.fn(),
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
});
