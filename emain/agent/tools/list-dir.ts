// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// list_dir — directory listing. Returns file + subdirectory names with
// a short type marker, suitable for the LLM to scan for relevant files
// without an `ls -la` shell call.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";

import type { AgentTool } from "../types";
import { requireAbsolute } from "./_paths";

const NAME = "list_dir";
const DEFAULT_MAX_ENTRIES = 500;

const ListDirSchema = Type.Object({
    path: Type.String({ description: "Absolute (or ~-prefixed) directory path." }),
    maxEntries: Type.Optional(
        Type.Number({ description: `Cap on returned entries. Defaults to ${DEFAULT_MAX_ENTRIES}.` }),
    ),
});

export interface ListDirDetails {
    path: string;
    entriesReturned: number;
    truncated: boolean;
}

interface DirEntry {
    name: string;
    type: "dir" | "file" | "symlink" | "other";
}

export const listDirTool: AgentTool<typeof ListDirSchema, ListDirDetails> = {
    name: NAME,
    label: "List Directory",
    description:
        "List the immediate contents of a directory. Returns one entry per line as '<type> <name>', where type is dir | file | symlink | other.",
    parameters: ListDirSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<{
        content: [{ type: "text"; text: string }];
        details: ListDirDetails;
    }> {
        const abs = requireAbsolute(params.path, NAME);
        const cap = Math.max(1, params.maxEntries ?? DEFAULT_MAX_ENTRIES);
        const dirents = await fs.readdir(abs, { withFileTypes: true });
        const sorted = dirents.sort((a, b) => a.name.localeCompare(b.name));
        const truncated = sorted.length > cap;
        const entries: DirEntry[] = sorted.slice(0, cap).map((d) => {
            let type: DirEntry["type"] = "other";
            if (d.isDirectory()) type = "dir";
            else if (d.isFile()) type = "file";
            else if (d.isSymbolicLink()) type = "symlink";
            return { name: d.name, type };
        });
        const lines = entries.map((e) => `${e.type.padEnd(7, " ")} ${e.name}`);
        if (truncated) {
            lines.push(`... ${sorted.length - cap} more entries truncated; bump maxEntries to see all.`);
        }
        return {
            content: [{ type: "text", text: lines.join("\n") || `(empty: ${abs})` }],
            details: {
                path: abs,
                entriesReturned: entries.length,
                truncated,
            },
        };
    },
};

type _Static = Static<typeof ListDirSchema>;
// path-import marker — placate the unused-import check while we keep
// path available for future helpers (e.g. join base + entry name).
void path.sep;
