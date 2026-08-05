// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renameSync, watch, writeFileSync, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
    IncrementalReaderConcurrency,
    runAnchoredReader,
    type AnchoredReaderEntryIdentity,
    type AnchoredReaderIdentity,
} from "./anchored-reader";

const cleanupRoots: string[] = [];

afterEach(async () => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
    await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("anchored reader", () => {
    test("uses a fixed batch concurrency and starts no workers for no entries", async () => {
        expect(IncrementalReaderConcurrency).toBe(8);
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
        const isolated = await import("./anchored-reader");

        await expect(
            isolated.runAnchoredReaderBatch({
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
        const isolated = await import("./anchored-reader");

        const result = await isolated.runAnchoredReaderBatch({
            rootPath: root,
            entries,
            maxSingleFileBytes: 1024,
            maxTotalBytes: 1024,
            timeoutMs: 5_000,
            signal: new AbortController().signal,
        });

        expect(result).toHaveLength(9);
        expect(peak).toBeLessThanOrEqual(IncrementalReaderConcurrency);
        expect(peak).toBeGreaterThan(1);
    });

    test("rehashes a same-size rewrite when an otherwise identical fingerprint is inside the racy window", async () => {
        const fixture = await makeReaderFixture("racy.txt", "other");
        const result = await runAnchoredReader({
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
        const result = await runAnchoredReader({
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
        const isolated = await import("./anchored-reader");

        await expect(isolated.runAnchoredReader(fixture.input)).rejects.toMatchObject({
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
        const isolated = await import("./anchored-reader");

        await expect(isolated.runAnchoredReader(fixture.input)).rejects.toMatchObject({
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
            const identity: AnchoredReaderEntryIdentity = {
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
                await expect(runAnchoredReader(fixture.input)).rejects.toMatchObject({
                    code: "worker_failed",
                    message: expect.stringMatching(/EACCES|permission denied/i),
                });
            } finally {
                await chmod(fixture.path, 0o600);
            }
        }
    );

    test("rejects an atomic pathname replacement after the regular file has been opened", async () => {
        const fixture = await makeReaderFixture("target.bin", "x".repeat(64 * 1024 ** 2));
        const replacement = join(fixture.root, "replacement.bin");
        await writeFile(replacement, "new inode");
        let replaced = false;
        const watcher = watch(fixture.root, (_event, filename) => {
            if (!replaced && String(filename) === "staging") {
                replaced = true;
                renameSync(replacement, fixture.path);
            }
        });
        try {
            await expect(runAnchoredReader({ ...fixture.input, timeoutMs: 10_000 })).rejects.toMatchObject({
                code: "unstable_file",
            });
        } finally {
            watcher.close();
        }
        expect(replaced).toBe(true);
    }, 15_000);
});

async function makeReaderFixture(name: string, content: string) {
    const root = await mkdtemp(join(tmpdir(), "crest-anchored-reader-test-"));
    cleanupRoots.push(root);
    const path = join(root, name);
    const stagingPath = join(root, "staging");
    await writeFile(path, content);
    const [parent, entry] = await Promise.all([lstat(root, { bigint: true }), lstat(path, { bigint: true })]);
    const parentIdentity: AnchoredReaderIdentity = {
        dev: parent.dev.toString(),
        ino: parent.ino.toString(),
        birthtimeNs: parent.birthtimeNs.toString(),
    };
    const identity: AnchoredReaderEntryIdentity = {
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

function identity(value: BigIntStats): AnchoredReaderIdentity {
    return {
        dev: value.dev.toString(),
        ino: value.ino.toString(),
        birthtimeNs: value.birthtimeNs.toString(),
    };
}

function entryIdentity(value: BigIntStats): AnchoredReaderEntryIdentity {
    return {
        ...identity(value),
        mode: value.mode.toString(),
        nlink: value.nlink.toString(),
        size: value.size.toString(),
        mtimeNs: value.mtimeNs.toString(),
        ctimeNs: value.ctimeNs.toString(),
    };
}
