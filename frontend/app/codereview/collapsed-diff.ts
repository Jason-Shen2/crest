// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure helpers for collapsing unchanged regions in a diff. Kept in their
// own module so they're testable without the React / window-bound imports
// that git-panel.tsx pulls in.

export type NumberedLine = { line: { type: string; content: string }; oldNum?: number; newNum?: number };

// Default context lines around each change block. Anything further than
// `DefaultContextLines` away from a change is collapsed into a gap.
export const DefaultContextLines = 3;

export type CollapsedSegment =
    | { kind: "lines"; startIdx: number; items: NumberedLine[] }
    | { kind: "gap"; gapId: number; gapStartIdx: number; gapEndIdx: number };

// Build the visible-run / gap sequence. `expandedGapIds` is the set of gap
// identifiers the user has clicked — each click fully expands that gap so
// all the hidden context lines appear in-line. Gap IDs are positional
// (start index of the gap in `numbered`) and stable across re-renders as
// long as the underlying `numbered` array doesn't change.
export function buildCollapsedSegments(
    numbered: NumberedLine[],
    contextLines: number,
    expandedGapIds: ReadonlySet<number>
): CollapsedSegment[] {
    const n = numbered.length;
    if (n === 0) return [];

    const isAnchor = (i: number) => {
        const t = numbered[i].line.type;
        return t === "add" || t === "remove" || t === "hunk" || t === "header";
    };

    // Default visibility window: every anchor plus `contextLines` of context
    // on each side. Anchors (hunk headers + add/remove) are always visible;
    // context lines are visible only within the window.
    const visible = new Array<boolean>(n).fill(false);
    for (let i = 0; i < n; i++) {
        if (!isAnchor(i)) continue;
        const lo = Math.max(0, i - contextLines);
        const hi = Math.min(n - 1, i + contextLines);
        for (let k = lo; k <= hi; k++) {
            if (numbered[k].line.type === "context") visible[k] = true;
        }
        visible[i] = true;
    }

    // Coalesce visible items into runs. Each gap between consecutive runs
    // becomes a CollapsedSegment.gap (or is uncollapsing if the user has
    // expanded it).
    const out: CollapsedSegment[] = [];
    let i = 0;
    while (i < n) {
        if (!visible[i]) {
            // Defensive: anchors are always visible, so a hidden line should
            // only appear inside a gap. Gaps are emitted between runs.
            i++;
            continue;
        }
        let j = i;
        while (j < n && visible[j]) j++;
        // [i, j) is a visible run.
        if (out.length > 0) {
            const prev = out[out.length - 1];
            if (prev.kind === "lines") {
                const lastIdx = prev.startIdx + prev.items.length - 1;
                const gapStartIdx = lastIdx + 1;
                const gapEndIdx = i - 1;
                if (gapEndIdx >= gapStartIdx) {
                    out.push({ kind: "gap", gapId: gapStartIdx, gapStartIdx, gapEndIdx });
                }
            }
        }
        out.push({ kind: "lines", startIdx: i, items: numbered.slice(i, j) });
        i = j;
    }

    // Apply user expansion: any gap whose id is in expandedGapIds is removed
    // and replaced with a "lines" segment containing the previously hidden
    // context lines.
    if (expandedGapIds.size === 0) return out;
    const expanded: CollapsedSegment[] = [];
    for (const seg of out) {
        if (seg.kind === "gap" && expandedGapIds.has(seg.gapId)) {
            if (seg.gapEndIdx >= seg.gapStartIdx) {
                expanded.push({
                    kind: "lines",
                    startIdx: seg.gapStartIdx,
                    items: numbered.slice(seg.gapStartIdx, seg.gapEndIdx + 1),
                });
            }
            // else: empty gap, drop it (shouldn't normally happen).
        } else {
            expanded.push(seg);
        }
    }
    return expanded;
}
