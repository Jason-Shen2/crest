// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useMemo, useState } from "react";
import { formatContextPercent } from "./context-format";
import { ContextCategoryItems } from "./context-inventory";

export const ContextCategoryOrder: AgentContextSnapshotCategoryView[] = [
    "agent_instructions",
    "tools",
    "conversation",
    "added_context",
];

export const ContextCategoryLabels: Record<AgentContextSnapshotCategoryView, string> = {
    agent_instructions: "Agent instructions",
    tools: "Tools",
    conversation: "Conversation",
    added_context: "Added context",
};

const ContextCategoryBreakdown: Record<
    AgentContextSnapshotCategoryView,
    { color: string; dot: string }
> = {
    agent_instructions: { color: "bg-sky-400/80", dot: "bg-sky-400" },
    tools: { color: "bg-violet-400/80", dot: "bg-violet-400" },
    conversation: { color: "bg-amber-400/80", dot: "bg-amber-400" },
    added_context: { color: "bg-emerald-400/80", dot: "bg-emerald-400" },
};

type ContextBreakdownEntry = {
    key: string;
    label: string;
    tokens: number;
    color: string;
    dot: string;
};

function ContextBreakdown({ snapshot }: { snapshot: AgentContextSnapshotView }) {
    const summaries = new Map(snapshot.categories.map((summary) => [summary.category, summary]));
    const entries: ContextBreakdownEntry[] = ContextCategoryOrder.flatMap((category) => {
        const tokens = Math.max(0, summaries.get(category)?.tokens ?? 0);
        if (!tokens) return [];
        return [
            {
                key: category,
                label: ContextCategoryLabels[category],
                tokens,
                ...ContextCategoryBreakdown[category],
            },
        ];
    });
    const otherTokens = Math.max(0, snapshot.requestOverheadTokens ?? 0);
    if (otherTokens) {
        entries.push({
            key: "other",
            label: "Other",
            tokens: otherTokens,
            color: "bg-muted-foreground/45",
            dot: "bg-muted-foreground/70",
        });
    }
    const total = entries.reduce((sum, entry) => sum + entry.tokens, 0);

    return (
        <section aria-labelledby="context-breakdown-title" className="space-y-2.5">
            <h3 id="context-breakdown-title" className="text-xs font-semibold text-foreground">
                Context breakdown
            </h3>
            <div aria-label="Context composition" className="flex h-2 overflow-hidden rounded-full bg-fg-overlay-2">
                {entries.map((entry) => {
                    const percentage = formatContextPercent(entry.tokens, total);
                    return (
                        <span
                            key={entry.key}
                            aria-label={`${entry.label} ${percentage}`}
                            className={entry.color}
                            style={{ width: `${(entry.tokens / total) * 100}%` }}
                        />
                    );
                })}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                {entries.map((entry) => (
                    <span key={entry.key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span aria-hidden="true" className={cn("size-2 rounded-full", entry.dot)} />
                        {entry.label} {formatContextPercent(entry.tokens, total)}
                    </span>
                ))}
            </div>
        </section>
    );
}

export function ContextComposition({ snapshot }: { snapshot: AgentContextSnapshotView }) {
    const [expandedItemId, setExpandedItemId] = useState<string>();
    const groupedItems = useMemo(() => {
        const grouped = new Map<AgentContextSnapshotCategoryView, AgentContextSnapshotItemView[]>();
        for (const category of ContextCategoryOrder) grouped.set(category, []);
        for (const item of snapshot.items) grouped.get(item.category)?.push(item);
        return grouped;
    }, [snapshot.items]);
    const toggleItem = (itemId: string) => {
        setExpandedItemId((current) => (current === itemId ? undefined : itemId));
    };

    return (
        <section aria-label="Context sources" className="space-y-4">
            <ContextBreakdown snapshot={snapshot} />
            <div className="border-b border-border/55">
                {ContextCategoryOrder.map((category) => {
                    const headingId = `context-group-${category}`;
                    return (
                        <section key={category} aria-labelledby={headingId} className="border-t border-border/55">
                            <h3
                                id={headingId}
                                className="bg-fg-overlay-1/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                            >
                                {ContextCategoryLabels[category]}
                            </h3>
                            <ContextCategoryItems
                                category={category}
                                items={groupedItems.get(category) ?? []}
                                expandedItemId={expandedItemId}
                                onToggleItem={toggleItem}
                            />
                        </section>
                    );
                })}
            </div>
        </section>
    );
}
