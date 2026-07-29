// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { renameSync, symlinkSync } from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    open,
    readdir,
    readFile,
    readlink,
    realpath,
    rename,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceGitRunner, WorkspaceGitRunnerError, type GitRunOptions, type GitRunResult } from "./git-runner";
import { makeProcessOwnerIdentity } from "./process-owner";
import { initializePrivateStore, WorkspaceCheckpointLimits, WorkspaceSnapshotStore } from "./snapshot-store";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";

const cleanupRoots: string[] = [];

afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private snapshot store", () => {
    test("exposes no unlocked bypass and serializes every public capture and ref operation", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "locked.txt"), "locked");
        const { ref } = await fixture.store.capture({ profile: "terminal" });
        const release = makeDeferred();
        const held = fixture.store.withWorkspaceLock(() => release.promise);
        await fixture.store.mutationLock.waitUntilHeldForTest();
        const pending = {
            boundaryToken: "boundary-lock",
            sessionId: "session-lock",
            workspaceIdentity: fixture.identity.workspaceIdentity,
            workspaceIncarnation: fixture.identity.workspaceIncarnation,
            processOwner: fixture.processOwner,
            nonce: "c".repeat(64),
            before: ref,
        };
        const operation = {
            operationId: "operation-lock",
            sessionId: "session-lock",
            workspaceIdentity: fixture.identity.workspaceIdentity,
            workspaceIncarnation: fixture.identity.workspaceIncarnation,
            snapshot: ref,
        };
        let settled = 0;
        const operations = [
            fixture.store.capture({ profile: "terminal" }),
            fixture.store.diff(ref, ref),
            fixture.store.readPathState(ref, "locked.txt"),
            fixture.store.readBlob(ref.scopeManifest),
            fixture.store.verify(ref),
            fixture.store.anchorSnapshot(ref),
            fixture.store.anchorPending(pending),
            fixture.store.anchorOperation(operation),
            fixture.store.deleteCrestRef("refs/crest/ops/missing-lock"),
            fixture.store.deleteCrestRefs([]),
            fixture.store.readCrestRefBlob("refs/crest/ops/missing-lock"),
            fixture.store.listCrestRefs(),
            fixture.store.ensureObjectsDurable([ref.id]),
            fixture.store.getQuotaStatus(),
        ].map((promise) =>
            promise.finally(() => {
                settled++;
            })
        );
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(settled).toBe(0);
        const unlockedNames = Object.getOwnPropertyNames(Object.getPrototypeOf(fixture.store)).filter((name) =>
            name.endsWith("Unlocked")
        );
        release.resolve();
        await held;
        await Promise.all(operations);
        expect(unlockedNames).toEqual([]);
    });

    test("initializes a repairable private bare repository without index or alternates", async () => {
        const root = await temporaryDirectory();
        const storeRoot = join(root, "repo.git");
        const git = new WorkspaceGitRunner();
        const processOwner = await makeProcessOwnerIdentity();

        await initializePrivateStore({ storeRoot, git, processOwner });
        await chmod(storeRoot, 0o755);
        await chmod(join(storeRoot, "objects"), 0o755);
        await initializePrivateStore({ storeRoot, git, processOwner });

        expect((await stat(storeRoot)).mode & 0o777).toBe(0o700);
        expect((await stat(join(storeRoot, "objects"))).mode & 0o777).toBe(0o700);
        expect((await stat(join(storeRoot, "refs"))).mode & 0o777).toBe(0o700);
        expect((await stat(join(storeRoot, "journal"))).mode & 0o777).toBe(0o700);
        expect((await stat(join(storeRoot, "lock"))).mode & 0o777).toBe(0o700);
        await expect(lstat(join(storeRoot, "index"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(join(storeRoot, "objects", "info", "alternates"))).rejects.toMatchObject({ code: "ENOENT" });

        const config = await readFile(join(storeRoot, "config"), "utf8");
        expect(config).toContain("bare = true");
        expect(config).toContain("autocrlf = false");
        expect(config).toContain("auto = 0");
        expect(config).toContain("fsync = loose-object,reference");
        expect(config).toContain(`hooksPath = ${join(storeRoot, "private-hooks")}`);
        expect(await readdir(join(storeRoot, "private-hooks"))).toEqual([]);
    });

    test("repairs an existing directory whose bare repository initialization was interrupted", async () => {
        const root = await temporaryDirectory();
        const storeRoot = join(root, "repo.git");
        await mkdir(storeRoot, { recursive: true });

        await initializePrivateStore({
            storeRoot,
            git: new WorkspaceGitRunner(),
            processOwner: await makeProcessOwnerIdentity(),
        });

        expect((await stat(join(storeRoot, "objects"))).isDirectory()).toBe(true);
        expect((await stat(join(storeRoot, "refs"))).isDirectory()).toBe(true);
    });

    test("falls back when Git reports unsupported core fsync components", async () => {
        const root = await temporaryDirectory();
        const storeRoot = join(root, "repo.git");

        await initializePrivateStore({
            storeRoot,
            git: new UnsupportedFsyncGit(),
            processOwner: await makeProcessOwnerIdentity(),
        });

        expect(await readFile(join(storeRoot, "config"), "utf8")).not.toContain("fsync =");
    });

    test("serializes concurrent bootstrap and publishes a mode-0600 owner record", async () => {
        const root = await temporaryDirectory();
        const storeRoot = join(root, "repo.git");
        const git = new BlockingInitGit();
        const processOwner = await makeProcessOwnerIdentity();

        const first = initializePrivateStore({ storeRoot, git, processOwner });
        await git.entered;
        const second = initializePrivateStore({ storeRoot, git, processOwner });

        expect((await stat(join(root, ".bootstrap-owner"))).mode & 0o777).toBe(0o600);
        git.unblock();
        await Promise.all([first, second]);
        expect(git.initCalls).toBe(1);
    });

    test("publishes a fully durable bootstrap record without writing the owner path directly", async () => {
        let directOwnerWrite = false;
        vi.doMock("node:fs/promises", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:fs/promises")>();
            return {
                ...actual,
                writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
                    if (String(args[0]).endsWith(".bootstrap-owner")) {
                        directOwnerWrite = true;
                        throw new Error("bootstrap owner path was written directly");
                    }
                    return actual.writeFile(...args);
                },
            };
        });
        vi.resetModules();
        try {
            const [isolated, isolatedGit, isolatedOwner] = await Promise.all([
                import("./snapshot-store"),
                import("./git-runner"),
                import("./process-owner"),
            ]);
            const root = await temporaryDirectory();

            await isolated.initializePrivateStore({
                storeRoot: join(root, "repo.git"),
                git: new isolatedGit.WorkspaceGitRunner(),
                processOwner: await isolatedOwner.makeProcessOwnerIdentity(),
            });

            expect(directOwnerWrite).toBe(false);
        } finally {
            vi.doUnmock("node:fs/promises");
            vi.resetModules();
        }
    });

    test.skipIf(process.platform === "win32")("serializes bootstrap across independent processes", async () => {
        const root = await temporaryDirectory();
        const storeRoot = join(root, "repo.git");
        const script = makeBootstrapChildScript(storeRoot);

        const results = await Promise.all([runTsxChild(script), runTsxChild(script)]);

        expect(results).toEqual([
            { code: 0, stderr: "" },
            { code: 0, stderr: "" },
        ]);
        expect((await stat(storeRoot)).isDirectory()).toBe(true);
        await expect(lstat(join(root, ".bootstrap-owner"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    test.skipIf(process.platform === "win32")(
        "recovers bootstrap after the publishing process crashes",
        async () => {
            const root = await temporaryDirectory();
            const storeRoot = join(root, "repo.git");
            const child = spawnTsxChild(makeCrashingBootstrapChildScript(storeRoot));
            await waitForChildOutput(child, "owner-ready\n");
            child.kill("SIGKILL");
            await waitForChildExit(child);

            expect((await stat(join(root, ".bootstrap-owner"))).mode & 0o777).toBe(0o600);
            await initializePrivateStore({
                storeRoot,
                git: new WorkspaceGitRunner(),
                processOwner: await makeProcessOwnerIdentity(),
            });

            expect((await stat(storeRoot)).isDirectory()).toBe(true);
            await expect(lstat(join(root, ".bootstrap-owner"))).rejects.toMatchObject({ code: "ENOENT" });
        },
        15_000
    );

    test("removes a dead process candidate left by a bootstrap crash", async () => {
        const root = await temporaryDirectory();
        const storeRoot = join(root, "repo.git");
        const candidate = join(root, `.bootstrap-owner.candidate-${2 ** 30}-${"a".repeat(24)}`);
        await writeFile(
            candidate,
            JSON.stringify({
                pid: 2 ** 30,
                processstarttoken: "dead",
                nonce: "b".repeat(64),
            }),
            { mode: 0o600 }
        );

        await initializePrivateStore({
            storeRoot,
            git: new WorkspaceGitRunner(),
            processOwner: await makeProcessOwnerIdentity(),
        });

        await expect(lstat(candidate)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("takes over stale and PID-reused bootstrap owner records", async () => {
        for (const record of [
            { pid: 2 ** 30, processstarttoken: "gone", nonce: "c".repeat(64) },
            { pid: process.pid, processstarttoken: "reused-pid", nonce: "d".repeat(64) },
        ]) {
            const root = await temporaryDirectory();
            const storeRoot = join(root, "repo.git");
            await writeFile(join(root, ".bootstrap-owner"), JSON.stringify(record), { mode: 0o666 });

            await initializePrivateStore({
                storeRoot,
                git: new WorkspaceGitRunner(),
                processOwner: await makeProcessOwnerIdentity(),
            });

            await expect(lstat(join(root, ".bootstrap-owner"))).rejects.toMatchObject({ code: "ENOENT" });
            expect((await stat(storeRoot)).isDirectory()).toBe(true);
        }
    });

    test("waits while a different live bootstrap owner is present", async () => {
        const root = await temporaryDirectory();
        const storeRoot = join(root, "repo.git");
        const processOwner = await makeProcessOwnerIdentity();
        const ownerPath = join(root, ".bootstrap-owner");
        await writeFile(
            ownerPath,
            JSON.stringify({
                pid: processOwner.pid,
                processstarttoken: processOwner.processStartToken,
                nonce: "e".repeat(64),
            }),
            { mode: 0o600 }
        );

        const opening = initializePrivateStore({
            storeRoot,
            git: new WorkspaceGitRunner(),
            processOwner,
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        await expect(lstat(storeRoot)).rejects.toMatchObject({ code: "ENOENT" });
        const { unlink } = await import("node:fs/promises");
        await unlink(ownerPath);
        await opening;

        expect((await stat(storeRoot)).isDirectory()).toBe(true);
    });

    test("repairs every repository directory and file to owner-only permissions", async () => {
        const root = await temporaryDirectory();
        const storeRoot = join(root, "repo.git");
        const input = {
            storeRoot,
            git: new WorkspaceGitRunner(),
            processOwner: await makeProcessOwnerIdentity(),
        };
        await initializePrivateStore(input);
        await chmod(join(storeRoot, "hooks"), 0o755);
        await chmod(join(storeRoot, "hooks", "applypatch-msg.sample"), 0o644);

        await initializePrivateStore(input);

        await expectOwnerOnlyTree(storeRoot);
    });

    test("refuses to repair a store redirected through a symlink", async () => {
        const root = await temporaryDirectory();
        const outside = join(root, "outside");
        const storeRoot = join(root, "repo.git");
        await mkdir(outside);
        await symlink(outside, storeRoot);

        await expect(
            initializePrivateStore({
                storeRoot,
                git: new WorkspaceGitRunner(),
                processOwner: await makeProcessOwnerIdentity(),
            })
        ).rejects.toThrow("Unsafe snapshot store");
        expect(await readdir(outside)).toEqual([]);
    });

    test("fails closed on Windows until owner-only ACL support is available", async () => {
        const root = await temporaryDirectory();
        const processOwner = await makeProcessOwnerIdentity();
        const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        try {
            await expect(
                initializePrivateStore({
                    storeRoot: join(root, "repo.git"),
                    git: new WorkspaceGitRunner(),
                    processOwner,
                })
            ).rejects.toThrow(/Windows ACL/);
            expect(await readdir(root)).toEqual([]);
        } finally {
            platform.mockRestore();
        }
    });
});

describe("workspace snapshots", () => {
    test("captures raw regular, binary, executable, symlink, absent, and excluded states", async () => {
        const fixture = await makeStoreFixture();
        const text = Buffer.from("line one\r\nline two\r\n");
        const binary = Buffer.from([0, 255, 13, 10, 128]);
        await writeFile(
            join(fixture.workspace, ".gitattributes"),
            "* text eol=lf\n*.bin filter=missing\ntext.txt working-tree-encoding=UTF-16\n"
        );
        await writeFile(join(fixture.workspace, ".gitignore"), "ignored.secret\n");
        await writeFile(join(fixture.workspace, "text.txt"), text);
        await writeFile(join(fixture.workspace, "binary.bin"), binary);
        await writeFile(join(fixture.workspace, "run.sh"), "#!/bin/sh\n");
        await chmod(join(fixture.workspace, "run.sh"), 0o755);
        await symlink("text.txt", join(fixture.workspace, "link"));
        await writeFile(join(fixture.workspace, "ignored.secret"), "secret");

        const snapshot = await fixture.store.capture({ profile: "pre-turn" });

        const textState = await fixture.store.readPathState(snapshot.ref, "text.txt");
        const binaryState = await fixture.store.readPathState(snapshot.ref, "binary.bin");
        expect(textState).toMatchObject({ state: "file", executable: false });
        expect(binaryState).toMatchObject({ state: "file", executable: false });
        expect(await fixture.store.readBlob((textState as { oid: string }).oid)).toEqual(text);
        expect(await fixture.store.readBlob((binaryState as { oid: string }).oid)).toEqual(binary);
        expect(fixture.git.calls.filter((args) => args[0] === "hash-object")).not.toHaveLength(0);
        expect(fixture.git.calls.filter((args) => args[0] === "hash-object")).toSatisfy((calls: string[][]) =>
            calls.every(
                (args) => (args.includes("--stdin") || args.includes("--stdin-paths")) && args.includes("--no-filters")
            )
        );
        expect(await fixture.store.readPathState(snapshot.ref, "run.sh")).toMatchObject({
            state: "file",
            executable: true,
        });
        expect(await fixture.store.readPathState(snapshot.ref, "link")).toMatchObject({ state: "symlink" });
        expect(await readlink(join(fixture.workspace, "link"))).toBe("text.txt");
        expect(await fixture.store.readPathState(snapshot.ref, "missing.txt")).toEqual({ state: "absent" });
        expect(await fixture.store.readPathState(snapshot.ref, "ignored.secret")).toEqual({
            state: "excluded",
            reason: "ignored",
        });
    });

    test("rejects a parent-directory symlink replacement before hashing external bytes", async () => {
        let directory = "";
        let replacement = "";
        let outside = "";
        let swapped = false;
        vi.doMock("node:child_process", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:child_process")>();
            return {
                ...actual,
                spawn: (...args: Parameters<typeof actual.spawn>) => {
                    const options = args[2];
                    if (!swapped && directory && options?.cwd === directory) {
                        swapped = true;
                        renameSync(directory, replacement);
                        symlinkSync(outside, directory, "dir");
                    }
                    return actual.spawn(...args);
                },
            };
        });
        vi.resetModules();
        try {
            const [isolated, isolatedGit] = await Promise.all([import("./snapshot-store"), import("./git-runner")]);
            class AuditedGit extends isolatedGit.WorkspaceGitRunner {
                calls: string[][] = [];

                override async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
                    this.calls.push([...args]);
                    return super.run(args, options);
                }
            }
            const fixture = await makeStoreFixtureWith(isolated.WorkspaceSnapshotStore, AuditedGit);
            directory = join(fixture.workspace, "directory");
            outside = join(fixture.workspace, "outside");
            replacement = join(fixture.workspace, "displaced");
            await mkdir(directory);
            await mkdir(outside);
            await writeFile(join(directory, "target.txt"), "inside");
            await writeFile(join(outside, "target.txt"), "outside");
            fixture.git.calls.length = 0;

            await expect(fixture.store.capture({ profile: "pre-turn" })).rejects.toThrow(/parent identity/);
            expect(swapped).toBe(true);
            expect(fixture.git.calls.some((args) => args[0] === "hash-object")).toBe(false);
        } finally {
            vi.doUnmock("node:child_process");
            vi.resetModules();
        }
    });

    test("cleans an unstable group, refreshes file evidence, and succeeds on its single retry", async () => {
        let workspace = "";
        let attempts = 0;
        let firstAttemptStaging: string[] = [];
        vi.doMock("./workspace-scope", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-scope")>();
            return {
                ...actual,
                verifyWorkspaceScopeDirectories: async () => true,
            };
        });
        vi.doMock("./anchored-reader", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./anchored-reader")>();
            return {
                ...actual,
                runAnchoredReader: async (input: Parameters<typeof actual.runAnchoredReader>[0]) => {
                    attempts++;
                    if (attempts === 1) {
                        firstAttemptStaging = input.entries.map((entry) => entry.stagingPath);
                        await Promise.all(firstAttemptStaging.map((path) => writeFile(path, "partial")));
                        await rename(join(workspace, "target.txt"), join(workspace, "displaced.txt"));
                        await writeFile(join(workspace, "target.txt"), "after");
                        throw new actual.AnchoredReaderError("unstable_file", "unstable_file:ENOENT pathname race");
                    }
                    await Promise.all(
                        firstAttemptStaging.map((path) => expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" }))
                    );
                    return actual.runAnchoredReader(input);
                },
            };
        });
        vi.resetModules();
        try {
            const [isolated, isolatedGit] = await Promise.all([import("./snapshot-store"), import("./git-runner")]);
            const fixture = await makeStoreFixtureWith(isolated.WorkspaceSnapshotStore, isolatedGit.WorkspaceGitRunner);
            workspace = fixture.workspace;
            await writeFile(join(workspace, "target.txt"), "before");

            const snapshot = await fixture.store.capture({ profile: "terminal" });
            const state = await fixture.store.readPathState(snapshot.ref, "target.txt");

            expect(attempts).toBe(2);
            expect(await fixture.store.readBlob((state as { oid: string }).oid)).toEqual(Buffer.from("after"));
        } finally {
            vi.doUnmock("./anchored-reader");
            vi.doUnmock("./workspace-scope");
            vi.resetModules();
        }
    });

    test("cleans both unstable groups and fails typed after exactly one retry", async () => {
        let workspace = "";
        let attempts = 0;
        const attemptStaging: string[][] = [];
        vi.doMock("./anchored-reader", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./anchored-reader")>();
            return {
                ...actual,
                runAnchoredReader: async (input: Parameters<typeof actual.runAnchoredReader>[0]) => {
                    if (attempts > 0) {
                        await Promise.all(
                            attemptStaging[attempts - 1]!.map((path) =>
                                expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" })
                            )
                        );
                    }
                    attempts++;
                    const stagingPaths = input.entries.map((entry) => entry.stagingPath);
                    attemptStaging.push(stagingPaths);
                    await Promise.all(stagingPaths.map((path) => writeFile(path, "partial")));
                    await rename(join(workspace, "target.txt"), join(workspace, `displaced-${attempts}.txt`));
                    await writeFile(join(workspace, "target.txt"), attempts === 1 ? "second" : "third!");
                    throw new actual.AnchoredReaderError(
                        "unstable_file",
                        `unstable_file:ENOENT pathname race ${attempts}`
                    );
                },
            };
        });
        vi.resetModules();
        try {
            const [isolated, isolatedGit] = await Promise.all([import("./snapshot-store"), import("./git-runner")]);
            const fixture = await makeStoreFixtureWith(isolated.WorkspaceSnapshotStore, isolatedGit.WorkspaceGitRunner);
            workspace = fixture.workspace;
            await writeFile(join(workspace, "target.txt"), "first!");

            await expect(fixture.store.capture({ profile: "terminal" })).rejects.toMatchObject({
                code: "unstable_file",
            });

            expect(attempts).toBe(2);
            await Promise.all(
                attemptStaging.flat().map((path) => expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" }))
            );
        } finally {
            vi.doUnmock("./anchored-reader");
            vi.resetModules();
        }
    });

    test("does not retry or reclassify an anchored permission failure", async () => {
        let attempts = 0;
        vi.doMock("./anchored-reader", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./anchored-reader")>();
            return {
                ...actual,
                runAnchoredReader: async () => {
                    attempts++;
                    throw new actual.AnchoredReaderError("worker_failed", "EACCES: permission denied");
                },
            };
        });
        vi.resetModules();
        try {
            const [isolated, isolatedGit] = await Promise.all([import("./snapshot-store"), import("./git-runner")]);
            const fixture = await makeStoreFixtureWith(isolated.WorkspaceSnapshotStore, isolatedGit.WorkspaceGitRunner);
            await writeFile(join(fixture.workspace, "target.txt"), "before");

            await expect(fixture.store.capture({ profile: "terminal" })).rejects.toMatchObject({
                code: "worker_failed",
                message: expect.stringMatching(/EACCES/),
            });
            expect(attempts).toBe(1);
        } finally {
            vi.doUnmock("./anchored-reader");
            vi.resetModules();
        }
    });

    test("restarts an empty scope once when a new name appears before publication", async () => {
        let workspace = "";
        let verifications = 0;
        vi.doMock("./workspace-scope", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-scope")>();
            return {
                ...actual,
                verifyWorkspaceScopeDirectories: async (
                    scope: Parameters<typeof actual.verifyWorkspaceScopeDirectories>[0],
                    signal?: AbortSignal
                ) => {
                    verifications++;
                    if (verifications === 1) {
                        await writeFile(join(workspace, "appeared.txt"), "appeared");
                    }
                    return actual.verifyWorkspaceScopeDirectories(scope, signal);
                },
            };
        });
        vi.resetModules();
        try {
            const [isolated, isolatedGit] = await Promise.all([import("./snapshot-store"), import("./git-runner")]);
            class AuditedGit extends isolatedGit.WorkspaceGitRunner {
                calls: string[][] = [];

                override async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
                    this.calls.push([...args]);
                    return super.run(args, options);
                }
            }
            const fixture = await makeStoreFixtureWith(isolated.WorkspaceSnapshotStore, AuditedGit);
            workspace = fixture.workspace;
            fixture.git.calls.length = 0;

            const snapshot = await fixture.store.capture({ profile: "terminal" });

            expect(verifications).toBe(2);
            expect(snapshot.coverage.complete).toBe(true);
            expect(await fixture.store.readPathState(snapshot.ref, "appeared.txt")).toMatchObject({ state: "file" });
            expect(fixture.git.calls.filter((args) => args[0] === "update-ref")).toHaveLength(1);
        } finally {
            vi.doUnmock("./workspace-scope");
            vi.resetModules();
        }
    });

    test("publishes no ref when directory names change during both full capture attempts", async () => {
        let workspace = "";
        let verifications = 0;
        vi.doMock("./workspace-scope", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-scope")>();
            return {
                ...actual,
                verifyWorkspaceScopeDirectories: async (
                    scope: Parameters<typeof actual.verifyWorkspaceScopeDirectories>[0],
                    signal?: AbortSignal
                ) => {
                    verifications++;
                    if (verifications === 1) {
                        await writeFile(join(workspace, "moving-0.txt"), "moving");
                    } else {
                        await rename(join(workspace, "moving-0.txt"), join(workspace, "moving-1.txt"));
                    }
                    return actual.verifyWorkspaceScopeDirectories(scope, signal);
                },
            };
        });
        vi.resetModules();
        try {
            const [isolated, isolatedGit] = await Promise.all([import("./snapshot-store"), import("./git-runner")]);
            class AuditedGit extends isolatedGit.WorkspaceGitRunner {
                calls: string[][] = [];

                override async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
                    this.calls.push([...args]);
                    return super.run(args, options);
                }
            }
            const fixture = await makeStoreFixtureWith(isolated.WorkspaceSnapshotStore, AuditedGit);
            workspace = fixture.workspace;
            fixture.git.calls.length = 0;

            await expect(fixture.store.capture({ profile: "terminal" })).rejects.toMatchObject({
                code: "unstable_file",
            });

            expect(verifications).toBe(2);
            expect(fixture.git.calls.some((args) => args[0] === "update-ref")).toBe(false);
        } finally {
            vi.doUnmock("./workspace-scope");
            vi.resetModules();
        }
    });

    test("shares the newly-hashed byte budget across whole capture attempts", async () => {
        const attemptedBytes = Math.floor(1024 ** 3 / 2) + 1;
        let readerCalls = 0;
        let stagedAttempts = 0;
        let verifications = 0;
        vi.doMock("./workspace-scope", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-scope")>();
            return {
                ...actual,
                verifyWorkspaceScopeDirectories: async () => ++verifications !== 1,
            };
        });
        vi.doMock("./anchored-reader", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./anchored-reader")>();
            return {
                ...actual,
                runAnchoredReader: async (input: Parameters<typeof actual.runAnchoredReader>[0]) => {
                    readerCalls++;
                    if (attemptedBytes > input.maxTotalBytes) {
                        throw new actual.AnchoredReaderError("capture_budget", "capture_budget:total bytes");
                    }
                    stagedAttempts++;
                    await Promise.all(input.entries.map((entry) => writeFile(entry.stagingPath, "x")));
                    return input.entries.map((entry) => ({
                        path: entry.path,
                        stagingPath: entry.stagingPath,
                        identity: entry.identity,
                        hashedBytes: attemptedBytes,
                    }));
                },
            };
        });
        vi.resetModules();
        try {
            const [isolated, isolatedGit] = await Promise.all([import("./snapshot-store"), import("./git-runner")]);
            const fixture = await makeStoreFixtureWith(isolated.WorkspaceSnapshotStore, isolatedGit.WorkspaceGitRunner);
            await writeFile(join(fixture.workspace, "target.txt"), "x");

            await expect(fixture.store.capture({ profile: "terminal" })).rejects.toMatchObject({
                code: "capture_budget",
            });

            expect(readerCalls).toBe(2);
            expect(stagedAttempts).toBe(1);
        } finally {
            vi.doUnmock("./anchored-reader");
            vi.doUnmock("./workspace-scope");
            vi.resetModules();
        }
    });

    test("reports newly-hashed work from every whole capture attempt", async () => {
        const attemptedBytes = 7;
        let readerCalls = 0;
        let verifications = 0;
        vi.doMock("./workspace-scope", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-scope")>();
            return {
                ...actual,
                verifyWorkspaceScopeDirectories: async () => ++verifications !== 1,
            };
        });
        vi.doMock("./anchored-reader", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./anchored-reader")>();
            return {
                ...actual,
                runAnchoredReader: async (input: Parameters<typeof actual.runAnchoredReader>[0]) => {
                    readerCalls++;
                    await Promise.all(input.entries.map((entry) => writeFile(entry.stagingPath, "x")));
                    return input.entries.map((entry) => ({
                        path: entry.path,
                        stagingPath: entry.stagingPath,
                        identity: entry.identity,
                        hashedBytes: attemptedBytes,
                    }));
                },
            };
        });
        vi.resetModules();
        try {
            const [isolated, isolatedGit] = await Promise.all([import("./snapshot-store"), import("./git-runner")]);
            const fixture = await makeStoreFixtureWith(isolated.WorkspaceSnapshotStore, isolatedGit.WorkspaceGitRunner);
            await writeFile(join(fixture.workspace, "target.txt"), "x");

            const snapshot = await fixture.store.capture({ profile: "terminal" });

            expect(readerCalls).toBe(2);
            expect(snapshot.coverage.newlyHashedBytes).toBe(attemptedBytes * 2);
        } finally {
            vi.doUnmock("./anchored-reader");
            vi.doUnmock("./workspace-scope");
            vi.resetModules();
        }
    });

    test("rejects a canonical-root replacement during reference publication", async () => {
        let workspace = "";
        class ReplacingRefGit extends RecordingGit {
            override async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
                const result = await super.run(args, options);
                if (workspace && args[0] === "update-ref") {
                    await rename(workspace, `${workspace}-moved`);
                    await mkdir(workspace);
                }
                return result;
            }
        }
        const fixture = await makeStoreFixtureWith(WorkspaceSnapshotStore, ReplacingRefGit);
        workspace = fixture.workspace;
        await writeFile(join(workspace, "tracked.txt"), "tracked");

        await expect(fixture.store.capture({ profile: "terminal" })).rejects.toThrow(/identity chain changed/i);
    });

    test("builds a descriptor that references the workspace tree and canonical scope manifest", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "a.txt"), "a");

        const { ref } = await fixture.store.capture({ profile: "pre-turn" });
        const descriptor = await fixture.git.run(["cat-file", "-p", ref.id], {
            gitDir: fixture.storeRoot,
            timeoutMs: 5_000,
        });
        const manifest = await fixture.store.readBlob(ref.scopeManifest);

        expect(descriptor.stdout.toString()).toContain(`${ref.tree}\tworkspace\n`);
        expect(descriptor.stdout.toString()).toContain(`${ref.scopeManifest}\tscope-manifest\n`);
        expect(JSON.parse(manifest.toString("utf8"))).toMatchObject({ schemaversion: 1 });
        expect(ref.workspaceIdentity).toBe(fixture.identity.workspaceIdentity);
        expect(ref.workspaceIncarnation).toBe(fixture.identity.workspaceIncarnation);
    });

    test("captures raw bytes in a Git workspace without consulting a shadow index", async () => {
        const fixture = await makeStoreFixture();
        await fixture.git.run(["init", fixture.workspace], {
            cwd: fixture.workspace,
            timeoutMs: 5_000,
        });
        const bytes = Buffer.from("git\r\nworkspace\0bytes");
        await writeFile(join(fixture.workspace, ".gitattributes"), "* text eol=lf\n");
        await writeFile(join(fixture.workspace, "raw.dat"), bytes);

        const { ref } = await fixture.store.capture({ profile: "terminal" });
        const state = await fixture.store.readPathState(ref, "raw.dat");

        expect(await fixture.store.readBlob((state as { oid: string }).oid)).toEqual(bytes);
        expect(fixture.git.calls.some((args) => args.some((arg) => arg.includes(fixture.storeRoot + "/index")))).toBe(
            false
        );
        await expect(lstat(join(fixture.storeRoot, "index"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("diffs create, modify, and delete using explicit path states", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "modify.txt"), "before");
        await writeFile(join(fixture.workspace, "delete.txt"), "delete");
        const before = await fixture.store.capture({ profile: "pre-turn" });
        await writeFile(join(fixture.workspace, "modify.txt"), "after");
        await writeFile(join(fixture.workspace, "create.txt"), "create");
        const { unlink } = await import("node:fs/promises");
        await unlink(join(fixture.workspace, "delete.txt"));
        const after = await fixture.store.capture({ profile: "pre-turn" });

        const changes = await fixture.store.diff(before.ref, after.ref);

        expect(changes.map((change) => change.path)).toEqual(["create.txt", "delete.txt", "modify.txt"]);
        expect(changes[0]).toMatchObject({ before: { state: "absent" }, after: { state: "file" } });
        expect(changes[1]).toMatchObject({ before: { state: "file" }, after: { state: "absent" } });
    });

    test("diff resolves a missing child through an ignored ancestor exclusion", async () => {
        const fixture = await makeStoreFixture();
        await mkdir(join(fixture.workspace, "ignored"));
        await writeFile(join(fixture.workspace, "ignored", "child.txt"), "child");
        await writeFile(join(fixture.workspace, ".gitignore"), "ignored/\n");
        const before = await fixture.store.capture({ profile: "pre-turn" });
        await writeFile(join(fixture.workspace, ".gitignore"), "");
        const after = await fixture.store.capture({ profile: "pre-turn" });

        const changes = await fixture.store.diff(before.ref, after.ref);

        expect(changes.find((change) => change.path === "ignored/child.txt")).toMatchObject({
            before: { state: "excluded", reason: "ignored" },
            after: { state: "file" },
        });
    });

    test("diff resolves a missing path through root capture-budget exclusion", async () => {
        let discovery = 0;
        vi.doMock("./workspace-scope", () => ({
            discoverWorkspaceScope: async (input: { identity: CanonicalWorkspaceIdentity }) => {
                discovery++;
                const exhausted = discovery === 1;
                return {
                    root: input.identity.canonicalRoot,
                    entries: exhausted
                        ? []
                        : [
                              {
                                  path: "child.txt",
                                  pathBytes: Buffer.from("child.txt"),
                                  kind: "file",
                                  tracked: false,
                                  executable: false,
                                  size: 5,
                                  ...(await makeScopeEvidence(input.identity.canonicalRoot, "child.txt")),
                              },
                          ],
                    coverage: {
                        complete: !exhausted,
                        eligibleEntryCount: exhausted ? 0 : 1,
                        newlyHashedBytes: 0,
                        exclusions: exhausted ? [{ scope: "workspace-root", reason: "capture-budget" }] : [],
                    },
                    manifest: {
                        schemaVersion: 1,
                        policy: {
                            maxEntries: 200_000,
                            maxUntrackedBytes: 2 * 1024 ** 2,
                            gitGlobalExcludes: "disabled-by-isolated-runner",
                        },
                        ignoreInputs: [],
                        nestedRepositoryBoundaries: [],
                        ...(exhausted ? { budgetExhaustion: { scope: "workspace-root" } } : {}),
                    },
                };
            },
            verifyWorkspaceScopeDirectories: async () => true,
        }));
        vi.resetModules();
        try {
            const [isolated, isolatedGit] = await Promise.all([import("./snapshot-store"), import("./git-runner")]);
            const fixture = await makeStoreFixtureWith(isolated.WorkspaceSnapshotStore, isolatedGit.WorkspaceGitRunner);
            await writeFile(join(fixture.workspace, "child.txt"), "child");
            const before = await fixture.store.capture({ profile: "pre-turn" });
            const after = await fixture.store.capture({ profile: "pre-turn" });

            const changes = await fixture.store.diff(before.ref, after.ref);

            expect(changes).toContainEqual(
                expect.objectContaining({
                    path: "child.txt",
                    before: { state: "excluded", reason: "capture-budget" },
                    after: expect.objectContaining({ state: "file" }),
                })
            );
        } finally {
            vi.doUnmock("./workspace-scope");
            vi.resetModules();
        }
    });

    test("reuses stable fingerprints but rehashes files inside the racy window", async () => {
        const fixture = await makeStoreFixture();
        const path = join(fixture.workspace, "racy.txt");
        await writeFile(path, "first");
        const first = await fixture.store.capture({ profile: "pre-turn" });
        const second = await fixture.store.capture({ profile: "pre-turn" });
        expect(second.coverage.newlyHashedBytes).toBeGreaterThan(0);

        const metadata = await stat(path, { bigint: true });
        const newestTimestamp = metadata.mtimeNs > metadata.ctimeNs ? metadata.mtimeNs : metadata.ctimeNs;
        vi.useFakeTimers();
        vi.setSystemTime(Number(newestTimestamp / 1_000_000n) + 1_100);
        try {
            const third = await fixture.store.capture({ profile: "pre-turn" });
            expect(third.coverage.newlyHashedBytes).toBe(0);
        } finally {
            vi.useRealTimers();
        }

        await writeFile(path, "other");
        const fourth = await fixture.store.capture({ profile: "pre-turn" });
        expect(fourth.coverage.newlyHashedBytes).toBeGreaterThan(0);
        expect(await fixture.store.readPathState(fourth.ref, "racy.txt")).not.toEqual(
            await fixture.store.readPathState(first.ref, "racy.txt")
        );
    });

    test("captures required oversized paths instead of silently excluding force-time bytes", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "large.bin"), Buffer.alloc(2 * 1024 ** 2 + 1, 7));

        const normal = await fixture.store.capture({ profile: "safety" });
        expect(await fixture.store.readPathState(normal.ref, "large.bin")).toEqual({
            state: "excluded",
            reason: "oversized-untracked",
        });

        const required = await fixture.store.capture({ profile: "safety", requiredPaths: ["large.bin"] });
        expect(await fixture.store.readPathState(required.ref, "large.bin")).toMatchObject({ state: "file" });
    });

    test("does not let required paths override the fixed single-file hard cap", async () => {
        const fixture = await makeStoreFixture();
        const path = join(fixture.workspace, "too-large-required.bin");
        const handle = await open(path, "w");
        await handle.truncate(64 * 1024 ** 2 + 1);
        await handle.close();

        await expect(
            fixture.store.capture({
                profile: "terminal",
                requiredPaths: ["too-large-required.bin"],
            })
        ).rejects.toMatchObject({
            code: "capture_budget",
            message: expect.stringMatching(/too-large-required\.bin.*67108864/),
        });
    });

    test("verifies snapshots and keeps an owner ref when reporting quota", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "a.txt"), "a");
        const { ref } = await fixture.store.capture({ profile: "pre-turn" });

        await expect(fixture.store.verify(ref)).resolves.toBeUndefined();
        await expect(fixture.store.verifyOwnedSnapshot(ref)).resolves.toBeUndefined();
        await fixture.store.deleteCrestRef(fixture.store.ownerRefName(ref.id));
        await expect(fixture.store.verify(ref)).resolves.toBeUndefined();
        await expect(fixture.store.verifyOwnedSnapshot(ref)).rejects.toThrow(/owner ref/i);
        await fixture.store.anchorSnapshot(ref);
        fixture.git.calls.length = 0;
        const quota = await fixture.store.getQuotaStatus();
        expect(quota.status).toBe("ok");
        expect(quota.usedBytes).toBeGreaterThan(0);
        expect(fixture.git.calls.map((args) => args[0])).toEqual([
            "count-objects",
            "for-each-ref",
            "rev-list",
            "cat-file",
        ]);
        const refs = await fixture.git.run(["show-ref"], { gitDir: fixture.storeRoot, timeoutMs: 5_000 });
        expect(refs.stdout.toString()).toContain(ref.id);
    });

    test("captures 10k unique files with a bounded number of Git processes", async () => {
        const fixture = await makeStoreFixture();
        const fileCount = 10_000;
        const batchSize = 250;
        for (let start = 0; start < fileCount; start += batchSize) {
            await Promise.all(
                Array.from({ length: Math.min(batchSize, fileCount - start) }, (_, offset) => {
                    const index = start + offset;
                    return writeFile(
                        join(fixture.workspace, `file-${index.toString().padStart(5, "0")}.txt`),
                        `unique-${index}\n`
                    );
                })
            );
        }
        fixture.git.calls.length = 0;

        // This stress test owns batching/process-count behavior. Fixed capture
        // deadlines have dedicated tests below; do not let unrelated full-suite
        // CPU contention turn this authority into a deadline test as well.
        const captureNow = vi.spyOn(Date, "now").mockReturnValue(Date.now());
        const realSetTimeout = globalThis.setTimeout;
        const captureDeadline = vi
            .spyOn(globalThis, "setTimeout")
            .mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
                realSetTimeout(
                    callback,
                    delay === WorkspaceCheckpointLimits.terminalTimeoutMs ? 2_147_000_000 : delay,
                    ...args
                )) as typeof setTimeout);
        let snapshot: Awaited<ReturnType<typeof fixture.store.capture>>;
        try {
            snapshot = await fixture.store.capture({ profile: "terminal" });
        } finally {
            captureDeadline.mockRestore();
            captureNow.mockRestore();
        }

        expect(snapshot.coverage.eligibleEntryCount).toBe(fileCount);
        expect(
            fixture.git.calls.filter((args) => args[0] === "hash-object" && args.includes("--stdin-paths"))
        ).toHaveLength(1);
        expect(fixture.git.calls.length).toBeLessThanOrEqual(20);
        fixture.git.calls.length = 0;
        const verifyStarted = Date.now();

        await fixture.store.verify(snapshot.ref);

        expect(Date.now() - verifyStarted).toBeLessThan(30_000);
        expect(fixture.git.calls.filter((args) => args[0] === "cat-file")).toHaveLength(4);
    }, 60_000);

    test("reports referenced-over-quota without deleting an existing owner ref", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "a.txt"), "a");
        const { ref } = await fixture.store.capture({ profile: "pre-turn" });
        const quotaGit = new ReferencedOverQuotaGit(fixture.git, ref.id);
        const quotaStore = await WorkspaceSnapshotStore.open({
            dataRoot: fixture.dataRoot,
            identity: fixture.identity,
            git: quotaGit,
            processOwner: fixture.processOwner,
        });

        const quotaStatus = await quotaStore.getQuotaStatus();
        expect(quotaStatus).toMatchObject({
            status: "referenced-over-quota",
            referencedBytes: 5 * 1024 ** 3 + 1,
            softQuotaBytes: 5 * 1024 ** 3,
        });
        await expect(quotaStore.capture({ profile: "pre-turn" })).rejects.toMatchObject({
            code: "quota_exceeded",
            quotaStatus,
        });
        expect(quotaGit.calls.some((args) => args[0] === "update-ref")).toBe(false);
        const refs = await fixture.git.run(["show-ref"], { gitDir: fixture.storeRoot, timeoutMs: 5_000 });
        expect(refs.stdout.toString()).toContain(ref.id);
    });

    test("stops before quota work when capture is already aborted", async () => {
        const fixture = await makeStoreFixture();
        fixture.git.calls.length = 0;
        const controller = new AbortController();
        controller.abort(new Error("cancelled"));

        await expect(fixture.store.capture({ profile: "pre-turn", signal: controller.signal })).rejects.toMatchObject({
            code: "capture_timeout",
        });
        expect(fixture.git.calls).toEqual([]);
    });

    test("aborts immediately while quota reference traversal is pending", async () => {
        const fixture = await makeStoreFixture();
        const quotaGit = new BlockingQuotaGit(fixture.git);
        const store = await WorkspaceSnapshotStore.open({
            dataRoot: fixture.dataRoot,
            identity: fixture.identity,
            git: quotaGit,
            processOwner: fixture.processOwner,
        });
        const controller = new AbortController();
        const capture = store.capture({ profile: "terminal", signal: controller.signal });
        await quotaGit.started;
        controller.abort(new Error("cancelled"));

        await expect(capture).rejects.toMatchObject({ code: "aborted" });
        expect(quotaGit.calls.some((args) => args[0] === "hash-object")).toBe(false);
    });

    test("anchors every captured descriptor against immediate Git pruning", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "a.txt"), "first");
        const first = await fixture.store.capture({ profile: "pre-turn" });
        await writeFile(join(fixture.workspace, "a.txt"), "second");
        const second = await fixture.store.capture({ profile: "pre-turn" });

        await fixture.git.run(["reflog", "expire", "--expire=now", "--all"], {
            gitDir: fixture.storeRoot,
            timeoutMs: 5_000,
        });
        await fixture.git.run(["gc", "--prune=now"], {
            gitDir: fixture.storeRoot,
            timeoutMs: 30_000,
        });

        await expect(fixture.store.verify(first.ref)).resolves.toBeUndefined();
        await expect(fixture.store.verify(second.ref)).resolves.toBeUndefined();
    });

    test("deletes a ref batch atomically when every expected object still matches", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "a.txt"), "first");
        const { ref } = await fixture.store.capture({ profile: "pre-turn" });
        const firstName = `refs/crest/pending/${fixture.identity.workspaceIdentity}/first`;
        const secondName = "refs/crest/ops/second";
        for (const name of [firstName, secondName]) {
            await fixture.git.run(["update-ref", name, ref.id], {
                gitDir: fixture.storeRoot,
                timeoutMs: 5_000,
            });
        }

        await expect(
            fixture.store.deleteCrestRefs([
                { name: firstName, oid: ref.id },
                { name: secondName, oid: "f".repeat(40) },
            ])
        ).rejects.toThrow();

        const refs = await fixture.store.listCrestRefs();
        expect(refs).toEqual(
            expect.arrayContaining([
                { name: firstName, oid: ref.id },
                { name: secondName, oid: ref.id },
            ])
        );
    });

    test("fails closed for a descriptor from another object", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "a.txt"), "a");
        const { ref } = await fixture.store.capture({ profile: "pre-turn" });
        const invalid = { ...ref, id: ref.tree };

        await expect(fixture.store.verify(invalid)).rejects.toThrow("descriptor");
    });

    test("fails closed for a non-canonical scope manifest", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "a.txt"), "a");
        const { ref } = await fixture.store.capture({ profile: "pre-turn" });
        const manifest = await fixture.git.run(["hash-object", "-w", "--stdin", "--no-filters"], {
            gitDir: fixture.storeRoot,
            stdin: Buffer.from('{"schemaversion":1,"unexpected":true}'),
            timeoutMs: 5_000,
        });
        const manifestOid = manifest.stdout.subarray(0, manifest.stdout.length - 1).toString("ascii");
        const descriptorInput = Buffer.concat([
            Buffer.from(`100644 blob ${manifestOid}\tscope-manifest\0`),
            Buffer.from(`040000 tree ${ref.tree}\tworkspace\0`),
        ]);
        const descriptor = await fixture.git.run(["mktree", "-z"], {
            gitDir: fixture.storeRoot,
            stdin: descriptorInput,
            timeoutMs: 5_000,
        });
        const descriptorOid = descriptor.stdout.subarray(0, descriptor.stdout.length - 1).toString("ascii");

        await expect(fixture.store.verify({ ...ref, id: descriptorOid, scopeManifest: manifestOid })).rejects.toThrow(
            "scope manifest"
        );
    });

    test("rejects semantically valid manifest JSON whose bytes are not canonical", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "a.txt"), "a");
        const { ref } = await fixture.store.capture({ profile: "pre-turn" });
        const value = JSON.parse((await fixture.store.readBlob(ref.scopeManifest)).toString("utf8"));
        const manifestOid = await writeTestBlob(fixture, Buffer.from(JSON.stringify(value, null, 2)));
        const descriptorOid = await writeTestDescriptor(fixture, ref.tree, manifestOid);

        await expect(
            fixture.store.verify({ ...ref, id: descriptorOid, scopeManifest: manifestOid })
        ).rejects.toMatchObject({ code: "corrupt_snapshot" });
    });

    test("rejects a workspace tree whose mode diverges from the manifest", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "a.txt"), "a");
        const { ref } = await fixture.store.capture({ profile: "pre-turn" });
        const state = await fixture.store.readPathState(ref, "a.txt");
        const tree = await fixture.git.run(["mktree", "-z"], {
            gitDir: fixture.storeRoot,
            stdin: Buffer.from(`100755 blob ${(state as { oid: string }).oid}\ta.txt\0`),
            timeoutMs: 5_000,
        });
        const treeOid = stripTestOid(tree.stdout);
        const descriptorOid = await writeTestDescriptor(fixture, treeOid, ref.scopeManifest);

        await expect(fixture.store.verify({ ...ref, id: descriptorOid, tree: treeOid })).rejects.toMatchObject({
            code: "corrupt_snapshot",
        });
    });

    test("rejects a recursively missing workspace blob", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "a.txt"), "a");
        const { ref } = await fixture.store.capture({ profile: "pre-turn" });
        const tree = await fixture.git.run(["mktree", "--missing", "-z"], {
            gitDir: fixture.storeRoot,
            stdin: Buffer.from(`100644 blob ${"f".repeat(40)}\ta.txt\0`),
            timeoutMs: 5_000,
        });
        const treeOid = stripTestOid(tree.stdout);
        const descriptorOid = await writeTestDescriptor(fixture, treeOid, ref.scopeManifest);

        await expect(fixture.store.verify({ ...ref, id: descriptorOid, tree: treeOid })).rejects.toMatchObject({
            code: "corrupt_snapshot",
        });
    });

    test("rejects a workspace branch that points to a blob", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "tracked.txt"), "tracked");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const wrongTreeType = await writeTestBlob(fixture, Buffer.from("not a tree"));
        const descriptor = await writeRawTree(
            fixture,
            Buffer.concat([
                Buffer.from("100644 scope-manifest\0"),
                Buffer.from(captured.ref.scopeManifest, "hex"),
                Buffer.from("40000 workspace\0"),
                Buffer.from(wrongTreeType, "hex"),
            ])
        );

        await expect(
            fixture.store.verify({
                ...captured.ref,
                id: descriptor,
                tree: wrongTreeType,
            })
        ).rejects.toMatchObject({
            code: "corrupt_snapshot",
        });
    });

    test("exposes fixed capture limits", () => {
        expect(WorkspaceCheckpointLimits).toEqual({
            preTurnTimeoutMs: 5_000,
            terminalTimeoutMs: 30_000,
            maxEntries: 200_000,
            maxNewlyHashedBytes: 1024 ** 3,
            maxUntrackedFileBytes: 2 * 1024 ** 2,
            softQuotaBytes: 5 * 1024 ** 3,
            minimumFreeBytes: 1024 ** 3,
            minimumFreeRatio: 0.05,
        });
        expect(Object.isFrozen(WorkspaceCheckpointLimits)).toBe(true);
    });

    test("enforces the ratio-based free-space gate", async () => {
        vi.doMock("node:fs/promises", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:fs/promises")>();
            return {
                ...actual,
                statfs: async () => ({
                    type: 0n,
                    bsize: 1024n ** 3n,
                    blocks: 100n,
                    bfree: 4n,
                    bavail: 4n,
                    files: 1n,
                    ffree: 1n,
                }),
            };
        });
        vi.resetModules();
        try {
            const [isolated, isolatedGit] = await Promise.all([import("./snapshot-store"), import("./git-runner")]);
            const fixture = await makeStoreFixtureWith(isolated.WorkspaceSnapshotStore, isolatedGit.WorkspaceGitRunner);

            await expect(fixture.store.capture({ profile: "pre-turn" })).rejects.toMatchObject({
                code: "enospc",
            });
        } finally {
            vi.doUnmock("node:fs/promises");
            vi.resetModules();
        }
    });

    test.each([
        { profile: "pre-turn" as const, expectedTimeoutMs: 5_000 },
        { profile: "terminal" as const, expectedTimeoutMs: 30_000 },
        { profile: "safety" as const, expectedTimeoutMs: 30_000 },
    ])("applies the fixed $profile deadline and ignores caller overrides", async ({ profile, expectedTimeoutMs }) => {
        let resolveStarted!: (input: { maxEntries: number; maxUntrackedBytes: number }) => void;
        const started = new Promise<{ maxEntries: number; maxUntrackedBytes: number }>((resolve) => {
            resolveStarted = resolve;
        });
        vi.doMock("./workspace-scope", () => ({
            discoverWorkspaceScope: (input: { maxEntries: number; maxUntrackedBytes: number }) => {
                resolveStarted(input);
                return new Promise(() => undefined);
            },
            verifyWorkspaceScopeDirectories: async () => true,
        }));
        vi.resetModules();
        try {
            const isolated = await import("./snapshot-store");
            const fixture = await makeStoreFixtureWith(isolated.WorkspaceSnapshotStore);
            vi.useFakeTimers();
            const capture = fixture.store.capture({ profile, timeoutMs: 1 } as never);
            await expect(started).resolves.toMatchObject({
                maxEntries: 200_000,
                maxUntrackedBytes: 2 * 1024 ** 2,
            });
            const timedOut = expect(capture).rejects.toMatchObject({ code: "capture_timeout" });
            let settled = false;
            void capture.then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                }
            );
            await vi.advanceTimersByTimeAsync(expectedTimeoutMs - 1);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(2);

            await timedOut;
        } finally {
            vi.useRealTimers();
            vi.doUnmock("./workspace-scope");
            vi.resetModules();
        }
    });

    test("rejects the fixed newly-hashed byte budget before reading an oversized entry", async () => {
        vi.doMock("./workspace-scope", () => ({
            discoverWorkspaceScope: async (input: { identity: CanonicalWorkspaceIdentity }) => ({
                root: input.identity.canonicalRoot,
                entries: [
                    {
                        path: "too-large.bin",
                        pathBytes: Buffer.from("too-large.bin"),
                        kind: "file",
                        tracked: true,
                        executable: false,
                        size: 1024 ** 3 + 1,
                        ...(await makeScopeEvidence(input.identity.canonicalRoot, "too-large.bin")),
                    },
                ],
                coverage: {
                    complete: true,
                    eligibleEntryCount: 1,
                    newlyHashedBytes: 0,
                    exclusions: [],
                },
                manifest: {
                    schemaVersion: 1,
                    policy: {
                        maxEntries: 200_000,
                        maxUntrackedBytes: 2 * 1024 ** 2,
                        gitGlobalExcludes: "disabled-by-isolated-runner",
                    },
                    ignoreInputs: [],
                    nestedRepositoryBoundaries: [],
                },
            }),
            verifyWorkspaceScopeDirectories: async () => true,
        }));
        vi.resetModules();
        try {
            const [isolated, isolatedGit] = await Promise.all([import("./snapshot-store"), import("./git-runner")]);
            const fixture = await makeStoreFixtureWith(isolated.WorkspaceSnapshotStore, isolatedGit.WorkspaceGitRunner);
            const oversized = await open(join(fixture.workspace, "too-large.bin"), "w");
            await oversized.truncate(1024 ** 3 + 1);
            await oversized.close();

            await expect(fixture.store.capture({ profile: "terminal" })).rejects.toMatchObject({
                code: "capture_budget",
            });
        } finally {
            vi.doUnmock("./workspace-scope");
            vi.resetModules();
        }
    });
});

