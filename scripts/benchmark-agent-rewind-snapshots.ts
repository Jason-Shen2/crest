// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, SessionTreeEntry } from "@crest/agent/harness/types";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { RewindConfirmationRegistry } from "../packages/coding-agent/workspace-rewind/confirmation-token";
import {
    WorkspaceGitRunner,
    type GitRunOptions,
    type GitRunResult,
} from "../packages/coding-agent/workspace-rewind/git-runner";
import { PendingWorkspaceRestoreStore } from "../packages/coding-agent/workspace-rewind/pending-restore-store";
import type { RestorePlanV1 } from "../packages/coding-agent/workspace-rewind/restore-plan";
import { initializeWorkspaceCheckpointSnapshotSource } from "../packages/coding-agent/workspace-rewind/snapshot-source";
import {
    WorkspaceCheckpointLimits,
    WorkspaceSnapshotStore,
    WorkspaceSnapshotStoreError,
} from "../packages/coding-agent/workspace-rewind/snapshot-store";
import { WorkspaceCandidates } from "../packages/coding-agent/workspace-rewind/workspace-candidates";
import type {
    WorkspaceChangeDrain,
    WorkspaceChangeFeed,
} from "../packages/coding-agent/workspace-rewind/workspace-change-feed";
import type { CanonicalWorkspaceIdentity } from "../packages/coding-agent/workspace-rewind/workspace-identity";
import { WorkspaceRecovery } from "../packages/coding-agent/workspace-rewind/workspace-recovery";
import {
    WorkspaceRestoreExecutor,
    type WorkspaceRestoreCommitStrategy,
} from "../packages/coding-agent/workspace-rewind/workspace-restore-executor";
import {
    WorkspaceTrackerRegistry,
    type WorkspaceTrackerAcquireInput,
    type WorkspaceTrackerLease,
} from "../packages/coding-agent/workspace-rewind/workspace-tracker-registry";

export type FixtureShape = "deep" | "wide";
export type BenchmarkScenario =
    | "cold"
    | "no-tool-fresh"
    | "warm-no-change"
    | "dirty-paths"
    | "session-contention"
    | "overlap"
    | "restore";
export type BenchmarkOutcome = "pass" | "fallback" | "unavailable" | "timeout" | "budget";

export interface BenchmarkOptions {
    entryCounts: number[];
    iterations: number;
}

export interface BenchmarkRow {
    scenario: BenchmarkScenario;
    shape: FixtureShape;
    outcome: BenchmarkOutcome;
    entryCount: number;
    eligibleFileCount: number;
    dirtyPathCount: number;
    sessionCount: number;
    iterations: number;
    candidateCount: number;
    bytesRead: number;
    commitsTraversed: number;
    fullReconcileCount: number;
    p50Ms: number | null;
    p95Ms: number | null;
    reason?: string;
}

export interface ColdBaselineProfile {
    entryCount: number;
    eligibleFileCount: number;
    shape: FixtureShape;
    outcome: "pass" | "timeout" | "failed";
    reason?: string;
    fixture: {
        createEntriesMs: number;
        initializeGitMs: number;
        identityMs: number;
        totalMs: number;
    };
    authority: {
        storeOpenMs: number;
        registryInitializeMs: number;
        captureTotalMs: number | null;
        scopeEnumeratedMs: number | null;
        discoverScopeMs: number | null;
        stableReaderAndHashMs: number | null;
        treeMaterializeMs: number | null;
        postCaptureInitializeMs: number | null;
    };
    scopeEntryCount: number | null;
    gitCommands: Record<string, { calls: number; durationMs: number }>;
}

interface MutableColdBaselineProfile extends ColdBaselineProfile {
    captureStartedAt?: number;
    captureFinishedAt?: number;
}

export interface BenchmarkFixtureView {
    root: string;
    shape: FixtureShape;
}

interface BenchmarkMetrics {
    candidateCount: number;
    bytesRead: number;
    commitsTraversed: number;
    fallbackCount: number;
    reset(): void;
}

interface BenchmarkFixture extends BenchmarkFixtureView {
    workspaceRoot: string;
    entryCount: number;
    paths: string[];
    registry: WorkspaceTrackerRegistry;
    registryInput: WorkspaceTrackerAcquireInput;
    feed: DeterministicChangeFeed;
    metrics: BenchmarkMetrics;
    coldDurations: number[];
    coldError?: unknown;
    keeperLease?: WorkspaceTrackerLease;
}

export interface BenchmarkDependencies<TFixture extends BenchmarkFixtureView = BenchmarkFixture> {
    makeFixture(entryCount: number, shape: FixtureShape): Promise<TFixture>;
    measureFixture(fixture: TFixture, options: BenchmarkOptions): Promise<BenchmarkRow[]>;
    cleanupFixture(fixture: TFixture): Promise<void>;
}

