// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, SessionTreeEntry } from "@crest/agent/harness/types";
import { describe, expect, it, vi } from "vitest";

import { RewindConfirmationRegistry } from "./confirmation-token";
import type { RestorePlanV1 } from "./restore-plan";
import { WorkspaceRewindEngine, type WorkspaceRewindEngineOptions } from "./rewind-engine";
import {
    WorkspaceControlCustomTypes,
    type WorkspaceCheckpointV1,
    type WorkspaceSnapshotRefV1,
    type WorkspaceStateV1,
} from "./types";

const Identity = "1".repeat(64);
const Incarnation = "2".repeat(64);
const CleanFingerprint = "3".repeat(64);
const OldOid = "a".repeat(40);
const NewOid = "b".repeat(40);
const MissingOid = "7".repeat(40);
const SecondOldOid = "8".repeat(40);
const SecondNewOid = "9".repeat(40);

function snapshot(id: string): WorkspaceSnapshotRefV1 {
    return {
        id,
        tree: "c".repeat(40),
        scopeManifest: "d".repeat(40),
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
    };
}

const HeadSnapshot = snapshot("5".repeat(40));
const CompleteCoverage = {
    complete: true,
    eligibleEntryCount: 1,
    newlyHashedBytes: 0,
    exclusions: [],
};
const Workspace = {
    canonicalRoot: "/workspace",
    workspaceIdentity: Identity,
    workspaceIncarnation: Incarnation,
    storeKey: "workspace",
    ancestorIdentityChain: [],
};

function restorePlan(overrides: Partial<RestorePlanV1> = {}): RestorePlanV1 {
    return {
        target: { kind: "rewind", targetTurnId: "turn-1" },
        sessionId: "session-1",
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        semanticLeafId: "old-leaf",
        commitParentId: "transaction-start",
        paths: [
            {
                path: "file.txt",
                operation: "write",
                target: { state: "file", oid: OldOid, executable: false },
                expectedCurrent: { state: "file", oid: NewOid, executable: false },
                liveFingerprint: CleanFingerprint,
                conflict: "none",
            },
        ],
        coverageWarnings: [],
        forceRequired: false,
        hardBlocked: false,
        ...overrides,
    };
}

function userEntry(): SessionTreeEntry {
    return {
        type: "message",
        id: "turn-1",
        parentId: "transaction-start",
        timestamp: "2026-07-29T00:00:00.000Z",
        message: {
            role: "user",
            content: [
                { type: "text", text: "restore " },
                { type: "image", data: "ignored", mimeType: "image/png" },
                { type: "text", text: "this" },
            ],
            timestamp: 0,
        },
    } as SessionTreeEntry;
}

function makeSession(options: { appendError?: Error; appendErrorAfterCommit?: Error } = {}) {
    const metadata: JsonlSessionMetadata = {
        id: "session-1",
        cwd: "/workspace",
        path: "/sessions/session-1.db",
        createdAt: "2026-07-29T00:00:00.000Z",
    };
    const entries: SessionTreeEntry[] = [
        {
            type: "custom",
            id: "transaction-start",
            parentId: null,
            timestamp: "2026-07-29T00:00:00.000Z",
            customType: "context_transaction_manifest",
            data: {},
        },
        userEntry(),
        {
            type: "custom",
            id: "old-leaf",
            parentId: "turn-1",
            timestamp: "2026-07-29T00:00:01.000Z",
            customType: "workspace_checkpoint",
            data: {},
        },
    ];
    let leafId: string | null = "old-leaf";
    let nextId = 0;
    const appendEntries = vi.fn(
        async (appended: SessionTreeEntry[], appendOptions?: { expectedLeafId?: string | null }) => {
            if (appendOptions?.expectedLeafId !== leafId) {
                throw new Error("stale leaf");
            }
            if (options.appendError) {
                throw options.appendError;
            }
            entries.push(...appended);
            leafId = appended.at(-1)?.id ?? leafId;
            if (options.appendErrorAfterCommit) {
                throw options.appendErrorAfterCommit;
            }
        }
    );
    const session = {
        getMetadata: vi.fn(async () => metadata),
        getEntries: vi.fn(async () => [...entries]),
        getBranch: vi.fn(async () => [...entries]),
        getLeafId: vi.fn(async () => leafId),
        getEntry: vi.fn(async (id: string) => entries.find((entry) => entry.id === id)),
        getStorage: vi.fn(() => ({
            createEntryId: vi.fn(async () => `operation-leaf-${++nextId}`),
        })),
        appendEntries,
    };
    return { session: session as never, entries, appendEntries, metadata, leafId: () => leafId };
}

