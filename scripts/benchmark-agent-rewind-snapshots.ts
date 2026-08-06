// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { WorkspaceGitRunner } from "../packages/coding-agent/workspace-rewind/git-runner";
import {
    IncrementalPathCapture,
    type IncrementalPathCaptureHooks,
} from "../packages/coding-agent/workspace-rewind/incremental-path-capture";
import {
    WorkspaceCheckpointLimits,
    WorkspaceSnapshotStore,
    WorkspaceSnapshotStoreError,
} from "../packages/coding-agent/workspace-rewind/snapshot-store";
import type {
    WorkspaceChangeFeed,
    WorkspaceChangeRead,
} from "../packages/coding-agent/workspace-rewind/workspace-change-feed";
import type { CanonicalWorkspaceIdentity } from "../packages/coding-agent/workspace-rewind/workspace-identity";
import { WorkspaceSnapshotTracker } from "../packages/coding-agent/workspace-rewind/workspace-snapshot-tracker";

type FixtureShape = "deep" | "wide";
type BenchmarkMode = "full-baseline" | "warm-incremental";

interface BenchmarkOptions {
    entryCounts: number[];
    iterations: number;
}

interface BenchmarkRow {
    shape: FixtureShape;
    mode: BenchmarkMode;
    outcome: "completed" | "capture-timeout";
    contentCardinality: number;
    entryCount: number;
    directoryCount: number;
    dirtyCount: number;
    sessionCount: number;
    p50Ms: number;
    p95Ms: number;
    fullReconcileCount: number;
    enumeratedEntries: number;
    workerPeak: number;
    newObjects: number;
    newlyHashedBytes: number;
}

interface CaptureMetrics {
    fullReconcileCount: number;
    enumeratedEntries: number;
    workerActive: number;
    workerPeak: number;
    newlyHashedBytes: number;
    hooks: IncrementalPathCaptureHooks;
    reset(): void;
}

interface BenchmarkFixture {
    root: string;
    shape: FixtureShape;
    workspaceRoot: string;
    directoryCount: number;
    contentCardinality: number;
    paths: string[];
    store: WorkspaceSnapshotStore;
    tracker: WorkspaceSnapshotTracker;
    feed: DeterministicChangeFeed;
    metrics: CaptureMetrics;
}

const DirtyCounts = [0, 1, 100] as const;
const SessionCounts = [1, 2, 4] as const;
const DefaultEntryCounts = [10_000, 50_000, 200_000];
const DefaultIterations = 20;
const RepresentativeContentCardinality = 64;

export async function runAgentRewindSnapshotBenchmark(
    options: BenchmarkOptions,
    onRow: (row: BenchmarkRow) => void = () => undefined
): Promise<BenchmarkRow[]> {
    const rows: BenchmarkRow[] = [];
    const append = (row: BenchmarkRow) => {
        rows.push(row);
        onRow(row);
    };
    for (const entryCount of options.entryCounts) {
        for (const shape of ["deep", "wide"] as const) {
            append(await measureUniqueContentColdProbe(entryCount, shape));
            const fixture = await makeFixture(entryCount, shape, RepresentativeContentCardinality);
            try {
                append(await measureFullBaseline(fixture));
                for (const dirtyCount of DirtyCounts) {
                    for (const sessionCount of SessionCounts) {
                        append(
                            await measureWarmRow(fixture, {
                                dirtyCount: Math.min(dirtyCount, fixture.paths.length),
                                sessionCount,
                                iterations: options.iterations,
                            })
                        );
                    }
                }
            } finally {
                await fixture.tracker.dispose();
                await rm(fixture.root, { recursive: true, force: true });
            }
        }
    }
    return rows;
}

async function measureFullBaseline(fixture: BenchmarkFixture): Promise<BenchmarkRow> {
    fixture.metrics.reset();
    const objectsBefore = await countLooseObjects(fixture.store);
    const started = performance.now();
    const captured = await fixture.tracker.capture({ profile: "terminal" });
    const elapsed = performance.now() - started;
    fixture.metrics.newlyHashedBytes += captured.coverage.newlyHashedBytes;
    const objectsAfter = await countLooseObjects(fixture.store);
    return makeRow(fixture, {
        mode: "full-baseline",
        outcome: "completed",
        dirtyCount: 0,
        sessionCount: 1,
        durations: [elapsed],
        newObjects: objectsAfter - objectsBefore,
    });
}

