// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { WorkspaceGitRunner, WorkspaceGitRunnerError } from "./git-runner";
import { IncrementalPathCapture } from "./incremental-path-capture";
import { makeProcessOwnerIdentity } from "./process-owner";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import { resolveCanonicalWorkspaceIdentity } from "./workspace-identity";
import { discoverWorkspaceScope } from "./workspace-scope";

const execFileAsync = promisify(execFile);
const capturesForCleanup: IncrementalPathCapture[] = [];

describe("IncrementalPathCapture", () => {
    let root: string;
    let workspace: string;
    let previousDataHome: string | undefined;
    const git = new WorkspaceGitRunner();

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "crest-incremental-capture-"));
        workspace = join(root, "workspace");
        await mkdir(workspace);
        previousDataHome = process.env.WAVETERM_DATA_HOME;
        process.env.WAVETERM_DATA_HOME = join(root, "data-home");
    });

    afterEach(async () => {
        await Promise.all(capturesForCleanup.splice(0).map((capture) => capture.dispose()));
        vi.doUnmock("node:child_process");
        vi.doUnmock("./anchored-reader");
        vi.resetModules();
        if (previousDataHome == null) delete process.env.WAVETERM_DATA_HOME;
        else process.env.WAVETERM_DATA_HOME = previousDataHome;
        await rm(root, { recursive: true, force: true });
    });

    test("captures exact sorted file and absence mutations without writing unrooted Git objects", async () => {
        await writeFile(join(workspace, "README.md"), "before");
        await writeFile(join(workspace, "deleted.txt"), "delete me");
        const fixture = await makeCaptureFixture(root, workspace, git);
        await writeFile(join(workspace, "README.md"), "after");
        await rm(join(workspace, "deleted.txt"));

        const result = await fixture.capture.capture(["deleted.txt", "README.md", "README.md"]);

        expect(result).toMatchObject({
            status: "captured",
            mutations: [
                {
                    path: "README.md",
                    state: { state: "file", executable: false, oid: expect.stringMatching(/^[0-9a-f]{40}$/) },
                },
                { path: "deleted.txt", state: { state: "absent" } },
            ],
            newlyHashedBytes: 5,
        });
        if (result.status !== "captured" || result.mutations[0]!.state.state !== "file") {
            throw new Error("expected captured file mutation");
        }
        await expect(
            git.run(["cat-file", "blob", result.mutations[0]!.state.oid], {
                gitDir: fixture.store.storeRoot,
                timeoutMs: 5_000,
            })
        ).rejects.toMatchObject({ code: "nonzero_exit" });
        await fixture.capture.discardCaptured(result);
        await expect(fixture.capture.discardCaptured(result)).rejects.toThrow(/consumed|discarded|pending/i);
    });

    test("keeps multiple pending capture results isolated until each is explicitly discarded", async () => {
        await writeFile(join(workspace, "one.txt"), "one");
        await writeFile(join(workspace, "two.txt"), "two");
        const fixture = await makeCaptureFixture(root, workspace, git);

        const first = await fixture.capture.capture(["one.txt"]);
        const second = await fixture.capture.capture(["two.txt"]);
        if (first.status !== "captured" || second.status !== "captured") {
            throw new Error("expected pending captures");
        }
        await fixture.capture.discardCaptured(first);
        await expect(fixture.capture.discardCaptured(first)).rejects.toThrow(/consumed|discarded|pending/i);
        await expect(fixture.capture.discardCaptured(second)).resolves.toBeUndefined();
    });

    test("disposes every abandoned pending capture and invalidates its result", async () => {
        await writeFile(join(workspace, "one.txt"), "one");
        await writeFile(join(workspace, "two.txt"), "two");
        const fixture = await makeCaptureFixture(root, workspace, git);

        const first = await fixture.capture.capture(["one.txt"]);
        const second = await fixture.capture.capture(["two.txt"]);
        await fixture.capture.dispose();

        await expect(fixture.capture.discardCaptured(first)).rejects.toThrow(/consumed|discarded|pending/i);
        await expect(fixture.capture.discardCaptured(second)).rejects.toThrow(/consumed|discarded|pending/i);
        await expect(fixture.capture.dispose()).resolves.toBeUndefined();
    });

    test("returns scope-invalidated for ignore, Git metadata, nested repository, and root identity changes", async () => {
        await writeFile(join(workspace, ".gitignore"), "*.ignored\n");
        await mkdir(join(workspace, "nested", ".git"), { recursive: true });
        const fixture = await makeCaptureFixture(root, workspace, git);

        await expect(fixture.capture.capture([".gitignore"])).resolves.toEqual({
            status: "reconcile",
            reason: "scope-invalidated",
        });
        await expect(fixture.capture.capture([".git/index"])).resolves.toEqual({
            status: "reconcile",
            reason: "scope-invalidated",
        });
        await expect(fixture.capture.capture(["nested/.git/config"])).resolves.toEqual({
            status: "reconcile",
            reason: "scope-invalidated",
        });

        const changedIdentity = {
            ...fixture.identity,
            ancestorIdentityChain: fixture.identity.ancestorIdentityChain.map((item, index) =>
                index === fixture.identity.ancestorIdentityChain.length - 1 ? { ...item, ino: "1" } : item
            ),
        };
        const invalid = new IncrementalPathCapture({ ...fixture.options, identity: changedIdentity });
        await expect(invalid.capture(["README.md"])).resolves.toEqual({
            status: "reconcile",
            reason: "scope-invalidated",
        });
    });

    test("captures binary, directory subtree, ignored and oversized states", async () => {
        await writeFile(join(workspace, ".gitignore"), "*.ignored\n");
        const fixture = await makeCaptureFixture(root, workspace, git, 16);
        await writeFile(join(workspace, "binary.bin"), Buffer.from([0, 255, 1]));
        await mkdir(join(workspace, "new-dir"));
        await writeFile(join(workspace, "new-dir", "b.txt"), "b");
        await writeFile(join(workspace, "new-dir", "a.txt"), "a");
        await writeFile(join(workspace, "cache.ignored"), "ignored");
        await writeFile(join(workspace, "large.bin"), "12345678901234567");

        const result = await fixture.capture.capture(["new-dir", "large.bin", "cache.ignored", "binary.bin"]);

        expect(result).toMatchObject({
            status: "captured",
            mutations: [
                { path: "binary.bin", state: { state: "file", executable: false } },
                { path: "cache.ignored", state: { state: "excluded", reason: "ignored" } },
                { path: "large.bin", state: { state: "excluded", reason: "oversized-untracked" } },
                { path: "new-dir/a.txt", state: { state: "file" } },
                { path: "new-dir/b.txt", state: { state: "file" } },
            ],
            newlyHashedBytes: 5,
        });
        await fixture.capture.discardCaptured(result);
    });

    test.runIf(process.platform !== "win32")("captures symlink and executable mode states", async () => {
        const fixture = await makeCaptureFixture(root, workspace, git);
        await writeFile(join(workspace, "binary.bin"), Buffer.from([0, 255, 1]));
        await symlink("binary.bin", join(workspace, "link"));
        await writeFile(join(workspace, "run.sh"), "echo ok\n");
        await chmod(join(workspace, "run.sh"), 0o755);

        const result = await fixture.capture.capture(["run.sh", "link"]);

        expect(result).toMatchObject({
            status: "captured",
            mutations: [
                { path: "link", state: { state: "symlink" } },
                { path: "run.sh", state: { state: "file", executable: true } },
            ],
            newlyHashedBytes: 18,
        });
        await fixture.capture.discardCaptured(result);
    });

    test("fails closed for hard links and aggregate hash budget exhaustion", async () => {
        await writeFile(join(workspace, "original.txt"), "linked");
        await link(join(workspace, "original.txt"), join(workspace, "linked.txt"));
        const fixture = await makeCaptureFixture(root, workspace, git, 1024, 5);

        await expect(fixture.capture.capture(["linked.txt"])).resolves.toEqual({
            status: "reconcile",
            reason: "unsafe-evidence",
        });
        await rm(join(workspace, "linked.txt"));
        await writeFile(join(workspace, "budget.txt"), "123456");
        await expect(fixture.capture.capture(["budget.txt"])).resolves.toEqual({
            status: "reconcile",
            reason: "unsafe-evidence",
        });
    });

    test("fails closed when a dirty path replaces a base leaf with a tree or a base tree with a leaf", async () => {
        await writeFile(join(workspace, "leaf"), "leaf");
        await mkdir(join(workspace, "tree"));
        await writeFile(join(workspace, "tree", "child.txt"), "child");
        const fixture = await makeCaptureFixture(root, workspace, git);
        await rm(join(workspace, "leaf"));
        await mkdir(join(workspace, "leaf"));
        await writeFile(join(workspace, "leaf", "child.txt"), "child");
        await rm(join(workspace, "tree"), { recursive: true });
        await writeFile(join(workspace, "tree"), "leaf");

        await expect(fixture.capture.capture(["leaf"])).resolves.toEqual({
            status: "reconcile",
            reason: "unsafe-evidence",
        });
        await expect(fixture.capture.capture(["tree"])).resolves.toEqual({
            status: "reconcile",
            reason: "unsafe-evidence",
        });
        await expect(fixture.capture.capture(["leaf/child.txt"])).resolves.toEqual({
            status: "reconcile",
            reason: "unsafe-evidence",
        });
    });

    test("accepts a base tree deletion and a newly created tree", async () => {
        await mkdir(join(workspace, "deleted"));
        await writeFile(join(workspace, "deleted", "child.txt"), "child");
        const fixture = await makeCaptureFixture(root, workspace, git);
        await rm(join(workspace, "deleted"), { recursive: true });
        await mkdir(join(workspace, "created"));
        await writeFile(join(workspace, "created", "child.txt"), "child");

        const result = await fixture.capture.capture(["deleted", "created"]);

        expect(result).toMatchObject({
            status: "captured",
            mutations: [
                { path: "created/child.txt", state: { state: "file" } },
                { path: "deleted", state: { state: "absent" } },
            ],
        });
        await fixture.capture.discardCaptured(result);
    });

    test("rehashes a same-size content rewrite even when mtime is restored", async () => {
        const path = join(workspace, "racy.txt");
        await writeFile(path, "first");
        const original = await stat(path);
        const fixture = await makeCaptureFixture(root, workspace, git);
        await writeFile(path, "other");
        await utimes(path, original.atime, original.mtime);

        const result = await fixture.capture.capture(["racy.txt"]);

        expect(result).toMatchObject({ status: "captured", newlyHashedBytes: 5 });
        if (result.status === "captured" && result.mutations[0]!.state.state === "file") {
            expect(result.mutations[0]!.state.oid).toBe(
                createHash("sha1").update(Buffer.from("blob 5\0other")).digest("hex")
            );
            await fixture.capture.discardCaptured(result);
        }
    });

    test.runIf(process.platform !== "win32")("captures a mode-only file change", async () => {
        const path = join(workspace, "mode-only.sh");
        await writeFile(path, "echo ok\n");
        await chmod(path, 0o644);
        const fixture = await makeCaptureFixture(root, workspace, git);
        await chmod(path, 0o755);

        await expect(fixture.capture.capture(["mode-only.sh"])).resolves.toMatchObject({
            status: "captured",
            mutations: [{ path: "mode-only.sh", state: { state: "file", executable: true } }],
            newlyHashedBytes: 8,
        });
    });

    test.runIf(process.platform !== "win32")("fails closed when a dirty path has a symlink ancestor", async () => {
        const outside = join(root, "outside");
        await mkdir(join(workspace, "parent"));
        await mkdir(outside);
        await writeFile(join(workspace, "parent", "file.txt"), "inside");
        const fixture = await makeCaptureFixture(root, workspace, git);
        await rm(join(workspace, "parent"), { recursive: true });
        await symlink(outside, join(workspace, "parent"));

        await expect(fixture.capture.capture(["parent/file.txt"])).resolves.toEqual({
            status: "reconcile",
            reason: "unsafe-evidence",
        });
    });

    test("maps a path identity change before anchored read to unstable-path", async () => {
        const target = join(workspace, "unstable.txt");
        const replacement = join(workspace, "replacement.txt");
        await writeFile(target, "before");
        await writeFile(replacement, "after!");
        const fixture = await makeCaptureFixture(root, workspace, git);
        let replaced = false;
        vi.doMock("./anchored-reader", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./anchored-reader")>();
            return {
                ...actual,
                runAnchoredReaderBatch: async (...args: Parameters<typeof actual.runAnchoredReaderBatch>) => {
                    if (!replaced) {
                        replaced = true;
                        await rm(target);
                        await writeFile(target, await readFile(replacement));
                    }
                    return actual.runAnchoredReaderBatch(...args);
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./incremental-path-capture");
        const isolatedGit = new (await import("./git-runner")).WorkspaceGitRunner();
        const capture = new isolated.IncrementalPathCapture({ ...fixture.options, git: isolatedGit });

        await expect(capture.capture(["unstable.txt"])).resolves.toEqual({
            status: "reconcile",
            reason: "unstable-path",
        });
        expect(replaced).toBe(true);
    });

    test("maps Git runner failures to unsafe evidence instead of a path race", async () => {
        await writeFile(join(workspace, "README.md"), "value");
        const fixture = await makeCaptureFixture(root, workspace, git);
        await rm(join(workspace, "README.md"));
        const failingGit = new WorkspaceGitRunner();
        failingGit.run = async () => {
            throw new WorkspaceGitRunnerError("timeout", "timed out");
        };
        const capture = new IncrementalPathCapture({ ...fixture.options, git: failingGit });

        await expect(capture.capture(["README.md"])).resolves.toEqual({
            status: "reconcile",
            reason: "unsafe-evidence",
        });
    });

    test.each([
        ["dubious ownership", "fatal: detected dubious ownership in repository\n"],
        ["corrupt gitfile", "fatal: invalid gitfile format: .git\n"],
        ["permission failure", "fatal: cannot open '.git/HEAD': Permission denied\n"],
    ])("does not interpret rev-parse %s as a non-Git workspace", async (_label, stderr) => {
        await writeFile(join(workspace, "README.md"), "value");
        const fixture = await makeCaptureFixture(root, workspace, git);
        await rm(join(workspace, "README.md"));
        const failingGit = new WorkspaceGitRunner();
        failingGit.run = async () => {
            throw new WorkspaceGitRunnerError(
                "nonzero_exit",
                "rev-parse failed",
                Buffer.alloc(0),
                Buffer.from(stderr),
                128
            );
        };
        const capture = new IncrementalPathCapture({ ...fixture.options, git: failingGit });

        await expect(capture.capture(["README.md"])).resolves.toEqual({
            status: "reconcile",
            reason: "unsafe-evidence",
        });
    });

    test("does not interpret malformed successful rev-parse output as a non-Git workspace", async () => {
        await writeFile(join(workspace, "README.md"), "value");
        const fixture = await makeCaptureFixture(root, workspace, git);
        await rm(join(workspace, "README.md"));
        const malformedGit = new WorkspaceGitRunner();
        malformedGit.run = async () => ({ stdout: Buffer.from("maybe\n"), stderr: Buffer.alloc(0) });
        const capture = new IncrementalPathCapture({ ...fixture.options, git: malformedGit });

        await expect(capture.capture(["README.md"])).resolves.toEqual({
            status: "reconcile",
            reason: "unsafe-evidence",
        });
    });

    test.runIf(process.platform === "linux")("fails closed on non-UTF-8 subtree evidence", async () => {
        await mkdir(join(workspace, "raw"));
        const rawPath = Buffer.concat([Buffer.from(`${join(workspace, "raw")}/`), Buffer.from([0xff])]);
        await writeFile(rawPath, "unsafe");
        const fixture = await makeCaptureFixture(root, workspace, git);

        await expect(fixture.capture.capture(["raw"])).resolves.toEqual({
            status: "reconcile",
            reason: "unsafe-evidence",
        });
    });

    test("returns an empty capture without hashing or Git path classification", async () => {
        const fixture = await makeCaptureFixture(root, workspace, git);
        const calls: string[][] = [];
        const originalRun = git.run.bind(git);
        git.run = async (args, options) => {
            calls.push([...args]);
            return originalRun(args, options);
        };

        await expect(fixture.capture.capture([])).resolves.toEqual({
            status: "captured",
            mutations: [],
            newlyHashedBytes: 0,
        });
        expect(calls).toEqual([]);
    });

    test("classifies tracked and ignored dirty paths with batched Git commands", async () => {
        await execFileAsync("git", ["init"], { cwd: workspace });
        await writeFile(join(workspace, ".gitignore"), "*.ignored\n");
        await writeFile(join(workspace, "tracked.txt"), "before");
        await execFileAsync("git", ["add", ".gitignore", "tracked.txt"], { cwd: workspace });
        const fixture = await makeCaptureFixture(root, workspace, git);
        await writeFile(join(workspace, "tracked.txt"), "after");
        await writeFile(join(workspace, "cache.ignored"), "cache");
        const calls: Array<{ args: readonly string[]; stdin?: Buffer }> = [];
        const originalRun = git.run.bind(git);
        git.run = async (args, options) => {
            calls.push({ args: [...args], stdin: options.stdin });
            return originalRun(args, options);
        };

        const result = await fixture.capture.capture(["tracked.txt", "cache.ignored"]);
        expect(result).toMatchObject({
            status: "captured",
            mutations: [
                { path: "cache.ignored", state: { state: "excluded", reason: "ignored" } },
                { path: "tracked.txt", state: { state: "file" } },
            ],
        });
        expect(calls.some((call) => call.args.slice(0, 4).join(" ") === "ls-files --cached -z --")).toBe(true);
        expect(calls).toContainEqual(
            expect.objectContaining({
                args: ["check-ignore", "-z", "--stdin"],
                stdin: Buffer.from("cache.ignored\0tracked.txt\0"),
            })
        );
    });

    test("invalidates scope for newly created and externally changed ignore inputs", async () => {
        const plain = await makeCaptureFixture(root, workspace, git);
        await mkdir(join(workspace, "nested"));
        await writeFile(join(workspace, "nested", ".gitignore"), "*.tmp\n");
        await expect(plain.capture.capture(["nested/.gitignore"])).resolves.toEqual({
            status: "reconcile",
            reason: "scope-invalidated",
        });

        const repository = join(root, "repository");
        await mkdir(repository);
        await execFileAsync("git", ["init"], { cwd: repository });
        const repositoryCapture = await makeCaptureFixture(root, repository, git);
        await writeFile(join(repository, ".git", "info", "exclude"), "*.secret\n");
        await expect(repositoryCapture.capture.capture(["README.md"])).resolves.toEqual({
            status: "reconcile",
            reason: "scope-invalidated",
        });
    });

    test("invalidates a linked-worktree scope when only its external Git index changes", async () => {
        const repository = join(root, "repository");
        const worktree = join(root, "linked-worktree");
        await mkdir(repository);
        await execFileAsync("git", ["init"], { cwd: repository });
        await execFileAsync("git", ["config", "user.email", "crest@example.com"], { cwd: repository });
        await execFileAsync("git", ["config", "user.name", "Crest Test"], { cwd: repository });
        await writeFile(join(repository, "tracked.txt"), "tracked");
        await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
        await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repository });
        await execFileAsync("git", ["worktree", "add", worktree], { cwd: repository });
        await writeFile(join(worktree, "dirty.txt"), "dirty");
        const fixture = await makeCaptureFixture(root, worktree, git);
        expect(fixture.options.scope.gitIndex).toMatchObject({ state: "file" });
        const indexPath = (
            await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
                cwd: worktree,
            })
        ).stdout.trim();
        const before = await stat(indexPath);
        const bytes = await readFile(indexPath);
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        await writeFile(indexPath, bytes);
        await utimes(indexPath, before.atime, before.mtime);

        await expect(fixture.capture.capture(["dirty.txt"])).resolves.toEqual({
            status: "reconcile",
            reason: "scope-invalidated",
        });
    });

    test("invalidates an old Git scope manifest that has no index evidence", async () => {
        const repository = join(root, "repository");
        await mkdir(repository);
        await execFileAsync("git", ["init"], { cwd: repository });
        await writeFile(join(repository, "dirty.txt"), "dirty");
        const fixture = await makeCaptureFixture(root, repository, git);
        const scope = structuredClone(fixture.options.scope);
        delete scope.gitIndex;
        const capture = new IncrementalPathCapture({ ...fixture.options, scope });

        await expect(capture.capture(["dirty.txt"])).resolves.toEqual({
            status: "reconcile",
            reason: "scope-invalidated",
        });
    });
});

