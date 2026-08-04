// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

import ParcelWatcher from "@parcel/watcher";

export type WorkspaceChangeRead =
    | { status: "complete"; changedPaths: string[]; scopeInvalidated: boolean; candidateCursor: string }
    | { status: "gap"; reason: "cold-start" | "cursor-missing" | "query-failed" | "unsafe-path" };

export interface WorkspaceChangeFeed {
    initializeAfterReconcile(): Promise<void>;
    readChanges(): Promise<WorkspaceChangeRead>;
    commitCursor(candidateCursor: string): Promise<void>;
    markGap(): void;
    dispose(): Promise<void>;
}

export interface WorkspaceChangeEvent {
    path: string;
    type: "create" | "update" | "delete";
}

export interface WorkspaceChangeSubscription {
    unsubscribe(): Promise<void>;
}

export interface WorkspaceChangeWatcher {
    getEventsSince(directory: string, snapshot: string): Promise<WorkspaceChangeEvent[]>;
    subscribe(
        directory: string,
        callback: (error: Error | null, events: WorkspaceChangeEvent[]) => unknown
    ): Promise<WorkspaceChangeSubscription>;
    writeSnapshot(directory: string, snapshot: string): Promise<string>;
}

export interface ParcelWorkspaceChangeFeedOptions {
    workspaceRoot: string;
    storeRoot: string;
    watcher?: WorkspaceChangeWatcher;
}

interface FeedState {
    workspaceRoot: string;
    trackerRoot: string;
    committedPath: string;
    watcher: WorkspaceChangeWatcher;
    subscription?: WorkspaceChangeSubscription;
    callbackEvents: WorkspaceChangeEvent[];
    gap: boolean;
    initialized: boolean;
    disposed: boolean;
    disposePromise?: Promise<void>;
    candidateToken?: string;
    candidatePath?: string;
}

const CandidateTokenPattern = /^[0-9a-f]{32}$/;
const State = new WeakMap<ParcelWorkspaceChangeFeed, FeedState>();

export class ParcelWorkspaceChangeFeed implements WorkspaceChangeFeed {
    constructor(options: ParcelWorkspaceChangeFeedOptions) {
        if (!isAbsolute(options.workspaceRoot) || normalize(options.workspaceRoot) !== options.workspaceRoot) {
            throw new Error("Workspace root must be a canonical absolute path");
        }
        if (!isAbsolute(options.storeRoot) || normalize(options.storeRoot) !== options.storeRoot) {
            throw new Error("Store root must be a canonical absolute path");
        }
        const trackerRoot = join(options.storeRoot, "tracker");
        State.set(this, {
            workspaceRoot: options.workspaceRoot,
            trackerRoot,
            committedPath: join(trackerRoot, "committed.cursor"),
            watcher: options.watcher ?? ParcelWatcher,
            callbackEvents: [],
            gap: false,
            initialized: false,
            disposed: false,
        });
    }

    async initializeAfterReconcile(): Promise<void> {
        const state = getState(this);
        await ensureTrackerRoot(state.trackerRoot);
        await removeCandidate(state);
        state.gap = false;
        state.callbackEvents = [];
        try {
            await ensureSubscription(state);
        } catch {
            state.gap = true;
        }
        await publishSnapshot(state, state.committedPath);
        state.initialized = true;
    }

    async readChanges(): Promise<WorkspaceChangeRead> {
        const state = getState(this);

        let trackerExists: boolean;
        let cursorExists: boolean;
        try {
            trackerExists = await validateExistingTrackerRoot(state.trackerRoot);
            cursorExists = await isRegularFile(state.committedPath);
        } catch {
            state.gap = true;
            return { status: "gap", reason: "query-failed" };
        }
        if (!cursorExists) {
            return { status: "gap", reason: state.initialized || trackerExists ? "cursor-missing" : "cold-start" };
        }
        if (state.gap) return { status: "gap", reason: "query-failed" };
        try {
            await ensureSubscription(state);
        } catch {
            state.gap = true;
            return { status: "gap", reason: "query-failed" };
        }
        if (state.gap) return { status: "gap", reason: "query-failed" };

        try {
            await removeCandidate(state);
        } catch {
            state.gap = true;
            return { status: "gap", reason: "query-failed" };
        }
        const token = randomBytes(16).toString("hex");
        const candidatePath = join(state.trackerRoot, `candidate-${token}.cursor`);
        try {
            await publishSnapshot(state, candidatePath);
        } catch {
            state.gap = true;
            return { status: "gap", reason: "query-failed" };
        }
        if (state.gap) {
            await unlink(candidatePath).catch(ignoreMissing);
            return { status: "gap", reason: "query-failed" };
        }

        let historicalEvents: WorkspaceChangeEvent[];
        try {
            historicalEvents = await state.watcher.getEventsSince(state.workspaceRoot, state.committedPath);
        } catch {
            await unlink(candidatePath).catch(ignoreMissing);
            state.gap = true;
            return { status: "gap", reason: "query-failed" };
        }
        if (state.gap) {
            await unlink(candidatePath).catch(ignoreMissing);
            return { status: "gap", reason: "query-failed" };
        }

        const changedPaths = new Set<string>();
        let scopeInvalidated = false;
        for (const event of [...historicalEvents, ...state.callbackEvents]) {
            const path = normalizeEventPath(state.workspaceRoot, event.path);
            if (!path) {
                await unlink(candidatePath).catch(ignoreMissing);
                state.gap = true;
                return { status: "gap", reason: "unsafe-path" };
            }
            changedPaths.add(path);
            scopeInvalidated ||= invalidatesScope(path);
        }
        state.candidateToken = token;
        state.candidatePath = candidatePath;
        return {
            status: "complete",
            changedPaths: [...changedPaths].sort(comparePathBytes),
            scopeInvalidated,
            candidateCursor: token,
        };
    }

