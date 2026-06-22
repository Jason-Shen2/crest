// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { PiRun } from "@/app/store/use-pi-chat";
import {
    buildChangeReview,
    buildChangeSet,
    type ChangeOutline,
    type ChangeReview,
    type ChangeReviewFile,
    type ChangeReviewModule,
    type ChangeReviewWarning,
    type ChangeSet,
    type ChangeSetFile,
    type ChangeSetHunk,
    deriveAgentChangeReview,
    extractChangeOperations,
    parseUnifiedPatchHunks,
} from "./agent-change-review";

function makeRun(responseMessages: PiRun["responseMessages"]): PiRun {
    return {
        runId: "run-1",
        userMessage: {
            role: "user",
            content: [{ type: "text", text: "update files" }],
            timestamp: 1,
        },
        responseMessages,
        status: "done",
    };
}

const Patch = `--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@ function main
 const before = true;
-const removed = "old";
+const added = "new";
+const extra = true;
 const keep = true;
@@ -12,2 +13,2 @@ export helper
-return "old";
+return "new";
`;

describe("extractChangeOperations", () => {
    it("reads Task1 changeOperation details from tool results and annotates run id", () => {
        const operations = extractChangeOperations(
            makeRun([
                {
                    role: "toolResult",
                    toolCallId: "edit-1",
                    toolName: "edit",
                    content: [{ type: "text", text: "patched" }],
                    details: {
                        changeOperation: {
                            id: "op-1",
                            toolCallId: "edit-1",
                            kind: "patch",
                            path: "src/app.ts",
                            patch: Patch,
                            patchStatus: "complete",
                        },
                    },
                },
            ])
        );

        expect(operations).toEqual([
            expect.objectContaining({
                id: "op-1",
                runId: "run-1",
                toolCallId: "edit-1",
                kind: "patch",
                path: "src/app.ts",
                patchStatus: "complete",
                patch: Patch,
            }),
        ]);
    });

    it("ignores failed tool results so rejected edits do not enter review", () => {
        const operations = extractChangeOperations(
            makeRun([
                {
                    role: "toolResult",
                    toolCallId: "edit-failed",
                    toolName: "edit",
                    content: [{ type: "text", text: "failed" }],
                    details: {
                        changeOperation: {
                            id: "op-failed",
                            toolCallId: "edit-failed",
                            kind: "patch",
                            path: "src/broken.ts",
                            patch: Patch,
                            patchStatus: "complete",
                        },
                    },
                    isError: true,
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-ok",
                    toolName: "edit",
                    content: [{ type: "text", text: "patched" }],
                    details: {
                        changeOperation: {
                            id: "op-ok",
                            toolCallId: "edit-ok",
                            kind: "patch",
                            path: "src/app.ts",
                            patch: Patch,
                            patchStatus: "complete",
                        },
                    },
                    isError: false,
                },
            ])
        );

        expect(operations.map((operation) => operation.id)).toEqual(["op-ok"]);
    });

    it("also reads change operations nested inside toolResult content blocks", () => {
        const operations = extractChangeOperations(
            makeRun([
                {
                    role: "toolResult",
                    content: [
                        {
                            type: "toolResult",
                            toolCallId: "write-1",
                            details: {
                                changeOperation: {
                                    id: "op-2",
                                    kind: "write",
                                    path: "src/virtual.ts",
                                    patchStatus: "unavailable",
                                    patchUnavailableReason: "readFile unavailable",
                                },
                            },
                        },
                    ],
                },
            ])
        );

        expect(operations).toEqual([
            expect.objectContaining({
                id: "op-2",
                runId: "run-1",
                path: "src/virtual.ts",
                patchStatus: "unavailable",
                patchUnavailableReason: "readFile unavailable",
            }),
        ]);
    });
});

