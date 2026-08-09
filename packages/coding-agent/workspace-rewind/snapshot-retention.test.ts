// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { SqliteSessionRepo } from "@crest/agent/harness/session/sqlite-repo";

import { AgentRuntimeRegistry } from "../agent-runtime-registry";
import { WorkspaceGitRunner, type GitRunOptions, type GitRunResult } from "./git-runner";
import { PendingBoundaryStore } from "./pending-boundary-store";
import { PendingWorkspaceRestoreStore, type PendingWorkspaceRestoreV2 } from "./pending-restore-store";
import { makeProcessOwnerIdentity } from "./process-owner";
import { reconcileSnapshotRefs, SnapshotRetentionLimits } from "./snapshot-retention";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import { WorkspaceControlCustomTypes, type WorkspaceCheckpointV1, type WorkspaceStateV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";

const CleanupRoots: string[] = [];

afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("keeps a first-seen orphan through fixed grace and removes it only after seven days", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    vi.advanceTimersByTime(SnapshotRetentionLimits.orphanGraceMs + 1);
    const expired = await reconcileSnapshotRefs({ store, sessionsRoot });

    expect(expired.removedRefs).toEqual([`refs/crest/snapshots/${snapshot.id}`]);
});

test("retains the current workspace head association while an older unowned association expires", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    const firstMetadata = await store.readSnapshotMetadata(snapshot);
    const firstCommit = await store.mutationLog.append({
        tree: snapshot.tree,
        metadata: {
            schemaversion: 1,
            workspaceidentity: store.identity.workspaceIdentity,
            workspaceincarnation: store.identity.workspaceIncarnation,
            kind: "agent-turn",
            sessionid: "first-session",
            turnid: "first-turn",
        },
    });
    await store.publishCommitSnapshot({ commit: firstCommit, ...firstMetadata });
    await writeFile(join(store.identity.canonicalRoot, "tracked.txt"), "current-value");
    const current = await store.captureFullReconcile({ profile: "terminal" });
    const currentCommit = await store.mutationLog.append({
        expectedHead: firstCommit,
        tree: current.tree,
        metadata: {
            schemaversion: 1,
            workspaceidentity: store.identity.workspaceIdentity,
            workspaceincarnation: store.identity.workspaceIncarnation,
            kind: "agent-turn",
            sessionid: "corrupt-head-session",
            turnid: "corrupt-head-turn",
        },
    });
    const currentSnapshot = await store.publishCommitSnapshot({ commit: currentCommit, ...current });
    await store.deleteCrestRef(store.ownerRefName(snapshot.id));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    vi.advanceTimersByTime(SnapshotRetentionLimits.orphanGraceMs + 1);
    const expired = await reconcileSnapshotRefs({ store, sessionsRoot });
    const remainingRefs = (await store.listCrestRefs()).map((ref) => ref.name);

    expect(expired.removedRefs).toEqual([store.ownerRefName(firstCommit)]);
    expect(remainingRefs).toContain(store.ownerRefName(currentCommit));
    await expect(store.readCommitSnapshot(currentCommit)).resolves.toEqual(currentSnapshot);
});

test("fails closed before deleting refs or running GC when the current workspace head graph is corrupt", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    const metadata = await store.readSnapshotMetadata(snapshot);
    const currentCommit = await store.mutationLog.append({
        tree: snapshot.tree,
        metadata: {
            schemaversion: 1,
            workspaceidentity: store.identity.workspaceIdentity,
            workspaceincarnation: store.identity.workspaceIncarnation,
            kind: "agent-turn",
            sessionid: "corrupt-head-session",
            turnid: "corrupt-head-turn",
        },
    });
    await store.publishCommitSnapshot({
        commit: currentCommit,
        scope: metadata.scope,
        coverage: {
            ...metadata.coverage,
            eligibleEntryCount: metadata.coverage.eligibleEntryCount + 1,
        },
    });
    const refsBefore = await store.listCrestRefs();
    const deleteRefs = vi.spyOn(store, "deleteCrestRefs");
    const git = vi.spyOn(store.git, "run");

    const report = await reconcileSnapshotRefs({ store, sessionsRoot });

    expect(report.removedRefs).toEqual([]);
    expect(report.failClosedReason).toMatch(/coverage.*workspace tree/i);
    expect(deleteRefs).not.toHaveBeenCalled();
    expect(git.mock.calls.some(([args]) => args[0] === "gc")).toBe(false);
    expect(await store.listCrestRefs()).toEqual(refsBefore);
});

