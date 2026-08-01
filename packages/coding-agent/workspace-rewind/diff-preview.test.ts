// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { projectWorkspacePathDiff, WorkspaceDiffPreviewBudget, WorkspaceDiffPreviewLimits } from "./diff-preview";
import type { CapturedPathStateV1 } from "./types";

const BeforeOid = "a".repeat(40);
const AfterOid = "b".repeat(40);

function fileState(oid: string): CapturedPathStateV1 {
    return { state: "file", oid, executable: false };
}

function readBlobs(blobs: Record<string, Buffer | string>) {
    return vi.fn(async (oid: string) => {
        const blob = blobs[oid];
        if (blob == null) throw new Error(`missing test blob: ${oid}`);
        return Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    });
}

describe("projectWorkspacePathDiff", () => {
    it.each([
        {
            name: "file to file",
            before: fileState(BeforeOid),
            after: fileState(AfterOid),
            blobs: { [BeforeOid]: "const value = 2;\n", [AfterOid]: "const value = 1;\n" },
            operation: "write" as const,
            additions: 1,
            deletions: 1,
            removed: "-const value = 2;",
            added: "+const value = 1;",
        },
        {
            name: "absent to file",
            before: { state: "absent" } as const,
            after: fileState(AfterOid),
            blobs: { [AfterOid]: "const value = 1;\n" },
            operation: "create" as const,
            additions: 1,
            deletions: 0,
            removed: "--- src/value.ts",
            added: "+const value = 1;",
        },
        {
            name: "file to absent",
            before: fileState(BeforeOid),
            after: { state: "absent" } as const,
            blobs: { [BeforeOid]: "const value = 2;\n" },
            operation: "delete" as const,
            additions: 0,
            deletions: 1,
            removed: "-const value = 2;",
            added: "+++ src/value.ts",
        },
    ])("projects $name operation, patch, and line counts", async (value) => {
        const row = await projectWorkspacePathDiff({
            path: "src/value.ts",
            before: value.before,
            after: value.after,
            readBlob: readBlobs(value.blobs),
            budget: new WorkspaceDiffPreviewBudget(),
        });

        expect(row).toMatchObject({
            path: "src/value.ts",
            operation: value.operation,
            additions: value.additions,
            deletions: value.deletions,
            coverage: "covered",
            conflict: "none",
        });
        expect(row.diff).toContain(value.removed);
        expect(row.diff).toContain(value.added);
    });

    it.each([
        { action: "Review", before: "before review\n", after: "after review\n" },
        { action: "Revert", before: "after revert\n", after: "before revert\n" },
        { action: "Undo", before: "after undo\n", after: "before undo\n" },
        { action: "Redo", before: "before redo\n", after: "after redo\n" },
    ])("uses the supplied immutable direction for $action", async ({ before, after }) => {
        const row = await projectWorkspacePathDiff({
            path: "direction.txt",
            before: fileState(BeforeOid),
            after: fileState(AfterOid),
            readBlob: readBlobs({ [BeforeOid]: before, [AfterOid]: after }),
            budget: new WorkspaceDiffPreviewBudget(),
        });

        expect(row.diff).toContain(`-${before.trimEnd()}`);
        expect(row.diff).toContain(`+${after.trimEnd()}`);
        expect(row.originalContent).toBe(before);
        expect(row.modifiedContent).toBe(after);
    });

    it("strictly decodes UTF-8 from snapshot blobs", async () => {
        const before = "你好，快照 👋\n";
        const after = "你好，检查点 ✅\n";
        const readBlob = readBlobs({
            [BeforeOid]: Buffer.from(before, "utf8"),
            [AfterOid]: Buffer.from(after, "utf8"),
        });

        const row = await projectWorkspacePathDiff({
            path: "文档.txt",
            before: fileState(BeforeOid),
            after: fileState(AfterOid),
            readBlob,
            budget: new WorkspaceDiffPreviewBudget(),
        });

        expect(readBlob.mock.calls).toEqual([[BeforeOid], [AfterOid]]);
        expect(row.originalContent).toBe(before);
        expect(row.modifiedContent).toBe(after);
        expect(row.diff).toContain("-你好，快照 👋");
        expect(row.diff).toContain("+你好，检查点 ✅");
    });

    it.each([
        {
            name: "binary content",
            before: fileState(BeforeOid),
            after: fileState(AfterOid),
            blobs: { [BeforeOid]: Buffer.from([0, 1]), [AfterOid]: Buffer.from("text\n") },
            reason: "binary file",
            reads: 2,
            coverage: "covered" as const,
        },
        {
            name: "invalid UTF-8",
            before: fileState(BeforeOid),
            after: fileState(AfterOid),
            blobs: { [BeforeOid]: Buffer.from([0xc3, 0x28]), [AfterOid]: Buffer.from("text\n") },
            reason: "invalid UTF-8",
            reads: 2,
            coverage: "covered" as const,
        },
        {
            name: "symlink state",
            before: { state: "symlink", oid: BeforeOid } as const,
            after: fileState(AfterOid),
            blobs: {},
            reason: "symlink",
            reads: 0,
            coverage: "covered" as const,
        },
        {
            name: "excluded state",
            before: { state: "excluded", reason: "ignored" } as const,
            after: fileState(AfterOid),
            blobs: {},
            reason: "excluded: ignored",
            reads: 0,
            coverage: "excluded" as const,
        },
    ])("returns a stable unavailable reason for $name", async (value) => {
        const readBlob = readBlobs(value.blobs);

        const row = await projectWorkspacePathDiff({
            path: "asset",
            before: value.before,
            after: value.after,
            readBlob,
            budget: new WorkspaceDiffPreviewBudget(),
        });

        expect(row).toMatchObject({
            path: "asset",
            operation: "write",
            coverage: value.coverage,
            conflict: "none",
            previewUnavailableReason: value.reason,
        });
        expect(row).not.toHaveProperty("diff");
        expect(row).not.toHaveProperty("originalContent");
        expect(row).not.toHaveProperty("modifiedContent");
        expect(readBlob).toHaveBeenCalledTimes(value.reads);
    });

    it("omits only the preview when either side exceeds the per-side byte limit", async () => {
        const row = await projectWorkspacePathDiff({
            path: "large.txt",
            before: fileState(BeforeOid),
            after: fileState(AfterOid),
            readBlob: readBlobs({
                [BeforeOid]: Buffer.alloc(WorkspaceDiffPreviewLimits.maxSideBytes + 1, 0x61),
                [AfterOid]: "small\n",
            }),
            budget: new WorkspaceDiffPreviewBudget(),
        });

        expect(row).toMatchObject({
            path: "large.txt",
            operation: "write",
            coverage: "covered",
            conflict: "none",
            previewUnavailableReason: "file exceeds preview size limit",
        });
        expect(row).not.toHaveProperty("diff");
    });

    it("omits only the current row when the cumulative input byte limit is exceeded", async () => {
        const budget = new WorkspaceDiffPreviewBudget();
        for (let index = 0; index < 4; index++) {
            expect(
                budget.reserve(WorkspaceDiffPreviewLimits.maxSideBytes, WorkspaceDiffPreviewLimits.maxSideBytes)
            ).toBe(true);
        }
        expect(budget.usedInputBytes).toBe(WorkspaceDiffPreviewLimits.maxRequestInputBytes);

        const row = await projectWorkspacePathDiff({
            path: "still-listed.txt",
            before: fileState(BeforeOid),
            after: fileState(AfterOid),
            readBlob: readBlobs({ [BeforeOid]: "before\n", [AfterOid]: "after\n" }),
            budget,
        });

        expect(row).toMatchObject({
            path: "still-listed.txt",
            operation: "write",
            coverage: "covered",
            conflict: "none",
            previewUnavailableReason: "request exceeds preview input limit",
        });
        expect(row).not.toHaveProperty("diff");
        expect(budget.usedInputBytes).toBe(WorkspaceDiffPreviewLimits.maxRequestInputBytes);
    });

    it("contains a blob read failure to its row", async () => {
        const budget = new WorkspaceDiffPreviewBudget();
        const failingRow = await projectWorkspacePathDiff({
            path: "missing.txt",
            before: fileState(BeforeOid),
            after: fileState(AfterOid),
            readBlob: vi.fn(async () => {
                throw new Error("sensitive storage detail");
            }),
            budget,
        });
        const healthyRow = await projectWorkspacePathDiff({
            path: "healthy.txt",
            before: fileState(BeforeOid),
            after: fileState(AfterOid),
            readBlob: readBlobs({ [BeforeOid]: "old\n", [AfterOid]: "new\n" }),
            budget,
        });

        expect(failingRow).toMatchObject({
            path: "missing.txt",
            operation: "write",
            coverage: "unavailable",
            conflict: "none",
            previewUnavailableReason: "snapshot blob is unavailable",
        });
        expect(failingRow.previewUnavailableReason).not.toContain("sensitive storage detail");
        expect(healthyRow).toMatchObject({ path: "healthy.txt", additions: 1, deletions: 1 });
        expect(healthyRow.diff).toContain("-old");
        expect(healthyRow.diff).toContain("+new");
    });
});
