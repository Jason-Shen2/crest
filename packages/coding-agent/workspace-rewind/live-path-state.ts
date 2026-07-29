// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { waitForChildProcess } from "../tools/_child-process";
import type { CapturedPathStateV1 } from "./types";

export type RewindConflictClass = "none" | "forceable-drift" | "hard-blocker";

export type LiveCapturedPathState =
    | { state: "absent"; fingerprint: string }
    | { state: "file"; oid: string; executable: boolean; fingerprint: string }
    | { state: "symlink"; oid: string; fingerprint: string }
    | { state: "directory"; empty: boolean; fingerprint: string }
    | { state: "unsafe"; kind: string; fingerprint: string }
    | { state: "blocked"; reason: string; fingerprint: string };

export interface LivePathClassification {
    conflict: RewindConflictClass;
    liveFingerprint: string;
    reason?: string;
}

const LiveInspectionMaxPaths = 4_096;
const LiveInspectionMaxInputBytes = 1024 * 1024;
const LiveInspectionMaxOutputBytes = 4 * 1024 * 1024;
const LiveInspectionMaxWorkers = 4;

function fingerprint(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function blocked(reason: string): LiveCapturedPathState {
    return { state: "blocked", reason, fingerprint: fingerprint(["blocked", reason]) };
}

function absent(): LiveCapturedPathState {
    return { state: "absent", fingerprint: fingerprint(["absent"]) };
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function directoryIdentity(state: BigIntStats): { dev: string; ino: string; birthtimeNs: string; ctimeNs: string } {
    return {
        dev: state.dev.toString(),
        ino: state.ino.toString(),
        birthtimeNs: state.birthtimeNs.toString(),
        ctimeNs: state.ctimeNs.toString(),
    };
}

function validateContainedPath(root: string, path: string): string | undefined {
    if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
        return undefined;
    }
    const segments = path.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        return undefined;
    }
    const absolute = resolve(root, ...segments);
    const fromRoot = relative(root, absolute);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        return undefined;
    }
    return absolute;
}

export async function inspectLivePath(root: string, path: string): Promise<LiveCapturedPathState> {
    const states = await inspectLivePaths(root, [path]);
    return states.get(path)!;
}

interface AnchoredInspectionGroup {
    parentPath: string;
    parentIdentity: { dev: string; ino: string; birthtimeNs: string; ctimeNs: string };
    paths: Array<{ path: string; name: string }>;
}

