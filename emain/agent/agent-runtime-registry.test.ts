// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { AgentRuntimeRegistry } from "./agent-runtime-registry";

function makeRuntime(running = false) {
    return {
        isRunning: vi.fn(() => running),
        dispose: vi.fn(),
    };
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

        expect(registry.evictIdle()).toEqual(["/idle.db"]);
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
        expect(registry.evictIdle()).toEqual([]);
        now = 181;
        expect(registry.evictIdle()).toEqual(["/a.db"]);
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

        expect(registry.evictIdle()).toEqual([]);
        expect(create).toHaveBeenCalledOnce();
    });

    it("disposes every runtime during shutdown", async () => {
        const first = makeRuntime();
        const second = makeRuntime();
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => first);
        await registry.getOrCreate("/b.db", async () => second);

        registry.disposeAll();

        expect(first.dispose).toHaveBeenCalledOnce();
        expect(second.dispose).toHaveBeenCalledOnce();
        expect(registry.get("/a.db")).toBeUndefined();
    });
});
