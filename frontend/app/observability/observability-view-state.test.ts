import { describe, expect, it } from "vitest";

import * as ViewStateModule from "./observability-view-state";
import {
    filterTimelineRows,
    type ObservabilityViewState,
    reduceObservabilityViewState,
} from "./observability-view-state";
import type { ObservationCategory } from "./observation-presentation";

function makeState(overrides: Partial<ObservabilityViewState> = {}): ObservabilityViewState {
    return {
        selectedTraceId: "trace-1",
        selectedObservationId: "obs-1",
        query: "",
        categories: new Set<ObservationCategory>(["generation", "tool", "lifecycle", "error"]),
        expandedObservationIds: new Set<string>(),
        followLive: true,
        scrollOffset: 0,
        traceStates: {},
        ...overrides,
    };
}

describe("reduceObservabilityViewState", () => {
    it("keeps selection, expansion, follow-live, and scroll position isolated by trace", () => {
        const reduce = reduceObservabilityViewState as (
            state: ObservabilityViewState,
            action: Record<string, unknown>
        ) => ObservabilityViewState & {
            traceStates?: Record<
                string,
                {
                    selectedObservationId?: string;
                    expandedObservationIds: Set<string>;
                    followLive: boolean;
                    scrollOffset: number;
                }
            >;
        };
        let state = reduce(makeState(), { type: "select-trace", traceId: "trace-1" });
        state = reduce(state, { type: "select-observation", observationId: "obs-1" });
        state = reduce(state, { type: "toggle-expanded", observationId: "obs-1" });
        state = reduce(state, { type: "pause-follow-live" });
        state = reduce(state, { type: "set-scroll-offset", scrollOffset: 128 });
        state = reduce(state, { type: "select-trace", traceId: "trace-2" });

        expect(state.traceStates).toBeDefined();
        expect(state.traceStates?.["trace-2"]).toMatchObject({
            selectedObservationId: undefined,
            followLive: true,
            scrollOffset: 0,
        });

        state = reduce(state, { type: "select-observation", observationId: "obs-2" });
        state = reduce(state, { type: "select-trace", traceId: "trace-1" });

        expect(state.traceStates?.["trace-1"]).toMatchObject({
            selectedObservationId: "obs-1",
            followLive: false,
            scrollOffset: 128,
        });
        expect(state.traceStates?.["trace-1"].expandedObservationIds).toEqual(new Set(["obs-1"]));
        expect(state.traceStates?.["trace-2"].selectedObservationId).toBe("obs-2");
    });

    it("selects a trace and clears the selected observation", () => {
        const state = reduceObservabilityViewState(makeState(), {
            type: "select-trace",
            traceId: "trace-2",
        });

        expect(state.selectedTraceId).toBe("trace-2");
        expect(state.selectedObservationId).toBeUndefined();
    });

    it("selects and clears an observation", () => {
        const selected = reduceObservabilityViewState(makeState(), {
            type: "select-observation",
            observationId: "obs-2",
        });
        const cleared = reduceObservabilityViewState(selected, {
            type: "select-observation",
            observationId: undefined,
        });

        expect(selected.selectedObservationId).toBe("obs-2");
        expect(cleared.selectedObservationId).toBeUndefined();
    });

    it("updates the search query", () => {
        const state = reduceObservabilityViewState(makeState(), {
            type: "set-query",
            query: "README",
        });

        expect(state.query).toBe("README");
    });

    it("toggles categories without mutating the previous set", () => {
        const original = makeState();
        const removed = reduceObservabilityViewState(original, {
            type: "toggle-category",
            category: "tool",
        });
        const restored = reduceObservabilityViewState(removed, {
            type: "toggle-category",
            category: "tool",
        });

        expect(original.categories.has("tool")).toBe(true);
        expect(removed.categories.has("tool")).toBe(false);
        expect(restored.categories.has("tool")).toBe(true);
        expect(removed.categories).not.toBe(original.categories);
    });

    it("toggles expanded rows without mutating the previous set", () => {
        const original = makeState();
        const expanded = reduceObservabilityViewState(original, {
            type: "toggle-expanded",
            observationId: "obs-2",
        });
        const collapsed = reduceObservabilityViewState(expanded, {
            type: "toggle-expanded",
            observationId: "obs-2",
        });

        expect(original.expandedObservationIds.has("obs-2")).toBe(false);
        expect(expanded.expandedObservationIds.has("obs-2")).toBe(true);
        expect(collapsed.expandedObservationIds.has("obs-2")).toBe(false);
        expect(expanded.expandedObservationIds).not.toBe(original.expandedObservationIds);
    });

    it("expands and collapses all supplied observations", () => {
        const expanded = reduceObservabilityViewState(makeState(), {
            type: "expand-all",
            observationIds: ["obs-1", "obs-2"],
        });
        const collapsed = reduceObservabilityViewState(expanded, { type: "collapse-all" });

        expect(expanded.expandedObservationIds).toEqual(new Set(["obs-1", "obs-2"]));
        expect(collapsed.expandedObservationIds).toEqual(new Set());
    });

    it("pauses and resumes follow-live", () => {
        const paused = reduceObservabilityViewState(makeState(), { type: "pause-follow-live" });
        const resumed = reduceObservabilityViewState(paused, { type: "resume-follow-live" });

        expect(paused.followLive).toBe(false);
        expect(resumed.followLive).toBe(true);
    });
});

