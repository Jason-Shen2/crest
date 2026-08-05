// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
    type AnchoredJournalDirectoryIdentity,
    type AnchoredJournalEntry,
    ensureAnchoredJournalSubdirectory,
    readAnchoredJournalEntry,
    removeAnchoredJournalEntry,
    removeAnchoredJournalReservedArtifacts,
    writeAnchoredJournalEntry,
} from "./journal-directory";

const MaximumCursorBytes = 16 * 1024 * 1024;
const MaximumTrackerCleanupEntries = 1024;

export interface CursorSnapshotWriter {
    writeSnapshot(directory: string, snapshot: string): Promise<string>;
}

export interface WorkspaceChangeFeedStorageHooks {
    beforeAnchoredMutation?: (operation: "write" | "remove" | "commit" | "commit-publish") => void | Promise<void>;
}

export interface AnchoredWorkspaceCursor {
    name: string;
    bytes: Buffer;
    identity: AnchoredJournalEntry["identity"];
    hash: string;
    rootIdentity: AnchoredJournalDirectoryIdentity;
}

export async function ensurePrivateCursorRoot(root: string): Promise<AnchoredJournalDirectoryIdentity> {
    assertPrivateStoragePlatform();
    const parent = dirname(root);
    try {
        await mkdir(parent, { mode: 0o700 });
    } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    await securePrivateDirectory(parent);
    return ensureAnchoredJournalSubdirectory({ root: parent, name: basename(root) });
}

async function securePrivateDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
        const before = await handle.stat({ bigint: true });
        if (!before.isDirectory()) throw new Error("Unsafe workspace change cursor directory");
        await handle.chmod(0o700);
        const after = await handle.stat({ bigint: true });
        if (
            !after.isDirectory() ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.birthtimeNs !== after.birthtimeNs ||
            (after.mode & 0o077n) !== 0n
        ) {
            throw new Error("Workspace change cursor directory changed while securing");
        }
    } finally {
        await handle.close();
    }
}

export async function readAnchoredCursor(root: string, name: string): Promise<AnchoredWorkspaceCursor | undefined> {
    assertPrivateStoragePlatform();
    const result = await readAnchoredJournalEntry({ root, name, maximumEntryBytes: MaximumCursorBytes });
    if (!result?.entry) return undefined;
    return cursorFromEntry(result.identity, result.entry);
}

export async function readAnchoredCursorRootIdentity(
    root: string
): Promise<AnchoredJournalDirectoryIdentity | undefined> {
    assertPrivateStoragePlatform();
    return (
        await readAnchoredJournalEntry({
            root,
            name: `.probe-${randomBytes(8).toString("hex")}`,
            maximumEntryBytes: MaximumCursorBytes,
        })
    )?.identity;
}

export async function writeWatcherCursor(input: {
    root: string;
    name: string;
    workspaceRoot: string;
    writer: CursorSnapshotWriter;
    expectedRootIdentity?: AnchoredJournalDirectoryIdentity;
    hooks?: WorkspaceChangeFeedStorageHooks;
}): Promise<AnchoredWorkspaceCursor> {
    assertPrivateStoragePlatform();
    const staging = await makePrivateStagingDirectory();
    const stagingName = "snapshot.cursor";
    const stagingPath = join(staging, stagingName);
    try {
        await input.writer.writeSnapshot(input.workspaceRoot, stagingPath);
        await secureGeneratedCursor(stagingPath);
        const generated = await readAnchoredCursor(staging, stagingName);
        if (!generated) throw new Error("Watcher did not write a cursor snapshot");
        const existing = await readAnchoredCursor(input.root, input.name);
        const rootIdentity = existing?.rootIdentity ?? (await anchorEmptyRoot(input.root));
        if (input.expectedRootIdentity && !sameDirectoryIdentity(rootIdentity, input.expectedRootIdentity)) {
            throw new Error("Workspace cursor directory changed before publication");
        }
        await input.hooks?.beforeAnchoredMutation?.("write");
        await writeAnchoredJournalEntry({
            root: input.root,
            rootIdentity,
            destinationName: input.name,
            bytes: generated.bytes,
            expectedDestination: existing ? toEntry(existing) : undefined,
        });
        const published = await readAnchoredCursor(input.root, input.name);
        if (
            !published ||
            (input.expectedRootIdentity && !sameDirectoryIdentity(published.rootIdentity, input.expectedRootIdentity))
        ) {
            throw new Error("Watcher cursor was not published to the anchored directory");
        }
        return published;
    } finally {
        await cleanupStaging(staging, stagingName);
    }
}

