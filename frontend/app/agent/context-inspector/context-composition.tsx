// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Icon } from "@/app/icon/Icon";
import { cn } from "@/util/util";
import { useMemo, useState } from "react";
import { formatContextPercent, formatContextTokens } from "./context-format";
import { ContextCategoryItems } from "./context-inventory";

export const ContextCategoryOrder: AgentContextSnapshotCategoryView[] = [
    "agent_instructions",
    "tools",
    "conversation",
    "added_context",
];

export const ContextCategoryMetadata: Record<
    AgentContextSnapshotCategoryView,
    { label: string; description: string; color: string; dot: string }
> = {
    agent_instructions: {
        label: "Agent instructions",
        description: "Base, project, runtime, and skill guidance",
        color: "bg-sky-400/80",
        dot: "bg-sky-400",
    },
    tools: {
        label: "Tools",
        description: "Definitions and schemas available to the model",
        color: "bg-violet-400/80",
        dot: "bg-violet-400",
    },
    conversation: {
        label: "Conversation",
        description: "Effective turns, tool activity, and summaries",
        color: "bg-amber-400/80",
        dot: "bg-amber-400",
    },
    added_context: {
        label: "Added context",
        description: "Files, selections, and cross-session references",
        color: "bg-emerald-400/80",
        dot: "bg-emerald-400",
    },
};

export function ContextComposition({ snapshot }: { snapshot: AgentContextSnapshotView }) {
    const [expandedCategories, setExpandedCategories] = useState<Set<AgentContextSnapshotCategoryView>>(new Set());
    const groupedItems = useMemo(() => {
        const grouped = new Map<AgentContextSnapshotCategoryView, AgentContextSnapshotItemView[]>();
        for (const category of ContextCategoryOrder) grouped.set(category, []);
        for (const item of snapshot.items) grouped.get(item.category)?.push(item);
        return grouped;
    }, [snapshot.items]);
    const summaries = new Map(snapshot.categories.map((summary) => [summary.category, summary]));
    const used = snapshot.effectiveInputTokens;
    return (
        <section aria-labelledby="context-composition-title" className="space-y-3">
            <div className="flex items-center justify-between">
                <h3 id="context-composition-title" className="text-xs font-semibold text-foreground">
                    Composition
                </h3>
                <span className="text-[11px] text-muted-foreground">{formatContextTokens(used)} used</span>
            </div>
            <div aria-label="Context composition" className="flex h-2.5 overflow-hidden rounded-full bg-fg-overlay-2">
                {ContextCategoryOrder.map((category) => {
                    const summary = summaries.get(category);
                    const width = used && summary?.tokens ? (summary.tokens / used) * 100 : 0;
                    return width > 0 ? (
                        <div
                            key={category}
                            aria-label={`${ContextCategoryMetadata[category].label} ${formatContextPercent(
                                summary?.tokens,
                                used
                            )}`}
                            className={ContextCategoryMetadata[category].color}
                            style={{ width: `${width}%` }}
                        />
                    ) : null;
                })}
                {(snapshot.requestOverheadTokens ?? 0) > 0 ? (
                    <div
                        aria-label={`Request overhead ${formatContextPercent(snapshot.requestOverheadTokens, used)}`}
                        className="bg-muted-foreground/35"
                        style={{ width: `${used ? (snapshot.requestOverheadTokens! / used) * 100 : 0}%` }}
                    />
                ) : null}
            </div>
            <div className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60">
                {ContextCategoryOrder.map((category) => {
                    const summary = summaries.get(category) ?? { category, itemCount: 0, tokens: 0 };
                    const metadata = ContextCategoryMetadata[category];
                    const categoryItems = groupedItems.get(category) ?? [];
                    const expanded = expandedCategories.has(category);
                    return (
                        <div key={category}>
                            <button
                                type="button"
                                aria-expanded={expanded}
                                aria-label={`${metadata.label}, ${summary.itemCount} sources`}
                                className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-3 bg-panel px-3 py-2.5 text-left outline-none transition-colors hover:bg-fg-overlay-1 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                                onClick={() =>
                                    setExpandedCategories((current) => {
                                        const next = new Set(current);
                                        if (next.has(category)) next.delete(category);
                                        else next.add(category);
                                        return next;
                                    })
                                }
                            >
                                <div className="flex min-w-0 items-start gap-2">
                                    <Icon
                                        name="chevron-right"
                                        size={13}
                                        className={cn(
                                            "mt-0.5 shrink-0 text-muted-foreground transition-transform",
                                            expanded && "rotate-90"
                                        )}
                                    />
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                                            <span
                                                aria-hidden="true"
                                                className={cn("size-2 rounded-full", metadata.dot)}
                                            />
                                            {metadata.label}
                                        </div>
                                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                            {metadata.description}
                                        </div>
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="font-mono text-xs tabular-nums text-foreground">
                                        {formatContextTokens(summary.tokens)}
                                    </div>
                                    <div className="text-[10px] text-muted-foreground">
                                        {formatContextPercent(summary.tokens, used)} ·{" "}
                                        {summary.itemCount.toLocaleString()} sources
                                    </div>
                                </div>
                            </button>
                            {expanded ? <ContextCategoryItems category={category} items={categoryItems} /> : null}
                        </div>
                    );
                })}
                {(snapshot.requestOverheadTokens ?? 0) > 0 ? (
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs">
                        <span className="text-muted-foreground">Request overhead</span>
                        <span className="font-mono tabular-nums text-foreground">
                            {formatContextTokens(snapshot.requestOverheadTokens)}
                        </span>
                    </div>
                ) : null}
            </div>
            {snapshot.attributionDeltaTokens ? (
                <p className="rounded-md bg-fg-overlay-1 px-2.5 py-2 text-[11px] text-muted-foreground">
                    Attribution differs from the provider-ready total by{" "}
                    {snapshot.attributionDeltaTokens > 0 ? "+" : ""}
                    {snapshot.attributionDeltaTokens} tokens. Category values are not rescaled.
                </p>
            ) : null}
        </section>
    );
}
