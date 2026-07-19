// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createRef, type ComponentProps } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ObservabilityPanel, type AgentObservabilityApi } from "./observability-panel";
import { ObservationTimeline } from "./observation-timeline";

const ViewportHeight = 480;
const CollapsedRowHeight = 44;
const ExpandedRowHeight = 180;
const OriginalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const OriginalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const OriginalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
const OriginalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
const OriginalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
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

function makeGraph(count = 1_000): AgentObservabilityTraceGraph {
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
        observations: Array.from({ length: count }, (_, index) => makeObservation(index)),
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

function mountedIndexes(container: HTMLElement): number[] {
    return Array.from(container.querySelectorAll<HTMLElement>("[data-index]"), (element) =>
        Number(element.dataset.index)
    );
}

function scrollTimeline(timeline: HTMLElement, top: number) {
    act(() => {
        timeline.scrollTop = top;
        timeline.dispatchEvent(new Event("scroll"));
    });
}

beforeAll(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
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
        clientHeight: {
            configurable: true,
            get() {
                return elementHeight(this);
            },
        },
        scrollHeight: {
            configurable: true,
            get() {
                if (this.getAttribute("aria-label") !== "Observation Timeline") {
                    return elementHeight(this);
                }
                return Number.parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? "0");
            },
        },
        scrollTo: {
            configurable: true,
            value(options: ScrollToOptions) {
                this.scrollTop = options.top ?? this.scrollTop;
                queueMicrotask(() => this.dispatchEvent(new Event("scroll")));
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

    it("keeps the mounted window bounded while scrolling through middle and late ranges", async () => {
        const graph = makeGraph();
        const view = render(<ObservationTimeline {...makeProps(graph)} />);
        const timeline = view.getByRole("listbox");

        for (const [top, minimumIndex] of [
            [22_000, 400],
            [42_000, 900],
        ] as const) {
            scrollTimeline(timeline, top);
            await waitFor(() => expect(Math.min(...mountedIndexes(view.container))).toBeGreaterThan(minimumIndex));
            const indexes = mountedIndexes(view.container);
            expect(indexes.length).toBeGreaterThan(1);
            expect(indexes.length).toBeLessThan(100);
            expect(indexes.length).toBeLessThan(graph.observations.length);
        }
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

    it("holds position while follow-live is paused and reaches an appended tail after resuming", async () => {
        const initialGraph = makeGraph(40);
        const props = makeProps(initialGraph, { followLive: false });
        const view = render(<ObservationTimeline {...props} />);
        const timeline = view.getByRole("listbox");
        scrollTimeline(timeline, 440);
        await waitFor(() => expect(Math.min(...mountedIndexes(view.container))).toBeGreaterThan(0));

        const appendedGraph = makeGraph(41);
        view.rerender(<ObservationTimeline {...props} graph={appendedGraph} />);
        expect(mountedIndexes(view.container)).not.toContain(40);
        expect(timeline.scrollTop).toBe(440);

        view.rerender(<ObservationTimeline {...props} graph={appendedGraph} followLive />);
        await waitFor(() => expect(mountedIndexes(view.container)).toContain(40));
        expect(timeline.scrollTop).toBeGreaterThan(440);
    });
});

describe("ObservabilityPanel real layout boundary", () => {
    it("replaces traces when the session scope changes", async () => {
        const firstGraph = makeGraph(1);
        firstGraph.trace = {
            ...firstGraph.trace,
            id: "trace-a",
            input: "First session run",
            sessionId: "session-a",
        };
        const secondGraph = makeGraph(1);
        secondGraph.trace = {
            ...secondGraph.trace,
            id: "trace-b",
            input: "Second session run",
            sessionId: "session-b",
        };
        const api: AgentObservabilityApi = {
            listTraces: vi.fn(async (sessionId) => [
                sessionId === "session-a" ? firstGraph.trace : secondGraph.trace,
            ]),
            getTrace: vi.fn(async (traceId) => (traceId === "trace-a" ? firstGraph : secondGraph)),
            subscribe: vi.fn(() => vi.fn()),
        };
        const view = render(<ObservabilityPanel api={api} sessionId="session-a" />);
        await view.findByRole("option", { name: /First session run/ });

        view.rerender(<ObservabilityPanel api={api} sessionId="session-b" />);

        await view.findByRole("option", { name: /Second session run/ });
        expect(view.queryByRole("option", { name: /First session run/ })).toBeNull();
        expect(api.getTrace).toHaveBeenCalledWith("trace-b", "session-b");
    });

    it("moves selected detail from inline normal mode to a sibling pane when magnified", async () => {
        const graph = makeGraph(20);
        const api: AgentObservabilityApi = {
            listTraces: vi.fn().mockResolvedValue([graph.trace]),
            getTrace: vi.fn().mockResolvedValue(graph),
            subscribe: vi.fn(() => vi.fn()),
        };
        const view = render(<ObservabilityPanel api={api} />);
        await waitFor(() => expect(view.container.querySelector("[data-index] button")).toBeTruthy());
        const visibleRow = view.container.querySelector<HTMLButtonElement>("[data-index] button")!;

        fireEvent.click(visibleRow);
        const normalRowContainer = visibleRow.closest("[data-index]");
        expect(within(normalRowContainer as HTMLElement).getByLabelText("Observation detail")).toBeTruthy();
        expect(view.queryByLabelText("Observation detail pane")).toBeNull();

        view.rerender(<ObservabilityPanel api={api} magnified />);
        const detailPane = await view.findByLabelText("Observation detail pane");
        const magnifiedRow = view.container.querySelector<HTMLButtonElement>(
            '[data-index] button[aria-expanded="true"]'
        )!;
        expect(magnifiedRow).toBeTruthy();
        expect(
            within(magnifiedRow.closest("[data-index]") as HTMLElement).queryByLabelText("Observation detail")
        ).toBeNull();
        expect(within(detailPane).getByLabelText("Observation detail")).toBeTruthy();
    });

    it("keeps an appended live tail paused until Back to live is selected", async () => {
        const initialGraph = makeGraph(40);
        let subscriber: ((event: AgentObservabilityEvent) => void) | undefined;
        const api: AgentObservabilityApi = {
            listTraces: vi.fn().mockResolvedValue([initialGraph.trace]),
            getTrace: vi.fn().mockResolvedValue(initialGraph),
            subscribe: vi.fn((_sessionId, callback) => {
                subscriber = callback;
                return vi.fn();
            }),
        };
        const view = render(<ObservabilityPanel api={api} />);
        const timeline = await view.findByRole("listbox");
        await waitFor(() => expect(mountedIndexes(view.container)).toContain(39));

        fireEvent.wheel(timeline);
        scrollTimeline(timeline, 440);
        expect(await view.findByRole("button", { name: "Back to live" })).toBeTruthy();

        const appendedGraph = makeGraph(41);
        act(() => {
            subscriber?.({
                traceId: appendedGraph.trace.id,
                sessionId: appendedGraph.trace.sessionId ?? undefined,
                graph: appendedGraph,
            });
        });
        expect(mountedIndexes(view.container)).not.toContain(40);

        fireEvent.click(view.getByRole("button", { name: "Back to live" }));
        await waitFor(() => expect(mountedIndexes(view.container)).toContain(40));
        expect(view.queryByRole("button", { name: "Back to live" })).toBeNull();
    });
});
