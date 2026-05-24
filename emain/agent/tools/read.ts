// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// read — read a text file with offset/limit + smart truncation. Ported
// from pi's packages/coding-agent/src/core/tools/read.ts
// (earendil-works/pi, MIT), with the pi-tui render layer stripped.
//
// Deviation from pi: image reading (auto-resize + mime sniff) is NOT
// ported — that path pulls pi's image-resize / mime utilities. crest's
// read is text-only for now; image-read is a deferred follow-up.
// TODO(edgeflow/pi): port pi's image-read branch (utils/image-resize +
// utils/mime) when crest wants the agent to read images.

import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { type Static, Type } from "typebox";

import type { AgentTool } from "../types";
import { resolveReadPathAsync } from "./_paths";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./_truncate";

const readSchema = Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
    truncation?: TruncationResult;
}

export interface ReadOperations {
    readFile: (absolutePath: string) => Promise<Buffer>;
    access: (absolutePath: string) => Promise<void>;
}

const defaultReadOperations: ReadOperations = {
    readFile: (p) => fsReadFile(p),
    access: (p) => fsAccess(p, constants.R_OK),
};

export interface ReadToolOptions {
    operations?: ReadOperations;
}

export function createReadTool(
    cwd: string,
    options?: ReadToolOptions,
): AgentTool<typeof readSchema, ReadToolDetails | undefined> {
    const ops = options?.operations ?? defaultReadOperations;
    return {
        name: "read",
        label: "read",
        description: `Read the contents of a text file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
        parameters: readSchema,
        async execute(_toolCallId, { path, offset, limit }, signal) {
            if (signal?.aborted) throw new Error("Operation aborted");

            const absolutePath = await resolveReadPathAsync(path, cwd);
            await ops.access(absolutePath);
            if (signal?.aborted) throw new Error("Operation aborted");

            const buffer = await ops.readFile(absolutePath);
            const textContent = buffer.toString("utf-8");
            const allLines = textContent.split("\n");
            const totalFileLines = allLines.length;

            // 1-indexed offset → 0-indexed array access.
            const startLine = offset ? Math.max(0, offset - 1) : 0;
            const startLineDisplay = startLine + 1;
            if (startLine >= allLines.length) {
                throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
            }

            let selectedContent: string;
            let userLimitedLines: number | undefined;
            if (limit !== undefined) {
                const endLine = Math.min(startLine + limit, allLines.length);
                selectedContent = allLines.slice(startLine, endLine).join("\n");
                userLimitedLines = endLine - startLine;
            } else {
                selectedContent = allLines.slice(startLine).join("\n");
            }

            const truncation = truncateHead(selectedContent);
            let details: ReadToolDetails | undefined;
            let outputText: string;
            if (truncation.firstLineExceedsLimit) {
                const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
                outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
                details = { truncation };
            } else if (truncation.truncated) {
                const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
                const nextOffset = endLineDisplay + 1;
                outputText = truncation.content;
                if (truncation.truncatedBy === "lines") {
                    outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
                } else {
                    outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
                }
                details = { truncation };
            } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
                const remaining = allLines.length - (startLine + userLimitedLines);
                const nextOffset = startLine + userLimitedLines + 1;
                outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
            } else {
                outputText = truncation.content;
            }

            return { content: [{ type: "text", text: outputText }], details };
        },
    };
}
