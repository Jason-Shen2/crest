// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";

export function ObservabilityPanel() {
    const [traces, setTraces] = useState<AgentObservabilityTrace[]>([]);
    const [selectedGraph, setSelectedGraph] = useState<AgentObservabilityTraceGraph | undefined>();

    useEffect(() => {
        const api = window.api?.agentObservability;
        if (!api) return;
        let disposed = false;
        void api.listTraces().then((items) => {
            if (disposed) return;
            setTraces(items);
            const first = items[0];
            if (first) {
                void api.getTrace(first.id).then((graph) => {
                    if (!disposed) setSelectedGraph(graph);
                });
            }
        });
        const unsubscribe = api.subscribe(undefined, (event) => {
            setSelectedGraph(event.graph);
            setTraces((current) => {
                const withoutUpdated = current.filter((trace) => trace.id !== event.graph.trace.id);
                return [event.graph.trace, ...withoutUpdated];
            });
        });
        return () => {
            disposed = true;
            unsubscribe();
        };
    }, []);

    const selectedTrace = selectedGraph?.trace ?? traces[0];
    const observationCount = selectedGraph?.observations.length ?? 0;

    return (
        <section aria-label="Agent Observability" className="flex h-full min-h-0 flex-col bg-panel text-foreground">
            <div className="border-b border-border px-3 py-2">
                <div className="text-sm font-medium text-primary">Agent Observability</div>
                <div className="mt-0.5 text-xs text-muted-foreground">Single trace view powered by Langfuse-compatible data.</div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
                <div className="rounded-lg border border-border bg-fg-overlay-1/40 p-3">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Run Review</div>
                    {selectedTrace ? (
                        <>
                            <div className="mt-2 text-sm font-medium text-foreground">{selectedTrace.name ?? "Agent run"}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                Status: {selectedTrace.status} · Observations: {observationCount}
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="mt-2 text-sm text-foreground">No trace selected yet.</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                Agent runs will appear here after `agent-observability` IPC starts streaming trace updates.
                            </div>
                        </>
                    )}
                </div>
                {selectedGraph ? (
                    <div className="rounded-lg border border-border bg-fg-overlay-1/30 p-3">
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Observations</div>
                        <div className="mt-2 flex flex-col gap-1">
                            {selectedGraph.observations.map((observation) => (
                                <div key={observation.id} className="rounded border border-border/70 px-2 py-1 text-xs">
                                    <span className="font-medium text-foreground">{observation.type}</span>
                                    <span className="ml-2 text-muted-foreground">{observation.name ?? observation.id}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}
            </div>
        </section>
    );
}
