// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The screen emulator stays in Electron land because it reuses Crest's
// renderer terminal engine.

import { AnsiParser } from "@/app/term/engine/ansi-parser";
import { Block } from "@/app/term/engine/block";
import { BlockHandler, type TerminalContext } from "@/app/term/engine/block-handler";
import type { Grid } from "@/app/term/engine/grid";
import type { Cell, CursorShape, TermMode } from "@/app/term/engine/types";
import { DefaultTermMode } from "@/app/term/engine/types";

export interface AgentPtyScreenCell {
    char: string;
}

export interface AgentPtyScreenRow {
    text: string;
    cells: AgentPtyScreenCell[];
}

export interface AgentPtyCursor {
    row: number;
    col: number;
    visible: boolean;
    shape: CursorShape;
    blink: boolean;
}

export interface AgentPtyScreenSnapshot {
    rows: AgentPtyScreenRow[];
    cursor: AgentPtyCursor;
    isAltScreenActive: boolean;
}

export interface AgentPtyScreenOptions {
    cols: number;
    rows: number;
    respond: (bytes: string) => void;
}

export class AgentPtyScreen {
    cols: number;
    rows: number;
    private block: Block;
    private parser: AnsiParser;
    private mode: TermMode = { ...DefaultTermMode };
    private encoder = new TextEncoder();

    constructor(options: AgentPtyScreenOptions) {
        this.cols = Math.max(1, options.cols);
        this.rows = Math.max(1, options.rows);
        this.block = new Block({ id: "agent-pty", seq: 0, cols: this.cols });
        this.block.startPrompt();
        this.block.endPrompt();
        this.block.startCommand();
        this.block.outputGrid.raw().resizeViewport(this.cols, this.rows);
        this.block.altScreen.resize(this.cols, this.rows);
        const context: TerminalContext = {
            respond: options.respond,
            getMode: () => this.mode,
            setMode: (patch) => {
                this.mode = { ...this.mode, ...patch };
            },
            onInlineTui: () => {
                this.block.outputGrid.raw().resizeViewport(this.cols, this.rows);
            },
        };
        this.parser = new AnsiParser(new BlockHandler(this.block, context));
    }

    feed(data: string | Uint8Array): void {
        if (!data.length) return;
        this.parser.feed(typeof data === "string" ? this.encoder.encode(data) : data);
        this.parser.flush();
        this.block.outputGrid.raw().resizeViewport(this.cols, this.rows);
        this.block.altScreen.resize(this.cols, this.rows);
    }

    resize(cols: number, rows: number): void {
        this.cols = Math.max(1, cols);
        this.rows = Math.max(1, rows);
        this.block.outputGrid.raw().resizeViewport(this.cols, this.rows);
        this.block.altScreen.resize(this.cols, this.rows);
    }

    snapshot(): AgentPtyScreenSnapshot {
        const grid = this.activeGrid();
        const cursorState = grid.cursorState;
        return {
            rows: this.rowsFromGrid(grid),
            cursor: {
                row: grid.cursor.row,
                col: grid.cursor.col,
                visible: cursorState.visible,
                shape: cursorState.shape,
                blink: cursorState.blink,
            },
            isAltScreenActive: this.block.altScreen.active,
        };
    }

    primaryRowCount(): number {
        return this.block.outputGrid.raw().rowCount();
    }

    altRowCount(): number {
        return this.block.altScreen.grid.rowCount();
    }

    private activeGrid(): Grid {
        if (this.block.altScreen.active) {
            return this.block.altScreen.grid;
        }
        return this.block.outputGrid.raw();
    }

    private rowsFromGrid(grid: Grid): AgentPtyScreenRow[] {
        const rows: AgentPtyScreenRow[] = [];
        for (let row = 0; row < this.rows; row += 1) {
            const cells = Array.from({ length: this.cols }, (_value, col) =>
                this.cellToSnapshot(grid.getCell(row, col))
            );
            rows.push({
                text: cells
                    .map((cell) => cell.char)
                    .join("")
                    .trimEnd(),
                cells,
            });
        }
        return rows;
    }

    private cellToSnapshot(cell: Cell): AgentPtyScreenCell {
        return { char: cell.char + (cell.extra?.zeroWidth ?? "") };
    }
}
