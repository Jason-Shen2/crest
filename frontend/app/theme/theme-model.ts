// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// ThemeModel — applies the user's selected term theme to :root as CSS
// variables.  Ported from warp's WarpTheme system so the same handful
// of inputs (background, foreground, accent, ANSI palette, details)
// drive every UI token through warp's derived-color formulas.
//
// Inputs:
//   - settings["term:theme"]      key into fullConfig.termthemes
//   - fullConfig.termthemes[key]  TermThemeType payload
//
// Outputs (set on document.documentElement.style):
//   --color-background / --bg-gradient
//   --color-foreground / --color-primary / --color-white / --color-secondary / --color-muted{,-foreground} / --color-sub-text
//   --color-accent / --color-accenthover / --color-accentbg / --color-accent-50..900
//   --color-fg-overlay-1/2/3 / --color-surface-1/2/3
//   --color-modalbg / --color-panel / --color-hover / --color-hoverbg / --color-highlightbg / --color-border
//   --color-term-accent / --color-term-accent-10 / --color-term-accent-25 / --color-term-selection
//   --color-term-success / --color-term-error / --color-term-warning / --color-term-yellow
//   --ansi-{black,red,green,yellow,blue,magenta,cyan,white}
//   --ansi-bright{Black,Red,Green,Yellow,Blue,Magenta,Cyan,White}
//
// Visual references inside warp:
//   crates/warp_core/src/ui/theme/color.rs   — neutral_/fg_overlay_/accent_overlay_ formulas
//   app/src/themes/default_themes.rs         — the three bundled themes we ship

import * as jotai from "jotai";
import { globalStore } from "@/app/store/jotaiStore";
import { atoms } from "@/app/store/global";
import { blend, parseHex, pickBestForeground, RGBA, toRgbCss, withOpacity } from "./theme-color";
import { getBuiltinThemes, getThemeUiOverrides } from "./registry/themes";

const DEFAULT_THEME_KEY = "default-dark";

// Warp Dark accent (#19AAD8) — used as the fallback solid accent when a
// theme doesn't define one, since the rest of crest's UI already
// references it via --color-term-accent.
const FALLBACK_ACCENT = "#19AAD8";

type DetailsMode = "darker" | "lighter";

type ResolvedTheme = {
    key: string;
    name: string;
    background: RGBA;
    backgroundGradient: { top: RGBA; bottom: RGBA } | null;
    foreground: RGBA;
    accent: RGBA;
    accentGradient: { left: RGBA; right: RGBA } | null;
    cursor: RGBA;
    selection: RGBA | null;
    details: DetailsMode;
    ansi: {
        black: RGBA;
        red: RGBA;
        green: RGBA;
        yellow: RGBA;
        blue: RGBA;
        magenta: RGBA;
        cyan: RGBA;
        white: RGBA;
        brightBlack: RGBA;
        brightRed: RGBA;
        brightGreen: RGBA;
        brightYellow: RGBA;
        brightBlue: RGBA;
        brightMagenta: RGBA;
        brightCyan: RGBA;
        brightWhite: RGBA;
    };
};

