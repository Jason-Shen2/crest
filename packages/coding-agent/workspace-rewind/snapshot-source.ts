// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, join, normalize, relative, sep } from "node:path";

import { ShadowWorkspaceIndex } from "./shadow-workspace-index";
import {
    WorkspaceCheckpointLimits,
    type CaptureWorkspaceOptions,
    type ReconciledWorkspaceState,
    type WorkspaceSnapshotStore,
} from "./snapshot-store";
import { encodeCanonicalStoredJson, validateWorkspaceRelativePath } from "./stored-manifest";
import type { WorkspacePathChangeV1, WorkspaceSnapshotCoverage, WorkspaceSnapshotRefV1 } from "./types";
import {
    materializeWorkspaceCandidateBatch,
    WorkspaceCandidateCapture,
    type WorkspaceCandidateCaptureResult,
} from "./workspace-candidate-capture";
import { type WorkspaceCandidateBoundary, type WorkspaceCandidates } from "./workspace-candidates";
import { refreshWorkspaceScopeGitIndexEvidence, type WorkspaceScopeManifest } from "./workspace-scope";

export interface WorkspaceCheckpointHead {
    ref: WorkspaceSnapshotRefV1;
    coverage: WorkspaceSnapshotCoverage;
}

export interface WorkspaceOwnedTurnCapture {
    after: WorkspaceSnapshotRefV1;
    changes: WorkspacePathChangeV1[];
    coverage: WorkspaceSnapshotCoverage;
}

export interface WorkspaceCheckpointSnapshotSource {
    readHead(signal?: AbortSignal): Promise<WorkspaceCheckpointHead>;
    synchronizeExternal(signal?: AbortSignal): Promise<WorkspaceCheckpointHead>;
    captureOwnedTurn(input: {
        base: WorkspaceSnapshotRefV1;
        sessionId: string;
        turnId: string;
        signal?: AbortSignal;
    }): Promise<WorkspaceOwnedTurnCapture>;
    dispose?(): Promise<void>;
}

export type WorkspaceFullReconcile = (options: CaptureWorkspaceOptions) => Promise<ReconciledWorkspaceState>;

const WorkspaceSourceInitializations = new Map<string, Promise<void>>();

export async function initializeWorkspaceCheckpointSnapshotSource(input: {
    store: WorkspaceSnapshotStore;
    fullReconcile: WorkspaceFullReconcile;
    candidates?: WorkspaceCandidates;
}): Promise<WorkspaceCheckpointSnapshotSource> {
    const source = new CommitBackedWorkspaceCheckpointSnapshotSource(
        input.store,
        input.fullReconcile,
        input.candidates
    );
    const key = `${input.store.storeRoot}:${input.store.identity.workspaceIdentity}:${input.store.identity.workspaceIncarnation}`;
    let initialization = WorkspaceSourceInitializations.get(key);
    if (!initialization) {
        initialization = source.initialize();
        WorkspaceSourceInitializations.set(key, initialization);
        void initialization.then(
            () => {
                if (WorkspaceSourceInitializations.get(key) === initialization) {
                    WorkspaceSourceInitializations.delete(key);
                }
            },
            () => {
                if (WorkspaceSourceInitializations.get(key) === initialization) {
                    WorkspaceSourceInitializations.delete(key);
                }
            }
        );
    }
    await initialization;
    return source;
}

class CommitBackedWorkspaceCheckpointSnapshotSource implements WorkspaceCheckpointSnapshotSource {
    readonly store: WorkspaceSnapshotStore;
    readonly fullReconcile: WorkspaceFullReconcile;
    readonly candidates?: WorkspaceCandidates;
    captureQueue: Promise<void> = Promise.resolve();
    disposed = false;

    constructor(
        store: WorkspaceSnapshotStore,
        fullReconcile: WorkspaceFullReconcile,
        candidates?: WorkspaceCandidates
    ) {
        this.store = store;
        this.fullReconcile = fullReconcile;
        this.candidates = candidates;
    }

