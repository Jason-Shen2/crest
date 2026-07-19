import { describe, expect, it } from "vitest";

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
        ...overrides,
    };
}

describe("reduceObservabilityViewState", () => {
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
