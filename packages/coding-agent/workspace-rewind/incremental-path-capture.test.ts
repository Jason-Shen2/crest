// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { WorkspaceGitRunner, WorkspaceGitRunnerError } from "./git-runner";
import {
    IncrementalPathCapture,
    materializeIncrementalCapturedBatch,
    type IncrementalPathCaptureResult,
} from "./incremental-path-capture";
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
        vi.useRealTimers();
        await Promise.all(capturesForCleanup.splice(0).map((capture) => capture.dispose()));
        vi.doUnmock("node:child_process");
        vi.doUnmock("node:fs/promises");
        vi.doUnmock("./anchored-reader");
        vi.doUnmock("./workspace-scope");
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

    test("does not register an empty batch after caller abort or an expired deadline", async () => {
        const fixture = await makeCaptureFixture(root, workspace, git);
        const controller = new AbortController();
        const abortReason = new Error("caller aborted empty capture");
        controller.abort(abortReason);

        await expect(fixture.capture.capture([], controller.signal)).rejects.toBe(abortReason);
        expect(fixture.capture.pendingBatches.size).toBe(0);

        const expired = new IncrementalPathCapture({ ...fixture.options, timeoutMs: 0 });
        capturesForCleanup.push(expired);
        await expect(expired.capture([])).rejects.toMatchObject({ code: "timeout" });
        expect(expired.pendingBatches.size).toBe(0);
    });

    test("allows a per-call terminal deadline to exceed a pre-turn constructor deadline", async () => {
        vi.useFakeTimers();
        const fixture = await makeCaptureFixture(root, workspace, git);
        const capture = new IncrementalPathCapture({ ...fixture.options, timeoutMs: 5_000 });
        capturesForCleanup.push(capture);
        vi.spyOn(capture, "captureActive").mockImplementation(
            async (_paths, signal) =>
                await new Promise<IncrementalPathCaptureResult>((resolve, reject) => {
                    const timer = setTimeout(
                        () => resolve({ status: "captured", mutations: [], newlyHashedBytes: 0 }),
                        6_000
                    );
                    signal.addEventListener(
                        "abort",
                        () => {
                            clearTimeout(timer);
                            reject(signal.reason);
                        },
                        { once: true }
                    );
                })
        );

        const pending = capture.capture([], undefined, 30_000);
        const assertion = expect(pending).resolves.toEqual({ status: "captured", mutations: [], newlyHashedBytes: 0 });
        await vi.advanceTimersByTimeAsync(6_000);

        await assertion;
    });

    test("waits for an active consumer before dispose can clean its staging", async () => {
        await writeFile(join(workspace, "README.md"), "content");
        const fixture = await makeCaptureFixture(root, workspace, git);
        const result = await fixture.capture.capture(["README.md"]);
        let releaseConsumer!: () => void;
        let consumerStarted!: () => void;
        const consumerGate = new Promise<void>((resolve) => {
            releaseConsumer = resolve;
        });
        const started = new Promise<void>((resolve) => {
            consumerStarted = resolve;
        });
        const consuming = fixture.capture.consumeCaptured(result, async (batch) => {
            consumerStarted();
            await consumerGate;
            await materializeIncrementalCapturedBatch(batch, {
                storeRoot: fixture.store.storeRoot,
                writeBlob: async (bytes) => gitBlobOid(bytes),
            });
        });
        await started;
        let disposeSettled = false;
        const disposing = fixture.capture.dispose().finally(() => {
            disposeSettled = true;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        const settledBeforeConsumer = disposeSettled;

        releaseConsumer();
        const outcomes = await Promise.allSettled([consuming, disposing]);

        expect(settledBeforeConsumer).toBe(false);
        expect(outcomes).toEqual([
            expect.objectContaining({ status: "fulfilled" }),
            expect.objectContaining({ status: "fulfilled" }),
        ]);
    });

    test("rejects discard while the batch consumer owns the terminal operation", async () => {
        await writeFile(join(workspace, "README.md"), "content");
        const fixture = await makeCaptureFixture(root, workspace, git);
        const result = await fixture.capture.capture(["README.md"]);
        let releaseConsumer!: () => void;
        let consumerStarted!: () => void;
        const consumerGate = new Promise<void>((resolve) => {
            releaseConsumer = resolve;
        });
        const started = new Promise<void>((resolve) => {
            consumerStarted = resolve;
        });
        const consuming = fixture.capture.consumeCaptured(result, async () => {
            consumerStarted();
            await consumerGate;
        });
        await started;

        const discardOutcome = await fixture.capture.discardCaptured(result).then(
            () => ({ status: "fulfilled" as const }),
            (error) => ({ status: "rejected" as const, error })
        );
        releaseConsumer();
        await consuming.catch(() => undefined);

        expect(discardOutcome.status).toBe("rejected");
        if (discardOutcome.status === "rejected") {
            expect(discardOutcome.error).toMatchObject({ message: expect.stringMatching(/operation.*active/i) });
        }
    });

    test("allows only one concurrent discard to own a captured batch", async () => {
        await writeFile(join(workspace, "README.md"), "content");
        const fixture = await makeCaptureFixture(root, workspace, git);
        const result = await fixture.capture.capture(["README.md"]);

        const outcomes = await Promise.allSettled([
            fixture.capture.discardCaptured(result),
            fixture.capture.discardCaptured(result),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
            expect.objectContaining({
                reason: expect.objectContaining({ message: expect.stringMatching(/operation.*active/i) }),
            }),
        ]);
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

    test("dispose blocks new captures, aborts and awaits in-flight capture, and prevents late registration", async () => {
        const fixture = await makeCaptureFixture(root, workspace, git);
        let releaseScope!: () => void;
        let scopeStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            scopeStarted = resolve;
        });
        vi.doMock("./workspace-scope", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-scope")>();
            return {
                ...actual,
                classifyIncrementalWorkspacePaths: async (input: { signal?: AbortSignal }) => {
                    scopeStarted();
                    await new Promise<void>((resolve, reject) => {
                        releaseScope = resolve;
                        input.signal?.addEventListener("abort", () => reject(new Error("capture aborted by dispose")), {
                            once: true,
                        });
                    });
                    return { status: "captured" as const, entries: [], pathKinds: [] };
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./incremental-path-capture");
        const isolatedGit = new (await import("./git-runner")).WorkspaceGitRunner();
        const capture = new isolated.IncrementalPathCapture({ ...fixture.options, git: isolatedGit });
        let captureSettled = false;
        let captureOutcome: "resolved" | "rejected" | undefined;
        const pending = capture
            .capture(["README.md"])
            .then(
                () => {
                    captureOutcome = "resolved";
                },
                () => {
                    captureOutcome = "rejected";
                }
            )
            .finally(() => {
                captureSettled = true;
            });
        await started;

        await capture.dispose();
        const disposeReturnedBeforeCapture = !captureSettled;
        releaseScope();
        await pending;

        expect(disposeReturnedBeforeCapture).toBe(false);
        expect(captureOutcome).toBe("rejected");
        expect(capture.pendingBatches.size).toBe(0);
        await expect(capture.capture([])).rejects.toThrow(/disposed/i);
    });

    test("preserves consumer and cleanup failures and allows cleanup retry without re-consuming", async () => {
        await writeFile(join(workspace, "README.md"), "before");
        const fixture = await makeCaptureFixture(root, workspace, git);
        await writeFile(join(workspace, "README.md"), "after");
        const cleanupError = new Error("staging cleanup failed");
        const consumerError = new Error("consumer failed");
        let stagingRoot: string | undefined;
        let cleanupFailures = 1;
        vi.doMock("node:fs/promises", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:fs/promises")>();
            return {
                ...actual,
                mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
                    const result = await actual.mkdtemp(...args);
                    if (String(args[0]).includes("crest-incremental-path-capture-")) stagingRoot = result;
                    return result;
                },
                rm: async (...args: Parameters<typeof actual.rm>) => {
                    if (String(args[0]) === stagingRoot && cleanupFailures > 0) {
                        cleanupFailures -= 1;
                        throw cleanupError;
                    }
                    return actual.rm(...args);
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./incremental-path-capture");
        const isolatedGit = new (await import("./git-runner")).WorkspaceGitRunner();
        const capture = new isolated.IncrementalPathCapture({ ...fixture.options, git: isolatedGit });
        const result = await capture.capture(["README.md"]);
        let failure: unknown;
        try {
            await capture.consumeCaptured(result, async () => {
                throw consumerError;
            });
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([consumerError, cleanupError]);
        await expect(stat(stagingRoot!)).resolves.toBeDefined();
        await expect(capture.consumeCaptured(result, async () => undefined)).rejects.toThrow(/consumed/i);
        await expect(capture.discardCaptured(result)).resolves.toBeUndefined();
        await expect(stat(stagingRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("retains cleanup ownership when dispose fails and retries it on the next dispose", async () => {
        await writeFile(join(workspace, "README.md"), "before");
        const fixture = await makeCaptureFixture(root, workspace, git);
        await writeFile(join(workspace, "README.md"), "after");
        const cleanupError = new Error("dispose cleanup failed");
        let stagingRoot: string | undefined;
        let cleanupFailures = 1;
        vi.doMock("node:fs/promises", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:fs/promises")>();
            return {
                ...actual,
                mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
                    const result = await actual.mkdtemp(...args);
                    if (String(args[0]).includes("crest-incremental-path-capture-")) stagingRoot = result;
                    return result;
                },
                rm: async (...args: Parameters<typeof actual.rm>) => {
                    if (String(args[0]) === stagingRoot && cleanupFailures > 0) {
                        cleanupFailures -= 1;
                        throw cleanupError;
                    }
                    return actual.rm(...args);
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./incremental-path-capture");
        const isolatedGit = new (await import("./git-runner")).WorkspaceGitRunner();
        const capture = new isolated.IncrementalPathCapture({ ...fixture.options, git: isolatedGit });
        await capture.capture(["README.md"]);

        await expect(capture.dispose()).rejects.toBeInstanceOf(AggregateError);
        expect(capture.pendingBatches.size).toBe(1);
        await expect(stat(stagingRoot!)).resolves.toBeDefined();
        await expect(capture.dispose()).resolves.toBeUndefined();
        expect(capture.pendingBatches.size).toBe(0);
        await expect(stat(stagingRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("allows discard to retry retained batch cleanup after dispose fails", async () => {
        await writeFile(join(workspace, "README.md"), "before");
        const fixture = await makeCaptureFixture(root, workspace, git);
        await writeFile(join(workspace, "README.md"), "after");
        let stagingRoot: string | undefined;
        let cleanupFailures = 1;
        vi.doMock("node:fs/promises", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:fs/promises")>();
            return {
                ...actual,
                mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
                    const result = await actual.mkdtemp(...args);
                    if (String(args[0]).includes("crest-incremental-path-capture-")) stagingRoot = result;
                    return result;
                },
                rm: async (...args: Parameters<typeof actual.rm>) => {
                    if (String(args[0]) === stagingRoot && cleanupFailures > 0) {
                        cleanupFailures -= 1;
                        throw new Error("dispose cleanup failed");
                    }
                    return actual.rm(...args);
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./incremental-path-capture");
        const isolatedGit = new (await import("./git-runner")).WorkspaceGitRunner();
        const capture = new isolated.IncrementalPathCapture({ ...fixture.options, git: isolatedGit });
        const result = await capture.capture(["README.md"]);

        await expect(capture.dispose()).rejects.toBeInstanceOf(AggregateError);
        await expect(capture.discardCaptured(result)).resolves.toBeUndefined();
        await expect(stat(stagingRoot!)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(capture.consumeCaptured(result, async () => undefined)).rejects.toThrow(/pending|discarded/i);
        await expect(capture.dispose()).resolves.toBeUndefined();
    });

    test("retains in-flight staging cleanup ownership across a failed dispose", async () => {
        await writeFile(join(workspace, "README.md"), "before");
        const fixture = await makeCaptureFixture(root, workspace, git);
        await writeFile(join(workspace, "README.md"), "after");
        let stagingRoot: string | undefined;
        let cleanupFailures = 2;
        vi.doMock("./anchored-reader", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./anchored-reader")>();
            return {
                ...actual,
                runAnchoredReaderBatch: async (input: Parameters<typeof actual.runAnchoredReaderBatch>[0]) =>
                    await new Promise((_, reject) => {
                        input.signal.addEventListener(
                            "abort",
                            () => reject(new actual.AnchoredReaderError("aborted", "reader aborted")),
                            { once: true }
                        );
                    }),
            };
        });
        vi.doMock("node:fs/promises", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:fs/promises")>();
            return {
                ...actual,
                mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
                    const result = await actual.mkdtemp(...args);
                    if (String(args[0]).includes("crest-incremental-path-capture-")) stagingRoot = result;
                    return result;
                },
                rm: async (...args: Parameters<typeof actual.rm>) => {
                    if (String(args[0]) === stagingRoot && cleanupFailures > 0) {
                        cleanupFailures -= 1;
                        throw new Error("in-flight staging cleanup failed");
                    }
                    return actual.rm(...args);
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./incremental-path-capture");
        const isolatedGit = new (await import("./git-runner")).WorkspaceGitRunner();
        const capture = new isolated.IncrementalPathCapture({ ...fixture.options, git: isolatedGit });
        const pending = capture.capture(["README.md"]).catch(() => undefined);
        await vi.waitFor(() => expect(stagingRoot).toBeDefined());

        await expect(capture.dispose()).rejects.toBeInstanceOf(AggregateError);
        await pending;
        await expect(stat(stagingRoot!)).resolves.toBeDefined();
        await expect(capture.dispose()).resolves.toBeUndefined();
        await expect(stat(stagingRoot!)).rejects.toMatchObject({ code: "ENOENT" });
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

    test.runIf(process.platform !== "win32")("fails closed before creating private staging on Windows", async () => {
        await writeFile(join(workspace, "README.md"), "before");
        const fixture = await makeCaptureFixture(root, workspace, git);
        await writeFile(join(workspace, "README.md"), "after");
        const [parentIdentity, entryIdentity] = await Promise.all([
            lstat(workspace, { bigint: true }),
            lstat(join(workspace, "README.md"), { bigint: true }),
        ]);
        let readerCalls = 0;
        vi.doMock("./anchored-reader", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./anchored-reader")>();
            return {
                ...actual,
                runAnchoredReaderBatch: async () => {
                    readerCalls += 1;
                    throw new Error("reader should not start on Windows");
                },
            };
        });
        vi.doMock("./workspace-scope", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-scope")>();
            return {
                ...actual,
                classifyIncrementalWorkspacePaths: async () => ({
                    status: "captured" as const,
                    entries: [
                        {
                            pathBytes: Buffer.from("README.md"),
                            path: "README.md",
                            kind: "file" as const,
                            tracked: false,
                            executable: false,
                            size: Number(entryIdentity.size),
                            parentIdentity: {
                                dev: parentIdentity.dev,
                                ino: parentIdentity.ino,
                                birthtimeNs: parentIdentity.birthtimeNs,
                            },
                            entryIdentity: {
                                dev: entryIdentity.dev,
                                ino: entryIdentity.ino,
                                birthtimeNs: entryIdentity.birthtimeNs,
                                mode: entryIdentity.mode,
                                nlink: entryIdentity.nlink,
                                size: entryIdentity.size,
                                mtimeNs: entryIdentity.mtimeNs,
                                ctimeNs: entryIdentity.ctimeNs,
                            },
                        },
                    ],
                    pathKinds: [{ path: "README.md", kind: "leaf" as const }],
                }),
            };
        });
        vi.resetModules();
        const isolated = await import("./incremental-path-capture");
        const isolatedGit = new (await import("./git-runner")).WorkspaceGitRunner();
        const capture = new isolated.IncrementalPathCapture({ ...fixture.options, git: isolatedGit });
        const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        try {
            await expect(capture.capture(["README.md"])).resolves.toEqual({
                status: "reconcile",
                reason: "unsafe-evidence",
            });
            expect(readerCalls).toBe(0);
        } finally {
            platform.mockRestore();
        }
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

    test("propagates an anchored-reader abort and removes private staging", async () => {
        const firstParent = join(workspace, "first");
        const secondParent = join(workspace, "second");
        await mkdir(firstParent);
        await mkdir(secondParent);
        await writeFile(join(firstParent, "file.txt"), "before");
        await writeFile(join(secondParent, "file.txt"), "before");
        const fixture = await makeCaptureFixture(root, workspace, git);
        await writeFile(join(firstParent, "file.txt"), "after");
        await writeFile(join(secondParent, "file.txt"), "after");
        let stagingRoot: string | undefined;
        vi.doMock("./anchored-reader", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./anchored-reader")>();
            return {
                ...actual,
                runAnchoredReaderBatch: async (
                    input: Parameters<typeof actual.runAnchoredReaderBatch>[0]
                ): Promise<never> =>
                    await new Promise((_, reject) => {
                        input.signal.addEventListener("abort", () => {
                            reject(new actual.AnchoredReaderError("aborted", "Anchored reader aborted"));
                        });
                    }),
            };
        });
        vi.doMock("node:fs/promises", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:fs/promises")>();
            return {
                ...actual,
                mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
                    const result = await actual.mkdtemp(...args);
                    if (String(args[0]).includes("crest-incremental-path-capture-")) stagingRoot = result;
                    return result;
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./incremental-path-capture");
        const isolatedGit = new (await import("./git-runner")).WorkspaceGitRunner();
        const capture = new isolated.IncrementalPathCapture({ ...fixture.options, git: isolatedGit });
        const controller = new AbortController();
        const pending = capture.capture(["first/file.txt", "second/file.txt"], controller.signal);
        await vi.waitFor(() => expect(stagingRoot).toBeDefined());

        controller.abort();

        await expect(pending).rejects.toMatchObject({ code: "aborted" });
        await expect(stat(stagingRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("starts one capture deadline before scope and index work", async () => {
        const fixture = await makeCaptureFixture(root, workspace, git);
        let observedAbort = false;
        vi.doMock("./workspace-scope", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-scope")>();
            return {
                ...actual,
                classifyIncrementalWorkspacePaths: async (input: { signal?: AbortSignal }) =>
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(
                            () => resolve({ status: "captured" as const, entries: [], pathKinds: [] }),
                            150
                        );
                        input.signal?.addEventListener(
                            "abort",
                            () => {
                                observedAbort = true;
                                clearTimeout(timer);
                                reject(input.signal!.reason);
                            },
                            { once: true }
                        );
                    }),
            };
        });
        vi.resetModules();
        const isolated = await import("./incremental-path-capture");
        const isolatedGit = new (await import("./git-runner")).WorkspaceGitRunner();
        const capture = new isolated.IncrementalPathCapture({
            ...fixture.options,
            git: isolatedGit,
            timeoutMs: 30,
        });
        const outcome = await capture.capture(["README.md"]).then(
            (result) => ({ status: "resolved" as const, result }),
            (error) => ({ status: "rejected" as const, error })
        );
        if (outcome.status === "resolved") await capture.discardCaptured(outcome.result);

        expect(outcome.status).toBe("rejected");
        expect(observedAbort).toBe(true);
        if (outcome.status === "rejected") expect(outcome.error).toMatchObject({ code: "timeout" });
    });

    test.runIf(process.platform !== "win32")(
        "maps an internal deadline through a real Git scope abort while preserving caller aborts",
        async () => {
            const repository = join(root, "repository");
            await mkdir(repository);
            await execFileAsync("git", ["init"], { cwd: repository });
            await writeFile(join(repository, "README.md"), "content");
            const fixture = await makeCaptureFixture(root, repository, git);
            const blockingGit = join(root, "blocking-git");
            await writeFile(
                blockingGit,
                `#!/usr/bin/env node
setTimeout(() => process.stdout.write("true\\n"), 500);
`
            );
            await chmod(blockingGit, 0o755);
            const runner = new WorkspaceGitRunner(blockingGit);
            const timed = new IncrementalPathCapture({ ...fixture.options, git: runner, timeoutMs: 30 });

            await expect(timed.capture(["README.md"])).rejects.toMatchObject({ code: "timeout" });

            const caller = new AbortController();
            const aborted = new IncrementalPathCapture({ ...fixture.options, git: runner, timeoutMs: 1_000 });
            const pending = aborted.capture(["README.md"], caller.signal);
            caller.abort();

            await expect(pending).rejects.toMatchObject({ code: "aborted" });
            await Promise.all([timed.dispose(), aborted.dispose()]);
        }
    );

    test("applies the same capture deadline to base-kind work", async () => {
        const fixture = await makeCaptureFixture(root, workspace, git);
        vi.doMock("./workspace-scope", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-scope")>();
            return {
                ...actual,
                classifyIncrementalWorkspacePaths: async () => ({
                    status: "captured" as const,
                    entries: [
                        {
                            pathBytes: Buffer.from("README.md"),
                            path: "README.md",
                            kind: "absent" as const,
                            tracked: false,
                        },
                    ],
                    pathKinds: [{ path: "README.md", kind: "absent" as const }],
                }),
            };
        });
        vi.resetModules();
        const isolated = await import("./incremental-path-capture");
        const isolatedGit = new (await import("./git-runner")).WorkspaceGitRunner();
        let activeBaseReads = 0;
        let receivedSignal: AbortSignal | undefined;
        const capture = new isolated.IncrementalPathCapture({
            ...fixture.options,
            git: isolatedGit,
            timeoutMs: 30,
            base: {
                readNodeKind: async (_path: string, signal?: AbortSignal) => {
                    activeBaseReads += 1;
                    receivedSignal = signal;
                    try {
                        await new Promise<void>((resolve, reject) => {
                            const timer = setTimeout(resolve, 150);
                            signal?.addEventListener(
                                "abort",
                                () => {
                                    clearTimeout(timer);
                                    reject(signal.reason);
                                },
                                { once: true }
                            );
                        });
                        return "absent" as const;
                    } finally {
                        activeBaseReads -= 1;
                    }
                },
            },
        });
        const outcome = await capture.capture(["README.md"]).then(
            (result) => ({ status: "resolved" as const, result }),
            (error) => ({ status: "rejected" as const, error })
        );
        const activeAtSettlement = activeBaseReads;
        if (outcome.status === "resolved") await capture.discardCaptured(outcome.result);
        await vi.waitFor(() => expect(activeBaseReads).toBe(0));

        expect(outcome.status).toBe("rejected");
        expect(receivedSignal).toBeInstanceOf(AbortSignal);
        expect(activeAtSettlement).toBe(0);
        if (outcome.status === "rejected") expect(outcome.error).toMatchObject({ code: "timeout" });
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

    test("consumes an exact empty pending batch without workers, Git calls, staging, or blobs", async () => {
        const fixture = await makeCaptureFixture(root, workspace, git);
        const calls: string[][] = [];
        const writeBlob = vi.fn(async () => "0".repeat(40));
        const originalRun = git.run.bind(git);
        git.run = async (args, options) => {
            calls.push([...args]);
            return originalRun(args, options);
        };

        const result = await fixture.capture.capture([]);
        expect(result).toEqual({
            status: "captured",
            mutations: [],
            newlyHashedBytes: 0,
        });
        await expect(
            fixture.capture.consumeCaptured(result, (batch) =>
                materializeIncrementalCapturedBatch(batch, { storeRoot: fixture.store.storeRoot, writeBlob })
            )
        ).resolves.toBeUndefined();
        await expect(fixture.capture.discardCaptured(result)).rejects.toThrow(/consumed|discarded|pending/i);
        expect(calls).toEqual([]);
        expect(writeBlob).not.toHaveBeenCalled();
    });

    test("discards an exact empty pending batch once", async () => {
        const fixture = await makeCaptureFixture(root, workspace, git);
        const result = await fixture.capture.capture([]);

        await expect(fixture.capture.discardCaptured(result)).resolves.toBeUndefined();
        await expect(fixture.capture.discardCaptured(result)).rejects.toThrow(/consumed|discarded|pending/i);
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

function gitBlobOid(bytes: Buffer): string {
    return createHash("sha1")
        .update(Buffer.from(`blob ${bytes.length}\0`))
        .update(bytes)
        .digest("hex");
}
