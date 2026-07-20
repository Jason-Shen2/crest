// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ObservabilityPanel, type AgentObservabilityApi } from "./observability-panel";
import { ObservationDetail } from "./observation-detail";
import { presentObservation } from "./observation-presentation";
import { ObservationRow } from "./observation-row";
import { buildTimelineRows, ObservationTimeline } from "./observation-timeline";

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

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class ResizeObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    VirtualizerHarness.count = 0;
    VirtualizerHarness.initialOffsets = [];
});

function makeObservation(id: string, overrides: Partial<Observation> = {}): Observation {
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

function makeTraceDetailFromObservation(observation: Observation): TraceDetail {
    return {
        trace: {
            id: "trace-1",
            name: "Live run",
            timestamp: "2026-07-19T00:00:00.000Z",
            environment: "test",
            tags: [],
            release: null,
            version: null,
            input: null,
            output: null,
            metadata: {},
            sessionId: "session-1",
            userId: null,
            status: "running",
        },
        observations: [observation],
        scores: [],
        corrections: [],
    };
}

function makeTraceDetailWithObservations(traceId: string, name: string, observations: Observation[]): TraceDetail {
    const detail = makeTraceDetailFromObservation(observations[0]);
    detail.trace = {
        ...detail.trace,
        id: traceId,
        name,
    };
    detail.observations = observations.map((observation) => ({ ...observation, traceId }));
    return detail;
}

function makeTraceDetailForRun(traceId: string, name: string, observationId: string): TraceDetail {
    const detail = makeTraceDetailFromObservation(
        makeObservation(observationId, { id: observationId, traceId, output: observationId })
    );
    detail.trace = {
        ...detail.trace,
        id: traceId,
        name,
        status: "success",
        endedAt: "2026-07-19T00:00:05.000Z",
    };
    return detail;
}

function renderTimeline(detail: TraceDetail, overrides: Record<string, unknown> = {}) {
    const props = {
        detail,
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

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("ObservationDetail real rerender", () => {
    it("clears copied feedback when switching observations", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const observationA = makeObservation("observation-a");
        const observationB = makeObservation("observation-b");
        const view = render(<ObservationDetail observation={observationA} traceTimestamp="2026-07-19T00:00:00.000Z" />);

        fireEvent.click(view.getByRole("button", { name: "Copy observation JSON" }));
        await waitFor(() => expect(view.getByRole("status").textContent).toBe("Copied"));

        view.rerender(<ObservationDetail observation={observationB} traceTimestamp="2026-07-19T00:00:00.000Z" />);

        expect(view.getByRole("button", { name: "Copy observation JSON" }).textContent).toBe("Copy");
        expect(view.queryByRole("status")).toBeNull();
    });

    it.each([
        ["resolves", (pending: ReturnType<typeof deferred<void>>) => pending.resolve()],
        ["rejects", (pending: ReturnType<typeof deferred<void>>) => pending.reject(new Error("denied"))],
    ])("ignores an old observation copy that %s after switching", async (_name, settle) => {
        const pending = deferred<void>();
        const writeText = vi.fn().mockReturnValue(pending.promise);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const observationA = makeObservation("observation-a");
        const observationB = makeObservation("observation-b");
        const view = render(<ObservationDetail observation={observationA} traceTimestamp="2026-07-19T00:00:00.000Z" />);

        fireEvent.click(view.getByRole("button", { name: "Copy observation JSON" }));
        view.rerender(<ObservationDetail observation={observationB} traceTimestamp="2026-07-19T00:00:00.000Z" />);
        await act(async () => {
            settle(pending);
            await pending.promise.catch(() => undefined);
        });

        expect(view.getByRole("button", { name: "Copy observation JSON" }).textContent).toBe("Copy");
        expect(view.queryByRole("status")).toBeNull();
    });
});

describe("ObservationTimeline real events", () => {
    it("reuses the stable row prefix when only the active generation tail streams", () => {
        const detail = makeTraceDetailWithObservations("trace-cache", "Cached run", [
            makeObservation("first", {
                type: "EVENT",
                name: "model_change",
                endTime: "2026-07-19T00:00:01.000Z",
            }),
            makeObservation("second", {
                type: "TOOL",
                name: "read_file",
                endTime: "2026-07-19T00:00:02.000Z",
            }),
            makeObservation("generation", {
                output: "first token",
                endTime: null,
                startTime: "2026-07-19T00:00:03.000Z",
            }),
        ]);
        const first = buildTimelineRows(detail);
        const updated = buildTimelineRows(
            {
                ...detail,
                observations: detail.observations.map((observation) => ({
                    ...observation,
                    output: observation.id === "generation" ? "first token second token" : observation.output,
                })),
            },
            first
        );

        expect(updated.rows[0]).toBe(first.rows[0]);
        expect(updated.rows[1]).toBe(first.rows[1]);
        expect(updated.rows[2]).not.toBe(first.rows[2]);
    });

    it("rebuilds the prefix when an earlier observation is still active", () => {
        const detail = makeTraceDetailWithObservations("trace-active-prefix", "Active prefix run", [
            makeObservation("tool", {
                type: "TOOL",
                name: "read_file",
                output: null,
                endTime: null,
            }),
            makeObservation("generation", {
                output: "first token",
                endTime: null,
                startTime: "2026-07-19T00:00:03.000Z",
            }),
        ]);
        const first = buildTimelineRows(detail);
        const updated = buildTimelineRows(
            {
                ...detail,
                observations: detail.observations.map((observation) => ({
                    ...observation,
                    endTime: observation.id === "tool" ? "2026-07-19T00:00:04.000Z" : observation.endTime,
                    output: observation.id === "tool" ? "file contents" : "first token second token",
                })),
            },
            first
        );

        expect(updated.rows[0]).not.toBe(first.rows[0]);
        expect(updated.rows[0].presentation.summary).toBe("file contents");
    });

    it("sticks to the live tail when the last observation content grows without adding a row", () => {
        VirtualizerHarness.scrollToIndex.mockClear();
        const observation = makeObservation("generation");
        const view = renderTimeline(makeTraceDetailFromObservation(observation));
        const callsAfterFirstRender = VirtualizerHarness.scrollToIndex.mock.calls.length;

        view.rerender(
            <Timeline
                {...view.props}
                detail={makeTraceDetailFromObservation({
                    ...observation,
                    output: "first chunk and streamed second chunk",
                })}
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
    ] satisfies Array<[string, Partial<Observation>]>) {
        it(`sticks to the live tail when the visible ${badgeName} badge changes`, () => {
            const observation = makeObservation("generation");
            const view = renderTimeline(makeTraceDetailFromObservation(observation));
            const callsAfterFirstRender = VirtualizerHarness.scrollToIndex.mock.calls.length;

            view.rerender(
                <Timeline {...view.props} detail={makeTraceDetailFromObservation({ ...observation, ...overrides })} />
            );

            expect(VirtualizerHarness.scrollToIndex.mock.calls.length).toBeGreaterThan(callsAfterFirstRender);
            view.unmount();
        });
    }

    it("dispatches keyboard and scroll behavior through DOM events", () => {
        const onSelectObservation = vi.fn();
        const onPauseFollowLive = vi.fn();
        const onScrollOffsetChange = vi.fn();
        const view = renderTimeline(makeTraceDetailFromObservation(makeObservation("generation")), {
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
    it("renders the Langfuse trace workspace and switches between tree and timeline", async () => {
        VirtualizerHarness.count = 0;
        const detail = makeTraceDetailWithObservations("trace-panel", "Panel run", [
            makeObservation("root", {
                type: "AGENT",
                name: "Agent run",
                parentObservationId: null,
            }),
            makeObservation("generation", {
                name: "Generate answer",
                parentObservationId: "root",
            }),
        ]);
        const api: AgentObservabilityApi = {
            listTraces: vi.fn().mockResolvedValue([detail.trace]),
            getTrace: vi.fn().mockResolvedValue(detail),
            subscribe: vi.fn(() => vi.fn()),
        };
        const view = render(<ObservabilityPanel api={api} sessionId="session-a" magnified />);

        await waitFor(() => expect(view.getByRole("tree", { name: "Trace tree" })).toBeTruthy());
        expect(VirtualizerHarness.count).toBe(3);
        expect(view.getByRole("region", { name: "Trace detail" })).toBeTruthy();
        expect(view.getByRole("region", { name: "Trace graph" })).toBeTruthy();

        const graphToggle = view.getByRole("button", { name: "Graph" });
        fireEvent.click(graphToggle);
        expect(view.getByRole("button", { name: "Graph" }).getAttribute("aria-expanded")).toBe("false");
        fireEvent.click(view.getByRole("button", { name: "Graph" }));
        expect(view.getByRole("button", { name: "Graph" }).getAttribute("aria-expanded")).toBe("true");

        fireEvent.click(view.getByRole("button", { name: "Timeline" }));

        expect(view.getByRole("region", { name: "Trace timeline" })).toBeTruthy();
        expect(view.queryByRole("tree", { name: "Trace tree" })).toBeNull();
    });

    it("reveals a selection made from the tree when switching to timeline", async () => {
        const scrollTo = vi.fn();
        Object.defineProperty(HTMLElement.prototype, "scrollTo", {
            configurable: true,
            value: scrollTo,
        });
        const detail = makeTraceDetailWithObservations("trace-reveal", "Reveal run", [
            makeObservation("root", {
                type: "AGENT",
                name: "Agent run",
                parentObservationId: null,
            }),
            makeObservation("tool", {
                type: "TOOL",
                name: "read_file",
                parentObservationId: "root",
                startTime: "2026-07-19T00:00:03.000Z",
            }),
        ]);
        const api: AgentObservabilityApi = {
            listTraces: vi.fn().mockResolvedValue([detail.trace]),
            getTrace: vi.fn().mockResolvedValue(detail),
            subscribe: vi.fn(() => vi.fn()),
        };
        const view = render(<ObservabilityPanel api={api} sessionId="session-a" magnified />);
        await waitFor(() => expect(view.getByRole("tree", { name: "Trace tree" })).toBeTruthy());

        fireEvent.click(view.getByRole("button", { name: /read_file/i }));
        VirtualizerHarness.scrollToIndex.mockClear();
        fireEvent.click(view.getByRole("button", { name: "Timeline" }));

        await waitFor(() =>
            expect(VirtualizerHarness.scrollToIndex).toHaveBeenCalledWith(2, {
                align: "center",
                behavior: "auto",
            })
        );
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: expect.any(Number) }));
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it("switches from tree to the Langfuse search list instead of filtering tree rows", async () => {
        const detail = makeTraceDetailWithObservations("trace-search", "Search run", [
            makeObservation("root", {
                type: "AGENT",
                name: "Agent run",
                parentObservationId: null,
            }),
            makeObservation("tool", {
                type: "TOOL",
                name: "Read source",
                parentObservationId: "root",
            }),
        ]);
        const api: AgentObservabilityApi = {
            listTraces: vi.fn().mockResolvedValue([detail.trace]),
            getTrace: vi.fn().mockResolvedValue(detail),
            subscribe: vi.fn(() => vi.fn()),
        };
        const view = render(<ObservabilityPanel api={api} sessionId="session-a" magnified />);
        await waitFor(() => expect(view.getByRole("tree", { name: "Trace tree" })).toBeTruthy());

        fireEvent.change(view.getByLabelText("Search trace"), { target: { value: "read" } });

        await waitFor(() => expect(view.queryByRole("tree", { name: "Trace tree" })).toBeNull());
        expect(view.getByRole("listbox", { name: "Trace search results" })).toBeTruthy();
        expect(view.getByRole("button", { name: /Read source/ })).toBeTruthy();
    });

    it("shows observation detail when a Langfuse tree node is selected", async () => {
        const detail = makeTraceDetailWithObservations("trace-selection", "Selection run", [
            makeObservation("root", {
                type: "AGENT",
                name: "Agent run",
                parentObservationId: null,
            }),
            makeObservation("tool", {
                type: "TOOL",
                name: "Read source",
                parentObservationId: "root",
                input: { path: "src/main.ts" },
                output: "source",
            }),
        ]);
        const api: AgentObservabilityApi = {
            listTraces: vi.fn().mockResolvedValue([detail.trace]),
            getTrace: vi.fn().mockResolvedValue(detail),
            subscribe: vi.fn(() => vi.fn()),
        };
        const view = render(<ObservabilityPanel api={api} sessionId="session-a" magnified />);

        await waitFor(() => expect(view.getByRole("tree", { name: "Trace tree" })).toBeTruthy());
        fireEvent.click(view.getByRole("button", { name: /Read source/ }));

        expect(view.getByRole("region", { name: "Observation detail" })).toBeTruthy();
        expect(view.getAllByText(/src\/main\.ts/).length).toBeGreaterThan(0);
    });

    it("handles the complete timeline keyboard contract through DOM events", async () => {
        const detail = makeTraceDetailWithObservations("trace-keys", "Keyboard run", [
            makeObservation("first", { name: "first step", startTime: "2026-07-19T00:00:01.000Z" }),
            makeObservation("second", { name: "second step", startTime: "2026-07-19T00:00:02.000Z" }),
            makeObservation("third", { name: "third step", startTime: "2026-07-19T00:00:03.000Z" }),
        ]);
        const api: AgentObservabilityApi = {
            listTraces: vi.fn().mockResolvedValue([detail.trace]),
            getTrace: vi.fn().mockResolvedValue(detail),
            subscribe: vi.fn(() => vi.fn()),
        };
        const view = render(<ObservabilityPanel api={api} sessionId="session-a" />);
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
        const detail = makeTraceDetailWithObservations("trace-live", "Live run", [
            makeObservation("first", { name: "first step", startTime: "2026-07-19T00:00:01.000Z" }),
            makeObservation("second", { name: "second step", startTime: "2026-07-19T00:00:02.000Z" }),
            makeObservation("third", { name: "third step", startTime: "2026-07-19T00:00:03.000Z" }),
        ]);
        const api: AgentObservabilityApi = {
            listTraces: vi.fn().mockResolvedValue([detail.trace]),
            getTrace: vi.fn().mockResolvedValue(detail),
            subscribe: vi.fn(() => vi.fn()),
        };
        const view = render(<ObservabilityPanel api={api} sessionId="session-a" />);
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
        const first = makeTraceDetailForRun("trace-1", "First run", "first-observation");
        const second = makeTraceDetailForRun("trace-2", "Second run", "second-observation");
        const api: AgentObservabilityApi = {
            listTraces: vi.fn().mockResolvedValue([first.trace, second.trace]),
            getTrace: vi.fn(async (traceId) => (traceId === first.trace.id ? first : second)),
            subscribe: vi.fn(() => vi.fn()),
        };
        const view = render(<ObservabilityPanel api={api} sessionId="session-a" />);
        await waitFor(() => expect(view.getByText("first-observation")).toBeTruthy());

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
        await waitFor(() => expect(view.getByText("second-observation")).toBeTruthy());
        expect(view.queryByText("Back to live")).toBeNull();
        expect(view.getByRole("button", { name: /Assistant Response/ }).getAttribute("aria-expanded")).toBe("false");
        fireEvent.change(view.getByLabelText("Recent Runs"), { target: { value: "trace-1" } });
        await waitFor(() => expect(view.getAllByText("first-observation").length).toBeGreaterThan(0));

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
                    traceTimestamp="2026-07-19T00:00:00.000Z"
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
