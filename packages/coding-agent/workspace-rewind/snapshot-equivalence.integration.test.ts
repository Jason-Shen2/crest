// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import {
    applyIncrementalTrees,
    type IncrementalPathMutation,
    type IncrementalTreeEntry,
    type IncrementalTreeObjectAccess,
} from "./incremental-tree";
import { WorkspaceCheckpointLimits, WorkspaceSnapshotStore } from "./snapshot-store";
import {
    encodeCanonicalStoredJson,
    StoredManifestReader,
    toStoredWorkspaceScope,
    type StoredManifestObjectReader,
    type StoredScopeManifestV2,
} from "./stored-manifest";
import type {
    CapturedPathStateV1,
    WorkspacePathChangeV1,
    WorkspaceSnapshotCoverage,
    WorkspaceSnapshotRefV1,
} from "./types";
import {
    ParcelWorkspaceChangeFeed,
    type WorkspaceChangeDrain,
    type WorkspaceChangeEvent,
    type WorkspaceChangeFeed,
    type WorkspaceChangeWatcher,
} from "./workspace-change-feed";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import type { WorkspaceScopeManifest } from "./workspace-scope";
import type { WorkspaceSnapshotTrackerPathCapture } from "./workspace-snapshot-tracker";
import { WorkspaceSnapshotTracker } from "./workspace-snapshot-tracker";

