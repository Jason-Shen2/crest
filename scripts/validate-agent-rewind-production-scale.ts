// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import {
    WorkspaceGitRunner,
    WorkspaceGitRunnerError,
    type GitRunOptions,
    type GitRunResult,
} from "../packages/coding-agent/workspace-rewind/git-runner";
import { makeProcessOwnerIdentity } from "../packages/coding-agent/workspace-rewind/process-owner";
import {
    WorkspaceCheckpointLimits,
    WorkspaceSnapshotStore,
    WorkspaceSnapshotStoreError,
} from "../packages/coding-agent/workspace-rewind/snapshot-store";
import { WorkspaceCandidates } from "../packages/coding-agent/workspace-rewind/workspace-candidates";
import { resolveCanonicalWorkspaceIdentity } from "../packages/coding-agent/workspace-rewind/workspace-identity";
import {
    WorkspaceTrackerRegistry,
    type WorkspaceTrackerLease,
} from "../packages/coding-agent/workspace-rewind/workspace-tracker-registry";

const execFileAsync = promisify(execFile);

interface ValidationMetrics {
    candidatecount: number;
    bytesread: number;
    commitstraversed: number;
    fullreconcilecount: number;
    reset(): void;
}

export interface CaptureObservation {
    outcome: "pass" | "fallback" | "unavailable" | "timeout" | "budget";
    durationms: number | null;
    snapshot?: string;
    candidatecount: number;
    bytesread: number;
    commitstraversed: number;
    fallbackcount: number;
    message?: string;
}

export interface RepositoryObservation {
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
    schemaversion: 2;
    generatedat: string;
    platform: NodeJS.Platform;
    arch: string;
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
    const { stdout } = await execFileAsync("du", ["-sk", root], { encoding: "utf8", timeout: 60_000 });
    const kibibytes = Number.parseInt(stdout.trim().split(/\s+/)[0]!, 10);
    if (!Number.isFinite(kibibytes)) throw new Error(`Invalid du output for ${root}`);
    return kibibytes * 1024;
}

function makeMetrics(): ValidationMetrics {
    return {
        candidatecount: 0,
        bytesread: 0,
        commitstraversed: 0,
        fullreconcilecount: 0,
        reset() {
            this.candidatecount = 0;
            this.bytesread = 0;
            this.commitstraversed = 0;
            this.fullreconcilecount = 0;
        },
    };
}

function observeStore(store: WorkspaceSnapshotStore, metrics: ValidationMetrics): void {
    const captureFullReconcile = store.captureFullReconcile.bind(store);
    store.captureFullReconcile = async (options) => {
        metrics.fullreconcilecount++;
        const captured = await captureFullReconcile(options);
        metrics.bytesread += captured.coverage.newlyHashedBytes;
        return captured;
    };
    const readNodeKinds = store.readNodeKinds.bind(store);
    store.readNodeKinds = async (snapshot, paths, signal) => {
        metrics.candidatecount += paths.length;
        return await readNodeKinds(snapshot, paths, signal);
    };
}

function recordCoverage(
    metrics: ValidationMetrics,
    coverage: { newlyHashedBytes: number },
    fullReconcileCountBefore: number
): void {
    if (metrics.fullreconcilecount === fullReconcileCountBefore) metrics.bytesread += coverage.newlyHashedBytes;
}

function classifyOutcome(error: unknown, fallbackCount: number): CaptureObservation["outcome"] {
    if (!error) return fallbackCount > 0 ? "fallback" : "pass";
    if (error instanceof WorkspaceSnapshotStoreError) {
        if (error.code === "capture_timeout") return "timeout";
        if (error.code === "capture_budget") return "budget";
    }
    if (error instanceof WorkspaceGitRunnerError && error.code === "timeout") return "timeout";
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout|timed out/i.test(message)) return "timeout";
    if (/budget|quota/i.test(message)) return "budget";
    return "unavailable";
}

