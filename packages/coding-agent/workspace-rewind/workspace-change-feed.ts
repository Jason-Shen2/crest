// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, normalize, relative, sep } from "node:path";

import ParcelWatcher from "@parcel/watcher";

import { validateWorkspaceRelativePath } from "./stored-manifest";

export type WorkspaceChangeUnavailableReason =
    | "not-started"
    | "watcher-error"
    | "unsafe-path"
    | "overflow"
    | "disposed";

export type WorkspaceChangeDrain =
    | { status: "complete"; changedPaths: string[] }
    | { status: "unavailable"; reason: WorkspaceChangeUnavailableReason };

export interface WorkspaceChangeFeed {
    start(): Promise<void>;
    drain(): Promise<WorkspaceChangeDrain>;
    isTrusted(): boolean;
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
    subscribe(
        directory: string,
        callback: (error: Error | null, events: WorkspaceChangeEvent[]) => unknown
    ): Promise<WorkspaceChangeSubscription>;
}

export interface ParcelWorkspaceChangeFeedOptions {
    workspaceRoot: string;
    watcher?: WorkspaceChangeWatcher;
    callbackPathCapacity?: number;
}

interface FeedState {
    workspaceRoot: string;
    watcher: WorkspaceChangeWatcher;
    callbackPaths: Set<string>;
    callbackPathCapacity: number;
    generation: number;
    transitionQueue: Promise<void>;
    subscription?: WorkspaceChangeSubscription;
    disposePromise?: Promise<void>;
    gapReason?: Exclude<WorkspaceChangeUnavailableReason, "not-started" | "disposed">;
    disposed: boolean;
    started: boolean;
    trusted: boolean;
}

const DefaultCallbackPathCapacity = 10_000;
const State = new WeakMap<ParcelWorkspaceChangeFeed, FeedState>();

export class ParcelWorkspaceChangeFeed implements WorkspaceChangeFeed {
    constructor(options: ParcelWorkspaceChangeFeedOptions) {
        if (!isAbsolute(options.workspaceRoot) || normalize(options.workspaceRoot) !== options.workspaceRoot) {
            throw new Error("Workspace root must be a canonical absolute path");
        }
        const callbackPathCapacity = options.callbackPathCapacity ?? DefaultCallbackPathCapacity;
        if (!Number.isSafeInteger(callbackPathCapacity) || callbackPathCapacity < 1) {
            throw new Error("Callback path capacity must be a positive safe integer");
        }
        State.set(this, {
            workspaceRoot: options.workspaceRoot,
            watcher: options.watcher ?? ParcelWatcher,
            callbackPaths: new Set(),
            callbackPathCapacity,
            generation: 0,
            transitionQueue: Promise.resolve(),
            disposed: false,
            started: false,
            trusted: false,
        });
    }

    start(): Promise<void> {
        const state = getState(this);
        return enqueueTransition(state, () => startState(state));
    }

    drain(): Promise<WorkspaceChangeDrain> {
        const state = getState(this);
        return enqueueTransition(state, async () => drainState(state));
    }

    isTrusted(): boolean {
        const state = getState(this);
        return state.started && state.trusted && !state.disposed;
    }

    dispose(): Promise<void> {
        const state = getState(this);
        if (state.disposePromise) return state.disposePromise;
        state.disposed = true;
        state.trusted = false;
        state.generation++;
        state.disposePromise = enqueueTransition(state, () => disposeState(state));
        return state.disposePromise;
    }
}

async function startState(state: FeedState): Promise<void> {
    if (state.disposed) throw new Error("Workspace change feed is disposed");
    const generation = ++state.generation;
    state.started = false;
    state.trusted = false;
    state.gapReason = undefined;
    state.callbackPaths = new Set();
    const previous = state.subscription;
    state.subscription = undefined;
    await previous?.unsubscribe();
    if (state.disposed || generation !== state.generation) {
        throw new Error("Workspace change feed was disposed during start");
    }
    let subscription: WorkspaceChangeSubscription;
    try {
        subscription = await state.watcher.subscribe(state.workspaceRoot, (error, events) => {
            if (state.disposed || generation !== state.generation) return;
            if (error) {
                loseTrust(state, "watcher-error");
                return;
            }
            addEvents(state, events);
        });
    } catch (error) {
        state.started = true;
        loseTrust(state, "watcher-error");
        throw error;
    }
    if (state.disposed || generation !== state.generation) {
        await subscription.unsubscribe();
        throw new Error("Workspace change feed was disposed during start");
    }
    state.subscription = subscription;
    state.started = true;
    state.trusted = state.gapReason == null;
}

function drainState(state: FeedState): WorkspaceChangeDrain {
    if (state.disposed) return { status: "unavailable", reason: "disposed" };
    if (!state.started) return { status: "unavailable", reason: "not-started" };
    if (!state.trusted) return { status: "unavailable", reason: state.gapReason ?? "watcher-error" };
    const drained = state.callbackPaths;
    state.callbackPaths = new Set();
    return { status: "complete", changedPaths: [...drained].sort(comparePathBytes) };
}

function addEvents(state: FeedState, events: readonly WorkspaceChangeEvent[]): void {
    if (!state.trusted && state.started) return;
    for (const event of events) {
        let path: string;
        try {
            path = normalizeEventPath(state.workspaceRoot, event.path);
        } catch {
            loseTrust(state, "unsafe-path");
            return;
        }
        if (state.callbackPaths.has(path)) continue;
        if (state.callbackPaths.size >= state.callbackPathCapacity) {
            loseTrust(state, "overflow");
            return;
        }
        state.callbackPaths.add(path);
    }
}

function normalizeEventPath(workspaceRoot: string, input: string): string {
    if (typeof input !== "string" || !input || !validUtf8String(input) || normalize(input) !== input) {
        throw new Error("Unsafe watcher path");
    }
    let path = input;
    if (isAbsolute(path)) {
        path = relative(workspaceRoot, path);
        if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
            throw new Error("Watcher path is outside the Workspace");
        }
    }
    if (sep !== "/") path = path.split(sep).join("/");
    validateWorkspaceRelativePath(path);
    return path;
}

function validUtf8String(value: string): boolean {
    return Buffer.from(value, "utf8").toString("utf8") === value;
}

function loseTrust(
    state: FeedState,
    reason: Exclude<WorkspaceChangeUnavailableReason, "not-started" | "disposed">
): void {
    state.trusted = false;
    state.gapReason = reason;
    state.callbackPaths = new Set();
}

async function disposeState(state: FeedState): Promise<void> {
    const subscription = state.subscription;
    state.subscription = undefined;
    state.callbackPaths = new Set();
    await subscription?.unsubscribe();
}

function enqueueTransition<T>(state: FeedState, operation: () => Promise<T>): Promise<T> {
    const result = state.transitionQueue.then(operation);
    state.transitionQueue = result.then(
        () => undefined,
        () => undefined
    );
    return result;
}

function comparePathBytes(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function getState(feed: ParcelWorkspaceChangeFeed): FeedState {
    const state = State.get(feed);
    if (!state) throw new Error("Invalid Workspace change feed");
    return state;
}