async function measureUniqueContentColdProbe(entryCount: number, shape: FixtureShape): Promise<BenchmarkRow> {
    const fixture = await makeFixture(entryCount, shape, entryCount);
    try {
        fixture.metrics.reset();
        const objectsBefore = await countLooseObjects(fixture.store);
        const started = performance.now();
        try {
            const captured = await fixture.tracker.capture({ profile: "terminal" });
            const elapsed = performance.now() - started;
            fixture.metrics.newlyHashedBytes += captured.coverage.newlyHashedBytes;
            const objectsAfter = await countLooseObjects(fixture.store);
            return makeRow(fixture, {
                mode: "full-baseline",
                outcome: "completed",
                dirtyCount: 0,
                sessionCount: 1,
                durations: [elapsed],
                newObjects: objectsAfter - objectsBefore,
            });
        } catch (error) {
            if (!(error instanceof WorkspaceSnapshotStoreError) || error.code !== "capture_timeout") throw error;
            const elapsed = performance.now() - started;
            const objectsAfter = await countLooseObjects(fixture.store);
            return makeRow(fixture, {
                mode: "full-baseline",
                outcome: "capture-timeout",
                dirtyCount: 0,
                sessionCount: 1,
                durations: [elapsed],
                newObjects: objectsAfter - objectsBefore,
            });
        }
    } finally {
        await fixture.tracker.dispose();
        await rm(fixture.root, { recursive: true, force: true });
    }
}

async function measureWarmRow(
    fixture: BenchmarkFixture,
    input: { dirtyCount: number; sessionCount: number; iterations: number }
): Promise<BenchmarkRow> {
    fixture.metrics.reset();
    const durations: number[] = [];
    const objectsBefore = await countLooseObjects(fixture.store);
    for (let iteration = 0; iteration < input.iterations; iteration++) {
        const dirtyPaths = fixture.paths.slice(0, input.dirtyCount);
        await mutatePaths(fixture.workspaceRoot, dirtyPaths, `${input.dirtyCount}:${input.sessionCount}:${iteration}`);
        fixture.feed.record(dirtyPaths);
        const started = performance.now();
        const captures = await Promise.all(
            Array.from({ length: input.sessionCount }, () => fixture.tracker.capture({ profile: "terminal" }))
        );
        durations.push(performance.now() - started);
        fixture.metrics.newlyHashedBytes += captures.reduce(
            (total, capture) => total + capture.coverage.newlyHashedBytes,
            0
        );
    }
    const objectsAfter = await countLooseObjects(fixture.store);
    return makeRow(fixture, {
        mode: "warm-incremental",
        dirtyCount: input.dirtyCount,
        sessionCount: input.sessionCount,
        durations,
        newObjects: objectsAfter - objectsBefore,
    });
}

function makeRow(
    fixture: BenchmarkFixture,
    input: {
        mode: BenchmarkMode;
        outcome?: "completed" | "capture-timeout";
        dirtyCount: number;
        sessionCount: number;
        durations: number[];
        newObjects: number;
    }
): BenchmarkRow {
    return {
        shape: fixture.shape,
        mode: input.mode,
        outcome: input.outcome ?? "completed",
        contentCardinality: fixture.contentCardinality,
        entryCount: fixture.paths.length + fixture.directoryCount,
        directoryCount: fixture.directoryCount,
        dirtyCount: input.dirtyCount,
        sessionCount: input.sessionCount,
        p50Ms: percentile(input.durations, 0.5),
        p95Ms: percentile(input.durations, 0.95),
        fullReconcileCount: fixture.metrics.fullReconcileCount,
        enumeratedEntries: fixture.metrics.enumeratedEntries,
        workerPeak: fixture.metrics.workerPeak,
        newObjects: input.newObjects,
        newlyHashedBytes: fixture.metrics.newlyHashedBytes,
    };
}

