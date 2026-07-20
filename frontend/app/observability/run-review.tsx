// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { computeTraceMetrics } from "./trace-metrics";

interface RunReviewProps {
    detail: TraceDetail;
}

interface MetricProps {
    label: string;
    value: string | number;
    tone?: "default" | "success" | "accent" | "error";
}

function Metric({ label, value, tone = "default" }: MetricProps) {
    const toneClass =
        tone === "success"
            ? "border-success/30 bg-success/10 text-success"
            : tone === "accent"
              ? "border-accent/30 bg-accent/10 text-accent"
            : tone === "error"
              ? "border-error/30 bg-error/10 text-error"
              : "text-muted-foreground";
    return (
        <span
            className={`inline-flex min-h-6 shrink-0 items-baseline gap-1 rounded-full border border-border bg-fg-overlay-1/50 px-2 py-1 text-[11px] tabular-nums ${toneClass}`}
        >
            <strong className="text-xs font-semibold text-foreground">{value}</strong>
            {label ? <span>{label}</span> : null}
        </span>
    );
}

function traceStatusTone(status: Trace["status"]): MetricProps["tone"] {
    if (status === "success") {
        return "success";
    }
    if (status === "error" || status === "aborted") {
        return "error";
    }
    return "accent";
}

export function RunReview({ detail }: RunReviewProps) {
    const metrics = computeTraceMetrics(detail);

    return (
        <div
            aria-label="Trace metrics"
            className="flex min-h-8 items-center gap-1.5 overflow-x-auto rounded-lg border border-border bg-fg-overlay-1/40 p-1"
        >
            <Metric label="" value={detail.trace.status} tone={traceStatusTone(detail.trace.status)} />
            <Metric label="duration" value={`${(metrics.durationMs / 1000).toFixed(1)}s`} />
            <Metric label="generations" value={metrics.generationCount} />
            <Metric label="tools" value={metrics.toolCount} />
            <Metric label="errors" value={metrics.errorCount} tone={metrics.errorCount > 0 ? "error" : "default"} />
            <Metric label="input" value={metrics.usage.input} />
            <Metric label="output" value={metrics.usage.output} />
            <Metric label="cache read" value={metrics.usage.cacheRead} />
            <Metric label="cache write" value={metrics.usage.cacheWrite} />
            <Metric label="tokens" value={metrics.usage.totalTokens} />
            <Metric label="cost" value={`$${metrics.totalCost.toFixed(4)}`} />
        </div>
    );
}
