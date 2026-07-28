// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { afterEach, expect, test, vi } from "vitest";

import { writeDurableJson } from "./durability";
import { WorkspaceGitRunner } from "./git-runner";
import {
    decodePendingWorkspaceBoundaryV1,
    PendingBoundaryStore,
    probeProcessOwner,
    type UnboundPendingBoundaryV1,
} from "./pending-boundary-store";
import { makeProcessOwnerIdentity } from "./process-owner";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import type { WorkspaceSnapshotRefV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";

const CleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("persists strict begin bind after complete transitions and recovers owner disposition", async () => {
    const { store, snapshot } = await makeStore();
    const pending = new PendingBoundaryStore(store);
    const owner = await makeProcessOwnerIdentity();
    const record: UnboundPendingBoundaryV1 = {
        boundaryToken: "boundary-a",
        sessionId: "session-a",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        processOwner: owner,
        nonce: "a".repeat(64),
        before: snapshot,
    };

    await pending.begin(record);
    await expect(pending.begin(record)).rejects.toThrow(/already exists/i);
    expect((await store.listCrestRefs()).map((ref) => ref.name)).toEqual(
        expect.arrayContaining([`refs/crest/snapshots/${snapshot.id}`, store.pendingRefName(record)])
    );
    await expect(pending.recordAfter(record.boundaryToken, snapshot)).rejects.toThrow(/bound/i);
    await pending.bind(record.boundaryToken, "user-a");
    await pending.recordAfter(record.boundaryToken, snapshot);
    await expect(pending.bind(record.boundaryToken, "user-b")).rejects.toThrow(/transition/i);

    const live = await pending.recover([]);
    expect(live).toEqual([
        { record: { ...record, userEntryId: "user-a", after: snapshot }, disposition: "owner-still-live" },
    ]);

    await pending.complete(record.boundaryToken);
    expect(await pending.recover([])).toEqual([]);
    expect((await store.listCrestRefs()).map((ref) => ref.name)).not.toContain(store.pendingRefName(record));
});

test("retires an unbound record whose process owner is dead", async () => {
    const { store, snapshot } = await makeStore();
    const pending = new PendingBoundaryStore(store);
    await pending.begin({
        boundaryToken: "boundary-dead",
        sessionId: "session-dead",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        processOwner: { pid: 2 ** 30, processStartToken: "gone", nonce: "b".repeat(64) },
        nonce: "c".repeat(64),
        before: snapshot,
    });

    const recovered = await pending.recover([] as SessionTreeEntry[]);

    expect(recovered[0]?.disposition).toBe("retire-unbound");
});

test("rejects unknown fields and unsafe boundary tokens before publishing refs", async () => {
    const { store, snapshot } = await makeStore();
    const pending = new PendingBoundaryStore(store);
    const owner = await makeProcessOwnerIdentity();
    const record: UnboundPendingBoundaryV1 = {
        boundaryToken: "safe-token",
        sessionId: "session-a",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        processOwner: owner,
        nonce: "d".repeat(64),
        before: snapshot,
    };

    expect(decodePendingWorkspaceBoundaryV1({ ...record, unknown: true })).toBeUndefined();
    await expect(pending.begin({ ...record, boundaryToken: "../escape" })).rejects.toThrow(/invalid/i);
    expect((await store.listCrestRefs()).some((ref) => ref.name.includes("escape"))).toBe(false);
});

test("recovers bind and after transitions from the pending ref when JSON publication crashes", async () => {
    const { store, snapshot } = await makeStore();
    const pending = new PendingBoundaryStore(store);
    const record: UnboundPendingBoundaryV1 = {
        boundaryToken: "boundary-crash",
        sessionId: "session-crash",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        processOwner: await makeProcessOwnerIdentity(),
        nonce: "e".repeat(64),
        before: snapshot,
    };
    await pending.begin(record);
    const unboundJson = await readFile(pending.path(record.boundaryToken));
    await pending.bind(record.boundaryToken, "user-crash");
    await writeFile(pending.path(record.boundaryToken), unboundJson);

    expect(await pending.read(record.boundaryToken)).toEqual({ ...record, userEntryId: "user-crash" });

    const bound = { ...record, userEntryId: "user-crash" };
    await writeDurableJson(pending.path(record.boundaryToken), bound);
    await pending.recordAfter(record.boundaryToken, snapshot);
    await writeDurableJson(pending.path(record.boundaryToken), bound);

    expect(await pending.read(record.boundaryToken)).toEqual({ ...bound, after: snapshot });
});

test("rejects a corrupt or identity-mismatched pending ref descriptor", async () => {
    const { store, snapshot } = await makeStore();
    const pending = new PendingBoundaryStore(store);
    const record: UnboundPendingBoundaryV1 = {
        boundaryToken: "boundary-corrupt",
        sessionId: "session-corrupt",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        processOwner: await makeProcessOwnerIdentity(),
        nonce: "f".repeat(64),
        before: snapshot,
    };
    await pending.begin(record);
    const corrupt = await store.git.run(["hash-object", "-w", "--stdin", "--no-filters"], {
        gitDir: store.storeRoot,
        stdin: Buffer.from('{"workspaceIdentity":"wrong"}\n'),
        timeoutMs: 30_000,
    });
    await store.git.run(["update-ref", store.pendingRefName(record), corrupt.stdout.toString("ascii").trim()], {
        gitDir: store.storeRoot,
        timeoutMs: 30_000,
    });

    await expect(pending.read(record.boundaryToken)).rejects.toThrow(/ref descriptor/i);
});

test("treats process probe errors as unknown and keeps the owner fail-safe", async () => {
    const { store, snapshot } = await makeStore();
    const probe = {
        signal: () => undefined,
        readStartToken: async () => {
            throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        },
    };
    const pending = new PendingBoundaryStore(store, probe);
    const owner = { pid: process.pid, processStartToken: "unknown", nonce: "1".repeat(64) };
    await pending.begin({
        boundaryToken: "boundary-unknown",
        sessionId: "session-unknown",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        processOwner: owner,
        nonce: "2".repeat(64),
        before: snapshot,
    });

    expect(await probeProcessOwner(owner, probe)).toBe("unknown");
    expect((await pending.recover([]))[0]?.disposition).toBe("owner-still-live");
});

test("makes operation ownership idempotent but rejects conflicting reuse", async () => {
    const { store, snapshot } = await makeStore();
    const record = {
        operationId: "operation-cas",
        sessionId: "session-a",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        snapshot,
    };

    await store.anchorOperation(record);
    await store.anchorOperation(record);
    await expect(store.anchorOperation({ ...record, sessionId: "session-b" })).rejects.toThrow(/already belongs/i);

    const operationRefs = (await store.listCrestRefs()).filter((ref) => ref.name.includes("operation-cas"));
    expect(operationRefs).toHaveLength(1);
    expect(JSON.parse((await store.readBlob(operationRefs[0]!.oid)).toString("utf8"))).toEqual(record);
});

test("rejects operation takeover when only the durable ref survived publication", async () => {
    const { store, snapshot } = await makeStore();
    const record = {
        operationId: "operation-ref-only-conflict",
        sessionId: "session-a",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        snapshot,
    };
    await store.anchorOperation(record);
    await unlink(join(store.storeRoot, "journal", "operations", `${record.operationId}.json`));

    await expect(store.anchorOperation({ ...record, sessionId: "session-b" })).rejects.toThrow(/already belongs/i);
});

test("replays an exact operation owner from its ref-only crash state", async () => {
    const { store, snapshot } = await makeStore();
    const record = {
        operationId: "operation-ref-only-replay",
        sessionId: "session-a",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        snapshot,
    };
    const journalPath = join(store.storeRoot, "journal", "operations", `${record.operationId}.json`);
    await store.anchorOperation(record);
    await unlink(journalPath);

    await store.anchorOperation(record);

    expect(JSON.parse(await readFile(journalPath, "utf8"))).toEqual(record);
});

test("anchors pending snapshot graphs before publishing their state ref", async () => {
    const { store, snapshot } = await makeStore();
    await writeFile(join(store.identity.canonicalRoot, "tracked.txt"), "after");
    const after = (await store.capture({ profile: "terminal", requiredPaths: ["tracked.txt"] })).ref;
    const record = {
        boundaryToken: "boundary-graph",
        sessionId: "session-graph",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        processOwner: await makeProcessOwnerIdentity(),
        nonce: "3".repeat(64),
        before: snapshot,
        userEntryId: "user-graph",
        after,
    };
    await store.deleteCrestRef(`refs/crest/snapshots/${snapshot.id}`);
    await store.deleteCrestRef(`refs/crest/snapshots/${after.id}`);

    await store.anchorPending(record);
    await store.git.run(["reflog", "expire", "--expire=now", "--all"], {
        gitDir: store.storeRoot,
        timeoutMs: 30_000,
    });
    await store.git.run(["gc", "--prune=now"], {
        gitDir: store.storeRoot,
        timeoutMs: 30_000,
    });

    await expect(store.verify(snapshot)).resolves.toBeUndefined();
    await expect(store.verify(after)).resolves.toBeUndefined();
    expect((await store.listCrestRefs()).map((ref) => ref.name)).toEqual(
        expect.arrayContaining([
            `refs/crest/snapshots/${snapshot.id}`,
            `refs/crest/snapshots/${after.id}`,
            store.pendingRefName(record),
        ])
    );
});

test("rejects missing or corrupt pending snapshots without publishing a pending ref", async () => {
    const { store, snapshot } = await makeStore();
    const base: UnboundPendingBoundaryV1 = {
        boundaryToken: "boundary-invalid-before",
        sessionId: "session-invalid",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        processOwner: await makeProcessOwnerIdentity(),
        nonce: "4".repeat(64),
        before: { ...snapshot, id: "f".repeat(40) },
    };

    await expect(store.anchorPending(base)).rejects.toThrow(/corrupt|missing|object/i);
    expect((await store.listCrestRefs()).map((ref) => ref.name)).not.toContain(store.pendingRefName(base));

    const corruptAfter = { ...snapshot, id: snapshot.tree };
    const withCorruptAfter = {
        ...base,
        boundaryToken: "boundary-invalid-after",
        before: snapshot,
        userEntryId: "user-invalid",
        after: corruptAfter,
    };
    await expect(store.anchorPending(withCorruptAfter)).rejects.toThrow(/corrupt|descriptor/i);
    expect((await store.listCrestRefs()).map((ref) => ref.name)).not.toContain(store.pendingRefName(withCorruptAfter));
});

test("reuses capture trust across ordinary pending transitions", async () => {
    const { store, snapshot } = await makeStore();
    const pending = new PendingBoundaryStore(store);
    const run = vi.spyOn(store.git, "run");
    const record: UnboundPendingBoundaryV1 = {
        boundaryToken: "boundary-capture-trust",
        sessionId: "session-trust",
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        processOwner: await makeProcessOwnerIdentity(),
        nonce: "5".repeat(64),
        before: snapshot,
    };

    await pending.begin(record);
    await pending.bind(record.boundaryToken, "user-trust");
    await pending.recordAfter(record.boundaryToken, snapshot);

    expect(treeTraversalCount(run.mock.calls)).toBe(0);
});

test("verifies each untrusted pending descriptor once in a fresh store", async () => {
    const fixture = await makeStore();
    await writeFile(join(fixture.store.identity.canonicalRoot, "tracked.txt"), "after-trust");
    const after = (await fixture.store.capture({ profile: "terminal", requiredPaths: ["tracked.txt"] })).ref;
    const fresh = await WorkspaceSnapshotStore.open({
        dataRoot: fixture.dataRoot,
        identity: fixture.identity,
        git: new WorkspaceGitRunner(),
        processOwner: await makeProcessOwnerIdentity(),
    });
    const pending = new PendingBoundaryStore(fresh);
    const run = vi.spyOn(fresh.git, "run");
    const record: UnboundPendingBoundaryV1 = {
        boundaryToken: "boundary-fresh-trust",
        sessionId: "session-fresh",
        workspaceIdentity: fresh.identity.workspaceIdentity,
        workspaceIncarnation: fresh.identity.workspaceIncarnation,
        processOwner: await makeProcessOwnerIdentity(),
        nonce: "6".repeat(64),
        before: fixture.snapshot,
    };

    await pending.begin(record);
    const afterBegin = treeTraversalCount(run.mock.calls);
    expect(afterBegin).toBeGreaterThan(0);
    await pending.bind(record.boundaryToken, "user-fresh");
    expect(treeTraversalCount(run.mock.calls)).toBe(afterBegin);
    await pending.recordAfter(record.boundaryToken, after);
    const afterRecord = treeTraversalCount(run.mock.calls);
    expect(afterRecord).toBeGreaterThan(afterBegin);
    await fresh.anchorPending({ ...record, userEntryId: "user-fresh", after });
    expect(treeTraversalCount(run.mock.calls)).toBe(afterRecord);

    const forged = {
        ...record,
        boundaryToken: "boundary-forged-descriptor",
        before: { ...fixture.snapshot, tree: "f".repeat(40) },
    };
    await expect(fresh.anchorPending(forged)).rejects.toThrow(/corrupt|descriptor/i);
    expect((await fresh.listCrestRefs()).map((ref) => ref.name)).not.toContain(fresh.pendingRefName(forged));
});

test("anchors an operation without scanning unrelated owner refs", async () => {
    const { store, snapshot } = await makeStore();
    const records = Array.from({ length: 5 }, (_, index) => ({
        operationId: `operation-scale-${index}`,
        sessionId: `session-${index}`,
        workspaceIdentity: store.identity.workspaceIdentity,
        workspaceIncarnation: store.identity.workspaceIncarnation,
        snapshot,
    }));
    for (const record of records) {
        await store.anchorOperation(record);
    }
    const readRef = vi.spyOn(store, "readCrestRefBlob");

    await store.anchorOperation(records[4]!);

    expect(readRef).toHaveBeenCalledTimes(1);
    expect(readRef).toHaveBeenCalledWith(`refs/crest/ops/${records[4]!.operationId}`);
});

function treeTraversalCount(calls: ReadonlyArray<readonly [readonly string[], unknown?]>): number {
    return calls.filter(([args]) => args[0] === "cat-file" && args[1] === "tree").length;
}

async function makeStore(): Promise<{
    store: WorkspaceSnapshotStore;
    snapshot: WorkspaceSnapshotRefV1;
    dataRoot: string;
    identity: CanonicalWorkspaceIdentity;
}> {
    const root = await mkdtemp(join(process.cwd(), ".crest-pending-"));
    CleanupRoots.push(root);
    const workspace = join(root, "workspace");
    const dataRoot = join(root, "data");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(workspace);
    await writeFile(join(workspace, "tracked.txt"), "value");
    const identity: CanonicalWorkspaceIdentity = {
        canonicalRoot: workspace,
        workspaceIdentity: "1".repeat(64),
        workspaceIncarnation: "2".repeat(64),
        storeKey: "store-a",
        ancestorIdentityChain: await ancestorIdentityChain(workspace),
    };
    const store = await WorkspaceSnapshotStore.open({
        dataRoot,
        identity,
        git: new WorkspaceGitRunner(),
        processOwner: await makeProcessOwnerIdentity(),
    });
    const captured = await store.capture({ profile: "terminal", requiredPaths: ["tracked.txt"] });
    return { store, snapshot: captured.ref, dataRoot, identity };
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
