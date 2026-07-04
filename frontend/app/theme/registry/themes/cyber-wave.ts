// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Cyber Wave — the showcase gradient theme.  Demonstrates the partial
// inheritance pattern: only declares the fields that differ from
// default-dark (gradient bg + accent + details mode); everything else
// (ANSI palette, foreground, cmdtext) is inherited.  Note that the
// JSON-side version of cyber-wave in pkg/wconfig/defaultconfig/
// termthemes.json redeclares everything — keeping that for transport
// parity, but the TS file is the canonical view for code review.
//
// Gradient stops reference:
//   backgroundTop   #002733 → #000F14  (vertical body bg)
//   accentLeft      #007972 → #7B008F  (horizontal accent gradient)

import type { RegistryEntry } from "../types";

export const cyberWaveEntry: RegistryEntry = {
    extends: "default-dark",
    theme: {
        id: "cyber-wave",
        "display:name": "Cyber Wave",
        "display:order": 11,

        // Override only what changes — ANSI palette, foreground,
        // cmdtext all inherit from default-dark.
        foreground: "#FFFFFF",
        cmdtext: "#FFFFFF",
        cursor: "#FFFFFF",
        background: "#000000",

        // Gradient pair — wins over the solid `background` for the
        // body's --bg-gradient; --color-background still uses the top
        // stop so small widgets read as solid.
        backgroundTop: "#002733",
        backgroundBottom: "#000F14",

        accent: "#3D3C80",
        accentLeft: "#007972",
        accentRight: "#7B008F",

        details: "darker",
    },
};