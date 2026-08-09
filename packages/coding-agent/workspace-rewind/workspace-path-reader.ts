// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";

import { waitForChildProcess } from "../tools/_child-process";
import { WorkspaceCheckpointInternalLimits } from "./internal-limits";
import { observeSafely } from "./observation";

export interface StablePathReaderIdentity {
    dev: string;
    ino: string;
    birthtimeNs: string;
}

export interface StablePathReaderEntryIdentity extends StablePathReaderIdentity {
    mode: string;
    nlink: string;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
}

export interface StablePathReaderEntry {
    path: string;
    name: string;
    kind: "file" | "symlink";
    identity: StablePathReaderEntryIdentity;
    stagingPath: string;
    previous?: StablePathReaderEntryIdentity & { oid: string };
}

export interface StablePathReaderResult {
    path: string;
    stagingPath?: string;
    reusedOid?: string;
    identity: StablePathReaderEntryIdentity;
    hashedBytes: number;
}

export interface StablePathReaderTestBarrier {
    path: string;
    openedMarker: string;
    releaseMarker: string;
}

export interface StablePathReaderBatchEntry extends StablePathReaderEntry {
    parentIdentity: StablePathReaderIdentity;
}

export interface StablePathReaderBatchHooks {
    workerStarted?(): void;
    workerSettled?(): void;
}

export type StablePathReaderGroupRunner = typeof runStablePathReader;

export class StablePathReaderError extends Error {
    readonly code: "aborted" | "timeout" | "capture_budget" | "unstable_file" | "worker_failed";

    constructor(code: StablePathReaderError["code"], message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "StablePathReaderError";
        this.code = code;
    }
}

const ReaderInputMaxBytes = 64 * 1024 ** 2;
const ReaderOutputMaxBytes = 64 * 1024 ** 2;
export const StablePathReaderConcurrency = 8;
export const StablePathReaderRacyWindowNs = 1_000_000_000n;

export function hasReusablePathIdentity(
    previous: StablePathReaderEntryIdentity | undefined,
    current: StablePathReaderEntryIdentity,
    nowMs: number
): boolean {
    if (
        !previous ||
        !["dev", "ino", "birthtimeNs", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
            (key) =>
                current[key as keyof StablePathReaderEntryIdentity] ===
                previous[key as keyof StablePathReaderEntryIdentity]
        )
    ) {
        return false;
    }
    if (
        BigInt(current.dev) <= 0n ||
        BigInt(current.ino) <= 0n ||
        BigInt(current.mtimeNs) <= 0n ||
        BigInt(current.ctimeNs) <= 0n
    ) {
        return false;
    }
    const newest =
        BigInt(current.mtimeNs) > BigInt(current.ctimeNs) ? BigInt(current.mtimeNs) : BigInt(current.ctimeNs);
    return BigInt(nowMs) * 1_000_000n - newest > StablePathReaderRacyWindowNs;
}

