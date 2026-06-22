// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// write — create or overwrite a file (auto-creates parent dirs). Ported
// from pi's packages/coding-agent/src/core/tools/write.ts
// (earendil-works/pi, MIT), with the pi-tui render layer stripped.
// Writes are serialized per-path via withFileMutationQueue so a
// concurrent edit/write on the same file can't tear.

import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Static, Type } from "typebox";

import { type ChangeOperation, type ChangeOperationKind, makeToolChangeOperation } from "../change-review/change-operation";
import type { AgentTool } from "../types";
import { generateUnifiedPatch } from "./_edit-diff";
import { withFileMutationQueue } from "./_file-mutation-queue";
import { resolveToCwd } from "./_paths";

const writeSchema = Type.Object({
    path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
    content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteOperations {
    writeFile: (absolutePath: string, content: string) => Promise<void>;
    mkdir: (dir: string) => Promise<void>;
    readFile?: (absolutePath: string) => Promise<Buffer>;
}

const defaultWriteOperations: WriteOperations = {
    writeFile: (p, content) => fsWriteFile(p, content, "utf-8"),
    mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
    readFile: (p) => fsReadFile(p),
};

export interface WriteToolOptions {
    operations?: WriteOperations;
}

export interface WriteToolDetails {
    patch?: string;
    patchStatus: "complete" | "unavailable";
    patchUnavailableReason?: string;
    changeOperation: ChangeOperation;
}

type ExistingContentResult =
    | { status: "complete"; content: string; exists: boolean }
    | { status: "unavailable"; reason: string };

async function readExistingContent(ops: WriteOperations, absolutePath: string): Promise<ExistingContentResult> {
    const readFile = ops.readFile;
    if (!readFile) return { status: "unavailable", reason: "readFile unavailable" };
    try {
        return { status: "complete", content: (await readFile(absolutePath)).toString("utf-8"), exists: true };
    } catch (error: unknown) {
        if (error instanceof Error && "code" in error && (error as { code: string }).code === "ENOENT") {
            return { status: "complete", content: "", exists: false };
        }
        return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema, WriteToolDetails> {
    const ops = options?.operations ?? defaultWriteOperations;
    return {
        name: "write",
        label: "write",
        description:
            "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories. Use write only for new files or complete rewrites — use edit for targeted changes.",
        parameters: writeSchema,
        async execute(toolCallId, { path, content }, signal) {
            const absolutePath = resolveToCwd(path, cwd);
            const dir = dirname(absolutePath);
            return withFileMutationQueue(absolutePath, async () => {
                // Don't reject off an abort listener — that would release the
                // mutation queue while an fs op may still settle. Check
                // signal.aborted after each await instead.
                const throwIfAborted = (): void => {
                    if (signal?.aborted) throw new Error("Operation aborted");
                };
                throwIfAborted();
                const previousContent = await readExistingContent(ops, absolutePath);
                throwIfAborted();
                await ops.mkdir(dir);
                throwIfAborted();
                await ops.writeFile(absolutePath, content);
                throwIfAborted();
                const patch =
                    previousContent.status === "complete"
                        ? generateUnifiedPatch(path, previousContent.content, content)
                        : undefined;
                const patchStatus = previousContent.status;
                const patchUnavailableReason =
                    previousContent.status === "unavailable" ? previousContent.reason : undefined;
                const operationKind: ChangeOperationKind =
                    previousContent.status === "complete" && !previousContent.exists ? "create" : "write";
                return {
                    content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
                    details: {
                        patch,
                        patchStatus,
                        ...(patchUnavailableReason !== undefined ? { patchUnavailableReason } : {}),
                        changeOperation: makeToolChangeOperation({
                            toolCallId,
                            kind: operationKind,
                            path,
                            patch,
                            patchStatus,
                            patchUnavailableReason,
                        }),
                    },
                };
            });
        },
    };
}
