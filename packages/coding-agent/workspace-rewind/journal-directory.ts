// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { waitForChildProcess } from "../tools/_child-process";

export interface AnchoredJournalDirectoryIdentity {
    dev: string;
    ino: string;
    birthtimeNs: string;
}

export interface AnchoredJournalEntry {
    name: string;
    bytes: Buffer;
    identity: AnchoredJournalDirectoryIdentity & {
        mode: string;
        nlink: string;
        size: string;
        mtimeNs: string;
        ctimeNs: string;
    };
}

const MaximumProtocolBytes = 96 * 1024 * 1024;

export async function readAnchoredJournalDirectory(input: {
    root: string;
    maximumEntries: number;
    maximumEntryBytes: number;
    maximumTotalBytes: number;
}): Promise<{ identity: AnchoredJournalDirectoryIdentity; entries: AnchoredJournalEntry[] } | undefined> {
    let state;
    try {
        state = await lstat(input.root, { bigint: true });
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
    if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077n) !== 0n) {
        throw new Error("Workspace recovery journal directory is unsafe");
    }
    const identity = directoryIdentity(state);
    const result = await runWorker(input.root, {
        type: "read",
        rootIdentity: identity,
        maximumEntries: input.maximumEntries,
        maximumEntryBytes: input.maximumEntryBytes,
        maximumTotalBytes: input.maximumTotalBytes,
    });
    const after = await lstat(input.root, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(after, identity)) {
        throw new Error("Workspace recovery journal directory changed while scanning");
    }
    if (!isReadResult(result, input)) {
        throw new Error("Workspace recovery journal reader returned invalid output");
    }
    return {
        identity,
        entries: result.entries.map((entry) => ({
            name: entry.name,
            bytes: Buffer.from(entry.bytesBase64, "base64"),
            identity: entry.identity,
        })),
    };
}

export async function readAnchoredJournalEntry(input: {
    root: string;
    name: string;
    maximumEntryBytes: number;
}): Promise<{ identity: AnchoredJournalDirectoryIdentity; entry: AnchoredJournalEntry | undefined } | undefined> {
    let state;
    try {
        state = await lstat(input.root, { bigint: true });
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
    if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077n) !== 0n) {
        throw new Error("Workspace recovery journal directory is unsafe");
    }
    const identity = directoryIdentity(state);
    const result = await runWorker(input.root, {
        type: "read-entry",
        rootIdentity: identity,
        name: input.name,
        maximumEntryBytes: input.maximumEntryBytes,
    });
    const after = await lstat(input.root, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(after, identity)) {
        throw new Error("Workspace recovery journal directory changed while reading entry");
    }
    if (!isNamedReadResult(result, input)) {
        throw new Error("Workspace recovery journal entry reader returned invalid output");
    }
    return {
        identity,
        entry:
            result.entry == null
                ? undefined
                : {
                      name: result.entry.name,
                      bytes: Buffer.from(result.entry.bytesBase64, "base64"),
                      identity: result.entry.identity,
                  },
    };
}

export async function inspectAnchoredJournalEntry(input: { root: string; name: string }): Promise<
    | {
          identity: AnchoredJournalDirectoryIdentity;
          entry: Pick<AnchoredJournalEntry, "name" | "identity"> | undefined;
      }
    | undefined
> {
    let state;
    try {
        state = await lstat(input.root, { bigint: true });
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
    }
    if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077n) !== 0n) {
        throw new Error("Workspace recovery journal directory is unsafe");
    }
    const identity = directoryIdentity(state);
    const result = await runWorker(input.root, {
        type: "inspect-entry",
        rootIdentity: identity,
        name: input.name,
    });
    const after = await lstat(input.root, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(after, identity)) {
        throw new Error("Workspace recovery journal directory changed while inspecting entry");
    }
    if (!isNamedEntryInspectionResult(result, input.name)) {
        throw new Error("Workspace recovery journal entry inspector returned invalid output");
    }
    return {
        identity,
        entry: result.entry == null ? undefined : result.entry,
    };
}

export async function readAnchoredJournalPublication(input: {
    root: string;
    destinationName: string;
    maximumEntryBytes: number;
}): Promise<{ identity: AnchoredJournalDirectoryIdentity; entry: AnchoredJournalEntry | undefined } | undefined> {
    return runPublicationWorker(input, "read-publication");
}

