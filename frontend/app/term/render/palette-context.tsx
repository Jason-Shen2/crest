// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// PaletteContext — terminal-wide color overrides set via OSC 4 (palette
// index), OSC 10 (default foreground), OSC 11 (default background),
// OSC 12 (cursor color).  CellRun consumes via useContext and passes
// the overrides to resolveColor; the engine stays agnostic.
//
// Overrides are reset by OSC 104 / 110 / 111 / 112 (or by ESC c full
// reset).  Most users / apps never touch this; the context defaults to
// empty so the renderer falls through to the theme.

import { createContext, useContext } from "react";

export interface PaletteOverrides {
    // Palette index N → CSS color string.  N is 0..255.
    palette: Record<number, string>;
    // Default fg / bg overrides for `Color.kind === "default"` runs.
    defaultFg?: string;
    defaultBg?: string;
    // Cursor color override (read by CursorOverlay).
    cursorColor?: string;
}

const EmptyPalette: PaletteOverrides = { palette: {} };

export const PaletteContext = createContext<PaletteOverrides>(EmptyPalette);

export function usePaletteOverrides(): PaletteOverrides {
    return useContext(PaletteContext);
}