async function makeStoreFixture() {
    return makeStoreFixtureWith(WorkspaceSnapshotStore);
}

async function makeStoreFixtureWith(
    Store: typeof WorkspaceSnapshotStore,
    Git: typeof WorkspaceGitRunner = RecordingGit
): Promise<Awaited<ReturnType<typeof makeStoreFixtureCore>>> {
    return makeStoreFixtureCore(Store, Git);
}

async function makeStoreFixtureCore(Store: typeof WorkspaceSnapshotStore, Git: typeof WorkspaceGitRunner) {
    const root = await temporaryDirectory();
    const requestedWorkspace = join(root, "workspace");
    const dataRoot = join(root, "data");
    await mkdir(requestedWorkspace, { recursive: true });
    const workspace = await realpath(requestedWorkspace);
    const identity: CanonicalWorkspaceIdentity = {
        canonicalRoot: workspace,
        workspaceIdentity: "a".repeat(64),
        workspaceIncarnation: "b".repeat(64),
        storeKey: "test-store",
        ancestorIdentityChain: await makeTestAncestorIdentityChain(workspace),
    };
    const git = new Git() as RecordingGit;
    const processOwner = await makeProcessOwnerIdentity();
    const store = await Store.open({
        dataRoot,
        identity,
        git,
        processOwner,
    });
    return {
        workspace,
        dataRoot,
        identity,
        git,
        processOwner,
        store,
        storeRoot: join(dataRoot, "agent-checkpoints", "workspaces", identity.storeKey, "repo.git"),
    };
}

