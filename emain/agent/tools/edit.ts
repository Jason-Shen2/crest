// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// edit — precise file editing via exact text replacement (with a fuzzy
// fallback), supporting multiple disjoint edits in one call. Ported from
// pi's packages/coding-agent/src/core/tools/edit.ts (earendil-works/pi,
// MIT), with the pi-tui render layer (diff preview) stripped. The edit/
// diff engine lives in ./_edit-diff. Writes are serialized per-path via
// withFileMutationQueue.

import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { type Static, Type } from "typebox";

import { type ChangeOperation, makeToolChangeOperation } from "../change-review/change-operation";
import type { AgentTool } from "../types";
import {
    applyEditsToNormalizedContent,
    detectLineEnding,
    type Edit,
    generateDiffString,
    generateUnifiedPatch,
    normalizeToLF,
    restoreLineEndings,
    stripBom,
} from "./_edit-diff";
import { withFileMutationQueue } from "./_file-mutation-queue";
import { resolveToCwd } from "./_paths";

const replaceEditSchema = Type.Object(
    {
        oldText: Type.String({
            description:
                "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
        }),
        newText: Type.String({ description: "Replacement text for this targeted edit." }),
    },
    { additionalProperties: false },
);

const editSchema = Type.Object(
    {
        path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
        edits: Type.Array(replaceEditSchema, {
            description:
                "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
        }),
    },
    { additionalProperties: false },
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & { oldText?: unknown; newText?: unknown };

export interface EditToolDetails {
    diff: string;
    patch: string;
    firstChangedLine?: number;
    changeOperation: ChangeOperation;
}

export interface EditOperations {
    readFile: (absolutePath: string) => Promise<Buffer>;
    writeFile: (absolutePath: string, content: string) => Promise<void>;
    access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
    readFile: (p) => fsReadFile(p),
    writeFile: (p, content) => fsWriteFile(p, content, "utf-8"),
    access: (p) => fsAccess(p, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
    operations?: EditOperations;
}

// Compat shim: some models send edits as a JSON string, or use the
// legacy single oldText/newText shape instead of edits[].
function prepareEditArguments(input: unknown): EditToolInput {
    if (!input || typeof input !== "object") return input as EditToolInput;
    const args = input as Record<string, unknown>;
    if (typeof args.edits === "string") {
        try {
            const parsed = JSON.parse(args.edits);
            if (Array.isArray(parsed)) args.edits = parsed;
        } catch {
            // leave as-is; validation below will reject
        }
    }
    const legacy = args as LegacyEditToolInput;
    if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
        return args as EditToolInput;
    }
    const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
    edits.push({ oldText: legacy.oldText, newText: legacy.newText });
    const { oldText: _oldText, newText: _newText, ...rest } = legacy;
    return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
        throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
    }
    return { path: input.path, edits: input.edits };
}

export function createEditTool(
    cwd: string,
    options?: EditToolOptions,
): AgentTool<typeof editSchema, EditToolDetails | undefined> {
    const ops = options?.operations ?? defaultEditOperations;
    return {
        name: "edit",
        label: "edit",
        description:
            "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Keep oldText as small as possible while still unique; do not pad with large unchanged regions.",
        parameters: editSchema,
        prepareArguments: prepareEditArguments,
        async execute(toolCallId, input, signal) {
            const { path, edits } = validateEditInput(input);
            const absolutePath = resolveToCwd(path, cwd);

            return withFileMutationQueue(absolutePath, async () => {
                const throwIfAborted = (): void => {
                    if (signal?.aborted) throw new Error("Operation aborted");
                };
                throwIfAborted();

                try {
                    await ops.access(absolutePath);
                } catch (error: unknown) {
                    throwIfAborted();
                    const errorMessage =
                        error instanceof Error && "code" in error
                            ? `Error code: ${(error as { code: string }).code}`
                            : String(error);
                    throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
                }
                throwIfAborted();

                const buffer = await ops.readFile(absolutePath);
                const rawContent = buffer.toString("utf-8");
                throwIfAborted();

                // Strip BOM before matching — the model won't include an
                // invisible BOM in oldText.
                const { bom, text: content } = stripBom(rawContent);
                const originalEnding = detectLineEnding(content);
                const normalizedContent = normalizeToLF(content);
                const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
                throwIfAborted();

                const finalContent = bom + restoreLineEndings(newContent, originalEnding);
                await ops.writeFile(absolutePath, finalContent);
                throwIfAborted();

                const diffResult = generateDiffString(baseContent, newContent);
                const patch = generateUnifiedPatch(path, baseContent, newContent);
                return {
                    content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
                    details: {
                        diff: diffResult.diff,
                        patch,
                        firstChangedLine: diffResult.firstChangedLine,
                        changeOperation: makeToolChangeOperation({
                            toolCallId,
                            kind: "patch",
                            path,
                            patch,
                            patchStatus: "complete",
                        }),
                    },
                };
            });
        },
    };
}
