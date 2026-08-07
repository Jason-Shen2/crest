// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from "vitest";

import { WorkspaceWriterLeaseRegistry } from "./workspace-writer-lease";

describe("WorkspaceWriterLeaseRegistry", () => {
    test("grants one holder with the requested turn identity", async () => {
        const registry = new WorkspaceWriterLeaseRegistry();

        const lease = await registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-a",
            boundaryToken: "boundary-a",
        });

        expect(lease).toMatchObject({
            workspaceKey: "workspace-a",
            sessionId: "session-a",
            boundaryToken: "boundary-a",
        });
        expect(lease.release()).toBeUndefined();
    });

    test("grants three acquisitions for one workspace in strict FIFO order", async () => {
        const registry = new WorkspaceWriterLeaseRegistry();
        const first = await registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-a",
            boundaryToken: "boundary-1",
        });
        const acquisitionOrder: string[] = [];
        const secondPromise = registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-b",
            boundaryToken: "boundary-2",
        });
        const thirdPromise = registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-c",
            boundaryToken: "boundary-3",
        });
        void secondPromise.then(() => acquisitionOrder.push("second"));
        void thirdPromise.then(() => acquisitionOrder.push("third"));

        await Promise.resolve();
        expect(acquisitionOrder).toEqual([]);

        first.release();
        const second = await secondPromise;
        expect(acquisitionOrder).toEqual(["second"]);

        second.release();
        const third = await thirdPromise;
        expect(acquisitionOrder).toEqual(["second", "third"]);
        third.release();
    });

    test("deduplicates active and queued retries for the same turn", async () => {
        const registry = new WorkspaceWriterLeaseRegistry();
        const activeInput = {
            workspaceKey: "workspace-a",
            sessionId: "session-a",
            boundaryToken: "boundary-1",
        };
        const activePromise = registry.acquire(activeInput);
        const activeRetry = registry.acquire(activeInput);

        expect(activeRetry).toBe(activePromise);
        const active = await activePromise;
        expect(await activeRetry).toBe(active);

        const queuedInput = {
            workspaceKey: "workspace-a",
            sessionId: "session-b",
            boundaryToken: "boundary-2",
        };
        const queuedPromise = registry.acquire(queuedInput);
        const queuedRetry = registry.acquire(queuedInput);

        expect(queuedRetry).toBe(queuedPromise);
        active.release();
        const queued = await queuedPromise;
        expect(await queuedRetry).toBe(queued);
        queued.release();
    });

    test("rejects a stale release without releasing the current owner", async () => {
        const registry = new WorkspaceWriterLeaseRegistry();
        const first = await registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-a",
            boundaryToken: "boundary-1",
        });
        const secondPromise = registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-b",
            boundaryToken: "boundary-2",
        });

        first.release();
        const second = await secondPromise;
        let thirdAcquired = false;
        const thirdPromise = registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-c",
            boundaryToken: "boundary-3",
        });
        void thirdPromise.then(() => {
            thirdAcquired = true;
        });

        expect(() => first.release()).toThrow(/active|owner|released|stale/i);
        await Promise.resolve();
        expect(thirdAcquired).toBe(false);

        second.release();
        const third = await thirdPromise;
        third.release();
    });

    test("rejects a pre-aborted acquisition without changing registry state", async () => {
        const registry = new WorkspaceWriterLeaseRegistry();
        const controller = new AbortController();
        controller.abort(new Error("cancelled before acquire"));
        const input = {
            workspaceKey: "workspace-a",
            sessionId: "session-a",
            boundaryToken: "boundary-1",
        };

        await expect(registry.acquire({ ...input, signal: controller.signal })).rejects.toThrow(
            "cancelled before acquire"
        );

        const lease = await registry.acquire(input);
        lease.release();
    });

    test("removes an aborted waiter without blocking the next acquisition", async () => {
        const registry = new WorkspaceWriterLeaseRegistry();
        const active = await registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-a",
            boundaryToken: "boundary-1",
        });
        const controller = new AbortController();
        const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
        const cancelled = new Error("cancelled while queued");
        const abortedPromise = registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-b",
            boundaryToken: "boundary-2",
            signal: controller.signal,
        });
        let abortReason: unknown;
        void abortedPromise.catch((error) => {
            abortReason = error;
        });
        let nextAcquired = false;
        const nextPromise = registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-c",
            boundaryToken: "boundary-3",
        });
        void nextPromise.then(() => {
            nextAcquired = true;
        });

        controller.abort(cancelled);
        await Promise.resolve();
        expect(abortReason).toBe(cancelled);
        expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));

        active.release();
        await Promise.resolve();
        expect(nextAcquired).toBe(true);
        const next = await nextPromise;
        next.release();
    });

    test("skips an aborted queue head when an earlier abort listener releases the holder", async () => {
        const registry = new WorkspaceWriterLeaseRegistry();
        const active = await registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-a",
            boundaryToken: "boundary-1",
        });
        const controller = new AbortController();
        controller.signal.addEventListener("abort", () => active.release(), { once: true });
        const cancelled = new Error("cancelled during reentrant release");
        const abortedPromise = registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-b",
            boundaryToken: "boundary-2",
            signal: controller.signal,
        });
        const nextPromise = registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-c",
            boundaryToken: "boundary-3",
        });

        controller.abort(cancelled);

        await expect(abortedPromise).rejects.toBe(cancelled);
        const next = await nextPromise;
        next.release();
    });

    test("snapshots a queued turn identity before caller input can mutate", async () => {
        const registry = new WorkspaceWriterLeaseRegistry();
        const active = await registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-a",
            boundaryToken: "boundary-1",
        });
        const input = {
            workspaceKey: "workspace-a",
            sessionId: "session-b",
            boundaryToken: "boundary-2",
        };
        const queuedPromise = registry.acquire(input);

        input.workspaceKey = "workspace-mutated";
        input.sessionId = "session-mutated";
        input.boundaryToken = "boundary-mutated";
        active.release();

        const queued = await queuedPromise;
        expect(queued).toMatchObject({
            workspaceKey: "workspace-a",
            sessionId: "session-b",
            boundaryToken: "boundary-2",
        });
        queued.release();
    });

    test("keeps queued cancellation bound to the snapshotted signal", async () => {
        const registry = new WorkspaceWriterLeaseRegistry();
        const active = await registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-a",
            boundaryToken: "boundary-1",
        });
        const originalController = new AbortController();
        const replacementController = new AbortController();
        const removeEventListener = vi.spyOn(originalController.signal, "removeEventListener");
        const input = {
            workspaceKey: "workspace-a",
            sessionId: "session-b",
            boundaryToken: "boundary-2",
            signal: originalController.signal,
        };
        const cancelled = new Error("cancelled through original signal");
        const abortedPromise = registry.acquire(input);
        const nextPromise = registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-c",
            boundaryToken: "boundary-3",
        });

        input.signal = replacementController.signal;
        originalController.abort(cancelled);

        await expect(abortedPromise).rejects.toBe(cancelled);
        expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
        active.release();
        const next = await nextPromise;
        next.release();
    });

    test("allows different workspaces to hold leases concurrently", async () => {
        const registry = new WorkspaceWriterLeaseRegistry();
        const first = await registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-a",
            boundaryToken: "boundary-1",
        });

        const second = await registry.acquire({
            workspaceKey: "workspace-b",
            sessionId: "session-b",
            boundaryToken: "boundary-2",
        });

        expect(first.workspaceKey).toBe("workspace-a");
        expect(second.workspaceKey).toBe("workspace-b");
        first.release();
        second.release();
    });

    test("removes workspace states after their leases become idle", async () => {
        const registry = new WorkspaceWriterLeaseRegistry();
        const leases = await Promise.all(
            ["workspace-a", "workspace-b", "workspace-c"].map((workspaceKey, index) =>
                registry.acquire({
                    workspaceKey,
                    sessionId: `session-${index}`,
                    boundaryToken: `boundary-${index}`,
                })
            )
        );

        expect(registry.workspaces.size).toBe(3);
        for (const lease of leases) {
            lease.release();
        }
        expect(registry.workspaces.size).toBe(0);
    });

    test.each([
        ["workspaceKey", { workspaceKey: "", sessionId: "session-a", boundaryToken: "boundary-1" }],
        ["workspaceKey", { workspaceKey: 42, sessionId: "session-a", boundaryToken: "boundary-1" }],
        ["sessionId", { workspaceKey: "workspace-a", sessionId: "   ", boundaryToken: "boundary-1" }],
        ["sessionId", { workspaceKey: "workspace-a", sessionId: null, boundaryToken: "boundary-1" }],
        ["boundaryToken", { workspaceKey: "workspace-a", sessionId: "session-a", boundaryToken: "" }],
        ["boundaryToken", { workspaceKey: "workspace-a", sessionId: "session-a", boundaryToken: false }],
    ])("rejects an invalid %s without changing registry state", async (field, invalidInput) => {
        const registry = new WorkspaceWriterLeaseRegistry();

        await expect(Promise.resolve().then(() => registry.acquire(invalidInput as never))).rejects.toThrow(
            new RegExp(field, "i")
        );

        const lease = await registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-a",
            boundaryToken: "boundary-1",
        });
        lease.release();
    });

    test("does not auto-release an active holder when its signal aborts", async () => {
        const registry = new WorkspaceWriterLeaseRegistry();
        const controller = new AbortController();
        const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
        const active = await registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-a",
            boundaryToken: "boundary-1",
            signal: controller.signal,
        });
        let nextAcquired = false;
        const nextPromise = registry.acquire({
            workspaceKey: "workspace-a",
            sessionId: "session-b",
            boundaryToken: "boundary-2",
        });
        void nextPromise.then(() => {
            nextAcquired = true;
        });

        expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
        controller.abort(new Error("active turn cancelled"));
        await Promise.resolve();
        expect(nextAcquired).toBe(false);

        active.release();
        const next = await nextPromise;
        next.release();
    });
});
