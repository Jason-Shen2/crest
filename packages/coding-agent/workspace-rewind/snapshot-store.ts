// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
    link,
    lstat,
    mkdir,
    mkdtemp,
    open,
    readdir,
    readFile,
    rename,
    rm,
    statfs,
    unlink,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import {
    AnchoredReaderError,
    runAnchoredReader,
    type AnchoredReaderEntry,
    type AnchoredReaderEntryIdentity,
} from "./anchored-reader";
import { encodeDurableJson, ensureDurableGitObjects } from "./durability";
import { WorkspaceGitRunner, WorkspaceGitRunnerError } from "./git-runner";
import {
    materializeIncrementalCapturedBatch,
    readIncrementalCapturedBatchSemantics,
    type IncrementalCapturedBatch,
} from "./incremental-path-capture";
import {
    applyIncrementalTrees,
    normalizeIncrementalMutations,
    type IncrementalPathMutation,
    type IncrementalTreeEntry,
    type IncrementalTreeObjectAccess,
} from "./incremental-tree";
import { WorkspaceCheckpointInternalLimits } from "./internal-limits";
import { decodePendingWorkspaceBoundaryV1, type PendingWorkspaceBoundaryV1 } from "./pending-boundary-store";
import { readProcessStartToken, type ProcessOwnerIdentity } from "./process-owner";
import {
    encodeCanonicalStoredJson as canonicalJson,
    StoredManifestBlobBatchSize,
    StoredManifestReader,
    validateWorkspaceRelativePath as validateRelativePath,
    type StoredManifestObjectReader,
    type StoredScopeManifestV1,
    type StoredScopeManifestV2,
} from "./stored-manifest";
import type {
    CapturedPathStateV1,
    WorkspacePathChangeV1,
    WorkspaceSnapshotCoverage,
    WorkspaceSnapshotRefV1,
} from "./types";
import { verifyCanonicalWorkspaceIdentity, type CanonicalWorkspaceIdentity } from "./workspace-identity";
import { WorkspaceMutationLock } from "./workspace-lock";
import {
    discoverWorkspaceScope,
    verifyWorkspaceScopeDirectories,
    type WorkspaceScope,
    type WorkspaceScopeDirectoryIdentity,
    type WorkspaceScopeEntry,
    type WorkspaceScopeEntryIdentity,
    type WorkspaceScopeManifest,
} from "./workspace-scope";

export const WorkspaceCheckpointLimits = Object.freeze({
    preTurnTimeoutMs: 5_000,
    terminalTimeoutMs: 30_000,
    maxEntries: 200_000,
    maxNewlyHashedBytes: 1024 ** 3,
    maxUntrackedFileBytes: 2 * 1024 ** 2,
    softQuotaBytes: 5 * 1024 ** 3,
    minimumFreeBytes: 1024 ** 3,
    minimumFreeRatio: 0.05,
} as const);

const QuotaMaxRefCount = 200_000;
const QuotaMaxObjectCount = 1_000_000;
const QuotaMaxRefOutputBytes = 16 * 1024 ** 2;
const QuotaMaxObjectOutputBytes = 64 * 1024 ** 2;
const StoredPathStateMaxBytes = 4 * 1024;
const StoredPathStateBatchOutputBytes = StoredManifestBlobBatchSize * (StoredPathStateMaxBytes + 128);

export interface CaptureWorkspaceOptions {
    profile: "pre-turn" | "terminal" | "safety";
    requiredPaths?: readonly string[];
    signal?: AbortSignal;
}

export interface WorkspaceSnapshotQuotaStatus {
    status: "ok" | "soft-quota-exceeded" | "referenced-over-quota";
    usedBytes: number;
    referencedBytes: number;
    softQuotaBytes: number;
}

export class WorkspaceSnapshotStoreError extends Error {
    readonly code:
        | "capture_timeout"
        | "capture_budget"
        | "unstable_file"
        | "enospc"
        | "quota_exceeded"
        | "corrupt_snapshot";
    readonly quotaStatus?: WorkspaceSnapshotQuotaStatus;

    constructor(
        code: WorkspaceSnapshotStoreError["code"],
        message: string,
        options?: { cause?: unknown; quotaStatus?: WorkspaceSnapshotQuotaStatus }
    ) {
        super(message, options?.cause == null ? undefined : { cause: options.cause });
        this.name = "WorkspaceSnapshotStoreError";
        this.code = code;
        this.quotaStatus = options?.quotaStatus;
    }
}

interface FileFingerprint {
    dev: bigint;
    ino: bigint;
    birthtimeNs: bigint;
    size: bigint;
    mode: bigint;
    nlink: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    oid: string;
}

interface CapturedEntry {
    path: string;
    pathBytes: Buffer;
    state: CapturedPathStateV1;
}

interface CapturedWorkspaceEntries {
    entries: CapturedEntry[];
    fingerprints: Map<string, FileFingerprint>;
    newlyHashedBytes: number;
}

interface TreeLeaf {
    mode: "100644" | "100755" | "120000";
    oid: string;
}

interface TreeNode {
    children: Map<string, TreeNode | TreeLeaf>;
}

interface BootstrapOwnerRecord {
    pid: number;
    processstarttoken: string;
    nonce: string;
}

interface CaptureRuntime {
    deadline: number;
    signal: AbortSignal;
    objectIds: Set<string>;
}

const StoreGitTimeoutMs = 30_000;
const BootstrapWaitTimeoutMs = 10_000;
const InitializationPromises = new Map<string, Promise<void>>();
const SnapshotFingerprints = new WeakMap<WorkspaceSnapshotStore, Map<string, FileFingerprint>>();
const TrustedSnapshotDescriptors = new WeakMap<WorkspaceSnapshotStore, Set<string>>();
export async function initializePrivateStore(input: {
    storeRoot: string;
    git: WorkspaceGitRunner;
    processOwner: ProcessOwnerIdentity;
}): Promise<void> {
    assertPrivateStorePlatform();
    if (
        !isAbsolute(input.storeRoot) ||
        basename(input.storeRoot) !== "repo.git" ||
        dirname(input.storeRoot) === input.storeRoot
    ) {
        throw new Error("Snapshot store root must be absolute");
    }
    validateProcessOwner(input.processOwner);
    const existing = InitializationPromises.get(input.storeRoot);
    if (existing) {
        return existing;
    }
    const initializing = initializePrivateStoreImpl(input).finally(() => {
        InitializationPromises.delete(input.storeRoot);
    });
    InitializationPromises.set(input.storeRoot, initializing);
    return initializing;
}

export class WorkspaceSnapshotStore {
    readonly storeRoot: string;
    readonly identity: CanonicalWorkspaceIdentity;
    readonly git: WorkspaceGitRunner;
    readonly processOwner: ProcessOwnerIdentity;
    readonly mutationLock: WorkspaceMutationLock;

    private constructor(input: {
        storeRoot: string;
        identity: CanonicalWorkspaceIdentity;
        git: WorkspaceGitRunner;
        processOwner: ProcessOwnerIdentity;
    }) {
        this.storeRoot = input.storeRoot;
        this.identity = input.identity;
        this.git = input.git;
        this.processOwner = input.processOwner;
        this.mutationLock = new WorkspaceMutationLock({
            workspaceRoot: dirname(input.storeRoot),
            workspaceIdentity: input.identity.workspaceIdentity,
            workspaceIncarnation: input.identity.workspaceIncarnation,
            processOwner: input.processOwner,
        });
        SnapshotFingerprints.set(this, new Map());
        TrustedSnapshotDescriptors.set(this, new Set());
    }

    static async open(input: {
        dataRoot: string;
        identity: CanonicalWorkspaceIdentity;
        git: WorkspaceGitRunner;
        processOwner: ProcessOwnerIdentity;
    }): Promise<WorkspaceSnapshotStore> {
        if (
            !isAbsolute(input.dataRoot) ||
            !/^[A-Za-z0-9-]+$/.test(input.identity.storeKey) ||
            !/^[0-9a-f]{64}$/.test(input.identity.workspaceIdentity) ||
            !/^[0-9a-f]{64}$/.test(input.identity.workspaceIncarnation)
        ) {
            throw new Error("Invalid snapshot store location");
        }
        validateProcessOwner(input.processOwner);
        const checkpointsRoot = join(input.dataRoot, "agent-checkpoints");
        const workspacesRoot = join(checkpointsRoot, "workspaces");
        const workspaceRoot = join(workspacesRoot, input.identity.storeKey);
        await makePrivateDirectory(checkpointsRoot);
        await makePrivateDirectory(workspacesRoot);
        await makePrivateDirectory(workspaceRoot);
        const storeRoot = join(workspaceRoot, "repo.git");
        await initializePrivateStore({
            storeRoot,
            git: input.git,
            processOwner: input.processOwner,
        });
        await quarantineLegacyRestoreJournals(storeRoot);
        return new WorkspaceSnapshotStore({ ...input, storeRoot });
    }

