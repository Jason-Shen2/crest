// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { Tooltip } from "@/app/element/tooltip";
import { cn } from "@/util/util";
import { FloatingPortal } from "@floating-ui/react";
import { useEffect, useRef } from "react";
import { TabColorId, TabColorLabels, TabColorOrder, useTabColorPalette } from "./tab-color-utils";

// VtabMenuItem — richer than the Electron `ContextMenuItem` so we
// can express warp's "custom-label" color row (a single item that
// renders 7 interactive dots inline; see `dot_color_option_menu_items`
// at tab.rs:544-617).
export type VtabMenuItem =
    | { kind: "text"; label: string; click: () => void }
    | { kind: "separator" }
    | {
          kind: "color-row";
          // Currently-selected color id (TabColorId) or null/legacy
          // hex.  Storing the id (not the hex) is warp's pattern —
          // theme changes auto-recolor every flagged tab.
          current: string | null;
          // Receives null when the user clicks the "no color" dot or
          // re-clicks the currently-selected color (warp's
          // ToggleTabColor semantics — same color twice clears).
          onSelect: (colorId: TabColorId | null) => void;
      };

const DotSize = 14;
const RingSize = 18; // includes 2px ring

interface ColorDotProps {
    color: string | null; // null = no-color slot
    selected: boolean;
    label: string;
    onClick: () => void;
}

function ColorDot({ color, selected, label, onClick }: ColorDotProps) {
    // Warp `render_color_dot` (color_dot.rs:31-75):
    //  - 16px circle, optional slash-circle overlay for no-color
    //  - 2px ring in accent color when selected
    //  - pointer cursor + tooltip
    const isNoColor = color == null;
    return (
        <Tooltip content={label} placement="top" divClassName="shrink-0">
            <button
                type="button"
                onClick={onClick}
                aria-label={label}
                aria-pressed={selected}
                className={cn(
                    "relative flex shrink-0 cursor-pointer items-center justify-center rounded-full border-2 transition-colors",
                    selected ? "border-accent" : "border-transparent hover:border-fg-overlay-3"
                )}
                style={{ width: RingSize, height: RingSize }}
            >
                <span
                    className={cn(
                        "block rounded-full",
                        isNoColor && "border border-fg-overlay-3"
                    )}
                    style={{
                        width: DotSize,
                        height: DotSize,
                        backgroundColor: color ?? "transparent",
                    }}
                />
                {isNoColor && (
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-secondary">
                        <UIcon name="slash-circle" size={DotSize} />
                    </span>
                )}
            </button>
        </Tooltip>
    );
}

interface ColorDotRowProps {
    current: string | null;
    onSelect: (colorId: TabColorId | null) => void;
    onCloseMenu: () => void;
}

function ColorDotRow({ current, onSelect, onCloseMenu }: ColorDotRowProps) {
    // Warp `dot_color_option_menu_items` — flex row, SpaceBetween,
    // 1 no-color dot + 6 color dots.  The whole row sits inside a
    // single MenuItem with `no_highlight_on_hover` so the row's
    // background never tints on hover (only individual dots react).
    // Dot hexes come from the active terminal theme (warp's
    // `theme.terminal_colors().normal` resolution) — much better
    // looking than hardcoded saturated values.
    const palette = useTabColorPalette();
    const handleClick = (chosen: TabColorId | null) => {
        // Toggle semantics — clicking the currently-checked color
        // clears it (warp's ToggleTabColor dispatch path).  No-color
        // dot click is a no-op when nothing is set, else clears.
        if (chosen == null) {
            if (current != null) onSelect(null);
        } else if (chosen === current) {
            onSelect(null);
        } else {
            onSelect(chosen);
        }
        onCloseMenu();
    };
    return (
        <div className="flex items-center justify-between px-3 py-1.5">
            <ColorDot
                color={null}
                selected={current == null}
                label="Default (no color)"
                onClick={() => handleClick(null)}
            />
            {TabColorOrder.map((id) => (
                <ColorDot
                    key={id}
                    color={palette[id]}
                    selected={current === id}
                    label={TabColorLabels[id]}
                    onClick={() => handleClick(id)}
                />
            ))}
        </div>
    );
}

interface VtabContextMenuProps {
    items: VtabMenuItem[];
    // Either a cursor position (right-click) OR an anchor rect
    // (kebab button) — kebab anchors below the button.
    position: { x: number; y: number } | { anchorRect: DOMRect };
    onClose: () => void;
}

const MenuWidth = 220;

export function VtabContextMenu({ items, position, onClose }: VtabContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            // Inside the menu itself — let the menu's own item handlers
            // decide what to do.
            if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
                return;
            }
            // Click landed on a kebab/menu-trigger button.  Skip the
            // auto-close so the button's onClick can toggle the menu
            // off cleanly (without us closing first and triggering a
            // reopen on the same click).
            if (
                e.target instanceof Element &&
                e.target.closest("[data-vtab-menu-trigger]") != null
            ) {
                return;
            }
            onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("mousedown", onDown, true);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("mousedown", onDown, true);
            window.removeEventListener("keydown", onKey);
        };
    }, [onClose]);

    // Estimate vertical size so the menu doesn't fall off-screen.
    // We don't measure post-mount (no animation, no need to be
    // pixel-perfect) — just clamp using a rough item-height count.
    const approxHeight = items.reduce((acc, item) => {
        if (item.kind === "separator") return acc + 9;
        if (item.kind === "color-row") return acc + 36;
        return acc + 26;
    }, 12);

    let top: number;
    let left: number;
    if ("anchorRect" in position) {
        top = position.anchorRect.bottom + 6;
        left = position.anchorRect.left;
    } else {
        top = position.y;
        left = position.x;
    }
    top = Math.min(Math.max(8, top), window.innerHeight - approxHeight - 8);
    left = Math.min(Math.max(8, left), window.innerWidth - MenuWidth - 8);

    return (
        <FloatingPortal>
            <div
                ref={menuRef}
                role="menu"
                className={cn(
                    "fixed z-50 overflow-hidden rounded-md border border-fg-overlay-1 bg-background py-1.5",
                    "shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
                )}
                style={{ top, left, width: MenuWidth }}
                onContextMenu={(e) => e.preventDefault()}
            >
                {items.map((item, idx) => {
                    if (item.kind === "separator") {
                        return <div key={idx} className="my-1 h-px bg-fg-overlay-1" aria-hidden />;
                    }
                    if (item.kind === "color-row") {
                        return (
                            <ColorDotRow
                                key={idx}
                                current={item.current}
                                onSelect={item.onSelect}
                                onCloseMenu={onClose}
                            />
                        );
                    }
                    return (
                        <button
                            key={idx}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                item.click();
                                onClose();
                            }}
                            className="flex w-full cursor-pointer items-center px-3 py-[3px] text-left text-[15px] text-foreground hover:bg-fg-overlay-1"
                        >
                            {item.label}
                        </button>
                    );
                })}
            </div>
        </FloatingPortal>
    );
}
