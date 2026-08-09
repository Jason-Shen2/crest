// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import { makeProcessOwnerIdentity } from "./process-owner";
import { initializePrivateStore } from "./snapshot-store";

const CleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private V3 bare-store bootstrap safety", () => {
    test("initializes and repairs a private bare repository without index or alternates", async () => {
        const root = await temporaryRoot("bare");
        const storeRoot = join(root, "repo.git");
        const input = {
            storeRoot,
            git: new WorkspaceGitRunner(),
            processOwner: await makeProcessOwnerIdentity(),
        };

        await initializePrivateStore(input);
        await chmod(storeRoot, 0o755);
        await chmod(join(storeRoot, "objects"), 0o755);
        await initializePrivateStore(input);

        expect((await stat(storeRoot)).mode & 0o777).toBe(0o700);
        expect((await stat(join(storeRoot, "objects"))).mode & 0o777).toBe(0o700);
        expect((await stat(join(storeRoot, "refs"))).mode & 0o777).toBe(0o700);
        expect((await stat(join(storeRoot, "journal"))).mode & 0o777).toBe(0o700);
        await expect(lstat(join(storeRoot, "index"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(join(storeRoot, "objects", "info", "alternates"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(join(storeRoot, "config"), "utf8")).toMatch(/bare = true/);
    });

    test("repairs an interrupted bare repository bootstrap", async () => {
        const root = await temporaryRoot("interrupted");
        const storeRoot = join(root, "repo.git");
        await mkdir(storeRoot);

        await initializePrivateStore({
            storeRoot,
            git: new WorkspaceGitRunner(),
            processOwner: await makeProcessOwnerIdentity(),
        });

        expect((await stat(join(storeRoot, "objects"))).isDirectory()).toBe(true);
        expect((await stat(join(storeRoot, "refs"))).isDirectory()).toBe(true);
    });

    test("recovers dead owner and candidate records left by a bootstrap crash", async () => {
        const root = await temporaryRoot("crash");
        const storeRoot = join(root, "repo.git");
        const ownerPath = join(root, ".bootstrap-owner");
        const candidatePath = join(root, `.bootstrap-owner.candidate-${2 ** 30}-${"a".repeat(24)}`);
        const deadOwner = JSON.stringify({
            pid: 2 ** 30,
            processstarttoken: "dead",
            nonce: "b".repeat(64),
        });
        await writeFile(ownerPath, deadOwner, { mode: 0o666 });
        await writeFile(candidatePath, deadOwner, { mode: 0o666 });

        await initializePrivateStore({
            storeRoot,
            git: new WorkspaceGitRunner(),
            processOwner: await makeProcessOwnerIdentity(),
        });

        await expect(lstat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(candidatePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await stat(storeRoot)).isDirectory()).toBe(true);
    });

    test("repairs every repository directory and file to owner-only permissions", async () => {
        const root = await temporaryRoot("permissions");
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

    test("fails closed when the store root is redirected through a symlink", async () => {
        const root = await temporaryRoot("symlink");
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
        ).rejects.toThrow(/unsafe snapshot store/i);
        expect(await readdir(outside)).toEqual([]);
    });
});

async function temporaryRoot(label: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `crest-v3-bootstrap-${label}-`));
    CleanupRoots.push(root);
    return root;
}

async function expectOwnerOnlyTree(root: string): Promise<void> {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        const path = join(root, entry.name);
        const value = await lstat(path);
        if (entry.isDirectory()) {
            expect(value.mode & 0o777, path).toBe(0o700);
            await expectOwnerOnlyTree(path);
            continue;
        }
        expect(entry.isSymbolicLink(), path).toBe(false);
        expect(value.mode & 0o777, path).toBe(0o600);
    }
}
