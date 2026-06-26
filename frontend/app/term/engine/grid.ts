// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Grid — the cell buffer for a single block (or alt-screen).  Owns rows of
// cells, a cursor, an active style, hyperlink table, tab stops, scroll
// margins, origin / wrap / insert mode flags, and a charset selection.
// All mutation flows through methods so the renderer can react to dirty
// rows without inspecting internals.
//
// VT220 + xterm coverage in this file:
//
//   * Rows are sparse — trailing positions are implicit BlankCell.
//   * Cursor in [0..cols-1]; the special `pendingWrap=true` state encodes
//     "cursor sat at the right edge after a write" and triggers wrap on
//     the next writeChar (only when DECAWM is on).
//   * Wide cells (East Asian Wide / emoji): owner cell has width=2 with
//     a trailing width=0 spacer.  When wrap-padding pushes a wide char to
//     the next row, a `leadingWideSpacer` flag is set on the trailing
//     blank.  Every mutator that touches a cell repairs orphan halves
//     so we never leave half a wide-char in the grid.
//   * Zero-width codepoints (combining marks, ZWJ, variation selectors)
//     attach to the previous cell's `extra.zeroWidth` string and render
//     as a single grapheme.
//   * Scroll region (DECSTBM, CSI r): scrollTop/scrollBottom margins; all
//     scroll / lineFeed / RI ops operate within the active region.
//   * Origin mode (DECOM): when on, cursorTo addresses rows relative to
//     scrollTop and clamps to the active region.
//   * Insert Replacement Mode (IRM): writeChar shifts existing cells right.
//   * Auto-wrap (DECAWM): at last col, overwrite or wrap.
//   * Tab stops: HTS (ESC H) / TBC (CSI g) maintain a per-column boolean;
//     CSI Z (CBT) walks backward.  Default every 8 cols when unset.
//   * Charset slots (G0/G1): SI/SO swap active; ESC ( c / ESC ) c map
//     a slot.  DEC Special Graphics translates a-z+`{|}~ to box-drawing.

import {
    BlankCell,
    Cell,
    CellExtra,
    CellStyle,
    CharsetMode,
    CursorShape,
    CursorState,
    DefaultCursorState,
    DefaultStyle,
    Hyperlink,
    makeCell,
} from "./types";

export interface CursorPos {
    row: number;
    col: number;
}

interface SavedCursor {
    row: number;
    col: number;
    style: CellStyle;
    pendingWrap: boolean;
    originMode: boolean;
    charsets: [CharsetMode, CharsetMode];
    activeCharset: 0 | 1;
}

// Sentinel for "no bottom margin set" — equivalent to "scroll the whole
// virtual viewport".  Methods that need a concrete bottom row resolve via
// effectiveScrollBottom().
const ScrollBottomUnbounded = Number.POSITIVE_INFINITY;

export class Grid {
    rows: Cell[][] = [];
    cursor: CursorPos = { row: 0, col: 0 };
    pendingWrap = false;
    cols: number;
    currentStyle: CellStyle = DefaultStyle;

    links: Map<number, Hyperlink> = new Map();
    private nextLinkId = 1;
    dirtyRows: Set<number> = new Set();

    // Per-row monotonic version.  Bumped on every mutation that touches
    // a row's cells; read by the renderer (passed as a memo'd prop) so a
    // RowLine actually re-renders when its array is mutated in place
    // — React.memo's default shallow compare only sees the array
    // reference, which is unchanged.
    private rowVersions: number[] = [];

    // Tab stops.  Sparse: tabStops[col] = true (explicit set), false
    // (explicit cleared), undefined (use default every 8 cols).
    private tabStops: (boolean | undefined)[] = [];

    // Scroll margins (DECSTBM).  Both inclusive 0-based rows.
    // scrollBottom of ScrollBottomUnbounded means "no explicit bottom" —
    // typical for the unbounded output grid; alt-screen TUIs set a region.
    private scrollTop = 0;
    private scrollBottom = ScrollBottomUnbounded;

    // Mode flags.  Defaults match xterm power-on state.
    originMode = false;
    insertMode = false;
    autoWrapMode = true;