export async function inspectLivePaths(
    root: string,
    paths: readonly string[]
): Promise<ReadonlyMap<string, LiveCapturedPathState>> {
    if (paths.length > LiveInspectionMaxPaths) {
        throw new Error(`Live path inspection path limit exceeded: ${LiveInspectionMaxPaths}`);
    }
    if (new Set(paths).size !== paths.length) {
        throw new Error("Live path inspection paths must be unique");
    }
    if (Buffer.byteLength(JSON.stringify(paths)) > LiveInspectionMaxInputBytes) {
        throw new Error(`Live path inspection input limit exceeded: ${LiveInspectionMaxInputBytes}`);
    }
    const results = new Map<string, LiveCapturedPathState>();
    if (paths.length === 0) {
        return results;
    }
    if (process.platform === "win32") {
        for (const path of paths) {
            results.set(path, blocked("live path inspection is unavailable on this platform"));
        }
        return results;
    }
    const canonicalRoot = resolve(root);

    let rootState: BigIntStats;
    try {
        rootState = await lstat(canonicalRoot, { bigint: true });
        if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
            for (const path of paths) {
                results.set(path, blocked("workspace root is not a stable directory"));
            }
            return results;
        }
    } catch (error) {
        for (const path of paths) {
            results.set(path, blocked(`workspace root cannot be inspected: ${(error as Error).message}`));
        }
        return results;
    }

    const groups = new Map<string, AnchoredInspectionGroup>();
    for (const path of paths) {
        const absolute = validateContainedPath(canonicalRoot, path);
        if (!absolute) {
            results.set(path, blocked("path is not a canonical workspace-relative path"));
            continue;
        }
        const segments = path.split("/");
        let cursor = canonicalRoot;
        let preparationFailure: LiveCapturedPathState | undefined;
        for (const segment of segments.slice(0, -1)) {
            cursor = resolve(cursor, segment);
            try {
                const state = await lstat(cursor, { bigint: true });
                if (state.isSymbolicLink()) {
                    preparationFailure = blocked("path has a symlink ancestor");
                    break;
                }
                if (!state.isDirectory()) {
                    preparationFailure = blocked("path ancestor is not a directory");
                    break;
                }
            } catch (error) {
                preparationFailure = isMissing(error)
                    ? absent()
                    : blocked(`path ancestor cannot be inspected: ${(error as Error).message}`);
                break;
            }
        }
        if (preparationFailure) {
            results.set(path, preparationFailure);
            continue;
        }
        const parentPath = dirname(absolute);
        let parentState: BigIntStats;
        try {
            parentState = await lstat(parentPath, { bigint: true });
            if (!parentState.isDirectory() || parentState.isSymbolicLink()) {
                results.set(path, blocked("path parent is not a stable directory"));
                continue;
            }
        } catch (error) {
            results.set(
                path,
                isMissing(error) ? absent() : blocked(`path parent cannot be inspected: ${(error as Error).message}`)
            );
            continue;
        }
        const parentIdentity = directoryIdentity(parentState);
        const group = groups.get(parentPath);
        if (group && JSON.stringify(group.parentIdentity) !== JSON.stringify(parentIdentity)) {
            for (const item of group.paths) {
                results.set(item.path, blocked("path parent identity changed while preparing inspection"));
            }
            results.set(path, blocked("path parent identity changed while preparing inspection"));
            groups.delete(parentPath);
            continue;
        }
        if (group) {
            group.paths.push({ path, name: segments.at(-1)! });
            continue;
        }
        groups.set(parentPath, {
            parentPath,
            parentIdentity,
            paths: [{ path, name: segments.at(-1)! }],
        });
    }

    let totalOutputBytes = 0;
    await runBounded([...groups.values()], LiveInspectionMaxWorkers, async (group) => {
        try {
            const inspected = await inspectFromAnchoredParent({
                parentPath: group.parentPath,
                parentIdentity: group.parentIdentity,
                names: group.paths.map((item) => item.name),
            });
            totalOutputBytes += inspected.outputBytes;
            if (totalOutputBytes > LiveInspectionMaxOutputBytes) {
                throw new Error(`Live path inspection output limit exceeded: ${LiveInspectionMaxOutputBytes}`);
            }
            for (const item of group.paths) {
                const state = inspected.states.get(item.name)!;
                results.set(item.path, withFingerprint(state));
            }
        } catch (error) {
            for (const item of group.paths) {
                results.set(
                    item.path,
                    blocked(`path changed or became unreadable during inspection: ${(error as Error).message}`)
                );
            }
        }
    });
    return results;
}

function withFingerprint(state: AnchoredLivePathState): LiveCapturedPathState {
    if (state.state === "file") {
        return { ...state, fingerprint: fingerprint(["file", state.oid, state.executable]) };
    }
    if (state.state === "symlink") {
        return { ...state, fingerprint: fingerprint(["symlink", state.oid]) };
    }
    if (state.state === "directory") {
        return { ...state, fingerprint: fingerprint(["directory", state.empty]) };
    }
    if (state.state === "unsafe") {
        return { ...state, fingerprint: fingerprint(["unsafe", state.kind]) };
    }
    return absent();
}

