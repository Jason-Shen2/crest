// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, SessionTreeEntry } from "@crest/agent/harness/types";
import { describe, expect, it, vi } from "vitest";

import { RewindConfirmationRegistry } from "./confirmation-token";
import type { PendingWorkspaceRestoreV1 } from "./pending-restore-store";
import type { RestorePlanV1, RestoreTargetV1 } from "./restore-plan";
import { WorkspaceControlCustomTypes, type WorkspaceSnapshotRefV1 } from "./types";
import { WorkspaceFrozenError } from "./workspace-recovery";
import {
    WorkspaceRestoreExecutor,
    workspaceStateFromPending,
    type WorkspaceRestoreCommitStrategy,
} from "./workspace-restore-executor";

const Identity = "1".repeat(64);
const Incarnation = "2".repeat(64);
const Before = { state: "file", oid: "a".repeat(40), executable: false } as const;
const Target = { state: "file", oid: "b".repeat(40), executable: false } as const;

function snapshot(id: string): WorkspaceSnapshotRefV1 {
    return {
        id,
        tree: "3".repeat(40),
        scopeManifest: "4".repeat(40),
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
    };
}

const Safety = snapshot("5".repeat(40));
const Result = snapshot("6".repeat(40));
const Workspace = {
    canonicalRoot: "/workspace",
    workspaceIdentity: Identity,
    workspaceIncarnation: Incarnation,
    storeKey: "workspace",
    ancestorIdentityChain: [],
};

function plan(target: RestoreTargetV1, withPath = false): RestorePlanV1 {
    return {
        target,
        sessionId: "session-1",
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        semanticLeafId: "current-leaf",
        commitParentId: "current-leaf",
        paths: withPath
            ? [
                  {
                      path: "file.txt",
                      operation: "write",
                      target: Target,
                      expectedCurrent: Before,
                      liveFingerprint: "7".repeat(64),
                      conflict: "none",
                  },
              ]
            : [],
        coverageWarnings: [],
        forceRequired: false,
        hardBlocked: false,
    };
}

function sessionFixture(appendError?: Error, appendAfterCommit = false) {
    const metadata: JsonlSessionMetadata = {
        id: "session-1",
        cwd: "/workspace",
        path: "/sessions/session-1.db",
        createdAt: new Date(0).toISOString(),
    };
    const entries: SessionTreeEntry[] = [
        {
            type: "message",
            id: "current-leaf",
            parentId: null,
            timestamp: new Date(0).toISOString(),
            message: { role: "user", content: "visible", timestamp: 0 },
        } as SessionTreeEntry,
    ];
    let leafId: string | null = "current-leaf";
    const appendEntries = vi.fn(async (next: SessionTreeEntry[]) => {
        if (appendError && !appendAfterCommit) throw appendError;
        entries.push(...next);
        leafId = next.at(-1)!.id;
        if (appendError) throw appendError;
    });
    return {
        session: {
            getMetadata: vi.fn(async () => metadata),
            getEntries: vi.fn(async () => [...entries]),
            getLeafId: vi.fn(async () => leafId),
            getEntry: vi.fn(async (id: string) => entries.find((entry) => entry.id === id)),
            getStorage: vi.fn(() => ({ createEntryId: vi.fn(async () => "operation-leaf") })),
            appendEntries,
        } as never,
        entries,
    };
}

function strategy(): WorkspaceRestoreCommitStrategy {
    return {
        makeWorkspaceState: workspaceStateFromPending,
        makeResult: ({ folded, sessionMetadata }) => ({
            sessionMetadata,
            semanticLeafId: folded.semanticLeafId,
            displayLeafId: folded.displayLeafId,
        }),
    };
}