    // Charsets.  G0/G1 independent slots; activeCharset (0 or 1) selects
    // which one writeChar consults.  SO (0x0E)→1, SI (0x0F)→0.
    private charsets: [CharsetMode, CharsetMode] = ["ascii", "ascii"];
    private activeCharset: 0 | 1 = 0;

    cursorState: CursorState = { ...DefaultCursorState };

    private savedCursor: SavedCursor | null = null;

    constructor(cols: number) {
        if (cols < 1) throw new Error(`Grid cols must be >= 1, got ${cols}`);
        this.cols = cols;
    }

    // ---------- queries ----------

    rowCount(): number {
        return this.rows.length;
    }

    // viewportHeight — returns the visible terminal height in rows.
    // When a bounded scroll region is set (TUI mode), this is scrollBottom+1;
    // otherwise it falls back to rowCount() (unbounded output mode).
    viewportHeight(): number {
        if (this.scrollBottom !== ScrollBottomUnbounded) {
            return this.scrollBottom + 1;
        }
        return Math.max(this.rows.length, 24);
    }

    getRow(row: number): readonly Cell[] {
        return this.rows[row] ?? [];
    }

    getCell(row: number, col: number): Cell {
        const r = this.rows[row];
        if (!r) return BlankCell;
        return r[col] ?? BlankCell;
    }

    // ---------- mode setters ----------

    setOriginMode(on: boolean): void {
        if (this.originMode === on) return;
        this.originMode = on;
        // Per DEC spec, toggling origin homes the cursor.
        this.cursor.row = on ? this.scrollTop : 0;
        this.cursor.col = 0;
        this.pendingWrap = false;
    }

    setInsertMode(on: boolean): void {
        this.insertMode = on;
    }

    setAutoWrap(on: boolean): void {
        this.autoWrapMode = on;
    }

    setCursorVisible(on: boolean): void {
        this.cursorState.visible = on;
    }

    setCursorShape(shape: CursorShape, blink: boolean): void {
        this.cursorState.shape = shape;
        this.cursorState.blink = blink;
    }

    // ---------- scroll region ----------

    // setScrollRegion — top and bottom are 0-based inclusive row indices.
    // Pass top=0, bottom=ScrollBottomUnbounded (or call resetScrollRegion)
    // to clear the region.
    setScrollRegion(topInclusive: number, bottomInclusive: number): void {
        this.scrollTop = Math.max(0, topInclusive);
        if (bottomInclusive === ScrollBottomUnbounded) {
            this.scrollBottom = ScrollBottomUnbounded;
        } else {
            this.scrollBottom = Math.max(this.scrollTop, bottomInclusive);
        }
        this.cursor.row = this.originMode ? this.scrollTop : 0;
        this.cursor.col = 0;
        this.pendingWrap = false;
    }

    resetScrollRegion(): void {
        this.scrollTop = 0;
        this.scrollBottom = ScrollBottomUnbounded;
    }

    // resizeViewport — set the grid to a fixed viewport size (TUI mode).
    // Sets a bounded scroll region covering [0, rows-1], updates cols,
    // prefills empty rows up to `rows` so the renderer always sees
    // a full-height grid, and trims any rows beyond the new viewport
    // (matching real terminal resize semantics — shrinking loses lines
    // at the bottom).
    resizeViewport(cols: number, rows: number): void {
        if (cols < 1) cols = 1;
        if (rows < 1) rows = 1;
        this.cols = cols;
        this.scrollTop = 0;
        this.scrollBottom = rows - 1;
        this.originMode = false;
        const target = rows;
        // Trim rows that fall below the new viewport bottom.
        while (this.rows.length > target) {
            this.rows.pop();
        }
        while (this.rowVersions.length > this.rows.length) {
            this.rowVersions.pop();
        }
        // Prefill up to target height.
        while (this.rows.length < target) {
            this.rows.push([]);
            this.markRowDirty(this.rows.length - 1);
        }
        while (this.rowVersions.length < this.rows.length) {
            this.rowVersions.push(0);
        }
        // Clamp cursor within the new viewport.
        if (this.cursor.row >= target) {
            this.cursor.row = target - 1;
            this.markRowDirty(this.cursor.row);
        }
        if (this.cursor.col >= cols) {
            this.cursor.col = cols - 1;
        }
        this.pendingWrap = false;
    }

