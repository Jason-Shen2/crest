// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renameSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { encodeDurableJson } from "./durability";
import { WorkspaceGitRunner } from "./git-runner";
import {
    decodePendingWorkspaceRestoreV1,
    PendingWorkspaceRestoreStore,
    type PendingWorkspaceRestoreV1,
} from "./pending-restore-store";
import { makeProcessOwnerIdentity } from "./process-owner";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";

const CleanupRoots: string[] = [];

afterEach(async () => {
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("node:child_process");
    vi.resetModules();
    vi.restoreAllMocks();
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("publishes only the fixed active record after verifying and anchoring its safety snapshot", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const first = makeRecord(fixture, "operation-a");
    const verify = vi.spyOn(fixture.store, "verify");
    const anchor = vi.spyOn(fixture.store, "anchorSnapshot");

    await fixture.store.withWorkspaceLock(() => pending.publishLocked(first));

    expect(await pending.readCandidate()).toEqual({ kind: "valid", record: first });
    expect(verify).toHaveBeenCalledWith(first.safetySnapshot);
    expect(anchor).toHaveBeenCalledWith(first.safetySnapshot);
    expect(await readFile(join(fixture.store.storeRoot, "journal", "restore", "pending.json"), "utf8")).toContain(
        '"operationId":"operation-a"'
    );

    verify.mockClear();
    anchor.mockClear();
    const second = makeRecord(fixture, "operation-b");
    await expect(fixture.store.withWorkspaceLock(() => pending.publishLocked(second))).rejects.toThrow(
        /already pending/i
    );
    expect(verify).toHaveBeenCalledWith(second.safetySnapshot);
    expect(anchor).toHaveBeenCalledWith(second.safetySnapshot);
    expect(await pending.readCandidate()).toEqual({ kind: "valid", record: first });
});

test("strictly decodes the phase-free pending restore schema", async () => {
    const fixture = await makeFixture();
    const record = makeRecord(fixture);

    expect(decodePendingWorkspaceRestoreV1(record)).toEqual(record);
    for (const extra of [
        { phase: "prepared" },
        { resultSnapshot: record.safetySnapshot },
        { fingerprint: "a".repeat(64) },
        { unknown: true },
    ]) {
        expect(decodePendingWorkspaceRestoreV1({ ...record, ...extra })).toBeUndefined();
    }
    expect(decodePendingWorkspaceRestoreV1({ ...record, sessionPath: "relative/session.db" })).toBeUndefined();
    expect(
        decodePendingWorkspaceRestoreV1({
            ...record,
            sessionPath: `${fixture.sessionsRoot}${sep}nested${sep}..${sep}session-a.db`,
        })
    ).toBeUndefined();
    expect(decodePendingWorkspaceRestoreV1({ ...record, operationId: "unsafe/id" })).toBeUndefined();
    expect(decodePendingWorkspaceRestoreV1({ ...record, sessionId: "" })).toBeUndefined();
    expect(decodePendingWorkspaceRestoreV1({ ...record, workspaceStateEntryId: "bad\0entry" })).toBeUndefined();
    expect(
        decodePendingWorkspaceRestoreV1({
            ...record,
            paths: [record.paths[1]!, record.paths[0]!],
        })
    ).toBeUndefined();
    expect(
        decodePendingWorkspaceRestoreV1({
            ...record,
            paths: [record.paths[0]!, record.paths[0]!],
        })
    ).toBeUndefined();
    expect(decodePendingWorkspaceRestoreV1({ ...record, forcedPaths: ["z.txt", "a.txt"] })).toBeUndefined();
    expect(decodePendingWorkspaceRestoreV1({ ...record, forcedPaths: ["a.txt", "a.txt"] })).toBeUndefined();
    for (const stateField of ["before", "target"] as const) {
        expect(
            decodePendingWorkspaceRestoreV1({
                ...record,
                paths: [
                    { ...record.paths[0]!, [stateField]: { state: "excluded", reason: "ignored" } },
                    record.paths[1],
                ],
            })
        ).toBeUndefined();
    }
    expect(
        decodePendingWorkspaceRestoreV1({
            ...record,
            safetySnapshot: { ...record.safetySnapshot, workspaceIdentity: "9".repeat(64) },
        })
    ).toBeUndefined();
});

test("rejects unpaired UTF-16 surrogates in every free-form persisted string family", async () => {
    const fixture = await makeFixture();
    const record = makeRecord(fixture);
    for (const unpaired of ["\ud800", "\udc00"]) {
        const invalidRecords = [
            { ...record, sessionId: `session-${unpaired}` },
            { ...record, sessionPath: `${record.sessionPath}-${unpaired}` },
            { ...record, target: { kind: "rewind", targetTurnId: `turn-${unpaired}` } },
            { ...record, commitParentId: `parent-${unpaired}` },
            { ...record, expectedSemanticLeafId: `leaf-${unpaired}` },
            { ...record, workspaceStateEntryId: `entry-${unpaired}` },
            {
                ...record,
                paths: [{ ...record.paths[0]!, path: `a-${unpaired}.txt` }, record.paths[1]],
            },
            {
                ...record,
                paths: [
                    record.paths[0],
                    {
                        ...record.paths[1]!,
                        path: `dir-${unpaired}/file.txt`,
                        createdParentDirectories: [`dir-${unpaired}`],
                    },
                ],
            },
        ];

        for (const invalid of invalidRecords) {
            expect(decodePendingWorkspaceRestoreV1(invalid)).toBeUndefined();
        }
    }
});

test("returns truncated active bytes as a corrupt candidate without deleting them", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const path = join(fixture.store.storeRoot, "journal", "restore", "pending.json");
    const bytes = Buffer.from('{"operationId":"operation-a","schemaVersion":1');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });

    const candidate = await pending.readCandidate();

    expect(candidate).toMatchObject({ kind: "corrupt", operationId: "operation-a" });
    expect(candidate.kind === "corrupt" && candidate.bytes.equals(bytes)).toBe(true);
    expect(await readFile(path)).toEqual(bytes);
});

