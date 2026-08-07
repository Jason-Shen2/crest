// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { WorkspaceGitRunner } from "../packages/coding-agent/workspace-rewind/git-runner";
import {
    IncrementalPathCapture,
    type IncrementalPathCaptureHooks,
} from "../packages/coding-agent/workspace-rewind/incremental-path-capture";
import { makeProcessOwnerIdentity } from "../packages/coding-agent/workspace-rewind/process-owner";
import {
    WorkspaceCheckpointLimits,
    WorkspaceSnapshotStore,
    WorkspaceSnapshotStoreError,
} from "../packages/coding-agent/workspace-rewind/snapshot-store";
import { resolveCanonicalWorkspaceIdentity } from "../packages/coding-agent/workspace-rewind/workspace-identity";
import { WorkspaceSnapshotTracker } from "../packages/coding-agent/workspace-rewind/workspace-snapshot-tracker";
import {
    WorkspaceTrackerRegistry,
    type WorkspaceTrackerLease,
} from "../packages/coding-agent/workspace-rewind/workspace-tracker-registry";

const execFileAsync = promisify(execFile);

interface CaptureMetrics {
    fullreconciles: number;
    enumeratedentries: number;
    workeractive: number;
    workerpeak: number;
    anchoredgroups: number;
    anchoredms: number;
    hooks: IncrementalPathCaptureHooks;
    reset(): void;
}

interface CaptureObservation {
    outcome: "completed" | "capture-timeout" | "capture-budget" | "failed" | "skipped";
    durationms: number;
    snapshot?: string;
    eligibleentries?: number;
    newlyhashedbytes?: number;
    exclusions?: number;
    fullreconciles: number;
    enumeratedentries: number;
    workerpeak: number;
    anchoredgroups: number;
    anchoredms: number;
    message?: string;
}

interface RepositoryObservation {
    name: string;
    root: string;
    head: string;
    trackedfiles: number;
    sourcefingerprintbefore: string;
    sourcefingerprintafter: string;
    sourceunchanged: boolean;
    cold: CaptureObservation;
    warmnochange: CaptureObservation;
    warmfoursessions: CaptureObservation;
    refsconsistent: boolean;
    storebytes: number;
    looseobjects: number;
    cleanupcomplete: boolean;
}

interface ValidationDocument {
    schemaversion: 1;
    generatedat: string;
    platform: NodeJS.Platform;
    arch: string;
    captureprofile: "pre-turn" | "terminal";
    productionlimits: typeof WorkspaceCheckpointLimits;
    repositories: RepositoryObservation[];
}

async function runGit(root: string, args: string[]): Promise<Buffer> {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
    });
    return stdout;
}