    private effectiveScrollBottom(): number {
        if (this.scrollBottom === ScrollBottomUnbounded) {
            return Math.max(this.rows.length, 24) - 1;
        }
        return this.scrollBottom;
    }

    // ---------- charsets ----------

    selectCharsetSlot(slot: 0 | 1, mode: CharsetMode): void {
        this.charsets[slot] = mode;
    }

    setActiveCharset(slot: 0 | 1): void {
        this.activeCharset = slot;
    }

    private translateChar(ch: string): string {
        if (this.charsets[this.activeCharset] !== "dec-special") return ch;
        return decSpecialMap[ch] ?? ch;
    }

    // ---------- cursor primitives ----------

    setStyle(style: CellStyle): void {
        this.currentStyle = style;
    }

    // cursorTo — origin-aware absolute positioning.  Caller passes 0-based
    // row/col; under DECOM the row is interpreted relative to scrollTop
    // and clamped to the scroll region.
    cursorTo(row: number, col: number): void {
        if (this.originMode) {
            const top = this.scrollTop;
            const bot = this.effectiveScrollBottom();
            this.cursor.row = Math.min(Math.max(top, top + row), bot);
        } else {
            this.cursor.row = Math.max(0, row);
        }
        this.cursor.col = Math.max(0, Math.min(col, this.cols - 1));
        this.pendingWrap = false;
    }

    cursorMove(dr: number, dc: number): void {
        const nextRow = this.cursor.row + dr;
        if (this.originMode) {
            this.cursor.row = Math.min(Math.max(this.scrollTop, nextRow), this.effectiveScrollBottom());
        } else {
            this.cursor.row = Math.max(0, nextRow);
        }
        this.cursor.col = Math.max(0, Math.min(this.cursor.col + dc, this.cols - 1));
        this.pendingWrap = false;
    }

    saveCursor(): void {
        this.savedCursor = {
            row: this.cursor.row,
            col: this.cursor.col,
            style: this.currentStyle,
            pendingWrap: this.pendingWrap,
            originMode: this.originMode,
            charsets: [this.charsets[0], this.charsets[1]],
            activeCharset: this.activeCharset,
        };
    }

    restoreCursor(): void {
        if (!this.savedCursor) {
            this.cursor.row = this.originMode ? this.scrollTop : 0;
            this.cursor.col = 0;
            this.pendingWrap = false;
            this.currentStyle = DefaultStyle;
            return;
        }
        const s = this.savedCursor;
        this.cursor.row = s.row;
        this.cursor.col = s.col;
        this.currentStyle = s.style;
        this.pendingWrap = s.pendingWrap;
        this.originMode = s.originMode;
        this.charsets = [s.charsets[0], s.charsets[1]];
        this.activeCharset = s.activeCharset;
    }

    // ---------- byte stream primitives ----------

