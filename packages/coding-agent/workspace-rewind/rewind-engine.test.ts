// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, SessionTreeEntry } from "@crest/agent/harness/types";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { RewindConfirmationRegistry } from "./confirmation-token";
import type { WorkspaceOperationJournalV2 } from "./recovery-journal";
import { planRedo, type RestorePlanV1 } from "./restore-plan";
import { WorkspaceRewindEngine, type WorkspaceRewindEngineOptions } from "./rewind-engine";
import {
    WorkspaceControlCustomTypes,
    type CapturedPathStateV1,
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

const SafetySnapshot = snapshot("5".repeat(40));
const ResultSnapshot = snapshot("6".repeat(40));
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
    turnUndoPlan?: RestorePlanV1;
    turnRedoPlan?: RestorePlanV1;
    blobs?: Record<string, Buffer | string | Error>;
    preStates?: Record<string, CapturedPathStateV1>;
    failApplyAt?: string;
    appendError?: Error;
    appendErrorAfterCommit?: Error;
    failBroadcast?: boolean;
    failCleanup?: boolean;
    recoverError?: Error;
    useRealPlanRedo?: boolean;
}) {
    const order: string[] = [];
    const plan = input.plan ?? restorePlan();
    const session = makeSession({
        appendError: input.appendError,
        appendErrorAfterCommit: input.appendErrorAfterCommit,
    });
    let record: WorkspaceOperationJournalV2 | undefined;
    const liveStates = new Map(
        plan.paths.map((path) => [path.path, input.preStates?.[path.path] ?? path.expectedCurrent])
    );
    const journal = {
        begin: vi.fn(async (next: WorkspaceOperationJournalV2) => {
            order.push("operation-ref", "prepared");
            record = structuredClone(next);
        }),
        transition: vi.fn(async (_operationId: string, phase: WorkspaceOperationJournalV2["phase"], patch = {}) => {
            order.push(phase);
            record = { ...record!, ...patch, phase };
            return structuredClone(record);
        }),
        updatePathProgress: vi.fn(async () => record!),
        read: vi.fn(async () => structuredClone(record!)),
        completeCleanup: vi.fn(async () => {
            order.push("remove-journal");
            if (input.failCleanup) throw new Error("cleanup failed");
            order.push("remove-operation-ref");
        }),
    };
    let captureCount = 0;
    const store = {
        identity: Workspace,
        capture: vi.fn(async (_options: { profile: string; requiredPaths?: readonly string[] }) => {
            captureCount++;
            order.push(captureCount === 1 ? "safety-capture" : "result-capture");
            return {
                ref: captureCount === 1 ? SafetySnapshot : ResultSnapshot,
                coverage: {
                    complete: true,
                    eligibleEntryCount: 1,
                    newlyHashedBytes: 0,
                    exclusions: [],
                },
            };
        }),
        readPathState: vi.fn(async (ref: WorkspaceSnapshotRefV1, path: string) => {
            if (ref.id === SafetySnapshot.id) return liveStates.get(path)!;
            return plan.paths.find((item) => item.path === path)!.target;
        }),
        readBlob: vi.fn(async (oid: string) => {
            const blob = input.blobs?.[oid] ?? "blob";
            if (blob instanceof Error) throw blob;
            return Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
        }),
        verify: vi.fn(async () => {}),
        anchorSnapshot: vi.fn(async () => {
            if (!order.includes("anchor-session-refs")) order.push("anchor-session-refs");
        }),
    };
    const onCommitted = vi.fn(async () => {
        order.push("broadcast");
        if (input.failBroadcast) throw new Error("broadcast failed");
    });
    const recovery = {
        isExactOperationLeaf: vi.fn(async (_session, _record, leafId: string | null) => {
            order.push("verify-exact-leaf");
            return leafId === record?.workspaceStateEntryId;
        }),
        recoverRecord: vi.fn(async () => {
            order.push("classifier-recovery");
            if (input.recoverError) throw input.recoverError;
            if (session.leafId() === record!.workspaceStateEntryId) {
                record = await journal.transition(record!.operationId, "completed");
                await onCommitted();
                await journal.completeCleanup();
                return;
            }
            for (const path of record!.paths) liveStates.set(path.path, path.preState);
        }),
    };
    const confirmations = new RewindConfirmationRegistry();
    const options: WorkspaceRewindEngineOptions = {
        store: store as never,
        journal: journal as never,
        recovery: recovery as never,
        confirmations,
        createOperationId: () => "operation-1",
        now: () => new Date("2026-07-29T00:00:02.000Z"),
        planRewind: vi.fn(async () => {
            order.push("recompute-plan");
            return structuredClone(plan);
        }),
        planRedo: input.useRealPlanRedo ? planRedo : vi.fn(async () => structuredClone(input.redoPlan ?? plan)),
        planTurnUndo: vi.fn(async () => structuredClone(input.turnUndoPlan ?? plan)),
        planTurnRedo: vi.fn(async () => structuredClone(input.turnRedoPlan ?? plan)),
        inspectLivePath: vi.fn(
            async (path: string) =>
                ({
                    ...liveStates.get(path)!,
                    fingerprint: plan.paths.find((item) => item.path === path)!.liveFingerprint,
                }) as never
        ),
        inspectLivePaths: vi.fn(
            async (paths: readonly string[]) =>
                new Map(
                    paths.map((path) => [
                        path,
                        {
                            ...liveStates.get(path)!,
                            fingerprint: plan.paths.find((item) => item.path === path)!.liveFingerprint,
                        },
                    ])
                ) as never
        ),
        applyPath: vi.fn(async ({ path, target, progress }) => {
            order.push(`write:${path}`);
            liveStates.set(path, target);
            await progress.onPathReplaced?.();
            if (input.failApplyAt === path) throw new Error(`apply failed: ${path}`);
        }),
        verifyPath: vi.fn(async ({ path, expected }) => {
            order.push(`verify:${path}`);
            expect(liveStates.get(path)).toEqual(expected);
        }),
        onCommitted,
    };
    return {
        engine: new WorkspaceRewindEngine(options),
        options,
        confirmations,
        plan,
        session,
        store,
        journal,
        recovery,
        liveStates,
        order,
        record: () => record!,
    };
}

