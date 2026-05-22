// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Engine-side types for the terminal cell model.  The model is deliberately
// kept separate from React — these structures are mutated by the ANSI parser
// and queried by the renderer; they never participate in JSX.

// ---------- Color ----------

// A color reference resolved against the active theme.  We carry the raw
// reference (palette index or RGB) rather than a resolved CSS string so the
// renderer can re-theme without re-parsing the byte stream.
export type Color =
    | { kind: "default" }
    | { kind: "palette"; index: number } // 0-15 ANSI, 16-255 256-color
    | { kind: "rgb"; r: number; g: number; b: number };

export const DefaultColor: Color = { kind: "default" };

export function colorsEqual(a: Color, b: Color): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "default") return true;
    if (a.kind === "palette") return a.index === (b as { index: number }).index;
    const br = b as { r: number; g: number; b: number };
    return a.r === br.r && a.g === br.g && a.b === br.b;
}

// ---------- Style (SGR-derived) ----------

// CellStyle mirrors the warp `Style` struct: one record per visible attribute.
// The parser writes new styles into Grid.currentStyle; the grid copies the
// reference into each cell — *not a clone* — so identical styles share memory
// and the renderer can merge runs by reference equality.
export interface CellStyle {
    fg: Color;
    bg: Color;
    bold: boolean;
    dim: boolean;
    italic: boolean;
    underline: boolean;
    strikethrough: boolean;
    reverse: boolean;
    invisible: boolean;
    blink: boolean;
    // Hyperlink: index into Grid.links.  0 = no link.  Stored on the style so
    // a run of cells with the same link is naturally a single render unit.
    linkId: number;
}

export const DefaultStyle: CellStyle = Object.freeze({
    fg: DefaultColor,
    bg: DefaultColor,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strikethrough: false,
    reverse: false,
    invisible: false,
    blink: false,
    linkId: 0,
});

export function stylesEqual(a: CellStyle, b: CellStyle): boolean {
    if (a === b) return true;
    return (
        a.bold === b.bold &&
        a.dim === b.dim &&
        a.italic === b.italic &&
        a.underline === b.underline &&
        a.strikethrough === b.strikethrough &&
        a.reverse === b.reverse &&
        a.invisible === b.invisible &&
        a.blink === b.blink &&
        a.linkId === b.linkId &&
        colorsEqual(a.fg, b.fg) &&
        colorsEqual(a.bg, b.bg)
    );
}

export function cloneStyle(s: CellStyle): CellStyle {
    return { ...s };
}

// ---------- CellExtra (beyond style) ----------

// Per-cell metadata that doesn't merge with style runs.  warp uses a `CellExtra`
// struct attached only to cells that need it; we follow the same pattern —
// `Cell.extra` is `undefined` for the vast majority of cells, which keeps
// memory tight and run-merging trivial.
export interface CellExtra {
    // OSC 133 shell-integration anchors.  Set on the cell *immediately after*
    // the marker, so scanning the row from a marker position gives the right
    // demarcation:
    //   promptStart   — cell at OSC 133;A (first cell of the prompt)
    //   promptEnd     — cell at OSC 133;B (one past the last prompt cell)
    //   commandStart  — cell at OSC 133;C (first cell of the typed command)
    //   commandEnd    — cell at OSC 133;C-end (one past the last command cell)
    promptStart?: boolean;
    promptEnd?: boolean;
    commandStart?: boolean;
    commandEnd?: boolean;

    // Image / graphics (kitty + iTerm 1337) reference id.  The image data
    // itself lives on the Grid's imageMap so duplicate placements share bytes.
    imageId?: string;

    // Secret redaction.  Set by the secret-scanner during writeChar() when a
    // pattern matches.  The renderer paints these cells as opaque boxes
    // instead of glyphs.
    secret?: boolean;

    // Wide-pair anchor: cell at the *left edge* of an East-Asian-wide char
    // pair where wrap-padding was needed (the spacer is at cols-1, and the
    // wide glyph itself starts at col 0 of the next row).  Renderer skips
    // painting; eraseInLine treats as the wide owner.
    leadingWideSpacer?: boolean;

    // Combining marks / ZWJ / variation-selector codepoints layered onto
    // this cell.  Stored as a single concatenated string so the renderer
    // can paint `cell.char + extra.zeroWidth` to produce the full grapheme.
    // Most cells have none; we only allocate `extra` when something lands.
    zeroWidth?: string;
}

// ---------- Cell ----------

