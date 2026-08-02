// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveWorkspaceApplyArtifactPaths } from "./filesystem-apply";
import type { PendingWorkspaceRestoreV1, ScannedPendingWorkspaceRestore } from "./pending-restore-store";
import type { RestoreTargetV1 } from "./restore-plan";
import {
    WorkspaceControlCustomTypes,
    type CapturedPathStateV1,
    type WorkspaceSnapshotRefV1,
    type WorkspaceStateV1,
} from "./types";
import { WorkspaceRecovery, classifyWorkspaceRecoveryPath } from "./workspace-recovery";
import { workspaceStateFromPending } from "./workspace-restore-executor";

const Identity = "1".repeat(64);
const Incarnation = "2".repeat(64);
const Before = { state: "file", oid: "a".repeat(40), executable: false } as const;
const Target = { state: "file", oid: "b".repeat(40), executable: false } as const;
const CleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTemporaryRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    CleanupRoots.push(root);
    return root;
}

function snapshot(id = "3".repeat(40)): WorkspaceSnapshotRefV1 {
    return {
        id,
        tree: "4".repeat(40),
        scopeManifest: "5".repeat(40),
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
    };
}

function pendingRecord(
    target: RestoreTargetV1 = { kind: "rewind", targetTurnId: "turn-1" }
): PendingWorkspaceRestoreV1 {
    return {
        schemaVersion: 1,
        operationId: "operation-1",
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        sessionId: "session-1",
        sessionPath: "/sessions/session-1.db",
        target,
        commitParentId: "commit-parent",
        applyMode: "normal",
        forcedPaths: [],
        expectedSemanticLeafId: "old-leaf",
        workspaceStateEntryId: "operation-leaf",
        safetySnapshot: snapshot(),
        paths: [{ path: "file.txt", before: Before, target: Target, createdParentDirectories: [] }],
    };
}

async function fixture(input: {
    target?: RestoreTargetV1;
    leaf?: string | null;
    marker?: "exact" | "missing" | "wrong-id" | "wrong-type" | "wrong-parent" | "wrong-payload";
    mutateState?: (state: WorkspaceStateV1) => void;
    live?: CapturedPathStateV1 | "unknown";
    sessionMissing?: boolean;
    corrupt?: boolean;
}) {
    const root = await makeTemporaryRoot("crest-pending-recovery-");
    let record = pendingRecord(input.target);
    const currentSnapshot = snapshot("6".repeat(40));
    const live = new Map<string, CapturedPathStateV1 | "unknown">([["file.txt", input.live ?? Target]]);
    const markerState = workspaceStateFromPending(record, currentSnapshot);
    if (input.marker === "wrong-payload") markerState.operationId = "forged-operation";
    input.mutateState?.(markerState);
    const marker: SessionTreeEntry = {
        type: "custom",
        id: input.marker === "wrong-id" ? "forged-entry" : record.workspaceStateEntryId,
        parentId: input.marker === "wrong-parent" ? "wrong-parent" : record.commitParentId,
        timestamp: new Date(0).toISOString(),
        customType: input.marker === "wrong-type" ? "forged-type" : WorkspaceControlCustomTypes.state,
        data: markerState,
    };
    const candidate = (): ScannedPendingWorkspaceRestore =>
        input.corrupt
            ? {
                  kind: "corrupt",
                  operationId: record.operationId,
                  message: "truncated pending",
                  bytes: Buffer.from("{"),
              }
            : { kind: "valid", record: structuredClone(record) };
    const order: string[] = [];
    const pending = {
        readCandidate: vi.fn(async () => {
            order.push("candidate");
            return candidate();
        }),
        readLocked: vi.fn(async () => {
            order.push("authoritative");
            return candidate();
        }),
        updateCreatedParentDirectoriesLocked: vi.fn(
            async (_operationId: string, path: string, directories: string[]) => {
                record = {
                    ...record,
                    paths: record.paths.map((item) =>
                        item.path === path ? { ...item, createdParentDirectories: [...directories] } : item
                    ),
                };
                return structuredClone(record);
            }
        ),
        removeLocked: vi.fn(async () => order.push("remove")),
        resolveToAuditLocked: vi.fn(async (_operationId: string, disposition: string) => order.push(disposition)),
    };
    const session = {
        getLeafId: vi.fn(async () => input.leaf ?? (input.marker === "missing" ? "old-leaf" : "operation-leaf")),
        getEntry: vi.fn(async () => (input.marker === "missing" ? undefined : marker)),
    };
    const store = {
        storeRoot: join(root, "store"),
        identity: {
            canonicalRoot: root,
            workspaceIdentity: Identity,
            workspaceIncarnation: Incarnation,
            storeKey: "workspace",
            ancestorIdentityChain: [],
        },
        readBlob: vi.fn(),
        verify: vi.fn(async () => {}),
        readPathState: vi.fn(
            async (_snapshot: WorkspaceSnapshotRefV1, path: string) =>
                record.paths.find((item) => item.path === path)!.target
        ),
        withWorkspaceLock: vi.fn(async (operation: () => Promise<unknown>) => {
            order.push("workspace");
            return operation();
        }),
    };
    const applyPath = vi.fn(async ({ path, target, progress }) => {
        live.set(path, target);
        await progress.onPathReplaced?.();
    });
    const recovery = new WorkspaceRecovery({
        workspace: store.identity,
        store: store as never,
        pending: pending as never,
        locateSession: async () => (input.sessionMissing ? undefined : session),
        inspectPath: async (path) => live.get(path) ?? "unknown",
        applyPath,
        verifyWorkspace: async () => {},
        withSessionLease: async (_sessionId, operation) => {
            order.push("session");
            return operation();
        },
    });
    return { recovery, pending, session, store, applyPath, live, order, record: () => record, currentSnapshot, root };
}

