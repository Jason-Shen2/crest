// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import { WorkspaceSnapshotStore } from "./snapshot-store";
import { ParcelWorkspaceChangeFeed, type WorkspaceChangeFeed } from "./workspace-change-feed";
import { WorkspaceSnapshotTracker } from "./workspace-snapshot-tracker";

export interface WorkspaceTrackerLease {
    store: WorkspaceSnapshotStore;
    tracker: WorkspaceSnapshotTracker;
    release(): Promise<void>;
}

export type WorkspaceTrackerAcquireInput = Parameters<typeof WorkspaceSnapshotStore.open>[0];

export interface WorkspaceTrackerRegistryDependencies {
    openStore: typeof WorkspaceSnapshotStore.open;
    makeFeed(input: { workspaceRoot: string; storeRoot: string }): WorkspaceChangeFeed;
    makeTracker(input: { store: WorkspaceSnapshotStore; feed: WorkspaceChangeFeed }): WorkspaceSnapshotTracker;
}

interface WorkspaceTrackerRegistryResource {
    store: WorkspaceSnapshotStore;
    tracker: WorkspaceSnapshotTracker;
}

interface WorkspaceTrackerRegistryEntry {
    binding: WorkspaceTrackerRegistryBinding;
    initialization: Promise<WorkspaceTrackerRegistryResource>;
    refCount: number;
    disposal?: Promise<void>;
}

interface WorkspaceTrackerRegistryBinding {
    dataRoot: string;
    identity: WorkspaceTrackerAcquireInput["identity"];
    processOwner: WorkspaceTrackerAcquireInput["processOwner"];
}

const DefaultDependencies: WorkspaceTrackerRegistryDependencies = {
    openStore: WorkspaceSnapshotStore.open,
    makeFeed: (input) => new ParcelWorkspaceChangeFeed(input),
    makeTracker: (input) => new WorkspaceSnapshotTracker(input),
};

export class WorkspaceTrackerRegistry {
    readonly dependencies: WorkspaceTrackerRegistryDependencies;
    readonly entries = new Map<string, WorkspaceTrackerRegistryEntry>();

    constructor(dependencies: Partial<WorkspaceTrackerRegistryDependencies> = {}) {
        this.dependencies = { ...DefaultDependencies, ...dependencies };
    }

    async acquire(input: WorkspaceTrackerAcquireInput): Promise<WorkspaceTrackerLease> {
        const key = `${input.identity.workspaceIdentity}:${input.identity.workspaceIncarnation}`;
        const binding = makeBinding(input);
        while (true) {
            let entry = this.entries.get(key);
            if (entry && !bindingsEqual(entry.binding, binding)) {
                throw new Error(`Workspace tracker registry binding mismatch for ${key}`);
            }
            if (entry?.refCount === 0) {
                await this.disposeEntry(key, entry);
                continue;
            }
            if (!entry) {
                entry = this.makeEntry(input, binding);
                this.entries.set(key, entry);
            }
            entry.refCount++;
            let resource: WorkspaceTrackerRegistryResource;
            try {
                resource = await entry.initialization;
            } catch (error) {
                entry.refCount--;
                if (this.entries.get(key) === entry) this.entries.delete(key);
                throw error;
            }
            let decremented = false;
            let releasePromise: Promise<void> | undefined;
            return {
                ...resource,
                release: () => {
                    if (releasePromise) return releasePromise;
                    if (!decremented) {
                        decremented = true;
                        entry!.refCount--;
                    }
                    if (entry!.refCount > 0) {
                        releasePromise = Promise.resolve();
                        return releasePromise;
                    }
                    releasePromise = this.disposeEntry(key, entry!).catch((error) => {
                        releasePromise = undefined;
                        throw error;
                    });
                    return releasePromise;
                },
            };
        }
    }

    makeEntry(
        input: WorkspaceTrackerAcquireInput,
        binding: WorkspaceTrackerRegistryBinding
    ): WorkspaceTrackerRegistryEntry {
        const initialization = (async () => {
            const store = await this.dependencies.openStore(input);
            const feed = this.dependencies.makeFeed({
                workspaceRoot: store.identity.canonicalRoot,
                storeRoot: store.storeRoot,
            });
            try {
                const tracker = this.dependencies.makeTracker({ store, feed });
                return { store, tracker };
            } catch (error) {
                try {
                    await feed.dispose();
                } catch (cleanupError) {
                    throw new AggregateError(
                        [error, cleanupError],
                        "Workspace tracker initialization and feed cleanup failed"
                    );
                }
                throw error;
            }
        })();
        return { binding, initialization, refCount: 0 };
    }

    disposeEntry(key: string, entry: WorkspaceTrackerRegistryEntry): Promise<void> {
        if (entry.disposal) return entry.disposal;
        const disposal = entry.initialization
            .then((resource) => resource.tracker.dispose())
            .then(() => {
                if (this.entries.get(key) === entry) this.entries.delete(key);
            });
        entry.disposal = disposal.catch((error) => {
            entry.disposal = undefined;
            throw error;
        });
        return entry.disposal;
    }
}

function makeBinding(input: WorkspaceTrackerAcquireInput): WorkspaceTrackerRegistryBinding {
    return {
        dataRoot: resolve(input.dataRoot),
        identity: {
            ...input.identity,
            ancestorIdentityChain: input.identity.ancestorIdentityChain.map((ancestor) => ({ ...ancestor })),
        },
        processOwner: { ...input.processOwner },
    };
}

function bindingsEqual(left: WorkspaceTrackerRegistryBinding, right: WorkspaceTrackerRegistryBinding): boolean {
    if (left.dataRoot !== right.dataRoot) return false;
    if (left.identity.canonicalRoot !== right.identity.canonicalRoot) return false;
    if (left.identity.storeKey !== right.identity.storeKey) return false;
    if (left.identity.workspaceIdentity !== right.identity.workspaceIdentity) return false;
    if (left.identity.workspaceIncarnation !== right.identity.workspaceIncarnation) return false;
    if (left.identity.ancestorIdentityChain.length !== right.identity.ancestorIdentityChain.length) return false;
    for (let index = 0; index < left.identity.ancestorIdentityChain.length; index++) {
        const leftAncestor = left.identity.ancestorIdentityChain[index];
        const rightAncestor = right.identity.ancestorIdentityChain[index];
        if (leftAncestor.absolutePath !== rightAncestor.absolutePath) return false;
        if (leftAncestor.dev !== rightAncestor.dev) return false;
        if (leftAncestor.ino !== rightAncestor.ino) return false;
        if (leftAncestor.birthtimeNs !== rightAncestor.birthtimeNs) return false;
    }
    if (left.processOwner.pid !== right.processOwner.pid) return false;
    if (left.processOwner.processStartToken !== right.processOwner.processStartToken) return false;
    return left.processOwner.nonce === right.processOwner.nonce;
}

const ProcessWorkspaceTrackerRegistry = new WorkspaceTrackerRegistry();

export function acquireWorkspaceTracker(input: WorkspaceTrackerAcquireInput): Promise<WorkspaceTrackerLease> {
    return ProcessWorkspaceTrackerRegistry.acquire(input);
}
