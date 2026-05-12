// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// CursorOverlay — absolute-positioned indicator showing where the
// terminal cursor sits within a grid.  Rendered for the running block
// and for alt-screen TUIs; done blocks don't carry a cursor.  Shape is
// driven by Grid.cursorState (DECSCUSR / DECTCEM): block / underline /
// bar, with or without blink.

import { Grid } from "../engine/grid";
import { usePaletteOverrides } from "./palette-context";

export interface CursorOverlayProps {
    grid: Grid;
    charWidth: number;
    lineHeight: number;
    visible?: boolean;
    // Revision tick from the model — re-renders the overlay on cursor
    // movement, since the cursor lives inside a mutable Grid object.
    revision?: number;
}

export function CursorOverlay({
    grid,
    charWidth,
    lineHeight,
    visible = true,
    revision: _revision,
}: CursorOverlayProps) {
    const overrides = usePaletteOverrides();
    if (!visible) return null;
    if (!grid.cursorState.visible) return null;

    // Snap to pixel boundaries the same way SelectionLayer /
    // FindHighlightLayer do — floating-point edges can leave a 1px
    // strip uncovered when the cell's glyph extends past the rect.
    const cellLeft = Math.floor(grid.cursor.col * charWidth);
    const cellRight = Math.ceil((grid.cursor.col + 1) * charWidth);
    const top = grid.cursor.row * lineHeight;
    const shape = grid.cursorState.shape;
    const blink = grid.cursorState.blink;

    let height: number;
    let width: number;
    let topPx: number;
    switch (shape) {
        case "underline":
            height = 2;
            width = cellRight - cellLeft;
            topPx = top + lineHeight - height;
            break;
        case "bar":
            height = lineHeight;
            width = 2;
            topPx = top;
            break;
        case "block":
        default:
            height = lineHeight;
            width = cellRight - cellLeft;
            topPx = top;
            break;
    }
    const left = cellLeft;

    const style: React.CSSProperties = {
        position: "absolute",
        left: `${left}px`,
        top: `${topPx}px`,
        width: `${width}px`,
        height: `${height}px`,
        background: overrides.cursorColor ?? "currentColor",
        opacity: shape === "block" ? 0.5 : 0.85,
        pointerEvents: "none",
    };
    return <div className={blink ? "animate-pulse" : ""} style={style} />;
}
