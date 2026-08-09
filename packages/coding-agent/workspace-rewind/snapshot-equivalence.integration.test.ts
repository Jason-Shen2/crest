// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renameSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import { WorkspaceCheckpointLimits } from "./snapshot-store";
import { WorkspaceCandidates } from "./workspace-candidates";
import {
    ParcelWorkspaceChangeFeed,
    type WorkspaceChangeEvent,
    type WorkspaceChangeWatcher,
} from "./workspace-change-feed";
import { resolveCanonicalWorkspaceIdentity } from "./workspace-identity";
import { runStablePathReader, type StablePathReaderEntryIdentity } from "./workspace-path-reader";
import { discoverWorkspaceScope } from "./workspace-scope";
import { WorkspaceTrackerRegistry } from "./workspace-tracker-registry";

const CleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V3 snapshot equivalence regressions", () => {
    test("fresh non-Git initialization establishes a warm no-change baseline", async () => {
        const fixture = await makeFreshNonGitFixture("fresh-non-git-no-change");
        try {
            const head = await fixture.lease.snapshotSource.synchronizeExternal();

            expect(fixture.reconcileCalls()).toBe(0);
            expect(head.coverage.newlyHashedBytes).toBe(0);
        } finally {
            await fixture.lease.release();
        }
    }, 30_000);

    test("fresh non-Git initialization retains an event observed during full capture", async () => {
        const fixture = await makeFreshNonGitFixture("fresh-non-git-observed", {
            onStart: async ({ feed, workspace }) => {
                await writeFile(join(workspace, "during-capture.txt"), "observed");
                feed.record(["during-capture.txt"]);
            },
        });
        try {
            const readNodeKinds = vi.spyOn(fixture.lease.store, "readNodeKinds");
            const head = await fixture.lease.snapshotSource.synchronizeExternal();

            expect(fixture.reconcileCalls()).toBe(0);
            expect(readNodeKinds).toHaveBeenCalledTimes(1);
            expect(readNodeKinds.mock.calls[0]![1]).toEqual(["during-capture.txt"]);
            const state = await fixture.lease.store.readPathState(head.ref, "during-capture.txt");
            expect(state.state).toBe("file");
            if (state.state !== "file") throw new Error("expected retained capture-period file");
            expect(await fixture.lease.store.readBlob(state.oid)).toEqual(Buffer.from("observed"));
        } finally {
            await fixture.lease.release();
        }
    }, 30_000);

    test("fresh non-Git initialization survives one feed start failure without trusting the baseline", async () => {
        const fixture = await makeFreshNonGitFixture("fresh-non-git-start-failure", {
            startFailure: new Error("watcher start failed"),
        });
        try {
            await expect(fixture.lease.snapshotSource.synchronizeExternal()).resolves.toBeDefined();
            expect(fixture.reconcileCalls()).toBe(1);
        } finally {
            await fixture.lease.release();
        }
    }, 30_000);

    test("fresh non-Git initialization keeps a capture-time feed trust loss cold", async () => {
        const fixture = await makeFreshNonGitFixture("fresh-non-git-trust-loss", {
            loseTrustOnStart: true,
        });
        try {
            await expect(fixture.lease.snapshotSource.synchronizeExternal()).resolves.toBeDefined();
            expect(fixture.reconcileCalls()).toBe(1);
        } finally {
            await fixture.lease.release();
        }
    }, 30_000);

    test("matches native full reconciliation after every non-Git filesystem operation", async () => {
        const fixture = await makeRegistryFixture("native-non-git-equivalence", {
            setup: async (workspace) => {
                await writeFile(join(workspace, "file-to-directory"), "file");
            },
        });
        try {
            const operations: readonly NativeOperation[] = [
                {
                    name: "create file",
                    paths: ["alpha.txt"],
                    expectedChanges: ["alpha.txt"],
                    mutate: () => writeFile(join(fixture.workspace, "alpha.txt"), "alpha"),
                },
                {
                    name: "same-size rewrite",
                    paths: ["alpha.txt"],
                    expectedChanges: ["alpha.txt"],
                    mutate: () => writeFile(join(fixture.workspace, "alpha.txt"), "bravo"),
                },
                {
                    name: "chmod executable",
                    paths: ["alpha.txt"],
                    expectedChanges: ["alpha.txt"],
                    mutate: () => chmod(join(fixture.workspace, "alpha.txt"), 0o755),
                },
                {
                    name: "create symlink",
                    paths: ["alpha-link"],
                    expectedChanges: ["alpha-link"],
                    mutate: () => symlink("alpha.txt", join(fixture.workspace, "alpha-link")),
                },
                {
                    name: "delete file",
                    paths: ["alpha.txt"],
                    expectedChanges: ["alpha.txt"],
                    mutate: () => rm(join(fixture.workspace, "alpha.txt")),
                },
                {
                    name: "replace file with directory",
                    paths: ["file-to-directory"],
                    expectedChanges: ["file-to-directory", "file-to-directory/child.txt"],
                    mutate: async () => {
                        await rm(join(fixture.workspace, "file-to-directory"));
                        await mkdir(join(fixture.workspace, "file-to-directory"));
                        await writeFile(join(fixture.workspace, "file-to-directory", "child.txt"), "child");
                    },
                },
                {
                    name: "rename directory",
                    paths: ["file-to-directory", "renamed-directory"],
                    expectedChanges: ["file-to-directory/child.txt", "renamed-directory/child.txt"],
                    mutate: () =>
                        rename(
                            join(fixture.workspace, "file-to-directory"),
                            join(fixture.workspace, "renamed-directory")
                        ),
                },
                {
                    name: "replace directory with file",
                    paths: ["renamed-directory"],
                    expectedChanges: ["renamed-directory", "renamed-directory/child.txt"],
                    mutate: async () => {
                        await rm(join(fixture.workspace, "renamed-directory"), { recursive: true });
                        await writeFile(join(fixture.workspace, "renamed-directory"), "file again");
                    },
                },
            ];
            for (const operation of operations) {
                await operation.mutate();
                fixture.feed.record(operation.paths);
                await expectCandidateMatchesFullReconcile(fixture, operation.name, operation.expectedChanges);
            }
        } finally {
            await fixture.lease.release();
        }
    }, 60_000);

    test("matches native full reconciliation after every Git scope operation", async () => {
        const fixture = await makeRegistryFixture("native-git-equivalence", { git: true });
        try {
            const operations: readonly NativeOperation[] = [
                {
                    name: "create untracked Git file",
                    paths: ["git-file.txt"],
                    expectedChanges: ["git-file.txt"],
                    mutate: () => writeFile(join(fixture.workspace, "git-file.txt"), "git file"),
                },
                {
                    name: "change gitignore scope",
                    paths: [".gitignore", "ignored/new.txt"],
                    expectedChanges: [".gitignore", "ignored"],
                    mutate: async () => {
                        await writeFile(join(fixture.workspace, ".gitignore"), "ignored/\n");
                        await mkdir(join(fixture.workspace, "ignored"));
                        await writeFile(join(fixture.workspace, "ignored", "new.txt"), "ignored");
                    },
                },
                {
                    name: "introduce nested repository boundary",
                    paths: ["vendor/module/.git/HEAD", "vendor/module/child.txt"],
                    expectedChanges: ["vendor/module"],
                    mutate: async () => {
                        const nested = join(fixture.workspace, "vendor", "module");
                        await mkdir(nested, { recursive: true });
                        await fixture.git.run(["init"], { cwd: nested, timeoutMs: 5_000 });
                        await writeFile(join(nested, "child.txt"), "nested");
                    },
                },
            ];
            for (const operation of operations) {
                await operation.mutate();
                fixture.feed.record(operation.paths);
                await expectCandidateMatchesFullReconcile(fixture, operation.name, operation.expectedChanges);
            }
        } finally {
            await fixture.lease.release();
        }
    }, 60_000);

    test("turns a real change-feed callback error into unavailable", async () => {
        let callback!: (error: Error | null, events: WorkspaceChangeEvent[]) => unknown;
        const watcher: WorkspaceChangeWatcher = {
            subscribe: async (_directory, next) => {
                callback = next;
                return { unsubscribe: async () => undefined };
            },
        };
        const root = await mkdtemp(join(tmpdir(), "crest-v3-feed-error-"));
        CleanupRoots.push(root);
        const feed = new ParcelWorkspaceChangeFeed({ workspaceRoot: root, watcher });
        await feed.start();

        callback(new Error("native watcher failed"), []);

        await expect(feed.drain()).resolves.toEqual({ status: "unavailable", reason: "watcher-error" });
        await feed.dispose();
    });

    test("detects a real dirty-file replacement at the stable read boundary", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-v3-path-replacement-"));
        CleanupRoots.push(root);
        const path = join(root, "target.bin");
        const replacement = join(root, "replacement.bin");
        const stagingPath = join(root, "staging.bin");
        const openedMarker = join(root, "opened");
        const releaseMarker = join(root, "release");
        await writeFile(path, "x".repeat(1024 * 1024));
        await writeFile(replacement, "replacement inode");
        const [parent, entry] = await Promise.all([lstat(root, { bigint: true }), lstat(path, { bigint: true })]);
        const identity: StablePathReaderEntryIdentity = {
            dev: entry.dev.toString(),
            ino: entry.ino.toString(),
            birthtimeNs: entry.birthtimeNs.toString(),
            mode: entry.mode.toString(),
            nlink: entry.nlink.toString(),
            size: entry.size.toString(),
            mtimeNs: entry.mtimeNs.toString(),
            ctimeNs: entry.ctimeNs.toString(),
        };
        const pending = runStablePathReader({
            parentPath: root,
            parentIdentity: {
                dev: parent.dev.toString(),
                ino: parent.ino.toString(),
                birthtimeNs: parent.birthtimeNs.toString(),
            },
            entries: [{ path: "target.bin", name: "target.bin", kind: "file", identity, stagingPath }],
            maxSingleFileBytes: 2 * 1024 * 1024,
            maxTotalBytes: 2 * 1024 * 1024,
            timeoutMs: 10_000,
            signal: new AbortController().signal,
            testBarrier: { path: "target.bin", openedMarker, releaseMarker },
        });
        try {
            await waitForPath(openedMarker);
            renameSync(replacement, path);
        } finally {
            await writeFile(releaseMarker, "release");
        }

        await expect(pending).rejects.toMatchObject({ code: "unstable_file" });
    }, 15_000);
});

