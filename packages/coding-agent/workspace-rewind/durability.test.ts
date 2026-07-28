// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { open, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { ensureDurableGitObjects, removeDurableFile, writeDurableJson } from "./durability";

const CleanupRoots: string[] = [];

afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("atomically replaces private canonical JSON and removes it durably", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "crest-durable-"));
    CleanupRoots.push(root);
    const path = join(root, "state.json");

    await writeDurableJson(path, { z: 1, a: "value" });

    expect(await readFile(path, "utf8")).toBe('{"a":"value","z":1}\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const handle = await open(path, "r");
    await handle.close();

    await removeDurableFile(path);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects values that JSON would silently discard or coerce", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "crest-durable-invalid-"));
    CleanupRoots.push(root);

    await expect(writeDurableJson(join(root, "undefined.json"), { value: undefined })).rejects.toThrow(
        /canonical JSON/
    );
    await expect(writeDurableJson(join(root, "nan.json"), { value: Number.NaN })).rejects.toThrow(/canonical JSON/);
});

test("rejects a required Git object missing from loose and verified packed storage", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "crest-durable-object-"));
    CleanupRoots.push(root);

    await expect(ensureDurableGitObjects(root, ["a".repeat(40)])).rejects.toMatchObject({ code: "ENOENT" });
});
