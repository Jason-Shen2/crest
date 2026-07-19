/**
 * TraceSearchList - Search results view.
 *
 * Displays filtered list of observations based on search query.
 * Uses VirtualizedList for performance with large result sets.
 */

import { X } from "lucide-react";
import { useMemo } from "react";

import { useTraceData, useTraceSelection } from "./trace-context";
import { TraceSearchListItem } from "./trace-search-list-item";
import { VirtualizedList } from "./virtualized-list";

export function TraceSearchList() {
    const { searchItems } = useTraceData();
    const { searchQuery, setSearchQuery, selectedNodeId, setSelectedNodeId } = useTraceSelection();
    const searchResults = useMemo(() => {
        if (!searchQuery.trim()) {
            return [];
        }
        const query = searchQuery.toLowerCase();
        return searchItems.filter((item) => {
            const node = item.node;
            return (
                node.type.toLowerCase().includes(query) ||
                node.name.toLowerCase().includes(query) ||
                node.id.toLowerCase().includes(query)
            );
        });
    }, [searchItems, searchQuery]);

    if (searchResults.length === 0 && searchQuery.trim()) {
        return (
            <div className="flex h-full flex-col items-center justify-center p-8 text-center">
                <div className="space-y-4">
                    <p className="text-muted-foreground">No results found</p>
                    <p className="text-sm text-muted-foreground">Try searching by type, title, or id</p>
                    <button
                        type="button"
                        className="inline-flex cursor-pointer items-center rounded border border-border px-2 py-1 text-xs hover:bg-fg-overlay-1"
                        onClick={() => setSearchQuery("")}
                    >
                        <X className="mr-2 h-4 w-4" />
                        Clear search
                    </button>
                </div>
            </div>
        );
    }

    return (
        <VirtualizedList
            items={searchResults}
            selectedItemId={selectedNodeId}
            onSelectItem={(id) => {
                const item = searchResults.find((result) => result.node.id === id);
                setSelectedNodeId(item?.node.type === "TRACE" ? null : id);
            }}
            getItemId={(item) => item.node.id}
            estimatedItemSize={48}
            renderItem={({ item, isSelected, onSelect }) => (
                <TraceSearchListItem item={item} isSelected={isSelected} onSelect={onSelect} />
            )}
        />
    );
}
