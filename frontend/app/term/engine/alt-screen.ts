// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AltScreen — the alternate-screen buffer for TUI apps (vim, htop, less).
// Mirrors warp's `terminal/model/alt_screen.rs`.
//
// Behavior we replicate from warp:
//
// * When the shell emits CSI ?1049h (enter alt-screen), bytes route to this
//   grid instead of the block's output_grid.  Selection state is independent.
// * When CSI ?1049l fires (exit alt-screen), the alt-screen contents *stay
//   on the block* — you can scroll up and see vim's last frame above the
//   command's regular output.  That's deliberate: warp considers the alt
//   buffer part of the block's history.
// * The alt-screen is a *fixed-size viewport* (rows × cols).  TUIs assume a
//   stable geometry — resizing should send SIGWINCH up the PTY, not silently
//   shrink the buffer.

import { Grid } from "./grid";
import { DefaultStyle } from "./types";

const DefaultAltScreenRows = 30;

export class AltScreen {
    grid: Grid;
    // Active = currently the receiving target for parser writes.  A block
    // can have an inactive AltScreen (TUI exited, but we kept the last
    // frame for scrollback history).
    active = false;
    // wasActive — sticky flag tracking whether this alt-screen has ever
    // been entered.  The renderer reads it to decide whether to surface
    // the last-frame above the output grid after exit.  Never reset.
    wasActive = false;
    // rows — the fixed height the TUI thinks it has.  Drives SIGWINCH
    // reporting and any "where does the cursor land on enter?" logic.
    rows: number;

    constructor(cols: number, rows: number = DefaultAltScreenRows) {
        this.grid = new Grid(cols);
        this.rows = rows;
        this.grid.resizeViewport(cols, rows);
    }

    // enter — switch to alt-screen mode.  `clear` controls whether the
    // alt buffer is wiped on entry: 1049 / 1047 do; 47 does not (rare
    // legacy mode that some older TUIs use to "resume" their last
    // alt-screen state across re-entries).
    enter(clear: boolean = true): void {
        if (this.active) return;
        this.active = true;
        this.wasActive = true;
        if (clear) {
            this.grid.eraseInDisplay(2);
            this.grid.cursorTo(0, 0);
            this.grid.setStyle(DefaultStyle);
            this.grid.resizeViewport(this.grid.cols, this.rows);
        }
        this.grid.markAllDirty();
    }

    exit(): void {
        if (!this.active) return;
        this.active = false;
        // Don't clear — warp keeps the last-frame on the block for scroll-back
        // history.  The renderer decides whether to render it (typically
        // shown above the command's output_grid).
        this.grid.resetScrollRegion();
    }

    // resize — when the terminal pane changes size, the TUI needs a new
    // geometry.  warp re-allocates internally and re-marks all rows dirty.
    // For our purposes the data structure is sparse, so we just update the
    // cols on the grid and the row count here; the renderer recomputes
    // layout naturally.
    resize(cols: number, rows: number): void {
        this.rows = rows;
        this.grid.resizeViewport(cols, rows);
        this.grid.markAllDirty();
    }
}