export async function recoverAnchoredJournalPublication(input: {
    root: string;
    destinationName: string;
    maximumEntryBytes: number;
}): Promise<{ identity: AnchoredJournalDirectoryIdentity; entry: AnchoredJournalEntry | undefined } | undefined> {
    return runPublicationWorker(input, "recover-publication");
}

export async function renameAnchoredJournalEntry(input: {
    root: string;
    rootIdentity: AnchoredJournalDirectoryIdentity;
    source: AnchoredJournalEntry;
    destinationName: string;
}): Promise<void> {
    const result = await runWorker(input.root, {
        type: "rename",
        rootIdentity: input.rootIdentity,
        sourceName: input.source.name,
        sourceIdentity: input.source.identity,
        destinationName: input.destinationName,
    });
    if (!isRecord(result) || result.ok !== true || Object.keys(result).length !== 1) {
        throw new Error("Workspace recovery journal rename returned invalid output");
    }
    const after = await lstat(input.root, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(after, input.rootIdentity)) {
        throw new Error("Workspace recovery journal directory changed during rename");
    }
}

export async function removeAnchoredJournalEntry(input: {
    root: string;
    rootIdentity: AnchoredJournalDirectoryIdentity;
    source: AnchoredJournalEntry;
}): Promise<void> {
    const result = await runWorker(input.root, {
        type: "remove",
        rootIdentity: input.rootIdentity,
        sourceName: input.source.name,
        sourceIdentity: input.source.identity,
    });
    if (!isRecord(result) || result.ok !== true || Object.keys(result).length !== 1) {
        throw new Error("Workspace recovery journal removal returned invalid output");
    }
}

export async function removeAnchoredJournalReservedArtifacts(input: {
    root: string;
    rootIdentity: AnchoredJournalDirectoryIdentity;
    maximumEntries: number;
}): Promise<void> {
    const result = await runWorker(input.root, {
        type: "remove-reserved-artifacts",
        rootIdentity: input.rootIdentity,
        maximumEntries: input.maximumEntries,
    });
    if (!isRecord(result) || result.ok !== true || Object.keys(result).length !== 1) {
        throw new Error("Workspace recovery journal reserved artifact cleanup returned invalid output");
    }
    const after = await lstat(input.root, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(after, input.rootIdentity)) {
        throw new Error("Workspace recovery journal directory changed during reserved artifact cleanup");
    }
}

export async function writeAnchoredJournalEntry(input: {
    root: string;
    rootIdentity: AnchoredJournalDirectoryIdentity;
    destinationName: string;
    bytes: Buffer;
    expectedDestination?: AnchoredJournalEntry;
    testFailAfterTemporarySync?: boolean;
}): Promise<void> {
    const result = await runWorker(input.root, {
        type: "write",
        rootIdentity: input.rootIdentity,
        destinationName: input.destinationName,
        bytesBase64: input.bytes.toString("base64"),
        expectedDestinationIdentity: input.expectedDestination?.identity,
        testFailAfterTemporarySync: input.testFailAfterTemporarySync === true,
    });
    if (!isRecord(result) || result.ok !== true || Object.keys(result).length !== 1) {
        throw new Error("Workspace recovery journal write returned invalid output");
    }
}

export async function ensureAnchoredJournalSubdirectory(input: {
    root: string;
    name: string;
}): Promise<AnchoredJournalDirectoryIdentity> {
    const state = await lstat(input.root, { bigint: true });
    if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077n) !== 0n) {
        throw new Error("Workspace recovery journal parent directory is unsafe");
    }
    const rootIdentity = directoryIdentity(state);
    const result = await runWorker(input.root, {
        type: "ensure-directory",
        rootIdentity,
        name: input.name,
    });
    if (!isRecord(result) || !isDirectoryIdentity(result.identity) || Object.keys(result).length !== 1) {
        throw new Error("Workspace recovery journal directory creation returned invalid output");
    }
    const after = await lstat(join(input.root, input.name), { bigint: true });
    if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        (after.mode & 0o077n) !== 0n ||
        !sameIdentity(after, result.identity)
    ) {
        throw new Error("Workspace recovery journal subdirectory changed while securing");
    }
    return result.identity;
}

