// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AnsiHandler — interface the parser calls into for every decoded event.
// Mirrors warp's `Handler` trait (terminal/ansi.rs).  Block implements this
// and the parser drives it byte-by-byte.
//
// All methods are synchronous and return void: the parser doesn't care what
// the handler does, only that it processed the event.  Side-effects (cell
// writes, state transitions, link table updates) live in the handler.

export interface AnsiHandler {
    // Literal text — UTF-8 decoded, possibly several characters at once when
    // the parser drains an uninterrupted run of printable bytes.  The
    // handler is responsible for grapheme/width handling.
    onText(text: string): void;

    // C0 controls (the ones that actually affect rendering).  Routed
    // through the handler instead of inlined in the parser so a downstream
    // subscriber (recorder, AI context capture) can observe each one.
    onLineFeed(): void;
    onCarriageReturn(): void;
    onBackspace(): void;
    onTab(): void;
    onBell(): void;

    // Charset shifts.  SO (0x0E) selects G1; SI (0x0F) selects G0.
    // Used by ncurses-era TUIs that emit ESC ( 0 then SO to draw boxes.
    onShiftOut(): void;
    onShiftIn(): void;

    // CSI sequence dispatch.  `params` is a flat list of numeric parameters
    // (both ';' and ':' separators flattened into one list — the consumer
    // decides whether to treat them as primary or sub-params per command).
    // Empty params are passed as 0.  `intermediate` is the 0-2 char string
    // between CSI and the final byte (rare; "$" / "?" / etc. for some
    // private modes).  `isPrivate` is true when the first parameter byte
    // was '?' (DEC private mode) or '>' / '=' (also private).
    onCsi(
        final: string,
        params: number[],
        intermediate: string,
        isPrivate: boolean,
        // The exact private-introducer char ('?', '>', '=', '<') if any,
        // or empty string when isPrivate is false.  Kitty's keyboard
        // protocol uses CSI =/>/< u distinctly from CSI ? u, so the
        // boolean alone isn't enough to dispatch.
        privatePrefix?: string
    ): void;

    // OSC sequence — the payload string between `ESC ]` and the terminator
    // (BEL or ST).  The payload starts with `<n>;...` where <n> identifies
    // the operation (133, 8, 7, 52, 1337, …).  Handlers parse the payload
    // themselves; the parser doesn't peek.
    onOsc(payload: string): void;

    // Non-CSI ESC sequence (ESC <final>).  Used for ESC 7 (save cursor),
    // ESC 8 (restore), ESC D (index), ESC E (next-line), ESC M (reverse
    // index), ESC c (full reset), ESC = / ESC > (keypad modes — ignore).
    onEsc(final: string, intermediate: string): void;

    // DCS / SOS / PM / APC are exotic.  Most shells never emit them; some
    // multiplexers (tmux, screen) do.  We surface them so a downstream
    // handler can pass-through to a nested terminal, but the default Block
    // implementation can be empty.
    onDcs(final: string, params: number[], intermediate: string, data: string): void;
    onSosPmApc(introducer: string, data: string): void;
}
