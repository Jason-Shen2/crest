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
        ancestorIdentityChain: [{ absolutePath: "/", dev: "1", ino: "2", birthtimeNs: "3" }],
        ...overrides,
    };
}

function acquireInput(workspace: CanonicalWorkspaceIdentity) {
    return {
        dataRoot: "/data",
        identity: workspace,
        git: {} as never,
        processOwner: ProcessOwner,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function makeRegistry() {
    const feeds: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    const sources: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    const openStore = vi.fn(async (input: { identity: CanonicalWorkspaceIdentity }) => ({
        identity: input.identity,
        storeRoot: `/data/${input.identity.storeKey}/repo.git`,
        mutationLog: {},
    }));
    const makeFeed = vi.fn(() => {
        const feed = { dispose: vi.fn(async () => undefined) };
        feeds.push(feed);
        return feed as never;
    });
    const makeSnapshotSource = vi.fn(async () => {
        const source = { dispose: vi.fn(async () => undefined) };
        sources.push(source);
        return source as never;
    });
    const registry = new WorkspaceTrackerRegistry({
        openStore: openStore as never,
        makeFeed,
        makeCandidates: vi.fn(() => ({}) as never),
        makeWriterLeases: vi.fn(() => ({}) as never),
        makeSnapshotSource,
    });
    return { registry, openStore, makeFeed, makeSnapshotSource, feeds, sources };
}

describe("WorkspaceTrackerRegistry", () => {
    it("has no tracker factory or tracker resource after the authority cutover", () => {
        const registry = new WorkspaceTrackerRegistry();

        expect(registry.dependencies).not.toHaveProperty("makeTracker");
    });

    it("shares one exact canonical resource and isolates different incarnations", async () => {
        const value = makeRegistry();
        const [first, second] = await Promise.all([
            value.registry.acquire(acquireInput(identity())),
            value.registry.acquire(acquireInput(identity())),
        ]);
        const isolated = await value.registry.acquire(
            acquireInput(identity({ workspaceIncarnation: "e".repeat(64), storeKey: "other-incarnation" }))
        );

        expect(second.store).toBe(first.store);
        expect(second.mutationLog).toBe(first.mutationLog);
        expect(second.candidates).toBe(first.candidates);
        expect(second.writerLeases).toBe(first.writerLeases);
        expect(second.snapshotSource).toBe(first.snapshotSource);
        expect(isolated.store).not.toBe(first.store);
        expect(isolated.mutationLog).not.toBe(first.mutationLog);
        expect(value.openStore).toHaveBeenCalledTimes(2);
        expect(value.makeFeed).toHaveBeenCalledTimes(2);
        expect(value.makeSnapshotSource).toHaveBeenCalledTimes(2);

        await Promise.all([first.release(), second.release(), isolated.release()]);
    });

    it("last idempotent release disposes source and feed once without disposing durable state", async () => {
        const feed = { dispose: vi.fn(async () => undefined) };
        const snapshotSource = {
            readHead: vi.fn(),
            synchronizeExternal: vi.fn(),
            captureOwnedTurn: vi.fn(),
            dispose: vi.fn(async () => undefined),
        };
        const mutationLog = { dispose: vi.fn(async () => undefined) };
        const store = {
            identity: identity(),
            storeRoot: "/data/workspace/repo.git",
            mutationLog,
            dispose: vi.fn(async () => undefined),
        };
        const registry = new WorkspaceTrackerRegistry({
            openStore: vi.fn(async () => store) as never,
            makeFeed: vi.fn(() => feed as never),
            makeCandidates: vi.fn(() => ({}) as never),
            makeWriterLeases: vi.fn(() => ({}) as never),
            makeSnapshotSource: vi.fn(async () => snapshotSource),
        });

        const first = await registry.acquire(acquireInput(identity()));
        const second = await registry.acquire(acquireInput(identity()));
        await first.release();
        expect(snapshotSource.dispose).not.toHaveBeenCalled();
        expect(feed.dispose).not.toHaveBeenCalled();

        await second.release();
        await second.release();

        expect(snapshotSource.dispose).toHaveBeenCalledOnce();
        expect(feed.dispose).toHaveBeenCalledOnce();
        expect(store.dispose).not.toHaveBeenCalled();
        expect(mutationLog.dispose).not.toHaveBeenCalled();
    });

    it("disposes a feed when snapshot-source initialization fails and permits retry", async () => {
        const feeds = [{ dispose: vi.fn(async () => undefined) }, { dispose: vi.fn(async () => undefined) }];
        const makeSnapshotSource = vi
            .fn()
            .mockRejectedValueOnce(new Error("source failed"))
            .mockResolvedValueOnce({ dispose: vi.fn(async () => undefined) });
        const registry = new WorkspaceTrackerRegistry({
            openStore: vi.fn(async () => ({
                identity: identity(),
                storeRoot: "/data/workspace/repo.git",
                mutationLog: {},
            })) as never,
            makeFeed: vi.fn().mockReturnValueOnce(feeds[0]).mockReturnValueOnce(feeds[1]),
            makeCandidates: vi.fn(() => ({}) as never),
            makeWriterLeases: vi.fn(() => ({}) as never),
            makeSnapshotSource,
        });

        await expect(registry.acquire(acquireInput(identity()))).rejects.toThrow("source failed");
        expect(feeds[0].dispose).toHaveBeenCalledOnce();

        const lease = await registry.acquire(acquireInput(identity()));
        await lease.release();
        expect(feeds[1].dispose).toHaveBeenCalledOnce();
    });

    it("waits for an in-flight final disposal before replacing the resource", async () => {
        const closing = deferred<void>();
        const firstFeed = { dispose: vi.fn(() => closing.promise) };
        const secondFeed = { dispose: vi.fn(async () => undefined) };
        const makeFeed = vi.fn().mockReturnValueOnce(firstFeed).mockReturnValueOnce(secondFeed);
        const registry = new WorkspaceTrackerRegistry({
            openStore: vi.fn(async () => ({
                identity: identity(),
                storeRoot: "/data/workspace/repo.git",
                mutationLog: {},
            })) as never,
            makeFeed,
            makeCandidates: vi.fn(() => ({}) as never),
            makeWriterLeases: vi.fn(() => ({}) as never),
            makeSnapshotSource: vi.fn(async () => ({ dispose: vi.fn(async () => undefined) })) as never,
        });
        const lease = await registry.acquire(acquireInput(identity()));

        const release = lease.release();
        const reacquired = registry.acquire(acquireInput(identity()));
        await Promise.resolve();
        expect(makeFeed).toHaveBeenCalledOnce();

        closing.resolve();
        await release;
        const replacement = await reacquired;
        expect(makeFeed).toHaveBeenCalledTimes(2);
        await replacement.release();
    });

    it.each([
        ["dataRoot", (input: ReturnType<typeof acquireInput>) => ({ ...input, dataRoot: "/other-data" })],
        [
            "canonicalRoot",
            (input: ReturnType<typeof acquireInput>) => ({
                ...input,
                identity: { ...input.identity, canonicalRoot: "/other-workspace" },
            }),
        ],
        [
            "process owner",
            (input: ReturnType<typeof acquireInput>) => ({
                ...input,
                processOwner: { ...input.processOwner, nonce: "d".repeat(64) },
            }),
        ],
    ])("rejects a same-key %s binding mismatch", async (_name, change) => {
        const value = makeRegistry();
        const input = acquireInput(identity());
        const lease = await value.registry.acquire(input);

        await expect(value.registry.acquire(change(input) as never)).rejects.toThrow(/binding mismatch/i);

        await lease.release();
    });
});
