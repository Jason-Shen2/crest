// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export function formatContextTokens(tokens: number | undefined): string {
    if (tokens == null || !Number.isFinite(tokens)) return "Unavailable";
    const sign = tokens < 0 ? "-" : "";
    const absolute = Math.abs(tokens);
    if (absolute >= 1_000_000) return `${sign}${(absolute / 1_000_000).toFixed(1)}M`;
    if (absolute >= 1_000) return `${sign}${(absolute / 1_000).toFixed(1)}k`;
    return `${tokens}`;
}

export function formatContextPercent(value: number | undefined, total: number | undefined): string {
    if (value == null || total == null || total <= 0) return "—";
    return `${Math.round((value / total) * 100)}%`;
}

export function formatContextLifecycle(lifecycle: AgentContextSnapshotLifecycleView): string {
    const labels: Record<AgentContextSnapshotLifecycleView, string> = {
        ready: "Ready",
        in_use: "In use",
        waiting_for_tool: "Waiting for tool result",
        updating: "Updating",
        out_of_date: "Out of date",
        unavailable: "Unavailable",
    };
    return labels[lifecycle];
}

export function formatContextAccuracy(accuracy: AgentContextSnapshotAccuracyView): string {
    if (accuracy === "exact") return "Exact";
    if (accuracy === "estimated") return "Estimated";
    return "Token count unavailable";
}

export function formatContextTimestamp(value: string): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return value;
    return new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).format(timestamp);
}
