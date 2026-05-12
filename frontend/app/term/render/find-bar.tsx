// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// FindBar — slim input strip that appears above the block list when the
// user hits Cmd+F.
//
// Behavior:
//   * Live highlight (not row filter) as the user types — rows stay in
//     place, matches get an amber rectangle behind them, the current
//     match has a stronger outline.
//   * Enter → jump to the next match; Shift+Enter → previous.  Both wrap
//     around the result list.
//   * Match counter (N / M) on the right.
//   * Case-sensitive toggle next to the counter.
//   * Esc dismisses the bar and clears the query.

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useRef } from "react";
import { TerminalModel } from "../terminal-model";

interface FindBarProps {
    model: TerminalModel;
}

export const FindBar = memo(({ model }: FindBarProps) => {
    const visible = useAtomValue(model.findVisibleAtom);
    const query = useAtomValue(model.findQueryAtom);
    const matches = useAtomValue(model.findMatchesAtom);
    const currentIndex = useAtomValue(model.findCurrentIndexAtom);
    const caseSensitive = useAtomValue(model.findCaseSensitiveAtom);
    const regexEnabled = useAtomValue(model.findRegexAtom);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (visible) {
            queueMicrotask(() => inputRef.current?.focus());
        }
    }, [visible]);

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Escape") {
                e.preventDefault();
                model.toggleFindVisible();
                return;
            }
            if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) model.findPrev();
                else model.findNext();
            }
        },
        [model]
    );

    if (!visible) return null;

    const total = matches.length;
    const counterText = total === 0 ? (query ? "no matches" : "") : `${currentIndex + 1} / ${total}`;

    return (
        <div className={cn("flex shrink-0 items-center gap-2 border-b border-fg-overlay-2 bg-surface-1 px-3 py-1.5")}>
            <UIcon name="search-small" size={12} className="text-secondary" />
            <input
                ref={inputRef}
                type="text"
                value={query}
                placeholder="Find in output…"
                onChange={(e) => model.setFind(e.target.value)}
                onKeyDown={onKeyDown}
                className="flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-secondary/50"
            />
            <span className="font-mono text-[11px] tabular-nums text-secondary/80">
                {counterText}
            </span>
            <button
                type="button"
                onClick={() => model.findPrev()}
                disabled={total === 0}
                className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-secondary hover:bg-fg-overlay-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
                aria-label="Previous match (Shift+Enter)"
                title="Previous match (Shift+Enter)"
            >
                <UIcon name="arrow-up" size={11} />
            </button>
            <button
                type="button"
                onClick={() => model.findNext()}
                disabled={total === 0}
                className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-secondary hover:bg-fg-overlay-2 hover:text-foreground disabled:cursor-default disabled:opacity-40"
                aria-label="Next match (Enter)"
                title="Next match (Enter)"
            >
                <UIcon name="arrow-down" size={11} />
            </button>
            <button
                type="button"
                onClick={() => model.setFindCaseSensitive(!caseSensitive)}
                className={cn(
                    "flex h-5 cursor-pointer items-center rounded px-1 font-mono text-[10px] hover:bg-fg-overlay-2",
                    caseSensitive ? "bg-fg-overlay-2 text-foreground" : "text-secondary"
                )}
                aria-label="Toggle case sensitivity"
                title="Case-sensitive"
            >
                Aa
            </button>
            <button
                type="button"
                onClick={() => model.setFindRegex(!regexEnabled)}
                className={cn(
                    "flex h-5 cursor-pointer items-center rounded px-1 font-mono text-[10px] hover:bg-fg-overlay-2",
                    regexEnabled ? "bg-fg-overlay-2 text-foreground" : "text-secondary"
                )}
                aria-label="Toggle regex"
                title="Regular expression"
            >
                .*
            </button>
            <button
                type="button"
                onClick={() => model.toggleFindVisible()}
                className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-secondary hover:bg-fg-overlay-2 hover:text-foreground"
                aria-label="Close find"
                title="Close find (Esc)"
            >
                <UIcon name="x-close" size={11} />
            </button>
        </div>
    );
});
FindBar.displayName = "FindBar";