describe("filterTimelineRows", () => {
    const rows = [
        { id: "tool-read", category: "tool" as const, searchableText: "Read README.md from repository" },
        { id: "tool-write", category: "tool" as const, searchableText: "Write package.json" },
        { id: "error-read", category: "error" as const, searchableText: "README.md was not found" },
        { id: "generation", category: "generation" as const, searchableText: "Summarize README.md" },
    ];

    it("combines normalized search and category filters with AND semantics", () => {
        const filtered = filterTimelineRows(rows, "  readme  ", new Set<ObservationCategory>(["tool", "error"]));

        expect(filtered.map((row) => row.id)).toEqual(["tool-read", "error-read"]);
    });

    it("preserves the row subtype and order when all rows match", () => {
        const filtered = filterTimelineRows(
            rows,
            "",
            new Set<ObservationCategory>(["generation", "tool", "lifecycle", "error"])
        );

        expect(filtered).toEqual(rows);
    });
});

describe("timeline interactions", () => {
    it("maps navigation, expansion, collapse, and search keys", () => {
        const getTimelineKeyboardIntent = (
            ViewStateModule as typeof ViewStateModule & {
                getTimelineKeyboardIntent?: (
                    key: string,
                    modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }
                ) => string | undefined;
            }
        ).getTimelineKeyboardIntent;

        expect(getTimelineKeyboardIntent).toBeTypeOf("function");
        if (!getTimelineKeyboardIntent) {
            return;
        }
        expect(getTimelineKeyboardIntent("j")).toBe("next");
        expect(getTimelineKeyboardIntent("ArrowDown")).toBe("next");
        expect(getTimelineKeyboardIntent("k")).toBe("previous");
        expect(getTimelineKeyboardIntent("ArrowUp")).toBe("previous");
        expect(getTimelineKeyboardIntent("g")).toBe("first");
        expect(getTimelineKeyboardIntent("G")).toBe("last");
        expect(getTimelineKeyboardIntent("Enter")).toBe("toggle");
        expect(getTimelineKeyboardIntent(" ")).toBe("toggle");
        expect(getTimelineKeyboardIntent("Escape")).toBe("collapse");
        expect(getTimelineKeyboardIntent("/")).toBe("search");
        expect(getTimelineKeyboardIntent("/", { ctrlKey: true })).toBeUndefined();
    });

    it("leaves row-button activation to the native button behavior", () => {
        const shouldHandleTimelineKeyboardIntent = (
            ViewStateModule as typeof ViewStateModule & {
                shouldHandleTimelineKeyboardIntent?: (intent: string, targetTagName: string) => boolean;
            }
        ).shouldHandleTimelineKeyboardIntent;

        expect(shouldHandleTimelineKeyboardIntent).toBeTypeOf("function");
        if (!shouldHandleTimelineKeyboardIntent) {
            return;
        }
        expect(shouldHandleTimelineKeyboardIntent("toggle", "BUTTON")).toBe(false);
        expect(shouldHandleTimelineKeyboardIntent("next", "BUTTON")).toBe(true);
        expect(shouldHandleTimelineKeyboardIntent("search", "INPUT")).toBe(false);
        expect(shouldHandleTimelineKeyboardIntent("next", "TEXTAREA")).toBe(false);
    });

    it("detects whether the viewport remains close enough to live tail", () => {
        const isTimelineAtBottom = (
            ViewStateModule as typeof ViewStateModule & {
                isTimelineAtBottom?: (metrics: {
                    scrollHeight: number;
                    scrollTop: number;
                    clientHeight: number;
                }) => boolean;
            }
        ).isTimelineAtBottom;

        expect(isTimelineAtBottom).toBeTypeOf("function");
        if (!isTimelineAtBottom) {
            return;
        }
        expect(isTimelineAtBottom({ scrollHeight: 1000, scrollTop: 676, clientHeight: 300 })).toBe(true);
        expect(isTimelineAtBottom({ scrollHeight: 1000, scrollTop: 675, clientHeight: 300 })).toBe(false);
    });
});
