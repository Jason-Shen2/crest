// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
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
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceGitRunner, WorkspaceGitRunnerError, type GitRunOptions, type GitRunResult } from "./git-runner";
import { IncrementalPathCapture } from "./incremental-path-capture";
import { makeProcessOwnerIdentity } from "./process-owner";
import { SnapshotQuotaExceededError } from "./snapshot-quota-accounting";
import {
    initializePrivateStore,
    WorkspaceCheckpointLimits,
    WorkspaceSnapshotStore,
    WorkspaceSnapshotStoreError,
} from "./snapshot-store";
import type { CapturedPathStateV1, WorkspaceSnapshotCoverage, WorkspaceSnapshotRefV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import { discoverWorkspaceScope } from "./workspace-scope";

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
        let settled = 0;
        const operations = [
            fixture.store.capture({ profile: "terminal" }),
            fixture.store.diff(ref, ref),
            fixture.store.readPathState(ref, "locked.txt"),
            fixture.store.readBlob(ref.scopeManifest),
            fixture.store.verify(ref),
            fixture.store.anchorSnapshot(ref),
            fixture.store.anchorPending(pending),
            fixture.store.deleteCrestRef(`refs/crest/pending/${fixture.identity.workspaceIdentity}/missing-lock`),
            fixture.store.deleteCrestRefs([]),
            fixture.store.readCrestRefBlob(`refs/crest/pending/${fixture.identity.workspaceIdentity}/missing-lock`),
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

    test("quarantines legacy restore bytes without decoding and warns once", async () => {
        const fixture = await makeStoreFixture();
        const legacyRoot = join(fixture.storeRoot, "journal", "restores");
        const bytes = Buffer.from("not-json\0legacy-restore");
        const digest = createHash("sha256").update(bytes).digest("hex");
        await mkdir(legacyRoot, { recursive: true, mode: 0o700 });
        const source = join(legacyRoot, "operation.json");
        await writeFile(source, bytes, { mode: 0o600 });
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

        await WorkspaceSnapshotStore.open({
            dataRoot: fixture.dataRoot,
            identity: fixture.identity,
            git: fixture.git,
            processOwner: fixture.processOwner,
        });

        const destination = join(fixture.storeRoot, "journal", "restore", "resolved", `legacy-${digest}.json`);
        await expect(readFile(destination)).resolves.toEqual(bytes);
        await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
        expect(warning).toHaveBeenCalledWith(expect.stringMatching(/legacy.*restore.*incompatible.*quarantined/i));

        warning.mockClear();
        await WorkspaceSnapshotStore.open({
            dataRoot: fixture.dataRoot,
            identity: fixture.identity,
            git: fixture.git,
            processOwner: fixture.processOwner,
        });
        expect(warning).not.toHaveBeenCalled();
        warning.mockRestore();
    });

    test.skipIf(process.platform === "win32")(
        "syncs each legacy quarantine destination before unlinking its source",
        async () => {
            const fixture = await makeStoreFixture();
            const legacyRoot = join(fixture.storeRoot, "journal", "restores");
            const resolvedRoot = join(fixture.storeRoot, "journal", "restore", "resolved");
            const bytes = Buffer.from("durable legacy restore");
            const digest = createHash("sha256").update(bytes).digest("hex");
            const source = join(legacyRoot, "operation.json");
            const destination = join(resolvedRoot, `legacy-${digest}.json`);
            await mkdir(legacyRoot, { recursive: true, mode: 0o700 });
            await writeFile(source, bytes, { mode: 0o600 });
            const probe = await open(source, "r");
            const prototype = Object.getPrototypeOf(probe) as {
                sync(): Promise<void>;
            };
            const originalSync = prototype.sync;
            await probe.close();
            const events: Array<{ directory: boolean; sourceExists: boolean }> = [];
            const exists = async (path: string) =>
                lstat(path).then(
                    () => true,
                    (error: NodeJS.ErrnoException) => {
                        if (error.code === "ENOENT") return false;
                        throw error;
                    }
                );
            const sync = vi.spyOn(prototype, "sync").mockImplementation(async function () {
                await originalSync.call(this);
                if (!(await exists(destination))) return;
                const state = await (this as unknown as { stat(): Promise<{ isDirectory(): boolean }> }).stat();
                events.push({ directory: state.isDirectory(), sourceExists: await exists(source) });
            });

            try {
                await WorkspaceSnapshotStore.open({
                    dataRoot: fixture.dataRoot,
                    identity: fixture.identity,
                    git: fixture.git,
                    processOwner: fixture.processOwner,
                });
            } finally {
                sync.mockRestore();
            }

            const destinationFileSync = events.findIndex((event) => !event.directory && event.sourceExists);
            const destinationDirectorySync = events.findIndex((event) => event.directory && event.sourceExists);
            const sourceDirectorySync = events.findIndex((event) => event.directory && !event.sourceExists);
            expect(destinationFileSync).toBeGreaterThanOrEqual(0);
            expect(destinationDirectorySync).toBeGreaterThan(destinationFileSync);
            expect(sourceDirectorySync).toBeGreaterThan(destinationDirectorySync);
        }
    );

    test("does not block startup when legacy restore quarantine cannot be created", async () => {
        const fixture = await makeStoreFixture();
        const legacyRoot = join(fixture.storeRoot, "journal", "restores");
        const source = join(legacyRoot, "operation.json");
        const bytes = Buffer.from("legacy source must remain");
        await mkdir(legacyRoot, { recursive: true, mode: 0o700 });
        await writeFile(source, bytes, { mode: 0o600 });
        await writeFile(join(fixture.storeRoot, "journal", "restore"), "blocks resolved directory", {
            mode: 0o600,
        });
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

        await expect(
            WorkspaceSnapshotStore.open({
                dataRoot: fixture.dataRoot,
                identity: fixture.identity,
                git: fixture.git,
                processOwner: fixture.processOwner,
            })
        ).resolves.toBeInstanceOf(WorkspaceSnapshotStore);
        await expect(readFile(source)).resolves.toEqual(bytes);
        expect(warning).toHaveBeenCalledWith(expect.stringMatching(/legacy.*restore.*incompatible/i));
        warning.mockRestore();
    });

    test("continues quarantining valid legacy restore bytes after an unsafe entry", async () => {
        const fixture = await makeStoreFixture();
        const legacyRoot = join(fixture.storeRoot, "journal", "restores");
        const bytes = Buffer.from("valid raw legacy restore");
        const digest = createHash("sha256").update(bytes).digest("hex");
        await mkdir(legacyRoot, { recursive: true, mode: 0o700 });
        await symlink(fixture.workspace, join(legacyRoot, "a-unsafe.json"));
        const source = join(legacyRoot, "b-valid.json");
        await writeFile(source, bytes, { mode: 0o600 });
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

        await expect(
            WorkspaceSnapshotStore.open({
                dataRoot: fixture.dataRoot,
                identity: fixture.identity,
                git: fixture.git,
                processOwner: fixture.processOwner,
            })
        ).resolves.toBeInstanceOf(WorkspaceSnapshotStore);

        await expect(
            readFile(join(fixture.storeRoot, "journal", "restore", "resolved", `legacy-${digest}.json`))
        ).resolves.toEqual(bytes);
        await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(join(legacyRoot, "a-unsafe.json"))).resolves.toMatchObject({ mode: expect.any(Number) });
        expect(warning).toHaveBeenCalledWith(expect.stringMatching(/some entries.*quarantined/i));
        warning.mockRestore();
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

    test("exposes full reconcile as the v2 baseline primitive while preserving capture compatibility", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "a.txt"), "a");

        const reconciled = await fixture.store.captureFullReconcile({ profile: "pre-turn" });
        const captured = await fixture.store.capture({ profile: "terminal" });
        const reconciledManifest = JSON.parse(
            (await fixture.store.readBlob(reconciled.ref.scopeManifest)).toString("utf8")
        );
        const capturedManifest = JSON.parse(
            (await fixture.store.readBlob(captured.ref.scopeManifest)).toString("utf8")
        );

        expect(reconciledManifest).toMatchObject({ schemaversion: 2, statetree: expect.stringMatching(/^[0-9a-f]+$/) });
        expect(capturedManifest).toMatchObject({ schemaversion: 2, statetree: expect.stringMatching(/^[0-9a-f]+$/) });
        await expect(fixture.store.verifyOwnedSnapshot(reconciled.ref)).resolves.toBeUndefined();
        await expect(fixture.store.verifyOwnedSnapshot(captured.ref)).resolves.toBeUndefined();
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
        expect(JSON.parse(manifest.toString("utf8"))).toMatchObject({ schemaversion: 2 });
        expect(ref.workspaceIdentity).toBe(fixture.identity.workspaceIdentity);
        expect(ref.workspaceIncarnation).toBe(fixture.identity.workspaceIncarnation);
    });

    test("reads and verifies a snapshot backed by a v2 path-state tree", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, ".gitignore"), "ignored.log\n");
        await writeFile(join(fixture.workspace, "README.md"), "readme");
        await writeFile(join(fixture.workspace, "ignored.log"), "ignored");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const v2 = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);

        await expect(fixture.store.verify(v2)).resolves.toBeUndefined();
        await expect(fixture.store.readPathState(v2, "README.md")).resolves.toMatchObject({ state: "file" });
        await expect(fixture.store.readPathState(v2, "ignored.log")).resolves.toEqual({
            state: "excluded",
            reason: "ignored",
        });
        await expect(fixture.store.readPathState(v2, "missing.txt")).resolves.toEqual({ state: "absent" });
    });

    test("diffs v2 path-state trees without changing v1 results", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "keep.txt"), "same");
        await writeFile(join(fixture.workspace, "change.txt"), "before");
        const before = await fixture.store.capture({ profile: "terminal" });
        await writeFile(join(fixture.workspace, "change.txt"), "after");
        await writeFile(join(fixture.workspace, "new.txt"), "new");
        const after = await fixture.store.capture({ profile: "terminal" });
        const [beforeV2, afterV2] = await Promise.all([
            convertSnapshotToV2(fixture, before.ref, before.coverage),
            convertSnapshotToV2(fixture, after.ref, after.coverage),
        ]);

        expect(await fixture.store.diff(beforeV2, afterV2)).toEqual(await fixture.store.diff(before.ref, after.ref));
    });

    test("roots a v2 state tree through its owner descriptor across immediate Git pruning", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "README.md"), "survives gc");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const v2 = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(v2);

        await fixture.git.run(["gc", "--prune=now"], {
            gitDir: fixture.storeRoot,
            timeoutMs: 30_000,
        });

        await expect(fixture.store.verify(v2)).resolves.toBeUndefined();
        await expect(fixture.store.readPathState(v2, "README.md")).resolves.toMatchObject({ state: "file" });
        await expect(fixture.store.diff(v2, v2)).resolves.toEqual([]);
    });

    test("commits a copy-on-write v2 snapshot and roots every new object through its owner ref", async () => {
        const fixture = await makeStoreFixture();
        await mkdir(join(fixture.workspace, "docs"));
        await mkdir(join(fixture.workspace, "src"));
        await mkdir(join(fixture.workspace, "assets"));
        await writeFile(join(fixture.workspace, "docs", "README.md"), "before");
        await writeFile(join(fixture.workspace, "src", "index.ts"), "source");
        await writeFile(join(fixture.workspace, "assets", "logo.txt"), "logo");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        const updatedOid = await writeTestBlob(fixture, Buffer.from("after"));
        const baseSrc = await readChildTreeOid(fixture, base.tree, "src");
        const baseAssets = await readChildTreeOid(fixture, base.tree, "assets");
        fixture.git.calls.length = 0;

        const committed = await fixture.store.commitIncrementalSnapshot({
            ...input,
            mutations: [{ path: "docs/README.md", state: { state: "file", oid: updatedOid, executable: false } }],
        });

        expect(committed.coverage).toEqual({ ...captured.coverage, newlyHashedBytes: 5 });
        expect(await fixture.store.readPathState(committed.ref, "docs/README.md")).toEqual({
            state: "file",
            oid: updatedOid,
            executable: false,
        });
        expect(await readChildTreeOid(fixture, committed.ref.tree, "src")).toBe(baseSrc);
        expect(await readChildTreeOid(fixture, committed.ref.tree, "assets")).toBe(baseAssets);
        const manifest = JSON.parse((await fixture.store.readBlob(committed.ref.scopeManifest)).toString("utf8")) as {
            schemaversion: number;
            statetree: string;
        };
        const descriptor = await fixture.git.run(["cat-file", "-p", committed.ref.id], {
            gitDir: fixture.storeRoot,
            timeoutMs: 5_000,
        });
        expect(manifest.schemaversion).toBe(2);
        expect(descriptor.stdout.toString()).toContain(`${manifest.statetree}\tstate\n`);
        expect(fixture.git.calls.filter((args) => args[0] === "mktree")).toHaveLength(5);
        expect(fixture.git.calls.filter((args) => args[0] === "count-objects" || args[0] === "rev-list")).toEqual([]);

        await fixture.git.run(["gc", "--prune=now"], { gitDir: fixture.storeRoot, timeoutMs: 30_000 });
        await expect(fixture.store.verifyOwnedSnapshot(committed.ref)).resolves.toBeUndefined();
        await expect(fixture.store.diff(base, committed.ref)).resolves.toHaveLength(1);
    });

    test("materializes captured bytes and roots them in one locked incremental commit", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "README.md"), "before");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const scope = await discoverWorkspaceScope({
            identity: fixture.identity,
            git: fixture.git,
            maxEntries: WorkspaceCheckpointLimits.maxEntries,
            maxUntrackedBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
        });
        const pathCapture = new IncrementalPathCapture({
            identity: fixture.identity,
            git: fixture.git,
            storeRoot: fixture.storeRoot,
            scope: scope.manifest,
            maxEntries: WorkspaceCheckpointLimits.maxEntries,
            maxUntrackedBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
            maxNewlyHashedBytes: WorkspaceCheckpointLimits.maxNewlyHashedBytes,
            timeoutMs: 10_000,
            base: { readNodeKind: (path, signal) => fixture.store.readNodeKind(base, path, signal) },
        });
        await writeFile(join(fixture.workspace, "README.md"), "after");
        const result = await pathCapture.capture(["README.md"]);
        if (result.status !== "captured" || result.mutations[0]!.state.state !== "file") {
            throw new Error("expected captured file mutation");
        }
        const oid = result.mutations[0]!.state.oid;
        await expect(
            fixture.git.run(["cat-file", "blob", oid], { gitDir: fixture.storeRoot, timeoutMs: 5_000 })
        ).rejects.toMatchObject({ code: "nonzero_exit" });
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);

        const committed = await pathCapture.consumeCaptured(result, (batch) =>
            fixture.store.commitCapturedIncrementalSnapshot({
                ...input,
                scope: scope.manifest,
                mutations: result.mutations,
                newlyHashedBytes: result.newlyHashedBytes,
                batch,
            })
        );

        await fixture.git.run(["gc", "--prune=now"], { gitDir: fixture.storeRoot, timeoutMs: 30_000 });
        await expect(fixture.store.readBlob(oid)).resolves.toEqual(Buffer.from("after"));
        await expect(fixture.store.verifyOwnedSnapshot(committed.ref)).resolves.toBeUndefined();
    });

    test("reads immutable snapshot node kinds without waiting for the mutation lock", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "README.md"), "content");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        const releaseLock = makeDeferred();
        const held = fixture.store.withWorkspaceLock(() => releaseLock.promise);
        await fixture.store.mutationLock.waitUntilHeldForTest();

        const pending = fixture.store.readNodeKind(base, "README.md");
        const whileHeld = await Promise.race([
            pending,
            new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
        ]);
        releaseLock.resolve();
        await held;
        await pending;

        expect(whileHeld).toBe("leaf");
    });

    test("propagates base node cancellation through lock-free manifest Git reads and drains", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "README.md"), "content");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        const releaseLock = makeDeferred();
        const held = fixture.store.withWorkspaceLock(() => releaseLock.promise);
        await fixture.store.mutationLock.waitUntilHeldForTest();
        const originalRun = fixture.git.run.bind(fixture.git);
        const started = makeDeferred();
        let activeGitReads = 0;
        vi.spyOn(fixture.git, "run").mockImplementation(async (args, options) => {
            if (args[0] === "cat-file") {
                activeGitReads += 1;
                started.resolve();
                try {
                    await new Promise<void>((resolve, reject) => {
                        const timer = setTimeout(resolve, 150);
                        options.signal?.addEventListener(
                            "abort",
                            () => {
                                clearTimeout(timer);
                                reject(options.signal!.reason);
                            },
                            { once: true }
                        );
                    });
                } finally {
                    activeGitReads -= 1;
                }
            }
            return await originalRun(args, options);
        });
        const controller = new AbortController();
        const abortReason = new Error("caller cancelled base read");
        const pending = fixture.store.readNodeKind(base, "README.md", controller.signal).then(
            (value) => ({ status: "fulfilled" as const, value }),
            (error) => ({ status: "rejected" as const, error })
        );
        const startedWhileHeld = await Promise.race([
            started.promise.then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
        ]);

        controller.abort(abortReason);
        releaseLock.resolve();
        await held;
        const outcome = await pending;

        expect(startedWhileHeld).toBe(true);
        expect(outcome).toEqual({ status: "rejected", error: abortReason });
        expect(activeGitReads).toBe(0);
    });

    test("rejects captured batch semantic tampering before quota, object, or ref work", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "a.txt"), "before");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const scope = await discoverWorkspaceScope({
            identity: fixture.identity,
            git: fixture.git,
            maxEntries: WorkspaceCheckpointLimits.maxEntries,
            maxUntrackedBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
        });
        const pathCapture = new IncrementalPathCapture({
            identity: fixture.identity,
            git: fixture.git,
            storeRoot: fixture.storeRoot,
            scope: scope.manifest,
            maxEntries: WorkspaceCheckpointLimits.maxEntries,
            maxUntrackedBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
            maxNewlyHashedBytes: WorkspaceCheckpointLimits.maxNewlyHashedBytes,
            timeoutMs: 10_000,
            base: { readNodeKind: (path, signal) => fixture.store.readNodeKind(base, path, signal) },
        });
        await writeFile(join(fixture.workspace, "a.txt"), "after");
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        type CapturedResult = Extract<Awaited<ReturnType<typeof pathCapture.capture>>, { status: "captured" }>;
        const attempts: Array<
            (
                result: CapturedResult,
                oid: string
            ) => Pick<typeof input, "newlyHashedBytes"> & {
                mutations: CapturedResult["mutations"];
            }
        > = [
            (result) => ({
                mutations: [{ ...result.mutations[0]!, path: "b.txt" }],
                newlyHashedBytes: result.newlyHashedBytes,
            }),
            (result) => ({
                mutations: [
                    {
                        ...result.mutations[0]!,
                        state: { state: "file" as const, oid: "0".repeat(40), executable: false },
                    },
                ],
                newlyHashedBytes: result.newlyHashedBytes,
            }),
            (result, oid) => ({
                mutations: [
                    {
                        ...result.mutations[0]!,
                        state: { state: "file" as const, oid, executable: true },
                    },
                ],
                newlyHashedBytes: result.newlyHashedBytes,
            }),
            (result) => ({
                mutations: [{ path: result.mutations[0]!.path, state: { state: "absent" as const } }],
                newlyHashedBytes: result.newlyHashedBytes,
            }),
            (result) => ({
                mutations: result.mutations,
                newlyHashedBytes: 0,
            }),
            (result) => ({
                mutations: result.mutations,
                newlyHashedBytes: result.newlyHashedBytes + 1,
            }),
        ];

        for (const tamper of attempts) {
            const result = await pathCapture.capture(["a.txt"]);
            if (result.status !== "captured") throw new Error("expected captured mutation");
            const state = result.mutations[0]!.state;
            if (state.state !== "file") throw new Error("expected captured file mutation");
            const semanticInput = tamper(result, state.oid);
            fixture.git.calls.length = 0;

            await expect(
                pathCapture.consumeCaptured(result, (batch) =>
                    fixture.store.commitCapturedIncrementalSnapshot({
                        ...input,
                        scope: scope.manifest,
                        ...semanticInput,
                        batch,
                    })
                )
            ).rejects.toThrow(/captured batch semantics/i);
            expect(fixture.git.calls).toEqual([]);
        }

        await writeFile(join(fixture.workspace, "b.txt"), "other");
        const resultA = await pathCapture.capture(["a.txt"]);
        const resultB = await pathCapture.capture(["b.txt"]);
        if (resultA.status !== "captured" || resultB.status !== "captured") {
            throw new Error("expected two captured results");
        }
        fixture.git.calls.length = 0;
        await expect(
            pathCapture.consumeCaptured(resultA, (batch) =>
                fixture.store.commitCapturedIncrementalSnapshot({
                    ...input,
                    scope: scope.manifest,
                    mutations: resultB.mutations,
                    newlyHashedBytes: resultB.newlyHashedBytes,
                    batch,
                })
            )
        ).rejects.toThrow(/captured batch semantics/i);
        expect(fixture.git.calls).toEqual([]);
        await pathCapture.discardCaptured(resultB);
    });

    test("commits deterministic incremental snapshot ids independent of mutation order", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        input.coverage.eligibleEntryCount += 2;
        const a = await writeTestBlob(fixture, Buffer.from("a"));
        const z = await writeTestBlob(fixture, Buffer.from("z"));
        const mutations = [
            { path: "z.txt", state: { state: "file", oid: z, executable: false } as const },
            { path: "a.txt", state: { state: "file", oid: a, executable: false } as const },
        ];

        const forward = await fixture.store.commitIncrementalSnapshot({ ...input, mutations });
        const reverse = await fixture.store.commitIncrementalSnapshot({
            ...input,
            mutations: [...mutations].reverse(),
        });

        expect(reverse.ref).toEqual(forward.ref);
        expect(reverse.coverage).toEqual(forward.coverage);
    });

    test("rejects an incremental reservation before writing any object or owner ref", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        vi.spyOn(fixture.store.quotaAccounting, "reserve").mockRejectedValue(
            new SnapshotQuotaExceededError({
                measuredBytes: WorkspaceCheckpointLimits.softQuotaBytes,
                requestedBytes: 1,
                maxBytes: WorkspaceCheckpointLimits.softQuotaBytes,
            })
        );
        fixture.git.calls.length = 0;

        await expect(fixture.store.commitIncrementalSnapshot({ ...input, mutations: [] })).rejects.toMatchObject({
            code: "quota_exceeded",
        });
        expect(
            fixture.git.calls.filter(
                (args) => args[0] === "hash-object" || args[0] === "mktree" || args[0] === "update-ref"
            )
        ).toEqual([]);
    });

    test("releases a reservation after a failed object write", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        const measuredBefore = fixture.store.quotaAccounting.measuredBytes;
        const originalRun = fixture.git.run.bind(fixture.git);
        vi.spyOn(fixture.git, "run").mockImplementation(async (args, options) => {
            if (args[0] === "mktree") throw new Error("simulated object write failure");
            return originalRun(args, options);
        });

        await expect(fixture.store.commitIncrementalSnapshot({ ...input, mutations: [] })).rejects.toThrow(
            /object write failure/i
        );
        expect(fixture.store.quotaAccounting.measuredBytes).toBe(measuredBefore);
    });

    test("maps ENOSPC after reservation and releases unused quota", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        const measuredBefore = fixture.store.quotaAccounting.measuredBytes;
        vi.spyOn(fixture.git, "run").mockImplementation(async (args, options) => {
            if (args[0] === "mktree") {
                throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
            }
            return WorkspaceGitRunner.prototype.run.call(fixture.git, args, options);
        });

        await expect(fixture.store.commitIncrementalSnapshot({ ...input, mutations: [] })).rejects.toMatchObject({
            code: "enospc",
        });
        expect(fixture.store.quotaAccounting.measuredBytes).toBe(measuredBefore);
    });

    test.each([
        ["ENOSPC", () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }), "enospc"],
        [
            "quota exceeded",
            () =>
                new SnapshotQuotaExceededError({
                    measuredBytes: WorkspaceCheckpointLimits.softQuotaBytes,
                    requestedBytes: 1,
                    maxBytes: WorkspaceCheckpointLimits.softQuotaBytes,
                }),
            "quota_exceeded",
        ],
    ])("preserves typed %s when incremental quota settlement also fails", async (_name, makePrimary, code) => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        const originalReserve = fixture.store.quotaAccounting.reserve.bind(fixture.store.quotaAccounting);
        vi.spyOn(fixture.store.quotaAccounting, "reserve").mockImplementation(async (reservationInput) => {
            const reservation = await originalReserve(reservationInput);
            vi.spyOn(reservation, "commit").mockRejectedValue(new Error("quota settlement failed"));
            vi.spyOn(reservation, "invalidate").mockResolvedValue(undefined);
            return reservation;
        });
        vi.spyOn(fixture.git, "run").mockImplementation(async (args, options) => {
            if (args[0] === "mktree") throw makePrimary();
            return WorkspaceGitRunner.prototype.run.call(fixture.git, args, options);
        });

        await expect(fixture.store.commitIncrementalSnapshot({ ...input, mutations: [] })).rejects.toMatchObject({
            cause: expect.any(AggregateError),
            code,
        });
    });

    test.each([
        [
            "ENOSPC",
            () => Object.assign(new Error("ENOSPC: no space left during settlement"), { code: "ENOSPC" }),
            "enospc",
        ],
        [
            "quota exceeded",
            () =>
                new SnapshotQuotaExceededError({
                    measuredBytes: WorkspaceCheckpointLimits.softQuotaBytes,
                    requestedBytes: 1,
                    maxBytes: WorkspaceCheckpointLimits.softQuotaBytes,
                }),
            "quota_exceeded",
        ],
    ])("maps typed %s from settlement when the primary error is generic", async (_name, makeSettlement, code) => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        const originalReserve = fixture.store.quotaAccounting.reserve.bind(fixture.store.quotaAccounting);
        vi.spyOn(fixture.store.quotaAccounting, "reserve").mockImplementation(async (reservationInput) => {
            const reservation = await originalReserve(reservationInput);
            vi.spyOn(reservation, "commit").mockRejectedValue(makeSettlement());
            vi.spyOn(reservation, "invalidate").mockResolvedValue(undefined);
            return reservation;
        });
        vi.spyOn(fixture.git, "run").mockImplementation(async (args, options) => {
            if (args[0] === "mktree") throw new Error("generic incremental write failure");
            return WorkspaceGitRunner.prototype.run.call(fixture.git, args, options);
        });

        await expect(fixture.store.commitIncrementalSnapshot({ ...input, mutations: [] })).rejects.toMatchObject({
            cause: expect.any(AggregateError),
            code,
        });
    });

    test("accounts a partial loose-object write when a later write fails", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        input.coverage.eligibleEntryCount -= 1;
        const measuredBefore = fixture.store.quotaAccounting.measuredBytes;
        const originalRun = fixture.git.run.bind(fixture.git);
        let treeWrites = 0;
        vi.spyOn(fixture.git, "run").mockImplementation(async (args, options) => {
            if (args[0] === "mktree" && ++treeWrites === 2) throw new Error("later object write failed");
            return originalRun(args, options);
        });

        await expect(
            fixture.store.commitIncrementalSnapshot({
                ...input,
                mutations: [{ path: "base.txt", state: { state: "absent" } }],
            })
        ).rejects.toThrow(/later object write failed/i);
        expect(fixture.store.quotaAccounting.measuredBytes).toBeGreaterThan(measuredBefore);
    });

    test("does not double charge loose objects that already exist on a deterministic retry", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        const first = await fixture.store.commitIncrementalSnapshot({ ...input, mutations: [] });
        const measuredAfterFirst = fixture.store.quotaAccounting.measuredBytes;
        fixture.git.calls.length = 0;

        const second = await fixture.store.commitIncrementalSnapshot({ ...input, mutations: [] });

        expect(second.ref).toEqual(first.ref);
        expect(fixture.store.quotaAccounting.measuredBytes).toBe(measuredAfterFirst);
        expect(fixture.git.calls.some((args) => args[0] === "count-objects" || args[0] === "rev-list")).toBe(false);
    });

    test("preserves a safe near-limit coverage count across offsetting changes", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "y-delete.txt"), "y");
        await writeFile(join(fixture.workspace, "z-delete.txt"), "z");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const nearLimitCoverage: WorkspaceSnapshotCoverage = {
            ...captured.coverage,
            eligibleEntryCount: Number.MAX_SAFE_INTEGER,
        };
        const base = await convertSnapshotToV2(fixture, captured.ref, nearLimitCoverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, nearLimitCoverage);
        const a = await writeTestBlob(fixture, Buffer.from("a"));
        const b = await writeTestBlob(fixture, Buffer.from("b"));

        const result = await fixture.store.commitIncrementalSnapshot({
            ...input,
            mutations: [
                { path: "a-create.txt", state: { state: "file", oid: a, executable: false } },
                { path: "b-create.txt", state: { state: "file", oid: b, executable: false } },
                { path: "y-delete.txt", state: { state: "absent" } },
                { path: "z-delete.txt", state: { state: "absent" } },
            ],
        });

        expect(result.coverage.eligibleEntryCount).toBe(Number.MAX_SAFE_INTEGER);
    });

    test("reports invalid incremental input as a rejected promise without acquiring the lock", async () => {
        const fixture = await makeStoreFixture();
        const runExclusive = vi.spyOn(fixture.store.mutationLock, "runExclusive");
        let result!: Promise<unknown>;

        expect(() => {
            result = fixture.store.commitIncrementalSnapshot({} as never);
        }).not.toThrow();
        expect(runExclusive).not.toHaveBeenCalled();
        await expect(result).rejects.toThrow(/invalid incremental snapshot commit input/i);
        expect(runExclusive).not.toHaveBeenCalled();
    });

    test("hard-blocks a v1 incremental base before writing or publishing objects", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const v1 = await convertSnapshotToV1(fixture, captured.ref, ["base.txt"]);
        await fixture.store.anchorSnapshot(v1);
        const scope = (
            JSON.parse((await fixture.store.readBlob(v1.scopeManifest)).toString("utf8")) as {
                scope: unknown;
            }
        ).scope;
        fixture.git.calls.length = 0;

        await expect(
            fixture.store.commitIncrementalSnapshot({
                base: v1,
                mutations: [{ path: "base.txt", state: { state: "absent" } }],
                scope: scope as never,
                coverage: withoutNewlyHashedBytes(captured.coverage),
                newlyHashedBytes: 0,
                profile: "terminal",
            })
        ).rejects.toThrow(/v2.*base|incremental.*v2/i);
        expect(
            fixture.git.calls.filter(
                (args) => args[0] === "hash-object" || args[0] === "mktree" || args[0] === "update-ref"
            )
        ).toEqual([]);
    });

    test("serializes incremental commits under the workspace lock", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        const release = makeDeferred();
        const held = fixture.store.withWorkspaceLock(() => release.promise);
        await fixture.store.mutationLock.waitUntilHeldForTest();
        let settled = false;

        const commit = fixture.store
            .commitIncrementalSnapshot({ ...input, mutations: [] })
            .finally(() => (settled = true));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        release.resolve();
        await held;
        await commit;
    });

    test("removes an owner ref when publication acknowledgement fails", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        input.coverage.eligibleEntryCount += 1;
        const oid = await writeTestBlob(fixture, Buffer.from("new"));
        const refsBefore = await fixture.store.listCrestRefs();
        const originalRun = fixture.git.run.bind(fixture.git);
        let failed = false;
        vi.spyOn(fixture.git, "run").mockImplementation(async (args, options) => {
            if (!failed && args[0] === "update-ref" && args[1]?.startsWith("refs/crest/snapshots/")) {
                failed = true;
                await originalRun(args, options);
                throw new Error("lost publication acknowledgement");
            }
            return await originalRun(args, options);
        });

        await expect(
            fixture.store.commitIncrementalSnapshot({
                ...input,
                mutations: [{ path: "new.txt", state: { state: "file", oid, executable: false } }],
            })
        ).rejects.toThrow(/publication acknowledgement/i);
        expect(await fixture.store.listCrestRefs()).toEqual(refsBefore);
    });

    test("preserves a deterministic pre-existing owner ref when repeat publication fails", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        input.coverage.eligibleEntryCount += 1;
        const oid = await writeTestBlob(fixture, Buffer.from("stable"));
        const commitInput = {
            ...input,
            mutations: [{ path: "stable.txt", state: { state: "file", oid, executable: false } as const }],
        };
        const first = await fixture.store.commitIncrementalSnapshot(commitInput);
        const originalRun = fixture.git.run.bind(fixture.git);
        let failed = false;
        vi.spyOn(fixture.git, "run").mockImplementation(async (args, options) => {
            if (!failed && args[0] === "update-ref" && args[1] === fixture.store.ownerRefName(first.ref.id)) {
                failed = true;
                await originalRun(args, options);
                throw new Error("lost repeat publication acknowledgement");
            }
            return await originalRun(args, options);
        });

        await expect(fixture.store.commitIncrementalSnapshot(commitInput)).rejects.toThrow(
            /repeat publication acknowledgement/i
        );
        await expect(fixture.store.verifyOwnedSnapshot(first.ref)).resolves.toBeUndefined();
    });

    test.each([
        { relativePath: "index", message: /index/i },
        { relativePath: "objects/info/alternates", message: /alternates/i },
    ])(
        "rejects a post-open $relativePath before incremental Git or quota access",
        async ({ relativePath, message }) => {
            const fixture = await makeStoreFixture();
            await writeFile(join(fixture.workspace, "base.txt"), "base");
            const captured = await fixture.store.capture({ profile: "terminal" });
            const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
            await fixture.store.anchorSnapshot(base);
            const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
            const refsBefore = await fixture.store.listCrestRefs();
            const shadowPath = join(fixture.storeRoot, ...relativePath.split("/"));
            await writeFile(shadowPath, relativePath === "index" ? "shadow index" : "/tmp/external-objects\n");
            fixture.git.calls.length = 0;

            await expect(fixture.store.commitIncrementalSnapshot({ ...input, mutations: [] })).rejects.toThrow(message);
            expect(fixture.git.calls).toEqual([]);
            await unlink(shadowPath);
            expect(await fixture.store.listCrestRefs()).toEqual(refsBefore);
        }
    );

    test("rejects incremental scope changes before writing objects", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        (input.scope as unknown as { policy: { maxentries: number } }).policy.maxentries += 1;
        const refsBefore = await fixture.store.listCrestRefs();
        fixture.git.calls.length = 0;

        await expect(fixture.store.commitIncrementalSnapshot({ ...input, mutations: [] })).rejects.toThrow(/scope/i);
        expect(
            fixture.git.calls.filter(
                (args) => args[0] === "hash-object" || args[0] === "mktree" || args[0] === "update-ref"
            )
        ).toEqual([]);
        expect(await fixture.store.listCrestRefs()).toEqual(refsBefore);
    });

    test.each(["complete", "count", "exclusions"] as const)(
        "rejects forged incremental coverage: %s",
        async (field) => {
            const fixture = await makeStoreFixture();
            await writeFile(join(fixture.workspace, "base.txt"), "base");
            const captured = await fixture.store.capture({ profile: "terminal" });
            const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
            await fixture.store.anchorSnapshot(base);
            const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
            if (field === "complete") input.coverage.complete = !input.coverage.complete;
            if (field === "count") input.coverage.eligibleEntryCount += 1;
            if (field === "exclusions") {
                input.coverage.complete = false;
                input.coverage.exclusions = [{ path: "forged.log", reason: "ignored" }];
            }
            const refsBefore = await fixture.store.listCrestRefs();

            await expect(fixture.store.commitIncrementalSnapshot({ ...input, mutations: [] })).rejects.toThrow(
                /coverage/i
            );
            expect(await fixture.store.listCrestRefs()).toEqual(refsBefore);
        }
    );

    test("derives coverage across create, delete, and excluded transitions", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, ".gitignore"), "ignored.log\n");
        await writeFile(join(fixture.workspace, "README.md"), "readme");
        await writeFile(join(fixture.workspace, "delete.txt"), "delete");
        await writeFile(join(fixture.workspace, "ignored.log"), "ignored");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        const created = await writeTestBlob(fixture, Buffer.from("created"));
        const included = await writeTestBlob(fixture, Buffer.from("included"));
        input.coverage = {
            complete: false,
            eligibleEntryCount: captured.coverage.eligibleEntryCount,
            exclusions: [{ path: "README.md", reason: "ignored" }],
        };

        const result = await fixture.store.commitIncrementalSnapshot({
            ...input,
            mutations: [
                { path: "created.txt", state: { state: "file", oid: created, executable: false } },
                { path: "delete.txt", state: { state: "absent" } },
                { path: "ignored.log", state: { state: "file", oid: included, executable: false } },
                { path: "README.md", state: { state: "excluded", reason: "ignored" } },
            ],
        });

        expect(withoutNewlyHashedBytes(result.coverage)).toEqual(input.coverage);
    });

    test("retains non-path and workspace-root coverage exclusions", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const retainedCoverage: WorkspaceSnapshotCoverage = {
            ...captured.coverage,
            complete: false,
            exclusions: [
                { pathBytesBase64: Buffer.from([0xff]).toString("base64"), reason: "non-utf8-path" },
                { scope: "workspace-root", reason: "capture-budget" },
            ],
        };
        const base = await convertSnapshotToV2(fixture, captured.ref, retainedCoverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, retainedCoverage);
        const created = await writeTestBlob(fixture, Buffer.from("created"));
        input.coverage.eligibleEntryCount += 1;

        const result = await fixture.store.commitIncrementalSnapshot({
            ...input,
            mutations: [{ path: "created.txt", state: { state: "file", oid: created, executable: false } }],
        });

        expect(result.coverage.complete).toBe(false);
        expect(result.coverage.eligibleEntryCount).toBe(retainedCoverage.eligibleEntryCount + 1);
        expect(result.coverage.exclusions).toHaveLength(2);
        expect(result.coverage.exclusions).toEqual(expect.arrayContaining(retainedCoverage.exclusions));
    });

    test("derives coverage for every descendant removed by a subtree deletion", async () => {
        const fixture = await makeStoreFixture();
        await mkdir(join(fixture.workspace, "dir"));
        await writeFile(join(fixture.workspace, "dir", "a.txt"), "a");
        await writeFile(join(fixture.workspace, "dir", "b.txt"), "b");
        await writeFile(join(fixture.workspace, "keep.txt"), "keep");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        input.coverage.eligibleEntryCount -= 2;

        const result = await fixture.store.commitIncrementalSnapshot({
            ...input,
            mutations: [{ path: "dir", state: { state: "absent" } }],
        });

        expect(result.coverage.eligibleEntryCount).toBe(captured.coverage.eligibleEntryCount - 2);
        await expect(fixture.store.readPathState(result.ref, "dir/a.txt")).resolves.toEqual({ state: "absent" });
        await expect(fixture.store.readPathState(result.ref, "dir/b.txt")).resolves.toEqual({ state: "absent" });
    });

    test("owns incremental commit input before waiting for the workspace lock", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "base.txt"), "base");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        await fixture.store.anchorSnapshot(base);
        const input = await readIncrementalCommitInput(fixture, base, captured.coverage);
        const oid = await writeTestBlob(fixture, Buffer.from("owned"));
        const state = { state: "file", oid, executable: false } as const;
        input.coverage.eligibleEntryCount += 1;
        const release = makeDeferred();
        const held = fixture.store.withWorkspaceLock(() => release.promise);
        await fixture.store.mutationLock.waitUntilHeldForTest();

        const commit = fixture.store.commitIncrementalSnapshot({
            ...input,
            mutations: [{ path: "owned.txt", state }],
        });
        (state as { oid: string }).oid = "f".repeat(40);
        (input.scope as unknown as { policy: { maxentries: number } }).policy.maxentries += 1;
        input.coverage.eligibleEntryCount += 1;
        release.resolve();
        await held;
        const result = await commit;

        await expect(fixture.store.readPathState(result.ref, "owned.txt")).resolves.toEqual({
            state: "file",
            oid,
            executable: false,
        });
    });

    test("verifies v2 state leaves with a bounded number of Git batch processes", async () => {
        const fixture = await makeStoreFixture();
        await Promise.all(
            Array.from({ length: 513 }, (_, index) =>
                writeFile(join(fixture.workspace, `file-${index.toString().padStart(3, "0")}.txt`), `${index}`)
            )
        );
        const captured = await fixture.store.capture({ profile: "terminal" });
        const v2 = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        fixture.git.calls.length = 0;

        await fixture.store.verify(v2);

        expect(fixture.git.calls.filter((args) => args[0] === "cat-file" && args[1] === "--batch")).toHaveLength(2);
    });

    test("requires exact descriptor entries for each manifest version", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "README.md"), "descriptor");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const v2 = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);
        const v1 = await convertSnapshotToV1(fixture, captured.ref, ["README.md"]);
        const v2Manifest = JSON.parse((await fixture.store.readBlob(v2.scopeManifest)).toString("utf8")) as {
            statetree: string;
        };
        const emptyStateTree = await writeTestStateTree(fixture, new Map());
        const extraBlob = await writeTestBlob(fixture, Buffer.from("extra"));
        const missing = await writeTestDescriptor(fixture, v2.tree, v2.scopeManifest);
        const mismatched = await writeTestV2Descriptor(fixture, v2.tree, v2.scopeManifest, emptyStateTree);
        const extra = await writeTestV2Descriptor(fixture, v2.tree, v2.scopeManifest, v2Manifest.statetree, [
            { name: "unexpected", mode: "100644", type: "blob", oid: extraBlob },
        ]);
        const v1WithState = await writeTestV2Descriptor(fixture, v1.tree, v1.scopeManifest, emptyStateTree);

        for (const snapshot of [
            { ...v2, id: missing },
            { ...v2, id: mismatched },
            { ...v2, id: extra },
            { ...v1, id: v1WithState },
        ]) {
            await expect(fixture.store.verify(snapshot)).rejects.toMatchObject({ code: "corrupt_snapshot" });
        }
    });

    test("classifies a corrupt v2 state tree discovered by readPathState as corrupt_snapshot", async () => {
        const fixture = await makeStoreFixture();
        const captured = await fixture.store.capture({ profile: "terminal" });
        const notATree = await writeTestBlob(fixture, Buffer.from("not a tree"));
        const stateTree = await writeRawTree(
            fixture,
            Buffer.concat([Buffer.from("40000 dir\0"), Buffer.from(notATree, "hex")])
        );
        const invalid = await makeV2SnapshotWithStateTree(fixture, captured.ref, captured.coverage, stateTree);

        await expect(fixture.store.readPathState(invalid, "dir/file.txt")).rejects.toMatchObject({
            code: "corrupt_snapshot",
        });
    });

    test("classifies a corrupt v2 state blob discovered by diff as corrupt_snapshot", async () => {
        const fixture = await makeStoreFixture();
        const captured = await fixture.store.capture({ profile: "terminal" });
        const invalidState = await writeTestBlob(
            fixture,
            canonicalTestJson({ schemaversion: 2, state: { state: "absent" } })
        );
        const invalidTree = await writeTestStateTreeNode(fixture, {
            children: new Map(),
            leaves: new Map([["README.md", invalidState]]),
        });
        const invalid = await makeV2SnapshotWithStateTree(fixture, captured.ref, captured.coverage, invalidTree);
        const valid = await convertSnapshotToV2(fixture, captured.ref, captured.coverage);

        await expect(fixture.store.diff(invalid, valid)).rejects.toMatchObject({ code: "corrupt_snapshot" });
    });

    test("does not relabel an existing typed snapshot-store failure as corruption", async () => {
        const fixture = await makeStoreFixture();
        await writeFile(join(fixture.workspace, "README.md"), "typed failure");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const originalRun = fixture.git.run.bind(fixture.git);
        vi.spyOn(fixture.git, "run").mockImplementation(async (args, options) => {
            if (args[0] === "cat-file" && args[1] === "tree" && args[2] === captured.ref.id) {
                throw new WorkspaceSnapshotStoreError("capture_timeout", "typed failure");
            }
            return await originalRun(args, options);
        });

        await expect(fixture.store.readPathState(captured.ref, "README.md")).rejects.toMatchObject({
            code: "capture_timeout",
        });
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
        ).toHaveLength(2);
        expect(fixture.git.calls.length).toBeLessThanOrEqual(24);
        fixture.git.calls.length = 0;
        const verifyStarted = Date.now();

        await fixture.store.verify(snapshot.ref);

        expect(Date.now() - verifyStarted).toBeLessThan(30_000);
        expect(fixture.git.calls.filter((args) => args[0] === "cat-file" && args[1] === "--batch")).toHaveLength(
            Math.ceil(fileCount / 512)
        );
        expect(fixture.git.calls.filter((args) => args[0] === "cat-file").length).toBeLessThanOrEqual(26);
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
        const secondName = `refs/crest/pending/${fixture.identity.workspaceIdentity}/second`;
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

async function convertSnapshotToV2(
    fixture: Awaited<ReturnType<typeof makeStoreFixture>>,
    source: WorkspaceSnapshotRefV1,
    coverage: WorkspaceSnapshotCoverage
): Promise<WorkspaceSnapshotRefV1> {
    const manifest = JSON.parse((await fixture.store.readBlob(source.scopeManifest)).toString("utf8")) as {
        schemaversion: number;
        entries?: Array<{ path: string; state: CapturedPathStateV1 }>;
        statetree?: string;
    };
    if (manifest.schemaversion === 2 && manifest.statetree) {
        return await makeV2SnapshotWithStateTree(fixture, source, coverage, manifest.statetree);
    }
    if (!manifest.entries) throw new Error("Test snapshot manifest has no inline entries");
    const stateTree = await writeTestStateTree(
        fixture,
        new Map(manifest.entries.map((entry) => [entry.path, entry.state]))
    );
    return await makeV2SnapshotWithStateTree(fixture, source, coverage, stateTree);
}

async function convertSnapshotToV1(
    fixture: Awaited<ReturnType<typeof makeStoreFixture>>,
    source: WorkspaceSnapshotRefV1,
    paths: readonly string[]
): Promise<WorkspaceSnapshotRefV1> {
    const sourceManifest = JSON.parse((await fixture.store.readBlob(source.scopeManifest)).toString("utf8")) as {
        scope: unknown;
    };
    const manifestOid = await writeTestBlob(
        fixture,
        canonicalTestJson({
            schemaversion: 1,
            workspaceidentity: source.workspaceIdentity,
            workspaceincarnation: source.workspaceIncarnation,
            scope: sourceManifest.scope,
            entries: await Promise.all(
                paths.map(async (path) => ({ path, state: await fixture.store.readPathState(source, path) }))
            ),
        })
    );
    return {
        ...source,
        id: await writeTestDescriptor(fixture, source.tree, manifestOid),
        scopeManifest: manifestOid,
    };
}

async function readIncrementalCommitInput(
    fixture: Awaited<ReturnType<typeof makeStoreFixture>>,
    base: WorkspaceSnapshotRefV1,
    coverage: WorkspaceSnapshotCoverage
) {
    const manifest = JSON.parse((await fixture.store.readBlob(base.scopeManifest)).toString("utf8")) as {
        scope: unknown;
    };
    return {
        base,
        scope: manifest.scope as never,
        coverage: withoutNewlyHashedBytes(coverage),
        newlyHashedBytes: 5,
        profile: "terminal" as const,
    };
}

function withoutNewlyHashedBytes(
    coverage: WorkspaceSnapshotCoverage
): Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes"> {
    return {
        complete: coverage.complete,
        eligibleEntryCount: coverage.eligibleEntryCount,
        exclusions: coverage.exclusions,
    };
}

