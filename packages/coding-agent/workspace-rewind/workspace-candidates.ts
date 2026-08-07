// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { lstat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import { WorkspaceGitRunner, WorkspaceGitRunnerError } from "./git-runner";
import { validateWorkspaceRelativePath } from "./stored-manifest";
import type { WorkspaceChangeDrain, WorkspaceChangeFeed } from "./workspace-change-feed";

const GitTimeoutMs = 30_000;
const IgnoreBatchSize = 2_048;

export interface GitWorkspaceCandidateBoundary {
    kind: "git";
    shadowGitDir: string;
    sourceHeadTree: string;
    shadowTree: string;
}

export interface NonGitWorkspaceCandidateBoundary {
    kind: "non-git";
}

export type WorkspaceCandidateBoundary = GitWorkspaceCandidateBoundary | NonGitWorkspaceCandidateBoundary;

export type WorkspaceCandidateUnavailableReason =
    | Extract<WorkspaceChangeDrain, { status: "unavailable" }>["reason"]
    | "git-query-failed"
    | "reconcile-failed";

export type WorkspaceCandidateRead =
    | { status: "complete"; paths: string[]; reconciled: boolean }
    | { status: "unavailable"; reason: WorkspaceCandidateUnavailableReason };

export type WorkspaceCandidateReconcile = (signal?: AbortSignal) => Promise<readonly string[]>;

export interface WorkspaceCandidatesOptions {
    workspaceRoot: string;
    feed: WorkspaceChangeFeed;
    userGit?: WorkspaceGitRunner;
    shadowGit?: WorkspaceGitRunner;
    reconcile?: WorkspaceCandidateReconcile;
}

export class WorkspaceCandidates {
    readonly workspaceRoot: string;
    readonly feed: WorkspaceChangeFeed;
    readonly userGit?: WorkspaceGitRunner;
    readonly shadowGit?: WorkspaceGitRunner;
    readonly reconcile?: WorkspaceCandidateReconcile;
    queue: Promise<void> = Promise.resolve();
    gitBaseline = false;
    nonGitBaseline = false;

    constructor(options: WorkspaceCandidatesOptions) {
        if (!isAbsolute(options.workspaceRoot) || normalize(options.workspaceRoot) !== options.workspaceRoot) {
            throw new Error("Workspace root must be a canonical absolute path");
        }
        this.workspaceRoot = options.workspaceRoot;
        this.feed = options.feed;
        this.userGit = options.userGit;
        this.shadowGit = options.shadowGit;
        this.reconcile = options.reconcile;
    }

    collect(boundary: WorkspaceCandidateBoundary, signal?: AbortSignal): Promise<WorkspaceCandidateRead> {
        const operation = this.queue.then(() => this.collectActive(boundary, signal));
        this.queue = operation.then(
            () => undefined,
            () => undefined
        );
        return operation;
    }

    async collectActive(boundary: WorkspaceCandidateBoundary, signal?: AbortSignal): Promise<WorkspaceCandidateRead> {
        signal?.throwIfAborted();
        if (boundary.kind === "git") return await this.collectGit(boundary, signal);
        return await this.collectNonGit(signal);
    }

