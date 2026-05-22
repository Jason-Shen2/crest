// Copyright 2026, Crest contributors. SPDX-License-Identifier: Apache-2.0
//
// ToolCommandCard — specialised body for shell-style tools (shell_exec).
// Structure derived from warp:
//   app/src/ai/blocklist/inline_action/requested_command.rs
// Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
//
// Renders the tool's `tooldesc` as a monospace command line in a card
// styled like a small terminal-prompt chip.  When the tool exposes a
// linked block (blockid set), shows an "Open block" affordance so the
// user can jump to the actual shell output that ran (warp's
// "headless block" attachment UX).

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { memo } from "react";

import type { WaveUIDataToolUse } from "./tool-use-card";

interface ToolCommandCardProps {
    tool: WaveUIDataToolUse;
    onOpenBlock?: (blockId: string) => void;
}

export const ToolCommandCard = memo(({ tool, onOpenBlock }: ToolCommandCardProps) => {
    // tooldesc is a one-line human summary the backend writes.  For
    // shell_exec it's roughly the literal command (without arg quoting).
    // We trim and word-wrap softly.
    const desc = (tool.tooldesc ?? "").trim();
    if (!desc) return null;
    return (
        <div className="mt-2 rounded border border-fg-overlay-2 bg-background/70">
            <div className="flex items-center gap-1.5 border-b border-fg-overlay-2/60 bg-fg-overlay-1/40 px-2 py-1 font-sans text-[11px] text-secondary/85">
                <UIcon name="terminal" size={11} className="shrink-0" />
                <span>shell</span>
                {tool.blockid && onOpenBlock && (
                    <button
                        type="button"
                        onClick={() => onOpenBlock(tool.blockid!)}
                        className={cn(
                            "ml-auto inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5",
                            "text-[var(--ansi-blue)] hover:bg-fg-overlay-2/60"
                        )}
                    >
                        <UIcon name="external-link" size={10} />
                        <span>Open block</span>
                    </button>
                )}
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[12px] leading-snug text-foreground/95">
                {desc}
            </pre>
            {tool.errormessage && (
                <div className="border-t border-fg-overlay-2/60 px-2 py-1 font-sans text-[11px] text-rose-300">
                    {tool.errormessage}
                </div>
            )}
        </div>
    );
});
ToolCommandCard.displayName = "ToolCommandCard";
