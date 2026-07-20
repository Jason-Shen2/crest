// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Component } from "../../src/tui";
import type { DiffHunk, WidgetDiffViewNode } from "../widget-tree";

export interface DiffViewOptions {
    filename?: string;
    hunks: DiffHunk[];
}

export class DiffView implements Component {
    readonly widgetKind = "diffview";
    readonly filename: string | undefined;
    readonly hunks: DiffHunk[];

    constructor(options: DiffViewOptions) {
        this.filename = options.filename;
        this.hunks = options.hunks;
    }

    toWidget(id: string): WidgetDiffViewNode {
        return {
            kind: "diffview",
            id,
            filename: this.filename,
            hunks: this.hunks,
        };
    }

    render(width: number): string[] {
        const lines: string[] = [];
        if (this.filename) lines.push(`diff -- ${this.filename}`);
        for (const hunk of this.hunks) {
            lines.push(hunk.header);
            for (const line of hunk.lines) {
                lines.push(line.text);
            }
        }
        return lines.map((line) => line.slice(0, width));
    }

    invalidate(): void {}
}