// A single grid cell.  width=0 is the right half of a wide (CJK / emoji) cell
// — the renderer skips painting it because the previous cell already covered
// the column.  width=1 is the common case; width=2 is a wide cell that
// occupies two columns (the column to the right gets width=0).
export interface Cell {
    char: string; // a single grapheme cluster, or "" for blank
    width: 0 | 1 | 2;
    style: CellStyle;
    extra?: CellExtra;
}

// Blank cell shared across all empty positions.  Frozen so accidental writes
// surface immediately.  When the grid needs to mutate a cell, it allocates a
// fresh Cell object instead of touching this one.
export const BlankCell: Cell = Object.freeze({
    char: "",
    width: 1 as const,
    style: DefaultStyle,
});

export function makeCell(char: string, width: 0 | 1 | 2, style: CellStyle, extra?: CellExtra): Cell {
    if (extra) return { char, width, style, extra };
    return { char, width, style };
}

// ---------- Block lifecycle ----------

// Block lifecycle states.  Mirrors warp's `BlockState` enum.  The transitions
// are driven by OSC 133 shell-integration markers, never inferred from byte
// content — that's what gives warp its reliability across shells.
export type BlockLifecycleState =
    | "waiting-for-input" // created, prompt not yet emitted
    | "running" // OSC 133;C fired, output being collected
    | "done-with-execution" // OSC 133;D fired, exit code known
    | "done-with-no-execution" // user dismissed without running
    | "background" // long-running daemon output, no associated user command
    | "static"; // synthesized (system message, bootstrap)

// PrecmdState tracks warp's internal collection phase independently of
// `state`.  See warp's block.rs comment: a Block can be Running (shell hasn't
// returned) but already AfterPrecmd (warp has all the output it needs for
// this command).  Useful for snapshotting before the shell exits.
export type PrecmdState = "before-precmd" | "after-precmd";

// ---------- Hyperlink table ----------

// OSC 8 hyperlinks are stored in a Grid-level table.  Cells reference them
// by id (CellStyle.linkId).  id=0 sentinel means "no link".
export interface Hyperlink {
    id: number;
    uri: string;
    params?: string; // optional `id=…` (anchor) extra params from OSC 8
}

// ---------- Image table ----------

// Image placements.  Cells reference by id (CellExtra.imageId).  The raw
// bytes live in `data`; the layout (rows × cols) is in `rows`/`cols` so the
// renderer knows the footprint without re-parsing.
export interface ImagePlacement {
    id: string;
    mimeType: string;
    data: Uint8Array;
    rows: number;
    cols: number;
}

// ---------- Cursor ----------

// DECSCUSR shapes (CSI Ps SP q).  0 / 1 = blinking block, 2 = steady block,
// 3 / 4 = underline, 5 / 6 = bar.  We collapse blink into a separate flag.
export type CursorShape = "block" | "underline" | "bar";

export interface CursorState {
    visible: boolean;
    shape: CursorShape;
    blink: boolean;
}

export const DefaultCursorState: CursorState = {
    visible: true,
    shape: "block",
    blink: true,
};

// ---------- Charset ----------

// Character-set translation tables.  G0 / G1 are the two slots an
// application can map glyphs into via ESC ( c / ESC ) c; SO (0x0E) and
// SI (0x0F) swap the active slot.  Almost all modern shells use ASCII +
// UTF-8 and never touch this, but ncurses-era TUIs (top, htop legacy,
// any program using `tput acsc`) still emit ESC ( 0 to draw box lines
// using ASCII letters that the DEC-Special-Graphics table maps to
// box-drawing glyphs.
export type CharsetMode = "ascii" | "dec-special";

// ---------- Terminal Modes (DEC private / ANSI) ----------