test("fails closed when any recursive owner source cannot be decoded", async () => {
    const { store, sessionsRoot } = await makeStore();
    await writeFile(join(sessionsRoot, "broken.db"), "not sqlite");

    const report = await reconcileSnapshotRefs({ store, sessionsRoot });

    expect(report.removedRefs).toEqual([]);
    expect(report.failClosedReason).toMatch(/owner source/i);
});

test("fails closed when a recursive session owner source contains a symlink", async () => {
    const { store, sessionsRoot } = await makeStore();
    const external = join(dirname(sessionsRoot), "external-sessions");
    await mkdir(external);
    await symlink(external, join(sessionsRoot, ".archive"));

    const report = await reconcileSnapshotRefs({ store, sessionsRoot });

    expect(report.removedRefs).toEqual([]);
    expect(report.failClosedReason).toMatch(/owner source/i);
});

test("serializes capture with reconciliation and GC under the canonical store lock", async () => {
    const git = new BlockingCaptureGit();
    const { store, sessionsRoot } = await makeStore(git);
    await writeFile(join(store.identity.canonicalRoot, "second.txt"), "second");
    git.arm();
    const quotaReconcile = vi.spyOn(store, "reconcileQuotaAccountingAssumingLock");
    const capture = store.capture({ profile: "terminal" });
    await git.captureBlocked;
    let reconciled = false;
    const reconciliation = reconcileSnapshotRefs({ store, sessionsRoot }).then((report) => {
        reconciled = true;
        return report;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(reconciled).toBe(false);
    expect(git.calls.some((args) => args[0] === "gc")).toBe(false);
    git.releaseCapture();
    const [{ ref }, report] = await Promise.all([capture, reconciliation]);
    expect(report.failClosedReason).toBeUndefined();
    expect((await store.listCrestRefs()).map((value) => value.name)).toContain(`refs/crest/snapshots/${ref.id}`);
    expect(git.calls.some((args) => args[0] === "gc")).toBe(true);
    expect(quotaReconcile).toHaveBeenCalledTimes(1);
});

test("reports Git cleanup failure when the post-GC exact quota reconcile fails", async () => {
    const { store, sessionsRoot } = await makeStore();
    vi.spyOn(store, "reconcileQuotaAccountingAssumingLock").mockRejectedValue(new Error("exact quota scan failed"));
    const git = vi.spyOn(store.git, "run");

    const report = await reconcileSnapshotRefs({ store, sessionsRoot });

    expect(git.mock.calls.some(([args]) => args[0] === "gc")).toBe(true);
    expect(report.failClosedReason).toMatch(/cleanup failed.*exact quota scan failed/i);
});

test("synthetic destructive consumer preserves owner refs without deadlock", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    await addStateOwner(store, sessionsRoot, snapshot, "owned-session");
    const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
    const release = deferred();
    const destructive = registry.withRetainedSessionMutation(
        join(sessionsRoot, "owned-session.db"),
        { rejectIfRunning: true },
        async () =>
            store.withWorkspaceLock(async () => {
                await store.anchorSnapshot(snapshot);
                await release.promise;
            })
    );
    await store.mutationLock.waitUntilHeldForTest();
    const reconciliation = reconcileSnapshotRefs({ store, sessionsRoot });
    release.resolve();

    const [, report] = await Promise.all([destructive, reconciliation]);
    expect(report.failClosedReason).toBeUndefined();
    expect((await store.listCrestRefs()).map((value) => value.name)).toContain(`refs/crest/snapshots/${snapshot.id}`);
});

test("retains checkpoint owners in archive trash and forks through aggressive Git GC", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    const repo = new SqliteSessionRepo({ sessionsRoot });
    const source = await repo.create({ cwd: store.identity.canonicalRoot, id: "source-session" });
    const userEntryId = await source.appendMessage({
        role: "user",
        content: [{ type: "text", text: "change it" }],
        timestamp: Date.now(),
    } as never);
    const checkpoint: WorkspaceCheckpointV1 = {
        schemaVersion: 1,
        status: "available",
        originSessionId: "source-session",
        turnId: userEntryId,
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        before: snapshot,
        after: snapshot,
        changes: [],
        coverage: {
            complete: true,
            eligibleEntryCount: 1,
            newlyHashedBytes: 0,
            exclusions: [],
        },
    };
    const checkpointId = await source.appendCustomEntry(WorkspaceControlCustomTypes.checkpoint, checkpoint);
    const sourceMetadata = await source.getMetadata();
    source.close();
    const fork = await repo.fork(sourceMetadata, {
        cwd: store.identity.canonicalRoot,
        id: "fork-session",
        entryId: checkpointId,
        position: "at",
    });
    const forkMetadata = await fork.getMetadata();
    fork.close();
    const archivedSession = await repo.create({ cwd: store.identity.canonicalRoot, id: "archive-session" });
    await archivedSession.appendCustomEntry(WorkspaceControlCustomTypes.checkpoint, checkpoint);
    const archivedMetadata = await archivedSession.getMetadata();
    archivedSession.close();
    const archived = await repo.archive(archivedMetadata);
    const trashedSession = await repo.create({ cwd: store.identity.canonicalRoot, id: "trash-session" });
    await trashedSession.appendCustomEntry(WorkspaceControlCustomTypes.checkpoint, checkpoint);
    const trashedMetadata = await trashedSession.getMetadata();
    trashedSession.close();
    const trashed = await repo.stageDelete(trashedMetadata);
    await rm(sourceMetadata.path);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));

    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    vi.advanceTimersByTime(SnapshotRetentionLimits.orphanGraceMs * 2);
    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    await store.verify(snapshot);

    await Promise.all([rm(forkMetadata.path), rm(archived.path), rm(trashed.path)]);
    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    vi.advanceTimersByTime(SnapshotRetentionLimits.orphanGraceMs + 1);
    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([
        `refs/crest/snapshots/${snapshot.id}`,
    ]);
});

