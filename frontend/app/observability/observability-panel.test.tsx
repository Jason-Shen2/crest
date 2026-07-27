import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TraceBuilder } from "@crest/coding-agent/observability/trace-builder";
import { ObservabilityPanel, type AgentObservabilityApi } from "./observability-panel";
import { TracePanel } from "./trace-panel/trace-panel";
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
        useState: <T,>(initial: T | (() => T)) => {
            const index = HookHarness.cursor++;
            if (!(index in HookHarness.slots)) {
                HookHarness.slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
            }
            const setValue = (next: T | ((current: T) => T)) => {
                HookHarness.slots[index] =
                    typeof next === "function" ? (next as (current: T) => T)(HookHarness.slots[index] as T) : next;
            };
            return [HookHarness.slots[index] as T, setValue] as const;
        },
    };
});

function makeTrace(id: string, name: string): Trace {
    return {
        id,
        name,
        timestamp: `2026-07-19T00:00:0${id.at(-1)}.000Z`,
        endedAt: "2026-07-19T00:00:10.000Z",
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
    };
}

function makeBuiltTrace(prompt: string, timestamp: string): Trace {
    let nextId = 0;
    const idScope = prompt.replaceAll(/\W+/g, "-").toLowerCase();
    const builder = new TraceBuilder({
        createId: (prefix) => `${prefix}-${idScope}-${++nextId}`,
        now: () => timestamp,
    });
    const sessionPath = `/tmp/${idScope}.db`;
    builder.applyEvent({ sessionPath, event: { type: "agent_start" } });
    builder.applyEvent({
        sessionPath,
        event: {
            type: "message_end",
            message: { role: "user", content: [{ type: "text", text: prompt }] },
        },
    });
    const detail = builder.applyEvent({ sessionPath, event: { type: "agent_end" } });
    expect(detail).toBeDefined();
    return detail!.trace;
}

function makeObservation(id: string, type: Observation["type"], overrides: Partial<Observation> = {}): Observation {
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

function makeTraceDetail(trace: Trace): TraceDetail {
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
        corrections: [],
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

function makeApi(traces: Trace[], getTrace: (traceId: string) => Promise<TraceDetail | undefined>) {
    let subscriber: ((event: TraceEvent) => void) | undefined;
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
        emit(detail: TraceDetail) {
            subscriber?.({ traceId: detail.trace.id, sessionId: detail.trace.sessionId ?? undefined, detail });
        },
    };
}

function renderPanel(api?: AgentObservabilityApi, magnified = false, sessionId = "session-1"): ReactElement {
    HookHarness.cursor = 0;
    return ObservabilityPanel({ api, magnified, sessionId } as Parameters<typeof ObservabilityPanel>[0] & {
        sessionId?: string;
    });
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
    vi.unstubAllGlobals();
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

    it("distinguishes recent runs built from real agent events", () => {
        const first = makeBuiltTrace("Review authentication flow", "2026-07-19T08:15:00.000Z");
        const second = makeBuiltTrace("Fix search indexing", "2026-07-19T09:30:00.000Z");

        const markup = renderToStaticMarkup(
            <TraceSelector traces={[second, first]} selectedTraceId={second.id} onSelectTrace={vi.fn()} />
        );

        expect(markup).toContain("Review authentication flow");
        expect(markup).toContain("2026-07-19 08:15");
        expect(markup).toContain("Fix search indexing");
        expect(markup).toContain("2026-07-19 09:30");
    });
});