test("candidate sees a linked first publication before locked recovery removes its fixed temp", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const record = makeRecord(fixture);
    const root = join(fixture.store.storeRoot, "journal", "restore");
    const destination = join(root, "pending.json");
    const temporary = join(root, ".pending.json.publish.tmp");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(temporary, encodeDurableJson(record), { mode: 0o600 });
    await link(temporary, destination);

    expect(await pending.readCandidate()).toEqual({ kind: "valid", record });
    expect((await lstat(temporary)).nlink).toBe(2);

    expect(await fixture.store.withWorkspaceLock(() => pending.readLocked())).toEqual({ kind: "valid", record });
    await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(destination)).nlink).toBe(1);
});

test("publish preflight durably discards an unpublished fixed temp", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const record = makeRecord(fixture);
    const root = join(fixture.store.storeRoot, "journal", "restore");
    const temporary = join(root, ".pending.json.publish.tmp");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(temporary, "abandoned", { mode: 0o600 });

    await fixture.store.withWorkspaceLock(() => pending.publishLocked(record));

    expect(await pending.readCandidate()).toEqual({ kind: "valid", record });
    await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
});

test("ignores resolved audit accumulation when reading and publishing the fixed active record", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const root = join(fixture.store.storeRoot, "journal", "restore");
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (let start = 0; start < 4_097; start += 128) {
        await Promise.all(
            Array.from({ length: Math.min(128, 4_097 - start) }, (_, offset) =>
                writeFile(join(root, `resolved-audit-${start + offset}.json`), "not an active record", {
                    mode: 0o600,
                })
            )
        );
    }

    expect(await pending.readCandidate()).toEqual({ kind: "none" });
    expect(await pending.readLocked()).toEqual({ kind: "none" });

    const record = makeRecord(fixture);
    await fixture.store.withWorkspaceLock(() => pending.publishLocked(record));
    expect(await pending.readLocked()).toEqual({ kind: "valid", record });
}, 30_000);

