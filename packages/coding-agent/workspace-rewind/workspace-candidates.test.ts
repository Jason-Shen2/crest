// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import {
    WorkspaceCandidates,
    type GitWorkspaceCandidateBoundary,
    type WorkspaceCandidateReconcile,
} from "./workspace-candidates";
import type { WorkspaceChangeDrain, WorkspaceChangeFeed } from "./workspace-change-feed";

const execFileAsync = promisify(execFile);

class MemoryChangeFeed implements WorkspaceChangeFeed {
    paths: string[] = [];
    trusted = false;
    startCalls = 0;
    disposeCalls = 0;
    unavailable?: Extract<WorkspaceChangeDrain, { status: "unavailable" }>["reason"];
    loseTrustAfterDrain?: Extract<WorkspaceChangeDrain, { status: "unavailable" }>["reason"];

    async start(): Promise<void> {
        this.startCalls++;
        this.trusted = true;
        this.unavailable = undefined;
    }

    async drain(): Promise<WorkspaceChangeDrain> {
        if (!this.trusted) {
            return { status: "unavailable", reason: this.unavailable ?? "not-started" };
        }
        const changedPaths = this.paths;
        this.paths = [];
        if (this.loseTrustAfterDrain) {
            const reason = this.loseTrustAfterDrain;
            this.loseTrustAfterDrain = undefined;
            this.loseTrust(reason);
        }
        return { status: "complete", changedPaths };
    }

    isTrusted(): boolean {
        return this.trusted;
    }

    async dispose(): Promise<void> {
        this.disposeCalls++;
        this.trusted = false;
    }

    hint(...paths: string[]): void {
        this.paths.push(...paths);
    }

    loseTrust(reason: Extract<WorkspaceChangeDrain, { status: "unavailable" }>["reason"]): void {
        this.trusted = false;
        this.unavailable = reason;
    }

    loseTrustOnNextCompleteDrain(reason: Extract<WorkspaceChangeDrain, { status: "unavailable" }>["reason"]): void {
        this.loseTrustAfterDrain = reason;
    }
}

