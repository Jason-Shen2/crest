import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ObservabilityPanel, type AgentObservabilityApi } from "./observability-panel";
import { ObservationDetail } from "./observation-detail";
import { ObservationTimeline } from "./observation-timeline";
import { RunReview } from "./run-review";
import { TimelineToolbar } from "./timeline-toolbar";
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

function renderPanel(api?: AgentObservabilityApi, magnified = false): ReactElement {
    HookHarness.cursor = 0;
    return ObservabilityPanel({ api, magnified });
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

function findElementByAriaLabel<P>(node: ReactNode, ariaLabel: string): ReactElement<P> | undefined {
    if (!isValidElement(node)) {
        return undefined;
    }
    if ((node.props as { "aria-label"?: string })["aria-label"] === ariaLabel) {
        return node as ReactElement<P>;
    }
    for (const child of Children.toArray((node.props as { children?: ReactNode }).children)) {
        const match = findElementByAriaLabel<P>(child, ariaLabel);
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

describe("ObservationDetail", () => {
    it("renders only structured sections backed by observation data", () => {
        const observation = makeObservation("tool", "TOOL", {
            name: "read",
            model: "claude-sonnet",
            input: { path: "README.md" },
            output: "contents",
            metadata: { cwd: "/repo" },
            usageDetails: { input: 20 },
            costDetails: { total: 0.0125 },
            statusMessage: "complete",
        });
        const markup = renderToStaticMarkup(
            <ObservationDetail observation={observation} traceTimestamp="2026-07-19T00:00:00.000Z" />
        );

        expect(markup).toContain('aria-label="Observation detail"');
        expect(markup).toContain("Overview");
        expect(markup).toContain("+1.0s");
        expect(markup).toContain("1 s");
        expect(markup).toContain("Input");
        expect(markup).toContain("Output");
        expect(markup).toContain("Usage");
        expect(markup).toContain("Metadata");
        expect(markup).toContain("Raw");

        HookHarness.cursor = 0;
        const sparseMarkup = renderToStaticMarkup(
            <ObservationDetail
                observation={makeObservation("event", "EVENT")}
                traceTimestamp="2026-07-19T00:00:00.000Z"
            />
        );
        expect(sparseMarkup).not.toContain(">Input<");
        expect(sparseMarkup).not.toContain(">Output<");
        expect(sparseMarkup).not.toContain(">Usage<");
        expect(sparseMarkup).not.toContain(">Metadata<");
    });

    it.each([
        ["Latency", { latency: 0.042 }, "42 ms"],
        ["TTFT", { timeToFirstToken: 0.125 }, "125 ms"],
    ] as const)("renders %s as usage without usage or cost entries", (label, timing, expectedValue) => {
        const observation = makeObservation("generation", "GENERATION", {
            ...timing,
            usageDetails: {},
            costDetails: {},
        });
        const markup = renderToStaticMarkup(
            <ObservationDetail observation={observation} traceTimestamp="2026-07-19T00:00:00.000Z" />
        );

        expect(markup).toContain(">Usage<");
        expect(markup).toContain(label);
        expect(markup).toContain(expectedValue);
    });

    it("copies complete observation JSON", async () => {
        const observation = makeObservation("tool", "TOOL", {
            input: { path: "README.md" },
            metadata: { cwd: "/repo" },
        });
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const detail = ObservationDetail({ observation, traceTimestamp: "2026-07-19T00:00:00.000Z" });
        const copyButton = findElementByAriaLabel<{ onClick: () => void }>(detail, "Copy observation JSON");

        copyButton?.props.onClick();
        await flushPromises();

        expect(writeText).toHaveBeenCalledWith(JSON.stringify(observation, null, 2));
        vi.unstubAllGlobals();
    });

    it("toggles raw JSON wrapping without creating dashboard state", () => {
        const observation = makeObservation("tool", "TOOL", { input: { path: "README.md" } });
        HookHarness.cursor = 0;
        let detail = ObservationDetail({ observation, traceTimestamp: "2026-07-19T00:00:00.000Z" });
        expect(renderToStaticMarkup(detail)).toContain("whitespace-pre");
        const wrapButton = findElementByAriaLabel<{ onClick: () => void }>(detail, "Wrap raw JSON");

        wrapButton?.props.onClick();
        HookHarness.cursor = 0;
        detail = ObservationDetail({ observation, traceTimestamp: "2026-07-19T00:00:00.000Z" });

        expect(renderToStaticMarkup(detail)).toContain("whitespace-pre-wrap");
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

    it("renders a semantic timeline without repeating the agent root", async () => {
        const graph = makeGraph(makeTrace("trace-2", "Latest run"));
        graph.observations = [
            makeObservation("root", "AGENT", {
                name: "Agent root",
                parentObservationId: null,
                startTime: "2026-07-19T00:00:00.000Z",
                endTime: "2026-07-19T00:00:05.000Z",
            }),
            makeObservation("generation", "GENERATION", {
                name: "assistant response",
                model: "claude-sonnet",
                output: "Implemented the requested timeline",
                usageDetails: { input: 20, output: 8, totalTokens: 28 },
            }),
        ];
        const { api } = makeApi([graph.trace], async () => graph);

        renderPanel(api);
        await flushPromises();
        const markup = renderToStaticMarkup(renderPanel(api));

        expect(markup).toContain("Timeline");
        expect(markup).not.toContain("Agent root");
        expect(markup).toContain(">All<");
        expect(markup).toContain("+1.0s");
        expect(markup).toContain("Implemented the requested timeline");
        expect(markup).toContain("1 s");
        expect(markup).toContain("claude-sonnet");
        expect(markup).toContain("28 tokens");
    });

    it("renders selected observation detail inline in normal mode", async () => {
        const graph = makeGraph(makeTrace("trace-2", "Latest run"));
        const { api } = makeApi([graph.trace], async () => graph);

        renderPanel(api);
        await flushPromises();
        let tree = renderPanel(api);
        const timelineControls = findElement<{
            onSelectObservation: (observationId?: string) => void;
            onToggleExpanded: (observationId: string) => void;
        }>(tree, ObservationTimeline);
        timelineControls?.props.onSelectObservation("tool");
        timelineControls?.props.onToggleExpanded("tool");
        tree = renderPanel(api);
        const timeline = findElement<{ renderInlineDetails: boolean }>(tree, ObservationTimeline);
        const markup = renderToStaticMarkup(tree);

        expect(timeline?.props.renderInlineDetails).toBe(true);
        expect(markup).toContain('aria-label="Observation detail"');
        expect(markup).not.toContain('aria-label="Observation detail pane"');
    });

    it("renders selected observation detail in a sibling pane when magnified", async () => {
        const graph = makeGraph(makeTrace("trace-2", "Latest run"));
        const { api } = makeApi([graph.trace], async () => graph);

        renderPanel(api, true);
        await flushPromises();
        let tree = renderPanel(api, true);
        findElement<{ onSelectObservation: (observationId?: string) => void }>(
            tree,
            ObservationTimeline
        )?.props.onSelectObservation("tool");
        tree = renderPanel(api, true);
        const timeline = findElement<{ renderInlineDetails: boolean }>(tree, ObservationTimeline);
        const markup = renderToStaticMarkup(tree);

        expect(timeline?.props.renderInlineDetails).toBe(false);
        expect(markup).toContain('aria-label="Observation detail pane"');
        expect(markup).toContain('aria-label="Observation detail"');
    });

    it("composes search and error filtering and controls visible expansion", async () => {
        const graph = makeGraph(makeTrace("trace-2", "Latest run"));
        const { api } = makeApi([graph.trace], async () => graph);

        renderPanel(api);
        await flushPromises();
        let tree = renderPanel(api);
        let toolbar = findElement<{
            onQueryChange: (query: string) => void;
            onToggleCategory: (category: "generation" | "tool" | "lifecycle" | "error") => void;
            onExpandAll: () => void;
            onCollapseAll: () => void;
        }>(tree, TimelineToolbar);
        toolbar?.props.onQueryChange("failed");
        toolbar?.props.onToggleCategory("generation");
        toolbar?.props.onToggleCategory("tool");
        toolbar?.props.onToggleCategory("lifecycle");
        let markup = renderToStaticMarkup(renderPanel(api));

        expect(markup).toContain("Failed once");
        expect(markup).not.toContain("No matching observations");

        tree = renderPanel(api);
        toolbar = findElement(tree, TimelineToolbar);
        toolbar?.props.onExpandAll();
        markup = renderToStaticMarkup(renderPanel(api));
        expect(markup).toContain('aria-expanded="true"');

        tree = renderPanel(api);
        toolbar = findElement(tree, TimelineToolbar);
        toolbar?.props.onCollapseAll();
        markup = renderToStaticMarkup(renderPanel(api));
        expect(markup).toContain('aria-expanded="false"');
    });

    it("pauses follow-live after scrolling away and resumes from the toolbar", async () => {
        const graph = makeGraph(makeTrace("trace-2", "Latest run"));
        const { api } = makeApi([graph.trace], async () => graph);

        renderPanel(api);
        await flushPromises();
        let tree = renderPanel(api);
        findElement<{ onPauseFollowLive: () => void }>(tree, ObservationTimeline)?.props.onPauseFollowLive();
        tree = renderPanel(api);
        let toolbar = findElement<{ showBackToLive: boolean; onBackToLive: () => void }>(tree, TimelineToolbar);

        expect(toolbar?.props.showBackToLive).toBe(true);
        toolbar?.props.onBackToLive();
        tree = renderPanel(api);
        toolbar = findElement(tree, TimelineToolbar);
        expect(toolbar?.props.showBackToLive).toBe(false);
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

    it("subscribes before listing and keeps a live graph over its stale snapshot", async () => {
        const calls: string[] = [];
        const snapshot = makeGraph(makeTrace("trace-3", "Snapshot run"));
        const live = makeGraph({
            ...makeTrace("trace-3", "Live run"),
            status: "running",
            endedAt: undefined,
        });
        const api: AgentObservabilityApi = {
            subscribe: vi.fn((_sessionId, callback) => {
                calls.push("subscribe");
                callback({ traceId: live.trace.id, sessionId: "session-1", graph: live });
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
        expect(findElement<{ traces: AgentObservabilityTrace[] }>(tree, TraceSelector)?.props.traces).toEqual([
            live.trace,
        ]);
        expect(findElement<{ graph: AgentObservabilityTraceGraph }>(tree, RunReview)?.props.graph).toBe(live);
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
