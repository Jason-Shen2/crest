// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, SessionTreeEntry } from "@crest/agent/harness/types";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { RewindConfirmationRegistry } from "./confirmation-token";
import type { WorkspaceOperationJournalV1 } from "./recovery-journal";
import { planRedo, type RestorePlanV1 } from "./restore-plan";
import { WorkspaceRewindEngine, type WorkspaceRewindEngineOptions } from "./rewind-engine";
import type { CapturedPathStateV1, WorkspaceSnapshotRefV1 } from "./types";

const Identity = "1".repeat(64);
const Incarnation = "2".repeat(64);
const CleanFingerprint = "3".repeat(64);
const OldOid = "a".repeat(40);
const NewOid = "b".repeat(40);

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
        kind: "rewind",
        sessionId: "session-1",
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        semanticLeafId: "old-leaf",
        targetTurnId: "turn-1",
        targetBoundaryId: "transaction-start",
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
    let record: WorkspaceOperationJournalV1 | undefined;
    const liveStates = new Map(
        plan.paths.map((path) => [path.path, input.preStates?.[path.path] ?? path.expectedCurrent])
    );
    const journal = {
        begin: vi.fn(async (next: WorkspaceOperationJournalV1) => {
            order.push("operation-ref", "prepared");
            record = structuredClone(next);
        }),
        transition: vi.fn(async (_operationId: string, phase: WorkspaceOperationJournalV1["phase"], patch = {}) => {
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
        readBlob: vi.fn(async () => Buffer.from("blob")),
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
        planRedo: input.useRealPlanRedo ? planRedo : vi.fn(async () => structuredClone(plan)),
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
});
