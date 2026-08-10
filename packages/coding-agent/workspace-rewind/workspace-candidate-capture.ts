// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { WorkspaceGitRunner, WorkspaceGitRunnerError } from "./git-runner";
import { WorkspaceCheckpointInternalLimits } from "./internal-limits";
import type { CapturedPathStateV1 } from "./types";
import { verifyCanonicalWorkspaceIdentity, type CanonicalWorkspaceIdentity } from "./workspace-identity";
import {
    StablePathReaderError,
    runStablePathReaderBatch,
    type StablePathReaderBatchEntry,
    type StablePathReaderBatchHooks,
    type StablePathReaderEntryIdentity,
} from "./workspace-path-reader";
import {
    classifyIncrementalWorkspacePaths,
    type IncrementalWorkspaceScopeEntry,
    type WorkspaceScopeEntryIdentity,
    type WorkspaceScopeManifest,
} from "./workspace-scope";

export interface WorkspaceCandidatePathEntry {
    path: string;
    state: CapturedPathStateV1;
}

export type WorkspaceCandidateCaptureResult =
    | { status: "captured"; entries: WorkspaceCandidatePathEntry[]; newlyHashedBytes: number }
    | { status: "reconcile"; reason: "scope-invalidated" | "unstable-path" | "unsafe-evidence" };

export interface WorkspaceCandidateCaptureOptions {
    identity: CanonicalWorkspaceIdentity;
    git: WorkspaceGitRunner;
    storeRoot: string;
    scope: WorkspaceScopeManifest;
    maxEntries: number;
    maxUntrackedBytes: number;
    maxNewlyHashedBytes: number;
    timeoutMs: number;
    base: BasePathKindReader;
    hooks?: WorkspaceCandidateCaptureHooks;
}

export interface WorkspaceCandidateCaptureHooks extends StablePathReaderBatchHooks {
    scopeEnumerated?(entryCount: number): void;
}

export interface BasePathKindReader {
    readNodeKind(path: string, signal?: AbortSignal): Promise<"absent" | "leaf" | "tree">;
    readNodeKinds?(
        paths: readonly string[],
        signal?: AbortSignal
    ): Promise<ReadonlyMap<string, "absent" | "leaf" | "tree">>;
}

export interface WorkspaceCandidateBatch {
    readonly kind: "workspace-candidate-batch";
}

interface WorkspaceCandidateBatchRecord {
    storeRoot: string;
    entries: ReadonlyArray<WorkspaceCandidatePathEntry>;
    newlyHashedBytes: number;
    stagingRoot?: string;
    stagingRootIdentity?: StablePathReaderEntryIdentity;
    files: Array<{
        path: string;
        stagingPath: string;
        oid: string;
        identity: StablePathReaderEntryIdentity;
    }>;
}

const CapturedBatchRecords = new WeakMap<WorkspaceCandidateBatch, WorkspaceCandidateBatchRecord>();

export class WorkspaceCandidateCapture {
    readonly identity: CanonicalWorkspaceIdentity;
    readonly git: WorkspaceGitRunner;
    readonly storeRoot: string;
    readonly scope: WorkspaceScopeManifest;
    readonly maxEntries: number;
    readonly maxUntrackedBytes: number;
    readonly maxNewlyHashedBytes: number;
    readonly timeoutMs: number;
    readonly base: BasePathKindReader;
    readonly hooks?: WorkspaceCandidateCaptureHooks;
    pendingCaptures = new WeakMap<object, WorkspaceCandidateBatch>();
    readonly pendingBatches = new Set<WorkspaceCandidateBatch>();
    readonly pendingResults = new Map<WorkspaceCandidateBatch, object>();
    readonly consumedBatches = new Set<WorkspaceCandidateBatch>();
    readonly batchOperations = new Map<WorkspaceCandidateBatch, Promise<void>>();
    readonly stagingRoots = new Set<string>();
    readonly inFlightCaptures = new Set<{ controller: AbortController; promise: Promise<unknown> }>();
    lifecycle: "active" | "disposing" | "disposed" = "active";
    disposePromise?: Promise<void>;