    async collectGit(boundary: GitWorkspaceCandidateBoundary, signal?: AbortSignal): Promise<WorkspaceCandidateRead> {
        if (!this.userGit || !this.shadowGit || !validGitBoundary(boundary)) {
            return { status: "unavailable", reason: "git-query-failed" };
        }
        try {
            const reconciled = this.gitBaseline && !this.feed.isTrusted();
            if (!this.feed.isTrusted()) await this.feed.start();
            const [status, shadowDifference] = await Promise.all([
                readGitStatus(this.userGit, this.workspaceRoot, signal),
                // Both trees already live in the private store so discovery never imports objects or writes user Git.
                this.shadowGit.run(
                    [
                        "diff",
                        "--name-only",
                        "-z",
                        "--no-renames",
                        "--no-ext-diff",
                        boundary.sourceHeadTree,
                        boundary.shadowTree,
                        "--",
                    ],
                    { gitDir: boundary.shadowGitDir, timeoutMs: GitTimeoutMs, signal }
                ),
            ]);
            const hints = await this.feed.drain();
            if (hints.status === "unavailable") return hints;
            if (!this.feed.isTrusted()) return { status: "unavailable", reason: "watcher-error" };
            const paths = canonicalPaths([
                ...parseStatusPaths(status.stdout),
                ...parseNulPaths(shadowDifference.stdout),
                ...hints.changedPaths,
            ]);
            const bounded = await collapseRepositoryBoundaries(this.workspaceRoot, paths);
            const eligible = await removeIgnoredPaths(this.userGit, this.workspaceRoot, bounded, signal);
            this.gitBaseline = true;
            return { status: "complete", paths: eligible, reconciled };
        } catch {
            signal?.throwIfAborted();
            return { status: "unavailable", reason: "git-query-failed" };
        }
    }

    async collectNonGit(signal?: AbortSignal): Promise<WorkspaceCandidateRead> {
        const reconcile = !this.nonGitBaseline || !this.feed.isTrusted();
        if (!reconcile) {
            const hints = await this.feed.drain();
            if (hints.status === "unavailable") return hints;
            return { status: "complete", paths: canonicalPaths(hints.changedPaths), reconciled: false };
        }
        if (!this.reconcile) return { status: "unavailable", reason: "reconcile-failed" };
        this.nonGitBaseline = false;
        try {
            await this.feed.start();
            const baseline = await this.reconcile(signal);
            const hints = await this.feed.drain();
            if (hints.status === "unavailable") return hints;
            const paths = canonicalPaths([...baseline, ...hints.changedPaths]);
            this.nonGitBaseline = true;
            return { status: "complete", paths, reconciled: true };
        } catch (error) {
            signal?.throwIfAborted();
            if (isUnsafePathError(error)) return { status: "unavailable", reason: "unsafe-path" };
            return { status: "unavailable", reason: "reconcile-failed" };
        }
    }
}

function validGitBoundary(boundary: GitWorkspaceCandidateBoundary): boolean {
    return (
        isAbsolute(boundary.shadowGitDir) &&
        normalize(boundary.shadowGitDir) === boundary.shadowGitDir &&
        /^[0-9a-f]{40}$/.test(boundary.sourceHeadTree) &&
        /^[0-9a-f]{40}$/.test(boundary.shadowTree)
    );
}

function parseStatusPaths(value: Buffer): string[] {
    if (value.length === 0) return [];
    if (value.at(-1) !== 0) throw new Error("Invalid Git status output");
    const paths: string[] = [];
    for (const record of splitNul(value)) {
        if (record.length < 4 || record[2] !== 0x20) throw new Error("Invalid Git status record");
        const status = record.subarray(0, 2).toString("ascii");
        if (!/^(?:[ MADRCU?!][ MADRCU?!])$/.test(status) || status === "!!") {
            throw new Error("Invalid Git status code");
        }
        const pathBytes = record.subarray(3);
        let path = decodePath(pathBytes);
        if (path.endsWith("/")) path = path.slice(0, -1);
        if (path === ".git" || path.startsWith(".git/")) continue;
        validateWorkspaceRelativePath(path);
        paths.push(path);
    }
    return paths;
}

function parseNulPaths(value: Buffer): string[] {
    if (value.length === 0) return [];
    if (value.at(-1) !== 0) throw new Error("Invalid Git path output");
    return splitNul(value).map((path) => {
        const decoded = decodePath(path);
        validateWorkspaceRelativePath(decoded);
        return decoded;
    });
}

function splitNul(value: Buffer): Buffer[] {
    const output: Buffer[] = [];
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] !== 0) continue;
        if (index === start) throw new Error("Invalid empty Git path");
        output.push(value.subarray(start, index));
        start = index + 1;
    }
    if (start !== value.length) throw new Error("Invalid unterminated Git path");
    return output;
}

