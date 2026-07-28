// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { SessionMutationBarrier } from "./session-mutation-barrier";
import { assertWorkspaceLockNotHeld } from "./workspace-rewind/workspace-lock";

export interface ManagedAgentRuntime {
    isRunning(): boolean;
    dispose(): void | Promise<void>;
}

export class AgentSessionMutationActiveError extends Error {
    constructor(readonly path: string) {
        super(`Agent runtime registry exclusive session mutation is active for ${path}`);
        this.name = "AgentSessionMutationActiveError";
    }
}

interface AgentRuntimeEntry<TRuntime extends ManagedAgentRuntime> {
    runtime: TRuntime;
    subscriberKeys: Set<string>;
    lastUsedAt: number;
    cleanupFailed: boolean;
    cleanupFailure?: unknown;
}

interface SessionAccessState {
    activeCount: number;
    waiters: Array<() => void>;
}

interface SessionMutationBarrierEntry {
    barrier: SessionMutationBarrier;
    usageCount: number;
}

export interface ExclusiveSessionMutationOptions {
    rejectIfRunning?: boolean;
    onExclusiveStart?: () => void;
    afterSessionAccessDrained?: () => void;
    beforeRuntimeDisposal?: () => void | Promise<void>;
    onFailureBeforeRelease?: (error: unknown) => void | Promise<void>;
}

export interface RetainedSessionMutationLease<TRuntime> {
    readonly path: string;
    readonly runtime?: TRuntime;
    readonly token: symbol;
}

export interface AgentRuntimeRegistryOptions {
    idleTtlMs: number;
    now?: () => number;
}

export class AgentRuntimeRegistry<TRuntime extends ManagedAgentRuntime> {
    entries = new Map<string, AgentRuntimeEntry<TRuntime>>();
    pendingCreates = new Map<string, Promise<TRuntime>>();
    idleTtlMs: number;
    now: () => number;
    generation = 0;
    disposing = false;
    disposalPromise: Promise<void>;
    inFlightEvictions = new Set<Promise<void>>();
    pathCleanups = new Map<string, Promise<void>>();
    exclusiveSessionMutations = new Set<string>();
    mutationTombstoneCounts = new Map<string, number>();
    private sessionMutationBarriers = new Map<string, SessionMutationBarrierEntry>();
    activeRetainedLeases = new Map<symbol, RetainedSessionMutationLease<TRuntime>>();
    sessionAccess = new Map<string, SessionAccessState>();

    constructor(options: AgentRuntimeRegistryOptions) {
        this.idleTtlMs = options.idleTtlMs;
        this.now = options.now ?? (() => Date.now());
    }

    get(path: string): TRuntime | undefined {
        if (this.disposing) return undefined;
        const entry = this.entries.get(path);
        if (!entry || entry.cleanupFailed || this.pathCleanups.has(path) || this.isMutationActive(path)) {
            return undefined;
        }
        entry.lastUsedAt = this.now();
        return entry.runtime;
    }

    async getOrCreate(path: string, create: () => Promise<TRuntime>): Promise<TRuntime> {
        if (this.disposing) {
            throw new Error("Agent runtime registry disposal is in progress");
        }
        this.assertSessionAccessible(path);
        const cleanup = this.pathCleanups.get(path);
        if (cleanup) {
            await cleanup;
            if (this.disposing) {
                throw new Error("Agent runtime registry disposal is in progress");
            }
            this.assertSessionAccessible(path);
        }
        const failedEntry = this.entries.get(path);
        if (failedEntry?.cleanupFailed) {
            throw new Error(`Agent runtime cleanup failed for ${path}`, { cause: failedEntry.cleanupFailure });
        }
        const existing = this.get(path);
        if (existing) return existing;
        const pending = this.pendingCreates.get(path);
        if (pending) return pending;
        const generation = this.generation;
        const creation = create().then(async (runtime) => {
            if (generation !== this.generation || this.disposing) {
                if (this.entries.has(path)) {
                    throw new Error(`Agent runtime cleanup owner already exists for ${path}`);
                }
                const entry: AgentRuntimeEntry<TRuntime> = {
                    runtime,
                    subscriberKeys: new Set(),
                    lastUsedAt: this.now(),
                    cleanupFailed: false,
                };
                this.entries.set(path, entry);
                try {
                    await this.startEntryCleanup(path, entry);
                } catch (error) {
                    console.error(
                        "[agent-runtime-registry] runtime creation cleanup failed",
                        new AggregateError([error])
                    );
                    throw new Error("Agent runtime registry disposed during creation", { cause: error });
                }
                throw new Error("Agent runtime registry disposed during creation");
            }
            this.entries.set(path, {
                runtime,
                subscriberKeys: new Set(),
                lastUsedAt: this.now(),
                cleanupFailed: false,
            });
            return runtime;
        });
        const trackedCreation = creation.finally(() => {
            if (this.pendingCreates.get(path) === trackedCreation) {
                this.pendingCreates.delete(path);
            }
        });
        this.pendingCreates.set(path, trackedCreation);
        return trackedCreation;
    }

