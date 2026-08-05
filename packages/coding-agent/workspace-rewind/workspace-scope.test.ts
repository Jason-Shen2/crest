// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import {
    chmod,
    link,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { WorkspaceGitRunner, WorkspaceGitRunnerError } from "./git-runner";
import { resolveCanonicalWorkspaceIdentity } from "./workspace-identity";
import { classifyIncrementalWorkspacePaths, discoverWorkspaceScope, type WorkspaceScopeEntry } from "./workspace-scope";

const execFileAsync = promisify(execFile);
const TwoMiB = 2 * 1024 * 1024;

describe("discoverWorkspaceScope", () => {
    test("returns raw-safe transient directory evidence that detects a newly added name", async () => {
        const workspace = join(root, "workspace");
        await mkdir(join(workspace, "nested"), { recursive: true });
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const scope = await discoverWorkspaceScope({
            identity,
            git: gitRunner,
            maxEntries: 200_000,
            maxUntrackedBytes: 2 * 1024 ** 2,
        });
        const transient = scope as typeof scope & {
            directories?: Array<{
                pathBytes: Buffer;
                dev: bigint;
                ino: bigint;
                birthtimeNs: bigint;
                mtimeNs: bigint;
                ctimeNs: bigint;
                namesHash: string;
            }>;
        };

        expect(transient.directories?.map((item) => item.pathBytes)).toEqual([Buffer.alloc(0), Buffer.from("nested")]);
        expect(
            transient.directories?.every(
                (item) =>
                    item.dev > 0n &&
                    item.ino > 0n &&
                    item.birthtimeNs >= 0n &&
                    item.mtimeNs > 0n &&
                    item.ctimeNs > 0n &&
                    /^[0-9a-f]{64}$/.test(item.namesHash)
            )
        ).toBe(true);

        await writeFile(join(workspace, "added.txt"), "added");
        const module = await import("./workspace-scope");
        const verify = (
            module as typeof module & {
                verifyWorkspaceScopeDirectories: (value: typeof scope, signal?: AbortSignal) => Promise<boolean>;
            }
        ).verifyWorkspaceScopeDirectories;
        expect(typeof verify).toBe("function");
        await expect(verify(scope)).resolves.toBe(false);
    });

    let root: string;
    let dataHome: string;
    let originalDataHome: string | undefined;
    let gitRunner: WorkspaceGitRunner;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "crest-workspace-scope-"));
        dataHome = join(root, "crest-data");
        originalDataHome = process.env.WAVETERM_DATA_HOME;
        process.env.WAVETERM_DATA_HOME = dataHome;
        gitRunner = new WorkspaceGitRunner();
    });

    afterEach(async () => {
        if (originalDataHome == null) {
            delete process.env.WAVETERM_DATA_HOME;
        } else {
            process.env.WAVETERM_DATA_HOME = originalDataHome;
        }
        await rm(root, { recursive: true, force: true });
    });

    test("captures tracked and non-ignored untracked files without changing the Git index", async () => {
        const workspace = join(root, "repository");
        await mkdir(workspace);
        await git(workspace, "init");
        await writeFile(join(workspace, "tracked.txt"), "tracked");
        await git(workspace, "add", "tracked.txt");
        await writeFile(join(workspace, "untracked.txt"), "untracked");
        await writeFile(join(workspace, ".gitignore"), "*.secret\n");
        await writeFile(join(workspace, ".git", "info", "exclude"), "*.private\n");
        const coreExcludesFile = join(root, "core-excludes");
        await writeFile(coreExcludesFile, "*.local-ignore\n");
        await git(workspace, "config", "core.excludesFile", coreExcludesFile);
        const indexPath = join(workspace, ".git", "index");
        const fixedTime = new Date("2024-02-03T04:05:06.000Z");
        await utimes(indexPath, fixedTime, fixedTime);
        const beforeBytes = await readFile(indexPath);
        const beforeStat = await stat(indexPath, { bigint: true });

        const scope = await discover(workspace);

        expect(entry(scope.entries, "tracked.txt")).toMatchObject({ kind: "file", tracked: true, size: 7 });
        expect(entry(scope.entries, "untracked.txt")).toMatchObject({ kind: "file", tracked: false, size: 9 });
        expect(await readFile(indexPath)).toEqual(beforeBytes);
        expect((await stat(indexPath, { bigint: true })).mtimeNs).toBe(beforeStat.mtimeNs);
        expect(scope.manifest.policy).toEqual({
            maxEntries: 10_000,
            maxUntrackedBytes: TwoMiB,
            gitGlobalExcludes: "disabled-by-isolated-runner",
        });
        expect(scope.manifest.ignoreInputs).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: "gitignore",
                    path: ".gitignore",
                    contentHash: sha256("*.secret\n"),
                }),
                expect.objectContaining({
                    source: "git-info-exclude",
                    contentHash: sha256("*.private\n"),
                }),
                expect.objectContaining({
                    source: "git-core-excludes-file",
                    contentHash: sha256("*.local-ignore\n"),
                }),
            ])
        );
    });

    test("does not open stable warm Git index content during incremental scope checks", async () => {
        const workspace = join(root, "repository");
        await mkdir(workspace);
        await git(workspace, "init");
        await writeFile(join(workspace, "tracked.txt"), "tracked");
        await git(workspace, "add", "tracked.txt");
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const scope = await discoverWorkspaceScope({
            identity,
            git: gitRunner,
            maxEntries: 10_000,
            maxUntrackedBytes: TwoMiB,
        });
        const indexPath = scope.manifest.gitIndex?.path;
        expect(indexPath).toBeTruthy();
        let indexOpenCount = 0;
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2_000);
        vi.resetModules();
        vi.doMock("node:fs/promises", async () => {
            const actual = await vi.importActual<typeof fsPromises>("node:fs/promises");
            return {
                ...actual,
                open: async (...args: Parameters<typeof actual.open>) => {
                    const path = Buffer.isBuffer(args[0]) ? args[0].toString() : String(args[0]);
                    if (path === indexPath) {
                        indexOpenCount += 1;
                        throw new Error("stable index content must not be opened");
                    }
                    return actual.open(...args);
                },
            };
        });
        try {
            const [isolatedScope, isolatedGit] = await Promise.all([
                import("./workspace-scope"),
                import("./git-runner"),
            ]);

            await expect(
                isolatedScope.classifyIncrementalWorkspacePaths({
                    identity,
                    git: new isolatedGit.WorkspaceGitRunner(),
                    scope: scope.manifest,
                    paths: ["tracked.txt"],
                    maxEntries: 10_000,
                    maxUntrackedBytes: TwoMiB,
                })
            ).resolves.toMatchObject({ status: "captured" });
            expect(indexOpenCount).toBe(0);
        } finally {
            clock.mockRestore();
            vi.doUnmock("node:fs/promises");
            vi.resetModules();
        }
    });

    test("rehashes matching but racy Git index metadata before trusting stored content", async () => {
        const workspace = join(root, "repository");
        await mkdir(workspace);
        await git(workspace, "init");
        await writeFile(join(workspace, "tracked.txt"), "tracked");
        await git(workspace, "add", "tracked.txt");
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const scope = await discoverWorkspaceScope({
            identity,
            git: gitRunner,
            maxEntries: 10_000,
            maxUntrackedBytes: TwoMiB,
        });
        const index = scope.manifest.gitIndex!;
        const before = await stat(index.path);
        const bytes = await readFile(index.path);
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        await writeFile(index.path, bytes);
        await utimes(index.path, before.atime, before.mtime);
        const current = await stat(index.path, { bigint: true });
        index.entryIdentity = {
            dev: current.dev.toString(),
            ino: current.ino.toString(),
            birthtimeNs: current.birthtimeNs.toString(),
            mode: current.mode.toString(),
            nlink: current.nlink.toString(),
            size: current.size.toString(),
            mtimeNs: current.mtimeNs.toString(),
            ctimeNs: current.ctimeNs.toString(),
        };

        await expect(
            classifyIncrementalWorkspacePaths({
                identity,
                git: gitRunner,
                scope: scope.manifest,
                paths: ["tracked.txt"],
                maxEntries: 10_000,
                maxUntrackedBytes: TwoMiB,
            })
        ).resolves.toEqual({ status: "reconcile", reason: "scope-invalidated" });
    });

    test("uses primary index evidence with split-index repositories when Git supports it", async () => {
        const workspace = join(root, "split-index");
        await mkdir(workspace);
        await git(workspace, "init");
        await writeFile(join(workspace, "tracked.txt"), "before");
        await git(workspace, "add", "tracked.txt");
        try {
            await git(workspace, "update-index", "--split-index");
        } catch {
            return;
        }
        if (!(await readdir(join(workspace, ".git"))).some((name) => name.startsWith("sharedindex."))) return;
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const scope = await discoverWorkspaceScope({
            identity,
            git: gitRunner,
            maxEntries: 10_000,
            maxUntrackedBytes: TwoMiB,
        });
        await writeFile(join(workspace, "tracked.txt"), "after");

        await expect(
            classifyIncrementalWorkspacePaths({
                identity,
                git: gitRunner,
                scope: scope.manifest,
                paths: ["tracked.txt"],
                maxEntries: 10_000,
                maxUntrackedBytes: TwoMiB,
            })
        ).resolves.toMatchObject({
            status: "captured",
            entries: [expect.objectContaining({ path: "tracked.txt", tracked: true })],
        });
    });

    test("uses primary index evidence with sparse-index repositories when Git supports it", async () => {
        const workspace = join(root, "sparse-index");
        await mkdir(join(workspace, "src"), { recursive: true });
        await mkdir(join(workspace, "docs"));
        await git(workspace, "init");
        await git(workspace, "config", "user.email", "crest@example.com");
        await git(workspace, "config", "user.name", "Crest Test");
        await writeFile(join(workspace, "src", "index.ts"), "before");
        await writeFile(join(workspace, "docs", "guide.md"), "guide");
        await git(workspace, "add", ".");
        await git(workspace, "commit", "-m", "initial");
        try {
            await git(workspace, "sparse-checkout", "init", "--cone", "--sparse-index");
            await git(workspace, "sparse-checkout", "set", "src");
        } catch {
            return;
        }
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const scope = await discoverWorkspaceScope({
            identity,
            git: gitRunner,
            maxEntries: 10_000,
            maxUntrackedBytes: TwoMiB,
        });
        await writeFile(join(workspace, "src", "index.ts"), "after");

        await expect(
            classifyIncrementalWorkspacePaths({
                identity,
                git: gitRunner,
                scope: scope.manifest,
                paths: ["src/index.ts"],
                maxEntries: 10_000,
                maxUntrackedBytes: TwoMiB,
            })
        ).resolves.toMatchObject({
            status: "captured",
            entries: [expect.objectContaining({ path: "src/index.ts", tracked: true })],
        });
    });

    test("records linked-worktree ignore inputs while preserving its user index", async () => {
        const repository = join(root, "repository");
        const worktree = join(root, "linked-worktree");
        await mkdir(repository);
        await git(repository, "init");
        await git(repository, "config", "user.email", "crest@example.com");
        await git(repository, "config", "user.name", "Crest Test");
        await git(repository, "commit", "--allow-empty", "-m", "initial");
        await git(repository, "worktree", "add", worktree);
        await writeFile(join(worktree, ".gitignore"), "*.worktree-secret\n");
        await writeFile(join(repository, ".git", "info", "exclude"), "*.shared-secret\n");
        const indexPath = (
            await gitOutput(worktree, "rev-parse", "--path-format=absolute", "--git-path", "index")
        ).trim();
        const fixedTime = new Date("2024-03-04T05:06:07.000Z");
        await utimes(indexPath, fixedTime, fixedTime);
        const beforeBytes = await readFile(indexPath);
        const beforeStat = await stat(indexPath, { bigint: true });

        const scope = await discover(worktree);

        expect(scope.manifest.ignoreInputs).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: "gitignore",
                    path: ".gitignore",
                    contentHash: sha256("*.worktree-secret\n"),
                }),
                expect.objectContaining({
                    source: "git-info-exclude",
                    contentHash: sha256("*.shared-secret\n"),
                }),
            ])
        );
        expect(await readFile(indexPath)).toEqual(beforeBytes);
        expect((await stat(indexPath, { bigint: true })).mtimeNs).toBe(beforeStat.mtimeNs);
    });

    test("preserves NUL-delimited Git pathnames containing tabs, newlines, and surrounding spaces", async () => {
        const workspace = join(root, "repository");
        await mkdir(workspace);
        await git(workspace, "init");
        const paths = ["tab\tname.txt", "line\nname.txt", " leading and trailing "];
        for (const path of paths) {
            await writeFile(join(workspace, path), path);
            await git(workspace, "add", "--", path);
        }

        const scope = await discover(workspace);

        for (const path of paths) {
            expect(entry(scope.entries, path)).toMatchObject({ path, kind: "file", tracked: true });
            expect(entry(scope.entries, path).pathBytes).toEqual(Buffer.from(path));
        }
    });

    test("includes the 2 MiB untracked boundary and excludes a larger untracked file", async () => {
        const workspace = join(root, "workspace");
        await mkdir(workspace);
        await writeFile(join(workspace, "boundary.bin"), Buffer.alloc(TwoMiB));
        await writeFile(join(workspace, "oversized.bin"), Buffer.alloc(TwoMiB + 1));

        const scope = await discover(workspace);

        expect(entry(scope.entries, "boundary.bin")).toMatchObject({ kind: "file", size: TwoMiB });
        expect(entry(scope.entries, "oversized.bin")).toMatchObject({
            kind: "excluded",
            exclusionReason: "oversized-untracked",
        });
    });

    test("records ignored paths, nested repositories, .git, and hard links as exclusions", async () => {
        const workspace = join(root, "repository");
        await mkdir(workspace);
        await git(workspace, "init");
        await writeFile(join(workspace, ".gitignore"), "ignored/\n");
        await mkdir(join(workspace, "ignored"));
        await writeFile(join(workspace, "ignored", "secret.txt"), "secret");
        const nested = join(workspace, "vendor", "child-repo");
        await mkdir(nested, { recursive: true });
        await git(nested, "init");
        await writeFile(join(workspace, "original.txt"), "same inode");
        await link(join(workspace, "original.txt"), join(workspace, "linked.txt"));

        const scope = await discover(workspace);

        expect(entry(scope.entries, "ignored")).toMatchObject({ kind: "excluded", exclusionReason: "ignored" });
        expect(entry(scope.entries, "vendor/child-repo")).toMatchObject({
            kind: "excluded",
            exclusionReason: "nested-repository",
        });
        expect(entry(scope.entries, ".git")).toMatchObject({ kind: "excluded", exclusionReason: "nested-repository" });
        expect(entry(scope.entries, "original.txt")).toMatchObject({
            kind: "excluded",
            exclusionReason: "hard-linked",
        });
        expect(entry(scope.entries, "linked.txt")).toMatchObject({
            kind: "excluded",
            exclusionReason: "hard-linked",
        });
        expect(scope.coverage.exclusions).toContainEqual({
            path: "vendor/child-repo",
            reason: "nested-repository",
        });
        expect(scope.manifest.nestedRepositoryBoundaries).toContainEqual({
            path: "vendor/child-repo",
        });
    });

    test.runIf(process.platform !== "win32")("records FIFOs as special-entry exclusions", async () => {
        const workspace = join(root, "workspace");
        await mkdir(workspace);
        const fifo = join(workspace, "events.fifo");
        await execFileAsync("mkfifo", [fifo]);

        const scope = await discover(workspace);

        expect(entry(scope.entries, "events.fifo")).toMatchObject({
            kind: "excluded",
            exclusionReason: "special-entry",
        });
    });

    test("captures a symlink leaf without traversing a symlink ancestor", async () => {
        const workspace = join(root, "workspace");
        const outside = join(root, "outside");
        await mkdir(workspace);
        await mkdir(outside);
        await writeFile(join(outside, "escaped.txt"), "outside");
        await symlink(outside, join(workspace, "linked-directory"), "dir");
        await symlink("missing-target", join(workspace, "dangling"));

        const scope = await discover(workspace);

        expect(entry(scope.entries, "linked-directory")).toMatchObject({ kind: "symlink", tracked: false });
        expect(entry(scope.entries, "dangling")).toMatchObject({ kind: "symlink", tracked: false });
        expect(scope.entries.some((item) => item.path === "linked-directory/escaped.txt")).toBe(false);
    });

    test("fails closed and discards staged entries when a directory is replaced by a symlink", async () => {
        const workspace = join(root, "workspace");
        const directory = join(workspace, "swapped");
        const backup = join(workspace, "swapped-backup");
        const outside = join(root, "outside");
        await mkdir(directory, { recursive: true });
        await mkdir(outside);
        await writeFile(join(directory, "inside.txt"), "inside");
        await writeFile(join(outside, "escaped.txt"), "escaped");
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        let replaced = false;
        vi.resetModules();
        vi.doMock("node:fs/promises", async () => {
            const actual = await vi.importActual<typeof fsPromises>("node:fs/promises");
            return {
                ...actual,
                opendir: async (...args: Parameters<typeof actual.opendir>) => {
                    const handle = await actual.opendir(...args);
                    const path = Buffer.isBuffer(args[0]) ? args[0].toString() : String(args[0]);
                    if (!replaced && path.endsWith("/workspace/swapped")) {
                        replaced = true;
                        await actual.rename(directory, backup);
                        await actual.symlink(outside, directory, "dir");
                    }
                    return handle;
                },
            };
        });
        try {
            const [isolatedModule, isolatedGitModule] = await Promise.all([
                import("./workspace-scope"),
                import("./git-runner"),
            ]);

            await expect(
                isolatedModule.discoverWorkspaceScope({
                    identity,
                    git: new isolatedGitModule.WorkspaceGitRunner(),
                    maxEntries: 10_000,
                    maxUntrackedBytes: TwoMiB,
                })
            ).rejects.toThrow(/directory changed/);
            expect(replaced).toBe(true);
        } finally {
            vi.doUnmock("node:fs/promises");
            vi.resetModules();
            if (replaced) {
                await rm(directory, { force: true });
                await rename(backup, directory);
            }
        }
    });

    test("classifies an observed parent replacement during incremental enumeration as unstable", async () => {
        const workspace = join(root, "workspace");
        const parent = join(workspace, "parent");
        const backup = join(workspace, "parent-before");
        const target = join(parent, "file.txt");
        await mkdir(parent, { recursive: true });
        await writeFile(target, "before");
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const scope = await discoverWorkspaceScope({
            identity,
            git: gitRunner,
            maxEntries: 10_000,
            maxUntrackedBytes: TwoMiB,
        });
        let replaced = false;
        vi.resetModules();
        vi.doMock("node:fs/promises", async () => {
            const actual = await vi.importActual<typeof fsPromises>("node:fs/promises");
            return {
                ...actual,
                lstat: async (...args: Parameters<typeof actual.lstat>) => {
                    const path = Buffer.isBuffer(args[0]) ? args[0].toString() : String(args[0]);
                    if (!replaced && path.endsWith("/parent/file.txt")) {
                        replaced = true;
                        await actual.rename(parent, backup);
                        await actual.mkdir(parent);
                        await actual.writeFile(target, "after");
                    }
                    return actual.lstat(...args);
                },
            };
        });
        try {
            const [isolatedScope, isolatedGit] = await Promise.all([
                import("./workspace-scope"),
                import("./git-runner"),
            ]);

            await expect(
                isolatedScope.classifyIncrementalWorkspacePaths({
                    identity,
                    git: new isolatedGit.WorkspaceGitRunner(),
                    scope: scope.manifest,
                    paths: ["parent/file.txt"],
                    maxEntries: 10_000,
                    maxUntrackedBytes: TwoMiB,
                })
            ).resolves.toEqual({ status: "reconcile", reason: "unstable-path" });
            expect(replaced).toBe(true);
        } finally {
            vi.doUnmock("node:fs/promises");
            vi.resetModules();
        }
    });

    test("classifies an incremental enumeration permission failure as unsafe", async () => {
        const workspace = join(root, "workspace");
        const target = join(workspace, "private.txt");
        await mkdir(workspace);
        await writeFile(target, "private");
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const scope = await discoverWorkspaceScope({
            identity,
            git: gitRunner,
            maxEntries: 10_000,
            maxUntrackedBytes: TwoMiB,
        });
        vi.resetModules();
        vi.doMock("node:fs/promises", async () => {
            const actual = await vi.importActual<typeof fsPromises>("node:fs/promises");
            return {
                ...actual,
                lstat: async (...args: Parameters<typeof actual.lstat>) => {
                    const path = Buffer.isBuffer(args[0]) ? args[0].toString() : String(args[0]);
                    if (path.endsWith("/private.txt")) {
                        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
                    }
                    return actual.lstat(...args);
                },
            };
        });
        try {
            const [isolatedScope, isolatedGit] = await Promise.all([
                import("./workspace-scope"),
                import("./git-runner"),
            ]);

            await expect(
                isolatedScope.classifyIncrementalWorkspacePaths({
                    identity,
                    git: new isolatedGit.WorkspaceGitRunner(),
                    scope: scope.manifest,
                    paths: ["private.txt"],
                    maxEntries: 10_000,
                    maxUntrackedBytes: TwoMiB,
                })
            ).resolves.toEqual({ status: "reconcile", reason: "unsafe-evidence" });
        } finally {
            vi.doUnmock("node:fs/promises");
            vi.resetModules();
        }
    });

    test.runIf(process.platform === "linux")("excludes filenames that are not valid UTF-8", async () => {
        const workspace = join(root, "workspace");
        await mkdir(workspace);
        const rawPath = Buffer.concat([Buffer.from(`${workspace}/invalid-`), Buffer.from([0xff])]);
        await writeFile(rawPath, "invalid");

        const scope = await discover(workspace);
        const invalid = scope.entries.find((item) => item.path == null);

        expect(invalid).toMatchObject({ kind: "excluded", exclusionReason: "non-utf8-path" });
        expect(invalid?.pathBytes).toEqual(
            Buffer.from([..."invalid-"].map((value) => value.charCodeAt(0)).concat(0xff))
        );
        expect(scope.coverage.exclusions).toContainEqual({
            pathBytesBase64: Buffer.from("invalid-\xff", "latin1").toString("base64"),
            reason: "non-utf8-path",
        });
    });

    test.runIf(process.platform === "linux")("classifies an invalid UTF-8 tracked path by its raw bytes", async () => {
        const workspace = join(root, "repository");
        await mkdir(workspace);
        await git(workspace, "init");
        const pathBytes = Buffer.concat([Buffer.from("tracked-"), Buffer.from([0xff])]);
        const absolutePath = Buffer.concat([Buffer.from(`${workspace}/`), pathBytes]);
        await writeFile(absolutePath, "tracked");
        await git(workspace, "add", "--all");

        const scope = await discover(workspace);
        const invalid = scope.entries.find((item) => item.path == null);

        expect(invalid).toMatchObject({
            kind: "excluded",
            tracked: true,
            exclusionReason: "non-utf8-path",
        });
        expect(invalid?.pathBytes).toEqual(pathBytes);
    });

    test("applies accumulated .gitignore rules in a non-Git workspace", async () => {
        const workspace = join(root, "workspace");
        await mkdir(join(workspace, "packages", "app"), { recursive: true });
        await writeFile(join(workspace, ".gitignore"), "*.root-secret\n");
        await writeFile(join(workspace, "top.root-secret"), "ignored");
        await writeFile(join(workspace, "packages", ".gitignore"), "*.local-secret\n");
        await writeFile(join(workspace, "packages", "app", "nested.local-secret"), "ignored");
        await writeFile(join(workspace, "packages", "app", "kept.txt"), "kept");

        const scope = await discover(workspace);

        expect(entry(scope.entries, "top.root-secret")).toMatchObject({ kind: "excluded", exclusionReason: "ignored" });
        expect(entry(scope.entries, "packages/app/nested.local-secret")).toMatchObject({
            kind: "excluded",
            exclusionReason: "ignored",
        });
        expect(entry(scope.entries, "packages/app/kept.txt")).toMatchObject({ kind: "file", tracked: false });
        expect(scope.manifest.ignoreInputs).toEqual([
            {
                source: "gitignore",
                path: ".gitignore",
                contentHash: sha256("*.root-secret\n"),
            },
            {
                source: "gitignore",
                path: "packages/.gitignore",
                contentHash: sha256("*.local-secret\n"),
            },
        ]);
    });

    test("rejects a symlink or oversized .gitignore without reading outside the workspace", async () => {
        const symlinkWorkspace = join(root, "symlink-ignore");
        const oversizedWorkspace = join(root, "oversized-ignore");
        const hardlinkWorkspace = join(root, "hardlink-ignore");
        const outside = join(root, "outside-ignore");
        await mkdir(symlinkWorkspace);
        await mkdir(oversizedWorkspace);
        await mkdir(hardlinkWorkspace);
        await writeFile(outside, "*.escaped\n");
        await symlink(outside, join(symlinkWorkspace, ".gitignore"));
        await writeFile(join(oversizedWorkspace, ".gitignore"), Buffer.alloc(1024 * 1024 + 1, 0x61));
        await writeFile(join(hardlinkWorkspace, ".gitignore"), "*.hardlinked\n");
        await link(join(hardlinkWorkspace, ".gitignore"), join(hardlinkWorkspace, "second-link"));

        await expect(discover(symlinkWorkspace)).rejects.toThrow(/unsafe .gitignore/);
        await expect(discover(oversizedWorkspace)).rejects.toThrow(/unsafe .gitignore/);
        await expect(discover(hardlinkWorkspace)).rejects.toThrow(/unsafe .gitignore/);
    });

    test.runIf(process.platform !== "win32")("rejects a FIFO .gitignore without blocking", async () => {
        const workspace = join(root, "fifo-ignore");
        await mkdir(workspace);
        await execFileAsync("mkfifo", [join(workspace, ".gitignore")]);

        await expect(discover(workspace)).rejects.toThrow(/unsafe .gitignore/);
    });

    test("stops capturing eligible entries after the entry budget", async () => {
        const workspace = join(root, "workspace");
        await mkdir(workspace);
        await writeFile(join(workspace, "a.txt"), "a");
        await writeFile(join(workspace, "b.txt"), "b");

        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const scope = await discoverWorkspaceScope({
            identity,
            git: gitRunner,
            maxEntries: 1,
            maxUntrackedBytes: TwoMiB,
        });

        expect(scope.entries.filter((item) => item.kind === "file")).toHaveLength(0);
        expect(scope.entries.filter((item) => item.exclusionReason === "capture-budget")).toHaveLength(0);
        expect(scope.coverage.exclusions).toEqual([{ scope: "workspace-root", reason: "capture-budget" }]);
        expect(scope.coverage.complete).toBe(false);
    });

    test("bounds scanning and manifest allocation for directories and excluded entries", async () => {
        const workspace = join(root, "workspace");
        await mkdir(workspace);
        await writeFile(join(workspace, ".gitignore"), "ignored-*\n");
        for (let index = 0; index < 100; index++) {
            await mkdir(join(workspace, `directory-${index.toString().padStart(3, "0")}`));
            await writeFile(join(workspace, `ignored-${index.toString().padStart(3, "0")}`), "ignored");
        }
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);

        const scope = await discoverWorkspaceScope({
            identity,
            git: gitRunner,
            maxEntries: 12,
            maxUntrackedBytes: TwoMiB,
        });

        expect(scope.entries.length).toBeLessThanOrEqual(13);
        expect(scope.coverage.exclusions.filter((item) => item.reason === "capture-budget")).toHaveLength(1);
        expect(scope.manifest.ignoreInputs.length).toBeLessThanOrEqual(12);
        expect(scope.coverage.complete).toBe(false);
    });

    test("uses the same directory-level budget exclusion regardless of creation order", async () => {
        const firstWorkspace = join(root, "first-workspace");
        const secondWorkspace = join(root, "second-workspace");
        await mkdir(firstWorkspace);
        await mkdir(secondWorkspace);
        const names = Array.from({ length: 20 }, (_, index) => `file-${index.toString().padStart(2, "0")}.txt`);
        for (const name of names) {
            await writeFile(join(firstWorkspace, name), name);
        }
        for (const name of [...names].reverse()) {
            await writeFile(join(secondWorkspace, name), name);
        }
        await writeFile(join(firstWorkspace, ".crest-workspace-rewind-root"), "real first file");
        await writeFile(join(secondWorkspace, ".crest-workspace-rewind-root"), "real second file");
        const [firstIdentity, secondIdentity] = await Promise.all([
            resolveCanonicalWorkspaceIdentity(firstWorkspace),
            resolveCanonicalWorkspaceIdentity(secondWorkspace),
        ]);

        const [first, second] = await Promise.all([
            discoverWorkspaceScope({
                identity: firstIdentity,
                git: gitRunner,
                maxEntries: 5,
                maxUntrackedBytes: TwoMiB,
            }),
            discoverWorkspaceScope({
                identity: secondIdentity,
                git: gitRunner,
                maxEntries: 5,
                maxUntrackedBytes: TwoMiB,
            }),
        ]);

        expect(first.entries).toEqual(second.entries);
        expect(first.coverage).toEqual(second.coverage);
        expect(first.entries).toEqual([]);
        expect(first.coverage.exclusions).toEqual([{ scope: "workspace-root", reason: "capture-budget" }]);
        expect(first.manifest.budgetExhaustion).toEqual({ scope: "workspace-root" });
        expect(first.entries.some((item) => item.path === ".crest-workspace-rewind-root")).toBe(false);
    });

    test("marks the whole workspace incomplete when a nested directory exhausts the global budget", async () => {
        const workspace = join(root, "workspace");
        const nested = join(workspace, "nested");
        await mkdir(nested, { recursive: true });
        await writeFile(join(workspace, "a.txt"), "previous sibling");
        for (let index = 0; index < 10; index++) {
            await writeFile(join(nested, `file-${index}.txt`), "value");
        }
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);

        const scope = await discoverWorkspaceScope({
            identity,
            git: gitRunner,
            maxEntries: 3,
            maxUntrackedBytes: TwoMiB,
        });

        expect(scope.entries).toEqual([]);
        expect(scope.coverage.exclusions).toEqual([{ scope: "workspace-root", reason: "capture-budget" }]);
        expect(scope.manifest.budgetExhaustion).toEqual({ scope: "workspace-root" });
    });

    test("retries non-Git discovery when files and .gitignore change during verification", async () => {
        const workspace = join(root, "workspace");
        await mkdir(workspace);
        await writeFile(join(workspace, ".gitignore"), "*.old-secret\n");
        await writeFile(join(workspace, "value.old-secret"), "old");
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        let rootOpenCount = 0;
        let mutated = false;
        vi.resetModules();
        vi.doMock("node:fs/promises", async () => {
            const actual = await vi.importActual<typeof fsPromises>("node:fs/promises");
            return {
                ...actual,
                opendir: async (...args: Parameters<typeof actual.opendir>) => {
                    const handle = await actual.opendir(...args);
                    const path = Buffer.isBuffer(args[0]) ? args[0].toString() : String(args[0]);
                    if (path.endsWith("/workspace")) {
                        rootOpenCount += 1;
                        if (rootOpenCount === 2) {
                            mutated = true;
                            await actual.writeFile(join(workspace, ".gitignore"), "*.new-secret\n");
                            await actual.writeFile(join(workspace, "value.new-secret"), "new");
                        }
                    }
                    return handle;
                },
            };
        });
        try {
            const [isolatedScope, isolatedGit] = await Promise.all([
                import("./workspace-scope"),
                import("./git-runner"),
            ]);

            const scope = await isolatedScope.discoverWorkspaceScope({
                identity,
                git: new isolatedGit.WorkspaceGitRunner(),
                maxEntries: 10_000,
                maxUntrackedBytes: TwoMiB,
            });

            expect(mutated).toBe(true);
            expect(rootOpenCount).toBeGreaterThanOrEqual(4);
            expect(scope.manifest.ignoreInputs).toContainEqual({
                source: "gitignore",
                path: ".gitignore",
                contentHash: sha256("*.new-secret\n"),
            });
            expect(entry(scope.entries, "value.old-secret")).toMatchObject({ kind: "file" });
            expect(entry(scope.entries, "value.new-secret")).toMatchObject({
                kind: "excluded",
                exclusionReason: "ignored",
            });
        } finally {
            vi.doUnmock("node:fs/promises");
            vi.resetModules();
        }
    });

    test("retries Git discovery when ignore inputs change and returns one coherent version", async () => {
        const workspace = join(root, "repository");
        await mkdir(workspace);
        await git(workspace, "init");
        await writeFile(join(workspace, ".gitignore"), "*.old-secret\n");
        await writeFile(join(workspace, "value.old-secret"), "old");
        await writeFile(join(workspace, "value.new-secret"), "new");
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const changingGit = new OneTimeIgnoreMutationGitRunner(join(workspace, ".gitignore"));

        const scope = await discoverWorkspaceScope({
            identity,
            git: changingGit,
            maxEntries: 10_000,
            maxUntrackedBytes: TwoMiB,
        });

        expect(changingGit.cachedQueries).toBeGreaterThanOrEqual(4);
        expect(scope.manifest.ignoreInputs).toContainEqual({
            source: "gitignore",
            path: ".gitignore",
            contentHash: sha256("*.new-secret\n"),
        });
        expect(entry(scope.entries, "value.old-secret")).toMatchObject({ kind: "file" });
        expect(entry(scope.entries, "value.new-secret")).toMatchObject({
            kind: "excluded",
            exclusionReason: "ignored",
        });
    });

    test("fails closed when Git ignore inputs change again after one retry", async () => {
        const workspace = join(root, "repository");
        await mkdir(workspace);
        await git(workspace, "init");
        const ignorePath = join(workspace, ".gitignore");
        await writeFile(ignorePath, "*.first-secret\n");
        await writeFile(join(workspace, "value.first-secret"), "first");
        await writeFile(join(workspace, "value.second-secret"), "second");
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const changingGit = new RepeatedIgnoreMutationGitRunner(ignorePath);

        await expect(
            discoverWorkspaceScope({
                identity,
                git: changingGit,
                maxEntries: 10_000,
                maxUntrackedBytes: TwoMiB,
            })
        ).rejects.toThrow(/changed repeatedly/);
    });

    test("retries when the user index identity changes during Git classification", async () => {
        const workspace = join(root, "repository");
        await mkdir(workspace);
        await git(workspace, "init");
        await writeFile(join(workspace, "tracked.txt"), "tracked");
        await git(workspace, "add", "tracked.txt");
        const indexPath = join(workspace, ".git", "index");
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const changingGit = new OneTimeIndexMutationGitRunner(indexPath);

        const scope = await discoverWorkspaceScope({
            identity,
            git: changingGit,
            maxEntries: 10_000,
            maxUntrackedBytes: TwoMiB,
        });

        expect(changingGit.cachedQueries).toBeGreaterThanOrEqual(4);
        expect(entry(scope.entries, "tracked.txt")).toMatchObject({ kind: "file", tracked: true });
    });

    test("documents that isolated Git discovery ignores global excludes files", async () => {
        const workspace = join(root, "repository");
        const globalConfig = join(root, "global.gitconfig");
        const globalExcludes = join(root, "global-excludes");
        await mkdir(workspace);
        await git(workspace, "init");
        await writeFile(globalExcludes, "*.global-ignore\n");
        await writeFile(globalConfig, `[core]\n\texcludesFile = ${globalExcludes}\n`);
        await writeFile(join(workspace, "visible.global-ignore"), "visible");
        const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
        process.env.GIT_CONFIG_GLOBAL = globalConfig;
        try {
            const scope = await discover(workspace);

            expect(entry(scope.entries, "visible.global-ignore")).toMatchObject({
                kind: "file",
                tracked: false,
            });
            expect(scope.manifest.policy.gitGlobalExcludes).toBe("disabled-by-isolated-runner");
            expect(scope.manifest.ignoreInputs).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ path: globalExcludes })])
            );
        } finally {
            if (previousGlobalConfig == null) {
                delete process.env.GIT_CONFIG_GLOBAL;
            } else {
                process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
            }
        }
    });

    test("fails closed when Git classification fails after repository discovery", async () => {
        const workspace = join(root, "repository");
        await mkdir(workspace);
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const failingGit = new ClassificationFailureGitRunner();

        await expect(
            discoverWorkspaceScope({
                identity,
                git: failingGit,
                maxEntries: 10_000,
                maxUntrackedBytes: TwoMiB,
            })
        ).rejects.toMatchObject({ code: "nonzero_exit" });
    });

    test("aborts the in-flight Git operand and waits for its child to be killed", async () => {
        const workspace = join(root, "workspace");
        const executable = join(root, "blocking-git");
        const pidPath = join(root, "blocking-git.pid");
        await mkdir(workspace);
        await writeFile(
            executable,
            `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setTimeout(() => {
    process.stdout.write("false\\n");
}, 1500);
`
        );
        await chmod(executable, 0o755);
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const controller = new AbortController();
        const discovery = discoverWorkspaceScope({
            identity,
            git: new WorkspaceGitRunner(executable),
            maxEntries: 10_000,
            maxUntrackedBytes: TwoMiB,
            signal: controller.signal,
        });
        const pid = Number(await waitForFile(pidPath));

        controller.abort();

        await expect(discovery).rejects.toMatchObject({ code: "aborted" });
        expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
    });

    async function discover(workspace: string) {
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        return discoverWorkspaceScope({
            identity,
            git: gitRunner,
            maxEntries: 10_000,
            maxUntrackedBytes: TwoMiB,
        });
    }
});