    async initialize(): Promise<void> {
        const head = await this.store.mutationLog.readHead();
        if (head) {
            await this.readCommitHead(head);
            return;
        }
        const observingFreshBaseline = (await this.candidates?.startNonGitBaselineObservation()) ?? false;
        const captured = await this.fullReconcile({ profile: "terminal" });
        let equivalentHead = true;
        try {
            await this.appendWorkspaceMutation({ captured, kind: "external" });
        } catch (error) {
            const concurrentHead = await this.store.mutationLog.readHead();
            if (!concurrentHead) throw error;
            const concurrent = await this.readCommitHead(concurrentHead);
            equivalentHead =
                concurrent.ref.tree === captured.tree && (await this.hasEquivalentSemantics(concurrent.ref, captured));
        }
        if (observingFreshBaseline && equivalentHead) this.candidates?.adoptNonGitBaseline();
    }

    async readHead(signal?: AbortSignal): Promise<WorkspaceCheckpointHead> {
        signal?.throwIfAborted();
        const head = await this.store.mutationLog.readHead();
        signal?.throwIfAborted();
        if (!head) throw new Error("Workspace mutation head is not initialized");
        return await this.readCommitHead(head);
    }

    async synchronizeExternal(signal?: AbortSignal): Promise<WorkspaceCheckpointHead> {
        const base = await this.readHead(signal);
        const captured = await this.captureWorkspace(base.ref, signal);
        signal?.throwIfAborted();
        if (captured.tree === base.ref.tree && (await this.hasEquivalentSemantics(base.ref, captured))) {
            return { ref: base.ref, coverage: cloneCoverage(captured.coverage) };
        }
        return await this.appendWorkspaceMutation({
            expectedHead: base.ref.id,
            captured,
            kind: "external",
        });
    }

    async captureOwnedTurn(input: {
        base: WorkspaceSnapshotRefV1;
        sessionId: string;
        turnId: string;
        signal?: AbortSignal;
    }): Promise<WorkspaceOwnedTurnCapture> {
        assertNonEmpty("Session id", input.sessionId);
        assertNonEmpty("turn id", input.turnId);
        const current = await this.readHead(input.signal);
        if (current.ref.id !== input.base.id) {
            throw new Error("Workspace mutation head moved outside the active writer lease");
        }
        const captured = await this.captureWorkspace(input.base, input.signal);
        input.signal?.throwIfAborted();
        if (captured.tree === input.base.tree && (await this.hasEquivalentSemantics(input.base, captured))) {
            return { after: input.base, coverage: cloneCoverage(captured.coverage), changes: [] };
        }
        const after = await this.appendWorkspaceMutation({
            expectedHead: input.base.id,
            captured,
            kind: "agent-turn",
            sessionId: input.sessionId,
            turnId: input.turnId,
        });
        const changes = await this.store.diff(input.base, after.ref);
        return { after: after.ref, coverage: after.coverage, changes };
    }

    async readCommitHead(commit: string): Promise<WorkspaceCheckpointHead> {
        const ref = await this.store.readCommitSnapshot(commit);
        const metadata = await this.store.readSnapshotMetadata(ref);
        return {
            ref,
            coverage: { ...metadata.coverage, newlyHashedBytes: 0 },
        };
    }

    async hasEquivalentSemantics(left: WorkspaceSnapshotRefV1, right: CapturedWorkspaceState): Promise<boolean> {
        const leftMetadata = await this.store.readSnapshotMetadata(left);
        return encodeCanonicalStoredJson(leftMetadata).equals(
            encodeCanonicalStoredJson({ scope: right.scope, coverage: withoutNewlyHashedBytes(right.coverage) })
        );
    }

    async appendWorkspaceMutation(input: {
        expectedHead?: string;
        captured: CapturedWorkspaceState;
        kind: "external" | "agent-turn";
        sessionId?: string;
        turnId?: string;
    }): Promise<WorkspaceCheckpointHead> {
        const prepared = await this.store.mutationLog.prepare({
            ...(input.expectedHead ? { expectedHead: input.expectedHead } : {}),
            tree: input.captured.tree,
            metadata: {
                schemaversion: 1,
                workspaceidentity: this.store.identity.workspaceIdentity,
                workspaceincarnation: this.store.identity.workspaceIncarnation,
                kind: input.kind,
                ...(input.sessionId ? { sessionid: input.sessionId } : {}),
                ...(input.turnId ? { turnid: input.turnId } : {}),
            },
        });
        const ref = await this.store.publishCommitSnapshot({
            commit: prepared.commit,
            scope: input.captured.scope,
            coverage: withoutNewlyHashedBytes(input.captured.coverage),
        });
        await this.store.mutationLog.publishPrepared(prepared);
        return { ref, coverage: cloneCoverage(input.captured.coverage) };
    }

