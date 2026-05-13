// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// FindHighlightLayer — overlay that draws yellow rectangles on every
// match of the active find query within a single block.  The currently-
// focused match (driven by Cmd+G / FindBar prev/next) gets a stronger
// outline so the user can tell which one will be jumped to next.
//
// Match identity is by reference: TerminalModel computes the matches
// once per setFind() and stashes them in a stable array, so a `===`
// against `activeMatch` reliably identifies the active rectangle.

import { memo } from "react";
import { FindMatch } from "../terminal-model";

export interface FindHighlightLayerProps {
    matches: FindMatch[]; // pre-filtered to this block
    activeMatch: FindMatch | null;
    charWidth: number;
    lineHeight: number;
}

export const FindHighlightLayer = memo(
    ({ matches, activeMatch, charWidth, lineHeight }: FindHighlightLayerProps) => {
        if (matches.length === 0) return null;
        return (
            <div className="pointer-events-none absolute inset-0">
                {matches.map((m, i) => {
                    const isActive = m === activeMatch;
                    // Snap to pixel boundaries — same reasoning as
                    // SelectionLayer: floating-point edges can leave
                    // a 1px gap when a glyph extends past the rect.
                    const left = Math.floor(m.startCol * charWidth);
                    const right = Math.ceil(m.endCol * charWidth);
                    return (
                        <div
                            key={i}
                            // Visual reference: warp
                            // crates/warp_core/src/ui/theme/color.rs:312-314
                            // find_bar_button_selection_color = accent_overlay_2
                            // (accent @ 25%).  Active match gets a stronger
                            // ring so prev/next focus is visible at a glance;
                            // inactive matches use the same hue at a fainter
                            // alpha so the runs are detectable without
                            // overwhelming the row colors.
                            className={
                                isActive
                                    ? "absolute bg-[var(--color-term-accent-25)] ring-1 ring-[var(--color-term-accent)]"
                                    : "absolute bg-[var(--color-term-accent-10)]"
                            }
                            style={{
                                top: `${m.row * lineHeight}px`,
                                height: `${lineHeight}px`,
                                left: `${left}px`,
                                width: `${right - left}px`,
                            }}
                        />
                    );
                })}
            </div>
        );
    }
);
FindHighlightLayer.displayName = "FindHighlightLayer";
