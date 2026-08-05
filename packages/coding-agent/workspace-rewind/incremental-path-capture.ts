// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import {
    AnchoredReaderError,
    runAnchoredReaderBatch,
    type AnchoredReaderBatchEntry,
    type AnchoredReaderEntryIdentity,
} from "./anchored-reader";
import { ensureDurableGitObjects } from "./durability";
import { WorkspaceGitRunner, WorkspaceGitRunnerError } from "./git-runner";
import { normalizeIncrementalMutations, type IncrementalPathMutation } from "./incremental-tree";
import { WorkspaceCheckpointInternalLimits } from "./internal-limits";
import type { CapturedPathStateV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import {
    classifyIncrementalWorkspacePaths,
    type IncrementalWorkspaceScopeEntry,
    type WorkspaceScopeEntryIdentity,
    type WorkspaceScopeManifest,
} from "./workspace-scope";

export type IncrementalPathCaptureResult =
    | { status: "captured"; mutations: IncrementalPathMutation[]; newlyHashedBytes: number }
    | { status: "reconcile"; reason: "scope-invalidated" | "unstable-path" | "unsafe-evidence" };

export interface IncrementalPathCaptureOptions {
    identity: CanonicalWorkspaceIdentity;
    git: WorkspaceGitRunner;
    storeRoot: string;
    scope: WorkspaceScopeManifest;
    maxEntries: number;
    maxUntrackedBytes: number;
    maxNewlyHashedBytes: number;
    timeoutMs: number;
}

export class IncrementalPathCapture {
    readonly identity: CanonicalWorkspaceIdentity;
    readonly git: WorkspaceGitRunner;
    readonly storeRoot: string;
    readonly scope: WorkspaceScopeManifest;
    readonly maxEntries: number;
    readonly maxUntrackedBytes: number;
    readonly maxNewlyHashedBytes: number;
    readonly timeoutMs: number;

    constructor(input: IncrementalPathCaptureOptions) {
        if (!isAbsolute(input.storeRoot) || basename(input.storeRoot) !== "repo.git") {
            throw new Error("Invalid incremental snapshot store root");
        }
        this.identity = cloneIdentity(input.identity);
        this.git = input.git;
        this.storeRoot = input.storeRoot;
        this.scope = cloneScope(input.scope);
        this.maxEntries = validateNonNegativeLimit(input.maxEntries, "entry");
        this.maxUntrackedBytes = validateNonNegativeLimit(input.maxUntrackedBytes, "untracked byte");
        this.maxNewlyHashedBytes = validateNonNegativeLimit(input.maxNewlyHashedBytes, "hash byte");
        this.timeoutMs = validateNonNegativeLimit(input.timeoutMs, "timeout");
        if (
            this.scope.schemaVersion !== 1 ||
            this.scope.policy.maxEntries !== this.maxEntries ||
            this.scope.policy.maxUntrackedBytes !== this.maxUntrackedBytes
        ) {
            throw new Error("Incremental capture scope policy does not match its limits");
        }
    }

    async capture(paths: readonly string[], signal?: AbortSignal): Promise<IncrementalPathCaptureResult> {
        if (paths.length === 0) {
            return { status: "captured", mutations: [], newlyHashedBytes: 0 };
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
        });
        if (scope.status === "reconcile") return scope;
        const direct = scope.entries.filter((entry) => entry.kind === "absent" || entry.kind === "excluded");
        const readable = scope.entries.filter(
            (entry): entry is IncrementalWorkspaceScopeEntry & { kind: "file" | "symlink" } =>
                entry.kind === "file" || entry.kind === "symlink"
        );
        if (readable.length === 0) {
            return {
                status: "captured",
                mutations: normalizeIncrementalMutations(direct.map(toDirectMutation)),
                newlyHashedBytes: 0,
            };
        }
        const stagingRoot = await mkdtemp(join(this.storeRoot, "journal", "incremental-capture-"));
        await chmod(stagingRoot, 0o700);
        try {
            const requests = readable.map((entry, index) => makeReaderEntry(entry, stagingRoot, index));
            const results = await runAnchoredReaderBatch({
                rootPath: this.identity.canonicalRoot,
                entries: requests,
                maxSingleFileBytes: WorkspaceCheckpointInternalLimits.maxSingleFileBytes,
                maxTotalBytes: this.maxNewlyHashedBytes,
                timeoutMs: this.timeoutMs,
                signal: signal ?? new AbortController().signal,
            });
            const newlyHashedBytes = results.reduce((total, result) => total + result.hashedBytes, 0);
            if (newlyHashedBytes > this.maxNewlyHashedBytes) {
                return { status: "reconcile", reason: "unsafe-evidence" };
            }
            const staged = results.map((result) => result.stagingPath!);
            const oids = await this.hashStagedPaths(staged, signal);
            await ensureDurableGitObjects(this.storeRoot, oids);
            const sourceByPath = new Map(readable.map((entry) => [entry.path!, entry]));
            const mutations = results.map((result, index): IncrementalPathMutation => {
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
            mutations.push(...direct.map(toDirectMutation));
            return {
                status: "captured",
                mutations: normalizeIncrementalMutations(mutations),
                newlyHashedBytes,
            };
        } catch (error) {
            if (error instanceof WorkspaceGitRunnerError && error.code === "aborted") throw error;
            if (error instanceof AnchoredReaderError && error.code === "unstable_file") {
                return { status: "reconcile", reason: "unstable-path" };
            }
            return { status: "reconcile", reason: "unsafe-evidence" };
        } finally {
            await rm(stagingRoot, { recursive: true, force: true });
        }
    }

    async hashStagedPaths(paths: string[], signal?: AbortSignal): Promise<string[]> {
        if (paths.length === 0) return [];
        if (paths.some((path) => path.includes("\n") || path.includes("\0"))) {
            throw new Error("Invalid incremental staging path");
        }
        const result = await this.git.run(["hash-object", "-w", "--stdin-paths", "--no-filters"], {
            gitDir: this.storeRoot,
            stdin: Buffer.from(`${paths.join("\n")}\n`),
            timeoutMs: this.timeoutMs,
            signal,
        });
        const oids = result.stdout.toString("ascii").trimEnd().split("\n");
        if (oids.length !== paths.length || oids.some((oid) => !/^[0-9a-f]{40}$/.test(oid))) {
            throw new Error("Git returned invalid incremental blob ids");
        }
        return oids;
    }
}

function makeReaderEntry(
    entry: IncrementalWorkspaceScopeEntry & { kind: "file" | "symlink" },
    stagingRoot: string,
    index: number
): AnchoredReaderBatchEntry {
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

function serializeEntryIdentity(value: WorkspaceScopeEntryIdentity): AnchoredReaderEntryIdentity {
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

function toDirectMutation(entry: IncrementalWorkspaceScopeEntry): IncrementalPathMutation {
    let state: CapturedPathStateV1;
    if (entry.kind === "absent") state = { state: "absent" };
    else if (entry.kind === "excluded") state = { state: "excluded", reason: entry.exclusionReason! };
    else throw new Error("Incremental direct mutation is readable");
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
    Object.freeze(value.ignoreInputs);
    Object.freeze(value.nestedRepositoryBoundaries);
    return Object.freeze(value);
}

function validateNonNegativeLimit(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid incremental ${label} limit`);
    return value;
}
