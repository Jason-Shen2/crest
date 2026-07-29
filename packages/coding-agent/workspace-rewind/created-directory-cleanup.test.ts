// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { removeCreatedWorkspaceDirectories } from "./created-directory-cleanup";

describe("created workspace directory cleanup", () => {
    it("removes only recorded empty directories from their anchored direct parents", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-created-directory-cleanup-"));
        await mkdir(join(root, "created", "nested"), { recursive: true });

        await removeCreatedWorkspaceDirectories(root, ["created", "created/nested"]);

        await expect(readFile(join(root, "created"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("does not follow a replaced ancestor to remove an external directory", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-created-directory-swap-"));
        const outside = await mkdtemp(join(tmpdir(), "crest-created-directory-outside-"));
        await mkdir(join(root, "created", "nested"), { recursive: true });
        await mkdir(join(outside, "nested"));
        await writeFile(join(outside, "nested", "sentinel"), "outside");
        await rename(join(root, "created"), join(root, "held"));
        await symlink(outside, join(root, "created"));

        await expect(removeCreatedWorkspaceDirectories(root, ["created/nested"])).rejects.toThrow(/unsafe|identity/i);

        await expect(readFile(join(outside, "nested", "sentinel"), "utf8")).resolves.toBe("outside");
    });
});
