// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo, useEffect, useMemo, useState } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";

import { cn } from "@/util/util";

const ToolPreviewMaxChars = 6_000;
const ToolPreviewMaxDepth = 5;
const ToolPreviewMaxEntries = 80;
const ToolPreviewTruncatedMessage = "\n\n[truncated]";

type ToolFallbackStatus = "running" | "complete" | "error" | "requires-action" | "incomplete";

interface ToolFallbackInitialExpandedInput {
    status: ToolCallMessagePartProps["status"];
    isError?: boolean;
}

export function getToolFallbackInitialExpanded({ status, isError }: ToolFallbackInitialExpandedInput): boolean {
    if (isError) return true;
    if (status.type === "running") return true;
    if (status.type === "requires-action") return true;
    if (status.type === "incomplete" && status.reason === "error") return true;
    return false;
}

export function renderToolFallbackPreview(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return truncateToolPreview(value);
    try {
        return truncateToolPreview(JSON.stringify(boundToolPreview(value), null, 2));
    } catch {
        return truncateToolPreview(String(value));
    }
}

function toolFallbackStatus(props: ToolCallMessagePartProps): ToolFallbackStatus {
    if (props.isError) return "error";
    if (props.status.type === "incomplete" && props.status.reason === "error") return "error";
    if (props.status.type === "requires-action") return "requires-action";
    if (props.status.type === "incomplete") return "incomplete";
    return props.status.type;
}

function toolFallbackStatusLabel(status: ToolFallbackStatus): string {
    switch (status) {
        case "running":
            return "Running";
        case "complete":
            return "Done";
        case "error":
            return "Error";
        case "requires-action":
            return "Needs input";
        case "incomplete":
            return "Stopped";
    }
}

function truncateToolPreview(text: string): string {
    if (text.length <= ToolPreviewMaxChars) return text;
    return `${text.slice(0, ToolPreviewMaxChars)}${ToolPreviewTruncatedMessage}`;
}

function boundToolPreview(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (typeof value === "string") return truncateToolPreview(value);
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    if (depth >= ToolPreviewMaxDepth) return "[truncated]";
    seen.add(value);

    if (Array.isArray(value)) {
        const next = value.slice(0, ToolPreviewMaxEntries).map((item) => boundToolPreview(item, depth + 1, seen));
        if (value.length > ToolPreviewMaxEntries) next.push(`[truncated ${value.length - ToolPreviewMaxEntries} items]`);
        return next;
    }

    const out: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, ToolPreviewMaxEntries);
    for (const [key, entryValue] of entries) {
        if (typeof entryValue === "function") continue;
        out[key] = boundToolPreview(entryValue, depth + 1, seen);
    }
    const extraCount = Object.keys(value).length - entries.length;
    if (extraCount > 0) out.__truncated = `${extraCount} entries`;
    return out;
}

function statusKey(status: ToolCallMessagePartProps["status"]): string {
    if (status.type !== "incomplete") return status.type;
    return `${status.type}:${status.reason}`;
}

function statusErrorValue(status: ToolCallMessagePartProps["status"]): unknown {
    if (status.type !== "incomplete" || status.reason !== "error") return undefined;
    return status.error;
}

function resultValueForDisplay(result: unknown, status: ToolCallMessagePartProps["status"]): unknown {
    if (typeof result === "string" && result.length === 0) return statusErrorValue(status);
    return result ?? statusErrorValue(status);
}

function DetailSection({ label, name, children }: { label: string; name: string; children: string }) {
    if (!children) return null;
    return (
        <section className="rounded border border-fg-overlay-2 bg-background" data-assistant-tool-detail-section={name}>
            <div className="border-b border-fg-overlay-2 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-secondary/60">
                {label}
            </div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-foreground/90">
                {children}
            </pre>
        </section>
    );
}

export const ToolFallback = memo((props: ToolCallMessagePartProps) => {
    const { toolCallId, toolName, args, argsText, result, artifact, isError, status: partStatus } = props;
    const status = toolFallbackStatus(props);
    const statusLabel = toolFallbackStatusLabel(status);
    const statusStateKey = statusKey(partStatus);
    const defaultExpanded = useMemo(
        () => getToolFallbackInitialExpanded({ status: partStatus, isError }),
        [isError, partStatus]
    );
    const [expanded, setExpanded] = useState(defaultExpanded);
    const argsPreview = useMemo(
        () => (expanded ? argsText || renderToolFallbackPreview(args) : ""),
        [args, argsText, expanded]
    );
    const resultPreview = useMemo(
        () => (expanded ? renderToolFallbackPreview(resultValueForDisplay(result, partStatus)) : ""),
        [expanded, partStatus, result]
    );
    const artifactPreview = useMemo(() => (expanded ? renderToolFallbackPreview(artifact) : ""), [artifact, expanded]);

    useEffect(() => {
        setExpanded(defaultExpanded);
    }, [defaultExpanded, statusStateKey]);

    return (
        <div
            className={cn(
                "my-2 overflow-hidden rounded-md border bg-fg-overlay-1/20",
                status === "error" ? "border-rose-500/40" : "border-fg-overlay-2"
            )}
            data-assistant-tool-fallback={toolCallId}
            data-assistant-tool-status={status}
        >
            <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
                className="flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-fg-overlay-1/35"
            >
                <span
                    className={cn(
                        "mt-0.5 h-2 w-2 shrink-0 rounded-full",
                        status === "running" && "bg-[var(--ansi-yellow)]",
                        status === "complete" && "bg-[var(--ansi-green)]",
                        status === "error" && "bg-rose-500",
                        status === "requires-action" && "bg-[var(--ansi-cyan)]",
                        status === "incomplete" && "bg-secondary/70"
                    )}
                />
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-[12px] font-medium text-foreground/90">{toolName}</span>
                        <span
                            className={cn(
                                "shrink-0 text-[11px] text-secondary/70",
                                status === "error" && "text-rose-300"
                            )}
                        >
                            {statusLabel}
                        </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-secondary/75">Tool call {toolCallId}</div>
                </div>
                <span className="mt-0.5 shrink-0 text-[12px] text-secondary/80">{expanded ? "⌄" : "›"}</span>
            </button>
            {expanded && (
                <div className="space-y-2 border-t border-fg-overlay-2 bg-background/80 p-3" data-assistant-tool-detail={toolCallId}>
                    <DetailSection label="Arguments" name="args">
                        {argsPreview}
                    </DetailSection>
                    <DetailSection label={status === "error" ? "Error" : "Result"} name="result">
                        {resultPreview}
                    </DetailSection>
                    <DetailSection label="Artifact" name="artifact">
                        {artifactPreview}
                    </DetailSection>
                </div>
            )}
        </div>
    );
});
ToolFallback.displayName = "ToolFallback";