async function writeTestBlob(fixture: Awaited<ReturnType<typeof makeStoreFixture>>, bytes: Buffer): Promise<string> {
    const result = await fixture.git.run(["hash-object", "-w", "--stdin", "--no-filters"], {
        gitDir: fixture.storeRoot,
        stdin: bytes,
        timeoutMs: 5_000,
    });
    return stripTestOid(result.stdout);
}

async function writeTestDescriptor(
    fixture: Awaited<ReturnType<typeof makeStoreFixture>>,
    treeOid: string,
    manifestOid: string
): Promise<string> {
    const result = await fixture.git.run(["mktree", "-z"], {
        gitDir: fixture.storeRoot,
        stdin: Buffer.concat([
            Buffer.from(`100644 blob ${manifestOid}\tscope-manifest\0`),
            Buffer.from(`040000 tree ${treeOid}\tworkspace\0`),
        ]),
        timeoutMs: 5_000,
    });
    return stripTestOid(result.stdout);
}

async function writeRawTree(fixture: Awaited<ReturnType<typeof makeStoreFixture>>, bytes: Buffer): Promise<string> {
    const result = await fixture.git.run(["hash-object", "-t", "tree", "-w", "--stdin"], {
        gitDir: fixture.storeRoot,
        stdin: bytes,
        timeoutMs: 5_000,
    });
    return stripTestOid(result.stdout);
}

