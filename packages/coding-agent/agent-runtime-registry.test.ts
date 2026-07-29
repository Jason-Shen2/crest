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

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("AgentRuntimeRegistry", () => {
    it("retains an idle runtime and subscribers while holding a drained retained lease", async () => {
        const runtime = makeRuntime(false);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => runtime);
        registry.acquire("/a.db", "renderer:1");
        const active = deferred<void>();
        const releaseAccess = deferred<void>();
        const access = registry.withSessionAccess("/a.db", async () => {
            active.resolve();
            await releaseAccess.promise;
        });
        await active.promise;
        let entered = false;
        const mutation = registry.withRetainedSessionMutation("/a.db", { rejectIfRunning: true }, async (lease) => {
            entered = true;
            expect(registry.get("/a.db")).toBeUndefined();
            expect(registry.getRuntimeForLease(lease)).toBe(runtime);
            await expect(registry.withMutationLeaseAccess(lease, async (value) => value)).resolves.toBe(runtime);
        });

        expect(registry.get("/a.db")).toBeUndefined();
        await expect(registry.withSessionAccess("/a.db", async () => undefined)).rejects.toThrow(/session mutation/i);
        expect(entered).toBe(false);
        releaseAccess.resolve();
        await access;
        await mutation;
        expect(runtime.dispose).not.toHaveBeenCalled();
        expect(registry.get("/a.db")).toBe(runtime);
    });

    it("lets a pre-existing session access lease retain its runtime after a mutation tombstone", async () => {
        const runtime = makeRuntime(false);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => runtime);
        const accessStarted = deferred<void>();
        const releaseAccess = deferred<void>();
        const access = registry.withSessionAccess("/a.db", async (lease) => {
            accessStarted.resolve();
            await releaseAccess.promise;
            expect(registry.get("/a.db")).toBeUndefined();
            expect(registry.getRuntimeForSessionAccess(lease)).toBe(runtime);
        });
        await accessStarted.promise;
        const mutation = registry.withExclusiveSessionMutation("/a.db", { rejectIfRunning: true }, async () => {});

        await expect(registry.withSessionAccess("/a.db", async () => undefined)).rejects.toThrow(/session mutation/i);
        releaseAccess.resolve();
        await access;
        await mutation;
    });

    it("queues same-session retained mutations while allowing different sessions to run", async () => {
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        const release = deferred<void>();
        const calls: string[] = [];
        const first = registry.withRetainedSessionMutation("/a.db", {}, async () => {
            calls.push("first");
            await release.promise;
        });
        const second = registry.withRetainedSessionMutation("/a.db", {}, async () => {
            calls.push("second");
        });
        const parallel = registry.withRetainedSessionMutation("/b.db", {}, async () => {
            calls.push("parallel");
        });

        await parallel;
        expect(calls).toEqual(["first", "parallel"]);
        release.resolve();
        await Promise.all([first, second]);
        expect(calls).toEqual(["first", "parallel", "second"]);
    });

    it("keeps a retained mutation behind an active registry-owned barrier operation", async () => {
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        const started = deferred<void>();
        const release = deferred<void>();
        const calls: string[] = [];
        const oldOperation = registry.runWithSessionMutationBarrier("/a.db", async () => {
            calls.push("old");
            started.resolve();
            await release.promise;
        });
        await started.promise;

        const retained = registry.withRetainedSessionMutation("/a.db", {}, async () => {
            calls.push("retained");
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(calls).toEqual(["old"]);

        release.resolve();
        await Promise.all([oldOperation, retained]);
        expect(calls).toEqual(["old", "retained"]);
        expect(registry.getSessionMutationBarrierCountForTest()).toBe(0);
    });

    it.each(["exclusive", "retained"] as const)(
        "rejects a reject-if-running %s mutation while checkpoint finalization owns the barrier",
        async (kind) => {
            const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
            const started = deferred<void>();
            const release = deferred<void>();
            const finalization = registry.runWithSessionMutationBarrier("/a.db", async () => {
                started.resolve();
                await release.promise;
            });
            await started.promise;

            const mutation =
                kind === "exclusive"
                    ? registry.withExclusiveSessionMutation("/a.db", { rejectIfRunning: true }, async () => undefined)
                    : registry.withRetainedSessionMutation("/a.db", { rejectIfRunning: true }, async () => undefined);
            const disposition = await Promise.race([
                mutation.then(
                    () => "resolved",
                    () => "rejected"
                ),
                new Promise<"queued">((resolve) => setImmediate(() => resolve("queued"))),
            ]);

            expect(disposition).toBe("rejected");
            await expect(mutation).rejects.toThrow(/running/i);
            release.resolve();
            await finalization;
        }
    );

    it("preserves one barrier and FIFO across queued registry-owned operations", async () => {
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        const release = deferred<void>();
        const calls: number[] = [];
        const first = registry.runWithSessionMutationBarrier("/a.db", async () => {
            calls.push(1);
            await release.promise;
        });
        const second = registry.runWithSessionMutationBarrier("/a.db", async () => {
            calls.push(2);
        });
        const third = registry.runWithSessionMutationBarrier("/a.db", async () => {
            calls.push(3);
        });

        expect(registry.getSessionMutationBarrierCountForTest()).toBe(1);
        expect(calls).toEqual([1]);
        release.resolve();
        await Promise.all([first, second, third]);
        expect(calls).toEqual([1, 2, 3]);
        expect(registry.getSessionMutationBarrierCountForTest()).toBe(0);
    });

    it("rejects a retained mutation while the live runtime is running", async () => {
        const runtime = makeRuntime(true);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => runtime);

        await expect(
            registry.withRetainedSessionMutation("/a.db", { rejectIfRunning: true }, async () => undefined)
        ).rejects.toThrow(/running/i);
        expect(runtime.dispose).not.toHaveBeenCalled();
        expect(registry.get("/a.db")).toBe(runtime);
    });

    it("releases idle mutation barriers for many short-lived sessions", async () => {
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await Promise.all(
            Array.from({ length: 500 }, (_, index) =>
                registry.withRetainedSessionMutation(`/short-${index}.db`, {}, async () => undefined)
            )
        );

        expect(registry.getSessionMutationBarrierCountForTest()).toBe(0);
    });

    it("releases barrier entries for many run-only and wait-only sessions", async () => {
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await Promise.all(
            Array.from({ length: 500 }, (_, index) =>
                registry.runWithSessionMutationBarrier(`/run-${index}.db`, async () => undefined)
            )
        );
        await Promise.all(
            Array.from({ length: 500 }, (_, index) => registry.waitForSessionMutationIdle(`/wait-${index}.db`))
        );

        expect(registry.getSessionMutationBarrierCountForTest()).toBe(0);
    });

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

    it("protects an idle harness with a live hosted PTY from eviction", async () => {
        let now = 0;
        const livePtyRuntime = makeRuntime(true);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now });
        await registry.getOrCreate("/pty.db", async () => livePtyRuntime);
        now = 101;

        await expect(registry.evictIdle()).resolves.toEqual([]);
        expect(livePtyRuntime.dispose).not.toHaveBeenCalled();
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

    it("waits for same-path idle cleanup before creating a replacement without blocking other paths", async () => {
        let now = 0;
        const cleanup = deferred<void>();
        const runtime = makeRuntime(false);
        runtime.dispose.mockReturnValue(cleanup.promise);
        const replacement = makeRuntime(false);
        const createReplacement = vi.fn(async () => replacement);
        const otherRuntime = makeRuntime(false);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now });
        await registry.getOrCreate("/a.db", async () => runtime);
        now = 101;
        const evicting = registry.evictIdle();
        await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce());

        const creating = registry.getOrCreate("/a.db", createReplacement);
        try {
            await expect(registry.getOrCreate("/b.db", async () => otherRuntime)).resolves.toBe(otherRuntime);
            await expect(
                registry.withExclusiveSessionMutation("/c.db", {}, async () => "other mutation")
            ).resolves.toBe("other mutation");
            expect(createReplacement).not.toHaveBeenCalled();
        } finally {
            cleanup.resolve();
        }

        await expect(evicting).resolves.toEqual(["/a.db"]);
        await expect(creating).resolves.toBe(replacement);
        expect(createReplacement).toHaveBeenCalledOnce();
    });

    it("waits for same-path idle cleanup before entering an exclusive mutation", async () => {
        let now = 0;
        const cleanup = deferred<void>();
        const runtime = makeRuntime(false);
        runtime.dispose.mockReturnValue(cleanup.promise);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now });
        await registry.getOrCreate("/a.db", async () => runtime);
        now = 101;
        const evicting = registry.evictIdle();
        await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce());
        const mutate = vi.fn(async () => "archived");
        const mutation = registry.withExclusiveSessionMutation("/a.db", {}, mutate);

        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(mutate).not.toHaveBeenCalled();
        } finally {
            cleanup.resolve();
        }

        await expect(evicting).resolves.toEqual(["/a.db"]);
        await expect(mutation).resolves.toBe("archived");
        expect(runtime.dispose).toHaveBeenCalledOnce();
    });

    it("quarantines failed idle cleanup until an exclusive retry succeeds", async () => {
        let now = 0;
        const cleanup = deferred<void>();
        const failure = new Error("idle session close failed");
        const runtime = makeRuntime(false);
        runtime.dispose.mockReturnValueOnce(cleanup.promise).mockResolvedValue(undefined);
        const replacement = makeRuntime(false);
        const createReplacement = vi.fn(async () => replacement);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now });
        await registry.getOrCreate("/a.db", async () => runtime);
        now = 101;
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const evicting = registry.evictIdle();
        await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce());
        const creatingResult = registry.getOrCreate("/a.db", createReplacement).catch((error) => error);
        const mutate = vi.fn(async () => "deleted");
        const mutationResult = registry.withExclusiveSessionMutation("/a.db", {}, mutate).catch((error) => error);

        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(createReplacement).not.toHaveBeenCalled();
            expect(mutate).not.toHaveBeenCalled();
            cleanup.reject(failure);

            await expect(evicting).resolves.toEqual([]);
            await expect(creatingResult).resolves.toBe(failure);
            await expect(mutationResult).resolves.toBe(failure);
            expect(mutate).not.toHaveBeenCalled();
            await expect(registry.getOrCreate("/a.db", createReplacement)).rejects.toThrow(/cleanup failed/i);

            await registry.withExclusiveSessionMutation("/a.db", {}, mutate);
            expect(runtime.dispose).toHaveBeenCalledTimes(2);
            expect(mutate).toHaveBeenCalledOnce();
            await expect(registry.getOrCreate("/a.db", createReplacement)).resolves.toBe(replacement);
        } finally {
            cleanup.reject(failure);
            consoleError.mockRestore();
        }
    });

    it("waits for every runtime to dispose during shutdown", async () => {
        const firstDisposal = deferred<void>();
        const secondDisposal = deferred<void>();
        const first = makeRuntime();
        first.dispose.mockReturnValue(firstDisposal.promise);
        const second = makeRuntime();
        second.dispose.mockReturnValue(secondDisposal.promise);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => first);
        await registry.getOrCreate("/b.db", async () => second);

        let settled = false;
        const disposing = registry.disposeAll().then(() => {
            settled = true;
        });

        await Promise.resolve();
        expect(first.dispose).toHaveBeenCalledOnce();
        expect(second.dispose).toHaveBeenCalledOnce();
        expect(registry.get("/a.db")).toBeUndefined();
        firstDisposal.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        secondDisposal.resolve();
        await disposing;
        expect(settled).toBe(true);
    });

    it("waits for and disposes a runtime that finishes creating after shutdown begins", async () => {
        const creation = deferred<ReturnType<typeof makeRuntime>>();
        const runtimeDisposal = deferred<void>();
        const runtime = makeRuntime();
        runtime.dispose.mockReturnValue(runtimeDisposal.promise);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        const creating = registry.getOrCreate("/a.db", () => creation.promise);
        const rejectedCreation = expect(creating).rejects.toThrow(/disposed during creation/);

        let settled = false;
        const disposing = registry.disposeAll().then(() => {
            settled = true;
        });
        creation.resolve(runtime);
        await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce());
        expect(settled).toBe(false);

        runtimeDisposal.resolve();
        await rejectedCreation;
        await disposing;
        expect(settled).toBe(true);
        expect(registry.get("/a.db")).toBeUndefined();
    });

    it("quarantines a pending runtime that fails to close during shutdown until exclusive retry", async () => {
        const creation = deferred<ReturnType<typeof makeRuntime>>();
        const failure = new Error("pending runtime close failed");
        const runtime = makeRuntime();
        runtime.dispose.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
        const replacement = makeRuntime();
        const createReplacement = vi.fn(async () => replacement);
        const mutate = vi.fn(async () => "archived");
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        const creatingResult = registry.getOrCreate("/a.db", () => creation.promise).catch((error) => error);
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const shutdown = registry.disposeAll();

        creation.resolve(runtime);

        try {
            await shutdown;
            await expect(creatingResult).resolves.toMatchObject({
                message: expect.stringMatching(/disposed during creation/i),
                cause: failure,
            });
            expect(runtime.dispose).toHaveBeenCalledOnce();
            await expect(registry.getOrCreate("/a.db", createReplacement)).rejects.toThrow(/cleanup failed/i);
            expect(createReplacement).not.toHaveBeenCalled();

            await expect(registry.withExclusiveSessionMutation("/a.db", {}, mutate)).resolves.toBe("archived");
            expect(runtime.dispose).toHaveBeenCalledTimes(2);
            expect(mutate).toHaveBeenCalledOnce();
            await expect(registry.getOrCreate("/a.db", createReplacement)).resolves.toBe(replacement);
        } finally {
            consoleError.mockRestore();
        }
    });

    it("hides selected idle entries while containing individual disposal failures", async () => {
        let now = 0;
        const first = makeRuntime();
        first.dispose.mockRejectedValue(new Error("first dispose failed"));
        const secondDisposal = deferred<void>();
        const second = makeRuntime();
        second.dispose.mockReturnValue(secondDisposal.promise);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now });
        await registry.getOrCreate("/a.db", async () => first);
        await registry.getOrCreate("/b.db", async () => second);
        now = 101;
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            let settled = false;
            const evicting = registry.evictIdle().then((paths) => {
                settled = true;
                return paths;
            });

            expect(registry.get("/a.db")).toBeUndefined();
            expect(registry.get("/b.db")).toBeUndefined();
            await Promise.resolve();
            expect(first.dispose).toHaveBeenCalledOnce();
            expect(second.dispose).toHaveBeenCalledOnce();
            expect(settled).toBe(false);

            secondDisposal.resolve();
            await expect(evicting).resolves.toEqual(["/b.db"]);
            expect(consoleError).toHaveBeenCalledWith(
                expect.stringMatching(/runtime eviction/i),
                expect.any(AggregateError)
            );
        } finally {
            consoleError.mockRestore();
        }
    });

    it("waits for an in-flight idle eviction during shutdown after the entry was removed", async () => {
        let now = 0;
        const runtimeDisposal = deferred<void>();
        const runtime = makeRuntime();
        runtime.dispose.mockReturnValue(runtimeDisposal.promise);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now });
        await registry.getOrCreate("/a.db", async () => runtime);
        now = 101;

        const evicting = registry.evictIdle();
        await Promise.resolve();
        expect(runtime.dispose).toHaveBeenCalledOnce();
        expect(registry.get("/a.db")).toBeUndefined();
        let shutdownSettled = false;
        const shutdown = registry.disposeAll().then(() => {
            shutdownSettled = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(shutdownSettled).toBe(false);

        runtimeDisposal.resolve();
        await expect(evicting).resolves.toEqual(["/a.db"]);
        await shutdown;
        expect(shutdownSettled).toBe(true);
        expect(runtime.dispose).toHaveBeenCalledOnce();
    });

    it("retains a failed idle cleanup owner when shutdown overlaps eviction", async () => {
        let now = 0;
        const runtimeDisposal = deferred<void>();
        const failure = new Error("idle close failed during shutdown");
        const runtime = makeRuntime();
        runtime.dispose.mockReturnValue(runtimeDisposal.promise);
        const replacement = makeRuntime();
        const createReplacement = vi.fn(async () => replacement);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now });
        await registry.getOrCreate("/a.db", async () => runtime);
        now = 101;
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const evicting = registry.evictIdle();
        await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce());

        const shutdown = registry.disposeAll();
        runtimeDisposal.reject(failure);

        try {
            await expect(evicting).resolves.toEqual([]);
            await shutdown;
            expect(runtime.dispose).toHaveBeenCalledOnce();
            await expect(registry.getOrCreate("/a.db", createReplacement)).rejects.toThrow(/cleanup failed/i);
            expect(createReplacement).not.toHaveBeenCalled();
        } finally {
            runtimeDisposal.reject(failure);
            consoleError.mockRestore();
        }
    });

    it("waits for an exclusive disposal and file mutation during shutdown without disposing twice", async () => {
        const runtimeDisposal = deferred<void>();
        const releaseMutation = deferred<void>();
        const mutationStarted = deferred<void>();
        const runtime = makeRuntime(false);
        runtime.dispose.mockReturnValue(runtimeDisposal.promise);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => runtime);
        const mutation = registry.withExclusiveSessionMutation("/a.db", {}, async () => {
            mutationStarted.resolve();
            await releaseMutation.promise;
            return "archived";
        });
        await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce());

        let shutdownSettled = false;
        const shutdown = registry.disposeAll().then(() => {
            shutdownSettled = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(runtime.dispose).toHaveBeenCalledOnce();
        expect(shutdownSettled).toBe(false);

        runtimeDisposal.resolve();
        await mutationStarted.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(runtime.dispose).toHaveBeenCalledOnce();
        expect(shutdownSettled).toBe(false);

        releaseMutation.resolve();
        await expect(mutation).resolves.toBe("archived");
        await shutdown;
        expect(shutdownSettled).toBe(true);
        expect(runtime.dispose).toHaveBeenCalledOnce();
    });

    it("rejects new runtime creation while disposal is in progress and accepts it after completion", async () => {
        const runtimeDisposal = deferred<void>();
        const runtime = makeRuntime();
        runtime.dispose.mockReturnValue(runtimeDisposal.promise);
        const replacement = makeRuntime();
        const createReplacement = vi.fn(async () => replacement);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => runtime);

        const disposing = registry.disposeAll();
        await expect(registry.getOrCreate("/b.db", createReplacement)).rejects.toThrow(/disposal.*progress/i);
        expect(createReplacement).not.toHaveBeenCalled();

        runtimeDisposal.resolve();
        await disposing;
        await expect(registry.getOrCreate("/b.db", createReplacement)).resolves.toBe(replacement);
    });

    it("blocks new session access and runtime creation while an exclusive mutation holds a tombstone", async () => {
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        const releaseMutation = deferred<void>();
        const mutation = registry.withExclusiveSessionMutation("/a.db", { rejectIfRunning: true }, async () => {
            await releaseMutation.promise;
            return "archived";
        });
        await Promise.resolve();

        await expect(registry.withSessionAccess("/a.db", async () => "late-read")).rejects.toThrow(
            /exclusive session mutation/i
        );
        await expect(registry.getOrCreate("/a.db", async () => makeRuntime())).rejects.toThrow(
            /exclusive session mutation/i
        );

        releaseMutation.resolve();
        await expect(mutation).resolves.toBe("archived");
        await expect(registry.withSessionAccess("/a.db", async () => "usable")).resolves.toBe("usable");
    });

    it("waits for existing session access leases before mutating the session file", async () => {
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        const releaseRead = deferred<void>();
        const readStarted = deferred<void>();
        const read = registry.withSessionAccess("/a.db", async () => {
            readStarted.resolve();
            await releaseRead.promise;
        });
        await readStarted.promise;

        let mutationEntered = false;
        const mutation = registry.withExclusiveSessionMutation("/a.db", { rejectIfRunning: true }, async () => {
            mutationEntered = true;
        });
        await Promise.resolve();
        expect(mutationEntered).toBe(false);

        releaseRead.resolve();
        await read;
        await mutation;
        expect(mutationEntered).toBe(true);
    });

    it("runs a second capture hook after existing session access drains", async () => {
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        const releaseRead = deferred<void>();
        const readStarted = deferred<void>();
        const read = registry.withSessionAccess("/a.db", async () => {
            readStarted.resolve();
            await releaseRead.promise;
        });
        await readStarted.promise;
        const calls: string[] = [];

        const mutation = registry.withExclusiveSessionMutation(
            "/a.db",
            {
                onExclusiveStart: () => calls.push("start"),
                afterSessionAccessDrained: () => calls.push("drained"),
            } as never,
            async () => calls.push("mutation")
        );

        expect(calls).toEqual(["start"]);
        releaseRead.resolve();
        await read;
        await mutation;
        expect(calls).toEqual(["start", "drained", "mutation"]);
    });

    it("runs the exclusive-start hook synchronously and clears the tombstone when it fails", async () => {
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        const failure = new Error("exclusive start failed");
        const onExclusiveStart = vi.fn(() => {
            throw failure;
        });

        const mutation = registry.withExclusiveSessionMutation(
            "/a.db",
            { rejectIfRunning: true, onExclusiveStart } as never,
            async () => "deleted"
        );

        expect(onExclusiveStart).toHaveBeenCalledOnce();
        await expect(mutation).rejects.toBe(failure);
        await expect(registry.withSessionAccess("/a.db", async () => "usable")).resolves.toBe("usable");
    });

    it("queues the next exclusive mutation until failure recovery completes", async () => {
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        const failure = new Error("mutation failed");
        const recoveryStarted = deferred<void>();
        const releaseRecovery = deferred<void>();
        const calls: string[] = [];
        const first = registry.withExclusiveSessionMutation(
            "/a.db",
            {
                onFailureBeforeRelease: async () => {
                    calls.push("recovery");
                    recoveryStarted.resolve();
                    await releaseRecovery.promise;
                },
            } as never,
            async () => {
                calls.push("first");
                throw failure;
            }
        );
        const firstResult = first.catch((error) => error);
        await recoveryStarted.promise;

        const second = registry.withExclusiveSessionMutation("/a.db", {}, async () => {
            calls.push("second");
        });
        await Promise.resolve();

        expect(calls).toEqual(["first", "recovery"]);
        releaseRecovery.resolve();
        await expect(firstResult).resolves.toBe(failure);
        await second;
        expect(calls).toEqual(["first", "recovery", "second"]);
    });

    it("rejects exclusive mutation while a runtime is running and leaves the session usable", async () => {
        const runtime = makeRuntime(true);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => runtime);

        await expect(
            registry.withExclusiveSessionMutation("/a.db", { rejectIfRunning: true }, async () => "deleted")
        ).rejects.toThrow(/running/i);

        expect(runtime.dispose).not.toHaveBeenCalled();
        await expect(registry.withSessionAccess("/a.db", async () => "usable")).resolves.toBe("usable");
    });

    it("disposes idle runtime under the exclusive tombstone before mutating the session file", async () => {
        const runtimeDisposal = deferred<void>();
        const runtime = makeRuntime(false);
        runtime.dispose.mockReturnValue(runtimeDisposal.promise);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => runtime);

        let mutationEntered = false;
        const mutation = registry.withExclusiveSessionMutation("/a.db", { rejectIfRunning: true }, async () => {
            mutationEntered = true;
        });
        await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce());
        expect(mutationEntered).toBe(false);

        runtimeDisposal.resolve();
        await mutation;
        expect(mutationEntered).toBe(true);
        expect(registry.get("/a.db")).toBeUndefined();
    });

    it("propagates exclusive runtime disposal failure without entering the mutation", async () => {
        const failure = new Error("session close failed");
        const runtime = makeRuntime(false);
        runtime.dispose.mockRejectedValueOnce(failure).mockResolvedValueOnce();
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });
        await registry.getOrCreate("/a.db", async () => runtime);
        const mutate = vi.fn();

        await expect(registry.withExclusiveSessionMutation("/a.db", { rejectIfRunning: true }, mutate)).rejects.toBe(
            failure
        );

        expect(mutate).not.toHaveBeenCalled();
        expect(registry.get("/a.db")).toBeUndefined();
        await expect(registry.getOrCreate("/a.db", async () => makeRuntime())).rejects.toThrow(/cleanup failed/i);

        await registry.withExclusiveSessionMutation("/a.db", { rejectIfRunning: true }, mutate);
        expect(runtime.dispose).toHaveBeenCalledTimes(2);
        expect(mutate).toHaveBeenCalledOnce();
    });

    it("keeps a cleanup-failed runtime quarantined across idle eviction until exclusive retry succeeds", async () => {
        let now = 0;
        const failure = new Error("session close failed");
        const runtime = makeRuntime(false);
        runtime.dispose.mockRejectedValue(failure);
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now });
        await registry.getOrCreate("/a.db", async () => runtime);

        await expect(registry.withExclusiveSessionMutation("/a.db", {}, async () => {})).rejects.toBe(failure);
        now = 101;
        await expect(registry.evictIdle()).resolves.toEqual([]);
        expect(runtime.dispose).toHaveBeenCalledOnce();
        await expect(registry.getOrCreate("/a.db", async () => makeRuntime())).rejects.toThrow(/cleanup failed/i);

        runtime.dispose.mockResolvedValue(undefined);
        await registry.withExclusiveSessionMutation("/a.db", {}, async () => {});
        const replacement = makeRuntime();
        await expect(registry.getOrCreate("/a.db", async () => replacement)).resolves.toBe(replacement);
        expect(runtime.dispose).toHaveBeenCalledTimes(2);
    });
});
