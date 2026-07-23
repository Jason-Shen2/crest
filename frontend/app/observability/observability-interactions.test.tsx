// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ObservabilityPanel, type AgentObservabilityApi } from "./observability-panel";

const VirtualizerHarness = vi.hoisted(() => ({
    scrollToIndex: vi.fn(),
    scrollToOffset: vi.fn(),
    measure: vi.fn(),
    count: 0,
    initialOffsets: [] as number[],
}));
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

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

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
            expect(scrollTo).toHaveBeenCalledWith(
                expect.objectContaining({ top: expect.any(Number), left: expect.any(Number) })
            )
        );
        expect(VirtualizerHarness.scrollToIndex).not.toHaveBeenCalled();
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

    it("renders the shared compact trace tree without a detail drawer or graph", async () => {
        const detail = makeTraceDetailWithObservations("trace-compact", "Compact run", [
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
        const view = render(<ObservabilityPanel api={api} sessionId="session-a" />);

        await waitFor(() => expect(view.getByRole("tree", { name: "Trace tree" })).toBeTruthy());

        expect(view.getByTestId("trace-layout-compact")).toBeTruthy();
        expect(view.queryByRole("region", { name: "Trace detail drawer" })).toBeNull();
        expect(view.queryByRole("region", { name: "Trace graph" })).toBeNull();
    });

    it("opens the compact detail drawer for a selected observation", async () => {
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
        const view = render(<ObservabilityPanel api={api} sessionId="session-a" />);

        await waitFor(() => expect(view.getByRole("tree", { name: "Trace tree" })).toBeTruthy());
        fireEvent.click(view.getByRole("button", { name: /Read source/ }));

        expect(view.getByRole("region", { name: "Trace detail drawer" })).toBeTruthy();
        expect(view.getByRole("region", { name: "Observation detail" })).toBeTruthy();
    });

    it("restores compact observation selection after switching traces without reopening the drawer", async () => {
        const traceA = makeTraceDetailWithObservations("trace-a", "Trace A", [
            makeObservation("root-a", {
                type: "AGENT",
                name: "Agent A",
                parentObservationId: null,
            }),
            makeObservation("observation-a", {
                type: "TOOL",
                name: "Read A",
                parentObservationId: "root-a",
            }),
        ]);
        const traceB = makeTraceDetailWithObservations("trace-b", "Trace B", [
            makeObservation("root-b", {
                type: "AGENT",
                name: "Agent B",
                parentObservationId: null,
            }),
            makeObservation("observation-b", {
                type: "TOOL",
                name: "Read B",
                parentObservationId: "root-b",
            }),
        ]);
        const traceBResponse = deferred<TraceDetail | undefined>();
        const returningTraceAResponse = deferred<TraceDetail | undefined>();
        let traceARequests = 0;
        const api: AgentObservabilityApi = {
            listTraces: vi.fn().mockResolvedValue([traceA.trace, traceB.trace]),
            getTrace: vi.fn((traceId) => {
                if (traceId === traceB.trace.id) {
                    return traceBResponse.promise;
                }
                traceARequests += 1;
                return traceARequests === 1 ? Promise.resolve(traceA) : returningTraceAResponse.promise;
            }),
            subscribe: vi.fn(() => vi.fn()),
        };
        const view = render(<ObservabilityPanel api={api} sessionId="session-a" />);

        const observationA = await view.findByRole("treeitem", { name: /Read A/ });
        fireEvent.click(observationA);
        expect(observationA.getAttribute("aria-selected")).toBe("true");
        expect(view.getByRole("region", { name: "Trace detail drawer" })).toBeTruthy();

        fireEvent.change(view.getByLabelText("Recent Runs"), { target: { value: traceB.trace.id } });
        expect(view.getByText("Loading recent runs...")).toBeTruthy();
        expect(view.queryByRole("treeitem", { name: /Read A/ })).toBeNull();
        traceBResponse.resolve(traceB);
        await view.findByRole("treeitem", { name: /Read B/ });

        fireEvent.change(view.getByLabelText("Recent Runs"), { target: { value: traceA.trace.id } });
        expect(view.getByText("Loading recent runs...")).toBeTruthy();
        expect(view.queryByRole("treeitem", { name: /Read B/ })).toBeNull();
        returningTraceAResponse.resolve(traceA);
        const restoredObservationA = await view.findByRole("treeitem", { name: /Read A/ });

        expect(restoredObservationA.getAttribute("aria-selected")).toBe("true");
        expect(view.queryByRole("region", { name: "Trace detail drawer" })).toBeNull();
    });
});
