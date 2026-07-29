// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

const SpawnMetrics = vi.hoisted(() => ({ active: 0, peak: 0, total: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
        ...actual,
        spawn: (...args: Parameters<typeof actual.spawn>) => {
            const child = actual.spawn(...args);
            SpawnMetrics.active++;
            SpawnMetrics.total++;
            SpawnMetrics.peak = Math.max(SpawnMetrics.peak, SpawnMetrics.active);
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                SpawnMetrics.active--;
            };
            child.once("exit", finish);
            child.once("error", finish);
            return child;
        },
    };
});

import { classifyLivePath, inspectLivePath, inspectLivePaths } from "./live-path-state";

const execFileAsync = promisify(execFile);

describe("live rewind path state", () => {
    it("captures files, executable bits, absent paths, directories, and leaf symlinks", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-live-path-"));
        await writeFile(join(root, "plain"), "hello");
        await writeFile(join(root, "exec"), "run");
        await chmod(join(root, "exec"), 0o755);
        await mkdir(join(root, "empty"));
        await symlink("plain", join(root, "link"));

        await expect(inspectLivePath(root, "plain")).resolves.toMatchObject({
            state: "file",
            executable: false,
        });
        await expect(inspectLivePath(root, "exec")).resolves.toMatchObject({
            state: "file",
            executable: true,
        });
        await expect(inspectLivePath(root, "missing")).resolves.toMatchObject({ state: "absent" });
        await expect(inspectLivePath(root, "empty")).resolves.toMatchObject({ state: "directory", empty: true });
        await expect(inspectLivePath(root, "link")).resolves.toMatchObject({ state: "symlink" });
    });

    it("blocks escapes and symlink ancestors without following them", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-live-path-"));
        await mkdir(join(root, "real"));
        await symlink("real", join(root, "alias"));

        await expect(inspectLivePath(root, "../outside")).resolves.toMatchObject({
            state: "blocked",
            reason: expect.stringContaining("path"),
        });
        await expect(inspectLivePath(root, "alias/file")).resolves.toMatchObject({
            state: "blocked",
            reason: expect.stringContaining("symlink"),
        });
    });

    it.runIf(process.platform !== "win32")("classifies a FIFO without waiting for a writer", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-live-path-"));
        await execFileAsync("/usr/bin/mkfifo", [join(root, "pipe")]);

        const result = await Promise.race([
            inspectLivePath(root, "pipe"),
            new Promise<never>((_resolve, reject) =>
                setTimeout(() => reject(new Error("FIFO inspection blocked")), 1_000)
            ),
        ]);

        expect(result).toMatchObject({ state: "unsafe", kind: "fifo" });
    });

    it.runIf(process.platform !== "win32")("never hashes outside bytes during an ancestor symlink swap", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-live-path-"));
        const outside = await mkdtemp(join(tmpdir(), "crest-live-path-outside-"));
        const parent = join(root, "parent");
        const held = join(root, "held");
        const outsideBytes = Buffer.from("outside-secret");
        await mkdir(parent);
        await writeFile(join(parent, "file"), "inside");
        await writeFile(join(outside, "file"), outsideBytes);
        const outsideOid = createHash("sha1")
            .update(Buffer.from(`blob ${outsideBytes.length}\0`))
            .update(outsideBytes)
            .digest("hex");

        const results = [];
        for (let index = 0; index < 8; index++) {
            const pending = inspectLivePath(root, "parent/file");
            await rename(parent, held);
            await symlink(outside, parent);
            results.push(await pending);
            await unlink(parent);
            await rename(held, parent);
        }

        expect(results.some((result) => result.state === "file" && result.oid === outsideOid)).toBe(false);
    });

    it.runIf(process.platform !== "win32")("does not block when a regular leaf becomes a FIFO", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-live-path-"));
        const path = join(root, "changing");
        await writeFile(path, Buffer.alloc(8 * 1024 * 1024, 1));
        const pending = inspectLivePath(root, "changing");
        await unlink(path);
        await execFileAsync("/usr/bin/mkfifo", [path]);

        const result = await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) =>
                setTimeout(() => reject(new Error("FIFO replacement blocked")), 1_000)
            ),
        ]);

        expect(["blocked", "unsafe"]).toContain(result.state);
    });

    it("batches many paths under one anchored parent into one worker", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-live-path-"));
        const paths = Array.from({ length: 64 }, (_, index) => `file-${index}`);
        await Promise.all(paths.map((path) => writeFile(join(root, path), path)));
        const before = SpawnMetrics.total;

        const states = await inspectLivePaths(root, paths);

        expect(states.size).toBe(paths.length);
        expect(SpawnMetrics.total - before).toBe(1);
    });

    it("bounds worker concurrency across many parent directories", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-live-path-"));
        const paths = Array.from({ length: 12 }, (_, index) => `parent-${index}/file`);
        for (const path of paths) {
            await mkdir(join(root, path, ".."));
            await writeFile(join(root, path), path);
        }
        SpawnMetrics.peak = SpawnMetrics.active;

        const states = await inspectLivePaths(root, paths);

        expect(states.size).toBe(paths.length);
        expect(SpawnMetrics.peak).toBeLessThanOrEqual(4);
    });

    it("rejects path-count and serialized-input limit violations before spawning", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-live-path-"));
        const before = SpawnMetrics.total;

        await expect(
            inspectLivePaths(
                root,
                Array.from({ length: 4_097 }, (_, index) => `file-${index}`)
            )
        ).rejects.toThrow(/path limit/i);
        await expect(
            inspectLivePaths(
                root,
                Array.from({ length: 4_096 }, (_, index) => `${index}-${"x".repeat(300)}`)
            )
        ).rejects.toThrow(/input limit/i);
        expect(SpawnMetrics.total).toBe(before);
    });

    it("classifies only regular-file content, mode, and presence drift as forceable", () => {
        const file = { state: "file" as const, oid: "a".repeat(40), executable: false };
        const changed = { state: "file" as const, oid: "b".repeat(40), executable: true, fingerprint: "changed" };

        expect(classifyLivePath({ live: changed, expected: file, target: { state: "absent" } })).toMatchObject({
            conflict: "forceable-drift",
            liveFingerprint: "changed",
        });
        expect(
            classifyLivePath({
                live: { state: "directory", empty: true, fingerprint: "directory" },
                expected: file,
                target: { state: "absent" },
            })
        ).toMatchObject({ conflict: "hard-blocker" });
        expect(
            classifyLivePath({
                live: { ...file, fingerprint: "same" },
                expected: file,
                target: { state: "absent" },
            })
        ).toEqual({ conflict: "none", liveFingerprint: "same" });
        expect(
            classifyLivePath({
                live: { state: "file", oid: file.oid, executable: true, fingerprint: "mode" },
                expected: file,
                target: { state: "absent" },
            }).conflict
        ).toBe("forceable-drift");
        expect(
            classifyLivePath({
                live: { state: "absent", fingerprint: "presence" },
                expected: file,
                target: { state: "absent" },
            }).conflict
        ).toBe("forceable-drift");
    });

    it.each([
        { state: "unsafe" as const, kind: "socket", fingerprint: "unsafe" },
        { state: "symlink" as const, oid: "b".repeat(40), fingerprint: "symlink" },
        { state: "blocked" as const, reason: "identity changed", fingerprint: "blocked" },
    ])("hard-blocks structurally unsafe live state $state", (live) => {
        expect(
            classifyLivePath({
                live,
                expected: { state: "file", oid: "a".repeat(40), executable: false },
                target: { state: "absent" },
            })
        ).toMatchObject({ conflict: "hard-blocker", liveFingerprint: live.fingerprint });
    });
});