function stripTestOid(value: Buffer): string {
    return value.subarray(0, value.length - 1).toString("ascii");
}

async function makeTestAncestorIdentityChain(
    path: string
): Promise<CanonicalWorkspaceIdentity["ancestorIdentityChain"]> {
    const paths = [path];
    while (dirname(paths[0]!) !== paths[0]) {
        paths.unshift(dirname(paths[0]!));
    }
    return Object.freeze(
        await Promise.all(
            paths.map(async (absolutePath) => {
                const metadata = await lstat(absolutePath, { bigint: true });
                return Object.freeze({
                    absolutePath,
                    dev: metadata.dev.toString(),
                    ino: metadata.ino.toString(),
                    birthtimeNs: metadata.birthtimeNs.toString(),
                });
            })
        )
    );
}

async function makeScopeEvidence(root: string, relativePath: string) {
    const parentPath = relativePath.includes("/") ? dirname(relativePath) : "";
    const [parent, entry] = await Promise.all([
        lstat(parentPath ? join(root, parentPath) : root, { bigint: true }),
        lstat(join(root, relativePath), { bigint: true }),
    ]);
    return {
        parentIdentity: {
            dev: parent.dev,
            ino: parent.ino,
            birthtimeNs: parent.birthtimeNs,
        },
        entryIdentity: {
            dev: entry.dev,
            ino: entry.ino,
            birthtimeNs: entry.birthtimeNs,
            mode: entry.mode,
            nlink: entry.nlink,
            size: entry.size,
            mtimeNs: entry.mtimeNs,
            ctimeNs: entry.ctimeNs,
        },
    };
}

