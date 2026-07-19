// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { computeTraceMetrics } from "./trace-metrics";

interface RunReviewProps {
    graph: AgentObservabilityTraceGraph;
}

interface MetricProps {
    label: string;
    value: string | number;
}

function Metric({ label, value }: MetricProps) {
    return (
        <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="mt-0.5 text-sm font-medium text-foreground">{value}</div>
        </div>
    );
}

export function RunReview({ graph }: RunReviewProps) {
    const metrics = computeTraceMetrics(graph);

    return (
        <div className="rounded-lg border border-border bg-fg-overlay-1/40 p-3">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Run Review</div>
                    <div className="mt-1 text-sm font-medium text-foreground">{graph.trace.name ?? "Agent run"}</div>
                </div>
                <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                    {graph.trace.status}
                </span>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-3">
                <Metric label="Duration" value={`${(metrics.durationMs / 1000).toFixed(1)}s`} />
                <Metric label="Generations" value={metrics.generationCount} />
                <Metric label="Tools" value={metrics.toolCount} />
                <Metric label="Errors" value={metrics.errorCount} />
                <Metric label="Input tokens" value={metrics.usage.input} />
                <Metric label="Output tokens" value={metrics.usage.output} />
                <Metric label="Cache read" value={metrics.usage.cacheRead} />
                <Metric label="Cache write" value={metrics.usage.cacheWrite} />
                <Metric label="Total tokens" value={metrics.usage.totalTokens} />
                <Metric label="Cost" value={`$${metrics.totalCost.toFixed(4)}`} />
            </div>
            {metrics.finalOutput ? (
                <div className="mt-3 border-t border-border pt-3">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Final output</div>
                    <div className="mt-1 whitespace-pre-wrap text-xs text-foreground">{metrics.finalOutput}</div>
                </div>
            ) : null}
        </div>
    );
}
