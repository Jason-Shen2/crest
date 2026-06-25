// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Selection — cell-range selection that can span multiple blocks.
// Lives entirely in the renderer; never written into the cell stream
// so the underlying Grids are unmodified.
//
// Three modes:
//   * "char" — drag-select; endpoints are exact cell positions.
//   * "word" — double-click; endpoints snap to the surrounding "word"
//     run (alphanumerics + a handful of shell-friendly punctuation that
//     keeps `--flag-name`, `./path/file.ext`, `user@host:port` whole).
//   * "line" — triple-click; endpoints snap to the row's full width.
//
// Cross-block selection: the anchor and focus carry independent
// blockIds.  BlockListElement computes a `BlockSelectionSlice` per
// rendered block by consulting the block order; SelectionLayer paints
// that slice without knowing about the global picture.

import { Cell } from "../engine/types";
import { Grid } from "../engine/grid";
import { BlockId } from "../engine/types";

// "block" = rectangular / column selection.  Triggered by Alt+drag.
// Behavior: each row in the selected vertical range gets a uniform
// horizontal slice [minCol, maxCol).  Useful for clipping a "column"
// of data from tabular output (top, ls -l, kubectl get).
// Behavior reference: warp app/src/terminal/model/selection.rs
//   (ExpandedSelectionRange::Rect variant).
export type SelectionMode = "char" | "word" | "line" | "block";

export interface Selection {
    anchorBlockId: BlockId;
    anchorRow: number;
    anchorCol: number;
    focusBlockId: BlockId;
    focusRow: number;
    focusCol: number;
    mode: SelectionMode;
}

// BlockSelectionSlice — the part of a single block that's covered by
// the (possibly multi-block) selection.  Coordinates are within this
// block's grid.  `null` from the computer means "this block isn't in
// the selection range and shouldn't render anything".
export interface BlockSelectionSlice {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    // mode + endpoint flags let the renderer / extractor apply word /
    // line expansion only at the actual selection ends, not at every
    // block boundary (a middle block always renders full-width regardless
    // of mode).
    mode: SelectionMode;
    isStartBlock: boolean;
    isEndBlock: boolean;
}

// computeBlockSlice — what portion of the given block is selected,
// given the global selection and a block-order lookup.  Returns null
// if the block falls outside the [start..end] block range.
export function computeBlockSlice(
    sel: Selection,
    blockId: BlockId,
    blockIndex: (id: BlockId) => number
): BlockSelectionSlice | null {
    const anchorIdx = blockIndex(sel.anchorBlockId);
    const focusIdx = blockIndex(sel.focusBlockId);
    const thisIdx = blockIndex(blockId);
    if (thisIdx < 0 || anchorIdx < 0 || focusIdx < 0) return null;

    // Order anchor and focus in document order so we always render
    // a left-to-right, top-to-bottom range.
    let startBlockId: BlockId;
    let startRow: number;
    let startCol: number;
    let endBlockId: BlockId;
    let endRow: number;
    let endCol: number;
    const anchorBefore =
        anchorIdx < focusIdx ||
        (anchorIdx === focusIdx &&
            (sel.anchorRow < sel.focusRow ||
                (sel.anchorRow === sel.focusRow && sel.anchorCol <= sel.focusCol)));
    if (anchorBefore) {
        startBlockId = sel.anchorBlockId;
        startRow = sel.anchorRow;
        startCol = sel.anchorCol;
        endBlockId = sel.focusBlockId;
        endRow = sel.focusRow;
        endCol = sel.focusCol;
    } else {
        startBlockId = sel.focusBlockId;
        startRow = sel.focusRow;
        startCol = sel.focusCol;
        endBlockId = sel.anchorBlockId;
        endRow = sel.anchorRow;
        endCol = sel.anchorCol;
    }

    const startIdx = blockIndex(startBlockId);
    const endIdx = blockIndex(endBlockId);
    if (thisIdx < startIdx || thisIdx > endIdx) return null;

    const isStartBlock = thisIdx === startIdx;
    const isEndBlock = thisIdx === endIdx;

    return {
        startRow: isStartBlock ? startRow : 0,
        startCol: isStartBlock ? startCol : 0,
        // For non-end blocks we paint the whole vertical span; the
        // renderer reads grid.rowCount() to clamp.  Sentinel
        // Number.MAX_SAFE_INTEGER means "to the bottom of this grid".
        endRow: isEndBlock ? endRow : Number.MAX_SAFE_INTEGER,
        endCol: isEndBlock ? endCol : Number.MAX_SAFE_INTEGER,
        mode: sel.mode,
        isStartBlock,
        isEndBlock,
    };
}