    capture(options: CaptureWorkspaceOptions): Promise<{
        ref: WorkspaceSnapshotRefV1;
        coverage: WorkspaceSnapshotCoverage;
    }> {
        return this.withWorkspaceLock(() => this.#captureUnlocked(options));
    }

    async commitIncrementalSnapshot(input: {
        base: WorkspaceSnapshotRefV1;
        mutations: IncrementalPathMutation[];
        scope: WorkspaceScopeManifest;
        coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
        newlyHashedBytes: number;
        profile: CaptureWorkspaceOptions["profile"];
    }): Promise<{ ref: WorkspaceSnapshotRefV1; coverage: WorkspaceSnapshotCoverage }> {
        const ownedInput = cloneIncrementalCommitInput(input);
        return this.withWorkspaceLock(() => this.#commitIncrementalSnapshot(ownedInput));
    }

    async commitCapturedIncrementalSnapshot(input: {
        base: WorkspaceSnapshotRefV1;
        mutations: IncrementalPathMutation[];
        scope: WorkspaceScopeManifest;
        coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
        newlyHashedBytes: number;
        profile: CaptureWorkspaceOptions["profile"];
        batch: IncrementalCapturedBatch;
    }): Promise<{ ref: WorkspaceSnapshotRefV1; coverage: WorkspaceSnapshotCoverage }> {
        const batch = input.batch;
        const ownedInput = cloneIncrementalCommitInput(input);
        return this.withWorkspaceLock(() => {
            const semantics = readIncrementalCapturedBatchSemantics(batch, this.storeRoot);
            if (
                ownedInput.newlyHashedBytes !== semantics.newlyHashedBytes ||
                JSON.stringify(ownedInput.mutations) !== JSON.stringify(semantics.mutations)
            ) {
                throw new Error("Incremental captured batch semantics do not match commit input");
            }
            return this.#commitIncrementalSnapshot(
                { ...ownedInput, mutations: semantics.mutations, newlyHashedBytes: semantics.newlyHashedBytes },
                (runtime) =>
                    materializeIncrementalCapturedBatch(batch, {
                        storeRoot: this.storeRoot,
                        writeBlob: (bytes) => this.writeBlob(bytes, runtime),
                    })
            );
        });
    }

    withWorkspaceLock<T>(operation: () => Promise<T>): Promise<T> {
        return this.mutationLock.runExclusive(operation);
    }

    async #captureUnlocked(options: CaptureWorkspaceOptions): Promise<{
        ref: WorkspaceSnapshotRefV1;
        coverage: WorkspaceSnapshotCoverage;
    }> {
        validateCaptureOptions(options);
        const timeoutMs =
            options.profile === "pre-turn"
                ? WorkspaceCheckpointLimits.preTurnTimeoutMs
                : WorkspaceCheckpointLimits.terminalTimeoutMs;
        const deadline = Date.now() + timeoutMs;
        const controller = new AbortController();
        const onAbort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) {
            onAbort();
        }
        const timer = setTimeout(() => controller.abort(new Error("capture deadline exceeded")), timeoutMs);
        const runtime: CaptureRuntime = {
            deadline,
            signal: controller.signal,
            objectIds: new Set(),
        };
        try {
            assertCaptureActive(deadline, controller.signal);
            await raceWithAbort(verifyCanonicalWorkspaceIdentity(this.identity), controller.signal);
            await assertNoShadowMutationFiles(this.storeRoot, runtime);
            const quotaStatus = await this.getQuotaStatus(runtime);
            if (quotaStatus.status !== "ok") {
                throw new WorkspaceSnapshotStoreError("quota_exceeded", "Workspace checkpoint quota exceeded", {
                    quotaStatus,
                });
            }
            await assertFreeSpace(this.storeRoot, runtime);
            let scope: WorkspaceScope | undefined;
            let captured: CapturedWorkspaceEntries | undefined;
            let newlyHashedBytes = 0;
            for (let attempt = 0; attempt < 2; attempt++) {
                scope = await raceWithAbort(
                    discoverWorkspaceScope({
                        identity: this.identity,
                        git: this.git,
                        maxEntries: WorkspaceCheckpointLimits.maxEntries,
                        maxUntrackedBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
                        signal: controller.signal,
                    }),
                    controller.signal
                );
                assertCaptureActive(deadline, controller.signal);
                await includeRequiredPaths(scope, options.requiredPaths ?? [], this.identity.canonicalRoot);
                assertCaptureActive(deadline, controller.signal);
                const remainingByteBudget = WorkspaceCheckpointLimits.maxNewlyHashedBytes - newlyHashedBytes;
                captured = await this.captureEntries(scope, remainingByteBudget, runtime);
                if (captured.newlyHashedBytes > remainingByteBudget) {
                    throw new WorkspaceSnapshotStoreError(
                        "capture_budget",
                        "Workspace newly-hashed byte budget exceeded"
                    );
                }
                newlyHashedBytes += captured.newlyHashedBytes;
                if (await verifyWorkspaceScopeDirectories(scope, controller.signal)) {
                    break;
                }
                scope = undefined;
                captured = undefined;
            }
            if (!scope || !captured) {
                throw new WorkspaceSnapshotStoreError(
                    "unstable_file",
                    "Workspace directory names changed during both capture attempts"
                );
            }
            const workspaceTree = await this.writeWorkspaceTree(captured.entries, runtime);
            const storedManifest: StoredScopeManifestV1 = {
                schemaversion: 1,
                workspaceidentity: this.identity.workspaceIdentity,
                workspaceincarnation: this.identity.workspaceIncarnation,
                scope: scope.manifest,
                entries: captured.entries.map((entry) => ({ path: entry.path, state: entry.state })),
            };
            const manifestOid = await this.writeBlob(canonicalJson(storedManifest), runtime);
            const descriptorOid = await this.writeDescriptor(workspaceTree, manifestOid, runtime);
            const ref: WorkspaceSnapshotRefV1 = {
                id: descriptorOid,
                workspaceIdentity: this.identity.workspaceIdentity,
                workspaceIncarnation: this.identity.workspaceIncarnation,
                tree: workspaceTree,
                scopeManifest: manifestOid,
            };
            await raceWithAbort(verifyCanonicalWorkspaceIdentity(this.identity), controller.signal);
            await this.ensureObjectsDurable([...runtime.objectIds], runtime);
            await this.anchorSnapshot(ref, runtime);
            const ownerRef = this.ownerRefName(descriptorOid);
            try {
                await secureCaptureArtifacts(this.storeRoot, runtime.objectIds, ownerRef, runtime);
            } catch (error) {
                await secureCaptureArtifacts(this.storeRoot, runtime.objectIds, ownerRef);
                throw error;
            }
            await raceWithAbort(verifyCanonicalWorkspaceIdentity(this.identity), controller.signal);
            SnapshotFingerprints.set(this, captured.fingerprints);
            markSnapshotTrusted(this, ref);
            return {
                ref,
                coverage: {
                    ...scope.coverage,
                    newlyHashedBytes,
                },
            };
        } catch (error) {
            if (controller.signal.aborted && !options.signal?.aborted) {
                throw new WorkspaceSnapshotStoreError("capture_timeout", "Workspace snapshot capture timed out", {
                    cause: error,
                });
            }
            if (error instanceof WorkspaceGitRunnerError && error.code === "timeout") {
                throw new WorkspaceSnapshotStoreError("capture_timeout", "Workspace snapshot capture timed out", {
                    cause: error,
                });
            }
            throw error;
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
        }
    }

    async #commitIncrementalSnapshot(
        input: {
            base: WorkspaceSnapshotRefV1;
            mutations: IncrementalPathMutation[];
            scope: WorkspaceScopeManifest;
            coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
            newlyHashedBytes: number;
            profile: CaptureWorkspaceOptions["profile"];
        },
        materialize?: (runtime: CaptureRuntime) => Promise<void>
    ): Promise<{
        ref: WorkspaceSnapshotRefV1;
        coverage: WorkspaceSnapshotCoverage;
    }> {
        const timeoutMs =
            input.profile === "pre-turn"
                ? WorkspaceCheckpointLimits.preTurnTimeoutMs
                : WorkspaceCheckpointLimits.terminalTimeoutMs;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("incremental commit deadline exceeded")), timeoutMs);
        const runtime: CaptureRuntime = {
            deadline: Date.now() + timeoutMs,
            signal: controller.signal,
            objectIds: new Set(),
        };
        try {
            await raceWithAbort(verifyCanonicalWorkspaceIdentity(this.identity), controller.signal);
            assertCaptureActive(runtime.deadline, runtime.signal);
            await assertNoShadowMutationFiles(this.storeRoot, runtime);
            this.assertSnapshotIdentity(input.base);
            await this.verifyUntrustedSnapshot(input.base);
            await this.#assertSnapshotOwnerRef(input.base);
            const baseManifest = await this.#readStoredManifest(input.base);
            if (baseManifest.manifest.schemaversion !== 2) {
                throw new Error("Incremental snapshot commit requires a v2 base snapshot");
            }
            if (!canonicalJson(input.scope).equals(canonicalJson(baseManifest.manifest.scope))) {
                throw new Error("Incremental snapshot scope changed; a full capture is required");
            }
            // TODO(snapshot-quota): Task 7 replaces this authoritative scan with durable write reservations.
            const quotaStatus = await this.getQuotaStatusAssumingLock(runtime);
            if (
                quotaStatus.status !== "ok" ||
                input.newlyHashedBytes > WorkspaceCheckpointLimits.softQuotaBytes - quotaStatus.usedBytes
            ) {
                throw new WorkspaceSnapshotStoreError("quota_exceeded", "Workspace checkpoint quota exceeded", {
                    quotaStatus,
                });
            }
            await assertFreeSpace(this.storeRoot, runtime);
            await materialize?.(runtime);
            const trees = await applyIncrementalTrees({
                baseWorkspaceTree: input.base.tree,
                baseStateTree: baseManifest.manifest.statetree,
                mutations: input.mutations,
                objects: this.#incrementalTreeObjects(runtime),
            });
            for (const oid of trees.objectIds) runtime.objectIds.add(oid);
            const resultSnapshot = { ...input.base, tree: trees.workspaceTree };
            const resultManifest = baseManifest.withV2StateTree(resultSnapshot, trees.stateTree);
            const expectedCoverage = deriveIncrementalCoverage(
                baseManifest.getCoverage()!,
                await baseManifest.diff(resultManifest)
            );
            if (!canonicalCoverage(expectedCoverage).equals(canonicalCoverage(input.coverage))) {
                throw new Error("Incremental snapshot coverage does not match the resulting state tree");
            }
            const storedManifest: StoredScopeManifestV2 = {
                schemaversion: 2,
                workspaceidentity: this.identity.workspaceIdentity,
                workspaceincarnation: this.identity.workspaceIncarnation,
                scope: input.scope,
                coverage: {
                    complete: expectedCoverage.complete,
                    eligibleentrycount: expectedCoverage.eligibleEntryCount,
                    exclusions: expectedCoverage.exclusions.map(toStoredCoverageExclusion),
                },
                statetree: trees.stateTree,
            };
            const manifestOid = await this.writeBlob(canonicalJson(storedManifest), runtime);
            const descriptorOid = await this.writeDescriptor(
                trees.workspaceTree,
                manifestOid,
                runtime,
                trees.stateTree
            );
            const ref: WorkspaceSnapshotRefV1 = {
                id: descriptorOid,
                workspaceIdentity: this.identity.workspaceIdentity,
                workspaceIncarnation: this.identity.workspaceIncarnation,
                tree: trees.workspaceTree,
                scopeManifest: manifestOid,
            };
            await StoredManifestReader.open({ snapshot: ref, objects: this.#storedManifestObjects() });
            await raceWithAbort(verifyCanonicalWorkspaceIdentity(this.identity), controller.signal);
            await this.#ensureObjectsDurableUnlocked([...runtime.objectIds], runtime);
            await this.#publishIncrementalOwnerRef(ref, runtime);
            markSnapshotTrusted(this, ref);
            return {
                ref,
                coverage: { ...expectedCoverage, newlyHashedBytes: input.newlyHashedBytes },
            };
        } catch (error) {
            if (error instanceof AggregateError) {
                throw error;
            }
            if (controller.signal.aborted) {
                throw new WorkspaceSnapshotStoreError(
                    "capture_timeout",
                    "Workspace incremental snapshot commit timed out",
                    { cause: error }
                );
            }
            if (error instanceof WorkspaceGitRunnerError && error.code === "timeout") {
                throw new WorkspaceSnapshotStoreError(
                    "capture_timeout",
                    "Workspace incremental snapshot commit timed out",
                    { cause: error }
                );
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    diff(before: WorkspaceSnapshotRefV1, after: WorkspaceSnapshotRefV1): Promise<WorkspacePathChangeV1[]> {
        return this.withWorkspaceLock(() => this.#diffUnlocked(before, after));
    }

    async #diffUnlocked(
        before: WorkspaceSnapshotRefV1,
        after: WorkspaceSnapshotRefV1
    ): Promise<WorkspacePathChangeV1[]> {
        try {
            const beforeManifest = await this.#readStoredManifest(before);
            const afterManifest = await this.#readStoredManifest(after);
            return await beforeManifest.diff(afterManifest);
        } catch (cause) {
            throw asCorruptSnapshot(cause);
        }
    }

    readPathState(snapshot: WorkspaceSnapshotRefV1, path: string): Promise<CapturedPathStateV1> {
        return this.withWorkspaceLock(() => this.#readPathStateUnlocked(snapshot, path));
    }

    async #readPathStateUnlocked(snapshot: WorkspaceSnapshotRefV1, path: string): Promise<CapturedPathStateV1> {
        validateRelativePath(path);
        try {
            const manifest = await this.#readStoredManifest(snapshot);
            return await manifest.readPathState(path);
        } catch (cause) {
            throw asCorruptSnapshot(cause);
        }
    }

    async readNodeKind(
        snapshot: WorkspaceSnapshotRefV1,
        path: string,
        signal?: AbortSignal
    ): Promise<"absent" | "leaf" | "tree"> {
        validateRelativePath(path);
        try {
            if (signal?.aborted) throw signal.reason;
            return await (await this.#readStoredManifest(snapshot, signal)).readNodeKind(path);
        } catch (cause) {
            if (signal?.aborted) throw signal.reason ?? cause;
            throw asCorruptSnapshot(cause);
        }
    }

    readBlob(oid: string): Promise<Buffer> {
        return this.withWorkspaceLock(() => this.#readBlobUnlocked(oid));
    }

    async #readBlobUnlocked(oid: string, signal?: AbortSignal): Promise<Buffer> {
        validateOid(oid);
        const result = await this.git.run(["cat-file", "blob", oid], {
            gitDir: this.storeRoot,
            timeoutMs: StoreGitTimeoutMs,
            signal,
        });
        return result.stdout;
    }

    verify(snapshot: WorkspaceSnapshotRefV1): Promise<void> {
        return this.withWorkspaceLock(() => this.#verifyUnlocked(snapshot));
    }

    verifyOwnedSnapshot(snapshot: WorkspaceSnapshotRefV1): Promise<void> {
        return this.withWorkspaceLock(async () => {
            await this.#verifyUnlocked(snapshot);
            await this.#assertSnapshotOwnerRef(snapshot);
        });
    }

    async #assertSnapshotOwnerRef(snapshot: WorkspaceSnapshotRefV1): Promise<void> {
        const owner = await this.#readExactRef(this.ownerRefName(snapshot.id));
        if (owner !== snapshot.id) {
            throw new Error("Workspace snapshot owner ref is missing or changed");
        }
    }

    measureSnapshotUsage(snapshots: readonly WorkspaceSnapshotRefV1[]): Promise<number> {
        return this.withWorkspaceLock(async () => {
            const roots = [
                ...new Set(
                    snapshots.map((snapshot) => {
                        this.assertSnapshotIdentity(snapshot);
                        return snapshot.id;
                    })
                ),
            ];
            return await this.#objectBytesForRoots(roots, makeMaintenanceRuntime());
        });
    }

    async #verifyUnlocked(snapshot: WorkspaceSnapshotRefV1): Promise<void> {
        try {
            this.assertSnapshotIdentity(snapshot);
            const manifest = await this.#readStoredManifest(snapshot);
            await this.verifyWorkspaceTree(snapshot, manifest);
            markSnapshotTrusted(this, snapshot);
        } catch (cause) {
            throw asCorruptSnapshot(cause);
        }
    }

    async #readSnapshotDescriptor(
        snapshot: WorkspaceSnapshotRefV1,
        signal?: AbortSignal
    ): Promise<Map<string, { mode: string; oid: string }>> {
        const descriptor = await this.git.run(["cat-file", "tree", snapshot.id], {
            gitDir: this.storeRoot,
            timeoutMs: StoreGitTimeoutMs,
            signal,
        });
        const entries = parseRawTreeEntries(descriptor.stdout, snapshot.id.length / 2);
        if (
            (entries.size !== 2 && entries.size !== 3) ||
            entries.get("workspace")?.oid !== snapshot.tree ||
            entries.get("workspace")?.mode !== "40000"
        ) {
            throw new Error("Snapshot descriptor has an invalid workspace tree");
        }
        if (
            entries.get("scope-manifest")?.oid !== snapshot.scopeManifest ||
            entries.get("scope-manifest")?.mode !== "100644"
        ) {
            throw new Error("Snapshot descriptor has an invalid scope manifest");
        }
        if (entries.size === 3 && entries.get("state")?.mode !== "40000") {
            throw new Error("Snapshot descriptor has an invalid state tree");
        }
        return entries;
    }

    anchorSnapshot(ref: WorkspaceSnapshotRefV1, runtime = makeMaintenanceRuntime()): Promise<void> {
        return this.withWorkspaceLock(() => this.#anchorSnapshotUnlocked(ref, runtime));
    }

    async #anchorSnapshotUnlocked(ref: WorkspaceSnapshotRefV1, runtime = makeMaintenanceRuntime()): Promise<void> {
        this.assertSnapshotIdentity(ref);
        await this.ensureObjectsDurable([ref.id, ref.tree, ref.scopeManifest], runtime);
        const refName = this.ownerRefName(ref.id);
        await this.git.run(["update-ref", refName, ref.id], {
            gitDir: this.storeRoot,
            timeoutMs: remainingTimeout(runtime.deadline),
            signal: runtime.signal,
        });
        await secureCaptureArtifacts(this.storeRoot, new Set(), refName, runtime);
    }

    anchorPending(record: PendingWorkspaceBoundaryV1): Promise<void> {
        return this.withWorkspaceLock(() => this.#anchorPendingUnlocked(record));
    }

    async #anchorPendingUnlocked(record: PendingWorkspaceBoundaryV1): Promise<void> {
        if (!decodePendingWorkspaceBoundaryV1(record)) {
            throw new Error("Invalid pending workspace boundary");
        }
        this.assertSnapshotIdentity(record.before);
        if (record.after) {
            this.assertSnapshotIdentity(record.after);
        }
        await this.verifyUntrustedSnapshot(record.before);
        if (record.after) {
            await this.verifyUntrustedSnapshot(record.after);
        }
        await this.anchorSnapshot(record.before);
        if (record.after) {
            await this.anchorSnapshot(record.after);
        }
        const descriptor = await this.git.run(["hash-object", "-w", "--stdin", "--no-filters"], {
            gitDir: this.storeRoot,
            stdin: encodeDurableJson(record),
            timeoutMs: StoreGitTimeoutMs,
        });
        const descriptorOid = parseOid(descriptor.stdout);
        await this.ensureObjectsDurable([descriptorOid]);
        const refName = this.pendingRefName(record);
        await this.git.run(["update-ref", refName, descriptorOid], {
            gitDir: this.storeRoot,
            timeoutMs: StoreGitTimeoutMs,
        });
        await secureCaptureArtifacts(this.storeRoot, new Set(), refName);
    }

    deleteCrestRef(refName: string): Promise<void> {
        return this.withWorkspaceLock(() => this.#deleteCrestRefUnlocked(refName));
    }

    async #deleteCrestRefUnlocked(refName: string): Promise<void> {
        validateCrestRefName(refName);
        const current = (await this.listCrestRefs()).find((ref) => ref.name === refName);
        if (!current) {
            return;
        }
        await this.deleteCrestRefs([current]);
    }

    deleteCrestRefs(refs: readonly { name: string; oid: string }[]): Promise<void> {
        return this.withWorkspaceLock(() => this.#deleteCrestRefsUnlocked(refs));
    }

    async #deleteCrestRefsUnlocked(refs: readonly { name: string; oid: string }[]): Promise<void> {
        if (refs.length === 0) {
            return;
        }
        const seen = new Set<string>();
        const commands = ["start"];
        for (const ref of refs) {
            validateCrestRefName(ref.name);
            validateOid(ref.oid);
            if (seen.has(ref.name)) {
                throw new Error("Duplicate Crest ref deletion");
            }
            seen.add(ref.name);
            commands.push(`delete ${ref.name} ${ref.oid}`);
        }
        commands.push("prepare", "commit", "");
        await this.git.run(["update-ref", "--stdin"], {
            gitDir: this.storeRoot,
            stdin: Buffer.from(commands.join("\n")),
            timeoutMs: StoreGitTimeoutMs,
        });
    }

    readCrestRefBlob(refName: string): Promise<{ oid: string; bytes: Buffer } | undefined> {
        return this.withWorkspaceLock(() => this.#readCrestRefBlobUnlocked(refName));
    }

    async #readCrestRefBlobUnlocked(refName: string): Promise<{ oid: string; bytes: Buffer } | undefined> {
        validateCrestRefName(refName);
        const target = await this.git.run(["for-each-ref", "--format=%(objectname)", refName], {
            gitDir: this.storeRoot,
            timeoutMs: StoreGitTimeoutMs,
            maxStdoutBytes: 256,
        });
        if (target.stdout.length === 0) {
            return undefined;
        }
        const oid = parseOid(target.stdout);
        const result = await this.git.run(["cat-file", "blob", oid], {
            gitDir: this.storeRoot,
            timeoutMs: StoreGitTimeoutMs,
        });
        return { oid, bytes: result.stdout };
    }

    listCrestRefs(): Promise<Array<{ name: string; oid: string }>> {
        return this.withWorkspaceLock(() => this.#listCrestRefsUnlocked());
    }

    async #listCrestRefsUnlocked(): Promise<Array<{ name: string; oid: string }>> {
        const result = await this.git.run(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/crest"], {
            gitDir: this.storeRoot,
            timeoutMs: StoreGitTimeoutMs,
            maxStdoutBytes: QuotaMaxRefOutputBytes,
        });
        if (result.stdout.length === 0) {
            return [];
        }
        return result.stdout
            .toString("utf8")
            .trimEnd()
            .split("\n")
            .map((line) => {
                const parts = line.split("\0");
                if (parts.length !== 2 || !parts[0] || !parts[1]) {
                    throw new Error("Git returned an invalid Crest ref");
                }
                validateCrestRefName(parts[0]);
                validateOid(parts[1]);
                return { name: parts[0], oid: parts[1] };
            });
    }

    ensureObjectsDurable(objectIds: readonly string[], runtime = makeMaintenanceRuntime()): Promise<void> {
        return this.withWorkspaceLock(() => this.#ensureObjectsDurableUnlocked(objectIds, runtime));
    }

    async #ensureObjectsDurableUnlocked(
        objectIds: readonly string[],
        runtime = makeMaintenanceRuntime()
    ): Promise<void> {
        if (objectIds.length === 0) {
            return;
        }
        const unique = [...new Set(objectIds)];
        for (const oid of unique) {
            validateOid(oid);
        }
        const result = await this.git.run(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
            gitDir: this.storeRoot,
            stdin: Buffer.from(`${unique.join("\n")}\n`),
            timeoutMs: remainingTimeout(runtime.deadline),
            maxStdoutBytes: QuotaMaxObjectOutputBytes,
            signal: runtime.signal,
        });
        const lines = splitLines(result.stdout);
        if (
            lines.length !== unique.length ||
            lines.some((line, index) => {
                const [oid, type, extra] = line.split(" ");
                return oid !== unique[index] || !["blob", "tree", "commit", "tag"].includes(type) || extra != null;
            })
        ) {
            throw new Error("Required Git object is missing or invalid");
        }
        await ensureDurableGitObjects(this.storeRoot, unique, new Set(unique));
    }

    getQuotaStatus(runtime = makeMaintenanceRuntime()): Promise<WorkspaceSnapshotQuotaStatus> {
        return this.withWorkspaceLock(() => this.#getQuotaStatusUnlocked(runtime));
    }

    /** Caller must already own this store's workspace lock. */
    getQuotaStatusAssumingLock(runtime = makeMaintenanceRuntime()): Promise<WorkspaceSnapshotQuotaStatus> {
        return this.#getQuotaStatusUnlocked(runtime);
    }

    async #getQuotaStatusUnlocked(runtime = makeMaintenanceRuntime()): Promise<WorkspaceSnapshotQuotaStatus> {
        assertCaptureActive(runtime.deadline, runtime.signal);
        const objectStatus = await this.git.run(["count-objects", "-v"], {
            gitDir: this.storeRoot,
            timeoutMs: remainingTimeout(runtime.deadline),
            signal: runtime.signal,
        });
        const usedBytes = parseCountObjectsBytes(objectStatus.stdout);
        const referencedBytes = await this.referencedObjectBytes(runtime);
        return {
            status:
                referencedBytes > WorkspaceCheckpointLimits.softQuotaBytes
                    ? "referenced-over-quota"
                    : usedBytes > WorkspaceCheckpointLimits.softQuotaBytes
                      ? "soft-quota-exceeded"
                      : "ok",
            usedBytes,
            referencedBytes,
            softQuotaBytes: WorkspaceCheckpointLimits.softQuotaBytes,
        };
    }

    async referencedObjectBytes(runtime: CaptureRuntime): Promise<number> {
        assertCaptureActive(runtime.deadline, runtime.signal);
        const refs = await this.git.run(["for-each-ref", "--format=%(objectname)", "refs/crest"], {
            gitDir: this.storeRoot,
            timeoutMs: remainingTimeout(runtime.deadline),
            maxStdoutBytes: QuotaMaxRefOutputBytes,
            signal: runtime.signal,
        });
        const roots = splitLines(refs.stdout);
        if (roots.length > QuotaMaxRefCount) {
            throw new Error("Snapshot reference count exceeds its quota traversal limit");
        }
        for (const oid of roots) {
            validateOid(oid);
        }
        return await this.#objectBytesForRoots(roots, runtime);
    }

    async #objectBytesForRoots(roots: readonly string[], runtime: CaptureRuntime): Promise<number> {
        if (roots.length === 0) return 0;
        assertCaptureActive(runtime.deadline, runtime.signal);
        const objects = await this.git.run(["rev-list", "--objects", "--no-object-names", "--stdin"], {
            gitDir: this.storeRoot,
            stdin: Buffer.from(`${roots.join("\n")}\n`),
            timeoutMs: remainingTimeout(runtime.deadline),
            maxStdoutBytes: QuotaMaxObjectOutputBytes,
            signal: runtime.signal,
        });
        const objectIds = splitLines(objects.stdout);
        if (objectIds.length > QuotaMaxObjectCount) {
            throw new Error("Snapshot object count exceeds its quota traversal limit");
        }
        if (new Set(objectIds).size !== objectIds.length) {
            throw new Error("Git returned duplicate objects during quota traversal");
        }
        for (const oid of objectIds) {
            validateOid(oid);
        }
        if (objectIds.length === 0) {
            throw new Error("Git returned no objects for live snapshot references");
        }
        assertCaptureActive(runtime.deadline, runtime.signal);
        const objectInfo = await this.git.run(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
            gitDir: this.storeRoot,
            stdin: Buffer.from(`${objectIds.join("\n")}\n`),
            timeoutMs: remainingTimeout(runtime.deadline),
            maxStdoutBytes: QuotaMaxObjectOutputBytes,
            signal: runtime.signal,
        });
        return parseBatchObjectBytes(objectInfo.stdout, objectIds);
    }

    async captureEntries(
        scope: WorkspaceScope,
        maxNewlyHashedBytes: number,
        runtime: CaptureRuntime
    ): Promise<CapturedWorkspaceEntries> {
        const states = new Map<string, CapturedPathStateV1>();
        const fingerprints = new Map<string, FileFingerprint>();
        const groups = new Map<string, WorkspaceScopeEntry[]>();
        let newlyHashedBytes = 0;
        for (const entry of scope.entries) {
            assertCaptureActive(runtime.deadline, runtime.signal);
            if (!entry.path) {
                continue;
            }
            if (entry.kind === "excluded") {
                states.set(entry.path, { state: "excluded", reason: entry.exclusionReason! });
                continue;
            }
            const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
            const group = groups.get(parent) ?? [];
            group.push(entry);
            groups.set(parent, group);
        }
        const stagingRoot = await mkdtemp(join(this.storeRoot, "journal", "capture-"));
        await securePathWithHandle(stagingRoot, 0o700, "directory");
        try {
            for (const [parent, group] of groups) {
                const captured = await this.captureAnchoredGroup(
                    parent,
                    group,
                    stagingRoot,
                    maxNewlyHashedBytes - newlyHashedBytes,
                    runtime
                );
                newlyHashedBytes += captured.hashedBytes;
                for (const item of captured.entries) {
                    states.set(item.path, item.state);
                    if (item.fingerprint) {
                        fingerprints.set(item.path, item.fingerprint);
                    }
                }
            }
        } finally {
            await rm(stagingRoot, { recursive: true, force: true });
        }
        const entries = scope.entries
            .filter((entry): entry is WorkspaceScopeEntry & { path: string } => entry.path != null)
            .map((entry) => ({
                path: entry.path,
                pathBytes: entry.pathBytes,
                state: states.get(entry.path)!,
            }));
        return { entries, fingerprints, newlyHashedBytes };
    }

    async captureAnchoredGroup(
        parent: string,
        entries: WorkspaceScopeEntry[],
        stagingRoot: string,
        remainingByteBudget: number,
        runtime: CaptureRuntime
    ): Promise<{
        entries: Array<{ path: string; state: CapturedPathStateV1; fingerprint?: FileFingerprint }>;
        hashedBytes: number;
    }> {
        let currentEntries = entries;
        for (let attempt = 0; attempt < 2; attempt++) {
            assertCaptureActive(runtime.deadline, runtime.signal);
            const attemptRoot = await mkdtemp(join(stagingRoot, "group-"));
            await securePathWithHandle(attemptRoot, 0o700, "directory");
            let captured:
                | {
                      entries: Array<{ path: string; state: CapturedPathStateV1; fingerprint?: FileFingerprint }>;
                      hashedBytes: number;
                  }
                | undefined;
            let failure: unknown;
            try {
                captured = await this.captureAnchoredGroupAttempt(
                    parent,
                    currentEntries,
                    attemptRoot,
                    remainingByteBudget,
                    runtime
                );
            } catch (error) {
                failure = error;
            } finally {
                await rm(attemptRoot, { recursive: true, force: true });
            }
            if (captured) {
                return captured;
            }
            if (failure instanceof AnchoredReaderError && failure.code === "unstable_file" && attempt === 0) {
                currentEntries = await this.refreshAnchoredGroupEvidence(parent, currentEntries, runtime);
                continue;
            }
            throw asSnapshotCaptureError(failure);
        }
        throw new WorkspaceSnapshotStoreError("unstable_file", "Workspace group remained unstable after retry");
    }

    async captureAnchoredGroupAttempt(
        parent: string,
        entries: WorkspaceScopeEntry[],
        stagingRoot: string,
        remainingByteBudget: number,
        runtime: CaptureRuntime
    ): Promise<{
        entries: Array<{ path: string; state: CapturedPathStateV1; fingerprint?: FileFingerprint }>;
        hashedBytes: number;
    }> {
        const parentIdentity = entries[0]?.parentIdentity;
        if (
            !parentIdentity ||
            entries.some(
                (entry) =>
                    !entry.parentIdentity ||
                    entry.parentIdentity.dev !== parentIdentity.dev ||
                    entry.parentIdentity.ino !== parentIdentity.ino ||
                    entry.parentIdentity.birthtimeNs !== parentIdentity.birthtimeNs ||
                    !entry.entryIdentity ||
                    !entry.path
            )
        ) {
            throw new WorkspaceSnapshotStoreError("unstable_file", "Workspace scope identity evidence is missing");
        }
        const previous = SnapshotFingerprints.get(this)!;
        const requests: AnchoredReaderEntry[] = entries.map((entry, index) => ({
            path: entry.path!,
            name: basename(entry.path!),
            kind: entry.kind as "file" | "symlink",
            identity: serializeScopeIdentity(entry.entryIdentity!),
            stagingPath: join(stagingRoot, `${index}-${randomBytes(12).toString("hex")}`),
            ...(previous.has(entry.path!) ? { previous: serializeFingerprint(previous.get(entry.path!)!) } : {}),
        }));
        const results = await runAnchoredReader({
            parentPath: parent ? join(this.identity.canonicalRoot, ...parent.split("/")) : this.identity.canonicalRoot,
            parentIdentity: {
                dev: parentIdentity.dev.toString(),
                ino: parentIdentity.ino.toString(),
                birthtimeNs: parentIdentity.birthtimeNs.toString(),
            },
            entries: requests,
            maxSingleFileBytes: WorkspaceCheckpointInternalLimits.maxSingleFileBytes,
            maxTotalBytes: remainingByteBudget,
            timeoutMs: remainingTimeout(runtime.deadline),
            signal: runtime.signal,
        });
        const staged = results.filter(
            (result): result is typeof result & { stagingPath: string } => result.stagingPath != null
        );
        const oids = await this.hashStagedPaths(
            staged.map((result) => result.stagingPath),
            runtime
        );
        const sources = new Map(entries.map((entry) => [entry.path!, entry]));
        let oidIndex = 0;
        return {
            hashedBytes: results.reduce((total, result) => total + result.hashedBytes, 0),
            entries: results.map((result) => {
                const oid = result.reusedOid ?? oids[oidIndex++]!;
                const source = sources.get(result.path)!;
                const identity = deserializeFingerprint(result.identity, oid);
                return {
                    path: result.path,
                    state:
                        source.kind === "symlink"
                            ? { state: "symlink" as const, oid }
                            : {
                                  state: "file" as const,
                                  oid,
                                  executable: (identity.mode & 0o111n) !== 0n,
                              },
                    ...(source.kind === "file" ? { fingerprint: identity } : {}),
                };
            }),
        };
    }

    async refreshAnchoredGroupEvidence(
        parent: string,
        entries: WorkspaceScopeEntry[],
        runtime: CaptureRuntime
    ): Promise<WorkspaceScopeEntry[]> {
        assertCaptureActive(runtime.deadline, runtime.signal);
        const expectedParent = entries[0]?.parentIdentity;
        const parentPath = parent
            ? join(this.identity.canonicalRoot, ...parent.split("/"))
            : this.identity.canonicalRoot;
        try {
            const parentMetadata = await lstat(parentPath, { bigint: true });
            if (
                !expectedParent ||
                !parentMetadata.isDirectory() ||
                !sameScopeDirectoryIdentity(expectedParent, parentMetadata)
            ) {
                throw new WorkspaceSnapshotStoreError(
                    "unstable_file",
                    "Workspace group parent identity changed during refresh"
                );
            }
            const refreshed: WorkspaceScopeEntry[] = [];
            for (const entry of entries) {
                assertCaptureActive(runtime.deadline, runtime.signal);
                if (!entry.path || (entry.kind !== "file" && entry.kind !== "symlink")) {
                    throw new Error("group entry is not capturable");
                }
                const metadata = await lstat(join(parentPath, basename(entry.path)), { bigint: true });
                if (
                    (entry.kind === "file" && (!metadata.isFile() || metadata.nlink !== 1n)) ||
                    (entry.kind === "symlink" && !metadata.isSymbolicLink())
                ) {
                    throw new Error("entry type changed");
                }
                refreshed.push({
                    ...entry,
                    executable: entry.kind === "file" ? (metadata.mode & 0o111n) !== 0n : entry.executable,
                    size: Number(metadata.size),
                    parentIdentity: scopeDirectoryIdentity(parentMetadata),
                    entryIdentity: scopeEntryIdentity(metadata),
                });
            }
            return refreshed;
        } catch (cause) {
            if (cause instanceof WorkspaceSnapshotStoreError) {
                throw cause;
            }
            throw new WorkspaceSnapshotStoreError(
                "unstable_file",
                "Workspace group identity could not be safely refreshed",
                { cause }
            );
        }
    }

    async hashStagedPaths(paths: string[], runtime: CaptureRuntime): Promise<string[]> {
        if (paths.length === 0) {
            return [];
        }
        if (paths.some((path) => path.includes("\n") || path.includes("\0"))) {
            throw new Error("Invalid snapshot staging path");
        }
        const result = await this.git.run(["hash-object", "-w", "--stdin-paths", "--no-filters"], {
            gitDir: this.storeRoot,
            stdin: Buffer.from(`${paths.join("\n")}\n`),
            timeoutMs: remainingTimeout(runtime.deadline),
            signal: runtime.signal,
        });
        const oids = splitLines(result.stdout);
        if (oids.length !== paths.length) {
            throw new Error("Git returned an invalid staged object count");
        }
        for (const oid of oids) {
            validateOid(oid);
            runtime.objectIds.add(oid);
        }
        return oids;
    }

    async writeBlob(bytes: Buffer, runtime: CaptureRuntime): Promise<string> {
        const result = await this.git.run(["hash-object", "-w", "--stdin", "--no-filters"], {
            gitDir: this.storeRoot,
            stdin: bytes,
            timeoutMs: remainingTimeout(runtime.deadline),
            signal: runtime.signal,
        });
        const oid = parseOid(result.stdout);
        runtime.objectIds.add(oid);
        return oid;
    }

    async writeWorkspaceTree(entries: CapturedEntry[], runtime: CaptureRuntime): Promise<string> {
        const root: TreeNode = { children: new Map() };
        for (const entry of entries) {
            if (entry.state.state !== "file" && entry.state.state !== "symlink") {
                continue;
            }
            insertTreeLeaf(root, entry.path, {
                mode: entry.state.state === "symlink" ? "120000" : entry.state.executable ? "100755" : "100644",
                oid: entry.state.oid,
            });
        }
        return this.writeTreeNode(root, runtime);
    }

    async writeTreeNode(node: TreeNode, runtime: CaptureRuntime): Promise<string> {
        const records: Array<{ name: string; mode: string; type: string; oid: string }> = [];
        for (const [name, child] of node.children) {
            if (isTreeLeaf(child)) {
                records.push({ name, mode: child.mode, type: "blob", oid: child.oid });
                continue;
            }
            records.push({
                name,
                mode: "040000",
                type: "tree",
                oid: await this.writeTreeNode(child, runtime),
            });
        }
        const stdin = makeTreeInput(records);
        const result = await this.git.run(["mktree", "-z"], {
            gitDir: this.storeRoot,
            stdin,
            timeoutMs: remainingTimeout(runtime.deadline),
            signal: runtime.signal,
        });
        const oid = parseOid(result.stdout);
        runtime.objectIds.add(oid);
        return oid;
    }

    async writeDescriptor(
        workspaceTree: string,
        manifestOid: string,
        runtime: CaptureRuntime,
        stateTree?: string
    ): Promise<string> {
        const records: Array<{ name: string; mode: string; type: string; oid: string }> = [
            { name: "scope-manifest", mode: "100644", type: "blob", oid: manifestOid },
            { name: "workspace", mode: "040000", type: "tree", oid: workspaceTree },
        ];
        if (stateTree) {
            records.push({ name: "state", mode: "040000", type: "tree", oid: stateTree });
        }
        const result = await this.git.run(["mktree", "-z"], {
            gitDir: this.storeRoot,
            stdin: makeTreeInput(records),
            timeoutMs: remainingTimeout(runtime.deadline),
            signal: runtime.signal,
        });
        const oid = parseOid(result.stdout);
        runtime.objectIds.add(oid);
        return oid;
    }

    #incrementalTreeObjects(runtime: CaptureRuntime): IncrementalTreeObjectAccess {
        return {
            readTree: async (oid) => {
                validateOid(oid);
                const result = await this.git.run(["cat-file", "tree", oid], {
                    gitDir: this.storeRoot,
                    timeoutMs: remainingTimeout(runtime.deadline),
                    signal: runtime.signal,
                });
                return result.stdout;
            },
            readBlob: async (oid) => {
                validateOid(oid);
                const result = await this.git.run(["cat-file", "blob", oid], {
                    gitDir: this.storeRoot,
                    timeoutMs: remainingTimeout(runtime.deadline),
                    signal: runtime.signal,
                });
                return result.stdout;
            },
            readObjectType: async (oid) => {
                validateOid(oid);
                const result = await this.git.run(["cat-file", "-t", oid], {
                    gitDir: this.storeRoot,
                    timeoutMs: remainingTimeout(runtime.deadline),
                    maxStdoutBytes: 16,
                    signal: runtime.signal,
                });
                const type = result.stdout.toString("ascii").trim();
                if (type !== "blob" && type !== "tree") throw new Error("Invalid incremental Git object type");
                return type;
            },
            writeBlob: (bytes) => this.writeBlob(bytes, runtime),
            writeTree: (entries) => this.#writeIncrementalTree(entries, runtime),
        };
    }

    async #writeIncrementalTree(entries: IncrementalTreeEntry[], runtime: CaptureRuntime): Promise<string> {
        const result = await this.git.run(["mktree", "-z"], {
            gitDir: this.storeRoot,
            stdin: makeTreeInput(entries),
            timeoutMs: remainingTimeout(runtime.deadline),
            signal: runtime.signal,
        });
        const oid = parseOid(result.stdout);
        runtime.objectIds.add(oid);
        return oid;
    }

    async #publishIncrementalOwnerRef(ref: WorkspaceSnapshotRefV1, runtime: CaptureRuntime): Promise<void> {
        const refName = this.ownerRefName(ref.id);
        const previous = await this.#readExactRef(refName, runtime);
        if (previous && previous !== ref.id) {
            throw new Error("Workspace snapshot owner ref changed before publication");
        }
        try {
            await this.git.run(["update-ref", refName, ref.id, previous ?? "0".repeat(ref.id.length)], {
                gitDir: this.storeRoot,
                timeoutMs: remainingTimeout(runtime.deadline),
                signal: runtime.signal,
            });
            await secureCaptureArtifacts(this.storeRoot, runtime.objectIds, refName, runtime);
            await raceWithAbort(verifyCanonicalWorkspaceIdentity(this.identity), runtime.signal);
        } catch (error) {
            if (!previous) {
                try {
                    await this.git.run(["update-ref", "-d", refName, ref.id], {
                        gitDir: this.storeRoot,
                        timeoutMs: StoreGitTimeoutMs,
                    });
                } catch (cleanupError) {
                    throw new AggregateError(
                        [error, cleanupError],
                        "Incremental snapshot publication failed and owner ref cleanup failed"
                    );
                }
            }
            throw error;
        }
    }

    async #readExactRef(refName: string, runtime = makeMaintenanceRuntime()): Promise<string | undefined> {
        validateCrestRefName(refName);
        const owner = await this.git.run(["for-each-ref", "--format=%(objectname)", refName], {
            gitDir: this.storeRoot,
            timeoutMs: remainingTimeout(runtime.deadline),
            maxStdoutBytes: 256,
            signal: runtime.signal,
        });
        if (owner.stdout.length === 0) return undefined;
        return parseOid(owner.stdout);
    }

    async #readStoredManifest(snapshot: WorkspaceSnapshotRefV1, signal?: AbortSignal): Promise<StoredManifestReader> {
        try {
            this.assertSnapshotIdentity(snapshot);
            const descriptor = await this.#readSnapshotDescriptor(snapshot, signal);
            const manifest = await this.#readStoredManifestBlob(snapshot, signal);
            if (manifest.manifest.schemaversion === 1) {
                if (descriptor.size !== 2 || descriptor.has("state")) {
                    throw new Error("Snapshot v1 descriptor has unexpected entries");
                }
                return manifest;
            }
            if (
                descriptor.size !== 3 ||
                descriptor.get("state")?.mode !== "40000" ||
                descriptor.get("state")?.oid !== manifest.manifest.statetree
            ) {
                throw new Error("Snapshot v2 descriptor has an invalid state tree");
            }
            return manifest;
        } catch (cause) {
            if (signal?.aborted) throw signal.reason ?? cause;
            throw asCorruptSnapshot(cause);
        }
    }

    async #readStoredManifestBlob(
        snapshot: WorkspaceSnapshotRefV1,
        signal?: AbortSignal
    ): Promise<StoredManifestReader> {
        return await StoredManifestReader.open({ snapshot, objects: this.#storedManifestObjects(signal) });
    }

    async verifyWorkspaceTree(snapshot: WorkspaceSnapshotRefV1, manifest: StoredManifestReader): Promise<void> {
        const runtime = makeMaintenanceRuntime();
        const actual = new Map<string, CapturedPathStateV1>();
        const leafOids = new Set<string>();
        const treeOids = new Set<string>();
        await this.collectWorkspaceTreeStates(snapshot.tree, "", actual, leafOids, treeOids, runtime);
        const manifestVerification = await manifest.verify();
        const expected = manifestVerification.workspaceStates;
        if (actual.size !== expected.size) {
            throw new Error("Workspace tree and scope manifest diverge");
        }
        for (const [path, expectedState] of expected) {
            const actualState = actual.get(path);
            if (!actualState || !canonicalJson(actualState).equals(canonicalJson(expectedState))) {
                throw new Error(`Workspace tree and scope manifest diverge: ${path}`);
            }
        }
        if (leafOids.size > 0) {
            const expectedObjectIds = [...leafOids];
            const objectInfo = await this.git.run(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
                gitDir: this.storeRoot,
                stdin: Buffer.from(`${expectedObjectIds.join("\n")}\n`),
                timeoutMs: remainingTimeout(runtime.deadline),
                maxStdoutBytes: QuotaMaxObjectOutputBytes,
                signal: runtime.signal,
            });
            assertBatchBlobObjects(objectInfo.stdout, expectedObjectIds);
        }
        const objectIds = [
            snapshot.id,
            snapshot.scopeManifest,
            ...treeOids,
            ...leafOids,
            ...manifestVerification.objectIds,
        ];
        await ensureDurableGitObjects(this.storeRoot, objectIds, new Set(objectIds));
    }

    #storedManifestObjects(signal?: AbortSignal): StoredManifestObjectReader {
        return {
            readBlob: (oid) => this.#readBlobUnlocked(oid, signal),
            readBlobs: (oids) => this.#readStoredPathStateBlobs(oids, signal),
            readTree: async (oid) => {
                validateOid(oid);
                const result = await this.git.run(["cat-file", "tree", oid], {
                    gitDir: this.storeRoot,
                    timeoutMs: StoreGitTimeoutMs,
                    signal,
                });
                return result.stdout;
            },
        };
    }

    async #readStoredPathStateBlobs(
        oids: readonly string[],
        signal?: AbortSignal
    ): Promise<ReadonlyMap<string, Buffer>> {
        if (oids.length === 0 || oids.length > StoredManifestBlobBatchSize || new Set(oids).size !== oids.length) {
            throw new Error("Invalid stored path state blob batch");
        }
        for (const oid of oids) validateOid(oid);
        const result = await this.git.run(["cat-file", "--batch"], {
            gitDir: this.storeRoot,
            stdin: Buffer.from(`${oids.join("\n")}\n`),
            timeoutMs: StoreGitTimeoutMs,
            maxStdoutBytes: StoredPathStateBatchOutputBytes,
            signal,
        });
        return parseBatchBlobs(result.stdout, oids, StoredPathStateMaxBytes);
    }

    async collectWorkspaceTreeStates(
        treeOid: string,
        parentPath: string,
        states: Map<string, CapturedPathStateV1>,
        leafOids: Set<string>,
        treeOids: Set<string>,
        runtime: CaptureRuntime
    ): Promise<void> {
        treeOids.add(treeOid);
        const tree = await this.git.run(["cat-file", "tree", treeOid], {
            gitDir: this.storeRoot,
            timeoutMs: remainingTimeout(runtime.deadline),
            signal: runtime.signal,
        });
        for (const [name, entry] of parseRawTreeEntries(tree.stdout, treeOid.length / 2)) {
            const path = parentPath ? `${parentPath}/${name}` : name;
            if (entry.mode === "40000") {
                await this.collectWorkspaceTreeStates(entry.oid, path, states, leafOids, treeOids, runtime);
                continue;
            }
            leafOids.add(entry.oid);
            if (entry.mode === "120000") {
                states.set(path, { state: "symlink", oid: entry.oid });
                continue;
            }
            if (entry.mode !== "100644" && entry.mode !== "100755") {
                throw new Error(`Workspace tree leaf has an invalid mode: ${path}`);
            }
            states.set(path, {
                state: "file",
                oid: entry.oid,
                executable: entry.mode === "100755",
            });
        }
    }

    async verifyUntrustedSnapshot(snapshot: WorkspaceSnapshotRefV1): Promise<void> {
        if (TrustedSnapshotDescriptors.get(this)!.has(snapshotTrustKey(snapshot))) {
            return;
        }
        await this.verify(snapshot);
    }

    assertSnapshotIdentity(snapshot: WorkspaceSnapshotRefV1): void {
        validateOid(snapshot.id);
        validateOid(snapshot.tree);
        validateOid(snapshot.scopeManifest);
        if (
            snapshot.workspaceIdentity !== this.identity.workspaceIdentity ||
            snapshot.workspaceIncarnation !== this.identity.workspaceIncarnation
        ) {
            throw new Error("Snapshot belongs to another workspace incarnation");
        }
    }

    ownerRefName(snapshotId: string): string {
        validateOid(snapshotId);
        return `refs/crest/snapshots/${snapshotId}`;
    }

    pendingRefName(record: Pick<PendingWorkspaceBoundaryV1, "sessionId" | "boundaryToken">): string {
        validateRefToken(record.boundaryToken, "boundary token");
        const sessionHash = createHash("sha256").update(record.sessionId, "utf8").digest("hex");
        return `refs/crest/pending/${sessionHash}/${record.boundaryToken}`;
    }
}

