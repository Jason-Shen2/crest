// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// CommandSelectorPanel — shared primitives for slash-command selector panels
// (/model, /tree, /fork, /resume, and future commands).
//
// Provides:
//   - Shared layout constants
//   - CommandSelectorSearchBar — unified search input
//   - CommandSelectorHintFooter — configurable keyboard hint footer
//   - CommandSelectorMessage — status/error/empty message
//   - CommandSelectorPanel — root container with consistent styling

import { cn } from "@/util/util";
import { Search } from "lucide-react";
import type { RefObject } from "react";
import { memo, useCallback, useEffect, useState } from "react";

// =========================================================================
// Shared interaction behavior
// =========================================================================
//
// These hooks are the single source of truth for selector *behavior*
// (keyboard navigation, focus, scroll), so /model, /tree, /fork and
// /resume stay consistent. Each panel still owns its layout and its
// command-specific keys (tab switching, tree folding, `/` to filter),
// but the shared ↑↓ / Enter / Esc skeleton and the focus/scroll effects
// live here.

export interface CommandSelectorNavigation {
    /** Index of the currently highlighted row. */
    activeIdx: number;
    setActiveIdx: (next: number | ((prev: number) => number)) => void;
    /**
     * Handles the shared navigation keys (ArrowDown / ArrowUp wrap-around,
     * Enter commit, Escape dismiss). Returns true when the event was
     * consumed so callers can fall through to command-specific keys.
     */
    handleNavKey: (e: React.KeyboardEvent) => boolean;
}

export interface UseCommandSelectorNavigationOptions {
    /** Number of currently visible/selectable rows. */
    itemCount: number;
    /** Commit the row at the given index (Enter / programmatic select). */
    onCommit: (index: number) => void;
    /** Dismiss the panel (Escape). */
    onDismiss: () => void;
    /** When true, Enter / commit is ignored (e.g. a pick is in flight). */
    commitDisabled?: boolean;
}

/**
 * Owns the highlighted-row index and the shared keyboard skeleton.
 * Keeps activeIdx clamped within [0, itemCount) as the list changes.
 */
export function useCommandSelectorNavigation({
    itemCount,
    onCommit,
    onDismiss,
    commitDisabled = false,
}: UseCommandSelectorNavigationOptions): CommandSelectorNavigation {
    const [activeIdx, setActiveIdx] = useState(0);

    useEffect(() => {
        if (itemCount === 0) {
            setActiveIdx(0);
        } else if (activeIdx >= itemCount) {
            setActiveIdx(itemCount - 1);
        }
    }, [itemCount, activeIdx]);

    const handleNavKey = useCallback(
        (e: React.KeyboardEvent): boolean => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                if (itemCount === 0) return true;
                setActiveIdx((prev) => (prev + 1) % itemCount);
                return true;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                if (itemCount === 0) return true;
                setActiveIdx((prev) => (prev - 1 + itemCount) % itemCount);
                return true;
            }
            if (e.key === "Enter") {
                e.preventDefault();
                if (!commitDisabled && itemCount > 0) onCommit(activeIdx);
                return true;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onDismiss();
                return true;
            }
            return false;
        },
        [itemCount, activeIdx, onCommit, onDismiss, commitDisabled]
    );

    return { activeIdx, setActiveIdx, handleNavKey };
}

/**
 * Scrolls the active row into view whenever the highlighted index changes.
 * `rowSelector` builds the attribute selector for the row at a given index
 * (e.g. `(i) => \`[data-row-idx="\${i}"]\``).
 */
