// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceDetailView.

import { useState, type ReactNode } from "react";

import { computeTraceMetrics } from "../trace-metrics";
import { DetailJsonView } from "./detail-json-view";
import { DetailTabs, type DetailTab } from "./detail-tabs";
import { IOPreview } from "./io-preview";

function Metric({ children }: { children: ReactNode }) {
    return (
        <span className="rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground">
            {children}
        </span>
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
            <DetailTabs
                label="Trace detail view"
                value={tab}
                onChange={setTab}
                preview={
                    <div className="flex flex-col gap-3 p-3">
                        <IOPreview label="Input" value={detail.trace.input} copyScopeKey={detail.trace.id} />
                        <IOPreview label="Output" value={detail.trace.output} copyScopeKey={detail.trace.id} />
                        <IOPreview label="Metadata" value={detail.trace.metadata} copyScopeKey={detail.trace.id} />
                    </div>
                }
                json={<DetailJsonView value={detail.trace} copyScopeKey={detail.trace.id} />}
            />
        </div>
    );
}