const DirtyPathCounts = [1, 10, 100] as const;
const SessionCounts = [1, 2, 4] as const;
const DefaultEntryCounts = [10_000, 50_000, 200_000];
const DefaultIterations = 10;
const FixtureRepositoryBoundaryCount = 1;
const execFileAsync = promisify(execFile);

const DefaultBenchmarkDependencies: BenchmarkDependencies = {
    makeFixture,
    measureFixture,
    cleanupFixture: cleanupBenchmarkFixture,
};

export async function runAgentRewindSnapshotBenchmark<TFixture extends BenchmarkFixtureView = BenchmarkFixture>(
    options: BenchmarkOptions,
    onRow: (row: BenchmarkRow) => void = () => undefined,
    dependencies: Partial<BenchmarkDependencies<TFixture>> = {}
): Promise<BenchmarkRow[]> {
    const resolved = {
        ...(DefaultBenchmarkDependencies as unknown as BenchmarkDependencies<TFixture>),
        ...dependencies,
    };
    const rows: BenchmarkRow[] = [];
    for (const entryCount of options.entryCounts) {
        for (const shape of ["deep", "wide"] as const) {
            const fixture = await resolved.makeFixture(entryCount, shape);
            let observerError: unknown;
            try {
                const measured = await resolved.measureFixture(fixture, options);
                for (const row of measured) {
                    rows.push(row);
                    if (observerError) continue;
                    try {
                        onRow(row);
                    } catch (error) {
                        observerError = error;
                    }
                }
            } finally {
                await resolved.cleanupFixture(fixture);
            }
            if (observerError) throw observerError;
        }
    }
    return rows;
}

export async function runAgentRewindSnapshotFixture(
    entryCount: number,
    shape: FixtureShape,
    iterations: number,
    matrix: "full" | "smoke" = "full"
): Promise<BenchmarkRow[]> {
    const fixture = await makeFixture(entryCount, shape);
    try {
        return await measureFixture(fixture, { entryCounts: [entryCount], iterations }, matrix);
    } finally {
        await cleanupBenchmarkFixture(fixture);
    }
}