class ReferencedOverQuotaGit extends WorkspaceGitRunner {
    calls: string[][] = [];

    constructor(
        readonly delegate: WorkspaceGitRunner,
        readonly referencedOid: string
    ) {
        super(delegate.executable);
    }

    override async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
        this.calls.push([...args]);
        if (args[0] === "for-each-ref") {
            return { stdout: Buffer.from(`${this.referencedOid}\n`), stderr: Buffer.alloc(0) };
        }
        if (args[0] === "rev-list") {
            return { stdout: Buffer.from(`${this.referencedOid}\n`), stderr: Buffer.alloc(0) };
        }
        if (args[0] === "cat-file" && args[1]?.startsWith("--batch-check=")) {
            return {
                stdout: Buffer.from(`${this.referencedOid} blob ${5 * 1024 ** 3 + 1}\n`),
                stderr: Buffer.alloc(0),
            };
        }
        return this.delegate.run(args, options);
    }
}

class BlockingQuotaGit extends WorkspaceGitRunner {
    calls: string[][] = [];
    resolveStarted!: () => void;
    started = new Promise<void>((resolve) => {
        this.resolveStarted = resolve;
    });

    constructor(readonly delegate: WorkspaceGitRunner) {
        super(delegate.executable);
    }

    override async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
        this.calls.push([...args]);
        if (args[0] !== "for-each-ref") {
            return this.delegate.run(args, options);
        }
        this.resolveStarted();
        return new Promise<GitRunResult>((_resolve, reject) => {
            const onAbort = () => reject(new WorkspaceGitRunnerError("aborted", "aborted"));
            options.signal?.addEventListener("abort", onAbort, { once: true });
            if (options.signal?.aborted) {
                onAbort();
            }
        });
    }
}