// Variable names we set on :root.  Kept here so the resetTheme() path
// can clear precisely the keys we touch without disturbing other
// runtime-set vars (--zoomfactor, --window-opacity, --window-bg-color).
const MANAGED_VARS = [
    // Base surfaces
    "--color-background",
    "--bg-gradient",
    "--color-foreground",
    "--color-primary",
    "--color-white",
    "--color-secondary",
    "--color-muted-foreground",
    "--color-muted",
    "--color-sub-text",
    // Accent + states
    "--color-accent",
    "--color-accenthover",
    "--color-accent-pressed",
    "--color-accentbg",
    "--color-on-accent",
    "--color-accent-50",
    "--color-accent-100",
    "--color-accent-200",
    "--color-accent-300",
    "--color-accent-400",
    "--color-accent-500",
    "--color-accent-600",
    "--color-accent-700",
    "--color-accent-800",
    "--color-accent-900",
    // Overlay scales (warp fg_overlay_n / neutral_n / accent_overlay_n)
    "--color-fg-overlay-1",
    "--color-fg-overlay-2",
    "--color-fg-overlay-3",
    "--color-surface-1",
    "--color-surface-2",
    "--color-surface-3",
    // Modals / panels / chrome
    "--color-modalbg",
    "--color-tooltip-bg",
    "--color-on-tooltip",
    "--color-panel",
    "--color-hover",
    "--color-hoverbg",
    "--color-highlightbg",
    "--color-border",
    "--color-dark-overlay",
    "--color-inactive-pane-overlay",
    // Block / status overlays (warp block_list_element.rs consumption)
    "--color-block-selection",
    "--color-block-failed-overlay",
    "--color-block-banner-bg",
    "--color-block-ai-overlay",
    "--color-block-restored-overlay",
    "--color-subshell-bg",
    // Terminal-scoped (kept distinct from --color-accent for clarity)
    "--color-term-accent",
    "--color-term-accent-10",
    "--color-term-accent-25",
    "--color-term-selection",
    "--color-term-success",
    "--color-term-error",
    "--color-term-warning",
    "--color-term-yellow",
    // shadcn/ui tokens
    "--color-card",
    "--color-card-foreground",
    "--color-popover",
    "--color-popover-foreground",
    "--color-primary-foreground",
    "--color-secondary-foreground",
    "--color-accent-foreground",
    "--color-destructive",
    "--color-destructive-foreground",
    "--color-ring",
    "--color-input",
    "--color-error",
    "--color-warning",
    "--color-success",
    "--color-add",
    "--color-add-strong",
    "--color-remove",
    "--color-remove-strong",
    // Code / diff viewer backgrounds
    "--color-code-bg",
    "--color-code-header-bg",
    // Sidebar tokens (file explorer, future icon rail)
    "--color-sidebar",
    "--color-sidebar-foreground",
    "--color-sidebar-primary",
    "--color-sidebar-primary-foreground",
    "--color-sidebar-accent",
    "--color-sidebar-accent-foreground",
    "--color-sidebar-border",
    "--color-sidebar-ring",
    // ANSI 16
    "--ansi-black",
    "--ansi-red",
    "--ansi-green",
    "--ansi-yellow",
    "--ansi-blue",
    "--ansi-magenta",
    "--ansi-cyan",
    "--ansi-white",
    "--ansi-brightblack",
    "--ansi-brightred",
    "--ansi-brightgreen",
    "--ansi-brightyellow",
    "--ansi-brightblue",
    "--ansi-brightmagenta",
    "--ansi-brightcyan",
    "--ansi-brightwhite",
];

function pickHex(...candidates: string[]): string | null {
    for (const c of candidates) {
        if (c && typeof c === "string" && c.trim()) return c;
    }
    return null;
}

// Parse an arbitrary color string (hex, rgb(), rgba()) into an RGBA.
// Returns null if the value cannot be parsed.  Used for ui override
// values that come from theme authors as raw CSS strings.
function parseColorString(value: string): RGBA | null {
    const trimmed = value.trim();
    if (trimmed.startsWith("#")) {
        try {
            return parseHex(trimmed);
        } catch {
            return null;
        }
    }
    const rgbMatch = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i);
    if (rgbMatch) {
        const r = Math.min(255, Math.max(0, parseInt(rgbMatch[1], 10)));
        const g = Math.min(255, Math.max(0, parseInt(rgbMatch[2], 10)));
        const b = Math.min(255, Math.max(0, parseInt(rgbMatch[3], 10)));
        let a = 255;
        if (rgbMatch[4] !== undefined) {
            const alphaFloat = parseFloat(rgbMatch[4]);
            a = Math.round(Math.min(1, Math.max(0, alphaFloat)) * 255);
        }
        return { r, g, b, a };
    }
    return null;
}

