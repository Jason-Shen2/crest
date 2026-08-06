// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

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
    initialization: Promise<WorkspaceTrackerRegistryResource>;
    refCount: number;
    disposal?: Promise<void>;
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
        while (true) {
            let entry = this.entries.get(key);
            if (entry?.refCount === 0) {
                await this.disposeEntry(key, entry);
                continue;
            }
            if (!entry) {
                entry = this.makeEntry(input);
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
            let released = false;
            return {
                ...resource,
                release: async () => {
                    if (released) return;
                    released = true;
                    entry!.refCount--;
                    if (entry!.refCount === 0) await this.disposeEntry(key, entry!);
                },
            };
        }
    }

    makeEntry(input: WorkspaceTrackerAcquireInput): WorkspaceTrackerRegistryEntry {
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
        return { initialization, refCount: 0 };
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

const ProcessWorkspaceTrackerRegistry = new WorkspaceTrackerRegistry();

export function acquireWorkspaceTracker(input: WorkspaceTrackerAcquireInput): Promise<WorkspaceTrackerLease> {
    return ProcessWorkspaceTrackerRegistry.acquire(input);
}
