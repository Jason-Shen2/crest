// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// multi_edit — apply a sequence of exact-string replacements to one
// file, atomically (all or nothing — if any edit's oldString isn't
// unique or isn't found, no writes happen). Mirrors crest's existing
// Go multi_edit semantics; safer than write_file for surgical changes
// because the LLM doesn't have to reproduce the entire file.

import { promises as fs } from "node:fs";
import { Type, type Static } from "typebox";

import type { AgentTool } from "../types";
import { requireAbsolute } from "./_paths";

const NAME = "multi_edit";

const EditSchema = Type.Object({
    oldString: Type.String({
        description:
            "Exact substring to replace. Must occur exactly once in the file (or replaceAll must be true).",
    }),
    newString: Type.String({ description: "Replacement substring." }),
    replaceAll: Type.Optional(
        Type.Boolean({
            description: "If true, replace every occurrence of oldString. Defaults to false.",
        }),
    ),
});

const MultiEditSchema = Type.Object({
    filename: Type.String({ description: "Absolute path (or ~-prefixed) to the file to edit." }),
    edits: Type.Array(EditSchema, {
        description:
            "Ordered list of edits. Each is applied to the result of the previous edit. All must succeed; if any fails the file is left untouched.",
    }),
});

export interface MultiEditDetails {
    path: string;
    editsApplied: number;
    bytesBefore: number;
    bytesAfter: number;
}

export const multiEditTool: AgentTool<typeof MultiEditSchema, MultiEditDetails> = {
    name: NAME,
    label: "Edit File",
    description:
        "Apply one or more exact-string replacements to a file atomically. Each edit's oldString must be unique in the (intermediate) file unless replaceAll is true. Failures roll back the entire batch — no partial writes.",
    parameters: MultiEditSchema,
    async execute(_toolCallId, params): Promise<{
        content: [{ type: "text"; text: string }];
        details: MultiEditDetails;
    }> {
        const abs = requireAbsolute(params.filename, NAME);
        const original = await fs.readFile(abs, "utf8");
        let working = original;
        for (let i = 0; i < params.edits.length; i++) {
            const edit = params.edits[i];
            if (edit.replaceAll) {
                if (!working.includes(edit.oldString)) {
                    throw new Error(
                        `${NAME}: edit #${i + 1} oldString not found in file ${abs}`,
                    );
                }
                working = working.split(edit.oldString).join(edit.newString);
                continue;
            }
            const first = working.indexOf(edit.oldString);
            if (first < 0) {
                throw new Error(
                    `${NAME}: edit #${i + 1} oldString not found in file ${abs}`,
                );
            }
            const second = working.indexOf(edit.oldString, first + edit.oldString.length);
            if (second >= 0) {
                throw new Error(
                    `${NAME}: edit #${i + 1} oldString matches ${working.split(edit.oldString).length - 1} times in ${abs} (set replaceAll:true or pass a longer oldString)`,
                );
            }
            working = working.slice(0, first) + edit.newString + working.slice(first + edit.oldString.length);
        }
        await fs.writeFile(abs, working, "utf8");
        return {
            content: [
                {
                    type: "text",
                    text: `Applied ${params.edits.length} edit(s) to ${abs}`,
                },
            ],
            details: {
                path: abs,
                editsApplied: params.edits.length,
                bytesBefore: Buffer.byteLength(original, "utf8"),
                bytesAfter: Buffer.byteLength(working, "utf8"),
            },
        };
    },
};

type _Static = Static<typeof MultiEditSchema>;
