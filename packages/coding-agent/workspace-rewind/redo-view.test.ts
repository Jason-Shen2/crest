// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { projectRedoFileRows } from "./redo-view";
import type { WorkspaceStateV1 } from "./types";

const BeforeOid = "a".repeat(40);
const AfterOid = "b".repeat(40);

function marker(overrides: Partial<Extract<WorkspaceStateV1, { kind: "rewind" }>> = {}) {
    return {
        schemaVersion: 1,
        sessionId: "session-1",
        operationId: "operation-1",
        workspaceIdentity: "workspace-1",
        workspaceIncarnation: "incarnation-1",
        kind: "rewind",
        applyMode: "normal",
        forcedPaths: [],
        sourceSnapshot: {
            id: "4".repeat(40),
            tree: "5".repeat(40),
            scopeManifest: "6".repeat(40),
            workspaceIdentity: "workspace-1",
            workspaceIncarnation: "incarnation-1",
        },
        currentSnapshot: {
            id: "1".repeat(40),
            tree: "2".repeat(40),
            scopeManifest: "3".repeat(40),
            workspaceIdentity: "workspace-1",
            workspaceIncarnation: "incarnation-1",
        },
        currentStates: [
            {
                path: "docs/README.md",
                state: { state: "file", oid: BeforeOid, executable: false },
            },
        ],
        rewind: {
            fromLeafId: "assistant-1",
            targetTurnId: "user-1",
            targetBoundaryId: null,
            redoStates: [
                {
                    path: "docs/README.md",
                    state: { state: "file", oid: AfterOid, executable: false },
                },
            ],
        },
        ...overrides,
    } satisfies Extract<WorkspaceStateV1, { kind: "rewind" }>;
}

describe("projectRedoFileRows", () => {
    it("projects current to redo file changes without inspecting live disk", async () => {
        const readBlob = vi.fn(async (oid: string) => {
            if (oid === BeforeOid) return Buffer.from("before\n");
            if (oid === AfterOid) return Buffer.from("after\nextra\n");
            throw new Error("unexpected oid");
        });

        const files = await projectRedoFileRows(marker(), readBlob);

        expect(files).toEqual([
            expect.objectContaining({
                path: "docs/README.md",
                operation: "write",
                additions: 2,
                deletions: 1,
                coverage: "covered",
                conflict: "none",
            }),
        ]);
        expect(files?.[0]?.diff).toContain("-before");
        expect(files?.[0]?.diff).toContain("+after");
        expect(readBlob.mock.calls.map(([oid]) => oid)).toEqual([BeforeOid, AfterOid]);
    });

    it("rejects a marker that lacks the expected current path state", async () => {
        const files = await projectRedoFileRows(marker({ currentStates: [] }), vi.fn());

        expect(files).toBeUndefined();
    });

    it("keeps the file row when immutable diff content is unavailable", async () => {
        const files = await projectRedoFileRows(
            marker(),
            vi.fn(async () => {
                throw new Error("missing blob");
            })
        );

        expect(files).toEqual([
            expect.objectContaining({
                path: "docs/README.md",
                operation: "write",
                coverage: "unavailable",
                conflict: "none",
                previewUnavailableReason: "snapshot blob is unavailable",
            }),
        ]);
    });
});