    // writeChar — place a single grapheme cluster at the cursor.
    //   - width=0 attaches to the previous cell as a zero-width modifier.
    //   - autoWrap=false + at last col → overwrite in place, no wrap.
    //   - insertMode=true → shift existing cells right before placing.
    //   - DEC Special Graphics translation applies when active charset is
    //     set to "dec-special".
    //   - Wide-pair boundaries are repaired so we never leave a stranded
    //     left or right half.
    writeChar(char: string, width: 0 | 1 | 2 = 1): void {
        if (width === 0) {
            this.attachZeroWidth(char);
            return;
        }

        if (this.pendingWrap) {
            if (this.autoWrapMode) {
                this.lineFeed();
                this.cursor.col = 0;
            }
            this.pendingWrap = false;
        }

        // Fit a wide char at the right edge: either wrap with a leading
        // spacer or drop to single-width when wrap is off.
        let effectiveWidth: 0 | 1 | 2 = width;
        if (width === 2 && this.cursor.col >= this.cols - 1) {
            if (this.autoWrapMode) {
                const r0 = this.ensureRow(this.cursor.row);
                this.padRowTo(r0, this.cursor.col);
                this.repairWidePairAt(r0, this.cursor.col);
                r0[this.cursor.col] = makeCell("", 1, this.currentStyle, { leadingWideSpacer: true });
                this.markRowDirty(this.cursor.row);
                this.lineFeed();
                this.cursor.col = 0;
                this.pendingWrap = false;
            } else {
                effectiveWidth = 1;
            }
        }

        const row = this.ensureRow(this.cursor.row);
        this.padRowTo(row, this.cursor.col);

        this.repairWidePairAt(row, this.cursor.col);
        if (effectiveWidth === 2) this.repairWidePairAt(row, this.cursor.col + 1);

        if (this.insertMode) {
            const shift = effectiveWidth;
            for (let i = 0; i < shift && row.length > 0; i++) row.pop();
            row.splice(this.cursor.col, 0, BlankCell);
            if (effectiveWidth === 2) row.splice(this.cursor.col + 1, 0, BlankCell);
        }

        const translated = this.translateChar(char);
        row[this.cursor.col] = makeCell(translated, effectiveWidth, this.currentStyle);
        if (effectiveWidth === 2) {
            row[this.cursor.col + 1] = makeCell("", 0, this.currentStyle);
        }
        this.markRowDirty(this.cursor.row);

        const advance = effectiveWidth;
        this.cursor.col += advance;
        if (this.cursor.col >= this.cols) {
            this.cursor.col = this.cols - 1;
            this.pendingWrap = true;
        }
    }

    // attachZeroWidth — combining mark / VS / ZWJ folds onto the previous
    // visible cell.  If the cursor sits at the start of an empty row with
    // no left neighbor, the codepoint is dropped (rendering a standalone
    // combining mark would distort the column count).
    private attachZeroWidth(ch: string): void {
        const row = this.rows[this.cursor.row];
        if (!row) return;
        let col = this.cursor.col - 1;
        while (col >= 0 && row[col] && row[col].width === 0) col--;
        if (col < 0) return;
        const target = row[col];
        if (!target) return;
        const prev = target.extra?.zeroWidth ?? "";
        const extra: CellExtra = { ...target.extra, zeroWidth: prev + ch };
        row[col] = { ...target, extra };
        this.markRowDirty(this.cursor.row);
    }

    // repairWidePairAt — if the cell at `col` is half of a wide-char pair
    // (either the width=2 owner or its width=0 spacer), blank out the
    // other half so the upcoming write doesn't leave an orphan.
    private repairWidePairAt(row: Cell[], col: number): void {
        if (col < 0 || col >= row.length) return;
        const cell = row[col];
        if (!cell) return;
        if (cell.width === 2) {
            if (row[col + 1]) row[col + 1] = BlankCell;
            return;
        }
        if (cell.width === 0 && col > 0) {
            const left = row[col - 1];
            if (left && left.width === 2) row[col - 1] = BlankCell;
        }
    }

    // writeText — convenience for the parser's printable-run path.  Splits
    // into codepoints, routes zero-width / wide / narrow appropriately.
    writeText(text: string): void {
        for (const ch of text) {
            const cp = ch.codePointAt(0) ?? 0;
            if (isZeroWidthCp(cp)) {
                this.writeChar(ch, 0);
            } else if (isWideCp(cp)) {
                this.writeChar(ch, 2);
            } else {
                this.writeChar(ch, 1);
            }
        }
    }

    lineFeed(): void {
        const bot = this.effectiveScrollBottom();
        if (this.scrollBottom === ScrollBottomUnbounded || this.cursor.row < bot) {
            this.cursor.row += 1;
            this.ensureRow(this.cursor.row);
            this.markRowDirty(this.cursor.row);
        } else {
            // At or past bottom margin — scroll the region up by one.
            this.scrollUpInRegion(1);
        }
        this.pendingWrap = false;
    }

    // reverseLineFeed — RI (ESC M).  Move up one row, scroll the region
    // down if we'd cross the top margin.
    reverseLineFeed(): void {
        if (this.cursor.row <= this.scrollTop) {
            this.scrollDownInRegion(1);
        } else {
            this.cursor.row -= 1;
        }
        this.pendingWrap = false;
    }

    carriageReturn(): void {
        this.cursor.col = 0;
        this.pendingWrap = false;
    }

