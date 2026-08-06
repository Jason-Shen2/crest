// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
    IncrementalReaderConcurrency,
    runAnchoredReaderBatch,
    type AnchoredReaderBatchEntry,
    type AnchoredReaderResult,
} from "./anchored-reader";
import { WorkspaceGitRunner } from "./git-runner";
import { IncrementalPathCapture, type IncrementalPathCaptureHooks } from "./incremental-path-capture";
import { WorkspaceCheckpointLimits, WorkspaceSnapshotStore } from "./snapshot-store";
import type { WorkspaceChangeFeed, WorkspaceChangeRead } from "./workspace-change-feed";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import { WorkspaceSnapshotTracker } from "./workspace-snapshot-tracker";
import { WorkspaceTrackerRegistry } from "./workspace-tracker-registry";

const cleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("incremental snapshot performance contracts", () => {
    test("keeps a warm no-change boundary off every workspace-scale path", async () => {
        const value = await makeFixture("warm-empty");
        const metrics = makeMetrics();
        const tracker = makeTracker({ store: value.store, feed: value.feed }, metrics);
        const fullReconcile = vi.spyOn(value.store, "captureFullReconcile");
        const exactQuotaScan = vi.spyOn(value.store.quotaAccounting, "reconcileExactUsage");
        try {
            const before = await tracker.capture({ profile: "terminal" });
            fullReconcile.mockClear();
            exactQuotaScan.mockClear();
            metrics.reset();

            const after = await tracker.capture({ profile: "terminal" });

            expect({
                fullReconcileCount: fullReconcile.mock.calls.length,
                enumeratedEntryCount: metrics.enumeratedEntryCount,
                anchoredWorkerCount: metrics.workerCount,
                exactQuotaScanCount: exactQuotaScan.mock.calls.length,
            }).toEqual({
                fullReconcileCount: 0,
                enumeratedEntryCount: 0,
                anchoredWorkerCount: 0,
                exactQuotaScanCount: 0,
            });
            expect(after.ref).toEqual(before.ref);
        } finally {
            await tracker.dispose();
        }
    });

    test("bounds one dirty path by its path-local evidence", async () => {
        const value = await makeFixture("one-dirty");
        const metrics = makeMetrics();
        const tracker = makeTracker({ store: value.store, feed: value.feed }, metrics);
        const readNodeKinds = vi.spyOn(value.store, "readNodeKinds");
        try {
            await tracker.capture({ profile: "terminal" });
            readNodeKinds.mockClear();
            await writeFile(join(value.workspaceRoot, "file.ts"), "export const value = 1;\n");
            value.feed.record(["file.ts"]);
            metrics.reset();

            await tracker.capture({ profile: "terminal" });

            expect(metrics.enumeratedEntryCount).toBeGreaterThan(0);
            expect(metrics.enumeratedEntryCount).toBe(1);
            expect(metrics.workerPeak).toBeLessThanOrEqual(1);
            expect(readNodeKinds).toHaveBeenCalledTimes(1);
            expect(value.feed.commitCount).toBe(1);
            await expect(tracker.capture({ profile: "terminal" })).resolves.toMatchObject({
                coverage: { newlyHashedBytes: 0 },
            });
            expect(metrics.enumeratedEntryCount).toBe(1);
        } finally {
            await tracker.dispose();
        }
    });

    test("caps 100 dirty parent groups at eight anchored workers", async () => {
        const metrics = makeMetrics();
        const entries = makeReaderEntries(100);
        const runGroup = vi.fn(async (input): Promise<AnchoredReaderResult[]> => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            return input.entries.map((entry) => ({
                path: entry.path,
                reusedOid: "a".repeat(40),
                identity: entry.identity,
                hashedBytes: 0,
            }));
        });

        const results = await runAnchoredReaderBatch(
            {
                rootPath: "/unused",
                entries,
                maxSingleFileBytes: 1,
                maxTotalBytes: 1,
                timeoutMs: 5_000,
                signal: new AbortController().signal,
                hooks: metrics.hooks,
            },
            runGroup
        );

        expect(results).toHaveLength(100);
        expect(runGroup).toHaveBeenCalledTimes(100);
        expect(metrics.workerCount).toBe(100);
        expect(metrics.workerPeak).toBe(IncrementalReaderConcurrency);
    });

    test.each([1, 2, 4])("shares one real cold baseline across %i sessions", async (sessionCount) => {
        const value = await makeWorkspaceFixture(`sessions-${sessionCount}`);
        const metrics = makeMetrics();
        const openStore = vi.fn((input: Parameters<typeof WorkspaceSnapshotStore.open>[0]) =>
            WorkspaceSnapshotStore.open(input)
        );
        const createTracker = vi.fn((input: { store: WorkspaceSnapshotStore; feed: WorkspaceChangeFeed }) =>
            makeTracker(input, metrics)
        );
        const registry = new WorkspaceTrackerRegistry({
            openStore,
            makeFeed: () => new DeterministicChangeFeed(),
            makeTracker: createTracker,
        });
        const input = {
            dataRoot: value.dataRoot,
            identity: value.identity,
            git: value.git,
            processOwner: value.processOwner,
        };
        const leases = await Promise.all(Array.from({ length: sessionCount }, () => registry.acquire(input)));
        const fullReconcile = vi.spyOn(leases[0]!.store, "captureFullReconcile");
        try {
            const captures = await Promise.all(leases.map((lease) => lease.tracker.capture({ profile: "terminal" })));
            expect(new Set(leases.map((lease) => lease.tracker)).size).toBe(1);
            expect(new Set(captures.map((capture) => capture.ref.id)).size).toBe(1);
            expect(openStore).toHaveBeenCalledTimes(1);
            expect(createTracker).toHaveBeenCalledTimes(1);
            expect({
                captureFullReconcileCount: fullReconcile.mock.calls.length,
                enumeratedEntryCount: metrics.enumeratedEntryCount,
                anchoredWorkerCount: metrics.workerCount,
            }).toEqual({
                captureFullReconcileCount: 1,
                enumeratedEntryCount: 0,
                anchoredWorkerCount: 0,
            });
        } finally {
            await Promise.all(leases.map((lease) => lease.release()));
        }
    });
});

