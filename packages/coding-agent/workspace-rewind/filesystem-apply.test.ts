// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
    link,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    readlink,
    rename,
    stat,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
    WorkspacePathApplyError,
    type WorkspacePathApplyProgress,
    applyCapturedPath,
    deriveWorkspaceApplyArtifactPaths,
    verifyCapturedPath,
    workspaceFilesystemApplyPlatformSupport,
} from "./filesystem-apply";
import type { CapturedPathStateV1 } from "./types";

const AbsentState = { state: "absent" } as const;

function oid(bytes: Buffer): string {
    return createHash("sha1")
        .update(Buffer.from(`blob ${bytes.length}\0`))
        .update(bytes)
        .digest("hex");
}

function fileState(bytes: Buffer | string, executable = false): CapturedPathStateV1 {
    const value = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    return { state: "file", oid: oid(value), executable };
}

function symlinkState(bytes: Buffer | string): CapturedPathStateV1 {
    const value = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    return { state: "symlink", oid: oid(value) };
}

function progress(operationId = "operation-1"): WorkspacePathApplyProgress {
    return {
        operationId,
        createdParentDirectories: new Set(),
        onPathReplaced: vi.fn(async () => {}),
    };
}

function blobReader(entries: Buffer[]) {
    const blobs = new Map(entries.map((bytes) => [oid(bytes), bytes]));
    return async (key: string) => {
        const value = blobs.get(key);
        if (!value) {
            throw new Error(`missing blob ${key}`);
        }
        return value;
    };
}

async function makeRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "crest-filesystem-apply-"));
}