describe("parseUnifiedPatchHunks", () => {
    it("parses hunk ranges and line statistics while ignoring file headers", () => {
        expect(parseUnifiedPatchHunks(Patch)).toEqual([
            {
                id: "src/app.ts:1",
                path: "src/app.ts",
                oldStart: 1,
                oldLines: 4,
                newStart: 1,
                newLines: 5,
                header: "function main",
                additions: 2,
                deletions: 1,
            },
            {
                id: "src/app.ts:2",
                path: "src/app.ts",
                oldStart: 12,
                oldLines: 2,
                newStart: 13,
                newLines: 2,
                header: "export helper",
                additions: 1,
                deletions: 1,
            },
        ]);
    });

    it("uses the deleted file path for multi-file patches with +++ /dev/null", () => {
        const multiFilePatch = `--- a/src/kept.ts
+++ b/src/kept.ts
@@ -1 +1 @@
-old
+new
--- a/src/deleted.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-forever
`;

        expect(parseUnifiedPatchHunks(multiFilePatch).map((hunk) => [hunk.id, hunk.path, hunk.deletions])).toEqual([
            ["src/kept.ts:1", "src/kept.ts", 1],
            ["src/deleted.ts:1", "src/deleted.ts", 2],
        ]);
    });
});

describe("buildChangeSet", () => {
    it("groups operations by file and keeps unavailable patch files with zero stats", () => {
        const changeSet = buildChangeSet([
            {
                id: "op-1",
                kind: "patch",
                path: "src/app.ts",
                patch: Patch,
                patchStatus: "complete",
            },
            {
                id: "op-2",
                kind: "write",
                path: "src/virtual.ts",
                patchStatus: "unavailable",
                patchUnavailableReason: "readFile unavailable",
            },
        ]);

        expect(changeSet.totals).toEqual({ files: 2, hunks: 2, additions: 3, deletions: 2 });
        expect(changeSet.files).toEqual([
            expect.objectContaining({
                path: "src/app.ts",
                status: "modified",
                stats: { hunks: 2, additions: 3, deletions: 2 },
            }),
            expect.objectContaining({
                path: "src/virtual.ts",
                status: "modified",
                stats: { hunks: 0, additions: 0, deletions: 0 },
                patchUnavailableReason: "readFile unavailable",
            }),
        ]);
    });

    it("preserves file status and previousPath from operation kind", () => {
        const changeSet = buildChangeSet([
            { id: "op-add", kind: "create", path: "src/new.ts", patchStatus: "unavailable" },
            { id: "op-delete", kind: "delete", path: "src/old.ts", patchStatus: "unavailable" },
            {
                id: "op-rename",
                kind: "rename",
                path: "src/new-name.ts",
                previousPath: "src/old-name.ts",
                patchStatus: "unavailable",
            },
        ]);

        expect(changeSet.files.map((file) => [file.path, file.status, file.previousPath])).toEqual([
            ["src/new.ts", "added", undefined],
            ["src/old.ts", "deleted", undefined],
            ["src/new-name.ts", "renamed", "src/old-name.ts"],
        ]);
    });
});