function harness(
    input: {
        decision?: "committed" | "not-committed" | "needs-user";
        fail?: "safety" | "apply" | "result";
        appendError?: Error;
        appendAfterCommit?: boolean;
        onCommittedError?: Error;
        publishError?: Error;
        withPath?: boolean;
    } = {}
) {
    const order: string[] = [];
    let captures = 0;
    let record: PendingWorkspaceRestoreV1;
    const store = {
        identity: Workspace,
        withWorkspaceLock: vi.fn(async (operation: () => Promise<unknown>) => {
            order.push("lock");
            const result = await operation();
            order.push("unlock");
            return result;
        }),
        capture: vi.fn(async () => {
            captures++;
            if (captures === 1) {
                order.push("safety");
                if (input.fail === "safety") throw new Error("safety failed");
                return { ref: Safety, coverage: {} };
            }
            order.push("result");
            if (input.fail === "result") throw new Error("result failed");
            return { ref: Result, coverage: {} };
        }),
        readPathState: vi.fn(async (ref: WorkspaceSnapshotRefV1) => (ref.id === Safety.id ? Before : Target)),
        readBlob: vi.fn(),
        verify: vi.fn(async () => order.push("verify-result")),
    };
    const pending = {
        publishLocked: vi.fn(async (next: PendingWorkspaceRestoreV1) => {
            record = structuredClone(next);
            order.push("publish-pending");
            if (input.publishError) throw input.publishError;
        }),
        updateCreatedParentDirectoriesLocked: vi.fn(async () => {
            order.push("persist-parent-progress");
            return structuredClone(record);
        }),
        removeLocked: vi.fn(async () => order.push("remove-pending")),
    };
    const recovery = {
        resolvePendingLocked: vi.fn(async () => {
            order.push("resolve-pending");
            const decision = input.decision ?? "committed";
            if (decision === "committed") {
                order.push("verify-marker-and-live");
                await pending.removeLocked();
                return { state: "committed", operationId: "operation-1" } as const;
            }
            if (decision === "not-committed") {
                return { state: "not-committed", operationId: "operation-1" } as const;
            }
            return {
                state: "needs-user",
                view: {
                    operationId: "operation-1",
                    corrupt: false,
                    message: "Workspace recovery required",
                    paths: [],
                    allowedActions: ["retry"] as ["retry"],
                },
            } as const;
        }),
    };
    const applyPath = vi.fn(async ({ progress }) => {
        order.push("apply");
        await progress.onParentDirectoryCreated?.("created");
        if (input.fail === "apply") throw new Error("apply failed");
        await progress.onPathReplaced?.();
    });
    const verifyPath = vi.fn(async () => {
        order.push("verify-live");
    });
    const onCommitted = vi.fn(async () => {
        order.push("refresh");
        if (input.onCommittedError) throw input.onCommittedError;
    });
    const session = sessionFixture(input.appendError, input.appendAfterCommit);
    const executor = new WorkspaceRestoreExecutor({
        store: store as never,
        pending: pending as never,
        recovery: recovery as never,
        inspectLivePaths: vi.fn(
            async (paths: readonly string[]) =>
                new Map(paths.map((path) => [path, { ...Before, fingerprint: "7".repeat(64) } as never]))
        ),
        applyPath,
        verifyPath,
        createOperationId: () => "operation-1",
        now: () => new Date(1),
        onCommitted,
    });
    return {
        executor,
        store,
        pending,
        recovery,
        applyPath,
        verifyPath,
        onCommitted,
        session,
        order,
        record: () => record!,
    };
}

async function execute(value: ReturnType<typeof harness>, target: RestoreTargetV1, withPath = false) {
    const restorePlan = plan(target, withPath);
    const confirmations = new RewindConfirmationRegistry();
    return value.executor.execute({
        session: value.session.session,
        workspace: Workspace,
        plan: restorePlan,
        confirmation: confirmations.take(confirmations.issue(restorePlan)),
        mode: "normal",
        commit: strategy(),
    });
}

