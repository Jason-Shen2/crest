// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import { WorkspaceTrackerRegistry } from "./workspace-tracker-registry";

const ProcessOwner = {
    pid: 42,
    processStartToken: "registry-test",
    nonce: "c".repeat(64),
};

function identity(overrides: Partial<CanonicalWorkspaceIdentity> = {}): CanonicalWorkspaceIdentity {
    return {
        canonicalRoot: "/workspace",
        workspaceIdentity: "a".repeat(64),
        workspaceIncarnation: "b".repeat(64),
        storeKey: "workspace",
        ancestorIdentityChain: [],
        ...overrides,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function makeRegistry() {
    const stores = new Map<string, { identity: CanonicalWorkspaceIdentity; storeRoot: string }>();
    const openStore = vi.fn(async (input: { identity: CanonicalWorkspaceIdentity }) => {
        const store = {
            identity: input.identity,
            storeRoot: `/data/${input.identity.workspaceIdentity}/${input.identity.workspaceIncarnation}/repo.git`,
        };
        stores.set(`${input.identity.workspaceIdentity}:${input.identity.workspaceIncarnation}`, store);
        return store as never;
    });
    const makeFeed = vi.fn((input: { workspaceRoot: string; storeRoot: string }) => ({ input }) as never);
    const trackers: Array<{ store: unknown; feed: unknown; dispose: ReturnType<typeof vi.fn> }> = [];
    const makeTracker = vi.fn((input: { store: unknown; feed: unknown }) => {
        const tracker = { ...input, dispose: vi.fn(async () => undefined) };
        trackers.push(tracker);
        return tracker as never;
    });
    const registry = new WorkspaceTrackerRegistry({ openStore: openStore as never, makeFeed, makeTracker });
    return { registry, openStore, makeFeed, makeTracker, trackers, stores };
}

function acquireInput(workspace: CanonicalWorkspaceIdentity) {
    return {
        dataRoot: "/data",
        identity: workspace,
        git: {} as never,
        processOwner: ProcessOwner,
    };
}

describe("WorkspaceTrackerRegistry", () => {
    it("shares one initialization promise, store, and tracker until the last idempotent release", async () => {
        const opened = deferred<never>();
        const openStore = vi.fn(() => opened.promise);
        const feed = {};
        const tracker = { dispose: vi.fn(async () => undefined) };
        const registry = new WorkspaceTrackerRegistry({
            openStore,
            makeFeed: vi.fn(() => feed as never),
            makeTracker: vi.fn(() => tracker as never),
        });
        const workspace = identity();

        const firstPromise = registry.acquire(acquireInput(workspace));
        const secondPromise = registry.acquire(acquireInput(workspace));
        expect(openStore).toHaveBeenCalledTimes(1);

        const store = { identity: workspace, storeRoot: "/data/workspace/repo.git" };
        opened.resolve(store as never);
        const [first, second] = await Promise.all([firstPromise, secondPromise]);
        expect(first.store).toBe(store);
        expect(second.store).toBe(store);
        expect(first.tracker).toBe(tracker);
        expect(second.tracker).toBe(tracker);

        await first.release();
        await first.release();
        expect(tracker.dispose).not.toHaveBeenCalled();
        await second.release();
        expect(tracker.dispose).toHaveBeenCalledTimes(1);
    });

    it("isolates different workspace identities and incarnations", async () => {
        const value = makeRegistry();
        const first = await value.registry.acquire(acquireInput(identity()));
        const otherIdentity = await value.registry.acquire(
            acquireInput(identity({ workspaceIdentity: "d".repeat(64), storeKey: "other-identity" }))
        );
        const otherIncarnation = await value.registry.acquire(
            acquireInput(identity({ workspaceIncarnation: "e".repeat(64), storeKey: "other-incarnation" }))
        );

        expect(new Set([first.tracker, otherIdentity.tracker, otherIncarnation.tracker]).size).toBe(3);
        expect(value.openStore).toHaveBeenCalledTimes(3);

        await Promise.all([first.release(), otherIdentity.release(), otherIncarnation.release()]);
        expect(value.trackers.every((tracker) => tracker.dispose.mock.calls.length === 1)).toBe(true);
    });

    it("removes a failed initialization so a later acquire can retry", async () => {
        const workspace = identity();
        const store = { identity: workspace, storeRoot: "/data/workspace/repo.git" };
        const openStore = vi
            .fn()
            .mockRejectedValueOnce(new Error("open failed"))
            .mockResolvedValueOnce(store as never);
        const tracker = { dispose: vi.fn(async () => undefined) };
        const registry = new WorkspaceTrackerRegistry({
            openStore,
            makeFeed: vi.fn(() => ({}) as never),
            makeTracker: vi.fn(() => tracker as never),
        });

        await expect(registry.acquire(acquireInput(workspace))).rejects.toThrow("open failed");
        const lease = await registry.acquire(acquireInput(workspace));

        expect(openStore).toHaveBeenCalledTimes(2);
        expect(lease.store).toBe(store);
        await lease.release();
    });

    it("disposes a feed created before tracker initialization fails", async () => {
        const workspace = identity();
        const store = { identity: workspace, storeRoot: "/data/workspace/repo.git" };
        const feed = { dispose: vi.fn(async () => undefined) };
        const tracker = { dispose: vi.fn(async () => undefined) };
        const makeTracker = vi
            .fn()
            .mockImplementationOnce(() => {
                throw new Error("tracker failed");
            })
            .mockReturnValueOnce(tracker as never);
        const registry = new WorkspaceTrackerRegistry({
            openStore: vi.fn(async () => store as never),
            makeFeed: vi.fn(() => feed as never),
            makeTracker,
        });

        await expect(registry.acquire(acquireInput(workspace))).rejects.toThrow("tracker failed");
        expect(feed.dispose).toHaveBeenCalledTimes(1);
        const lease = await registry.acquire(acquireInput(workspace));
        expect(lease.tracker).toBe(tracker);
        await lease.release();
    });
});
