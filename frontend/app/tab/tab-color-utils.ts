// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Warp tab colors come from `theme.terminal_colors().normal` (one of
// `AnsiColorIdentifier::{Red,Green,Yellow,Blue,Magenta,Cyan}`).  For
// warp's default dark theme, those resolve to the constants in
// `app/src/themes/default_themes.rs:11-20`
// (`DARK_MODE_NORMAL_COLORS = AnsiColors::new(…)`):
//   black   #616161  red    #FF8272  green  #B4FA72  yellow #FEFDC2
//   blue    #A5D5FE  magenta #FF8FFD cyan   #D0D1FE  white  #F1F1F1
//
// We use those hexes directly so the picker and row tint look exactly
// like warp's out-of-the-box experience — pastel-ish tones that read
// well as both 14px dots and 15%/50%-opacity row backgrounds.
//
// Stored as a TabColorId (the *name*) rather than a hex, mirroring
// warp's `AnsiColorIdentifier`.  resolveTabFlagColor maps id → hex.

export type TabColorId = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan";

export const TabColorOrder: TabColorId[] = ["red", "green", "yellow", "blue", "magenta", "cyan"];

export const TabColorLabels: Record<TabColorId, string> = {
    red: "Red",
    green: "Green",
    yellow: "Yellow",
    blue: "Blue",
    magenta: "Magenta",
    cyan: "Cyan",
};

// Warp's `DARK_MODE_NORMAL_COLORS` (default_themes.rs:11-20).
// Pasted as-is — the alpha byte (0xFF) is dropped since CSS doesn't
// need it for fully-opaque hexes.
export const TabColorHex: Record<TabColorId, string> = {
    red: "#FF8272",
    green: "#B4FA72",
    yellow: "#FEFDC2",
    blue: "#A5D5FE",
    magenta: "#FF8FFD",
    cyan: "#D0D1FE",
};

export function useTabColorPalette(): Record<TabColorId, string> {
    return TabColorHex;
}

// Resolve a stored `tab:flagcolor` value to a renderable hex.
// Accepts:
//  - a TabColorId ("red", "green", …) — new format
//  - a `#RRGGBB` literal — legacy format, returned as-is so existing
//    tabs flagged under the old impl keep their color
//  - null / undefined / "" — returns null (no color)
export function resolveTabFlagColor(value: string | null | undefined): string | null {
    if (!value) return null;
    if (value.startsWith("#")) return value;
    if ((TabColorOrder as readonly string[]).includes(value)) {
        return TabColorHex[value as TabColorId];
    }
    return null;
}

// Kept as a hook for call-site symmetry with the previous theme-aware
// version, even though the palette is static now.  If we later want
// the picker to track the active terminal theme again, this is the
// single spot to extend.
export function useResolvedTabFlagColor(value: string | null | undefined): string | null {
    return resolveTabFlagColor(value);
}