async function initializePrivateStoreImpl(input: {
    storeRoot: string;
    git: WorkspaceGitRunner;
    processOwner: ProcessOwnerIdentity;
}): Promise<void> {
    const parent = dirname(input.storeRoot);
    await makePrivateDirectory(parent);
    const ownerPath = join(parent, ".bootstrap-owner");
    await removeAbandonedBootstrapCandidates(parent);
    await acquireBootstrapOwner(ownerPath, input.processOwner);
    try {
        let created = false;
        if (!(await pathExists(input.storeRoot))) {
            const staging = await mkdtemp(join(parent, `.${basename(input.storeRoot)}.staging-`));
            try {
                await securePathWithHandle(staging, 0o700, "directory");
                await initializeBareRepository(staging, input.git, join(input.storeRoot, "private-hooks"));
                await repairStorePermissions(staging);
                await verifyPrivateStore(staging, input.git);
                await syncTree(staging);
                try {
                    await rename(staging, input.storeRoot);
                    await syncDirectory(parent);
                    created = true;
                } catch (error) {
                    if (!(await pathExists(input.storeRoot))) {
                        throw error;
                    }
                }
            } finally {
                await rm(staging, { recursive: true, force: true });
            }
        }
        if (!created) {
            await assertSafeExistingTree(input.storeRoot, join(input.storeRoot, "journal", "restores"));
            await initializeBareRepository(input.storeRoot, input.git);
        }
        await repairStorePermissions(input.storeRoot);
        await verifyPrivateStore(input.storeRoot, input.git);
    } finally {
        await removeOwnerIfUnchanged(ownerPath, canonicalJson(makeBootstrapOwnerRecord(input.processOwner)));
    }
}

