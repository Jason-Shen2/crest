// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// keyEventToBytes — translate a browser KeyboardEvent into the byte
// sequence a real terminal would send over PTY input.  Used by the alt-
// screen keystroke router and the input bar's raw-key passthrough so
// vim / htop / less / lazygit / fzf / helix get the keystrokes they
// expect.
//
// Mode-aware encoding:
//
//   * appCursor (DECCKM, CSI ? 1 h): unmodified arrow keys + Home/End
//     send SS3 <letter> (e.g. ESC O A) instead of CSI <letter> (ESC [ A).
//     Modified arrows always use the long form CSI 1 ; <mod> <letter>
//     regardless of appCursor — application mode doesn't have modifier
//     variants.
//
//   * Modifier code (xterm convention):
//         mod = 1 + (shift?1:0) + (alt?2:0) + (ctrl?4:0)
//     Long form: ESC [ 1 ; <mod> <letter>     for letter-final keys
//                ESC [ <n> ; <mod> ~          for ~-final keys
//
// Alt is encoded as an ESC prefix on printable / Backspace / Enter /
// Tab — xterm's "Meta sends ESC" convention.  Cmd+letter combinations
// (Cmd+C/V/A/Z/X/…) belong to the OS / browser and return null, but
// Cmd+editing keys (Backspace, Arrow keys, Home/End, Delete) are mapped
// to their expected terminal functions so macOS text-editing muscle
// memory works inside TUIs (pi, coco, vim, htop, …).

// Keys where Cmd acts as a "command modifier" (OS shortcut) — these
// return null so the browser/OS handles them.  Letters, digits, and
// common app-level shortcuts (R reload, W close tab, Q quit, …).
function isCmdShortcutKey(key: string): boolean {
    if (key.length === 1) return true; // letters, digits, punctuation
    switch (key) {
        case "F1":
        case "F2":
        case "F3":
        case "F4":
        case "F5":
        case "F6":
        case "F7":
        case "F8":
        case "F9":
        case "F10":
        case "F11":
        case "F12":
        case "Tab":
        case "Enter":
        case "Escape":
            return true;
        default:
            return false;
    }
}

export interface KeyEncoderMode {
    appCursor: boolean;
    appKeypad?: boolean;
    // Kitty keyboard protocol bitfield (see types.ts TermMode).  Bit 0
    // = "disambiguate escape codes": Tab / Enter / Escape / Backspace
    // and Ctrl+<letter> get unique CSI <code>;<mod> u encodings so the
    // running app can tell Tab from Ctrl+I, Enter from Ctrl+M, Escape
    // from Ctrl+[, Backspace from Ctrl+H.  Other bits not implemented
    // yet (level-1 disambiguate is what helix / neovim 0.10+ need).
    kittyKeyboardFlags?: number;
}

const DefaultMode: KeyEncoderMode = { appCursor: false };

export function keyEventToBytes(e: KeyboardEvent, mode: KeyEncoderMode = DefaultMode): string | null {
    const { key, ctrlKey, altKey, metaKey, shiftKey } = e;

    // Pure Cmd + letter/digit/function-key combinations belong to OS/browser.
    // Cmd+editing keys (Backspace, Arrows, Home/End, Delete) fall through
    // and are mapped to terminal editing sequences below.
    if (metaKey && !ctrlKey && !altKey && isCmdShortcutKey(key)) return null;

    const modCode = 1 + (shiftKey ? 1 : 0) + (altKey ? 2 : 0) + (ctrlKey ? 4 : 0);
    const hasMod = modCode !== 1;
    const kittyDisambig = ((mode.kittyKeyboardFlags ?? 0) & 0x1) !== 0;

    // Kitty disambiguate — overlapping keys (Tab/Enter/Escape/Backspace
    // + Ctrl+<letter>) get a CSI <code>;<mod> u form so the running
    // app can tell Tab from Ctrl+I etc.  Takes priority over the
    // xterm-style control-byte path below.
    if (kittyDisambig) {
        const k = encodeKittyDisambiguate(e, modCode);
        if (k != null) return k;
    }

    // Ctrl + character → control byte.  Must precede the printable
    // branch so Ctrl+A doesn't fall through as literal "a".
    if (ctrlKey && !altKey && !metaKey) {
        const ctrlBytes = encodeCtrlChar(key);
        if (ctrlBytes != null) return ctrlBytes;
    }

    // Single-character printable input.
    if (key.length === 1 && !ctrlKey) {
        return altKey ? "\x1b" + key : key;
    }

    switch (key) {
        case "ArrowUp":
            return arrowOrCursor("A", mode.appCursor, hasMod, modCode);
        case "ArrowDown":
            return arrowOrCursor("B", mode.appCursor, hasMod, modCode);
        case "ArrowRight":
            if (metaKey && !ctrlKey && !altKey) return "\x1b[F";
            return arrowOrCursor("C", mode.appCursor, hasMod, modCode);
        case "ArrowLeft":
            if (metaKey && !ctrlKey && !altKey) return "\x1b[H";
            return arrowOrCursor("D", mode.appCursor, hasMod, modCode);
        case "Home":
            return arrowOrCursor("H", mode.appCursor, hasMod, modCode);
        case "End":
            return arrowOrCursor("F", mode.appCursor, hasMod, modCode);
        case "PageUp":
            return tildeKey(5, hasMod, modCode);
        case "PageDown":
            return tildeKey(6, hasMod, modCode);
        case "Insert":
            return tildeKey(2, hasMod, modCode);
        case "Delete":
            return tildeKey(3, hasMod, modCode);
        case "Backspace":
            if (metaKey && !ctrlKey && !altKey) return "\x15";
            if (ctrlKey) return "\x08";
            return (altKey ? "\x1b" : "") + "\x7f";
        case "Enter":
            return (altKey ? "\x1b" : "") + "\r";
        case "Tab":
            if (shiftKey) return "\x1b[Z";
            return (altKey ? "\x1b" : "") + "\t";
        case "Escape":
            return "\x1b";
        case "F1":
            return funcSs3("P", hasMod, modCode);
        case "F2":
            return funcSs3("Q", hasMod, modCode);
        case "F3":
            return funcSs3("R", hasMod, modCode);
        case "F4":
            return funcSs3("S", hasMod, modCode);
        case "F5":
            return tildeKey(15, hasMod, modCode);
        case "F6":
            return tildeKey(17, hasMod, modCode);
        case "F7":
            return tildeKey(18, hasMod, modCode);
        case "F8":
            return tildeKey(19, hasMod, modCode);
        case "F9":
            return tildeKey(20, hasMod, modCode);
        case "F10":
            return tildeKey(21, hasMod, modCode);
        case "F11":
            return tildeKey(23, hasMod, modCode);
        case "F12":
            return tildeKey(24, hasMod, modCode);
    }

    return null;
}