test("cannot miss an active pending record when its restore directory is swapped and restored during read", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const record = makeRecord(fixture);
    await fixture.store.withWorkspaceLock(() => pending.publishLocked(record));
    const root = join(fixture.store.storeRoot, "journal", "restore");
    const held = join(dirname(root), "restore-held");
    const replacement = join(dirname(root), "restore-replacement");
    await mkdir(replacement, { mode: 0o700 });
    let swapped = false;
    let restored = false;
    vi.doMock("node:fs/promises", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:fs/promises")>();
        return {
            ...actual,
            lstat: async (...args: Parameters<typeof actual.lstat>) => {
                const path = String(args[0]);
                if (!swapped && path === root) {
                    const state = await actual.lstat(...args);
                    renameSync(root, held);
                    renameSync(replacement, root);
                    swapped = true;
                    return state;
                }
                if (swapped && !restored && path === root) {
                    renameSync(root, replacement);
                    renameSync(held, root);
                    restored = true;
                }
                return actual.lstat(...args);
            },
        };
    });
    vi.doMock("node:child_process", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:child_process")>();
        return {
            ...actual,
            spawn: (...args: Parameters<typeof actual.spawn>) => {
                const child = actual.spawn(...args);
                if (swapped && !restored && args[2]?.cwd === root) {
                    renameSync(root, replacement);
                    renameSync(held, root);
                    restored = true;
                }
                return child;
            },
        };
    });
    vi.resetModules();
    const isolated = await import("./pending-restore-store");
    const isolatedPending = new isolated.PendingWorkspaceRestoreStore(fixture.store);

    await expect(isolatedPending.readCandidate()).rejects.toThrow(/anchor|changed|directory/i);
    expect({ swapped, restored }).toEqual({ swapped: true, restored: true });
    expect(await pending.readCandidate()).toEqual({ kind: "valid", record });
});

test("updates created parent directory progress only for the active operation and path", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const record = makeRecord(fixture);
    await fixture.store.withWorkspaceLock(() => pending.publishLocked(record));

    await expect(
        fixture.store.withWorkspaceLock(() =>
            pending.updateCreatedParentDirectoriesLocked("other-operation", "dir/file.txt", ["dir"])
        )
    ).rejects.toThrow(/operation/i);
    await expect(
        fixture.store.withWorkspaceLock(() =>
            pending.updateCreatedParentDirectoriesLocked(record.operationId, "missing.txt", [])
        )
    ).rejects.toThrow(/path/i);
    for (const directories of [["dir/nested", "dir"], ["dir", "dir"], ["../dir"], ["other"]]) {
        await expect(
            fixture.store.withWorkspaceLock(() =>
                pending.updateCreatedParentDirectoriesLocked(record.operationId, "dir/file.txt", directories)
            )
        ).rejects.toThrow(/director/i);
    }

    const updated = await fixture.store.withWorkspaceLock(() =>
        pending.updateCreatedParentDirectoriesLocked(record.operationId, "dir/file.txt", ["dir"])
    );
    expect(updated.paths[1]!.createdParentDirectories).toEqual(["dir"]);
    await expect(
        fixture.store.withWorkspaceLock(() =>
            pending.updateCreatedParentDirectoriesLocked(record.operationId, "dir/file.txt", [])
        )
    ).rejects.toThrow(/monotonic|remove|created/i);
    expect(await pending.readCandidate()).toEqual({ kind: "valid", record: updated });
});

test("removes only the matching valid active operation", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const record = makeRecord(fixture);
    await fixture.store.withWorkspaceLock(() => pending.publishLocked(record));

    await expect(fixture.store.withWorkspaceLock(() => pending.removeLocked("other-operation"))).rejects.toThrow(
        /operation/i
    );
    await fixture.store.withWorkspaceLock(() => pending.removeLocked(record.operationId));

    expect(await pending.readCandidate()).toEqual({ kind: "none" });
});

