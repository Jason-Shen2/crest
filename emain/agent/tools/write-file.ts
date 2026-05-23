// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// write_file — create or overwrite a UTF-8 text file. mkdir -p style:
// parent directories are auto-created so the tool can land a new file
// in a deep path without a separate mkdir call.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";

import type { AgentTool } from "../types";
import { requireAbsolute } from "./_paths";

const NAME = "write_file";

const WriteFileSchema = Type.Object({
    filename: Type.String({
        description: "Absolute path (or ~-prefixed). Parent directories are created on demand.",
    }),
    content: Type.String({
        description: "Full file contents to write. Existing content is overwritten.",
    }),
});

export interface WriteFileDetails {
    path: string;
    bytesWritten: number;
    created: boolean;
}

export const writeFileTool: AgentTool<typeof WriteFileSchema, WriteFileDetails> = {
    name: NAME,
    label: "Write File",
    description:
        "Create or overwrite a file. Prefer multi_edit for targeted changes to existing files; use write_file for wholly new files or when replacing the entire content is intended.",
    parameters: WriteFileSchema,
    async execute(_toolCallId, params): Promise<{
        content: [{ type: "text"; text: string }];
        details: WriteFileDetails;
    }> {
        const abs = requireAbsolute(params.filename, NAME);
        const existed = await fs
            .stat(abs)
            .then(() => true)
            .catch(() => false);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, params.content, "utf8");
        const bytes = Buffer.byteLength(params.content, "utf8");
        const verb = existed ? "Overwrote" : "Created";
        return {
            content: [{ type: "text", text: `${verb} ${abs} (${bytes} bytes)` }],
            details: { path: abs, bytesWritten: bytes, created: !existed },
        };
    },
};

type _Static = Static<typeof WriteFileSchema>;
