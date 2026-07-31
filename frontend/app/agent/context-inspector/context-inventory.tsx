// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Icon } from "@/app/icon/Icon";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { ContextCategoryMetadata, ContextCategoryOrder } from "./context-composition";
import { formatContextTokens } from "./context-format";
import { ContextItem } from "./context-item";

function ConversationItems({ items }: { items: AgentContextSnapshotItemView[] }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({
        count: items.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 86,
        overscan: 6,
        initialRect: { width: 320, height: 480 },
    });
    const measuredRows = virtualizer.getVirtualItems();
    const visibleRows =
        measuredRows.length > 0
            ? measuredRows
            : items.slice(0, Math.min(items.length, 12)).map((_, index) => ({
                  index,
                  key: items[index].id,
                  start: index * 86,
                  size: 86,
                  end: (index + 1) * 86,
                  lane: 0,
              }));
    return (
        <div ref={scrollRef} className="max-h-[min(60vh,640px)] overflow-auto" data-virtualized="conversation">
            <div
                className="relative w-full"
                style={{ height: `${Math.max(virtualizer.getTotalSize(), items.length * 86)}px` }}
            >
                {visibleRows.map((virtualRow) => {
                    const item = items[virtualRow.index];
                    return (
                        <div
                            key={item.id}
                            ref={virtualizer.measureElement}
                            data-index={virtualRow.index}
                            className="absolute left-0 top-0 w-full"
                            style={{ transform: `translateY(${virtualRow.start}px)` }}
                        >
                            <ContextItem item={item} />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export function ContextInventory({
    categories,
    items,
}: {
    categories: AgentContextSnapshotView["categories"];
    items: AgentContextSnapshotItemView[];
}) {
    const [expandedCategories, setExpandedCategories] = useState<Set<AgentContextSnapshotCategoryView>>(new Set());
    const grouped = useMemo(() => {
        const map = new Map<AgentContextSnapshotCategoryView, AgentContextSnapshotItemView[]>();
        for (const category of ContextCategoryOrder) map.set(category, []);
        for (const item of items) map.get(item.category)?.push(item);
        return map;
    }, [items]);
    const summaries = new Map(categories.map((summary) => [summary.category, summary]));

    return (
        <section aria-labelledby="context-inventory-title" className="space-y-2">
            <h3 id="context-inventory-title" className="text-xs font-semibold text-foreground">
                Sources
            </h3>
            <div className="overflow-hidden rounded-lg border border-border/60">
                {ContextCategoryOrder.map((category) => {
                    const metadata = ContextCategoryMetadata[category];
                    const categoryItems = grouped.get(category) ?? [];
                    const summary = summaries.get(category) ?? {
                        category,
                        itemCount: categoryItems.length,
                        tokens: undefined,
                    };
                    const expanded = expandedCategories.has(category);
                    return (
                        <div key={category} className="border-b border-border/50 last:border-b-0">
                            <button
                                type="button"
                                aria-expanded={expanded}
                                aria-label={`${metadata.label}, ${summary.itemCount} sources`}
                                className="flex w-full cursor-pointer items-center gap-2 bg-panel px-3 py-2.5 text-left outline-none transition-colors hover:bg-fg-overlay-1 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                                onClick={() =>
                                    setExpandedCategories((current) => {
                                        const next = new Set(current);
                                        if (expanded) next.delete(category);
                                        else next.add(category);
                                        return next;
                                    })
                                }
                            >
                                <Icon
                                    name="chevron-right"
                                    size={13}
                                    className={`shrink-0 text-muted-foreground transition-transform ${
                                        expanded ? "rotate-90" : ""
                                    }`}
                                />
                                <span className="min-w-0 flex-1 text-xs font-medium text-foreground">
                                    {metadata.label}
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                    {summary.itemCount.toLocaleString()} sources
                                </span>
                                <span className="w-12 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                                    {formatContextTokens(summary.tokens)}
                                </span>
                            </button>
                            {expanded ? (
                                categoryItems.length === 0 ? (
                                    <div className="px-8 py-3 text-[11px] text-muted-foreground">No active sources.</div>
                                ) : category === "conversation" ? (
                                    <ConversationItems items={categoryItems} />
                                ) : (
                                    <div>{categoryItems.map((item) => <ContextItem key={item.id} item={item} />)}</div>
                                )
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