async function readChildTreeOid(
    fixture: Awaited<ReturnType<typeof makeStoreFixture>>,
    treeOid: string,
    name: string
): Promise<string> {
    const tree = await fixture.git.run(["cat-file", "tree", treeOid], {
        gitDir: fixture.storeRoot,
        timeoutMs: 5_000,
    });
    const hashBytes = treeOid.length / 2;
    let offset = 0;
    while (offset < tree.stdout.length) {
        const space = tree.stdout.indexOf(0x20, offset);
        const nul = tree.stdout.indexOf(0, space + 1);
        const mode = tree.stdout.subarray(offset, space).toString("ascii");
        const entryName = tree.stdout.subarray(space + 1, nul).toString("utf8");
        if (entryName === name && mode === "40000") {
            return tree.stdout.subarray(nul + 1, nul + 1 + hashBytes).toString("hex");
        }
        offset = nul + 1 + hashBytes;
    }
    throw new Error(`Missing test child tree: ${name}`);
}

async function makeV2SnapshotWithStateTree(
    fixture: Awaited<ReturnType<typeof makeStoreFixture>>,
    source: WorkspaceSnapshotRefV1,
    coverage: WorkspaceSnapshotCoverage,
    stateTree: string
): Promise<WorkspaceSnapshotRefV1> {
    const v1 = JSON.parse((await fixture.store.readBlob(source.scopeManifest)).toString("utf8")) as {
        scope: unknown;
    };
    const manifestOid = await writeTestBlob(
        fixture,
        canonicalTestJson({
            schemaversion: 2,
            workspaceidentity: source.workspaceIdentity,
            workspaceincarnation: source.workspaceIncarnation,
            scope: v1.scope,
            coverage: {
                complete: coverage.complete,
                eligibleentrycount: coverage.eligibleEntryCount,
                exclusions: coverage.exclusions,
            },
            statetree: stateTree,
        })
    );
    return {
        ...source,
        id: await writeTestV2Descriptor(fixture, source.tree, manifestOid, stateTree),
        scopeManifest: manifestOid,
    };
}

