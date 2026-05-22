// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Color math used by ThemeModel.  Faithfully mirrors warp's blending
// primitives so derived tokens (surfaces, overlays, contrast text) end up
// with the same visual feel as warp's own UI.
//
// Visual reference:
//   warp/crates/warp_core/src/ui/color/blend.rs       — over-compositing
//   warp/crates/warp_core/src/ui/color/contrast.rs    — best-foreground pick
//   warp/crates/warp_core/src/ui/theme/color.rs       — neutral_/fg_overlay_/accent_overlay

export type RGBA = { r: number; g: number; b: number; a: number };

export function parseHex(hex: string): RGBA {
    if (!hex) return { r: 0, g: 0, b: 0, a: 255 };
    let s = hex.trim();
    if (s.startsWith("#")) s = s.slice(1);
    if (s.length === 3) {
        s = s
            .split("")
            .map((c) => c + c)
            .join("");
    }
    if (s.length === 6) {
        return {
            r: parseInt(s.slice(0, 2), 16),
            g: parseInt(s.slice(2, 4), 16),
            b: parseInt(s.slice(4, 6), 16),
            a: 255,
        };
    }
    if (s.length === 8) {
        return {
            r: parseInt(s.slice(0, 2), 16),
            g: parseInt(s.slice(2, 4), 16),
            b: parseInt(s.slice(4, 6), 16),
            a: parseInt(s.slice(6, 8), 16),
        };
    }
    return { r: 0, g: 0, b: 0, a: 255 };
}

export function toRgbCss(c: RGBA): string {
    if (c.a >= 255) return `rgb(${c.r}, ${c.g}, ${c.b})`;
    const alpha = (c.a / 255).toFixed(3);
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

export function toHexCss(c: RGBA): string {
    const h = (n: number) => n.toString(16).padStart(2, "0");
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

// Set the alpha channel — percent is 0..100, matching warp's Opacity type.
// Reference: warp coloru_with_opacity (color/mod.rs).
export function withOpacity(c: RGBA, percent: number): RGBA {
    const p = Math.max(0, Math.min(100, percent));
    return { r: c.r, g: c.g, b: c.b, a: Math.round((p / 100) * 255) };
}

// Over-compositing: paint `over` on top of `base`.  Mirrors warp's
// Blend impl for ColorU: result.rgb = base.rgb * (1 - over.a/255) +
// over.rgb * (over.a/255); base.alpha is preserved.
// Reference: warp/crates/warp_core/src/ui/color/blend.rs.
export function blend(base: RGBA, over: RGBA): RGBA {
    const oa = over.a / 255;
    return {
        r: Math.round(base.r * (1 - oa) + over.r * oa),
        g: Math.round(base.g * (1 - oa) + over.g * oa),
        b: Math.round(base.b * (1 - oa) + over.b * oa),
        a: base.a,
    };
}

// WCAG relative luminance.  Reference: warp relative_luminance
// (color/contrast.rs).
export function relativeLuminance(c: RGBA): number {
    const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

// Contrast ratio of two opaque colors (1..21).  The 0.05 offset matches
// warp's LUMINANCE_OFFSET_FOR_CONTRAST_RATIO (contrast.rs:10) — it's
// W3C-spec-recommended to avoid division-by-near-zero at pure black.
const LUMINANCE_OFFSET = 0.05;

export function contrastRatio(a: RGBA, b: RGBA): number {
    const la = relativeLuminance(a) + LUMINANCE_OFFSET;
    const lb = relativeLuminance(b) + LUMINANCE_OFFSET;
    return la > lb ? la / lb : lb / la;
}

// WCAG minima.  4.5:1 is the threshold for normal-sized text;
// 3:1 covers non-text graphical elements (icons, UI affordances).
// Reference: warp MinimumAllowedContrast (contrast.rs:121-145).
export const WCAG_TEXT_CONTRAST = 4.5;
export const WCAG_NONTEXT_CONTRAST = 3.0;

function pickContrasting(bg: RGBA, a: RGBA, b: RGBA): RGBA {
    return contrastRatio(bg, a) >= contrastRatio(bg, b) ? a : b;
}

// Pick the best foreground color for `bg` out of {a, b}, falling back to
// {black, white} if neither candidate hits `minContrast`.  This is the
// faithful port of warp's pick_best_foreground_color (contrast.rs:154);
// black/white are guaranteed to satisfy any WCAG threshold because they
// sit at the extremes of relative luminance.
export function pickBestForeground(
    bg: RGBA,
    a: RGBA,
    b: RGBA,
    minContrast: number = WCAG_TEXT_CONTRAST,
): RGBA {
    const candidate = pickContrasting(bg, a, b);
    if (contrastRatio(bg, candidate) >= minContrast) return candidate;
    const black: RGBA = { r: 0, g: 0, b: 0, a: 255 };
    const white: RGBA = { r: 255, g: 255, b: 255, a: 255 };
    return pickContrasting(bg, black, white);
}