describe("ObservabilityPanel", () => {
    it("defines opaque local surfaces without changing shared panel colors", () => {
        const markup = renderToStaticMarkup(renderPanel());

        expect(markup).toContain("--observability-panel-bg:rgb(from var(--color-panel) r g b / 90%)");
        expect(markup).toContain("--observability-workspace-bg:rgb(from var(--color-panel) r g b / 92%)");
        expect(markup).toContain("--observability-drawer-bg:rgb(from var(--color-panel) r g b / 96%)");
        expect(markup).toContain("bg-[var(--observability-panel-bg)]");
    });

    it("does not call observability APIs without a session scope", async () => {
        const { api } = makeApi([], async () => undefined);
        HookHarness.cursor = 0;

        const markup = renderToStaticMarkup(ObservabilityPanel({ api }));
        await flushPromises();

        expect(markup).toContain("Observability is unavailable");
        expect(api.subscribe).not.toHaveBeenCalled();
        expect(api.listTraces).not.toHaveBeenCalled();
        expect(api.getTrace).not.toHaveBeenCalled();
    });

    it("uses the same session scope for list, subscribe, and get", async () => {
        const detail = makeTraceDetail(makeTrace("trace-2", "Latest run"));
        const { api } = makeApi([detail.trace], async () => detail);

        renderPanel(api, false, "session-1");
        await flushPromises();

        expect(api.subscribe).toHaveBeenCalledWith("session-1", expect.any(Function));
        expect(api.listTraces).toHaveBeenCalledWith("session-1");
        expect(api.getTrace).toHaveBeenCalledWith("trace-2", "session-1");
    });

    it("selects the latest trace initially and can select an older trace", async () => {
        const latest = makeTraceDetail(makeTrace("trace-2", "Latest run"));
        const older = makeTraceDetail(makeTrace("trace-1", "Older run"));
        const { api } = makeApi([latest.trace, older.trace], async (traceId) =>
            traceId === latest.trace.id ? latest : older
        );

        renderPanel(api);
        await flushPromises();
        let tree = renderPanel(api);
        expect(findElement<{ detail: TraceDetail }>(tree, TracePanel)?.props.detail.trace.id).toBe("trace-2");

        findElement<{ onSelectTrace: (traceId: string) => void }>(tree, TraceSelector)?.props.onSelectTrace("trace-1");
        await flushPromises();
        tree = renderPanel(api);

        expect(findElement<{ detail: TraceDetail }>(tree, TracePanel)?.props.detail.trace.id).toBe("trace-1");
    });

    it.each([
        [false, "compact"],
        [true, "desktop"],
    ] as const)("renders the shared trace panel with magnified=%s using the %s layout", async (magnified, layout) => {
        const detail = makeTraceDetail(makeTrace("trace-2", "Latest run"));
        const { api } = makeApi([detail.trace], async () => detail);

        renderPanel(api, magnified);
        await flushPromises();
        const tree = renderPanel(api, magnified);
        const tracePanel = findElement<{ detail: TraceDetail; layout: "compact" | "desktop" }>(tree, TracePanel);

        expect(tracePanel?.props.detail).toBe(detail);
        expect(tracePanel?.props.layout).toBe(layout);
    });

    it("ignores a stale trace response after a newer selection resolves", async () => {
        const latest = makeTraceDetail(makeTrace("trace-3", "Latest run"));
        const older = makeTraceDetail(makeTrace("trace-1", "Older run"));
        const newer = makeTraceDetail(makeTrace("trace-2", "Newer run"));
        const first = deferred<TraceDetail | undefined>();
        const second = deferred<TraceDetail | undefined>();
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

        expect(findElement<{ detail: TraceDetail }>(tree, TracePanel)?.props.detail.trace.id).toBe("trace-2");
    });

    it("updates recent runs without replacing a selected historical detail", async () => {
        const latest = makeTraceDetail(makeTrace("trace-2", "Latest run"));
        const older = makeTraceDetail(makeTrace("trace-1", "Older run"));
        const live = makeTraceDetail({ ...makeTrace("trace-3", "Live run"), status: "running", endedAt: undefined });
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

        expect(findElement<{ detail: TraceDetail }>(tree, TracePanel)?.props.detail.trace.id).toBe("trace-1");
        expect(findElement<{ traces: Trace[] }>(tree, TraceSelector)?.props.traces.map((trace) => trace.id)).toEqual([
            "trace-3",
            "trace-2",
            "trace-1",
        ]);
    });

    it("keeps a live run received before the history request resolves", async () => {
        const history = makeTraceDetail(makeTrace("trace-2", "History run"));
        const live = makeTraceDetail({ ...makeTrace("trace-3", "Live run"), status: "running", endedAt: undefined });
        const listResponse = deferred<Trace[]>();
        const source = makeApi([], async () => history);
        source.api.listTraces = vi.fn(() => listResponse.promise);

        renderPanel(source.api);
        source.emit(live);
        listResponse.resolve([history.trace]);
        await flushPromises();
        const tree = renderPanel(source.api);

        expect(findElement<{ traces: Trace[] }>(tree, TraceSelector)?.props.traces.map((trace) => trace.id)).toEqual([
            "trace-3",
            "trace-2",
        ]);
        expect(findElement<{ selectedTraceId?: string }>(tree, TraceSelector)?.props.selectedTraceId).toBe("trace-3");
        expect(findElement<{ detail: TraceDetail }>(tree, TracePanel)?.props.detail.trace.id).toBe("trace-3");
    });

    it("subscribes before listing and keeps a live detail over its stale snapshot", async () => {
        const calls: string[] = [];
        const snapshot = makeTraceDetail(makeTrace("trace-3", "Snapshot run"));
        const live = makeTraceDetail({
            ...makeTrace("trace-3", "Live run"),
            status: "running",
            endedAt: undefined,
        });
        const api: AgentObservabilityApi = {
            subscribe: vi.fn((_sessionId, callback) => {
                calls.push("subscribe");
                callback({ traceId: live.trace.id, sessionId: "session-1", detail: live });
                return vi.fn();
            }),
            listTraces: vi.fn(async () => {
                calls.push("list");
                return [snapshot.trace];
            }),
            getTrace: vi.fn(async () => snapshot),
        };

        renderPanel(api);
        await flushPromises();
        const tree = renderPanel(api);

        expect(calls).toEqual(["subscribe", "list"]);
        expect(api.getTrace).not.toHaveBeenCalled();
        expect(findElement<{ traces: Trace[] }>(tree, TraceSelector)?.props.traces).toEqual([live.trace]);
        expect(findElement<{ detail: TraceDetail }>(tree, TracePanel)?.props.detail).toBe(live);
    });

    it("ignores an in-flight trace response after unmount", async () => {
        const latest = makeTraceDetail(makeTrace("trace-2", "Latest run"));
        const response = deferred<TraceDetail | undefined>();
        const { api } = makeApi([latest.trace], () => response.promise);

        renderPanel(api);
        await flushPromises();
        cleanupPanel();
        response.resolve(latest);
        await flushPromises();
        const tree = renderPanel(api);

        expect(findElement<{ detail: TraceDetail }>(tree, TracePanel)).toBeUndefined();
    });

    it("distinguishes unavailable, loading, empty, and rejected states", async () => {
        expect(renderToStaticMarkup(renderPanel())).toContain("Observability is unavailable");

        cleanupPanel();
        HookHarness.slots = [];
        HookHarness.cursor = 0;
        HookHarness.effectRan = false;
        const pending = deferred<Trace[]>();
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
