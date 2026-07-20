// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TraceDataProvider, TraceSelectionProvider, useTraceSelection } from "./trace-context";
import { TraceTimeline } from "./trace-timeline";

const ViewportHeight = 260;
const ViewportWidth = 400;
const OriginalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const OriginalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const OriginalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const OriginalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
const OriginalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
const OriginalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
const OriginalGetBoundingClientRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
const PendingScrollTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
let scrollCalls: ScrollToOptions[] = [];

class TestResizeObserver {
    callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
    }

    observe(target: Element) {
        const rect = target.getBoundingClientRect();
        this.callback(
            [
                {
                    target,
                    contentRect: rect,
                    borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
                } as unknown as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver
        );
    }

    unobserve() {}

    disconnect() {}
}

function isTimelineScroll(element: Element): boolean {
    return element.getAttribute("data-testid") === "timeline-scroll";
}

function makeObservation(index: number): Observation {
    return {
        id: `observation-${index}`,
        traceId: "trace-large",
        type: "GENERATION",
        name: `Observation ${index}`,
        startTime: new Date(Date.parse("2026-07-20T08:00:01.000Z") + index * 1_000).toISOString(),
        endTime: new Date(Date.parse("2026-07-20T08:00:01.500Z") + index * 1_000).toISOString(),
        parentObservationId: "parent",
        level: "DEFAULT",
        statusMessage: null,
        version: null,
        model: "fixture-model",
        input: null,
        output: null,
        metadata: {},
        latency: 0.5,
        timeToFirstToken: null,
        usageDetails: {},
        costDetails: {},
        toolCalls: null,
        toolCallNames: null,
    };
}

function makeTraceDetail(count = 1_000): TraceDetail {
    return {
        trace: {
            id: "trace-large",
            name: "Large run",
            timestamp: "2026-07-20T08:00:00.000Z",
            endedAt: new Date(Date.parse("2026-07-20T08:00:02.000Z") + count * 1_000).toISOString(),
            environment: "test",
            tags: [],
            release: null,
            version: null,
            input: null,
            output: null,
            metadata: {},
            sessionId: "session-large",
            userId: null,
            status: "success",
        },
        observations: [
            {
                ...makeObservation(-1),
                id: "parent",
                name: "Parent",
                type: "SPAN",
                parentObservationId: null,
                startTime: "2026-07-20T08:00:00.500Z",
            },
            ...Array.from({ length: count }, (_, index) => makeObservation(index)),
        ],
        scores: [],
        corrections: [],
    };
}

function TimelineControls() {
    const { collapsedNodes, toggleCollapsed, setSelectedNodeId } = useTraceSelection();
    return (
        <>
            <button
                type="button"
                onClick={() => {
                    toggleCollapsed("trace-trace-large");
                    toggleCollapsed("parent");
                }}
            >
                Collapse ancestors
            </button>
            <button type="button" onClick={() => setSelectedNodeId("observation-997")}>
                Select remote observation
            </button>
            <output data-testid="collapsed-nodes">{[...collapsedNodes].sort().join(",")}</output>
            <TraceTimeline />
        </>
    );
}

function TraceTimelineHarness() {
    const detail = makeTraceDetail();
    return (
        <TraceDataProvider detail={detail}>
            <TraceSelectionProvider traceId={detail.trace.id}>
                <TimelineControls />
            </TraceSelectionProvider>
        </TraceDataProvider>
    );
}

beforeAll(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    Object.defineProperties(HTMLElement.prototype, {
        offsetWidth: {
            configurable: true,
            get() {
                return isTimelineScroll(this) ? ViewportWidth : 0;
            },
        },
        offsetHeight: {
            configurable: true,
            get() {
                return isTimelineScroll(this) ? ViewportHeight : 0;
            },
        },
        clientWidth: {
            configurable: true,
            get() {
                return isTimelineScroll(this) ? ViewportWidth : 0;
            },
        },
        clientHeight: {
            configurable: true,
            get() {
                return isTimelineScroll(this) ? ViewportHeight : 0;
            },
        },
        scrollHeight: {
            configurable: true,
            get() {
                if (!isTimelineScroll(this)) {
                    return 0;
                }
                return Number.parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? "0");
            },
        },
        scrollTo: {
            configurable: true,
            value(options: ScrollToOptions) {
                const pendingTimer = PendingScrollTimers.get(this);
                if (pendingTimer != null) {
                    clearTimeout(pendingTimer);
                }
                scrollCalls.push(options);
                const timer = setTimeout(() => {
                    this.scrollTop = options.top ?? this.scrollTop;
                    this.scrollLeft = options.left ?? this.scrollLeft;
                    this.dispatchEvent(new Event("scroll"));
                }, 0);
                PendingScrollTimers.set(this, timer);
            },
        },
        getBoundingClientRect: {
            configurable: true,
            value() {
                const width = isTimelineScroll(this) ? ViewportWidth : 0;
                const height = isTimelineScroll(this) ? ViewportHeight : 0;
                return {
                    x: 0,
                    y: 0,
                    top: 0,
                    right: width,
                    bottom: height,
                    left: 0,
                    width,
                    height,
                    toJSON: () => undefined,
                };
            },
        },
    });
});

