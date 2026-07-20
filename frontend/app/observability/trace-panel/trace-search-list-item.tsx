/**
 * SearchListItem - Individual search result row.
 *
 * Renders a single search result using ItemBadge + SpanContent.
 */

import { cn } from "@/util/util";
import { ItemBadge } from "./item-badge";
import { SpanContent } from "./span-content";
import type { TraceSearchListItem as SearchListItem } from "./types";

interface TraceSearchListItemProps {
    item: SearchListItem;
    isSelected: boolean;
    onSelect: () => void;
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

export function TraceSearchListItem({ item, isSelected, onSelect, onHover }: TraceSearchListItemProps) {
    const { node, parentTotalCost, parentTotalDuration } = item;
    const traceRelativeTime = formatIntervalSeconds(node.startTimeSinceTrace / 1000);
    const parentRelativeTime =
        node.startTimeSinceParentStart !== null ? formatIntervalSeconds(node.startTimeSinceParentStart / 1000) : null;

    return (
        <div
            role="option"
            aria-selected={isSelected}
            onClick={onSelect}
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