describe("WorkspaceCandidates Git discovery", () => {
    let root: string;
    let workspaceRoot: string;
    let feed: MemoryChangeFeed;
    let candidates: WorkspaceCandidates;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "crest-workspace-candidates-git-"));
        workspaceRoot = join(root, "workspace");
        await mkdir(workspaceRoot);
        await git(workspaceRoot, "init", "-q");
        await git(workspaceRoot, "config", "user.name", "Crest Tests");
        await git(workspaceRoot, "config", "user.email", "crest@example.invalid");
        await writeFile(join(workspaceRoot, ".gitignore"), "*.ignored\n");
        await writeFile(join(workspaceRoot, "tracked.txt"), "base\n");
        await git(workspaceRoot, "add", ".gitignore", "tracked.txt");
        await git(workspaceRoot, "commit", "-qm", "base");
        feed = new MemoryChangeFeed();
        candidates = new WorkspaceCandidates({
            workspaceRoot,
            feed,
            userGit: new WorkspaceGitRunner(),
            shadowGit: new WorkspaceGitRunner(),
        });
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    test("unions dirty, staged, untracked, deleted, and watcher paths in canonical byte order", async () => {
        await writeFile(join(workspaceRoot, "tracked.txt"), "dirty\n");
        await writeFile(join(workspaceRoot, "z-untracked.txt"), "untracked\n");
        await writeFile(join(workspaceRoot, "delete.txt"), "delete\n");
        await git(workspaceRoot, "add", "delete.txt");
        await git(workspaceRoot, "commit", "-qm", "add delete target");
        await rm(join(workspaceRoot, "delete.txt"));
        await writeFile(join(workspaceRoot, "staged.txt"), "staged\n");
        await git(workspaceRoot, "add", "staged.txt");
        feed.hint("z-untracked.txt", "a-watcher.txt", "tracked.txt");

        const result = await candidates.collect(await currentGitBoundary(workspaceRoot));

        expect(result).toEqual({
            status: "complete",
            paths: ["a-watcher.txt", "delete.txt", "staged.txt", "tracked.txt", "z-untracked.txt"],
            reconciled: false,
        });
    });

    test("excludes ignored paths from both Git status and watcher hints", async () => {
        await writeFile(join(workspaceRoot, "cache.ignored"), "ignored\n");
        feed.hint("cache.ignored");

        const result = await candidates.collect(await currentGitBoundary(workspaceRoot));

        expect(result).toEqual({ status: "complete", paths: [], reconciled: false });
    });

    test("collapses nested repository events to the repository boundary", async () => {
        const nested = join(workspaceRoot, "nested");
        await mkdir(nested);
        await git(nested, "init", "-q");
        await writeFile(join(nested, "inside.txt"), "nested\n");
        feed.hint("nested/inside.txt", "nested/.git/index");

        const result = await candidates.collect(await currentGitBoundary(workspaceRoot));

        expect(result).toEqual({ status: "complete", paths: ["nested"], reconciled: false });
    });

    test("does not follow a candidate symlink while checking nested repository boundaries", async () => {
        const outside = join(root, "outside");
        await mkdir(join(outside, "inside", ".git"), { recursive: true });
        await writeFile(join(outside, "inside", "content.txt"), "outside\n");
        await symlink(outside, join(workspaceRoot, "linked"));
        feed.hint("linked/inside/content.txt");

        const result = await candidates.collect(await currentGitBoundary(workspaceRoot));

        expect(result).toEqual({ status: "complete", paths: ["linked"], reconciled: false });
    });

    test("detects a clean checkout or reset through source HEAD and Shadow tree divergence", async () => {
        const shadowTree = await revParse(workspaceRoot, "HEAD^{tree}");
        await writeFile(join(workspaceRoot, "branch-only.txt"), "branch\n");
        await git(workspaceRoot, "add", "branch-only.txt");
        await git(workspaceRoot, "commit", "-qm", "branch state");
        const sourceHeadTree = await revParse(workspaceRoot, "HEAD^{tree}");
        expect(await gitStatus(workspaceRoot)).toBe("");

        const result = await candidates.collect({
            kind: "git",
            shadowGitDir: join(workspaceRoot, ".git"),
            sourceHeadTree,
            shadowTree,
        });

        expect(result).toEqual({ status: "complete", paths: ["branch-only.txt"], reconciled: false });
    });

    test("preserves a private tree difference hidden by current ignore rules", async () => {
        const shadowTree = await revParse(workspaceRoot, "HEAD^{tree}");
        await git(workspaceRoot, "rm", "-q", "tracked.txt");
        await writeFile(join(workspaceRoot, ".gitignore"), "*.ignored\ntracked.txt\n");
        await git(workspaceRoot, "add", ".gitignore");
        await git(workspaceRoot, "commit", "-qm", "delete and ignore tracked path");
        const sourceHeadTree = await revParse(workspaceRoot, "HEAD^{tree}");
        expect(await gitStatus(workspaceRoot)).toBe("");

        const result = await candidates.collect({
            kind: "git",
            shadowGitDir: join(workspaceRoot, ".git"),
            sourceHeadTree,
            shadowTree,
        });

        expect(result).toEqual({
            status: "complete",
            paths: [".gitignore", "tracked.txt"],
            reconciled: false,
        });
    });

    test("fails closed when the Shadow boundary is not readable in the private object database", async () => {
        const boundary = await currentGitBoundary(workspaceRoot);

        const result = await candidates.collect({ ...boundary, shadowTree: "f".repeat(40) });

        expect(result).toEqual({ status: "unavailable", reason: "git-query-failed" });
    });

    test("falls back to safe status when built-in fsmonitor is unavailable", async () => {
        const userGit = {
            run: vi
                .fn()
                .mockRejectedValueOnce(new Error("built-in fsmonitor unavailable"))
                .mockResolvedValueOnce({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
        };
        const shadowGit = {
            run: vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })),
        };
        const fallbackCandidates = new WorkspaceCandidates({
            workspaceRoot,
            feed,
            userGit: userGit as unknown as WorkspaceGitRunner,
            shadowGit: shadowGit as unknown as WorkspaceGitRunner,
        });

        await expect(
            fallbackCandidates.collect({
                kind: "git",
                shadowGitDir: join(workspaceRoot, ".git"),
                sourceHeadTree: "1".repeat(40),
                shadowTree: "2".repeat(40),
            })
        ).resolves.toEqual({ status: "complete", paths: [], reconciled: false });
        expect(userGit.run).toHaveBeenCalledTimes(2);
        expect(userGit.run.mock.calls[0]![1]).toMatchObject({ fsmonitor: "builtin" });
        expect(userGit.run.mock.calls[1]![1]).not.toHaveProperty("fsmonitor");
    });

    test("reconciles from Git metadata after watcher overflow", async () => {
        const boundary = await currentGitBoundary(workspaceRoot);
        await candidates.collect(boundary);
        await writeFile(join(workspaceRoot, "tracked.txt"), "after overflow\n");
        feed.loseTrust("overflow");

        const result = await candidates.collect(boundary);

        expect(result).toEqual({ status: "complete", paths: ["tracked.txt"], reconciled: true });
        expect(feed.startCalls).toBe(2);
    });
});

