// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { AgentRuntimeRegistry } from "./agent-runtime-registry";

function makeRuntime(running = false) {
    return {
        isRunning: vi.fn(() => running),
        dispose: vi.fn<() => void | Promise<void>>(),
    };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("AgentRuntimeRegistry", () => {
    it("deduplicates concurrent runtime creation by session path", async () => {
        let resolve!: (runtime: ReturnType<typeof makeRuntime>) => void;
        const runtime = makeRuntime();
        const create = vi.fn(() => new Promise<ReturnType<typeof makeRuntime>>((done) => (resolve = done)));
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => 0 });

        const first = registry.getOrCreate("/a.db", create);
        const second = registry.getOrCreate("/a.db", create);
        resolve(runtime);

        await expect(first).resolves.toBe(runtime);
        await expect(second).resolves.toBe(runtime);
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("does not retain a failed creation promise", async () => {
        const runtime = makeRuntime();
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => 0 });

        await expect(
            registry.getOrCreate("/a.db", async () => {
                throw new Error("create failed");
            })
        ).rejects.toThrow("create failed");

        await expect(registry.getOrCreate("/a.db", async () => runtime)).resolves.toBe(runtime);
    });

    it("evicts only idle unreferenced runtimes after the TTL", async () => {
        let now = 0;
        const idle = makeRuntime(false);
        const running = makeRuntime(true);
        const subscribed = makeRuntime(false);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now });
        await registry.getOrCreate("/idle.db", async () => idle);
        await registry.getOrCreate("/running.db", async () => running);
        await registry.getOrCreate("/subscribed.db", async () => subscribed);
        registry.acquire("/subscribed.db", "renderer:1");
        now = 101;

        await expect(registry.evictIdle()).resolves.toEqual(["/idle.db"]);
        expect(idle.dispose).toHaveBeenCalledOnce();
        expect(running.dispose).not.toHaveBeenCalled();
        expect(subscribed.dispose).not.toHaveBeenCalled();
    });

    it("touches an entry when its last subscriber releases it", async () => {
        let now = 0;
        const runtime = makeRuntime(false);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now });
        await registry.getOrCreate("/a.db", async () => runtime);
        registry.acquire("/a.db", "renderer:1");
        now = 80;
        registry.release("/a.db", "renderer:1");
        now = 150;
        await expect(registry.evictIdle()).resolves.toEqual([]);
        now = 181;
        await expect(registry.evictIdle()).resolves.toEqual(["/a.db"]);
    });

    it("touches an existing runtime when it is reused", async () => {
        let now = 0;
        const runtime = makeRuntime(false);
        const create = vi.fn(async () => runtime);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now });
        await registry.getOrCreate("/a.db", create);
        now = 80;
        await registry.getOrCreate("/a.db", create);
        now = 150;

        await expect(registry.evictIdle()).resolves.toEqual([]);
        expect(create).toHaveBeenCalledOnce();
    });

    it("invalidates one runtime with a caller-provided disposer", async () => {
        const target = makeRuntime();
        const other = makeRuntime();
        const dispose = vi.fn();
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/target.db", async () => target);
        await registry.getOrCreate("/other.db", async () => other);

        await expect(registry.invalidate("/target.db", dispose)).resolves.toBe(true);

        expect(dispose).toHaveBeenCalledWith(target);
        expect(target.dispose).not.toHaveBeenCalled();
        expect(registry.get("/target.db")).toBeUndefined();
        expect(registry.get("/other.db")).toBe(other);
    });

    it("waits for async runtime disposal before completing idle eviction", async () => {
        const gate = deferred();
        const runtime = makeRuntime();
        runtime.dispose.mockImplementation(() => gate.promise);
        let now = 0;
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now });
        await registry.getOrCreate("/a.db", async () => runtime);
        now = 101;
        let settled = false;

        const eviction = Promise.resolve(registry.evictIdle()).then((paths) => {
            settled = true;
            return paths;
        });
        await Promise.resolve();

        expect(settled).toBe(false);
        gate.resolve();
        await expect(eviction).resolves.toEqual(["/a.db"]);
    });

    it("does not create a replacement until the previous runtime finishes disposal", async () => {
        const gate = deferred();
        const first = makeRuntime();
        const second = makeRuntime();
        first.dispose.mockImplementation(() => gate.promise);
        let now = 0;
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now });
        await registry.getOrCreate("/a.db", async () => first);
        now = 101;
        const eviction = registry.evictIdle();
        const createSecond = vi.fn(async () => second);

        const replacement = registry.getOrCreate("/a.db", createSecond);
        await Promise.resolve();

        expect(createSecond).not.toHaveBeenCalled();
        gate.resolve();
        await eviction;
        await expect(replacement).resolves.toBe(second);
        expect(createSecond).toHaveBeenCalledOnce();
    });

    it("waits for every async runtime disposal during shutdown", async () => {
        const firstGate = deferred();
        const secondGate = deferred();
        const first = makeRuntime();
        const second = makeRuntime();
        first.dispose.mockImplementation(() => firstGate.promise);
        second.dispose.mockImplementation(() => secondGate.promise);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => first);
        await registry.getOrCreate("/b.db", async () => second);
        let settled = false;

        const shutdown = Promise.resolve(registry.disposeAll()).then(() => {
            settled = true;
        });
        await Promise.resolve();

        expect(first.dispose).toHaveBeenCalledOnce();
        expect(second.dispose).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
        firstGate.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        secondGate.resolve();
        await shutdown;
        expect(settled).toBe(true);
    });

    it("invalidates every runtime with its path and a caller-provided disposer", async () => {
        const first = makeRuntime();
        const second = makeRuntime();
        const dispose = vi.fn(async () => {});
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => first);
        await registry.getOrCreate("/b.db", async () => second);

        await expect(registry.invalidateAll(dispose)).resolves.toEqual(["/a.db", "/b.db"]);

        expect(dispose).toHaveBeenCalledWith("/a.db", first);
        expect(dispose).toHaveBeenCalledWith("/b.db", second);
        expect(first.dispose).not.toHaveBeenCalled();
        expect(second.dispose).not.toHaveBeenCalled();
        expect(registry.get("/a.db")).toBeUndefined();
        expect(registry.get("/b.db")).toBeUndefined();
    });

    it("blocks new creation until a global invalidation finishes", async () => {
        const gate = deferred();
        const first = makeRuntime();
        const second = makeRuntime();
        first.dispose.mockImplementation(() => gate.promise);
        const createSecond = vi.fn(async () => second);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => first);

        const invalidation = registry.invalidateAll();
        const replacement = registry.getOrCreate("/b.db", createSecond);
        await Promise.resolve();

        expect(createSecond).not.toHaveBeenCalled();
        gate.resolve();
        await invalidation;
        await expect(replacement).resolves.toBe(second);
        expect(createSecond).toHaveBeenCalledOnce();
    });

    it("disposes every runtime during shutdown", async () => {
        const first = makeRuntime();
        const second = makeRuntime();
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => first);
        await registry.getOrCreate("/b.db", async () => second);

        await registry.disposeAll();

        expect(first.dispose).toHaveBeenCalledOnce();
        expect(second.dispose).toHaveBeenCalledOnce();
        expect(registry.get("/a.db")).toBeUndefined();
    });

    it("waits for a pending runtime creation to dispose during shutdown", async () => {
        let resolveFirst!: (runtime: ReturnType<typeof makeRuntime>) => void;
        const disposeGate = deferred();
        const firstRuntime = makeRuntime();
        firstRuntime.dispose.mockImplementation(() => disposeGate.promise);
        const secondRuntime = makeRuntime();
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        const first = registry.getOrCreate(
            "/a.db",
            () => new Promise<ReturnType<typeof makeRuntime>>((resolve) => (resolveFirst = resolve))
        );
        let shutdownSettled = false;

        const shutdown = registry.disposeAll().then(() => {
            shutdownSettled = true;
        });
        resolveFirst(firstRuntime);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(shutdownSettled).toBe(false);
        expect(firstRuntime.dispose).toHaveBeenCalledOnce();
        disposeGate.resolve();
        await shutdown;
        await expect(first).rejects.toThrow(/disposed during creation/);
        await expect(registry.getOrCreate("/a.db", async () => secondRuntime)).resolves.toBe(secondRuntime);
        expect(firstRuntime.dispose).toHaveBeenCalledOnce();
        expect(registry.get("/a.db")).toBe(secondRuntime);
    });
});
