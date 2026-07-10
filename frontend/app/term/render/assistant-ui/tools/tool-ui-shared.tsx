// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo, ReactNode, useEffect, useMemo, useState } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";

import { cn } from "@/util/util";

const ToolPreviewMaxChars = 6_000;
const ToolPreviewMaxDepth = 5;
const ToolPreviewMaxEntries = 80;
const ToolPreviewTruncatedMessage = "\n\n[truncated]";

export type AssistantToolKind = "file-read" | "file-write" | "shell" | "web";
export type AssistantToolStatus = "running" | "complete" | "error" | "requires-action" | "incomplete";

interface ToolInitialExpandedInput {
    status: ToolCallMessagePartProps["status"];
    isError?: boolean;
}

export interface ToolDisclosureProps {
    toolCallId: string;
    kind: AssistantToolKind;
    status: AssistantToolStatus;
    title: string;
    summary: string;
    renderDetails: () => ReactNode;
}

interface ToolDetailSectionProps {
    label: string;
    name: string;
    children: ReactNode;
    tone?: "error";
}

export function getToolStatus(props: Pick<ToolCallMessagePartProps, "status" | "isError">): AssistantToolStatus {
    if (props.isError) return "error";
    if (props.status.type === "incomplete" && props.status.reason === "error") return "error";
    if (props.status.type === "requires-action") return "requires-action";
    if (props.status.type === "incomplete") return "incomplete";
    return props.status.type;
}

export function getToolStatusLabel(status: AssistantToolStatus): string {
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

export function getToolInitialExpanded({ status, isError }: ToolInitialExpandedInput): boolean {
    if (isError) return true;
    if (status.type === "running") return true;
    if (status.type === "requires-action") return true;
    if (status.type === "incomplete" && status.reason === "error") return true;
    return false;
}

export function renderToolTextPreview(text: string): string {
    if (text.length <= ToolPreviewMaxChars) return text;
    return `${text.slice(0, ToolPreviewMaxChars)}${ToolPreviewTruncatedMessage}`;
}

export function renderToolValuePreview(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return renderToolTextPreview(value);
    try {
        return renderToolTextPreview(JSON.stringify(boundToolPreview(value), null, 2));
    } catch {
        return renderToolTextPreview(String(value));
    }
}

export function objectString(value: unknown, keys: string[]): string {
    if (!value || typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    for (const key of keys) {
        const entry = record[key];
        if (typeof entry === "string" && entry.trim()) return entry;
    }
    return "";
}

export function fileNameFromPath(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    return normalized.split("/").filter(Boolean).pop() || path;
}

export function resultText(result: unknown): string {
    if (typeof result === "string") return result;
    if (!result || typeof result !== "object") return "";
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const typedItem = item as { type?: unknown; text?: unknown };
        if (typedItem.type === "text" && typeof typedItem.text === "string") {
            parts.push(typedItem.text);
        }
    }
    return parts.join("\n");
}

export function statusErrorValue(status: ToolCallMessagePartProps["status"]): unknown {
    if (status.type !== "incomplete" || status.reason !== "error") return undefined;
    return status.error;
}

export function resultOrStatusError(result: unknown, status: ToolCallMessagePartProps["status"]): unknown {
    if (typeof result === "string" && result.length === 0) return statusErrorValue(status);
    return result ?? statusErrorValue(status);
}

function boundToolPreview(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (typeof value === "string") return renderToolTextPreview(value);
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

export function ToolDisclosureContent(props: ToolDisclosureProps) {
    const { toolCallId, kind, status, title, summary, renderDetails } = props;
    const defaultExpanded = status === "running" || status === "requires-action" || status === "error";
    const [expanded, setExpanded] = useState(defaultExpanded);
    const statusLabel = getToolStatusLabel(status);

    useEffect(() => {
        setExpanded(defaultExpanded);
    }, [defaultExpanded, status]);

    return (
        <div
            className={cn(
                "my-2 overflow-hidden rounded-md border bg-fg-overlay-1/20",
                status === "error" ? "border-rose-500/40" : "border-fg-overlay-2"
            )}
            data-assistant-tool-kind={kind}
            data-assistant-tool-call={toolCallId}
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
                        <span className="min-w-0 truncate text-[12px] font-medium text-foreground/90">{title}</span>
                        <span
                            className={cn(
                                "shrink-0 text-[11px] text-secondary/70",
                                status === "error" && "text-rose-300"
                            )}
                        >
                            {statusLabel}
                        </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-secondary/75">{summary}</div>
                </div>
                <span className="mt-0.5 shrink-0 text-[12px] text-secondary/80">{expanded ? "⌄" : "›"}</span>
            </button>
            {expanded && (
                <div className="space-y-2 border-t border-fg-overlay-2 bg-background/80 p-3" data-assistant-tool-detail={toolCallId}>
                    {renderDetails()}
                </div>
            )}
        </div>
    );
}

export const ToolDisclosure = memo(ToolDisclosureContent);
ToolDisclosure.displayName = "ToolDisclosure";

export function ToolDetailSection({ label, name, children, tone }: ToolDetailSectionProps) {
    if (!children) return null;
    return (
        <section className="rounded border border-fg-overlay-2 bg-background" data-assistant-tool-detail-section={name}>
            <div className="border-b border-fg-overlay-2 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-secondary/60">
                {label}
            </div>
            <pre
                className={cn(
                    "max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-foreground/90",
                    tone === "error" && "text-rose-300"
                )}
            >
                {children}
            </pre>
        </section>
    );
}

export function useStatusKey(status: ToolCallMessagePartProps["status"]): string {
    return useMemo(() => statusKey(status), [status]);
}