function makeReaderEntries(count: number): AnchoredReaderBatchEntry[] {
    return Array.from({ length: count }, (_, index) => ({
        path: `dir-${index}/file.txt`,
        name: "file.txt",
        kind: "file",
        stagingPath: `/staging/${index}`,
        parentIdentity: {
            dev: "1",
            ino: String(index + 1),
            birthtimeNs: "1",
        },
        identity: {
            dev: "1",
            ino: String(index + 101),
            birthtimeNs: "1",
            mode: "33188",
            nlink: "1",
            size: "0",
            mtimeNs: "1",
            ctimeNs: "1",
        },
    }));
}

interface PerformanceMetrics {
    enumeratedEntryCount: number;
    workerCount: number;
    workerActive: number;
    workerPeak: number;
    hooks: IncrementalPathCaptureHooks;
    reset(): void;
}

function makeMetrics(): PerformanceMetrics {
    const metrics: PerformanceMetrics = {
        enumeratedEntryCount: 0,
        workerCount: 0,
        workerActive: 0,
        workerPeak: 0,
        hooks: {
            scopeClassified: (entryCount) => {
                metrics.enumeratedEntryCount += entryCount;
            },
            workerStarted: () => {
                metrics.workerCount++;
                metrics.workerActive++;
                metrics.workerPeak = Math.max(metrics.workerPeak, metrics.workerActive);
            },
            workerSettled: () => {
                metrics.workerActive--;
            },
        },
        reset() {
            metrics.enumeratedEntryCount = 0;
            metrics.workerCount = 0;
            metrics.workerActive = 0;
            metrics.workerPeak = 0;
        },
    };
    return metrics;
}

