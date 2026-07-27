// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The screen emulator stays in Electron land because it reuses Crest's
// renderer terminal engine.

import { Terminal, type IBuffer, type IBufferCell } from "@xterm/xterm";

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
    shape: string;
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

interface SynchronousTerminalCore {
    writeSync(data: string | Uint8Array): void;
    coreService: {
        isCursorHidden: boolean;
    };
}

export class AgentPtyScreen {
    cols: number;
    rows: number;
    terminal: Terminal;
    core: SynchronousTerminalCore;
    encoder = new TextEncoder();

    constructor(options: AgentPtyScreenOptions) {
        this.cols = Math.max(1, options.cols);
        this.rows = Math.max(1, options.rows);
        this.terminal = new Terminal({
            cols: this.cols,
            rows: this.rows,
            scrollback: 0,
            allowProposedApi: false,
            logLevel: "off",
        });
        this.core = (this.terminal as unknown as { _core: SynchronousTerminalCore })._core;
        this.terminal.onData(options.respond);
    }

    feed(data: string | Uint8Array): void {
        if (!data.length) return;
        const bytes = typeof data === "string" ? this.encoder.encode(data) : data;
        let wasAltScreenActive = this.terminal.buffer.active.type === "alternate";
        for (const byte of bytes) {
            this.core.writeSync(Uint8Array.of(byte));
            const isAltScreenActive = this.terminal.buffer.active.type === "alternate";
            if (!wasAltScreenActive && isAltScreenActive) {
                this.core.writeSync("\x1b[H\x1b[2J");
            }
            wasAltScreenActive = isAltScreenActive;
        }
    }

    resize(cols: number, rows: number): void {
        this.cols = Math.max(1, cols);
        this.rows = Math.max(1, rows);
        this.terminal.resize(this.cols, this.rows);
    }

    snapshot(): AgentPtyScreenSnapshot {
        const buffer = this.terminal.buffer.active;
        return {
            rows: this.rowsFromBuffer(buffer),
            cursor: {
                row: buffer.cursorY,
                col: buffer.cursorX,
                visible: !this.core.coreService.isCursorHidden,
                shape: this.terminal.options.cursorStyle ?? "block",
                blink: this.terminal.options.cursorBlink ?? false,
            },
            isAltScreenActive: buffer.type === "alternate",
        };
    }

    primaryRowCount(): number {
        return this.terminal.buffer.normal.length;
    }

    altRowCount(): number {
        return Math.max(this.rows, this.terminal.buffer.alternate.length);
    }

    rowsFromBuffer(buffer: IBuffer): AgentPtyScreenRow[] {
        const rows: AgentPtyScreenRow[] = [];
        for (let row = 0; row < this.rows; row += 1) {
            const line = buffer.getLine(buffer.viewportY + row);
            const reusableCell = buffer.getNullCell();
            const cells = Array.from({ length: this.cols }, (_value, col) =>
                this.cellToSnapshot(line?.getCell(col, reusableCell))
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

    cellToSnapshot(cell?: IBufferCell): AgentPtyScreenCell {
        return { char: cell?.getChars() ?? "" };
    }
}
