import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ObservabilityPanel, type AgentObservabilityApi } from "./observability-panel";
import { RunReview } from "./run-review";
import { TraceSelector } from "./trace-selector";

const HookHarness = vi.hoisted(() => ({
    slots: [] as unknown[],
    cursor: 0,
    effectRan: false,
    cleanup: undefined as void | (() => void),
}));

vi.mock("react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react")>();
    return {
        ...actual,
        useEffect: (effect: () => void | (() => void)) => {
            if (HookHarness.effectRan) {
                return;
            }
            HookHarness.effectRan = true;
            HookHarness.cleanup = effect();
        },
        useRef: <T,>(initial: T) => {
            const index = HookHarness.cursor++;
            if (!HookHarness.slots[index]) {
                HookHarness.slots[index] = { current: initial };
            }
            return HookHarness.slots[index] as { current: T };
        },
        useState: <T,>(initial: T) => {
            const index = HookHarness.cursor++;
            if (!(index in HookHarness.slots)) {
                HookHarness.slots[index] = initial;
            }
            const setValue = (next: T | ((current: T) => T)) => {
                HookHarness.slots[index] =
                    typeof next === "function" ? (next as (current: T) => T)(HookHarness.slots[index] as T) : next;
            };
            return [HookHarness.slots[index] as T, setValue] as const;
        },
    };
});

function makeTrace(id: string, name: string): AgentObservabilityTrace {
    return {
        id,
        name,
        timestamp: `2026-07-19T00:00:0${id.at(-1)}.000Z`,
        endedAt: "2026-07-19T00:00:10.000Z",
        environment: "test",
        tags: [],
        input: null,
        output: null,
        metadata: {},
        sessionId: "session-1",
        status: "success",
    };
}