    async commitCursor(candidateCursor: string): Promise<void> {
        const state = getState(this);
        if (
            state.gap ||
            !CandidateTokenPattern.test(candidateCursor) ||
            candidateCursor !== state.candidateToken ||
            basename(state.candidatePath ?? "") !== `candidate-${candidateCursor}.cursor`
        ) {
            throw new Error("Invalid or stale candidate cursor");
        }
        if (!(await validateExistingTrackerRoot(state.trackerRoot))) {
            throw new Error("Invalid or stale candidate cursor");
        }
        if (!(await isRegularFile(state.candidatePath!))) {
            throw new Error("Invalid or stale candidate cursor");
        }
        await rename(state.candidatePath!, state.committedPath);
        await syncDirectory(state.trackerRoot);
        state.candidatePath = undefined;
        state.candidateToken = undefined;
        state.callbackEvents = [];
    }

    markGap(): void {
        getState(this).gap = true;
    }

    dispose(): Promise<void> {
        const state = getState(this);
        if (state.disposePromise) return state.disposePromise;
        state.disposed = true;
        state.disposePromise = disposeState(state);
        return state.disposePromise;
    }
}

async function disposeState(state: FeedState): Promise<void> {
    const subscription = state.subscription;
    state.subscription = undefined;
    if (subscription) await subscription.unsubscribe().catch(() => undefined);
    try {
        await removeCandidate(state);
    } catch {
        clearCandidate(state);
    }
}

async function ensureSubscription(state: FeedState): Promise<void> {
    if (state.subscription) return;
    if (state.disposed) throw new Error("Workspace change feed is disposed");
    state.subscription = await state.watcher.subscribe(state.workspaceRoot, (error, events) => {
        try {
            if (error) {
                state.gap = true;
                return;
            }
            state.callbackEvents.push(...events);
        } catch {
            state.gap = true;
        }
    });
}

async function publishSnapshot(state: FeedState, destination: string): Promise<void> {
    const temporaryPath = join(state.trackerRoot, `.snapshot-${randomBytes(16).toString("hex")}.tmp`);
    try {
        await state.watcher.writeSnapshot(state.workspaceRoot, temporaryPath);
        const handle = await open(temporaryPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            await handle.chmod(0o600);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporaryPath, destination);
        await syncDirectory(dirname(destination));
    } catch (error) {
        await unlink(temporaryPath).catch(ignoreMissing);
        throw error;
    }
}

async function ensureTrackerRoot(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe tracker directory");
    await chmod(path, 0o700);
}

async function validateExistingTrackerRoot(path: string): Promise<boolean> {
    let stat;
    try {
        stat = await lstat(path);
    } catch (error) {
        if (isCode(error, "ENOENT")) return false;
        throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe tracker directory");
    await chmod(path, 0o700);
    return true;
}

async function removeCandidate(state: FeedState): Promise<void> {
    if (!(await validateExistingTrackerRoot(state.trackerRoot))) {
        clearCandidate(state);
        return;
    }
    if (state.candidatePath) await unlink(state.candidatePath).catch(ignoreMissing);
    clearCandidate(state);
    const entries = await readdir(state.trackerRoot);
    await Promise.all(
        entries
            .filter(
                (entry) =>
                    /^candidate-[0-9a-f]{32}\.cursor$/.test(entry) || /^\.snapshot-[0-9a-f]{32}\.tmp$/.test(entry)
            )
            .map((entry) => unlink(join(state.trackerRoot, entry)).catch(ignoreMissing))
    );
}

function clearCandidate(state: FeedState): void {
    state.candidatePath = undefined;
    state.candidateToken = undefined;
}

function normalizeEventPath(workspaceRoot: string, eventPath: string): string | undefined {
    if (!isAbsolute(eventPath) || normalize(eventPath) !== eventPath || !validUtf8String(eventPath)) return undefined;
    const path = relative(workspaceRoot, eventPath);
    if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) return undefined;
    if (path.split(sep).some((segment) => !segment || segment === "." || segment === "..")) return undefined;
    return sep === "/" ? path : path.split(sep).join("/");
}

function validUtf8String(value: string): boolean {
    return Buffer.from(value, "utf8").toString("utf8") === value && !value.includes("\0");
}

function invalidatesScope(path: string): boolean {
    const segments = path.split("/");
    return (
        path === ".git/index" ||
        path === ".git/info/exclude" ||
        segments.includes(".git") ||
        segments.includes(".gitignore")
    );
}

function comparePathBytes(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function isRegularFile(path: string): Promise<boolean> {
    try {
        const stat = await lstat(path);
        return stat.isFile() && !stat.isSymbolicLink();
    } catch (error) {
        if (isCode(error, "ENOENT")) return false;
        throw error;
    }
}

async function syncDirectory(path: string): Promise<void> {
    let handle;
    try {
        handle = await open(path, "r");
    } catch (error) {
        if (isUnsupportedDirectorySync(error)) return;
        throw error;
    }
    try {
        await handle.sync();
    } catch (error) {
        if (!isUnsupportedDirectorySync(error)) throw error;
    } finally {
        await handle.close();
    }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
    return (
        isCode(error, "EINVAL") ||
        isCode(error, "ENOTSUP") ||
        isCode(error, "EISDIR") ||
        (process.platform === "win32" && isCode(error, "EPERM"))
    );
}

function ignoreMissing(error: unknown): void {
    if (!isCode(error, "ENOENT")) throw error;
}

function isCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

function getState(feed: ParcelWorkspaceChangeFeed): FeedState {
    return State.get(feed)!;
}
