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
    if (typeof details === "string") return details;
    try {
        return JSON.stringify(details, null, 2);
    } catch {
        return String(details);
    }
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
    const resultText = useMemo(() => renderCompactToolResultText(item.result), [item.result]);
    const detailText = useMemo(() => stringifyDetails(item.result?.details), [item.result?.details]);
    const hasDetail = Boolean(resultText || detailText);

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