async function makeCaptureFixture(
    root: string,
    workspace: string,
    git: WorkspaceGitRunner,
    maxUntrackedBytes = 2 * 1024 ** 2,
    maxNewlyHashedBytes = 1024 ** 2
) {
    const identity = await resolveCanonicalWorkspaceIdentity(workspace);
    const scope = await discoverWorkspaceScope({ identity, git, maxEntries: 10_000, maxUntrackedBytes });
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: join(root, "data"),
        identity,
        git,
        processOwner: await makeProcessOwnerIdentity(),
    });
    const options = {
        identity,
        git,
        storeRoot: store.storeRoot,
        scope: scope.manifest,
        maxEntries: 10_000,
        maxUntrackedBytes,
        maxNewlyHashedBytes,
        timeoutMs: 10_000,
        base: {
            readNodeKind: async (path: string) => {
                if (scope.entries.some((entry) => entry.path === path)) return "leaf" as const;
                const segments = path.split("/");
                for (let index = 1; index < segments.length; index++) {
                    if (scope.entries.some((entry) => entry.path === segments.slice(0, index).join("/"))) {
                        throw new Error("base path traverses a leaf");
                    }
                }
                if (scope.directories.some((entry) => entry.pathBytes.toString("utf8") === path)) {
                    return "tree" as const;
                }
                return "absent" as const;
            },
        },
    };
    const capture = new IncrementalPathCapture(options);
    capturesForCleanup.push(capture);
    return { capture, identity, options, store };
}