class DeterministicFeed {
    paths = new Set<string>();
    trusted = false;
    onStart?: () => Promise<void>;
    startFailure?: Error;
    loseTrustOnStart = false;

    record(paths: readonly string[]): void {
        for (const path of paths) this.paths.add(path);
    }

    async start(): Promise<void> {
        this.paths.clear();
        const startFailure = this.startFailure;
        this.startFailure = undefined;
        if (startFailure) throw startFailure;
        this.trusted = true;
        const onStart = this.onStart;
        this.onStart = undefined;
        await onStart?.();
        if (this.loseTrustOnStart) {
            this.loseTrustOnStart = false;
            this.trusted = false;
        }
    }

    async drain() {
        if (!this.trusted) return { status: "unavailable" as const, reason: "not-started" as const };
        const changedPaths = [...this.paths].sort((left, right) =>
            Buffer.compare(Buffer.from(left), Buffer.from(right))
        );
        this.paths.clear();
        return { status: "complete" as const, changedPaths };
    }

    isTrusted(): boolean {
        return this.trusted;
    }

    async dispose(): Promise<void> {
        this.trusted = false;
    }
}

async function makeFreshNonGitFixture(
    label: string,
    options: {
        onStart?: (input: { feed: DeterministicFeed; workspace: string }) => Promise<void>;
        startFailure?: Error;
        loseTrustOnStart?: boolean;
    } = {}
) {
    const root = await mkdtemp(join(tmpdir(), `crest-v3-equivalence-${label}-`));
    CleanupRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "baseline.txt"), "baseline");
    const identity = await resolveCanonicalWorkspaceIdentity(workspace);
    const feed = new DeterministicFeed();
    if (options.onStart) feed.onStart = () => options.onStart!({ feed, workspace });
    feed.startFailure = options.startFailure;
    feed.loseTrustOnStart = options.loseTrustOnStart ?? false;
    let reconcileCalls = 0;
    const registry = new WorkspaceTrackerRegistry({
        makeFeed: () => feed,
        makeCandidates: ({ store, feed: sourceFeed, userGit }) =>
            new WorkspaceCandidates({
                workspaceRoot: store.identity.canonicalRoot,
                feed: sourceFeed,
                reconcile: async (signal) => {
                    reconcileCalls++;
                    const scope = await discoverWorkspaceScope({
                        identity: store.identity,
                        git: userGit,
                        maxEntries: WorkspaceCheckpointLimits.maxEntries,
                        maxUntrackedBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
                        signal,
                    });
                    return scope.entries.flatMap((entry) => (entry.path ? [entry.path] : []));
                },
            }),
    });
    const lease = await registry.acquire({
        dataRoot: join(root, "data"),
        identity,
        git: new WorkspaceGitRunner(),
        processOwner: { pid: process.pid, processStartToken: label, nonce: "c".repeat(64) },
    });
    return { feed, lease, reconcileCalls: () => reconcileCalls, workspace };
}