    constructor(input: WorkspaceCandidateCaptureOptions) {
        if (!isAbsolute(input.storeRoot) || basename(input.storeRoot) !== "repo.git") {
            throw new Error("Invalid candidate snapshot store root");
        }
        this.identity = cloneIdentity(input.identity);
        this.git = input.git;
        this.storeRoot = input.storeRoot;
        this.scope = cloneScope(input.scope);
        this.maxEntries = validateNonNegativeLimit(input.maxEntries, "entry");
        this.maxUntrackedBytes = validateNonNegativeLimit(input.maxUntrackedBytes, "untracked byte");
        this.maxNewlyHashedBytes = validateNonNegativeLimit(input.maxNewlyHashedBytes, "hash byte");
        this.timeoutMs = validateNonNegativeLimit(input.timeoutMs, "timeout");
        this.hooks = input.hooks;
        if (!input.base || typeof input.base.readNodeKind !== "function") {
            throw new Error("Workspace candidate capture requires a base path kind reader");
        }
        this.base = Object.freeze({
            readNodeKind: input.base.readNodeKind.bind(input.base),
            ...(input.base.readNodeKinds ? { readNodeKinds: input.base.readNodeKinds.bind(input.base) } : {}),
        });
        if (
            this.scope.schemaVersion !== 1 ||
            this.scope.policy.maxEntries !== this.maxEntries ||
            this.scope.policy.maxUntrackedBytes !== this.maxUntrackedBytes
        ) {
            throw new Error("Workspace candidate capture scope policy does not match its limits");
        }
    }

