// Copyright 2026, Crest contributors. SPDX-License-Identifier: Apache-2.0
//
// ToolDiffCard — unified diff preview for tools that mutate files
// (write_text_file, multi_edit).  Structure derived from warp:
//   app/src/ai/blocklist/inline_action/code_diff_view.rs
// Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
//
// Renders a hunked unified diff between `originalcontent` and
// `modifiedcontent` using jsdiff's `diffLines`.  Diff lines render green
// (added) / red (removed) / muted (context).  3-line context window
// around each change block to match warp's default.

import { cn } from "@/util/util";
import { diffLines, structuredPatch } from "diff";
import { memo, useMemo } from "react";

const CONTEXT_LINES = 3;
const MAX_RENDER_LINES = 400;  // safety cap on extremely large diffs

interface ToolDiffCardProps {
    original: string;
    modified: string;
    filename?: string;
}

interface DiffLine {
    type: "add" | "remove" | "context" | "hunk-header";
    text: string;
    oldNo?: number;
    newNo?: number;
}

export const ToolDiffCard = memo(({ original, modified, filename }: ToolDiffCardProps) => {
    const lines = useMemo(() => buildDiffLines(original, modified), [original, modified]);
    if (lines.length === 0) {
        return (
            <div className="mt-2 rounded border border-fg-overlay-2 bg-background/60 px-2 py-1.5 font-mono text-[11px] text-secondary/65">
                No changes.
            </div>
        );
    }
    const truncated = lines.length > MAX_RENDER_LINES;
    const shown = truncated ? lines.slice(0, MAX_RENDER_LINES) : lines;
    return (
        <div className="mt-2 overflow-hidden rounded border border-fg-overlay-2 bg-background/70">
            {filename && (
                <div className="border-b border-fg-overlay-2/70 bg-fg-overlay-1/40 px-2 py-1 font-mono text-[11px] text-foreground/80">
                    {filename}
                </div>
            )}
            <div className="overflow-x-auto py-0.5 font-mono text-[11px] leading-[1.45]">
                {shown.map((l, idx) => (
                    <DiffRow key={idx} line={l} />
                ))}
                {truncated && (
                    <div className="px-2 py-1 text-secondary/65">
                        … ({lines.length - MAX_RENDER_LINES} more lines)
                    </div>
                )}
            </div>
        </div>
    );
});
ToolDiffCard.displayName = "ToolDiffCard";

const DiffRow = memo(({ line }: { line: DiffLine }) => {
    if (line.type === "hunk-header") {
        return (
            <div className="bg-fg-overlay-2/40 px-2 py-0.5 text-[var(--ansi-cyan)]">
                {line.text}
            </div>
        );
    }
    const accent =
        line.type === "add"
            ? "bg-[var(--ansi-green)]/12 text-[var(--ansi-green)]"
            : line.type === "remove"
                ? "bg-[var(--ansi-red)]/12 text-[var(--ansi-red)]"
                : "text-foreground/80";
    const sigil = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
    return (
        <div className={cn("flex px-2", accent)}>
            <span className="w-9 shrink-0 select-none text-right text-secondary/55">
                {line.oldNo ?? ""}
            </span>
            <span className="w-9 shrink-0 select-none text-right text-secondary/55">
                {line.newNo ?? ""}
            </span>
            <span className="mx-2 w-3 shrink-0 select-none">{sigil}</span>
            <span className="whitespace-pre">{line.text}</span>
        </div>
    );
});
DiffRow.displayName = "DiffRow";

// buildDiffLines — produce a flat list of hunked diff rows.  We use jsdiff's
// `structuredPatch` for hunk grouping (handles context-around-change for
// us) and then unfold each hunk's lines into our DiffLine[] shape.  Falls
// back to a single big hunk via `diffLines` when structuredPatch produces
// nothing useful (e.g. brand-new file).
function buildDiffLines(original: string, modified: string): DiffLine[] {
    // Brand-new file (no original) — show every modified line as additions
    // without a hunk header.
    if (!original && modified) {
        return modified.split("\n").map((text, i) => ({
            type: "add" as const,
            text,
            newNo: i + 1,
        }));
    }
    // File deletion (no modified) — show every original line as removals.
    if (original && !modified) {
        return original.split("\n").map((text, i) => ({
            type: "remove" as const,
            text,
            oldNo: i + 1,
        }));
    }
    if (!original && !modified) return [];
    const patch = structuredPatch("a", "b", original, modified, "", "", {
        context: CONTEXT_LINES,
    });
    if (!patch || patch.hunks.length === 0) {
        // No structural diff — try line-by-line; if still nothing, render
        // empty.  (Identical files fall through here.)
        const changes = diffLines(original, modified);
        if (changes.every((c) => !c.added && !c.removed)) return [];
        const out: DiffLine[] = [];
        for (const c of changes) {
            const lines = c.value.split("\n");
            // diffLines includes a trailing empty when value ends with \n
            if (lines[lines.length - 1] === "") lines.pop();
            for (const text of lines) {
                out.push({
                    type: c.added ? "add" : c.removed ? "remove" : "context",
                    text,
                });
            }
        }
        return out;
    }
    const out: DiffLine[] = [];
    for (const hunk of patch.hunks) {
        out.push({
            type: "hunk-header",
            text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        });
        let oldNo = hunk.oldStart;
        let newNo = hunk.newStart;
        for (const raw of hunk.lines) {
            const marker = raw[0];
            const text = raw.slice(1);
            if (marker === "+") {
                out.push({ type: "add", text, newNo });
                newNo++;
            } else if (marker === "-") {
                out.push({ type: "remove", text, oldNo });
                oldNo++;
            } else if (marker === "\\") {
                // "\ No newline at end of file" — drop; visually noisy.
                continue;
            } else {
                out.push({ type: "context", text, oldNo, newNo });
                oldNo++;
                newNo++;
            }
        }
    }
    return out;
}
