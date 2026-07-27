// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// ls — list directory contents. Ported from pi's
// packages/coding-agent/src/core/tools/ls.ts (earendil-works/pi, MIT),
// with the pi-tui render layer stripped: crest renders tool output in
// assistant-ui tool components, so only the schema + execute logic is kept.
//
// pi tools are cwd-bound — createLsTool(cwd) resolves relative paths
// against the pane's cwd. The pluggable LsOperations seam is preserved
// so a future SSH/remote backend can override the filesystem calls.

import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import nodePath from "node:path";
import { type Static, Type } from "typebox";

import type { AgentTool } from "@crest/agent/types";
import { pathExists, resolveToCwd } from "./_paths";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type TruncationResult } from "./_truncate";

const lsSchema = Type.Object({
    path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

export type LsToolInput = Static<typeof lsSchema>;

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
    truncation?: TruncationResult;
    entryLimitReached?: number;
}

export interface LsOperations {
    exists: (absolutePath: string) => Promise<boolean> | boolean;
    stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
    readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
    exists: pathExists,
    stat: fsStat,
    readdir: fsReaddir,
};

export interface LsToolOptions {
    operations?: LsOperations;
}

export function createLsTool(
    cwd: string,
    options?: LsToolOptions
): AgentTool<typeof lsSchema, LsToolDetails | undefined> {
    const ops = options?.operations ?? defaultLsOperations;
    return {
        name: "ls",
        label: "ls",
        description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
        promptSnippet: "List directory contents",
        parameters: lsSchema,
        async execute(_toolCallId, { path, limit }, signal) {
            if (signal?.aborted) throw new Error("Operation aborted");

            const dirPath = resolveToCwd(path || ".", cwd);
            const effectiveLimit = limit ?? DEFAULT_LIMIT;

            if (!(await ops.exists(dirPath))) throw new Error(`Path not found: ${dirPath}`);

            const stat = await ops.stat(dirPath);
            if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

            let entries: string[];
            try {
                entries = await ops.readdir(dirPath);
            } catch (e) {
                throw new Error(`Cannot read directory: ${(e as Error).message}`);
            }

            entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

            const results: string[] = [];
            let entryLimitReached = false;
            for (const entry of entries) {
                if (results.length >= effectiveLimit) {
                    entryLimitReached = true;
                    break;
                }
                const fullPath = nodePath.join(dirPath, entry);
                let suffix = "";
                try {
                    const entryStat = await ops.stat(fullPath);
                    if (entryStat.isDirectory()) suffix = "/";
                } catch {
                    continue;
                }
                results.push(entry + suffix);
            }

            if (results.length === 0) {
                return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
            }

            const rawOutput = results.join("\n");
            // Byte-only truncation — entry count is already capped above.
            const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
            let output = truncation.content;
            const details: LsToolDetails = {};
            const notices: string[] = [];
            if (entryLimitReached) {
                notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
                details.entryLimitReached = effectiveLimit;
            }
            if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                details.truncation = truncation;
            }
            if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

            return {
                content: [{ type: "text", text: output }],
                details: Object.keys(details).length > 0 ? details : undefined,
            };
        },
    };
}