    captureWorkspace(base: WorkspaceSnapshotRefV1, signal?: AbortSignal): Promise<CapturedWorkspaceState> {
        if (this.disposed) return Promise.reject(new Error("Workspace checkpoint snapshot source is disposed"));
        const operation = this.captureQueue.then(() => this.captureWorkspaceActive(base, signal));
        this.captureQueue = operation.then(
            () => undefined,
            () => undefined
        );
        return operation;
    }

    async captureWorkspaceActive(base: WorkspaceSnapshotRefV1, signal?: AbortSignal): Promise<CapturedWorkspaceState> {
        if (!this.candidates) return await this.captureFullReconcile(signal);
        const metadata = await this.store.readSnapshotMetadata(base);
        const boundary = await this.readCandidateBoundary(base.tree, signal);
        const discovered = await this.candidates.collect(boundary, signal);
        if (discovered.status !== "complete") {
            throw new Error(`Workspace candidate discovery unavailable: ${discovered.reason}`);
        }
        const captured = await this.captureCandidatePaths(base, metadata.scope, discovered.paths, signal);
        if (captured) return captured;
        if (boundary.kind === "git") {
            const refreshedScope = await refreshWorkspaceScopeGitIndexEvidence({
                identity: this.store.identity,
                git: this.store.git,
                scope: metadata.scope,
                signal,
            });
            const retried = await this.captureCandidatePaths(base, refreshedScope, discovered.paths, signal);
            if (retried) return retried;
        }
        return await this.captureFullReconcile(signal);
    }

    async captureCandidatePaths(
        base: WorkspaceSnapshotRefV1,
        scope: WorkspaceScopeManifest,
        paths: readonly string[],
        signal?: AbortSignal
    ): Promise<CapturedWorkspaceState | undefined> {
        let capturePaths = [...paths];
        let candidateBoundary = await this.readCandidateBoundary(base.tree, signal);
        let captureScope = scope;
        for (let attempt = 0; attempt < 2; attempt++) {
            const observationToken = this.candidates!.observationToken();
            const staged = await this.stageCandidatePaths(base, captureScope, capturePaths, signal);
            if (!staged) {
                if (attempt === 1) throw new Error("Workspace changed during candidate capture");
                return undefined;
            }
            let collectionBoundary: WorkspaceCandidateBoundary;
            let validationBoundary: WorkspaceCandidateBoundary;
            let validation;
            try {
                collectionBoundary = await this.readCandidateBoundary(base.tree, signal);
                validation = await this.candidates!.collect(collectionBoundary, signal);
                validationBoundary = await this.readCandidateBoundary(base.tree, signal);
            } catch (error) {
                await this.discardCandidateCapture(staged);
                throw error;
            }
            if (validation.status !== "complete") {
                await this.discardCandidateCapture(staged);
                throw new Error(`Workspace candidate validation unavailable: ${validation.reason}`);
            }
            const nextPaths = mergeCandidatePaths(capturePaths, validation.paths);
            const boundaryChanged =
                !candidateBoundariesEqual(candidateBoundary, collectionBoundary) ||
                !candidateBoundariesEqual(collectionBoundary, validationBoundary);
            const pathsChanged = nextPaths.length !== capturePaths.length;
            const observationsChanged = this.candidates!.observationToken() !== observationToken;
            if (boundaryChanged || pathsChanged || observationsChanged) {
                await this.discardCandidateCapture(staged);
                if (attempt === 1) throw new Error("Workspace changed during candidate capture");
                capturePaths = nextPaths;
                candidateBoundary = validationBoundary;
                if (validationBoundary.kind === "git") {
                    captureScope = await refreshWorkspaceScopeGitIndexEvidence({
                        identity: this.store.identity,
                        git: this.store.git,
                        scope: captureScope,
                        signal,
                    });
                }
                continue;
            }
            return await this.commitCandidateCapture(base, captureScope, staged, signal);
        }
        throw new Error("Workspace changed during candidate capture");
    }