// Arrow + Home/End.  CSI in cursor mode, SS3 in application cursor mode;
// modified always uses long form regardless of appCursor.
function arrowOrCursor(letter: string, appCursor: boolean, hasMod: boolean, modCode: number): string {
    if (hasMod) return `\x1b[1;${modCode}${letter}`;
    return appCursor ? `\x1bO${letter}` : `\x1b[${letter}`;
}

// F1-F4 use SS3 letter unmodified; modified switches to CSI long form.
function funcSs3(letter: string, hasMod: boolean, modCode: number): string {
    if (hasMod) return `\x1b[1;${modCode}${letter}`;
    return `\x1bO${letter}`;
}

// ~-final keys (PgUp/PgDn/Ins/Del, F5+).  CSI <n> ~ unmodified;
// CSI <n> ; <mod> ~ modified.
function tildeKey(num: number, hasMod: boolean, modCode: number): string {
    if (hasMod) return `\x1b[${num};${modCode}~`;
    return `\x1b[${num}~`;
}

// Kitty keyboard protocol — level 1 ("disambiguate") encoding for
// the keys that overlap with xterm control-byte conventions.  Format
// per https://sw.kovidgoyal.net/kitty/keyboard-protocol/ is
//   CSI <unicode-codepoint> ; <modifier> u
// with the trailing `;modifier` omitted when modifier is 1 (none).
//
// Returns null for keys we don't disambiguate (the caller falls back
// to the xterm encoder).  Level-2+ flags (event types, alternate keys,
// all-keys-as-escapes, associated text) not implemented — the level-1
// payload is what helix / neovim 0.10+ actually need to function.
function encodeKittyDisambiguate(e: KeyboardEvent, modCode: number): string | null {
    const { key, ctrlKey, altKey, metaKey } = e;
    const mod = modCode === 1 ? "" : `;${modCode}`;
    switch (key) {
        case "Tab":
            return `\x1b[9${mod}u`;
        case "Enter":
            return `\x1b[13${mod}u`;
        case "Escape":
            return `\x1b[27${mod}u`;
        case "Backspace":
            return `\x1b[127${mod}u`;
    }
    // Ctrl+<letter> / Ctrl+<digit> — collapse to control byte in xterm
    // mode, but in disambiguate mode the running app wants to see the
    // original key.  Encode by lowercase ASCII codepoint.
    if (ctrlKey && !altKey && !metaKey && key.length === 1) {
        const cp = key.toLowerCase().charCodeAt(0);
        return `\x1b[${cp};${modCode}u`;
    }
    return null;
}

function encodeCtrlChar(key: string): string | null {
    const lower = key.toLowerCase();
    if (lower.length === 1 && lower >= "a" && lower <= "z") {
        const code = lower.charCodeAt(0) - "a".charCodeAt(0) + 1;
        return String.fromCharCode(code);
    }
    if (key === " " || key === "@") return "\x00";
    if (key === "[" || key === "Escape") return "\x1b";
    if (key === "\\") return "\x1c";
    if (key === "]") return "\x1d";
    if (key === "^") return "\x1e";
    if (key === "_" || key === "?") return "\x1f";
    return null;
}
