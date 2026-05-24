// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// find — search for files by glob pattern. Schema + output shape ported
// from pi's packages/coding-agent/src/core/tools/find.ts (earendil-works
// /pi, MIT) with the pi-tui render layer stripped. pi shells out to `fd`
// (downloading the binary if missing); crest uses a pure-Node glob
// instead (see ./_search) — no binary download.

import * as path from "node:path";
import { type Static, Type } from "typebox";

import type { AgentTool } from "../types";
import { pathExists, resolveToCwd } from "./_paths";
import { enumerateFiles } from "./_search";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./_truncate";

const findSchema = Type.Object({
    pattern: Type.String({
        description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    }),
    path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
    truncation?: TruncationResult;
    resultLimitReached?: number;
}

export function createFindTool(cwd: string): AgentTool<typeof findSchema, FindToolDetails | undefined> {
    return {
        name: "find",
        label: "find",
        description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore (repo root). Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
        parameters: findSchema,
        async execute(_toolCallId, { pattern, path: searchDir, limit }, signal) {
            if (signal?.aborted) throw new Error("Operation aborted");

            const searchPath = resolveToCwd(searchDir || ".", cwd);
            if (!(await pathExists(searchPath))) throw new Error(`Path not found: ${searchPath}`);

            const effectiveLimit = limit ?? DEFAULT_LIMIT;
            // A pattern with no '/' matches a basename at any depth (fd's
            // default behavior). glob would otherwise anchor it to the top
            // level, so prefix '**/' to search recursively.
            const effectivePattern =
                pattern.includes("/") || pattern.startsWith("**") ? pattern : `**/${pattern}`;

            const { files, reachedLimit } = await enumerateFiles(effectivePattern, searchPath, {
                limit: effectiveLimit,
                signal,
            });

            if (files.length === 0) {
                return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
            }

            const rawOutput = files.map((f) => f.split(path.sep).join("/")).join("\n");
            const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
            let resultOutput = truncation.content;
            const details: FindToolDetails = {};
            const notices: string[] = [];
            if (reachedLimit) {
                notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
                details.resultLimitReached = effectiveLimit;
            }
            if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                details.truncation = truncation;
            }
            if (notices.length > 0) resultOutput += `\n\n[${notices.join(". ")}]`;

            return {
                content: [{ type: "text", text: resultOutput }],
                details: Object.keys(details).length > 0 ? details : undefined,
            };
        },
    };
}
