// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// CellRun — a horizontal run of cells that share the same style.  The
// renderer merges contiguous same-style cells into one `<span>` so a row
// of, say, 80 cells with the same color is one DOM element instead of 80.
// This is the perf trick that makes DOM-based terminal rendering viable.

import { cn } from "@/util/util";
import { memo } from "react";
import { Cell, CellStyle } from "../engine/types";
import { resolveColor } from "./color";
import { PaletteOverrides, usePaletteOverrides } from "./palette-context";

interface CellRunProps {
    cells: Cell[]; // contiguous cells, all with the same style reference
    style: CellStyle;
    // OSC 8 link target.  Resolved from the grid's link table by the
    // GridElement parent (CellRun doesn't have a grid reference).  When set
    // and onLinkClick is wired, clicks open the URI.
    linkUri?: string;
    onLinkClick?: (uri: string) => void;
}

// styleToInline — convert engine CellStyle to a React style object.
function styleToInline(style: CellStyle, overrides: PaletteOverrides): React.CSSProperties {
    const out: React.CSSProperties = {};
    const fg = resolveColor(style.reverse ? style.bg : style.fg, "fg", overrides);
    const bg = resolveColor(style.reverse ? style.fg : style.bg, "bg", overrides);
    if (fg) out.color = fg;
    if (bg) out.backgroundColor = bg;
    if (style.bold) out.fontWeight = 700;
    if (style.italic) out.fontStyle = "italic";
    if (style.dim) out.opacity = 0.65;
    // Underline + strikethrough → text-decoration list.  CSS supports
    // combining them, but only via the line property.  We emit them
    // together so a cell with both decorations renders correctly.
    const lines: string[] = [];
    if (style.underline) lines.push("underline");
    if (style.strikethrough) lines.push("line-through");
    if (lines.length > 0) out.textDecoration = lines.join(" ");
    if (style.invisible) out.visibility = "hidden";
    return out;
}

export const CellRun = memo(({ cells, style, linkUri, onLinkClick }: CellRunProps) => {
    const overrides = usePaletteOverrides();
    const cellText = cellsToText(cells);
    const inline = styleToInline(style, overrides);
    const hasLink = style.linkId !== 0 && linkUri != null;
    const className = "whitespace-pre";
    if (hasLink) {
        return (
            <a
                href={linkUri}
                className={cn(className, "cursor-pointer")}
                style={inline}
                data-link-id={style.linkId}
                title={linkUri}
                onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onLinkClick?.(linkUri);
                }}
            >
                {cellText}
            </a>
        );
    }
    return (
        <span className={className} style={inline}>
            {cellText}
        </span>
    );
});
CellRun.displayName = "CellRun";

// cellsToText — concatenate cell chars, skipping the right-half of wide
// cells (width=0).  Empty char → space so the run still occupies the
// right number of columns.
function cellsToText(cells: Cell[]): string {
    let out = "";
    for (const cell of cells) {
        if (cell.width === 0) continue; // continuation of a wide cell
        if (cell.extra?.secret) {
            out += "█";
            continue;
        }
        out += cell.char.length > 0 ? cell.char : " ";
    }
    return out;
}
