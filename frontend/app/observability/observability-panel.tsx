// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";

import type { ObservationCategory } from "./observation-presentation";
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
    const [selectedTraceId, setSelectedTraceId] = useState<string | undefined>();
    const [loadState, setLoadState] = useState<LoadState>(api ? "loading" : "unavailable");
    const [query, setQuery] = useState("");
    const [categories, setCategories] = useState(
        new Set<ObservationCategory>(["generation", "tool", "lifecycle", "error"])
    );
    const [expandedObservationIds, setExpandedObservationIds] = useState(new Set<string>());
    const [selectedObservationId, setSelectedObservationId] = useState<string | undefined>();
    const [followLive, setFollowLive] = useState(true);
    const selectedTraceIdRef = useRef<string | undefined>(undefined);
    const requestIdRef = useRef(0);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const loadTrace = async (traceId: string) => {
        if (!api) {
            return;
        }
        const requestId = ++requestIdRef.current;
        selectedTraceIdRef.current = traceId;
        setSelectedTraceId(traceId);
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
            setSelectedTraceId(event.graph.trace.id);
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

    const toggleCategory = (category: ObservationCategory) => {
        setCategories((current) => {
            const next = new Set(current);
            if (next.has(category)) {
                next.delete(category);
            } else {
                next.add(category);
            }
            return next;
        });
    };

    const toggleExpanded = (observationId: string) => {
        setExpandedObservationIds((current) => {
            const next = new Set(current);
            if (next.has(observationId)) {
                next.delete(observationId);
            } else {
                next.add(observationId);
            }
            return next;
        });
    };

    const collapseObservation = (observationId: string) => {
        setExpandedObservationIds((current) => {
            if (!current.has(observationId)) {
                return current;
            }
            const next = new Set(current);
            next.delete(observationId);
            return next;
        });
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
                    <TraceSelector traces={traces} selectedTraceId={selectedTraceId} onSelectTrace={loadTrace} />
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
                            query={query}
                            categories={categories}
                            searchInputRef={searchInputRef}
                            showBackToLive={!followLive}
                            onQueryChange={setQuery}
                            onShowAll={() =>
                                setCategories(
                                    new Set<ObservationCategory>(["generation", "tool", "lifecycle", "error"])
                                )
                            }
                            onToggleCategory={toggleCategory}
                            onExpandAll={() => setExpandedObservationIds(new Set(timelineObservationIds))}
                            onCollapseAll={() => setExpandedObservationIds(new Set())}
                            onBackToLive={() => setFollowLive(true)}
                        />
                        <ObservationTimeline
                            graph={selectedGraph}
                            query={query}
                            categories={categories}
                            expandedObservationIds={expandedObservationIds}
                            selectedObservationId={selectedObservationId}
                            followLive={followLive}
                            searchInputRef={searchInputRef}
                            onSelectObservation={setSelectedObservationId}
                            onToggleExpanded={toggleExpanded}
                            onCollapseObservation={collapseObservation}
                            onPauseFollowLive={() => setFollowLive(false)}
                        />
                    </div>
                ) : null}
            </div>
        </section>
    );
}