class RecordingGit extends WorkspaceGitRunner {
    calls: string[][] = [];

    override async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
        this.calls.push([...args]);
        return super.run(args, options);
    }
}

class UnsupportedFsyncGit extends WorkspaceGitRunner {
    override async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
        const result = await super.run(args, options);
        if (args[0] === "rev-parse") {
            return {
                ...result,
                stderr: Buffer.from("warning: ignoring unknown core.fsync component 'reference'\n"),
            };
        }
        return result;
    }
}

class BlockingInitGit extends WorkspaceGitRunner {
    initCalls = 0;
    resolveEntered!: () => void;
    resolveBlocked!: () => void;
    entered = new Promise<void>((resolveEntered) => {
        this.resolveEntered = resolveEntered;
    });
    blocked = new Promise<void>((resolveBlocked) => {
        this.resolveBlocked = resolveBlocked;
    });

    unblock(): void {
        this.resolveBlocked();
    }

    override async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
        if (args[0] === "init") {
            this.initCalls++;
            if (this.initCalls === 1) {
                this.resolveEntered();
                await this.blocked;
            }
        }
        return super.run(args, options);
    }
}

async function expectOwnerOnlyTree(root: string): Promise<void> {
    const entries = await readdir(root, { withFileTypes: true });
    expect((await stat(root)).mode & 0o077).toBe(0);
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isSymbolicLink()) {
            continue;
        }
        expect((await stat(path)).mode & 0o077, path).toBe(0);
        if (entry.isDirectory()) {
            await expectOwnerOnlyTree(path);
        }
    }
}