export async function publishAnchoredJournalEntryNoReplace(input: {
    root: string;
    rootIdentity: AnchoredJournalDirectoryIdentity;
    destinationName: string;
    bytes: Buffer;
}): Promise<void> {
    const result = await runWorker(input.root, {
        type: "publish-no-replace",
        rootIdentity: input.rootIdentity,
        destinationName: input.destinationName,
        bytesBase64: input.bytes.toString("base64"),
    });
    if (!isRecord(result) || result.ok !== true || Object.keys(result).length !== 1) {
        throw new Error("Workspace recovery journal no-replace publication returned invalid output");
    }
}

async function runPublicationWorker(
    input: { root: string; destinationName: string; maximumEntryBytes: number },
    type: "read-publication" | "recover-publication"
): Promise<{ identity: AnchoredJournalDirectoryIdentity; entry: AnchoredJournalEntry | undefined } | undefined> {
    let state;
    try {
        state = await lstat(input.root, { bigint: true });
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
    if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077n) !== 0n) {
        throw new Error("Workspace recovery journal directory is unsafe");
    }
    const identity = directoryIdentity(state);
    const result = await runWorker(input.root, {
        type,
        rootIdentity: identity,
        destinationName: input.destinationName,
        maximumEntryBytes: input.maximumEntryBytes,
    });
    const after = await lstat(input.root, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(after, identity)) {
        throw new Error("Workspace recovery journal directory changed while recovering publication");
    }
    if (!isNamedReadResult(result, { name: input.destinationName, maximumEntryBytes: input.maximumEntryBytes })) {
        throw new Error("Workspace recovery journal publication worker returned invalid output");
    }
    return {
        identity,
        entry:
            result.entry == null
                ? undefined
                : {
                      name: result.entry.name,
                      bytes: Buffer.from(result.entry.bytesBase64, "base64"),
                      identity: result.entry.identity,
                  },
    };
}