describe("WorkspaceRewindEngine transaction", () => {
    it("projects rewind in reverse and redo forward from immutable restore-plan states", async () => {
        const rewindPlan = restorePlan();
        const redoPlan = restorePlan({
            target: { kind: "redo" },
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

        expect(rewindPreview.files[0]).toMatchObject({ operation: "write", additions: 1, deletions: 1 });
        expect(rewindPreview.files[0]!.diff).toContain("-checkpoint B");
        expect(rewindPreview.files[0]!.diff).toContain("+checkpoint A");

        const confirmation = value.confirmations.take(rewindPreview.confirmationToken!);
        await value.engine.applyRewind({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "old-leaf",
            targetTurnId: "turn-1",
            mode: "normal",
            confirmation,
        });
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

    it("orders every durable boundary, CAS commit point, broadcast, and cleanup", async () => {
        const value = makeHarness({});
        const confirmation = value.confirmations.take(value.confirmations.issue(value.plan));

        const result = await value.engine.applyRewind({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "old-leaf",
            targetTurnId: "turn-1",
            mode: "normal",
            confirmation,
        });

        expect(value.order).toEqual([
            "recompute-plan",
            "safety-capture",
            "operation-ref",
            "prepared",
            "applying_files",
            "write:file.txt",
            "result-capture",
            "verify:file.txt",
            "files_verified",
            "anchor-session-refs",
            "committing_session",
            "verify-exact-leaf",
            "completed",
            "broadcast",
            "remove-journal",
            "remove-operation-ref",
        ]);
        expect(value.session.appendEntries).toHaveBeenCalledWith(
            [expect.objectContaining({ id: "operation-leaf-1", parentId: "transaction-start" })],
            { expectedLeafId: "old-leaf" }
        );
        expect(result).toMatchObject({
            semanticLeafId: "operation-leaf-1",
            displayLeafId: "transaction-start",
            editorText: "restore this",
        });
    });

    it("records a complete force safety preimage and the exact confirmed conflict set before writing", async () => {
        const driftState = { state: "file", oid: "e".repeat(40), executable: true } as const;
        const driftFingerprint = createHash("sha256")
            .update(JSON.stringify(["file", driftState.oid, driftState.executable]))
            .digest("hex");
        const plan = restorePlan({
            paths: [
                {
                    path: "drift.bin",
                    operation: "write",
                    target: { state: "file", oid: OldOid, executable: false },
                    expectedCurrent: { state: "file", oid: NewOid, executable: false },
                    liveFingerprint: driftFingerprint,
                    conflict: "forceable-drift",
                },
            ],
            forceRequired: true,
        });
        const value = makeHarness({ plan, preStates: { "drift.bin": driftState } });
        const confirmation = value.confirmations.take(value.confirmations.issue(plan));

        await value.engine.applyRewind({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "old-leaf",
            targetTurnId: "turn-1",
            mode: "force-drift",
            confirmation,
        });

        expect(value.store.capture).toHaveBeenNthCalledWith(1, {
            profile: "safety",
            requiredPaths: ["drift.bin"],
        });
        expect(value.record().confirmedConflictFingerprints).toEqual([
            { path: "drift.bin", fingerprint: driftFingerprint },
        ]);
        expect(value.record().paths[0]!.preState).toEqual(driftState);
        expect(value.options.applyPath).toHaveBeenCalledWith(
            expect.objectContaining({
                path: "drift.bin",
                expectedCurrent: driftState,
            })
        );
        const marker = value.session.entries.at(-1) as Extract<SessionTreeEntry, { type: "custom" }>;
        expect(marker.data).toMatchObject({
            applyMode: "force-drift",
            forcedPaths: ["drift.bin"],
            rewind: {
                fromLeafId: "old-leaf",
                redoSnapshot: SafetySnapshot,
                redoStates: [{ path: "drift.bin", state: driftState }],
            },
        });
    });

    it("commits a branch-only no-op without performing selective filesystem writes", async () => {
        const value = makeHarness({ plan: restorePlan({ paths: [] }) });
        const confirmation = value.confirmations.take(value.confirmations.issue(value.plan));

        await value.engine.applyRewind({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "old-leaf",
            targetTurnId: "turn-1",
            mode: "normal",
            confirmation,
        });

        expect(value.options.applyPath).not.toHaveBeenCalled();
        expect(value.session.appendEntries).toHaveBeenCalledOnce();
    });

    it.each(["file.txt", "second.txt"])(
        "uses Task 11 classifier recovery for a pre-CAS failure at %s",
        async (failedPath) => {
            const plan = restorePlan({
                paths: [
                    restorePlan().paths[0]!,
                    {
                        path: "second.txt",
                        operation: "delete",
                        target: { state: "absent" },
                        expectedCurrent: { state: "file", oid: NewOid, executable: false },
                        liveFingerprint: CleanFingerprint,
                        conflict: "none",
                    },
                ],
            });
            const value = makeHarness({ plan, failApplyAt: failedPath });
            const confirmation = value.confirmations.take(value.confirmations.issue(plan));

            await expect(
                value.engine.applyRewind({
                    session: value.session.session,
                    sessionId: "session-1",
                    workspace: Workspace,
                    semanticLeafId: "old-leaf",
                    targetTurnId: "turn-1",
                    mode: "normal",
                    confirmation,
                })
            ).rejects.toThrow(/apply failed/);

            expect(value.recovery.recoverRecord).toHaveBeenCalledOnce();
            expect(value.session.appendEntries).not.toHaveBeenCalled();
            for (const path of value.record().paths) {
                expect(value.liveStates.get(path.path)).toEqual(path.preState);
            }
        }
    );

    it("classifier-rolls back a SQLite CAS failure without changing the session leaf", async () => {
        const value = makeHarness({ appendError: new Error("stale leaf CAS") });
        const confirmation = value.confirmations.take(value.confirmations.issue(value.plan));

        await expect(
            value.engine.applyRewind({
                session: value.session.session,
                sessionId: "session-1",
                workspace: Workspace,
                semanticLeafId: "old-leaf",
                targetTurnId: "turn-1",
                mode: "normal",
                confirmation,
            })
        ).rejects.toThrow(/stale leaf CAS/);

        expect(value.recovery.recoverRecord).toHaveBeenCalledOnce();
        expect(value.session.leafId()).toBe("old-leaf");
        expect(value.liveStates.get("file.txt")).toEqual(value.record().paths[0]!.preState);
    });

    it("finishes from Task 11 recovery when SQLite commits before appendEntries throws", async () => {
        const value = makeHarness({ appendErrorAfterCommit: new Error("wrapper failed after commit") });
        const confirmation = value.confirmations.take(value.confirmations.issue(value.plan));

        const result = await value.engine.applyRewind({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "old-leaf",
            targetTurnId: "turn-1",
            mode: "normal",
            confirmation,
        });

        expect(result.semanticLeafId).toBe("operation-leaf-1");
        expect(value.session.leafId()).toBe("operation-leaf-1");
        expect(value.recovery.recoverRecord).toHaveBeenCalledOnce();
        expect(value.options.onCommitted).toHaveBeenCalledOnce();
        expect(value.liveStates.get("file.txt")).toEqual(value.plan.paths[0]!.target);
        expect(value.order.slice(-6)).toEqual([
            "classifier-recovery",
            "completed",
            "broadcast",
            "remove-journal",
            "remove-operation-ref",
            "verify-exact-leaf",
        ]);
    });

    it("never performs a broad rollback when Task 11 classifies a third-party write as unknown", async () => {
        const frozen = new Error("unknown live path state");
        const value = makeHarness({ failApplyAt: "file.txt", recoverError: frozen });
        const confirmation = value.confirmations.take(value.confirmations.issue(value.plan));

        await expect(
            value.engine.applyRewind({
                session: value.session.session,
                sessionId: "session-1",
                workspace: Workspace,
                semanticLeafId: "old-leaf",
                targetTurnId: "turn-1",
                mode: "normal",
                confirmation,
            })
        ).rejects.toThrow(/unknown live path state/);

        expect(value.recovery.recoverRecord).toHaveBeenCalledOnce();
        expect(value.liveStates.get("file.txt")).toEqual(value.plan.paths[0]!.target);
    });

    it.each(["broadcast", "cleanup"] as const)(
        "does not invoke rollback after the SQLite commit when %s fails",
        async (failure) => {
            const value = makeHarness({
                failBroadcast: failure === "broadcast",
                failCleanup: failure === "cleanup",
            });
            const confirmation = value.confirmations.take(value.confirmations.issue(value.plan));

            await expect(
                value.engine.applyRewind({
                    session: value.session.session,
                    sessionId: "session-1",
                    workspace: Workspace,
                    semanticLeafId: "old-leaf",
                    targetTurnId: "turn-1",
                    mode: "normal",
                    confirmation,
                })
            ).rejects.toThrow(new RegExp(failure));

            expect(value.session.leafId()).toBe("operation-leaf-1");
            expect(value.liveStates.get("file.txt")).toEqual(value.plan.paths[0]!.target);
            expect(value.recovery.recoverRecord).not.toHaveBeenCalled();
            expect(value.record().phase).toBe("completed");
        }
    );

    it("rejects a changed conflict set or fingerprint before safety capture and first write", async () => {
        const confirmedPlan = restorePlan();
        const value = makeHarness({
            plan: restorePlan({
                paths: [{ ...restorePlan().paths[0]!, liveFingerprint: "f".repeat(64) }],
            }),
        });
        const confirmation = value.confirmations.take(value.confirmations.issue(confirmedPlan));

        await expect(
            value.engine.applyRewind({
                session: value.session.session,
                sessionId: "session-1",
                workspace: Workspace,
                semanticLeafId: "old-leaf",
                targetTurnId: "turn-1",
                mode: "normal",
                confirmation,
            })
        ).rejects.toThrow(/stale/i);

        expect(value.store.capture).not.toHaveBeenCalled();
        expect(value.options.applyPath).not.toHaveBeenCalled();
    });

    it("invalidates redo after a new prompt advances the raw branch beyond the rewind marker", async () => {
        const value = makeHarness({ useRealPlanRedo: true });
        const confirmation = value.confirmations.take(value.confirmations.issue(value.plan));
        await value.engine.applyRewind({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "old-leaf",
            targetTurnId: "turn-1",
            mode: "normal",
            confirmation,
        });
        await value.session.appendEntries(
            [
                {
                    type: "message",
                    id: "new-turn",
                    parentId: "operation-leaf-1",
                    timestamp: "2026-07-29T00:00:03.000Z",
                    message: { role: "user", content: "continue", timestamp: 0 },
                } as SessionTreeEntry,
            ],
            { expectedLeafId: "operation-leaf-1" }
        );

        const preview = await value.engine.previewRedo({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "new-turn",
        });

        expect(preview.hardBlocked).toBe(true);
        expect(preview.confirmationToken).toBeUndefined();
        expect(preview.coverageWarnings).toContainEqual(expect.stringMatching(/current raw leaf.*rewind marker/i));
    });

    it("uses a later turn marker for rewind CAS authority and rejects conversation redo", async () => {
        const value = makeHarness({});
        const confirmation = value.confirmations.take(value.confirmations.issue(value.plan));
        await value.engine.applyRewind({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "old-leaf",
            targetTurnId: "turn-1",
            mode: "normal",
            confirmation,
        });
        const turnMarker = {
            schemaVersion: 1,
            sessionId: "session-1",
            operationId: "turn-undo-operation",
            workspaceIdentity: Identity,
            workspaceIncarnation: Incarnation,
            kind: "turn-undo",
            sourceTurnId: "turn-1",
            applyMode: "normal",
            forcedPaths: [],
            currentSnapshot: ResultSnapshot,
            currentStates: [],
        } satisfies WorkspaceStateV1;
        await value.session.appendEntries(
            [
                {
                    type: "custom",
                    id: "turn-marker",
                    parentId: "operation-leaf-1",
                    timestamp: "2026-07-29T00:00:03.000Z",
                    customType: "workspace_state",
                    data: turnMarker,
                },
            ],
            { expectedLeafId: "operation-leaf-1" }
        );

        await value.engine.previewRewind({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "turn-marker",
            targetTurnId: "turn-1",
        });
        const redoPreview = await value.engine.previewRedo({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "turn-marker",
        });

        expect(value.options.planRewind).toHaveBeenLastCalledWith(
            expect.objectContaining({ currentWorkspaceState: turnMarker })
        );
        expect(redoPreview.hardBlocked).toBe(true);
        expect(redoPreview.confirmationToken).toBeUndefined();
    });

    it("keeps turn Undo and Redo on the current semantic branch while preserving the display leaf", async () => {
        const undoPlan = restorePlan({
            target: { kind: "turn-undo", sourceTurnId: "turn-1" },
            commitParentId: "old-leaf",
            paths: [],
        });
        const value = makeHarness({ turnUndoPlan: undoPlan });
        const undoPreview = await value.engine.previewTurnUndo({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "old-leaf",
            sourceTurnId: "turn-1",
        });
        const undo = await value.engine.applyTurnUndo({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "old-leaf",
            sourceTurnId: "turn-1",
            mode: "normal",
            confirmation: value.confirmations.take(undoPreview.confirmationToken!),
        });

        expect(value.session.entries.at(-1)).toMatchObject({
            parentId: "old-leaf",
            data: { kind: "turn-undo", sourceTurnId: "turn-1" },
        });
        expect(undo).toMatchObject({
            semanticLeafId: "operation-leaf-1",
            displayLeafId: undoPreview.displayLeafId,
        });

        const redoPlan = restorePlan({
            target: {
                kind: "turn-redo",
                sourceTurnId: "turn-1",
                undoOperationId: "operation-1",
            },
            semanticLeafId: "operation-leaf-1",
            commitParentId: "operation-leaf-1",
            paths: [],
        });
        Object.assign(value.options, { planTurnRedo: vi.fn(async () => structuredClone(redoPlan)) });
        const redoEngine = new WorkspaceRewindEngine(value.options);
        const redoPreview = await redoEngine.previewTurnRedo({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "operation-leaf-1",
            sourceTurnId: "turn-1",
            undoOperationId: "operation-1",
        });
        const redo = await redoEngine.applyTurnRedo({
            session: value.session.session,
            sessionId: "session-1",
            workspace: Workspace,
            semanticLeafId: "operation-leaf-1",
            sourceTurnId: "turn-1",
            undoOperationId: "operation-1",
            confirmation: value.confirmations.take(redoPreview.confirmationToken!),
        });

        expect(value.session.entries.at(-1)).toMatchObject({
            parentId: "operation-leaf-1",
            data: {
                kind: "turn-redo",
                sourceTurnId: "turn-1",
                undoOperationId: "operation-1",
            },
        });
        expect(redo).toMatchObject({
            semanticLeafId: "operation-leaf-2",
            displayLeafId: undoPreview.displayLeafId,
        });
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
