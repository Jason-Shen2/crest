// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test } from "vitest";

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

async function appendSnapshot(
    store: WorkspaceSnapshotStore,
    snapshot: WorkspaceSnapshotRefV1,
    input: { kind: "external" }
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
        kind: "external" | "rewind";
        sessionId?: string;
        turnId?: string;
        operationId?: string;
    }
): Promise<{ id: string; ref: WorkspaceSnapshotRefV1; prepared: Awaited<ReturnType<typeof store.mutationLog.prepare>> }> {
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