    backspace(): void {
        if (this.pendingWrap) {
            this.pendingWrap = false;
            return;
        }
        if (this.cursor.col > 0) {
            this.cursor.col -= 1;
        }
    }

    // ---------- tabs ----------

    setTabStop(): void {
        this.tabStops[this.cursor.col] = true;
    }

    clearTabStop(mode: 0 | 3 = 0): void {
        if (mode === 3) {
            this.tabStops = [];
            return;
        }
        this.tabStops[this.cursor.col] = false;
    }

    private isTabStop(col: number): boolean {
        const v = this.tabStops[col];
        if (v === true) return true;
        if (v === false) return false;
        return col > 0 && col % 8 === 0;
    }

    tab(): void {
        for (let c = this.cursor.col + 1; c < this.cols; c++) {
            if (this.isTabStop(c)) {
                this.cursor.col = c;
                this.pendingWrap = false;
                return;
            }
        }
        this.cursor.col = this.cols - 1;
        this.pendingWrap = false;
    }

    moveBackwardTabs(n: number): void {
        let col = this.cursor.col;
        for (let i = 0; i < n && col > 0; i++) {
            col -= 1;
            while (col > 0 && !this.isTabStop(col)) col -= 1;
        }
        this.cursor.col = col;
        this.pendingWrap = false;
    }

    // ---------- erasers ----------

    eraseInLine(mode: 0 | 1 | 2): void {
        const row = this.ensureRow(this.cursor.row);
        this.markRowDirty(this.cursor.row);
        const blank = this.bgBlankCell();
        if (mode === 2) {
            row.length = 0;
            return;
        }
        if (mode === 0) {
            this.repairWidePairAt(row, this.cursor.col);
            row.length = this.cursor.col;
            if (!isDefaultBg(this.currentStyle)) {
                while (row.length < this.cols) row.push(blank);
            }
            return;
        }
        if (mode === 1) {
            this.padRowTo(row, this.cursor.col);
            this.repairWidePairAt(row, this.cursor.col);
            for (let i = 0; i <= this.cursor.col; i++) row[i] = blank;
        }
    }

    eraseInDisplay(mode: 0 | 1 | 2 | 3): void {
        if (mode === 2 || mode === 3) {
            this.rows = [];
            this.markRowDirty(0);
            return;
        }
        if (mode === 0) {
            this.eraseInLine(0);
            const blank = this.bgBlankCell();
            for (let r = this.cursor.row + 1; r < this.rows.length; r++) {
                this.rows[r] = [];
                if (!isDefaultBg(this.currentStyle)) {
                    while (this.rows[r].length < this.cols) this.rows[r].push(blank);
                }
                this.markRowDirty(r);
            }
            return;
        }
        if (mode === 1) {
            for (let r = 0; r < this.cursor.row; r++) {
                this.rows[r] = [];
                this.markRowDirty(r);
            }
            this.eraseInLine(1);
        }
    }

    // CSI X — erase N chars at cursor, current bg, cursor stays put.
    eraseChars(n: number): void {
        if (n <= 0) return;
        const row = this.ensureRow(this.cursor.row);
        this.padRowTo(row, this.cursor.col);
        this.repairWidePairAt(row, this.cursor.col);
        const end = Math.min(this.cursor.col + n, this.cols);
        this.repairWidePairAt(row, end);
        const blank = this.bgBlankCell();
        for (let c = this.cursor.col; c < end; c++) row[c] = blank;
        this.markRowDirty(this.cursor.row);
    }

    // ---------- insert/delete chars (within a line) ----------

    // CSI @ — insert N blank cells at cursor; existing cells shift right
    // and any that fall off the right edge are dropped.
    insertChars(n: number): void {
        if (n <= 0) return;
        const row = this.ensureRow(this.cursor.row);
        this.padRowTo(row, this.cursor.col);
        this.repairWidePairAt(row, this.cursor.col);
        const count = Math.min(n, this.cols - this.cursor.col);
        while (row.length > this.cols - count) row.pop();
        const blank = this.bgBlankCell();
        for (let i = 0; i < count; i++) {
            row.splice(this.cursor.col, 0, blank);
        }
        this.markRowDirty(this.cursor.row);
    }