// expand — apply mode-specific extension to slice endpoints within one
// grid.  Only the actual selection endpoints (isStartBlock / isEndBlock)
// get adjusted; middle blocks of a cross-block selection stay at natural
// boundaries.
export function expand(slice: BlockSelectionSlice, grid: Grid): { startRow: number; startCol: number; endRow: number; endCol: number } {
    const rowMax = Math.max(0, grid.rowCount() - 1);
    const startRow = Math.min(slice.startRow, rowMax);
    const endRow = Math.min(slice.endRow, rowMax);
    const startCol = Math.max(0, Math.min(slice.startCol, grid.cols));
    const endCol = Math.max(0, Math.min(slice.endCol, grid.cols));
    // block / rectangular — only valid inside one block; for cross-block
    // ranges we fall through to char semantics (a "rectangle" spanning
    // blocks would have ill-defined semantics).
    if (slice.mode === "block" && slice.isStartBlock && slice.isEndBlock) {
        const lo = Math.min(startCol, endCol);
        const hi = Math.max(startCol, endCol);
        return { startRow, startCol: lo, endRow, endCol: hi };
    }
    if (slice.mode === "char") {
        return { startRow, startCol, endRow, endCol };
    }
    if (slice.mode === "line") {
        return {
            startRow,
            startCol: slice.isStartBlock ? 0 : startCol,
            endRow,
            endCol: slice.isEndBlock ? grid.cols : endCol,
        };
    }
    // word mode (default fallthrough) — only adjust at endpoints.
    const startRowCells = grid.getRow(startRow);
    const endRowCells = grid.getRow(endRow);

    // Smart-select runs before word-boundary expansion for the pure
    // double-click case (single row, anchor == focus): try URL / email /
    // path / identifier regexes; if a match contains the click column,
    // the match wins.  After the user drags, anchor != focus so this
    // branch falls through to plain word boundary.
    if (
        slice.isStartBlock &&
        slice.isEndBlock &&
        startRow === endRow &&
        startCol === endCol
    ) {
        const rowText = rowToText(startRowCells);
        const m = smartSelectMatch(rowText, startCol);
        if (m) {
            return { startRow, startCol: m.start, endRow, endCol: m.end };
        }
    }

    const newStartCol = slice.isStartBlock
        ? wordBoundaryLeft(startRowCells, Math.min(startCol, startRowCells.length))
        : startCol;
    const newEndCol = slice.isEndBlock
        ? wordBoundaryRight(endRowCells, Math.min(endCol, endRowCells.length))
        : endCol;
    return { startRow, startCol: newStartCol, endRow, endCol: newEndCol };
}

// extractTextFromSlice — pull the text covered by a single block's
// slice.  Caller concatenates across blocks for multi-block selection,
// separating with a "\n" between blocks so command boundaries are
// visible in the copied content.
//
// In block (rectangular) mode the column range is uniform across rows
// and trailing whitespace is preserved per line — users selecting a
// column of aligned values usually want the alignment intact when they
// paste.
export function extractTextFromSlice(grid: Grid, slice: BlockSelectionSlice): string {
    const n = expand(slice, grid);
    const isBlock = slice.mode === "block" && slice.isStartBlock && slice.isEndBlock;
    const lines: string[] = [];
    for (let r = n.startRow; r <= n.endRow; r++) {
        const row = grid.getRow(r);
        const cStart = isBlock ? n.startCol : r === n.startRow ? n.startCol : 0;
        const cEnd = isBlock
            ? n.endCol
            : r === n.endRow
              ? Math.min(n.endCol, row.length)
              : row.length;
        let s = "";
        for (let c = cStart; c < cEnd; c++) {
            const cell = row[c];
            if (!cell) {
                s += " ";
                continue;
            }
            if (cell.width === 0) continue;
            s += cell.char.length > 0 ? cell.char : " ";
        }
        if (isBlock) {
            // Pad short rows out to the column range so the rectangle
            // stays rectangular when pasted (vim's `:set virtualedit`
            // semantics).
            const want = n.endCol - n.startCol;
            if (s.length < want) s = s.padEnd(want, " ");
            lines.push(s);
        } else {
            lines.push(s.replace(/\s+$/g, ""));
        }
    }
    return lines.join("\n");
}

// pixelToCell — translate a pointer position relative to a grid's host
// element into cell coordinates.  Clamps to grid bounds.
export function pixelToCell(
    relX: number,
    relY: number,
    charWidth: number,
    lineHeight: number,
    grid: Grid
): { row: number; col: number } {
    const row = Math.max(0, Math.min(Math.floor(relY / lineHeight), grid.rowCount() - 1));
    const col = Math.max(0, Math.min(Math.floor(relX / charWidth), grid.cols));
    return { row, col };
}

