// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// SelectionLayer — absolute-positioned overlay that paints the selection
// highlight on top of a Grid.  Never touches the cell stream; reads the
// per-block slice computed by the parent and draws rectangles.
//
// Up to 3 rectangles cover any rectangular slice across rows:
//
//   row == startRow == endRow:           1 rect (from startCol → endCol)
//   startRow < endRow:                   up to 3 rects:
//      - top:    startRow, startCol → end-of-row
//      - middle: rows in (startRow, endRow), full width
//      - bottom: endRow, 0 → endCol

import { memo } from "react";
import { Grid } from "../engine/grid";
import { BlockSelectionSlice, expand } from "./selection";

export interface SelectionLayerProps {
    slice: BlockSelectionSlice | null;
    grid: Grid;
    charWidth: number;
    lineHeight: number;
}

export const SelectionLayer = memo(({ slice, grid, charWidth, lineHeight }: SelectionLayerProps) => {
    if (!slice) return null;
    const n = expand(slice, grid);
    const isBlock = slice.mode === "block" && slice.isStartBlock && slice.isEndBlock;
    const rects = isBlock ? buildBlockRect(n) : buildLineWrapRects(n, grid.cols);
    return (
        <div className="pointer-events-none absolute inset-0">
            {rects.map((r, i) => {
                // Snap rect edges to pixel boundaries so sub-pixel
                // glyph rendering doesn't leak past the highlight.
                // `left = floor` / `right = ceil` together cover every
                // pixel any glyph in [startCol, endCol) could touch.
                const left = Math.floor(r.startCol * charWidth);
                const right = Math.ceil(r.endCol * charWidth);
                return (
                    <div
                        key={i}
                        // Visual reference: warp
                        // crates/warp_core/src/ui/theme/color.rs:303-304
                        // text_selection_color = ColorU(118, 167, 250, 102)
                        // — periwinkle blue at 40% alpha.  Distinct from
                        // the (sky-blue) accent so users can tell text
                        // selection apart from block-level highlights.
                        className="absolute bg-[var(--color-term-selection)]"
                        style={{
                            top: `${r.row * lineHeight}px`,
                            height: `${r.rows * lineHeight}px`,
                            left: `${left}px`,
                            width: `${right - left}px`,
                        }}
                    />
                );
            })}
        </div>
    );
});
SelectionLayer.displayName = "SelectionLayer";

interface Rect {
    row: number;
    rows: number;
    startCol: number;
    endCol: number;
}

interface NormalizedRange {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
}

// block / rectangular: one rect covering the whole vertical span.
function buildBlockRect(n: NormalizedRange): Rect[] {
    if (n.endRow < n.startRow) return [];
    if (n.endCol <= n.startCol) return [];
    return [
        {
            row: n.startRow,
            rows: n.endRow - n.startRow + 1,
            startCol: n.startCol,
            endCol: n.endCol,
        },
    ];
}

// char / word / line: the natural line-wrap rendering — first row right
// edge wraps full-width to the last row's start.
function buildLineWrapRects(n: NormalizedRange, cols: number): Rect[] {
    if (n.endRow < n.startRow) return [];
    if (n.startRow === n.endRow) {
        if (n.endCol <= n.startCol) return [];
        return [{ row: n.startRow, rows: 1, startCol: n.startCol, endCol: n.endCol }];
    }
    const rects: Rect[] = [];
    rects.push({ row: n.startRow, rows: 1, startCol: n.startCol, endCol: cols });
    const midRows = n.endRow - n.startRow - 1;
    if (midRows > 0) {
        rects.push({ row: n.startRow + 1, rows: midRows, startCol: 0, endCol: cols });
    }
    if (n.endCol > 0) {
        rects.push({ row: n.endRow, rows: 1, startCol: 0, endCol: n.endCol });
    }
    return rects;
}