test("locked update remove and audit recover stale fixed temps without blocking later publication", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const root = join(fixture.store.storeRoot, "journal", "restore");
    const destination = join(root, "pending.json");
    const temporary = join(root, ".pending.json.publish.tmp");
    const first = makeRecord(fixture, "operation-a");
    await fixture.store.withWorkspaceLock(() => pending.publishLocked(first));

    await link(destination, temporary);
    await fixture.store.withWorkspaceLock(() =>
        pending.updateCreatedParentDirectoriesLocked(first.operationId, "dir/file.txt", ["dir"])
    );
    await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });

    await link(destination, temporary);
    await fixture.store.withWorkspaceLock(() => pending.removeLocked(first.operationId));
    await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });

    const second = makeRecord(fixture, "operation-b");
    await fixture.store.withWorkspaceLock(() => pending.publishLocked(second));
    await link(destination, temporary);
    await fixture.store.withWorkspaceLock(() => pending.resolveToAuditLocked(second.operationId, "keep-current"));
    await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });

    const third = makeRecord(fixture, "operation-c");
    await fixture.store.withWorkspaceLock(() => pending.publishLocked(third));
    expect(await pending.readCandidate()).toEqual({ kind: "valid", record: third });
});

test("atomically resolves a valid pending record to non-owning audit without changing its bytes", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const record = makeRecord(fixture);
    await fixture.store.withWorkspaceLock(() => pending.publishLocked(record));
    const activePath = join(fixture.store.storeRoot, "journal", "restore", "pending.json");
    const bytes = await readFile(activePath);

    await fixture.store.withWorkspaceLock(() => pending.resolveToAuditLocked(record.operationId, "keep-current"));

    expect(await pending.readCandidate()).toEqual({ kind: "none" });
    const names = (await readdir(dirname(activePath))).filter((name) => name !== "pending.json");
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^resolved-operation-a-\d+-keep-current\.json$/);
    expect(await readFile(join(dirname(activePath), names[0]!))).toEqual(bytes);
});

test("atomically quarantines corrupt active bytes using the scanned operation id", async () => {
    const fixture = await makeFixture();
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const root = join(fixture.store.storeRoot, "journal", "restore");
    const bytes = Buffer.from('{"operationId":"operation-corrupt"');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "pending.json"), bytes, { mode: 0o600 });
    const candidate = await pending.readCandidate();
    expect(candidate).toMatchObject({ kind: "corrupt", operationId: "operation-corrupt" });

    await fixture.store.withWorkspaceLock(() => pending.resolveToAuditLocked("operation-corrupt", "quarantine"));

    expect(await pending.readCandidate()).toEqual({ kind: "none" });
    const audit = (await readdir(root)).find((name) => name.includes("quarantine"));
    expect(audit).toBeDefined();
    expect(await readFile(join(root, audit!))).toEqual(bytes);
});

interface Fixture {
    store: WorkspaceSnapshotStore;
    sessionsRoot: string;
    snapshot: Awaited<ReturnType<WorkspaceSnapshotStore["capture"]>>["ref"];
}

async function makeFixture(): Promise<Fixture> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "crest-pending-restore-")));
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
        git: new WorkspaceGitRunner(),
        processOwner: await makeProcessOwnerIdentity(),
    });
    const { ref: snapshot } = await store.capture({ profile: "terminal", requiredPaths: ["tracked.txt"] });
    return { store, sessionsRoot, snapshot };
}

function makeRecord(fixture: Fixture, operationId = "operation-a"): PendingWorkspaceRestoreV1 {
    return {
        schemaVersion: 1,
        operationId,
        workspaceIdentity: fixture.store.identity.workspaceIdentity,
        workspaceIncarnation: fixture.store.identity.workspaceIncarnation,
        sessionId: "session-a",
        sessionPath: join(fixture.sessionsRoot, "session-a.db"),
        target: { kind: "rewind", targetTurnId: "turn-a" },
        commitParentId: null,
        applyMode: "normal",
        forcedPaths: [],
        expectedSemanticLeafId: null,
        workspaceStateEntryId: "workspace-state-a",
        safetySnapshot: fixture.snapshot,
        paths: [
            {
                path: "a.txt",
                before: { state: "absent" },
                target: { state: "file", oid: "a".repeat(40), executable: false },
                createdParentDirectories: [],
            },
            {
                path: "dir/file.txt",
                before: { state: "absent" },
                target: { state: "symlink", oid: "b".repeat(40) },
                createdParentDirectories: [],
            },
        ],
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
