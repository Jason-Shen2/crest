// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Color resolution.  Turns engine Color values (palette index or RGB) into
// CSS strings the renderer can drop into inline `style`.  Kept separate so
// the engine doesn't grow any DOM/CSS knowledge — the engine just carries
// the abstract reference.
//
// Honors per-terminal overrides (OSC 4 palette indices, OSC 10/11 default
// fg/bg).  Overrides come from PaletteContext; callers pass them in so
// CellRun can stay a pure render function.

import { Color } from "../engine/types";
import { PaletteOverrides } from "./palette-context";

// ANSI palette names map to the --ansi-* CSS custom properties defined in
// tailwindsetup.css.  Indexes 0-7 are the base ANSI colors, 8-15 are bright
// variants.  Keep this in lock-step with the theme tokens.
const AnsiNames = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightblack",
    "brightred",
    "brightgreen",
    "brightyellow",
    "brightblue",
    "brightmagenta",
    "brightcyan",
    "brightwhite",
];

// 6×6×6 color cube → 6 levels.  Standard xterm mapping: level 0 = 0,
// levels 1-5 use `55 + n*40`.
function cubeStep(n: number): number {
    return n === 0 ? 0 : 55 + n * 40;
}

export type ColorRole = "fg" | "bg";

// resolveColor — Color → CSS color string, or null for "default" with no
// override (the renderer omits the property so the cascade applies).
// `role` distinguishes which default override to apply when the color
// kind is "default".
export function resolveColor(color: Color, role: ColorRole = "fg", overrides?: PaletteOverrides): string | null {
    if (color.kind === "default") {
        if (overrides) {
            if (role === "fg" && overrides.defaultFg) return overrides.defaultFg;
            if (role === "bg" && overrides.defaultBg) return overrides.defaultBg;
        }
        return null;
    }
    if (color.kind === "rgb") {
        return `rgb(${color.r}, ${color.g}, ${color.b})`;
    }
    // palette
    const idx = color.index;
    if (idx < 0 || idx > 255) return null;
    if (overrides) {
        const override = overrides.palette[idx];
        if (override) return override;
    }
    if (idx < 16) return `var(--ansi-${AnsiNames[idx]})`;
    if (idx < 232) {
        const i = idx - 16;
        const r = cubeStep(Math.floor(i / 36));
        const g = cubeStep(Math.floor((i % 36) / 6));
        const b = cubeStep(i % 6);
        return `rgb(${r}, ${g}, ${b})`;
    }
    // Grayscale ramp 232-255: 24 steps from #080808 to #eeeeee.
    const gray = 8 + (idx - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
}

// parseColorSpec — decode an xterm OSC color payload.  Accepts:
//   * "rgb:RR/GG/BB"        — 1-4 hex digits per channel, scaled to 0-255
//   * "rgba:RR/GG/BB/AA"    — alpha ignored; opacity handled by the renderer
//   * "#RRGGBB" / "#RGB"    — CSS hex, passed through
// Returns null for unparsable specs.
export function parseColorSpec(s: string): string | null {
    const raw = s.trim();
    if (!raw) return null;
    if (raw.startsWith("#")) {
        if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
        if (/^#[0-9a-fA-F]{3}$/.test(raw)) return raw;
        return null;
    }
    const prefix = raw.startsWith("rgba:") ? "rgba:" : raw.startsWith("rgb:") ? "rgb:" : null;
    if (!prefix) return null;
    const parts = raw.slice(prefix.length).split("/");
    if (parts.length < 3) return null;
    const r = parseHexChannel(parts[0]);
    const g = parseHexChannel(parts[1]);
    const b = parseHexChannel(parts[2]);
    if (r == null || g == null || b == null) return null;
    return `rgb(${r}, ${g}, ${b})`;
}

function parseHexChannel(hex: string): number | null {
    if (!/^[0-9a-fA-F]{1,4}$/.test(hex)) return null;
    const max = (1 << (hex.length * 4)) - 1;
    const n = parseInt(hex, 16);
    return Math.round((n / max) * 255);
}
