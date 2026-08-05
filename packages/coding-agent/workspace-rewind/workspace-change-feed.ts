// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

import ParcelWatcher from "@parcel/watcher";

import type { AnchoredJournalDirectoryIdentity } from "./journal-directory";
import {
    type AnchoredWorkspaceCursor,
    type WorkspaceChangeFeedStorageHooks,
    commitAnchoredCursor,
    ensurePrivateCursorRoot,
    readAnchoredCursor,
    readAnchoredCursorRootIdentity,
    removeAbandonedCursorArtifacts,
    removeAnchoredCursor,
    sameCursor,
    sameDirectoryIdentity,
    withMaterializedCursor,
    writeWatcherCursor,
} from "./workspace-change-feed-storage";

export type WorkspaceChangeRead =
    | { status: "complete"; changedPaths: string[]; scopeInvalidated: boolean; candidateCursor: string }
    | { status: "gap"; reason: "cold-start" | "cursor-missing" | "query-failed" | "unsafe-path" };

export interface WorkspaceChangeFeed {
    prepareForReconcile(): Promise<void>;
    initializeAfterReconcile(): Promise<void>;
    readChanges(): Promise<WorkspaceChangeRead>;
    advanceCandidate(candidateCursor: string): Promise<WorkspaceChangeRead>;
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
    callbackPathCapacity?: number;
    testHooks?: WorkspaceChangeFeedStorageHooks;
}

interface CandidateCursor {
    token: string;
    cursor: AnchoredWorkspaceCursor;
}

interface FeedState {
    workspaceRoot: string;
    trackerRoot: string;
    watcher: WorkspaceChangeWatcher;
    callbackPaths: Set<string>;
    callbackPathCapacity: number;
    continuityGeneration: number;
    transitionQueue: Promise<void>;
    trackerIdentity?: AnchoredJournalDirectoryIdentity;
    gapReason?: "query-failed" | "unsafe-path";
    subscription?: WorkspaceChangeSubscription;
    subscriptionPromise?: Promise<WorkspaceChangeSubscription>;
    disposePromise?: Promise<void>;
    disposed: boolean;
    initialized: boolean;
    preparedCursor?: AnchoredWorkspaceCursor;
    candidate?: CandidateCursor;
    testHooks?: WorkspaceChangeFeedStorageHooks;
}

const CandidateTokenPattern = /^[0-9a-f]{32}$/;
const CommittedCursorName = "committed.cursor";
const ReconcileCursorName = "reconcile.cursor";
const PostReconcileCursorName = "reconcile-post.cursor";
const DefaultCallbackPathCapacity = 10_000;
const State = new WeakMap<ParcelWorkspaceChangeFeed, FeedState>();

export class ParcelWorkspaceChangeFeed implements WorkspaceChangeFeed {
    constructor(options: ParcelWorkspaceChangeFeedOptions) {
        if (!isAbsolute(options.workspaceRoot) || normalize(options.workspaceRoot) !== options.workspaceRoot) {
            throw new Error("Workspace root must be a canonical absolute path");
        }
        if (!isAbsolute(options.storeRoot) || normalize(options.storeRoot) !== options.storeRoot) {
            throw new Error("Store root must be a canonical absolute path");
        }
        const callbackPathCapacity = options.callbackPathCapacity ?? DefaultCallbackPathCapacity;
        if (!Number.isSafeInteger(callbackPathCapacity) || callbackPathCapacity < 1) {
            throw new Error("Callback path capacity must be a positive safe integer");
        }
        State.set(this, {
            workspaceRoot: options.workspaceRoot,
            trackerRoot: join(options.storeRoot, "tracker"),
            watcher: options.watcher ?? ParcelWatcher,
            callbackPaths: new Set(),
            callbackPathCapacity,
            continuityGeneration: 0,
            transitionQueue: Promise.resolve(),
            disposed: false,
            initialized: false,
            testHooks: options.testHooks,
        });
    }

    prepareForReconcile(): Promise<void> {
        const state = getState(this);
        return enqueueTransition(state, () => this.prepareForReconcileUnlocked());
    }

