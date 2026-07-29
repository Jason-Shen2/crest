// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";

import { waitForChildProcess } from "../tools/_child-process";

const MaximumPaths = 4_096;
const MaximumInputBytes = 4 * 1024 * 1024;
const MaximumOutputBytes = 64 * 1024;

export async function removeCreatedWorkspaceDirectories(root: string, paths: readonly string[]): Promise<void> {
    const unique = [...new Set(paths)].sort(
        (left, right) => right.split("/").length - left.split("/").length || comparePathBytes(left, right)
    );
    if (unique.length > MaximumPaths || unique.some((path) => !isCanonicalRelativePath(path))) {
        throw new Error("Invalid created workspace directory cleanup");
    }
    const rootState = await lstat(root, { bigint: true });
    if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
        throw new Error("Workspace root is unsafe for directory cleanup");
    }
    const rootIdentity = identity(rootState);
    for (const path of unique) {
        await removeCreatedWorkspaceDirectory(root, rootIdentity, path);
    }
}

async function removeCreatedWorkspaceDirectory(
    root: string,
    rootIdentity: { dev: string; ino: string; birthtimeNs: string },
    path: string
): Promise<void> {
    const input = Buffer.from(JSON.stringify({ rootIdentity, path }));
    const child = spawn(process.execPath, ["-e", CleanupWorkerSource], {
        cwd: root,
        env: { ELECTRON_RUN_AS_NODE: "1", LC_ALL: "C" },
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr.on("data", (bytes: Buffer) => {
        stderrBytes += bytes.length;
        if (stderrBytes <= MaximumOutputBytes) {
            stderr.push(bytes);
        }
        if (stderrBytes > MaximumOutputBytes) {
            child.kill("SIGKILL");
        }
    });
    child.stdin.end(input);
    const exitCode = await waitForChildProcess(child);
    if (exitCode !== 0) {
        throw new Error(Buffer.concat(stderr).toString("utf8") || "Created workspace directory cleanup failed");
    }
}

function identity(state: { dev: bigint; ino: bigint; birthtimeNs: bigint }) {
    return {
        dev: state.dev.toString(),
        ino: state.ino.toString(),
        birthtimeNs: state.birthtimeNs.toString(),
    };
}

function isCanonicalRelativePath(path: string): boolean {
    return (
        path.length > 0 &&
        path.length <= 4_096 &&
        !path.includes("\0") &&
        !path.includes("\\") &&
        !path.startsWith("/") &&
        path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
}

function comparePathBytes(left: string, right: string): number {
    return Buffer.from(left).compare(Buffer.from(right));
}

const CleanupWorkerSource = String.raw`
"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");

function fail(message) {
    process.stderr.write(message);
    process.exit(1);
}

function identity(state) {
    return {
        dev: state.dev.toString(),
        ino: state.ino.toString(),
        birthtimeNs: state.birthtimeNs.toString(),
    };
}

function sameIdentity(state, expected) {
    const actual = identity(state);
    return actual.dev === expected.dev &&
        actual.ino === expected.ino &&
        actual.birthtimeNs === expected.birthtimeNs;
}

async function readInput() {
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
        total += chunk.length;
        if (total > ${MaximumInputBytes}) fail("cleanup input exceeds its limit");
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function syncCurrentDirectory() {
    const handle = await fsp.open(".", fs.constants.O_RDONLY);
    try {
        await handle.sync();
    } catch (error) {
        if (!["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes(error.code)) throw error;
    } finally {
        await handle.close();
    }
}

async function removePath(rootIdentity, path) {
    const root = await fsp.lstat(".", { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || !sameIdentity(root, rootIdentity)) {
        throw new Error("workspace root identity changed");
    }
    const segments = path.split("/");
    const stack = [{ name: "", identity: rootIdentity }];
    for (const segment of segments.slice(0, -1)) {
        const before = await fsp.lstat(segment, { bigint: true });
        if (!before.isDirectory() || before.isSymbolicLink()) {
            throw new Error("created directory ancestor is unsafe");
        }
        const expected = identity(before);
        process.chdir(segment);
        const anchored = await fsp.lstat(".", { bigint: true });
        const parent = await fsp.lstat("..", { bigint: true });
        const named = await fsp.lstat("../" + segment, { bigint: true });
        if (!sameIdentity(anchored, expected) ||
            !sameIdentity(parent, stack.at(-1).identity) ||
            named.isSymbolicLink() ||
            !sameIdentity(named, expected)) {
            throw new Error("created directory ancestor identity changed");
        }
        stack.push({ name: segment, identity: expected });
    }
    const leaf = segments.at(-1);
    let state;
    try {
        state = await fsp.lstat(leaf, { bigint: true });
    } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
    }
    if (!state.isDirectory() || state.isSymbolicLink()) {
        throw new Error("created directory leaf is unsafe");
    }
    try {
        await fsp.rmdir(leaf);
        await syncCurrentDirectory();
    } catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
    }
}

(async () => {
    const input = await readInput();
    if (!input || typeof input.path !== "string") {
        fail("invalid cleanup input");
    }
    await removePath(input.rootIdentity, input.path);
})().catch((error) => fail(String(error && error.message || error)));
`;
