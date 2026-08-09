// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import type { WorkspaceChangeDrain, WorkspaceChangeFeed } from "./workspace-change-feed";
import { resolveCanonicalWorkspaceIdentity } from "./workspace-identity";
import {
    runStablePathReaderBatch,
    StablePathReaderConcurrency,
    type StablePathReaderBatchEntry,
} from "./workspace-path-reader";
import { WorkspaceTrackerRegistry } from "./workspace-tracker-registry";

const CleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V3 snapshot performance contracts", () => {
    test("keeps a warm no-change boundary off every workspace-scale path", async () => {
        const fixture = await makeFixture("warm-empty", 32);
        try {
            await fixture.lease.snapshotSource.synchronizeExternal();
            const fullReconcile = vi.spyOn(fixture.lease.store, "captureFullReconcile");
            const readNodeKinds = vi.spyOn(fixture.lease.store, "readNodeKinds");
            const exactQuota = vi.spyOn(fixture.lease.store.quotaAccounting, "reconcileExactUsage");
            const git = vi.spyOn(fixture.lease.store.git, "run");

            const before = await fixture.lease.snapshotSource.readHead();
            const after = await fixture.lease.snapshotSource.synchronizeExternal();

            expect(fullReconcile).not.toHaveBeenCalled();
            expect(exactQuota).not.toHaveBeenCalled();
            expect(readNodeKinds.mock.calls.every(([, paths]) => paths.length === 0)).toBe(true);
            expect(git.mock.calls.length).toBeLessThanOrEqual(40);
            expect(after.ref).toEqual(before.ref);
        } finally {
            await fixture.lease.release();
        }
    }, 30_000);

    test("bounds one dirty path by its path-local evidence", async () => {
        const fixture = await makeFixture("one-dirty", 32);
        try {
            await fixture.lease.snapshotSource.synchronizeExternal();
            const fullReconcile = vi.spyOn(fixture.lease.store, "captureFullReconcile");
            const readNodeKinds = vi.spyOn(fixture.lease.store, "readNodeKinds");
            const git = vi.spyOn(fixture.lease.store.git, "run");
            await writeFile(join(fixture.workspace, "file-16.txt"), "dirty");
            fixture.feed.record(["file-16.txt"]);

            await fixture.lease.snapshotSource.synchronizeExternal();

            expect(fullReconcile).not.toHaveBeenCalled();
            expect(readNodeKinds).toHaveBeenCalledTimes(1);
            expect(readNodeKinds.mock.calls[0]![1]).toEqual(["file-16.txt"]);
            expect(git.mock.calls.length).toBeLessThanOrEqual(80);
        } finally {
            await fixture.lease.release();
        }
    }, 30_000);

    test("keeps 100 dirty parent groups candidate-bounded with at most eight stable readers", async () => {
        const fixture = await makeFixture("hundred-groups", 0);
        try {
            await fixture.lease.snapshotSource.synchronizeExternal();
            const readNodeKinds = vi.spyOn(fixture.lease.store, "readNodeKinds");
            const fullReconcile = vi.spyOn(fixture.lease.store, "captureFullReconcile");
            const git = vi.spyOn(fixture.lease.store.git, "run");
            for (let index = 0; index < 100; index++) {
                await mkdir(join(fixture.workspace, `dir-${index}`));
                await writeFile(join(fixture.workspace, `dir-${index}`, "file.txt"), `dirty-${index}`);
                fixture.feed.record([`dir-${index}/file.txt`]);
            }

            await fixture.lease.snapshotSource.synchronizeExternal();

            expect(fullReconcile).not.toHaveBeenCalled();
            expect(readNodeKinds).toHaveBeenCalledTimes(1);
            expect(readNodeKinds.mock.calls[0]![1]).toHaveLength(100);
            expect(new Set(readNodeKinds.mock.calls[0]![1]).size).toBe(100);
            expect(git.mock.calls.length).toBeLessThanOrEqual(8 * 100);
        } finally {
            await fixture.lease.release();
        }

        const entries = makeReaderEntries(100);
        let active = 0;
        let peak = 0;
        let workers = 0;
        const results = await runStablePathReaderBatch(
            {
                rootPath: "/unused",
                entries,
                maxSingleFileBytes: 1,
                maxTotalBytes: 100,
                timeoutMs: 5_000,
                signal: new AbortController().signal,
                hooks: {
                    workerStarted: () => {
                        workers++;
                        active++;
                        peak = Math.max(peak, active);
                    },
                    workerSettled: () => active--,
                },
            },
            async (input) => {
                await new Promise<void>((resolve) => setImmediate(resolve));
                return input.entries.map((entry) => ({
                    path: entry.path,
                    reusedOid: "a".repeat(40),
                    identity: entry.identity,
                    hashedBytes: 0,
                }));
            }
        );
        expect(results).toHaveLength(100);
        expect(workers).toBe(100);
        expect(peak).toBe(StablePathReaderConcurrency);
    }, 30_000);
});

class DeterministicFeed implements WorkspaceChangeFeed {
    paths = new Set<string>();
    trusted = false;

    record(paths: readonly string[]): void {
        for (const path of paths) this.paths.add(path);
    }

    async start(): Promise<void> {
        this.paths.clear();
        this.trusted = true;
    }

    async drain(): Promise<WorkspaceChangeDrain> {
        if (!this.trusted) return { status: "unavailable", reason: "not-started" };
        const changedPaths = [...this.paths].sort((left, right) =>
            Buffer.compare(Buffer.from(left), Buffer.from(right))
        );
        this.paths.clear();
        return { status: "complete", changedPaths };
    }

    isTrusted(): boolean {
        return this.trusted;
    }

    async dispose(): Promise<void> {
        this.trusted = false;
    }
}

async function makeFixture(label: string, fileCount: number) {
    const root = await mkdtemp(join(tmpdir(), `crest-v3-performance-${label}-`));
    CleanupRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    for (let index = 0; index < fileCount; index++) {
        await writeFile(join(workspace, `file-${index}.txt`), `value-${index}`);
    }
    const identity = await resolveCanonicalWorkspaceIdentity(workspace);
    const feed = new DeterministicFeed();
    const registry = new WorkspaceTrackerRegistry({ makeFeed: () => feed });
    const lease = await registry.acquire({
        dataRoot: join(root, "data"),
        identity,
        git: new WorkspaceGitRunner(),
        processOwner: { pid: process.pid, processStartToken: label, nonce: "b".repeat(64) },
    });
    return { feed, lease, workspace };
}

function makeReaderEntries(count: number): StablePathReaderBatchEntry[] {
    return Array.from({ length: count }, (_, index) => ({
        path: `dir-${index}/file.txt`,
        name: "file.txt",
        kind: "file" as const,
        stagingPath: `/unused/staging-${index}`,
        parentIdentity: { dev: "1", ino: `${index + 1}`, birthtimeNs: "1" },
        identity: {
            dev: "1",
            ino: `${index + 101}`,
            birthtimeNs: "1",
            mode: "33188",
            nlink: "1",
            size: "1",
            mtimeNs: "1",
            ctimeNs: "1",
        },
    }));
}
