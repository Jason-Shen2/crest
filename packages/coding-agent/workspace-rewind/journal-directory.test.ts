// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renameSync, watch, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { readAnchoredJournalEntry, writeAnchoredJournalEntry } from "./journal-directory";

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

test("first publication refuses to overwrite an existing destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "crest-journal-publish-existing-"));
    CleanupRoots.push(root);
    await writeFile(join(root, "pending.json"), "existing", { mode: 0o600 });
    const anchored = await readAnchoredJournalEntry({ root, name: "absent.json", maximumEntryBytes: 1024 });

    await expect(
        writeAnchoredJournalEntry({
            root,
            rootIdentity: anchored!.identity,
            destinationName: "pending.json",
            bytes: Buffer.from("replacement"),
        })
    ).rejects.toThrow(/destination|exist/i);
    expect(await readFile(join(root, "pending.json"), "utf8")).toBe("existing");
});

test("first publication cannot overwrite a destination created after its initial check", async () => {
    const root = await mkdtemp(join(tmpdir(), "crest-journal-publish-race-"));
    CleanupRoots.push(root);
    const destination = join(root, "pending.json");
    const anchored = await readAnchoredJournalEntry({ root, name: "absent.json", maximumEntryBytes: 1024 });
    let installed = false;
    const watcher = watch(root, (_event, filename) => {
        if (installed || !/^\.[0-9a-f]{32}\.tmp$/.test(String(filename))) {
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
            writeAnchoredJournalEntry({
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
    expect((await readdir(root)).filter((name) => /^\.[0-9a-f]{32}\.tmp$/.test(name))).toEqual([]);
}, 15_000);