// Convert a CSS color value (string) to a format suitable for CSS
// custom property assignment.  Raw strings are returned as-is so
// authors can use rgba()/oklch()/etc.; #-hex values are normalized
// through toRgbCss() for consistency with computed vars.
function toCssColorValue(value: string): string {
    const parsed = parseColorString(value);
    if (parsed) return toRgbCss(parsed);
    return value;
}

function resolveTheme(key: string, theme: TermThemeType): ResolvedTheme {
    const bgTopHex = pickHex(theme.backgroundTop, theme.background);
    const background = parseHex(bgTopHex ?? "#000000");
    const backgroundGradient =
        theme.backgroundTop && theme.backgroundBottom
            ? { top: parseHex(theme.backgroundTop), bottom: parseHex(theme.backgroundBottom) }
            : null;

    const foreground = parseHex(pickHex(theme.foreground, theme.cmdtext, theme.brightWhite, theme.white) ?? "#ffffff");

    // Accent: prefer explicit theme.accent, then the midpoint of the
    // horizontal gradient if present, then fall back to ANSI cyan or
    // the warp Dark accent.  Mirrors warp's into_solid_bias_top_color
    // for HorizontalGradient (midcolor).
    let accent: RGBA;
    if (theme.accent) {
        accent = parseHex(theme.accent);
    } else if (theme.accentLeft && theme.accentRight) {
        const l = parseHex(theme.accentLeft);
        const r = parseHex(theme.accentRight);
        accent = {
            r: Math.round((l.r + r.r) / 2),
            g: Math.round((l.g + r.g) / 2),
            b: Math.round((l.b + r.b) / 2),
            a: 255,
        };
    } else {
        accent = parseHex(pickHex(theme.cyan, FALLBACK_ACCENT) ?? FALLBACK_ACCENT);
    }
    const accentGradient =
        theme.accentLeft && theme.accentRight
            ? { left: parseHex(theme.accentLeft), right: parseHex(theme.accentRight) }
            : null;

    const cursor = parseHex(pickHex(theme.cursor, theme.foreground) ?? "#ffffff");
    const selection = theme.selectionBackground ? parseHex(theme.selectionBackground) : null;

    const details: DetailsMode = theme.details === "lighter" ? "lighter" : "darker";

    return {
        key,
        name: theme["display:name"] ?? key,
        background,
        backgroundGradient,
        foreground,
        accent,
        accentGradient,
        cursor,
        selection,
        details,
        ansi: {
            black: parseHex(theme.black),
            red: parseHex(theme.red),
            green: parseHex(theme.green),
            yellow: parseHex(theme.yellow),
            blue: parseHex(theme.blue),
            magenta: parseHex(theme.magenta),
            cyan: parseHex(theme.cyan),
            white: parseHex(theme.white),
            brightBlack: parseHex(pickHex(theme.brightBlack, theme.black) ?? theme.black),
            brightRed: parseHex(pickHex(theme.brightRed, theme.red) ?? theme.red),
            brightGreen: parseHex(pickHex(theme.brightGreen, theme.green) ?? theme.green),
            brightYellow: parseHex(pickHex(theme.brightYellow, theme.yellow) ?? theme.yellow),
            brightBlue: parseHex(pickHex(theme.brightBlue, theme.blue) ?? theme.blue),
            brightMagenta: parseHex(pickHex(theme.brightMagenta, theme.magenta) ?? theme.magenta),
            brightCyan: parseHex(pickHex(theme.brightCyan, theme.cyan) ?? theme.cyan),
            brightWhite: parseHex(pickHex(theme.brightWhite, theme.white) ?? theme.white),
        },
    };
}

