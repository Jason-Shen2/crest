// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { execFile } from "node:child_process";
import { WorkspaceGitRunner } from "./git-runner";
import { IncrementalPathCapture } from "./incremental-path-capture";
import { makeProcessOwnerIdentity } from "./process-owner";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import { resolveCanonicalWorkspaceIdentity } from "./workspace-identity";
import { discoverWorkspaceScope } from "./workspace-scope";

const execFileAsync = promisify(execFile);

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
        vi.doUnmock("node:child_process");
        vi.doUnmock("./anchored-reader");
        vi.resetModules();
        if (previousDataHome == null) delete process.env.WAVETERM_DATA_HOME;
        else process.env.WAVETERM_DATA_HOME = previousDataHome;
        await rm(root, { recursive: true, force: true });
    });

    test("captures exact sorted file and absence mutations with actual hashed bytes", async () => {
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
        if (result.status === "captured" && result.mutations[0]!.state.state === "file") {
            const object = await git.run(["cat-file", "blob", result.mutations[0]!.state.oid], {
                gitDir: fixture.store.storeRoot,
                timeoutMs: 5_000,
            });
            expect(object.stdout).toEqual(Buffer.from("after"));
        }
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

    test.runIf(process.platform !== "win32")(
        "captures binary, symlink, executable mode, directory subtree, ignored and oversized states",
        async () => {
            await writeFile(join(workspace, ".gitignore"), "*.ignored\n");
            const fixture = await makeCaptureFixture(root, workspace, git, 16);
            await writeFile(join(workspace, "binary.bin"), Buffer.from([0, 255, 1]));
            await symlink("binary.bin", join(workspace, "link"));
            await writeFile(join(workspace, "run.sh"), "echo ok\n");
            await chmod(join(workspace, "run.sh"), 0o755);
            await mkdir(join(workspace, "new-dir"));
            await writeFile(join(workspace, "new-dir", "b.txt"), "b");
            await writeFile(join(workspace, "new-dir", "a.txt"), "a");
            await writeFile(join(workspace, "cache.ignored"), "ignored");
            await writeFile(join(workspace, "large.bin"), "12345678901234567");

            const result = await fixture.capture.capture([
                "run.sh",
                "new-dir",
                "link",
                "large.bin",
                "cache.ignored",
                "binary.bin",
            ]);

            expect(result).toMatchObject({
                status: "captured",
                mutations: [
                    { path: "binary.bin", state: { state: "file", executable: false } },
                    { path: "cache.ignored", state: { state: "excluded", reason: "ignored" } },
                    { path: "large.bin", state: { state: "excluded", reason: "oversized-untracked" } },
                    { path: "link", state: { state: "symlink" } },
                    { path: "new-dir/a.txt", state: { state: "file" } },
                    { path: "new-dir/b.txt", state: { state: "file" } },
                    { path: "run.sh", state: { state: "file", executable: true } },
                ],
                newlyHashedBytes: 23,
            });
        }
    );

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
            const object = await git.run(["cat-file", "blob", result.mutations[0]!.state.oid], {
                gitDir: fixture.store.storeRoot,
                timeoutMs: 5_000,
            });
            expect(object.stdout).toEqual(Buffer.from("other"));
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
    };
    return { capture: new IncrementalPathCapture(options), identity, options, store };
}