    capture(
        paths: readonly string[],
        signal?: AbortSignal,
        timeoutMs: number = this.timeoutMs
    ): Promise<WorkspaceCandidateCaptureResult> {
        if (this.lifecycle !== "active") {
            return Promise.reject(new Error("Workspace candidate capture is disposed"));
        }
        const captureTimeoutMs = validateNonNegativeLimit(timeoutMs, "timeout");
        const controller = new AbortController();
        const onAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        const deadline = Date.now() + captureTimeoutMs;
        const deadlineError = new StablePathReaderError("timeout", "Workspace candidate capture timed out");
        const timer = setTimeout(() => controller.abort(deadlineError), captureTimeoutMs);
        const tracked = { controller, promise: Promise.resolve() as Promise<unknown> };
        const promise = this.captureActive([...paths], controller.signal, deadline)
            .catch((error) => {
                if (controller.signal.reason === deadlineError) throw deadlineError;
                throw error;
            })
            .finally(() => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                this.inFlightCaptures.delete(tracked);
            });
        tracked.promise = promise;
        this.inFlightCaptures.add(tracked);
        return promise;
    }

    async captureActive(
        paths: readonly string[],
        signal: AbortSignal,
        deadline: number
    ): Promise<WorkspaceCandidateCaptureResult> {
        assertCaptureDeadline(deadline, signal);
        if (paths.length === 0) {
            await verifyCanonicalWorkspaceIdentity(this.identity);
            assertCaptureDeadline(deadline, signal);
            const result: WorkspaceCandidateCaptureResult = {
                status: "captured",
                entries: [],
                newlyHashedBytes: 0,
            };
            this.registerPendingCapture(result, { storeRoot: this.storeRoot, files: [] });
            return result;
        }
        const ownedPaths = [...paths];
        const scope = await classifyIncrementalWorkspacePaths({
            identity: this.identity,
            git: this.git,
            scope: this.scope,
            paths: ownedPaths,
            maxEntries: this.maxEntries,
            maxUntrackedBytes: this.maxUntrackedBytes,
            signal,
            observer: {
                scopeEnumerated: this.hooks?.scopeEnumerated,
            },
        });
        if (scope.status === "reconcile") return scope;
        try {
            const baseKinds = this.base.readNodeKinds
                ? await this.base.readNodeKinds(
                      scope.pathKinds.map((current) => current.path),
                      signal
                  )
                : await readBaseNodeKinds(this.base, scope.pathKinds, signal);
            for (const current of scope.pathKinds) {
                const base = baseKinds.get(current.path);
                if (!base) return { status: "reconcile", reason: "unsafe-evidence" };
                if ((current.kind === "tree" && base === "leaf") || (current.kind === "leaf" && base === "tree")) {
                    return { status: "reconcile", reason: "unsafe-evidence" };
                }
            }
        } catch (error) {
            if (signal.aborted) throw signal.reason ?? error;
            return { status: "reconcile", reason: "unsafe-evidence" };
        }
        const direct = scope.entries.filter((entry) => entry.kind === "absent" || entry.kind === "excluded");
        const readable = scope.entries.filter(
            (entry): entry is IncrementalWorkspaceScopeEntry & { kind: "file" | "symlink" } =>
                entry.kind === "file" || entry.kind === "symlink"
        );
        if (readable.length === 0) {
            assertCaptureDeadline(deadline, signal);
            await verifyCanonicalWorkspaceIdentity(this.identity);
            assertCaptureDeadline(deadline, signal);
            const result: WorkspaceCandidateCaptureResult = {
                status: "captured",
                entries: normalizeWorkspaceCandidateEntries(direct.map(toDirectEntry)),
                newlyHashedBytes: 0,
            };
            this.registerPendingCapture(result, { storeRoot: this.storeRoot, files: [] });
            return result;
        }
        if (process.platform === "win32") {
            return { status: "reconcile", reason: "unsafe-evidence" };
        }
        const stagingRoot = await mkdtemp(join(tmpdir(), "crest-workspace-candidate-capture-"));
        this.stagingRoots.add(stagingRoot);
        let retained = false;
        try {
            await chmod(stagingRoot, 0o700);
            const requests = readable.map((entry, index) => makeReaderEntry(entry, stagingRoot, index));
            const results = await runStablePathReaderBatch({
                rootPath: this.identity.canonicalRoot,
                entries: requests,
                maxSingleFileBytes: WorkspaceCheckpointInternalLimits.maxSingleFileBytes,
                maxTotalBytes: this.maxNewlyHashedBytes,
                timeoutMs: remainingCaptureMs(deadline, signal),
                signal,
                hooks: this.hooks,
            });
            const newlyHashedBytes = results.reduce((total, result) => total + result.hashedBytes, 0);
            if (newlyHashedBytes > this.maxNewlyHashedBytes) {
                return { status: "reconcile", reason: "unsafe-evidence" };
            }
            const staged = results.map((result) => result.stagingPath!);
            const oids = await this.hashStagedPaths(staged, remainingCaptureMs(deadline, signal), signal);
            const sourceByPath = new Map(readable.map((entry) => [entry.path!, entry]));
            const entries = results.map((result, index): WorkspaceCandidatePathEntry => {
                const source = sourceByPath.get(result.path)!;
                return {
                    path: result.path,
                    state:
                        source.kind === "symlink"
                            ? { state: "symlink", oid: oids[index]! }
                            : {
                                  state: "file",
                                  oid: oids[index]!,
                                  executable: (BigInt(result.identity.mode) & 0o111n) !== 0n,
                              },
                };
            });
            entries.push(...direct.map(toDirectEntry));
            const result: WorkspaceCandidateCaptureResult = {
                status: "captured",
                entries: normalizeWorkspaceCandidateEntries(entries),
                newlyHashedBytes,
            };
            assertCaptureDeadline(deadline, signal);
            await verifyCanonicalWorkspaceIdentity(this.identity);
            assertCaptureDeadline(deadline, signal);
            const rootIdentity = serializeEntryIdentity(await lstat(stagingRoot, { bigint: true }));
            this.registerPendingCapture(result, {
                storeRoot: this.storeRoot,
                stagingRoot,
                stagingRootIdentity: rootIdentity,
                files: await Promise.all(
                    results.map(async (item, index) => ({
                        path: item.path,
                        stagingPath: item.stagingPath!,
                        oid: oids[index]!,
                        identity: serializeEntryIdentity(await lstat(item.stagingPath!, { bigint: true })),
                    }))
                ),
            });
            this.stagingRoots.delete(stagingRoot);
            retained = true;
            return result;
        } catch (error) {
            if (signal.aborted && signal.reason instanceof StablePathReaderError) throw signal.reason;
            if (error instanceof WorkspaceGitRunnerError && error.code === "aborted") throw error;
            if (error instanceof StablePathReaderError && error.code === "aborted") throw error;
            if (error instanceof StablePathReaderError && error.code === "unstable_file") {
                return { status: "reconcile", reason: "unstable-path" };
            }
            return { status: "reconcile", reason: "unsafe-evidence" };
        } finally {
            if (!retained) await this.cleanupStagingRoot(stagingRoot);
        }
    }

    async consumeCaptured<T>(
        result: WorkspaceCandidateCaptureResult,
        consumer: (batch: WorkspaceCandidateBatch) => Promise<T>
    ): Promise<T> {
        const batch = this.getPendingCapture(result);
        if (this.consumedBatches.has(batch)) {
            throw new Error("Workspace candidate capture result was already consumed");
        }
        const release = this.reserveBatchOperation(batch, "consume");
        try {
            this.consumedBatches.add(batch);
            let value: T | undefined;
            let consumerFailure: unknown;
            try {
                value = await consumer(batch);
            } catch (error) {
                consumerFailure = error;
            }
            let cleanupFailure: unknown;
            try {
                await this.cleanupPendingBatch(batch);
            } catch (error) {
                cleanupFailure = error;
            }
            if (consumerFailure && cleanupFailure) {
                throw new AggregateError(
                    [consumerFailure, cleanupFailure],
                    "Workspace candidate capture consumer and cleanup failed"
                );
            }
            if (consumerFailure) throw consumerFailure;
            if (cleanupFailure) throw cleanupFailure;
            return value!;
        } finally {
            release();
        }
    }

    async discardCaptured(result: WorkspaceCandidateCaptureResult): Promise<void> {
        const batch = this.getPendingCapture(result);
        const release = this.reserveBatchOperation(batch, "discard");
        try {
            await this.cleanupPendingBatch(batch);
        } finally {
            release();
        }
    }

    async dispose(): Promise<void> {
        if (this.lifecycle === "disposed") return;
        if (this.disposePromise) return this.disposePromise;
        this.lifecycle = "disposing";
        for (const capture of this.inFlightCaptures) capture.controller.abort(new Error("capture disposed"));
        const operation = this.disposeActive();
        this.disposePromise = operation.finally(() => {
            this.disposePromise = undefined;
        });
        return this.disposePromise;
    }

    async disposeActive(): Promise<void> {
        await Promise.allSettled([...this.inFlightCaptures].map((capture) => capture.promise));
        await Promise.allSettled([...this.batchOperations.values()]);
        const batches = [...this.pendingBatches];
        const roots = [...this.stagingRoots];
        const results = await Promise.allSettled([
            ...batches.map((batch) => this.cleanupPendingBatch(batch)),
            ...roots.map((root) => this.cleanupStagingRoot(root)),
        ]);
        const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
        if (failures.length > 0) {
            throw new AggregateError(failures, "Failed to dispose workspace candidate capture staging");
        }
        this.lifecycle = "disposed";
    }

    registerPendingCapture(
        result: WorkspaceCandidateCaptureResult,
        record: Omit<WorkspaceCandidateBatchRecord, "entries" | "newlyHashedBytes">
    ): void {
        if (this.lifecycle !== "active") throw new Error("Workspace candidate capture is disposed");
        if (result.status !== "captured") throw new Error("Cannot register a non-captured incremental batch");
        const entries = freezeEntries(result.entries);
        const batch = Object.freeze(
            Object.defineProperty({}, "kind", {
                value: "workspace-candidate-batch",
                enumerable: false,
            }) as WorkspaceCandidateBatch
        );
        CapturedBatchRecords.set(batch, {
            ...record,
            entries,
            newlyHashedBytes: result.newlyHashedBytes,
        });
        this.pendingCaptures.set(result, batch);
        this.pendingBatches.add(batch);
        this.pendingResults.set(batch, result);
    }

    getPendingCapture(result: WorkspaceCandidateCaptureResult): WorkspaceCandidateBatch {
        const batch = this.pendingCaptures.get(result);
        if (!batch)
            throw new Error("Workspace candidate capture result is not pending or was already consumed or discarded");
        return batch;
    }

    reserveBatchOperation(batch: WorkspaceCandidateBatch, kind: "consume" | "discard"): () => void {
        if (this.batchOperations.has(batch)) {
            throw new Error("Workspace candidate capture batch operation is already active");
        }
        const retryingFailedDisposeCleanup =
            kind === "discard" && this.lifecycle === "disposing" && this.disposePromise == null;
        if (this.lifecycle !== "active" && !retryingFailedDisposeCleanup) {
            throw new Error("Workspace candidate capture is disposed");
        }
        let settle!: () => void;
        const settled = new Promise<void>((resolve) => {
            settle = resolve;
        });
        this.batchOperations.set(batch, settled);
        return () => {
            if (this.batchOperations.get(batch) !== settled) {
                throw new Error("Workspace candidate capture batch operation ownership changed");
            }
            this.batchOperations.delete(batch);
            settle();
        };
    }

    async cleanupPendingBatch(batch: WorkspaceCandidateBatch): Promise<void> {
        const result = this.pendingResults.get(batch);
        if (!result || !this.pendingBatches.has(batch)) {
            throw new Error("Workspace candidate capture result is not pending or was already consumed or discarded");
        }
        await cleanupCapturedBatch(batch);
        this.pendingCaptures.delete(result);
        this.pendingBatches.delete(batch);
        this.pendingResults.delete(batch);
        this.consumedBatches.delete(batch);
    }

    async cleanupStagingRoot(root: string): Promise<void> {
        if (!this.stagingRoots.has(root)) return;
        await rm(root, { recursive: true, force: true });
        this.stagingRoots.delete(root);
    }

    async hashStagedPaths(paths: string[], timeoutMs: number, signal?: AbortSignal): Promise<string[]> {
        if (paths.length === 0) return [];
        if (paths.some((path) => path.includes("\n") || path.includes("\0"))) {
            throw new Error("Invalid incremental staging path");
        }
        const result = await this.git.run(["hash-object", "--stdin-paths", "--no-filters"], {
            gitDir: this.storeRoot,
            stdin: Buffer.from(`${paths.join("\n")}\n`),
            timeoutMs,
            signal,
        });
        const oids = result.stdout.toString("ascii").trimEnd().split("\n");
        if (oids.length !== paths.length || oids.some((oid) => !/^[0-9a-f]{40}$/.test(oid))) {
            throw new Error("Git returned invalid incremental blob ids");
        }
        return oids;
    }
}