describe("WorkspaceRecovery pending resolver", () => {
    it("classifies only exact before and target path states", () => {
        expect(classifyWorkspaceRecoveryPath(Before, Before, Target)).toBe("before");
        expect(classifyWorkspaceRecoveryPath(Target, Before, Target)).toBe("target");
        expect(classifyWorkspaceRecoveryPath("unknown", Before, Target)).toBe("unknown");
        expect(
            classifyWorkspaceRecoveryPath({ state: "file", oid: "c".repeat(40), executable: false }, Before, Target)
        ).toBe("unknown");
    });

    it.each([
        { kind: "rewind", targetTurnId: "turn-1" },
        { kind: "redo" },
        { kind: "turn-undo", sourceTurnId: "turn-1" },
        { kind: "turn-redo", sourceTurnId: "turn-1", undoOperationId: "undo-1" },
    ] satisfies RestoreTargetV1[])("recognizes an exact committed $kind marker", async (target) => {
        const value = await fixture({ target, marker: "exact", live: Target });

        await expect(value.recovery.inspectPending()).resolves.toEqual({
            state: "committed",
            operationId: "operation-1",
        });
        expect(value.store.verify).toHaveBeenCalledWith(value.currentSnapshot);
        expect(value.store.readPathState).toHaveBeenCalledWith(value.currentSnapshot, "file.txt");
        expect(value.pending.removeLocked).not.toHaveBeenCalled();
    });

    it.each(["wrong-id", "wrong-type", "wrong-parent", "wrong-payload"] as const)(
        "requires user input when the marker has a %s",
        async (marker) => {
            const value = await fixture({ marker, live: Target });
            await expect(value.recovery.inspectPending()).resolves.toMatchObject({ state: "needs-user" });
        }
    );

    it.each([
        ["Session", (state: WorkspaceStateV1) => (state.sessionId = "session-2")],
        ["Workspace", (state: WorkspaceStateV1) => (state.workspaceIdentity = "9".repeat(64))],
        ["operation target", (state: WorkspaceStateV1) => Object.assign(state, { kind: "redo", rewind: undefined })],
        ["apply mode", (state: WorkspaceStateV1) => (state.applyMode = "force-drift")],
        ["forced paths", (state: WorkspaceStateV1) => (state.forcedPaths = ["other.txt"])],
        ["current states", (state: WorkspaceStateV1) => (state.currentStates = [])],
        [
            "rewind safety snapshot",
            (state: WorkspaceStateV1) => {
                if (state.kind === "rewind") state.rewind.redoSnapshot = snapshot("8".repeat(40));
            },
        ],
        [
            "rewind before states",
            (state: WorkspaceStateV1) => {
                if (state.kind === "rewind") state.rewind.redoStates = [];
            },
        ],
    ] as Array<[string, (state: WorkspaceStateV1) => void]>)(
        "requires user input when exact marker %s differs from pending",
        async (_label, mutateState) => {
            const value = await fixture({ marker: "exact", live: Target, mutateState });
            await expect(value.recovery.inspectPending()).resolves.toMatchObject({ state: "needs-user" });
        }
    );

    it("requires user input when the committed snapshot is missing or does not contain every target", async () => {
        const missing = await fixture({ marker: "exact", live: Target });
        missing.store.verify.mockRejectedValueOnce(new Error("missing snapshot"));
        await expect(missing.recovery.inspectPending()).resolves.toMatchObject({ state: "needs-user" });

        const wrongState = await fixture({ marker: "exact", live: Target });
        wrongState.store.readPathState.mockResolvedValueOnce(Before);
        await expect(wrongState.recovery.inspectPending()).resolves.toMatchObject({ state: "needs-user" });
    });

    it("recognizes only an absent marker at the expected old leaf as not committed", async () => {
        const expected = await fixture({ marker: "missing", live: Target });
        await expect(expected.recovery.inspectPending()).resolves.toEqual({
            state: "not-committed",
            operationId: "operation-1",
        });

        const changedLeaf = await fixture({ marker: "missing", leaf: "other-leaf", live: Before });
        await expect(changedLeaf.recovery.inspectPending()).resolves.toMatchObject({ state: "needs-user" });

        const committedMarkerOffLeaf = await fixture({ marker: "exact", leaf: "other-leaf", live: Target });
        await expect(committedMarkerOffLeaf.recovery.inspectPending()).resolves.toMatchObject({
            state: "needs-user",
        });
    });

    it("classifies every path before performing any rollback write", async () => {
        const value = await fixture({ marker: "missing", live: Target });
        const second = { path: "other.txt", before: Before, target: Target, createdParentDirectories: [] };
        Object.assign(value.record(), { paths: [...value.record().paths, second] });
        value.live.set("other.txt", "unknown");

        await expect(value.recovery.resolvePending()).resolves.toMatchObject({ state: "needs-user" });
        expect(value.applyPath).not.toHaveBeenCalled();
    });

    it("rolls back only target paths, persists parent progress, and removes recorded empty directories", async () => {
        const value = await fixture({ marker: "missing", live: Target });
        await mkdir(join(value.root, "created"));
        value.record().paths[0]!.createdParentDirectories = ["created"];

        await expect(value.recovery.resolvePending()).resolves.toEqual({
            state: "not-committed",
            operationId: "operation-1",
        });

        expect(value.applyPath).toHaveBeenCalledWith(
            expect.objectContaining({ path: "file.txt", expectedCurrent: Target, target: Before })
        );
        expect(value.pending.updateCreatedParentDirectoriesLocked).toHaveBeenCalled();
        expect(value.pending.removeLocked).toHaveBeenCalledWith("operation-1");
        await expect(stat(join(value.root, "created"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("reconciles deterministic apply artifacts before classifying live paths", async () => {
        const root = await makeTemporaryRoot("crest-pending-artifact-");
        const beforeBytes = Buffer.from("before");
        const targetBytes = Buffer.from("target");
        const blobOid = (bytes: Buffer) =>
            createHash("sha1")
                .update(Buffer.from(`blob ${bytes.length}\0`))
                .update(bytes)
                .digest("hex");
        const before = { state: "file", oid: blobOid(beforeBytes), executable: false } as const;
        const target = { state: "file", oid: blobOid(targetBytes), executable: false } as const;
        let record = {
            ...pendingRecord({ kind: "redo" }),
            paths: [{ path: "file.txt", before, target, createdParentDirectories: [] }],
        };
        await writeFile(join(root, "file.txt"), beforeBytes);
        const artifacts = deriveWorkspaceApplyArtifactPaths({ operationId: record.operationId, path: "file.txt" });
        await mkdir(join(root, artifacts.quarantine));
        await rename(join(root, "file.txt"), join(root, artifacts.quarantine, "entry"));
        const pending = {
            readCandidate: vi.fn(async () => ({ kind: "valid", record }) as const),
            readLocked: vi.fn(async () => ({ kind: "valid", record }) as const),
            updateCreatedParentDirectoriesLocked: vi.fn(async () => record),
            removeLocked: vi.fn(async () => {}),
        };
        const store = {
            storeRoot: join(root, "store"),
            identity: workspaceIdentity(root),
            readBlob: vi.fn(async (key: string) => (key === before.oid ? beforeBytes : targetBytes)),
            readPathState: vi.fn(),
            verify: vi.fn(),
        };
        const recovery = new WorkspaceRecovery({
            workspace: store.identity,
            store: store as never,
            pending: pending as never,
            locateSession: async () => ({
                getLeafId: async () => "old-leaf",
                getEntry: async () => undefined,
            }),
            verifyWorkspace: async () => {},
        });

        await expect(recovery.resolvePending()).resolves.toMatchObject({ state: "not-committed" });
        await expect(readFile(join(root, "file.txt"))).resolves.toEqual(beforeBytes);
        expect(pending.updateCreatedParentDirectoriesLocked).toHaveBeenCalled();
    });

    it("never auto-writes for a missing owning Session and permits explicit keep current", async () => {
        const value = await fixture({ marker: "missing", live: Target, sessionMissing: true });
        await expect(value.recovery.resolvePending()).resolves.toMatchObject({
            state: "needs-user",
            view: { allowedActions: ["retry", "abandon-current"] },
        });
        expect(value.applyPath).not.toHaveBeenCalled();

        await value.recovery.keepCurrent("operation-1");
        expect(value.pending.resolveToAuditLocked).toHaveBeenCalledWith("operation-1", "keep-current");
    });

    it("permits only quarantine for corrupt pending bytes", async () => {
        const value = await fixture({ corrupt: true });
        await expect(value.recovery.inspectPending()).resolves.toMatchObject({
            state: "needs-user",
            view: { corrupt: true, allowedActions: ["quarantine-corrupt"] },
        });
        await expect(value.recovery.keepCurrent("operation-1")).rejects.toThrow(/decoded/i);
        await value.recovery.quarantine("operation-1");
        expect(value.pending.resolveToAuditLocked).toHaveBeenCalledWith("operation-1", "quarantine");
    });

    it("orders candidate read, Session lease, Workspace lock, then authoritative reread", async () => {
        const value = await fixture({ marker: "missing", live: Before });
        await value.recovery.inspectPending();
        expect(value.order.slice(0, 4)).toEqual(["candidate", "session", "workspace", "authoritative"]);
    });

    it.each(["inspectPending", "resolvePending"] as const)(
        "returns none when a concurrent completed restore removes pending before %s authoritatively rereads",
        async (method) => {
            const value = await fixture({ marker: "exact", live: Target });
            value.pending.readLocked.mockResolvedValueOnce({ kind: "none" });

            await expect(value.recovery[method]()).resolves.toEqual({ state: "none" });
            expect(value.pending.removeLocked).not.toHaveBeenCalled();
        }
    );

    it("keeps the operation guard strict when pending disappears before an action rereads", async () => {
        const value = await fixture({ marker: "exact", live: Target });
        value.pending.readLocked.mockResolvedValueOnce({ kind: "none" });

        await expect(value.recovery.resolvePending("operation-1")).rejects.toThrow(/disappeared/i);
        expect(value.pending.removeLocked).not.toHaveBeenCalled();
    });

    it("does not reacquire either public lock from the locked Resolver helper", async () => {
        const value = await fixture({ marker: "missing", live: Before });
        await value.recovery.resolvePendingLocked(value.record());
        expect(value.order).not.toContain("session");
        expect(value.order).not.toContain("workspace");
    });

    it("rechecks the requested operation ID after entering the Workspace lock", async () => {
        const value = await fixture({ marker: "missing", live: Before });
        value.pending.readLocked.mockImplementationOnce(async () => ({
            kind: "valid",
            record: { ...value.record(), operationId: "operation-2" },
        }));
        await expect(value.recovery.resolvePending("operation-1")).rejects.toThrow(/operation changed/i);
        expect(value.applyPath).not.toHaveBeenCalled();
    });
});

function workspaceIdentity(canonicalRoot: string) {
    return {
        canonicalRoot,
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        storeKey: "workspace",
        ancestorIdentityChain: [],
    };
}
