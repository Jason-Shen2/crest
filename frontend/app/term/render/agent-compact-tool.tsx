// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { memo, useEffect, useMemo, useState } from "react";

import {
    compactToolIcon,
    compactToolLabel,
    compactToolPath,
    compactToolSummary,
    isCompactReadGroup,
    renderCompactToolResultText,
    type CompactToolGroup,
    type CompactToolIcon,
    type CompactToolItem,
} from "./agent-tool-view-model";

export interface AgentCompactToolRowProps {
    item: CompactToolItem;
    defaultExpanded?: boolean;
}

export interface AgentCompactToolListProps {
    groups: CompactToolGroup[];
}

const IconByCompactToolIcon: Record<CompactToolIcon, string> = {
    file: "file",
    search: "search",
    edit: "file-code-02",
    terminal: "terminal",
    globe: "compass-3",
    agent: "stars-01",
    tool: "gear",
};

const CompactDetailMaxChars = 6_000;
const CompactDetailMaxDepth = 5;
const CompactDetailMaxEntries = 80;
const CompactDetailTruncatedMessage = "\n\n[truncated]";

function statusClasses(status: CompactToolItem["status"]): { icon: string; accent: string } {
    switch (status) {
        case "failed":
            return { icon: "x-circle", accent: "text-rose-400" };
        case "running":
            return { icon: "clock-loader", accent: "text-[var(--ansi-yellow)]" };
        case "done":
            return { icon: "check-circle-broken", accent: "text-[var(--ansi-green)]" };
    }
}

function stringifyDetails(details: unknown): string {
    if (details == null) return "";
    if (typeof details === "string") return truncateCompactDetailText(details);
    try {
        return truncateCompactDetailText(JSON.stringify(boundDetails(details), null, 2));
    } catch {
        return truncateCompactDetailText(String(details));
    }
}

function truncateCompactDetailText(text: string): string {
    if (text.length <= CompactDetailMaxChars) return text;
    return `${text.slice(0, CompactDetailMaxChars)}${CompactDetailTruncatedMessage}`;
}

function hasRenderableDetail(result: CompactToolItem["result"]): boolean {
    if (!result) return false;
    if (result.details != null) return true;
    return Boolean(result.content?.some((part) => textPartHasContent(part)));
}

function textPartHasContent(part: { type: string; text?: string; [field: string]: unknown }): boolean {
    if (typeof part.text === "string" && part.text.length > 0) return true;
    if (typeof part.content === "string" && part.content.length > 0) return true;
    if (Array.isArray(part.content)) {
        return part.content.some((child) => typeof child?.text === "string" && child.text.length > 0);
    }
    return false;
}

function boundDetails(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (typeof value === "string") return truncateCompactDetailText(value);
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    if (depth >= CompactDetailMaxDepth) return "[truncated]";
    seen.add(value);

    if (Array.isArray(value)) {
        const next = value.slice(0, CompactDetailMaxEntries).map((item) => boundDetails(item, depth + 1, seen));
        if (value.length > CompactDetailMaxEntries) next.push(`[truncated ${value.length - CompactDetailMaxEntries} items]`);
        return next;
    }

    const out: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, CompactDetailMaxEntries);
    for (const [key, entryValue] of entries) {
        if (typeof entryValue === "function") continue;
        out[key] = boundDetails(entryValue, depth + 1, seen);
    }
    const extraCount = Object.keys(value).length - entries.length;
    if (extraCount > 0) {
        out.__truncated = `${extraCount} entries`;
    }
    return out;
}