test("retains bound and unbound pending owners without consulting quota", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    const pending = new PendingBoundaryStore(store);
    const owner = await makeProcessOwnerIdentity();
    await pending.begin({
        boundaryToken: "pending-owner",
        sessionId: "session-pending",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        processOwner: owner,
        nonce: "a".repeat(64),
        before: snapshot,
    });
    await pending.begin({
        boundaryToken: "bound-owner",
        sessionId: "session-bound",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        processOwner: owner,
        nonce: "b".repeat(64),
        before: snapshot,
    });
    await pending.bind("bound-owner", "user-bound");
    const quota = vi.spyOn(store, "getQuotaStatus").mockRejectedValue(new Error("soft quota"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));

    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    vi.advanceTimersByTime(SnapshotRetentionLimits.orphanGraceMs * 2);
    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    expect(quota).not.toHaveBeenCalled();
    await store.verify(snapshot);
}, 15_000);

test("retains result source and current snapshots after pending cleanup and aggressive Git GC", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    const pending = new PendingWorkspaceRestoreStore(store);
    const { record, sourceSnapshot, plannedSnapshot } = await makePendingRestore(store, sessionsRoot, snapshot);
    await store.withWorkspaceLock(() => pending.publishLocked(record));
    expect(await pending.readCandidate()).toEqual({ kind: "valid", record });
    await addRewindStateOwner(store, sessionsRoot, sourceSnapshot, plannedSnapshot, "restore-session");
    await store.withWorkspaceLock(() => pending.removeLocked(record.operationId));
    await store.deleteCrestRef(store.ownerRefName(sourceSnapshot.id));
    await store.deleteCrestRef(store.ownerRefName(plannedSnapshot.id));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T00:00:00Z"));

    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    vi.advanceTimersByTime(SnapshotRetentionLimits.orphanGraceMs * 2);
    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    await Promise.all([store.verify(sourceSnapshot), store.verify(plannedSnapshot)]);
}, 15_000);

test("retains linked operation endpoints while a Redo result is pending before its marker exists", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    const pending = new PendingWorkspaceRestoreStore(store);
    const { record, linkedSource, linkedResult } = await makePendingRedoRestore(store, sessionsRoot, snapshot);
    await store.withWorkspaceLock(() => pending.publishLocked(record));
    await store.deleteCrestRef(store.ownerRefName(linkedSource.id));
    await store.deleteCrestRef(store.ownerRefName(linkedResult.id));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T00:00:00Z"));

    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).failClosedReason).toBeUndefined();
    const refs = new Set((await store.listCrestRefs()).map((ref) => ref.name));
    expect(refs.has(store.ownerRefName(linkedSource.id))).toBe(true);
    expect(refs.has(store.ownerRefName(linkedResult.id))).toBe(true);
    await Promise.all([store.verify(linkedSource), store.verify(linkedResult)]);
}, 15_000);