export async function cleanupBenchmarkFixture(
    fixture: Pick<BenchmarkFixture, "root"> & { keeperLease?: Pick<WorkspaceTrackerLease, "release"> },
    removeRoot: (root: string) => Promise<void> = (root) => rm(root, { recursive: true, force: true })
): Promise<void> {
    const failures: unknown[] = [];
    if (fixture.keeperLease) {
        try {
            await fixture.keeperLease.release();
        } catch (error) {
            failures.push(error);
        }
    }
    try {
        await removeRoot(fixture.root);
    } catch (error) {
        failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Benchmark fixture cleanup failed");
}

export async function profileAgentRewindColdBaseline(
    entryCount: number,
    shape: FixtureShape
): Promise<ColdBaselineProfile> {
    validateEntryCount(entryCount);
    const layout = planAgentRewindBenchmarkFixture(entryCount, shape);
    const root = await mkdtemp(join(tmpdir(), `crest-rewind-v3-profile-${shape}-${entryCount}-`));
    const profile: MutableColdBaselineProfile = {
        entryCount,
        eligibleFileCount: layout.eligibleFileCount,
        shape,
        outcome: "failed",
        fixture: { createEntriesMs: 0, initializeGitMs: 0, identityMs: 0, totalMs: 0 },
        authority: {
            storeOpenMs: 0,
            registryInitializeMs: 0,
            captureTotalMs: null,
            scopeEnumeratedMs: null,
            discoverScopeMs: null,
            stableReaderAndHashMs: null,
            treeMaterializeMs: null,
            postCaptureInitializeMs: null,
        },
        scopeEntryCount: null,
        gitCommands: {},
    };
    const fixtureStarted = performance.now();
    let lease: WorkspaceTrackerLease | undefined;
    try {
        const workspaceRoot = await realpath(await mkdir(join(root, "workspace"), { recursive: true }));
        let started = performance.now();
        await createFixtureEntries(workspaceRoot, entryCount, shape);
        profile.fixture.createEntriesMs = elapsedMs(started);
        started = performance.now();
        await initializeGitFixture(workspaceRoot);
        profile.fixture.initializeGitMs = elapsedMs(started);
        started = performance.now();
        const identity = await makeIdentity(workspaceRoot, `profile-${shape}-${entryCount}`);
        profile.fixture.identityMs = elapsedMs(started);
        profile.fixture.totalMs = elapsedMs(fixtureStarted);
        const metrics = makeMetrics();
        const git = new ObservedWorkspaceGitRunner(metrics, profile.gitCommands);
        const feed = new DeterministicChangeFeed();
        const registry = new WorkspaceTrackerRegistry({
            openStore: async (input) => {
                const openStarted = performance.now();
                const store = await WorkspaceSnapshotStore.open(input);
                profile.authority.storeOpenMs = elapsedMs(openStarted);
                const captureEntries = store.captureEntries.bind(store);
                store.captureEntries = async (...args: Parameters<typeof captureEntries>) => {
                    const captureEntriesStarted = performance.now();
                    if (profile.captureStartedAt != null) {
                        profile.authority.discoverScopeMs = roundMs(captureEntriesStarted - profile.captureStartedAt);
                    }
                    try {
                        return await captureEntries(...args);
                    } finally {
                        profile.authority.stableReaderAndHashMs = elapsedMs(captureEntriesStarted);
                    }
                };
                const writeWorkspaceTree = store.writeWorkspaceTree.bind(store);
                store.writeWorkspaceTree = async (...args: Parameters<typeof writeWorkspaceTree>) => {
                    const treeStarted = performance.now();
                    try {
                        return await writeWorkspaceTree(...args);
                    } finally {
                        profile.authority.treeMaterializeMs = elapsedMs(treeStarted);
                    }
                };
                return store;
            },
            makeFeed: () => feed,
            makeCandidates: ({ store, userGit }) =>
                new WorkspaceCandidates({
                    workspaceRoot,
                    feed,
                    userGit,
                    shadowGit: store.git,
                }),
            makeSnapshotSource: ({ store, candidates }) =>
                initializeWorkspaceCheckpointSnapshotSource({
                    store,
                    candidates,
                    fullReconcile: async (options) => {
                        const captureStarted = performance.now();
                        profile.captureStartedAt = captureStarted;
                        try {
                            return await store.captureFullReconcile({
                                ...options,
                                observer: {
                                    scopeEnumerated: (count) => {
                                        profile.scopeEntryCount = count;
                                        profile.authority.scopeEnumeratedMs = elapsedMs(captureStarted);
                                    },
                                },
                            });
                        } finally {
                            profile.captureFinishedAt = performance.now();
                            profile.authority.captureTotalMs = roundMs(profile.captureFinishedAt - captureStarted);
                        }
                    },
                }),
        });
        const registryStarted = performance.now();
        try {
            lease = await registry.acquire({
                dataRoot: join(root, "data"),
                identity,
                git,
                processOwner: {
                    pid: process.pid,
                    processStartToken: `profile-${shape}-${entryCount}`,
                    nonce: "8".repeat(64),
                },
            });
            profile.outcome = "pass";
        } catch (error) {
            profile.outcome =
                error instanceof WorkspaceSnapshotStoreError && error.code === "capture_timeout" ? "timeout" : "failed";
            profile.reason = failureMessage(error);
        } finally {
            const registryFinished = performance.now();
            profile.authority.registryInitializeMs = roundMs(registryFinished - registryStarted);
            if (profile.captureFinishedAt != null) {
                profile.authority.postCaptureInitializeMs = roundMs(registryFinished - profile.captureFinishedAt);
            }
        }
        delete profile.captureStartedAt;
        delete profile.captureFinishedAt;
        return profile;
    } finally {
        if (lease) await lease.release();
        await rm(root, { recursive: true, force: true });
    }
}

async function makeFixture(entryCount: number, shape: FixtureShape): Promise<BenchmarkFixture> {
    validateEntryCount(entryCount);
    const root = await mkdtemp(join(tmpdir(), `crest-rewind-v3-${shape}-${entryCount}-`));
    const metrics = makeMetrics();
    try {
        const workspaceRoot = await realpath(await mkdir(join(root, "workspace"), { recursive: true }));
        const paths = await createFixtureEntries(workspaceRoot, entryCount, shape);
        await initializeGitFixture(workspaceRoot);
        const identity = await makeIdentity(workspaceRoot, `${shape}-${entryCount}`);
        const git = new ObservedWorkspaceGitRunner(metrics);
        const registryInput: WorkspaceTrackerAcquireInput = {
            dataRoot: join(root, "data"),
            identity,
            git,
            processOwner: {
                pid: process.pid,
                processStartToken: `benchmark-${shape}-${entryCount}`,
                nonce: "7".repeat(64),
            },
        };
        const feed = new DeterministicChangeFeed();
        const registry = new WorkspaceTrackerRegistry({
            openStore: async (input) => {
                const store = await WorkspaceSnapshotStore.open(input);
                observeStore(store, metrics);
                return store;
            },
            makeFeed: () => feed,
            makeCandidates: ({ store, userGit }) =>
                new WorkspaceCandidates({
                    workspaceRoot,
                    feed,
                    userGit,
                    shadowGit: store.git,
                }),
        });
        const fixture: BenchmarkFixture = {
            root,
            shape,
            workspaceRoot,
            entryCount,
            paths,
            registry,
            registryInput,
            feed,
            metrics,
            coldDurations: [],
        };
        metrics.reset();
        const started = performance.now();
        try {
            fixture.keeperLease = await registry.acquire(registryInput);
            fixture.coldDurations.push(performance.now() - started);
        } catch (error) {
            fixture.coldDurations.push(performance.now() - started);
            fixture.coldError = error;
        }
        return fixture;
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}

async function measureFixture(
    fixture: BenchmarkFixture,
    options: BenchmarkOptions,
    matrix: "full" | "smoke" = "full"
): Promise<BenchmarkRow[]> {
    const cold = makeMeasuredRow(fixture, {
        scenario: "cold",
        dirtyPathCount: 0,
        sessionCount: 1,
        iterations: 1,
        durations: fixture.coldError ? [] : fixture.coldDurations,
        error: fixture.coldError,
    });
    if (!fixture.keeperLease) {
        return [
            cold,
            ...unavailableRows(
                fixture,
                options.iterations,
                `cold authority unavailable: ${failureMessage(fixture.coldError)}`
            ),
        ];
    }
    const rows = [cold];
    rows.push(await measureNoToolFresh(fixture, options.iterations));
    rows.push(await measureWarmNoChange(fixture, options.iterations));
    const dirtyPathCounts = matrix === "smoke" ? ([1] as const) : DirtyPathCounts;
    const sessionCounts = matrix === "smoke" ? ([4] as const) : SessionCounts;
    for (const dirtyPathCount of dirtyPathCounts) {
        rows.push(await measureDirtyPaths(fixture, dirtyPathCount, options.iterations));
    }
    for (const sessionCount of sessionCounts) {
        rows.push(await measureSessionContention(fixture, sessionCount, options.iterations));
    }
    rows.push(await measureOverlap(fixture, options.iterations));
    rows.push(await measureRestore(fixture, options.iterations));
    return rows;
}

async function measureNoToolFresh(fixture: BenchmarkFixture, iterations: number): Promise<BenchmarkRow> {
    return await measureOperations(fixture, "no-tool-fresh", 0, 1, iterations, async (iteration) => {
        const head = await fixture.keeperLease!.snapshotSource.readHead();
        const fallbackBefore = fixture.metrics.fullReconcileCount;
        const captured = await fixture.keeperLease!.snapshotSource.captureOwnedTurn({
            base: head.ref,
            sessionId: "no-tool-session",
            turnId: `no-tool-${iteration}`,
        });
        recordCoverage(fixture.metrics, captured.coverage, fallbackBefore);
    });
}

async function measureWarmNoChange(fixture: BenchmarkFixture, iterations: number): Promise<BenchmarkRow> {
    return await measureOperations(fixture, "warm-no-change", 0, 1, iterations, async () => {
        const fallbackBefore = fixture.metrics.fullReconcileCount;
        const captured = await fixture.keeperLease!.snapshotSource.synchronizeExternal();
        recordCoverage(fixture.metrics, captured.coverage, fallbackBefore);
    });
}

async function measureDirtyPaths(
    fixture: BenchmarkFixture,
    dirtyPathCount: number,
    iterations: number
): Promise<BenchmarkRow> {
    const paths = fixture.paths.slice(0, Math.min(dirtyPathCount, fixture.paths.length));
    return await measureOperations(fixture, "dirty-paths", dirtyPathCount, 1, iterations, async (iteration) => {
        const head = await fixture.keeperLease!.snapshotSource.readHead();
        await mutatePaths(fixture.workspaceRoot, paths, `dirty-${dirtyPathCount}-${iteration}`);
        fixture.feed.record(paths);
        const fallbackBefore = fixture.metrics.fullReconcileCount;
        const captured = await fixture.keeperLease!.snapshotSource.captureOwnedTurn({
            base: head.ref,
            sessionId: "dirty-session",
            turnId: `dirty-${dirtyPathCount}-${iteration}`,
        });
        recordCoverage(fixture.metrics, captured.coverage, fallbackBefore);
    });
}

async function measureSessionContention(
    fixture: BenchmarkFixture,
    sessionCount: number,
    iterations: number
): Promise<BenchmarkRow> {
    const leases = await Promise.all(
        Array.from({ length: sessionCount }, () => fixture.registry.acquire(fixture.registryInput))
    );
    try {
        if (leases.some((lease) => lease.snapshotSource !== fixture.keeperLease!.snapshotSource)) {
            throw new Error("Workspace Sessions did not share one snapshot authority");
        }
        return await measureOperations(fixture, "session-contention", 0, sessionCount, iterations, async () => {
            await Promise.all(
                leases.map(async (lease, index) => {
                    const writer = await lease.writerLeases.acquire({
                        workspaceKey: `${fixture.registryInput.identity.workspaceIdentity}:${fixture.registryInput.identity.workspaceIncarnation}`,
                        sessionId: `contention-${index}`,
                        boundaryToken: `contention-${index}`,
                    });
                    try {
                        const fallbackBefore = fixture.metrics.fullReconcileCount;
                        const captured = await lease.snapshotSource.synchronizeExternal();
                        recordCoverage(fixture.metrics, captured.coverage, fallbackBefore);
                    } finally {
                        writer.release();
                    }
                })
            );
        });
    } finally {
        await Promise.all(leases.map((lease) => lease.release()));
    }
}

async function measureOverlap(fixture: BenchmarkFixture, iterations: number): Promise<BenchmarkRow> {
    const path = fixture.paths[0]!;
    return await measureOperations(fixture, "overlap", 1, 2, iterations, async (iteration) => {
        let head = await fixture.keeperLease!.snapshotSource.readHead();
        await mutatePaths(fixture.workspaceRoot, [path], `overlap-a-${iteration}`);
        fixture.feed.record([path]);
        let fallbackBefore = fixture.metrics.fullReconcileCount;
        const first = await fixture.keeperLease!.snapshotSource.captureOwnedTurn({
            base: head.ref,
            sessionId: "overlap-a",
            turnId: `overlap-a-${iteration}`,
        });
        recordCoverage(fixture.metrics, first.coverage, fallbackBefore);
        head = await fixture.keeperLease!.snapshotSource.readHead();
        await mutatePaths(fixture.workspaceRoot, [path], `overlap-b-${iteration}`);
        fixture.feed.record([path]);
        fallbackBefore = fixture.metrics.fullReconcileCount;
        const second = await fixture.keeperLease!.snapshotSource.captureOwnedTurn({
            base: head.ref,
            sessionId: "overlap-b",
            turnId: `overlap-b-${iteration}`,
        });
        recordCoverage(fixture.metrics, second.coverage, fallbackBefore);
        const overlaps = await fixture.keeperLease!.mutationLog.findForeignOverlap({
            afterCommit: first.after.id,
            paths: [path],
            includedCommits: new Set(),
            ownerSessionId: "overlap-a",
        });
        if (!overlaps.some((item) => item.path === path && item.sessionId === "overlap-b")) {
            throw new Error("Same-path Session overlap was not detected");
        }
    });
}

async function measureRestore(fixture: BenchmarkFixture, iterations: number): Promise<BenchmarkRow> {
    const path = fixture.paths[0]!;
    return await measureOperations(fixture, "restore", 1, 1, iterations, async (iteration) => {
        const before = await fixture.keeperLease!.snapshotSource.readHead();
        await mutatePaths(fixture.workspaceRoot, [path], `restore-source-${iteration}`);
        fixture.feed.record([path]);
        const fallbackBefore = fixture.metrics.fullReconcileCount;
        const changed = await fixture.keeperLease!.snapshotSource.captureOwnedTurn({
            base: before.ref,
            sessionId: "restore-session",
            turnId: `restore-source-${iteration}`,
        });
        recordCoverage(fixture.metrics, changed.coverage, fallbackBefore);
        const source = await fixture.keeperLease!.snapshotSource.readHead();
        const expectedCurrent = await fixture.keeperLease!.store.readPathState(source.ref, path);
        const beforeState = await fixture.keeperLease!.store.readPathState(before.ref, path);
        if (expectedCurrent.state === "excluded" || beforeState.state === "excluded") {
            throw new Error("Restore benchmark path is excluded");
        }
        const plan: RestorePlanV1 = {
            target: { kind: "turn-undo", sourceTurnId: `restore-source-${iteration}` },
            sessionId: "restore-session",
            workspaceIdentity: fixture.registryInput.identity.workspaceIdentity,
            workspaceIncarnation: fixture.registryInput.identity.workspaceIncarnation,
            semanticLeafId: `restore-leaf-${iteration}`,
            commitParentId: `restore-leaf-${iteration}`,
            paths: [
                {
                    path,
                    operation: "write",
                    target: beforeState,
                    expectedCurrent,
                    liveFingerprint: fingerprintCaptured(expectedCurrent),
                    conflict: "none",
                },
            ],
            coverageWarnings: [],
            forceRequired: false,
            hardBlocked: false,
        };
        const session = makeBenchmarkSession(fixture, iteration, plan.semanticLeafId!);
        const pending = new PendingWorkspaceRestoreStore(fixture.keeperLease!.store);
        const recovery = new WorkspaceRecovery({
            workspace: fixture.registryInput.identity,
            store: fixture.keeperLease!.store,
            pending,
            locateSession: async () => session,
        });
        const confirmations = new RewindConfirmationRegistry();
        const executor = new WorkspaceRestoreExecutor({
            store: fixture.keeperLease!.store,
            pending,
            recovery,
            createOperationId: () => `restore-operation-${iteration}`,
        });
        await executor.execute({
            session: session as never,
            workspace: fixture.registryInput.identity,
            source: source.ref,
            plan,
            confirmation: confirmations.take(confirmations.issue(plan)),
            mode: "normal",
            commit: benchmarkCommitStrategy(),
        });
        const restoredHead = await fixture.keeperLease!.snapshotSource.readHead();
        const restoredState = await fixture.keeperLease!.store.readPathState(restoredHead.ref, path);
        if (JSON.stringify(restoredState) !== JSON.stringify(beforeState) || changed.changes.length !== 1) {
            throw new Error("Restore workload did not reproduce the exact prior path state");
        }
        const pendingAfter = await pending.readCandidate();
        if (pendingAfter.kind !== "none") throw new Error("Restore workload left a pending journal");
    });
}

function makeBenchmarkSession(fixture: BenchmarkFixture, iteration: number, initialLeaf: string) {
    const metadata: JsonlSessionMetadata = {
        id: "restore-session",
        cwd: fixture.workspaceRoot,
        path: join(fixture.root, `restore-session-${iteration}.db`),
        createdAt: "2026-08-08T00:00:00.000Z",
    };
    const entries: SessionTreeEntry[] = [
        {
            type: "message",
            id: initialLeaf,
            parentId: null,
            timestamp: "2026-08-08T00:00:00.000Z",
            message: { role: "user", content: "benchmark restore", timestamp: 0 },
        } as SessionTreeEntry,
    ];
    let leaf: string | null = initialLeaf;
    return {
        getMetadata: async () => structuredClone(metadata),
        getEntries: async () => structuredClone(entries),
        getLeafId: async () => leaf,
        getEntry: async (id: string) => structuredClone(entries.find((entry) => entry.id === id)),
        getStorage: () => ({ createEntryId: async () => `restore-state-${iteration}` }),
        appendEntries: async (next: SessionTreeEntry[], input: { expectedLeafId: string | null }) => {
            if (leaf !== input.expectedLeafId) throw new Error("Benchmark Session leaf moved during restore");
            entries.push(...structuredClone(next));
            leaf = next.at(-1)!.id;
        },
    };
}

function benchmarkCommitStrategy(): WorkspaceRestoreCommitStrategy {
    return {
        makeResult: ({ folded, sessionMetadata }) => ({
            sessionMetadata,
            semanticLeafId: folded.semanticLeafId,
            displayLeafId: folded.displayLeafId,
        }),
    };
}

function fingerprintCaptured(state: Exclude<RestorePlanV1["paths"][number]["target"], { state: "excluded" }>): string {
    const value =
        state.state === "absent"
            ? ["absent"]
            : state.state === "file"
              ? ["file", state.oid, state.executable]
              : ["symlink", state.oid];
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function measureOperations(
    fixture: BenchmarkFixture,
    scenario: BenchmarkScenario,
    dirtyPathCount: number,
    sessionCount: number,
    iterations: number,
    operation: (iteration: number) => Promise<void>
): Promise<BenchmarkRow> {
    fixture.metrics.reset();
    const durations: number[] = [];
    let error: unknown;
    for (let iteration = 0; iteration < iterations; iteration++) {
        const started = performance.now();
        try {
            await operation(iteration);
            durations.push(performance.now() - started);
        } catch (operationError) {
            error = operationError;
            break;
        }
    }
    return makeMeasuredRow(fixture, {
        scenario,
        dirtyPathCount,
        sessionCount,
        iterations,
        durations,
        error,
    });
}

function makeMeasuredRow(
    fixture: BenchmarkFixture,
    input: {
        scenario: BenchmarkScenario;
        dirtyPathCount: number;
        sessionCount: number;
        iterations: number;
        durations: number[];
        error?: unknown;
    }
): BenchmarkRow {
    const fallbackCount = input.scenario === "cold" ? 0 : fixture.metrics.fullReconcileCount;
    const outcome = classifyOutcome(input.error, fallbackCount);
    return {
        scenario: input.scenario,
        shape: fixture.shape,
        outcome,
        entryCount: fixture.entryCount,
        eligibleFileCount: fixture.paths.length,
        dirtyPathCount: input.dirtyPathCount,
        sessionCount: input.sessionCount,
        iterations: input.iterations,
        candidateCount: fixture.metrics.candidateCount,
        bytesRead: fixture.metrics.bytesRead,
        commitsTraversed: fixture.metrics.commitsTraversed,
        fallbackCount,
        p50Ms: input.durations.length === 0 ? null : percentile(input.durations, 0.5),
        p95Ms: input.durations.length === 0 ? null : percentile(input.durations, 0.95),
        ...(input.error ? { reason: failureMessage(input.error) } : {}),
    };
}

function classifyOutcome(error: unknown, fallbackCount: number): BenchmarkOutcome {
    if (!error) return fallbackCount > 0 ? "fallback" : "pass";
    if (error instanceof WorkspaceSnapshotStoreError) {
        if (error.code === "capture_timeout") return "timeout";
        if (error.code === "capture_budget") return "budget";
    }
    const message = failureMessage(error);
    if (/timed out|timeout/i.test(message)) return "timeout";
    if (/budget|quota/i.test(message)) return "budget";
    return "unavailable";
}

function unavailableRows(fixture: BenchmarkFixture, iterations: number, reason: string): BenchmarkRow[] {
    const make = (scenario: BenchmarkScenario, dirtyPathCount: number, sessionCount: number): BenchmarkRow => ({
        scenario,
        shape: fixture.shape,
        outcome: "unavailable",
        entryCount: fixture.entryCount,
        eligibleFileCount: fixture.paths.length,
        dirtyPathCount,
        sessionCount,
        iterations,
        candidateCount: 0,
        bytesRead: 0,
        commitsTraversed: 0,
        fallbackCount: 0,
        p50Ms: null,
        p95Ms: null,
        reason,
    });
    return [
        make("no-tool-fresh", 0, 1),
        make("warm-no-change", 0, 1),
        ...DirtyPathCounts.map((dirty) => make("dirty-paths", dirty, 1)),
        ...SessionCounts.map((sessions) => make("session-contention", 0, sessions)),
        make("overlap", 1, 2),
        make("restore", 1, 1),
    ];
}

export function planAgentRewindBenchmarkFixture(entryCount: number, shape: FixtureShape) {
    validateEntryCount(entryCount);
    const preferredDirectoryCount = shape === "deep" ? Math.min(24, Math.max(1, Math.ceil(Math.log2(entryCount)))) : 0;
    const directoryCount = Math.min(
        preferredDirectoryCount,
        Math.max(0, entryCount - FixtureRepositoryBoundaryCount - 1)
    );
    const eligibleFileCount = entryCount - FixtureRepositoryBoundaryCount - directoryCount;
    return {
        requestedEntryCount: entryCount,
        repositoryBoundaryCount: FixtureRepositoryBoundaryCount,
        directoryCount,
        eligibleFileCount,
        scannedEntryCount: FixtureRepositoryBoundaryCount + directoryCount + eligibleFileCount,
    };
}

async function createFixtureEntries(workspaceRoot: string, entryCount: number, shape: FixtureShape): Promise<string[]> {
    const layout = planAgentRewindBenchmarkFixture(entryCount, shape);
    const { directoryCount } = layout;
    const relativeRoot = Array.from({ length: directoryCount }, (_, index) => `d${index.toString(36)}`).join("/");
    if (relativeRoot) await mkdir(join(workspaceRoot, relativeRoot), { recursive: true });
    const paths = Array.from({ length: layout.eligibleFileCount }, (_, index) =>
        relativeRoot ? `${relativeRoot}/f${index.toString(36)}` : `f${index.toString(36)}`
    );
    for (let offset = 0; offset < paths.length; offset += 256) {
        await Promise.all(
            paths
                .slice(offset, offset + 256)
                .map((path, index) => writeFile(join(workspaceRoot, path), `content-${(offset + index) % 64}`))
        );
    }
    return paths;
}

async function initializeGitFixture(workspaceRoot: string): Promise<void> {
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspaceRoot });
    await execFileAsync("git", ["add", "--all"], {
        cwd: workspaceRoot,
        maxBuffer: 64 * 1024 * 1024,
    });
    await execFileAsync(
        "git",
        [
            "-c",
            "user.name=Crest Benchmark",
            "-c",
            "user.email=benchmark@crest.invalid",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ],
        { cwd: workspaceRoot, maxBuffer: 64 * 1024 * 1024 }
    );
}

async function mutatePaths(workspaceRoot: string, paths: readonly string[], value: string): Promise<void> {
    await Promise.all(paths.map((path, index) => writeFile(join(workspaceRoot, path), `${value}:${index}`)));
}

function makeMetrics(): BenchmarkMetrics {
    return {
        candidateCount: 0,
        bytesRead: 0,
        commitsTraversed: 0,
        fullReconcileCount: 0,
        reset() {
            this.candidateCount = 0;
            this.bytesRead = 0;
            this.commitsTraversed = 0;
            this.fullReconcileCount = 0;
        },
    };
}

function observeStore(store: WorkspaceSnapshotStore, metrics: BenchmarkMetrics): void {
    const captureFullReconcile = store.captureFullReconcile.bind(store);
    store.captureFullReconcile = async (options) => {
        metrics.fullReconcileCount++;
        const captured = await captureFullReconcile(options);
        metrics.bytesRead += captured.coverage.newlyHashedBytes;
        return captured;
    };
    const readNodeKinds = store.readNodeKinds.bind(store);
    store.readNodeKinds = async (snapshot, paths, signal) => {
        metrics.candidateCount += paths.length;
        return await readNodeKinds(snapshot, paths, signal);
    };
}

function recordCoverage(
    metrics: BenchmarkMetrics,
    coverage: { newlyHashedBytes: number },
    fullReconcileCountBefore: number
): void {
    if (metrics.fullReconcileCount === fullReconcileCountBefore) metrics.bytesRead += coverage.newlyHashedBytes;
}

class ObservedWorkspaceGitRunner extends WorkspaceGitRunner {
    constructor(
        readonly metrics: BenchmarkMetrics,
        readonly commandProfile?: Record<string, { calls: number; durationMs: number }>
    ) {
        super();
    }

    override async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
        const started = performance.now();
        try {
            const result = await super.run(args, options);
            if (args[0] === "cat-file" && args[1] === "commit") this.metrics.commitsTraversed++;
            return result;
        } finally {
            if (this.commandProfile) {
                const command = args[0] ?? "unknown";
                const previous = this.commandProfile[command] ?? { calls: 0, durationMs: 0 };
                this.commandProfile[command] = {
                    calls: previous.calls + 1,
                    durationMs: roundMs(previous.durationMs + performance.now() - started),
                };
            }
        }
    }
}

