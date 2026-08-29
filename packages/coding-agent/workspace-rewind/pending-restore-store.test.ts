// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import {
    decodePendingWorkspaceRestoreV2,
    PendingWorkspaceRestoreStore,
    type PendingWorkspaceRestoreV2,
} from "./pending-restore-store";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import type { WorkspaceSnapshotRefV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";

const CleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("accepts only the exact minimal commit-backed pending restore schema", () => {
    const record = makeDecodedRecord();

    expect(decodePendingWorkspaceRestoreV2(record)).toEqual(record);
    for (const legacy of [
        { paths: [] },
        { safetySnapshot: {} },
        { phase: "prepared" },
        { createdParentDirectories: [] },
        { resultSnapshot: {} },
    ]) {
        expect(decodePendingWorkspaceRestoreV2({ ...record, ...legacy })).toBeUndefined();
    }
    expect(decodePendingWorkspaceRestoreV2({ ...record, affectedPaths: ["z.txt", "a.txt"] })).toBeUndefined();
    expect(decodePendingWorkspaceRestoreV2({ ...record, affectedPaths: ["a.txt", "a.txt"] })).toBeUndefined();
    expect(decodePendingWorkspaceRestoreV2({ ...record, forcedPaths: ["other.txt"] })).toBeUndefined();
    expect(decodePendingWorkspaceRestoreV2({ ...record, sourceCommit: "not-a-commit" })).toBeUndefined();
    expect(decodePendingWorkspaceRestoreV2({ ...record, plannedCommit: record.sourceCommit })).toBeUndefined();
});

test("requires canonical linked endpoints for every Redo-like pending target", () => {
    const base = makeDecodedRecord();
    const linkedOperation = {
        operationId: "rewind-a",
        sourceSnapshot: decodedSnapshot("5".repeat(40)),
        currentSnapshot: decodedSnapshot("6".repeat(40)),
    };
    const record = {
        ...base,
        target: { kind: "redo", sourceRewindOperationId: "rewind-a", linkedOperation } as const,
    };

    expect(decodePendingWorkspaceRestoreV2(record)).toEqual(record);
    expect(
        decodePendingWorkspaceRestoreV2({
            ...record,
            target: { kind: "redo", sourceRewindOperationId: "rewind-a" },
        })
    ).toBeUndefined();
    expect(
        decodePendingWorkspaceRestoreV2({
            ...record,
            target: { ...record.target, linkedOperation: { ...linkedOperation, operationId: "other" } },
        })
    ).toBeUndefined();
    expect(
        decodePendingWorkspaceRestoreV2({
            ...record,
            target: {
                ...record.target,
                linkedOperation: { ...linkedOperation, currentSnapshot: linkedOperation.sourceSnapshot },
            },
        })
    ).toBeUndefined();
});

test("publishes one record only after validating both commit associations and exact changed paths", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);

    await fixture.store.withWorkspaceLock(() => pending.publishLocked(fixture.record));

    expect(await pending.readCandidate()).toEqual({ kind: "valid", record: fixture.record });
    await expect(fixture.store.withWorkspaceLock(() => pending.publishLocked(fixture.record))).rejects.toThrow(
        /already pending/i
    );
    await fixture.store.withWorkspaceLock(() => pending.removeLocked(fixture.record.operationId));
    await expect(pending.readCandidate()).resolves.toEqual({ kind: "none" });
});

test("publishes a trusted prepared record without a redundant active-journal read", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const readActiveEntry = vi.spyOn(pending, "readActiveEntry");

    await fixture.store.withWorkspaceLock(() => pending.publishPreparedLocked(fixture.record));

    expect(readActiveEntry).not.toHaveBeenCalled();
    expect(await pending.readCandidate()).toEqual({ kind: "valid", record: fixture.record });
});

test("removes its just-published record without rereading the active journal", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const requireValidActive = vi.spyOn(pending, "requireValidActive");

    await fixture.store.withWorkspaceLock(() => pending.publishPreparedLocked(fixture.record));
    await fixture.store.withWorkspaceLock(() => pending.removeLocked(fixture.record.operationId));

    expect(requireValidActive).not.toHaveBeenCalled();
    await expect(pending.readCandidate()).resolves.toEqual({ kind: "none" });
});

test("rejects pending paths that are not the authoritative result-commit diff", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);

    await expect(
        fixture.store.withWorkspaceLock(() =>
            pending.publishLocked({ ...fixture.record, affectedPaths: ["different.txt"] })
        )
    ).rejects.toThrow(/paths do not match/i);
    await expect(pending.readCandidate()).resolves.toEqual({ kind: "none" });
});

test("rejects a result commit whose operation metadata differs from pending", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);

    await expect(
        fixture.store.withWorkspaceLock(() =>
            pending.publishLocked({ ...fixture.record, operationId: "operation-other" })
        )
    ).rejects.toThrow(/does not match its operation/i);
});

