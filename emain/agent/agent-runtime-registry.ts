// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface ManagedAgentRuntime {
    isRunning(): boolean;
    dispose(): void | Promise<void>;
}

interface AgentRuntimeEntry<TRuntime extends ManagedAgentRuntime> {
    runtime: TRuntime;
    subscriberKeys: Set<string>;
    lastUsedAt: number;
}

export interface AgentRuntimeRegistryOptions {
    idleTtlMs: number;
    now?: () => number;
}

async function runDisposals(disposals: Array<() => void | Promise<void>>): Promise<void> {
    const results = await Promise.allSettled(disposals.map(async (dispose) => dispose()));
    const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Agent runtime disposal failed");
}

export class AgentRuntimeRegistry<TRuntime extends ManagedAgentRuntime> {
    entries = new Map<string, AgentRuntimeEntry<TRuntime>>();
    pendingCreates = new Map<string, Promise<TRuntime>>();
    pendingDisposals = new Map<string, Promise<void>>();
    idleTtlMs: number;
    now: () => number;
    generation = 0;
    invalidationPromise: Promise<void> | undefined;

    constructor(options: AgentRuntimeRegistryOptions) {
        this.idleTtlMs = options.idleTtlMs;
        this.now = options.now ?? (() => Date.now());
    }

    get(path: string): TRuntime | undefined {
        const entry = this.entries.get(path);
        if (!entry) return undefined;
        entry.lastUsedAt = this.now();
        return entry.runtime;
    }

    async getOrCreate(path: string, create: () => Promise<TRuntime>): Promise<TRuntime> {
        const invalidation = this.invalidationPromise;
        if (invalidation) {
            await invalidation;
            return this.getOrCreate(path, create);
        }
        const existing = this.get(path);
        if (existing) return existing;
        const pendingDisposal = this.pendingDisposals.get(path);
        if (pendingDisposal) {
            await pendingDisposal;
            return this.getOrCreate(path, create);
        }
        const pending = this.pendingCreates.get(path);
        if (pending) return pending;
        const generation = this.generation;
        const creation = create().then(async (runtime) => {
            if (generation !== this.generation) {
                await runtime.dispose();
                throw new Error("Agent runtime registry disposed during creation");
            }
            this.entries.set(path, {
                runtime,
                subscriberKeys: new Set(),
                lastUsedAt: this.now(),
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

    async invalidate(path: string, dispose?: (runtime: TRuntime) => void | Promise<void>): Promise<boolean> {
        const entry = this.entries.get(path);
        if (!entry) return false;
        this.entries.delete(path);
        await this.startDisposal(path, async () => {
            if (dispose) {
                await dispose(entry.runtime);
            } else {
                await entry.runtime.dispose();
            }
        });
        return true;
    }

    async evictIdle(now = this.now()): Promise<string[]> {
        const evicted: string[] = [];
        const disposals: Promise<void>[] = [];
        for (const [path, entry] of this.entries) {
            if (entry.subscriberKeys.size > 0) continue;
            if (entry.runtime.isRunning()) continue;
            if (now - entry.lastUsedAt < this.idleTtlMs) continue;
            this.entries.delete(path);
            evicted.push(path);
            disposals.push(this.startDisposal(path, () => entry.runtime.dispose()));
        }
        await this.waitForDisposals(disposals);
        return evicted;
    }

    async invalidateAll(
        dispose?: (path: string, runtime: TRuntime) => void | Promise<void>
    ): Promise<string[]> {
        if (this.invalidationPromise) {
            await this.invalidationPromise;
            return [];
        }
        let resolveInvalidation!: () => void;
        this.invalidationPromise = new Promise<void>((resolve) => {
            resolveInvalidation = resolve;
        });
        this.generation++;
        const entries = [...this.entries.entries()];
        const pendingCreates = [...this.pendingCreates.values()];
        this.entries.clear();
        this.pendingCreates.clear();
        const existingDisposals = [...this.pendingDisposals.values()];
        const newDisposals = entries.map(([path, entry]) =>
            this.startDisposal(path, async () => {
                if (dispose) {
                    await dispose(path, entry.runtime);
                } else {
                    await entry.runtime.dispose();
                }
            })
        );
        try {
            await this.waitForDisposals([...existingDisposals, ...newDisposals]);
            await Promise.allSettled(pendingCreates);
            return entries.map(([path]) => path);
        } finally {
            this.invalidationPromise = undefined;
            resolveInvalidation();
        }
    }

    async disposeAll(): Promise<void> {
        await this.invalidateAll();
    }

    private startDisposal(path: string, dispose: () => void | Promise<void>): Promise<void> {
        const existing = this.pendingDisposals.get(path);
        if (existing) return existing;
        const disposal = Promise.resolve().then(dispose);
        const trackedDisposal = disposal.finally(() => {
            if (this.pendingDisposals.get(path) === trackedDisposal) {
                this.pendingDisposals.delete(path);
            }
        });
        this.pendingDisposals.set(path, trackedDisposal);
        return trackedDisposal;
    }

    private async waitForDisposals(disposals: Promise<void>[]): Promise<void> {
        await runDisposals(disposals.map((disposal) => () => disposal));
    }
}