test("fails closed before deletion or GC when the active restore pending is corrupt", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    const root = join(store.storeRoot, "journal", "restore");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "pending.json"), '{"operationId":"broken-restore"', { mode: 0o600 });
    const gc = vi.spyOn(store.git, "run");

    const report = await reconcileSnapshotRefs({ store, sessionsRoot });

    expect(report.removedRefs).toEqual([]);
    expect(report.failClosedReason).toMatch(/owner source/i);
    expect(gc.mock.calls.some(([args]) => args[0] === "gc")).toBe(false);
    expect((await store.listCrestRefs()).map((ref) => ref.name)).toContain(`refs/crest/snapshots/${snapshot.id}`);
});

test("retains workspace state source and current snapshots through aggressive Git GC", async () => {
    const { store, sessionsRoot, snapshot: sourceSnapshot } = await makeStore();
    await writeFile(join(store.identity.canonicalRoot, "tracked.txt"), "redo-value");
    const { ref: currentSnapshot } = await store.capture({ profile: "terminal", requiredPaths: ["tracked.txt"] });
    const repo = new SqliteSessionRepo({ sessionsRoot });
    const session = await repo.create({ cwd: store.identity.canonicalRoot, id: "state-session" });
    const state: WorkspaceStateV1 = {
        schemaVersion: 1,
        sessionId: "state-session",
        operationId: "state-operation",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        kind: "rewind",
        applyMode: "normal",
        forcedPaths: [],
        sourceSnapshot,
        currentSnapshot,
        currentStates: [],
        rewind: {
            fromLeafId: null,
            targetTurnId: "turn-a",
            targetBoundaryId: null,
            redoStates: [],
        },
    };
    await session.appendCustomEntry(WorkspaceControlCustomTypes.state, state);
    session.close();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));

    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    vi.advanceTimersByTime(SnapshotRetentionLimits.orphanGraceMs * 2);
    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    await Promise.all([store.verify(sourceSnapshot), store.verify(currentSnapshot)]);
});

test("grace-collects orphan refs without pruning a session-owned graph", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    await addStateOwner(store, sessionsRoot, snapshot, "state-owner");
    const pendingRef = `refs/crest/pending/${"a".repeat(64)}/orphan-boundary`;
    const orphanRef = "refs/crest/ops/legacy-operation";
    await store.git.run(["update-ref", pendingRef, snapshot.id], {
        gitDir: store.storeRoot,
        timeoutMs: 30_000,
    });
    await store.git.run(["update-ref", orphanRef, snapshot.id], {
        gitDir: store.storeRoot,
        timeoutMs: 30_000,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00Z"));

    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    vi.advanceTimersByTime(SnapshotRetentionLimits.orphanGraceMs + 1);
    const expired = await reconcileSnapshotRefs({ store, sessionsRoot });

    expect(expired.failClosedReason).toBeUndefined();
    expect(expired.removedRefs.sort()).toEqual([orphanRef, pendingRef].sort());
    expect((await store.listCrestRefs()).map((ref) => ref.name)).toContain(`refs/crest/snapshots/${snapshot.id}`);
    await store.verify(snapshot);

    await store.git.run(["update-ref", orphanRef, snapshot.id], {
        gitDir: store.storeRoot,
        timeoutMs: 30_000,
    });
    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    expect((await store.listCrestRefs()).map((ref) => ref.name)).toContain(orphanRef);
});

test("keeps every ref when the durable grace ledger cannot be persisted", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    await reconcileSnapshotRefs({ store, sessionsRoot });
    vi.advanceTimersByTime(SnapshotRetentionLimits.orphanGraceMs + 1);
    const ledgerPath = join(store.storeRoot, "journal", "orphan-grace.json");
    await rm(ledgerPath);
    await mkdir(ledgerPath);

    const report = await reconcileSnapshotRefs({ store, sessionsRoot });

    expect(report.removedRefs).toEqual([]);
    expect(report.failClosedReason).toBeDefined();
    expect((await store.listCrestRefs()).map((ref) => ref.name)).toContain(`refs/crest/snapshots/${snapshot.id}`);
});

