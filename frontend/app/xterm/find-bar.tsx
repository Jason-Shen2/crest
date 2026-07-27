// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// FindBar — floating search strip in a pane's top-right corner (Cmd+F).
// Searches the whole xterm buffer through the session-level find accessors
// (never a captured addon reference, which a slot rebind would strand), so
// it works identically in plain and blocks mode; per-block search in
// BlockOverlay stays separate. UX ports the old render/find-bar.tsx:
// incremental highlight while typing, Enter/Shift+Enter cycle matches,
// Esc closes, match counter, case-sensitive and regex toggles. The addon
// prop is only tapped for onDidChangeResults (the counter) and may be null
// while the pane is dormant.

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import type { SearchAddon } from "@xterm/addon-search";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
    clearSessionFind,
    findInSession,
    findNextInSession,
    findPreviousInSession,
    type SessionFindOptions,
} from "./xterm-session";

interface FindBarProps {
    blockId: string;
    addon: SearchAddon | null;
    // Bumped by the host on every Cmd+F so an already-open bar refocuses.
    focusSeq: number;
    onClose: () => void;
}

type FindResults = { index: number; count: number };

function counterText(query: string, results: FindResults): string {
    if (!query || !results) return "";
    if (results.count === 0) return "no matches";
    // index < 0 means the addon's highlight limit was exceeded.
    if (results.index < 0) return `${results.count}+`;
    return `${results.index + 1} / ${results.count}`;
}

export const FindBar = memo(({ blockId, addon, focusSeq, onClose }: FindBarProps) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [regexEnabled, setRegexEnabled] = useState(false);
    const [results, setResults] = useState<FindResults>(null);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [focusSeq]);

    useEffect(() => () => clearSessionFind(blockId), [blockId]);

    useEffect(() => {
        if (!addon) return;
        const sub = addon.onDidChangeResults((e) => setResults({ index: e.resultIndex, count: e.resultCount }));
        return () => sub.dispose();
    }, [addon]);

    const runFind = useCallback(
        (q: string, opts: SessionFindOptions) => {
            findInSession(blockId, q, opts);
            if (!q) setResults(null);
        },
        [blockId]
    );

    const onChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const next = e.target.value;
            setQuery(next);
            runFind(next, { caseSensitive, regex: regexEnabled });
        },
        [runFind, caseSensitive, regexEnabled]
    );

    const findPrev = useCallback(() => {
        findPreviousInSession(blockId, query, { caseSensitive, regex: regexEnabled });
    }, [blockId, query, caseSensitive, regexEnabled]);

    const findNext = useCallback(() => {
        findNextInSession(blockId, query, { caseSensitive, regex: regexEnabled });
    }, [blockId, query, caseSensitive, regexEnabled]);

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onClose();
                return;
            }
            if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) findPrev();
                else findNext();
            }
        },
        [onClose, findPrev, findNext]
    );

    const toggleCase = useCallback(() => {
        const next = !caseSensitive;
        setCaseSensitive(next);
        runFind(query, { caseSensitive: next, regex: regexEnabled });
    }, [caseSensitive, query, regexEnabled, runFind]);

    const toggleRegex = useCallback(() => {
        const next = !regexEnabled;
        setRegexEnabled(next);
        runFind(query, { caseSensitive, regex: next });
    }, [regexEnabled, query, caseSensitive, runFind]);

    const hasQuery = query.length > 0;

    return (
        <div
            data-testid="xterm-find-bar"
            className="absolute right-2 top-2 z-20 flex items-center gap-1.5 rounded-md border border-border bg-popover/95 px-2 py-1 shadow-[0_4px_14px_rgba(0,0,0,0.28)]"
        >
            <UIcon name="search-small" size={12} className="shrink-0 text-muted-foreground" />
            <input
                ref={inputRef}
                type="text"
                value={query}
                placeholder="Find in terminal"
                aria-label="Find in terminal"
                onChange={onChange}
                onKeyDown={onKeyDown}
                className="w-40 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
            />
            <span className="whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground">
                {counterText(query, results)}
            </span>
            <button
                type="button"
                onClick={findPrev}
                disabled={!hasQuery}
                className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-fg-overlay-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                aria-label="Previous match (Shift+Enter)"
                title="Previous match (Shift+Enter)"
            >
                <UIcon name="chevron-up" size={11} />
            </button>
            <button
                type="button"
                onClick={findNext}
                disabled={!hasQuery}
                className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-fg-overlay-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                aria-label="Next match (Enter)"
                title="Next match (Enter)"
            >
                <UIcon name="chevron-down" size={11} />
            </button>
            <button
                type="button"
                onClick={toggleCase}
                className={cn(
                    "flex h-5 cursor-pointer items-center rounded px-1 font-mono text-[10px] hover:bg-fg-overlay-2",
                    caseSensitive ? "bg-[var(--color-term-accent-25)] text-foreground" : "text-muted-foreground"
                )}
                aria-label="Toggle case sensitivity"
                title="Case-sensitive"
            >
                Aa
            </button>
            <button
                type="button"
                onClick={toggleRegex}
                className={cn(
                    "flex h-5 cursor-pointer items-center rounded px-1 font-mono text-[10px] hover:bg-fg-overlay-2",
                    regexEnabled ? "bg-[var(--color-term-accent-25)] text-foreground" : "text-muted-foreground"
                )}
                aria-label="Toggle regex"
                title="Regular expression"
            >
                .*
            </button>
            <button
                type="button"
                onClick={onClose}
                className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-fg-overlay-2 hover:text-foreground"
                aria-label="Close find (Esc)"
                title="Close find (Esc)"
            >
                <UIcon name="x-close" size={11} />
            </button>
        </div>
    );
});
FindBar.displayName = "FindBar";