// Compute CSS variable map from the resolved theme using warp's blend
// formulas.  See warp/crates/warp_core/src/ui/theme/color.rs for the
// reference values:
//   neutral_n  = background ⊕ foreground@(5,10,15,20,40,60,90)%
//   fg_overlay = foreground@(5,10,15,20,40,60,90)%
//   accent_overlay = accent@(10,25,40,60)%
function computeVars(t: ResolvedTheme): Record<string, string> {
    const vars: Record<string, string> = {};

    // Backgrounds: emit a solid for widget tiles, plus a gradient for
    // the body if the theme defines one.  Cyber Wave is the headline
    // user of this path.  --bg-gradient is intentionally omitted for
    // solid themes so the body's `background-image: var(--bg-gradient,
    // none)` falls through to the solid --color-background underneath.
    // Direct CSS linear-gradient — same two-stop form warp's
    // Fill::VerticalGradient produces (mod.rs:158-203).
    vars["--color-background"] = toRgbCss(t.background);
    if (t.backgroundGradient) {
        // `in oklab` keeps the midtone perceptually closer to the top color —
        // sRGB-linear interpolation on a (dark teal → black) gradient washes
        // out to near-black around the 30% mark.  warp's GPU pipeline gives
        // a similarly "lifted" middle, so this gets us visual parity without
        // changing the theme's declared stops.
        vars["--bg-gradient"] = `linear-gradient(180deg in oklab, ${toRgbCss(t.backgroundGradient.top)} 0%, ${toRgbCss(t.backgroundGradient.bottom)} 100%)`;
    }

    // Foreground / text strata.  warp's "darker" preset hands main
    // text @90, sub @60, hint @40 — we map crest's existing tokens to
    // the closest equivalents so already-shipped CSS keeps working.
    // NOTE: --color-secondary stays a TEXT color (muted foreground)
    // for backward compat with existing text-secondary usage; the
    // shadcn secondary-background role is served by --color-muted
    // (which is a bg tone) and components can use bg-muted/50 etc.
    vars["--color-foreground"] = toRgbCss(t.foreground);
    vars["--color-primary"] = toRgbCss(t.foreground);
    vars["--color-white"] = toRgbCss(t.foreground);
    vars["--color-secondary"] = toRgbCss(withOpacity(t.foreground, 60));
    vars["--color-secondary-foreground"] = toRgbCss(t.foreground);
    vars["--color-muted-foreground"] = toRgbCss(withOpacity(t.foreground, 60));
    vars["--color-muted"] = toRgbCss(blend(t.background, withOpacity(t.foreground, 8)));
    vars["--color-sub-text"] = toRgbCss(withOpacity(t.foreground, 62));

    // Accent + state variants.  Formulas straight from
    //   warp/.../color.rs internal_colors::accent_hover (line 453)
    //   warp/.../color.rs internal_colors::accent_pressed (line 463).
    // Hover blends FOREGROUND into accent — gives lift on dark themes
    // (fg=light → brighter) and darken on light themes (fg=dark →
    // darker), which is the asymmetric behavior warp wants.  Pressed
    // does the inverse with BACKGROUND so it always reads "active".
    vars["--color-accent"] = toRgbCss(t.accent);
    vars["--color-accenthover"] = toRgbCss(blend(t.accent, withOpacity(t.foreground, 40)));
    vars["--color-accent-pressed"] = toRgbCss(blend(t.accent, withOpacity(t.background, 30)));
    vars["--color-accentbg"] = toRgbCss(withOpacity(t.accent, 50));

    // Text color to use on top of an --color-accent surface.  This is
    // the warp pattern that makes light themes (Solarized Light, mint
    // accent) actually readable — fg and bg on a midtone accent both
    // fail WCAG 4.5:1, so we fall back to black/white via
    // pickBestForeground (faithful to warp's pick_best_foreground_color
    // contrast.rs:154).  Used by any UI that puts text on bg-accent.
    vars["--color-on-accent"] = toRgbCss(pickBestForeground(t.accent, t.foreground, t.background));

    // Accent scale 50..900.  Approximate: blend toward foreground for
    // the light end, toward background for the dark end.  Keeps shadcn/
    // tailwind utility classes (text-accent-100 etc.) producing sensible
    // colors without needing a full HSL ramp.
    const accentScalePoints = [
        { name: 50, mix: 90, towardFg: true },
        { name: 100, mix: 75, towardFg: true },
        { name: 200, mix: 55, towardFg: true },
        { name: 300, mix: 30, towardFg: true },
        { name: 400, mix: 0, towardFg: true },
        { name: 500, mix: 15, towardFg: false },
        { name: 600, mix: 30, towardFg: false },
        { name: 700, mix: 45, towardFg: false },
        { name: 800, mix: 60, towardFg: false },
        { name: 900, mix: 75, towardFg: false },
    ];
    for (const p of accentScalePoints) {
        const overlay = withOpacity(p.towardFg ? t.foreground : t.background, p.mix);
        vars[`--color-accent-${p.name}`] = toRgbCss(blend(t.accent, overlay));
    }

    // Foreground / surface overlays (warp fg_overlay_n and neutral_n).
    vars["--color-fg-overlay-1"] = toRgbCss(withOpacity(t.foreground, 5));
    vars["--color-fg-overlay-2"] = toRgbCss(withOpacity(t.foreground, 9));
    vars["--color-fg-overlay-3"] = toRgbCss(withOpacity(t.foreground, 18));
    vars["--color-surface-1"] = toRgbCss(blend(t.background, withOpacity(t.foreground, 5)));
    vars["--color-surface-2"] = toRgbCss(blend(t.background, withOpacity(t.foreground, 10)));
    vars["--color-surface-3"] = toRgbCss(blend(t.background, withOpacity(t.foreground, 15)));

    // Modals / panels / hover-states.  modalbg is opaque; panel keeps
    // the existing translucent feel for blur backdrops.  Tooltips use
    // warp's neutral_6 = bg ⊕ fg@60% (color.rs:359) — far higher
    // contrast than the modal surface so floating callouts read clearly
    // against any UI underneath.
    vars["--color-modalbg"] = toRgbCss(blend(t.background, withOpacity(t.foreground, 8)));
    const tooltipBg = blend(t.background, withOpacity(t.foreground, 60));
    vars["--color-tooltip-bg"] = toRgbCss(tooltipBg);
    // Tooltip is the textbook case where naive `text-foreground` fails:
    // the bg sits at ~60% between bg and fg, so neither extreme has
    // enough WCAG contrast.  pickBestForeground falls through to
    // black/white when {bg, fg} both miss, mirroring warp's main_text_
    // color(tooltip_background) → font_color → pick_best_foreground_color.
    vars["--color-on-tooltip"] = toRgbCss(pickBestForeground(tooltipBg, t.foreground, t.background));
    vars["--color-panel"] = toRgbCss({ ...blend(t.background, withOpacity(t.foreground, 6)), a: 128 });
    vars["--color-hover"] = toRgbCss(withOpacity(t.foreground, 10));
    vars["--color-hoverbg"] = toRgbCss(withOpacity(t.foreground, 20));
    vars["--color-highlightbg"] = toRgbCss(withOpacity(t.foreground, 20));
    vars["--color-border"] = toRgbCss(withOpacity(t.foreground, 15));
    // Dark scrim used behind modals + button-click feedback.  Always
    // black per warp's dark_overlay (color.rs:206) — the click looks
    // the same on every theme.
    vars["--color-dark-overlay"] = toRgbCss({ r: 0, g: 0, b: 0, a: Math.round(0.2 * 255) });
    // Dim non-focused split panes.  warp inactive_pane_overlay
    // (color.rs:345) = fg_overlay_2.
    vars["--color-inactive-pane-overlay"] = toRgbCss(withOpacity(t.foreground, 10));

    // Block / status tokens — direct ports of the methods that
    // block_list_element.rs reaches for:
    //   block_selection_color           = accent_overlay_2  (accent@25%)
    //   failed_block_color.with_opacity = ansi_red@10%
    //   block_banner_background         = neutral_3         (bg+fg@15%)
    //   ai_blocks_overlay               = fg_overlay_1      (fg@5%)
    //   restored_blocks_overlay         = fg_overlay_2      (fg@10%)
    //   subshell_background             = neutral_4         (bg+fg@20%)
    vars["--color-block-selection"] = toRgbCss(withOpacity(t.accent, 25));
    vars["--color-block-failed-overlay"] = toRgbCss(withOpacity(t.ansi.red, 10));
    vars["--color-block-banner-bg"] = toRgbCss(blend(t.background, withOpacity(t.foreground, 15)));
    vars["--color-block-ai-overlay"] = toRgbCss(withOpacity(t.foreground, 5));
    vars["--color-block-restored-overlay"] = toRgbCss(withOpacity(t.foreground, 10));
    vars["--color-subshell-bg"] = toRgbCss(blend(t.background, withOpacity(t.foreground, 20)));

    // Terminal-scoped accent (the cyan-cursor color in warp Dark).  Same
    // accent, but with the alpha steps we already reference throughout
    // the term renderer.
    vars["--color-term-accent"] = toRgbCss(t.accent);
    vars["--color-term-accent-10"] = toRgbCss(withOpacity(t.accent, 10));
    vars["--color-term-accent-25"] = toRgbCss(withOpacity(t.accent, 25));
    vars["--color-term-selection"] = t.selection
        ? toRgbCss(t.selection)
        : toRgbCss(withOpacity(pickBestForeground(t.background, t.ansi.blue, t.ansi.cyan), 40));

    // Status colors lean on ANSI green/red/yellow so they shift with
    // the palette.  warp does the same in ansi_fg_green / ui_error /
    // ui_warning helpers.
    vars["--color-term-success"] = toRgbCss(t.ansi.green);
    vars["--color-term-error"] = toRgbCss(t.ansi.red);
    vars["--color-term-warning"] = toRgbCss(t.ansi.yellow);
    vars["--color-term-yellow"] = toRgbCss(t.ansi.yellow);

    // shadcn/ui tokens — derived from the same palette so all
    // shadcn components (button, dialog, card, input, etc.)
    // automatically follow the active theme instead of staying
    // locked to the static @theme defaults in tailwindsetup.css.
    const cardSurface = blend(t.background, withOpacity(t.foreground, 8));
    vars["--color-card"] = toRgbCss(cardSurface);
    vars["--color-card-foreground"] = toRgbCss(t.foreground);
    vars["--color-popover"] = toRgbCss(cardSurface);
    vars["--color-popover-foreground"] = toRgbCss(t.foreground);
    vars["--color-primary-foreground"] = toRgbCss(pickBestForeground(t.foreground, t.background, t.foreground));
    vars["--color-secondary-foreground"] = toRgbCss(t.foreground);
    vars["--color-accent-foreground"] = toRgbCss(t.foreground);
    vars["--color-destructive"] = toRgbCss(t.ansi.red);
    vars["--color-destructive-foreground"] = toRgbCss(pickBestForeground(t.ansi.red, t.foreground, t.background));
    vars["--color-ring"] = toRgbCss(t.accent);
    vars["--color-input"] = toRgbCss(withOpacity(t.foreground, 14));
    vars["--color-error"] = toRgbCss(t.ansi.red);
    vars["--color-warning"] = toRgbCss(t.ansi.yellow);
    vars["--color-success"] = toRgbCss(t.ansi.green);
    vars["--color-add"] = toRgbCss(withOpacity(t.ansi.green, 22));
    vars["--color-add-strong"] = toRgbCss(t.ansi.green);
    vars["--color-remove"] = toRgbCss(withOpacity(t.ansi.red, 24));
    vars["--color-remove-strong"] = toRgbCss(t.ansi.red);

    // Code block backgrounds — a surface step deeper than prose so
    // fenced code / diff viewers have visual separation.  Uses the
    // same bg⊕fg blend formula as --color-surface-* so it adapts to
    // any theme (lighter on dark, darker on light).
    vars["--color-code-bg"] = toRgbCss(blend(t.background, withOpacity(t.foreground, 8)));
    vars["--color-code-header-bg"] = toRgbCss(blend(t.background, withOpacity(t.foreground, 14)));

    // Sidebar tokens — defaults for themes that don't pin explicit
    // values.  For dark themes the sidebar sits a step darker than
    // card to create visual hierarchy; for light themes it stays
    // close to card.  These are all overridable via a theme's `ui`
    // field (see applyTheme).
    const isDark = t.details === "darker";
    const sidebarBg = isDark
        ? blend(t.background, { r: 0, g: 0, b: 0, a: 38 }) // bg ⊕ black@15% — pushes darker
        : blend(t.background, withOpacity(t.foreground, 5));
    const sidebarAccent = blend(t.background, withOpacity(t.foreground, 9));
    vars["--color-sidebar"] = toRgbCss(sidebarBg);
    vars["--color-sidebar-foreground"] = toRgbCss(t.foreground);
    vars["--color-sidebar-primary"] = toRgbCss(t.accent);
    vars["--color-sidebar-primary-foreground"] = toRgbCss(pickBestForeground(t.accent, t.foreground, t.background));
    vars["--color-sidebar-accent"] = toRgbCss(sidebarAccent);
    vars["--color-sidebar-accent-foreground"] = toRgbCss(t.foreground);
    vars["--color-sidebar-border"] = toRgbCss(withOpacity(t.foreground, 10));
    vars["--color-sidebar-ring"] = toRgbCss(t.accent);

    // ANSI palette — feeds --ansi-* used by the renderer's
    // resolveColor() in frontend/app/term/render/color.ts.
    vars["--ansi-black"] = toRgbCss(t.ansi.black);
    vars["--ansi-red"] = toRgbCss(t.ansi.red);
    vars["--ansi-green"] = toRgbCss(t.ansi.green);
    vars["--ansi-yellow"] = toRgbCss(t.ansi.yellow);
    vars["--ansi-blue"] = toRgbCss(t.ansi.blue);
    vars["--ansi-magenta"] = toRgbCss(t.ansi.magenta);
    vars["--ansi-cyan"] = toRgbCss(t.ansi.cyan);
    vars["--ansi-white"] = toRgbCss(t.ansi.white);
    vars["--ansi-brightblack"] = toRgbCss(t.ansi.brightBlack);
    vars["--ansi-brightred"] = toRgbCss(t.ansi.brightRed);
    vars["--ansi-brightgreen"] = toRgbCss(t.ansi.brightGreen);
    vars["--ansi-brightyellow"] = toRgbCss(t.ansi.brightYellow);
    vars["--ansi-brightblue"] = toRgbCss(t.ansi.brightBlue);
    vars["--ansi-brightmagenta"] = toRgbCss(t.ansi.brightMagenta);
    vars["--ansi-brightcyan"] = toRgbCss(t.ansi.brightCyan);
    vars["--ansi-brightwhite"] = toRgbCss(t.ansi.brightWhite);

    return vars;
}