async function writeTestStateTree(
    fixture: Awaited<ReturnType<typeof makeStoreFixture>>,
    states: ReadonlyMap<string, CapturedPathStateV1>
): Promise<string> {
    const root = makeStateTreeNode();
    const items = [...states];
    const staging = await temporaryDirectory();
    const stagingNames = items.map((_, index) => `${index}.json`);
    await Promise.all(
        items.map(([, state], index) =>
            writeFile(join(staging, stagingNames[index]!), canonicalTestJson({ schemaversion: 1, state }))
        )
    );
    const stateOids =
        items.length === 0
            ? []
            : stripTestLines(
                  (
                      await fixture.git.run(["hash-object", "-w", "--stdin-paths", "--no-filters"], {
                          cwd: staging,
                          gitDir: fixture.storeRoot,
                          stdin: Buffer.from(`${stagingNames.join("\n")}\n`),
                          timeoutMs: 30_000,
                      })
                  ).stdout
              );
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const [path] = items[itemIndex]!;
        const segments = path.split("/");
        let node = root;
        for (const segment of segments.slice(0, -1)) {
            node.children.set(segment, node.children.get(segment) ?? makeStateTreeNode());
            node = node.children.get(segment)!;
        }
        node.leaves.set(segments.at(-1)!, stateOids[itemIndex]!);
    }
    return await writeTestStateTreeNode(fixture, root);
}

