// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createRef, type ComponentProps } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ObservationTimeline } from "./observation-timeline";

const ViewportHeight = 480;
const CollapsedRowHeight = 44;
const ExpandedRowHeight = 180;
const OriginalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const OriginalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const OriginalGetBoundingClientRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");

type ResizeCallback = ConstructorParameters<typeof ResizeObserver>[0];

class TestResizeObserver {
    static instances: TestResizeObserver[] = [];

    callback: ResizeCallback;
    observed = new Set<Element>();

    constructor(callback: ResizeCallback) {
        this.callback = callback;
        TestResizeObserver.instances.push(this);
    }

    observe(target: Element) {
        this.observed.add(target);
    }

    unobserve(target: Element) {
        this.observed.delete(target);
    }

    disconnect() {
        this.observed.clear();
    }

    static notify(target: Element) {
        for (const observer of TestResizeObserver.instances) {
            if (!observer.observed.has(target)) {
                continue;
            }
            const rect = target.getBoundingClientRect();
            observer.callback(
                [
                    {
                        target,
                        contentRect: rect,
                        borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
                    } as unknown as ResizeObserverEntry,
                ],
                observer as unknown as ResizeObserver
            );
        }
    }
}

function elementHeight(element: Element): number {
    if (element.getAttribute("aria-label") === "Observation Timeline") {
        return ViewportHeight;
    }
    if (element.hasAttribute("data-index")) {
        return element.querySelector('[aria-expanded="true"]') ? ExpandedRowHeight : CollapsedRowHeight;
    }
    return 0;
}

function makeObservation(index: number): AgentObservabilityObservation {
    return {
        id: `observation-${index}`,
        traceId: "trace-large",
        type: "GENERATION",
        name: index === 997 ? "Needle observation" : `Observation ${index}`,
        startTime: new Date(Date.parse("2026-07-19T00:00:00.000Z") + index * 1_000).toISOString(),
        endTime: new Date(Date.parse("2026-07-19T00:00:00.500Z") + index * 1_000).toISOString(),
        parentObservationId: "root",
        level: "DEFAULT",
        statusMessage: null,
        version: null,
        model: "fixture-model",
        input: null,
        output: `Output ${index}`,
        metadata: {},
        latency: null,
        timeToFirstToken: null,
        usageDetails: {},
        costDetails: {},
        toolCalls: null,
        toolCallNames: null,
    };
}

function makeGraph(): AgentObservabilityTraceGraph {
    return {
        trace: {
            id: "trace-large",
            name: "Large run",
            timestamp: "2026-07-19T00:00:00.000Z",
            environment: "test",
            tags: [],
            input: null,
            output: null,
            metadata: {},
            sessionId: "session-large",
            status: "success",
        },
        observations: Array.from({ length: 1_000 }, (_, index) => makeObservation(index)),
        scores: [],
    };
}

function makeProps(
    graph: AgentObservabilityTraceGraph,
    overrides: Partial<ComponentProps<typeof ObservationTimeline>> = {}
): ComponentProps<typeof ObservationTimeline> {
    return {
        graph,
        query: "",
        categories: new Set(["generation", "tool", "lifecycle", "error"]),
        expandedObservationIds: new Set(),
        selectedObservationId: undefined,
        followLive: false,
        scrollOffset: 0,
        searchInputRef: createRef<HTMLInputElement>(),
        onSelectObservation: vi.fn(),
        onToggleExpanded: vi.fn(),
        onCollapseObservation: vi.fn(),
        onPauseFollowLive: vi.fn(),
        onScrollOffsetChange: vi.fn(),
        ...overrides,
    };
}

function rowStart(element: Element): number {
    return Number.parseFloat((element as HTMLElement).style.transform.match(/translateY\(([\d.]+)px\)/)?.[1] ?? "NaN");
}

beforeAll(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    Object.defineProperties(HTMLElement.prototype, {
        offsetWidth: {
            configurable: true,
            get() {
                return 320;
            },
        },
        offsetHeight: {
            configurable: true,
            get() {
                return elementHeight(this);
            },
        },
        getBoundingClientRect: {
            configurable: true,
            value() {
                const height = elementHeight(this);
                return {
                    x: 0,
                    y: 0,
                    top: 0,
                    right: 320,
                    bottom: height,
                    left: 0,
                    width: 320,
                    height,
                    toJSON: () => undefined,
                };
            },
        },
    });
});

afterEach(() => {
    cleanup();
    TestResizeObserver.instances = [];
});

afterAll(() => {
    for (const [name, descriptor] of [
        ["offsetWidth", OriginalOffsetWidth],
        ["offsetHeight", OriginalOffsetHeight],
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

describe("ObservationTimeline real virtualization", () => {
    it("mounts a bounded window for 1,000 observations and searches the full row set", async () => {
        const graph = makeGraph();
        const props = makeProps(graph);
        const view = render(<ObservationTimeline {...props} />);

        await waitFor(() => expect(view.container.querySelectorAll("[data-index]").length).toBeGreaterThan(1));
        const mountedCount = view.container.querySelectorAll("[data-index]").length;
        expect(mountedCount).toBeLessThan(100);
        expect(mountedCount).toBeLessThan(graph.observations.length);

        view.rerender(<ObservationTimeline {...props} query="Needle observation" />);

        expect(await view.findByRole("button", { name: /Needle Observation/ })).toBeTruthy();
        expect(view.container.querySelectorAll("[data-index]")).toHaveLength(1);
    });

    it("remeasures an expanded row and shifts following rows without overlap", async () => {
        const graph = makeGraph();
        const props = makeProps(graph);
        const view = render(<ObservationTimeline {...props} />);
        await waitFor(() => expect(view.container.querySelectorAll("[data-index]").length).toBeGreaterThan(1));

        const firstRow = view.container.querySelector<HTMLElement>('[data-index="0"]');
        const secondRow = view.container.querySelector<HTMLElement>('[data-index="1"]');
        expect(firstRow).toBeTruthy();
        expect(secondRow).toBeTruthy();
        expect(rowStart(secondRow!)).toBe(rowStart(firstRow!) + CollapsedRowHeight);

        view.rerender(
            <ObservationTimeline
                {...props}
                expandedObservationIds={new Set(["observation-0"])}
                selectedObservationId="observation-0"
            />
        );
        const expandedFirstRow = view.container.querySelector<HTMLElement>('[data-index="0"]');
        expect(expandedFirstRow?.getBoundingClientRect().height).toBe(ExpandedRowHeight);

        act(() => TestResizeObserver.notify(expandedFirstRow!));

        await waitFor(() => {
            const shiftedSecondRow = view.container.querySelector<HTMLElement>('[data-index="1"]');
            expect(shiftedSecondRow).toBeTruthy();
            expect(rowStart(shiftedSecondRow!)).toBe(rowStart(expandedFirstRow!) + ExpandedRowHeight);
        });
    });
});