function makeHarness(input: {
    plan?: RestorePlanV1;
    redoPlan?: RestorePlanV1;
    blobs?: Record<string, Buffer | string | Error>;
}) {
    const plan = input.plan ?? restorePlan();
    const session = makeSession();
    const store = {
        storeRoot: "/store",
        identity: Workspace,
        mutationLog: {
            read: vi.fn(),
            findForeignOverlap: vi.fn(),
        },
        readBlob: vi.fn(async (oid: string) => {
            const blob = input.blobs?.[oid] ?? "blob";
            if (blob instanceof Error) throw blob;
            return Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
        }),
        verify: vi.fn(async () => {}),
        verifyUntrustedSnapshot: vi.fn(async () => {}),
    };
    const confirmations = new RewindConfirmationRegistry();
    const snapshotSource = {
        readHead: vi.fn(async () => ({ ref: HeadSnapshot, coverage: CompleteCoverage })),
        synchronizeExternal: vi.fn(async () => ({ ref: HeadSnapshot, coverage: CompleteCoverage })),
        captureOwnedTurn: vi.fn(),
    };
    const options: WorkspaceRewindEngineOptions = {
        store: store as never,
        confirmations,
        snapshotSource: snapshotSource as never,
        locateSession: async () => undefined,
        planRewind: vi.fn(async () => {
            return structuredClone(plan);
        }),
        planRedo: vi.fn(async () => structuredClone(input.redoPlan ?? plan)),
        inspectLivePath: vi.fn(),
        inspectLivePaths: vi.fn(),
    };
    return {
        engine: new WorkspaceRewindEngine(options),
        options,
        confirmations,
        plan,
        session,
        store,
        snapshotSource,
    };
}

