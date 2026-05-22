// Copyright 2026, Crest contributors. SPDX-License-Identifier: Apache-2.0
//
// CitationChips — chip row beneath a tool-use card.  Structure derived
// from warp:
//   app/src/ai/blocklist/inline_action/requested_command_attribution.rs
//   app/src/terminal/view/block/view_impl.rs:655-728 (click handlers)
// Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
//
// Each citation renders as a small chip: icon (per kind) + truncated
// title (≤30 chars) + optional line range.  Click behavior:
//   web / doc → openExternal(url)
//   file      → onFileJump(title, line) — host wires "scroll to block + line"
//   history   → copy title (the command) to clipboard

import { UIcon } from "@/app/element/ui-icon";
import { getApi } from "@/store/global";
import { cn } from "@/util/util";
import { memo, useCallback } from "react";

import { Citation } from "@/app/store/aitypes";

const TITLE_MAX_CHARS = 30;

function truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
}

interface CitationChipsProps {
    citations?: Citation[];
    // File-citation jump.  When omitted the chip is still clickable but
    // does nothing — caller is expected to wire scroll-to-block later
    // (P0.7 punch-list item).
    onFileJump?: (filename: string, line?: number) => void;
}

export const CitationChips = memo(({ citations, onFileJump }: CitationChipsProps) => {
    if (!citations || citations.length === 0) return null;
    return (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {citations.map((c, idx) => (
                <CitationChip key={`${c.kind}-${idx}-${c.title}`} citation={c} onFileJump={onFileJump} />
            ))}
        </div>
    );
});
CitationChips.displayName = "CitationChips";

interface CitationChipProps {
    citation: Citation;
    onFileJump?: (filename: string, line?: number) => void;
}

const CitationChip = memo(({ citation, onFileJump }: CitationChipProps) => {
    const icon = iconForKind(citation.kind);
    const label = formatLabel(citation);
    const onClick = useCallback(() => {
        switch (citation.kind) {
            case "web":
            case "doc":
                if (citation.url) {
                    try {
                        getApi().openExternal(citation.url);
                    } catch {
                        window.open(citation.url, "_blank", "noopener,noreferrer");
                    }
                }
                return;
            case "file":
                onFileJump?.(citation.title, citation.linestart);
                return;
            case "history":
                void navigator.clipboard.writeText(citation.title);
                return;
        }
    }, [citation, onFileJump]);
    return (
        <button
            type="button"
            onClick={onClick}
            title={titleAttr(citation)}
            className={cn(
                "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border border-fg-overlay-2/70 bg-fg-overlay-1/40 px-1.5 py-0.5 font-sans text-[11px] text-foreground/85 transition-colors",
                "hover:bg-fg-overlay-2/60 hover:text-foreground"
            )}
        >
            <UIcon name={icon} size={11} className="shrink-0 text-secondary/75" />
            <span className="truncate">{label}</span>
        </button>
    );
});
CitationChip.displayName = "CitationChip";

function iconForKind(kind: Citation["kind"]): string {
    switch (kind) {
        case "web":
            return "globe";
        case "file":
            return "file";
        case "history":
            return "clock";
        case "doc":
            return "book-open";
    }
}

function formatLabel(c: Citation): string {
    const base = truncate(c.title, TITLE_MAX_CHARS);
    if (c.kind === "file" && c.linestart != null) {
        if (c.lineend != null && c.lineend !== c.linestart) {
            return `${base}:${c.linestart}-${c.lineend}`;
        }
        return `${base}:${c.linestart}`;
    }
    return base;
}

function titleAttr(c: Citation): string {
    if (c.kind === "file") {
        const base = c.title;
        if (c.linestart != null) {
            return c.lineend != null && c.lineend !== c.linestart
                ? `${base}:${c.linestart}-${c.lineend}`
                : `${base}:${c.linestart}`;
        }
        return base;
    }
    if (c.kind === "web" || c.kind === "doc") {
        return c.url ?? c.title;
    }
    return c.title;
}