async function temporaryDirectory(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "crest-snapshot-store-test-"));
    cleanupRoots.push(root);
    return root;
}

function makeDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function makeBootstrapChildScript(storeRoot: string): string {
    const snapshotUrl = pathToFileURL(
        join(process.cwd(), "packages", "coding-agent", "workspace-rewind", "snapshot-store.ts")
    ).href;
    const gitUrl = pathToFileURL(
        join(process.cwd(), "packages", "coding-agent", "workspace-rewind", "git-runner.ts")
    ).href;
    const ownerUrl = pathToFileURL(
        join(process.cwd(), "packages", "coding-agent", "workspace-rewind", "process-owner.ts")
    ).href;
    return `(async () => {
        const [{ initializePrivateStore }, { WorkspaceGitRunner }, { makeProcessOwnerIdentity }] = await Promise.all([
            import(${JSON.stringify(snapshotUrl)}),
            import(${JSON.stringify(gitUrl)}),
            import(${JSON.stringify(ownerUrl)})
        ]);
        await initializePrivateStore({
            storeRoot: ${JSON.stringify(storeRoot)},
            git: new WorkspaceGitRunner(),
            processOwner: await makeProcessOwnerIdentity()
        });
    })().catch((error) => {
        process.stderr.write(String(error?.stack ?? error));
        process.exitCode = 1;
    });`;
}

