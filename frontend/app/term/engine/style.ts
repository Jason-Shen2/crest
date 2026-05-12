// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// SGR (Select Graphic Rendition) decoding.  The ANSI parser hands us the
// parameter list from `CSI <params> m` and we fold it into a CellStyle.
// Self-contained — no dependencies on grid or block.

import { CellStyle, Color, DefaultColor, DefaultStyle, cloneStyle } from "./types";

// applySgr — mutate `style` in place per a CSI m parameter list.
//
// The SGR grammar is finicky: params are usually separated by ";" but
// 38/48 (extended colors) accept either ";" or ":" as a sub-delim, and the
// 256-color and 24-bit RGB forms have completely different param counts.
// We accept both delimiters by flattening the parser's parameter list before
// calling us — see ansi-parser.ts.
//
// Returns the new style.  Caller should treat the returned style as an
// independent object (we clone on entry so the in-grid style references
// stay stable for run-merging).
export function applySgr(prev: CellStyle, params: number[]): CellStyle {
    const style = cloneStyle(prev);
    let i = 0;
    while (i < params.length) {
        const p = params[i];
        switch (p) {
            case 0:
                // Reset.  Copy from DefaultStyle so we don't accidentally
                // share its frozen reference (callers may mutate later).
                Object.assign(style, DefaultStyle);
                break;
            case 1:
                style.bold = true;
                break;
            case 2:
                style.dim = true;
                break;
            case 3:
                style.italic = true;
                break;
            case 4:
                style.underline = true;
                break;
            case 5:
            case 6:
                // Slow blink (5) and rapid blink (6) — collapsed onto one flag.
                style.blink = true;
                break;
            case 7:
                style.reverse = true;
                break;
            case 8:
                style.invisible = true;
                break;
            case 9:
                style.strikethrough = true;
                break;
            case 21:
                // Double underline (ECMA-48).  Some terminals interpret 21 as
                // "not bold" instead — we alias to underline because it's the
                // dominant modern interpretation and keeps the visual hint.
                style.underline = true;
                break;
            case 22:
                style.bold = false;
                style.dim = false;
                break;
            case 23:
                style.italic = false;
                break;
            case 24:
                style.underline = false;
                break;
            case 25:
                style.blink = false;
                break;
            case 27:
                style.reverse = false;
                break;
            case 28:
                style.invisible = false;
                break;
            case 29:
                style.strikethrough = false;
                break;
            case 30:
            case 31:
            case 32:
            case 33:
            case 34:
            case 35:
            case 36:
            case 37:
                style.fg = { kind: "palette", index: p - 30 };
                break;
            case 38: {
                // Extended foreground.  Form: 38;5;N (256-color) or 38;2;R;G;B.
                const consumed = readExtendedColor(params, i + 1);
                if (consumed.color) style.fg = consumed.color;
                i += consumed.advance;
                break;
            }
            case 39:
                style.fg = DefaultColor;
                break;
            case 40:
            case 41:
            case 42:
            case 43:
            case 44:
            case 45:
            case 46:
            case 47:
                style.bg = { kind: "palette", index: p - 40 };
                break;
            case 48: {
                const consumed = readExtendedColor(params, i + 1);
                if (consumed.color) style.bg = consumed.color;
                i += consumed.advance;
                break;
            }
            case 49:
                style.bg = DefaultColor;
                break;
            case 90:
            case 91:
            case 92:
            case 93:
            case 94:
            case 95:
            case 96:
            case 97:
                // Bright foreground: palette indices 8-15.
                style.fg = { kind: "palette", index: p - 90 + 8 };
                break;
            case 100:
            case 101:
            case 102:
            case 103:
            case 104:
            case 105:
            case 106:
            case 107:
                style.bg = { kind: "palette", index: p - 100 + 8 };
                break;
            default:
                // Unknown SGR — ignore.  Real terminals do the same; surfacing
                // an error here would noise up the console for benign cases
                // (CSI 26m, vendor extensions, etc.).
                break;
        }
        i += 1;
    }
    return style;
}

// Decode a 38/48 extended-color tail starting at `start`.  Returns the parsed
// color and the number of *additional* params consumed beyond the lead 38/48.
function readExtendedColor(
    params: number[],
    start: number
): { color: Color | null; advance: number } {
    const mode = params[start];
    if (mode === 5) {
        // 256-color
        const idx = params[start + 1];
        if (idx == null) return { color: null, advance: 1 };
        return { color: { kind: "palette", index: clamp(idx, 0, 255) }, advance: 2 };
    }
    if (mode === 2) {
        // RGB
        const r = params[start + 1];
        const g = params[start + 2];
        const b = params[start + 3];
        if (r == null || g == null || b == null) return { color: null, advance: 1 };
        return {
            color: { kind: "rgb", r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255) },
            advance: 4,
        };
    }
    // Unknown mode — drop the rest of the run silently.
    return { color: null, advance: 1 };
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

// withLink — derive a style with a different linkId.  Used by the OSC 8
// handler when entering / exiting a hyperlink without otherwise touching SGR.
export function withLink(style: CellStyle, linkId: number): CellStyle {
    if (style.linkId === linkId) return style;
    return { ...style, linkId };
}
