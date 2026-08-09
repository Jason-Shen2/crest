// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renameSync, writeFileSync, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
    StablePathReaderConcurrency,
    runStablePathReader,
    runStablePathReaderBatch,
    type StablePathReaderEntryIdentity,
    type StablePathReaderIdentity,
} from "./workspace-path-reader";

const cleanupRoots: string[] = [];

afterEach(async () => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
    await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stable path reader", () => {
    test("keeps observation hook failures outside the reader result", async () => {
        const entries = [makeBatchEntry("first/file.txt"), makeBatchEntry("second/file.txt")];
        let started = 0;
        let settled = 0;

        await expect(
            runStablePathReaderBatch(
                {
                    rootPath: "/unused",
                    entries,
                    maxSingleFileBytes: 1,
                    maxTotalBytes: 2,
                    timeoutMs: 1_000,
                    signal: new AbortController().signal,
                    hooks: {
                        workerStarted: () => {
                            started++;
                            throw new Error("start observer failed");
                        },
                        workerSettled: () => {
                            settled++;
                            throw new Error("settle observer failed");
                        },
                    },
                },
                async (input) =>
                    input.entries.map((entry) => ({
                        path: entry.path,
                        reusedOid: "0".repeat(40),
                        identity: entry.identity,
                        hashedBytes: 0,
                    }))
            )
        ).resolves.toHaveLength(2);
        expect(started).toBe(2);
        expect(settled).toBe(2);
    });

    test("preserves reader and abort failures when observation hooks throw", async () => {
        const readerFailure = new Error("reader failed");
        let started = 0;
        let settled = 0;
        const hooks = {
            workerStarted: () => {
                started++;
                throw new Error("start observer failed");
            },
            workerSettled: () => {
                settled++;
                throw new Error("settle observer failed");
            },
        };

        await expect(
            runStablePathReaderBatch(
                {
                    rootPath: "/unused",
                    entries: [makeBatchEntry("first/file.txt")],
                    maxSingleFileBytes: 1,
                    maxTotalBytes: 1,
                    timeoutMs: 1_000,
                    signal: new AbortController().signal,
                    hooks,
                },
                async () => {
                    throw readerFailure;
                }
            )
        ).rejects.toBe(readerFailure);
        expect({ started, settled }).toEqual({ started: 1, settled: 1 });

        const controller = new AbortController();
        const abortFailure = new Error("cancelled");
        controller.abort(abortFailure);
        await expect(
            runStablePathReaderBatch(
                {
                    rootPath: "/unused",
                    entries: [makeBatchEntry("first/file.txt")],
                    maxSingleFileBytes: 1,
                    maxTotalBytes: 1,
                    timeoutMs: 1_000,
                    signal: controller.signal,
                    hooks,
                },
                async (input) => {
                    throw input.signal.reason;
                }
            )
        ).rejects.toBe(abortFailure);
        expect({ started, settled }).toEqual({ started: 2, settled: 2 });
    });

    test("uses a fixed batch concurrency and starts no workers for no entries", async () => {
        expect(StablePathReaderConcurrency).toBe(8);
        let spawnCount = 0;
        vi.doMock("node:child_process", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:child_process")>();
            return {
                ...actual,
                spawn: (...args: Parameters<typeof actual.spawn>) => {
                    spawnCount += 1;
                    return actual.spawn(...args);
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./workspace-path-reader");

        await expect(
            isolated.runStablePathReaderBatch({
                rootPath: "/unused",
                entries: [],
                maxSingleFileBytes: 1,
                maxTotalBytes: 1,
                timeoutMs: 1,
                signal: new AbortController().signal,
            })
        ).resolves.toEqual([]);
        expect(spawnCount).toBe(0);
    });

    test("runs parent groups with at most eight reader workers", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-anchored-batch-test-"));
        cleanupRoots.push(root);
        const entries = [];
        for (let index = 0; index < 9; index++) {
            const parentPath = join(root, `parent-${index}`);
            const path = join(parentPath, "file.txt");
            const stagingPath = join(root, `staging-${index}`);
            await mkdir(parentPath);
            await writeFile(path, "content");
            const [parent, entry] = await Promise.all([
                lstat(parentPath, { bigint: true }),
                lstat(path, { bigint: true }),
            ]);
            entries.push({
                path: `parent-${index}/file.txt`,
                name: "file.txt",
                kind: "file" as const,
                stagingPath,
                parentIdentity: identity(parent),
                identity: entryIdentity(entry),
            });
        }
        let active = 0;
        let peak = 0;
        vi.doMock("node:child_process", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:child_process")>();
            return {
                ...actual,
                spawn: (...args: Parameters<typeof actual.spawn>) => {
                    const child = actual.spawn(...args);
                    active += 1;
                    peak = Math.max(peak, active);
                    child.once("exit", () => {
                        active -= 1;
                    });
                    return child;
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./workspace-path-reader");

        const result = await isolated.runStablePathReaderBatch({
            rootPath: root,
            entries,
            maxSingleFileBytes: 1024,
            maxTotalBytes: 1024,
            timeoutMs: 5_000,
            signal: new AbortController().signal,
        });

        expect(result).toHaveLength(9);
        expect(peak).toBeLessThanOrEqual(StablePathReaderConcurrency);
        expect(peak).toBeGreaterThan(1);
    });

    test("aborts and drains sibling workers before a failed batch returns", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-anchored-batch-drain-"));
        cleanupRoots.push(root);
        const failingParent = join(root, "failing");
        const slowParent = join(root, "slow");
        await mkdir(failingParent);
        await mkdir(slowParent);
        await writeFile(join(failingParent, "file.txt"), "failure");
        await writeFile(join(slowParent, "file.txt"), "slow");
        const failingEntry = await lstat(join(failingParent, "file.txt"), { bigint: true });
        const slowEntry = await lstat(join(slowParent, "file.txt"), { bigint: true });
        const failingParentStat = await lstat(failingParent, { bigint: true });
        const slowParentStat = await lstat(slowParent, { bigint: true });
        let active = 0;
        vi.doMock("node:child_process", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:child_process")>();
            return {
                ...actual,
                spawn: (...args: Parameters<typeof actual.spawn>) => {
                    if ((args[2] as { cwd?: string }).cwd === slowParent) {
                        args[1] = ["-e", "process.stdin.resume(); setTimeout(() => {}, 5000)"];
                    }
                    const child = actual.spawn(...args);
                    active += 1;
                    child.once("exit", () => {
                        active -= 1;
                    });
                    return child;
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./workspace-path-reader");
        const failingIdentity = entryIdentity(failingEntry);
        failingIdentity.ino = (BigInt(failingIdentity.ino) + 1n).toString();

        await expect(
            isolated.runStablePathReaderBatch({
                rootPath: root,
                entries: [
                    {
                        path: "failing/file.txt",
                        name: "file.txt",
                        kind: "file",
                        stagingPath: join(root, "failing-stage"),
                        parentIdentity: identity(failingParentStat),
                        identity: failingIdentity,
                    },
                    {
                        path: "slow/file.txt",
                        name: "file.txt",
                        kind: "file",
                        stagingPath: join(root, "slow-stage"),
                        parentIdentity: identity(slowParentStat),
                        identity: entryIdentity(slowEntry),
                    },
                ],
                maxSingleFileBytes: 1024,
                maxTotalBytes: 1024,
                timeoutMs: 10_000,
                signal: new AbortController().signal,
            })
        ).rejects.toMatchObject({ code: "unstable_file" });
        expect(active).toBe(0);
    });

    test("drains every blocked sibling before an external abort returns", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-anchored-external-abort-"));
        cleanupRoots.push(root);
        const firstParent = join(root, "first");
        const secondParent = join(root, "second");
        await mkdir(firstParent);
        await mkdir(secondParent);
        await writeFile(join(firstParent, "file.txt"), "first");
        await writeFile(join(secondParent, "file.txt"), "second");
        const [firstParentStat, secondParentStat, firstEntry, secondEntry] = await Promise.all([
            lstat(firstParent, { bigint: true }),
            lstat(secondParent, { bigint: true }),
            lstat(join(firstParent, "file.txt"), { bigint: true }),
            lstat(join(secondParent, "file.txt"), { bigint: true }),
        ]);
        let active = 0;
        vi.doMock("node:child_process", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:child_process")>();
            return {
                ...actual,
                spawn: (...args: Parameters<typeof actual.spawn>) => {
                    args[1] = ["-e", "process.stdin.resume(); setTimeout(() => {}, 5000)"];
                    const child = actual.spawn(...args);
                    active += 1;
                    child.once("exit", () => {
                        active -= 1;
                    });
                    return child;
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./workspace-path-reader");
        const controller = new AbortController();
        const pending = isolated.runStablePathReaderBatch({
            rootPath: root,
            entries: [
                {
                    path: "first/file.txt",
                    name: "file.txt",
                    kind: "file",
                    stagingPath: join(root, "first-stage"),
                    parentIdentity: identity(firstParentStat),
                    identity: entryIdentity(firstEntry),
                },
                {
                    path: "second/file.txt",
                    name: "file.txt",
                    kind: "file",
                    stagingPath: join(root, "second-stage"),
                    parentIdentity: identity(secondParentStat),
                    identity: entryIdentity(secondEntry),
                },
            ],
            maxSingleFileBytes: 1024,
            maxTotalBytes: 1024,
            timeoutMs: 10_000,
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(active).toBe(2));

        controller.abort();

        await expect(pending).rejects.toMatchObject({ code: "aborted" });
        expect(active).toBe(0);
    });

    test("does not grant a fresh timeout to a later queued parent worker", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-anchored-shared-deadline-"));
        cleanupRoots.push(root);
        const entries = [];
        for (let index = 0; index < StablePathReaderConcurrency + 1; index++) {
            const parentPath = join(root, `parent-${index}`);
            const path = join(parentPath, "file.txt");
            await mkdir(parentPath);
            await writeFile(path, "x");
            const [parent, entry] = await Promise.all([
                lstat(parentPath, { bigint: true }),
                lstat(path, { bigint: true }),
            ]);
            entries.push({
                path: `parent-${index}/file.txt`,
                name: "file.txt",
                kind: "file" as const,
                stagingPath: join(root, `staging-${index}`),
                parentIdentity: identity(parent),
                identity: entryIdentity(entry),
            });
        }
        let spawned = 0;
        vi.doMock("node:child_process", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:child_process")>();
            return {
                ...actual,
                spawn: (...args: Parameters<typeof actual.spawn>) => {
                    args[1] = [
                        "-e",
                        `const chunks=[];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
    const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    setTimeout(() => process.stdout.write(JSON.stringify(input.entries.map(entry => ({
        path: entry.path,
        stagingPath: entry.stagingPath,
        identity: entry.identity,
        hashedBytes: Number(entry.identity.size)
    })))), 300);
});`,
                    ];
                    spawned += 1;
                    return actual.spawn(...args);
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./workspace-path-reader");

        await expect(
            isolated.runStablePathReaderBatch({
                rootPath: root,
                entries,
                maxSingleFileBytes: 1024,
                maxTotalBytes: 1024,
                timeoutMs: 500,
                signal: new AbortController().signal,
            })
        ).rejects.toMatchObject({ code: "timeout" });
        expect(spawned).toBe(StablePathReaderConcurrency + 1);
    });

    test("rehashes a same-size rewrite when an otherwise identical fingerprint is inside the racy window", async () => {
        const fixture = await makeReaderFixture("racy.txt", "other");
        const result = await runStablePathReader({
            ...fixture.input,
            entries: [
                {
                    ...fixture.entry,
                    previous: {
                        ...fixture.entry.identity,
                        oid: "a".repeat(40),
                    },
                },
            ],
        });

        expect(result).toMatchObject([{ path: "racy.txt", stagingPath: fixture.entry.stagingPath, hashedBytes: 5 }]);
        expect(result[0]!.reusedOid).toBeUndefined();
        expect(await readFile(fixture.entry.stagingPath)).toEqual(Buffer.from("other"));
    });

    test.each([
        ["file identity", { dev: "0", ino: "0" }],
        ["filesystem timestamps", { mtimeNs: "0", ctimeNs: "0" }],
    ])("rehashes when the previous %s is unreliable", async (_label, overrides) => {
        const fixture = await makeReaderFixture("unreliable.txt", "same");
        const result = await runStablePathReader({
            ...fixture.input,
            entries: [
                {
                    ...fixture.entry,
                    previous: {
                        ...fixture.entry.identity,
                        ...overrides,
                        oid: "b".repeat(40),
                    },
                },
            ],
        });

        expect(result[0]).toMatchObject({ stagingPath: fixture.entry.stagingPath, hashedBytes: 4 });
        expect(result[0]!.reusedOid).toBeUndefined();
    });

    test("fails closed when a file changes after scope evidence is captured", async () => {
        const fixture = await makeReaderFixture("unstable.txt", "before!");
        let changed = false;
        vi.doMock("node:child_process", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:child_process")>();
            return {
                ...actual,
                spawn: (...args: Parameters<typeof actual.spawn>) => {
                    const child = actual.spawn(...args);
                    if (!changed && args[2]?.cwd === fixture.root) {
                        changed = true;
                        writeFileSync(fixture.path, "changed");
                    }
                    return child;
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./workspace-path-reader");

        await expect(isolated.runStablePathReader(fixture.input)).rejects.toMatchObject({
            code: "unstable_file",
        });
        expect(changed).toBe(true);
    });

    test("classifies a pathname that vanishes after scope capture as unstable", async () => {
        const fixture = await makeReaderFixture("vanished.txt", "before");
        let vanished = false;
        vi.doMock("node:child_process", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:child_process")>();
            return {
                ...actual,
                spawn: (...args: Parameters<typeof actual.spawn>) => {
                    if (!vanished && args[2]?.cwd === fixture.root) {
                        vanished = true;
                        renameSync(fixture.path, join(fixture.root, "displaced.txt"));
                    }
                    return actual.spawn(...args);
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./workspace-path-reader");

        await expect(isolated.runStablePathReader(fixture.input)).rejects.toMatchObject({
            code: "unstable_file",
        });
        expect(vanished).toBe(true);
    });

    test.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
        "does not classify a genuine pathname permission error as unstable",
        async () => {
            const fixture = await makeReaderFixture("forbidden.txt", "before");
            await chmod(fixture.path, 0);
            const metadata = await lstat(fixture.path, { bigint: true });
            const identity: StablePathReaderEntryIdentity = {
                dev: metadata.dev.toString(),
                ino: metadata.ino.toString(),
                birthtimeNs: metadata.birthtimeNs.toString(),
                mode: metadata.mode.toString(),
                nlink: metadata.nlink.toString(),
                size: metadata.size.toString(),
                mtimeNs: metadata.mtimeNs.toString(),
                ctimeNs: metadata.ctimeNs.toString(),
            };
            fixture.input.entries[0]!.identity = identity;

            try {
                await expect(runStablePathReader(fixture.input)).rejects.toMatchObject({
                    code: "worker_failed",
                    message: expect.stringMatching(/EACCES|permission denied/i),
                });
            } finally {
                await chmod(fixture.path, 0o600);
            }
        }
    );

    test("rejects an atomic pathname replacement after the regular file has been opened", async () => {
        const fixture = await makeReaderFixture("target.bin", "x".repeat(1024 * 1024));
        const replacement = join(fixture.root, "replacement.bin");
        const openedMarker = join(fixture.root, "reader-opened");
        const releaseMarker = join(fixture.root, "reader-release");
        await writeFile(replacement, "new inode");
        const pending = runStablePathReader({
            ...fixture.input,
            timeoutMs: 10_000,
            testBarrier: { path: "target.bin", openedMarker, releaseMarker },
        });
        try {
            await waitForPath(openedMarker);
            renameSync(replacement, fixture.path);
        } finally {
            await writeFile(releaseMarker, "release");
        }
        await expect(pending).rejects.toMatchObject({ code: "unstable_file" });
    }, 15_000);
});

async function makeReaderFixture(name: string, content: string) {
    const root = await mkdtemp(join(tmpdir(), "crest-workspace-path-reader-test-"));
    cleanupRoots.push(root);
    const path = join(root, name);
    const stagingPath = join(root, "staging");
    await writeFile(path, content);
    const [parent, entry] = await Promise.all([lstat(root, { bigint: true }), lstat(path, { bigint: true })]);
    const parentIdentity: StablePathReaderIdentity = {
        dev: parent.dev.toString(),
        ino: parent.ino.toString(),
        birthtimeNs: parent.birthtimeNs.toString(),
    };
    const identity: StablePathReaderEntryIdentity = {
        dev: entry.dev.toString(),
        ino: entry.ino.toString(),
        birthtimeNs: entry.birthtimeNs.toString(),
        mode: entry.mode.toString(),
        nlink: entry.nlink.toString(),
        size: entry.size.toString(),
        mtimeNs: entry.mtimeNs.toString(),
        ctimeNs: entry.ctimeNs.toString(),
    };
    return {
        root,
        path,
        entry: {
            path: name,
            name,
            kind: "file" as const,
            identity,
            stagingPath,
        },
        input: {
            parentPath: root,
            parentIdentity,
            entries: [
                {
                    path: name,
                    name,
                    kind: "file" as const,
                    identity,
                    stagingPath,
                },
            ],
            maxSingleFileBytes: 64 * 1024 ** 2,
            maxTotalBytes: 1024 ** 3,
            timeoutMs: 5_000,
            signal: new AbortController().signal,
        },
    };
}

function identity(value: BigIntStats): StablePathReaderIdentity {
    return {
        dev: value.dev.toString(),
        ino: value.ino.toString(),
        birthtimeNs: value.birthtimeNs.toString(),
    };
}

function entryIdentity(value: BigIntStats): StablePathReaderEntryIdentity {
    return {
        ...identity(value),
        mode: value.mode.toString(),
        nlink: value.nlink.toString(),
        size: value.size.toString(),
        mtimeNs: value.mtimeNs.toString(),
        ctimeNs: value.ctimeNs.toString(),
    };
}

function makeBatchEntry(path: string) {
    return {
        path,
        name: "file.txt",
        kind: "file" as const,
        stagingPath: `/unused/${path}`,
        parentIdentity: { dev: "1", ino: path, birthtimeNs: "1" },
        identity: {
            dev: "1",
            ino: path,
            birthtimeNs: "1",
            mode: "33188",
            nlink: "1",
            size: "1",
            mtimeNs: "1",
            ctimeNs: "1",
        },
    };
}

async function waitForPath(path: string): Promise<void> {
    for (let attempt = 0; attempt < 1_000; attempt++) {
        try {
            await lstat(path);
            return;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Stable path reader did not reach its test barrier");
}
