// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ObservationCategory } from "./observation-presentation";

export interface ObservabilityViewState {
    selectedTraceId?: string;
    selectedObservationId?: string;
    query: string;
    categories: Set<ObservationCategory>;
    expandedObservationIds: Set<string>;
    followLive: boolean;
    scrollOffset: number;
    traceStates: Record<string, TraceObservabilityViewState>;
}

export interface TraceObservabilityViewState {
    selectedObservationId?: string;
    expandedObservationIds: Set<string>;
    followLive: boolean;
    scrollOffset: number;
}

export type ObservabilityViewStateAction =
    | { type: "select-trace"; traceId: string }
    | { type: "select-observation"; observationId?: string }
    | { type: "set-query"; query: string }
    | { type: "toggle-category"; category: ObservationCategory }
    | { type: "toggle-expanded"; observationId: string }
    | { type: "expand-all"; observationIds: string[] }
    | { type: "collapse-all" }
    | { type: "pause-follow-live" }
    | { type: "resume-follow-live" }
    | { type: "set-scroll-offset"; scrollOffset: number };

export interface FilterableTimelineRow {
    category: ObservationCategory;
    searchableText: string;
}

export function makeTraceObservabilityViewState(): TraceObservabilityViewState {
    return {
        selectedObservationId: undefined,
        expandedObservationIds: new Set(),
        followLive: true,
        scrollOffset: 0,
    };
}

export function makeObservabilityViewState(): ObservabilityViewState {
    const traceState = makeTraceObservabilityViewState();
    return {
        selectedTraceId: undefined,
        ...traceState,
        query: "",
        categories: new Set<ObservationCategory>(["generation", "tool", "lifecycle", "error"]),
        traceStates: {},
    };
}

function currentTraceState(state: ObservabilityViewState): TraceObservabilityViewState {
    return {
        selectedObservationId: state.selectedObservationId,
        expandedObservationIds: state.expandedObservationIds,
        followLive: state.followLive,
        scrollOffset: state.scrollOffset ?? 0,
    };
}

function updateCurrentTraceState(
    state: ObservabilityViewState,
    update: (traceState: TraceObservabilityViewState) => TraceObservabilityViewState
): ObservabilityViewState {
    const traceState = update(currentTraceState(state));
    if (!state.selectedTraceId) {
        return { ...state, ...traceState };
    }
    return {
        ...state,
        ...traceState,
        traceStates: {
            ...state.traceStates,
            [state.selectedTraceId]: traceState,
        },
    };
}

export type TimelineKeyboardIntent = "next" | "previous" | "first" | "last" | "toggle" | "collapse" | "search";

export function getTimelineKeyboardIntent(
    key: string,
    modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}
): TimelineKeyboardIntent | undefined {
    if (key === "/" && !modifiers.altKey && !modifiers.ctrlKey && !modifiers.metaKey) {
        return "search";
    }
    if (key === "j" || key === "ArrowDown") {
        return "next";
    }
    if (key === "k" || key === "ArrowUp") {
        return "previous";
    }
    if (key === "g") {
        return "first";
    }
    if (key === "G") {
        return "last";
    }
    if (key === "Enter" || key === " ") {
        return "toggle";
    }
    if (key === "Escape") {
        return "collapse";
    }
    return undefined;
}

export function shouldHandleTimelineKeyboardIntent(intent: TimelineKeyboardIntent, targetTagName: string): boolean {
    if (targetTagName === "INPUT" || targetTagName === "TEXTAREA") {
        return false;
    }
    return targetTagName !== "BUTTON" || intent !== "toggle";
}

export function isTimelineAtBottom(
    metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
    threshold = 24
): boolean {
    return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function reduceObservabilityViewState(
    state: ObservabilityViewState,
    action: ObservabilityViewStateAction
): ObservabilityViewState {
    switch (action.type) {
        case "select-trace": {
            const traceStates = { ...(state.traceStates ?? {}) };
            if (state.selectedTraceId) {
                traceStates[state.selectedTraceId] = currentTraceState(state);
            }
            const traceState = traceStates[action.traceId] ?? makeTraceObservabilityViewState();
            return {
                ...state,
                selectedTraceId: action.traceId,
                ...traceState,
                traceStates: {
                    ...traceStates,
                    [action.traceId]: traceState,
                },
            };
        }
        case "select-observation":
            return updateCurrentTraceState(state, (traceState) => ({
                ...traceState,
                selectedObservationId: action.observationId,
            }));
        case "set-query":
            return { ...state, query: action.query };
        case "toggle-category": {
            const categories = new Set(state.categories);
            if (categories.has(action.category)) {
                categories.delete(action.category);
            } else {
                categories.add(action.category);
            }
            return { ...state, categories };
        }
        case "toggle-expanded": {
            return updateCurrentTraceState(state, (traceState) => {
                const expandedObservationIds = new Set(traceState.expandedObservationIds);
                if (expandedObservationIds.has(action.observationId)) {
                    expandedObservationIds.delete(action.observationId);
                } else {
                    expandedObservationIds.add(action.observationId);
                }
                return { ...traceState, expandedObservationIds };
            });
        }
        case "expand-all":
            return updateCurrentTraceState(state, (traceState) => ({
                ...traceState,
                expandedObservationIds: new Set(action.observationIds),
            }));
        case "collapse-all":
            return updateCurrentTraceState(state, (traceState) => ({
                ...traceState,
                expandedObservationIds: new Set(),
            }));
        case "pause-follow-live":
            return updateCurrentTraceState(state, (traceState) => ({ ...traceState, followLive: false }));
        case "resume-follow-live":
            return updateCurrentTraceState(state, (traceState) => ({ ...traceState, followLive: true }));
        case "set-scroll-offset":
            return updateCurrentTraceState(state, (traceState) => ({
                ...traceState,
                scrollOffset: action.scrollOffset,
            }));
        default: {
            const exhaustiveAction: never = action;
            return exhaustiveAction;
        }
    }
}

export function filterTimelineRows<TRow extends FilterableTimelineRow>(
    rows: TRow[],
    query: string,
    categories: Set<ObservationCategory>
): TRow[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return rows.filter(
        (row) =>
            categories.has(row.category) &&
            (normalizedQuery === "" || row.searchableText.toLocaleLowerCase().includes(normalizedQuery))
    );
}
