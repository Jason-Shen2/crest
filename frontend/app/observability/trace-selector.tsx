// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

interface TraceSelectorProps {
    traces: AgentObservabilityTrace[];
    selectedTraceId?: string;
    onSelectTrace: (traceId: string) => void;
}

const TraceLabelLimit = 72;

function traceInputLabel(trace: AgentObservabilityTrace): string {
    const input = typeof trace.input === "string" ? trace.input : "";
    const compact = input.replaceAll(/\s+/g, " ").trim();
    if (!compact) return trace.name ?? "Agent run";
    if (compact.length <= TraceLabelLimit) return compact;
    return `${compact.slice(0, TraceLabelLimit - 3).trimEnd()}...`;
}

export function formatTraceOptionLabel(trace: AgentObservabilityTrace): string {
    const timestamp = trace.timestamp.replace("T", " ").slice(0, 16);
    return `${traceInputLabel(trace)} · ${timestamp} · ${trace.status}`;
}

export function TraceSelector({ traces, selectedTraceId, onSelectTrace }: TraceSelectorProps) {
    return (
        <select
            aria-label="Recent Runs"
            className="w-full cursor-pointer rounded border border-border bg-fg-overlay-1 px-2 py-1.5 text-xs text-foreground"
            value={selectedTraceId ?? ""}
            onChange={(event) => onSelectTrace(event.currentTarget.value)}
        >
            {traces.map((trace) => (
                <option key={trace.id} value={trace.id}>
                    {formatTraceOptionLabel(trace)}
                </option>
            ))}
        </select>
    );
}
