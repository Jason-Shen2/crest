// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Diff + exact-text-replacement engine for the edit tool. Ported from
// pi's packages/coding-agent/src/core/tools/edit-diff.ts
// (earendil-works/pi, MIT). The render-only computeEditsDiff /
// computeEditDiff preview helpers are dropped (they only fed pi's TUI
// preview); the execute-path functions are kept verbatim.
//
// Handles: BOM preservation, CRLF/LF detection + restoration, exact
// match with a fuzzy fallback (smart quotes / dashes / unicode spaces /
// trailing whitespace), multi-edit with overlap detection, and both a
// display diff and a unified patch.

import * as Diff from "diff";

export function detectLineEnding(content: string): "\r\n" | "\n" {
    const crlfIdx = content.indexOf("\r\n");
    const lfIdx = content.indexOf("\n");
    if (lfIdx === -1) return "\n";
    if (crlfIdx === -1) return "\n";
    return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
    return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function normalizeForFuzzyMatch(text: string): string {
    return text
        .normalize("NFKC")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .replace(/[‘’‚‛]/g, "'")
        .replace(/[“”„‟]/g, '"')
        .replace(/[‐‑‒–—―−]/g, "-")
        .replace(/[  -   　]/g, " ");
}

export interface FuzzyMatchResult {
    found: boolean;
    index: number;
    matchLength: number;
    usedFuzzyMatch: boolean;
    contentForReplacement: string;
}

export interface Edit {
    oldText: string;
    newText: string;
}

interface MatchedEdit {
    editIndex: number;
    matchIndex: number;
    matchLength: number;
    newText: string;
}

export interface AppliedEditsResult {
    baseContent: string;
    newContent: string;
}

export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
    const exactIndex = content.indexOf(oldText);
    if (exactIndex !== -1) {
        return {
            found: true,
            index: exactIndex,
            matchLength: oldText.length,
            usedFuzzyMatch: false,
            contentForReplacement: content,
        };
    }

    const fuzzyContent = normalizeForFuzzyMatch(content);
    const fuzzyOldText = normalizeForFuzzyMatch(oldText);
    const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

    if (fuzzyIndex === -1) {
        return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
    }

    return {
        found: true,
        index: fuzzyIndex,
        matchLength: fuzzyOldText.length,
        usedFuzzyMatch: true,
        contentForReplacement: fuzzyContent,
    };
}

export function stripBom(content: string): { bom: string; text: string } {
    return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

function countOccurrences(content: string, oldText: string): number {
    const fuzzyContent = normalizeForFuzzyMatch(content);
    const fuzzyOldText = normalizeForFuzzyMatch(oldText);
    return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
    if (totalEdits === 1) {
        return new Error(
            `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
        );
    }
    return new Error(
        `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
    );
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
    if (totalEdits === 1) {
        return new Error(
            `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
        );
    }
    return new Error(
        `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
    );
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
    if (totalEdits === 1) return new Error(`oldText must not be empty in ${path}.`);
    return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
    if (totalEdits === 1) {
        return new Error(
            `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
        );
    }
    return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 * All edits match against the same original content; replacements are
 * applied in reverse offset order so indices stay stable. Throws on
 * not-found, ambiguous (>1 occurrence), overlapping, or no-op edits.
 */
export function applyEditsToNormalizedContent(
    normalizedContent: string,
    edits: Edit[],
    path: string,
): AppliedEditsResult {
    const normalizedEdits = edits.map((edit) => ({
        oldText: normalizeToLF(edit.oldText),
        newText: normalizeToLF(edit.newText),
    }));

    for (let i = 0; i < normalizedEdits.length; i++) {
        if (normalizedEdits[i].oldText.length === 0) {
            throw getEmptyOldTextError(path, i, normalizedEdits.length);
        }
    }

    const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
    const baseContent = initialMatches.some((match) => match.usedFuzzyMatch)
        ? normalizeForFuzzyMatch(normalizedContent)
        : normalizedContent;

    const matchedEdits: MatchedEdit[] = [];
    for (let i = 0; i < normalizedEdits.length; i++) {
        const edit = normalizedEdits[i];
        const matchResult = fuzzyFindText(baseContent, edit.oldText);
        if (!matchResult.found) throw getNotFoundError(path, i, normalizedEdits.length);

        const occurrences = countOccurrences(baseContent, edit.oldText);
        if (occurrences > 1) throw getDuplicateError(path, i, normalizedEdits.length, occurrences);

        matchedEdits.push({
            editIndex: i,
            matchIndex: matchResult.index,
            matchLength: matchResult.matchLength,
            newText: edit.newText,
        });
    }

    matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
    for (let i = 1; i < matchedEdits.length; i++) {
        const previous = matchedEdits[i - 1];
        const current = matchedEdits[i];
        if (previous.matchIndex + previous.matchLength > current.matchIndex) {
            throw new Error(
                `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
            );
        }
    }

    let newContent = baseContent;
    for (let i = matchedEdits.length - 1; i >= 0; i--) {
        const edit = matchedEdits[i];
        newContent =
            newContent.substring(0, edit.matchIndex) +
            edit.newText +
            newContent.substring(edit.matchIndex + edit.matchLength);
    }

    if (baseContent === newContent) throw getNoChangeError(path, normalizedEdits.length);

    return { baseContent, newContent };
}

export function generateUnifiedPatch(
    path: string,
    oldContent: string,
    newContent: string,
    contextLines = 4,
): string {
    return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
        context: contextLines,
        headerOptions: Diff.FILE_HEADERS_ONLY,
    });
}