async function initializeBareRepository(
    storeRoot: string,
    git: WorkspaceGitRunner,
    configuredHooks = join(storeRoot, "private-hooks")
): Promise<void> {
    await makePrivateDirectory(storeRoot);
    await git.run(["init", "--bare", storeRoot], {
        cwd: dirname(storeRoot),
        timeoutMs: StoreGitTimeoutMs,
    });
    const hooks = join(storeRoot, "private-hooks");
    await makePrivateDirectory(hooks);
    await makePrivateDirectory(join(storeRoot, "journal"));
    await makePrivateDirectory(join(storeRoot, "lock"));
    await configureStore(git, storeRoot, "core.bare", "true");
    await configureStore(git, storeRoot, "core.autocrlf", "false");
    await configureStore(git, storeRoot, "core.hooksPath", configuredHooks);
    await configureStore(git, storeRoot, "gc.auto", "0");
    await configureGitFsyncWhenSupported(git, storeRoot);
    await unlink(join(storeRoot, "index")).catch(ignoreMissing);
    await unlink(join(storeRoot, "objects", "info", "alternates")).catch(ignoreMissing);
}

async function configureStore(git: WorkspaceGitRunner, storeRoot: string, key: string, value: string): Promise<void> {
    await git.run(["config", "--local", key, value], {
        gitDir: storeRoot,
        timeoutMs: StoreGitTimeoutMs,
    });
}