interface NativeOperation {
    name: string;
    paths: readonly string[];
    expectedChanges: readonly string[];
    mutate(): Promise<unknown>;
}

async function makeRegistryFixture(
    label: string,
    options: { git?: boolean; setup?: (workspace: string) => Promise<void> } = {}
) {
    const root = await mkdtemp(join(tmpdir(), `crest-v3-equivalence-${label}-`));
    CleanupRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "baseline.txt"), "baseline");
    const git = new WorkspaceGitRunner();
    if (options.git) await git.run(["init"], { cwd: workspace, timeoutMs: 5_000 });
    await options.setup?.(workspace);
    const identity = await resolveCanonicalWorkspaceIdentity(workspace);
    const feed = new DeterministicFeed();
    const registry = new WorkspaceTrackerRegistry({ makeFeed: () => feed });
    const lease = await registry.acquire({
        dataRoot: join(root, "data"),
        identity,
        git,
        processOwner: { pid: process.pid, processStartToken: label, nonce: "a".repeat(64) },
    });
    return { feed, git, lease, workspace };
}

async function expectCandidateMatchesFullReconcile(
    fixture: Awaited<ReturnType<typeof makeRegistryFixture>>,
    operation: string,
    expectedChanges: readonly string[]
): Promise<void> {
    const previous = await fixture.lease.snapshotSource.readHead();
    const candidate = await fixture.lease.snapshotSource.synchronizeExternal();
    const full = await fixture.lease.store.captureFullReconcile({ profile: "terminal" });
    const metadata = await fixture.lease.store.readSnapshotMetadata(candidate.ref);
    const changes = await fixture.lease.store.diff(previous.ref, candidate.ref);
    const { newlyHashedBytes: _newlyHashedBytes, ...fullCoverage } = full.coverage;

    expect(candidate.ref.tree, `${operation}: tree`).toBe(full.tree);
    expect(metadata.scope, `${operation}: scope`).toEqual(full.scope);
    expect(metadata.coverage, `${operation}: coverage`).toEqual(fullCoverage);
    expect(
        changes.map((change) => change.path),
        `${operation}: diff paths`
    ).toEqual(expectedChanges);
}

async function waitForPath(path: string): Promise<void> {
    for (let attempt = 0; attempt < 1_000; attempt++) {
        try {
            await lstat(path);
            return;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Stable path reader did not reach its test barrier");
}