test("uses one atomic ref transaction and resets grace when the deletion batch fails", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    await addStateOwner(store, sessionsRoot, snapshot, "batch-owner");
    const pendingRef = `refs/crest/pending/${"b".repeat(64)}/batch-pending`;
    const orphanRef = `refs/crest/pending/${"d".repeat(64)}/batch-ref`;
    for (const refName of [pendingRef, orphanRef]) {
        await store.git.run(["update-ref", refName, snapshot.id], {
            gitDir: store.storeRoot,
            timeoutMs: 30_000,
        });
    }
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    await reconcileSnapshotRefs({ store, sessionsRoot });
    vi.advanceTimersByTime(SnapshotRetentionLimits.orphanGraceMs + 1);
    const deletion = vi.spyOn(store, "deleteCrestRefs").mockImplementation(async (refs) => {
        expect(refs).toHaveLength(2);
        throw new Error("simulated second delete failure");
    });

    const failed = await reconcileSnapshotRefs({ store, sessionsRoot });

    expect(failed.removedRefs).toEqual([]);
    expect((await store.listCrestRefs()).map((ref) => ref.name)).toEqual(
        expect.arrayContaining([pendingRef, orphanRef])
    );
    deletion.mockRestore();
    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
});

test("reports refs already removed when Git GC fails after the atomic deletion", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    await addStateOwner(store, sessionsRoot, snapshot, "gc-owner");
    const pendingRef = `refs/crest/pending/${"c".repeat(64)}/gc-pending`;
    const orphanRef = `refs/crest/pending/${"d".repeat(64)}/gc-ref`;
    for (const refName of [pendingRef, orphanRef]) {
        await store.git.run(["update-ref", refName, snapshot.id], {
            gitDir: store.storeRoot,
            timeoutMs: 30_000,
        });
    }
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    await reconcileSnapshotRefs({ store, sessionsRoot });
    vi.advanceTimersByTime(SnapshotRetentionLimits.orphanGraceMs + 1);
    const run = store.git.run.bind(store.git);
    vi.spyOn(store.git, "run").mockImplementation(async (args, options) => {
        if (args[0] === "gc") {
            throw new Error("simulated gc failure");
        }
        return run(args, options);
    });

    const report = await reconcileSnapshotRefs({ store, sessionsRoot });

    expect(report.removedRefs.sort()).toEqual([pendingRef, orphanRef].sort());
    expect(report.failClosedReason).toMatch(/cleanup failed/i);
    expect((await store.listCrestRefs()).map((ref) => ref.name)).not.toEqual(
        expect.arrayContaining([pendingRef, orphanRef])
    );
});

test("fails closed before deletion or GC when an owner snapshot graph is corrupt", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    await addStateOwner(store, sessionsRoot, { ...snapshot, tree: "f".repeat(40) }, "corrupt-owner");
    const gc = vi.spyOn(store.git, "run");

    const report = await reconcileSnapshotRefs({ store, sessionsRoot });

    expect(report.removedRefs).toEqual([]);
    expect(report.failClosedReason).toBeDefined();
    expect(gc.mock.calls.some(([args]) => args[0] === "gc")).toBe(false);
    expect((await store.listCrestRefs()).map((ref) => ref.name)).toContain(`refs/crest/snapshots/${snapshot.id}`);
});

test("fails closed on a corrupt pending owner record", async () => {
    const { store, sessionsRoot } = await makeStore();
    const root = join(store.storeRoot, "journal", "pending");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "broken.json"), "{}");

    const report = await reconcileSnapshotRefs({ store, sessionsRoot });

    expect(report.removedRefs).toEqual([]);
    expect(report.failClosedReason).toMatch(/owner source/i);
});

async function makeStore(git: WorkspaceGitRunner = new WorkspaceGitRunner()) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "crest-retention-")));
    CleanupRoots.push(root);
    const workspace = join(root, "workspace");
    const sessionsRoot = join(root, "sessions");
    await mkdir(workspace);
    await mkdir(sessionsRoot);
    await writeFile(join(workspace, "tracked.txt"), "value");
    const identity: CanonicalWorkspaceIdentity = {
        canonicalRoot: workspace,
        workspaceIdentity: "3".repeat(64),
        workspaceIncarnation: "4".repeat(64),
        storeKey: "store-a",
        ancestorIdentityChain: await ancestorIdentityChain(workspace),
    };
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: join(root, "data"),
        identity,
        git,
        processOwner: await makeProcessOwnerIdentity(),
    });
    const { ref: snapshot } = await store.capture({ profile: "terminal", requiredPaths: ["tracked.txt"] });
    return { store, sessionsRoot, snapshot };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