async function configureGitFsyncWhenSupported(git: WorkspaceGitRunner, storeRoot: string): Promise<void> {
    try {
        await configureStore(git, storeRoot, "core.fsync", "loose-object,reference");
        const probe = await git.run(["rev-parse", "--is-bare-repository"], {
            gitDir: storeRoot,
            timeoutMs: StoreGitTimeoutMs,
        });
        if (/unknown .*fsync|ignoring unknown core\.fsync/i.test(probe.stderr.toString("utf8"))) {
            throw new WorkspaceGitRunnerError("nonzero_exit", "Git does not support the configured fsync components");
        }
    } catch (error) {
        if (!(error instanceof WorkspaceGitRunnerError) || error.code !== "nonzero_exit") {
            throw error;
        }
        await git
            .run(["config", "--local", "--unset-all", "core.fsync"], {
                gitDir: storeRoot,
                timeoutMs: StoreGitTimeoutMs,
            })
            .catch((unsetError) => {
                if (!(unsetError instanceof WorkspaceGitRunnerError) || unsetError.code !== "nonzero_exit") {
                    throw unsetError;
                }
            });
    }
}

async function verifyPrivateStore(storeRoot: string, git: WorkspaceGitRunner): Promise<void> {
    const result = await git.run(["rev-parse", "--is-bare-repository"], {
        gitDir: storeRoot,
        timeoutMs: StoreGitTimeoutMs,
    });
    if (stripLineEnding(result.stdout).toString("ascii") !== "true") {
        throw new Error("Snapshot store is not a bare repository");
    }
    await assertNoShadowMutationFiles(storeRoot);
}