    async prepareForReconcileUnlocked(): Promise<void> {
        const state = getState(this);
        if (state.disposed) {
            setGap(state, "query-failed");
            throw new Error("Workspace change feed is disposed");
        }
        if (state.preparedCursor && !state.gapReason) {
            setGap(state, "query-failed");
            throw new Error("Workspace change feed reconcile is already prepared");
        }
        let publishedPrepared: AnchoredWorkspaceCursor | undefined;
        try {
            if (state.preparedCursor) {
                await removeAnchoredCursor({
                    root: state.trackerRoot,
                    cursor: state.preparedCursor,
                    hooks: state.testHooks,
                });
                state.preparedCursor = undefined;
                if (state.disposed) throw new Error("Workspace change feed was disposed during reconcile preparation");
            }
            state.callbackPaths.clear();
            clearGap(state);
            state.initialized = false;
            const continuityGeneration = state.continuityGeneration;
            const trackerIdentity = await ensurePrivateCursorRoot(state.trackerRoot);
            assertContinuityFence(state, continuityGeneration);
            if (state.trackerIdentity && !sameDirectoryIdentity(state.trackerIdentity, trackerIdentity)) {
                throw new Error("Workspace cursor directory changed during feed lifecycle");
            }
            state.trackerIdentity = trackerIdentity;
            await ensureSubscription(state);
            assertContinuityFence(state, continuityGeneration);
            await removeCandidate(state);
            assertContinuityFence(state, continuityGeneration);
            await removeAbandonedCursorArtifacts(state.trackerRoot, trackerIdentity, state.testHooks);
            assertContinuityFence(state, continuityGeneration);
            publishedPrepared = await writeWatcherCursor({
                root: state.trackerRoot,
                name: ReconcileCursorName,
                workspaceRoot: state.workspaceRoot,
                writer: state.watcher,
                expectedRootIdentity: trackerIdentity,
                hooks: state.testHooks,
            });
            assertContinuityFence(state, continuityGeneration);
            state.preparedCursor = publishedPrepared;
            publishedPrepared = undefined;
        } catch (error) {
            if (publishedPrepared) {
                await removeAnchoredCursor({
                    root: state.trackerRoot,
                    cursor: publishedPrepared,
                    hooks: state.testHooks,
                }).catch(() => undefined);
            }
            setGap(state, "query-failed");
            throw error;
        }
    }

    initializeAfterReconcile(): Promise<void> {
        const state = getState(this);
        return enqueueTransition(state, () => this.initializeAfterReconcileUnlocked());
    }

    async initializeAfterReconcileUnlocked(): Promise<void> {
        const state = getState(this);
        const prepared = state.preparedCursor;
        if (!prepared || state.disposed) {
            setGap(state, "query-failed");
            throw new Error("Workspace change feed reconcile was not prepared");
        }
        if (state.gapReason) throw new Error("Workspace change feed reconcile has a continuity gap");
        const continuityGeneration = state.continuityGeneration;
        let post: AnchoredWorkspaceCursor | undefined;
        try {
            post = await writeWatcherCursor({
                root: state.trackerRoot,
                name: PostReconcileCursorName,
                workspaceRoot: state.workspaceRoot,
                writer: state.watcher,
                expectedRootIdentity: state.trackerIdentity,
                hooks: state.testHooks,
            });
            assertContinuityFence(state, continuityGeneration);
            const events = await withMaterializedCursor(prepared, (path) =>
                state.watcher.getEventsSince(state.workspaceRoot, path)
            );
            addEvents(state, events);
            assertContinuityFence(state, continuityGeneration);
        } catch (error) {
            if (post) {
                await removeAnchoredCursor({ root: state.trackerRoot, cursor: post, hooks: state.testHooks }).catch(
                    () => undefined
                );
            }
            state.initialized = false;
            setGap(state, "query-failed");
            throw error;
        }
        try {
            await commitAnchoredCursor({
                root: state.trackerRoot,
                candidate: post,
                committedName: CommittedCursorName,
                hooks: state.testHooks,
            });
            assertContinuityFence(state, continuityGeneration);
            await removeAnchoredCursor({ root: state.trackerRoot, cursor: prepared, hooks: state.testHooks });
            state.preparedCursor = undefined;
            assertContinuityFence(state, continuityGeneration);
            state.initialized = true;
        } catch (error) {
            state.initialized = false;
            setGap(state, "query-failed");
            throw error;
        }
    }

