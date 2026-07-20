/**
 * SearchListItem - Individual search result row.
 *
 * Renders a single search result using ItemBadge + SpanContent.
 */

import { cn } from "@/util/util";
import type { KeyboardEvent, Ref } from "react";
import { ItemBadge } from "./item-badge";
import { SpanContent } from "./span-content";
import type { TraceSearchListItem as SearchListItem } from "./types";

interface TraceSearchListItemProps {
    item: SearchListItem;
    isSelected: boolean;
    isTabStop: boolean;
    onSelect: () => void;
    onNavigate: (event: KeyboardEvent<HTMLDivElement>) => void;
    itemRef: Ref<HTMLDivElement>;
    onHover?: () => void;
}

function formatIntervalSeconds(seconds: number): string {
    if (!Number.isFinite(seconds)) {
        return "0s";
    }
    if (seconds < 1) {
        return `${Math.round(seconds * 1000)}ms`;
    }
    return `${seconds.toFixed(2)}s`;
}

export function TraceSearchListItem({
    item,
    isSelected,
    isTabStop,
    onSelect,
    onNavigate,
    itemRef,
    onHover,
}: TraceSearchListItemProps) {
    const { node, parentTotalCost, parentTotalDuration } = item;
    const traceRelativeTime = formatIntervalSeconds(node.startTimeSinceTrace / 1000);
    const parentRelativeTime =
        node.startTimeSinceParentStart !== null ? formatIntervalSeconds(node.startTimeSinceParentStart / 1000) : null;

    return (
        <div
            ref={itemRef}
            role="option"
            aria-selected={isSelected}
            tabIndex={isTabStop ? 0 : -1}
            onClick={onSelect}
            onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                    onNavigate(event);
                    return;
                }
                event.preventDefault();
                onSelect();
            }}
            onMouseEnter={onHover}
            className={cn(
                "flex cursor-pointer items-start gap-2 px-2 py-1.5 transition-colors hover:bg-fg-overlay-1/50",
                isSelected && "bg-muted"
            )}
        >
            <ItemBadge type={node.type} />
            <div className="min-w-0 flex-1 space-y-0.5">
                <SpanContent
                    node={node}
                    parentTotalCost={parentTotalCost}
                    parentTotalDuration={parentTotalDuration}
                    onSelect={onSelect}
                    tabIndex={-1}
                />
                {node.type !== "TRACE" && (
                    <div className="text-xs text-muted-foreground/70">
                        depth {node.depth} • +{traceRelativeTime}
                        {parentRelativeTime !== null && ` • +${parentRelativeTime} from parent`}
                    </div>
                )}
            </div>
        </div>
    );
}
