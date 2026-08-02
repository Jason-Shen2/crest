// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useRef } from "react";
import { ContextItem } from "./context-item";

const ConversationSourceRowEstimate = 48;
const ConversationTurnHeaderEstimate = 28;

type CollapsedSizeEntry = {
    size: number;
    signature: string;
};

type DisclosureStateProps = {
    expandedItemId?: string;
    onToggleItem: (itemId: string) => void;
};

function ConversationEntry({
    item,
    expandedItemId,
    onToggleItem,
}: DisclosureStateProps & { item: AgentContextSnapshotItemView }) {
    if (item.kind !== "turn") {
        return <ContextItem item={item} expanded={expandedItemId === item.id} onToggle={onToggleItem} />;
    }

    return (
        <div className="border-t border-border/45 first:border-t-0">
            <div className="px-3 pb-1 pt-2 font-mono text-[10px] text-muted-foreground">{item.title}</div>
            {item.children?.map((child) => (
                <ContextItem
                    key={child.id}
                    item={child}
                    expanded={expandedItemId === child.id}
                    onToggle={onToggleItem}
                    accessibleContext={item.title}
                />
            ))}
        </div>
    );
}

function containsItem(item: AgentContextSnapshotItemView, itemId: string): boolean {
    if (item.id === itemId) return true;
    return item.children?.some((child) => containsItem(child, itemId)) ?? false;
}

function expandedParentId(items: AgentContextSnapshotItemView[], expandedItemId?: string): string | undefined {
    if (!expandedItemId) return undefined;
    return items.find((item) => containsItem(item, expandedItemId))?.id;
}

function estimateConversationRow(item: AgentContextSnapshotItemView): number {
    if (item.kind !== "turn") return ConversationSourceRowEstimate;
    return ConversationTurnHeaderEstimate + (item.children?.length ?? 0) * ConversationSourceRowEstimate;
}

function conversationRowSignature(item: AgentContextSnapshotItemView): string {
    return `${item.kind}:${item.children?.map((child) => child.id).join(",") ?? ""}`;
}

function ConversationItems({
    items,
    expandedItemId,
    onToggleItem,
}: DisclosureStateProps & { items: AgentContextSnapshotItemView[] }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const collapsedSizesRef = useRef(new Map<string, CollapsedSizeEntry>());
    const previousExpandedParentIdRef = useRef<string>();
    const previousExpandedItemIdRef = useRef<string>();
    const getItemKey = useCallback((index: number) => items[index].id, [items]);
    const virtualizer = useVirtualizer({
        count: items.length,
        getScrollElement: () => scrollRef.current,
        getItemKey,
        estimateSize: (index) => estimateConversationRow(items[index]),
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
                  start: items.slice(0, index).reduce((total, item) => total + estimateConversationRow(item), 0),
                  size: estimateConversationRow(items[index]),
                  end: items.slice(0, index + 1).reduce((total, item) => total + estimateConversationRow(item), 0),
                  lane: 0,
              }));
    const currentExpandedParentId = expandedParentId(items, expandedItemId);
    useLayoutEffect(() => {
        const currentItems = new Map(items.map((item) => [item.id, item]));
        for (const [itemId, cached] of collapsedSizesRef.current) {
            const item = currentItems.get(itemId);
            if (!item || cached.signature !== conversationRowSignature(item)) {
                collapsedSizesRef.current.delete(itemId);
            }
        }
    }, [items]);
    useLayoutEffect(() => {
        const previousParentId = previousExpandedParentIdRef.current;
        const previousItemId = previousExpandedItemIdRef.current;
        const rememberCurrentExpansion = () => {
            previousExpandedParentIdRef.current = currentExpandedParentId;
            previousExpandedItemIdRef.current = expandedItemId;
        };
        if (!previousParentId && !currentExpandedParentId) {
            rememberCurrentExpansion();
            return;
        }

        const newIndex = currentExpandedParentId ? items.findIndex((item) => item.id === currentExpandedParentId) : -1;
        const measureNewParent = () => {
            if (newIndex < 0) return;
            const newElement = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-index]") ?? []).find(
                (element) => Number(element.dataset.index) === newIndex
            );
            if (newElement) virtualizer.measureElement(newElement);
        };
        if (previousParentId === currentExpandedParentId) {
            if (previousItemId !== expandedItemId) measureNewParent();
            rememberCurrentExpansion();
            return;
        }

        if (currentExpandedParentId && newIndex >= 0 && !collapsedSizesRef.current.has(currentExpandedParentId)) {
            const renderedSize = visibleRows.find((row) => row.index === newIndex)?.size;
            collapsedSizesRef.current.set(currentExpandedParentId, {
                size: renderedSize ?? estimateConversationRow(items[newIndex]),
                signature: conversationRowSignature(items[newIndex]),
            });
        }

        if (previousParentId) {
            const previousIndex = items.findIndex((item) => item.id === previousParentId);
            if (previousIndex >= 0) {
                const previousItem = items[previousIndex];
                const cached = collapsedSizesRef.current.get(previousParentId);
                virtualizer.resizeItem(
                    previousIndex,
                    cached?.signature === conversationRowSignature(previousItem)
                        ? cached.size
                        : estimateConversationRow(previousItem)
                );
            }
        }

        measureNewParent();
        rememberCurrentExpansion();
    }, [currentExpandedParentId, expandedItemId, items, virtualizer]);
    const totalSize = virtualizer.getTotalSize();
    const estimatedTotalSize = items.reduce((total, item) => total + estimateConversationRow(item), 0);
    const contentHeight = Number.isFinite(totalSize) && totalSize > 0 ? totalSize : estimatedTotalSize;

    return (
        <div
            ref={scrollRef}
            className="max-h-[min(60vh,640px)] overflow-auto"
            data-testid="context-conversation-items"
            data-virtualized="conversation"
        >
            <div className="relative w-full" style={{ height: `${contentHeight}px` }}>
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
                            <ConversationEntry
                                item={item}
                                expandedItemId={expandedItemId}
                                onToggleItem={onToggleItem}
                            />
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
    expandedItemId,
    onToggleItem,
}: DisclosureStateProps & {
    category: AgentContextSnapshotCategoryView;
    items: AgentContextSnapshotItemView[];
}) {
    if (items.length === 0) {
        return <div className="px-3 py-2.5 text-[11px] text-muted-foreground">No active sources.</div>;
    }
    if (category === "conversation") {
        return <ConversationItems items={items} expandedItemId={expandedItemId} onToggleItem={onToggleItem} />;
    }
    return (
        <div>
            {items.map((item) => (
                <ContextItem key={item.id} item={item} expanded={expandedItemId === item.id} onToggle={onToggleItem} />
            ))}
        </div>
    );
}