function entry(entries: WorkspaceScopeEntry[], path: string): WorkspaceScopeEntry {
    const result = entries.find((item) => item.path === path);
    expect(result, `missing scope entry ${JSON.stringify(path)}`).toBeDefined();
    return result!;
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

async function waitForFile(path: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            return await readFile(path, "utf8");
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                throw error;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for file: ${path}`);
}

class ClassificationFailureGitRunner extends WorkspaceGitRunner {
    override async run(args: readonly string[], options: Parameters<WorkspaceGitRunner["run"]>[1]) {
        if (args[0] === "rev-parse" && args.includes("--git-path")) {
            return {
                stdout: Buffer.from(`${join(options.cwd!, args.at(-1)!)}\n`),
                stderr: Buffer.alloc(0),
            };
        }
        if (args[0] === "rev-parse") {
            return {
                stdout: Buffer.from("true\n"),
                stderr: Buffer.alloc(0),
            };
        }
        throw new WorkspaceGitRunnerError("nonzero_exit", "classification failed");
    }
}

class OneTimeIgnoreMutationGitRunner extends WorkspaceGitRunner {
    cachedQueries = 0;

    constructor(readonly ignorePath: string) {
        super();
    }

    override async run(args: readonly string[], options: Parameters<WorkspaceGitRunner["run"]>[1]) {
        const result = await super.run(args, options);
        if (args[0] === "ls-files" && args[1] === "--cached") {
            this.cachedQueries += 1;
            if (this.cachedQueries === 2) {
                await writeFile(this.ignorePath, "*.new-secret\n");
            }
        }
        return result;
    }
}

class RepeatedIgnoreMutationGitRunner extends WorkspaceGitRunner {
    cachedQueries = 0;

    constructor(readonly ignorePath: string) {
        super();
    }

    override async run(args: readonly string[], options: Parameters<WorkspaceGitRunner["run"]>[1]) {
        const result = await super.run(args, options);
        if (args[0] === "ls-files" && args[1] === "--cached") {
            this.cachedQueries += 1;
            if (this.cachedQueries % 2 === 0) {
                const generation = this.cachedQueries / 2;
                await writeFile(this.ignorePath, `*.generation-${generation}.secret\n`);
            }
        }
        return result;
    }
}

class OneTimeIndexMutationGitRunner extends WorkspaceGitRunner {
    cachedQueries = 0;

    constructor(readonly indexPath: string) {
        super();
    }

    override async run(args: readonly string[], options: Parameters<WorkspaceGitRunner["run"]>[1]) {
        const result = await super.run(args, options);
        if (args[0] === "ls-files" && args[1] === "--cached") {
            this.cachedQueries += 1;
            if (this.cachedQueries === 2) {
                const changedTime = new Date("2025-01-02T03:04:05.000Z");
                await utimes(this.indexPath, changedTime, changedTime);
            }
        }
        return result;
    }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
    await gitOutput(cwd, ...args);
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
    const result = await execFileAsync("git", args, {
        cwd,
        env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
        },
    });
    return result.stdout;
}
