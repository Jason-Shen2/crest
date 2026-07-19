// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface ManagedAgentRuntime {
    isRunning(): boolean;
    dispose(): void;
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

export class AgentRuntimeRegistry<TRuntime extends ManagedAgentRuntime> {
    entries = new Map<string, AgentRuntimeEntry<TRuntime>>();
    pendingCreates = new Map<string, Promise<TRuntime>>();
    idleTtlMs: number;
    now: () => number;

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
        const existing = this.get(path);
        if (existing) return existing;
        const pending = this.pendingCreates.get(path);
        if (pending) return pending;
        const creation = create()
            .then((runtime) => {
                this.entries.set(path, {
                    runtime,
                    subscriberKeys: new Set(),
                    lastUsedAt: this.now(),
                });
                return runtime;
            })
            .finally(() => this.pendingCreates.delete(path));
        this.pendingCreates.set(path, creation);
        return creation;
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

    evictIdle(now = this.now()): string[] {
        const evicted: string[] = [];
        for (const [path, entry] of this.entries) {
            if (entry.subscriberKeys.size > 0) continue;
            if (entry.runtime.isRunning()) continue;
            if (now - entry.lastUsedAt < this.idleTtlMs) continue;
            entry.runtime.dispose();
            this.entries.delete(path);
            evicted.push(path);
        }
        return evicted;
    }

    disposeAll(): void {
        for (const entry of this.entries.values()) {
            entry.runtime.dispose();
        }
        this.entries.clear();
        this.pendingCreates.clear();
    }
}