    async stageCandidatePaths(
        base: WorkspaceSnapshotRefV1,
        scope: WorkspaceScopeManifest,
        paths: readonly string[],
        signal?: AbortSignal
    ): Promise<StagedCandidateCapture | undefined> {
        const capture = new WorkspaceCandidateCapture({
            identity: this.store.identity,
            git: this.store.git,
            storeRoot: this.store.storeRoot,
            scope,
            maxEntries: WorkspaceCheckpointLimits.maxEntries,
            maxUntrackedBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
            maxNewlyHashedBytes: WorkspaceCheckpointLimits.maxNewlyHashedBytes,
            timeoutMs: WorkspaceCheckpointLimits.terminalTimeoutMs,
            base: {
                readNodeKind: (path, captureSignal) => this.store.readNodeKind(base, path, captureSignal),
                readNodeKinds: (paths, captureSignal) => this.store.readNodeKinds(base, paths, captureSignal),
            },
        });
        try {
            const result = await capture.capture(paths, signal);
            if (result.status === "reconcile") {
                await capture.dispose();
                return undefined;
            }
            return { capture, result };
        } catch (error) {
            await capture.dispose();
            throw error;
        }
    }

    async commitCandidateCapture(
        base: WorkspaceSnapshotRefV1,
        scope: WorkspaceScopeManifest,
        staged: StagedCandidateCapture,
        signal?: AbortSignal
    ): Promise<CapturedWorkspaceState> {
        try {
            return await staged.capture.consumeCaptured(staged.result, async (batch) => {
                await materializeWorkspaceCandidateBatch(batch, {
                    storeRoot: this.store.storeRoot,
                    writeBlob: (bytes) => this.writeCandidateBlob(bytes, signal),
                });
                const index = new ShadowWorkspaceIndex({
                    git: this.store.git,
                    gitDir: this.store.storeRoot,
                    indexFile: join(this.store.storeRoot, "journal", "workspace-candidate.index"),
                });
                await index.load(base.tree);
                await index.apply(staged.result.entries);
                const tree = await index.writeTree();
                const coverage = await this.store.computeCandidateSnapshotCoverage(base, staged.result.entries);
                return {
                    tree,
                    scope,
                    coverage: { ...coverage, newlyHashedBytes: staged.result.newlyHashedBytes },
                };
            });
        } finally {
            await staged.capture.dispose();
        }
    }

    async discardCandidateCapture(staged: StagedCandidateCapture): Promise<void> {
        try {
            await staged.capture.discardCaptured(staged.result);
        } finally {
            await staged.capture.dispose();
        }
    }

    async captureFullReconcile(signal?: AbortSignal): Promise<CapturedWorkspaceState> {
        return await this.fullReconcile({
            profile: "terminal",
            ...(signal ? { signal } : {}),
        });
    }

