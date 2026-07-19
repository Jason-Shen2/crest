// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";

import {
    makeObservabilityViewState,
    reduceObservabilityViewState,
    type ObservabilityViewStateAction,
} from "./observability-view-state";
import { ObservationTimeline } from "./observation-timeline";
import { RunReview } from "./run-review";
import { TimelineToolbar } from "./timeline-toolbar";
import { TraceSelector } from "./trace-selector";

export type AgentObservabilityApi = Window["api"]["agentObservability"];

interface ObservabilityPanelProps {
    api?: AgentObservabilityApi;
}

type LoadState = "unavailable" | "loading" | "ready" | "empty" | "error";

export function ObservabilityPanel({ api: injectedApi }: ObservabilityPanelProps = {}) {
    const api = injectedApi ?? (typeof window === "undefined" ? undefined : window.api?.agentObservability);
    const [traces, setTraces] = useState<AgentObservabilityTrace[]>([]);
    const [selectedGraph, setSelectedGraph] = useState<AgentObservabilityTraceGraph | undefined>();
    const [loadState, setLoadState] = useState<LoadState>(api ? "loading" : "unavailable");
    const [viewState, setViewState] = useState(makeObservabilityViewState);
    const selectedTraceIdRef = useRef<string | undefined>(undefined);
    const requestIdRef = useRef(0);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const dispatchViewState = (action: ObservabilityViewStateAction) => {
        setViewState((current) => reduceObservabilityViewState(current, action));
    };

    const loadTrace = async (traceId: string) => {
        if (!api) {
            return;
        }
        const requestId = ++requestIdRef.current;
        selectedTraceIdRef.current = traceId;
        dispatchViewState({ type: "select-trace", traceId });
        setSelectedGraph(undefined);
        setLoadState("loading");
        try {
            const graph = await api.getTrace(traceId);
            if (requestId !== requestIdRef.current || selectedTraceIdRef.current !== traceId) {
                return;
            }
            if (!graph) {
                setLoadState("error");
                return;
            }
            setSelectedGraph(graph);
            setLoadState("ready");
        } catch {
            if (requestId === requestIdRef.current && selectedTraceIdRef.current === traceId) {
                setLoadState("error");
            }
        }
    };

    useEffect(() => {
        if (!api) {
            return;
        }
        let disposed = false;
        const unsubscribe = api.subscribe(undefined, (event) => {
            setTraces((current) => {
                const withoutUpdated = current.filter((trace) => trace.id !== event.graph.trace.id);
                return [event.graph.trace, ...withoutUpdated];
            });
            if (selectedTraceIdRef.current && selectedTraceIdRef.current !== event.graph.trace.id) {
                return;
            }
            selectedTraceIdRef.current = event.graph.trace.id;
            dispatchViewState({ type: "select-trace", traceId: event.graph.trace.id });
            requestIdRef.current += 1;
            setSelectedGraph(event.graph);
            setLoadState("ready");
        });
        void api
            .listTraces()
            .then((items) => {
                if (disposed) {
                    return;
                }
                setTraces((current) => [
                    ...current,
                    ...items.filter((item) => !current.some((trace) => trace.id === item.id)),
                ]);
                const first = items[0];
                if (!first) {
                    if (!selectedTraceIdRef.current) {
                        setLoadState("empty");
                    }
                    return;
                }
                if (selectedTraceIdRef.current) {
                    return;
                }
                void loadTrace(first.id);
            })
            .catch(() => {
                if (!disposed) {
                    setLoadState("error");
                }
            });
        return () => {
            disposed = true;
            requestIdRef.current += 1;
            unsubscribe();
        };
    }, []);

    const collapseObservation = (observationId: string) => {
        if (!viewState.expandedObservationIds.has(observationId)) {
            return;
        }
        dispatchViewState({ type: "toggle-expanded", observationId });
    };

    const timelineObservationIds =
        selectedGraph?.observations
            .filter((observation) => observation.type !== "AGENT")
            .map((observation) => observation.id) ?? [];

    return (
        <section aria-label="Agent Observability" className="flex h-full min-h-0 flex-col bg-panel text-foreground">
            <div className="border-b border-border px-3 py-2">
                <div className="text-sm font-medium text-primary">Agent Observability</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                    Single trace view powered by Langfuse-compatible data.
                </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
                {traces.length > 0 ? (
                    <TraceSelector
                        traces={traces}
                        selectedTraceId={viewState.selectedTraceId}
                        onSelectTrace={loadTrace}
                    />
                ) : null}
                {loadState === "unavailable" ? <div className="text-sm">Observability is unavailable.</div> : null}
                {loadState === "loading" ? <div className="text-sm">Loading recent runs...</div> : null}
                {loadState === "empty" ? <div className="text-sm">No runs recorded.</div> : null}
                {loadState === "error" ? <div className="text-sm">Unable to load recent runs.</div> : null}
                {selectedGraph ? <RunReview graph={selectedGraph} /> : null}
                {selectedGraph ? (
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-fg-overlay-1/30">
                        <div className="px-2 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Timeline
                        </div>
                        <TimelineToolbar
                            query={viewState.query}
                            categories={viewState.categories}
                            searchInputRef={searchInputRef}
                            showBackToLive={!viewState.followLive}
                            onQueryChange={(query) => dispatchViewState({ type: "set-query", query })}
                            onShowAll={() => {
                                for (const category of ["generation", "tool", "lifecycle", "error"] as const) {
                                    if (!viewState.categories.has(category)) {
                                        dispatchViewState({ type: "toggle-category", category });
                                    }
                                }
                            }}
                            onToggleCategory={(category) => dispatchViewState({ type: "toggle-category", category })}
                            onExpandAll={() =>
                                dispatchViewState({ type: "expand-all", observationIds: timelineObservationIds })
                            }
                            onCollapseAll={() => dispatchViewState({ type: "collapse-all" })}
                            onBackToLive={() => dispatchViewState({ type: "resume-follow-live" })}
                        />
                        <ObservationTimeline
                            key={selectedGraph.trace.id}
                            graph={selectedGraph}
                            query={viewState.query}
                            categories={viewState.categories}
                            expandedObservationIds={viewState.expandedObservationIds}
                            selectedObservationId={viewState.selectedObservationId}
                            followLive={viewState.followLive}
                            scrollOffset={viewState.scrollOffset}
                            searchInputRef={searchInputRef}
                            onSelectObservation={(observationId) =>
                                dispatchViewState({ type: "select-observation", observationId })
                            }
                            onToggleExpanded={(observationId) =>
                                dispatchViewState({ type: "toggle-expanded", observationId })
                            }
                            onCollapseObservation={collapseObservation}
                            onPauseFollowLive={() => dispatchViewState({ type: "pause-follow-live" })}
                            onScrollOffsetChange={(scrollOffset) =>
                                dispatchViewState({ type: "set-scroll-offset", scrollOffset })
                            }
                        />
                    </div>
                ) : null}
            </div>
        </section>
    );
}