class DeterministicChangeFeed implements WorkspaceChangeFeed {
    trusted = false;
    paths = new Set<string>();

    record(paths: readonly string[]): void {
        for (const path of paths) this.paths.add(path);
    }

    async start(): Promise<void> {
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
        this.paths.clear();
    }
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
    for (let cursor = path; ; cursor = dirname(cursor)) {
        paths.unshift(cursor);
        if (dirname(cursor) === cursor) break;
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

function elapsedMs(started: number): number {
    return roundMs(performance.now() - started);
}

function roundMs(value: number): number {
    return Number(value.toFixed(2));
}

function failureMessage(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function validateEntryCount(entryCount: number): void {
    if (!Number.isSafeInteger(entryCount) || entryCount < 2 || entryCount > WorkspaceCheckpointLimits.maxEntries) {
        throw new Error(`Entry count must be between 2 and ${WorkspaceCheckpointLimits.maxEntries}`);
    }
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
    for (const entryCount of entryCounts) validateEntryCount(entryCount);
    if (!Number.isSafeInteger(iterations) || iterations < 1) {
        throw new Error("--iterations must be a positive integer");
    }
    return { entryCounts: [...new Set(entryCounts)], iterations };
}

function printRows(rows: readonly BenchmarkRow[]): void {
    console.table(
        rows.map((row) => ({
            scenario: row.scenario,
            shape: row.shape,
            outcome: row.outcome,
            requestedentries: row.entryCount,
            eligiblefiles: row.eligibleFileCount,
            dirty: row.dirtyPathCount,
            sessions: row.sessionCount,
            candidates: row.candidateCount,
            bytesread: row.bytesRead,
            commits: row.commitsTraversed,
            fallbacks: row.fallbackCount,
            p50ms: row.p50Ms,
            p95ms: row.p95Ms,
        }))
    );
    console.log(JSON.stringify({ rows }, null, 2));
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => process.argv[1]!) : "";
if (invokedPath === new URL(import.meta.url).pathname) {
    const options = parseOptions(process.argv.slice(2));
    const totalRows = options.entryCounts.length * 22;
    let completedRows = 0;
    const rows = await runAgentRewindSnapshotBenchmark(options, (row) => {
        completedRows++;
        console.log(
            `[${completedRows}/${totalRows}] ${row.shape} ${row.scenario} ${row.outcome} ` +
                `dirty=${row.dirtyPathCount} sessions=${row.sessionCount} p95=${row.p95Ms ?? "n/a"}ms`
        );
    });
    printRows(rows);
}
