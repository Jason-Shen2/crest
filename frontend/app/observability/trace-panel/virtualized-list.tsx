/**
 * VirtualizedList - Generic virtualized list component.
 *
 * Simpler than VirtualizedTree - no tree structure, just flat list virtualization.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type Ref } from "react";

import { getLinearNavigationAction } from "./roving-navigation";

interface VirtualizedListProps<T> {
    items: T[];
    renderItem: (params: {
        item: T;
        index: number;
        isSelected: boolean;
        isTabStop: boolean;
        onSelect: () => void;
        onNavigate: (event: KeyboardEvent<HTMLDivElement>) => void;
        itemRef: Ref<HTMLDivElement>;
    }) => ReactNode;
    selectedItemId?: string | null;
    onSelectItem: (id: string) => void;
    getItemId: (item: T) => string;
    estimatedItemSize?: number;
    overscan?: number;
}

export function VirtualizedList<T>({
    items,
    renderItem,
    selectedItemId,
    onSelectItem,
    getItemId,
    estimatedItemSize = 48,
    overscan = 16,
}: VirtualizedListProps<T>) {
    const parentRef = useRef<HTMLDivElement>(null);
    const itemElementsRef = useRef(new Map<string, HTMLDivElement>());
    const revealedItemIdRef = useRef<string | null>(null);
    const virtualizer = useVirtualizer({
        count: items.length,
        getScrollElement: () => parentRef.current,
        initialRect: { width: 800, height: 600 },
        estimateSize: () => estimatedItemSize,
        getItemKey: (index) => getItemId(items[index]),
        overscan,
    });

    const virtualItems = virtualizer.getVirtualItems();
    const renderedItems =
        virtualItems.length > 0
            ? virtualItems
            : items.slice(0, Math.min(items.length, 32)).map((_, index) => ({
                  index,
                  key: getItemId(items[index]),
                  start: index * estimatedItemSize,
              }));
    const selectedItemIsVisible = selectedItemId != null && items.some((item) => getItemId(item) === selectedItemId);
    const focusItemId = selectedItemIsVisible ? selectedItemId : items.length > 0 ? getItemId(items[0]) : null;
    const selectedVirtualItemKey =
        focusItemId == null
            ? null
            : (renderedItems.find((item) => getItemId(items[item.index]) === focusItemId)?.key ?? null);

    useLayoutEffect(() => {
        if (!selectedItemIsVisible) {
            revealedItemIdRef.current = null;
            return;
        }
        if (revealedItemIdRef.current === selectedItemId) {
            return;
        }
        revealedItemIdRef.current = selectedItemId;
        const index = items.findIndex((item) => getItemId(item) === selectedItemId);
        if (index >= 0) {
            virtualizer.scrollToIndex(index, { align: "auto" });
        }
    }, [getItemId, items, selectedItemId, selectedItemIsVisible, virtualizer]);

    useEffect(() => {
        if (selectedItemId != null && selectedVirtualItemKey != null) {
            itemElementsRef.current.get(selectedItemId)?.focus();
        }
    }, [selectedItemId, selectedVirtualItemKey]);

    const registerItem = (itemId: string, element: HTMLDivElement | null) => {
        if (element == null) {
            itemElementsRef.current.delete(itemId);
            return;
        }
        itemElementsRef.current.set(itemId, element);
    };

    const onNavigate = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            return;
        }
        event.preventDefault();
        const action = getLinearNavigationAction(event.key, index, items.length);
        if (action?.type === "select") {
            onSelectItem(getItemId(items[action.index]));
        }
    };

    return (
        <div ref={parentRef} role="listbox" aria-label="Trace search results" className="h-full overflow-auto">
            <div
                style={{
                    height: `${virtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                }}
            >
                {renderedItems.map((virtualRow) => {
                    const item = items[virtualRow.index];
                    const itemId = getItemId(item);
                    const isSelected = selectedItemId === itemId;

                    return (
                        <div
                            key={itemId}
                            data-index={virtualRow.index}
                            ref={virtualizer.measureElement}
                            style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                transform: `translateY(${virtualRow.start}px)`,
                            }}
                        >
                            {renderItem({
                                item,
                                index: virtualRow.index,
                                isSelected,
                                isTabStop: focusItemId === itemId,
                                onSelect: () => onSelectItem(itemId),
                                onNavigate: (event) => onNavigate(event, virtualRow.index),
                                itemRef: (element) => registerItem(itemId, element),
                            })}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
