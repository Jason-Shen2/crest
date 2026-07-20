import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TraceBuilder } from "../../../emain/agent/observability/trace-builder";
import { ObservabilityPanel, type AgentObservabilityApi } from "./observability-panel";
import { ObservationDetail } from "./observation-detail";
import { ObservationTimeline } from "./observation-timeline";
import { RunReview } from "./run-review";
import { TimelineToolbar } from "./timeline-toolbar";
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

describe("RunReview", () => {
    it("renders compact trace metrics without default final output", () => {
        const markup = renderToStaticMarkup(<RunReview detail={makeTraceDetail(makeTrace("trace-2", "Latest run"))} />);

        expect(markup).toContain('aria-label="Trace metrics"');
        expect(markup).toContain("success");
        expect(markup).toContain("5.0s");
        expect(markup).toContain("generations");
        expect(markup).toContain(">1<");
        expect(markup).toContain("tools");
        expect(markup).toContain("errors");
        expect(markup).toContain("input");
        expect(markup).toContain(">20<");
        expect(markup).toContain("output");
        expect(markup).toContain(">8<");
        expect(markup).toContain("cache read");
        expect(markup).toContain(">4<");
        expect(markup).toContain("cache write");
        expect(markup).toContain(">2<");
        expect(markup).toContain("tokens");
        expect(markup).toContain(">34<");
        expect(markup).toContain("$0.0125");
        expect(markup).not.toContain("Final output");
        expect(markup).not.toContain("Review complete");
    });

    it("keeps long final output out of the run-level chrome", () => {
        const detail = makeTraceDetail(makeTrace("trace-2", "Latest run"));
        detail.trace.output = `Summary start ${"x".repeat(2_000)} hidden-tail-sentinel`;

        const markup = renderToStaticMarkup(<RunReview detail={detail} />);

        expect(markup).toContain('aria-label="Trace metrics"');
        expect(markup).not.toContain("Summary start");
        expect(markup).not.toContain("hidden-tail-sentinel");
    });

    it("uses non-success status tones for failed and active runs", () => {
        const errorMarkup = renderToStaticMarkup(
            <RunReview detail={makeTraceDetail({ ...makeTrace("trace-2", "Latest run"), status: "error" })} />
        );
        const runningMarkup = renderToStaticMarkup(
            <RunReview detail={makeTraceDetail({ ...makeTrace("trace-2", "Latest run"), status: "running" })} />
        );

        expect(errorMarkup).toContain("text-error");
        expect(errorMarkup).not.toContain("text-success");
        expect(runningMarkup).toContain("text-accent");
        expect(runningMarkup).not.toContain("text-success");
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
        HookHarness.cursor = 0;
        const feedback = renderToStaticMarkup(
            ObservationDetail({ observation, traceTimestamp: "2026-07-19T00:00:00.000Z" })
        );
        expect(feedback).toContain('role="status"');
        expect(feedback).toContain("Copied");
    });

    it.each([
        ["clipboard API is unavailable", {}],
        ["clipboard write rejects", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } }],
    ])("reports copy failure when %s", async (_name, navigatorValue) => {
        const observation = makeObservation("tool", "TOOL");
        vi.stubGlobal("navigator", navigatorValue);
        const detail = ObservationDetail({ observation, traceTimestamp: "2026-07-19T00:00:00.000Z" });
        const copyButton = findElementByAriaLabel<{ onClick: () => void | Promise<void> }>(
            detail,
            "Copy observation JSON"
        );

        await expect(copyButton?.props.onClick()).resolves.toBeUndefined();
        await flushPromises();
        HookHarness.cursor = 0;
        const feedback = renderToStaticMarkup(
            ObservationDetail({ observation, traceTimestamp: "2026-07-19T00:00:00.000Z" })
        );

        expect(feedback).toContain('role="status"');
        expect(feedback).toContain("Copy failed");
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
        expect(findElement<{ detail: TraceDetail }>(tree, RunReview)?.props.detail.trace.id).toBe("trace-2");

        findElement<{ onSelectTrace: (traceId: string) => void }>(tree, TraceSelector)?.props.onSelectTrace("trace-1");
        await flushPromises();
        tree = renderPanel(api);

        expect(findElement<{ detail: TraceDetail }>(tree, RunReview)?.props.detail.trace.id).toBe("trace-1");
    });

    it("renders a semantic timeline without repeating the agent root", async () => {
        const detail = makeTraceDetail(makeTrace("trace-2", "Latest run"));
        detail.observations = [
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
        const { api } = makeApi([detail.trace], async () => detail);

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
        const detail = makeTraceDetail(makeTrace("trace-2", "Latest run"));
        const { api } = makeApi([detail.trace], async () => detail);

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

    it("renders the Langfuse trace panel instead of the legacy timeline when magnified", async () => {
        const detail = makeTraceDetail(makeTrace("trace-2", "Latest run"));
        const { api } = makeApi([detail.trace], async () => detail);

        renderPanel(api, true);
        await flushPromises();
        const tree = renderPanel(api, true);
        const tracePanel = findElement<{ detail: TraceDetail }>(tree, TracePanel);

        expect(findElement(tree, ObservationTimeline)).toBeUndefined();
        expect(tracePanel?.props.detail).toBe(detail);
    });

    it("composes search and error filtering and controls visible expansion", async () => {
        const detail = makeTraceDetail(makeTrace("trace-2", "Latest run"));
        const { api } = makeApi([detail.trace], async () => detail);

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
        const detail = makeTraceDetail(makeTrace("trace-2", "Latest run"));
        const { api } = makeApi([detail.trace], async () => detail);

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

        expect(findElement<{ detail: TraceDetail }>(tree, RunReview)?.props.detail.trace.id).toBe("trace-2");
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

        expect(findElement<{ detail: TraceDetail }>(tree, RunReview)?.props.detail.trace.id).toBe("trace-1");
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
        expect(findElement<{ detail: TraceDetail }>(tree, RunReview)?.props.detail.trace.id).toBe("trace-3");
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
        expect(findElement<{ detail: TraceDetail }>(tree, RunReview)?.props.detail).toBe(live);
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

        expect(findElement<{ detail: TraceDetail }>(tree, RunReview)).toBeUndefined();
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