    // CSI P — delete N cells at cursor; remaining cells shift left,
    // right edge is padded with bg blanks if the current bg is non-default.
    deleteChars(n: number): void {
        if (n <= 0) return;
        const row = this.ensureRow(this.cursor.row);
        if (row.length <= this.cursor.col) return;
        this.repairWidePairAt(row, this.cursor.col);
        const count = Math.min(n, row.length - this.cursor.col);
        row.splice(this.cursor.col, count);
        if (!isDefaultBg(this.currentStyle)) {
            const blank = this.bgBlankCell();
            while (row.length < this.cols) row.push(blank);
        }
        this.markRowDirty(this.cursor.row);
    }

    // ---------- insert/delete lines (within scroll region) ----------

    // CSI L — insert N blank rows at cursor row; rows below shift down
    // within the scroll region, rows pushed past the bottom margin drop.
    insertLines(n: number): void {
        if (n <= 0) return;
        const top = this.cursor.row;
        const bot = this.effectiveScrollBottom();
        if (top < this.scrollTop || top > bot) return;
        const count = Math.min(n, bot - top + 1);
        if (this.scrollBottom === ScrollBottomUnbounded) {
            for (let i = 0; i < count; i++) {
                this.rows.splice(top, 0, []);
            }
        } else {
            // Bounded scroll region — shift rows within [top, bot] downward
            // without moving rows outside the region.
            this.ensureRow(bot);
            for (let i = 0; i < count; i++) {
                for (let r = bot; r > top; r--) {
                    this.rows[r] = this.rows[r - 1] ?? [];
                }
                this.rows[top] = [];
            }
        }
        for (let r = top; r <= bot && r < this.rows.length; r++) this.markRowDirty(r);
        this.cursor.col = 0;
        this.pendingWrap = false;
    }

    // CSI M — delete N rows at cursor row; rows below shift up within
    // the scroll region, bottom margin is padded with blanks.
    deleteLines(n: number): void {
        if (n <= 0) return;
        const top = this.cursor.row;
        const bot = this.effectiveScrollBottom();
        if (top < this.scrollTop || top > bot) return;
        const count = Math.min(n, bot - top + 1);
        if (this.scrollBottom === ScrollBottomUnbounded) {
            for (let i = 0; i < count; i++) {
                if (this.rows[top]) this.rows.splice(top, 1);
            }
        } else {
            // Bounded scroll region — shift rows within [top, bot] upward
            // without moving rows outside the region.
            this.ensureRow(bot);
            for (let i = 0; i < count; i++) {
                for (let r = top; r < bot; r++) {
                    this.rows[r] = this.rows[r + 1] ?? [];
                }
                this.rows[bot] = [];
            }
        }
        for (let r = top; r <= bot && r < this.rows.length; r++) this.markRowDirty(r);
        this.cursor.col = 0;
        this.pendingWrap = false;
    }

    // ---------- scrolling ----------

    scrollUp(n: number): void {
        this.scrollUpInRegion(n);
    }

    scrollDown(n: number): void {
        this.scrollDownInRegion(n);
    }

    scrollUpInRegion(n: number): void {
        if (n <= 0) return;
        const top = this.scrollTop;
        if (this.scrollBottom === ScrollBottomUnbounded) {
            for (let i = 0; i < n && this.rows.length > top; i++) {
                this.rows.splice(top, 1);
            }
            for (let r = top; r < this.rows.length; r++) this.markRowDirty(r);
            return;
        }
        const bot = this.scrollBottom;
        const regionSize = bot - top + 1;
        const count = Math.min(n, regionSize);
        // Shift rows within the scroll region only — rows outside the
        // region (below bot / above top) must NOT move.  Using splice on
        // the whole array would shift external rows too; instead we
        // copy rows within the region and clear the vacated bottom rows.
        this.ensureRow(bot);
        for (let i = 0; i < count; i++) {
            for (let r = top; r < bot; r++) {
                this.rows[r] = this.rows[r + 1] ?? [];
            }
            this.rows[bot] = [];
        }
        for (let r = top; r <= bot; r++) this.markRowDirty(r);
    }

