// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Icon } from "@/app/icon/Icon";
import { useRef } from "react";
import { ContextPayload } from "./context-payload";

function payloadId(itemId: string): string {
    return `context-payload-panel-${encodeURIComponent(itemId)}`;
}

function disclosureId(itemId: string): string {
    return `context-payload-disclosure-${encodeURIComponent(itemId)}`;
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
    const buttonId = disclosureId(item.id);
    const accessibleName = [accessibleContext, item.title, item.preview].filter(Boolean).join(", ");
    const closeDisclosure = () => {
        if (!expanded) return;
        onToggle(item.id);
        buttonRef.current?.focus();
    };

    return (
        <article
            data-testid="context-inventory-item"
            className="border-t border-border/35 first:border-t-0"
            onKeyDown={(event) => {
                if (!expanded || event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                closeDisclosure();
            }}
        >
            <button
                id={buttonId}
                ref={buttonRef}
                type="button"
                aria-controls={panelId}
                aria-expanded={expanded}
                aria-label={accessibleName}
                className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left outline-none transition-colors motion-reduce:transition-none hover:bg-fg-overlay-1 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                onClick={() => onToggle(item.id)}
            >
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">{item.title}</span>
                    {item.preview ? (
                        <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground">
                            {item.preview}
                        </span>
                    ) : null}
                </span>
                <Icon name="unfold-more" size={14} className="shrink-0 text-muted-foreground/70" />
            </button>
            {expanded ? (
                <ContextPayload itemId={item.id} panelId={panelId} labelledBy={buttonId} content={item.content} />
            ) : null}
        </article>
    );
}