async function runBounded<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T) => Promise<void>
): Promise<void> {
    let cursor = 0;
    const run = async () => {
        while (cursor < items.length) {
            const item = items[cursor++]!;
            await worker(item);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

type AnchoredLivePathState =
    | { state: "absent" }
    | { state: "file"; oid: string; executable: boolean }
    | { state: "symlink"; oid: string }
    | { state: "directory"; empty: boolean }
    | { state: "unsafe"; kind: string };

async function inspectFromAnchoredParent(input: {
    parentPath: string;
    parentIdentity: { dev: string; ino: string; birthtimeNs: string; ctimeNs: string };
    names: string[];
}): Promise<{ states: ReadonlyMap<string, AnchoredLivePathState>; outputBytes: number }> {
    const child = spawn(process.execPath, ["-e", AnchoredLivePathInspectorSource], {
        cwd: input.parentPath,
        env: {
            ELECTRON_RUN_AS_NODE: "1",
            LC_ALL: "C",
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > LiveInspectionMaxOutputBytes) {
            overflow = true;
            child.kill("SIGKILL");
            return;
        }
        stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= 64 * 1024) {
            stderr.push(chunk);
        }
    });
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const encoded = Buffer.from(JSON.stringify({ parentIdentity: input.parentIdentity, names: input.names }));
    if (encoded.length > LiveInspectionMaxInputBytes) {
        child.kill("SIGKILL");
        throw new Error(`Live path inspection input limit exceeded: ${LiveInspectionMaxInputBytes}`);
    }
    child.stdin.end(encoded);
    try {
        const exitCode = await waitForChildProcess(child);
        if (overflow) {
            throw new Error("anchored inspector output exceeded its limit");
        }
        if (exitCode !== 0) {
            const diagnostic = Buffer.concat(stderr, Math.min(stderrBytes, 64 * 1024)).toString("utf8");
            throw new Error(diagnostic || `anchored inspector exited ${exitCode}`);
        }
        const value: unknown = JSON.parse(Buffer.concat(stdout, stdoutBytes).toString("utf8"));
        if (!isAnchoredLivePathStateBatch(value, input.names)) {
            throw new Error("anchored inspector returned an invalid result");
        }
        return {
            states: new Map(value.map((item) => [item.name, item.value])),
            outputBytes: stdoutBytes,
        };
    } finally {
        clearTimeout(timer);
    }
}

function isAnchoredLivePathStateBatch(
    value: unknown,
    names: readonly string[]
): value is Array<{ name: string; value: AnchoredLivePathState }> {
    if (!Array.isArray(value) || value.length !== names.length) {
        return false;
    }
    return value.every(
        (item, index) =>
            item != null &&
            typeof item === "object" &&
            Object.keys(item).sort().join(",") === "name,value" &&
            item.name === names[index] &&
            isAnchoredLivePathState(item.value)
    );
}

function isAnchoredLivePathState(value: unknown): value is AnchoredLivePathState {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const state = value as Record<string, unknown>;
    if (state.state === "absent") {
        return Object.keys(state).length === 1;
    }
    if (state.state === "file") {
        return (
            Object.keys(state).sort().join(",") === "executable,oid,state" &&
            typeof state.oid === "string" &&
            /^[0-9a-f]{40}$/.test(state.oid) &&
            typeof state.executable === "boolean"
        );
    }
    if (state.state === "symlink") {
        return (
            Object.keys(state).sort().join(",") === "oid,state" &&
            typeof state.oid === "string" &&
            /^[0-9a-f]{40}$/.test(state.oid)
        );
    }
    if (state.state === "directory") {
        return Object.keys(state).sort().join(",") === "empty,state" && typeof state.empty === "boolean";
    }
    return (
        state.state === "unsafe" &&
        Object.keys(state).sort().join(",") === "kind,state" &&
        typeof state.kind === "string" &&
        ["block-device", "character-device", "fifo", "socket", "unknown"].includes(state.kind)
    );
}

const AnchoredLivePathInspectorSource = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const chunks = [];
let inputBytes = 0;
process.stdin.on("data", (chunk) => {
    inputBytes += chunk.length;
    if (inputBytes > ${LiveInspectionMaxInputBytes}) {
        process.stderr.write("anchored inspector input exceeded its limit");
        process.exit(2);
    }
    chunks.push(chunk);
});
process.stdin.on("end", () => {
    main(JSON.parse(Buffer.concat(chunks, inputBytes).toString("utf8"))).then(
        (value) => process.stdout.write(JSON.stringify(value)),
        (error) => {
            process.stderr.write(String(error && error.message ? error.message : error));
            process.exitCode = 1;
        }
    );
});
function parentToken(stat) {
    return {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        birthtimeNs: stat.birthtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString()
    };
}
function entryToken(stat) {
    return {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        birthtimeNs: stat.birthtimeNs.toString(),
        mode: stat.mode.toString(),
        nlink: stat.nlink.toString(),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString()
    };
}
function same(left, right) {
    return Object.keys(right).every((key) => left[key] === right[key]);
}
function kind(stat) {
    if (stat.isBlockDevice()) return "block-device";
    if (stat.isCharacterDevice()) return "character-device";
    if (stat.isFIFO()) return "fifo";
    if (stat.isSocket()) return "socket";
    return "unknown";
}
async function lstatLeaf(name) {
    try {
        return await fsp.lstat(name, { bigint: true });
    } catch (error) {
        if (error && error.code === "ENOENT") return undefined;
        throw error;
    }
}
async function main(input) {
    if (!input || typeof input !== "object" || !Array.isArray(input.names) ||
        input.names.length > ${LiveInspectionMaxPaths}) {
        throw new Error("invalid anchored inspector input");
    }
    const parent = await fsp.lstat(".", { bigint: true });
    if (!parent.isDirectory() || !same(parentToken(parent), input.parentIdentity)) {
        throw new Error("anchored parent identity changed");
    }
    const values = [];
    for (const name of input.names) {
        if (!name || name === "." || name === ".." || /[\/\\\0]/.test(name)) {
            throw new Error("invalid anchored inspector leaf");
        }
        values.push({ name, value: await inspectName(name, input.parentIdentity) });
    }
    return values;
}
async function inspectName(name, parentIdentity) {
    const before = await lstatLeaf(name);
    if (!before) return { state: "absent" };
    const beforeToken = entryToken(before);
    if (before.isSymbolicLink()) {
        const bytes = await fsp.readlink(name, { encoding: "buffer" });
        const after = await fsp.lstat(name, { bigint: true });
        if (!after.isSymbolicLink() || !same(entryToken(after), beforeToken)) {
            throw new Error("symlink changed during inspection");
        }
        const oid = crypto.createHash("sha1")
            .update(Buffer.from("blob " + bytes.length + "\0"))
            .update(bytes)
            .digest("hex");
        return { state: "symlink", oid };
    }
    if (!before.isFile() && !before.isDirectory()) {
        return { state: "unsafe", kind: kind(before) };
    }
    if (before.isFile() && before.nlink !== 1n) {
        throw new Error("hard-linked file is unsafe to restore");
    }
    if (before.isDirectory()) {
        process.chdir(name);
        const anchored = await fsp.lstat(".", { bigint: true });
        if (!anchored.isDirectory() || !same(entryToken(anchored), beforeToken)) {
            throw new Error("directory identity changed before inspection");
        }
        const directory = await fsp.opendir(".");
        const firstEntry = await directory.read();
        await directory.close();
        const after = await fsp.lstat(".", { bigint: true });
        if (!same(entryToken(after), beforeToken)) {
            throw new Error("directory changed during inspection");
        }
        const value = { state: "directory", empty: firstEntry == null };
        process.chdir("..");
        const restoredParent = await fsp.lstat(".", { bigint: true });
        if (!restoredParent.isDirectory() || !same(parentToken(restoredParent), parentIdentity)) {
            throw new Error("anchored parent identity changed");
        }
        return value;
    }
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    const handle = await fsp.open(name, flags);
    try {
        const opened = await handle.stat({ bigint: true });
        if (before.isFile() && !opened.isFile()) return { state: "unsafe", kind: kind(opened) };
        if (!same(entryToken(opened), beforeToken)) {
            throw new Error("leaf identity changed before inspection");
        }
        const hash = crypto.createHash("sha1").update(Buffer.from("blob " + opened.size + "\0"));
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        const after = await handle.stat({ bigint: true });
        const leafAfter = await fsp.lstat(name, { bigint: true });
        if (!same(entryToken(after), beforeToken) || !same(entryToken(leafAfter), beforeToken)) {
            throw new Error("file changed during inspection");
        }
        return {
            state: "file",
            oid: hash.digest("hex"),
            executable: (opened.mode & 73n) !== 0n
        };
    } finally {
        await handle.close();
    }
}
`;

function liveMatchesCaptured(live: LiveCapturedPathState, captured: CapturedPathStateV1): boolean {
    if (captured.state === "absent") {
        return live.state === "absent";
    }
    if (captured.state === "file") {
        return live.state === "file" && live.oid === captured.oid && live.executable === captured.executable;
    }
    if (captured.state === "symlink") {
        return live.state === "symlink" && live.oid === captured.oid;
    }
    return false;
}

export function classifyLivePath(input: {
    live: LiveCapturedPathState;
    expected: CapturedPathStateV1;
    target: CapturedPathStateV1;
}): LivePathClassification {
    const liveFingerprint = input.live.fingerprint;
    if (input.expected.state === "excluded" || input.target.state === "excluded") {
        return { conflict: "hard-blocker", liveFingerprint, reason: "path does not have complete snapshot coverage" };
    }
    if (input.live.state === "blocked") {
        return { conflict: "hard-blocker", liveFingerprint, reason: input.live.reason };
    }
    if (liveMatchesCaptured(input.live, input.expected)) {
        return { conflict: "none", liveFingerprint };
    }
    if (input.live.state === "unsafe") {
        return {
            conflict: "hard-blocker",
            liveFingerprint,
            reason: `path has unsafe live kind: ${input.live.kind}`,
        };
    }
    if (input.live.state === "directory") {
        return { conflict: "hard-blocker", liveFingerprint, reason: "path has a file-directory collision" };
    }
    if (input.live.state === "symlink" || input.expected.state === "symlink") {
        return { conflict: "hard-blocker", liveFingerprint, reason: "path has an unexpected symlink state" };
    }
    return {
        conflict: "forceable-drift",
        liveFingerprint,
        reason: "file changed on disk since the agent last wrote it",
    };
}
