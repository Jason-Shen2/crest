// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

interface TraceSelectorProps {
    traces: AgentObservabilityTrace[];
    selectedTraceId?: string;
    onSelectTrace: (traceId: string) => void;
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
                    {trace.name ?? "Agent run"} · {trace.status}
                </option>
            ))}
        </select>
    );
}
