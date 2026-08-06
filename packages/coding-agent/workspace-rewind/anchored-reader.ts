// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";

import { waitForChildProcess } from "../tools/_child-process";
import { WorkspaceCheckpointInternalLimits } from "./internal-limits";

export interface AnchoredReaderIdentity {
    dev: string;
    ino: string;
    birthtimeNs: string;
}

export interface AnchoredReaderEntryIdentity extends AnchoredReaderIdentity {
    mode: string;
    nlink: string;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
}

export interface AnchoredReaderEntry {
    path: string;
    name: string;
    kind: "file" | "symlink";
    identity: AnchoredReaderEntryIdentity;
    stagingPath: string;
    previous?: AnchoredReaderEntryIdentity & { oid: string };
}

export interface AnchoredReaderResult {
    path: string;
    stagingPath?: string;
    reusedOid?: string;
    identity: AnchoredReaderEntryIdentity;
    hashedBytes: number;
}

export interface AnchoredReaderBatchEntry extends AnchoredReaderEntry {
    parentIdentity: AnchoredReaderIdentity;
}

export interface AnchoredReaderBatchHooks {
    workerStarted?(): void;
    workerSettled?(): void;
}

export type AnchoredReaderGroupRunner = typeof runAnchoredReader;

export class AnchoredReaderError extends Error {
    readonly code: "aborted" | "timeout" | "capture_budget" | "unstable_file" | "worker_failed";

    constructor(code: AnchoredReaderError["code"], message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "AnchoredReaderError";
        this.code = code;
    }
}

const ReaderInputMaxBytes = 64 * 1024 ** 2;
const ReaderOutputMaxBytes = 64 * 1024 ** 2;
export const IncrementalReaderConcurrency = 8;
export const AnchoredReaderRacyWindowNs = 1_000_000_000n;

export function hasReusableAnchoredIdentity(
    previous: AnchoredReaderEntryIdentity | undefined,
    current: AnchoredReaderEntryIdentity,
    nowMs: number
): boolean {
    if (
        !previous ||
        !["dev", "ino", "birthtimeNs", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
            (key) =>
                current[key as keyof AnchoredReaderEntryIdentity] === previous[key as keyof AnchoredReaderEntryIdentity]
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
    return BigInt(nowMs) * 1_000_000n - newest > AnchoredReaderRacyWindowNs;
}

export async function runAnchoredReaderBatch(
    input: {
        rootPath: string;
        entries: AnchoredReaderBatchEntry[];
        maxSingleFileBytes: number;
        maxTotalBytes: number;
        timeoutMs: number;
        signal: AbortSignal;
        hooks?: AnchoredReaderBatchHooks;
    },
    runGroup: AnchoredReaderGroupRunner = runAnchoredReader
): Promise<AnchoredReaderResult[]> {
    if (input.entries.length === 0) return [];
    const entries = [...input.entries];
    for (const entry of entries) {
        if (basename(entry.path) !== entry.name) {
            throw new AnchoredReaderError("worker_failed", "Anchored reader batch received an invalid path");
        }
    }
    const maximumBytes = entries.reduce((total, entry) => total + Number(entry.identity.size), 0);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes > input.maxTotalBytes) {
        throw new AnchoredReaderError("capture_budget", "Anchored reader batch byte budget exceeded");
    }
    const groups = new Map<string, AnchoredReaderBatchEntry[]>();
    for (const entry of entries) {
        const parent = dirname(entry.path) === "." ? "" : dirname(entry.path);
        const group = groups.get(parent) ?? [];
        group.push(entry);
        groups.set(parent, group);
    }
    const queue = [...groups.entries()];
    const results: AnchoredReaderResult[] = [];
    const controller = new AbortController();
    const deadline = Date.now() + input.timeoutMs;
    const deadlineError = new AnchoredReaderError("timeout", "Anchored reader batch timed out");
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
                    throw new AnchoredReaderError("unstable_file", "Anchored reader parent evidence conflicts");
                }
                input.hooks?.workerStarted?.();
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
                    input.hooks?.workerSettled?.();
                }
            }
        } catch (error) {
            firstFailure ??= error;
            controller.abort(error);
        }
    };
    try {
        await Promise.allSettled(
            Array.from({ length: Math.min(IncrementalReaderConcurrency, queue.length) }, () => runWorker())
        );
    } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onExternalAbort);
    }
    if (controller.signal.reason === deadlineError) throw deadlineError;
    if (firstFailure) throw firstFailure;
    return results.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