    readChanges(): Promise<WorkspaceChangeRead> {
        const state = getState(this);
        return enqueueTransition(state, () => this.readChangesUnlocked());
    }

    async readChangesUnlocked(): Promise<WorkspaceChangeRead> {
        const state = getState(this);
        if (!state.initialized) return state.gapReason ? gap(state) : { status: "gap", reason: "cold-start" };
        let committed: AnchoredWorkspaceCursor | undefined;
        let trackerExists = false;
        try {
            const trackerIdentity = await readAnchoredCursorRootIdentity(state.trackerRoot);
            trackerExists = trackerIdentity != null;
            if (
                trackerIdentity &&
                (!state.trackerIdentity || !sameDirectoryIdentity(trackerIdentity, state.trackerIdentity))
            ) {
                throw new Error("Workspace cursor directory changed during feed lifecycle");
            }
            committed = trackerExists ? await readAnchoredCursor(state.trackerRoot, CommittedCursorName) : undefined;
            if (
                committed &&
                (!state.trackerIdentity || !sameDirectoryIdentity(committed.rootIdentity, state.trackerIdentity))
            ) {
                throw new Error("Workspace cursor directory changed while reading committed cursor");
            }
        } catch {
            setGap(state, "query-failed");
            return gap(state);
        }
        if (!committed) {
            return { status: "gap", reason: state.initialized || trackerExists ? "cursor-missing" : "cold-start" };
        }
        if (state.gapReason || state.disposed || state.preparedCursor) return gap(state);
        try {
            await ensureSubscription(state);
            await removeCandidate(state);
        } catch {
            setGap(state, "query-failed");
            return gap(state);
        }

        const continuityGeneration = state.continuityGeneration;
        const token = randomBytes(16).toString("hex");
        let candidate: AnchoredWorkspaceCursor | undefined;
        try {
            candidate = await writeWatcherCursor({
                root: state.trackerRoot,
                name: `candidate-${token}.cursor`,
                workspaceRoot: state.workspaceRoot,
                writer: state.watcher,
                expectedRootIdentity: state.trackerIdentity,
                hooks: state.testHooks,
            });
            assertContinuityFence(state, continuityGeneration);
            const historical = await withMaterializedCursor(committed, (path) =>
                state.watcher.getEventsSince(state.workspaceRoot, path)
            );
            addEvents(state, historical);
            assertContinuityFence(state, continuityGeneration);
        } catch {
            if (candidate) {
                await removeAnchoredCursor({
                    root: state.trackerRoot,
                    cursor: candidate,
                    hooks: state.testHooks,
                }).catch(() => undefined);
            }
            setGap(state, "query-failed");
            return gap(state);
        }
        if (state.gapReason) {
            await removeAnchoredCursor({ root: state.trackerRoot, cursor: candidate, hooks: state.testHooks }).catch(
                () => undefined
            );
            return gap(state);
        }
        state.candidate = { token, cursor: candidate };
        const changedPaths = [...state.callbackPaths].sort(comparePathBytes);
        return {
            status: "complete",
            changedPaths,
            scopeInvalidated: changedPaths.some(invalidatesScope),
            candidateCursor: token,
        };
    }

    commitCursor(candidateCursor: string): Promise<void> {
        const state = getState(this);
        return enqueueTransition(state, () => this.commitCursorUnlocked(candidateCursor));
    }

