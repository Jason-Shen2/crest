// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import { WorkspaceCandidateCapture } from "./workspace-candidate-capture";
import type { WorkspaceChangeDrain, WorkspaceChangeFeed } from "./workspace-change-feed";
import { resolveCanonicalWorkspaceIdentity } from "./workspace-identity";
import { StablePathReaderConcurrency } from "./workspace-path-reader";
import { discoverWorkspaceScope } from "./workspace-scope";
import { WorkspaceTrackerRegistry } from "./workspace-tracker-registry";

const CleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V3 snapshot performance contracts", () => {
    test("keeps a warm no-change boundary off every workspace-scale path", async () => {
        const fixture = await makeFixture("warm-empty", 8);
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
        const fixture = await makeFixture("one-dirty", 8);
        try {
            await fixture.lease.snapshotSource.synchronizeExternal();
            const fullReconcile = vi.spyOn(fixture.lease.store, "captureFullReconcile");
            const readNodeKinds = vi.spyOn(fixture.lease.store, "readNodeKinds");
            const git = vi.spyOn(fixture.lease.store.git, "run");
            await writeFile(join(fixture.workspace, "file-4.txt"), "dirty");
            fixture.feed.record(["file-4.txt"]);

            await fixture.lease.snapshotSource.synchronizeExternal();

            expect(fullReconcile).not.toHaveBeenCalled();
            expect(readNodeKinds).toHaveBeenCalledTimes(1);
            expect(readNodeKinds.mock.calls[0]![1]).toEqual(["file-4.txt"]);
            expect(git.mock.calls.length).toBeLessThanOrEqual(80);
        } finally {
            await fixture.lease.release();
        }
    }, 30_000);

    test("keeps 100 dirty parent groups candidate-bounded with at most eight stable readers", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-v3-performance-hundred-groups-"));
        CleanupRoots.push(root);
        const workspace = join(root, "workspace");
        const storeRoot = join(root, "repo.git");
        await Promise.all([mkdir(workspace), mkdir(storeRoot)]);
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const nativeGit = new WorkspaceGitRunner();
        const scope = await discoverWorkspaceScope({
            identity,
            git: nativeGit,
            maxEntries: 1_000,
            maxUntrackedBytes: 2 * 1024 ** 2,
        });
        const paths = Array.from({ length: 100 }, (_, index) => `dir-${index}/file.txt`);
        const gitRun = vi.fn(async (args: readonly string[], options: Parameters<WorkspaceGitRunner["run"]>[1]) => {
            if (args[0] !== "hash-object") return await nativeGit.run(args, options);
            const count = options.stdin?.toString("utf8").trimEnd().split("\n").length ?? 0;
            return {
                stdout: Buffer.from(
                    `${Array.from({ length: count }, (_, index) => (index + 1).toString(16).padStart(40, "0")).join("\n")}\n`
                ),
                stderr: Buffer.alloc(0),
            };
        });
        const readNodeKinds = vi.fn(async (candidates: readonly string[]) => {
            return new Map(candidates.map((path) => [path, "absent" as const]));
        });
        let active = 0;
        let peak = 0;
        let workers = 0;
        const capture = new WorkspaceCandidateCapture({
            identity,
            git: { run: gitRun } as unknown as WorkspaceGitRunner,
            storeRoot,
            scope: scope.manifest,
            maxEntries: 1_000,
            maxUntrackedBytes: 2 * 1024 ** 2,
            maxNewlyHashedBytes: 2 * 1024 ** 2,
            timeoutMs: 30_000,
            base: { readNodeKind: async () => "absent", readNodeKinds },
            hooks: {
                workerStarted: () => {
                    workers++;
                    active++;
                    peak = Math.max(peak, active);
                },
                workerSettled: () => active--,
            },
        });
        try {
            for (let index = 0; index < 100; index++) {
                await mkdir(join(workspace, `dir-${index}`));
                await writeFile(join(workspace, paths[index]!), `dirty-${index}`);
            }

            const result = await capture.capture(paths);

            expect(readNodeKinds).toHaveBeenCalledTimes(1);
            expect(readNodeKinds.mock.calls[0]![0]).toHaveLength(100);
            expect(new Set(readNodeKinds.mock.calls[0]![0]).size).toBe(100);
            expect(result).toMatchObject({ status: "captured", entries: { length: 100 } });
            expect(gitRun.mock.calls.length).toBeLessThanOrEqual(8 * 100);
            expect(workers).toBe(100);
            expect(peak).toBe(StablePathReaderConcurrency);
            await capture.discardCaptured(result);
        } finally {
            await capture.dispose();
        }
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