const execFileAsync = promisify(execFile);
const cleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("full and incremental snapshot equivalence", () => {
    test.each([false, true])(
        "keeps fixed filesystem operations equivalent in Git=%s workspaces",
        async (git) => {
            const value = await makeFixture(git ? "git" : "plain", git);
            const fullReconcile = vi.spyOn(value.store, "captureFullReconcile");
            try {
                let previousIncremental = await value.tracker.capture({ profile: "pre-turn" });
                let previousFull = await value.store.captureFullReconcile({ profile: "pre-turn" });
                const observedPaths = new Set<string>();

                await expectEquivalent(value.store, previousIncremental.ref, previousFull.ref, observedPaths);

                const operations: Array<{
                    name: string;
                    paths: string[];
                    posixOnly?: boolean;
                    scopeInvalidated?: boolean;
                    apply(): Promise<void>;
                }> = [
                    {
                        name: "empty boundary",
                        paths: [],
                        apply: async () => undefined,
                    },
                    {
                        name: "create text",
                        paths: ["text.txt"],
                        apply: async () => await writeFile(join(value.workspaceRoot, "text.txt"), "first\n"),
                    },
                    {
                        name: "write text",
                        paths: ["text.txt"],
                        apply: async () => await writeFile(join(value.workspaceRoot, "text.txt"), "second\n"),
                    },
                    {
                        name: "write binary",
                        paths: ["binary.bin"],
                        apply: async () =>
                            await writeFile(join(value.workspaceRoot, "binary.bin"), Buffer.from([0, 255, 1])),
                    },
                    {
                        name: "same-size rewrite",
                        paths: ["text.txt"],
                        apply: async () => await writeFile(join(value.workspaceRoot, "text.txt"), "third!\n"),
                    },
                    {
                        name: "chmod",
                        paths: ["text.txt"],
                        posixOnly: true,
                        apply: async () => await chmod(join(value.workspaceRoot, "text.txt"), 0o755),
                    },
                    {
                        name: "symlink",
                        paths: ["latest"],
                        posixOnly: true,
                        apply: async () => await symlink("text.txt", join(value.workspaceRoot, "latest")),
                    },
                    {
                        name: "delete",
                        paths: ["binary.bin"],
                        apply: async () => await unlink(join(value.workspaceRoot, "binary.bin")),
                    },
                    {
                        name: "rename",
                        paths: ["text.txt", "renamed.txt"],
                        apply: async () =>
                            await rename(
                                join(value.workspaceRoot, "text.txt"),
                                join(value.workspaceRoot, "renamed.txt")
                            ),
                    },
                    {
                        name: "create directory tree",
                        paths: ["old-dir"],
                        apply: async () => {
                            await mkdir(join(value.workspaceRoot, "old-dir", "nested"), { recursive: true });
                            await writeFile(join(value.workspaceRoot, "old-dir", "a.txt"), "a");
                            await writeFile(join(value.workspaceRoot, "old-dir", "nested", "b.txt"), "b");
                        },
                    },
                    {
                        name: "directory rename",
                        paths: ["old-dir", "new-dir"],
                        apply: async () =>
                            await rename(join(value.workspaceRoot, "old-dir"), join(value.workspaceRoot, "new-dir")),
                    },
                    {
                        name: "ignored file",
                        paths: [".gitignore", "ignored.tmp"],
                        scopeInvalidated: true,
                        apply: async () => {
                            await writeFile(join(value.workspaceRoot, ".gitignore"), "*.tmp\n");
                            await writeFile(join(value.workspaceRoot, "ignored.tmp"), "ignored");
                        },
                    },
                    {
                        name: "delete ignored file",
                        paths: ["ignored.tmp"],
                        apply: async () => await unlink(join(value.workspaceRoot, "ignored.tmp")),
                    },
                    {
                        name: "nested repository",
                        paths: ["nested-repo"],
                        scopeInvalidated: true,
                        apply: async () => {
                            await mkdir(join(value.workspaceRoot, "nested-repo"));
                            await execFileAsync("git", ["init", "-q"], {
                                cwd: join(value.workspaceRoot, "nested-repo"),
                            });
                            await writeFile(join(value.workspaceRoot, "nested-repo", "inside.txt"), "nested");
                        },
                    },
                ];

                for (const operation of operations) {
                    if (operation.posixOnly && process.platform === "win32") continue;
                    await operation.apply();
                    value.feed.record(operation.paths, operation.scopeInvalidated ?? false);
                    for (const path of operation.paths) observedPaths.add(path);
                    const fullReconcilesBefore = fullReconcile.mock.calls.length;
                    const full = await value.store.captureFullReconcile({ profile: "terminal" });
                    const context = `${operation.name} (${git ? "Git" : "non-Git"})`;
                    let incremental: Awaited<ReturnType<WorkspaceSnapshotTracker["capture"]>>;
                    try {
                        incremental = await value.tracker.capture({ profile: "terminal" });
                    } catch (cause) {
                        throw new Error(`Incremental capture failed after ${context}`, { cause });
                    }
                    if (operation.name === "delete ignored file") {
                        expect(fullReconcile.mock.calls.length - fullReconcilesBefore, context).toBe(1);
                    }

                    await expectEquivalent(value.store, incremental.ref, full.ref, observedPaths, context);
                    expect(semanticCoverage(incremental.coverage), context).toEqual(semanticCoverage(full.coverage));
                    expect(await value.store.diff(previousIncremental.ref, incremental.ref), context).toEqual(
                        await value.store.diff(previousFull.ref, full.ref)
                    );
                    previousIncremental = incremental;
                    previousFull = full;
                }
            } finally {
                await value.tracker.dispose();
            }
        },
        60_000
    );

    test("matches an independent full projection for 50 deterministic 100-operation models", async () => {
        for (let seed = 1; seed <= 50; seed++) {
            const random = makeRandom(seed);
            const objects = new MemorySnapshotObjects();
            let incrementalRoots = {
                workspaceTree: await objects.writeTree([]),
                stateTree: await objects.writeTree([]),
            };
            const fullProjection = new Map<string, CapturedPathStateV1>();
            let incrementalReader = await makeMemoryReader(objects, incrementalRoots, fullProjection.size);

            for (let operationIndex = 0; operationIndex < 100; operationIndex++) {
                const previousFull = new Map(fullProjection);
                const previousReader = incrementalReader;
                const operation = await makeRandomOperation(objects, fullProjection, random, operationIndex);
                const context = `seed ${seed}, operation ${operationIndex}: ${operation.name}`;

                incrementalRoots = await applyIncrementalTrees({
                    baseWorkspaceTree: incrementalRoots.workspaceTree,
                    baseStateTree: incrementalRoots.stateTree,
                    mutations: operation.mutations,
                    objects,
                });
                incrementalReader = await makeMemoryReader(objects, incrementalRoots, fullProjection.size);

                const actualPaths = new Set<string>();
                await incrementalReader.collectExplicitPaths(actualPaths);
                const allPaths = [...new Set([...actualPaths, ...previousFull.keys(), ...fullProjection.keys()])].sort(
                    comparePaths
                );
                expect(await materializeReader(incrementalReader, allPaths), context).toEqual(
                    materializeFullProjection(fullProjection, allPaths)
                );
                expect(await previousReader.diff(incrementalReader), context).toEqual(
                    diffFullProjections(previousFull, fullProjection)
                );
            }
        }
    }, 30_000);

    test.each([
        ["watcher overflow", true, false],
        ["watcher error", true, false],
        ["scope invalidation", false, true],
    ] as const)(
        "full reconciles %s without publishing an available empty state",
        async (_name, loseTrust, scopeInvalidated) => {
            const value = await makeFixture(`gap-${_name.replaceAll(" ", "-")}`, false);
            const fullReconcile = vi.spyOn(value.store, "captureFullReconcile");
            try {
                await value.tracker.capture({ profile: "pre-turn" });
                await writeFile(join(value.workspaceRoot, "changed.txt"), _name);
                value.feed.record(["changed.txt"], scopeInvalidated);
                if (loseTrust) value.feed.loseTrust();
                const full = await value.store.captureFullReconcile({ profile: "terminal" });

                const incremental = await value.tracker.capture({ profile: "terminal" });

                expect(fullReconcile).toHaveBeenCalledTimes(3);
                await expectEquivalent(value.store, incremental.ref, full.ref, new Set(["changed.txt"]), _name);
                expect(await value.store.diff(incremental.ref, full.ref), _name).toEqual([]);
            } finally {
                await value.tracker.dispose();
            }
        },
        30_000
    );

    test.each(["dirty path replaced during read", "continuous instability beyond retry budget"] as const)(
        "full reconciles %s instead of publishing an available empty state",
        async (scenario) => {
            let captureCalls = 0;
            const pathCapture = makeInstabilityPathCapture(async () => {
                captureCalls++;
                return scenario === "dirty path replaced during read"
                    ? { status: "reconcile" as const, reason: "unstable-path" as const }
                    : {
                          status: "captured" as const,
                          mutations: [{ path: "unstable.txt", state: { state: "absent" as const } }],
                          newlyHashedBytes: 0,
                      };
            });
            const value = await makeFixture(`instability-${scenario.replaceAll(" ", "-")}`, false, pathCapture);
            const fullReconcile = vi.spyOn(value.store, "captureFullReconcile");
            try {
                await value.tracker.capture({ profile: "pre-turn" });
                await writeFile(join(value.workspaceRoot, "unstable.txt"), "stable full bytes");
                value.feed.record(["unstable.txt"]);
                if (scenario === "continuous instability beyond retry budget") {
                    value.feed.onAdvance = () => value.feed.record(["unstable.txt"]);
                }
                const full = await value.store.captureFullReconcile({ profile: "terminal" });

                const incremental = await value.tracker.capture({ profile: "terminal" });

                expect(captureCalls).toBe(scenario === "dirty path replaced during read" ? 1 : 2);
                expect(fullReconcile).toHaveBeenCalledTimes(3);
                await expectEquivalent(value.store, incremental.ref, full.ref, new Set(["unstable.txt"]), scenario);
            } finally {
                await value.tracker.dispose();
            }
        },
        30_000
    );

    test("turns a real change-feed callback error into typed unavailable", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-equivalence-feed-callback-error-"));
        cleanupRoots.push(root);
        const requestedWorkspaceRoot = join(root, "workspace");
        await mkdir(requestedWorkspaceRoot);
        const workspaceRoot = await realpath(requestedWorkspaceRoot);
        const watcher = new FaultInjectingWatcher();
        const feed = new ParcelWorkspaceChangeFeed({ workspaceRoot, watcher });
        try {
            await feed.start();
            watcher.callback?.(new Error("injected callback failure"), []);

            await expect(feed.drain()).resolves.toEqual({
                status: "unavailable",
                reason: "watcher-error",
            });
        } finally {
            await feed.dispose();
        }
    });

    test("detects a real dirty-file replacement at the anchored read boundary", async () => {
        const value = await makeFixture("real-dirty-read-replacement", false);
        const target = join(value.workspaceRoot, "unstable.txt");
        await writeFile(target, "before");
        const baseline = await value.store.captureFullReconcile({ profile: "pre-turn" });
        const metadata = await value.store.readIncrementalSnapshotMetadata(baseline.ref);
        await writeFile(target, "after!");
        let replaced = false;
        vi.doMock("./anchored-reader", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./anchored-reader")>();
            return {
                ...actual,
                runAnchoredReaderBatch: async (...args: Parameters<typeof actual.runAnchoredReaderBatch>) => {
                    replaced = true;
                    await rm(target);
                    await writeFile(target, "other!");
                    return await actual.runAnchoredReaderBatch(...args);
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./incremental-path-capture");
        const IsolatedGitRunner = (await import("./git-runner")).WorkspaceGitRunner;
        const capture = new isolated.IncrementalPathCapture({
            identity: value.store.identity,
            git: new IsolatedGitRunner(),
            storeRoot: value.store.storeRoot,
            scope: metadata.scope,
            maxEntries: WorkspaceCheckpointLimits.maxEntries,
            maxUntrackedBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
            maxNewlyHashedBytes: WorkspaceCheckpointLimits.maxNewlyHashedBytes,
            timeoutMs: WorkspaceCheckpointLimits.terminalTimeoutMs,
            base: { readNodeKind: (path, signal) => value.store.readNodeKind(baseline.ref, path, signal) },
        });
        try {
            await expect(capture.capture(["unstable.txt"])).resolves.toEqual({
                status: "reconcile",
                reason: "unstable-path",
            });
            expect(replaced).toBe(true);
        } finally {
            await capture.dispose();
            await value.tracker.dispose();
            vi.doUnmock("./anchored-reader");
            vi.resetModules();
        }
    }, 30_000);
});

interface RandomOperation {
    name: string;
    mutations: IncrementalPathMutation[];
}

class MemorySnapshotObjects implements IncrementalTreeObjectAccess, StoredManifestObjectReader {
    objects = new Map<string, { type: "blob" | "tree"; bytes: Buffer }>();

    async readBlob(oid: string): Promise<Buffer> {
        return this.readObject(oid, "blob");
    }

    async readBlobs(oids: readonly string[]): Promise<ReadonlyMap<string, Buffer>> {
        return new Map(await Promise.all(oids.map(async (oid) => [oid, await this.readBlob(oid)] as const)));
    }

    async readTree(oid: string): Promise<Buffer> {
        return this.readObject(oid, "tree");
    }

    async readObjectType(oid: string): Promise<"blob" | "tree"> {
        const object = this.objects.get(oid);
        if (!object) throw new Error(`Missing memory object ${oid}`);
        return object.type;
    }

    async writeBlob(bytes: Buffer): Promise<string> {
        return this.putObject("blob", bytes);
    }

    async writeTree(entries: IncrementalTreeEntry[]): Promise<string> {
        const sorted = [...entries].sort((left, right) =>
            Buffer.compare(
                Buffer.from(left.type === "tree" ? `${left.name}/` : left.name),
                Buffer.from(right.type === "tree" ? `${right.name}/` : right.name)
            )
        );
        const bytes = Buffer.concat(
            sorted.map((entry) =>
                Buffer.concat([
                    Buffer.from(`${entry.mode.replace(/^0/, "")} ${entry.name}\0`),
                    Buffer.from(entry.oid, "hex"),
                ])
            )
        );
        return this.putObject("tree", bytes);
    }

    putObject(type: "blob" | "tree", bytes: Buffer): string {
        const oid = createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
        this.objects.set(oid, { type, bytes: Buffer.from(bytes) });
        return oid;
    }

    readObject(oid: string, type: "blob" | "tree"): Buffer {
        const object = this.objects.get(oid);
        if (!object || object.type !== type) throw new Error(`Missing memory ${type} ${oid}`);
        return Buffer.from(object.bytes);
    }
}

async function makeMemoryReader(
    objects: MemorySnapshotObjects,
    roots: { workspaceTree: string; stateTree: string },
    eligibleEntryCount: number
): Promise<StoredManifestReader> {
    const manifest: StoredScopeManifestV2 = {
        schemaversion: 2,
        workspaceidentity: "a".repeat(64),
        workspaceincarnation: "b".repeat(64),
        scope: toStoredWorkspaceScope(memoryScope()),
        coverage: { complete: true, eligibleentrycount: eligibleEntryCount, exclusions: [] },
        statetree: roots.stateTree,
    };
    const scopeManifest = await objects.writeBlob(encodeCanonicalStoredJson(manifest));
    return await StoredManifestReader.open({
        snapshot: {
            id: scopeManifest,
            workspaceIdentity: "a".repeat(64),
            workspaceIncarnation: "b".repeat(64),
            tree: roots.workspaceTree,
            scopeManifest,
        },
        objects,
    });
}

function memoryScope(): WorkspaceScopeManifest {
    return {
        schemaVersion: 1,
        policy: {
            maxEntries: 200_000,
            maxUntrackedBytes: 2 * 1024 ** 2,
            gitGlobalExcludes: "disabled-by-isolated-runner",
        },
        ignoreInputs: [],
        nestedRepositoryBoundaries: [],
    };
}

async function makeRandomOperation(
    objects: MemorySnapshotObjects,
    full: Map<string, CapturedPathStateV1>,
    random: () => number,
    operationIndex: number
): Promise<RandomOperation> {
    const existingPaths = [...full.keys()].sort(comparePaths);
    const choice = existingPaths.length === 0 ? 0 : random() % 5;
    if (choice === 0) {
        const path = randomPath(random);
        const state = await randomFile(objects, operationIndex, random, false);
        full.set(path, state);
        return { name: `create/write ${path}`, mutations: [{ path, state }] };
    }
    const source = existingPaths[random() % existingPaths.length]!;
    if (choice === 1) {
        const current = full.get(source)!;
        const state = await randomFile(objects, operationIndex, random, current.state === "file" && current.executable);
        full.set(source, state);
        return { name: `write ${source}`, mutations: [{ path: source, state }] };
    }
    if (choice === 2) {
        full.delete(source);
        return { name: `delete ${source}`, mutations: [{ path: source, state: { state: "absent" } }] };
    }
    if (choice === 3) {
        let target = randomPath(random);
        for (let attempt = 0; attempt < 400 && full.has(target); attempt++) target = randomPath(random);
        if (full.has(target)) {
            const state = await randomFile(objects, operationIndex, random, false);
            full.set(source, state);
            return { name: `write ${source}`, mutations: [{ path: source, state }] };
        }
        const state = full.get(source)!;
        full.delete(source);
        full.set(target, state);
        return {
            name: `rename ${source} to ${target}`,
            mutations: [
                { path: source, state: { state: "absent" } },
                { path: target, state },
            ],
        };
    }
    const current = full.get(source)!;
    if (current.state !== "file") throw new Error("Random model expected a file state");
    const state = { ...current, executable: !current.executable };
    full.set(source, state);
    return { name: `chmod ${source}`, mutations: [{ path: source, state }] };
}

async function randomFile(
    objects: MemorySnapshotObjects,
    operationIndex: number,
    random: () => number,
    executable: boolean
): Promise<Extract<CapturedPathStateV1, { state: "file" }>> {
    const bytes = Buffer.from(`operation-${operationIndex}-${random()}-${random()}`);
    return { state: "file", oid: await objects.writeBlob(bytes), executable };
}

function randomPath(random: () => number): string {
    return `dir-${random() % 10}/file-${random() % 40}.txt`;
}

function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

async function materializeReader(
    reader: StoredManifestReader,
    paths: readonly string[]
): Promise<Array<{ path: string; state: CapturedPathStateV1 }>> {
    return await Promise.all(paths.map(async (path) => ({ path, state: await reader.readPathState(path) })));
}

function materializeFullProjection(
    projection: ReadonlyMap<string, CapturedPathStateV1>,
    paths: readonly string[]
): Array<{ path: string; state: CapturedPathStateV1 }> {
    return paths.map((path) => ({ path, state: projection.get(path) ?? { state: "absent" } }));
}

function diffFullProjections(
    before: ReadonlyMap<string, CapturedPathStateV1>,
    after: ReadonlyMap<string, CapturedPathStateV1>
): WorkspacePathChangeV1[] {
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort(comparePaths);
    const changes: WorkspacePathChangeV1[] = [];
    for (const path of paths) {
        const beforeState = before.get(path) ?? { state: "absent" as const };
        const afterState = after.get(path) ?? { state: "absent" as const };
        if (JSON.stringify(beforeState) !== JSON.stringify(afterState)) {
            changes.push({ path, before: beforeState, after: afterState });
        }
    }
    return changes;
}

class FaultInjectingWatcher implements WorkspaceChangeWatcher {
    callback?: (error: Error | null, events: WorkspaceChangeEvent[]) => unknown;

    async subscribe(_directory: string, callback: (error: Error | null, events: WorkspaceChangeEvent[]) => unknown) {
        this.callback = callback;
        return { unsubscribe: async () => undefined };
    }
}

class DeterministicChangeFeed implements WorkspaceChangeFeed {
    events: Array<{ sequence: number; path: string; scopeInvalidated: boolean }> = [];
    drainedSequence = 0;
    nextSequence = 0;
    trusted = false;
    lastDrainHadChanges = false;
    onAdvance?: () => void;

    record(paths: readonly string[], scopeInvalidated = false): void {
        for (const path of paths) {
            this.events.push({ sequence: ++this.nextSequence, path, scopeInvalidated });
        }
        if (scopeInvalidated) this.trusted = false;
    }

    async start(): Promise<void> {
        this.drainedSequence = this.nextSequence;
        this.lastDrainHadChanges = false;
        this.trusted = true;
    }

    async drain(): Promise<WorkspaceChangeDrain> {
        if (!this.trusted) return { status: "unavailable", reason: "watcher-error" };
        if (this.lastDrainHadChanges) this.onAdvance?.();
        const events = this.events.filter((event) => event.sequence > this.drainedSequence);
        this.drainedSequence = this.nextSequence;
        const changedPaths = [...new Set(events.map((event) => event.path))].sort(comparePaths);
        this.lastDrainHadChanges = changedPaths.length > 0;
        return { status: "complete", changedPaths };
    }

    isTrusted(): boolean {
        return this.trusted;
    }

    loseTrust(): void {
        this.trusted = false;
    }

    async dispose(): Promise<void> {
        this.trusted = false;
    }
}

async function makeFixture(label: string, gitRepository: boolean, pathCapture?: WorkspaceSnapshotTrackerPathCapture) {
    const root = await mkdtemp(join(tmpdir(), `crest-snapshot-equivalence-${label}-`));
    cleanupRoots.push(root);
    const workspaceRoot = await realpath(await mkdir(join(root, "workspace"), { recursive: true }));
    if (gitRepository) await execFileAsync("git", ["init", "-q"], { cwd: workspaceRoot });
    const identity: CanonicalWorkspaceIdentity = {
        canonicalRoot: workspaceRoot,
        workspaceIdentity: Buffer.from(`identity-${label}`).toString("hex").padEnd(64, "0").slice(0, 64),
        workspaceIncarnation: Buffer.from(`incarnation-${label}`).toString("hex").padEnd(64, "0").slice(0, 64),
        storeKey: `equivalence-${label}`,
        ancestorIdentityChain: await ancestorIdentityChain(workspaceRoot),
    };
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: join(root, "data"),
        identity,
        git: new WorkspaceGitRunner(),
        processOwner: {
            pid: process.pid,
            processStartToken: `equivalence-${label}`,
            nonce: "9".repeat(64),
        },
    });
    const feed = new DeterministicChangeFeed();
    const tracker = new WorkspaceSnapshotTracker({
        store,
        feed,
        state: {
            load: async () => ({ status: "untrusted" }),
            publish: async () => undefined,
        },
        ...(pathCapture ? { makePathCapture: () => pathCapture } : {}),
    });
    return { root, workspaceRoot, store, feed, tracker };
}

