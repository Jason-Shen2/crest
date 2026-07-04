// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildCollapsedSegments, DefaultContextLines } from "./collapsed-diff";

// We can't import the internal NumberedLine type without coupling the test
// to non-exported types. Construct minimal NumberedLine objects directly —
// they share shape with the internal type so a structural cast keeps it
// isolated from refactors inside git-panel.tsx.
type FakeLine = { line: { type: string; content: string }; oldNum?: number; newNum?: number };

function ctx(content: string, oldNum?: number, newNum?: number): FakeLine {
    return { line: { type: "context", content }, oldNum, newNum };
}
function add(content: string, newNum?: number): FakeLine {
    return { line: { type: "add", content }, newNum };
}
function hunk(content: string): FakeLine {
    return { line: { type: "hunk", content } };
}
function header(content: string): FakeLine {
    return { line: { type: "header", content } };
}

const asNumbered = (rows: FakeLine[]) => rows as any;

describe("buildCollapsedSegments", () => {
    it("returns empty for empty input", () => {
        expect(buildCollapsedSegments([], DefaultContextLines, new Set())).toEqual([]);
    });

    it("emits one lines segment with no gaps when hunks overlap their context windows", () => {
        // hunk header at idx 0, then 2 add lines within context window — no gap.
        const numbered = asNumbered([
            hunk("@@ -1,3 +1,3 @@"),
            ctx("a", 1, 1),
            add("x", 2),
            ctx("b", 4, 3),
        ]);
        const segs = buildCollapsedSegments(numbered, DefaultContextLines, new Set());
        // Expect one segment: 4 lines from idx 0..3 visible (hunk + 3 ctx-or-add).
        // No hunk windows overlap a different run, so no gap.
        expect(segs.every((s) => s.kind === "lines")).toBe(true);
        expect(segs.length).toBe(1);
    });

    it("emits a gap between two distant change blocks at default context", () => {
        // Anchor at idx 0 (hunk) + 1 (add); 20 hidden context lines from
        // idx 2..21; then anchor at idx 22 (hunk) + 23 (add). With ctx=3
        // the first run covers 0..4 and the second run covers 19..23,
        // leaving a real gap at 5..18.
        const rows: FakeLine[] = [hunk("@@ -1,5 +1,5 @@"), add("a", 1)];
        for (let i = 2; i < 22; i++) rows.push(ctx(`c${i}`, i, i));
        rows.push(hunk("@@ -30,5 +30,5 @@"), add("b", 30));
        const segs = buildCollapsedSegments(asNumbered(rows), DefaultContextLines, new Set());
        const kinds = segs.map((s) => s.kind);
        expect(kinds).toEqual(["lines", "gap", "lines"]);
        const gap = segs[1];
        if (gap.kind !== "gap") throw new Error("expected gap");
        expect(gap.gapStartIdx).toBe(5);
        expect(gap.gapEndIdx).toBe(18);
        expect(gap.gapId).toBe(5);
    });

    it("expanding a gap replaces it with the previously hidden context lines", () => {
        // hunk@0, add@1, 15 ctx lines @2..16, hunk@17, add@18.
        // visibility at ctx=3: 0..4 from first anchors, 14..18 from second anchors.
        // gap = 5..13 (9 hidden ctx lines).
        const rows: FakeLine[] = [hunk("@@ -1,5 +1,5 @@"), add("a", 1)];
        for (let i = 2; i < 17; i++) rows.push(ctx(`c${i}`, i, i));
        rows.push(hunk("@@ -20,5 +20,5 @@"), add("b", 20));
        const numbered = asNumbered(rows);
        const segs0 = buildCollapsedSegments(numbered, DefaultContextLines, new Set());
        const gap = segs0.find((s) => s.kind === "gap");
        expect(gap).toBeDefined();
        if (gap?.kind !== "gap") throw new Error();
        const expanded = new Set([gap.gapId]);
        const segs1 = buildCollapsedSegments(numbered, DefaultContextLines, expanded);
        expect(segs1.every((s) => s.kind === "lines")).toBe(true);
        const flatContent = segs1
            .flatMap((s) => (s.kind === "lines" ? s.items.map((i: any) => i.line.content) : []))
            .join("|");
        // Previously hidden lines should now be visible.
        expect(flatContent).toContain("c2");
        expect(flatContent).toContain("c16");
    });

    it("does not collapse short stretches that fall within the context window", () => {
        // Add at idx 0, ctx until idx 6, then another add at idx 7. With ctx=3,
        // both add anchors see each other through the ctx — single run.
        const rows: FakeLine[] = [
            hunk("@@ -1,9 +1,9 @@"),
            ctx("a", 1, 1),
            add("X", 2),
            ctx("b", 3, 3),
            ctx("c", 4, 4),
            ctx("d", 5, 5),
            ctx("e", 6, 6),
            add("Y", 7),
        ];
        const segs = buildCollapsedSegments(asNumbered(rows), DefaultContextLines, new Set());
        expect(segs.every((s) => s.kind === "lines")).toBe(true);
    });

    it("treats hunk headers and file headers as anchors (always visible)", () => {
        const rows: FakeLine[] = [
            header("diff --git a/foo b/foo"),
            hunk("@@ -1,1 +1,1 @@"),
            add("z", 1),
        ];
        const segs = buildCollapsedSegments(asNumbered(rows), DefaultContextLines, new Set());
        expect(segs.length).toBe(1);
        expect(segs[0].kind).toBe("lines");
    });

    it("uses new-side line numbers for the gap range label on pure additions", () => {
        // Verify the gap placeholder will have new-side numbers — the caller
        // uses these to label the gap. We assert the underlying data we
        // generate here can drive a label like L15–L19.
        const rows: FakeLine[] = [hunk("@@ -1,5 +1,5 @@"), add("a", 1)];
        for (let n = 2; n < 8; n++) rows.push(ctx(`c${n}`, n, n));
        for (let n = 8; n < 22; n++) rows.push(ctx(`c${n}`, n, n));
        for (let n = 22; n < 32; n++) rows.push(ctx(`c${n}`, n, n));
        rows.push(add("z", 32));
        const segs = buildCollapsedSegments(asNumbered(rows), DefaultContextLines, new Set());
        const gap = segs.find((s) => s.kind === "gap");
        if (gap?.kind !== "gap") throw new Error();
        const first = rows[gap.gapStartIdx] as FakeLine;
        const last = rows[gap.gapEndIdx] as FakeLine;
        expect(first.newNum).toBeGreaterThan(0);
        expect(last.newNum).toBeGreaterThan(first.newNum!);
    });
});