export async function runStablePathReaderBatch(
    input: {
        rootPath: string;
        entries: StablePathReaderBatchEntry[];
        maxSingleFileBytes: number;
        maxTotalBytes: number;
        timeoutMs: number;
        signal: AbortSignal;
        hooks?: StablePathReaderBatchHooks;
    },
    runGroup: StablePathReaderGroupRunner = runStablePathReader
): Promise<StablePathReaderResult[]> {
    if (input.entries.length === 0) return [];
    const entries = [...input.entries];
    for (const entry of entries) {
        if (basename(entry.path) !== entry.name) {
            throw new StablePathReaderError("worker_failed", "Stable path reader batch received an invalid path");
        }
    }
    const maximumBytes = entries.reduce((total, entry) => total + Number(entry.identity.size), 0);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes > input.maxTotalBytes) {
        throw new StablePathReaderError("capture_budget", "Stable path reader batch byte budget exceeded");
    }
    const groups = new Map<string, StablePathReaderBatchEntry[]>();
    for (const entry of entries) {
        const parent = dirname(entry.path) === "." ? "" : dirname(entry.path);
        const group = groups.get(parent) ?? [];
        group.push(entry);
        groups.set(parent, group);
    }
    const queue = [...groups.entries()];
    const results: StablePathReaderResult[] = [];
    const controller = new AbortController();
    const deadline = Date.now() + input.timeoutMs;
    const deadlineError = new StablePathReaderError("timeout", "Stable path reader batch timed out");
    const timer = setTimeout(() => controller.abort(deadlineError), input.timeoutMs);
    const onExternalAbort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", onExternalAbort, { once: true });
    if (input.signal.aborted) onExternalAbort();
    let cursor = 0;
    let firstFailure: unknown;
    const runWorker = async () => {
        try {
            while (cursor < queue.length) {
                const group = queue[cursor++]!;
                const [parent, groupEntries] = group;
                const remainingMs = deadline - Date.now();
                if (remainingMs <= 0) throw deadlineError;
                const parentIdentity = groupEntries[0]!.parentIdentity;
                if (
                    groupEntries.some(
                        (entry) =>
                            entry.parentIdentity.dev !== parentIdentity.dev ||
                            entry.parentIdentity.ino !== parentIdentity.ino ||
                            entry.parentIdentity.birthtimeNs !== parentIdentity.birthtimeNs
                    )
                ) {
                    throw new StablePathReaderError("unstable_file", "Stable path reader parent evidence conflicts");
                }
                observeSafely(input.hooks?.workerStarted);
                try {
                    results.push(
                        ...(await runGroup({
                            parentPath: parent ? join(input.rootPath, ...parent.split("/")) : input.rootPath,
                            parentIdentity,
                            entries: groupEntries,
                            maxSingleFileBytes: input.maxSingleFileBytes,
                            maxTotalBytes: input.maxTotalBytes,
                            timeoutMs: remainingMs,
                            signal: controller.signal,
                        }))
                    );
                } finally {
                    observeSafely(input.hooks?.workerSettled);
                }
            }
        } catch (error) {
            firstFailure ??= error;
            controller.abort(error);
        }
    };
    try {
        await Promise.allSettled(
            Array.from({ length: Math.min(StablePathReaderConcurrency, queue.length) }, () => runWorker())
        );
    } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onExternalAbort);
    }
    if (controller.signal.reason === deadlineError) throw deadlineError;
    if (firstFailure) throw firstFailure;
    return results.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

export async function runStablePathReader(input: {
    parentPath: string;
    parentIdentity: StablePathReaderIdentity;
    entries: StablePathReaderEntry[];
    maxSingleFileBytes: number;
    maxTotalBytes: number;
    timeoutMs: number;
    signal: AbortSignal;
    testBarrier?: StablePathReaderTestBarrier;
}): Promise<StablePathReaderResult[]> {
    const maxSingleFileBytes = Math.min(input.maxSingleFileBytes, WorkspaceCheckpointInternalLimits.maxSingleFileBytes);
    const encoded = Buffer.from(
        JSON.stringify({
            parentIdentity: input.parentIdentity,
            entries: input.entries,
            maxSingleFileBytes,
            maxTotalBytes: input.maxTotalBytes,
            nowMs: Date.now(),
            ...(input.testBarrier ? { testBarrier: input.testBarrier } : {}),
        })
    );
    if (encoded.length > ReaderInputMaxBytes) {
        throw new StablePathReaderError("capture_budget", "Stable path reader input budget exceeded");
    }
    if (input.signal.aborted) {
        throw new StablePathReaderError("aborted", "Stable path reader aborted");
    }
    const child = spawn(process.execPath, ["-e", StablePathReaderWorkerSource], {
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
    let terminalError: StablePathReaderError | undefined;
    const terminate = (code: "aborted" | "timeout" | "worker_failed", message: string) => {
        terminalError ??= new StablePathReaderError(code, message);
        child.kill("SIGKILL");
    };
    const onAbort = () => terminate("aborted", "Stable path reader aborted");
    const onStdout = (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > ReaderOutputMaxBytes) {
            terminate("worker_failed", "Stable path reader output exceeded its limit");
            return;
        }
        stdout.push(chunk);
    };
    const onStderr = (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= ReaderOutputMaxBytes) {
            stderr.push(chunk);
        }
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") {
            terminate("worker_failed", "Stable path reader input failed");
        }
    });
    input.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => terminate("timeout", "Stable path reader timed out"), input.timeoutMs);
    child.stdin.end(encoded);
    try {
        let exitCode;
        try {
            exitCode = await waitForChildProcess(child);
        } catch (cause) {
            if (terminalError) {
                throw terminalError;
            }
            throw new StablePathReaderError("worker_failed", "Stable path reader could not be started", { cause });
        }
        if (terminalError) {
            throw terminalError;
        }
        const diagnostic = Buffer.concat(stderr, Math.min(stderrBytes, ReaderOutputMaxBytes)).toString("utf8");
        if (exitCode !== 0) {
            if (diagnostic.startsWith("capture_budget:")) {
                throw new StablePathReaderError("capture_budget", diagnostic);
            }
            if (diagnostic.startsWith("unstable_file:")) {
                throw new StablePathReaderError("unstable_file", diagnostic);
            }
            throw new StablePathReaderError("worker_failed", diagnostic || `Stable path reader exited ${exitCode}`);
        }
        const value: unknown = JSON.parse(Buffer.concat(stdout, stdoutBytes).toString("utf8"));
        if (!isStablePathReaderResult(value, input.entries, maxSingleFileBytes)) {
            throw new StablePathReaderError("worker_failed", "Stable path reader returned an invalid result");
        }
        return value;
    } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onAbort);
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
    }
}