function makeInstabilityPathCapture(
    capture: WorkspaceSnapshotTrackerPathCapture["capture"]
): WorkspaceSnapshotTrackerPathCapture {
    return {
        capture,
        consumeCaptured: async (_result, consumer) => await consumer({ kind: "incremental-captured-batch" }),
        discardCaptured: async () => undefined,
        dispose: async () => undefined,
    };
}

async function expectEquivalent(
    store: WorkspaceSnapshotStore,
    incremental: WorkspaceSnapshotRefV1,
    full: WorkspaceSnapshotRefV1,
    observedPaths: ReadonlySet<string>,
    context = "initial boundary"
): Promise<void> {
    const paths = [...observedPaths].sort(comparePaths);
    expect(await materializeStates(store, incremental, paths), context).toEqual(
        await materializeStates(store, full, paths)
    );
}

async function materializeStates(
    store: WorkspaceSnapshotStore,
    snapshot: WorkspaceSnapshotRefV1,
    paths: readonly string[]
): Promise<Array<{ path: string; state: CapturedPathStateV1 }>> {
    return await Promise.all(paths.map(async (path) => ({ path, state: await store.readPathState(snapshot, path) })));
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

function comparePaths(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function semanticCoverage(coverage: WorkspaceSnapshotCoverage): Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes"> {
    return {
        complete: coverage.complete,
        eligibleEntryCount: coverage.eligibleEntryCount,
        exclusions: coverage.exclusions,
    };
}
