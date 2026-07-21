// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

interface TraceSelectorProps {
    traces: Trace[];
    selectedTraceId?: string;
    onSelectTrace: (traceId: string) => void;
}

const TraceLabelLimit = 72;

function messageInputText(value: unknown): string {
    if (typeof value === "string") return value;
    if (value == null || typeof value !== "object") return "";
    const content = (value as Record<string, unknown>).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (part): part is { type: "text"; text: string } =>
                part != null &&
                typeof part === "object" &&
                (part as Record<string, unknown>).type === "text" &&
                typeof (part as Record<string, unknown>).text === "string"
        )
        .map((part) => part.text)
        .join("");
}

function traceInputLabel(trace: Trace): string {
    const input = Array.isArray(trace.input)
        ? (trace.input.map(messageInputText).find((message) => message.trim().length > 0) ?? "")
        : messageInputText(trace.input);
    const compact = input.replaceAll(/\s+/g, " ").trim();
    if (!compact) return trace.name ?? "Agent run";
    if (compact.length <= TraceLabelLimit) return compact;
    return `${compact.slice(0, TraceLabelLimit - 3).trimEnd()}...`;
}

export function formatTraceOptionLabel(trace: Trace): string {
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