    async commitCursorUnlocked(candidateCursor: string): Promise<void> {
        const state = getState(this);
        const candidate = state.candidate;
        if (
            state.gapReason ||
            !candidate ||
            !CandidateTokenPattern.test(candidateCursor) ||
            candidate.token !== candidateCursor
        ) {
            throw new Error("Invalid or stale candidate cursor");
        }
        const continuityGeneration = state.continuityGeneration;
        try {
            if (
                !state.trackerIdentity ||
                !sameDirectoryIdentity(candidate.cursor.rootIdentity, state.trackerIdentity)
            ) {
                throw new Error("Workspace cursor directory changed during feed lifecycle");
            }
            await commitAnchoredCursor({
                root: state.trackerRoot,
                candidate: candidate.cursor,
                committedName: CommittedCursorName,
                hooks: state.testHooks,
            });
            assertContinuityFence(state, continuityGeneration);
        } catch {
            state.candidate = undefined;
            state.initialized = false;
            setGap(state, "query-failed");
            throw new Error("Invalid or stale candidate cursor");
        }
        state.candidate = undefined;
        state.callbackPaths.clear();
    }

    advanceCandidate(candidateCursor: string): Promise<WorkspaceChangeRead> {
        const state = getState(this);
        return enqueueTransition(state, () => this.advanceCandidateUnlocked(candidateCursor));
    }

    async advanceCandidateUnlocked(candidateCursor: string): Promise<WorkspaceChangeRead> {
        const state = getState(this);
        const current = state.candidate;
        if (
            state.gapReason ||
            state.disposed ||
            state.preparedCursor ||
            !state.initialized ||
            !current ||
            !CandidateTokenPattern.test(candidateCursor) ||
            current.token !== candidateCursor
        ) {
            await rejectCandidate(state, current);
        }
        const continuityGeneration = state.continuityGeneration;
        const nextToken = randomBytes(16).toString("hex");
        let next: AnchoredWorkspaceCursor | undefined;
        try {
            const observed = await readAnchoredCursor(state.trackerRoot, current.cursor.name);
            if (
                !observed ||
                !sameCursor(observed, current.cursor) ||
                !state.trackerIdentity ||
                !sameDirectoryIdentity(observed.rootIdentity, state.trackerIdentity)
            ) {
                throw new Error("Invalid or stale candidate cursor");
            }
            state.callbackPaths.clear();
            next = await writeWatcherCursor({
                root: state.trackerRoot,
                name: `candidate-${nextToken}.cursor`,
                workspaceRoot: state.workspaceRoot,
                writer: state.watcher,
                expectedRootIdentity: state.trackerIdentity,
                hooks: state.testHooks,
            });
            assertContinuityFence(state, continuityGeneration);
            const interval = await withMaterializedCursor(current.cursor, (path) =>
                state.watcher.getEventsSince(state.workspaceRoot, path)
            );
            addEvents(state, interval);
            assertContinuityFence(state, continuityGeneration);
            await removeAnchoredCursor({ root: state.trackerRoot, cursor: current.cursor, hooks: state.testHooks });
            assertContinuityFence(state, continuityGeneration);
        } catch {
            await abandonCandidateTransition(state, current, next);
            return gap(state);
        }
        state.candidate = { token: nextToken, cursor: next };
        const changedPaths = [...state.callbackPaths].sort(comparePathBytes);
        return {
            status: "complete",
            changedPaths,
            scopeInvalidated: changedPaths.some(invalidatesScope),
            candidateCursor: nextToken,
        };
    }

    markGap(): void {
        setGap(getState(this), "query-failed");
    }

    dispose(): Promise<void> {
        const state = getState(this);
        if (state.disposePromise) return state.disposePromise;
        state.disposed = true;
        state.continuityGeneration++;
        state.disposePromise = enqueueTransition(state, () => disposeState(state));
        return state.disposePromise;
    }
}

function enqueueTransition<T>(state: FeedState, operation: () => Promise<T>): Promise<T> {
    const result = state.transitionQueue.then(operation);
    state.transitionQueue = result.then(
        () => undefined,
        () => undefined
    );
    return result;
}