test("rejects tampered linked endpoint descriptors and linked-result metadata", async () => {
    const fixture = await makeRedoFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const target = fixture.record.target;
    if (target.kind !== "redo") throw new Error("Redo fixture target is invalid");

    await expect(
        fixture.store.withWorkspaceLock(() =>
            pending.publishLocked({
                ...fixture.record,
                target: {
                    ...target,
                    linkedOperation: {
                        ...target.linkedOperation,
                        sourceSnapshot: {
                            ...target.linkedOperation.sourceSnapshot,
                            scopeManifest: "f".repeat(40),
                        },
                    },
                },
            })
        )
    ).rejects.toThrow(/linked result/i);
    await expect(
        fixture.store.withWorkspaceLock(() =>
            pending.publishLocked({
                ...fixture.record,
                target: {
                    ...target,
                    linkedOperation: {
                        ...target.linkedOperation,
                        currentSnapshot: target.linkedOperation.sourceSnapshot,
                    },
                },
            })
        )
    ).rejects.toThrow(/invalid pending|does not match/i);
    await expect(pending.readCandidate()).resolves.toEqual({ kind: "none" });
});

test("returns corrupt bytes as a diagnostic without deleting them", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const path = join(fixture.store.storeRoot, "journal", "restore", "pending.json");
    const bytes = Buffer.from('{"operationId":"operation-a","schemaVersion":1');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });

    const candidate = await pending.readCandidate();

    expect(candidate).toMatchObject({ kind: "corrupt", operationId: "operation-a" });
    expect(await readFile(path)).toEqual(bytes);
});

interface Fixture {
    store: WorkspaceSnapshotStore;
    record: PendingWorkspaceRestoreV2;
}

async function makeFixture(): Promise<Fixture> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "crest-pending-restore-v2-")));
    CleanupRoots.push(root);
    const workspace = join(root, "workspace");
    const sessionsRoot = join(root, "sessions");
    await mkdir(workspace);
    await mkdir(sessionsRoot);
    await writeFile(join(workspace, "tracked.txt"), "source\n");
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
        git: new WorkspaceGitRunner(),
        processOwner: { pid: process.pid, processStartToken: "test-start", nonce: "a".repeat(64) },
    });
    const sourceCaptured = await store.capture({ profile: "terminal" });
    const source = await appendSnapshot(store, sourceCaptured.ref, {
        kind: "external",
    });
    await writeFile(join(workspace, "tracked.txt"), "planned\n");
    const plannedCaptured = await store.capture({ profile: "terminal" });
    const planned = await prepareSnapshot(store, plannedCaptured.ref, {
        expectedHead: source.id,
        kind: "rewind",
        sessionId: "session-a",
        turnId: "turn-a",
        operationId: "operation-a",
    });
    await writeFile(join(workspace, "tracked.txt"), "source\n");
    return {
        store,
        record: {
            ...makeDecodedRecord(),
            workspaceIdentity: identity.workspaceIdentity,
            workspaceIncarnation: identity.workspaceIncarnation,
            sessionPath: join(sessionsRoot, "session-a.db"),
            sourceCommit: source.id,
            plannedCommit: planned.id,
            affectedPaths: ["tracked.txt"],
        },
    };
}

async function makeRedoFixture(): Promise<Fixture> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "crest-pending-redo-v2-")));
    CleanupRoots.push(root);
    const workspace = join(root, "workspace");
    const sessionsRoot = join(root, "sessions");
    await Promise.all([mkdir(workspace), mkdir(sessionsRoot)]);
    await writeFile(join(workspace, "tracked.txt"), "source\n");
    const identity: CanonicalWorkspaceIdentity = {
        canonicalRoot: workspace,
        workspaceIdentity: "3".repeat(64),
        workspaceIncarnation: "4".repeat(64),
        storeKey: "store-redo",
        ancestorIdentityChain: await ancestorIdentityChain(workspace),
    };
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: join(root, "data"),
        identity,
        git: new WorkspaceGitRunner(),
        processOwner: { pid: process.pid, processStartToken: "test-start", nonce: "b".repeat(64) },
    });
    const sourceCaptured = await store.capture({ profile: "terminal" });
    const linkedSource = await appendSnapshot(store, sourceCaptured.ref, { kind: "external" });
    const linkedResult = await appendSnapshot(store, sourceCaptured.ref, {
        expectedHead: linkedSource.id,
        kind: "rewind",
        sessionId: "session-a",
        turnId: "turn-a",
        operationId: "rewind-a",
    });
    const actualSource = await appendSnapshot(store, sourceCaptured.ref, {
        expectedHead: linkedResult.id,
        kind: "external",
    });
    await writeFile(join(workspace, "tracked.txt"), "planned\n");
    const plannedCaptured = await store.capture({ profile: "terminal" });
    const planned = await prepareSnapshot(store, plannedCaptured.ref, {
        expectedHead: actualSource.id,
        kind: "redo",
        sessionId: "session-a",
        operationId: "operation-a",
        sourceOperationId: "rewind-a",
        linkedResultCommitId: linkedResult.id,
    });
    await writeFile(join(workspace, "tracked.txt"), "source\n");
    return {
        store,
        record: {
            ...makeDecodedRecord(),
            workspaceIdentity: identity.workspaceIdentity,
            workspaceIncarnation: identity.workspaceIncarnation,
            sessionPath: join(sessionsRoot, "session-a.db"),
            target: {
                kind: "redo",
                sourceRewindOperationId: "rewind-a",
                linkedOperation: {
                    operationId: "rewind-a",
                    sourceSnapshot: linkedSource,
                    currentSnapshot: linkedResult,
                },
            },
            sourceCommit: actualSource.id,
            plannedCommit: planned.id,
            affectedPaths: ["tracked.txt"],
        },
    };
}

