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

test("retains bound and unbound pending plus operation journal owners without consulting quota", async () => {
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
    await store.anchorOperation({
        operationId: "operation-owner",
        sessionId: "session-operation",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        snapshot,
    });
    const quota = vi.spyOn(store, "getQuotaStatus").mockRejectedValue(new Error("soft quota"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));

    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    vi.advanceTimersByTime(SnapshotRetentionLimits.orphanGraceMs * 2);
    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    expect(quota).not.toHaveBeenCalled();
    await store.verify(snapshot);
});

test("retains workspace state current and redo snapshots through aggressive Git GC", async () => {
    const { store, sessionsRoot, snapshot: currentSnapshot } = await makeStore();
    await writeFile(join(store.identity.canonicalRoot, "tracked.txt"), "redo-value");
    const { ref: redoSnapshot } = await store.capture({ profile: "terminal", requiredPaths: ["tracked.txt"] });
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
        currentSnapshot,
        currentStates: [],
        rewind: {
            fromLeafId: null,
            targetTurnId: "turn-a",
            targetBoundaryId: null,
            redoSnapshot,
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
    await Promise.all([store.verify(currentSnapshot), store.verify(redoSnapshot)]);
});

test("grace-collects orphan pending and operation refs without pruning a session-owned graph", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    await addStateOwner(store, sessionsRoot, snapshot, "state-owner");
    const pendingRef = `refs/crest/pending/${"a".repeat(64)}/orphan-boundary`;
    const operationRef = "refs/crest/ops/orphan-operation";
    await store.git.run(["update-ref", pendingRef, snapshot.id], {
        gitDir: store.storeRoot,
        timeoutMs: 30_000,
    });
    await store.git.run(["update-ref", operationRef, snapshot.id], {
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
    expect(expired.removedRefs.sort()).toEqual([operationRef, pendingRef].sort());
    expect((await store.listCrestRefs()).map((ref) => ref.name)).toContain(`refs/crest/snapshots/${snapshot.id}`);
    await store.verify(snapshot);

    await store.git.run(["update-ref", operationRef, snapshot.id], {
        gitDir: store.storeRoot,
        timeoutMs: 30_000,
    });
    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
    expect((await store.listCrestRefs()).map((ref) => ref.name)).toContain(operationRef);
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
    const operationRef = "refs/crest/ops/batch-operation";
    for (const refName of [pendingRef, operationRef]) {
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
        expect.arrayContaining([pendingRef, operationRef])
    );
    deletion.mockRestore();
    expect((await reconcileSnapshotRefs({ store, sessionsRoot })).removedRefs).toEqual([]);
});

test("reports refs already removed when Git GC fails after the atomic deletion", async () => {
    const { store, sessionsRoot, snapshot } = await makeStore();
    await addStateOwner(store, sessionsRoot, snapshot, "gc-owner");
    const pendingRef = `refs/crest/pending/${"c".repeat(64)}/gc-pending`;
    const operationRef = "refs/crest/ops/gc-operation";
    for (const refName of [pendingRef, operationRef]) {
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

    expect(report.removedRefs.sort()).toEqual([pendingRef, operationRef].sort());
    expect(report.failClosedReason).toMatch(/cleanup failed/i);
    expect((await store.listCrestRefs()).map((ref) => ref.name)).not.toEqual(
        expect.arrayContaining([pendingRef, operationRef])
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

test("fails closed on a corrupt pending or operation owner record", async () => {
    for (const directory of ["pending", "operations"]) {
        const { store, sessionsRoot } = await makeStore();
        const root = join(store.storeRoot, "journal", directory);
        await mkdir(root, { recursive: true });
        await writeFile(join(root, "broken.json"), "{}");

        const report = await reconcileSnapshotRefs({ store, sessionsRoot });

        expect(report.removedRefs).toEqual([]);
        expect(report.failClosedReason).toMatch(/owner source/i);
    }
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
        kind: "redo",
        applyMode: "normal",
        forcedPaths: [],
        currentSnapshot: snapshot,
        currentStates: [],
    };
    await session.appendCustomEntry(WorkspaceControlCustomTypes.state, state);
    session.close();
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
