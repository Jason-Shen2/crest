// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef, type ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ObservabilityPanel, type AgentObservabilityApi } from "./observability-panel";
import { presentObservation } from "./observation-presentation";
import { ObservationRow } from "./observation-row";
import { ObservationTimeline } from "./observation-timeline";

const VirtualizerHarness = vi.hoisted(() => ({
    scrollToIndex: vi.fn(),
    scrollToOffset: vi.fn(),
    measure: vi.fn(),
    count: 0,
    initialOffsets: [] as number[],
}));
const Timeline = ObservationTimeline as ComponentType<any>;

vi.mock("@tanstack/react-virtual", () => {
    const virtualizer = {
        measure: VirtualizerHarness.measure,
        measureElement: vi.fn(),
        scrollToIndex: VirtualizerHarness.scrollToIndex,
        scrollToOffset: VirtualizerHarness.scrollToOffset,
        getTotalSize: () => VirtualizerHarness.count * 44,
        getVirtualItems: () =>
            Array.from({ length: VirtualizerHarness.count }, (_, index) => ({
                index,
                key: index,
                start: index * 44,
                size: 44,
                end: (index + 1) * 44,
                lane: 0,
            })),
    };
    return {
        useVirtualizer: (options: { count: number; initialOffset?: number }) => {
            VirtualizerHarness.count = options.count;
            VirtualizerHarness.initialOffsets.push(options.initialOffset ?? 0);
            return virtualizer;
        },
    };
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

function makeObservation(
    id: string,
    overrides: Partial<AgentObservabilityObservation> = {}
): AgentObservabilityObservation {
    return {
        id,
        traceId: "trace-1",
        type: "GENERATION",
        name: "assistant response",
        startTime: "2026-07-19T00:00:01.000Z",
        endTime: "2026-07-19T00:00:02.000Z",
        parentObservationId: "root",
        level: "DEFAULT",
        statusMessage: null,
        version: null,
        model: "claude-sonnet",
        input: null,
        output: "first chunk",
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

function makeGraph(observation: AgentObservabilityObservation): AgentObservabilityTraceGraph {
    return {
        trace: {
            id: "trace-1",
            name: "Live run",
            timestamp: "2026-07-19T00:00:00.000Z",
            environment: "test",
            tags: [],
            input: null,
            output: null,
            metadata: {},
            sessionId: "session-1",
            status: "running",
        },
        observations: [observation],
        scores: [],
    };
}

function makeGraphWithObservations(
    traceId: string,
    name: string,
    observations: AgentObservabilityObservation[]
): AgentObservabilityTraceGraph {
    const graph = makeGraph(observations[0]);
    graph.trace = {
        ...graph.trace,
        id: traceId,
        name,
    };
    graph.observations = observations.map((observation) => ({ ...observation, traceId }));
    return graph;
}

function makeTraceGraph(traceId: string, name: string, observationId: string): AgentObservabilityTraceGraph {
    const graph = makeGraph(makeObservation(observationId, { id: observationId, traceId }));
    graph.trace = {
        ...graph.trace,
        id: traceId,
        name,
        status: "success",
        endedAt: "2026-07-19T00:00:05.000Z",
    };
    return graph;
}

function renderTimeline(graph: AgentObservabilityTraceGraph, overrides: Record<string, unknown> = {}) {
    const props = {
        graph,
        query: "",
        categories: new Set(["generation", "tool", "lifecycle", "error"] as const),
        expandedObservationIds: new Set<string>(),
        selectedObservationId: undefined,
        followLive: true,
        scrollOffset: 0,
        searchInputRef: createRef<HTMLInputElement>(),
        onSelectObservation: vi.fn(),
        onToggleExpanded: vi.fn(),
        onCollapseObservation: vi.fn(),
        onPauseFollowLive: vi.fn(),
        onScrollOffsetChange: vi.fn(),
        ...overrides,
    };
    return { ...render(<Timeline {...props} />), props };
}

describe("ObservationTimeline real events", () => {
    it("sticks to the live tail when the last observation content grows without adding a row", () => {
        VirtualizerHarness.scrollToIndex.mockClear();
        const observation = makeObservation("generation");
        const view = renderTimeline(makeGraph(observation));
        const callsAfterFirstRender = VirtualizerHarness.scrollToIndex.mock.calls.length;

        view.rerender(
            <Timeline
                {...view.props}
                graph={makeGraph({ ...observation, output: "first chunk and streamed second chunk" })}
            />
        );

        expect(VirtualizerHarness.scrollToIndex.mock.calls.length).toBeGreaterThan(callsAfterFirstRender);
        expect(VirtualizerHarness.scrollToIndex).toHaveBeenLastCalledWith(0, {
            align: "end",
            behavior: "smooth",
        });
    });

    for (const [badgeName, overrides] of [
        ["duration", { endTime: "2026-07-19T00:00:03.000Z" }],
        ["model", { model: "claude-opus" }],
        ["tokens", { usageDetails: { totalTokens: 42 } }],
        ["cost", { costDetails: { total: 0.125 } }],
        ["status", { statusMessage: "stream failed" }],
    ] satisfies Array<[string, Partial<AgentObservabilityObservation>]>) {
        it(`sticks to the live tail when the visible ${badgeName} badge changes`, () => {
            const observation = makeObservation("generation");
            const view = renderTimeline(makeGraph(observation));
            const callsAfterFirstRender = VirtualizerHarness.scrollToIndex.mock.calls.length;

            view.rerender(<Timeline {...view.props} graph={makeGraph({ ...observation, ...overrides })} />);

            expect(VirtualizerHarness.scrollToIndex.mock.calls.length).toBeGreaterThan(callsAfterFirstRender);
            view.unmount();
        });
    }

    it("dispatches keyboard and scroll behavior through DOM events", () => {
        const onSelectObservation = vi.fn();
        const onPauseFollowLive = vi.fn();
        const onScrollOffsetChange = vi.fn();
        const view = renderTimeline(makeGraph(makeObservation("generation")), {
            onSelectObservation,
            onPauseFollowLive,
            onScrollOffsetChange,
        });
        const timeline = view.getByRole("listbox");
        Object.defineProperties(timeline, {
            scrollHeight: { configurable: true, value: 1000 },
            clientHeight: { configurable: true, value: 300 },
            scrollTop: { configurable: true, writable: true, value: 120 },
        });

        fireEvent.keyDown(timeline, { key: "j" });
        fireEvent.wheel(timeline);
        fireEvent.scroll(timeline);

        expect(onSelectObservation).toHaveBeenCalledWith("generation");
        expect(onScrollOffsetChange).toHaveBeenCalledWith(120);
        expect(onPauseFollowLive).toHaveBeenCalled();
    });
});

describe("ObservabilityPanel trace state", () => {
    it("handles the complete timeline keyboard contract through DOM events", async () => {
        const graph = makeGraphWithObservations("trace-keys", "Keyboard run", [
            makeObservation("first", { name: "first step", startTime: "2026-07-19T00:00:01.000Z" }),
            makeObservation("second", { name: "second step", startTime: "2026-07-19T00:00:02.000Z" }),
            makeObservation("third", { name: "third step", startTime: "2026-07-19T00:00:03.000Z" }),
        ]);
        const api: AgentObservabilityApi = {
            listTraces: vi.fn().mockResolvedValue([graph.trace]),
            getTrace: vi.fn().mockResolvedValue(graph),
            subscribe: vi.fn(() => vi.fn()),
        };
        const view = render(<ObservabilityPanel api={api} />);
        await waitFor(() => expect(view.getByRole("listbox")).toBeTruthy());
        const timeline = view.getByRole("listbox");
        const first = view.getByRole("button", { name: /First Step/ });
        const second = view.getByRole("button", { name: /Second Step/ });
        const third = view.getByRole("button", { name: /Third Step/ });

        fireEvent.keyDown(timeline, { key: "j" });
        expect(first.className).toContain("border-accent");
        fireEvent.keyDown(timeline, { key: "G" });
        expect(third.className).toContain("border-accent");
        fireEvent.keyDown(timeline, { key: "k" });
        expect(second.className).toContain("border-accent");

        fireEvent.keyDown(timeline, { key: "Enter" });
        expect(second.getAttribute("aria-expanded")).toBe("true");
        fireEvent.keyDown(timeline, { key: " " });
        expect(second.getAttribute("aria-expanded")).toBe("false");
        fireEvent.keyDown(timeline, { key: "Enter" });
        fireEvent.keyDown(timeline, { key: "Escape" });
        expect(second.getAttribute("aria-expanded")).toBe("false");

        fireEvent.keyDown(timeline, { key: "g" });
        expect(first.className).toContain("border-accent");
        fireEvent.keyDown(timeline, { key: "/" });
        expect(document.activeElement).toBe(view.getByLabelText("Search timeline"));
    });

    it("scrolls to the last row when Back to live is clicked", async () => {
        const graph = makeGraphWithObservations("trace-live", "Live run", [
            makeObservation("first", { name: "first step", startTime: "2026-07-19T00:00:01.000Z" }),
            makeObservation("second", { name: "second step", startTime: "2026-07-19T00:00:02.000Z" }),
            makeObservation("third", { name: "third step", startTime: "2026-07-19T00:00:03.000Z" }),
        ]);
        const api: AgentObservabilityApi = {
            listTraces: vi.fn().mockResolvedValue([graph.trace]),
            getTrace: vi.fn().mockResolvedValue(graph),
            subscribe: vi.fn(() => vi.fn()),
        };
        const view = render(<ObservabilityPanel api={api} />);
        await waitFor(() => expect(view.getByRole("listbox")).toBeTruthy());
        const timeline = view.getByRole("listbox");
        Object.defineProperties(timeline, {
            scrollHeight: { configurable: true, value: 1000 },
            clientHeight: { configurable: true, value: 300 },
            scrollTop: { configurable: true, writable: true, value: 120 },
        });
        fireEvent.wheel(timeline);
        fireEvent.scroll(timeline);
        const backToLive = await view.findByRole("button", { name: "Back to live" });
        VirtualizerHarness.scrollToIndex.mockClear();

        fireEvent.click(backToLive);

        await waitFor(() =>
            expect(VirtualizerHarness.scrollToIndex).toHaveBeenCalledWith(2, {
                align: "end",
                behavior: "smooth",
            })
        );
    });

    it("restores selection, expansion, follow-live, and scroll offset through real events", async () => {
        VirtualizerHarness.initialOffsets = [];
        const first = makeTraceGraph("trace-1", "First run", "first-observation");
        const second = makeTraceGraph("trace-2", "Second run", "second-observation");
        const api: AgentObservabilityApi = {
            listTraces: vi.fn().mockResolvedValue([first.trace, second.trace]),
            getTrace: vi.fn(async (traceId) => (traceId === first.trace.id ? first : second)),
            subscribe: vi.fn(() => vi.fn()),
        };
        const view = render(<ObservabilityPanel api={api} />);
        await waitFor(() => expect(view.getAllByText("First run").length).toBeGreaterThan(0));

        fireEvent.click(view.getByRole("button", { name: /Assistant Response/ }));
        const timeline = view.getByRole("listbox");
        Object.defineProperties(timeline, {
            scrollHeight: { configurable: true, value: 1000 },
            clientHeight: { configurable: true, value: 300 },
            scrollTop: { configurable: true, writable: true, value: 144 },
        });
        fireEvent.wheel(timeline);
        fireEvent.scroll(timeline);
        expect(view.getByText("Back to live")).toBeTruthy();

        fireEvent.change(view.getByLabelText("Recent Runs"), { target: { value: "trace-2" } });
        await waitFor(() => expect(view.getAllByText("Second run").length).toBeGreaterThan(0));
        expect(view.queryByText("Back to live")).toBeNull();
        expect(view.getByRole("button", { name: /Assistant Response/ }).getAttribute("aria-expanded")).toBe("false");
        fireEvent.change(view.getByLabelText("Recent Runs"), { target: { value: "trace-1" } });
        await waitFor(() => expect(view.getAllByText("First run").length).toBeGreaterThan(0));

        const restoredRow = view.getByRole("button", { name: /Assistant Response/ });
        expect(restoredRow.getAttribute("aria-expanded")).toBe("true");
        expect(restoredRow.className).toContain("border-accent");
        expect(view.getByText("Back to live")).toBeTruthy();
        expect(VirtualizerHarness.initialOffsets).toContain(144);
    });
});

describe("ObservationRow theme tokens", () => {
    it("uses semantic theme tokens for every tone", () => {
        for (const [type, level, expectedToken] of [
            ["GENERATION", "DEFAULT", "text-accent"],
            ["TOOL", "DEFAULT", "text-success"],
            ["EVENT", "DEFAULT", "text-muted-foreground"],
            ["GENERATION", "WARNING", "text-warning"],
            ["GENERATION", "ERROR", "text-error"],
        ] as const) {
            const observation = makeObservation(`${type}-${level}`, {
                type,
                level,
                statusMessage: level === "ERROR" ? "failed" : null,
            });
            const { container, unmount } = render(
                <ObservationRow
                    observation={observation}
                    presentation={presentObservation(observation)}
                    relativeTime="+1.0s"
                    expanded={false}
                    selected={false}
                    onToggle={vi.fn()}
                />
            );

            expect(container.innerHTML).toContain(expectedToken);
            expect(container.innerHTML).not.toMatch(/(?:blue|green|yellow|red)-\d/);
            unmount();
        }
    });
});
