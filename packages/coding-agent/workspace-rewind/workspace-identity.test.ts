// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveCanonicalWorkspaceIdentity } from "./workspace-identity";

const execFileAsync = promisify(execFile);

describe("resolveCanonicalWorkspaceIdentity", () => {
    let root: string;
    let originalDataHome: string | undefined;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "crest-workspace-identity-"));
        originalDataHome = process.env.WAVETERM_DATA_HOME;
        process.env.WAVETERM_DATA_HOME = join(root, "crest-data");
    });

    afterEach(async () => {
        if (originalDataHome == null) {
            delete process.env.WAVETERM_DATA_HOME;
        } else {
            process.env.WAVETERM_DATA_HOME = originalDataHome;
        }
        await rm(root, { recursive: true, force: true });
    });

    test("resolves a repository subdirectory to the canonical Git root", async () => {
        const repository = join(root, "repository");
        const child = join(repository, "src", "feature");
        await mkdir(child, { recursive: true });
        await git(repository, "init");

        const identity = await resolveCanonicalWorkspaceIdentity(child);

        expect(identity.canonicalRoot).toBe(await realpath(repository));
        expect(identity.workspaceIdentity).toMatch(/^[0-9a-f]{64}$/);
        expect(identity.workspaceIncarnation).toMatch(/^[0-9a-f]{64}$/);
        expect(identity.storeKey).toBe(`${identity.workspaceIdentity}-${identity.workspaceIncarnation}`);
    });

    test.runIf(process.platform !== "win32")("preserves a legal trailing carriage return in the Git root", async () => {
        const repository = join(root, "repository\r");
        await mkdir(repository);
        await git(repository, "init");

        const identity = await resolveCanonicalWorkspaceIdentity(repository);

        expect(identity.canonicalRoot).toBe(await realpath(repository));
    });

    test("resolves a linked Git worktree whose .git is a file", async () => {
        const repository = join(root, "repository");
        const worktree = join(root, "linked-worktree");
        await mkdir(repository);
        await git(repository, "init");
        await git(repository, "config", "user.email", "crest@example.com");
        await git(repository, "config", "user.name", "Crest Test");
        await git(repository, "commit", "--allow-empty", "-m", "initial");
        await git(repository, "worktree", "add", worktree);
        const child = join(worktree, "nested");
        await mkdir(child);

        const identity = await resolveCanonicalWorkspaceIdentity(child);

        expect(identity.canonicalRoot).toBe(await realpath(worktree));
    });

    test("canonicalizes non-Git and symlink workspace roots", async () => {
        const workspace = join(root, "workspace");
        const link = join(root, "workspace-link");
        await mkdir(workspace);
        await symlink(workspace, link, "dir");

        const direct = await resolveCanonicalWorkspaceIdentity(workspace);
        const linked = await resolveCanonicalWorkspaceIdentity(link);

        expect(linked.canonicalRoot).toBe(await realpath(workspace));
        expect(linked.workspaceIdentity).toBe(direct.workspaceIdentity);
        expect(linked.workspaceIncarnation).toBe(direct.workspaceIncarnation);
    });

    test("registers one stable incarnation atomically for concurrent callers", async () => {
        const workspace = join(root, "workspace");
        await mkdir(workspace);

        const identities = await Promise.all(
            Array.from({ length: 12 }, () => resolveCanonicalWorkspaceIdentity(workspace))
        );

        expect(new Set(identities.map((identity) => identity.workspaceIncarnation))).toHaveLength(1);
    });

    test("keeps identity but changes incarnation after a workspace is deleted and recreated", async () => {
        const workspace = join(root, "workspace");
        await mkdir(workspace);
        const original = await resolveCanonicalWorkspaceIdentity(workspace);
        await rm(workspace, { recursive: true });
        await mkdir(workspace);

        const recreated = await resolveCanonicalWorkspaceIdentity(workspace);

        expect(recreated.workspaceIdentity).toBe(original.workspaceIdentity);
        expect(recreated.workspaceIncarnation).not.toBe(original.workspaceIncarnation);
    });

    test("stores the nonce registry outside the workspace", async () => {
        const workspace = join(root, "workspace");
        await mkdir(workspace);

        await resolveCanonicalWorkspaceIdentity(workspace);

        await expect(realpath(join(workspace, ".crest"))).rejects.toThrow();
        await expect(realpath(join(root, "crest-data"))).resolves.toBe(await realpath(join(root, "crest-data")));
    });

    test("fails closed when the filesystem reports an unreliable root file identity", async () => {
        const workspace = join(root, "workspace");
        await mkdir(workspace);
        vi.resetModules();
        vi.doMock("node:fs/promises", async () => {
            const actual = await vi.importActual<typeof fsPromises>("node:fs/promises");
            return {
                ...actual,
                stat: async (...args: Parameters<typeof actual.stat>) => {
                    const result = await actual.stat(...args);
                    if (typeof result.ino !== "bigint") {
                        return result;
                    }
                    return new Proxy(result, {
                        get(target, property, receiver) {
                            if (property === "ino") {
                                return 0n;
                            }
                            return Reflect.get(target, property, receiver);
                        },
                    });
                },
            };
        });
        try {
            const isolatedModule = await import("./workspace-identity");

            await expect(isolatedModule.resolveCanonicalWorkspaceIdentity(workspace)).rejects.toThrow(
                /reliable root file identity/
            );
        } finally {
            vi.doUnmock("node:fs/promises");
            vi.resetModules();
        }
    });

    test("fails closed when the workspace filesystem capability is unknown", async () => {
        const workspace = join(root, "workspace");
        await mkdir(workspace);
        vi.resetModules();
        vi.doMock("node:fs/promises", async () => {
            const actual = await vi.importActual<typeof fsPromises>("node:fs/promises");
            return {
                ...actual,
                statfs: async () => ({
                    type: 0x6969n,
                }),
            };
        });
        try {
            const isolatedModule = await import("./workspace-identity");

            await expect(isolatedModule.resolveCanonicalWorkspaceIdentity(workspace)).rejects.toThrow(
                /unsupported workspace filesystem/
            );
        } finally {
            vi.doUnmock("node:fs/promises");
            vi.resetModules();
        }
    });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
    await execFileAsync("git", args, {
        cwd,
        env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
        },
    });
}