async function observeCapture(
    metrics: ValidationMetrics,
    operation: () => Promise<{ ref: { id: string }; coverage: { newlyHashedBytes: number } }>,
    recordResult = true
): Promise<CaptureObservation> {
    metrics.reset();
    const started = performance.now();
    try {
        const fallbackBefore = metrics.fullreconcilecount;
        const captured = await operation();
        if (recordResult) recordCoverage(metrics, captured.coverage, fallbackBefore);
        return {
            outcome: classifyOutcome(undefined, metrics.fullreconcilecount),
            durationms: Number((performance.now() - started).toFixed(2)),
            snapshot: captured.ref.id,
            candidatecount: metrics.candidatecount,
            bytesread: metrics.bytesread,
            commitstraversed: metrics.commitstraversed,
            fallbackcount: metrics.fullreconcilecount,
        };
    } catch (error) {
        return {
            outcome: classifyOutcome(error, metrics.fullreconcilecount),
            durationms: Number((performance.now() - started).toFixed(2)),
            candidatecount: metrics.candidatecount,
            bytesread: metrics.bytesread,
            commitstraversed: metrics.commitstraversed,
            fallbackcount: metrics.fullreconcilecount,
            message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };
    }
}

function unavailableCapture(message: string): CaptureObservation {
    return {
        outcome: "unavailable",
        durationms: null,
        candidatecount: 0,
        bytesread: 0,
        commitstraversed: 0,
        fallbackcount: 0,
        message,
    };
}

export async function measureAgentRewindProductionRepository(rootInput: string): Promise<RepositoryObservation> {
    const root = await realpath(resolve(rootInput));
    const name = basename(root);
    const sourcefingerprintbefore = await readSourceFingerprint(root);
    const [headBytes, trackedfiles] = await Promise.all([runGit(root, ["rev-parse", "HEAD"]), countTrackedFiles(root)]);
    const head = headBytes.toString("utf8").trim();
    const [identity, processOwner] = await Promise.all([
        resolveCanonicalWorkspaceIdentity(root),
        makeProcessOwnerIdentity(),
    ]);
    const temporaryRoot = await mkdtemp(join(tmpdir(), `crest-rewind-production-v3-${name}-`));
    const metrics = makeMetrics();
    const git = new ObservedWorkspaceGitRunner(metrics);
    const registryInput = { dataRoot: join(temporaryRoot, "data"), identity, git, processOwner };
    const registry = new WorkspaceTrackerRegistry({
        openStore: async (input) => {
            const store = await WorkspaceSnapshotStore.open(input);
            observeStore(store, metrics);
            return store;
        },
        makeCandidates: ({ store, feed, userGit }) =>
            new WorkspaceCandidates({
                workspaceRoot: identity.canonicalRoot,
                feed,
                userGit,
                shadowGit: store.git,
            }),
    });
    let keeper: WorkspaceTrackerLease | undefined;
    let additional: WorkspaceTrackerLease[] = [];
    let cold = unavailableCapture("cold authority was not started");
    let warmnochange = unavailableCapture("cold authority unavailable");
    let warmfoursessions = unavailableCapture("cold authority unavailable");
    let storebytes = 0;
    let looseobjects = 0;
    let releasecomplete = true;
    let cleanupcomplete = false;
    metrics.reset();
    const coldStarted = performance.now();
    try {
        try {
            keeper = await registry.acquire(registryInput);
            cold = {
                outcome: "pass",
                durationms: Number((performance.now() - coldStarted).toFixed(2)),
                snapshot: (await keeper.snapshotSource.readHead()).ref.id,
                candidatecount: metrics.candidatecount,
                bytesread: metrics.bytesread,
                commitstraversed: metrics.commitstraversed,
                fallbackcount: 0,
            };
        } catch (error) {
            cold = {
                outcome: classifyOutcome(error, 0),
                durationms: Number((performance.now() - coldStarted).toFixed(2)),
                candidatecount: metrics.candidatecount,
                bytesread: metrics.bytesread,
                commitstraversed: metrics.commitstraversed,
                fallbackcount: 0,
                message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            };
        }
        if (keeper) {
            warmnochange = await observeCapture(metrics, () => keeper!.snapshotSource.synchronizeExternal());
            additional = await Promise.all(Array.from({ length: 3 }, () => registry.acquire(registryInput)));
            const leases = [keeper, ...additional];
            if (leases.some((lease) => lease.snapshotSource !== keeper!.snapshotSource)) {
                throw new Error("Production validation Sessions did not share one snapshot authority");
            }
            warmfoursessions = await observeCapture(
                metrics,
                async () => {
                    const captures = await Promise.all(
                        leases.map(async (lease, index) => {
                            const writer = await lease.writerLeases.acquire({
                                workspaceKey: `${identity.workspaceIdentity}:${identity.workspaceIncarnation}`,
                                sessionId: `production-validation-${index}`,
                                boundaryToken: `production-validation-${index}`,
                            });
                            try {
                                const fallbackBefore = metrics.fullreconcilecount;
                                const captured = await lease.snapshotSource.synchronizeExternal();
                                recordCoverage(metrics, captured.coverage, fallbackBefore);
                                return captured;
                            } finally {
                                writer.release();
                            }
                        })
                    );
                    return captures[0]!;
                },
                false
            );
            looseobjects = await countLooseObjects(keeper.store);
            storebytes = await measureDirectoryBytes(temporaryRoot);
        }
    } finally {
        const releases = await Promise.allSettled(
            [...additional, keeper]
                .filter((item): item is WorkspaceTrackerLease => item != null)
                .map((item) => item.release())
        );
        releasecomplete = releases.every((result) => result.status === "fulfilled");
        await rm(temporaryRoot, { recursive: true, force: true });
        cleanupcomplete = releasecomplete && (await pathIsMissing(temporaryRoot));
    }
    const sourcefingerprintafter = await readSourceFingerprint(root);
    const snapshots = [cold.snapshot, warmnochange.snapshot, warmfoursessions.snapshot];
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
        refsconsistent: snapshots.every((snapshot) => snapshot != null) && new Set(snapshots).size === 1,
        storebytes,
        looseobjects,
        cleanupcomplete,
    };
}