async function runWorker(root: string, input: unknown): Promise<unknown> {
    const encoded = Buffer.from(JSON.stringify(input));
    const child = spawn(process.execPath, ["-e", JournalDirectoryWorkerSource], {
        cwd: root,
        env: { ELECTRON_RUN_AS_NODE: "1", LC_ALL: "C" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (bytes: Buffer) => {
        stdoutBytes += bytes.length;
        if (stdoutBytes <= MaximumProtocolBytes) {
            stdout.push(bytes);
        } else {
            child.kill("SIGKILL");
        }
    });
    child.stderr.on("data", (bytes: Buffer) => {
        stderrBytes += bytes.length;
        if (stderrBytes <= MaximumProtocolBytes) {
            stderr.push(bytes);
        }
    });
    child.stdin.end(encoded);
    const exitCode = await waitForChildProcess(child);
    if (exitCode !== 0 || stdoutBytes > MaximumProtocolBytes) {
        throw new Error(Buffer.concat(stderr).toString("utf8") || "Workspace recovery journal directory worker failed");
    }
    return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}

function isReadResult(
    value: unknown,
    limits: { maximumEntries: number; maximumEntryBytes: number; maximumTotalBytes: number }
): value is {
    entries: Array<{
        name: string;
        bytesBase64: string;
        identity: AnchoredJournalEntry["identity"];
    }>;
} {
    if (!isRecord(value) || !Array.isArray(value.entries) || value.entries.length > limits.maximumEntries) {
        return false;
    }
    let total = 0;
    return value.entries.every((entry) => {
        if (
            !isRecord(entry) ||
            typeof entry.name !== "string" ||
            typeof entry.bytesBase64 !== "string" ||
            !isEntryIdentity(entry.identity)
        ) {
            return false;
        }
        const bytes = Buffer.from(entry.bytesBase64, "base64");
        total += bytes.length;
        return (
            bytes.toString("base64") === entry.bytesBase64 &&
            bytes.length <= limits.maximumEntryBytes &&
            total <= limits.maximumTotalBytes
        );
    });
}

function isNamedReadResult(
    value: unknown,
    input: { name: string; maximumEntryBytes: number }
): value is {
    entry: {
        name: string;
        bytesBase64: string;
        identity: AnchoredJournalEntry["identity"];
    } | null;
} {
    if (!isRecord(value) || Object.keys(value).length !== 1 || !("entry" in value)) {
        return false;
    }
    if (value.entry === null) {
        return true;
    }
    if (
        !isRecord(value.entry) ||
        value.entry.name !== input.name ||
        typeof value.entry.bytesBase64 !== "string" ||
        !isEntryIdentity(value.entry.identity)
    ) {
        return false;
    }
    const bytes = Buffer.from(value.entry.bytesBase64, "base64");
    return bytes.toString("base64") === value.entry.bytesBase64 && bytes.length <= input.maximumEntryBytes;
}

function isNamedEntryInspectionResult(
    value: unknown,
    name: string
): value is { entry: Pick<AnchoredJournalEntry, "name" | "identity"> | null } {
    return (
        isRecord(value) &&
        Object.keys(value).length === 1 &&
        "entry" in value &&
        (value.entry === null ||
            (isRecord(value.entry) && value.entry.name === name && isEntryIdentity(value.entry.identity)))
    );
}

function isEntryIdentity(value: unknown): value is AnchoredJournalEntry["identity"] {
    if (!isRecord(value)) {
        return false;
    }
    const keys = ["birthtimeNs", "ctimeNs", "dev", "ino", "mode", "mtimeNs", "nlink", "size"];
    return (
        Object.keys(value).sort().join(",") === keys.sort().join(",") &&
        keys.every((key) => typeof value[key] === "string" && /^\d+$/.test(value[key]))
    );
}

function isDirectoryIdentity(value: unknown): value is AnchoredJournalDirectoryIdentity {
    if (!isRecord(value)) return false;
    const keys = ["birthtimeNs", "dev", "ino"];
    return (
        Object.keys(value).sort().join(",") === keys.sort().join(",") &&
        keys.every((key) => typeof value[key] === "string" && /^\d+$/.test(value[key]))
    );
}

function directoryIdentity(state: { dev: bigint; ino: bigint; birthtimeNs: bigint }) {
    return {
        dev: state.dev.toString(),
        ino: state.ino.toString(),
        birthtimeNs: state.birthtimeNs.toString(),
    };
}

function sameIdentity(
    state: { dev: bigint; ino: bigint; birthtimeNs: bigint },
    expected: AnchoredJournalDirectoryIdentity
): boolean {
    return (
        state.dev.toString() === expected.dev &&
        state.ino.toString() === expected.ino &&
        state.birthtimeNs.toString() === expected.birthtimeNs
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

const JournalDirectoryWorkerSource = String.raw`
"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const MAX_INPUT = ${MaximumProtocolBytes};

function identity(state) {
    return {
        dev: state.dev.toString(),
        ino: state.ino.toString(),
        birthtimeNs: state.birthtimeNs.toString(),
    };
}

function entryIdentity(state) {
    return {
        ...identity(state),
        mode: state.mode.toString(),
        nlink: state.nlink.toString(),
        size: state.size.toString(),
        mtimeNs: state.mtimeNs.toString(),
        ctimeNs: state.ctimeNs.toString(),
    };
}

function sameIdentity(state, expected) {
    const actual = identity(state);
    return actual.dev === expected.dev &&
        actual.ino === expected.ino &&
        actual.birthtimeNs === expected.birthtimeNs;
}

function sameEntry(state, expected) {
    const actual = entryIdentity(state);
    return Object.keys(expected).every((key) => actual[key] === expected[key]);
}

function validName(name) {
    return typeof name === "string" && name.length > 0 && name.length <= 255 &&
        name !== "." && name !== ".." && !/[\/\\\0]/.test(name);
}

function publicationTemporaryName(destinationName) {
    const temporaryName = "." + destinationName + ".publish.tmp";
    if (!validName(destinationName) || !validName(temporaryName)) {
        throw new Error("invalid journal publication name");
    }
    return temporaryName;
}

async function readInput() {
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
        total += chunk.length;
        if (total > MAX_INPUT) throw new Error("journal worker input limit exceeded");
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function assertRoot(expected) {
    const root = await fsp.lstat(".", { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 63n) !== 0n ||
        !sameIdentity(root, expected)) {
        throw new Error("journal root anchor changed");
    }
}

async function readEntry(name, maximumEntryBytes) {
    if (!validName(name)) throw new Error("invalid journal entry name");
    const before = await fsp.lstat(name, { bigint: true });
    return readEntryWithState(name, maximumEntryBytes, before);
}

async function readOptionalEntry(name, maximumEntryBytes) {
    if (!validName(name)) throw new Error("invalid journal entry name");
    let before;
    try {
        before = await fsp.lstat(name, { bigint: true });
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
    return readEntryWithState(name, maximumEntryBytes, before);
}

async function inspectOptionalEntry(name) {
    if (!validName(name)) throw new Error("invalid journal entry name");
    let state;
    try {
        state = await fsp.lstat(name, { bigint: true });
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
    if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1n || (state.mode & 63n) !== 0n) {
        throw new Error("unsafe journal entry: " + name);
    }
    return { name, identity: entryIdentity(state) };
}

async function lstatOptional(name) {
    try {
        return await fsp.lstat(name, { bigint: true });
    } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
    }
}

function safePrivateRegular(state, maximumEntryBytes, expectedNlink) {
    return state && state.isFile() && !state.isSymbolicLink() && state.nlink === expectedNlink &&
        (state.mode & 63n) === 0n && state.size <= BigInt(maximumEntryBytes);
}

function sameInode(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

async function readLinkedPublicationEntry(destinationName, temporaryName, maximumEntryBytes, beforeDestination) {
    const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK |
        (fs.constants.O_NOFOLLOW || 0);
    const handle = await fsp.open(destinationName, flags);
    try {
        const opened = await handle.stat({ bigint: true });
        if (!sameInode(opened, beforeDestination)) {
            throw new Error("journal publication changed");
        }
        const bytes = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        const namedDestination = await fsp.lstat(destinationName, { bigint: true });
        const namedTemporary = await lstatOptional(temporaryName);
        if (!sameEntry(after, entryIdentity(namedDestination)) || !sameInode(after, beforeDestination)) {
            throw new Error("journal publication changed");
        }
        if (namedTemporary) {
            if (!safePrivateRegular(after, maximumEntryBytes, 2n) ||
                !safePrivateRegular(namedTemporary, maximumEntryBytes, 2n) ||
                !sameInode(after, namedTemporary)) {
                throw new Error("journal publication changed");
            }
        } else if (!safePrivateRegular(after, maximumEntryBytes, 1n)) {
            throw new Error("journal publication changed");
        }
        return {
            name: destinationName,
            bytesBase64: bytes.toString("base64"),
            identity: entryIdentity(after),
        };
    } finally {
        await handle.close();
    }
}

async function readPublication(destinationName, maximumEntryBytes) {
    const temporaryName = publicationTemporaryName(destinationName);
    for (let attempt = 0; attempt < 4; attempt++) {
        const destination = await lstatOptional(destinationName);
        const temporary = await lstatOptional(temporaryName);
        if (!destination) {
            if (!temporary) return null;
            if (safePrivateRegular(temporary, maximumEntryBytes, 1n)) return null;
            if (safePrivateRegular(temporary, maximumEntryBytes, 2n)) continue;
            throw new Error("unsafe journal publication temporary entry");
        }
        if (!temporary) {
            if (safePrivateRegular(destination, maximumEntryBytes, 2n)) continue;
            return readEntryWithState(destinationName, maximumEntryBytes, destination);
        }
        if (!sameInode(destination, temporary)) {
            throw new Error("journal publication pair does not match");
        }
        if (!safePrivateRegular(destination, maximumEntryBytes, 2n) ||
            !safePrivateRegular(temporary, maximumEntryBytes, 2n)) {
            continue;
        }
        try {
            return await readLinkedPublicationEntry(
                destinationName,
                temporaryName,
                maximumEntryBytes,
                destination
            );
        } catch (error) {
            if (error.message !== "journal publication changed") throw error;
        }
    }
    throw new Error("journal publication changed while reading");
}

async function recoverPublication(destinationName, maximumEntryBytes, rootIdentity) {
    const temporaryName = publicationTemporaryName(destinationName);
    const destination = await lstatOptional(destinationName);
    const temporary = await lstatOptional(temporaryName);
    if (!destination && !temporary) return null;
    if (!destination) {
        if (!safePrivateRegular(temporary, maximumEntryBytes, 1n)) {
            throw new Error("unsafe journal publication temporary entry");
        }
        await fsp.unlink(temporaryName);
        await syncRoot();
        await assertRoot(rootIdentity);
        return null;
    }
    if (!temporary) {
        if (!safePrivateRegular(destination, maximumEntryBytes, 1n)) {
            throw new Error("unsafe journal publication destination entry");
        }
        await syncRoot();
        await assertRoot(rootIdentity);
        const recovered = await fsp.lstat(destinationName, { bigint: true });
        return readEntryWithState(destinationName, maximumEntryBytes, recovered);
    }
    if (!safePrivateRegular(destination, maximumEntryBytes, 2n) ||
        !safePrivateRegular(temporary, maximumEntryBytes, 2n) ||
        !sameInode(destination, temporary)) {
        throw new Error("unsafe journal publication pair does not match");
    }
    await fsp.unlink(temporaryName);
    await syncRoot();
    await assertRoot(rootIdentity);
    const recovered = await fsp.lstat(destinationName, { bigint: true });
    return readEntryWithState(destinationName, maximumEntryBytes, recovered);
}

async function readEntryWithState(name, maximumEntryBytes, before) {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
        (before.mode & 63n) !== 0n || before.size > BigInt(maximumEntryBytes)) {
        throw new Error("unsafe journal entry: " + name);
    }
    const expected = entryIdentity(before);
    const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK |
        (fs.constants.O_NOFOLLOW || 0);
    const handle = await fsp.open(name, flags);
    try {
        const opened = await handle.stat({ bigint: true });
        if (!sameEntry(opened, expected)) throw new Error("journal entry changed: " + name);
        const bytes = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        const named = await fsp.lstat(name, { bigint: true });
        if (!sameEntry(after, expected) || !sameEntry(named, expected)) {
            throw new Error("journal entry changed: " + name);
        }
        return { name, bytesBase64: bytes.toString("base64"), identity: expected };
    } finally {
        await handle.close();
    }
}

async function syncRoot() {
    const handle = await fsp.open(".", fs.constants.O_RDONLY);
    try {
        await handle.sync();
    } catch (error) {
        if (!["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes(error.code)) throw error;
    } finally {
        await handle.close();
    }
}

async function main() {
    const input = await readInput();
    await assertRoot(input.rootIdentity);
    if (input.type === "read") {
        const names = await fsp.readdir(".");
        if (names.length > input.maximumEntries) throw new Error("journal entry limit exceeded");
        const entries = [];
        let total = 0;
        for (const name of names.sort()) {
            const entry = await readEntry(name, input.maximumEntryBytes);
            total += Buffer.byteLength(entry.bytesBase64, "base64");
            if (total > input.maximumTotalBytes) throw new Error("journal byte limit exceeded");
            entries.push(entry);
        }
        await assertRoot(input.rootIdentity);
        return { entries };
    }
    if (input.type === "read-entry") {
        const entry = await readOptionalEntry(input.name, input.maximumEntryBytes);
        await assertRoot(input.rootIdentity);
        return { entry };
    }
    if (input.type === "inspect-entry") {
        const entry = await inspectOptionalEntry(input.name);
        await assertRoot(input.rootIdentity);
        return { entry };
    }
    if (input.type === "ensure-directory") {
        if (!validName(input.name)) throw new Error("invalid journal directory name");
        try {
            await fsp.mkdir(input.name, { mode: 448 });
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
        const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) |
            (fs.constants.O_NOFOLLOW || 0);
        const handle = await fsp.open(input.name, flags);
        try {
            const before = await handle.stat({ bigint: true });
            if (!before.isDirectory()) throw new Error("unsafe journal subdirectory");
            await handle.chmod(448);
            const after = await handle.stat({ bigint: true });
            if (!after.isDirectory() || !sameInode(before, after) || (after.mode & 63n) !== 0n) {
                throw new Error("journal subdirectory changed while securing");
            }
            await syncRoot();
            await assertRoot(input.rootIdentity);
            return { identity: identity(after) };
        } finally {
            await handle.close();
        }
    }
    if (input.type === "remove-reserved-artifacts") {
        if (!Number.isSafeInteger(input.maximumEntries) || input.maximumEntries < 1) {
            throw new Error("invalid journal cleanup entry limit");
        }
        const names = await fsp.readdir(".");
        if (names.length > input.maximumEntries) throw new Error("journal entry limit exceeded");
        for (const name of names.sort()) {
            if (!/^candidate-[0-9a-f]{32}\.cursor$/.test(name) && !/^\.[0-9a-f]{32}\.tmp$/.test(name)) {
                continue;
            }
            await fsp.unlink(name);
            await syncRoot();
            await assertRoot(input.rootIdentity);
        }
        await assertRoot(input.rootIdentity);
        return { ok: true };
    }
    if (input.type === "read-publication" || input.type === "recover-publication") {
        publicationTemporaryName(input.destinationName);
        const entry = input.type === "read-publication"
            ? await readPublication(input.destinationName, input.maximumEntryBytes)
            : await recoverPublication(input.destinationName, input.maximumEntryBytes, input.rootIdentity);
        await assertRoot(input.rootIdentity);
        return { entry };
    }
    if (input.type === "rename" || input.type === "remove") {
        if (!validName(input.sourceName) ||
            (input.type === "rename" && !validName(input.destinationName))) {
            throw new Error("invalid journal mutation name");
        }
        const source = await fsp.lstat(input.sourceName, { bigint: true });
        if (!source.isFile() || source.isSymbolicLink() || !sameEntry(source, input.sourceIdentity)) {
            throw new Error("journal mutation source changed");
        }
        if (input.type === "remove") {
            await fsp.unlink(input.sourceName);
            await syncRoot();
            await assertRoot(input.rootIdentity);
            return { ok: true };
        }
        try {
            await fsp.lstat(input.destinationName);
            throw new Error("journal rename destination exists");
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        await fsp.rename(input.sourceName, input.destinationName);
        await syncRoot();
        await assertRoot(input.rootIdentity);
        return { ok: true };
    }
    if (input.type === "write" || input.type === "publish-no-replace") {
        if (!validName(input.destinationName) || typeof input.bytesBase64 !== "string") {
            throw new Error("invalid journal write input");
        }
        const bytes = Buffer.from(input.bytesBase64, "base64");
        if (bytes.toString("base64") !== input.bytesBase64) {
            throw new Error("invalid journal write bytes");
        }
        let destination;
        try {
            destination = await fsp.lstat(input.destinationName, { bigint: true });
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        if (input.expectedDestinationIdentity) {
            if (!destination || !destination.isFile() || destination.isSymbolicLink() ||
                !sameEntry(destination, input.expectedDestinationIdentity)) {
                throw new Error("journal write destination changed");
            }
        } else if (destination) {
            throw new Error("journal write destination appeared");
        }
        const noReplace = input.type === "publish-no-replace";
        if (noReplace && input.expectedDestinationIdentity) {
            throw new Error("invalid journal no-replace publication input");
        }
        const temporary = noReplace
            ? publicationTemporaryName(input.destinationName)
            : "." + require("node:crypto").randomBytes(16).toString("hex") + ".tmp";
        const handle = await fsp.open(temporary, "wx", 384);
        try {
            await handle.writeFile(bytes);
            await handle.sync();
            await handle.close();
            if (input.testFailAfterTemporarySync) {
                throw new Error("injected journal failure after temporary sync");
            }
            if (!noReplace) {
                await fsp.rename(temporary, input.destinationName);
                await syncRoot();
                await assertRoot(input.rootIdentity);
            } else {
                await fsp.link(temporary, input.destinationName);
                await syncRoot();
                await assertRoot(input.rootIdentity);
                await fsp.unlink(temporary);
                await syncRoot();
                await assertRoot(input.rootIdentity);
            }
        } catch (error) {
            await handle.close().catch(() => {});
            if (!noReplace) {
                await fsp.unlink(temporary).catch(() => {});
                throw error;
            }
            try {
                await fsp.unlink(temporary);
                await syncRoot();
                await assertRoot(input.rootIdentity);
            } catch (cleanupError) {
                if (cleanupError.code !== "ENOENT") throw cleanupError;
            }
            throw error;
        }
        return { ok: true };
    }
    throw new Error("invalid journal worker operation");
}

main().then(
    (value) => process.stdout.write(JSON.stringify(value)),
    (error) => {
        process.stderr.write(String(error && error.message || error));
        process.exitCode = 1;
    }
);
`;
