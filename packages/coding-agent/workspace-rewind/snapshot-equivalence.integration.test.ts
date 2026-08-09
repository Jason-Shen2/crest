// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renameSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import type { CapturedPathStateV1 } from "./types";
import { normalizeWorkspaceCandidateEntries, type WorkspaceCandidatePathEntry } from "./workspace-candidate-capture";
import {
    ParcelWorkspaceChangeFeed,
    type WorkspaceChangeEvent,
    type WorkspaceChangeWatcher,
} from "./workspace-change-feed";
import { resolveCanonicalWorkspaceIdentity } from "./workspace-identity";
import { runStablePathReader, type StablePathReaderEntryIdentity } from "./workspace-path-reader";
import { WorkspaceTrackerRegistry } from "./workspace-tracker-registry";

const CleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V3 snapshot equivalence regressions", () => {
    test("matches an independent full projection for 50 deterministic 100-operation models", () => {
        for (let seed = 1; seed <= 50; seed++) {
            const random = makeRandom(seed);
            const candidateProjection = new Map<string, CapturedPathStateV1>();
            const fullProjection = new Map<string, CapturedPathStateV1>();
            for (let operation = 0; operation < 100; operation++) {
                const path = `dir-${Math.floor(random() * 8)}/file-${Math.floor(random() * 16)}.bin`;
                const state = makeState(seed, operation, random);
                const duplicate = makeState(seed, operation + 10_000, random);
                const entries = normalizeWorkspaceCandidateEntries([
                    { path, state: duplicate },
                    { path: `stable-${operation % 3}.txt`, state: { state: "absent" } },
                    { path, state },
                ]);
                applyCandidateProjection(candidateProjection, entries);
                applyFullProjection(fullProjection, path, state);
                fullProjection.delete(`stable-${operation % 3}.txt`);

                expect(sortedProjection(candidateProjection), `seed ${seed}, operation ${operation}`).toEqual(
                    sortedProjection(fullProjection)
                );
            }
        }
    });

    test("commits six model checkpoints through registry snapshotSource and native V3 full reconcile", async () => {
        const fixture = await makeRegistryFixture("native-equivalence");
        try {
            await fixture.lease.snapshotSource.synchronizeExternal();
            const expected = new Map<string, Buffer>();
            for (let operation = 0; operation < 6; operation++) {
                const path = `model/file-${operation % 3}.txt`;
                const bytes = Buffer.from(`operation-${operation}\0${operation % 3}`);
                await mkdir(join(fixture.workspace, "model"), { recursive: true });
                await writeFile(join(fixture.workspace, path), bytes);
                fixture.feed.record([path]);
                expected.set(path, bytes);

                const head = await fixture.lease.snapshotSource.synchronizeExternal();
                const full = await fixture.lease.store.captureFullReconcile({ profile: "terminal" });

                expect(head.ref.tree).toBe(full.tree);
                for (const [expectedPath, expectedBytes] of expected) {
                    const state = await fixture.lease.store.readPathState(head.ref, expectedPath);
                    expect(state.state).toBe("file");
                    if (state.state !== "file") throw new Error("expected V3 file state");
                    expect(await fixture.lease.store.readBlob(state.oid)).toEqual(expectedBytes);
                    expect(await readFile(join(fixture.workspace, expectedPath))).toEqual(expectedBytes);
                }
            }
        } finally {
            await fixture.lease.release();
        }
    }, 30_000);

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

    record(paths: readonly string[]): void {
        for (const path of paths) this.paths.add(path);
    }

    async start(): Promise<void> {
        this.paths.clear();
        this.trusted = true;
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

async function makeRegistryFixture(label: string) {
    const root = await mkdtemp(join(tmpdir(), `crest-v3-equivalence-${label}-`));
    CleanupRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "baseline.txt"), "baseline");
    const identity = await resolveCanonicalWorkspaceIdentity(workspace);
    const feed = new DeterministicFeed();
    const registry = new WorkspaceTrackerRegistry({ makeFeed: () => feed });
    const lease = await registry.acquire({
        dataRoot: join(root, "data"),
        identity,
        git: new WorkspaceGitRunner(),
        processOwner: { pid: process.pid, processStartToken: label, nonce: "a".repeat(64) },
    });
    return { feed, lease, workspace };
}

function applyCandidateProjection(
    projection: Map<string, CapturedPathStateV1>,
    entries: readonly WorkspaceCandidatePathEntry[]
): void {
    for (const entry of entries) {
        if (entry.state.state === "absent") projection.delete(entry.path);
        else projection.set(entry.path, structuredClone(entry.state));
    }
}

function applyFullProjection(
    projection: Map<string, CapturedPathStateV1>,
    path: string,
    state: CapturedPathStateV1
): void {
    if (state.state === "absent") projection.delete(path);
    else projection.set(path, structuredClone(state));
}

function sortedProjection(projection: Map<string, CapturedPathStateV1>) {
    return [...projection.entries()].sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function makeState(seed: number, operation: number, random: () => number): CapturedPathStateV1 {
    const kind = Math.floor(random() * 4);
    const oid = ((seed * 10_000 + operation) >>> 0).toString(16).padStart(40, "0");
    if (kind === 0) return { state: "absent" };
    if (kind === 1) return { state: "excluded", reason: "ignored" };
    if (kind === 2) return { state: "symlink", oid };
    return { state: "file", oid, executable: random() > 0.5 };
}

function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
    };
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