function isStablePathReaderResult(
    value: unknown,
    entries: StablePathReaderEntry[],
    maxSingleFileBytes: number
): value is StablePathReaderResult[] {
    if (!Array.isArray(value) || value.length !== entries.length) {
        return false;
    }
    return value.every((item, index) => {
        const expected = entries[index]!;
        if (item == null || typeof item !== "object") {
            return false;
        }
        const result = item as Partial<StablePathReaderResult>;
        const resultKeys = Object.keys(result).sort().join(",");
        if (
            resultKeys !== "hashedBytes,identity,path,reusedOid" &&
            resultKeys !== "hashedBytes,identity,path,stagingPath"
        ) {
            return false;
        }
        const identity = result.identity as Partial<StablePathReaderEntryIdentity> | undefined;
        const validIdentity =
            identity != null &&
            Object.keys(identity).sort().join(",") === "birthtimeNs,ctimeNs,dev,ino,mode,mtimeNs,nlink,size" &&
            ["dev", "ino", "birthtimeNs", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every((key) => {
                const value = identity[key as keyof StablePathReaderEntryIdentity];
                return (
                    typeof value === "string" &&
                    /^(0|[1-9][0-9]*)$/.test(value) &&
                    value === expected.identity[key as keyof StablePathReaderEntryIdentity]
                );
            });
        const hasStaging = result.stagingPath === expected.stagingPath && result.reusedOid == null;
        const hasReuse =
            result.stagingPath == null && result.reusedOid === expected.previous?.oid && result.hashedBytes === 0;
        return (
            result.path === expected.path &&
            validIdentity &&
            Number.isSafeInteger(result.hashedBytes) &&
            result.hashedBytes! >= 0 &&
            result.hashedBytes! <= maxSingleFileBytes &&
            (hasStaging || hasReuse)
        );
    });
}

const StablePathReaderWorkerSource = String.raw`
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const chunks = [];
let inputBytes = 0;
process.stdin.on("data", (chunk) => {
    inputBytes += chunk.length;
    if (inputBytes > ${ReaderInputMaxBytes}) {
        process.stderr.write("capture_budget:reader input");
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
function token(stat) {
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
async function workspaceSyscall(operation, action) {
    try {
        return await action();
    } catch (error) {
        const code = error && typeof error === "object" ? error.code : undefined;
        const pathnameRace = code === "ENOENT" || code === "ELOOP" || code === "ESTALE" || code === "ENOTDIR";
        const typeRace =
            (operation === "open" && code === "EISDIR") ||
            (operation === "readlink" && code === "EINVAL") ||
            (operation === "read" && code === "EISDIR");
        if (pathnameRace || typeRace) {
            throw new Error("unstable_file:" + operation + " observed a workspace pathname race");
        }
        throw error;
    }
}
function reusable(previous, current, nowMs) {
    if (!previous || !["dev", "ino", "birthtimeNs", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]
        .every((key) => current[key] === previous[key])) return false;
    if (BigInt(current.dev) <= 0n || BigInt(current.ino) <= 0n ||
        BigInt(current.mtimeNs) <= 0n || BigInt(current.ctimeNs) <= 0n) return false;
    const newest = BigInt(current.mtimeNs) > BigInt(current.ctimeNs)
        ? BigInt(current.mtimeNs)
        : BigInt(current.ctimeNs);
    return BigInt(nowMs) * 1000000n - newest > ${StablePathReaderRacyWindowNs}n;
}
async function writeBytes(path, bytes) {
    const output = await fsp.open(path, "wx", 0o600);
    try {
        await output.writeFile(bytes);
    } finally {
        await output.close();
    }
}
async function waitAtTestBarrier(input, entry) {
    const barrier = input.testBarrier;
    if (!barrier || barrier.path !== entry.path) return;
    await fsp.writeFile(barrier.openedMarker, "opened", { flag: "wx", mode: 0o600 });
    while (true) {
        try {
            await fsp.lstat(barrier.releaseMarker);
            return;
        } catch (error) {
            if (!error || error.code !== "ENOENT") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}
async function main(input) {
    const cwd = await workspaceSyscall("lstat", () => fsp.lstat(".", { bigint: true }));
    if (!cwd.isDirectory() || !same(token(cwd), input.parentIdentity)) {
        throw new Error("unstable_file:parent identity changed");
    }
    const results = [];
    let total = 0;
    for (const entry of input.entries) {
        if (!entry.name || entry.name === "." || entry.name === ".." || /[\/\\\0]/.test(entry.name)) {
            throw new Error("unstable_file:invalid leaf");
        }
        const before = await workspaceSyscall("lstat", () => fsp.lstat(entry.name, { bigint: true }));
        const beforeToken = token(before);
        if (!same(beforeToken, entry.identity)) {
            throw new Error("unstable_file:scope identity changed");
        }
        if (entry.kind === "symlink") {
            if (!before.isSymbolicLink()) throw new Error("unstable_file:leaf type changed");
            const bytes = await workspaceSyscall("readlink", () =>
                fsp.readlink(entry.name, { encoding: "buffer" })
            );
            const after = await workspaceSyscall("lstat", () => fsp.lstat(entry.name, { bigint: true }));
            if (!same(token(after), beforeToken)) throw new Error("unstable_file:symlink changed");
            if (bytes.length > input.maxSingleFileBytes || total + bytes.length > input.maxTotalBytes) {
                if (bytes.length > input.maxSingleFileBytes) {
                    throw new Error(
                        "capture_budget:" + entry.path + ": single-file limit " +
                        input.maxSingleFileBytes + " bytes"
                    );
                }
                throw new Error("capture_budget:total bytes");
            }
            await writeBytes(entry.stagingPath, bytes);
            total += bytes.length;
            results.push({
                path: entry.path,
                stagingPath: entry.stagingPath,
                identity: beforeToken,
                hashedBytes: bytes.length
            });
            continue;
        }
        if (!before.isFile() || before.nlink !== 1n) throw new Error("unstable_file:leaf type changed");
        const inputFile = await workspaceSyscall("open", () =>
            fsp.open(entry.name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
        );
        try {
            const opened = await workspaceSyscall("fstat", () => inputFile.stat({ bigint: true }));
            const openedToken = token(opened);
            if (!same(openedToken, beforeToken)) throw new Error("unstable_file:file changed before open");
            if (BigInt(openedToken.size) > BigInt(input.maxSingleFileBytes)) {
                throw new Error(
                    "capture_budget:" + entry.path + ": single-file limit " +
                    input.maxSingleFileBytes + " bytes"
                );
            }
            if (reusable(entry.previous, openedToken, input.nowMs)) {
                const after = await workspaceSyscall("fstat", () => inputFile.stat({ bigint: true }));
                const finalPath = await workspaceSyscall("lstat", () =>
                    fsp.lstat(entry.name, { bigint: true })
                );
                if (!same(token(after), openedToken) || !same(token(finalPath), openedToken)) {
                    throw new Error("unstable_file:file changed");
                }
                results.push({
                    path: entry.path,
                    reusedOid: entry.previous.oid,
                    identity: openedToken,
                    hashedBytes: 0
                });
                continue;
            }
            const size = Number(opened.size);
            if (total + size > input.maxTotalBytes) throw new Error("capture_budget:total bytes");
            const output = await fsp.open(entry.stagingPath, "wx", 0o600);
            try {
                await waitAtTestBarrier(input, entry);
                const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, size)));
                let offset = 0;
                while (offset < size) {
                    const read = await workspaceSyscall("read", () =>
                        inputFile.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
                    );
                    if (read.bytesRead === 0) throw new Error("unstable_file:short read");
                    await output.write(buffer, 0, read.bytesRead, offset);
                    offset += read.bytesRead;
                }
                const overflow = await workspaceSyscall("read", () =>
                    inputFile.read(Buffer.alloc(1), 0, 1, offset)
                );
                const after = await workspaceSyscall("fstat", () => inputFile.stat({ bigint: true }));
                const finalPath = await workspaceSyscall("lstat", () =>
                    fsp.lstat(entry.name, { bigint: true })
                );
                if (
                    overflow.bytesRead !== 0 ||
                    !same(token(after), openedToken) ||
                    !same(token(finalPath), openedToken)
                ) {
                    throw new Error("unstable_file:file changed during read");
                }
            } finally {
                await output.close();
            }
            total += size;
            results.push({
                path: entry.path,
                stagingPath: entry.stagingPath,
                identity: openedToken,
                hashedBytes: size
            });
        } finally {
            await inputFile.close();
        }
    }
    return results;
}
`;