describe("workspace filesystem apply", () => {
    it("writes exact text and binary file bytes and executable mode", async () => {
        const root = await makeRoot();
        const text = Buffer.from("#!/bin/sh\necho ok\n");
        const binary = Buffer.from([0, 255, 1, 128, 2]);
        const applyProgress = progress();

        await applyCapturedPath({
            root,
            path: "src/run.sh",
            expectedCurrent: AbsentState,
            target: { state: "file", oid: oid(text), executable: true },
            readBlob: blobReader([text, binary]),
            progress: applyProgress,
        });
        await applyCapturedPath({
            root,
            path: "asset.bin",
            expectedCurrent: AbsentState,
            target: { state: "file", oid: oid(binary), executable: false },
            readBlob: blobReader([text, binary]),
            progress: applyProgress,
        });

        expect(await readFile(join(root, "src/run.sh"))).toEqual(text);
        expect((await stat(join(root, "src/run.sh"))).mode & 0o111).not.toBe(0);
        expect(await readFile(join(root, "asset.bin"))).toEqual(binary);
        expect((await stat(join(root, "asset.bin"))).mode & 0o111).toBe(0);
        expect(await readdir(join(root, "src"))).toEqual(["run.sh"]);
        expect(applyProgress.onPathReplaced).toHaveBeenNthCalledWith(1, "src/run.sh");
        expect(applyProgress.onPathReplaced).toHaveBeenNthCalledWith(2, "asset.bin");
    });

    it("rejects non-SHA-1 object ids before reading a blob", async () => {
        const root = await makeRoot();
        const readBlob = vi.fn(async () => Buffer.from("unreachable"));

        await expect(
            applyCapturedPath({
                root,
                path: "file",
                expectedCurrent: AbsentState,
                target: { state: "file", oid: "a".repeat(64), executable: false },
                readBlob,
                progress: progress(),
            })
        ).rejects.toThrow(/SHA-1|object id/i);
        expect(readBlob).not.toHaveBeenCalled();
    });

    it("replaces files through an exclusive same-parent prepared object with no residue", async () => {
        const root = await makeRoot();
        const bytes = Buffer.from("new");
        await writeFile(join(root, "file"), "old");

        await applyCapturedPath({
            root,
            path: "file",
            expectedCurrent: fileState("old"),
            target: { state: "file", oid: oid(bytes), executable: false },
            readBlob: blobReader([bytes]),
            progress: progress("../unsafe / id"),
        });

        expect(await readFile(join(root, "file"), "utf8")).toBe("new");
        expect(await readdir(root)).toEqual(["file"]);
    });

    it("rejects bytes that differ from the caller-confirmed current state before any side effect", async () => {
        const root = await makeRoot();
        const expected = Buffer.from("confirmed");
        const thirdParty = Buffer.from("third party");
        const target = Buffer.from("target");
        await writeFile(join(root, "file"), thirdParty);
        const applyProgress = progress();

        await expect(
            applyCapturedPath({
                root,
                path: "file",
                expectedCurrent: { state: "file", oid: oid(expected), executable: false },
                target: { state: "file", oid: oid(target), executable: false },
                readBlob: blobReader([target]),
                progress: applyProgress,
            })
        ).rejects.toThrow(/changed|expected|confirmed/i);

        expect(await readFile(join(root, "file"))).toEqual(thirdParty);
        expect(applyProgress.createdParentDirectories).toEqual(new Set());
        expect(applyProgress.onPathReplaced).not.toHaveBeenCalled();
        expect(await readdir(root)).toEqual(["file"]);
    });

    it("writes exact symlink bytes through a same-parent prepared symlink", async () => {
        const root = await makeRoot();
        const targetBytes = Buffer.from("../target");
        await writeFile(join(root, "link"), "old");

        await applyCapturedPath({
            root,
            path: "link",
            expectedCurrent: fileState("old"),
            target: { state: "symlink", oid: oid(targetBytes) },
            readBlob: blobReader([targetBytes]),
            progress: progress(),
        });

        expect(Buffer.from(await readlink(join(root, "link"), { encoding: "buffer" }))).toEqual(targetBytes);
        expect(await readdir(root)).toEqual(["link"]);
    });

    it("deletes only regular files and leaf symlinks and treats absence as idempotent", async () => {
        const root = await makeRoot();
        await writeFile(join(root, "file"), "old");
        await symlink("file", join(root, "link"));
        const applyProgress = progress();

        for (const path of ["file", "link", "missing"]) {
            await applyCapturedPath({
                root,
                path,
                expectedCurrent:
                    path === "file" ? fileState("old") : path === "link" ? symlinkState("file") : AbsentState,
                target: { state: "absent" },
                readBlob: blobReader([]),
                progress: applyProgress,
            });
        }

        await expect(lstat(join(root, "file"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(join(root, "link"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(applyProgress.onPathReplaced).toHaveBeenCalledTimes(2);
    });

    it("does not create missing parent directories while applying an absent target", async () => {
        const root = await makeRoot();
        const applyProgress = progress();

        await applyCapturedPath({
            root,
            path: "missing/parent/file",
            expectedCurrent: AbsentState,
            target: { state: "absent" },
            readBlob: blobReader([]),
            progress: applyProgress,
        });

        await expect(lstat(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(applyProgress.createdParentDirectories).toEqual(new Set());
        expect(applyProgress.onPathReplaced).not.toHaveBeenCalled();
    });

    it("creates missing parents one layer at a time and records only operation-created paths", async () => {
        const root = await makeRoot();
        const bytes = Buffer.from("nested");
        await mkdir(join(root, "existing"));
        const applyProgress = progress();

        await applyCapturedPath({
            root,
            path: "existing/a/b/file",
            expectedCurrent: AbsentState,
            target: { state: "file", oid: oid(bytes), executable: false },
            readBlob: blobReader([bytes]),
            progress: applyProgress,
        });

        expect(applyProgress.createdParentDirectories).toEqual(new Set(["existing/a", "existing/a/b"]));
        expect(await readFile(join(root, "existing/a/b/file"))).toEqual(bytes);
    });

    it("rolls back only newly-created parents that remain empty after a failed replacement", async () => {
        const root = await makeRoot();
        const bytes = Buffer.from("content");
        await mkdir(join(root, "existing"));
        const tooLong = "x".repeat(300);

        await expect(
            applyCapturedPath({
                root,
                path: `existing/created/${tooLong}`,
                expectedCurrent: AbsentState,
                target: { state: "file", oid: oid(bytes), executable: false },
                readBlob: blobReader([bytes]),
                progress: progress(),
            })
        ).rejects.toThrow();

        await expect(lstat(join(root, "existing/created"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(join(root, "existing"))).resolves.toMatchObject({});
    });

    it("preserves newly-created parents that become nonempty before rollback", async () => {
        const root = await makeRoot();
        const bytes = Buffer.from("content");
        const applyProgress = progress();

        await expect(
            applyCapturedPath({
                root,
                path: "created/parent/file",
                expectedCurrent: AbsentState,
                target: { state: "file", oid: oid(bytes), executable: false },
                readBlob: blobReader([bytes]),
                progress: applyProgress,
                testHooks: {
                    createUnmanagedChildBeforeFailure: true,
                    faultAt: "before-install",
                },
            })
        ).rejects.toThrow(/injected/i);

        expect(await readFile(join(root, "created/parent/unmanaged"), "utf8")).toBe("external");
        expect(applyProgress.createdParentDirectories).toEqual(new Set(["created", "created/parent"]));
    });

    it("rejects lexical escapes, symlink ancestors, and excluded targets", async () => {
        const root = await makeRoot();
        const outside = await makeRoot();
        await symlink(outside, join(root, "alias"));
        const bytes = Buffer.from("unsafe");

        for (const path of ["../outside", "/absolute", "a/../outside", "alias/file"]) {
            await expect(
                applyCapturedPath({
                    root,
                    path,
                    expectedCurrent: AbsentState,
                    target: { state: "file", oid: oid(bytes), executable: false },
                    readBlob: blobReader([bytes]),
                    progress: progress(),
                })
            ).rejects.toThrow();
        }
        await expect(
            applyCapturedPath({
                root,
                path: "ignored",
                expectedCurrent: AbsentState,
                target: { state: "excluded", reason: "ignored" },
                readBlob: blobReader([]),
                progress: progress(),
            })
        ).rejects.toThrow(/programming error/i);
        await expect(lstat(join(outside, "file"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.runIf(process.platform !== "win32")("rejects FIFO, socket, and device leaf entries", async () => {
        const root = await makeRoot();
        const pipe = join(root, "pipe");
        const socket = join(root, "socket");
        await makeFifo(pipe);
        const server = createServer();
        const socketAvailable = await new Promise<boolean>((resolve, reject) => {
            server.once("error", (error: NodeJS.ErrnoException) => {
                if (error.code === "EPERM") {
                    resolve(false);
                    return;
                }
                reject(error);
            });
            server.listen(socket, () => resolve(true));
        });
        const bytes = Buffer.from("replacement");

        try {
            const unsafePaths = socketAvailable ? ["pipe", "socket"] : ["pipe"];
            for (const path of unsafePaths) {
                await expect(
                    applyCapturedPath({
                        root,
                        path,
                        expectedCurrent: AbsentState,
                        target: { state: "file", oid: oid(bytes), executable: false },
                        readBlob: blobReader([bytes]),
                        progress: progress(),
                    })
                ).rejects.toThrow(/unsafe|block/i);
            }
            await expect(
                applyCapturedPath({
                    root: "/",
                    path: "dev/null",
                    expectedCurrent: AbsentState,
                    target: { state: "absent" },
                    readBlob: blobReader([]),
                    progress: progress(),
                })
            ).rejects.toThrow(/unsafe|block/i);
        } finally {
            if (socketAvailable) {
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        }
    });

    it("hard-blocks file-directory collisions, empty or nonempty directories, and unmanaged descendants", async () => {
        const root = await makeRoot();
        const bytes = Buffer.from("replacement");
        await mkdir(join(root, "empty"));
        await mkdir(join(root, "nonempty"));
        await writeFile(join(root, "nonempty/child"), "unmanaged");

        for (const path of ["empty", "nonempty"]) {
            await expect(
                applyCapturedPath({
                    root,
                    path,
                    expectedCurrent: AbsentState,
                    target: { state: "file", oid: oid(bytes), executable: false },
                    readBlob: blobReader([bytes]),
                    progress: progress(),
                })
            ).rejects.toThrow(/directory|collision|block/i);
            await expect(
                applyCapturedPath({
                    root,
                    path,
                    expectedCurrent: AbsentState,
                    target: { state: "absent" },
                    readBlob: blobReader([]),
                    progress: progress(),
                })
            ).rejects.toThrow(/directory|collision|block/i);
        }
        expect(await readFile(join(root, "nonempty/child"), "utf8")).toBe("unmanaged");
    });

    it("hard-blocks hard-linked regular files without changing either link", async () => {
        const root = await makeRoot();
        const bytes = Buffer.from("hard-linked");
        await writeFile(join(root, "file"), bytes);
        await link(join(root, "file"), join(root, "other"));

        await expect(
            applyCapturedPath({
                root,
                path: "file",
                expectedCurrent: fileState(bytes),
                target: { state: "absent" },
                readBlob: blobReader([]),
                progress: progress(),
            })
        ).rejects.toThrow(/hard-linked|blocked|unsafe/i);

        expect(await readFile(join(root, "file"))).toEqual(bytes);
        expect(await readFile(join(root, "other"))).toEqual(bytes);
    });

    it("rejects oversized blobs and unbounded operation ids before worker side effects", async () => {
        const root = await makeRoot();
        const oversized = Buffer.alloc(64 * 1024 ** 2 + 1);

        await expect(
            applyCapturedPath({
                root,
                path: "oversized",
                expectedCurrent: AbsentState,
                target: { state: "file", oid: "a".repeat(40), executable: false },
                readBlob: async () => oversized,
                progress: progress(),
            })
        ).rejects.toThrow(/single-file apply limit/i);
        await expect(
            applyCapturedPath({
                root,
                path: "operation",
                expectedCurrent: AbsentState,
                target: { state: "absent" },
                readBlob: blobReader([]),
                progress: progress("x".repeat(129)),
            })
        ).rejects.toThrow(/progress/i);
        expect(await readdir(root)).toEqual([]);
    });

    it("supports case-only replacement on case-insensitive filesystems", async () => {
        const root = await makeRoot();
        const bytes = Buffer.from("new");
        await writeFile(join(root, "Name"), "old");
        await writeFile(join(root, "name"), "probe");
        const entries = await readdir(root);
        if (entries.length !== 1) {
            return;
        }

        await applyCapturedPath({
            root,
            path: "NAME",
            expectedCurrent: fileState("probe"),
            target: { state: "file", oid: oid(bytes), executable: false },
            readBlob: blobReader([bytes]),
            progress: progress(),
        });

        expect(await readdir(root)).toEqual(["NAME"]);
        expect(await readFile(join(root, "NAME"))).toEqual(bytes);
    });

    it("restores original casing and leaves no hidden temp when case-only installation fails", async () => {
        const root = await makeRoot();
        const bytes = Buffer.from("new");
        await writeFile(join(root, "Name"), "old");

        await expect(
            applyCapturedPath({
                root,
                path: "NAME",
                expectedCurrent: fileState("old"),
                target: { state: "file", oid: oid(bytes), executable: false },
                readBlob: blobReader([bytes]),
                progress: progress(),
                testHooks: {
                    caseInsensitiveExistingName: "Name",
                    faultAt: "before-install",
                },
            })
        ).rejects.toThrow(/injected/i);

        expect(await readdir(root)).toEqual(["Name"]);
        expect(await readFile(join(root, "Name"), "utf8")).toBe("old");
    });

    it("fails verification after an ancestor swap without writing outside the workspace", async () => {
        const root = await makeRoot();
        const outside = await makeRoot();
        const held = join(root, "held");
        const bytes = Buffer.from("replacement");
        await mkdir(join(root, "parent"));
        await writeFile(join(root, "parent/file"), "inside");
        await writeFile(join(outside, "file"), "outside");

        await expect(
            applyCapturedPath({
                root,
                path: "parent/file",
                expectedCurrent: fileState("inside"),
                target: { state: "file", oid: oid(bytes), executable: false },
                readBlob: async () => {
                    await rename(join(root, "parent"), held);
                    await symlink(outside, join(root, "parent"));
                    return bytes;
                },
                progress: progress(),
            })
        ).rejects.toThrow(/changed|symlink|stable|block|no-follow/i);

        expect(await readFile(join(outside, "file"), "utf8")).toBe("outside");
        expect(await readFile(join(held, "file"), "utf8")).toBe("inside");
    });

    it.each([
        {
            label: "normal",
            target: (bytes: Buffer) => ({ state: "file" as const, oid: oid(bytes), executable: false }),
        },
        { label: "force", target: () => ({ state: "absent" as const }) },
    ])("never overwrites or deletes a leaf swapped after check in $label mode", async ({ target }) => {
        const root = await makeRoot();
        const original = Buffer.from("original");
        const replacement = Buffer.from("replacement");
        const external = Buffer.from("external-after-check");
        await writeFile(join(root, "file"), original);

        await expect(
            applyCapturedPath({
                root,
                path: "file",
                expectedCurrent: fileState(original),
                target: target(replacement),
                readBlob: blobReader([replacement]),
                progress: progress(),
                testHooks: { swapLeafAfterCheck: external },
            })
        ).rejects.toThrow(/identity|changed|race/i);

        expect(await readFile(join(root, "file"))).toEqual(external);
        expect((await readdir(root)).filter((entry) => entry.startsWith(".crest-rewind-"))).toEqual([]);
    });

    it("rejects a same-inode equal-length rewrite with restored mtime after leaf validation", async () => {
        const root = await makeRoot();
        const original = Buffer.from("original-content");
        const external = Buffer.from("external-content");
        const replacement = Buffer.from("replacement-data");
        const steps: string[] = [];
        expect(external.length).toBe(original.length);
        await writeFile(join(root, "file"), original);
        const fixedTime = new Date("2026-01-02T03:04:05.000Z");
        await utimes(join(root, "file"), fixedTime, fixedTime);

        await expect(
            applyCapturedPath({
                root,
                path: "file",
                expectedCurrent: fileState(original),
                target: { state: "file", oid: oid(replacement), executable: false },
                readBlob: blobReader([replacement]),
                progress: progress(),
                testHooks: {
                    rewriteLeafSameInodeAfterCheck: external,
                    onWorkerStep: async (step) => {
                        steps.push(step);
                    },
                },
            })
        ).rejects.toThrow(/content|changed|identity|quarantine/i);

        expect(await readFile(join(root, "file"))).toEqual(external);
        expect(steps).not.toContain("quarantine-cas");
        expect((await readdir(root)).filter((entry) => entry.startsWith(".crest-rewind-"))).toEqual([]);
    });

    it("rejects a leaf swapped between preflight inspection and worker validation", async () => {
        const root = await makeRoot();
        const original = Buffer.from("original");
        const external = Buffer.from("external-before-worker-check");
        const replacement = Buffer.from("replacement");
        await writeFile(join(root, "file"), original);

        await expect(
            applyCapturedPath({
                root,
                path: "file",
                expectedCurrent: fileState(original),
                target: { state: "file", oid: oid(replacement), executable: false },
                readBlob: blobReader([replacement]),
                progress: progress(),
                testHooks: { swapLeafBeforeValidation: external },
            })
        ).rejects.toThrow(/preflight|changed/i);

        expect(await readFile(join(root, "file"))).toEqual(external);
        expect((await readdir(root)).filter((entry) => entry.startsWith(".crest-rewind-"))).toEqual([]);
    });

    it("retains and reports quarantined bytes when exclusive restoration loses a race", async () => {
        const root = await makeRoot();
        const original = Buffer.from("original");
        const displaced = Buffer.from("displaced-external");
        const competitor = Buffer.from("new-external");
        const replacement = Buffer.from("replacement");
        await writeFile(join(root, "file"), original);
        let error: unknown;

        try {
            await applyCapturedPath({
                root,
                path: "file",
                expectedCurrent: fileState(original),
                target: { state: "file", oid: oid(replacement), executable: false },
                readBlob: blobReader([replacement]),
                progress: progress(),
                testHooks: {
                    swapLeafAfterCheck: displaced,
                    createLeafBeforeQuarantineRestore: competitor,
                },
            });
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(WorkspacePathApplyError);
        const [artifact] = (error as WorkspacePathApplyError).retainedArtifacts;
        expect(artifact).toBe(
            deriveWorkspaceApplyArtifactPaths({ operationId: "operation-1", path: "file" }).quarantine
        );
        expect(await readFile(join(root, "file"))).toEqual(competitor);
        expect(await readFile(join(root, artifact, "entry"))).toEqual(displaced);
    });

    it("derives every artifact path before side effects and fails closed on a deterministic collision", async () => {
        const root = await makeRoot();
        const operationId = "operation-artifacts";
        const path = "file";
        const first = deriveWorkspaceApplyArtifactPaths({ operationId, path });
        const second = deriveWorkspaceApplyArtifactPaths({ operationId, path });
        const other = deriveWorkspaceApplyArtifactPaths({ operationId, path: "other" });
        const original = Buffer.from("original");
        const replacement = Buffer.from("replacement");
        await writeFile(join(root, path), original);
        await mkdir(join(root, first.quarantine));
        await writeFile(join(root, first.quarantine, "marker"), "external");
        let error: unknown;

        expect(second).toEqual(first);
        expect(other).not.toEqual(first);
        expect(
            Object.values(first).every((artifact) =>
                /^\.crest-rewind-v1-(?:prepared-file|prepared-symlink|quarantine)-[0-9a-f]{40}$/.test(artifact)
            )
        ).toBe(true);

        try {
            await applyCapturedPath({
                root,
                path,
                expectedCurrent: fileState(original),
                target: { state: "file", oid: oid(replacement), executable: false },
                readBlob: blobReader([replacement]),
                progress: progress(operationId),
            });
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(WorkspacePathApplyError);
        expect((error as WorkspacePathApplyError).pathSideEffect).toBe(false);
        expect((error as WorkspacePathApplyError).artifactPaths).toEqual(Object.values(first));
        expect(await readFile(join(root, path))).toEqual(original);
        expect(await readFile(join(root, first.quarantine, "marker"), "utf8")).toBe("external");
    });

    it("reports deterministic artifact paths on typed preflight failures", async () => {
        const root = await makeRoot();
        const operationId = "operation-preflight";
        const path = "file";
        const expected = Object.values(deriveWorkspaceApplyArtifactPaths({ operationId, path }));
        const replacement = Buffer.from("replacement");
        await mkdir(join(root, path));
        let error: unknown;

        try {
            await applyCapturedPath({
                root,
                path,
                expectedCurrent: AbsentState,
                target: { state: "file", oid: oid(replacement), executable: false },
                readBlob: blobReader([replacement]),
                progress: progress(operationId),
            });
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(WorkspacePathApplyError);
        expect((error as WorkspacePathApplyError).artifactPaths).toEqual(expected);
    });

    it("rejects a rename-plus-symlink ancestor that points back to the same inode", async () => {
        const root = await makeRoot();
        const bytes = Buffer.from("replacement");
        await mkdir(join(root, "parent"));
        await writeFile(join(root, "parent/file"), "inside");

        await expect(
            applyCapturedPath({
                root,
                path: "parent/file",
                expectedCurrent: fileState("inside"),
                target: { state: "file", oid: oid(bytes), executable: false },
                readBlob: blobReader([bytes]),
                progress: progress(),
                testHooks: { replaceAncestorWithSymlinkToSameInode: true },
            })
        ).rejects.toThrow(/anchor|ancestor|symlink|namespace/i);

        expect(await readlink(join(root, "parent"))).toBe("held-parent");
        expect(await readFile(join(root, "held-parent/file"), "utf8")).toBe("inside");
        expect(
            (await readdir(join(root, "held-parent"))).filter((entry) => entry.startsWith(".crest-rewind-"))
        ).toEqual([]);
    });

    it("reports exact durable operation order before invoking the callback", async () => {
        const root = await makeRoot();
        const bytes = Buffer.from("ordered");
        const steps: string[] = [];
        const applyProgress = progress();
        vi.mocked(applyProgress.onPathReplaced).mockImplementation(async () => {
            steps.push("callback");
        });

        await applyCapturedPath({
            root,
            path: "file",
            expectedCurrent: AbsentState,
            target: { state: "file", oid: oid(bytes), executable: true },
            readBlob: blobReader([bytes]),
            progress: applyProgress,
            testHooks: {
                onWorkerStep: async (step) => {
                    steps.push(step);
                },
            },
        });

        expect(steps).toEqual([
            "exclusive-temp",
            "write",
            "chmod",
            "file-fsync",
            "exclusive-install",
            "parent-fsync",
            "callback",
        ]);
    });

    it("reports quarantine CAS only after exact validation and exposes the temporary absent stage", async () => {
        const root = await makeRoot();
        const original = Buffer.from("original");
        const replacement = Buffer.from("replacement");
        const steps: string[] = [];
        let observedAbsent = false;
        await writeFile(join(root, "file"), original);
        const applyProgress = progress();
        vi.mocked(applyProgress.onPathReplaced).mockImplementation(async () => {
            steps.push("callback");
        });

        await applyCapturedPath({
            root,
            path: "file",
            expectedCurrent: fileState(original),
            target: { state: "file", oid: oid(replacement), executable: false },
            readBlob: blobReader([replacement]),
            progress: applyProgress,
            testHooks: {
                pauseAfterQuarantineCas: true,
                onWorkerStep: async (step) => {
                    steps.push(step);
                    if (step === "quarantine-cas") {
                        observedAbsent = await lstat(join(root, "file"))
                            .then(() => false)
                            .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT");
                    }
                },
            },
        });

        expect(observedAbsent).toBe(true);
        expect(steps).toEqual([
            "exclusive-temp",
            "write",
            "chmod",
            "file-fsync",
            "quarantine-cas",
            "exclusive-install",
            "parent-fsync",
            "callback",
        ]);
    });

    it("wraps Windows, worker-header, and blob-integrity failures with deterministic artifact scope", async () => {
        const root = await makeRoot();
        const operationId = "operation-errors";
        const path = "file";
        const bytes = Buffer.from("replacement");
        const artifactPaths = Object.values(deriveWorkspaceApplyArtifactPaths({ operationId, path }));

        const attempts = [
            () =>
                applyCapturedPath({
                    root,
                    path,
                    expectedCurrent: AbsentState,
                    target: { state: "absent" as const },
                    readBlob: blobReader([]),
                    progress: progress(operationId),
                    testHooks: { platform: "win32" as const },
                }),
            () =>
                applyCapturedPath({
                    root,
                    path,
                    expectedCurrent: AbsentState,
                    target: { state: "file" as const, oid: oid(bytes), executable: false },
                    readBlob: blobReader([bytes]),
                    progress: progress(operationId),
                    testHooks: { swapLeafAfterCheck: Buffer.alloc(800 * 1024) },
                }),
            () =>
                applyCapturedPath({
                    root,
                    path,
                    expectedCurrent: AbsentState,
                    target: { state: "file" as const, oid: oid(bytes), executable: false },
                    readBlob: async () => Buffer.from("wrong"),
                    progress: progress(operationId),
                }),
        ];

        for (const attempt of attempts) {
            let error: unknown;
            try {
                await attempt();
            } catch (caught) {
                error = caught;
            }
            expect(error).toBeInstanceOf(WorkspacePathApplyError);
            expect((error as WorkspacePathApplyError).artifactPaths).toEqual(artifactPaths);
        }
    });

    it.each([
        ["file-fsync", false, false],
        ["parent-fsync", true, false],
        ["after-progress", true, true],
        ["malformed-stdout-after-progress", true, true],
    ] as const)("exposes progress when the worker fails at %s", async (faultAt, sideEffect, callbackExpected) => {
        const root = await makeRoot();
        const bytes = Buffer.from("fault");
        const applyProgress = progress();
        let error: unknown;

        try {
            await applyCapturedPath({
                root,
                path: "file",
                expectedCurrent: AbsentState,
                target: { state: "file", oid: oid(bytes), executable: false },
                readBlob: blobReader([bytes]),
                progress: applyProgress,
                testHooks: { faultAt },
            });
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(WorkspacePathApplyError);
        expect((error as WorkspacePathApplyError).pathSideEffect).toBe(sideEffect);
        expect(applyProgress.onPathReplaced).toHaveBeenCalledTimes(callbackExpected ? 1 : 0);
        if (sideEffect) {
            expect(await readFile(join(root, "file"))).toEqual(bytes);
        }
    });

    it("keeps durable replacement progress observable when the callback fails", async () => {
        const root = await makeRoot();
        const bytes = Buffer.from("callback");
        const applyProgress = progress();
        vi.mocked(applyProgress.onPathReplaced).mockRejectedValue(new Error("journal unavailable"));

        await expect(
            applyCapturedPath({
                root,
                path: "file",
                expectedCurrent: AbsentState,
                target: { state: "file", oid: oid(bytes), executable: false },
                readBlob: blobReader([bytes]),
                progress: applyProgress,
            })
        ).rejects.toMatchObject({
            pathSideEffect: true,
            pathDurable: true,
        });
        expect(applyProgress.onPathReplaced).toHaveBeenCalledWith("file");
        expect(await readFile(join(root, "file"))).toEqual(bytes);
    });

    it("keeps durable progress on post-write verification failure", async () => {
        const root = await makeRoot();
        const bytes = Buffer.from("verified");
        const applyProgress = progress();
        vi.mocked(applyProgress.onPathReplaced).mockImplementation(async (path) => {
            await writeFile(join(root, path), "changed-after-fsync");
        });

        await expect(
            applyCapturedPath({
                root,
                path: "file",
                expectedCurrent: AbsentState,
                target: { state: "file", oid: oid(bytes), executable: false },
                readBlob: blobReader([bytes]),
                progress: applyProgress,
            })
        ).rejects.toMatchObject({
            pathSideEffect: true,
            pathDurable: true,
        });
        expect(applyProgress.onPathReplaced).toHaveBeenCalledWith("file");
    });

    it("exposes an explicit typed Windows hard-block for reparse-point safety", () => {
        expect(workspaceFilesystemApplyPlatformSupport("win32")).toEqual({
            supported: false,
            code: "windows-reparse-unsupported",
        });
        expect(workspaceFilesystemApplyPlatformSupport("darwin")).toEqual({ supported: true });
        expect(workspaceFilesystemApplyPlatformSupport("linux")).toEqual({ supported: true });
    });

    it("verifies exact file, symlink, and absent states and rejects mismatches", async () => {
        const root = await makeRoot();
        const fileBytes = Buffer.from("file");
        const linkBytes = Buffer.from("file");
        await writeFile(join(root, "file"), fileBytes);
        await symlink("file", join(root, "link"));
        const states: Array<[string, CapturedPathStateV1]> = [
            ["file", { state: "file", oid: oid(fileBytes), executable: false }],
            ["link", { state: "symlink", oid: oid(linkBytes) }],
            ["missing", { state: "absent" }],
        ];

        for (const [path, expected] of states) {
            await expect(verifyCapturedPath({ root, path, expected })).resolves.toBeUndefined();
        }
        await expect(
            verifyCapturedPath({
                root,
                path: "file",
                expected: { state: "file", oid: "0".repeat(40), executable: false },
            })
        ).rejects.toThrow(/verification/i);
    });
});

async function makeFifo(path: string): Promise<void> {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
        execFile("/usr/bin/mkfifo", [path], (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}
