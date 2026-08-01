// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as Diff from "diff";

import type { AgentRewindFileRowView } from "./api-types";
import type { CapturedPathStateV1 } from "./types";

export const WorkspaceDiffPreviewLimits = {
    maxSideBytes: 1 * 1024 * 1024,
    maxRequestInputBytes: 8 * 1024 * 1024,
} as const;

export class WorkspaceDiffPreviewBudget {
    usedInputBytes = 0;

    reserve(beforeBytes: number, afterBytes: number): boolean {
        if (
            beforeBytes > WorkspaceDiffPreviewLimits.maxSideBytes ||
            afterBytes > WorkspaceDiffPreviewLimits.maxSideBytes
        ) {
            return false;
        }
        const inputBytes = beforeBytes + afterBytes;
        if (this.usedInputBytes + inputBytes > WorkspaceDiffPreviewLimits.maxRequestInputBytes) {
            return false;
        }
        this.usedInputBytes += inputBytes;
        return true;
    }
}

interface ProjectWorkspacePathDiffInput {
    path: string;
    before: CapturedPathStateV1;
    after: CapturedPathStateV1;
    readBlob(oid: string): Promise<Buffer>;
    budget: WorkspaceDiffPreviewBudget;
}

type ProjectedWorkspacePathDiff = AgentRewindFileRowView & {
    originalContent?: string;
    modifiedContent?: string;
};

function operationFor(before: CapturedPathStateV1, after: CapturedPathStateV1): AgentRewindFileRowView["operation"] {
    if (after.state === "absent") return "delete";
    if (before.state === "absent") return "create";
    return "write";
}

function baseRow(input: ProjectWorkspacePathDiffInput): AgentRewindFileRowView {
    return {
        path: input.path,
        operation: operationFor(input.before, input.after),
        coverage: input.before.state === "excluded" || input.after.state === "excluded" ? "excluded" : "covered",
        conflict: "none",
    };
}

function unavailable(
    row: AgentRewindFileRowView,
    previewUnavailableReason: string,
    coverage: AgentRewindFileRowView["coverage"] = row.coverage
): ProjectedWorkspacePathDiff {
    return { ...row, coverage, previewUnavailableReason };
}

async function readTextSide(
    state: Extract<CapturedPathStateV1, { state: "absent" | "file" }>,
    readBlob: (oid: string) => Promise<Buffer>
): Promise<Buffer> {
    if (state.state === "absent") return Buffer.alloc(0);
    return readBlob(state.oid);
}

function decodeText(blob: Buffer): { content?: string; reason?: string } {
    if (blob.includes(0)) return { reason: "binary file" };
    try {
        return { content: new TextDecoder("utf-8", { fatal: true }).decode(blob) };
    } catch {
        return { reason: "invalid UTF-8" };
    }
}

function lineCounts(originalContent: string, modifiedContent: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    for (const part of Diff.diffLines(originalContent, modifiedContent)) {
        if (part.added) additions += part.count ?? 0;
        if (part.removed) deletions += part.count ?? 0;
    }
    return { additions, deletions };
}

export async function projectWorkspacePathDiff(
    input: ProjectWorkspacePathDiffInput
): Promise<ProjectedWorkspacePathDiff> {
    const row = baseRow(input);
    if (input.before.state === "excluded") return unavailable(row, `excluded: ${input.before.reason}`);
    if (input.after.state === "excluded") return unavailable(row, `excluded: ${input.after.reason}`);
    if (input.before.state === "symlink" || input.after.state === "symlink") {
        return unavailable(row, "symlink");
    }

    let beforeBlob: Buffer;
    let afterBlob: Buffer;
    try {
        [beforeBlob, afterBlob] = await Promise.all([
            readTextSide(input.before, input.readBlob),
            readTextSide(input.after, input.readBlob),
        ]);
    } catch {
        return unavailable(row, "snapshot blob is unavailable", "unavailable");
    }

    if (
        beforeBlob.byteLength > WorkspaceDiffPreviewLimits.maxSideBytes ||
        afterBlob.byteLength > WorkspaceDiffPreviewLimits.maxSideBytes
    ) {
        return unavailable(row, "file exceeds preview size limit");
    }
    if (!input.budget.reserve(beforeBlob.byteLength, afterBlob.byteLength)) {
        return unavailable(row, "request exceeds preview input limit");
    }

    const beforeText = decodeText(beforeBlob);
    if (beforeText.reason) return unavailable(row, beforeText.reason);
    const afterText = decodeText(afterBlob);
    if (afterText.reason) return unavailable(row, afterText.reason);

    const originalContent = beforeText.content!;
    const modifiedContent = afterText.content!;
    return {
        ...row,
        ...lineCounts(originalContent, modifiedContent),
        diff: Diff.createTwoFilesPatch(input.path, input.path, originalContent, modifiedContent),
        originalContent,
        modifiedContent,
    };
}