export async function commitAnchoredCursor(input: {
    root: string;
    candidate: AnchoredWorkspaceCursor;
    committedName: string;
    hooks?: WorkspaceChangeFeedStorageHooks;
}): Promise<AnchoredWorkspaceCursor> {
    const observed = await readAnchoredCursor(input.root, input.candidate.name);
    if (!observed || !sameCursor(observed, input.candidate)) {
        throw new Error("Invalid or stale candidate cursor");
    }
    await input.hooks?.beforeAnchoredMutation?.("commit");
    await removeAnchoredJournalEntry({
        root: input.root,
        rootIdentity: observed.rootIdentity,
        source: toEntry(observed),
    });
    await input.hooks?.beforeAnchoredMutation?.("commit-publish");
    const committed = await readAnchoredCursor(input.root, input.committedName);
    const currentRootIdentity = committed?.rootIdentity ?? (await anchorEmptyRoot(input.root));
    if (!sameDirectoryIdentity(currentRootIdentity, observed.rootIdentity)) {
        throw new Error("Workspace cursor directory changed before committed publication");
    }
    await writeAnchoredJournalEntry({
        root: input.root,
        rootIdentity: observed.rootIdentity,
        destinationName: input.committedName,
        bytes: observed.bytes,
        expectedDestination: committed ? toEntry(committed) : undefined,
    });
    const published = await readAnchoredCursor(input.root, input.committedName);
    if (!published || published.hash !== observed.hash) {
        throw new Error("Committed workspace cursor publication failed validation");
    }
    return published;
}

export async function removeAnchoredCursor(input: {
    root: string;
    cursor: AnchoredWorkspaceCursor;
    hooks?: WorkspaceChangeFeedStorageHooks;
}): Promise<void> {
    const observed = await readAnchoredCursor(input.root, input.cursor.name);
    if (!observed) return;
    if (!sameCursor(observed, input.cursor)) throw new Error("Workspace cursor changed before removal");
    await input.hooks?.beforeAnchoredMutation?.("remove");
    await removeAnchoredJournalEntry({
        root: input.root,
        rootIdentity: observed.rootIdentity,
        source: toEntry(observed),
    });
}

export async function removeAbandonedCursorArtifacts(
    root: string,
    rootIdentity: AnchoredJournalDirectoryIdentity,
    hooks?: WorkspaceChangeFeedStorageHooks
): Promise<void> {
    await hooks?.beforeAnchoredMutation?.("remove");
    await removeAnchoredJournalReservedArtifacts({
        root,
        rootIdentity,
        maximumEntries: MaximumTrackerCleanupEntries,
    });
}

export async function withMaterializedCursor<T>(
    cursor: AnchoredWorkspaceCursor,
    callback: (path: string) => Promise<T>
): Promise<T> {
    const staging = await makePrivateStagingDirectory();
    const name = "query.cursor";
    const anchor = await anchorEmptyRoot(staging);
    try {
        await writeAnchoredJournalEntry({
            root: staging,
            rootIdentity: anchor,
            destinationName: name,
            bytes: cursor.bytes,
        });
        return await callback(join(staging, name));
    } finally {
        await cleanupStaging(staging, name);
    }
}

export function sameCursor(left: AnchoredWorkspaceCursor, right: AnchoredWorkspaceCursor): boolean {
    return (
        left.name === right.name &&
        left.hash === right.hash &&
        sameDirectoryIdentity(left.rootIdentity, right.rootIdentity) &&
        Object.keys(left.identity).every(
            (key) =>
                left.identity[key as keyof AnchoredJournalEntry["identity"]] ===
                right.identity[key as keyof AnchoredJournalEntry["identity"]]
        )
    );
}

async function anchorEmptyRoot(root: string): Promise<AnchoredJournalDirectoryIdentity> {
    const anchored = await readAnchoredJournalEntry({
        root,
        name: `.anchor-${randomBytes(8).toString("hex")}`,
        maximumEntryBytes: MaximumCursorBytes,
    });
    if (!anchored) throw new Error("Workspace cursor directory is missing");
    return anchored.identity;
}

async function makePrivateStagingDirectory(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "crest-workspace-cursor-"));
    await securePrivateDirectory(root);
    return root;
}

async function secureGeneratedCursor(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n) throw new Error("Unsafe generated workspace cursor");
        await handle.chmod(0o600);
        const after = await handle.stat({ bigint: true });
        if (
            !after.isFile() ||
            after.nlink !== 1n ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.birthtimeNs !== after.birthtimeNs ||
            (after.mode & 0o077n) !== 0n
        ) {
            throw new Error("Generated workspace cursor changed while securing");
        }
    } finally {
        await handle.close();
    }
}

async function cleanupStaging(root: string, name: string): Promise<void> {
    try {
        const cursor = await readAnchoredCursor(root, name);
        if (cursor) {
            await removeAnchoredJournalEntry({ root, rootIdentity: cursor.rootIdentity, source: toEntry(cursor) });
        }
        const entries = await readdir(root);
        if (entries.length === 0) await rmdir(root);
    } catch {
        return;
    }
}

function cursorFromEntry(
    rootIdentity: AnchoredJournalDirectoryIdentity,
    entry: AnchoredJournalEntry
): AnchoredWorkspaceCursor {
    return {
        name: entry.name,
        bytes: entry.bytes,
        identity: entry.identity,
        hash: createHash("sha256").update(entry.bytes).digest("hex"),
        rootIdentity,
    };
}

function toEntry(cursor: AnchoredWorkspaceCursor): AnchoredJournalEntry {
    return { name: cursor.name, bytes: cursor.bytes, identity: cursor.identity };
}

export function sameDirectoryIdentity(
    left: AnchoredJournalDirectoryIdentity,
    right: AnchoredJournalDirectoryIdentity
): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

function assertPrivateStoragePlatform(): void {
    if (process.platform === "win32") {
        throw new Error("Workspace change feed is disabled until owner-only Windows ACL support is available");
    }
}