describe("buildChangeReview", () => {
    it("builds modules from a valid outline and leaves other files ungrouped", () => {
        const changeSet = buildChangeSet([
            {
                id: "op-1",
                kind: "patch",
                path: "src/app.ts",
                patch: Patch,
                patchStatus: "complete",
            },
            {
                id: "op-2",
                kind: "write",
                path: "src/virtual.ts",
                patchStatus: "unavailable",
                patchUnavailableReason: "readFile unavailable",
            },
        ]);

        const review = buildChangeReview(changeSet, {
            modules: [
                {
                    id: "focused",
                    title: "Focused review",
                    summary: "Review only touched hunks.",
                    files: [{ path: "src/app.ts", hunkIds: ["src/app.ts:2", "src/app.ts:1"] }],
                },
            ],
        });

        const _review: ChangeReview = review;
        const _changeSet: ChangeSet = review.changeSet;
        const _module: ChangeReviewModule = review.modules[0];
        const _file: ChangeReviewFile = review.modules[0].files[0];
        const _setFile: ChangeSetFile = review.changeSet.files[0];
        const _hunk: ChangeSetHunk = review.changeSet.files[0].hunks[0];
        expect(Boolean(_review && _changeSet && _module && _file && _setFile && _hunk)).toBe(true);
        expect(review.changeSetId).toBe(changeSet.id);
        expect(review.changeSet).toBe(changeSet);
        expect(review.modules).toEqual([
            expect.objectContaining({
                id: "focused",
                title: "Focused review",
                summary: "Review only touched hunks.",
                files: [
                    expect.objectContaining({
                        path: "src/app.ts",
                        hunks: [
                            expect.objectContaining({ id: "src/app.ts:2" }),
                            expect.objectContaining({ id: "src/app.ts:1" }),
                        ],
                    }),
                ],
            }),
        ]);
        expect(review.ungroupedFiles.map((file) => file.path)).toEqual(["src/virtual.ts"]);
        expect(review.warnings).toEqual([]);
    });

    it("keeps remaining file hunks ungrouped when outline references only some hunks", () => {
        const changeSet = buildChangeSet([
            {
                id: "op-1",
                kind: "patch",
                path: "src/app.ts",
                patch: Patch,
                patchStatus: "complete",
            },
        ]);

        const review = buildChangeReview(changeSet, {
            modules: [
                {
                    id: "focused",
                    title: "Focused review",
                    files: [{ path: "src/app.ts", hunkIds: ["src/app.ts:2"] }],
                },
            ],
        });

        expect(review.modules[0].files[0].hunks.map((hunk) => hunk.id)).toEqual(["src/app.ts:2"]);
        expect(review.ungroupedFiles).toEqual([
            expect.objectContaining({
                path: "src/app.ts",
                hunks: [expect.objectContaining({ id: "src/app.ts:1" })],
                stats: { hunks: 1, additions: 2, deletions: 1 },
            }),
        ]);
    });

    it("falls back to ungrouped files with warnings when an outline references missing paths or hunks", () => {
        const changeSet = buildChangeSet([
            {
                id: "op-1",
                kind: "patch",
                path: "src/app.ts",
                patch: Patch,
                patchStatus: "complete",
            },
        ]);

        const outline: ChangeOutline = {
            modules: [
                {
                    id: "invalid",
                    title: "Invalid review",
                    files: [{ path: "src/missing.ts", hunkIds: ["src/app.ts:99"] }],
                },
            ],
        };
        const review = buildChangeReview(changeSet, outline);

        const _warning: ChangeReviewWarning = review.warnings[0];
        expect(_warning.severity).toBe("warning");
        expect(review.modules).toEqual([]);
        expect(review.ungroupedFiles.map((file) => file.path)).toEqual(["src/app.ts"]);
        expect(review.warnings).toEqual([
            { code: "unknown-file", message: 'Outline references unknown file "src/missing.ts".', severity: "warning" },
            { code: "unknown-hunk", message: 'Outline references unknown hunk "src/app.ts:99".', severity: "warning" },
        ]);
    });

    it("falls back when an outline hunk belongs to a different file", () => {
        const otherPatch = `--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1 @@
-old
+new
`;
        const changeSet = buildChangeSet([
            {
                id: "op-1",
                kind: "patch",
                path: "src/app.ts",
                patch: Patch,
                patchStatus: "complete",
            },
            {
                id: "op-2",
                kind: "patch",
                path: "src/other.ts",
                patch: otherPatch,
                patchStatus: "complete",
            },
        ]);

        const review = buildChangeReview(changeSet, {
            modules: [
                { id: "invalid", title: "Invalid", files: [{ path: "src/app.ts", hunkIds: ["src/other.ts:1"] }] },
            ],
        });

        expect(review.modules).toEqual([]);
        expect(review.warnings).toEqual([
            {
                code: "hunk-file-mismatch",
                message: 'Outline references hunk "src/other.ts:1" outside file "src/app.ts".',
                severity: "warning",
            },
        ]);
    });
});

describe("deriveAgentChangeReview", () => {
    it("derives a review with all files ungrouped when no outline is provided", () => {
        const review = deriveAgentChangeReview(
            makeRun([
                {
                    role: "toolResult",
                    toolCallId: "edit-1",
                    toolName: "edit",
                    content: [{ type: "text", text: "patched" }],
                    details: {
                        changeOperation: {
                            id: "op-1",
                            toolCallId: "edit-1",
                            kind: "patch",
                            path: "src/app.ts",
                            patch: Patch,
                            patchStatus: "complete",
                        },
                    },
                },
            ])
        );

        expect(review).toMatchObject({
            changeSetId: "run-1",
            changeSet: { id: "run-1", totals: { files: 1, hunks: 2, additions: 3, deletions: 2 } },
            modules: [],
            warnings: [],
        });
        expect(review.ungroupedFiles.map((file) => file.path)).toEqual(["src/app.ts"]);
    });
});
