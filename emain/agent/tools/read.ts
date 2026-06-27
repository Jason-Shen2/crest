// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// read — read a text file with offset/limit + smart truncation, or an
// image file as an inline attachment. Ported from pi's
// packages/coding-agent/src/core/tools/read.ts (earendil-works/pi, MIT),
// with the pi-tui render layer stripped.
//
// Deviation from pi: image MIME sniffing (./_mime) is ported verbatim,
// but pi's processImage (auto-resize/convert via Photon WASM +
// worker_threads) is replaced by crest's WASM-free processImage
// (./_image), which only does no-resize base64 pass-through of
// inline-supported formats. See ./_image header for the trade-off.

import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { type Static, Type } from "typebox";

import type { ImageContent, TextContent } from "../../ai";
import type { AgentTool } from "../types";
import { processImage } from "./_image";
import { detectSupportedImageMimeTypeFromFile } from "./_mime";
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
    /** Detect image MIME type, return null or undefined for non-images. */
    detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
    readFile: (p) => fsReadFile(p),
    access: (p) => fsAccess(p, constants.R_OK),
    detectImageMimeType: detectSupportedImageMimeTypeFromFile,
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
        description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
        promptSnippet: "Read file contents",
        promptGuidelines: ["Use read to examine files instead of cat or sed."],
        parameters: readSchema,
        async execute(_toolCallId, { path, offset, limit }, signal) {
            if (signal?.aborted) throw new Error("Operation aborted");

            const absolutePath = await resolveReadPathAsync(path, cwd);
            await ops.access(absolutePath);
            if (signal?.aborted) throw new Error("Operation aborted");

            const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
            if (mimeType) {
                const buffer = await ops.readFile(absolutePath);
                if (signal?.aborted) throw new Error("Operation aborted");
                const processed = processImage(buffer, mimeType);
                let content: (TextContent | ImageContent)[];
                if (processed.ok === true) {
                    let textNote = `Read image file [${processed.mimeType}]`;
                    if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
                    content = [
                        { type: "text", text: textNote },
                        { type: "image", data: processed.data, mimeType: processed.mimeType },
                    ];
                } else {
                    content = [{ type: "text", text: `Read image file [${mimeType}]\n${processed.message}` }];
                }
                return { content, details: undefined };
            }

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
