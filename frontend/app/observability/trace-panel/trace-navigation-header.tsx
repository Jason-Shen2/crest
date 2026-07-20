// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TracePanelNavigationHeader.

import { ListTree, Search, Waypoints } from "lucide-react";

import { useTraceSelection } from "./trace-context";

export function TraceNavigationHeader() {
    const { navigationMode, setNavigationMode, searchQuery, setSearchQuery } = useTraceSelection();

    return (
        <div className="flex shrink-0 items-center gap-1 border-b border-border p-1.5">
            <button
                type="button"
                aria-label="Tree"
                aria-pressed={navigationMode === "tree"}
                className={`flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs ${
                    navigationMode === "tree"
                        ? "bg-accent/15 text-accent"
                        : "text-muted-foreground hover:bg-fg-overlay-1/60 hover:text-foreground"
                }`}
                onClick={() => setNavigationMode("tree")}
            >
                <ListTree className="h-3.5 w-3.5" />
                Tree
            </button>
            <button
                type="button"
                aria-label="Timeline"
                aria-pressed={navigationMode === "timeline"}
                className={`flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs ${
                    navigationMode === "timeline"
                        ? "bg-accent/15 text-accent"
                        : "text-muted-foreground hover:bg-fg-overlay-1/60 hover:text-foreground"
                }`}
                onClick={() => setNavigationMode("timeline")}
            >
                <Waypoints className="h-3.5 w-3.5" />
                Timeline
            </button>
            <label className="ml-auto flex min-w-32 max-w-56 flex-1 items-center gap-1 rounded border border-border bg-fg-overlay-1/40 px-2">
                <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
                <input
                    aria-label="Search trace"
                    className="min-w-0 flex-1 bg-transparent py-1 text-xs outline-none"
                    value={searchQuery}
                    placeholder="Search"
                    onChange={(event) => setSearchQuery(event.target.value)}
                />
            </label>
        </div>
    );
}