async function appendSnapshot(
    store: WorkspaceSnapshotStore,
    snapshot: WorkspaceSnapshotRefV1,
    input: {
        expectedHead?: string;
        kind: "external" | "rewind" | "redo";
        sessionId?: string;
        turnId?: string;
        operationId?: string;
        sourceOperationId?: string;
        linkedResultCommitId?: string;
    }
): Promise<WorkspaceSnapshotRefV1> {
    const prepared = await prepareSnapshot(store, snapshot, input);
    await store.mutationLog.publishPrepared(prepared.prepared);
    return prepared.ref;
}

async function prepareSnapshot(
    store: WorkspaceSnapshotStore,
    snapshot: WorkspaceSnapshotRefV1,
    input: {
        expectedHead?: string;
        kind: "external" | "rewind" | "redo";
        sessionId?: string;
        turnId?: string;
        operationId?: string;
        sourceOperationId?: string;
        linkedResultCommitId?: string;
    }
): Promise<{
    id: string;
    ref: WorkspaceSnapshotRefV1;
    prepared: Awaited<ReturnType<typeof store.mutationLog.prepare>>;
}> {
    const prepared = await store.mutationLog.prepare({
        ...(input.expectedHead ? { expectedHead: input.expectedHead } : {}),
        tree: snapshot.tree,
        metadata: {
            schemaversion: 1,
            workspaceidentity: store.identity.workspaceIdentity,
            workspaceincarnation: store.identity.workspaceIncarnation,
            kind: input.kind,
            ...(input.sessionId ? { sessionid: input.sessionId } : {}),
            ...(input.turnId ? { turnid: input.turnId } : {}),
            ...(input.operationId ? { operationid: input.operationId } : {}),
            ...(input.sourceOperationId ? { sourceoperationid: input.sourceOperationId } : {}),
            ...(input.linkedResultCommitId ? { linkedresultcommitid: input.linkedResultCommitId } : {}),
        },
    });
    const metadata = await store.readSnapshotMetadata(snapshot);
    const ref = await store.publishCommitSnapshot({
        commit: prepared.commit,
        scope: metadata.scope,
        coverage: metadata.coverage,
    });
    return { id: prepared.commit, ref, prepared };
}

function decodedSnapshot(id: string): WorkspaceSnapshotRefV1 {
    return {
        id,
        workspaceIdentity: "3".repeat(64),
        workspaceIncarnation: "4".repeat(64),
        tree: "7".repeat(40),
        scopeManifest: "8".repeat(40),
    };
}

function makeDecodedRecord(): PendingWorkspaceRestoreV2 {
    return {
        schemaVersion: 2,
        operationId: "operation-a",
        workspaceIdentity: "3".repeat(64),
        workspaceIncarnation: "4".repeat(64),
        sessionId: "session-a",
        sessionPath: "/sessions/session-a.db",
        target: { kind: "rewind", targetTurnId: "turn-a" },
        applyMode: "normal",
        forcedPaths: [],
        expectedSemanticLeafId: "old-leaf",
        commitParentId: "target-boundary",
        workspaceStateEntryId: "workspace-state-a",
        workspaceStateTimestamp: "2026-08-08T00:00:00.000Z",
        sourceCommit: "1".repeat(40),
        plannedCommit: "2".repeat(40),
        affectedPaths: ["a.txt", "dir/file.txt"],
    };
}

async function ancestorIdentityChain(path: string): Promise<CanonicalWorkspaceIdentity["ancestorIdentityChain"]> {
    const paths: string[] = [];
    let cursor = path;
    while (true) {
        paths.unshift(cursor);
        const parent = dirname(cursor);
        if (parent === cursor) break;
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