    async withSessionAccess<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
        this.assertSessionAccessible(path);
        const state = this.getOrCreateSessionAccessState(path);
        state.activeCount++;
        try {
            return await fn();
        } finally {
            this.releaseSessionAccess(path, state);
        }
    }

    async withExclusiveSessionMutation<T>(
        path: string,
        options: ExclusiveSessionMutationOptions,
        fn: () => Promise<T> | T
    ): Promise<T> {
        assertWorkspaceLockNotHeld();
        if (this.disposing) {
            throw new Error("Agent runtime registry disposal is in progress");
        }
        this.addMutationTombstone(path);
        const operation = this.runWithSessionMutationBarrier(path, async () => {
            try {
                options.onExclusiveStart?.();
                await this.waitForSessionAccessToDrain(path);
                const pendingCreate = this.pendingCreates.get(path);
                if (pendingCreate) {
                    await pendingCreate.catch(() => undefined);
                }
                options.afterSessionAccessDrained?.();
                const cleanup = this.pathCleanups.get(path);
                if (cleanup) {
                    await cleanup;
                }
                await options.beforeRuntimeDisposal?.();
                const entry = this.entries.get(path);
                if (entry?.runtime.isRunning() && options.rejectIfRunning) {
                    throw new Error("Agent session is running");
                }
                if (entry && !entry.runtime.isRunning()) {
                    await this.startEntryCleanup(path, entry);
                }
                return await fn();
            } catch (error) {
                try {
                    await options.onFailureBeforeRelease?.(error);
                } catch (recoveryError) {
                    throw new AggregateError(
                        [error, recoveryError],
                        `Agent runtime registry exclusive session mutation recovery failed for ${path}`
                    );
                }
                throw error;
            }
        });
        return operation.finally(() => this.removeMutationTombstone(path));
    }

    withRetainedSessionMutation<T>(
        path: string,
        options: { rejectIfRunning?: boolean },
        fn: (lease: RetainedSessionMutationLease<TRuntime>) => Promise<T>
    ): Promise<T> {
        assertWorkspaceLockNotHeld();
        if (this.disposing) {
            return Promise.reject(new Error("Agent runtime registry disposal is in progress"));
        }
        this.addMutationTombstone(path);
        const operation = this.runWithSessionMutationBarrier(path, async () => {
            await this.waitForSessionAccessToDrain(path);
            const pendingCreate = this.pendingCreates.get(path);
            if (pendingCreate) {
                await pendingCreate.catch(() => undefined);
            }
            const cleanup = this.pathCleanups.get(path);
            if (cleanup) {
                await cleanup;
            }
            const entry = this.entries.get(path);
            if (entry?.cleanupFailed) {
                throw new Error(`Agent runtime cleanup failed for ${path}`, {
                    cause: entry.cleanupFailure,
                });
            }
            if (entry?.runtime.isRunning() && options.rejectIfRunning) {
                throw new Error("Agent session is running");
            }
            const lease: RetainedSessionMutationLease<TRuntime> = {
                path,
                runtime: entry?.runtime,
                token: Symbol(path),
            };
            this.activeRetainedLeases.set(lease.token, lease);
            try {
                return await fn(lease);
            } finally {
                this.activeRetainedLeases.delete(lease.token);
            }
        });
        return operation.finally(() => this.removeMutationTombstone(path));
    }

    getRuntimeForLease(lease: RetainedSessionMutationLease<TRuntime>): TRuntime | undefined {
        this.assertActiveLease(lease);
        return lease.runtime;
    }

    async withMutationLeaseAccess<T>(
        lease: RetainedSessionMutationLease<TRuntime>,
        fn: (runtime: TRuntime | undefined) => Promise<T>
    ): Promise<T> {
        this.assertActiveLease(lease);
        return fn(lease.runtime);
    }

    async runWithSessionMutationBarrier<T>(path: string, operation: () => Promise<T> | T): Promise<T> {
        const entry = this.acquireSessionMutationBarrierEntry(path);
        try {
            return await entry.barrier.run(async () => operation());
        } finally {
            this.releaseSessionMutationBarrierEntry(path, entry);
        }
    }

    async waitForSessionMutationIdle(path: string): Promise<void> {
        const entry = this.acquireSessionMutationBarrierEntry(path);
        try {
            await entry.barrier.waitForIdle();
        } finally {
            this.releaseSessionMutationBarrierEntry(path, entry);
        }
    }

    getSessionMutationBarrierCountForTest(): number {
        return this.sessionMutationBarriers.size;
    }

    acquire(path: string, subscriberKey: string): void {
        const entry = this.entries.get(path);
        if (!entry) return;
        entry.subscriberKeys.add(subscriberKey);
        entry.lastUsedAt = this.now();
    }

    release(path: string, subscriberKey: string): void {
        const entry = this.entries.get(path);
        if (!entry) return;
        entry.subscriberKeys.delete(subscriberKey);
        entry.lastUsedAt = this.now();
    }

    async evictIdle(now = this.now()): Promise<string[]> {
        if (this.disposing) return [];
        const cleanups: Array<{ path: string; promise: Promise<void> }> = [];
        for (const [path, entry] of this.entries) {
            if (entry.cleanupFailed) continue;
            if (this.pathCleanups.has(path)) continue;
            if (this.exclusiveSessionMutations.has(path)) continue;
            if (entry.subscriberKeys.size > 0) continue;
            if (entry.runtime.isRunning()) continue;
            if (now - entry.lastUsedAt < this.idleTtlMs) continue;
            const cleanup = this.startEntryCleanup(path, entry);
            cleanups.push({ path, promise: cleanup });
        }
        const results = await Promise.allSettled(cleanups.map(({ promise }) => promise));
        const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason);
        if (errors.length > 0) {
            console.error("[agent-runtime-registry] runtime eviction failed", new AggregateError(errors));
        }
        return cleanups.filter((_, index) => results[index].status === "fulfilled").map(({ path }) => path);
    }

    disposeAll(): Promise<void> {
        if (this.disposalPromise) {
            return this.disposalPromise;
        }
        this.disposing = true;
        this.generation++;
        const pendingCreates = Array.from(this.pendingCreates.values());
        const inFlightEvictions = Array.from(this.inFlightEvictions);
        const exclusiveTurns = Array.from(this.sessionMutationBarriers.keys()).map((path) =>
            this.waitForSessionMutationIdle(path)
        );
        const disposal = (async () => {
            if (pendingCreates.length > 0 || inFlightEvictions.length > 0 || exclusiveTurns.length > 0) {
                await Promise.all([
                    Promise.allSettled(pendingCreates),
                    Promise.allSettled(inFlightEvictions),
                    Promise.allSettled(exclusiveTurns),
                ]);
            }
            const cleanups = Array.from(this.entries)
                .filter(([, entry]) => !entry.cleanupFailed)
                .map(([path, entry]) => this.startEntryCleanup(path, entry));
            const results = await Promise.allSettled(cleanups);
            const errors = results
                .filter((result): result is PromiseRejectedResult => result.status === "rejected")
                .map((result) => result.reason);
            if (errors.length > 0) {
                console.error("[agent-runtime-registry] registry disposal failed", new AggregateError(errors));
            }
        })().finally(() => {
            if (this.disposalPromise === disposal) {
                this.disposalPromise = undefined;
                this.disposing = false;
            }
        });
        this.disposalPromise = disposal;
        return disposal;
    }

    private startEntryCleanup(path: string, entry: AgentRuntimeEntry<TRuntime>): Promise<void> {
        const existing = this.pathCleanups.get(path);
        if (existing) return existing;
        const cleanup = Promise.resolve()
            .then(() => entry.runtime.dispose())
            .then(() => {
                if (this.entries.get(path) === entry) {
                    this.entries.delete(path);
                }
            })
            .catch((error) => {
                if (this.entries.get(path) === entry) {
                    entry.cleanupFailed = true;
                    entry.cleanupFailure = error;
                }
                throw error;
            })
            .finally(() => {
                if (this.pathCleanups.get(path) === cleanup) {
                    this.pathCleanups.delete(path);
                }
                this.inFlightEvictions.delete(cleanup);
                const barrierEntry = this.sessionMutationBarriers.get(path);
                if (barrierEntry) {
                    this.cleanupSessionMutationBarrier(path, barrierEntry);
                }
            });
        this.pathCleanups.set(path, cleanup);
        this.inFlightEvictions.add(cleanup);
        return cleanup;
    }

    async disposeRuntimes(runtimes: TRuntime[], context: string): Promise<void> {
        const results = await Promise.allSettled(
            runtimes.map((runtime) => Promise.resolve().then(() => runtime.dispose()))
        );
        const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason);
        if (errors.length === 0) {
            return;
        }
        console.error(`[agent-runtime-registry] ${context} failed`, new AggregateError(errors));
    }

    private assertSessionAccessible(path: string): void {
        if (this.isMutationActive(path)) {
            throw new AgentSessionMutationActiveError(path);
        }
    }

    private addMutationTombstone(path: string): void {
        const count = (this.mutationTombstoneCounts.get(path) ?? 0) + 1;
        this.mutationTombstoneCounts.set(path, count);
        this.exclusiveSessionMutations.add(path);
    }

    private removeMutationTombstone(path: string): void {
        const count = (this.mutationTombstoneCounts.get(path) ?? 1) - 1;
        if (count > 0) {
            this.mutationTombstoneCounts.set(path, count);
            return;
        }
        this.mutationTombstoneCounts.delete(path);
        this.exclusiveSessionMutations.delete(path);
        const barrierEntry = this.sessionMutationBarriers.get(path);
        if (barrierEntry) {
            this.cleanupSessionMutationBarrier(path, barrierEntry);
        }
    }

    private isMutationActive(path: string): boolean {
        return (this.mutationTombstoneCounts.get(path) ?? 0) > 0;
    }

    private acquireSessionMutationBarrierEntry(path: string): SessionMutationBarrierEntry {
        let entry = this.sessionMutationBarriers.get(path);
        if (!entry) {
            entry = {
                barrier: undefined!,
                usageCount: 0,
            };
            entry.barrier = new SessionMutationBarrier(() => this.cleanupSessionMutationBarrier(path, entry!));
            this.sessionMutationBarriers.set(path, entry);
        }
        entry.usageCount++;
        return entry;
    }

    private releaseSessionMutationBarrierEntry(path: string, entry: SessionMutationBarrierEntry): void {
        if (entry.usageCount <= 0) {
            throw new Error("Session mutation barrier usage underflow");
        }
        entry.usageCount--;
        this.cleanupSessionMutationBarrier(path, entry);
    }

    private cleanupSessionMutationBarrier(path: string, entry: SessionMutationBarrierEntry): void {
        if (this.sessionMutationBarriers.get(path) !== entry || entry.usageCount !== 0 || entry.barrier.isBusy()) {
            return;
        }
        if (
            this.entries.has(path) ||
            this.pendingCreates.has(path) ||
            this.pathCleanups.has(path) ||
            this.sessionAccess.has(path) ||
            this.isMutationActive(path)
        ) {
            return;
        }
        this.sessionMutationBarriers.delete(path);
    }

    private assertActiveLease(lease: RetainedSessionMutationLease<TRuntime>): void {
        if (this.activeRetainedLeases.get(lease.token) !== lease) {
            throw new Error("Invalid or expired retained session mutation lease");
        }
    }

    private getOrCreateSessionAccessState(path: string): SessionAccessState {
        let state = this.sessionAccess.get(path);
        if (state) return state;
        state = { activeCount: 0, waiters: [] };
        this.sessionAccess.set(path, state);
        return state;
    }

    private releaseSessionAccess(path: string, state: SessionAccessState): void {
        state.activeCount--;
        if (state.activeCount > 0) return;
        this.sessionAccess.delete(path);
        const waiters = state.waiters.splice(0);
        for (const waiter of waiters) {
            waiter();
        }
        const barrierEntry = this.sessionMutationBarriers.get(path);
        if (barrierEntry) {
            this.cleanupSessionMutationBarrier(path, barrierEntry);
        }
    }

    private async waitForSessionAccessToDrain(path: string): Promise<void> {
        const state = this.sessionAccess.get(path);
        if (!state || state.activeCount === 0) {
            return;
        }
        await new Promise<void>((resolve) => {
            state.waiters.push(resolve);
        });
    }
}
