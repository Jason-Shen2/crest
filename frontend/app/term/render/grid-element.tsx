// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// GridElement — renders a Grid (or BlockGrid) as DOM rows.  Each row is a
// `<div>` containing CellRun children.  We merge contiguous same-style cells
// into one CellRun so a typical 80-cell row collapses to 1-5 spans.
//
// React reconciliation is doing the heavy lifting here.  When the engine
// mutates a row, we re-render that row's DOM subtree; React diffs the spans
// and only touches what changed.  At 60fps with a single dirty row that's
// well within budget — a streaming `tail -f` updates one row per frame.

import { cn } from "@/util/util";
import { memo } from "react";
import { BlockGrid } from "../engine/block-grid";
import { Grid } from "../engine/grid";
import { Cell, CellStyle, stylesEqual } from "../engine/types";
import { CellRun } from "./cell-run";

export interface GridElementProps {
    // Accept either a raw Grid or a BlockGrid.  Most callers will pass a
    // BlockGrid (it carries filter + finished state); ad-hoc embeds (e.g.
    // alt-screen surface) get the raw Grid.
    source: Grid | BlockGrid;
    // Revision counter from the model — bump triggers re-render.  Without
    // this, React has no way to know the (mutable) grid changed.
    revision: number;
    className?: string;
    // fontSize in px.  Drives row height (1.4× ratio).  Defaults to 16.
    fontSize?: number;
    // OSC 8 link-click callback.  Threaded down to CellRun where each <a>
    // wraps its `onClick` around it.  Optional — when omitted, links are
    // rendered but clicks are no-ops.
    onLinkClick?: (uri: string) => void;
    // Optional override of which rows to render.  When set, replaces the
    // default "all visible rows from source" computation.  Caller is
    // responsible for the contents — out-of-range indices render as
    // empty rows, duplicates render twice, ordering is preserved.
    visibleRowIndicesOverride?: number[];
}

export const GridElement = memo(
    ({
        source,
        revision: _revision,
        className,
        fontSize = 16,
        onLinkClick,
        visibleRowIndicesOverride,
    }: GridElementProps) => {
        // Pick the right view of the underlying rows.
        const grid: Grid = source instanceof BlockGrid ? source.raw() : source;
        const visibleRowIndices: number[] =
            visibleRowIndicesOverride ??
            (source instanceof BlockGrid
                ? source.visibleRowIndices()
                : Array.from({ length: grid.rowCount() }, (_, i) => i));

        const lineHeight = Math.round(fontSize * 1.4);

        return (
            <div
                className={cn("font-mono leading-none", className)}
                style={{ fontSize: `${fontSize}px`, lineHeight: `${lineHeight}px` }}
            >
                {visibleRowIndices.map((rowIdx) => (
                    <RowLine
                        key={rowIdx}
                        cells={grid.getRow(rowIdx)}
                        rowVersion={grid.getRowVersion(rowIdx)}
                        height={lineHeight}
                        grid={grid}
                        onLinkClick={onLinkClick}
                    />
                ))}
            </div>
        );
    }
);
GridElement.displayName = "GridElement";

// RowLine — one logical row.  Splits cells into runs of identical style and
// emits a CellRun per run.  Trailing blanks after the last visible cell are
// dropped to avoid a sea of zero-width spans (the parent's line-height
// already gives the row its physical height).
const RowLine = memo(
    ({
        cells,
        rowVersion: _rowVersion,
        height,
        grid,
        onLinkClick,
    }: {
        cells: readonly Cell[];
        // Per-row version counter — included in the React.memo prop set so
        // a re-render fires when the underlying array is mutated in place
        // (cells reference unchanged, contents updated).
        rowVersion: number;
        height: number;
        grid: Grid;
        onLinkClick?: (uri: string) => void;
    }) => {
        const runs = computeRuns(cells);
        return (
            <div className="flex whitespace-pre" style={{ height: `${height}px`, minHeight: `${height}px` }}>
                {runs.length === 0 ? (
                    <span>&nbsp;</span>
                ) : (
                    runs.map((run, i) => {
                        // Resolve linkUri for OSC 8 runs.  Lookup is O(1) on
                        // the link table; cells in the same run share linkId.
                        const linkId = run.style.linkId;
                        const linkUri = linkId !== 0 ? grid.getLink(linkId)?.uri : undefined;
                        return (
                            <CellRun
                                key={i}
                                cells={run.cells}
                                style={run.style}
                                linkUri={linkUri}
                                onLinkClick={onLinkClick}
                            />
                        );
                    })
                )}
            </div>
        );
    }
);
RowLine.displayName = "RowLine";

interface Run {
    cells: Cell[];
    style: CellStyle;
}

// computeRuns — coalesce contiguous cells that share a style.  The engine
// re-uses CellStyle references when SGR doesn't change, so the cheap
// reference-equality (`===`) check catches the common case; the deep
// fallback (`stylesEqual`) is for the case where the SGR sequence emitted
// the same attribute set as the previous run but the parser allocated a
// fresh style object.
function computeRuns(cells: readonly Cell[]): Run[] {
    const runs: Run[] = [];
    let current: Run | null = null;
    let trailingBlankStart = -1;
    for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        // Track where the trailing blanks would start.  If this cell is
        // non-blank, reset the tracker.
        if (cell.char === "" && !cell.extra?.secret) {
            if (trailingBlankStart === -1) trailingBlankStart = i;
        } else {
            trailingBlankStart = -1;
        }
        if (current && (current.style === cell.style || stylesEqual(current.style, cell.style))) {
            current.cells.push(cell);
        } else {
            current = { cells: [cell], style: cell.style };
            runs.push(current);
        }
    }
    // Trim trailing all-blank runs at the right edge.  Visually invisible
    // and keeping them just bloats the DOM.
    if (trailingBlankStart >= 0) {
        while (runs.length > 0) {
            const last = runs[runs.length - 1];
            const allBlank = last.cells.every(
                (c) => c.char === "" && !c.extra?.secret && c.style.bg.kind === "default"
            );
            if (!allBlank) break;
            runs.pop();
        }
    }
    return runs;
}