export function useScrollActiveRowIntoView(
    listRef: RefObject<HTMLElement | null>,
    activeIdx: number,
    rowSelector: (index: number) => string,
    enabled = true
) {
    useEffect(() => {
        if (!enabled) return;
        const row = listRef.current?.querySelector<HTMLElement>(rowSelector(activeIdx));
        row?.scrollIntoView({ block: "nearest" });
        // rowSelector is expected to be stable/inline; intentionally omitted.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeIdx, enabled, listRef]);
}

/**
 * Moves keyboard focus onto `targetRef` once `ready` becomes true, so the
 * element that owns the keyboard handler actually receives key events on
 * open. Restores nothing — callers manage focus restoration separately.
 */
export function useFocusOnReady(targetRef: RefObject<HTMLElement | null>, ready: boolean) {
    useEffect(() => {
        if (!ready) return;
        const id = window.setTimeout(() => targetRef.current?.focus({ preventScroll: true }), 0);
        return () => window.clearTimeout(id);
    }, [ready, targetRef]);
}

// =========================================================================
// Shared constants
// =========================================================================

export const COMMAND_SELECTOR_LIST_MAX_HEIGHT_PX = 360;
export const COMMAND_SELECTOR_LIST_MIN_HEIGHT_PX = 200;
export const COMMAND_SELECTOR_LIST_MAX_RESIZE_HEIGHT_PX = 720;
export const COMMAND_SELECTOR_SEARCH_FONT_PX = 12;
export const COMMAND_SELECTOR_ROW_FONT_PX = 12;
export const COMMAND_SELECTOR_FOOTER_FONT_PX = 11;
export const COMMAND_SELECTOR_ROW_LINE_HEIGHT_PX = 22;
export const COMMAND_SELECTOR_KBD_HEIGHT_PX = 14;

// =========================================================================
// CommandSelectorMessage — loading / error / empty state
// =========================================================================

interface CommandSelectorMessageProps {
    children: React.ReactNode;
    tone?: "muted" | "error";
}

export const CommandSelectorMessage = memo(function CommandSelectorMessage({
    children,
    tone = "muted",
}: CommandSelectorMessageProps) {
    return (
        <div
            className={cn(
                "px-3 py-4 text-center font-sans",
                tone === "error" ? "text-rose-300" : "text-secondary/75"
            )}
        >
            {children}
        </div>
    );
});

// =========================================================================
// CommandSelectorSearchBar — unified search input
// =========================================================================

export interface CommandSelectorSearchBarProps {
    inputRef?: RefObject<HTMLInputElement | null>;
    value: string;
    onChange: (v: string) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    placeholder?: string;
    showShortcutHint?: boolean;
    autoFocus?: boolean;
    shortcutKey?: string;
    py?: string;
    fontFamily?: "mono" | "sans";
}

export const CommandSelectorSearchBar = memo(function CommandSelectorSearchBar({
    inputRef,
    value,
    onChange,
    onKeyDown,
    placeholder = "filter…",
    showShortcutHint = true,
    autoFocus = false,
    shortcutKey = "/",
    py = "py-1.5",
    fontFamily = "mono",
}: CommandSelectorSearchBarProps) {
    return (
        <div
            className={cn("flex cursor-text items-center gap-2 border-b border-fg-overlay-2/80 px-3", py)}
            onClick={() => {
                if (document.activeElement !== inputRef?.current) {
                    inputRef?.current?.focus();
                }
            }}
        >
            <Search size={13} className="shrink-0 text-secondary/50" />
            <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                spellCheck={false}
                autoComplete="off"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus={autoFocus}
                className={cn(
                    "w-full bg-transparent text-foreground outline-none placeholder:text-secondary/45",
                    fontFamily === "mono" ? "font-mono" : "font-sans"
                )}
                style={{ fontSize: `${COMMAND_SELECTOR_SEARCH_FONT_PX}px`, lineHeight: "18px" }}
            />
            {showShortcutHint && !value && (
                <kbd
                    className="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1 font-sans text-secondary/60"
                    style={{ fontSize: "10px" }}
                >
                    {shortcutKey}
                </kbd>
            )}
        </div>
    );
});

// =========================================================================
// CommandSelectorHintFooter — configurable keyboard hint footer
// =========================================================================

export interface SelectorHint {
    keys: string[];
    label: string;
}

interface CommandSelectorHintFooterProps {
    hints: SelectorHint[];
    countText?: string;
}

function KbdKey({ children }: { children: React.ReactNode }) {
    return (
        <kbd
            className="inline-flex items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1 font-sans"
            style={{ height: `${COMMAND_SELECTOR_KBD_HEIGHT_PX}px`, minWidth: `${COMMAND_SELECTOR_KBD_HEIGHT_PX}px`, fontSize: "10px" }}
        >
            {children}
        </kbd>
    );
}

export const CommandSelectorHintFooter = memo(function CommandSelectorHintFooter({
    hints,
    countText,
}: CommandSelectorHintFooterProps) {
    return (
        <div
            className="flex items-center gap-x-3 border-t border-fg-overlay-2 bg-fg-overlay-1/60 px-3 py-1.5 font-sans text-secondary/65"
            style={{ fontSize: `${COMMAND_SELECTOR_FOOTER_FONT_PX}px` }}
        >
            {hints.map((hint, i) => (
                <span key={i} className="inline-flex items-center gap-1.5">
                    {hint.keys.map((k, ki) => (
                        <KbdKey key={ki}>{k}</KbdKey>
                    ))}
                    <span>{hint.label}</span>
                </span>
            ))}
            {countText && (
                <span className="ml-auto font-mono tabular-nums text-secondary/50">
                    {countText}
                </span>
            )}
        </div>
    );
});

// =========================================================================
// CommandSelectorPanel — root container with consistent styling
// =========================================================================

interface CommandSelectorPanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "ref" | "role" | "tabIndex"> {
    panelRef?: RefObject<HTMLDivElement | null>;
    ariaLabel?: string;
    fontFamily?: "mono" | "sans";
}

export const CommandSelectorPanel = memo(function CommandSelectorPanel({
    panelRef,
    ariaLabel,
    children,
    fontFamily = "mono",
    className,
    ...rest
}: CommandSelectorPanelProps) {
    return (
        <div
            ref={panelRef}
            tabIndex={-1}
            role="listbox"
            aria-label={ariaLabel}
            className={cn(
                "text-foreground outline-none focus:outline-none",
                fontFamily === "mono" ? "font-mono" : "font-sans",
                className
            )}
            style={{ fontSize: `${COMMAND_SELECTOR_ROW_FONT_PX}px` }}
            {...rest}
        >
            {children}
        </div>
    );
});
