// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// grep — search file contents for a pattern. Schema + output shape ported
// from pi's packages/coding-agent/src/core/tools/grep.ts (earendil-works
// /pi, MIT) with the pi-tui render layer stripped. pi shells out to
// ripgrep (downloading the binary if missing); crest implements the
// search in pure Node (enumerate via ./_search, then regex-scan each
// file) — no binary download. Output mimics ripgrep: `path:line:match`
// for matches, `path:line-context` for context lines, `--` between
// non-contiguous blocks.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { type Static, Type } from "typebox";

import type { AgentTool } from "../types";
import { pathExists, resolveToCwd } from "./_paths";
import { enumerateFiles } from "./_search";
import {
    DEFAULT_MAX_BYTES,
    formatSize,
    GREP_MAX_LINE_LENGTH,
    type TruncationResult,
    truncateHead,
    truncateLine,
} from "./_truncate";

const grepSchema = Type.Object({
    pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
    path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
    glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
    literal: Type.Optional(
        Type.Boolean({ description: "Treat pattern as a literal string instead of regex (default: false)" }),
    ),
    context: Type.Optional(
        Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
    ),
    limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;
// Cap how many files we'll enumerate when searching a directory, so a
// huge tree can't make grep walk forever before truncating output.
const MAX_FILES_SCANNED = 20_000;

export interface GrepToolDetails {
    truncation?: TruncationResult;
    matchLimitReached?: number;
    linesTruncated?: boolean;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isProbablyBinary(buf: Buffer): boolean {
    // A NUL byte in the first 8KB is the standard heuristic ripgrep uses.
    const slice = buf.subarray(0, 8192);
    return slice.includes(0);
}

export function createGrepTool(cwd: string): AgentTool<typeof grepSchema, GrepToolDetails | undefined> {
    return {
        name: "grep",
        label: "grep",
        description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore (repo root). Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
        parameters: grepSchema,
        async execute(_toolCallId, { pattern, path: searchDir, glob, ignoreCase, literal, context, limit }, signal) {
            if (signal?.aborted) throw new Error("Operation aborted");

            const searchPath = resolveToCwd(searchDir || ".", cwd);
            if (!(await pathExists(searchPath))) throw new Error(`Path not found: ${searchPath}`);

            let regex: RegExp;
            try {
                regex = new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? "i" : "");
            } catch (e) {
                throw new Error(`Invalid regex pattern: ${(e as Error).message}`);
            }

            const contextValue = context && context > 0 ? context : 0;
            const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

            const stat = await fs.stat(searchPath);
            const isDirectory = stat.isDirectory();

            // Build the list of (absolutePath, displayPath) files to scan.
            const targets: { abs: string; display: string }[] = [];
            if (isDirectory) {
                const { files } = await enumerateFiles(glob ?? "**/*", searchPath, {
                    limit: MAX_FILES_SCANNED,
                    signal,
                });
                for (const rel of files) targets.push({ abs: path.join(searchPath, rel), display: rel });
            } else {
                targets.push({ abs: searchPath, display: path.basename(searchPath) });
            }

            const outBlocks: string[] = [];
            let matchCount = 0;
            let matchLimitReached = false;
            let linesTruncated = false;

            for (const { abs, display } of targets) {
                if (matchLimitReached) break;
                if (signal?.aborted) throw new Error("Operation aborted");

                let buf: Buffer;
                try {
                    buf = await fs.readFile(abs);
                } catch {
                    continue;
                }
                if (isProbablyBinary(buf)) continue;
                const lines = buf.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

                // Find match line indices.
                const matchIdx: number[] = [];
                for (let i = 0; i < lines.length; i++) {
                    if (regex.test(lines[i])) matchIdx.push(i);
                }
                if (matchIdx.length === 0) continue;

                // Expand each match to its context window, merge overlaps
                // into ranges so shared context lines aren't duplicated.
                const ranges: Array<{ start: number; end: number }> = [];
                for (const i of matchIdx) {
                    const start = Math.max(0, i - contextValue);
                    const end = Math.min(lines.length - 1, i + contextValue);
                    const last = ranges[ranges.length - 1];
                    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
                    else ranges.push({ start, end });
                }
                const matchSet = new Set(matchIdx);

                for (const { start, end } of ranges) {
                    if (matchLimitReached) break;
                    if (outBlocks.length > 0) outBlocks.push("--");
                    for (let i = start; i <= end; i++) {
                        const isMatch = matchSet.has(i);
                        if (isMatch) {
                            if (matchCount >= effectiveLimit) {
                                matchLimitReached = true;
                                break;
                            }
                            matchCount++;
                        }
                        const { text: lineText, wasTruncated } = truncateLine(lines[i]);
                        if (wasTruncated) linesTruncated = true;
                        const sep = isMatch ? ":" : "-";
                        outBlocks.push(`${display}:${i + 1}${sep}${lineText}`);
                    }
                }
            }

            if (matchCount === 0) {
                return { content: [{ type: "text", text: "No matches found" }], details: undefined };
            }

            const rawOutput = outBlocks.join("\n");
            const truncation = truncateHead(rawOutput);
            let output = truncation.content;
            const details: GrepToolDetails = {};
            const notices: string[] = [];
            if (matchLimitReached) {
                notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine the pattern`);
                details.matchLimitReached = effectiveLimit;
            }
            if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                details.truncation = truncation;
            }
            if (linesTruncated) {
                notices.push(`some lines truncated to ${GREP_MAX_LINE_LENGTH} chars`);
                details.linesTruncated = true;
            }
            if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

            return {
                content: [{ type: "text", text: output }],
                details: Object.keys(details).length > 0 ? details : undefined,
            };
        },
    };
}
