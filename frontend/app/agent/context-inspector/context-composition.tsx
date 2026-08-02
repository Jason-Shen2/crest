// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
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
        <section aria-label="Context sources" className="border-b border-border/55">
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
        </section>
    );
}