    async readCandidateBoundary(shadowTree: string, signal?: AbortSignal): Promise<WorkspaceCandidateBoundary> {
        const userGit = this.candidates!.userGit;
        if (!userGit) return { kind: "non-git" };
        let sourceHeadTree: string;
        let repositoryRoot: string;
        let workspacePrefix: string;
        try {
            const inside = await userGit.run(["rev-parse", "--is-inside-work-tree"], {
                cwd: this.store.identity.canonicalRoot,
                timeoutMs: WorkspaceCheckpointLimits.terminalTimeoutMs,
                signal,
            });
            if (!inside.stdout.equals(Buffer.from("true\n")) || inside.stderr.length !== 0) {
                return { kind: "non-git" };
            }
            const topLevel = await userGit.run(["rev-parse", "--show-toplevel"], {
                cwd: this.store.identity.canonicalRoot,
                timeoutMs: WorkspaceCheckpointLimits.terminalTimeoutMs,
                signal,
                maxStdoutBytes: 16 * 1024,
            });
            repositoryRoot = parseGitTopLevel(topLevel.stdout, topLevel.stderr);
            workspacePrefix = workspacePrefixFromTopLevel(repositoryRoot, this.store.identity.canonicalRoot);
            const revision = workspacePrefix === "" ? "HEAD^{tree}" : `HEAD:${workspacePrefix}`;
            const head = await userGit.run(["rev-parse", revision], {
                cwd: repositoryRoot,
                timeoutMs: WorkspaceCheckpointLimits.terminalTimeoutMs,
                signal,
                maxStdoutBytes: 128,
            });
            sourceHeadTree = parseOid(head.stdout);
        } catch {
            signal?.throwIfAborted();
            return { kind: "non-git" };
        }
        await this.importSourceTree(sourceHeadTree, signal);
        return {
            kind: "git",
            repositoryRoot,
            workspacePrefix,
            shadowGitDir: this.store.storeRoot,
            sourceHeadTree,
            shadowTree,
        };
    }

    async importSourceTree(sourceHeadTree: string, signal?: AbortSignal): Promise<void> {
        const visited = new Set<string>();
        const copy = async (tree: string, knownMissing = false): Promise<void> => {
            if (visited.has(tree)) return;
            visited.add(tree);
            if (!knownMissing && (await this.privateTreePresence([tree], signal))[0]) return;
            const raw = await this.candidates!.userGit!.run(["cat-file", "tree", tree], {
                cwd: this.store.identity.canonicalRoot,
                timeoutMs: WorkspaceCheckpointLimits.terminalTimeoutMs,
                signal,
            });
            const children = [...new Set(readSubtreeOids(raw.stdout).filter((child) => !visited.has(child)))];
            const presence = await this.privateTreePresence(children, signal);
            for (let index = 0; index < children.length; index++) {
                if (presence[index]) visited.add(children[index]!);
            }
            for (let index = 0; index < children.length; index++) {
                if (!presence[index]) await copy(children[index]!, true);
            }
            const imported = await this.store.git.run(["hash-object", "-t", "tree", "-w", "--stdin", "--literally"], {
                gitDir: this.store.storeRoot,
                stdin: raw.stdout,
                timeoutMs: WorkspaceCheckpointLimits.terminalTimeoutMs,
                signal,
                maxStdoutBytes: 128,
            });
            if (parseOid(imported.stdout) !== tree) {
                throw new Error("Imported source tree changed object identity");
            }
        };
        await copy(sourceHeadTree);
    }

    async privateTreePresence(trees: readonly string[], signal?: AbortSignal): Promise<boolean[]> {
        if (trees.length === 0) return [];
        const checked = await this.store.git.run(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
            gitDir: this.store.storeRoot,
            stdin: Buffer.from(`${trees.join("\n")}\n`),
            timeoutMs: WorkspaceCheckpointLimits.terminalTimeoutMs,
            signal,
        });
        if (checked.stderr.length !== 0) throw new Error("Private source-tree lookup wrote to stderr");
        const presence: boolean[] = [];
        let offset = 0;
        for (const tree of trees) {
            const newline = checked.stdout.indexOf(0x0a, offset);
            if (newline < 0) throw new Error("Private source-tree lookup returned an invalid object result");
            const line = checked.stdout.subarray(offset, newline);
            if (line.equals(Buffer.from(`${tree} tree`))) {
                presence.push(true);
            } else if (line.equals(Buffer.from(`${tree} missing`))) {
                presence.push(false);
            } else {
                throw new Error("Private source-tree lookup returned an invalid object result");
            }
            offset = newline + 1;
        }
        if (offset !== checked.stdout.length) {
            throw new Error("Private source-tree lookup returned an invalid object result");
        }
        return presence;
    }

    async writeCandidateBlob(bytes: Buffer, signal?: AbortSignal): Promise<string> {
        const result = await this.store.git.run(["hash-object", "-w", "--stdin", "--no-filters"], {
            gitDir: this.store.storeRoot,
            stdin: bytes,
            timeoutMs: WorkspaceCheckpointLimits.terminalTimeoutMs,
            signal,
            maxStdoutBytes: 128,
        });
        return parseOid(result.stdout);
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await this.captureQueue;
    }
}

