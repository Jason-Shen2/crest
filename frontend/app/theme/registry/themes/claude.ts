// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Claude — warm clay accent on paper dark theme.
// Ported from terax-ai (https://github.com/crynta/terax-ai)
// src/modules/theme/themes/claude.ts.
//
// Palette philosophy (from terax-ai):
//   background  #1f1e1d  warm dark brown-black
//   foreground  #f5f4ee  warm paper white
//   accent      #d97757  terracotta / warm clay
//   ANSI        earthy olive/ochre/denim/rose/teal instead of
//               warp's neon green/cyan palette.

import type { RegistryEntry } from "../types";

export const claudeEntry: RegistryEntry = {
    theme: {
        id: "claude",
        "display:name": "Claude",
        "display:order": 2,

        background: "#1f1e1d",
        foreground: "#f5f4ee",
        cmdtext: "#f5f4ee",
        white: "#d8d3c7",
        cursor: "#d97757",
        gray: "#b0a89a",
        selectionBackground: "#d9775738",

        black: "#34322e",
        red: "#e5634d",
        green: "#b3c98c",
        yellow: "#e8b87a",
        blue: "#8fb0d9",
        magenta: "#cf9bb0",
        cyan: "#82c0bb",
        brightBlack: "#5a554c",
        brightRed: "#f07a63",
        brightGreen: "#c4d89e",
        brightYellow: "#f5cf94",
        brightBlue: "#a9c3e0",
        brightMagenta: "#e0b0c6",
        brightCyan: "#9bd4cf",
        brightWhite: "#f5f4ee",

        accent: "#d97757",

        details: "darker",
    },
    ui: {
        // Exact shadcn/ui + sidebar values from terax-ai Claude dark theme
        // (src/modules/theme/themes/claude.ts).  These bypass the blend-
        // formula defaults so every surface matches terax pixel-for-pixel.
        card: "#262624",
        cardForeground: "#f5f4ee",
        popover: "#262624",
        popoverForeground: "#f5f4ee",
        primaryForeground: "#1f1e1d",
        muted: "#2a2926",
        mutedForeground: "#b0a89a",
        accentForeground: "#f5f4ee",
        destructive: "#e5634d",
        border: "rgba(245,244,238,0.10)",
        input: "rgba(245,244,238,0.14)",
        ring: "#d97757",
        // Sidebar tokens — for future icon nav rail (darker than card).
        // terax uses these for the leftmost icon bar, not the file
        // explorer (which lives in a bg-card panel).
        sidebar: "#1a1918",
        sidebarForeground: "#f5f4ee",
        sidebarPrimary: "#d97757",
        sidebarPrimaryForeground: "#1f1e1d",
        // sidebar-accent = terax `accent` warm gray — used for row
        // hover/selected states inside sidebar panels (file tree, etc.)
        sidebarAccent: "#2f2d2a",
        sidebarAccentForeground: "#f5f4ee",
        sidebarBorder: "rgba(245,244,238,0.10)",
        sidebarRing: "#d97757",
    },
};