    scrollDownInRegion(n: number): void {
        if (n <= 0) return;
        const top = this.scrollTop;
        if (this.scrollBottom === ScrollBottomUnbounded) {
            for (let i = 0; i < n; i++) this.rows.splice(top, 0, []);
            for (let r = top; r < this.rows.length; r++) this.markRowDirty(r);
            return;
        }
        const bot = this.scrollBottom;
        const regionSize = bot - top + 1;
        const count = Math.min(n, regionSize);
        // Shift rows down within the scroll region only; rows below bot
        // must stay in place.  Copy rows down and clear the vacated top
        // rows rather than splicing (which would shift external rows).
        this.ensureRow(bot);
        for (let i = 0; i < count; i++) {
            for (let r = bot; r > top; r--) {
                this.rows[r] = this.rows[r - 1] ?? [];
            }
            this.rows[top] = [];
        }
        for (let r = top; r <= bot; r++) this.markRowDirty(r);
    }

    // ---------- hyperlinks ----------

    // addLink — dedupes by (uri, params) so a run of cells emitted under
    // one OSC 8 open share an id and the renderer can merge runs.
    addLink(uri: string, params?: string): number {
        for (const [id, link] of this.links) {
            if (link.uri === uri && (link.params ?? "") === (params ?? "")) {
                return id;
            }
        }
        const id = this.nextLinkId++;
        this.links.set(id, { id, uri, params });
        return id;
    }

    getLink(id: number): Hyperlink | undefined {
        return this.links.get(id);
    }

    // ---------- cell extras ----------

    markCursorCellExtra(extra: CellExtra): void {
        const row = this.ensureRow(this.cursor.row);
        this.padRowTo(row, this.cursor.col);
        const existing = row[this.cursor.col];
        if (existing && existing !== BlankCell) {
            const mergedExtra: CellExtra = { ...existing.extra, ...extra };
            row[this.cursor.col] = { ...existing, extra: mergedExtra };
        } else {
            row[this.cursor.col] = makeCell("", 1, this.currentStyle, extra);
        }
        this.markRowDirty(this.cursor.row);
    }

    // ---------- full reset ----------

    // reset — bring the grid back to power-on state.  Called by ESC c (RIS)
    // and on the alt-screen `enter` path so the TUI sees a clean slate.
    fullReset(): void {
        this.rows = [];
        this.cursor.row = 0;
        this.cursor.col = 0;
        this.pendingWrap = false;
        this.currentStyle = DefaultStyle;
        this.tabStops = [];
        this.scrollTop = 0;
        this.scrollBottom = ScrollBottomUnbounded;
        this.originMode = false;
        this.insertMode = false;
        this.autoWrapMode = true;
        this.charsets = ["ascii", "ascii"];
        this.activeCharset = 0;
        this.cursorState = { ...DefaultCursorState };
        this.savedCursor = null;
        this.links.clear();
        this.nextLinkId = 1;
        this.dirtyRows.clear();
        this.rowVersions = [];
        this.markRowDirty(0);
    }

    // ---------- dirty tracking ----------

    consumeDirty(): number[] {
        if (this.dirtyRows.size === 0) return [];
        const arr = Array.from(this.dirtyRows).sort((a, b) => a - b);
        this.dirtyRows.clear();
        return arr;
    }

    markAllDirty(): void {
        for (let r = 0; r < this.rows.length; r++) this.markRowDirty(r);
    }

    // markRowDirty — central mutation marker.  All in-place writes route
    // through this so we update both the dirty set (cheap "what changed
    // this frame" signal) and the per-row version counter (lets the React
    // renderer's memo'd RowLine actually re-render when its in-place
    // mutated array gets new contents).
    private markRowDirty(r: number): void {
        this.dirtyRows.add(r);
        this.rowVersions[r] = (this.rowVersions[r] ?? 0) + 1;
    }

    // getRowVersion — monotonic counter bumped on every mutation that
    // touched row `r`.  Renderer threads this into the row component's
    // props so React.memo's shallow compare detects the change.
    getRowVersion(r: number): number {
        return this.rowVersions[r] ?? 0;
    }

    // ---------- structural ----------

