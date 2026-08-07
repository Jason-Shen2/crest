// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AnchoredReaderError } from "./anchored-reader";
import {
    IncrementalPathCapture,
    type IncrementalCapturedBatch,
    type IncrementalPathCaptureResult,
} from "./incremental-path-capture";
import type { IncrementalPathMutation } from "./incremental-tree";
import type { LegacyWorkspaceSnapshotCapture } from "./snapshot-source";
import {
    WorkspaceCheckpointLimits,
    WorkspaceSnapshotStoreError,
    type CaptureWorkspaceOptions,
    type WorkspaceSnapshotStore,
} from "./snapshot-store";
import type { WorkspacePathChangeV1, WorkspaceSnapshotCoverage, WorkspaceSnapshotRefV1 } from "./types";
import type { WorkspaceChangeDrain, WorkspaceChangeFeed } from "./workspace-change-feed";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import type { WorkspaceScopeManifest } from "./workspace-scope";
import type { LoadedWorkspaceTrackerState } from "./workspace-tracker-state";

export interface WorkspaceSnapshotTrackerStore {
    storeRoot: string;
    identity: CanonicalWorkspaceIdentity;
    git: WorkspaceSnapshotStore["git"];
    captureFullReconcile(options: CaptureWorkspaceOptions): Promise<WorkspaceSnapshotCapture>;
    readIncrementalSnapshotMetadata(snapshot: WorkspaceSnapshotRefV1): Promise<WorkspaceIncrementalMetadata>;
    computeIncrementalSnapshotCoverage(
        snapshot: WorkspaceSnapshotRefV1,
        mutations: IncrementalPathMutation[]
    ): Promise<Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">>;
    commitCapturedIncrementalSnapshot(input: {
        base: WorkspaceSnapshotRefV1;
        mutations: IncrementalPathMutation[];
        scope: WorkspaceScopeManifest;
        coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
        newlyHashedBytes: number;
        profile: CaptureWorkspaceOptions["profile"];
        batch: IncrementalCapturedBatch;
    }): Promise<WorkspaceSnapshotCapture>;
    readNodeKind(
        snapshot: WorkspaceSnapshotRefV1,
        path: string,
        signal?: AbortSignal
    ): Promise<"absent" | "leaf" | "tree">;
    readNodeKinds?(
        snapshot: WorkspaceSnapshotRefV1,
        paths: readonly string[],
        signal?: AbortSignal
    ): Promise<ReadonlyMap<string, "absent" | "leaf" | "tree">>;
    verifyOwnedSnapshot(snapshot: WorkspaceSnapshotRefV1): Promise<void>;
    diff(before: WorkspaceSnapshotRefV1, after: WorkspaceSnapshotRefV1): Promise<WorkspacePathChangeV1[]>;
}

export interface WorkspaceSnapshotTrackerPathCapture {
    capture(paths: readonly string[], signal?: AbortSignal, timeoutMs?: number): Promise<IncrementalPathCaptureResult>;
    consumeCaptured<T>(
        result: IncrementalPathCaptureResult,
        consumer: (batch: IncrementalCapturedBatch) => Promise<T>
    ): Promise<T>;
    discardCaptured(result: IncrementalPathCaptureResult): Promise<void>;
    dispose(): Promise<void>;
}

export interface WorkspaceSnapshotTrackerStateAccess {
    load(): Promise<LoadedWorkspaceTrackerState>;
    publish(input: {
        current: WorkspaceSnapshotRefV1;
        coverage: WorkspaceSnapshotCoverage | Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
    }): Promise<void>;
}

export interface WorkspaceSnapshotTrackerHooks {
    afterIncrementalSnapshotPublished?(): void | Promise<void>;
    afterTrackerStatePublished?(): void | Promise<void>;
}

export interface WorkspaceSnapshotTrackerOptions {
    store: WorkspaceSnapshotTrackerStore;
    feed: WorkspaceChangeFeed;
    state?: WorkspaceSnapshotTrackerStateAccess;
    makePathCapture?(input: {
        snapshot: WorkspaceSnapshotRefV1;
        scope: WorkspaceScopeManifest;
        base: {
            readNodeKind(path: string, signal?: AbortSignal): Promise<"absent" | "leaf" | "tree">;
            readNodeKinds?(
                paths: readonly string[],
                signal?: AbortSignal
            ): Promise<ReadonlyMap<string, "absent" | "leaf" | "tree">>;
        };
    }): WorkspaceSnapshotTrackerPathCapture;
    hooks?: WorkspaceSnapshotTrackerHooks;
}

