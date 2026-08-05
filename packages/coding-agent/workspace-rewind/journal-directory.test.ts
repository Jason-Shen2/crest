// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renameSync, watch, writeFileSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import {
    publishAnchoredJournalEntryNoReplace,
    readAnchoredJournalDirectory,
    readAnchoredJournalEntry,
    readAnchoredJournalPublication,
    recoverAnchoredJournalPublication,
    writeAnchoredJournalEntry,
} from "./journal-directory";

const CleanupRoots: string[] = [];

afterEach(async () => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("reads only the requested private journal entry and ignores other names", async () => {
    const root = await mkdtemp(join(tmpdir(), "crest-journal-entry-"));
    CleanupRoots.push(root);
    const bytes = Buffer.from("active bytes");
    await writeFile(join(root, "pending.json"), bytes, { mode: 0o600 });
    await symlink(join(root, "missing-audit-target"), join(root, "resolved-unreadable-audit.json"));

    const active = await readAnchoredJournalEntry({
        root,
        name: "pending.json",
        maximumEntryBytes: 1024,
    });

    expect(active?.entry?.bytes).toEqual(bytes);
    expect(active?.entry?.name).toBe("pending.json");
    await expect(
        readAnchoredJournalEntry({ root, name: "absent.json", maximumEntryBytes: 1024 })
    ).resolves.toMatchObject({ entry: undefined });
});

test("fails closed when the named journal root is swapped before its worker starts", async () => {
    const parent = await mkdtemp(join(tmpdir(), "crest-journal-entry-swap-"));
    CleanupRoots.push(parent);
    const root = join(parent, "restore");
    const held = join(parent, "held");
    const replacement = join(parent, "replacement");
    await Promise.all([mkdir(root, { mode: 0o700 }), mkdir(replacement, { mode: 0o700 })]);
    await writeFile(join(root, "pending.json"), "real", { mode: 0o600 });
    await writeFile(join(replacement, "pending.json"), "substitute", { mode: 0o600 });
    let swapped = false;
    vi.doMock("node:child_process", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:child_process")>();
        return {
            ...actual,
            spawn: (...args: Parameters<typeof actual.spawn>) => {
                if (!swapped && args[2]?.cwd === root) {
                    renameSync(root, held);
                    renameSync(replacement, root);
                    swapped = true;
                    const child = actual.spawn(...args);
                    renameSync(root, replacement);
                    renameSync(held, root);
                    return child;
                }
                return actual.spawn(...args);
            },
        };
    });
    vi.resetModules();
    const isolated = await import("./journal-directory");

    await expect(
        isolated.readAnchoredJournalEntry({ root, name: "pending.json", maximumEntryBytes: 1024 })
    ).rejects.toThrow(/anchor|changed/i);
    expect(swapped).toBe(true);
});

test("pending publication refuses to overwrite an existing destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "crest-journal-publish-existing-"));
    CleanupRoots.push(root);
    await writeFile(join(root, "pending.json"), "existing", { mode: 0o600 });
    const anchored = await readAnchoredJournalEntry({ root, name: "absent.json", maximumEntryBytes: 1024 });

    await expect(
        publishAnchoredJournalEntryNoReplace({
            root,
            rootIdentity: anchored!.identity,
            destinationName: "pending.json",
            bytes: Buffer.from("replacement"),
        })
    ).rejects.toThrow(/destination|exist/i);
    expect(await readFile(join(root, "pending.json"), "utf8")).toBe("existing");
});

test("pending publication cannot overwrite a destination created after its initial check", async () => {
    const root = await mkdtemp(join(tmpdir(), "crest-journal-publish-race-"));
    CleanupRoots.push(root);
    const destination = join(root, "pending.json");
    const anchored = await readAnchoredJournalEntry({ root, name: "absent.json", maximumEntryBytes: 1024 });
    let installed = false;
    const watcher = watch(root, (_event, filename) => {
        if (installed || String(filename) !== ".pending.json.publish.tmp") {
            return;
        }
        try {
            writeFileSync(destination, "racing owner", { flag: "wx", mode: 0o600 });
            installed = true;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
                throw error;
            }
        }
    });
    try {
        await expect(
            publishAnchoredJournalEntryNoReplace({
                root,
                rootIdentity: anchored!.identity,
                destinationName: "pending.json",
                bytes: Buffer.alloc(64 * 1024 * 1024, 0x61),
            })
        ).rejects.toThrow(/exist/i);
    } finally {
        watcher.close();
    }

    expect(installed).toBe(true);
    expect(await readFile(destination, "utf8")).toBe("racing owner");
    expect((await readdir(root)).filter((name) => name.endsWith(".publish.tmp"))).toEqual([]);
}, 15_000);