afterEach(() => {
    cleanup();
    scrollCalls = [];
});

afterAll(() => {
    for (const [name, descriptor] of [
        ["offsetWidth", OriginalOffsetWidth],
        ["offsetHeight", OriginalOffsetHeight],
        ["clientWidth", OriginalClientWidth],
        ["clientHeight", OriginalClientHeight],
        ["scrollHeight", OriginalScrollHeight],
        ["scrollTo", OriginalScrollTo],
        ["getBoundingClientRect", OriginalGetBoundingClientRect],
    ] as const) {
        if (descriptor) {
            Object.defineProperty(HTMLElement.prototype, name, descriptor);
        } else {
            delete HTMLElement.prototype[name];
        }
    }
    vi.unstubAllGlobals();
});

describe("trace timeline real virtualization", () => {
    it("mounts a bounded row window for a large trace", async () => {
        render(<TraceTimelineHarness />);

        await waitFor(() => expect(screen.getAllByTestId("timeline-gutter-row").length).toBeGreaterThan(1));
        const mountedRows = screen.getAllByTestId("timeline-gutter-row");
        expect(mountedRows.length).toBeLessThan(100);
        expect(mountedRows.length).toBeLessThan(1_002);
    });

    it("expands collapsed ancestors and reveals a remotely selected row", async () => {
        render(<TraceTimelineHarness />);
        await waitFor(() => expect(screen.getAllByTestId("timeline-gutter-row").length).toBeGreaterThan(1));
        const chart = screen.getByTestId("timeline-scroll");

        fireEvent.click(screen.getByRole("button", { name: "Collapse ancestors" }));
        expect(screen.getByTestId("collapsed-nodes").textContent).toBe("parent,trace-trace-large");
        expect(screen.queryByRole("treeitem", { name: "Observation 997" })).toBeNull();

        scrollCalls = [];
        act(() => fireEvent.click(screen.getByRole("button", { name: "Select remote observation" })));

        await waitFor(() => expect(screen.getByTestId("collapsed-nodes").textContent).toBe(""));
        const selectedRow = await screen.findByRole("treeitem", { name: "Observation 997" });
        expect(scrollCalls).toEqual([
            expect.objectContaining({
                top: expect.any(Number),
                left: expect.any(Number),
                behavior: "smooth",
            }),
        ]);
        expect(chart.scrollTop).toBeGreaterThan(0);
        expect(document.activeElement).toBe(selectedRow);
    });

    it("re-expands ancestors collapsed after their selected descendant was revealed", async () => {
        render(<TraceTimelineHarness />);
        await waitFor(() => expect(screen.getAllByTestId("timeline-gutter-row").length).toBeGreaterThan(1));
        const chart = screen.getByTestId("timeline-scroll");

        fireEvent.click(screen.getByRole("button", { name: "Select remote observation" }));
        await waitFor(() => expect(screen.getByRole("treeitem", { name: "Observation 997" })).toBeTruthy());
        expect(chart.scrollTop).toBeGreaterThan(0);

        fireEvent.click(screen.getByRole("button", { name: "Collapse ancestors" }));

        await waitFor(() => expect(screen.getByTestId("collapsed-nodes").textContent).toBe(""));
        expect(screen.getByRole("treeitem", { name: "Observation 997" }).getAttribute("aria-selected")).toBe("true");
        expect(chart.scrollTop).toBeGreaterThan(0);
    });
});