export class ThemeModel {
    private static instance: ThemeModel | null = null;

    activeKeyAtom = jotai.atom(DEFAULT_THEME_KEY) as jotai.PrimitiveAtom<string>;
    resolvedAtom = jotai.atom(null) as jotai.PrimitiveAtom<ResolvedTheme | null>;

    private unsubscribe: (() => void) | null = null;

    private constructor() {}

    static getInstance(): ThemeModel {
        if (!ThemeModel.instance) {
            ThemeModel.instance = new ThemeModel();
        }
        return ThemeModel.instance;
    }

    // Wires the model to fullConfigAtom changes.  Call once at app boot
    // after the first config snapshot has been pushed into the store.
    initialize(): void {
        if (this.unsubscribe) return;
        this.applyFromStore();
        this.unsubscribe = globalStore.sub(atoms.fullConfigAtom, () => {
            this.applyFromStore();
        });
    }

    dispose(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    private applyFromStore(): void {
        const fullConfig = globalStore.get(atoms.fullConfigAtom);
        if (!fullConfig) return;
        const themes = getBuiltinThemes(fullConfig.termthemes ?? {});
        const settingsTheme = fullConfig.settings?.["term:theme"];
        const key =
            (settingsTheme && themes[settingsTheme] && settingsTheme) ||
            (themes[DEFAULT_THEME_KEY] && DEFAULT_THEME_KEY) ||
            Object.keys(themes)[0];
        if (!key || !themes[key]) return;
        this.applyTheme(key, themes[key]);
    }

    applyTheme(key: string, theme: TermThemeType): void {
        const resolved = resolveTheme(key, theme);
        const vars = computeVars(resolved);

        // Apply registry-level UI token overrides (e.g. terax-ai Claude
        // theme pins exact hexes for card/popover/sidebar instead of
        // relying on blend-formula derivation).  These win over the
        // computed defaults for any key the theme explicitly declares.
        //
        // NOTE: we deliberately do NOT map ui.secondary / ui.accent to
        // --color-secondary / --color-accent here:
        //   - crest --color-secondary is a TEXT color (muted fg) used
        //     by `text-secondary` throughout the codebase; terax
        //     `secondary` is a background tone.
        //   - crest --color-accent is the brand/CTA color (buttons,
        //     links, focus rings, cursor); terax `accent` is a subtle
        //     hover/selection gray.  The sidebar-* accent tokens carry
        //     that hover-gray role for panel regions like the file
        //     explorer.
        const uiOverrides = getThemeUiOverrides(key);
        const uiVarMap: Record<string, keyof typeof uiOverrides> = {
            "--color-card": "card",
            "--color-card-foreground": "cardForeground",
            "--color-popover": "popover",
            "--color-popover-foreground": "popoverForeground",
            "--color-primary-foreground": "primaryForeground",
            "--color-muted": "muted",
            "--color-muted-foreground": "mutedForeground",
            "--color-accent-foreground": "accentForeground",
            "--color-destructive": "destructive",
            "--color-destructive-foreground": "destructiveForeground",
            "--color-border": "border",
            "--color-input": "input",
            "--color-ring": "ring",
            "--color-sidebar": "sidebar",
            "--color-sidebar-foreground": "sidebarForeground",
            "--color-sidebar-primary": "sidebarPrimary",
            "--color-sidebar-primary-foreground": "sidebarPrimaryForeground",
            "--color-sidebar-accent": "sidebarAccent",
            "--color-sidebar-accent-foreground": "sidebarAccentForeground",
            "--color-sidebar-border": "sidebarBorder",
            "--color-sidebar-ring": "sidebarRing",
        };
        for (const [cssVar, uiKey] of Object.entries(uiVarMap)) {
            const val = uiOverrides[uiKey];
            if (val !== undefined && val !== null && val !== "") {
                vars[cssVar] = toCssColorValue(val);
            }
        }

        const root = document.documentElement;
        // Iterate managed vars so any token absent from the new map
        // (e.g. --bg-gradient when switching from Cyber Wave to a solid
        // theme) is cleared rather than left stale.
        for (const name of MANAGED_VARS) {
            if (name in vars) {
                root.style.setProperty(name, vars[name]);
            } else {
                root.style.removeProperty(name);
            }
        }
        globalStore.set(this.activeKeyAtom, key);
        globalStore.set(this.resolvedAtom, resolved);
    }

    resetTheme(): void {
        const root = document.documentElement;
        for (const name of MANAGED_VARS) {
            root.style.removeProperty(name);
        }
        globalStore.set(this.resolvedAtom, null);
    }
}