function fileNameFromPath(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

function DetailSection({ label, name, children }: { label: string; name: string; children: string }) {
    if (!children) return null;
    return (
        <section
            className="rounded border border-fg-overlay-2 bg-background"
            data-agent-compact-tool-detail-section={name}
        >
            <div className="border-b border-fg-overlay-2 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-secondary/60">
                {label}
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-foreground/90">
                {children || "(empty)"}
            </pre>
        </section>
    );
}

export const AgentCompactToolRow = memo(({ item, defaultExpanded = false }: AgentCompactToolRowProps) => {
    const [expanded, setExpanded] = useState(defaultExpanded || item.status === "failed");
    const status = statusClasses(item.status);
    const label = useMemo(() => compactToolLabel(item), [item]);
    const summary = useMemo(() => compactToolSummary(item), [item]);
    const hasDetail = useMemo(() => hasRenderableDetail(item.result), [item.result]);
    const resultText = useMemo(
        () => (expanded ? truncateCompactDetailText(renderCompactToolResultText(item.result)) : ""),
        [expanded, item.result]
    );
    const detailText = useMemo(
        () => (expanded ? stringifyDetails(item.result?.details) : ""),
        [expanded, item.result?.details]
    );

    useEffect(() => {
        if (item.status !== "failed") return;
        setExpanded(true);
    }, [item.status]);

    return (
        <div
            className={cn(
                "overflow-hidden rounded-md border bg-fg-overlay-1/20",
                item.status === "failed" ? "border-rose-500/30" : "border-fg-overlay-2"
            )}
            data-agent-compact-tool-row={item.call.id}
            data-agent-compact-tool-kind={item.kind}
            data-agent-compact-tool-status={item.status}
        >
            <button
                type="button"
                aria-expanded={expanded}
                disabled={!hasDetail}
                onClick={() => {
                    if (!hasDetail) return;
                    setExpanded((value) => !value);
                }}
                className={cn(
                    "flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left",
                    hasDetail && "cursor-pointer hover:bg-fg-overlay-1/35",
                    !hasDetail && "cursor-default"
                )}
            >
                <UIcon
                    name={IconByCompactToolIcon[compactToolIcon(item)]}
                    size={13}
                    className="mt-0.5 shrink-0 text-secondary/80"
                />
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-[12px] font-medium text-foreground/90">{label}</span>
                        <UIcon name={status.icon} size={12} className={cn("shrink-0", status.accent)} />
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-secondary/80">{summary}</div>
                </div>
                {hasDetail && (
                    <UIcon
                        name={expanded ? "chevron-down" : "chevron-right"}
                        size={13}
                        className="mt-0.5 shrink-0 text-secondary/80"
                    />
                )}
            </button>
            {expanded && hasDetail && (
                <div
                    className="space-y-2 border-t border-fg-overlay-2 bg-background/80 p-3"
                    data-agent-compact-tool-detail={item.call.id}
                >
                    <DetailSection label={item.status === "failed" ? "Error" : "Result"} name="result">
                        {resultText}
                    </DetailSection>
                    <DetailSection label="Details" name="details">
                        {detailText}
                    </DetailSection>
                </div>
            )}
        </div>
    );
});
AgentCompactToolRow.displayName = "AgentCompactToolRow";

function AgentCompactReadGroup({ group }: { group: Extract<CompactToolGroup, { kind: "read-group" }> }) {
    return (
        <div
            className="rounded-md border border-fg-overlay-2 bg-fg-overlay-1/15 px-3 py-2"
            data-agent-compact-read-group={group.id}
            data-agent-compact-read-count={group.items.length}
        >
            <div className="flex min-w-0 items-center gap-2">
                <UIcon name="file" size={13} className="shrink-0 text-secondary/80" />
                <span className="text-[12px] font-medium text-foreground/90">Read {group.items.length} files</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
                {group.items.map((item) => {
                    const path = compactToolPath(item);
                    const label = path ? fileNameFromPath(path) : compactToolLabel(item);
                    return (
                        <span
                            key={item.call.id}
                            className="max-w-48 truncate rounded border border-fg-overlay-2 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-secondary/90"
                            title={path || label}
                        >
                            {label}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

export const AgentCompactToolList = memo(({ groups }: AgentCompactToolListProps) => {
    if (groups.length === 0) return null;
    return (
        <div className="my-2 space-y-1.5" data-agent-compact-tool-list="true">
            {groups.map((group) =>
                isCompactReadGroup(group) ? (
                    <AgentCompactReadGroup key={group.id} group={group} />
                ) : (
                    <AgentCompactToolRow key={group.id} item={group.item} />
                )
            )}
        </div>
    );
});
AgentCompactToolList.displayName = "AgentCompactToolList";