export async function runAnchoredReader(input: {
    parentPath: string;
    parentIdentity: AnchoredReaderIdentity;
    entries: AnchoredReaderEntry[];
    maxSingleFileBytes: number;
    maxTotalBytes: number;
    timeoutMs: number;
    signal: AbortSignal;
}): Promise<AnchoredReaderResult[]> {
    const maxSingleFileBytes = Math.min(input.maxSingleFileBytes, WorkspaceCheckpointInternalLimits.maxSingleFileBytes);
    const encoded = Buffer.from(
        JSON.stringify({
            parentIdentity: input.parentIdentity,
            entries: input.entries,
            maxSingleFileBytes,
            maxTotalBytes: input.maxTotalBytes,
            nowMs: Date.now(),
        })
    );
    if (encoded.length > ReaderInputMaxBytes) {
        throw new AnchoredReaderError("capture_budget", "Anchored reader input budget exceeded");
    }
    if (input.signal.aborted) {
        throw new AnchoredReaderError("aborted", "Anchored reader aborted");
    }
    const child = spawn(process.execPath, ["-e", AnchoredReaderWorkerSource], {
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
    let terminalError: AnchoredReaderError | undefined;
    const terminate = (code: "aborted" | "timeout" | "worker_failed", message: string) => {
        terminalError ??= new AnchoredReaderError(code, message);
        child.kill("SIGKILL");
    };
    const onAbort = () => terminate("aborted", "Anchored reader aborted");
    const onStdout = (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > ReaderOutputMaxBytes) {
            terminate("worker_failed", "Anchored reader output exceeded its limit");
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
            terminate("worker_failed", "Anchored reader input failed");
        }
    });
    input.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => terminate("timeout", "Anchored reader timed out"), input.timeoutMs);
    child.stdin.end(encoded);
    try {
        let exitCode;
        try {
            exitCode = await waitForChildProcess(child);
        } catch (cause) {
            if (terminalError) {
                throw terminalError;
            }
            throw new AnchoredReaderError("worker_failed", "Anchored reader could not be started", { cause });
        }
        if (terminalError) {
            throw terminalError;
        }
        const diagnostic = Buffer.concat(stderr, Math.min(stderrBytes, ReaderOutputMaxBytes)).toString("utf8");
        if (exitCode !== 0) {
            if (diagnostic.startsWith("capture_budget:")) {
                throw new AnchoredReaderError("capture_budget", diagnostic);
            }
            if (diagnostic.startsWith("unstable_file:")) {
                throw new AnchoredReaderError("unstable_file", diagnostic);
            }
            throw new AnchoredReaderError("worker_failed", diagnostic || `Anchored reader exited ${exitCode}`);
        }
        const value: unknown = JSON.parse(Buffer.concat(stdout, stdoutBytes).toString("utf8"));
        if (!isAnchoredReaderResult(value, input.entries, maxSingleFileBytes)) {
            throw new AnchoredReaderError("worker_failed", "Anchored reader returned an invalid result");
        }
        return value;
    } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onAbort);
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
    }
}

function isAnchoredReaderResult(
    value: unknown,
    entries: AnchoredReaderEntry[],
    maxSingleFileBytes: number
): value is AnchoredReaderResult[] {
    if (!Array.isArray(value) || value.length !== entries.length) {
        return false;
    }
    return value.every((item, index) => {
        const expected = entries[index]!;
        if (item == null || typeof item !== "object") {
            return false;
        }
        const result = item as Partial<AnchoredReaderResult>;
        const resultKeys = Object.keys(result).sort().join(",");
        if (
            resultKeys !== "hashedBytes,identity,path,reusedOid" &&
            resultKeys !== "hashedBytes,identity,path,stagingPath"
        ) {
            return false;
        }
        const identity = result.identity as Partial<AnchoredReaderEntryIdentity> | undefined;
        const validIdentity =
            identity != null &&
            Object.keys(identity).sort().join(",") === "birthtimeNs,ctimeNs,dev,ino,mode,mtimeNs,nlink,size" &&
            ["dev", "ino", "birthtimeNs", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every((key) => {
                const value = identity[key as keyof AnchoredReaderEntryIdentity];
                return (
                    typeof value === "string" &&
                    /^(0|[1-9][0-9]*)$/.test(value) &&
                    value === expected.identity[key as keyof AnchoredReaderEntryIdentity]
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

const AnchoredReaderWorkerSource = String.raw`
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
    return BigInt(nowMs) * 1000000n - newest > ${AnchoredReaderRacyWindowNs}n;
}
async function writeBytes(path, bytes) {
    const output = await fsp.open(path, "wx", 0o600);
    try {
        await output.writeFile(bytes);
    } finally {
        await output.close();
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