async function assertNoShadowMutationFiles(storeRoot: string, runtime?: CaptureRuntime): Promise<void> {
    assertRuntimeActive(runtime);
    if (await pathExists(join(storeRoot, "index"))) {
        throw new Error("Snapshot store must not contain an index");
    }
    if (await pathExists(join(storeRoot, "objects", "info", "alternates"))) {
        throw new Error("Snapshot store must not contain alternates");
    }
    assertRuntimeActive(runtime);
}

async function acquireBootstrapOwner(path: string, owner: ProcessOwnerIdentity): Promise<void> {
    const record = makeBootstrapOwnerRecord(owner);
    const encoded = canonicalJson(record);
    const deadline = Date.now() + BootstrapWaitTimeoutMs;
    while (true) {
        if (await tryPublishBootstrapOwner(path, encoded)) {
            return;
        }
        const existingBytes = await readFile(path).catch((error) => {
            if (isCode(error, "ENOENT")) {
                return undefined;
            }
            throw error;
        });
        if (!existingBytes) {
            continue;
        }
        const existing = decodeBootstrapOwner(existingBytes);
        if (existing && sameOwner(existing, record)) {
            await removeOwnerIfUnchanged(path, existingBytes);
            continue;
        }
        if (!existing || !(await isOwnerAlive(existing))) {
            await removeOwnerIfUnchanged(path, existingBytes);
            continue;
        }
        if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for snapshot store bootstrap owner");
        }
        await delay(25);
    }
}

async function tryPublishBootstrapOwner(path: string, encoded: Buffer): Promise<boolean> {
    const temporaryPath = `${path}.candidate-${process.pid}-${randomBytes(12).toString("hex")}`;
    await writeFile(temporaryPath, encoded, { flag: "wx", mode: 0o600 });
    try {
        const handle = await open(temporaryPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            await handle.chmod(0o600);
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await link(temporaryPath, path);
        } catch (error) {
            if (isCode(error, "EEXIST")) {
                return false;
            }
            throw error;
        }
        await syncDirectory(dirname(path));
        return true;
    } finally {
        await unlink(temporaryPath).catch(ignoreMissing);
    }
}

async function removeAbandonedBootstrapCandidates(parent: string): Promise<void> {
    const entries = await readdir(parent, { withFileTypes: true });
    for (const entry of entries) {
        const match = /^\.bootstrap-owner\.candidate-([1-9][0-9]*)-[0-9a-f]{24}$/.exec(entry.name);
        if (!match || !entry.isFile()) {
            continue;
        }
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid)) {
            continue;
        }
        const path = join(parent, entry.name);
        const bytes = await readFile(path).catch((error) => {
            if (isCode(error, "ENOENT")) {
                return undefined;
            }
            throw error;
        });
        if (!bytes) {
            continue;
        }
        const owner = decodeBootstrapOwner(bytes);
        if (owner ? await isOwnerAlive(owner) : isPidAlive(pid)) {
            continue;
        }
        await unlink(path).catch(ignoreMissing);
    }
}

async function removeOwnerIfUnchanged(path: string, expected: Buffer): Promise<void> {
    const quarantine = `${path}.stale-${process.pid}-${randomBytes(12).toString("hex")}`;
    try {
        await rename(path, quarantine);
    } catch (error) {
        if (isCode(error, "ENOENT")) {
            return;
        }
        throw error;
    }
    try {
        const captured = await readFile(quarantine);
        if (captured.equals(expected)) {
            return;
        }
        await link(quarantine, path).catch((error) => {
            if (!isCode(error, "EEXIST")) {
                throw error;
            }
        });
    } finally {
        await unlink(quarantine).catch(ignoreMissing);
    }
}

async function isOwnerAlive(owner: BootstrapOwnerRecord): Promise<boolean> {
    try {
        return (await readProcessStartToken(owner.pid)) === owner.processstarttoken;
    } catch {
        try {
            process.kill(owner.pid, 0);
            return true;
        } catch (error) {
            return !isCode(error, "ESRCH");
        }
    }
}

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !isCode(error, "ESRCH");
    }
}

function makeBootstrapOwnerRecord(owner: ProcessOwnerIdentity): BootstrapOwnerRecord {
    return {
        pid: owner.pid,
        processstarttoken: owner.processStartToken,
        nonce: owner.nonce,
    };
}

function sameOwner(left: BootstrapOwnerRecord, right: BootstrapOwnerRecord): boolean {
    return left.pid === right.pid && left.processstarttoken === right.processstarttoken && left.nonce === right.nonce;
}

function decodeBootstrapOwner(bytes: Buffer): BootstrapOwnerRecord | undefined {
    try {
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        if (
            typeof value !== "object" ||
            value == null ||
            Array.isArray(value) ||
            Object.keys(value).sort().join(",") !== "nonce,pid,processstarttoken"
        ) {
            return undefined;
        }
        const record = value as Record<string, unknown>;
        if (
            !Number.isSafeInteger(record.pid) ||
            (record.pid as number) <= 0 ||
            typeof record.processstarttoken !== "string" ||
            !record.processstarttoken ||
            typeof record.nonce !== "string" ||
            !/^[0-9a-f]{64}$/.test(record.nonce)
        ) {
            return undefined;
        }
        return record as unknown as BootstrapOwnerRecord;
    } catch {
        return undefined;
    }
}

async function includeRequiredPaths(
    scope: WorkspaceScope,
    requiredPaths: readonly string[],
    root: string
): Promise<void> {
    const seen = new Set<string>();
    for (const path of requiredPaths) {
        validateRelativePath(path);
        if (seen.has(path)) {
            throw new Error(`Duplicate required path: ${path}`);
        }
        seen.add(path);
        const index = scope.entries.findIndex((entry) => entry.path === path);
        if (index < 0 || scope.entries[index]!.exclusionReason !== "oversized-untracked") {
            continue;
        }
        const discovered = scope.entries[index]!;
        const metadata = await lstat(join(root, ...path.split("/")), { bigint: true });
        if (
            !metadata.isFile() ||
            metadata.nlink !== 1n ||
            !discovered.parentIdentity ||
            !discovered.entryIdentity ||
            !sameScopeEntryIdentity(discovered.entryIdentity, metadata)
        ) {
            throw new Error(`Required path cannot be safely captured: ${path}`);
        }
        scope.entries[index] = {
            path,
            pathBytes: Buffer.from(path),
            kind: "file",
            tracked: false,
            executable: (metadata.mode & 0o111n) !== 0n,
            size: Number(metadata.size),
            parentIdentity: discovered.parentIdentity,
            entryIdentity: discovered.entryIdentity,
        };
        scope.coverage.exclusions = scope.coverage.exclusions.filter((item) => !("path" in item && item.path === path));
        scope.coverage.complete = scope.coverage.exclusions.length === 0;
        scope.coverage.eligibleEntryCount += 1;
    }
}

function sameScopeEntryIdentity(left: WorkspaceScopeEntryIdentity, right: BigIntStats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.birthtimeNs === right.birthtimeNs &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs
    );
}

function sameScopeDirectoryIdentity(left: WorkspaceScopeDirectoryIdentity, right: BigIntStats): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function scopeDirectoryIdentity(value: BigIntStats): WorkspaceScopeDirectoryIdentity {
    return {
        dev: value.dev,
        ino: value.ino,
        birthtimeNs: value.birthtimeNs,
    };
}

function scopeEntryIdentity(value: BigIntStats): WorkspaceScopeEntryIdentity {
    return {
        ...scopeDirectoryIdentity(value),
        mode: value.mode,
        nlink: value.nlink,
        size: value.size,
        mtimeNs: value.mtimeNs,
        ctimeNs: value.ctimeNs,
    };
}

function asSnapshotCaptureError(error: unknown): Error {
    if (error instanceof AnchoredReaderError && error.code === "capture_budget") {
        return new WorkspaceSnapshotStoreError("capture_budget", error.message, { cause: error });
    }
    if (error instanceof AnchoredReaderError && error.code === "unstable_file") {
        return new WorkspaceSnapshotStoreError("unstable_file", error.message, { cause: error });
    }
    return error instanceof Error ? error : new Error("Workspace group capture failed", { cause: error });
}

function serializeScopeIdentity(value: WorkspaceScopeEntryIdentity): AnchoredReaderEntryIdentity {
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

function serializeFingerprint(value: FileFingerprint): AnchoredReaderEntryIdentity & { oid: string } {
    return {
        dev: value.dev.toString(),
        ino: value.ino.toString(),
        birthtimeNs: value.birthtimeNs.toString(),
        mode: value.mode.toString(),
        nlink: value.nlink.toString(),
        size: value.size.toString(),
        mtimeNs: value.mtimeNs.toString(),
        ctimeNs: value.ctimeNs.toString(),
        oid: value.oid,
    };
}

function deserializeFingerprint(value: AnchoredReaderEntryIdentity, oid: string): FileFingerprint {
    return {
        dev: BigInt(value.dev),
        ino: BigInt(value.ino),
        birthtimeNs: BigInt(value.birthtimeNs),
        size: BigInt(value.size),
        mode: BigInt(value.mode),
        nlink: BigInt(value.nlink),
        mtimeNs: BigInt(value.mtimeNs),
        ctimeNs: BigInt(value.ctimeNs),
        oid,
    };
}

function insertTreeLeaf(root: TreeNode, path: string, leaf: TreeLeaf): void {
    const segments = path.split("/");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
        const existing = node.children.get(segment);
        if (existing) {
            if (isTreeLeaf(existing)) {
                throw new Error(`Workspace tree path collision: ${path}`);
            }
            node = existing;
            continue;
        }
        const child: TreeNode = { children: new Map() };
        node.children.set(segment, child);
        node = child;
    }
    const name = segments.at(-1)!;
    if (node.children.has(name)) {
        throw new Error(`Duplicate workspace tree path: ${path}`);
    }
    node.children.set(name, leaf);
}

function isTreeLeaf(value: TreeNode | TreeLeaf): value is TreeLeaf {
    return "oid" in value;
}