function makeCrashingBootstrapChildScript(storeRoot: string): string {
    const snapshotUrl = pathToFileURL(
        join(process.cwd(), "packages", "coding-agent", "workspace-rewind", "snapshot-store.ts")
    ).href;
    const gitUrl = pathToFileURL(
        join(process.cwd(), "packages", "coding-agent", "workspace-rewind", "git-runner.ts")
    ).href;
    const ownerUrl = pathToFileURL(
        join(process.cwd(), "packages", "coding-agent", "workspace-rewind", "process-owner.ts")
    ).href;
    return `(async () => {
        const [{ initializePrivateStore }, { WorkspaceGitRunner }, { makeProcessOwnerIdentity }] = await Promise.all([
            import(${JSON.stringify(snapshotUrl)}),
            import(${JSON.stringify(gitUrl)}),
            import(${JSON.stringify(ownerUrl)})
        ]);
        class BlockingGit extends WorkspaceGitRunner {
            async run(args, options) {
                if (args[0] === "init") {
                    process.stdout.write("owner-ready\\n");
                    await new Promise((resolve) => setTimeout(resolve, 60_000));
                }
                return super.run(args, options);
            }
        }
        await initializePrivateStore({
            storeRoot: ${JSON.stringify(storeRoot)},
            git: new BlockingGit(),
            processOwner: await makeProcessOwnerIdentity()
        });
    })().catch((error) => {
        process.stderr.write(String(error?.stack ?? error));
        process.exitCode = 1;
    });`;
}

function spawnTsxChild(script: string): ChildProcess {
    return spawn(process.execPath, ["--import", "tsx", "--eval", script], {
        stdio: ["ignore", "pipe", "pipe"],
    });
}

async function runTsxChild(script: string): Promise<{ code: number; stderr: string }> {
    const child = spawnTsxChild(script);
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
        stderr += chunk;
    });
    const code = await waitForChildExit(child);
    return { code: code ?? -1, stderr };
}

async function waitForChildOutput(child: ChildProcess, expected: string): Promise<void> {
    let output = "";
    child.stdout!.setEncoding("utf8");
    await new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", (chunk: string) => {
            output += chunk;
            if (output.includes(expected)) {
                resolve();
            }
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`Bootstrap child exited before publishing: ${code}`)));
    });
}

async function waitForChildExit(child: ChildProcess): Promise<number | null> {
    if (child.exitCode != null || child.signalCode != null) {
        return child.exitCode;
    }
    return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
}
