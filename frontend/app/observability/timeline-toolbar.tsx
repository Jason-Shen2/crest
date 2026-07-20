// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RefObject } from "react";

import type { ObservationCategory } from "./observation-presentation";

const CategoryLabels: Array<{ category: ObservationCategory; label: string }> = [
    { category: "generation", label: "Generation" },
    { category: "tool", label: "Tool" },
    { category: "lifecycle", label: "Lifecycle" },
    { category: "error", label: "Errors" },
];

interface TimelineToolbarProps {
    query: string;
    categories: Set<ObservationCategory>;
    searchInputRef: RefObject<HTMLInputElement>;
    showBackToLive: boolean;
    onQueryChange: (query: string) => void;
    onShowAll: () => void;
    onToggleCategory: (category: ObservationCategory) => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
    onBackToLive: () => void;
}

export function TimelineToolbar({
    query,
    categories,
    searchInputRef,
    showBackToLive,
    onQueryChange,
    onShowAll,
    onToggleCategory,
    onExpandAll,
    onCollapseAll,
    onBackToLive,
}: TimelineToolbarProps) {
    return (
        <div className="flex flex-col gap-2 border-b border-border p-2">
            <div className="flex gap-2">
                <input
                    ref={searchInputRef}
                    aria-label="Search timeline"
                    className="min-w-0 flex-1 rounded border border-border bg-fg-overlay-1 px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
                    placeholder="Search timeline"
                    value={query}
                    onChange={(event) => onQueryChange(event.currentTarget.value)}
                />
                {showBackToLive ? (
                    <button
                        className="cursor-pointer rounded bg-accent/80 px-2 py-1 text-xs text-primary transition-colors hover:bg-accent"
                        type="button"
                        onClick={onBackToLive}
                    >
                        Back to live
                    </button>
                ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1">
                <button
                    aria-pressed={categories.size === CategoryLabels.length}
                    className={
                        categories.size === CategoryLabels.length
                            ? "cursor-pointer rounded border border-accent bg-accent/15 px-2 py-0.5 text-[11px] text-foreground"
                            : "cursor-pointer rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
                    }
                    type="button"
                    onClick={onShowAll}
                >
                    All
                </button>
                {CategoryLabels.map(({ category, label }) => {
                    const active = categories.has(category);
                    return (
                        <button
                            key={category}
                            aria-pressed={active}
                            className={
                                active
                                    ? "cursor-pointer rounded border border-accent bg-accent/15 px-2 py-0.5 text-[11px] text-foreground"
                                    : "cursor-pointer rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
                            }
                            type="button"
                            onClick={() => onToggleCategory(category)}
                        >
                            {label}
                        </button>
                    );
                })}
                <span className="mx-1 h-4 w-px bg-border" />
                <button
                    className="cursor-pointer px-1 text-[11px] text-muted-foreground hover:text-foreground"
                    type="button"
                    onClick={onExpandAll}
                >
                    Expand All
                </button>
                <button
                    className="cursor-pointer px-1 text-[11px] text-muted-foreground hover:text-foreground"
                    type="button"
                    onClick={onCollapseAll}
                >
                    Collapse All
                </button>
            </div>
        </div>
    );
}