function makeTreeInput(records: Array<{ name: string; mode: string; type: string; oid: string }>): Buffer {
    records.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    const chunks: Buffer[] = [];
    for (const record of records) {
        if (record.name.includes("\0") || record.name.includes("/")) {
            throw new Error("Invalid tree entry name");
        }
        chunks.push(
            Buffer.from(`${record.mode} ${record.type} ${record.oid}\t`),
            Buffer.from(record.name),
            Buffer.from([0])
        );
    }
    return Buffer.concat(chunks);
}

async function repairStorePermissions(storeRoot: string): Promise<void> {
    for (const directory of ["objects", "refs", "journal", "lock", "private-hooks"]) {
        await makePrivateDirectory(join(storeRoot, directory));
    }
    await repairTreePermissions(storeRoot, join(storeRoot, "journal", "restores"));
}

async function secureCaptureArtifacts(
    storeRoot: string,
    objectIds: ReadonlySet<string>,
    ownerRef: string,
    runtime?: CaptureRuntime
): Promise<void> {
    for (const oid of objectIds) {
        assertRuntimeActive(runtime);
        const fanout = join(storeRoot, "objects", oid.slice(0, 2));
        const objectPath = join(fanout, oid.slice(2));
        if (!(await pathExists(objectPath))) {
            continue;
        }
        await securePathWithHandle(fanout, 0o700, "directory");
        await securePathWithHandle(objectPath, 0o600, "file");
    }
    let referenceDirectory = storeRoot;
    const referenceSegments = ownerRef.split("/");
    for (const segment of referenceSegments.slice(0, -1)) {
        assertRuntimeActive(runtime);
        referenceDirectory = join(referenceDirectory, segment);
        await securePathWithHandle(referenceDirectory, 0o700, "directory");
    }
    assertRuntimeActive(runtime);
    const referencePath = join(storeRoot, ...referenceSegments);
    if (await pathExists(referencePath)) {
        await securePathWithHandle(referencePath, 0o600, "file");
        return;
    }
    const packedRefsPath = join(storeRoot, "packed-refs");
    if (!(await pathExists(packedRefsPath))) {
        throw new Error(`Snapshot store reference was not published: ${ownerRef}`);
    }
    await securePathWithHandle(packedRefsPath, 0o600, "file");
}

function assertPrivateStorePlatform(): void {
    if (process.platform === "win32") {
        throw new Error("Workspace snapshot store is disabled until owner-only Windows ACL support is available");
    }
}

async function repairTreePermissions(root: string, ignoredLegacyRoot?: string): Promise<void> {
    const entries = await readdir(root, { withFileTypes: true });
    await securePathWithHandle(root, 0o700, "directory");
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (path === ignoredLegacyRoot) {
            continue;
        }
        if (entry.isDirectory()) {
            await repairTreePermissions(path, ignoredLegacyRoot);
            continue;
        }
        if (entry.isFile()) {
            await securePathWithHandle(path, 0o600, "file");
            continue;
        }
        throw new Error(`Unsafe snapshot store entry: ${path}`);
    }
}

async function makePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await securePathWithHandle(path, 0o700, "directory");
}

async function securePathWithHandle(path: string, mode: number, kind: "file" | "directory"): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const before = await handle.stat({ bigint: true });
        if (
            (kind === "file" && (!before.isFile() || before.nlink !== 1n)) ||
            (kind === "directory" && !before.isDirectory())
        ) {
            throw new Error(`Unsafe snapshot store ${kind}: ${path}`);
        }
        await handle.chmod(mode);
        const after = await handle.stat({ bigint: true });
        if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            (after.mode & 0o077n) !== 0n ||
            (kind === "file" && (!after.isFile() || after.nlink !== 1n)) ||
            (kind === "directory" && !after.isDirectory())
        ) {
            throw new Error(`Snapshot store ${kind} identity changed while securing: ${path}`);
        }
    } finally {
        await handle.close();
    }
}

async function assertSafeExistingTree(root: string, ignoredLegacyRoot?: string): Promise<void> {
    const metadata = await lstat(root, { bigint: true });
    if (!metadata.isDirectory()) {
        throw new Error(`Unsafe snapshot store directory: ${root}`);
    }
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (path === ignoredLegacyRoot) {
            continue;
        }
        if (entry.isDirectory()) {
            await assertSafeExistingTree(path, ignoredLegacyRoot);
            continue;
        }
        if (!entry.isFile()) {
            throw new Error(`Unsafe snapshot store entry: ${path}`);
        }
        const file = await lstat(path, { bigint: true });
        if (!file.isFile() || file.nlink !== 1n) {
            throw new Error(`Unsafe snapshot store file: ${path}`);
        }
    }
}

async function syncDirectory(path: string): Promise<void> {
    if (process.platform === "win32") {
        return;
    }
    const handle = await open(path, constants.O_RDONLY);
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function syncTree(root: string): Promise<void> {
    if (process.platform === "win32") {
        return;
    }
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            await syncTree(path);
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        const handle = await open(path, constants.O_RDONLY);
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
    await syncDirectory(root);
}

async function assertFreeSpace(path: string, runtime: CaptureRuntime): Promise<void> {
    assertCaptureActive(runtime.deadline, runtime.signal);
    const value = await statfs(path, { bigint: true });
    assertCaptureActive(runtime.deadline, runtime.signal);
    const volumeBytes = value.blocks * BigInt(value.bsize);
    const availableBytes = value.bavail * BigInt(value.bsize);
    const ratioMinimum = (volumeBytes + 19n) / 20n;
    const requiredBytes =
        ratioMinimum > BigInt(WorkspaceCheckpointLimits.minimumFreeBytes)
            ? ratioMinimum
            : BigInt(WorkspaceCheckpointLimits.minimumFreeBytes);
    if (availableBytes < requiredBytes) {
        throw new WorkspaceSnapshotStoreError("enospc", "Insufficient free space for workspace checkpoint");
    }
}

function makeMaintenanceRuntime(): CaptureRuntime {
    return {
        deadline: Date.now() + StoreGitTimeoutMs,
        signal: new AbortController().signal,
        objectIds: new Set(),
    };
}

function assertRuntimeActive(runtime?: CaptureRuntime): void {
    if (runtime) {
        assertCaptureActive(runtime.deadline, runtime.signal);
    }
}

function validateCaptureOptions(options: CaptureWorkspaceOptions): void {
    if (!options || !["pre-turn", "terminal", "safety"].includes(options.profile)) {
        throw new Error("Invalid workspace capture profile");
    }
    if (options.requiredPaths != null && !Array.isArray(options.requiredPaths)) {
        throw new Error("Invalid required paths");
    }
}

function validateIncrementalCommitInput(input: {
    base: WorkspaceSnapshotRefV1;
    mutations: IncrementalPathMutation[];
    scope: WorkspaceScopeManifest;
    coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
    newlyHashedBytes: number;
    profile: CaptureWorkspaceOptions["profile"];
}): void {
    if (
        !input ||
        !input.base ||
        !Array.isArray(input.mutations) ||
        !input.scope ||
        typeof input.scope !== "object" ||
        !input.coverage ||
        typeof input.coverage.complete !== "boolean" ||
        !Number.isSafeInteger(input.coverage.eligibleEntryCount) ||
        input.coverage.eligibleEntryCount < 0 ||
        !Array.isArray(input.coverage.exclusions) ||
        !Number.isSafeInteger(input.newlyHashedBytes) ||
        input.newlyHashedBytes < 0 ||
        input.newlyHashedBytes > WorkspaceCheckpointLimits.maxNewlyHashedBytes ||
        !["pre-turn", "terminal", "safety"].includes(input.profile)
    ) {
        throw new Error("Invalid incremental snapshot commit input");
    }
    input.coverage.exclusions.forEach(toStoredCoverageExclusion);
}

function cloneIncrementalCommitInput(input: {
    base: WorkspaceSnapshotRefV1;
    mutations: IncrementalPathMutation[];
    scope: WorkspaceScopeManifest;
    coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
    newlyHashedBytes: number;
    profile: CaptureWorkspaceOptions["profile"];
}): {
    base: WorkspaceSnapshotRefV1;
    mutations: IncrementalPathMutation[];
    scope: WorkspaceScopeManifest;
    coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
    newlyHashedBytes: number;
    profile: CaptureWorkspaceOptions["profile"];
} {
    validateIncrementalCommitInput(input);
    return {
        base: { ...input.base },
        mutations: normalizeIncrementalMutations(input.mutations),
        scope: JSON.parse(JSON.stringify(input.scope)) as WorkspaceScopeManifest,
        coverage: {
            complete: input.coverage.complete,
            eligibleEntryCount: input.coverage.eligibleEntryCount,
            exclusions: input.coverage.exclusions.map(cloneCoverageExclusion),
        },
        newlyHashedBytes: input.newlyHashedBytes,
        profile: input.profile,
    };
}

function deriveIncrementalCoverage(
    base: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">,
    changes: readonly WorkspacePathChangeV1[]
): Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes"> {
    let eligibleEntryDelta = 0;
    const pathExclusions = new Map<
        string,
        Extract<WorkspaceSnapshotCoverage["exclusions"][number], { path: string }>
    >();
    const nonPathExclusions: WorkspaceSnapshotCoverage["exclusions"] = [];
    for (const exclusion of base.exclusions) {
        if (exclusion.path != null) {
            pathExclusions.set(exclusion.path, { path: exclusion.path, reason: exclusion.reason });
        } else {
            nonPathExclusions.push(cloneCoverageExclusion(exclusion));
        }
    }
    for (const change of changes) {
        eligibleEntryDelta += Number(isEligiblePathState(change.after)) - Number(isEligiblePathState(change.before));
        if (!Number.isSafeInteger(eligibleEntryDelta)) {
            throw new Error("Incremental snapshot coverage is invalid");
        }
        if (change.before.state === "excluded") pathExclusions.delete(change.path);
        if (change.after.state === "excluded") {
            pathExclusions.set(change.path, {
                path: change.path,
                reason: change.after.reason,
            });
        }
    }
    const eligibleEntryCount = base.eligibleEntryCount + eligibleEntryDelta;
    if (!Number.isSafeInteger(eligibleEntryCount) || eligibleEntryCount < 0) {
        throw new Error("Incremental snapshot coverage is invalid");
    }
    const exclusions = [...nonPathExclusions, ...pathExclusions.values()].sort(compareCoverageExclusions);
    return {
        complete: exclusions.length === 0,
        eligibleEntryCount,
        exclusions,
    };
}

function canonicalCoverage(coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">): Buffer {
    return canonicalJson({
        complete: coverage.complete,
        eligibleEntryCount: coverage.eligibleEntryCount,
        exclusions: coverage.exclusions.map(cloneCoverageExclusion).sort(compareCoverageExclusions),
    });
}

function compareCoverageExclusions(
    left: WorkspaceSnapshotCoverage["exclusions"][number],
    right: WorkspaceSnapshotCoverage["exclusions"][number]
): number {
    return Buffer.compare(canonicalJson(left), canonicalJson(right));
}

function cloneCoverageExclusion(
    exclusion: WorkspaceSnapshotCoverage["exclusions"][number]
): WorkspaceSnapshotCoverage["exclusions"][number] {
    const stored = toStoredCoverageExclusion(exclusion);
    if ("scope" in stored) return { scope: stored.scope, reason: stored.reason };
    if ("path" in stored) return { path: stored.path, reason: stored.reason };
    return { pathBytesBase64: stored.pathbytesbase64, reason: stored.reason };
}

function isEligiblePathState(state: CapturedPathStateV1): boolean {
    return state.state === "file" || state.state === "symlink";
}

function toStoredCoverageExclusion(
    exclusion: WorkspaceSnapshotCoverage["exclusions"][number]
): StoredScopeManifestV2["coverage"]["exclusions"][number] {
    if (!exclusion || typeof exclusion !== "object" || typeof exclusion.reason !== "string") {
        throw new Error("Invalid incremental snapshot coverage exclusion");
    }
    const record = exclusion as unknown as Record<string, unknown>;
    if (Object.hasOwn(record, "scope")) {
        if (
            record.scope !== "workspace-root" ||
            Object.keys(record).some((key) => !["scope", "reason"].includes(key))
        ) {
            throw new Error("Invalid incremental snapshot coverage exclusion");
        }
        if (exclusion.reason !== "capture-budget") {
            throw new Error("Invalid incremental snapshot coverage exclusion");
        }
        return { scope: "workspace-root", reason: "capture-budget" };
    }
    if (Object.hasOwn(record, "path")) {
        if (typeof record.path !== "string" || Object.keys(record).some((key) => !["path", "reason"].includes(key))) {
            throw new Error("Invalid incremental snapshot coverage exclusion");
        }
        validateRelativePath(record.path);
        return { path: record.path, reason: exclusion.reason };
    }
    if (
        typeof record.pathBytesBase64 !== "string" ||
        Object.keys(record).some((key) => !["pathBytesBase64", "reason"].includes(key))
    ) {
        throw new Error("Invalid incremental snapshot coverage exclusion");
    }
    const bytes = Buffer.from(record.pathBytesBase64, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== record.pathBytesBase64) {
        throw new Error("Invalid incremental snapshot coverage exclusion");
    }
    return { pathbytesbase64: record.pathBytesBase64, reason: exclusion.reason };
}