class BlockingCaptureGit extends WorkspaceGitRunner {
    calls: string[][] = [];
    captureBlocked: Promise<void>;
    resolveCaptureBlocked!: () => void;
    captureRelease: Promise<void>;
    resolveCaptureRelease!: () => void;
    blocked = false;
    armed = false;

    constructor() {
        super();
        this.captureBlocked = new Promise((resolve) => {
            this.resolveCaptureBlocked = resolve;
        });
        this.captureRelease = new Promise((resolve) => {
            this.resolveCaptureRelease = resolve;
        });
    }

    releaseCapture(): void {
        this.resolveCaptureRelease();
    }

    arm(): void {
        this.armed = true;
    }

    override async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
        this.calls.push([...args]);
        if (args[0] === "mktree" && this.armed && !this.blocked) {
            this.blocked = true;
            this.resolveCaptureBlocked();
            await this.captureRelease;
        }
        return super.run(args, options);
    }
}

async function addStateOwner(
    store: WorkspaceSnapshotStore,
    sessionsRoot: string,
    snapshot: WorkspaceStateV1["currentSnapshot"],
    sessionId: string
): Promise<void> {
    const repo = new SqliteSessionRepo({ sessionsRoot });
    const session = await repo.create({ cwd: store.identity.canonicalRoot, id: sessionId });
    const state: WorkspaceStateV1 = {
        schemaVersion: 1,
        sessionId,
        operationId: `${sessionId}-operation`,
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        kind: "turn-undo",
        sourceTurnId: `${sessionId}-turn`,
        applyMode: "normal",
        forcedPaths: [],
        sourceSnapshot: snapshot,
        currentSnapshot: snapshot,
        currentStates: [],
    };
    await session.appendCustomEntry(WorkspaceControlCustomTypes.state, state);
    session.close();
}

async function addRewindStateOwner(
    store: WorkspaceSnapshotStore,
    sessionsRoot: string,
    sourceSnapshot: WorkspaceStateV1["sourceSnapshot"],
    currentSnapshot: WorkspaceStateV1["currentSnapshot"],
    sessionId: string
): Promise<void> {
    const repo = new SqliteSessionRepo({ sessionsRoot });
    const session = await repo.create({ cwd: store.identity.canonicalRoot, id: sessionId });
    const state: WorkspaceStateV1 = {
        schemaVersion: 1,
        sessionId,
        operationId: "active-restore",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        kind: "rewind",
        applyMode: "normal",
        forcedPaths: [],
        sourceSnapshot,
        currentSnapshot,
        currentStates: [],
        rewind: {
            fromLeafId: null,
            targetTurnId: "turn-a",
            targetBoundaryId: null,
            redoStates: [],
        },
    };
    await session.appendCustomEntry(WorkspaceControlCustomTypes.state, state);
    session.close();
}

async function makePendingRestore(
    store: WorkspaceSnapshotStore,
    sessionsRoot: string,
    snapshot: WorkspaceStateV1["sourceSnapshot"]
): Promise<{
    record: PendingWorkspaceRestoreV2;
    sourceSnapshot: WorkspaceStateV1["sourceSnapshot"];
    plannedSnapshot: WorkspaceStateV1["currentSnapshot"];
}> {
    const metadata = await store.readSnapshotMetadata(snapshot);
    const sourceCommit = await store.mutationLog.append({
        tree: snapshot.tree,
        metadata: {
            schemaversion: 1,
            workspaceidentity: store.identity.workspaceIdentity,
            workspaceincarnation: store.identity.workspaceIncarnation,
            kind: "external",
        },
    });
    const sourceSnapshot = await store.publishCommitSnapshot({ commit: sourceCommit, ...metadata });
    const plannedCommit = await store.mutationLog.append({
        expectedHead: sourceCommit,
        tree: snapshot.tree,
        metadata: {
            schemaversion: 1,
            workspaceidentity: store.identity.workspaceIdentity,
            workspaceincarnation: store.identity.workspaceIncarnation,
            kind: "rewind",
            sessionid: "restore-session",
            operationid: "active-restore",
            turnid: "turn-a",
        },
    });
    const plannedSnapshot = await store.publishCommitSnapshot({ commit: plannedCommit, ...metadata });
    return {
        sourceSnapshot,
        plannedSnapshot,
        record: {
            schemaVersion: 2,
            operationId: "active-restore",
            workspaceIdentity: store.identity.workspaceIdentity,
            workspaceIncarnation: store.identity.workspaceIncarnation,
            sessionId: "restore-session",
            sessionPath: join(sessionsRoot, "restore-session.db"),
            target: { kind: "rewind", targetTurnId: "turn-a" },
            applyMode: "normal",
            forcedPaths: [],
            expectedSemanticLeafId: null,
            commitParentId: null,
            workspaceStateEntryId: "workspace-state-a",
            workspaceStateTimestamp: "2026-03-15T00:00:00.000Z",
            sourceCommit,
            plannedCommit,
            affectedPaths: [],
        },
    };
}

