// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renameSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { readAnchoredJournalEntry } from "./journal-directory";

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