function validateProcessOwner(owner: ProcessOwnerIdentity): void {
    if (
        !owner ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        typeof owner.processStartToken !== "string" ||
        !owner.processStartToken ||
        typeof owner.nonce !== "string" ||
        !/^[0-9a-f]{64}$/.test(owner.nonce)
    ) {
        throw new Error("Invalid process owner identity");
    }
}

function validateOid(oid: string): void {
    if (!/^[0-9a-f]{40,64}$/.test(oid)) {
        throw new Error("Invalid Git object id");
    }
}

function snapshotTrustKey(snapshot: WorkspaceSnapshotRefV1): string {
    return encodeDurableJson(snapshot).toString("utf8");
}

function markSnapshotTrusted(store: WorkspaceSnapshotStore, snapshot: WorkspaceSnapshotRefV1): void {
    TrustedSnapshotDescriptors.get(store)!.add(snapshotTrustKey(snapshot));
}

function validateRefToken(value: string, label: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.endsWith(".lock") || value.includes("..")) {
        throw new Error(`Invalid ${label}`);
    }
}

function validateCrestRefName(value: string): void {
    if (
        !/^refs\/crest\/(?:snapshots\/[0-9a-f]{40}|pending\/[0-9a-f]{64}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}|ops\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.test(
            value
        ) ||
        value.endsWith(".lock") ||
        value.includes("..")
    ) {
        throw new Error("Invalid Crest ref name");
    }
}

async function quarantineLegacyRestoreJournals(storeRoot: string): Promise<void> {
    try {
        const result = await quarantineLegacyRestoreJournalsImpl(storeRoot);
        if (result.failed > 0) {
            console.warn("Legacy restore data is incompatible and some entries could not be quarantined safely");
        } else if (result.quarantined > 0) {
            console.warn("Legacy restore data is incompatible and was quarantined without decoding");
        }
    } catch {
        console.warn("Legacy restore data is incompatible and could not be quarantined safely");
    }
}

async function quarantineLegacyRestoreJournalsImpl(
    storeRoot: string
): Promise<{ quarantined: number; failed: number }> {
    const legacyRoot = join(storeRoot, "journal", "restores");
    let names: string[];
    try {
        const rootState = await lstat(legacyRoot, { bigint: true });
        if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
            throw new Error("Legacy restore journal root is unsafe");
        }
        names = await readdir(legacyRoot);
    } catch (error) {
        if (isCode(error, "ENOENT")) return { quarantined: 0, failed: 0 };
        throw error;
    }
    const resolvedRoot = join(storeRoot, "journal", "restore", "resolved");
    await makePrivateDirectory(resolvedRoot);
    let quarantined = 0;
    let failed = 0;
    for (const name of names.sort()) {
        if (!name.endsWith(".json")) continue;
        try {
            await quarantineLegacyRestoreJournal(legacyRoot, resolvedRoot, name);
            quarantined++;
        } catch {
            failed++;
        }
    }
    return { quarantined, failed };
}

async function quarantineLegacyRestoreJournal(legacyRoot: string, resolvedRoot: string, name: string): Promise<void> {
    const source = join(legacyRoot, name);
    const sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    let sourceIdentity: { dev: bigint; ino: bigint };
    try {
        const state = await sourceHandle.stat({ bigint: true });
        if (!state.isFile() || state.nlink !== 1n) {
            throw new Error("Legacy restore journal entry is unsafe");
        }
        sourceIdentity = { dev: state.dev, ino: state.ino };
        bytes = await sourceHandle.readFile();
    } finally {
        await sourceHandle.close();
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const destination = join(resolvedRoot, `legacy-${digest}.json`);
    let created = false;
    try {
        const destinationHandle = await open(
            destination,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
            0o600
        );
        created = true;
        try {
            await destinationHandle.writeFile(bytes);
            await destinationHandle.sync();
        } finally {
            await destinationHandle.close();
        }
    } catch (error) {
        if (!isCode(error, "EEXIST")) {
            if (created) await unlink(destination).catch(() => {});
            throw error;
        }
    }
    try {
        await securePathWithHandle(destination, 0o600, "file");
        if (!(await readFile(destination)).equals(bytes)) {
            throw new Error("Legacy restore quarantine digest collision");
        }
    } catch (error) {
        if (created) await unlink(destination).catch(() => {});
        throw error;
    }
    const currentSource = await lstat(source, { bigint: true });
    if (
        !currentSource.isFile() ||
        currentSource.isSymbolicLink() ||
        currentSource.nlink !== 1n ||
        currentSource.dev !== sourceIdentity.dev ||
        currentSource.ino !== sourceIdentity.ino
    ) {
        throw new Error("Legacy restore journal entry changed during quarantine");
    }
    await syncDirectory(resolvedRoot);
    await unlink(source);
    await syncDirectory(legacyRoot);
}

function parseOid(value: Buffer): string {
    const oid = stripLineEnding(value).toString("ascii");
    validateOid(oid);
    return oid;
}

function stripLineEnding(value: Buffer): Buffer {
    return value.at(-1) === 0x0a ? value.subarray(0, -1) : value;
}

function splitLines(value: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let index = 0; index <= value.length; index++) {
        if (index < value.length && value[index] !== 0x0a) {
            continue;
        }
        let end = index;
        if (end > start && value[end - 1] === 0x0d) {
            end--;
        }
        if (end > start) {
            lines.push(value.subarray(start, end).toString("ascii"));
        }
        start = index + 1;
    }
    return lines;
}

function parseCountObjectsBytes(value: Buffer): number {
    const expected = new Set([
        "count",
        "size",
        "in-pack",
        "packs",
        "size-pack",
        "prune-packable",
        "garbage",
        "size-garbage",
    ]);
    const fields = new Map<string, number>();
    for (const line of splitLines(value)) {
        const match = /^([a-z-]+): ([0-9]+)$/.exec(line);
        if (!match || !expected.has(match[1]!) || fields.has(match[1]!)) {
            throw new Error("Invalid Git object usage report");
        }
        fields.set(match[1]!, parseSafeInteger(match[2]!, "Git object usage"));
    }
    if (fields.size !== expected.size) {
        throw new Error("Incomplete Git object usage report");
    }
    const usedKiB = fields.get("size")! + fields.get("size-pack")!;
    const usedBytes = usedKiB * 1024;
    if (!Number.isSafeInteger(usedBytes)) {
        throw new Error("Git object usage exceeds the supported range");
    }
    return usedBytes;
}

function parseBatchObjectBytes(value: Buffer, expectedObjectIds: string[]): number {
    const lines = splitLines(value);
    if (lines.length !== expectedObjectIds.length) {
        throw new Error("Git returned an invalid object metadata count");
    }
    let bytes = 0;
    for (let index = 0; index < lines.length; index++) {
        const fields = lines[index]!.split(" ");
        if (
            fields.length !== 3 ||
            fields[0] !== expectedObjectIds[index] ||
            (fields[1] !== "tree" && fields[1] !== "blob")
        ) {
            throw new Error("Git returned invalid snapshot object metadata");
        }
        bytes += parseSafeInteger(fields[2]!, "Git object size");
        if (!Number.isSafeInteger(bytes)) {
            throw new Error("Snapshot object bytes exceed the supported range");
        }
    }
    return bytes;
}

function assertBatchBlobObjects(value: Buffer, expectedObjectIds: string[]): void {
    const lines = splitLines(value);
    if (lines.length !== expectedObjectIds.length) {
        throw new Error("Git returned an invalid workspace leaf metadata count");
    }
    for (let index = 0; index < lines.length; index++) {
        const fields = lines[index]!.split(" ");
        if (fields.length !== 2 || fields[0] !== expectedObjectIds[index] || fields[1] !== "blob") {
            throw new Error("Workspace tree leaf is missing or is not a blob");
        }
    }
}

function parseBatchBlobs(
    value: Buffer,
    expectedObjectIds: readonly string[],
    maxBlobBytes: number
): Map<string, Buffer> {
    const blobs = new Map<string, Buffer>();
    let offset = 0;
    for (const expectedOid of expectedObjectIds) {
        const lineEnd = value.indexOf(0x0a, offset);
        if (lineEnd < offset) throw new Error("Git returned an invalid stored path state blob batch");
        const header = value.subarray(offset, lineEnd).toString("ascii").split(" ");
        if (header.length !== 3 || header[0] !== expectedOid || header[1] !== "blob") {
            throw new Error("Git returned an invalid stored path state blob batch");
        }
        const size = parseSafeInteger(header[2]!, "stored path state blob size");
        if (size > maxBlobBytes || lineEnd + 1 + size >= value.length || value[lineEnd + 1 + size] !== 0x0a) {
            throw new Error("Git returned an invalid stored path state blob batch");
        }
        blobs.set(expectedOid, Buffer.from(value.subarray(lineEnd + 1, lineEnd + 1 + size)));
        offset = lineEnd + 1 + size + 1;
    }
    if (offset !== value.length) throw new Error("Git returned an invalid stored path state blob batch");
    return blobs;
}

function parseSafeInteger(value: string, label: string): number {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(`Invalid ${label}`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${label} exceeds the supported range`);
    }
    return parsed;
}

function parseRawTreeEntries(value: Buffer, hashBytes: number): Map<string, { mode: string; oid: string }> {
    if (hashBytes !== 20 && hashBytes !== 32) {
        throw new Error("Unsupported Git object format");
    }
    const entries = new Map<string, { mode: string; oid: string }>();
    let offset = 0;
    while (offset < value.length) {
        const space = value.indexOf(0x20, offset);
        const nul = value.indexOf(0x00, space + 1);
        if (space <= offset || nul < space + 2 || nul + 1 + hashBytes > value.length) {
            throw new Error("Invalid raw Git tree object");
        }
        const mode = value.subarray(offset, space).toString("ascii");
        if (!/^[0-7]{5,6}$/.test(mode)) {
            throw new Error("Invalid raw Git tree mode");
        }
        const nameBytes = value.subarray(space + 1, nul);
        const name = nameBytes.toString("utf8");
        if (!Buffer.from(name).equals(nameBytes) || entries.has(name)) {
            throw new Error("Invalid raw Git tree name");
        }
        entries.set(name, {
            mode,
            oid: value.subarray(nul + 1, nul + 1 + hashBytes).toString("hex"),
        });
        offset = nul + 1 + hashBytes;
    }
    return entries;
}

function remainingTimeout(deadline: number): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
        throw new WorkspaceSnapshotStoreError("capture_timeout", "Workspace snapshot capture timed out");
    }
    return Math.min(remaining, StoreGitTimeoutMs);
}

function assertCaptureActive(deadline: number, signal: AbortSignal): void {
    if (signal.aborted || Date.now() >= deadline) {
        throw new WorkspaceSnapshotStoreError("capture_timeout", "Workspace snapshot capture timed out");
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (isCode(error, "ENOENT")) {
            return false;
        }
        throw error;
    }
}

function isCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

function ignoreMissing(error: unknown): void {
    if (!isCode(error, "ENOENT")) {
        throw error;
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function asCorruptSnapshot(cause: unknown): WorkspaceSnapshotStoreError {
    if (cause instanceof WorkspaceSnapshotStoreError) return cause;
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    return new WorkspaceSnapshotStoreError("corrupt_snapshot", `Workspace snapshot is corrupt${detail}`, { cause });
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(
            new WorkspaceSnapshotStoreError("capture_timeout", "Workspace snapshot capture timed out")
        );
    }
    return new Promise<T>((resolveOperation, rejectOperation) => {
        const onAbort = () => {
            rejectOperation(new WorkspaceSnapshotStoreError("capture_timeout", "Workspace snapshot capture timed out"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        operation.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolveOperation(value);
            },
            (error) => {
                signal.removeEventListener("abort", onAbort);
                rejectOperation(error);
            }
        );
    });
}