async function makeFixture(
    entryCount: number,
    shape: FixtureShape,
    contentCardinality: number
): Promise<BenchmarkFixture> {
    if (!Number.isSafeInteger(entryCount) || entryCount < 1 || entryCount > WorkspaceCheckpointLimits.maxEntries) {
        throw new Error(`Entry count must be between 1 and ${WorkspaceCheckpointLimits.maxEntries}`);
    }
    const root = await mkdtemp(join(tmpdir(), `crest-rewind-benchmark-${shape}-${entryCount}-`));
    try {
        const workspaceRoot = await realpath(await mkdir(join(root, "workspace"), { recursive: true }));
        const layout = await createFixtureEntries(workspaceRoot, entryCount, shape, contentCardinality);
        const identity = await makeIdentity(workspaceRoot, `${shape}-${entryCount}`);
        const store = await WorkspaceSnapshotStore.open({
            dataRoot: join(root, "data"),
            identity,
            git: new WorkspaceGitRunner(),
            processOwner: {
                pid: process.pid,
                processStartToken: `benchmark-${shape}-${entryCount}`,
                nonce: "7".repeat(64),
            },
        });
        const metrics = makeMetrics();
        instrumentStore(store, metrics);
        const feed = new DeterministicChangeFeed();
        const tracker = new WorkspaceSnapshotTracker({
            store,
            feed,
            state: {
                load: async () => ({ status: "untrusted" }),
                publish: async () => undefined,
            },
            makePathCapture: (input) =>
                new IncrementalPathCapture({
                    identity,
                    git: store.git,
                    storeRoot: store.storeRoot,
                    scope: input.scope,
                    maxEntries: WorkspaceCheckpointLimits.maxEntries,
                    maxUntrackedBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
                    maxNewlyHashedBytes: WorkspaceCheckpointLimits.maxNewlyHashedBytes,
                    timeoutMs: WorkspaceCheckpointLimits.terminalTimeoutMs,
                    base: input.base,
                    hooks: metrics.hooks,
                }),
        });
        return {
            root,
            shape,
            workspaceRoot,
            directoryCount: layout.directoryCount,
            contentCardinality: layout.contentCardinality,
            paths: layout.paths,
            store,
            tracker,
            feed,
            metrics,
        };
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}

async function createFixtureEntries(
    workspaceRoot: string,
    entryCount: number,
    shape: FixtureShape,
    contentCardinality: number
): Promise<{ directoryCount: number; contentCardinality: number; paths: string[] }> {
    const directoryCount =
        shape === "deep" ? Math.min(32, Math.ceil(Math.log2(entryCount))) : Math.min(8, Math.max(0, entryCount - 1));
    let relativeRoot = "";
    if (shape === "deep") {
        relativeRoot = Array.from({ length: directoryCount }, (_, index) => `d${index.toString(36)}`).join("/");
        await mkdir(join(workspaceRoot, relativeRoot), { recursive: true });
    } else if (directoryCount > 0) {
        await Promise.all(
            Array.from({ length: directoryCount }, (_, index) => mkdir(join(workspaceRoot, `w${index}`)))
        );
    }
    const fileCount = entryCount - directoryCount;
    const effectiveContentCardinality = Math.max(1, Math.min(contentCardinality, fileCount));
    const paths = Array.from({ length: fileCount }, (_, index) => {
        if (relativeRoot) return `${relativeRoot}/f${index.toString(36)}`;
        if (directoryCount > 0) return `w${index % directoryCount}/f${index.toString(36)}`;
        return `f${index.toString(36)}`;
    });
    for (let offset = 0; offset < paths.length; offset += 128) {
        await Promise.all(
            paths
                .slice(offset, offset + 128)
                .map((path, index) =>
                    writeFile(
                        join(workspaceRoot, path),
                        Buffer.from(`content-${(offset + index) % effectiveContentCardinality}`)
                    )
                )
        );
    }
    return { directoryCount, contentCardinality: effectiveContentCardinality, paths };
}

async function mutatePaths(workspaceRoot: string, paths: readonly string[], version: string): Promise<void> {
    await Promise.all(paths.map((path, index) => writeFile(join(workspaceRoot, path), `${version}:${index}`)));
}

function makeMetrics(): CaptureMetrics {
    const metrics: CaptureMetrics = {
        fullReconcileCount: 0,
        enumeratedEntries: 0,
        workerActive: 0,
        workerPeak: 0,
        newlyHashedBytes: 0,
        hooks: {
            scopeClassified: (entryCount) => {
                metrics.enumeratedEntries += entryCount;
            },
            workerStarted: () => {
                metrics.workerActive++;
                metrics.workerPeak = Math.max(metrics.workerPeak, metrics.workerActive);
            },
            workerSettled: () => {
                metrics.workerActive--;
            },
        },
        reset() {
            metrics.fullReconcileCount = 0;
            metrics.enumeratedEntries = 0;
            metrics.workerActive = 0;
            metrics.workerPeak = 0;
            metrics.newlyHashedBytes = 0;
        },
    };
    return metrics;
}

function instrumentStore(store: WorkspaceSnapshotStore, metrics: CaptureMetrics): void {
    const captureFullReconcile = store.captureFullReconcile.bind(store);
    store.captureFullReconcile = async (options) => {
        metrics.fullReconcileCount++;
        const captureAnchoredGroupAttempt = store.captureAnchoredGroupAttempt.bind(store);
        store.captureAnchoredGroupAttempt = async (...args) => {
            metrics.workerActive++;
            metrics.workerPeak = Math.max(metrics.workerPeak, metrics.workerActive);
            metrics.enumeratedEntries += args[1].length;
            try {
                return await captureAnchoredGroupAttempt(...args);
            } finally {
                metrics.workerActive--;
            }
        };
        try {
            return await captureFullReconcile(options);
        } finally {
            store.captureAnchoredGroupAttempt = captureAnchoredGroupAttempt;
        }
    };
}

async function countLooseObjects(store: WorkspaceSnapshotStore): Promise<number> {
    const result = await store.git.run(["count-objects", "-v"], { gitDir: store.storeRoot, timeoutMs: 30_000 });
    const match = /^count: (\d+)$/m.exec(result.stdout.toString("ascii"));
    if (!match) throw new Error("Git returned invalid object statistics");
    return Number(match[1]);
}

async function makeIdentity(workspaceRoot: string, label: string): Promise<CanonicalWorkspaceIdentity> {
    return {
        canonicalRoot: workspaceRoot,
        workspaceIdentity: Buffer.from(`benchmark-${label}`).toString("hex").padEnd(64, "0").slice(0, 64),
        workspaceIncarnation: Buffer.from(`incarnation-${label}`).toString("hex").padEnd(64, "0").slice(0, 64),
        storeKey: `benchmark-${label}`,
        ancestorIdentityChain: await ancestorIdentityChain(workspaceRoot),
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

function percentile(values: readonly number[], quantile: number): number {
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
    return Number(sorted[index]!.toFixed(2));
}

function parseOptions(argv: readonly string[]): BenchmarkOptions {
    let entryCounts = DefaultEntryCounts;
    let iterations = DefaultIterations;
    for (const argument of argv) {
        if (argument.startsWith("--entries=")) {
            entryCounts = argument
                .slice("--entries=".length)
                .split(",")
                .map((value) => Number(value));
            continue;
        }
        if (argument.startsWith("--iterations=")) {
            iterations = Number(argument.slice("--iterations=".length));
            continue;
        }
        throw new Error(`Unknown argument: ${argument}`);
    }
    if (
        entryCounts.length === 0 ||
        entryCounts.some(
            (value) => !Number.isSafeInteger(value) || value < 1 || value > WorkspaceCheckpointLimits.maxEntries
        )
    ) {
        throw new Error(`--entries must contain integers between 1 and ${WorkspaceCheckpointLimits.maxEntries}`);
    }
    if (!Number.isSafeInteger(iterations) || iterations < 1) {
        throw new Error("--iterations must be a positive integer");
    }
    return { entryCounts: [...new Set(entryCounts)], iterations };
}

function printRows(rows: readonly BenchmarkRow[]): void {
    console.table(
        rows.map((row) => ({
            shape: row.shape,
            mode: row.mode,
            outcome: row.outcome,
            cardinality: row.contentCardinality,
            entries: row.entryCount,
            directories: row.directoryCount,
            dirty: row.dirtyCount,
            sessions: row.sessionCount,
            p50ms: row.p50Ms,
            p95ms: row.p95Ms,
            full: row.fullReconcileCount,
            enumerated: row.enumeratedEntries,
            workerpeak: row.workerPeak,
            newobjects: row.newObjects,
            hashedbytes: row.newlyHashedBytes,
        }))
    );
    console.log(JSON.stringify({ rows }, null, 2));
}

class DeterministicChangeFeed implements WorkspaceChangeFeed {
    events: Array<{ sequence: number; path: string }> = [];
    initialized = false;
    committedSequence = 0;
    nextSequence = 0;
    nextCandidate = 0;
    candidates = new Map<string, number>();

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

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => process.argv[1]!) : "";
if (invokedPath === new URL(import.meta.url).pathname) {
    const options = parseOptions(process.argv.slice(2));
    const totalRows = options.entryCounts.length * 22;
    let completedRows = 0;
    printRows(
        await runAgentRewindSnapshotBenchmark(options, (row) => {
            completedRows++;
            console.log(
                `[${completedRows}/${totalRows}] ${row.shape} ${row.mode} ${row.outcome} cardinality=${row.contentCardinality} dirty=${row.dirtyCount} sessions=${row.sessionCount} p95=${row.p95Ms}ms`
            );
        })
    );
}
