// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// BlockGrid — wraps a Grid with the lifecycle state and memoized queries
// that a *block* (one command invocation) needs.  Mirrors warp's
// `terminal/model/blockgrid.rs`.
//
// Why this layer at all (over raw Grid)?
//   1. `started` / `finished` flags: the parser uses these to gate writes
//      (a fresh block is "not started" until OSC 133;A, an output_grid is
//      "not started" until OSC 133;C).
//   2. Filter — the block-filter UI applies a regex; non-matching rows hide
//      without losing the underlying cells.  Stored here, applied in
//      visibleRows().
//   3. Memoization — once finished, expensive queries like
//      "rightmost visible non-empty column" are computed once and cached.
//      Caching is *only* safe post-finish because the grid never mutates
//      again.

import { Cell } from "./types";
import { Grid } from "./grid";

export class BlockGrid {
    private inner: Grid;
    private started = false;
    private finished = false;

    // filter applied at read time.  null = pass-through.  Stored as both raw
    // query (for the UI) and compiled regex (for matching) so the UI can
    // recover the textbox state without recomputing.
    private filterQuery: string | null = null;
    private filterRegex: RegExp | null = null;

    // Memoized post-finished queries.  Set lazily on first call, never
    // invalidated (only valid after finished).
    private cachedRightmostNonempty?: number;
    private cachedHasVisibleChars?: boolean;
    private cachedRowText?: string[];

    constructor(cols: number) {
        this.inner = new Grid(cols);
    }

    // Direct access to the underlying Grid — used by the ANSI parser to call
    // mutation methods.  We don't proxy each Grid method through BlockGrid
    // because that's a lot of boilerplate and the parser is the only caller
    // that needs raw access.
    raw(): Grid {
        return this.inner;
    }

    // ---------- lifecycle ----------

    isStarted(): boolean {
        return this.started;
    }
    isFinished(): boolean {
        return this.finished;
    }

    start(): void {
        if (this.started) return;
        this.started = true;
    }

    // Mark the grid immutable.  warp's analogue computes and caches a bunch
    // of derived values here (rightmost-visible-non-empty cell, etc.).  We
    // do the same — but lazily, on first query.  Eager precompute would
    // waste cycles for blocks that are never queried (hidden agent blocks,
    // background daemons, …).
    finish(): void {
        if (this.finished) return;
        this.finished = true;
    }

    // ---------- queries ----------

    cols(): number {
        return this.inner.cols;
    }

    rowCount(): number {
        return this.inner.rowCount();
    }

    // Returns the cells for `row`, after filter.  Pass-through when no
    // filter is active — common case, no copy.
    rowAt(row: number): readonly Cell[] {
        return this.inner.getRow(row);
    }

    // visibleRowIndices — row numbers that pass the filter (or all of them
    // when filter is null).  The renderer iterates this rather than 0..n so
    // hidden rows truly disappear from layout.
    visibleRowIndices(): number[] {
        if (this.filterRegex == null) {
            const out: number[] = [];
            for (let i = 0; i < this.inner.rowCount(); i++) out.push(i);
            return out;
        }
        const rx = this.filterRegex;
        const out: number[] = [];
        const rowTexts = this.rowTexts();
        for (let i = 0; i < rowTexts.length; i++) {
            if (rx.test(rowTexts[i])) out.push(i);
        }
        return out;
    }

    // rowTexts — cached array of plain-text per row (for find / filter /
    // copy).  Computed lazily; invalidated when the grid mutates and
    // recomputed on next access for unfinished blocks.  For finished blocks
    // the cache is permanent.
    private rowTexts(): string[] {
        if (this.finished && this.cachedRowText) return this.cachedRowText;
        const out: string[] = [];
        for (let r = 0; r < this.inner.rowCount(); r++) {
            const row = this.inner.getRow(r);
            let s = "";
            for (const cell of row) {
                if (!cell) continue;
                if (cell.width !== 0 && cell.char) s += cell.char;
            }
            out.push(s);
        }
        if (this.finished) this.cachedRowText = out;
        return out;
    }

    // rightmostVisibleNonemptyCol — the largest col index across all rows
    // that has a non-blank cell.  Used to compute the actual visual width
    // of the block (so the right-side padding doesn't extend past content).
    rightmostVisibleNonemptyCol(): number {
        if (this.finished && this.cachedRightmostNonempty != null) {
            return this.cachedRightmostNonempty;
        }
        let max = -1;
        for (let r = 0; r < this.inner.rowCount(); r++) {
            const row = this.inner.getRow(r);
            for (let c = row.length - 1; c >= 0; c--) {
                if (row[c]?.char) {
                    if (c > max) max = c;
                    break;
                }
            }
        }
        if (this.finished) this.cachedRightmostNonempty = max;
        return max;
    }

    hasVisibleChars(): boolean {
        if (this.finished && this.cachedHasVisibleChars != null) {
            return this.cachedHasVisibleChars;
        }
        let has = false;
        for (let r = 0; r < this.inner.rowCount() && !has; r++) {
            const row = this.inner.getRow(r);
            for (const cell of row) {
                if (!cell) continue;
                if (cell.char) {
                    has = true;
                    break;
                }
            }
        }
        if (this.finished) this.cachedHasVisibleChars = has;
        return has;
    }

    // ---------- filter ----------

    getFilterQuery(): string | null {
        return this.filterQuery;
    }

    setFilter(query: string | null): void {
        this.filterQuery = query;
        if (!query) {
            this.filterRegex = null;
            return;
        }
        try {
            // Treat as literal substring by default — most users type plain
            // text into the filter box, not regex.  Case-insensitive.
            this.filterRegex = new RegExp(escapeRegex(query), "i");
        } catch {
            this.filterRegex = null;
        }
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
