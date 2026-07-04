// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Default Dark — the foundational bundled theme.  Every other registry
// theme falls back to this one for any field it doesn't override, so
// the file doubles as the canonical "everything" template for new
// entries.  ANSI palette mirrors the warp Dark preset at warp/crates/
// warp_core/src/ui/theme/default_themes.rs::default_dark.

import type { RegistryEntry } from "../types";

export const defaultDarkEntry: RegistryEntry = {
    theme: {
        id: "default-dark",
        "display:name": "Default Dark",
        "display:order": 1,

        black: "#757575",
        red: "#cc685c",
        green: "#76c266",
        yellow: "#cbca9b",
        blue: "#85aacb",
        magenta: "#cc72ca",
        cyan: "#74a7cb",
        white: "#c1c1c1",
        brightBlack: "#727272",
        brightRed: "#cc9d97",
        brightGreen: "#a3dd97",
        brightYellow: "#cbcaaa",
        brightBlue: "#9ab6cb",
        brightMagenta: "#cc8ecb",
        brightCyan: "#b7b8cb",
        brightWhite: "#f0f0f0",
        gray: "#8b918a",
        cmdtext: "#f0f0f0",
        foreground: "#c1c1c1",
        // selectionBackground intentionally empty — ThemeModel picks a
        // foreground-contrasting fallback via pickBestForeground.
        selectionBackground: "",
        background: "#000000",
        // cursor empty → ThemeModel falls through to theme.foreground.
        cursor: "",
    },
};

// Re-exported as a plain TermThemeType for callers that want the
// resolved view without going through getBuiltinThemes().
export const defaultDark: TermThemeType = defaultDarkEntry.theme as TermThemeType;