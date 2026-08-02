// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Icon } from "@/app/icon/Icon";
import { cn } from "@/util/util";
import { useRef } from "react";
import { ContextPayload } from "./context-payload";

function payloadId(itemId: string): string {
    return `context-payload-panel-${encodeURIComponent(itemId)}`;
}

export function ContextItem({
    item,
    expanded,
    onToggle,
    accessibleContext,
}: {
    item: AgentContextSnapshotItemView;
    expanded: boolean;
    onToggle: (itemId: string) => void;
    accessibleContext?: string;
}) {
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelId = payloadId(item.id);
    const accessibleName = [accessibleContext, item.title, item.preview].filter(Boolean).join(", ");
    const closeFromPayload = () => {
        onToggle(item.id);
        buttonRef.current?.focus();
    };

    return (
        <article data-testid="context-inventory-item" className="border-t border-border/35 first:border-t-0">
            <button
                ref={buttonRef}
                type="button"
                aria-controls={panelId}
                aria-expanded={expanded}
                aria-label={accessibleName}
                className="flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left outline-none transition-colors motion-reduce:transition-none hover:bg-fg-overlay-1 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                onClick={() => onToggle(item.id)}
            >
                <Icon
                    name="chevron-right"
                    size={12}
                    className={cn(
                        "mt-0.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                        expanded && "rotate-90"
                    )}
                />
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">{item.title}</span>
                    {item.preview ? (
                        <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground">
                            {item.preview}
                        </span>
                    ) : null}
                </span>
            </button>
            {expanded ? (
                <ContextPayload itemId={item.id} panelId={panelId} content={item.content} onEscape={closeFromPayload} />
            ) : null}
        </article>
    );
}
