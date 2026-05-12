// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// HeaderGrid — the prompt + command row of a Block.  Mirrors warp's
// `terminal/model/header_grid.rs`.
//
// Why a dedicated structure (not just a BlockGrid)?
//
// warp keeps *two* grids here:
//   - `promptGrid`              — the PS1 alone, for the "Edit Prompt" modal
//                                 which renders the prompt without re-running
//                                 the shell.
//   - `promptAndCommandGrid`    — the prompt followed by the typed command,
//                                 the one actually rendered above the output.
//
// The same prompt bytes feed both grids while we're in receivingChars="prompt"
// mode; once OSC 133;B (end-of-prompt) fires we flip to
// receivingChars="prompt-and-command", and only the second grid keeps
// receiving bytes.  CellExtra flags (promptStart / promptEnd / commandStart /
// commandEnd) mark the demarcation in the second grid so we can later scan
// out the command text without re-parsing.

import { BlockGrid } from "./block-grid";
import { CellExtra } from "./types";

export type HeaderReceivingMode = "prompt" | "prompt-and-command";

export class HeaderGrid {
    readonly promptGrid: BlockGrid;
    readonly promptAndCommandGrid: BlockGrid;

    // Which grid(s) the parser feeds.  See the file comment.
    private receiving: HeaderReceivingMode = "prompt";

    // Cached command text — derived from the promptAndCommandGrid by scanning
    // between the commandStart and commandEnd markers.  Populated on
    // finish(); cleared on any new write before finish.
    private _commandText: string | null = null;

    constructor(cols: number) {
        this.promptGrid = new BlockGrid(cols);
        this.promptAndCommandGrid = new BlockGrid(cols);
    }

    // ---------- mode ----------

    getReceivingMode(): HeaderReceivingMode {
        return this.receiving;
    }

    setReceivingMode(mode: HeaderReceivingMode): void {
        this.receiving = mode;
    }

    // ---------- OSC 133 anchors ----------

    // OSC 133;A — start of prompt.  Plants a `promptStart` marker on the
    // cursor cell of both grids (the prompt bytes are about to land).
    onStartPrompt(): void {
        this.start();
        const extra: CellExtra = { promptStart: true };
        this.promptGrid.raw().markCursorCellExtra(extra);
        this.promptAndCommandGrid.raw().markCursorCellExtra(extra);
    }

    // OSC 133;B — end of prompt / start of user-input region.  Plants
    // `promptEnd` on promptAndCommandGrid only (the standalone promptGrid
    // stops receiving here, so it doesn't need the marker).  Flips mode.
    onEndPrompt(): void {
        this.promptAndCommandGrid.raw().markCursorCellExtra({ promptEnd: true });
        this.receiving = "prompt-and-command";
    }

    // OSC 133;C — start of command execution.  Plants `commandStart` at the
    // current cursor in promptAndCommandGrid.  This is where the user's
    // typed text will be (it was already echoed by the shell between B and
    // C).  Many shells fire C exactly at the same position as B; that's fine.
    onStartCommand(): void {
        this.promptAndCommandGrid.raw().markCursorCellExtra({ commandStart: true });
    }

    // Mark the end of the command region.  Called when execution begins (so
    // the next output byte belongs to the *output_grid*, not the header).
    // The command text becomes the substring between commandStart and here.
    onEndCommand(): void {
        this.promptAndCommandGrid.raw().markCursorCellExtra({ commandEnd: true });
        // Force re-scan on next commandText() call.
        this._commandText = null;
    }

    // ---------- lifecycle ----------

    private start(): void {
        this.promptGrid.start();
        this.promptAndCommandGrid.start();
    }

    finish(): void {
        this.promptGrid.finish();
        this.promptAndCommandGrid.finish();
    }

    // ---------- queries ----------

    // commandText — extracts the typed command from promptAndCommandGrid by
    // scanning between commandStart and commandEnd markers (or end of grid
    // if commandEnd hasn't fired).  Caches once the surrounding block is
    // finished.
    commandText(): string {
        if (this._commandText != null) return this._commandText;
        const grid = this.promptAndCommandGrid.raw();
        let inCommand = false;
        let out = "";
        for (let r = 0; r < grid.rowCount(); r++) {
            const row = grid.getRow(r);
            // Track whether we've already started accumulating in this row.
            // Newlines between rows become \n in the output.
            if (inCommand && r > 0) out += "\n";
            for (let c = 0; c < row.length; c++) {
                const cell = row[c];
                if (cell.extra?.commandStart) inCommand = true;
                if (cell.extra?.commandEnd) {
                    if (this.promptAndCommandGrid.isFinished()) this._commandText = out;
                    return out;
                }
                if (inCommand && cell.char) out += cell.char;
            }
        }
        if (this.promptAndCommandGrid.isFinished()) this._commandText = out;
        return out;
    }

    // promptText — symmetric helper, scans from promptStart to promptEnd in
    // the promptAndCommandGrid (or, if those markers aren't both set, falls
    // back to "everything before commandStart").
    promptText(): string {
        const grid = this.promptAndCommandGrid.raw();
        let inPrompt = false;
        let sawStart = false;
        let out = "";
        for (let r = 0; r < grid.rowCount(); r++) {
            const row = grid.getRow(r);
            if (inPrompt && r > 0) out += "\n";
            for (let c = 0; c < row.length; c++) {
                const cell = row[c];
                if (cell.extra?.promptStart) {
                    inPrompt = true;
                    sawStart = true;
                }
                if (cell.extra?.promptEnd) return out;
                if (cell.extra?.commandStart && !sawStart) return out;
                if (inPrompt && cell.char) out += cell.char;
            }
        }
        return out;
    }

    rowCount(): number {
        return this.promptAndCommandGrid.rowCount();
    }
}
