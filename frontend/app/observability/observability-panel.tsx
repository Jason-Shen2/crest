// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";

import { RunReview } from "./run-review";
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
    const selectedTraceIdRef = useRef<string | undefined>(undefined);
    const requestIdRef = useRef(0);

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

    return (
        <section aria-label="Agent Observability" className="flex h-full min-h-0 flex-col bg-panel text-foreground">
            <div className="border-b border-border px-3 py-2">
                <div className="text-sm font-medium text-primary">Agent Observability</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                    Single trace view powered by Langfuse-compatible data.
                </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
                {traces.length > 0 ? (
                    <TraceSelector traces={traces} selectedTraceId={selectedTraceId} onSelectTrace={loadTrace} />
                ) : null}
                {loadState === "unavailable" ? <div className="text-sm">Observability is unavailable.</div> : null}
                {loadState === "loading" ? <div className="text-sm">Loading recent runs...</div> : null}
                {loadState === "empty" ? <div className="text-sm">No runs recorded.</div> : null}
                {loadState === "error" ? <div className="text-sm">Unable to load recent runs.</div> : null}
                {selectedGraph ? <RunReview graph={selectedGraph} /> : null}
                {selectedGraph ? (
                    <div className="rounded-lg border border-border bg-fg-overlay-1/30 p-3">
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Observations
                        </div>
                        <div className="mt-2 flex flex-col gap-1">
                            {selectedGraph.observations.map((observation) => (
                                <div key={observation.id} className="rounded border border-border/70 px-2 py-1 text-xs">
                                    <span className="font-medium text-foreground">{observation.type}</span>
                                    <span className="ml-2 text-muted-foreground">
                                        {observation.name ?? observation.id}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}
            </div>
        </section>
    );
}
