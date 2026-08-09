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
        ancestorIdentityChain: [
            {
                absolutePath: "/",
                dev: "1",
                ino: "2",
                birthtimeNs: "3",
            },
        ],
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

function makeSharedResourceDependencies() {
    return {
        makeCandidates: vi.fn(() => ({}) as never),
        makeWriterLeases: vi.fn(() => ({}) as never),
        makeSnapshotSource: vi.fn(async () => ({}) as never),
    };
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
    const registry = new WorkspaceTrackerRegistry({
        ...makeSharedResourceDependencies(),
        openStore: openStore as never,
        makeFeed,
        makeTracker,
    });
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

type RegistryAcquireInput = ReturnType<typeof acquireInput>;
type BindingMismatchCase = readonly [string, (input: RegistryAcquireInput) => RegistryAcquireInput];

const BindingMismatchCases: BindingMismatchCase[] = [
    ["dataRoot", (input) => ({ ...input, dataRoot: "/other-data" })],
    [
        "identity.canonicalRoot",
        (input) => ({ ...input, identity: { ...input.identity, canonicalRoot: "/other-workspace" } }),
    ],
    ["identity.storeKey", (input) => ({ ...input, identity: { ...input.identity, storeKey: "other-store" } })],
    [
        "identity.ancestorIdentityChain.length",
        (input) => ({ ...input, identity: { ...input.identity, ancestorIdentityChain: [] } }),
    ],
    ...(["absolutePath", "dev", "ino", "birthtimeNs"] as const).map(
        (field): BindingMismatchCase => [
            `identity.ancestorIdentityChain.${field}`,
            (input) => ({
                ...input,
                identity: {
                    ...input.identity,
                    ancestorIdentityChain: [{ ...input.identity.ancestorIdentityChain[0], [field]: `other-${field}` }],
                },
            }),
        ]
    ),
    ["processOwner.pid", (input) => ({ ...input, processOwner: { ...input.processOwner, pid: 99 } })],
    [
        "processOwner.processStartToken",
        (input) => ({ ...input, processOwner: { ...input.processOwner, processStartToken: "other-start" } }),
    ],
    ["processOwner.nonce", (input) => ({ ...input, processOwner: { ...input.processOwner, nonce: "other-nonce" } })],
];

describe("WorkspaceTrackerRegistry", () => {
    it("shares the exact canonical Workspace resource and isolates every incarnation", async () => {
        const store = {
            identity: identity(),
            storeRoot: "/data/workspace/repo.git",
            mutationLog: {},
        };
        const tracker = { dispose: vi.fn(async () => undefined) };
        const makeCandidates = vi.fn(() => ({}));
        const makeWriterLeases = vi.fn(() => ({}));
        const makeSnapshotSource = vi.fn(async () => ({ dispose: vi.fn(async () => undefined) }));
        const registry = new WorkspaceTrackerRegistry({
            openStore: vi.fn(async (input) => ({
                ...store,
                identity: input.identity,
                mutationLog: {},
            })) as never,
            makeFeed: vi.fn(() => ({}) as never),
            makeTracker: vi.fn(() => tracker as never),
            makeCandidates,
            makeWriterLeases,
            makeSnapshotSource,
        } as never);

        const [first, second] = await Promise.all([
            registry.acquire(acquireInput(identity())),
            registry.acquire(acquireInput(identity())),
        ]);
        const isolated = await registry.acquire(
            acquireInput(identity({ workspaceIncarnation: "e".repeat(64), storeKey: "other-incarnation" }))
        );

        expect(second.store).toBe(first.store);
        expect(second.mutationLog).toBe(first.store.mutationLog);
        expect(second.mutationLog).toBe(first.mutationLog);
        expect(second.candidates).toBe(first.candidates);
        expect(second.writerLeases).toBe(first.writerLeases);
        expect(second.snapshotSource).toBe(first.snapshotSource);
        expect(isolated.store).not.toBe(first.store);
        expect(isolated.mutationLog).not.toBe(first.mutationLog);
        expect(isolated.candidates).not.toBe(first.candidates);
        expect(isolated.writerLeases).not.toBe(first.writerLeases);
        expect(isolated.snapshotSource).not.toBe(first.snapshotSource);
        expect(makeCandidates).toHaveBeenCalledTimes(2);
        expect(makeWriterLeases).toHaveBeenCalledTimes(2);
        expect(makeSnapshotSource).toHaveBeenCalledTimes(2);

        await Promise.all([first.release(), second.release(), isolated.release()]);
    });

    it("last idempotent release disposes capture hints without disposing durable Workspace state", async () => {
        const mutationLog = { dispose: vi.fn(async () => undefined) };
        const store = {
            identity: identity(),
            storeRoot: "/data/workspace/repo.git",
            mutationLog,
            dispose: vi.fn(async () => undefined),
        };
        const tracker = { dispose: vi.fn(async () => undefined) };
        const snapshotSource = { dispose: vi.fn(async () => undefined) };
        const registry = new WorkspaceTrackerRegistry({
            openStore: vi.fn(async () => store) as never,
            makeFeed: vi.fn(() => ({}) as never),
            makeTracker: vi.fn(() => tracker as never),
            makeCandidates: vi.fn(() => ({})),
            makeWriterLeases: vi.fn(() => ({})),
            makeSnapshotSource: vi.fn(async () => snapshotSource),
        } as never);

        const first = await registry.acquire(acquireInput(identity()));
        const second = await registry.acquire(acquireInput(identity()));
        await first.release();
        expect(snapshotSource.dispose).not.toHaveBeenCalled();
        expect(tracker.dispose).not.toHaveBeenCalled();

        await second.release();
        await second.release();

        expect(snapshotSource.dispose).toHaveBeenCalledOnce();
        expect(tracker.dispose).toHaveBeenCalledOnce();
        expect(store.dispose).not.toHaveBeenCalled();
        expect(mutationLog.dispose).not.toHaveBeenCalled();
    });

    it("shares one initialization promise, store, and tracker until the last idempotent release", async () => {
        const opened = deferred<never>();
        const openStore = vi.fn(() => opened.promise);
        const feed = {};
        const tracker = { dispose: vi.fn(async () => undefined) };
        const registry = new WorkspaceTrackerRegistry({
            ...makeSharedResourceDependencies(),
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
        await second.release();
        expect(tracker.dispose).toHaveBeenCalledTimes(1);
    });

    it("retries final disposal from the same lease without decrementing twice", async () => {
        const workspace = identity();
        const store = { identity: workspace, storeRoot: "/data/workspace/repo.git" };
        const dispose = vi.fn().mockRejectedValueOnce(new Error("dispose failed")).mockResolvedValueOnce(undefined);
        const registry = new WorkspaceTrackerRegistry({
            ...makeSharedResourceDependencies(),
            openStore: vi.fn(async () => store as never),
            makeFeed: vi.fn(() => ({}) as never),
            makeTracker: vi.fn(() => ({ dispose }) as never),
        });
        const lease = await registry.acquire(acquireInput(workspace));

        await expect(lease.release()).rejects.toThrow("dispose failed");
        await expect(lease.release()).resolves.toBeUndefined();

        expect(dispose).toHaveBeenCalledTimes(2);
    });

    it("shares an in-flight final disposal and does not create an overlapping tracker on reacquire", async () => {
        const workspace = identity();
        const store = { identity: workspace, storeRoot: "/data/workspace/repo.git" };
        const disposing = deferred<void>();
        const firstTracker = { dispose: vi.fn(() => disposing.promise) };
        const secondTracker = { dispose: vi.fn(async () => undefined) };
        const makeTracker = vi
            .fn()
            .mockReturnValueOnce(firstTracker as never)
            .mockReturnValueOnce(secondTracker as never);
        const registry = new WorkspaceTrackerRegistry({
            ...makeSharedResourceDependencies(),
            openStore: vi.fn(async () => store as never),
            makeFeed: vi.fn(() => ({}) as never),
            makeTracker,
        });
        const lease = await registry.acquire(acquireInput(workspace));

        const firstRelease = lease.release();
        const secondRelease = lease.release();
        const reacquired = registry.acquire(acquireInput(workspace));
        let reacquiredSettled = false;
        void reacquired.finally(() => {
            reacquiredSettled = true;
        });
        await Promise.resolve();

        expect(secondRelease).toBe(firstRelease);
        expect(firstTracker.dispose).toHaveBeenCalledTimes(1);
        expect(makeTracker).toHaveBeenCalledTimes(1);
        expect(reacquiredSettled).toBe(false);

        disposing.resolve();
        await expect(firstRelease).resolves.toBeUndefined();
        const replacement = await reacquired;
        expect(replacement.tracker).toBe(secondTracker);
        expect(makeTracker).toHaveBeenCalledTimes(2);
        await replacement.release();
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

    it("normalizes the data root and does not bind the registry to a Git runner instance", async () => {
        const value = makeRegistry();
        const workspace = identity();
        const first = await value.registry.acquire(acquireInput(workspace));
        const second = await value.registry.acquire({
            ...acquireInput(workspace),
            dataRoot: "/data/./",
            git: { different: true } as never,
        });

        expect(second.tracker).toBe(first.tracker);
        expect(value.openStore).toHaveBeenCalledTimes(1);
        await Promise.all([first.release(), second.release()]);
    });

    it.each(BindingMismatchCases)("rejects a same-key %s binding mismatch", async (_field, change) => {
        const value = makeRegistry();
        const input = acquireInput(identity());
        const lease = await value.registry.acquire(input);

        await expect(value.registry.acquire(change(input) as never)).rejects.toThrow(/binding mismatch/i);

        expect(value.openStore).toHaveBeenCalledTimes(1);
        await lease.release();
        expect(value.trackers[0].dispose).toHaveBeenCalledTimes(1);
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
            ...makeSharedResourceDependencies(),
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
            ...makeSharedResourceDependencies(),
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