    private ensureRow(index: number): Cell[] {
        while (this.rows.length <= index) {
            const r: Cell[] = [];
            this.rows.push(r);
            this.markRowDirty(this.rows.length - 1);
        }
        return this.rows[index];
    }

    private padRowTo(row: Cell[], col: number): void {
        while (row.length < col) row.push(BlankCell);
    }

    private bgBlankCell(): Cell {
        if (isDefaultBg(this.currentStyle)) return BlankCell;
        return makeCell("", 1, this.currentStyle);
    }
}

// ---------- helpers ----------

function isDefaultBg(style: CellStyle): boolean {
    return style.bg.kind === "default";
}

// East-Asian Wide / Fullwidth detection.  Covers CJK + emoji + box-drawing
// wide.  Full UAX #11 implementation is overkill — we cover what users
// actually see and accept that some rare wide chars render at width=1.
function isWideCp(cp: number): boolean {
    if (cp >= 0x1100 && cp <= 0x115f) return true; // Hangul Jamo
    if (cp >= 0x2e80 && cp <= 0x303e) return true; // CJK Radicals etc.
    if (cp >= 0x3041 && cp <= 0x33ff) return true; // Hiragana/Katakana/CJK Symbols
    if (cp >= 0x3400 && cp <= 0x4dbf) return true; // CJK Ext A
    if (cp >= 0x4e00 && cp <= 0x9fff) return true; // CJK Unified
    if (cp >= 0xa000 && cp <= 0xa4cf) return true; // Yi
    if (cp >= 0xac00 && cp <= 0xd7a3) return true; // Hangul Syllables
    if (cp >= 0xf900 && cp <= 0xfaff) return true; // CJK Compat
    if (cp >= 0xfe30 && cp <= 0xfe4f) return true; // CJK Compat Forms
    if (cp >= 0xff00 && cp <= 0xff60) return true; // Fullwidth ASCII
    if (cp >= 0xffe0 && cp <= 0xffe6) return true; // Fullwidth signs
    if (cp >= 0x1f300 && cp <= 0x1f64f) return true; // Misc symbols + Emoticons
    if (cp >= 0x1f680 && cp <= 0x1f6ff) return true; // Transport
    if (cp >= 0x1f900 && cp <= 0x1f9ff) return true; // Supplemental
    if (cp >= 0x1fa70 && cp <= 0x1faff) return true; // Symbols & Pictographs Ext-A
    return false;
}

// Zero-width codepoints — combining marks, ZWJ, variation selectors.
function isZeroWidthCp(cp: number): boolean {
    if (cp === 0x200d) return true; // ZWJ
    if (cp === 0x200c) return true; // ZWNJ
    if (cp >= 0xfe00 && cp <= 0xfe0f) return true; // Variation selectors 1-16
    if (cp >= 0xe0100 && cp <= 0xe01ef) return true; // Variation selectors supp.
    if (cp >= 0x0300 && cp <= 0x036f) return true; // Combining Diacritical Marks
    if (cp >= 0x1ab0 && cp <= 0x1aff) return true; // Combining Marks Extended
    if (cp >= 0x1dc0 && cp <= 0x1dff) return true; // Combining Marks Supplement
    if (cp >= 0x20d0 && cp <= 0x20ff) return true; // Combining Symbols
    if (cp >= 0xfe20 && cp <= 0xfe2f) return true; // Combining Half Marks
    return false;
}

// DEC Special Graphics translation — ESC ( 0 selects this slot, then a-z
// + a handful of punctuation map to box-drawing / arrow / math glyphs.
// Anything not in the table passes through.
const decSpecialMap: Record<string, string> = {
    "`": "◆",
    a: "▒",
    b: "␉",
    c: "␌",
    d: "␍",
    e: "␊",
    f: "°",
    g: "±",
    h: "␤",
    i: "␋",
    j: "┘",
    k: "┐",
    l: "┌",
    m: "└",
    n: "┼",
    o: "⎺",
    p: "⎻",
    q: "─",
    r: "⎼",
    s: "⎽",
    t: "├",
    u: "┤",
    v: "┴",
    w: "┬",
    x: "│",
    y: "≤",
    z: "≥",
    "{": "π",
    "|": "≠",
    "}": "£",
    "~": "·",
};