// TermMode aggregates the on/off flags toggled by `CSI ? n h/l` (private)
// and `CSI n h/l` (ANSI standard).  These are terminal-wide — they persist
// across blocks, get reset on `RIS` (ESC c), and many get cleared after
// `command_finished` to recover from buggy SSH inheritance.
//
// The handler consults these during dispatch (origin mode for cursor math,
// autoWrap for writeChar, insertMode for line editing).  The renderer and
// input layer consult them too (appCursor for key encoding, bracketedPaste
// for paste wrapping, mouse* for event capture, syncOutput for render
// gating).
export interface TermMode {
    // ----- input encoding -----
    appCursor: boolean;       // DECCKM (1) — arrow keys send SS3 instead of CSI
    appKeypad: boolean;       // DECKPAM (ESC =) / DECKPNM (ESC >)
    bracketedPaste: boolean;  // 2004 — paste wrapped in ESC[200~ … ESC[201~
    focusReport: boolean;     // 1004 — window focus → ESC[I / ESC[O
    // mouse reporting (combine modes orthogonally; the encoder picks
    // the right encoding based on which encoding bit is on)
    mouseX10: boolean;        // 9
    mouseClick: boolean;      // 1000 — press/release only
    mouseButton: boolean;     // 1002 — press/release + drag
    mouseMotion: boolean;     // 1003 — any motion
    mouseSgr: boolean;        // 1006 — SGR encoding
    mouseUtf8: boolean;       // 1005 — UTF-8 encoding
    mouseUrxvt: boolean;      // 1015 — urxvt-style encoding
    alternateScroll: boolean; // 1007 — alt-screen scroll → arrow keys
    // ----- output / cursor -----
    autoWrap: boolean;        // DECAWM (7)
    origin: boolean;          // DECOM (6) — cursor pos relative to scroll region
    insertMode: boolean;      // IRM (4) — insert vs overwrite
    syncOutput: boolean;      // 2026 — buffer renderer between h/l
    reverseVideo: boolean;    // DECSCNM (5) — invert screen colors
    columnMode: boolean;      // DECCOLM (3) — 132-col mode (tracked, not enforced)
    autoRepeat: boolean;      // DECARM (8)
    // Kitty keyboard protocol active flag set.  Bitfield:
    //   0x1  disambiguate escape codes (Tab vs Ctrl+I, Enter vs Ctrl+M, …)
    //   0x2  report event types (press/release/repeat)
    //   0x4  report alternate keys (shifted/base layout chars)
    //   0x8  report all keys as escape codes (no plain text)
    //   0x10 report associated text
    // Toggled via CSI =/>/< u; queried via CSI ? u.  See:
    //   https://sw.kovidgoyal.net/kitty/keyboard-protocol/
    kittyKeyboardFlags: number;
}

export const DefaultTermMode: TermMode = Object.freeze({
    appCursor: false,
    appKeypad: false,
    bracketedPaste: false,
    focusReport: false,
    mouseX10: false,
    mouseClick: false,
    mouseButton: false,
    mouseMotion: false,
    mouseSgr: false,
    mouseUtf8: false,
    mouseUrxvt: false,
    alternateScroll: false,
    autoWrap: true,
    origin: false,
    insertMode: false,
    syncOutput: false,
    reverseVideo: false,
    columnMode: false,
    autoRepeat: true,
    kittyKeyboardFlags: 0,
});

export function mouseReportingActive(m: TermMode): boolean {
    return m.mouseX10 || m.mouseClick || m.mouseButton || m.mouseMotion;
}

// ---------- IDs ----------

// BlockId.  warp uses {sessionId}-{seq} for shell-created blocks and
// "manual-{uuid}" for synthesized.  We mirror the format so Go-side IDs
// round-trip without translation.
export type BlockId = string;

// SessionId — opaque, supplied by Go.
export type SessionId = string;

// ---------- Agent blocks ----------

// BlockKind partitions the block timeline into two kinds: shell blocks
// (the existing PTY-driven flow) and agent blocks (LLM exchanges).
// Mirrors warp's `Block::AgentResponse` enum variant.  Engine code paths
// for shell vs agent are kept strictly separate — the ANSI parser never
// writes into an agent block, and renderers dispatch on `kind`.
export type BlockKind = "shell" | "agent";

// AgentBlockStatus tracks the lifecycle of a single agent exchange.
// Mirrors warp's `AIAgentOutput.status`:
//   streaming — useChat is actively producing tokens / tool calls
//   done      — the turn finished normally
//   error     — the request errored; the body carries the error message
export type AgentBlockStatus = "streaming" | "done" | "error";

// AgentPayload — per-block agent data carried alongside the (unused)
// outputGrid on a Block whose `kind === "agent"`.  Field names mirror
// warp's `AIAgentOutput` semantics (exchangeId / status / createdAt) so
// future trajectory replay can deserialize without name remapping.
//
// `createdAt` is UI metadata only ("5s ago" displays); it does NOT
// participate in block ordering.  Ordering is always the order of
// `appendAgentBlock` / `pushShellBlock` calls — see `Blocks.push`.
export interface AgentPayload {
    exchangeId: string;
    userText: string;
    status: AgentBlockStatus;
    createdAt: number;
    // Accumulated assistant text deltas.  Mutated by `appendAgentText`
    // (engine/block.ts) which the useChat → applyAgentDelta bridge calls.
    assistantText: string;
    // Optional error message when status === "error".  Set by setAgentStatus.
    errorMessage?: string;
}