async function ensureSubscription(state: FeedState): Promise<WorkspaceChangeSubscription> {
    if (state.subscription) return state.subscription;
    if (state.subscriptionPromise) return state.subscriptionPromise;
    if (state.disposed) throw new Error("Workspace change feed is disposed");
    const promise = state.watcher
        .subscribe(state.workspaceRoot, (error, events) => {
            if (state.disposed) return;
            try {
                if (error) {
                    setGap(state, "query-failed");
                    return;
                }
                addEvents(state, events);
            } catch {
                setGap(state, "query-failed");
            }
        })
        .then(async (subscription) => {
            if (state.disposed) {
                await subscription.unsubscribe().catch(() => undefined);
                throw new Error("Workspace change feed was disposed while subscribing");
            }
            state.subscription = subscription;
            return subscription;
        });
    state.subscriptionPromise = promise;
    const clearPending = () => {
        if (state.subscriptionPromise === promise) state.subscriptionPromise = undefined;
    };
    void promise.then(clearPending, clearPending);
    return promise;
}

async function disposeState(state: FeedState): Promise<void> {
    await state.subscriptionPromise?.catch(() => undefined);
    const subscription = state.subscription;
    state.subscription = undefined;
    if (subscription) await subscription.unsubscribe().catch(() => undefined);
    await removeCandidate(state).catch(() => undefined);
    if (state.preparedCursor) {
        await removeAnchoredCursor({
            root: state.trackerRoot,
            cursor: state.preparedCursor,
            hooks: state.testHooks,
        }).catch(() => undefined);
        state.preparedCursor = undefined;
    }
}

async function removeCandidate(state: FeedState): Promise<void> {
    const candidate = state.candidate;
    state.candidate = undefined;
    if (!candidate) return;
    await removeAnchoredCursor({ root: state.trackerRoot, cursor: candidate.cursor, hooks: state.testHooks });
}

async function rejectCandidate(state: FeedState, candidate?: CandidateCursor): Promise<never> {
    state.candidate = undefined;
    if (candidate) {
        await removeAnchoredCursor({ root: state.trackerRoot, cursor: candidate.cursor, hooks: state.testHooks }).catch(
            () => undefined
        );
    }
    setGap(state, "query-failed");
    throw new Error("Invalid or stale candidate cursor");
}

async function abandonCandidateTransition(
    state: FeedState,
    current: CandidateCursor,
    next?: AnchoredWorkspaceCursor
): Promise<void> {
    state.candidate = undefined;
    if (next) {
        await removeAnchoredCursor({ root: state.trackerRoot, cursor: next, hooks: state.testHooks }).catch(
            () => undefined
        );
    }
    await removeAnchoredCursor({ root: state.trackerRoot, cursor: current.cursor, hooks: state.testHooks }).catch(
        () => undefined
    );
    setGap(state, "query-failed");
}

function addEvents(state: FeedState, events: readonly WorkspaceChangeEvent[]): void {
    for (const event of events) {
        const path = normalizeEventPath(state.workspaceRoot, event.path);
        if (!path) {
            setGap(state, "unsafe-path");
            return;
        }
        if (state.callbackPaths.has(path)) continue;
        if (state.callbackPaths.size >= state.callbackPathCapacity) {
            setGap(state, "query-failed");
            return;
        }
        state.callbackPaths.add(path);
    }
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

function setGap(state: FeedState, reason: "query-failed" | "unsafe-path"): void {
    state.continuityGeneration++;
    if (state.gapReason !== "unsafe-path") state.gapReason = reason;
}

function clearGap(state: FeedState): void {
    state.continuityGeneration++;
    state.gapReason = undefined;
}

function assertContinuityFence(state: FeedState, continuityGeneration: number): void {
    if (state.disposed || state.gapReason || state.continuityGeneration !== continuityGeneration) {
        state.initialized = false;
        throw new Error("Workspace change feed continuity changed during cursor publication");
    }
}

function gap(state: FeedState): WorkspaceChangeRead {
    return { status: "gap", reason: state.gapReason ?? "query-failed" };
}

function getState(feed: ParcelWorkspaceChangeFeed): FeedState {
    return State.get(feed)!;
}