function decodePath(value: Buffer): string {
    const path = value.toString("utf8");
    if (!Buffer.from(path).equals(value)) throw new Error("Git returned a non-UTF-8 path");
    return path;
}

async function collapseRepositoryBoundaries(workspaceRoot: string, paths: readonly string[]): Promise<string[]> {
    const output: string[] = [];
    for (const path of paths) {
        if (path === ".git" || path.startsWith(".git/")) continue;
        const segments = path.split("/");
        let boundary: string | undefined;
        for (let length = 1; length <= segments.length; length++) {
            const candidate = segments.slice(0, length).join("/");
            let state: Awaited<ReturnType<typeof lstat>>;
            try {
                state = await lstat(join(workspaceRoot, candidate));
            } catch (error) {
                if (isMissingOrNotDirectory(error)) break;
                throw error;
            }
            if (state.isSymbolicLink() || !state.isDirectory()) {
                boundary = candidate;
                break;
            }
            try {
                await lstat(join(workspaceRoot, candidate, ".git"));
                boundary = candidate;
                break;
            } catch (error) {
                if (isMissingOrNotDirectory(error)) continue;
                throw error;
            }
        }
        output.push(boundary ?? path);
    }
    return canonicalPaths(output);
}

async function readGitStatus(
    git: WorkspaceGitRunner,
    workspaceRoot: string,
    signal?: AbortSignal
): Promise<{ stdout: Buffer; stderr: Buffer }> {
    const args = [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=no",
        "--ignore-submodules=none",
        "--no-renames",
    ];
    try {
        return await git.run(args, {
            cwd: workspaceRoot,
            timeoutMs: GitTimeoutMs,
            signal,
            fsmonitor: "builtin",
        });
    } catch {
        signal?.throwIfAborted();
        return await git.run(args, { cwd: workspaceRoot, timeoutMs: GitTimeoutMs, signal });
    }
}

async function removeIgnoredPaths(
    git: WorkspaceGitRunner,
    workspaceRoot: string,
    paths: readonly string[],
    signal?: AbortSignal
): Promise<string[]> {
    const ignored = new Set<string>();
    for (let offset = 0; offset < paths.length; offset += IgnoreBatchSize) {
        const batch = paths.slice(offset, offset + IgnoreBatchSize);
        if (batch.length === 0) continue;
        let output: Buffer;
        try {
            output = (
                await git.run(["check-ignore", "-z", "--stdin"], {
                    cwd: workspaceRoot,
                    stdin: Buffer.concat(batch.map((path) => Buffer.from(`${path}\0`))),
                    timeoutMs: GitTimeoutMs,
                    signal,
                })
            ).stdout;
        } catch (error) {
            if (!(error instanceof WorkspaceGitRunnerError) || error.code !== "nonzero_exit" || error.exitCode !== 1) {
                throw error;
            }
            output = error.stdout;
        }
        for (const path of parseOptionalNulPaths(output)) ignored.add(path);
    }
    return paths.filter((path) => !ignored.has(path));
}

function parseOptionalNulPaths(value: Buffer): string[] {
    if (value.length === 0) return [];
    return parseNulPaths(value);
}

function canonicalPaths(paths: readonly string[]): string[] {
    const unique = new Set<string>();
    for (const path of paths) {
        if (Buffer.from(path, "utf8").toString("utf8") !== path) {
            throw new Error(`Invalid workspace-relative path: ${path}`);
        }
        validateWorkspaceRelativePath(path);
        unique.add(path);
    }
    return [...unique].sort(comparePathBytes);
}

function comparePathBytes(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function isMissingOrNotDirectory(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")
    );
}

function isUnsafePathError(error: unknown): boolean {
    return error instanceof Error && /workspace-relative path/i.test(error.message);
}
