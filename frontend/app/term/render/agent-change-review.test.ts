// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { PiRun } from "@/app/store/use-pi-chat";
import {
    buildChangeReview,
    buildChangeSet,
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
                stats: { hunks: 2, additions: 3, deletions: 2 },
            }),
            expect.objectContaining({
                path: "src/virtual.ts",
                stats: { hunks: 0, additions: 0, deletions: 0 },
                patchUnavailableReason: "readFile unavailable",
            }),
        ]);
    });
});

describe("buildChangeReview", () => {
    it("uses a valid outline to order file and hunk references", () => {
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
            title: "Focused review",
            summary: "Review only touched hunks.",
            files: [{ path: "src/app.ts", hunkIds: ["src/app.ts:2", "src/app.ts:1"] }],
        });

        expect(review.title).toBe("Focused review");
        expect(review.summary).toBe("Review only touched hunks.");
        expect(review.files[0].hunks.map((hunk) => hunk.id)).toEqual(["src/app.ts:2", "src/app.ts:1"]);
        expect(review.isFallback).toBe(false);
        expect(review.validationErrors).toEqual([]);
    });

    it("falls back when an outline references missing paths or hunks", () => {
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
            title: "Invalid review",
            files: [{ path: "src/missing.ts", hunkIds: ["src/app.ts:99"] }],
        });

        expect(review.isFallback).toBe(true);
        expect(review.title).toBe("Changed files");
        expect(review.files.map((file) => file.path)).toEqual(["src/app.ts"]);
        expect(review.validationErrors).toEqual([
            'Outline references unknown file "src/missing.ts".',
            'Outline references unknown hunk "src/app.ts:99".',
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
            files: [{ path: "src/app.ts", hunkIds: ["src/other.ts:1"] }],
        });

        expect(review.isFallback).toBe(true);
        expect(review.validationErrors).toEqual([
            'Outline references hunk "src/other.ts:1" outside file "src/app.ts".',
        ]);
    });
});

describe("deriveAgentChangeReview", () => {
    it("derives a fallback review from a run", () => {
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
            title: "Changed files",
            summary: "1 file changed with 3 additions and 2 deletions.",
            totals: { files: 1, hunks: 2, additions: 3, deletions: 2 },
            isFallback: true,
        });
    });
});