async function pathIsMissing(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return false;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
        throw error;
    }
}

async function countLooseObjects(store: WorkspaceSnapshotStore): Promise<number> {
    const result = await store.git.run(["count-objects", "-v"], { gitDir: store.storeRoot, timeoutMs: 30_000 });
    const match = /^count: (\d+)$/m.exec(result.stdout.toString("ascii"));
    if (!match) throw new Error("Git returned invalid object statistics");
    return Number(match[1]);
}

class ObservedWorkspaceGitRunner extends WorkspaceGitRunner {
    constructor(readonly metrics: ValidationMetrics) {
        super();
    }

    override async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
        const result = await super.run(args, options);
        if (args[0] === "cat-file" && args[1] === "commit") this.metrics.commitstraversed++;
        return result;
    }
}

async function main(argv: string[]): Promise<void> {
    const outputArgument = argv.find((argument) => argument.startsWith("--output="));
    const workspaces = argv.filter((argument) => !argument.startsWith("--output="));
    if (workspaces.length === 0) {
        throw new Error("Usage: tsx scripts/validate-agent-rewind-production-scale.ts <absolute-workspace> [...]");
    }
    const repositories: RepositoryObservation[] = [];
    for (const workspace of workspaces) {
        process.stderr.write(`Measuring ${workspace}\n`);
        const observation = await measureAgentRewindProductionRepository(workspace);
        repositories.push(observation);
        process.stderr.write(
            `${observation.name}: cold=${observation.cold.outcome} ${observation.cold.durationms ?? "n/a"}ms ` +
                `warm=${observation.warmnochange.outcome} ${observation.warmnochange.durationms ?? "n/a"}ms\n`
        );
    }
    const document: ValidationDocument = {
        schemaversion: 2,
        generatedat: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        productionlimits: WorkspaceCheckpointLimits,
        repositories,
    };
    const json = `${JSON.stringify(document, null, 2)}\n`;
    if (outputArgument) {
        await writeFile(resolve(outputArgument.slice("--output=".length)), json, { mode: 0o600 });
        return;
    }
    process.stdout.write(json);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main(process.argv.slice(2));
}