function makeObservation(
    id: string,
    type: AgentObservabilityObservation["type"],
    overrides: Partial<AgentObservabilityObservation> = {}
): AgentObservabilityObservation {
    return {
        id,
        traceId: "trace-2",
        type,
        name: type.toLowerCase(),
        startTime: "2026-07-19T00:00:01.000Z",
        endTime: "2026-07-19T00:00:02.000Z",
        parentObservationId: "root",
        level: "DEFAULT",
        statusMessage: null,
        version: null,
        model: null,
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

function makeGraph(trace: AgentObservabilityTrace): AgentObservabilityTraceGraph {
    return {
        trace: {
            ...trace,
            timestamp: "2026-07-19T00:00:00.000Z",
            endedAt: "2026-07-19T00:00:05.000Z",
            output: "Review complete",
        },
        observations: [
            makeObservation("generation", "GENERATION", {
                usageDetails: { input: 20, output: 8, cacheRead: 4, cacheWrite: 2, totalTokens: 34 },
                costDetails: { total: 0.0125 },
            }),
            makeObservation("tool", "TOOL"),
            makeObservation("error", "EVENT", { level: "ERROR", statusMessage: "Failed once" }),
        ],
        scores: [],
    };
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

function makeApi(
    traces: AgentObservabilityTrace[],
    getTrace: (traceId: string) => Promise<AgentObservabilityTraceGraph | undefined>
) {
    let subscriber: ((event: AgentObservabilityEvent) => void) | undefined;
    const api: AgentObservabilityApi = {
        listTraces: vi.fn().mockResolvedValue(traces),
        getTrace: vi.fn(getTrace),
        subscribe: vi.fn((_sessionId, callback) => {
            subscriber = callback;
            return vi.fn();
        }),
    };
    return {
        api,
        emit(graph: AgentObservabilityTraceGraph) {
            subscriber?.({ traceId: graph.trace.id, sessionId: graph.trace.sessionId ?? undefined, graph });
        },
    };
}

function renderPanel(api?: AgentObservabilityApi): ReactElement {
    HookHarness.cursor = 0;
    return ObservabilityPanel({ api });
}

function findElement<P>(node: ReactNode, type: unknown): ReactElement<P> | undefined {
    if (!isValidElement(node)) {
        return undefined;
    }
    if (node.type === type) {
        return node as ReactElement<P>;
    }
    for (const child of Children.toArray((node.props as { children?: ReactNode }).children)) {
        const match = findElement<P>(child, type);
        if (match) {
            return match;
        }
    }
    return undefined;
}

async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
}

function cleanupPanel() {
    const cleanup = HookHarness.cleanup;
    if (typeof cleanup === "function") {
        cleanup();
    }
}

beforeEach(() => {
    cleanupPanel();
    HookHarness.slots = [];
    HookHarness.cursor = 0;
    HookHarness.effectRan = false;
    HookHarness.cleanup = undefined;
});

describe("TraceSelector", () => {
    it("renders recent runs and selects an older trace", () => {
        const onSelectTrace = vi.fn();
        const element = TraceSelector({
            traces: [makeTrace("trace-2", "Latest run"), makeTrace("trace-1", "Older run")],
            selectedTraceId: "trace-2",
            onSelectTrace,
        });
        const markup = renderToStaticMarkup(element);

        expect(markup).toContain("Recent Runs");
        expect(markup).toContain("Latest run");
        expect(markup).toContain("Older run");
        expect(markup).toContain('value="trace-2" selected=""');

        element.props.onChange({ currentTarget: { value: "trace-1" } });
        expect(onSelectTrace).toHaveBeenCalledWith("trace-1");
    });
});

describe("RunReview", () => {
    it("renders the run status, aggregate metrics, usage, cost, and final output", () => {
        const markup = renderToStaticMarkup(<RunReview graph={makeGraph(makeTrace("trace-2", "Latest run"))} />);

        expect(markup).toContain("Run Review");
        expect(markup).toContain("success");
        expect(markup).toContain("5.0s");
        expect(markup).toContain("Generations");
        expect(markup).toContain(">1<");
        expect(markup).toContain("Tools");
        expect(markup).toContain("Errors");
        expect(markup).toContain("Input tokens");
        expect(markup).toContain(">20<");
        expect(markup).toContain("Output tokens");
        expect(markup).toContain(">8<");
        expect(markup).toContain("Cache read");
        expect(markup).toContain(">4<");
        expect(markup).toContain("Cache write");
        expect(markup).toContain(">2<");
        expect(markup).toContain("Total tokens");
        expect(markup).toContain(">34<");
        expect(markup).toContain("$0.0125");
        expect(markup).toContain("Review complete");
    });
});

describe("ObservabilityPanel", () => {
    it("selects the latest trace initially and can select an older trace", async () => {
        const latest = makeGraph(makeTrace("trace-2", "Latest run"));
        const older = makeGraph(makeTrace("trace-1", "Older run"));
        const { api } = makeApi([latest.trace, older.trace], async (traceId) =>
            traceId === latest.trace.id ? latest : older
        );

        renderPanel(api);
        await flushPromises();
        let tree = renderPanel(api);
        expect(findElement<{ graph: AgentObservabilityTraceGraph }>(tree, RunReview)?.props.graph.trace.id).toBe(
            "trace-2"
        );

        findElement<{ onSelectTrace: (traceId: string) => void }>(tree, TraceSelector)?.props.onSelectTrace("trace-1");
        await flushPromises();
        tree = renderPanel(api);

        expect(findElement<{ graph: AgentObservabilityTraceGraph }>(tree, RunReview)?.props.graph.trace.id).toBe(
            "trace-1"
        );
    });

    it("ignores a stale trace response after a newer selection resolves", async () => {
        const latest = makeGraph(makeTrace("trace-3", "Latest run"));
        const older = makeGraph(makeTrace("trace-1", "Older run"));
        const newer = makeGraph(makeTrace("trace-2", "Newer run"));
        const first = deferred<AgentObservabilityTraceGraph | undefined>();
        const second = deferred<AgentObservabilityTraceGraph | undefined>();
        const { api } = makeApi([latest.trace, newer.trace, older.trace], (traceId) => {
            if (traceId === "trace-1") {
                return first.promise;
            }
            if (traceId === "trace-2") {
                return second.promise;
            }
            return Promise.resolve(latest);
        });

        renderPanel(api);
        await flushPromises();
        let tree = renderPanel(api);
        const selector = findElement<{ onSelectTrace: (traceId: string) => void }>(tree, TraceSelector);
        selector?.props.onSelectTrace("trace-1");
        selector?.props.onSelectTrace("trace-2");
        second.resolve(newer);
        await flushPromises();
        first.resolve(older);
        await flushPromises();
        tree = renderPanel(api);

        expect(findElement<{ graph: AgentObservabilityTraceGraph }>(tree, RunReview)?.props.graph.trace.id).toBe(
            "trace-2"
        );
    });

    it("updates recent runs without replacing a selected historical graph", async () => {
        const latest = makeGraph(makeTrace("trace-2", "Latest run"));
        const older = makeGraph(makeTrace("trace-1", "Older run"));
        const live = makeGraph({ ...makeTrace("trace-3", "Live run"), status: "running", endedAt: undefined });
        const source = makeApi([latest.trace, older.trace], async (traceId) =>
            traceId === latest.trace.id ? latest : older
        );

        renderPanel(source.api);
        await flushPromises();
        let tree = renderPanel(source.api);
        findElement<{ onSelectTrace: (traceId: string) => void }>(tree, TraceSelector)?.props.onSelectTrace("trace-1");
        await flushPromises();
        source.emit(live);
        tree = renderPanel(source.api);

        expect(findElement<{ graph: AgentObservabilityTraceGraph }>(tree, RunReview)?.props.graph.trace.id).toBe(
            "trace-1"
        );
        expect(
            findElement<{ traces: AgentObservabilityTrace[] }>(tree, TraceSelector)?.props.traces.map(
                (trace) => trace.id
            )
        ).toEqual(["trace-3", "trace-2", "trace-1"]);
    });

    it("keeps a live run received before the history request resolves", async () => {
        const history = makeGraph(makeTrace("trace-2", "History run"));
        const live = makeGraph({ ...makeTrace("trace-3", "Live run"), status: "running", endedAt: undefined });
        const listResponse = deferred<AgentObservabilityTrace[]>();
        const source = makeApi([], async () => history);
        source.api.listTraces = vi.fn(() => listResponse.promise);

        renderPanel(source.api);
        source.emit(live);
        listResponse.resolve([history.trace]);
        await flushPromises();
        const tree = renderPanel(source.api);

        expect(
            findElement<{ traces: AgentObservabilityTrace[] }>(tree, TraceSelector)?.props.traces.map(
                (trace) => trace.id
            )
        ).toEqual(["trace-3", "trace-2"]);
        expect(findElement<{ selectedTraceId?: string }>(tree, TraceSelector)?.props.selectedTraceId).toBe("trace-3");
        expect(findElement<{ graph: AgentObservabilityTraceGraph }>(tree, RunReview)?.props.graph.trace.id).toBe(
            "trace-3"
        );
    });

    it("ignores an in-flight trace response after unmount", async () => {
        const latest = makeGraph(makeTrace("trace-2", "Latest run"));
        const response = deferred<AgentObservabilityTraceGraph | undefined>();
        const { api } = makeApi([latest.trace], () => response.promise);

        renderPanel(api);
        await flushPromises();
        cleanupPanel();
        response.resolve(latest);
        await flushPromises();
        const tree = renderPanel(api);

        expect(findElement<{ graph: AgentObservabilityTraceGraph }>(tree, RunReview)).toBeUndefined();
    });

    it("distinguishes unavailable, loading, empty, and rejected states", async () => {
        expect(renderToStaticMarkup(renderPanel())).toContain("Observability is unavailable");

        cleanupPanel();
        HookHarness.slots = [];
        HookHarness.cursor = 0;
        HookHarness.effectRan = false;
        const pending = deferred<AgentObservabilityTrace[]>();
        const loading = makeApi([], async () => undefined);
        loading.api.listTraces = vi.fn(() => pending.promise);
        expect(renderToStaticMarkup(renderPanel(loading.api))).toContain("Loading recent runs");
        pending.resolve([]);
        await flushPromises();
        expect(renderToStaticMarkup(renderPanel(loading.api))).toContain("No runs recorded");

        cleanupPanel();
        HookHarness.slots = [];
        HookHarness.cursor = 0;
        HookHarness.effectRan = false;
        const rejected = makeApi([], async () => undefined);
        rejected.api.listTraces = vi.fn().mockRejectedValue(new Error("storage failed"));
        renderPanel(rejected.api);
        await flushPromises();
        expect(renderToStaticMarkup(renderPanel(rejected.api))).toContain("Unable to load recent runs");
    });
});