describe("WorkspaceRewindEngine transaction", () => {
    it("constructs one pending store and Resolver shared by every restore path", () => {
        const store = {
            storeRoot: "/store",
            identity: Workspace,
            readBlob: vi.fn(),
            readPathState: vi.fn(),
            verify: vi.fn(),
        };
        const engine = new WorkspaceRewindEngine({
            store: store as never,
            confirmations: new RewindConfirmationRegistry(),
            locateSession: async () => undefined,
        });

        expect(engine.executor.pending).toBe((engine as unknown as { pending: unknown }).pending);
        expect(engine.executor.recovery).toBe((engine as unknown as { recovery: unknown }).recovery);
    });

    it("rejects explicitly mismatched pending store and Resolver dependencies", () => {
        const store = {
            storeRoot: "/store",
            identity: Workspace,
            readBlob: vi.fn(),
            readPathState: vi.fn(),
            verify: vi.fn(),
        };
        const pending = { root: "/store/journal/restore-a" };
        const recovery = { pending: { root: "/store/journal/restore-b" } };

        expect(
            () =>
                new WorkspaceRewindEngine({
                    store: store as never,
                    pending: pending as never,
                    recovery: recovery as never,
                    confirmations: new RewindConfirmationRegistry(),
                })
        ).toThrow(/pending store/i);
    });

    it("projects rewind in reverse and redo forward without exposing immutable content", async () => {
        const rewindPlan = restorePlan();
        const redoPlan = restorePlan({
            target: {
                kind: "redo",
                sourceRewindOperationId: "rewind-operation-1",
                linkedOperation: {
                    operationId: "rewind-operation-1",
                    sourceSnapshot: snapshot("6".repeat(40)),
                    currentSnapshot: snapshot("7".repeat(40)),
                },
            },
            semanticLeafId: "operation-leaf-1",
            paths: [
                {
                    path: "file.txt",
                    operation: "write",
                    target: { state: "file", oid: NewOid, executable: false },
                    expectedCurrent: { state: "file", oid: OldOid, executable: false },
                    liveFingerprint: CleanFingerprint,
                    conflict: "none",
                },
            ],
        });
        const value = makeHarness({
            plan: rewindPlan,
            redoPlan,
            blobs: { [OldOid]: "checkpoint A\n", [NewOid]: "checkpoint B\n" },
        });

        const rewindPreview = await value.engine.previewRewind({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "old-leaf",
            targetTurnId: "turn-1",
        });
        expect(value.options.planRewind).toHaveBeenCalledWith(
            expect.objectContaining({ mutationLog: value.store.mutationLog })
        );
        expect(rewindPreview.files[0]).toMatchObject({ operation: "write", additions: 1, deletions: 1 });
        expect(rewindPreview.files[0]!.diff).toContain("-checkpoint B");
        expect(rewindPreview.files[0]!.diff).toContain("+checkpoint A");
        value.session.entries.push({
            type: "custom",
            id: "operation-leaf-1",
            parentId: "transaction-start",
            timestamp: "2026-07-29T00:00:02.000Z",
            customType: WorkspaceControlCustomTypes.state,
            data: {
                schemaVersion: 1,
                sessionId: "session-1",
                operationId: "rewind-operation-1",
                workspaceIdentity: Identity,
                workspaceIncarnation: Incarnation,
                kind: "rewind",
                applyMode: "normal",
                forcedPaths: [],
                sourceSnapshot: snapshot("6".repeat(40)),
                currentSnapshot: snapshot("7".repeat(40)),
                currentStates: [],
                rewind: {
                    fromLeafId: "old-leaf",
                    targetTurnId: "turn-1",
                    targetBoundaryId: "transaction-start",
                    redoStates: [],
                },
            } satisfies WorkspaceStateV1,
        } as SessionTreeEntry);
        const redoPreview = await value.engine.previewRedo({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "operation-leaf-1",
        });
        expect(redoPreview.files[0]).toMatchObject({ operation: "write", additions: 1, deletions: 1 });
        expect(redoPreview.files[0]!.diff).toContain("-checkpoint A");
        expect(redoPreview.files[0]!.diff).toContain("+checkpoint B");
        expect(redoPreview.files[0]!.diff).not.toBe(rewindPreview.files[0]!.diff);
        for (const row of [...rewindPreview.files, ...redoPreview.files]) {
            expect(row).not.toHaveProperty("originalContent");
            expect(row).not.toHaveProperty("modifiedContent");
        }
    });

    it("counts only reverted user messages in rewind previews", async () => {
        const value = makeHarness({ plan: restorePlan() });
        const assistant: SessionTreeEntry = {
            type: "message",
            id: "assistant-1",
            parentId: "turn-1",
            timestamp: "2026-07-29T00:00:00.500Z",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "working" }],
                timestamp: 0,
            },
        } as SessionTreeEntry;
        value.session.entries.splice(2, 0, assistant);
        value.session.entries[3]!.parentId = assistant.id;

        const preview = await value.engine.previewRewind({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "old-leaf",
            targetTurnId: "turn-1",
        });

        expect(preview.messageCount).toBe(1);
    });

    it("keeps planner authority and other rows when one immutable blob is unavailable", async () => {
        const plan = restorePlan({
            paths: [
                {
                    path: "missing.txt",
                    operation: "write",
                    target: { state: "file", oid: OldOid, executable: false },
                    expectedCurrent: { state: "file", oid: MissingOid, executable: false },
                    liveFingerprint: CleanFingerprint,
                    conflict: "forceable-drift",
                    reason: "live file drifted",
                },
                {
                    path: "healthy.txt",
                    operation: "write",
                    target: { state: "file", oid: SecondOldOid, executable: false },
                    expectedCurrent: { state: "file", oid: SecondNewOid, executable: false },
                    liveFingerprint: CleanFingerprint,
                    conflict: "none",
                },
            ],
            forceRequired: true,
        });
        const value = makeHarness({
            plan,
            blobs: {
                [MissingOid]: new Error("sensitive blob failure"),
                [OldOid]: "missing target\n",
                [SecondNewOid]: "healthy before\n",
                [SecondOldOid]: "healthy after\n",
            },
        });

        const preview = await value.engine.previewRewind({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "old-leaf",
            targetTurnId: "turn-1",
        });

        expect(preview.confirmationToken).toBeTypeOf("string");
        expect(preview.fileCount).toBe(2);
        expect(preview.files).toHaveLength(2);
        expect(preview.files[0]).toMatchObject({
            path: "missing.txt",
            operation: "write",
            coverage: "covered",
            conflict: "forceable-drift",
            reason: "live file drifted",
            previewUnavailableReason: "snapshot blob is unavailable",
        });
        expect(preview.files[1]).toMatchObject({
            path: "healthy.txt",
            operation: "write",
            additions: 1,
            deletions: 1,
            coverage: "covered",
            conflict: "none",
        });
        expect(preview.files[1]!.diff).toContain("-healthy before");
        expect(preview.files[1]!.diff).toContain("+healthy after");
        expect(value.store.readBlob.mock.calls.map(([oid]) => oid)).toEqual([
            MissingOid,
            OldOid,
            SecondNewOid,
            SecondOldOid,
        ]);
    });

    it("projects immutable turn summary, review, and file diff without live disk inspection or confirmation", async () => {
        const checkpoint: WorkspaceCheckpointV1 = {
            schemaVersion: 1,
            status: "available",
            originSessionId: "session-1",
            turnId: "turn-1",
            workspaceIdentity: Identity,
            workspaceIncarnation: Incarnation,
            before: snapshot("1".repeat(40)),
            after: snapshot("2".repeat(40)),
            changes: [
                {
                    path: "src/file.ts",
                    before: { state: "file", oid: OldOid, executable: false },
                    after: { state: "file", oid: NewOid, executable: false },
                },
            ],
            coverage: { complete: true, eligibleEntryCount: 1, newlyHashedBytes: 0, exclusions: [] },
        };
        const entries: SessionTreeEntry[] = [
            { ...userEntry(), parentId: null },
            {
                type: "custom",
                id: "checkpoint-1",
                parentId: "turn-1",
                timestamp: "2026-07-29T00:00:01.000Z",
                customType: WorkspaceControlCustomTypes.checkpoint,
                data: checkpoint,
            },
        ];
        const session = { getEntries: vi.fn(async () => entries) };
        const value = makeHarness({ blobs: { [OldOid]: "old\n", [NewOid]: "new\nadded\n" } });
        const issue = vi.spyOn(value.confirmations, "issue");
        vi.mocked(value.options.inspectLivePath!).mockClear();
        vi.mocked(value.options.inspectLivePaths!).mockClear();
        const input = {
            session: session as never,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "checkpoint-1",
            sourceTurnId: "turn-1",
        };

        const summary = await value.engine.getTurnChangeSummary(input);
        const review = await value.engine.reviewTurnChanges(input);
        const file = await value.engine.getTurnFileDiff({ ...input, path: "src/file.ts" });
        const historicalFile = await value.engine.getTurnFileDiff({
            ...input,
            semanticLeafId: null,
            path: "src/file.ts",
        });

        expect(summary).toEqual({
            turnId: "turn-1",
            semanticLeafId: "checkpoint-1",
            fileCount: 1,
            additions: 2,
            deletions: 1,
            files: [{ path: "src/file.ts", operation: "write", additions: 2, deletions: 1 }],
        });
        expect(summary.files[0]).not.toHaveProperty("diff");
        expect(review).toMatchObject({
            turnId: "turn-1",
            semanticLeafId: "checkpoint-1",
            files: [{ path: "src/file.ts", operation: "write", additions: 2, deletions: 1 }],
        });
        expect(review.files[0]?.diff).toContain("-old");
        expect(file).toMatchObject({
            turnId: "turn-1",
            path: "src/file.ts",
            operation: "write",
            additions: 2,
            deletions: 1,
            originalContent: "old\n",
            modifiedContent: "new\nadded\n",
            isBinary: false,
            truncated: false,
        });
        expect(file.fallbackPatch).toContain("+added");
        expect(historicalFile).toEqual(file);
        expect(issue).not.toHaveBeenCalled();
        expect(value.options.inspectLivePath).not.toHaveBeenCalled();
        expect(value.options.inspectLivePaths).not.toHaveBeenCalled();
        expect(value.store.verifyUntrustedSnapshot).toHaveBeenCalledTimes(8);
        expect(value.store.verify).not.toHaveBeenCalled();

        entries.push({ ...userEntry(), id: "turn-2", parentId: null });
        await expect(
            value.engine.getTurnFileDiff({
                ...input,
                semanticLeafId: null,
                path: "src/file.ts",
            })
        ).rejects.toThrow(/checkpoint is unavailable/i);
    });

    it("fences immutable turn reads to the expected active semantic leaf", async () => {
        const value = makeHarness({});
        const session = { getEntries: vi.fn(async () => [userEntry()]) };

        await expect(
            value.engine.getTurnChangeSummary({
                session: session as never,
                sessionId: "session-1",
                workspace: Workspace,
                semanticLeafId: "stale-leaf",
                sourceTurnId: "turn-1",
            })
        ).rejects.toThrow(/semantic leaf changed/i);
    });

    it("projects only the requested checkpoint path for a single-file diff", async () => {
        const checkpoint: WorkspaceCheckpointV1 = {
            schemaVersion: 1,
            status: "available",
            originSessionId: "session-1",
            turnId: "turn-1",
            workspaceIdentity: Identity,
            workspaceIncarnation: Incarnation,
            before: snapshot("1".repeat(40)),
            after: snapshot("2".repeat(40)),
            changes: [
                {
                    path: "unrelated.txt",
                    before: { state: "file", oid: MissingOid, executable: false },
                    after: { state: "file", oid: SecondOldOid, executable: false },
                },
                {
                    path: "target.txt",
                    before: { state: "file", oid: OldOid, executable: false },
                    after: { state: "file", oid: NewOid, executable: false },
                },
            ],
            coverage: { complete: true, eligibleEntryCount: 1, newlyHashedBytes: 0, exclusions: [] },
        };
        const session = {
            getEntries: vi.fn(async () => [
                { ...userEntry(), parentId: null },
                {
                    type: "custom",
                    id: "checkpoint-1",
                    parentId: "turn-1",
                    timestamp: "2026-07-29T00:00:01.000Z",
                    customType: WorkspaceControlCustomTypes.checkpoint,
                    data: checkpoint,
                },
            ]),
        };
        const value = makeHarness({
            blobs: {
                [MissingOid]: new Error("unrelated blob must not be read"),
                [SecondOldOid]: "unrelated\n",
                [OldOid]: "old\n",
                [NewOid]: "new\n",
            },
        });

        const file = await value.engine.getTurnFileDiff({
            session: session as never,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "checkpoint-1",
            sourceTurnId: "turn-1",
            path: "target.txt",
        });

        expect(file).toMatchObject({ path: "target.txt", originalContent: "old\n", modifiedContent: "new\n" });
        expect(value.store.readBlob).toHaveBeenCalledTimes(2);
        expect(value.store.readBlob).toHaveBeenNthCalledWith(1, OldOid);
        expect(value.store.readBlob).toHaveBeenNthCalledWith(2, NewOid);
    });

    it("reports unavailable summary statistics explicitly and caps aggregate review input", async () => {
        const binary = Buffer.alloc(900_000, 1);
        binary[0] = 0;
        const changes = Array.from({ length: 5 }, (_, index) => ({
            path: `binary-${index}.dat`,
            before: { state: "file" as const, oid: (index + 1).toString(16).repeat(40), executable: false },
            after: { state: "file" as const, oid: (index + 6).toString(16).repeat(40), executable: false },
        }));
        const checkpoint: WorkspaceCheckpointV1 = {
            schemaVersion: 1,
            status: "available",
            originSessionId: "session-1",
            turnId: "turn-1",
            workspaceIdentity: Identity,
            workspaceIncarnation: Incarnation,
            before: snapshot("1".repeat(40)),
            after: snapshot("2".repeat(40)),
            changes,
            coverage: { complete: true, eligibleEntryCount: 1, newlyHashedBytes: 0, exclusions: [] },
        };
        const session = {
            getEntries: vi.fn(async () => [
                { ...userEntry(), parentId: null },
                {
                    type: "custom",
                    id: "checkpoint-1",
                    parentId: "turn-1",
                    timestamp: "2026-07-29T00:00:01.000Z",
                    customType: WorkspaceControlCustomTypes.checkpoint,
                    data: checkpoint,
                },
            ]),
        };
        const blobs = Object.fromEntries(
            changes.flatMap((change) => [
                [change.before.oid, binary],
                [change.after.oid, binary],
            ])
        );
        const value = makeHarness({ blobs });
        const input = {
            session: session as never,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "checkpoint-1",
            sourceTurnId: "turn-1",
        };

        const summary = await value.engine.getTurnChangeSummary(input);
        const review = await value.engine.reviewTurnChanges(input);

        expect(summary.additions).toBeNull();
        expect(summary.deletions).toBeNull();
        expect(summary.files).toEqual(
            changes.map((change) => ({
                path: change.path,
                operation: "write",
                additions: null,
                deletions: null,
            }))
        );
        expect(review.files.map((file) => file.previewUnavailableReason)).toEqual([
            "binary file",
            "binary file",
            "binary file",
            "binary file",
            "request exceeds preview input limit",
        ]);
    });
});