interface CapturedWorkspaceState {
    tree: string;
    scope: WorkspaceScopeManifest;
    coverage: WorkspaceSnapshotCoverage;
}

interface StagedCandidateCapture {
    capture: WorkspaceCandidateCapture;
    result: Extract<WorkspaceCandidateCaptureResult, { status: "captured" }>;
}

function mergeCandidatePaths(left: readonly string[], right: readonly string[]): string[] {
    return [...new Set([...left, ...right])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function candidateBoundariesEqual(left: WorkspaceCandidateBoundary, right: WorkspaceCandidateBoundary): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "non-git" || right.kind === "non-git") return true;
    return (
        left.shadowGitDir === right.shadowGitDir &&
        left.repositoryRoot === right.repositoryRoot &&
        left.workspacePrefix === right.workspacePrefix &&
        left.sourceHeadTree === right.sourceHeadTree &&
        left.shadowTree === right.shadowTree
    );
}

function parseGitTopLevel(stdout: Buffer, stderr: Buffer): string {
    if (stderr.length !== 0 || stdout.length < 2 || stdout.at(-1) !== 0x0a) {
        throw new Error("Git returned an invalid repository top-level path");
    }
    const bytes = stdout.subarray(0, -1);
    const repositoryRoot = bytes.toString("utf8");
    if (!Buffer.from(repositoryRoot).equals(bytes) || repositoryRoot.includes("\n")) {
        throw new Error("Git returned an invalid repository top-level path");
    }
    if (!isAbsolute(repositoryRoot) || normalize(repositoryRoot) !== repositoryRoot) {
        throw new Error("Git returned a non-canonical repository top-level path");
    }
    return repositoryRoot;
}

function workspacePrefixFromTopLevel(repositoryRoot: string, workspaceRoot: string): string {
    const prefix = relative(repositoryRoot, workspaceRoot).split(sep).join("/");
    if (isAbsolute(prefix) || prefix === ".." || prefix.startsWith("../")) {
        throw new Error("Workspace is outside its Git repository top level");
    }
    if (prefix !== "") validateWorkspaceRelativePath(prefix);
    if (prefix.includes("\\")) throw new Error("Git Workspace prefix must use forward slashes");
    return prefix;
}

function cloneCoverage(coverage: WorkspaceSnapshotCoverage): WorkspaceSnapshotCoverage {
    return {
        complete: coverage.complete,
        eligibleEntryCount: coverage.eligibleEntryCount,
        newlyHashedBytes: coverage.newlyHashedBytes,
        exclusions: coverage.exclusions.map((exclusion) => ({ ...exclusion })),
    };
}

function withoutNewlyHashedBytes(
    coverage: WorkspaceSnapshotCoverage
): Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes"> {
    return {
        complete: coverage.complete,
        eligibleEntryCount: coverage.eligibleEntryCount,
        exclusions: coverage.exclusions.map((exclusion) => ({ ...exclusion })),
    };
}

function parseOid(output: Buffer): string {
    const match = /^([0-9a-f]{40})\n$/.exec(output.toString("ascii"));
    if (!match) throw new Error("Git returned an invalid object id");
    return match[1]!;
}

function readSubtreeOids(raw: Buffer): string[] {
    const output: string[] = [];
    let offset = 0;
    while (offset < raw.length) {
        const space = raw.indexOf(0x20, offset);
        const nul = raw.indexOf(0, space + 1);
        if (space <= offset || nul < 0 || nul + 21 > raw.length) {
            throw new Error("Git returned an invalid raw tree");
        }
        const mode = raw.subarray(offset, space).toString("ascii");
        if (!/^(?:40000|100644|100755|120000|160000)$/.test(mode)) {
            throw new Error("Git returned an unsupported raw tree mode");
        }
        if (mode === "40000") output.push(raw.subarray(nul + 1, nul + 21).toString("hex"));
        offset = nul + 21;
    }
    return output;
}

function assertNonEmpty(label: string, value: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be non-empty`);
    }
}
