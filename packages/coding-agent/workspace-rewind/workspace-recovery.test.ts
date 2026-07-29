// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { encodeDurableJson } from "./durability";
import { deriveWorkspaceApplyArtifactPaths } from "./filesystem-apply";
import { WorkspaceRecoveryJournal, type WorkspaceOperationJournalV1 } from "./recovery-journal";
import type { CapturedPathStateV1, WorkspaceSnapshotRefV1, WorkspaceStateV1 } from "./types";
import {
    WorkspaceFrozenError,
    WorkspaceRecovery,
    classifyWorkspaceRecoveryPath,
    type WorkspaceRecoverySession,
} from "./workspace-recovery";

const Identity = "1".repeat(64);
const Incarnation = "2".repeat(64);

function oid(bytes: Buffer): string {
    return createHash("sha1")
        .update(Buffer.from(`blob ${bytes.length}\0`))
        .update(bytes)
        .digest("hex");
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

function journalRecord(
    phase: WorkspaceOperationJournalV1["phase"],
    preState: CapturedPathStateV1,
    target: CapturedPathStateV1
): WorkspaceOperationJournalV1 {
    return {
        schemaVersion: 1,
        phase,
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        sessionId: "session-1",
        sessionPath: "/old/path.sqlite",
        operationId: "operation-1",
        kind: "rewind",
        applyMode: "normal",
        expectedSemanticLeafId: "old-leaf",
        targetTurnId: "turn-1",
        targetBoundaryId: "target",
        safetySnapshot: snapshot(),
        confirmedConflictFingerprints: [],
        paths: [
            {
                path: "file.txt",
                preState,
                target,
                expectedCurrent: preState,
                confirmedLiveFingerprint: "6".repeat(64),
                createdParentDirectories: [],
            },
        ],
        workspaceStateEntryId: "operation-leaf",
        ...(phase === "completed" ? { resultSnapshot: snapshot("7".repeat(40)) } : {}),
    };
}

async function fixture(input: {
    phase: WorkspaceOperationJournalV1["phase"];
    live: CapturedPathStateV1 | "unknown";
    leaf?: string;
    stateOverrides?: Partial<WorkspaceStateV1>;
    entryParentId?: string;
}) {
    const root = await mkdtemp(join(tmpdir(), "crest-workspace-recovery-"));
    const storeRoot = join(root, "store", "repo.git");
    await mkdir(storeRoot, { recursive: true });
    const pre = Buffer.from("pre");
    const target = Buffer.from("target");
    const states = {
        pre: { state: "file", oid: oid(pre), executable: false } satisfies CapturedPathStateV1,
        target: { state: "file", oid: oid(target), executable: false } satisfies CapturedPathStateV1,
    };
    const store = {
        storeRoot,
        identity: {
            canonicalRoot: root,
            workspaceIdentity: Identity,
            workspaceIncarnation: Incarnation,
            storeKey: `${Identity}-${Incarnation}`,
            ancestorIdentityChain: [],
        },
        anchorOperation: vi.fn(async () => {}),
        deleteCrestRef: vi.fn(async () => {}),
        readBlob: vi.fn(async (key: string) => (key === states.pre.oid ? pre : target)),
        verify: vi.fn(async () => {}),
    };
    const durable = new WorkspaceRecoveryJournal(store);
    await durable.begin(journalRecord("prepared", states.pre, states.target));
    const phases = ["prepared", "applying_files", "files_verified", "committing_session", "completed"] as const;
    for (const phase of phases.slice(1, phases.indexOf(input.phase) + 1)) {
        await durable.transition("operation-1", phase, {
            ...(phase === "files_verified" ? { resultSnapshot: snapshot("7".repeat(40)) } : {}),
        });
    }
    const stateEntry: WorkspaceStateV1 = {
        schemaVersion: 1,
        sessionId: "session-1",
        operationId: "operation-1",
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        kind: "rewind",
        applyMode: "normal",
        forcedPaths: [],
        currentSnapshot: snapshot("7".repeat(40)),
        currentStates: [{ path: "file.txt", state: states.target }],
        rewind: {
            fromLeafId: "old-leaf",
            targetTurnId: "turn-1",
            targetBoundaryId: "target",
            redoSnapshot: snapshot(),
            redoStates: [{ path: "file.txt", state: states.pre }],
        },
        ...input.stateOverrides,
    };
    const session: WorkspaceRecoverySession = {
        getLeafId: vi.fn(async () => input.leaf ?? "old-leaf"),
        getEntry: vi.fn(
            async (entryId): Promise<SessionTreeEntry | undefined> =>
                entryId === "operation-leaf"
                    ? {
                          type: "custom",
                          id: "operation-leaf",
                          parentId: input.entryParentId ?? "target",
                          timestamp: new Date(0).toISOString(),
                          customType: "workspace_state",
                          data: stateEntry,
                      }
                    : undefined
        ),
    };
    const apply = vi.fn(async ({ target: next }: { target: CapturedPathStateV1 }) => {
        input.live = next;
    });
    const recovery = new WorkspaceRecovery({
        workspace: store.identity,
        store,
        journal: durable,
        locateSession: async () => session,
        inspectPath: async () => input.live,
        applyPath: apply,
        publishState: vi.fn(async () => {}),
        repairSessionRefs: vi.fn(async () => {}),
        verifyWorkspace: vi.fn(async () => {}),
    });
    return { recovery, durable, apply, states, input, session };
}

describe("workspace recovery", () => {
    it("classifies only exact pre and target states", () => {
        const pre = { state: "absent" } as const;
        const target = { state: "file", oid: "a".repeat(40), executable: false } as const;
        expect(classifyWorkspaceRecoveryPath(pre, pre, target)).toBe("pre");
        expect(classifyWorkspaceRecoveryPath(target, pre, target)).toBe("target");
        expect(
            classifyWorkspaceRecoveryPath({ state: "file", oid: "b".repeat(40), executable: false }, pre, target)
        ).toBe("unknown");
        expect(classifyWorkspaceRecoveryPath("unknown", pre, target)).toBe("unknown");
    });

    it("discards prepared only when every path is exact pre", async () => {
        const safe = await fixture({ phase: "prepared", live: "unknown" });
        safe.input.live = safe.states.pre;
        await safe.recovery.ensureRecovered(safe.recovery.workspace);
        await expect(safe.durable.read("operation-1")).rejects.toThrow(/not found/i);
        expect(safe.apply).not.toHaveBeenCalled();

        const unsafe = await fixture({ phase: "prepared", live: "unknown" });
        await expect(unsafe.recovery.ensureRecovered(unsafe.recovery.workspace)).rejects.toThrow(WorkspaceFrozenError);
        expect(await unsafe.recovery.getRecoveryState(unsafe.recovery.workspace)).toMatchObject({
            phase: "prepared",
            paths: [{ path: "file.txt", classification: "unknown" }],
            allowedActions: ["retry", "abandon-current"],
        });
    });

    it.each(["applying_files", "files_verified"] as const)(
        "rolls exact target paths back in %s and is idempotent",
        async (phase) => {
            const value = await fixture({ phase, live: "unknown" });
            value.input.live = value.states.target;

            await value.recovery.ensureRecovered(value.recovery.workspace);
            await value.recovery.ensureRecovered(value.recovery.workspace);

            expect(value.apply).toHaveBeenCalledOnce();
            expect(value.apply).toHaveBeenCalledWith(
                expect.objectContaining({ path: "file.txt", target: value.states.pre })
            );
            await expect(value.durable.read("operation-1")).rejects.toThrow(/not found/i);
        }
    );

    it("never overwrites an unknown post-crash manual modification", async () => {
        const value = await fixture({
            phase: "applying_files",
            live: { state: "file", oid: oid(Buffer.from("manual")), executable: false },
        });

        await expect(value.recovery.ensureRecovered(value.recovery.workspace)).rejects.toThrow(WorkspaceFrozenError);

        expect(value.apply).not.toHaveBeenCalled();
        await expect(value.durable.read("operation-1")).resolves.toMatchObject({ phase: "applying_files" });
        await expect(value.recovery.assertWorkspaceWritable(value.recovery.workspace)).rejects.toThrow(
            WorkspaceFrozenError
        );
    });

    it("offers abandon only when the session leaf is exactly old or committed", async () => {
        const oldLeaf = await fixture({ phase: "applying_files", live: "unknown", leaf: "old-leaf" });
        await expect(oldLeaf.recovery.ensureRecovered(oldLeaf.recovery.workspace)).rejects.toThrow(
            WorkspaceFrozenError
        );
        await expect(oldLeaf.recovery.getRecoveryState(oldLeaf.recovery.workspace)).resolves.toMatchObject({
            allowedActions: ["retry", "abandon-current"],
        });

        const unexpected = await fixture({ phase: "applying_files", live: "unknown", leaf: "other-leaf" });
        await expect(unexpected.recovery.ensureRecovered(unexpected.recovery.workspace)).rejects.toThrow(
            WorkspaceFrozenError
        );
        await expect(unexpected.recovery.getRecoveryState(unexpected.recovery.workspace)).resolves.toMatchObject({
            allowedActions: ["retry"],
        });
    });

    it("freezes for missing objects, missing sessions, and incarnation mismatch", async () => {
        const missingObject = await fixture({ phase: "prepared", live: "unknown" });
        missingObject.input.live = missingObject.states.pre;
        missingObject.recovery.store.verify = vi.fn(async () => {
            throw new Error("missing object");
        });
        await expect(missingObject.recovery.ensureRecovered(missingObject.recovery.workspace)).rejects.toThrow(
            WorkspaceFrozenError
        );
        await expect(missingObject.durable.read("operation-1")).resolves.toMatchObject({ phase: "prepared" });

        const missingSession = await fixture({ phase: "prepared", live: "unknown" });
        Object.assign(missingSession.recovery, { locateSession: async () => undefined });
        await expect(missingSession.recovery.ensureRecovered(missingSession.recovery.workspace)).rejects.toThrow(
            WorkspaceFrozenError
        );

        const wrongIncarnation = await fixture({ phase: "prepared", live: "unknown" });
        const path = wrongIncarnation.durable.path("operation-1");
        const value = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8")));
        value.workspaceIncarnation = "a".repeat(64);
        value.safetySnapshot.workspaceIncarnation = "a".repeat(64);
        await writeFile(path, encodeDurableJson(value));
        await expect(wrongIncarnation.recovery.ensureRecovered(wrongIncarnation.recovery.workspace)).rejects.toThrow(
            WorkspaceFrozenError
        );
        expect(await wrongIncarnation.recovery.getRecoveryState(wrongIncarnation.recovery.workspace)).toMatchObject({
            corrupt: false,
        });
    });

    it("acquires the owning session lease before the workspace lock", async () => {
        const value = await fixture({ phase: "prepared", live: "unknown" });
        value.input.live = value.states.pre;
        const order: string[] = [];
        Object.assign(value.recovery, {
            withSessionLease: async (_sessionId: string, operation: () => Promise<unknown>) => {
                order.push("session");
                return operation();
            },
        });
        Object.assign(value.recovery.store, {
            withWorkspaceLock: async (operation: () => Promise<unknown>) => {
                order.push("workspace");
                return operation();
            },
        });

        await value.recovery.ensureRecovered(value.recovery.workspace);

        expect(order.slice(0, 2)).toEqual(["session", "workspace"]);
    });

    it("rereads the authoritative journal after waiting for the workspace lock", async () => {
        const value = await fixture({ phase: "applying_files", live: "unknown" });
        value.input.live = value.states.target;
        let firstLock = true;
        Object.assign(value.recovery.store, {
            withWorkspaceLock: async (operation: () => Promise<unknown>) => {
                if (firstLock) {
                    firstLock = false;
                    await value.durable.completeCleanup("operation-1");
                }
                return operation();
            },
        });

        await value.recovery.ensureRecovered(value.recovery.workspace);

        expect(value.apply).not.toHaveBeenCalled();
        await expect(value.durable.read("operation-1")).rejects.toThrow(/not found/i);
    });

    it("refuses abandon when the authoritative journal changes owning session", async () => {
        const value = await fixture({ phase: "prepared", live: "unknown", leaf: "old-leaf" });
        const originalScan = value.durable.scan.bind(value.durable);
        let scans = 0;
        vi.spyOn(value.durable, "scan").mockImplementation(async () => {
            const result = await originalScan();
            scans++;
            if (scans === 2 && result[0]?.record) {
                result[0].record.sessionId = "session-2";
            }
            return result;
        });

        await expect(value.recovery.abandonKeepingCurrent("operation-1")).rejects.toThrow(/owning session/i);
        await expect(value.durable.read("operation-1")).resolves.toMatchObject({ sessionId: "session-1" });
    });

    it("does not freeze a corrupt candidate that disappears before authoritative reread", async () => {
        const value = await fixture({ phase: "applying_files", live: "unknown" });
        await writeFile(value.durable.path("operation-1"), "{truncated");
        let firstLock = true;
        Object.assign(value.recovery.store, {
            withWorkspaceLock: async (operation: () => Promise<unknown>) => {
                if (firstLock) {
                    firstLock = false;
                    await value.durable.completeCleanup("operation-1");
                }
                return operation();
            },
        });

        await value.recovery.ensureRecovered(value.recovery.workspace);

        expect(value.apply).not.toHaveBeenCalled();
    });

    it("revalidates workspace incarnation inside both locks before recovery mutations", async () => {
        const value = await fixture({ phase: "applying_files", live: "unknown" });
        value.input.live = value.states.target;
        let verification = 0;
        Object.assign(value.recovery, {
            verifyWorkspace: vi.fn(async () => {
                verification++;
                if (verification === 2) {
                    throw new Error("workspace replaced while waiting");
                }
            }),
        });

        await expect(value.recovery.ensureRecovered(value.recovery.workspace)).rejects.toThrow(WorkspaceFrozenError);

        expect(value.apply).not.toHaveBeenCalled();
        await expect(value.durable.read("operation-1")).resolves.toMatchObject({ phase: "applying_files" });
    });

    it("assertWorkspaceWritable waits on the workspace lock and observes a newly published operation", async () => {
        const value = await fixture({ phase: "prepared", live: "unknown" });
        await value.durable.completeCleanup("operation-1");
        let published = false;
        Object.assign(value.recovery.store, {
            withWorkspaceLock: async (operation: () => Promise<unknown>) => {
                if (!published) {
                    published = true;
                    await value.durable.begin(journalRecord("prepared", value.states.pre, value.states.target));
                }
                return operation();
            },
        });

        await expect(value.recovery.assertWorkspaceWritable(value.recovery.workspace)).rejects.toThrow(
            WorkspaceFrozenError
        );
    });

    it("reconciles Task10's deterministic quarantine before classifying a crash-time absent leaf", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-workspace-recovery-artifact-"));
        const storeRoot = join(root, ".store", "repo.git");
        await mkdir(storeRoot, { recursive: true });
        const pre = Buffer.from("pre");
        const target = Buffer.from("target");
        const preState = { state: "file", oid: oid(pre), executable: false } as const;
        const targetState = { state: "file", oid: oid(target), executable: false } as const;
        await writeFile(join(root, "file.txt"), pre);
        const artifacts = deriveWorkspaceApplyArtifactPaths({
            operationId: "operation-1",
            path: "file.txt",
        });
        await mkdir(join(root, artifacts.quarantine));
        await rename(join(root, "file.txt"), join(root, artifacts.quarantine, "entry"));
        const store = {
            storeRoot,
            identity: {
                canonicalRoot: root,
                workspaceIdentity: Identity,
                workspaceIncarnation: Incarnation,
                storeKey: `${Identity}-${Incarnation}`,
                ancestorIdentityChain: [],
            },
            anchorOperation: vi.fn(async () => {}),
            deleteCrestRef: vi.fn(async () => {}),
            readBlob: vi.fn(async (key: string) => (key === preState.oid ? pre : target)),
            verify: vi.fn(async () => {}),
        };
        const durable = new WorkspaceRecoveryJournal(store);
        await durable.begin(journalRecord("prepared", preState, targetState));
        await durable.transition("operation-1", "applying_files");
        const recovery = new WorkspaceRecovery({
            workspace: store.identity,
            store,
            journal: durable,
            locateSession: async () => ({
                getLeafId: async () => "old-leaf",
                getEntry: async () => undefined,
            }),
            verifyWorkspace: async () => {},
        });

        await expect(recovery.getRecoveryState(store.identity)).resolves.toMatchObject({
            paths: [{ path: "file.txt", classification: "unknown" }],
        });
        await expect(readFile(join(root, artifacts.quarantine, "entry"))).resolves.toEqual(pre);
        await expect(readFile(join(root, "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });

        await recovery.ensureRecovered(store.identity);

        await expect(
            import("node:fs/promises").then(({ readFile }) => readFile(join(root, "file.txt")))
        ).resolves.toEqual(pre);
        await expect(durable.read("operation-1")).rejects.toThrow(/not found/i);
    });

    it("finishes committing_session only for the exact operation leaf and rolls back only at the old leaf", async () => {
        const committed = await fixture({ phase: "committing_session", live: "unknown", leaf: "operation-leaf" });
        committed.input.live = committed.states.target;
        await committed.recovery.ensureRecovered(committed.recovery.workspace);
        await expect(committed.durable.read("operation-1")).rejects.toThrow(/not found/i);
        expect(committed.apply).not.toHaveBeenCalled();

        const uncommitted = await fixture({ phase: "committing_session", live: "unknown", leaf: "old-leaf" });
        uncommitted.input.live = uncommitted.states.target;
        await uncommitted.recovery.ensureRecovered(uncommitted.recovery.workspace);
        expect(uncommitted.apply).toHaveBeenCalledWith(
            expect.objectContaining({ path: "file.txt", target: uncommitted.states.pre })
        );

        const unexpected = await fixture({ phase: "committing_session", live: "unknown", leaf: "other-leaf" });
        unexpected.input.live = unexpected.states.target;
        await expect(unexpected.recovery.ensureRecovered(unexpected.recovery.workspace)).rejects.toThrow(
            WorkspaceFrozenError
        );
    });

    it("freezes a forged operation leaf whose marker or parent does not exactly match the journal", async () => {
        const wrongParent = await fixture({
            phase: "committing_session",
            live: "unknown",
            leaf: "operation-leaf",
            entryParentId: "wrong-parent",
        });
        wrongParent.input.live = wrongParent.states.target;
        await expect(wrongParent.recovery.ensureRecovered(wrongParent.recovery.workspace)).rejects.toThrow(
            WorkspaceFrozenError
        );

        const wrongKind = await fixture({
            phase: "committing_session",
            live: "unknown",
            leaf: "operation-leaf",
            stateOverrides: { kind: "redo" },
        });
        wrongKind.input.live = wrongKind.states.target;
        await expect(wrongKind.recovery.ensureRecovered(wrongKind.recovery.workspace)).rejects.toThrow(
            WorkspaceFrozenError
        );
    });

    it("finishes completed only after exact target, operation leaf, object verification, and publish", async () => {
        const value = await fixture({ phase: "completed", live: "unknown", leaf: "operation-leaf" });
        value.input.live = value.states.target;

        await value.recovery.ensureRecovered(value.recovery.workspace);

        expect(value.recovery.store.verify).toHaveBeenCalledWith(expect.objectContaining({ id: "7".repeat(40) }));
        expect(value.recovery.repairSessionRefs).toHaveBeenCalledWith("session-1");
        expect(value.recovery.publishState).toHaveBeenCalledWith("session-1");
        await expect(value.durable.read("operation-1")).rejects.toThrow(/not found/i);
    });

    it("allows abandon only at the exact old or committed leaf, and quarantine only for corrupt bytes", async () => {
        const abandon = await fixture({ phase: "prepared", live: "unknown", leaf: "old-leaf" });
        await expect(abandon.recovery.ensureRecovered(abandon.recovery.workspace)).rejects.toThrow(
            WorkspaceFrozenError
        );
        await abandon.recovery.abandonKeepingCurrent("operation-1");
        await expect(abandon.durable.read("operation-1")).rejects.toThrow(/not found/i);

        const corrupt = await fixture({ phase: "prepared", live: "unknown" });
        await writeFile(corrupt.durable.path("operation-1"), "{truncated");
        await expect(corrupt.recovery.ensureRecovered(corrupt.recovery.workspace)).rejects.toThrow(
            WorkspaceFrozenError
        );
        await expect(corrupt.recovery.abandonKeepingCurrent("operation-1")).rejects.toThrow(/corrupt/i);
        await corrupt.recovery.quarantineCorrupt("operation-1");
        await expect(corrupt.durable.read("operation-1")).rejects.toThrow(/not found/i);
    });
});
