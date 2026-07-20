// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TracePanelDetail, TraceDetailView, and ObservationDetailView.

import { useState, type ReactNode } from "react";

import { ObservationDetail } from "../observation-detail";
import { useTraceData, useTraceSelection } from "./trace-context";

function JsonSection({ label, value }: { label: string; value: unknown }) {
    const [expanded, setExpanded] = useState(true);
    if (value == null) {
        return null;
    }
    return (
        <section className="rounded-lg border border-border bg-fg-overlay-1/20">
            <button
                type="button"
                className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left text-xs font-medium"
                aria-expanded={expanded}
                onClick={() => setExpanded((current) => !current)}
            >
                {label}
                <span className="text-muted-foreground">{expanded ? "−" : "+"}</span>
            </button>
            {expanded ? (
                <pre className="max-h-72 overflow-auto border-t border-border p-3 text-[11px] leading-relaxed whitespace-pre-wrap">
                    {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                </pre>
            ) : null}
        </section>
    );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
    return (
        <span className="inline-flex items-baseline gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground">
            <strong className="font-medium text-foreground">{children}</strong>
            {label}
        </span>
    );
}

function TraceDetailView() {
    const { detail } = useTraceData();
    const duration = detail.trace.endedAt
        ? Math.max(0, Date.parse(detail.trace.endedAt) - Date.parse(detail.trace.timestamp))
        : null;
    return (
        <div role="region" aria-label="Trace detail" className="flex flex-col gap-3 p-3">
            <header>
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Trace</div>
                <h2 className="mt-1 truncate text-base font-semibold">{detail.trace.name ?? "Untitled trace"}</h2>
                <div className="mt-2 flex flex-wrap gap-1">
                    <Metric label="status">{detail.trace.status}</Metric>
                    {duration != null ? (
                        <Metric label="duration">
                            {duration >= 1000 ? `${(duration / 1000).toFixed(2)}s` : `${duration}ms`}
                        </Metric>
                    ) : null}
                    <Metric label="observations">{detail.observations.length}</Metric>
                    <Metric label="scores">{detail.scores.length}</Metric>
                </div>
            </header>
            <JsonSection label="Input" value={detail.trace.input} />
            <JsonSection label="Output" value={detail.trace.output} />
            <JsonSection label="Metadata" value={detail.trace.metadata} />
            {detail.scores.length > 0 ? <JsonSection label="Scores" value={detail.scores} /> : null}
        </div>
    );
}

export function TraceDetailPanel() {
    const { detail, nodeMap, observationMap } = useTraceData();
    const { selectedNodeId } = useTraceSelection();
    const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) : null;
    const isObservationSelected = selectedNodeId != null && selectedNode?.type !== "TRACE";
    const observation = isObservationSelected ? observationMap.get(selectedNodeId) : undefined;

    if (isObservationSelected && !observation) {
        return (
            <div
                role="region"
                aria-label="Observation detail"
                className="flex h-full items-center justify-center text-sm text-muted-foreground"
            >
                Observation not found
            </div>
        );
    }
    if (observation) {
        return (
            <div role="region" aria-label="Observation detail" className="h-full overflow-auto p-3">
                <ObservationDetail observation={observation} traceTimestamp={detail.trace.timestamp} />
            </div>
        );
    }
    return <TraceDetailView />;
}