async function makePendingRedoRestore(
    store: WorkspaceSnapshotStore,
    sessionsRoot: string,
    snapshot: WorkspaceStateV1["sourceSnapshot"]
): Promise<{
    record: PendingWorkspaceRestoreV2;
    linkedSource: WorkspaceStateV1["sourceSnapshot"];
    linkedResult: WorkspaceStateV1["currentSnapshot"];
}> {
    const metadata = await store.readSnapshotMetadata(snapshot);
    const append = async (
        kind: "external" | "rewind" | "redo",
        expectedHead: string | undefined,
        operationId?: string,
        linkedResultCommit?: string
    ) => {
        const commit = await store.mutationLog.append({
            ...(expectedHead ? { expectedHead } : {}),
            tree: snapshot.tree,
            metadata: {
                schemaversion: 1,
                workspaceidentity: store.identity.workspaceIdentity,
                workspaceincarnation: store.identity.workspaceIncarnation,
                kind,
                ...(kind === "external"
                    ? {}
                    : {
                          sessionid: "restore-session",
                          operationid: operationId!,
                          ...(kind === "rewind"
                              ? { turnid: "turn-a" }
                              : {
                                    sourceoperationid: "linked-rewind",
                                    linkedresultcommitid: linkedResultCommit!,
                                }),
                      }),
            },
        });
        return await store.publishCommitSnapshot({ commit, ...metadata });
    };
    const linkedSource = await append("external", undefined);
    const linkedResult = await append("rewind", linkedSource.id, "linked-rewind");
    const actualSource = await append("external", linkedResult.id);
    const planned = await append("redo", actualSource.id, "active-redo", linkedResult.id);
    return {
        linkedSource,
        linkedResult,
        record: {
            schemaVersion: 2,
            operationId: "active-redo",
            workspaceIdentity: store.identity.workspaceIdentity,
            workspaceIncarnation: store.identity.workspaceIncarnation,
            sessionId: "restore-session",
            sessionPath: join(sessionsRoot, "restore-session.db"),
            target: {
                kind: "redo",
                sourceRewindOperationId: "linked-rewind",
                linkedOperation: {
                    operationId: "linked-rewind",
                    sourceSnapshot: linkedSource,
                    currentSnapshot: linkedResult,
                },
            },
            applyMode: "normal",
            forcedPaths: [],
            expectedSemanticLeafId: null,
            commitParentId: null,
            workspaceStateEntryId: "workspace-state-redo",
            workspaceStateTimestamp: "2026-03-20T00:00:00.000Z",
            sourceCommit: actualSource.id,
            plannedCommit: planned.id,
            affectedPaths: [],
        },
    };
}

async function ancestorIdentityChain(path: string): Promise<CanonicalWorkspaceIdentity["ancestorIdentityChain"]> {
    const paths: string[] = [];
    let cursor = path;
    while (true) {
        paths.unshift(cursor);
        const parent = dirname(cursor);
        if (parent === cursor) {
            break;
        }
        cursor = parent;
    }
    return Promise.all(
        paths.map(async (absolutePath) => {
            const stats = await lstat(absolutePath, { bigint: true });
            return {
                absolutePath,
                dev: stats.dev.toString(),
                ino: stats.ino.toString(),
                birthtimeNs: stats.birthtimeNs.toString(),
            };
        })
    );
}
