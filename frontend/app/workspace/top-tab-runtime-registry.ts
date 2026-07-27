// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface TopTabRuntimeSnapshot {
    dirty: boolean;
    title: string;
    status: "cold" | "loading" | "ready" | "error";
}

export interface TopTabRuntime {
    getSnapshot(): TopTabRuntimeSnapshot;
    subscribe(listener: () => void): () => void;
    dispose(): void | Promise<void>;
    disposeAlias?(topTabId: string): void | Promise<void>;
}

export class WorkspaceTopTabRuntimeRegistry {
    runtimes = new Map<string, TopTabRuntime>();
    listeners = new Map<string, Set<() => void>>();
    pendingClose = new Map<string, { runtime: TopTabRuntime; token: object }>();
    disposeErrors: unknown[] = [];
    disposed = false;

    getOrCreate(topTabId: string, factory: () => TopTabRuntime): TopTabRuntime {
        if (this.disposed) {
            throw new Error("Workspace Top Tab runtime registry is disposed");
        }
        const current = this.runtimes.get(topTabId);
        if (current) {
            return current;
        }
        const runtime = factory();
        this.runtimes.set(topTabId, runtime);
        this.emit(topTabId);
        return runtime;
    }

    get(topTabId: string): TopTabRuntime | undefined {
        return this.runtimes.get(topTabId);
    }

    subscribe(topTabId: string, listener: () => void): () => void {
        let listeners = this.listeners.get(topTabId);
        if (!listeners) {
            listeners = new Set();
            this.listeners.set(topTabId, listeners);
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) {
                this.listeners.delete(topTabId);
            }
        };
    }

    async close(topTabId: string, expectedRuntime?: TopTabRuntime): Promise<void> {
        const runtime = this.runtimes.get(topTabId);
        if (!runtime || (expectedRuntime && runtime !== expectedRuntime)) {
            return;
        }
        this.pendingClose.delete(topTabId);
        this.runtimes.delete(topTabId);
        this.emit(topTabId);
        await (runtime.disposeAlias ? runtime.disposeAlias(topTabId) : runtime.dispose());
    }

    scheduleClose(topTabId: string, runtime: TopTabRuntime): void {
        const token = {};
        this.pendingClose.set(topTabId, { runtime, token });
        queueMicrotask(() => {
            const pending = this.pendingClose.get(topTabId);
            if (pending?.token !== token || pending.runtime !== runtime) {
                return;
            }
            this.pendingClose.delete(topTabId);
            void this.closeSafely(topTabId, runtime);
        });
    }

    cancelScheduledClose(topTabId: string, runtime: TopTabRuntime): void {
        if (this.pendingClose.get(topTabId)?.runtime === runtime) {
            this.pendingClose.delete(topTabId);
        }
    }

    async closeSafely(topTabId: string, expectedRuntime?: TopTabRuntime): Promise<void> {
        try {
            await this.close(topTabId, expectedRuntime);
        } catch (error) {
            this.disposeErrors.push(error);
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.pendingClose.clear();
        const entries = [...this.runtimes.entries()];
        this.runtimes.clear();
        entries.forEach(([topTabId]) => this.emit(topTabId));
        let results: PromiseSettledResult<void>[] = [];
        try {
            results = await Promise.allSettled(
                entries.map(([topTabId, runtime]) =>
                    Promise.resolve().then(() =>
                        runtime.disposeAlias ? runtime.disposeAlias(topTabId) : runtime.dispose()
                    )
                )
            );
        } finally {
            this.listeners.clear();
        }
        const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason);
        if (errors.length > 0) {
            throw new AggregateError(errors, "Workspace Top Tab runtime disposal failed");
        }
    }

    async disposeSafely(): Promise<void> {
        try {
            await this.dispose();
        } catch (error) {
            if (error instanceof AggregateError) {
                this.disposeErrors.push(...error.errors);
                return;
            }
            this.disposeErrors.push(error);
        }
    }

    emit(topTabId: string): void {
        const listeners = [...(this.listeners.get(topTabId) ?? [])];
        queueMicrotask(() =>
            listeners.forEach((listener) => {
                if (this.listeners.get(topTabId)?.has(listener)) {
                    listener();
                }
            })
        );
    }
}