interface TestStateTreeNode {
    children: Map<string, TestStateTreeNode>;
    leaves: Map<string, string>;
}

function makeStateTreeNode(): TestStateTreeNode {
    return { children: new Map(), leaves: new Map() };
}

async function writeTestStateTreeNode(
    fixture: Awaited<ReturnType<typeof makeStoreFixture>>,
    node: TestStateTreeNode
): Promise<string> {
    const entries: Array<{ name: string; mode: string; type: string; oid: string }> = [];
    for (const [name, child] of node.children) {
        entries.push({ name, mode: "040000", type: "tree", oid: await writeTestStateTreeNode(fixture, child) });
    }
    for (const [name, oid] of node.leaves) entries.push({ name, mode: "100644", type: "blob", oid });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    const result = await fixture.git.run(["mktree", "-z"], {
        gitDir: fixture.storeRoot,
        stdin: Buffer.concat(
            entries.map((entry) => Buffer.from(`${entry.mode} ${entry.type} ${entry.oid}\t${entry.name}\0`))
        ),
        timeoutMs: 5_000,
    });
    return stripTestOid(result.stdout);
}

function canonicalTestJson(value: unknown): Buffer {
    return Buffer.from(JSON.stringify(sortTestJsonValue(value)));
}

function sortTestJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortTestJsonValue);
    if (typeof value !== "object" || value == null) return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, item]) => [key.toLowerCase(), sortTestJsonValue(item)])
    );
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

async function writeTestV2Descriptor(
    fixture: Awaited<ReturnType<typeof makeStoreFixture>>,
    treeOid: string,
    manifestOid: string,
    stateTreeOid: string,
    extraEntries: Array<{ name: string; mode: string; type: string; oid: string }> = []
): Promise<string> {
    const entries = [
        { name: "scope-manifest", mode: "100644", type: "blob", oid: manifestOid },
        { name: "state", mode: "040000", type: "tree", oid: stateTreeOid },
        { name: "workspace", mode: "040000", type: "tree", oid: treeOid },
        ...extraEntries,
    ].sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    const result = await fixture.git.run(["mktree", "-z"], {
        gitDir: fixture.storeRoot,
        stdin: Buffer.concat(
            entries.map((entry) => Buffer.from(`${entry.mode} ${entry.type} ${entry.oid}\t${entry.name}\0`))
        ),
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

function stripTestLines(value: Buffer): string[] {
    return value.toString("ascii").trimEnd().split("\n");
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