async function readSourceFingerprint(root: string): Promise<string> {
    const [head, status] = await Promise.all([
        runGit(root, ["rev-parse", "HEAD"]),
        runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    return createHash("sha256")
        .update(head)
        .update(Buffer.from([0]))
        .update(status)
        .digest("hex");
}

async function countTrackedFiles(root: string): Promise<number> {
    const files = await runGit(root, ["ls-files", "-z"]);
    let count = 0;
    for (const byte of files) {
        if (byte === 0) count++;
    }
    return count;
}

async function measureDirectoryBytes(root: string): Promise<number> {
    const { stdout } = await execFileAsync("du", ["-sk", root], {
        encoding: "utf8",
        timeout: 60_000,
    });
    const kibibytes = Number.parseInt(stdout.trim().split(/\s+/)[0]!, 10);
    if (!Number.isFinite(kibibytes)) throw new Error(`Invalid du output for ${root}`);
    return kibibytes * 1024;
}

function makeMetrics(): CaptureMetrics {
    const metrics: CaptureMetrics = {
        fullreconciles: 0,
        enumeratedentries: 0,
        workeractive: 0,
        workerpeak: 0,
        anchoredgroups: 0,
        anchoredms: 0,
        hooks: {
            scopeEnumerated: (entryCount) => {
                metrics.enumeratedentries += entryCount;
            },
            workerStarted: () => {
                metrics.workeractive++;
                metrics.workerpeak = Math.max(metrics.workerpeak, metrics.workeractive);
            },
            workerSettled: () => {
                metrics.workeractive--;
            },
        },
        reset() {
            metrics.fullreconciles = 0;
            metrics.enumeratedentries = 0;
            metrics.workeractive = 0;
            metrics.workerpeak = 0;
            metrics.anchoredgroups = 0;
            metrics.anchoredms = 0;
        },
    };
    return metrics;
}

function instrumentStore(store: WorkspaceSnapshotStore, metrics: CaptureMetrics): void {
    const captureFullReconcile = store.captureFullReconcile.bind(store);
    store.captureFullReconcile = async (options) => {
        metrics.fullreconciles++;
        const captureAnchoredGroupAttempt = store.captureAnchoredGroupAttempt.bind(store);
        store.captureAnchoredGroupAttempt = async (...args) => {
            metrics.workeractive++;
            metrics.workerpeak = Math.max(metrics.workerpeak, metrics.workeractive);
            metrics.anchoredgroups++;
            const started = performance.now();
            try {
                return await captureAnchoredGroupAttempt(...args);
            } finally {
                metrics.anchoredms += performance.now() - started;
                metrics.workeractive--;
            }
        };
        try {
            return await captureFullReconcile({
                ...options,
                observer: {
                    scopeEnumerated: (entryCount) => {
                        metrics.enumeratedentries += entryCount;
                    },
                },
            });
        } finally {
            store.captureAnchoredGroupAttempt = captureAnchoredGroupAttempt;
        }
    };
}

function classifyCaptureFailure(error: unknown): CaptureObservation["outcome"] {
    if (!(error instanceof WorkspaceSnapshotStoreError)) return "failed";
    if (error.code === "capture_timeout") return "capture-timeout";
    if (error.code === "capture_budget") return "capture-budget";
    return "failed";
}

async function observeCapture(
    metrics: CaptureMetrics,
    operation: () => ReturnType<WorkspaceSnapshotTracker["capture"]>
): Promise<CaptureObservation> {
    metrics.reset();
    const started = performance.now();
    try {
        const captured = await operation();
        return {
            outcome: "completed",
            durationms: Number((performance.now() - started).toFixed(2)),
            snapshot: captured.ref.id,
            eligibleentries: captured.coverage.eligibleEntryCount,
            newlyhashedbytes: captured.coverage.newlyHashedBytes,
            exclusions: captured.coverage.exclusions.length,
            fullreconciles: metrics.fullreconciles,
            enumeratedentries: metrics.enumeratedentries,
            workerpeak: metrics.workerpeak,
            anchoredgroups: metrics.anchoredgroups,
            anchoredms: Number(metrics.anchoredms.toFixed(2)),
        };
    } catch (error) {
        return {
            outcome: classifyCaptureFailure(error),
            durationms: Number((performance.now() - started).toFixed(2)),
            fullreconciles: metrics.fullreconciles,
            enumeratedentries: metrics.enumeratedentries,
            workerpeak: metrics.workerpeak,
            anchoredgroups: metrics.anchoredgroups,
            anchoredms: Number(metrics.anchoredms.toFixed(2)),
            message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };
    }
}

function skippedCapture(message: string): CaptureObservation {
    return {
        outcome: "skipped",
        durationms: 0,
        fullreconciles: 0,
        enumeratedentries: 0,
        workerpeak: 0,
        anchoredgroups: 0,
        anchoredms: 0,
        message,
    };
}

async function measureRepository(
    rootInput: string,
    captureProfile: "pre-turn" | "terminal"
): Promise<RepositoryObservation> {
    const root = resolve(rootInput);
    const name = basename(root);
    const sourcefingerprintbefore = await readSourceFingerprint(root);
    const [headBytes, trackedfiles] = await Promise.all([runGit(root, ["rev-parse", "HEAD"]), countTrackedFiles(root)]);
    const head = headBytes.toString("utf8").trim();
    const temporaryRoot = await mkdtemp(join(tmpdir(), `crest-rewind-production-${name}-`));
    let cleanupcomplete = false;
    let keeper: WorkspaceTrackerLease | undefined;
    let additional: WorkspaceTrackerLease[] = [];
    let cold = skippedCapture("not started");
    let warmnochange = skippedCapture("cold baseline unavailable");
    let warmfoursessions = skippedCapture("cold baseline unavailable");
    let storebytes = 0;
    let looseobjects = 0;
    try {
        const [identity, processOwner] = await Promise.all([
            resolveCanonicalWorkspaceIdentity(root),
            makeProcessOwnerIdentity(),
        ]);
        const metrics = makeMetrics();
        const registryInput = {
            dataRoot: join(temporaryRoot, "data"),
            identity,
            git: new WorkspaceGitRunner(),
            processOwner,
        };
        const registry = new WorkspaceTrackerRegistry({
            openStore: async (input) => {
                const store = await WorkspaceSnapshotStore.open(input);
                instrumentStore(store, metrics);
                return store;
            },
            makeTracker: ({ store, feed }) =>
                new WorkspaceSnapshotTracker({
                    store,
                    feed,
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
                }),
        });
        keeper = await registry.acquire(registryInput);
        cold = await observeCapture(metrics, () => keeper!.tracker.capture({ profile: captureProfile }));
        if (cold.outcome === "completed") {
            warmnochange = await observeCapture(metrics, () => keeper!.tracker.capture({ profile: captureProfile }));
            additional = await Promise.all(Array.from({ length: 3 }, () => registry.acquire(registryInput)));
            const leases = [keeper, ...additional];
            warmfoursessions = await observeCapture(metrics, async () => {
                const captured = await Promise.all(
                    leases.map((lease) => lease.tracker.capture({ profile: captureProfile }))
                );
                return captured[0]!;
            });
        }
        looseobjects = await countLooseObjects(keeper.store);
        storebytes = await measureDirectoryBytes(temporaryRoot);
    } finally {
        const releases = await Promise.allSettled(
            [...additional, keeper].filter((item) => item != null).map((item) => item.release())
        );
        const releaseFailures = releases.filter((result) => result.status === "rejected");
        await rm(temporaryRoot, { recursive: true, force: true });
        cleanupcomplete = releaseFailures.length === 0;
    }
    const sourcefingerprintafter = await readSourceFingerprint(root);
    const snapshots = [cold.snapshot, warmnochange.snapshot, warmfoursessions.snapshot].filter((item) => item != null);
    return {
        name,
        root,
        head,
        trackedfiles,
        sourcefingerprintbefore,
        sourcefingerprintafter,
        sourceunchanged: sourcefingerprintbefore === sourcefingerprintafter,
        cold,
        warmnochange,
        warmfoursessions,
        refsconsistent: snapshots.length === 3 && new Set(snapshots).size === 1,
        storebytes,
        looseobjects,
        cleanupcomplete,
    };
}

async function countLooseObjects(store: WorkspaceSnapshotStore): Promise<number> {
    const result = await store.git.run(["count-objects", "-v"], { gitDir: store.storeRoot, timeoutMs: 30_000 });
    const match = /^count: (\d+)$/m.exec(result.stdout.toString("ascii"));
    if (!match) throw new Error("Git returned invalid object statistics");
    return Number(match[1]);
}

async function main(argv: string[]): Promise<void> {
    const outputArgument = argv.find((argument) => argument.startsWith("--output="));
    const profileArgument = argv.find((argument) => argument.startsWith("--profile="));
    const captureprofile = profileArgument?.slice("--profile=".length) ?? "terminal";
    if (captureprofile !== "pre-turn" && captureprofile !== "terminal") {
        throw new Error("--profile must be pre-turn or terminal");
    }
    const workspaces = argv.filter(
        (argument) => !argument.startsWith("--output=") && !argument.startsWith("--profile=")
    );
    if (workspaces.length === 0) {
        throw new Error("Usage: tsx scripts/validate-agent-rewind-production-scale.ts <absolute-workspace> [...]");
    }
    const repositories: RepositoryObservation[] = [];
    for (const workspace of workspaces) {
        process.stderr.write(`Measuring ${workspace}\n`);
        const observation = await measureRepository(workspace, captureprofile);
        repositories.push(observation);
        process.stderr.write(
            `${observation.name}: cold=${observation.cold.outcome} ${observation.cold.durationms}ms ` +
                `warm=${observation.warmnochange.outcome} ${observation.warmnochange.durationms}ms\n`
        );
    }
    const document: ValidationDocument = {
        schemaversion: 1,
        generatedat: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        captureprofile,
        productionlimits: {
            preTurnTimeoutMs: WorkspaceCheckpointLimits.preTurnTimeoutMs,
            terminalTimeoutMs: WorkspaceCheckpointLimits.terminalTimeoutMs,
            maxEntries: WorkspaceCheckpointLimits.maxEntries,
            maxNewlyHashedBytes: WorkspaceCheckpointLimits.maxNewlyHashedBytes,
            maxUntrackedFileBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
            softQuotaBytes: WorkspaceCheckpointLimits.softQuotaBytes,
            minimumFreeBytes: WorkspaceCheckpointLimits.minimumFreeBytes,
            minimumFreeRatio: WorkspaceCheckpointLimits.minimumFreeRatio,
        },
        repositories,
    };
    const json = `${JSON.stringify(document, null, 2)}\n`;
    if (outputArgument) {
        const output = resolve(outputArgument.slice("--output=".length));
        await writeFile(output, json, { mode: 0o600 });
        process.stderr.write(`Wrote ${output}\n`);
        return;
    }
    process.stdout.write(json);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main(process.argv.slice(2));
}
