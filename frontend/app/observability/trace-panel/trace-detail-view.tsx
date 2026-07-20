// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceDetailView.

import { useState, type ReactNode } from "react";

import { computeTraceMetrics } from "../trace-metrics";
import { IOPreview } from "./io-preview";

type DetailTab = "preview" | "json";

function Metric({ children }: { children: ReactNode }) {
    return (
        <span className="rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground">
            {children}
        </span>
    );
}

function DetailTabs({ value, onChange }: { value: DetailTab; onChange: (value: DetailTab) => void }) {
    return (
        <div role="tablist" aria-label="Trace detail view" className="flex border-b border-border px-3">
            {(["preview", "json"] as const).map((tab) => (
                <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={value === tab}
                    className="cursor-pointer border-b-2 border-transparent px-3 py-2 text-xs capitalize text-muted-foreground aria-selected:border-accent aria-selected:text-foreground"
                    onClick={() => onChange(tab)}
                >
                    {tab === "json" ? "JSON" : "Preview"}
                </button>
            ))}
        </div>
    );
}

function JsonView({ value }: { value: unknown }) {
    return (
        <pre className="m-3 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-fg-overlay-1/20 p-3 font-mono text-[11px]">
            {JSON.stringify(value, null, 2)}
        </pre>
    );
}

export function TraceDetailView({ detail }: { detail: TraceDetail }) {
    const [tab, setTab] = useState<DetailTab>("preview");
    const metrics = computeTraceMetrics(detail);
    const observationLabel = `${detail.observations.length} observation${detail.observations.length === 1 ? "" : "s"}`;

    return (
        <div role="region" aria-label="Trace detail" className="flex h-full min-h-0 flex-col">
            <header role="banner" aria-label="Trace header" className="shrink-0 space-y-2 border-b border-border p-3">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Trace</div>
                <h2 className="truncate text-base font-semibold">{detail.trace.name ?? detail.trace.id}</h2>
                <div className="flex flex-wrap gap-1">
                    <Metric>{detail.trace.status}</Metric>
                    <Metric>{`${(metrics.durationMs / 1000).toFixed(2)}s`}</Metric>
                    <Metric>{observationLabel}</Metric>
                    <Metric>{`${metrics.usage.totalTokens} tokens`}</Metric>
                    <Metric>{`$${metrics.totalCost.toFixed(4)}`}</Metric>
                </div>
            </header>
            <DetailTabs value={tab} onChange={setTab} />
            <div className="min-h-0 flex-1 overflow-auto">
                {tab === "preview" ? (
                    <div className="flex flex-col gap-3 p-3">
                        <IOPreview label="Input" value={detail.trace.input} copyScopeKey={detail.trace.id} />
                        <IOPreview label="Output" value={detail.trace.output} copyScopeKey={detail.trace.id} />
                        <IOPreview label="Metadata" value={detail.trace.metadata} copyScopeKey={detail.trace.id} />
                    </div>
                ) : (
                    <JsonView value={detail.trace} />
                )}
            </div>
        </div>
    );
}