// ---------- smart-select (semantic entities) ----------
//
// On double-click crest first tries to match the click position against
// the same set of semantic regexes warp uses: URL, email, scientific
// notation, filepath, identifier (highest precedence first).  If any
// regex hit contains the click column, that whole hit becomes the
// selection.  Falls through to word-boundary expansion otherwise.
//
// Behavior reference: warp crates/warp_core/src/semantic_selection/mod.rs:30
//   `REGEXES` array (5 patterns, same precedence order); :177 `smart_select`.

interface SmartSelectPattern {
    name: string;
    re: RegExp;
}

const SmartSelectPatterns: SmartSelectPattern[] = [
    // URL — any scheme.  Matches host (domain | bracketed IPv6 | IPv4),
    // optional userinfo / port / path / query / fragment.
    {
        name: "url",
        re: /[a-z][a-z\d.-]*:\/\/(([\w.-]+(:[\w.-]+)?@)?([\w-]+((\.[\w-]+)+)|(\[[:\da-f]+\]))(:\d{1,5})?)?([\w.,@?^=%&:/~+#-]*[\w@?^=%&/~+#-])?/gi,
    },
    // Email — local part then @ then domain.
    {
        name: "email",
        re: /[\w\d!#$%&'*+\-/=?^`{|}~.]+@[a-z\d-]+\.[a-z\d.-]+[a-z\d-]/gi,
    },
    // Scientific notation — e.g. 6.02e+23, -1.5e-10.
    {
        name: "sci",
        re: /-?\d(\.\d+)?(e[+-]?\d+)/gi,
    },
    // Filepath — ~, drive letter, or word prefix + slash + path body.
    {
        name: "path",
        re: /(~|\b[a-z]:|[\w.*-]+)?[/\\][/\\\w.*-]*/gi,
    },
    // Identifier — word chars with optional . or - separators.  Also
    // happens to match IP addresses and simple floats.
    {
        name: "ident",
        re: /\w+([.-]\w+)*/gi,
    },
];

function rowToText(row: readonly Cell[]): string {
    let s = "";
    for (const cell of row) {
        if (!cell) continue;
        if (cell.width === 0) continue;
        s += cell.char.length > 0 ? cell.char : " ";
    }
    return s;
}

// smartSelectMatch — return the first regex hit (in precedence order)
// that spans the click column.  The returned range is [start, end) in
// column coordinates.
function smartSelectMatch(rowText: string, clickCol: number): { start: number; end: number } | null {
    for (const { re } of SmartSelectPatterns) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(rowText)) != null) {
            if (m[0].length === 0) {
                re.lastIndex++;
                continue;
            }
            const end = m.index + m[0].length;
            if (clickCol >= m.index && clickCol < end) {
                return { start: m.index, end };
            }
        }
    }
    return null;
}

// ---------- word boundary detection ----------
//
// Default rule: a "word" run extends until whitespace or one of the
// punctuation chars listed below.  Underscore is NOT a boundary so
// `snake_case` selects as one word.  This matches warp's double-click
// behavior — selection grabs the token, not the whole shell argument.
// To grab a multi-token path / flag the user drag-selects or triple-
// clicks for line mode.
//
// Behavior reference: warp crates/warpui_core/src/text/words.rs:2
//   `DEFAULT_WORD_BOUNDARY_CHARS`.

type CharCategory = "word" | "ws" | "other";

const WordBoundaryChars = new Set<string>([
    "`", "~", "!", "@", "#", "$", "%", "^", "&", "*",
    "(", ")", "-", "=", "+", "[", "{", "]", "}", "\\",
    "|", ";", ":", "'", '"', ",", ".", "<", ">", "/",
    "?", "«", "»",
]);

function categoryAt(row: readonly Cell[], col: number): CharCategory {
    const cell = row[col];
    if (!cell) return "ws";
    if (cell.char.length === 0) return "ws";
    if (cell.width === 0) {
        return col > 0 ? categoryAt(row, col - 1) : "ws";
    }
    const c = cell.char;
    if (/^\s$/.test(c)) return "ws";
    if (WordBoundaryChars.has(c)) return "other";
    return "word";
}

function wordBoundaryLeft(row: readonly Cell[], col: number): number {
    if (col >= row.length) return row.length;
    const cat = categoryAt(row, col);
    let c = col;
    while (c > 0 && categoryAt(row, c - 1) === cat) c--;
    return c;
}

function wordBoundaryRight(row: readonly Cell[], col: number): number {
    if (col >= row.length) return row.length;
    const cat = categoryAt(row, col);
    let c = col;
    const maxC = row.length;
    while (c < maxC && categoryAt(row, c) === cat) c++;
    return c;
}
