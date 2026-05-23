// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// read_file — read a UTF-8 text file from disk. Mirrors crest's
// previous Go read_text_file tool but as a pi AgentTool that runs in
// the Electron main process.

import { promises as fs } from "node:fs";
import { Type, type Static } from "typebox";

import type { AgentTool } from "../types";
import { requireAbsolute } from "./_paths";

const DEFAULT_LINE_LIMIT = 2000;
const NAME = "read_file";

const ReadFileSchema = Type.Object({
    filename: Type.String({
        description:
            "Absolute path to read (or ~-prefixed). Relative paths are rejected to avoid ambiguity with the pane's cwd.",
    }),
    offset: Type.Optional(
        Type.Number({
            description: "1-indexed first line to read. Defaults to the start of the file.",
        }),
    ),
    limit: Type.Optional(
        Type.Number({
            description: `Maximum number of lines to read. Defaults to ${DEFAULT_LINE_LIMIT}.`,
        }),
    ),
});

export interface ReadFileDetails {
    path: string;
    bytesRead: number;
    linesReturned: number;
    truncated: boolean;
}

export const readFileTool: AgentTool<typeof ReadFileSchema, ReadFileDetails> = {
    name: NAME,
    label: "Read File",
    description:
        "Read a UTF-8 text file. Use the offset/limit parameters when you only need a specific section — don't pull entire large files.",
    parameters: ReadFileSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<{
        content: [{ type: "text"; text: string }];
        details: ReadFileDetails;
    }> {
        const abs = requireAbsolute(params.filename, NAME);
        const raw = await fs.readFile(abs, "utf8");
        const allLines = raw.split("\n");
        const offset = Math.max(0, (params.offset ?? 1) - 1);
        const limit = Math.max(1, params.limit ?? DEFAULT_LINE_LIMIT);
        const slice = allLines.slice(offset, offset + limit);
        const truncated = offset + limit < allLines.length || offset > 0;
        return {
            content: [{ type: "text", text: slice.join("\n") }],
            details: {
                path: abs,
                bytesRead: Buffer.byteLength(raw, "utf8"),
                linesReturned: slice.length,
                truncated,
            },
        };
    },
};

type _Static = Static<typeof ReadFileSchema>;