async function readBaseNodeKinds(
    base: BasePathKindReader,
    paths: readonly { path: string }[],
    signal: AbortSignal
): Promise<ReadonlyMap<string, "absent" | "leaf" | "tree">> {
    const kinds = new Map<string, "absent" | "leaf" | "tree">();
    for (const { path } of paths) kinds.set(path, await base.readNodeKind(path, signal));
    return kinds;
}

function remainingCaptureMs(deadline: number, signal: AbortSignal): number {
    assertCaptureDeadline(deadline, signal);
    return Math.max(1, deadline - Date.now());
}

function assertCaptureDeadline(deadline: number, signal: AbortSignal): void {
    if (signal.aborted)
        throw signal.reason ?? new StablePathReaderError("aborted", "Workspace candidate capture aborted");
    if (Date.now() >= deadline) throw new StablePathReaderError("timeout", "Workspace candidate capture timed out");
}

async function cleanupCapturedBatch(batch: WorkspaceCandidateBatch): Promise<void> {
    const record = CapturedBatchRecords.get(batch);
    if (!record) throw new Error("Invalid workspace candidate batch");
    if (record.stagingRoot) await rm(record.stagingRoot, { recursive: true, force: true });
    CapturedBatchRecords.delete(batch);
}

export async function materializeWorkspaceCandidateBatch(
    batch: WorkspaceCandidateBatch,
    input: { storeRoot: string; writeBlob: (bytes: Buffer) => Promise<string> }
): Promise<void> {
    const record = CapturedBatchRecords.get(batch);
    if (!record || record.storeRoot !== input.storeRoot) {
        throw new Error("Invalid workspace candidate batch");
    }
    if (!record.stagingRoot) {
        if (record.files.length !== 0) throw new Error("Invalid workspace candidate batch");
        return;
    }
    const rootBefore = await lstat(record.stagingRoot, { bigint: true });
    if (!rootBefore.isDirectory() || !sameSerializedIdentity(rootBefore, record.stagingRootIdentity!)) {
        throw new Error("Workspace candidate capture staging root changed before commit");
    }
    for (const file of record.files) {
        if (
            dirname(file.stagingPath) !== record.stagingRoot ||
            !/^[0-9]+-[0-9a-f]{24}$/.test(basename(file.stagingPath))
        ) {
            throw new Error("Invalid workspace candidate capture staging path");
        }
        const before = await lstat(file.stagingPath, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || !sameSerializedIdentity(before, file.identity)) {
            throw new Error("Workspace candidate capture staging file changed before commit");
        }
        const handle = await open(file.stagingPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let bytes: Buffer;
        try {
            const opened = await handle.stat({ bigint: true });
            if (!opened.isFile() || opened.nlink !== 1n || !sameSerializedIdentity(opened, file.identity)) {
                throw new Error("Workspace candidate capture staging file changed before commit");
            }
            bytes = await handle.readFile();
            const openedAfter = await handle.stat({ bigint: true });
            if (!sameSerializedIdentity(openedAfter, file.identity)) {
                throw new Error("Workspace candidate capture staging file changed during commit");
            }
        } finally {
            await handle.close();
        }
        if (!sameSerializedIdentity(await lstat(file.stagingPath, { bigint: true }), file.identity)) {
            throw new Error("Workspace candidate capture staging file changed during commit");
        }
        const oid = createHash("sha1")
            .update(Buffer.from(`blob ${bytes.length}\0`))
            .update(bytes)
            .digest("hex");
        if (oid !== file.oid) throw new Error("Workspace candidate capture staged bytes do not match their object id");
        if ((await input.writeBlob(bytes)) !== file.oid) {
            throw new Error("Private snapshot store returned a different object id");
        }
    }
    if (!sameSerializedIdentity(await lstat(record.stagingRoot, { bigint: true }), record.stagingRootIdentity!)) {
        throw new Error("Workspace candidate capture staging root changed during commit");
    }
}

export function readWorkspaceCandidateBatchSemantics(
    batch: WorkspaceCandidateBatch,
    storeRoot: string
): { entries: WorkspaceCandidatePathEntry[]; newlyHashedBytes: number } {
    const record = CapturedBatchRecords.get(batch);
    if (!record || record.storeRoot !== storeRoot) {
        throw new Error("Invalid workspace candidate batch");
    }
    const staged = record.files
        .map((file) => ({ path: file.path, oid: file.oid }))
        .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    const semantic = record.entries
        .filter((entry) => entry.state.state === "file" || entry.state.state === "symlink")
        .map((entry) => ({ path: entry.path, oid: "oid" in entry.state ? entry.state.oid : "" }));
    if (JSON.stringify(staged) !== JSON.stringify(semantic)) {
        throw new Error("Workspace candidate batch staging does not match its semantics");
    }
    return {
        entries: normalizeWorkspaceCandidateEntries(record.entries.map(cloneEntry)),
        newlyHashedBytes: record.newlyHashedBytes,
    };
}

function freezeEntries(entries: WorkspaceCandidatePathEntry[]): ReadonlyArray<WorkspaceCandidatePathEntry> {
    return Object.freeze(
        normalizeWorkspaceCandidateEntries(entries).map((entry) =>
            Object.freeze({ path: entry.path, state: Object.freeze({ ...entry.state }) })
        )
    );
}

function cloneEntry(entry: WorkspaceCandidatePathEntry): WorkspaceCandidatePathEntry {
    return { path: entry.path, state: { ...entry.state } };
}

function sameSerializedIdentity(value: BigIntStats, expected: StablePathReaderEntryIdentity): boolean {
    return (
        value.dev.toString() === expected.dev &&
        value.ino.toString() === expected.ino &&
        value.birthtimeNs.toString() === expected.birthtimeNs &&
        value.mode.toString() === expected.mode &&
        value.nlink.toString() === expected.nlink &&
        value.size.toString() === expected.size &&
        value.mtimeNs.toString() === expected.mtimeNs &&
        value.ctimeNs.toString() === expected.ctimeNs
    );
}

function makeReaderEntry(
    entry: IncrementalWorkspaceScopeEntry & { kind: "file" | "symlink" },
    stagingRoot: string,
    index: number
): StablePathReaderBatchEntry {
    if (!entry.parentIdentity || !entry.entryIdentity || !entry.path) {
        throw new Error("Incremental path identity evidence is missing");
    }
    return {
        path: entry.path,
        name: basename(entry.path),
        kind: entry.kind,
        parentIdentity: {
            dev: entry.parentIdentity.dev.toString(),
            ino: entry.parentIdentity.ino.toString(),
            birthtimeNs: entry.parentIdentity.birthtimeNs.toString(),
        },
        identity: serializeEntryIdentity(entry.entryIdentity),
        stagingPath: join(stagingRoot, `${index}-${randomBytes(12).toString("hex")}`),
    };
}

function serializeEntryIdentity(value: WorkspaceScopeEntryIdentity): StablePathReaderEntryIdentity {
    return {
        dev: value.dev.toString(),
        ino: value.ino.toString(),
        birthtimeNs: value.birthtimeNs.toString(),
        mode: value.mode.toString(),
        nlink: value.nlink.toString(),
        size: value.size.toString(),
        mtimeNs: value.mtimeNs.toString(),
        ctimeNs: value.ctimeNs.toString(),
    };
}

function toDirectEntry(entry: IncrementalWorkspaceScopeEntry): WorkspaceCandidatePathEntry {
    let state: CapturedPathStateV1;
    if (entry.kind === "absent") state = { state: "absent" };
    else if (entry.kind === "excluded") state = { state: "excluded", reason: entry.exclusionReason! };
    else throw new Error("Incremental direct entry is readable");
    return { path: entry.path!, state };
}

function cloneIdentity(identity: CanonicalWorkspaceIdentity): CanonicalWorkspaceIdentity {
    return Object.freeze({
        ...identity,
        ancestorIdentityChain: Object.freeze(
            identity.ancestorIdentityChain.map((entry) => Object.freeze({ ...entry }))
        ),
    });
}

function cloneScope(scope: WorkspaceScopeManifest): WorkspaceScopeManifest {
    const value = structuredClone(scope);
    Object.freeze(value.policy);
    value.ignoreInputs.forEach(Object.freeze);
    value.nestedRepositoryBoundaries.forEach(Object.freeze);
    if (value.gitIndex) {
        Object.freeze(value.gitIndex.parentIdentity);
        if (value.gitIndex.entryIdentity) Object.freeze(value.gitIndex.entryIdentity);
        Object.freeze(value.gitIndex);
    }
    Object.freeze(value.ignoreInputs);
    Object.freeze(value.nestedRepositoryBoundaries);
    return Object.freeze(value);
}

function validateNonNegativeLimit(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid incremental ${label} limit`);
    return value;
}

export function normalizeWorkspaceCandidateEntries(
    entries: readonly WorkspaceCandidatePathEntry[]
): WorkspaceCandidatePathEntry[] {
    const byPath = new Map<string, WorkspaceCandidatePathEntry>();
    for (const entry of entries) {
        if (typeof entry.path !== "string" || entry.path.length === 0) {
            throw new Error("Invalid workspace candidate path");
        }
        byPath.set(entry.path, { path: entry.path, state: { ...entry.state } });
    }
    return [...byPath.values()].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}