function makeTracker(value: { store: WorkspaceSnapshotStore; feed: WorkspaceChangeFeed }, metrics: PerformanceMetrics) {
    return new WorkspaceSnapshotTracker({
        store: value.store,
        feed: value.feed,
        state: {
            load: async () => ({ status: "untrusted" }),
            publish: async () => undefined,
        },
        makePathCapture: (input) =>
            new IncrementalPathCapture({
                identity: value.store.identity,
                git: value.store.git,
                storeRoot: value.store.storeRoot,
                scope: input.scope,
                maxEntries: WorkspaceCheckpointLimits.maxEntries,
                maxUntrackedBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
                maxNewlyHashedBytes: WorkspaceCheckpointLimits.maxNewlyHashedBytes,
                timeoutMs: WorkspaceCheckpointLimits.terminalTimeoutMs,
                base: input.base,
                hooks: metrics.hooks,
            }),
    });
}

async function makeFixture(label: string) {
    const value = await makeWorkspaceFixture(label);
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: value.dataRoot,
        identity: value.identity,
        git: value.git,
        processOwner: value.processOwner,
    });
    const feed = new DeterministicChangeFeed();
    return { ...value, store, feed };
}

async function makeWorkspaceFixture(label: string) {
    const root = await mkdtemp(join(tmpdir(), `crest-snapshot-performance-${label}-`));
    cleanupRoots.push(root);
    const workspaceRoot = await realpath(await mkdir(join(root, "workspace"), { recursive: true }));
    const identity: CanonicalWorkspaceIdentity = {
        canonicalRoot: workspaceRoot,
        workspaceIdentity: Buffer.from(`performance-${label}`).toString("hex").padEnd(64, "0").slice(0, 64),
        workspaceIncarnation: Buffer.from(`incarnation-${label}`).toString("hex").padEnd(64, "0").slice(0, 64),
        storeKey: `performance-${label}`,
        ancestorIdentityChain: await ancestorIdentityChain(workspaceRoot),
    };
    return {
        root,
        workspaceRoot,
        dataRoot: join(root, "data"),
        identity,
        git: new WorkspaceGitRunner(),
        processOwner: {
            pid: process.pid,
            processStartToken: `performance-${label}`,
            nonce: "8".repeat(64),
        },
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
    return await Promise.all(
        paths.map(async (absolutePath) => {
            const state = await lstat(absolutePath, { bigint: true });
            return {
                absolutePath,
                dev: state.dev.toString(),
                ino: state.ino.toString(),
                birthtimeNs: state.birthtimeNs.toString(),
            };
        })
    );
}

class DeterministicChangeFeed implements WorkspaceChangeFeed {
    events: Array<{ sequence: number; path: string }> = [];
    initialized = false;
    committedSequence = 0;
    nextSequence = 0;
    nextCandidate = 0;
    candidates = new Map<string, number>();
    commitCount = 0;

    record(paths: readonly string[]): void {
        for (const path of paths) this.events.push({ sequence: ++this.nextSequence, path });
    }

    async prepareForReconcile(): Promise<void> {}

    async initializeAfterReconcile(): Promise<void> {
        this.committedSequence = this.nextSequence;
        this.candidates.clear();
        this.initialized = true;
    }

    async readChanges(): Promise<WorkspaceChangeRead> {
        if (!this.initialized) return { status: "gap", reason: "cold-start" };
        return this.readAfter(this.committedSequence);
    }

    async advanceCandidate(candidateCursor: string): Promise<WorkspaceChangeRead> {
        const sequence = this.candidates.get(candidateCursor);
        if (sequence == null) throw new Error("Unknown deterministic candidate cursor");
        return this.readAfter(sequence);
    }

    async commitCursor(candidateCursor: string): Promise<void> {
        const sequence = this.candidates.get(candidateCursor);
        if (sequence == null) throw new Error("Unknown deterministic candidate cursor");
        this.committedSequence = sequence;
        this.candidates.clear();
        this.commitCount++;
    }

    markGap(): void {
        this.initialized = false;
    }

    async dispose(): Promise<void> {}

    readAfter(sequence: number): WorkspaceChangeRead {
        const candidateCursor = (++this.nextCandidate).toString(16).padStart(32, "0");
        this.candidates.set(candidateCursor, this.nextSequence);
        return {
            status: "complete",
            changedPaths: [
                ...new Set(this.events.filter((event) => event.sequence > sequence).map((event) => event.path)),
            ].sort(),
            scopeInvalidated: false,
            candidateCursor,
        };
    }
}