test("shared journal writes keep random rename temps readable by the legacy directory scanner", async () => {
    const root = await mkdtemp(join(tmpdir(), "crest-journal-legacy-write-"));
    CleanupRoots.push(root);
    const anchored = await readAnchoredJournalEntry({ root, name: "absent.json", maximumEntryBytes: 1024 });
    let temporaryName: string | undefined;
    const watcher = watch(root, (_event, filename) => {
        const name = String(filename);
        if (/^\.[0-9a-f]{32}\.tmp$/.test(name)) {
            temporaryName = name;
        }
    });
    try {
        await writeAnchoredJournalEntry({
            root,
            rootIdentity: anchored!.identity,
            destinationName: "legacy.json",
            bytes: Buffer.alloc(64 * 1024 * 1024, 0x62),
        });
    } finally {
        watcher.close();
    }
    expect(temporaryName).toMatch(/^\.[0-9a-f]{32}\.tmp$/);

    await writeFile(join(root, temporaryName!), "interrupted legacy write", { mode: 0o600 });
    const scanned = await readAnchoredJournalDirectory({
        root,
        maximumEntries: 2,
        maximumEntryBytes: 64 * 1024 * 1024,
        maximumTotalBytes: 65 * 1024 * 1024,
    });
    expect(scanned?.entries.map((entry) => entry.name).sort()).toEqual([temporaryName, "legacy.json"].sort());
}, 15_000);

test("shared journal writes remove random temps after an injected post-sync failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "crest-journal-temp-cleanup-"));
    CleanupRoots.push(root);
    const anchored = await readAnchoredJournalEntry({ root, name: "absent.json", maximumEntryBytes: 1024 });

    await expect(
        writeAnchoredJournalEntry({
            root,
            rootIdentity: anchored!.identity,
            destinationName: "state.json",
            bytes: Buffer.from("state"),
            testFailAfterTemporarySync: true,
        })
    ).rejects.toThrow(/injected/i);

    expect((await readdir(root)).filter((name) => /^\.[0-9a-f]{32}\.tmp$/.test(name))).toEqual([]);
});

test.each([
    ["after link", false, false],
    ["after first directory sync", true, false],
    ["after unlink before second directory sync", true, true],
] as const)("reads and recovers first publication %s", async (_boundary, syncAfterLink, unlinkTemporary) => {
    const root = await mkdtemp(join(tmpdir(), "crest-journal-publish-recover-"));
    CleanupRoots.push(root);
    const destinationName = "pending.json";
    const temporaryName = ".pending.json.publish.tmp";
    const destination = join(root, destinationName);
    const temporary = join(root, temporaryName);
    const bytes = Buffer.from("published bytes");
    await writeFile(temporary, bytes, { mode: 0o600 });
    await link(temporary, destination);
    if (syncAfterLink) {
        const directory = await open(root, "r");
        await directory.sync();
        await directory.close();
    }
    if (unlinkTemporary) {
        await unlink(temporary);
    }

    const observed = await readAnchoredJournalPublication({ root, destinationName, maximumEntryBytes: 1024 });
    expect(observed?.entry?.bytes).toEqual(bytes);
    if (!unlinkTemporary) {
        expect((await lstat(temporary)).nlink).toBe(2);
    }

    const recovered = await recoverAnchoredJournalPublication({ root, destinationName, maximumEntryBytes: 1024 });
    expect(recovered?.entry?.bytes).toEqual(bytes);
    await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(destination)).nlink).toBe(1);
});

test("leaves an active only-temp publication untouched until locked recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "crest-journal-publish-only-temp-"));
    CleanupRoots.push(root);
    const temporary = join(root, ".pending.json.publish.tmp");
    await writeFile(temporary, "not published", { mode: 0o600 });

    await expect(
        readAnchoredJournalPublication({ root, destinationName: "pending.json", maximumEntryBytes: 1024 })
    ).resolves.toMatchObject({ entry: undefined });
    await expect(lstat(temporary)).resolves.toBeDefined();

    await expect(
        recoverAnchoredJournalPublication({ root, destinationName: "pending.json", maximumEntryBytes: 1024 })
    ).resolves.toMatchObject({ entry: undefined });
    await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
});

test("fails closed on mismatched or unsafe fixed publication entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "crest-journal-publish-unsafe-"));
    CleanupRoots.push(root);
    const destination = join(root, "pending.json");
    const temporary = join(root, ".pending.json.publish.tmp");
    await writeFile(destination, "destination", { mode: 0o600 });
    await writeFile(temporary, "mismatch", { mode: 0o600 });

    await expect(
        readAnchoredJournalPublication({ root, destinationName: "pending.json", maximumEntryBytes: 1024 })
    ).rejects.toThrow(/pair|match|unsafe/i);
    await expect(
        recoverAnchoredJournalPublication({ root, destinationName: "pending.json", maximumEntryBytes: 1024 })
    ).rejects.toThrow(/pair|match|unsafe/i);
    expect(await readFile(destination, "utf8")).toBe("destination");
    expect(await readFile(temporary, "utf8")).toBe("mismatch");

    await unlink(temporary);
    await symlink(join(root, "missing"), temporary);
    await expect(
        recoverAnchoredJournalPublication({ root, destinationName: "pending.json", maximumEntryBytes: 1024 })
    ).rejects.toThrow(/pair|match|unsafe/i);
    expect(await readFile(destination, "utf8")).toBe("destination");
    expect((await lstat(temporary)).isSymbolicLink()).toBe(true);
});
