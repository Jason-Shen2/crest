// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

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

export interface ExclusiveSessionMutationOptions {
    rejectIfRunning?: boolean;
    onExclusiveStart?: () => void;
    afterSessionAccessDrained?: () => void;
    beforeRuntimeDisposal?: () => void | Promise<void>;
    onFailureBeforeRelease?: (error: unknown) => void | Promise<void>;
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
    exclusiveSessionMutationTurns = new Map<string, Promise<void>>();
    sessionAccess = new Map<string, SessionAccessState>();

    constructor(options: AgentRuntimeRegistryOptions) {
        this.idleTtlMs = options.idleTtlMs;
        this.now = options.now ?? (() => Date.now());
    }

    get(path: string): TRuntime | undefined {
        if (this.disposing) return undefined;
        const entry = this.entries.get(path);
        if (!entry || entry.cleanupFailed || this.pathCleanups.has(path)) return undefined;
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
        if (this.disposing) {
            throw new Error("Agent runtime registry disposal is in progress");
        }
        const previousTurn = this.exclusiveSessionMutationTurns.get(path);
        let releaseTurn!: () => void;
        const turn = new Promise<void>((resolve) => {
            releaseTurn = resolve;
        });
        this.exclusiveSessionMutationTurns.set(path, turn);
        if (previousTurn) {
            await previousTurn;
        } else {
            this.exclusiveSessionMutations.add(path);
        }
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
        } finally {
            if (this.exclusiveSessionMutationTurns.get(path) === turn) {
                this.exclusiveSessionMutationTurns.delete(path);
                this.exclusiveSessionMutations.delete(path);
            }
            releaseTurn();
        }
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
        return cleanups
            .filter((_, index) => results[index].status === "fulfilled")
            .map(({ path }) => path);
    }

    disposeAll(): Promise<void> {
        if (this.disposalPromise) {
            return this.disposalPromise;
        }
        this.disposing = true;
        this.generation++;
        const pendingCreates = Array.from(this.pendingCreates.values());
        const inFlightEvictions = Array.from(this.inFlightEvictions);
        const exclusiveTurns = Array.from(this.exclusiveSessionMutationTurns.values());
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
        if (this.exclusiveSessionMutations.has(path)) {
            throw new AgentSessionMutationActiveError(path);
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
