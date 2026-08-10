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

import { encodeDurableJson, ensureDurableGitObjects } from "./durability";
import { WorkspaceGitRunner, WorkspaceGitRunnerError } from "./git-runner";
import { WorkspaceCheckpointInternalLimits } from "./internal-limits";
import { decodePendingWorkspaceBoundaryV1, type PendingWorkspaceBoundaryV1 } from "./pending-boundary-store";
import { readProcessStartToken, type ProcessOwnerIdentity } from "./process-owner";
import { ShadowWorkspaceIndex } from "./shadow-workspace-index";
import { SnapshotQuotaAccounting } from "./snapshot-quota-accounting";
import {
    encodeCanonicalStoredJson as canonicalJson,
    StoredManifestReader,
    toStoredWorkspaceScope,
    validateWorkspaceRelativePath as validateRelativePath,
    type StoredManifestObjectReader,
    type StoredScopeManifest,
} from "./stored-manifest";
import type {
    CapturedPathStateV1,
    WorkspacePathChangeV1,
    WorkspaceSnapshotCoverage,
    WorkspaceSnapshotRefV1,
} from "./types";
import { normalizeWorkspaceCandidateEntries, type WorkspaceCandidatePathEntry } from "./workspace-candidate-capture";
import { verifyCanonicalWorkspaceIdentity, type CanonicalWorkspaceIdentity } from "./workspace-identity";
import { WorkspaceMutationLock } from "./workspace-lock";
import { WorkspaceMutationLog } from "./workspace-mutation-log";
import {
    runStablePathReader,
    StablePathReaderError,
    type StablePathReaderEntry,
    type StablePathReaderEntryIdentity,
    type StablePathReaderResult,
} from "./workspace-path-reader";
import {
    discoverWorkspaceScope,
    verifyWorkspaceScopeDirectories,
    type WorkspaceScope,
    type WorkspaceScopeDirectoryIdentity,
    type WorkspaceScopeEntry,
    type WorkspaceScopeEntryIdentity,
    type WorkspaceScopeManifest,
    type WorkspaceScopeObserver,
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
const CandidateLookupMaxPaths = 512;
const CandidateLookupMaxArgumentBytes = 128 * 1024;
const StagedHashMaxPaths = 512;
const StagedHashMaxInputBytes = 128 * 1024;
const StagedCaptureMaxBytes = 64 * 1024 ** 2;
// Keep room for the concurrently written pack staging file, its index/rev metadata, and filesystem overhead.
const ObjectClosureOverlayReserveBytes = 64 * 1024 ** 2;
const ColdIndexPrefix = "workspace-cold-baseline-";
const GitUnsafeAttributes = new Set(["text", "eol", "crlf", "filter", "ident", "working-tree-encoding"]);

export interface CaptureWorkspaceOptions {
    profile: "pre-turn" | "terminal" | "safety";
    requiredPaths?: readonly string[];
    signal?: AbortSignal;
    observer?: WorkspaceScopeObserver;
}

export interface ReconciledWorkspaceState {
    tree: string;
    scope: WorkspaceScopeManifest;
    coverage: WorkspaceSnapshotCoverage;
}

type WorkspaceTreePathEntry =
    | { kind: "tree" }
    | { kind: "leaf"; state: Extract<CapturedPathStateV1, { state: "file" | "symlink" }> };

interface WorkspaceRawTreeDeltaEntry {
    path: string;
    before: Extract<CapturedPathStateV1, { state: "absent" | "file" | "symlink" }>;
    after: Extract<CapturedPathStateV1, { state: "absent" | "file" | "symlink" }>;
}

export interface WorkspaceSnapshotQuotaStatus {
    status: "ok" | "soft-quota-exceeded" | "referenced-over-quota";
    usedBytes: number;
    referencedBytes: number;
    softQuotaBytes: number;
}

export interface CaptureGitBaselineOptions {
    sourceRoot: string;
    sourceTree: string;
    sourceGit: WorkspaceGitRunner;
    candidatePaths: readonly string[];
    signal?: AbortSignal;
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

interface GitBaselineTreeEntry {
    path: string;
    mode: "100644" | "100755" | "120000";
    oid: string;
}

interface GitBaselineProjection {
    captureEntries: WorkspaceScopeEntry[];
    absentEntries: Array<{ path: string; pathBytes: Buffer; state: { state: "absent" } }>;
}

interface CapturedStablePathGroup {
    stagingRoot: string;
    entries: Array<{ source: WorkspaceScopeEntry & { path: string }; result: StablePathReaderResult }>;
    hashedBytes: number;
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
    newLooseObjectCandidates?: Set<string>;
}

const StoreGitTimeoutMs = 30_000;
const BootstrapWaitTimeoutMs = 10_000;
const InitializationPromises = new Map<string, Promise<void>>();
const SnapshotFingerprints = new WeakMap<WorkspaceSnapshotStore, Map<string, FileFingerprint>>();
const TrustedSnapshotDescriptors = new WeakMap<WorkspaceSnapshotStore, Set<string>>();
const TrustedCommitSnapshots = new WeakMap<WorkspaceSnapshotStore, Set<string>>();
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
    readonly mutationLog: WorkspaceMutationLog;
    readonly quotaAccounting: SnapshotQuotaAccounting;

    private constructor(input: {
        storeRoot: string;
        identity: CanonicalWorkspaceIdentity;
        git: WorkspaceGitRunner;
        processOwner: ProcessOwnerIdentity;
        quotaAccounting: SnapshotQuotaAccounting;
    }) {
        this.storeRoot = input.storeRoot;
        this.identity = input.identity;
        this.git = input.git;
        this.processOwner = input.processOwner;
        this.quotaAccounting = input.quotaAccounting;
        this.mutationLock = new WorkspaceMutationLock({
            workspaceRoot: dirname(input.storeRoot),
            workspaceIdentity: input.identity.workspaceIdentity,
            workspaceIncarnation: input.identity.workspaceIncarnation,
            processOwner: input.processOwner,
        });
        this.mutationLog = new WorkspaceMutationLog({
            git: input.git,
            gitDir: input.storeRoot,
            workspaceIdentity: input.identity.workspaceIdentity,
            workspaceIncarnation: input.identity.workspaceIncarnation,
        });
        SnapshotFingerprints.set(this, new Map());
        TrustedSnapshotDescriptors.set(this, new Set());
        TrustedCommitSnapshots.set(this, new Set());
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
        const quotaAccounting = await SnapshotQuotaAccounting.open({
            storeRoot,
            maxBytes: WorkspaceCheckpointLimits.softQuotaBytes,
            generation: quotaGeneration(input.processOwner),
            measureExactUsage: () => measureExactStoreUsage(storeRoot, input.git),
        });
        const store = new WorkspaceSnapshotStore({ ...input, storeRoot, quotaAccounting });
        await store.withWorkspaceLock(async () => {
            await removeAbandonedObjectImports(storeRoot);
            await removeIncompletePublishedPacks(storeRoot);
            await removeStaleColdIndexes(storeRoot);
            quotaAccounting.markNeedsReconcile();
        });
        return store;
    }

    capture(options: CaptureWorkspaceOptions): Promise<{
        ref: WorkspaceSnapshotRefV1;
        coverage: WorkspaceSnapshotCoverage;
    }> {
        return this.withWorkspaceLock(async () => {
            const captured = await this.#captureFullReconcileUnlocked(options);
            const expectedHead = await this.mutationLog.readHead();
            if (expectedHead) {
                const current = await this.#readCommitSnapshotUnlocked(expectedHead);
                const metadata = await this.#readStoredManifest(current);
                if (
                    current.tree === captured.tree &&
                    canonicalJson({ scope: metadata.getScope(), coverage: metadata.getCoverage() }).equals(
                        canonicalJson({
                            scope: captured.scope,
                            coverage: withoutNewlyHashedBytes(captured.coverage),
                        })
                    )
                ) {
                    return { ref: current, coverage: captured.coverage };
                }
            }
            const prepared = await this.mutationLog.prepare({
                ...(expectedHead ? { expectedHead } : {}),
                tree: captured.tree,
                metadata: {
                    schemaversion: 1,
                    workspaceidentity: this.identity.workspaceIdentity,
                    workspaceincarnation: this.identity.workspaceIncarnation,
                    kind: "external",
                },
            });
            const ref = await this.#publishCommitSnapshotUnlocked({
                commit: prepared.commit,
                scope: captured.scope,
                coverage: withoutNewlyHashedBytes(captured.coverage),
            });
            return { ref, coverage: captured.coverage };
        });
    }

    captureFullReconcile(options: CaptureWorkspaceOptions): Promise<ReconciledWorkspaceState> {
        return this.withWorkspaceLock(() => this.#captureFullReconcileUnlocked(options));
    }

    captureGitBaseline(options: CaptureGitBaselineOptions): Promise<ReconciledWorkspaceState | undefined> {
        const owned = {
            ...options,
            sourceRoot: `${options.sourceRoot}`,
            sourceTree: `${options.sourceTree}`,
            candidatePaths: options.candidatePaths.map((path) => `${path}`),
        };
        return this.withWorkspaceLock(() => this.#captureGitBaselineUnlocked(owned));
    }

    withWorkspaceLock<T>(operation: () => Promise<T>): Promise<T> {
        return this.mutationLock.runExclusive(operation);
    }

    publishCommitSnapshot(input: {
        commit: string;
        scope: WorkspaceScopeManifest;
        coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
    }): Promise<WorkspaceSnapshotRefV1> {
        const owned = cloneCommitSnapshotInput(input);
        return this.withWorkspaceLock(() => this.#publishCommitSnapshotUnlocked(owned));
    }

    readCommitSnapshot(commit: string): Promise<WorkspaceSnapshotRefV1> {
        const ownedCommit = `${commit}`;
        return this.withWorkspaceLock(() => this.#readCommitSnapshotUnlocked(ownedCommit));
    }

    async #publishCommitSnapshotUnlocked(input: {
        commit: string;
        scope: WorkspaceScopeManifest;
        coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
    }): Promise<WorkspaceSnapshotRefV1> {
        const mutation = await this.mutationLog.read(input.commit);
        const runtime = makeMaintenanceRuntime();
        const storedManifest: StoredScopeManifest = {
            schemaversion: 3,
            workspaceidentity: this.identity.workspaceIdentity,
            workspaceincarnation: this.identity.workspaceIncarnation,
            scope: toStoredWorkspaceScope(input.scope),
            coverage: {
                complete: input.coverage.complete,
                eligibleentrycount: input.coverage.eligibleEntryCount,
                exclusions: input.coverage.exclusions.map(toStoredCoverageExclusion),
            },
        };
        const scopeManifest = await this.writeBlob(canonicalJson(storedManifest), runtime);
        const ref: WorkspaceSnapshotRefV1 = {
            id: input.commit,
            workspaceIdentity: this.identity.workspaceIdentity,
            workspaceIncarnation: this.identity.workspaceIncarnation,
            tree: mutation.tree,
            scopeManifest,
        };
        const manifest = await this.#readStoredManifestBlob(ref);
        if (manifest.manifest.schemaversion !== 3) {
            throw new Error("Commit-backed snapshot requires a v3 scope manifest");
        }
        // The mutation commit and tree were built inside this private store. Publication is a candidate-bound
        // hot path; recursive object/path/count validation belongs exclusively to explicit verify().
        await this.#ensureObjectsDurableUnlocked([ref.id, ref.tree, ref.scopeManifest], runtime);
        await this.#publishSnapshotAssociation(ref, ref.scopeManifest, runtime);
        markSnapshotTrusted(this, ref, true);
        return ref;
    }

    async #readCommitSnapshotUnlocked(commit: string): Promise<WorkspaceSnapshotRefV1> {
        const mutation = await this.mutationLog.read(commit);
        const association = await this.#readSnapshotAssociation(this.ownerRefName(commit));
        if (!association) throw new Error("Commit-backed snapshot association is missing");
        const ref: WorkspaceSnapshotRefV1 = {
            id: commit,
            workspaceIdentity: this.identity.workspaceIdentity,
            workspaceIncarnation: this.identity.workspaceIncarnation,
            tree: mutation.tree,
            scopeManifest: association,
        };
        const manifest = await this.#readStoredManifestBlob(ref);
        if (manifest.manifest.schemaversion !== 3) {
            throw new Error("Commit-backed snapshot association does not reference a v3 manifest");
        }
        // Association reconstruction is intentionally not a recursive integrity audit.
        return ref;
    }

    async #captureFullReconcileUnlocked(options: CaptureWorkspaceOptions): Promise<ReconciledWorkspaceState> {
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
            this.quotaAccounting.markNeedsReconcile();
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
                        observer: options.observer,
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
            await raceWithAbort(verifyCanonicalWorkspaceIdentity(this.identity), controller.signal);
            await this.#ensureObjectsDurableUnlocked([...runtime.objectIds], runtime);
            await raceWithAbort(verifyCanonicalWorkspaceIdentity(this.identity), controller.signal);
            SnapshotFingerprints.set(this, captured.fingerprints);
            return {
                tree: workspaceTree,
                scope: scope.manifest,
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

    async #captureGitBaselineUnlocked(
        options: CaptureGitBaselineOptions
    ): Promise<ReconciledWorkspaceState | undefined> {
        validateGitBaselineOptions(options);
        const timeoutMs = WorkspaceCheckpointLimits.terminalTimeoutMs;
        const deadline = Date.now() + timeoutMs;
        const controller = new AbortController();
        const onAbort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
        const timer = setTimeout(() => controller.abort(new Error("capture deadline exceeded")), timeoutMs);
        const runtime: CaptureRuntime = {
            deadline,
            signal: controller.signal,
            objectIds: new Set(),
        };
        try {
            if (options.sourceRoot !== this.identity.canonicalRoot) return undefined;
            await raceWithAbort(verifyCanonicalWorkspaceIdentity(this.identity), controller.signal);
            await assertNoShadowMutationFiles(this.storeRoot, runtime);
            const quotaStatus = await this.getQuotaStatus(runtime);
            if (quotaStatus.status !== "ok") {
                throw new WorkspaceSnapshotStoreError("quota_exceeded", "Workspace checkpoint quota exceeded", {
                    quotaStatus,
                });
            }
            const scope = await discoverWorkspaceScope({
                identity: this.identity,
                git: this.git,
                maxEntries: WorkspaceCheckpointLimits.maxEntries,
                maxUntrackedBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
                signal: controller.signal,
            });
            const sourceEntries = await this.readGitBaselineEntries(
                options.sourceRoot,
                options.sourceTree,
                options.sourceGit,
                runtime
            );
            if (!sourceEntries) return undefined;
            const attributePaths = await this.readGitBaselineAttributePaths(
                options.sourceRoot,
                sourceEntries,
                options.sourceGit,
                runtime
            );
            if (!attributePaths) return undefined;
            const projection = planGitBaselineProjection(scope, sourceEntries, [
                ...options.candidatePaths,
                ...attributePaths,
            ]);
            if (!projection) return undefined;
            const freeSpace = await assertFreeSpace(this.storeRoot, runtime);
            const maxPackBytes = calculateObjectClosurePackBudget(
                quotaStatus.softQuotaBytes - quotaStatus.usedBytes,
                freeSpace.availableBytes,
                freeSpace.requiredBytes
            );
            if (maxPackBytes == null) return undefined;
            try {
                await options.sourceGit.importObjectClosure({
                    sourceRoot: options.sourceRoot,
                    sourceTree: options.sourceTree,
                    destinationGitDir: this.storeRoot,
                    maxPackBytes,
                    timeoutMs: remainingTimeout(deadline),
                    signal: controller.signal,
                });
            } catch (error) {
                if (controller.signal.aborted) throw controller.signal.reason ?? error;
                if (error instanceof WorkspaceGitRunnerError) return undefined;
                throw error;
            }
            this.quotaAccounting.markNeedsReconcile();
            const captured = await this.captureEntries(
                { ...scope, entries: projection.captureEntries },
                WorkspaceCheckpointLimits.maxNewlyHashedBytes,
                runtime
            );
            const mutations = [...captured.entries, ...projection.absentEntries];
            await removeStaleColdIndexes(this.storeRoot);
            const indexFile = join(
                this.storeRoot,
                "journal",
                `${ColdIndexPrefix}${randomBytes(16).toString("hex")}.index`
            );
            let tree: string;
            try {
                const index = new ShadowWorkspaceIndex({ git: this.git, gitDir: this.storeRoot, indexFile });
                const indexOptions = {
                    timeoutMs: remainingTimeout(deadline),
                    signal: controller.signal,
                };
                await index.load(options.sourceTree, indexOptions);
                await index.apply(mutations, {
                    timeoutMs: remainingTimeout(deadline),
                    signal: controller.signal,
                });
                tree = await index.writeTree({
                    timeoutMs: remainingTimeout(deadline),
                    signal: controller.signal,
                });
            } finally {
                await removeColdIndex(indexFile);
            }
            const validatedAttributePaths = await this.readGitBaselineAttributePaths(
                options.sourceRoot,
                sourceEntries,
                options.sourceGit,
                runtime
            );
            if (!validatedAttributePaths || !samePaths(attributePaths, validatedAttributePaths)) {
                throw new WorkspaceSnapshotStoreError("unstable_file", "Git attributes changed during cold capture");
            }
            if (!(await verifyWorkspaceScopeDirectories(scope, controller.signal))) {
                throw new WorkspaceSnapshotStoreError(
                    "unstable_file",
                    "Workspace directories changed during cold capture"
                );
            }
            await this.#ensureObjectsDurableUnlocked([...runtime.objectIds], runtime);
            await raceWithAbort(verifyCanonicalWorkspaceIdentity(this.identity), controller.signal);
            SnapshotFingerprints.set(this, captured.fingerprints);
            return {
                tree,
                scope: scope.manifest,
                coverage: { ...scope.coverage, newlyHashedBytes: captured.newlyHashedBytes },
            };
        } catch (error) {
            if (controller.signal.aborted && !options.signal?.aborted) {
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

    async readGitBaselineEntries(
        sourceRoot: string,
        sourceTree: string,
        sourceGit: WorkspaceGitRunner,
        runtime: CaptureRuntime
    ): Promise<GitBaselineTreeEntry[] | undefined> {
        try {
            const result = await sourceGit.run(["ls-tree", "-r", "-z", "--full-tree", sourceTree], {
                cwd: sourceRoot,
                timeoutMs: remainingTimeout(runtime.deadline),
                signal: runtime.signal,
            });
            if (result.stderr.length !== 0) return undefined;
            return parseGitBaselineTreeEntries(result.stdout);
        } catch (error) {
            if (runtime.signal.aborted) throw runtime.signal.reason ?? error;
            return undefined;
        }
    }

    async readGitBaselineAttributePaths(
        sourceRoot: string,
        sourceEntries: readonly GitBaselineTreeEntry[],
        sourceGit: WorkspaceGitRunner,
        runtime: CaptureRuntime
    ): Promise<string[] | undefined> {
        let autocrlf = "false";
        try {
            const configured = await sourceGit.run(["config", "--get-all", "core.autocrlf"], {
                cwd: sourceRoot,
                timeoutMs: remainingTimeout(runtime.deadline),
                signal: runtime.signal,
                maxStdoutBytes: 1024,
                effectiveConfig: true,
            });
            autocrlf = configured.stdout.toString("utf8").trim().toLowerCase();
        } catch (error) {
            if (runtime.signal.aborted) throw runtime.signal.reason ?? error;
            if (!(error instanceof WorkspaceGitRunnerError) || error.code !== "nonzero_exit") return undefined;
        }
        if (autocrlf !== "false") return sourceEntries.map((entry) => entry.path);
        if (sourceEntries.length === 0) return [];
        try {
            const attributes = await sourceGit.run(["check-attr", "-z", "--stdin", "--all"], {
                cwd: sourceRoot,
                stdin: Buffer.concat(sourceEntries.map((entry) => Buffer.from(`${entry.path}\0`))),
                timeoutMs: remainingTimeout(runtime.deadline),
                signal: runtime.signal,
                effectiveConfig: true,
            });
            if (attributes.stderr.length !== 0) return undefined;
            return parseUnsafeGitAttributePaths(attributes.stdout, new Set(sourceEntries.map((entry) => entry.path)));
        } catch (error) {
            if (runtime.signal.aborted) throw runtime.signal.reason ?? error;
            return undefined;
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
            const rawChanges = await this.#readRawTreeDelta(before.tree, after.tree);
            const rawByPath = new Map(rawChanges.map((change) => [change.path, change]));
            const beforeExclusions = manifestPathExclusionPaths(beforeManifest);
            const afterExclusions = manifestPathExclusionPaths(afterManifest);
            const paths = new Set([...rawByPath.keys(), ...beforeExclusions.keys(), ...afterExclusions.keys()]);
            const changes: WorkspacePathChangeV1[] = [];
            for (const path of [...paths].sort(comparePathBytes)) {
                const raw = rawByPath.get(path);
                const beforeState = await mergeRawTreeState(raw?.before, beforeManifest, path);
                const afterState = await mergeRawTreeState(raw?.after, afterManifest, path);
                if (canonicalJson(beforeState).equals(canonicalJson(afterState))) continue;
                changes.push({ path, before: beforeState, after: afterState });
            }
            return changes;
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
            return await this.#readPathStateFromManifest(snapshot, manifest, path);
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
            const manifest = await this.#readStoredManifest(snapshot, signal);
            const entry = await this.#readWorkspacePathEntry(snapshot.tree, path, signal);
            if (!entry) {
                await manifest.readCoveragePathState(path);
                return "absent";
            }
            return entry.kind;
        } catch (cause) {
            if (signal?.aborted) throw signal.reason ?? cause;
            throw asCorruptSnapshot(cause);
        }
    }

    async readNodeKinds(
        snapshot: WorkspaceSnapshotRefV1,
        paths: readonly string[],
        signal?: AbortSignal
    ): Promise<ReadonlyMap<string, "absent" | "leaf" | "tree">> {
        for (const path of paths) validateRelativePath(path);
        try {
            if (signal?.aborted) throw signal.reason;
            const manifest = await this.#readStoredManifest(snapshot, signal);
            const uniquePaths = [...new Set(paths)];
            const entries = await this.#readWorkspacePathEntries(snapshot.tree, uniquePaths, signal);
            const kinds = new Map<string, "absent" | "leaf" | "tree">();
            for (const path of uniquePaths) {
                if (signal?.aborted) throw signal.reason;
                const entry = entries.get(path);
                if (!entry) await manifest.readCoveragePathState(path);
                kinds.set(path, entry?.kind ?? "absent");
            }
            return kinds;
        } catch (cause) {
            if (signal?.aborted) throw signal.reason ?? cause;
            throw asCorruptSnapshot(cause);
        }
    }

    async #readWorkspacePathEntries(
        tree: string,
        paths: readonly string[],
        signal?: AbortSignal
    ): Promise<ReadonlyMap<string, WorkspaceTreePathEntry>> {
        const expectedObjectTypes = new Map<string, "blob" | "tree">();
        const results = new Map<string, WorkspaceTreePathEntry>();
        const byDepth = new Map<number, string[]>();
        for (const path of paths) {
            const depth = path.split("/").length;
            const group = byDepth.get(depth) ?? [];
            group.push(path);
            byDepth.set(depth, group);
        }
        for (const group of byDepth.values()) {
            for (const chunk of chunkCandidateLookupPaths(group)) {
                if (signal?.aborted) throw signal.reason;
                const requested = new Set(chunk);
                const result = await this.git.run(
                    ["ls-tree", "-z", "--full-tree", tree, "--", ...chunk.map((path) => `:(literal)${path}`)],
                    {
                        gitDir: this.storeRoot,
                        timeoutMs: StoreGitTimeoutMs,
                        maxStdoutBytes: QuotaMaxObjectOutputBytes,
                        signal,
                        pathspecMode: "literal-magic",
                    }
                );
                for (const [path, entry] of parseNulLsTreeEntries(result.stdout, requested)) {
                    const converted = workspaceTreePathEntry(entry);
                    const expectedType = converted.kind === "tree" ? "tree" : "blob";
                    const previousType = expectedObjectTypes.get(entry.oid);
                    if (previousType && previousType !== expectedType) {
                        throw new Error("Workspace tree object has conflicting types");
                    }
                    expectedObjectTypes.set(entry.oid, expectedType);
                    if (results.has(path)) throw new Error("Git returned a duplicate candidate path");
                    results.set(path, converted);
                }
            }
        }
        if (expectedObjectTypes.size > 0) {
            const expected = [...expectedObjectTypes].map(([oid, type]) => ({ oid, type }));
            const objectInfo = await this.git.run(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
                gitDir: this.storeRoot,
                stdin: Buffer.from(`${expected.map((item) => item.oid).join("\n")}\n`),
                timeoutMs: StoreGitTimeoutMs,
                maxStdoutBytes: QuotaMaxObjectOutputBytes,
                signal,
            });
            assertBatchObjectTypes(objectInfo.stdout, expected);
        }
        return results;
    }

    async #readPathStateFromManifest(
        snapshot: WorkspaceSnapshotRefV1,
        manifest: StoredManifestReader,
        path: string
    ): Promise<CapturedPathStateV1> {
        const entry = await this.#readWorkspacePathEntry(snapshot.tree, path);
        if (!entry || entry.kind === "tree") return await manifest.readCoveragePathState(path);
        return entry.state;
    }

    async #readWorkspacePathEntry(
        tree: string,
        path: string,
        signal?: AbortSignal
    ): Promise<
        | { kind: "tree" }
        | { kind: "leaf"; state: Extract<CapturedPathStateV1, { state: "file" | "symlink" }> }
        | undefined
    > {
        const segments = path.split("/");
        let treeOid = tree;
        let entry: { mode: string; oid: string } | undefined;
        for (let index = 0; index < segments.length; index++) {
            const result = await this.git.run(["cat-file", "tree", treeOid], {
                gitDir: this.storeRoot,
                timeoutMs: StoreGitTimeoutMs,
                signal,
            });
            entry = parseRawTreeEntries(result.stdout, treeOid.length / 2).get(segments[index]!);
            if (!entry) return undefined;
            if (index < segments.length - 1) {
                if (entry.mode !== "40000") return undefined;
                treeOid = entry.oid;
            }
        }
        if (!entry) return undefined;
        if (entry.mode !== "40000" && entry.mode !== "100644" && entry.mode !== "100755" && entry.mode !== "120000") {
            throw new Error("Workspace tree path has an invalid mode");
        }
        const type = await this.git.run(["cat-file", "-t", entry.oid], {
            gitDir: this.storeRoot,
            timeoutMs: StoreGitTimeoutMs,
            maxStdoutBytes: 16,
            signal,
        });
        const expectedType = entry.mode === "40000" ? "tree" : "blob";
        if (!type.stdout.equals(Buffer.from(`${expectedType}\n`))) {
            if (expectedType === "tree") throw new Error("Workspace tree path is missing or is not a tree");
            throw new Error("Workspace tree leaf is missing or is not a blob");
        }
        if (entry.mode === "40000") return { kind: "tree" };
        if (entry.mode === "120000") {
            return { kind: "leaf", state: { state: "symlink", oid: entry.oid } };
        }
        return {
            kind: "leaf",
            state: { state: "file", oid: entry.oid, executable: entry.mode === "100755" },
        };
    }

    async #readTreeDelta(
        beforeTree: string,
        afterTree: string
    ): Promise<{ paths: string[]; eligibleEntryDelta: number }> {
        if (beforeTree === afterTree) return { paths: [], eligibleEntryDelta: 0 };
        const result = await this.git.run(
            ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--no-renames", beforeTree, afterTree],
            { gitDir: this.storeRoot, timeoutMs: StoreGitTimeoutMs }
        );
        return parseNulWorkspaceTreeDelta(result.stdout);
    }

    async #readRawTreeDelta(beforeTree: string, afterTree: string): Promise<WorkspaceRawTreeDeltaEntry[]> {
        if (beforeTree === afterTree) return [];
        if (beforeTree.length !== afterTree.length) throw new Error("Workspace tree object formats do not match");
        const result = await this.git.run(
            ["diff-tree", "--no-commit-id", "--raw", "-r", "-z", "--no-renames", "--no-abbrev", beforeTree, afterTree],
            { gitDir: this.storeRoot, timeoutMs: StoreGitTimeoutMs, maxStdoutBytes: QuotaMaxObjectOutputBytes }
        );
        const entries = parseNulWorkspaceRawTreeDelta(result.stdout, beforeTree.length);
        const objectIds = [
            ...new Set(
                entries.flatMap((entry) =>
                    [entry.before, entry.after]
                        .filter(
                            (state): state is Extract<CapturedPathStateV1, { state: "file" | "symlink" }> =>
                                state.state === "file" || state.state === "symlink"
                        )
                        .map((state) => state.oid)
                )
            ),
        ];
        if (objectIds.length > 0) {
            const expected = objectIds.map((oid) => ({ oid, type: "blob" as const }));
            const objectInfo = await this.git.run(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
                gitDir: this.storeRoot,
                stdin: Buffer.from(`${objectIds.join("\n")}\n`),
                timeoutMs: StoreGitTimeoutMs,
                maxStdoutBytes: QuotaMaxObjectOutputBytes,
            });
            assertBatchObjectTypes(objectInfo.stdout, expected);
        }
        return entries;
    }

    readSnapshotMetadata(snapshot: WorkspaceSnapshotRefV1): Promise<{
        scope: WorkspaceScopeManifest;
        coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
    }> {
        return this.withWorkspaceLock(async () => {
            const manifest = await this.#readStoredManifest(snapshot);
            const coverage = manifest.getCoverage();
            return {
                scope: manifest.getScope(),
                coverage: {
                    complete: coverage.complete,
                    eligibleEntryCount: coverage.eligibleEntryCount,
                    exclusions: coverage.exclusions.map(cloneCoverageExclusion),
                },
            };
        });
    }

    computeCandidateSnapshotCoverage(
        snapshot: WorkspaceSnapshotRefV1,
        candidateTree: string,
        entries: WorkspaceCandidatePathEntry[]
    ): Promise<Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">> {
        const ownedEntries = normalizeWorkspaceCandidateEntries(entries);
        return this.withWorkspaceLock(async () => {
            const manifest = await this.#readStoredManifest(snapshot);
            const coverage = manifest.getCoverage();
            const { eligibleEntryDelta } = await this.#readTreeDelta(snapshot.tree, candidateTree);
            return deriveCandidateCoverage(coverage, ownedEntries, eligibleEntryDelta);
        });
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
            // A V3 ref created or fully audited in this process is immutable; repeated owner checks only need
            // the association CAS authority.
            if (isTrustedCommitSnapshot(this, snapshot)) {
                this.assertSnapshotIdentity(snapshot);
                await this.#assertSnapshotOwnerRef(snapshot, true);
                return;
            }
            await this.#verifyUnlocked(snapshot);
            await this.#assertSnapshotOwnerRef(snapshot, isTrustedCommitSnapshot(this, snapshot));
        });
    }

    async #assertSnapshotOwnerRef(snapshot: WorkspaceSnapshotRefV1, _trustedCommitSnapshot = false): Promise<void> {
        const expected = snapshot.scopeManifest;
        const owner = await this.#readSnapshotAssociation(this.ownerRefName(snapshot.id));
        if (owner !== expected) {
            throw new Error("Workspace snapshot owner ref is missing or changed");
        }
    }

    measureSnapshotUsage(snapshots: readonly WorkspaceSnapshotRefV1[]): Promise<number> {
        return this.withWorkspaceLock(async () => {
            const roots = new Set<string>();
            for (const snapshot of snapshots) {
                this.assertSnapshotIdentity(snapshot);
                roots.add(snapshot.id);
                roots.add(snapshot.scopeManifest);
            }
            return await this.#objectBytesForRoots([...roots], makeMaintenanceRuntime());
        });
    }

    async #verifyUnlocked(snapshot: WorkspaceSnapshotRefV1): Promise<void> {
        try {
            this.assertSnapshotIdentity(snapshot);
            const manifest = await this.#readStoredManifest(snapshot);
            await this.verifyWorkspaceTree(snapshot, manifest);
            markSnapshotTrusted(this, snapshot, true);
        } catch (cause) {
            throw asCorruptSnapshot(cause);
        }
    }

    anchorSnapshot(ref: WorkspaceSnapshotRefV1, runtime = makeMaintenanceRuntime()): Promise<void> {
        return this.withWorkspaceLock(() => this.#anchorSnapshotUnlocked(ref, runtime));
    }

    async #anchorSnapshotUnlocked(ref: WorkspaceSnapshotRefV1, runtime = makeMaintenanceRuntime()): Promise<void> {
        this.assertSnapshotIdentity(ref);
        await this.#ensureObjectsDurableUnlocked([ref.id, ref.tree, ref.scopeManifest], runtime);
        await this.#readStoredManifest(ref, runtime.signal);
        await this.#publishSnapshotAssociation(ref, ref.scopeManifest, runtime);
    }

    async #publishSnapshotAssociation(
        ref: WorkspaceSnapshotRefV1,
        target: string,
        runtime: CaptureRuntime
    ): Promise<void> {
        const refName = this.ownerRefName(ref.id);
        const objectRefName = this.snapshotObjectRefName(ref.id);
        const previousObject = await this.#readSnapshotObjectAnchor(objectRefName, runtime);
        if (previousObject != null && previousObject !== ref.id) {
            throw new Error("Workspace snapshot object anchor conflicts with an existing value");
        }
        const previous = await this.#readSnapshotAssociation(refName, runtime);
        if (previous != null && previous !== target) {
            throw new Error("Workspace snapshot manifest association conflicts with an existing value");
        }
        const commands = [
            "start",
            `update ${objectRefName} ${ref.id} ${previousObject ?? "0".repeat(ref.id.length)}`,
            `update ${refName} ${target} ${previous ?? "0".repeat(target.length)}`,
            "prepare",
            "commit",
            "",
        ];
        await this.git.run(["update-ref", "--no-deref", "--stdin"], {
            gitDir: this.storeRoot,
            stdin: Buffer.from(commands.join("\n")),
            timeoutMs: remainingTimeout(runtime.deadline),
            signal: runtime.signal,
        });
        await secureCaptureArtifacts(this.storeRoot, runtime.objectIds, refName, runtime);
    }

    async #readSnapshotObjectAnchor(refName: string, runtime = makeMaintenanceRuntime()): Promise<string | undefined> {
        validateSnapshotObjectRefName(refName);
        const result = await this.git.run(["for-each-ref", "--format=%(objectname)", "--count=2", refName], {
            gitDir: this.storeRoot,
            timeoutMs: remainingTimeout(runtime.deadline),
            maxStdoutBytes: 256,
            signal: runtime.signal,
        });
        if (result.stdout.length === 0) return undefined;
        return parseOid(result.stdout);
    }

    async #readSnapshotAssociation(refName: string, runtime = makeMaintenanceRuntime()): Promise<string | undefined> {
        validateCrestRefName(refName);
        await assertNoSymlinkRefPath(this.storeRoot, refName);
        const result = await this.git.run(
            ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", "--count=2", refName],
            {
                gitDir: this.storeRoot,
                timeoutMs: remainingTimeout(runtime.deadline),
                maxStdoutBytes: 1024,
                signal: runtime.signal,
            }
        );
        await assertNoSymlinkRefPath(this.storeRoot, refName);
        if (result.stdout.length === 0) return undefined;
        let association: string | undefined;
        for (const line of splitLines(result.stdout)) {
            const fields = line.split("\0");
            if (fields.length !== 3) throw new Error("Invalid workspace snapshot association ref");
            if (fields[0] !== refName) continue;
            if (fields[2]) throw new Error("Workspace snapshot association must not be symbolic");
            validateOid(fields[1]!);
            if (association) throw new Error("Duplicate workspace snapshot association ref");
            association = fields[1];
        }
        return association;
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
            const snapshot = /^refs\/crest\/snapshots\/([0-9a-f]{40})$/.exec(ref.name);
            if (snapshot) {
                const anchorName = this.snapshotObjectRefName(snapshot[1]!);
                const anchor = await this.#readSnapshotObjectAnchor(anchorName);
                if (anchor) commands.push(`delete ${anchorName} ${anchor}`);
            }
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
        const result = await this.git.run(
            [
                "for-each-ref",
                "--format=%(refname)%00%(objectname)",
                "refs/crest/snapshots",
                "refs/crest/pending",
                "refs/crest/ops",
            ],
            {
                gitDir: this.storeRoot,
                timeoutMs: StoreGitTimeoutMs,
                maxStdoutBytes: QuotaMaxRefOutputBytes,
            }
        );
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

    /** Caller must already own this store's workspace lock. */
    reconcileQuotaAccountingAssumingLock(): Promise<number> {
        return this.quotaAccounting.reconcileExactUsage();
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
        await this.quotaAccounting.replaceExactUsage(usedBytes);
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
        const refs = await this.git.run(
            ["for-each-ref", "--format=%(objectname)", "refs/crest", "refs/crest-objects"],
            {
                gitDir: this.storeRoot,
                timeoutMs: remainingTimeout(runtime.deadline),
                maxStdoutBytes: QuotaMaxRefOutputBytes,
                signal: runtime.signal,
            }
        );
        const roots = [...new Set(splitLines(refs.stdout))];
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
            let capturedGroups: CapturedStablePathGroup[] = [];
            let stagedPathCount = 0;
            let stagedInputBytes = 0;
            let stagedBytes = 0;
            const flush = async () => {
                if (capturedGroups.length === 0) return;
                const staged = capturedGroups.flatMap((group) =>
                    group.entries.filter(
                        (
                            entry
                        ): entry is typeof entry & {
                            result: StablePathReaderResult & { stagingPath: string };
                        } => entry.result.stagingPath != null
                    )
                );
                const stagedOids = await this.hashStagedPaths(
                    staged.map((entry) => entry.result.stagingPath),
                    runtime
                );
                const oidByStagingPath = new Map(
                    staged.map((entry, index) => [entry.result.stagingPath, stagedOids[index]!])
                );
                for (const group of capturedGroups) {
                    for (const { source, result } of group.entries) {
                        const oid = result.reusedOid ?? oidByStagingPath.get(result.stagingPath!)!;
                        const identity = deserializeFingerprint(result.identity, oid);
                        states.set(
                            result.path,
                            source.kind === "symlink"
                                ? { state: "symlink", oid }
                                : { state: "file", oid, executable: (identity.mode & 0o111n) !== 0n }
                        );
                        if (source.kind === "file") fingerprints.set(result.path, identity);
                    }
                    await rm(group.stagingRoot, { recursive: true, force: true });
                }
                capturedGroups = [];
                stagedPathCount = 0;
                stagedInputBytes = 0;
                stagedBytes = 0;
            };
            for (const [parent, group] of groups) {
                for (const entryChunk of chunkStableCaptureEntries(group)) {
                    const captured = await this.captureStablePathGroup(
                        parent,
                        entryChunk,
                        stagingRoot,
                        maxNewlyHashedBytes - newlyHashedBytes,
                        runtime
                    );
                    const stagedPaths = captured.entries.flatMap((entry) =>
                        entry.result.stagingPath == null ? [] : [entry.result.stagingPath]
                    );
                    const inputBytes = stagedPaths.reduce((total, path) => total + Buffer.byteLength(path) + 1, 0);
                    if (
                        capturedGroups.length > 0 &&
                        (stagedPathCount + stagedPaths.length > StagedHashMaxPaths ||
                            stagedInputBytes + inputBytes > StagedHashMaxInputBytes ||
                            stagedBytes + captured.hashedBytes > StagedCaptureMaxBytes)
                    ) {
                        await flush();
                    }
                    newlyHashedBytes += captured.hashedBytes;
                    capturedGroups.push(captured);
                    stagedPathCount += stagedPaths.length;
                    stagedInputBytes += inputBytes;
                    stagedBytes += captured.hashedBytes;
                }
            }
            await flush();
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

    async captureStablePathGroup(
        parent: string,
        entries: WorkspaceScopeEntry[],
        stagingRoot: string,
        remainingByteBudget: number,
        runtime: CaptureRuntime
    ): Promise<CapturedStablePathGroup> {
        let currentEntries = entries;
        for (let attempt = 0; attempt < 2; attempt++) {
            assertCaptureActive(runtime.deadline, runtime.signal);
            const attemptRoot = await mkdtemp(join(stagingRoot, "group-"));
            await securePathWithHandle(attemptRoot, 0o700, "directory");
            let captured: CapturedStablePathGroup | undefined;
            let failure: unknown;
            try {
                const result = await this.captureStablePathGroupAttempt(
                    parent,
                    currentEntries,
                    attemptRoot,
                    remainingByteBudget,
                    runtime
                );
                captured = { ...result, stagingRoot: attemptRoot };
            } catch (error) {
                failure = error;
            } finally {
                if (!captured) await rm(attemptRoot, { recursive: true, force: true });
            }
            if (captured) {
                return captured;
            }
            if (failure instanceof StablePathReaderError && failure.code === "unstable_file" && attempt === 0) {
                currentEntries = await this.refreshStablePathGroupEvidence(parent, currentEntries, runtime);
                continue;
            }
            throw asSnapshotCaptureError(failure);
        }
        throw new WorkspaceSnapshotStoreError("unstable_file", "Workspace group remained unstable after retry");
    }

    async captureStablePathGroupAttempt(
        parent: string,
        entries: WorkspaceScopeEntry[],
        stagingRoot: string,
        remainingByteBudget: number,
        runtime: CaptureRuntime
    ): Promise<{
        entries: Array<{ source: WorkspaceScopeEntry & { path: string }; result: StablePathReaderResult }>;
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
        const requests: StablePathReaderEntry[] = entries.map((entry, index) => ({
            path: entry.path!,
            name: basename(entry.path!),
            kind: entry.kind as "file" | "symlink",
            identity: serializeScopeIdentity(entry.entryIdentity!),
            stagingPath: join(stagingRoot, `${index}-${randomBytes(12).toString("hex")}`),
            ...(previous.has(entry.path!) ? { previous: serializeFingerprint(previous.get(entry.path!)!) } : {}),
        }));
        const results = await runStablePathReader({
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
        const sources = new Map(entries.map((entry) => [entry.path!, entry]));
        return {
            hashedBytes: results.reduce((total, result) => total + result.hashedBytes, 0),
            entries: results.map((result) => ({
                source: sources.get(result.path)! as WorkspaceScopeEntry & { path: string },
                result,
            })),
        };
    }

    async refreshStablePathGroupEvidence(
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
        const oids: string[] = [];
        for (const chunk of chunkStagedHashPaths(paths)) {
            const result = await this.git.run(["hash-object", "-w", "--stdin-paths", "--no-filters"], {
                gitDir: this.storeRoot,
                stdin: Buffer.from(`${chunk.join("\n")}\n`),
                timeoutMs: remainingTimeout(runtime.deadline),
                signal: runtime.signal,
            });
            const chunkOids = splitLines(result.stdout);
            if (chunkOids.length !== chunk.length) {
                throw new Error("Git returned an invalid staged object count");
            }
            for (const oid of chunkOids) {
                validateOid(oid);
                runtime.objectIds.add(oid);
            }
            oids.push(...chunkOids);
        }
        return oids;
    }

    async writeBlob(bytes: Buffer, runtime: CaptureRuntime): Promise<string> {
        const expectedOid = await prepareQuotaObjectWrite(this.storeRoot, "blob", bytes, runtime);
        const result = await this.git.run(["hash-object", "-w", "--stdin", "--no-filters"], {
            gitDir: this.storeRoot,
            stdin: bytes,
            timeoutMs: remainingTimeout(runtime.deadline),
            signal: runtime.signal,
        });
        const oid = parseOid(result.stdout);
        if (expectedOid && oid !== expectedOid) throw new Error("Git wrote an unexpected snapshot blob");
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
        const expectedOid = await prepareQuotaObjectWrite(this.storeRoot, "tree", makeTreeObject(records), runtime);
        const result = await this.git.run(["mktree", "-z"], {
            gitDir: this.storeRoot,
            stdin,
            timeoutMs: remainingTimeout(runtime.deadline),
            signal: runtime.signal,
        });
        const oid = parseOid(result.stdout);
        if (expectedOid && oid !== expectedOid) throw new Error("Git wrote an unexpected snapshot tree");
        runtime.objectIds.add(oid);
        return oid;
    }

    async #readStoredManifest(snapshot: WorkspaceSnapshotRefV1, signal?: AbortSignal): Promise<StoredManifestReader> {
        try {
            this.assertSnapshotIdentity(snapshot);
            const manifest = await this.#readStoredManifestBlob(snapshot, signal);
            const mutation = await this.mutationLog.read(snapshot.id);
            if (mutation.tree !== snapshot.tree) {
                throw new Error("Commit-backed snapshot tree does not match its mutation commit");
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
        const coverage = manifest.manifest.coverage;
        if (coverage.eligibleentrycount !== actual.size) {
            throw new Error("Commit-backed snapshot coverage does not match its workspace tree");
        }
        if (coverage.complete !== (coverage.exclusions.length === 0)) {
            throw new Error("Commit-backed snapshot coverage completeness is inconsistent");
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
        };
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
            validateRelativePath(path);
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

    snapshotObjectRefName(snapshotId: string): string {
        validateOid(snapshotId);
        return `refs/crest-objects/snapshots/${snapshotId}`;
    }

    pendingRefName(record: Pick<PendingWorkspaceBoundaryV1, "sessionId" | "boundaryToken">): string {
        validateRefToken(record.boundaryToken, "boundary token");
        const sessionHash = createHash("sha256").update(record.sessionId, "utf8").digest("hex");
        return `refs/crest/pending/${sessionHash}/${record.boundaryToken}`;
    }
}

async function assertNoSymlinkRefPath(storeRoot: string, refName: string): Promise<void> {
    let cursor = storeRoot;
    for (const segment of refName.split("/")) {
        cursor = join(cursor, segment);
        try {
            const state = await lstat(cursor);
            if (state.isSymbolicLink()) {
                throw new Error("Workspace snapshot association path must not contain a symlink");
            }
        } catch (error) {
            if (isCode(error, "ENOENT")) return;
            throw error;
        }
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

async function removeAbandonedObjectImports(storeRoot: string): Promise<void> {
    const objects = join(storeRoot, "objects");
    const entries = await readdir(objects, { withFileTypes: true });
    let removed = false;
    for (const entry of entries) {
        if (!/^crest-object-import-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
        const path = join(objects, entry.name);
        const state = await lstat(path);
        if (!entry.isDirectory() || state.isSymbolicLink()) {
            throw new Error("Unsafe object-import staging path");
        }
        await rm(path, { recursive: true, force: true });
        removed = true;
    }
    if (removed) await syncDirectory(objects);
}

async function removeIncompletePublishedPacks(storeRoot: string): Promise<void> {
    const packRoot = join(storeRoot, "objects", "pack");
    const entries = await readdir(packRoot, { withFileTypes: true });
    const families = new Map<string, Map<string, string>>();
    for (const entry of entries) {
        const match = /^pack-([0-9a-f]{40})\.(pack|idx|rev)$/.exec(entry.name);
        if (!match) continue;
        const path = join(packRoot, entry.name);
        const state = await lstat(path);
        if (!entry.isFile() || state.isSymbolicLink()) throw new Error("Unsafe published pack path");
        const family = families.get(match[1]!) ?? new Map<string, string>();
        family.set(match[2]!, path);
        families.set(match[1]!, family);
    }
    let removed = false;
    for (const family of families.values()) {
        const hasPack = family.has("pack");
        const hasIndex = family.has("idx");
        if (hasPack && hasIndex) continue;
        for (const path of family.values()) await unlink(path);
        removed = true;
    }
    if (removed) await syncDirectory(packRoot);
}

async function removeStaleColdIndexes(storeRoot: string): Promise<void> {
    const journal = join(storeRoot, "journal");
    const entries = await readdir(journal, { withFileTypes: true });
    for (const entry of entries) {
        if (!new RegExp(`^${ColdIndexPrefix}[0-9a-f]{32}\\.index(?:\\.lock)?$`).test(entry.name)) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error("Unsafe stale cold index path");
        await unlink(join(journal, entry.name));
    }
}

async function removeColdIndex(indexFile: string): Promise<void> {
    await unlink(indexFile).catch(ignoreMissing);
    await unlink(`${indexFile}.lock`).catch(ignoreMissing);
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
    if (error instanceof StablePathReaderError && error.code === "capture_budget") {
        return new WorkspaceSnapshotStoreError("capture_budget", error.message, { cause: error });
    }
    if (error instanceof StablePathReaderError && error.code === "unstable_file") {
        return new WorkspaceSnapshotStoreError("unstable_file", error.message, { cause: error });
    }
    return error instanceof Error ? error : new Error("Workspace group capture failed", { cause: error });
}

function serializeScopeIdentity(value: WorkspaceScopeEntryIdentity): StablePathReaderEntryIdentity {
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

function serializeFingerprint(value: FileFingerprint): StablePathReaderEntryIdentity & { oid: string } {
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

function deserializeFingerprint(value: StablePathReaderEntryIdentity, oid: string): FileFingerprint {
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

function makeTreeObject(records: Array<{ name: string; mode: string; type: string; oid: string }>): Buffer {
    const sorted = [...records].sort((left, right) =>
        Buffer.compare(
            Buffer.from(`${left.name}${left.type === "tree" ? "/" : ""}`),
            Buffer.from(`${right.name}${right.type === "tree" ? "/" : ""}`)
        )
    );
    return Buffer.concat(
        sorted.map((record) =>
            Buffer.concat([
                Buffer.from(`${record.mode.replace(/^0/, "")} ${record.name}\0`),
                Buffer.from(record.oid, "hex"),
            ])
        )
    );
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

interface WorkspaceFreeSpaceEvidence {
    availableBytes: bigint;
    requiredBytes: bigint;
}

async function assertFreeSpace(path: string, runtime: CaptureRuntime): Promise<WorkspaceFreeSpaceEvidence> {
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
    return { availableBytes, requiredBytes };
}

export function calculateObjectClosurePackBudget(
    quotaRemainingBytes: number,
    availableBytes: bigint,
    requiredFreeBytes: bigint
): number | undefined {
    if (!Number.isSafeInteger(quotaRemainingBytes) || quotaRemainingBytes < 0) return undefined;
    const reserve = BigInt(ObjectClosureOverlayReserveBytes);
    const quotaBudget = BigInt(quotaRemainingBytes) - reserve;
    const filesystemBudget = availableBytes - requiredFreeBytes - reserve;
    const budget = quotaBudget < filesystemBudget ? quotaBudget : filesystemBudget;
    return budget > 0n ? Number(budget) : undefined;
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

function validateGitBaselineOptions(options: CaptureGitBaselineOptions): void {
    if (
        !options ||
        !isAbsolute(options.sourceRoot) ||
        !(options.sourceGit instanceof WorkspaceGitRunner) ||
        !Array.isArray(options.candidatePaths)
    ) {
        throw new Error("Invalid Git baseline options");
    }
    validateOid(options.sourceTree);
    for (const path of options.candidatePaths) validateRelativePath(path);
}

function parseGitBaselineTreeEntries(value: Buffer): GitBaselineTreeEntry[] {
    if (value.length === 0) return [];
    if (value.at(-1) !== 0) throw new Error("Invalid Git baseline tree listing");
    const entries: GitBaselineTreeEntry[] = [];
    const seen = new Set<string>();
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] !== 0) continue;
        const record = value.subarray(start, index);
        const tab = record.indexOf(0x09);
        if (tab < 0) throw new Error("Invalid Git baseline tree entry");
        const header = /^(\d{6}) blob ([0-9a-f]{40})$/.exec(record.subarray(0, tab).toString("ascii"));
        if (!header) throw new Error("Invalid Git baseline tree entry");
        const pathBytes = record.subarray(tab + 1);
        const path = pathBytes.toString("utf8");
        if (!Buffer.from(path).equals(pathBytes)) throw new Error("Git baseline path is not UTF-8");
        validateRelativePath(path);
        if (seen.has(path)) throw new Error("Duplicate Git baseline tree path");
        seen.add(path);
        entries.push({
            path,
            mode: header[1] as GitBaselineTreeEntry["mode"],
            oid: header[2]!,
        });
        start = index + 1;
    }
    return entries;
}

function parseUnsafeGitAttributePaths(value: Buffer, expectedPaths: ReadonlySet<string>): string[] {
    if (value.length === 0) return [];
    if (value.at(-1) !== 0) throw new Error("Invalid Git attribute output");
    const fields: Buffer[] = [];
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] !== 0) continue;
        fields.push(value.subarray(start, index));
        start = index + 1;
    }
    if (fields.length % 3 !== 0) throw new Error("Invalid Git attribute output");
    const unsafe = new Set<string>();
    for (let index = 0; index < fields.length; index += 3) {
        const pathBytes = fields[index]!;
        const path = pathBytes.toString("utf8");
        if (!Buffer.from(path).equals(pathBytes) || !expectedPaths.has(path)) {
            throw new Error("Invalid Git attribute path");
        }
        const attribute = fields[index + 1]!.toString("utf8");
        const attributeValue = fields[index + 2]!.toString("utf8");
        if (GitUnsafeAttributes.has(attribute) && attributeValue !== "unspecified" && attributeValue !== "unset") {
            unsafe.add(path);
        }
    }
    return [...unsafe].sort(comparePathBytes);
}

function planGitBaselineProjection(
    scope: WorkspaceScope,
    sourceEntries: readonly GitBaselineTreeEntry[],
    candidatePaths: readonly string[]
): GitBaselineProjection | undefined {
    const source = new Map(sourceEntries.map((entry) => [entry.path, entry]));
    if (source.size !== sourceEntries.length) return undefined;
    if (sourceEntries.some((entry) => !["100644", "100755", "120000"].includes(entry.mode))) return undefined;
    const sourcePaths = [...source.keys()].sort(comparePathBytes);
    const sourcePathSet = new Set(sourcePaths);
    const candidates = normalizePathRoots(candidatePaths);
    const candidateSet = new Set(candidates);
    const physical = new Map<string, WorkspaceScopeEntry>();
    const exclusionByPath = new Map<string, WorkspaceScopeEntry>();
    for (const entry of scope.entries) {
        if (!entry.path) {
            if (entry.kind !== "excluded") return undefined;
            continue;
        }
        if (entry.kind === "excluded") {
            exclusionByPath.set(entry.path, entry);
            continue;
        }
        physical.set(entry.path, entry);
    }
    if (physical.size !== scope.coverage.eligibleEntryCount) return undefined;
    const physicalPaths = [...physical.keys()].sort(comparePathBytes);
    const exclusionPaths = normalizePathRoots([...exclusionByPath.keys()]);
    const exclusionSet = new Set(exclusionPaths);
    const capture = new Map<string, WorkspaceScopeEntry>();
    for (const path of exclusionPaths) {
        if (pathsOverlapIndex(sourcePaths, sourcePathSet, path) || pathsOverlapIndex(candidates, candidateSet, path)) {
            capture.set(path, exclusionByPath.get(path)!);
        }
    }
    for (const entry of physical.values()) {
        if (entry.size == null || entry.size > WorkspaceCheckpointInternalLimits.maxSingleFileBytes) return undefined;
        const sourceEntry = source.get(entry.path!);
        const expectedMode = entry.kind === "symlink" ? "120000" : entry.executable === true ? "100755" : "100644";
        if (
            !entry.tracked ||
            !sourceEntry ||
            sourceEntry.mode !== expectedMode ||
            pathsOverlapIndex(candidates, candidateSet, entry.path!)
        ) {
            capture.set(entry.path!, entry);
        }
    }
    const absentRoots = candidates.filter(
        (candidate) => !hasPathAtOrBelow(physicalPaths, candidate) && hasPathAtOrBelow(sourcePaths, candidate)
    );
    const absentRootSet = new Set(absentRoots);
    const absent = new Map<string, { path: string; pathBytes: Buffer; state: { state: "absent" } }>();
    for (const path of absentRoots)
        absent.set(path, { path, pathBytes: Buffer.from(path), state: { state: "absent" } });
    for (const entry of sourceEntries) {
        if (physical.has(entry.path)) continue;
        if (hasCoveringPath(exclusionSet, entry.path)) continue;
        if (hasCoveringPath(absentRootSet, entry.path)) continue;
        absent.set(entry.path, {
            path: entry.path,
            pathBytes: Buffer.from(entry.path),
            state: { state: "absent" },
        });
    }
    return {
        captureEntries: [...capture.values()].sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes)),
        absentEntries: [...absent.values()].sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes)),
    };
}

function normalizePathRoots(paths: readonly string[]): string[] {
    const roots: string[] = [];
    const rootSet = new Set<string>();
    for (const path of [...new Set(paths)].sort(comparePathBytes)) {
        if (hasCoveringPath(rootSet, path)) continue;
        roots.push(path);
        rootSet.add(path);
    }
    return roots;
}

function pathsOverlapIndex(sortedPaths: readonly string[], paths: ReadonlySet<string>, path: string): boolean {
    return hasCoveringPath(paths, path) || hasPathAtOrBelow(sortedPaths, path);
}

function hasCoveringPath(paths: ReadonlySet<string>, path: string): boolean {
    for (let current = path; ; ) {
        if (paths.has(current)) return true;
        const separator = current.lastIndexOf("/");
        if (separator < 0) return false;
        current = current.slice(0, separator);
    }
}

function hasPathAtOrBelow(sortedPaths: readonly string[], root: string): boolean {
    let low = 0;
    let high = sortedPaths.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (comparePathBytes(sortedPaths[middle]!, root) < 0) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    const path = sortedPaths[low];
    return path != null && (path === root || path.startsWith(`${root}/`));
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((path, index) => path === right[index]);
}

function validateCaptureOptions(options: CaptureWorkspaceOptions): void {
    if (!options || !["pre-turn", "terminal", "safety"].includes(options.profile)) {
        throw new Error("Invalid workspace capture profile");
    }
    if (options.requiredPaths != null && !Array.isArray(options.requiredPaths)) {
        throw new Error("Invalid required paths");
    }
}

function cloneCommitSnapshotInput(input: {
    commit: string;
    scope: WorkspaceScopeManifest;
    coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
}): {
    commit: string;
    scope: WorkspaceScopeManifest;
    coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
} {
    if (
        !input ||
        typeof input.commit !== "string" ||
        !input.scope ||
        typeof input.scope !== "object" ||
        !input.coverage ||
        typeof input.coverage.complete !== "boolean" ||
        !Number.isSafeInteger(input.coverage.eligibleEntryCount) ||
        input.coverage.eligibleEntryCount < 0 ||
        !Array.isArray(input.coverage.exclusions)
    ) {
        throw new Error("Invalid commit-backed snapshot input");
    }
    const exclusions = input.coverage.exclusions.map(cloneCoverageExclusion).sort(compareCoverageExclusions);
    if (input.coverage.complete !== (exclusions.length === 0)) {
        throw new Error("Commit-backed snapshot coverage completeness is inconsistent");
    }
    for (let index = 1; index < exclusions.length; index++) {
        if (compareCoverageExclusions(exclusions[index - 1]!, exclusions[index]!) === 0) {
            throw new Error("Duplicate commit-backed snapshot coverage exclusion");
        }
    }
    return {
        commit: input.commit,
        scope: JSON.parse(JSON.stringify(input.scope)) as WorkspaceScopeManifest,
        coverage: {
            complete: input.coverage.complete,
            eligibleEntryCount: input.coverage.eligibleEntryCount,
            exclusions,
        },
    };
}

function deriveCandidateCoverage(
    base: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">,
    entries: readonly WorkspaceCandidatePathEntry[],
    eligibleEntryDelta: number
): Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes"> {
    if (!Number.isSafeInteger(eligibleEntryDelta)) {
        throw new Error("Candidate snapshot coverage is invalid");
    }
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
    for (const entry of entries) {
        pathExclusions.delete(entry.path);
        if (entry.state.state === "excluded") {
            pathExclusions.set(entry.path, {
                path: entry.path,
                reason: entry.state.reason,
            });
        }
    }
    const eligibleEntryCount = base.eligibleEntryCount + eligibleEntryDelta;
    if (!Number.isSafeInteger(eligibleEntryCount) || eligibleEntryCount < 0) {
        throw new Error("Candidate snapshot coverage is invalid");
    }
    const exclusions = [...nonPathExclusions, ...pathExclusions.values()].sort(compareCoverageExclusions);
    return {
        complete: exclusions.length === 0,
        eligibleEntryCount,
        exclusions,
    };
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

function withoutNewlyHashedBytes(
    coverage: WorkspaceSnapshotCoverage
): Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes"> {
    return {
        complete: coverage.complete,
        eligibleEntryCount: coverage.eligibleEntryCount,
        exclusions: coverage.exclusions.map(cloneCoverageExclusion),
    };
}

function toStoredCoverageExclusion(
    exclusion: WorkspaceSnapshotCoverage["exclusions"][number]
): StoredScopeManifest["coverage"]["exclusions"][number] {
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

function markSnapshotTrusted(
    store: WorkspaceSnapshotStore,
    snapshot: WorkspaceSnapshotRefV1,
    commitBacked = false
): void {
    TrustedSnapshotDescriptors.get(store)!.add(snapshotTrustKey(snapshot));
    if (commitBacked) TrustedCommitSnapshots.get(store)!.add(snapshotTrustKey(snapshot));
}

function isTrustedCommitSnapshot(store: WorkspaceSnapshotStore, snapshot: WorkspaceSnapshotRefV1): boolean {
    return TrustedCommitSnapshots.get(store)!.has(snapshotTrustKey(snapshot));
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

function validateSnapshotObjectRefName(value: string): void {
    if (!/^refs\/crest-objects\/snapshots\/[0-9a-f]{40}$/.test(value)) {
        throw new Error("Invalid workspace snapshot object ref name");
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

async function measureExactStoreUsage(storeRoot: string, git: WorkspaceGitRunner): Promise<number> {
    const result = await git.run(["count-objects", "-v"], {
        gitDir: storeRoot,
        timeoutMs: StoreGitTimeoutMs,
    });
    return parseCountObjectsBytes(result.stdout);
}

function quotaGeneration(processOwner: ProcessOwnerIdentity): string {
    return createHash("sha256").update(`${processOwner.pid}\0${processOwner.processStartToken}`, "utf8").digest("hex");
}

async function prepareQuotaObjectWrite(
    storeRoot: string,
    type: "blob" | "tree",
    bytes: Buffer,
    runtime: CaptureRuntime
): Promise<string | undefined> {
    if (!runtime.newLooseObjectCandidates) return undefined;
    const oid = createHash("sha1").update(`${type} ${bytes.length}\0`, "ascii").update(bytes).digest("hex");
    if ((await readLooseObjectBytes(storeRoot, oid)) == null) {
        runtime.newLooseObjectCandidates.add(oid);
    }
    return oid;
}

async function measureNewLooseObjectBytes(storeRoot: string, objectIds: ReadonlySet<string>): Promise<number> {
    let measuredBytes = 0;
    for (const oid of objectIds) {
        const bytes = await readLooseObjectBytes(storeRoot, oid);
        if (bytes == null) continue;
        measuredBytes += bytes;
        if (!Number.isSafeInteger(measuredBytes)) throw new Error("New loose object usage exceeds the supported range");
    }
    return measuredBytes;
}

async function readLooseObjectBytes(storeRoot: string, oid: string): Promise<number | undefined> {
    validateOid(oid);
    try {
        const state = await lstat(join(storeRoot, "objects", oid.slice(0, 2), oid.slice(2)));
        if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
            throw new Error("Unsafe loose snapshot object");
        }
        if (!Number.isSafeInteger(state.size) || state.size < 0) {
            throw new Error("Invalid loose snapshot object size");
        }
        return state.size;
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

function isNoSpaceError(error: unknown): boolean {
    if (isNodeError(error) && (error.code === "ENOSPC" || error.code === "EDQUOT")) return true;
    return error instanceof Error && /(?:ENOSPC|EDQUOT|no space left|disk quota exceeded)/i.test(error.message);
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
            (fields[1] !== "commit" && fields[1] !== "tree" && fields[1] !== "blob")
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

function assertBatchObjectTypes(value: Buffer, expected: ReadonlyArray<{ oid: string; type: "blob" | "tree" }>): void {
    const lines = splitLines(value);
    if (lines.length !== expected.length) {
        throw new Error("Workspace tree object verification returned an invalid count");
    }
    for (let index = 0; index < lines.length; index++) {
        const fields = lines[index]!.split(" ");
        if (fields.length !== 2 || fields[0] !== expected[index]!.oid || fields[1] !== expected[index]!.type) {
            throw new Error("Workspace tree object is missing or has an invalid type");
        }
    }
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
    let previous: { name: Buffer; mode: string } | undefined;
    let offset = 0;
    while (offset < value.length) {
        const space = value.indexOf(0x20, offset);
        const nul = value.indexOf(0x00, space + 1);
        if (space <= offset || nul < space + 2 || nul + 1 + hashBytes > value.length) {
            throw new Error("Invalid raw Git tree object");
        }
        const modeBytes = value.subarray(offset, space);
        if (
            (modeBytes.length !== 5 && modeBytes.length !== 6) ||
            modeBytes.some((byte) => byte < 0x30 || byte > 0x37)
        ) {
            throw new Error("Invalid raw Git tree mode");
        }
        const mode = modeBytes.toString("ascii");
        if (mode !== "40000" && mode !== "100644" && mode !== "100755" && mode !== "120000") {
            throw new Error("Invalid raw Git tree mode");
        }
        const nameBytes = value.subarray(space + 1, nul);
        const name = nameBytes.toString("utf8");
        if (!Buffer.from(name).equals(nameBytes) || name.includes("/")) {
            throw new Error("Invalid raw Git tree name");
        }
        validateRelativePath(name);
        if (previous && compareGitTreeBaseNames(previous.name, previous.mode, nameBytes, mode) >= 0) {
            throw new Error("Raw Git tree entries are not strictly ordered");
        }
        entries.set(name, {
            mode,
            oid: value.subarray(nul + 1, nul + 1 + hashBytes).toString("hex"),
        });
        previous = { name: nameBytes, mode };
        offset = nul + 1 + hashBytes;
    }
    return entries;
}

function workspaceTreePathEntry(entry: { mode: string; oid: string }): WorkspaceTreePathEntry {
    if (entry.mode === "40000") return { kind: "tree" };
    if (entry.mode === "120000") {
        return { kind: "leaf", state: { state: "symlink", oid: entry.oid } };
    }
    if (entry.mode !== "100644" && entry.mode !== "100755") {
        throw new Error("Workspace tree path has an invalid mode");
    }
    return {
        kind: "leaf",
        state: { state: "file", oid: entry.oid, executable: entry.mode === "100755" },
    };
}

function manifestPathExclusionPaths(manifest: StoredManifestReader): Set<string> {
    const exclusions = new Set<string>();
    for (const exclusion of manifest.getCoverage().exclusions) {
        if (exclusion.path != null) exclusions.add(exclusion.path);
    }
    return exclusions;
}

async function mergeRawTreeState(
    state: Extract<CapturedPathStateV1, { state: "absent" | "file" | "symlink" }> | undefined,
    manifest: StoredManifestReader,
    path: string
): Promise<CapturedPathStateV1> {
    if (state && state.state !== "absent") return state;
    return await manifest.readCoveragePathState(path);
}

function chunkCandidateLookupPaths(paths: readonly string[]): string[][] {
    const chunks: string[][] = [];
    let chunk: string[] = [];
    let bytes = 0;
    for (const path of paths) {
        const pathBytes = Buffer.byteLength(path) + 16;
        if (
            chunk.length > 0 &&
            (chunk.length >= CandidateLookupMaxPaths || bytes + pathBytes > CandidateLookupMaxArgumentBytes)
        ) {
            chunks.push(chunk);
            chunk = [];
            bytes = 0;
        }
        chunk.push(path);
        bytes += pathBytes;
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
}

function chunkStagedHashPaths(paths: readonly string[]): string[][] {
    const chunks: string[][] = [];
    let chunk: string[] = [];
    let bytes = 0;
    for (const path of paths) {
        const pathBytes = Buffer.byteLength(path) + 1;
        if (chunk.length > 0 && (chunk.length >= StagedHashMaxPaths || bytes + pathBytes > StagedHashMaxInputBytes)) {
            chunks.push(chunk);
            chunk = [];
            bytes = 0;
        }
        if (pathBytes > StagedHashMaxInputBytes) throw new Error("Snapshot staging path exceeds its input budget");
        chunk.push(path);
        bytes += pathBytes;
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
}

function chunkStableCaptureEntries(entries: readonly WorkspaceScopeEntry[]): WorkspaceScopeEntry[][] {
    const chunks: WorkspaceScopeEntry[][] = [];
    let chunk: WorkspaceScopeEntry[] = [];
    let bytes = 0;
    for (const entry of entries) {
        const entryBytes = entry.size ?? StagedCaptureMaxBytes;
        if (chunk.length > 0 && (chunk.length >= StagedHashMaxPaths || bytes + entryBytes > StagedCaptureMaxBytes)) {
            chunks.push(chunk);
            chunk = [];
            bytes = 0;
        }
        chunk.push(entry);
        bytes += entryBytes;
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
}

function parseNulLsTreeEntries(
    value: Buffer,
    requested: ReadonlySet<string>
): Map<string, { mode: string; oid: string }> {
    if (value.length > 0 && value.at(-1) !== 0) throw new Error("Invalid Git candidate tree output");
    const entries = new Map<string, { mode: string; oid: string }>();
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] !== 0) continue;
        const record = value.subarray(start, index);
        const tab = record.indexOf(0x09);
        if (tab <= 0) throw new Error("Invalid Git candidate tree output");
        const header = record.subarray(0, tab).toString("ascii").split(" ");
        const pathBytes = record.subarray(tab + 1);
        const path = pathBytes.toString("utf8");
        if (!Buffer.from(path).equals(pathBytes)) throw new Error("Invalid UTF-8 Git candidate path");
        validateRelativePath(path);
        if (!requested.has(path) || entries.has(path)) throw new Error("Git returned an unexpected candidate path");
        if (header.length !== 3) throw new Error("Invalid Git candidate tree output");
        const [mode, type, oid] = header;
        validateOid(oid!);
        if (
            !(
                (mode === "040000" && type === "tree") ||
                (["100644", "100755", "120000"].includes(mode!) && type === "blob")
            )
        ) {
            throw new Error("Git candidate tree entry has an invalid mode or type");
        }
        entries.set(path, { mode: mode === "040000" ? "40000" : mode!, oid: oid! });
        start = index + 1;
    }
    return entries;
}

function compareGitTreeBaseNames(left: Buffer, leftMode: string, right: Buffer, rightMode: string): number {
    const shared = Math.min(left.length, right.length);
    for (let index = 0; index < shared; index++) {
        if (left[index] !== right[index]) return left[index]! - right[index]!;
    }
    if (left.length === right.length) return 0;
    if (left.length < right.length) {
        return (isGitDirectoryMode(leftMode) ? 0x2f : 0) - right[shared]!;
    }
    return left[shared]! - (isGitDirectoryMode(rightMode) ? 0x2f : 0);
}

function isGitDirectoryMode(mode: string): boolean {
    return (Number.parseInt(mode, 8) & 0o170000) === 0o040000;
}

function parseNulWorkspaceTreeDelta(value: Buffer): { paths: string[]; eligibleEntryDelta: number } {
    if (value.length === 0) return { paths: [], eligibleEntryDelta: 0 };
    if (value.at(-1) !== 0) throw new Error("Invalid Git tree delta output");
    const paths: string[] = [];
    const seen = new Set<string>();
    let eligibleEntryDelta = 0;
    let start = 0;
    let status: string | undefined;
    for (let index = 0; index < value.length; index++) {
        if (value[index] !== 0) continue;
        const bytes = value.subarray(start, index);
        if (status == null) {
            status = bytes.toString("ascii");
            if (!/^[ADMT]$/.test(status) || !Buffer.from(status, "ascii").equals(bytes)) {
                throw new Error("Invalid Git tree delta status");
            }
            start = index + 1;
            continue;
        }
        const path = bytes.toString("utf8");
        if (!Buffer.from(path).equals(bytes)) throw new Error("Invalid UTF-8 Git tree delta path");
        validateRelativePath(path);
        if (seen.has(path)) throw new Error("Duplicate Git tree delta path");
        seen.add(path);
        paths.push(path);
        eligibleEntryDelta += status === "A" ? 1 : status === "D" ? -1 : 0;
        status = undefined;
        start = index + 1;
    }
    if (status != null) throw new Error("Invalid Git tree delta output");
    return { paths: paths.sort(comparePathBytes), eligibleEntryDelta };
}

function parseNulWorkspaceRawTreeDelta(value: Buffer, hashLength: number): WorkspaceRawTreeDeltaEntry[] {
    if (hashLength !== 40 && hashLength !== 64) throw new Error("Unsupported Git object format");
    if (value.length === 0) return [];
    if (value.at(-1) !== 0) throw new Error("Invalid raw Git tree delta output");
    const records: Buffer[] = [];
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] !== 0) continue;
        records.push(value.subarray(start, index));
        start = index + 1;
    }
    if (records.length % 2 !== 0) throw new Error("Invalid raw Git tree delta output");
    const zeroOid = "0".repeat(hashLength);
    const oidPattern = new RegExp(`^[0-9a-f]{${hashLength}}$`);
    const seen = new Set<string>();
    const entries: WorkspaceRawTreeDeltaEntry[] = [];
    for (let index = 0; index < records.length; index += 2) {
        const headerBytes = records[index]!;
        const header = headerBytes.toString("ascii");
        if (!Buffer.from(header, "ascii").equals(headerBytes)) throw new Error("Invalid raw Git tree delta header");
        const fields = header.split(" ");
        if (fields.length !== 5 || !fields[0]!.startsWith(":")) {
            throw new Error("Invalid raw Git tree delta header");
        }
        const beforeMode = fields[0]!.slice(1);
        const afterMode = fields[1]!;
        const beforeOid = fields[2]!;
        const afterOid = fields[3]!;
        const status = fields[4]!;
        if (
            !["000000", "100644", "100755", "120000"].includes(beforeMode) ||
            !["000000", "100644", "100755", "120000"].includes(afterMode) ||
            !oidPattern.test(beforeOid) ||
            !oidPattern.test(afterOid) ||
            !/^[ADMT]$/.test(status)
        ) {
            throw new Error("Invalid raw Git tree delta header");
        }
        const beforeAbsent = beforeMode === "000000";
        const afterAbsent = afterMode === "000000";
        if (beforeAbsent !== (beforeOid === zeroOid) || afterAbsent !== (afterOid === zeroOid)) {
            throw new Error("Invalid raw Git tree delta zero object id");
        }
        if (
            (status === "A" && (!beforeAbsent || afterAbsent)) ||
            (status === "D" && (beforeAbsent || !afterAbsent)) ||
            ((status === "M" || status === "T") && (beforeAbsent || afterAbsent))
        ) {
            throw new Error("Invalid raw Git tree delta status");
        }
        if (status === "M" && rawModeKind(beforeMode) !== rawModeKind(afterMode)) {
            throw new Error("Invalid raw Git tree delta modification");
        }
        if (status === "T" && rawModeKind(beforeMode) === rawModeKind(afterMode)) {
            throw new Error("Invalid raw Git tree delta type change");
        }
        const pathBytes = records[index + 1]!;
        const path = pathBytes.toString("utf8");
        if (!Buffer.from(path).equals(pathBytes)) throw new Error("Invalid UTF-8 raw Git tree delta path");
        validateRelativePath(path);
        if (seen.has(path)) throw new Error("Duplicate raw Git tree delta path");
        seen.add(path);
        const before = rawTreeDeltaState(beforeMode, beforeOid);
        const after = rawTreeDeltaState(afterMode, afterOid);
        if (canonicalJson(before).equals(canonicalJson(after))) {
            throw new Error("Raw Git tree delta entry does not change state");
        }
        entries.push({ path, before, after });
    }
    return entries.sort((left, right) => comparePathBytes(left.path, right.path));
}

function rawModeKind(mode: string): "absent" | "file" | "symlink" {
    if (mode === "000000") return "absent";
    if (mode === "100644" || mode === "100755") return "file";
    if (mode === "120000") return "symlink";
    throw new Error("Invalid raw Git tree delta mode");
}

function rawTreeDeltaState(
    mode: string,
    oid: string
): Extract<CapturedPathStateV1, { state: "absent" | "file" | "symlink" }> {
    const kind = rawModeKind(mode);
    if (kind === "absent") return { state: "absent" };
    if (kind === "symlink") return { state: "symlink", oid };
    return { state: "file", oid, executable: mode === "100755" };
}

function comparePathBytes(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
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
