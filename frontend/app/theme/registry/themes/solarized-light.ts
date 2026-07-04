// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Solarized Light — the canonical "lighter" details-mode theme.
// Demonstrates partial inheritance from default-dark: only the
// details preset needs to flip; the ANSI palette and bg/fg are all
// overriding values, but anything absent still falls through to the
// base (e.g. gray, cmdtext would inherit default-dark's values if
// not declared here).

import type { RegistryEntry } from "../types";

export const solarizedLightEntry: RegistryEntry = {
    extends: "default-dark",
    theme: {
        id: "solarized-light",
        "display:name": "Solarized Light",
        "display:order": 12,

        // Background + foreground flip to light end.  ThemeModel's
        // `details: "lighter"` branch (theme-model.ts:200) keeps the
        // 90/60/40 fg-opacity ladder usable on a bright background
        // — the default "darker" ladder washes out text on Solarized
        // Light without this.
        background: "#FDF6E3",
        foreground: "#586E75",
        cursor: "#586E75",

        // Solarized canonical palette — declared explicitly rather
        // than inheriting the dark palette, because most users expect
        // the warm-paper look.
        black: "#073642",
        red: "#DC322F",
        green: "#859900",
        yellow: "#B58900",
        blue: "#268BD2",
        magenta: "#D33682",
        cyan: "#2AA198",
        white: "#EEE8D5",
        brightBlack: "#002B36",
        brightRed: "#CB4B16",
        brightGreen: "#586E75",
        brightYellow: "#657B83",
        brightBlue: "#839496",
        brightMagenta: "#6C71C4",
        brightCyan: "#93A1A1",
        brightWhite: "#FDF6E3",
        gray: "#586E75",
        cmdtext: "#586E75",

        // Accent flips to the canonical Solarized teal.  Falling back
        // to ANSI cyan would also work, but the explicit teal matches
        // what users expect from "Solarized Light".
        accent: "#66B5A9",

        details: "lighter",
    },
};