describe("WorkspaceRestoreExecutor pending transaction", () => {
    it.each([
        { kind: "rewind", targetTurnId: "turn-1" },
        { kind: "redo" },
        { kind: "turn-undo", sourceTurnId: "turn-1" },
        { kind: "turn-redo", sourceTurnId: "turn-1", undoOperationId: "undo-1" },
    ] satisfies RestoreTargetV1[])("executes the phase-free transaction for $kind", async (target) => {
        const value = harness();
        await execute(value, target);

        expect(value.order).toEqual([
            "lock",
            "safety",
            "publish-pending",
            "result",
            "verify-result",
            "resolve-pending",
            "verify-marker-and-live",
            "remove-pending",
            "unlock",
            "refresh",
        ]);
        expect(value.record()).not.toHaveProperty("phase");
        const marker = value.session.entries.at(-1) as Extract<SessionTreeEntry, { type: "custom" }>;
        expect(marker).toMatchObject({
            id: "operation-leaf",
            parentId: "current-leaf",
            customType: WorkspaceControlCustomTypes.state,
            data: workspaceStateFromPending(value.record(), Result),
        });
    });

    it("applies paths while durably persisting created parent progress", async () => {
        const value = harness({ withPath: true });
        await execute(value, { kind: "redo" }, true);
        expect(value.order).toContain("persist-parent-progress");
        expect(value.verifyPath).toHaveBeenCalledWith(expect.objectContaining({ path: "file.txt", expected: Target }));
    });

    it.each(["apply", "result"] as const)(
        "uses the locked Resolver once and rethrows the original %s failure after rollback",
        async (failure) => {
            const value = harness({ fail: failure, decision: "not-committed", withPath: failure === "apply" });
            await expect(execute(value, { kind: "redo" }, failure === "apply")).rejects.toThrow(`${failure} failed`);
            expect(value.recovery.resolvePendingLocked).toHaveBeenCalledOnce();
        }
    );

    it("uses the locked Resolver once and rethrows the original SQLite CAS failure", async () => {
        const error = new Error("SQLite CAS failed");
        const value = harness({ appendError: error, decision: "not-committed" });
        await expect(execute(value, { kind: "redo" })).rejects.toBe(error);
        expect(value.recovery.resolvePendingLocked).toHaveBeenCalledOnce();
    });

    it("returns success when an error occurs after SQLite committed and the Resolver says committed", async () => {
        const value = harness({
            appendError: new Error("wrapper failed"),
            appendAfterCommit: true,
            decision: "committed",
        });
        await expect(execute(value, { kind: "redo" })).resolves.toMatchObject({ semanticLeafId: "operation-leaf" });
        expect(value.recovery.resolvePendingLocked).toHaveBeenCalledOnce();
    });

    it("throws Recovery required when the Resolver cannot prove either terminal state", async () => {
        const value = harness({ fail: "result", decision: "needs-user" });
        await expect(execute(value, { kind: "redo" })).rejects.toBeInstanceOf(WorkspaceFrozenError);
        expect(value.recovery.resolvePendingLocked).toHaveBeenCalledOnce();
    });

    it("does not invoke the Resolver before pending publication", async () => {
        const value = harness({ fail: "safety" });
        await expect(execute(value, { kind: "redo" })).rejects.toThrow("safety failed");
        expect(value.pending.publishLocked).not.toHaveBeenCalled();
        expect(value.recovery.resolvePendingLocked).not.toHaveBeenCalled();
    });

    it("propagates a failed pending publication without invoking the Resolver", async () => {
        const error = new Error("pending publication failed");
        const value = harness({ publishError: error });

        await expect(execute(value, { kind: "redo" })).rejects.toBe(error);

        expect(value.pending.publishLocked).toHaveBeenCalledOnce();
        expect(value.recovery.resolvePendingLocked).not.toHaveBeenCalled();
    });

    it("logs renderer refresh failure after unlocking without changing the transaction result", async () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        const value = harness({ onCommittedError: new Error("refresh failed") });
        await expect(execute(value, { kind: "redo" })).resolves.toMatchObject({ semanticLeafId: "operation-leaf" });
        expect(value.order.slice(-2)).toEqual(["unlock", "refresh"]);
        expect(warning).toHaveBeenCalled();
        warning.mockRestore();
    });
});
