// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// BlockContextMenu — popover shown on right-click of a command block.
// Surfaces the same actions that live on the hover-toolbelt, plus
// "Copy command", "Copy block" (cmd + output), "Re-run command".
//
// Positioned fixed to viewport so it isn't clipped by the block's
// overflow:hidden ancestors.  Dismissed on outside click or Escape.

import { cn } from "@/util/util";
import { useEffect, useRef } from "react";

// Action item.  Renders as a clickable row.
export interface BlockContextMenuItem {
    label: string;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
}

// Separator row.  Used to group related actions (copy / navigate /
// crest-specific) the way warp's block context menu groups them.
export interface BlockContextMenuSeparator {
    separator: true;
}

export type BlockContextMenuEntry = BlockContextMenuItem | BlockContextMenuSeparator;

export interface BlockContextMenuProps {
    x: number;
    y: number;
    items: BlockContextMenuEntry[];
    onClose: () => void;
}

function isSeparator(e: BlockContextMenuEntry): e is BlockContextMenuSeparator {
    return (e as BlockContextMenuSeparator).separator === true;
}

export function BlockContextMenu({ x, y, items, onClose }: BlockContextMenuProps) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onPointerDown = (e: MouseEvent) => {
            const r = ref.current;
            if (r && !r.contains(e.target as Node)) onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        };
        // Slight delay before attaching pointer listener so the click that
        // *opened* the menu doesn't immediately close it.
        const id = setTimeout(() => {
            document.addEventListener("mousedown", onPointerDown);
        }, 0);
        document.addEventListener("keydown", onKey);
        return () => {
            clearTimeout(id);
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [onClose]);

    return (
        <div
            ref={ref}
            className="fixed z-50 min-w-[200px] rounded border border-fg-overlay-2 bg-surface-1 py-1 text-[12px] shadow-lg"
            style={{ left: `${x}px`, top: `${y}px` }}
        >
            {items.map((entry, i) => {
                if (isSeparator(entry)) {
                    // Drop leading / consecutive / trailing separators
                    // — keep only ones that sit between two action rows
                    // so collapsed-empty groups don't leave stray rules.
                    if (i === 0) return null;
                    if (i === items.length - 1) return null;
                    const prev = items[i - 1];
                    if (prev && isSeparator(prev)) return null;
                    let hasMore = false;
                    for (let j = i + 1; j < items.length; j++) {
                        if (!isSeparator(items[j])) {
                            hasMore = true;
                            break;
                        }
                    }
                    if (!hasMore) return null;
                    return <div key={i} className="my-1 h-px bg-fg-overlay-2" />;
                }
                return (
                    <button
                        key={i}
                        type="button"
                        disabled={entry.disabled}
                        onClick={() => {
                            entry.onClick();
                            onClose();
                        }}
                        className={cn(
                            "flex w-full cursor-pointer items-center px-3 py-1 text-left hover:bg-fg-overlay-2 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent",
                            entry.danger ? "text-rose-400" : "text-foreground"
                        )}
                    >
                        {entry.label}
                    </button>
                );
            })}
        </div>
    );
}