/**
 * Display-oriented diff with line numbers + limited context. Returns
 * the diff string and the first changed line number in the new file.
 */
export function generateDiffString(
    oldContent: string,
    newContent: string,
    contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
    const parts = Diff.diffLines(oldContent, newContent);
    const output: string[] = [];

    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const maxLineNum = Math.max(oldLines.length, newLines.length);
    const lineNumWidth = String(maxLineNum).length;

    let oldLineNum = 1;
    let newLineNum = 1;
    let lastWasChange = false;
    let firstChangedLine: number | undefined;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const raw = part.value.split("\n");
        if (raw[raw.length - 1] === "") raw.pop();

        if (part.added || part.removed) {
            if (firstChangedLine === undefined) firstChangedLine = newLineNum;

            for (const line of raw) {
                if (part.added) {
                    const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
                    output.push(`+${lineNum} ${line}`);
                    newLineNum++;
                } else {
                    const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                    output.push(`-${lineNum} ${line}`);
                    oldLineNum++;
                }
            }
            lastWasChange = true;
        } else {
            const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
            const hasLeadingChange = lastWasChange;
            const hasTrailingChange = nextPartIsChange;

            if (hasLeadingChange && hasTrailingChange) {
                if (raw.length <= contextLines * 2) {
                    for (const line of raw) {
                        const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                        output.push(` ${lineNum} ${line}`);
                        oldLineNum++;
                        newLineNum++;
                    }
                } else {
                    const leadingLines = raw.slice(0, contextLines);
                    const trailingLines = raw.slice(raw.length - contextLines);
                    const skippedLines = raw.length - leadingLines.length - trailingLines.length;

                    for (const line of leadingLines) {
                        const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                        output.push(` ${lineNum} ${line}`);
                        oldLineNum++;
                        newLineNum++;
                    }
                    output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
                    oldLineNum += skippedLines;
                    newLineNum += skippedLines;
                    for (const line of trailingLines) {
                        const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                        output.push(` ${lineNum} ${line}`);
                        oldLineNum++;
                        newLineNum++;
                    }
                }
            } else if (hasLeadingChange) {
                const shownLines = raw.slice(0, contextLines);
                const skippedLines = raw.length - shownLines.length;
                for (const line of shownLines) {
                    const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                    output.push(` ${lineNum} ${line}`);
                    oldLineNum++;
                    newLineNum++;
                }
                if (skippedLines > 0) {
                    output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
                    oldLineNum += skippedLines;
                    newLineNum += skippedLines;
                }
            } else if (hasTrailingChange) {
                const skippedLines = Math.max(0, raw.length - contextLines);
                if (skippedLines > 0) {
                    output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
                    oldLineNum += skippedLines;
                    newLineNum += skippedLines;
                }
                for (const line of raw.slice(skippedLines)) {
                    const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                    output.push(` ${lineNum} ${line}`);
                    oldLineNum++;
                    newLineNum++;
                }
            } else {
                oldLineNum += raw.length;
                newLineNum += raw.length;
            }
            lastWasChange = false;
        }
    }

    return { diff: output.join("\n"), firstChangedLine };
}
