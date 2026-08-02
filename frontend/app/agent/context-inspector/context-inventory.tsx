// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
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
        <div
            ref={scrollRef}
            className="max-h-[min(60vh,640px)] overflow-auto"
            data-testid="context-conversation-items"
            data-virtualized="conversation"
        >
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

export function ContextCategoryItems({
    category,
    items,
}: {
    category: AgentContextSnapshotCategoryView;
    items: AgentContextSnapshotItemView[];
}) {
    if (items.length === 0) {
        return <div className="px-8 py-3 text-[11px] text-muted-foreground">No active sources.</div>;
    }
    if (category === "conversation") {
        return <ConversationItems items={items} />;
    }
    return (
        <div>
            {items.map((item) => (
                <ContextItem key={item.id} item={item} />
            ))}
        </div>
    );
}