interface WorkspaceSnapshotCapture {
    ref: WorkspaceSnapshotRefV1;
    coverage: WorkspaceSnapshotCoverage;
}

interface WorkspaceIncrementalMetadata {
    scope: WorkspaceScopeManifest;
    coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
}

interface TrackerCurrent extends WorkspaceIncrementalMetadata {
    ref: WorkspaceSnapshotRefV1;
    coverage: WorkspaceSnapshotCoverage;
}

export class WorkspaceSnapshotTracker implements LegacyWorkspaceSnapshotCapture {
    readonly store: WorkspaceSnapshotTrackerStore;
    readonly feed: WorkspaceChangeFeed;
    readonly state: WorkspaceSnapshotTrackerStateAccess;
    readonly makePathCapture: NonNullable<WorkspaceSnapshotTrackerOptions["makePathCapture"]>;
    readonly hooks?: WorkspaceSnapshotTrackerHooks;
    captureQueue: Promise<void> = Promise.resolve();
    loadPromise?: Promise<LoadedWorkspaceTrackerState>;
    current?: TrackerCurrent;
    pathCapture?: WorkspaceSnapshotTrackerPathCapture;
    readonly retainedPathCaptures = new Set<WorkspaceSnapshotTrackerPathCapture>();
    needsReconcile = true;
    lifecycle: "active" | "disposing" | "disposed" = "active";
    disposePromise?: Promise<void>;

    constructor(input: WorkspaceSnapshotTrackerOptions) {
        this.store = input.store;
        this.feed = input.feed;
        this.hooks = input.hooks;
        this.state = input.state ?? {
            load: async () => ({ status: "untrusted" }),
            publish: async () => undefined,
        };
        this.makePathCapture = input.makePathCapture ?? ((options) => this.makeDefaultPathCapture(options));
    }

