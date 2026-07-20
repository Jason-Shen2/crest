// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Component } from "../../src/tui";
import type { RichTableColumn, RichTableRow, WidgetRichTableNode } from "../widget-tree";

export interface RichTableOptions {
    columns: RichTableColumn[];
    rows: RichTableRow[];
    selectedrow?: number;
}

export class RichTable implements Component {
    readonly widgetKind = "richtable";
    readonly columns: RichTableColumn[];
    readonly rows: RichTableRow[];
    readonly selectedrow: number | undefined;

    constructor(options: RichTableOptions) {
        this.columns = options.columns;
        this.rows = options.rows;
        this.selectedrow = options.selectedrow;
    }

    toWidget(id: string): WidgetRichTableNode {
        return {
            kind: "richtable",
            id,
            columns: this.columns,
            rows: this.rows,
            selectedrow: this.selectedrow,
        };
    }

    render(width: number): string[] {
        if (this.columns.length === 0) return [];
        const labels = this.columns.map((column) => column.label);
        const values = this.rows.map((row) => this.columns.map((column) => String(row[column.key] ?? "")));
        const widths = this.columns.map((column, index) => {
            const cells = values.map((row) => row[index] ?? "");
            return Math.max(column.label.length, ...cells.map((cell) => cell.length), 3);
        });
        const format = (cells: string[]): string =>
            cells
                .map((cell, index) => cell.padEnd(widths[index]))
                .join("  ")
                .slice(0, width);

        return [format(labels), format(widths.map((size) => "-".repeat(size))), ...values.map(format)];
    }

    invalidate(): void {}
}