describe("WorkspaceCandidates non-Git discovery", () => {
    let root: string;
    let workspaceRoot: string;
    let feed: MemoryChangeFeed;
    let reconcile: ReturnType<typeof vi.fn<WorkspaceCandidateReconcile>>;
    let candidates: WorkspaceCandidates;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "crest-workspace-candidates-plain-"));
        workspaceRoot = join(root, "workspace");
        await mkdir(workspaceRoot);
        feed = new MemoryChangeFeed();
        reconcile = vi.fn<WorkspaceCandidateReconcile>(async () => ["z.txt", "a.txt"]);
        candidates = new WorkspaceCandidates({ workspaceRoot, feed, reconcile });
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    test("performs one cold baseline and then uses only warm in-memory hints", async () => {
        reconcile.mockImplementationOnce(async () => {
            feed.hint("during-baseline.txt");
            return ["z.txt", "a.txt"];
        });

        await expect(candidates.collect({ kind: "non-git" })).resolves.toEqual({
            status: "complete",
            paths: ["a.txt", "during-baseline.txt", "z.txt"],
            reconciled: true,
        });
        feed.hint("warm.txt", "a.txt", "warm.txt");
        await expect(candidates.collect({ kind: "non-git" })).resolves.toEqual({
            status: "complete",
            paths: ["a.txt", "warm.txt"],
            reconciled: false,
        });
        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(feed.startCalls).toBe(1);
    });

    test("reconciles after watcher overflow instead of trusting incomplete hints", async () => {
        await candidates.collect({ kind: "non-git" });
        feed.loseTrust("overflow");
        reconcile.mockResolvedValueOnce(["after-overflow.txt"]);

        await expect(candidates.collect({ kind: "non-git" })).resolves.toEqual({
            status: "complete",
            paths: ["after-overflow.txt"],
            reconciled: true,
        });
        expect(reconcile).toHaveBeenCalledTimes(2);
        expect(feed.startCalls).toBe(2);
    });

    test("rejects warm hints when the feed loses trust immediately after a complete drain", async () => {
        await candidates.collect({ kind: "non-git" });
        feed.hint("racy.txt");
        feed.loseTrustOnNextCompleteDrain("overflow");

        await expect(candidates.collect({ kind: "non-git" })).resolves.toEqual({
            status: "unavailable",
            reason: "watcher-error",
        });
        expect(reconcile).toHaveBeenCalledTimes(1);
    });

    test("does not publish a baseline when the feed loses trust immediately after its drain", async () => {
        feed.loseTrustOnNextCompleteDrain("overflow");

        await expect(candidates.collect({ kind: "non-git" })).resolves.toEqual({
            status: "unavailable",
            reason: "watcher-error",
        });
        expect(reconcile).toHaveBeenCalledTimes(1);

        await expect(candidates.collect({ kind: "non-git" })).resolves.toEqual({
            status: "complete",
            paths: ["a.txt", "z.txt"],
            reconciled: true,
        });
        expect(reconcile).toHaveBeenCalledTimes(2);
    });

    test("a runtime restart always establishes a new baseline and ignores old cursor artifacts", async () => {
        const legacyTracker = join(root, "store", "tracker");
        await mkdir(legacyTracker, { recursive: true });
        await writeFile(join(legacyTracker, "committed.cursor"), "stale cursor bytes");
        await candidates.collect({ kind: "non-git" });

        const restartedFeed = new MemoryChangeFeed();
        const restartedReconcile = vi.fn<WorkspaceCandidateReconcile>(async () => ["restart.txt"]);
        const restarted = new WorkspaceCandidates({
            workspaceRoot,
            feed: restartedFeed,
            reconcile: restartedReconcile,
        });

        await expect(restarted.collect({ kind: "non-git" })).resolves.toEqual({
            status: "complete",
            paths: ["restart.txt"],
            reconciled: true,
        });
        expect(restartedReconcile).toHaveBeenCalledTimes(1);
    });

    test("returns typed unavailable when the cold baseline cannot complete", async () => {
        reconcile.mockRejectedValueOnce(new Error("budget exceeded"));

        await expect(candidates.collect({ kind: "non-git" })).resolves.toEqual({
            status: "unavailable",
            reason: "reconcile-failed",
        });
    });

    test("preserves caller cancellation instead of translating it to unavailable", async () => {
        const controller = new AbortController();
        const reason = new Error("caller cancelled");
        reconcile.mockImplementationOnce(async () => {
            controller.abort(reason);
            throw new Error("reconcile observed abort");
        });

        await expect(candidates.collect({ kind: "non-git" }, controller.signal)).rejects.toBe(reason);
    });

    test("rejects unsafe baseline paths without publishing candidate truth", async () => {
        reconcile.mockResolvedValueOnce(["../outside.txt"]);

        await expect(candidates.collect({ kind: "non-git" })).resolves.toEqual({
            status: "unavailable",
            reason: "unsafe-path",
        });
    });
});

async function currentGitBoundary(workspaceRoot: string): Promise<GitWorkspaceCandidateBoundary> {
    const tree = await revParse(workspaceRoot, "HEAD^{tree}");
    return {
        kind: "git",
        shadowGitDir: join(workspaceRoot, ".git"),
        sourceHeadTree: tree,
        shadowTree: tree,
    };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
    await execFileAsync("git", args, { cwd });
}

async function revParse(cwd: string, revision: string): Promise<string> {
    const result = await execFileAsync("git", ["rev-parse", revision], { cwd });
    return result.stdout.trim();
}

async function gitStatus(cwd: string): Promise<string> {
    const result = await execFileAsync("git", ["status", "--porcelain"], { cwd });
    return result.stdout;
}