    capture(options: CaptureWorkspaceOptions): Promise<WorkspaceSnapshotCapture> {
        if (this.lifecycle !== "active") return Promise.reject(new Error("Workspace snapshot tracker is disposed"));
        const ownedOptions: CaptureWorkspaceOptions = {
            profile: options.profile,
            ...(options.requiredPaths ? { requiredPaths: [...options.requiredPaths] } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
        };
        const operation = this.captureQueue.then(() => this.captureActive(ownedOptions));
        this.captureQueue = operation.then(
            () => undefined,
            () => undefined
        );
        return operation;
    }

    diff(before: WorkspaceSnapshotRefV1, after: WorkspaceSnapshotRefV1): Promise<WorkspacePathChangeV1[]> {
        return this.store.diff(before, after);
    }

    dispose(): Promise<void> {
        if (this.disposePromise) return this.disposePromise;
        this.lifecycle = "disposing";
        const disposing = this.captureQueue.then(async () => {
            const captures = [
                ...new Set([this.pathCapture, ...this.retainedPathCaptures].filter((item) => item != null)),
            ];
            const results = await Promise.allSettled([
                ...captures.map((capture) => capture.dispose()),
                this.feed.dispose(),
            ]);
            for (let index = 0; index < captures.length; index++) {
                if (results[index]!.status === "fulfilled") this.retainedPathCaptures.delete(captures[index]!);
            }
            const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
            if (failures.length === 1) throw failures[0]!.reason;
            if (failures.length > 1) {
                throw new AggregateError(
                    failures.map((failure) => failure.reason),
                    "Workspace snapshot tracker resource disposal failed"
                );
            }
            this.pathCapture = undefined;
            this.retainedPathCaptures.clear();
            this.lifecycle = "disposed";
        });
        this.disposePromise = disposing.catch((error) => {
            this.disposePromise = undefined;
            throw error;
        });
        return this.disposePromise;
    }

    async captureActive(options: CaptureWorkspaceOptions): Promise<WorkspaceSnapshotCapture> {
        options.signal?.throwIfAborted();
        await this.loadDurableState();
        options.signal?.throwIfAborted();
        if (options.requiredPaths && options.requiredPaths.length > 0) {
            return await this.fullReconcile(options);
        }
        if (this.needsReconcile || !this.current || !this.pathCapture) {
            return await this.fullReconcile(options);
        }
        options.signal?.throwIfAborted();
        this.needsReconcile = true;
        const changes = await this.feed.drain();
        if (options.signal?.aborted) {
            options.signal.throwIfAborted();
        }
        if (
            changes.status === "unavailable" ||
            !this.feed.isTrusted() ||
            changes.changedPaths.some(invalidatesSnapshotScope)
        ) {
            return await this.fullReconcile(options);
        }
        if (changes.changedPaths.length === 0) {
            return await this.publishEmptyCapture(options.signal);
        }
        return await this.captureDirty(options, changes.changedPaths);
    }

    async loadDurableState(): Promise<void> {
        if (!this.loadPromise) this.loadPromise = this.state.load();
        await this.loadPromise;
    }

    async fullReconcile(options: CaptureWorkspaceOptions): Promise<WorkspaceSnapshotCapture> {
        this.needsReconcile = true;
        await this.feed.start();
        const previousPathCapture = this.pathCapture;
        let previousDisposed = false;
        let nextPathCapture: WorkspaceSnapshotTrackerPathCapture | undefined;
        try {
            const captured = await this.store.captureFullReconcile(options);
            const metadata = await this.store.readIncrementalSnapshotMetadata(captured.ref);
            nextPathCapture = this.makePathCapture({
                snapshot: captured.ref,
                scope: metadata.scope,
                base: {
                    readNodeKind: (path, signal) =>
                        this.store.readNodeKind(this.current?.ref ?? captured.ref, path, signal),
                    ...(this.store.readNodeKinds
                        ? {
                              readNodeKinds: (paths: readonly string[], signal?: AbortSignal) =>
                                  this.store.readNodeKinds!(this.current?.ref ?? captured.ref, paths, signal),
                          }
                        : {}),
                },
            });
            if (!this.feed.isTrusted()) throw new Error("Workspace change feed lost trust during reconcile");
            await previousPathCapture?.dispose();
            previousDisposed = previousPathCapture != null;
            if (this.pathCapture === previousPathCapture) this.pathCapture = undefined;
            await this.state.publish({ current: captured.ref, coverage: captured.coverage });
            this.current = {
                ref: captured.ref,
                scope: cloneScope(metadata.scope),
                coverage: cloneCoverage(captured.coverage),
            };
            this.pathCapture = nextPathCapture;
            this.needsReconcile = false;
            return cloneCapture(captured);
        } catch (error) {
            const failures = [error];
            if (nextPathCapture && nextPathCapture !== previousPathCapture) {
                try {
                    await nextPathCapture.dispose();
                } catch (cleanupError) {
                    this.retainedPathCaptures.add(nextPathCapture);
                    failures.push(cleanupError);
                }
            }
            this.pathCapture = previousDisposed ? undefined : previousPathCapture;
            this.current = undefined;
            if (failures.length > 1) {
                throw new AggregateError(failures, "Workspace snapshot tracker reconcile cleanup failed");
            }
            throw error;
        }
    }

    async publishEmptyCapture(signal?: AbortSignal): Promise<WorkspaceSnapshotCapture> {
        const current = this.current!;
        this.needsReconcile = true;
        signal?.throwIfAborted();
        await this.state.publish({ current: current.ref, coverage: current.coverage });
        const capture = {
            ref: { ...current.ref },
            coverage: { ...cloneCoverage(current.coverage), newlyHashedBytes: 0 },
        };
        this.current = { ...current, coverage: capture.coverage };
        this.needsReconcile = false;
        return capture;
    }

    async captureDirty(
        options: CaptureWorkspaceOptions,
        initialPaths: readonly string[]
    ): Promise<WorkspaceSnapshotCapture> {
        let paths = canonicalPaths(initialPaths);
        for (let attempt = 0; attempt < 2; attempt++) {
            const timeoutMs =
                options.profile === "pre-turn"
                    ? WorkspaceCheckpointLimits.preTurnTimeoutMs
                    : WorkspaceCheckpointLimits.terminalTimeoutMs;
            let result: IncrementalPathCaptureResult;
            try {
                result = await this.pathCapture!.capture(paths, options.signal, timeoutMs);
            } catch (error) {
                if (
                    error !== options.signal?.reason &&
                    error instanceof AnchoredReaderError &&
                    error.code === "timeout"
                ) {
                    throw new WorkspaceSnapshotStoreError("capture_timeout", "Workspace snapshot capture timed out", {
                        cause: error,
                    });
                }
                throw error;
            }
            if (result.status === "reconcile") return await this.fullReconcile(options);
            let validation: WorkspaceChangeDrain;
            try {
                validation = await this.feed.drain();
            } catch (error) {
                await this.pathCapture!.discardCaptured(result).catch(() => undefined);
                this.needsReconcile = true;
                throw error;
            }
            if (validation.status === "unavailable" || !this.feed.isTrusted()) {
                await this.pathCapture!.discardCaptured(result);
                return await this.fullReconcile(options);
            }
            if (validation.changedPaths.length > 0) {
                await this.pathCapture!.discardCaptured(result);
                if (attempt === 1) return await this.fullReconcile(options);
                paths = canonicalPaths([...paths, ...validation.changedPaths]);
                continue;
            }
            return await this.commitIncremental(options, result);
        }
        return await this.fullReconcile(options);
    }

    async commitIncremental(
        options: CaptureWorkspaceOptions,
        result: Extract<IncrementalPathCaptureResult, { status: "captured" }>
    ): Promise<WorkspaceSnapshotCapture> {
        const current = this.current!;
        this.needsReconcile = true;
        let consumed = false;
        try {
            const coverage = await this.store.computeIncrementalSnapshotCoverage(current.ref, result.mutations);
            const captured = await this.pathCapture!.consumeCaptured(result, async (batch) => {
                consumed = true;
                return await this.store.commitCapturedIncrementalSnapshot({
                    base: current.ref,
                    mutations: result.mutations,
                    scope: current.scope,
                    coverage,
                    newlyHashedBytes: result.newlyHashedBytes,
                    profile: options.profile,
                    batch,
                });
            });
            await this.hooks?.afterIncrementalSnapshotPublished?.();
            await this.state.publish({ current: captured.ref, coverage: captured.coverage });
            await this.hooks?.afterTrackerStatePublished?.();
            this.current = {
                ref: { ...captured.ref },
                scope: cloneScope(current.scope),
                coverage: cloneCoverage(captured.coverage),
            };
            this.needsReconcile = false;
            return cloneCapture(captured);
        } catch (error) {
            if (!consumed) await this.pathCapture!.discardCaptured(result).catch(() => undefined);
            throw error;
        }
    }

    makeDefaultPathCapture(input: {
        scope: WorkspaceScopeManifest;
        base: {
            readNodeKind(path: string, signal?: AbortSignal): Promise<"absent" | "leaf" | "tree">;
            readNodeKinds?(
                paths: readonly string[],
                signal?: AbortSignal
            ): Promise<ReadonlyMap<string, "absent" | "leaf" | "tree">>;
        };
    }): WorkspaceSnapshotTrackerPathCapture {
        return new IncrementalPathCapture({
            identity: this.store.identity,
            git: this.store.git,
            storeRoot: this.store.storeRoot,
            scope: input.scope,
            maxEntries: WorkspaceCheckpointLimits.maxEntries,
            maxUntrackedBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
            maxNewlyHashedBytes: WorkspaceCheckpointLimits.maxNewlyHashedBytes,
            timeoutMs: WorkspaceCheckpointLimits.preTurnTimeoutMs,
            base: input.base,
        });
    }
}

function canonicalPaths(paths: readonly string[]): string[] {
    return [...new Set(paths)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function invalidatesSnapshotScope(path: string): boolean {
    const segments = path.split("/");
    return (
        path === ".git/index" ||
        path === ".git/info/exclude" ||
        segments.includes(".git") ||
        segments.includes(".gitignore")
    );
}

function cloneScope(scope: WorkspaceScopeManifest): WorkspaceScopeManifest {
    return JSON.parse(JSON.stringify(scope)) as WorkspaceScopeManifest;
}

function cloneCoverage(coverage: WorkspaceSnapshotCoverage): WorkspaceSnapshotCoverage {
    return {
        complete: coverage.complete,
        eligibleEntryCount: coverage.eligibleEntryCount,
        newlyHashedBytes: coverage.newlyHashedBytes,
        exclusions: coverage.exclusions.map((exclusion) => ({ ...exclusion })),
    };
}

function cloneCapture(capture: WorkspaceSnapshotCapture): WorkspaceSnapshotCapture {
    return { ref: { ...capture.ref }, coverage: cloneCoverage(capture.coverage) };
}
