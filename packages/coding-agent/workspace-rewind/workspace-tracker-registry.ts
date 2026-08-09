// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import { initializeWorkspaceCheckpointSnapshotSource, type WorkspaceCheckpointSnapshotSource } from "./snapshot-source";
import { WorkspaceCheckpointLimits, WorkspaceSnapshotStore } from "./snapshot-store";
import { WorkspaceCandidates } from "./workspace-candidates";
import { ParcelWorkspaceChangeFeed, type WorkspaceChangeFeed } from "./workspace-change-feed";
import { discoverWorkspaceScope } from "./workspace-scope";
import { WorkspaceSnapshotTracker } from "./workspace-snapshot-tracker";
import { WorkspaceWriterLeaseRegistry } from "./workspace-writer-lease";

export interface WorkspaceTrackerLease {
    store: WorkspaceSnapshotStore;
    mutationLog: WorkspaceSnapshotStore["mutationLog"];
    candidates: WorkspaceCandidates;
    writerLeases: WorkspaceWriterLeaseRegistry;
    snapshotSource: WorkspaceCheckpointSnapshotSource;
    release(): Promise<void>;
}

export type WorkspaceTrackerAcquireInput = Parameters<typeof WorkspaceSnapshotStore.open>[0];

export interface WorkspaceTrackerRegistryDependencies {
    openStore: typeof WorkspaceSnapshotStore.open;
    makeFeed(input: { workspaceRoot: string; storeRoot: string }): WorkspaceChangeFeed;
    makeTracker(input: { store: WorkspaceSnapshotStore; feed: WorkspaceChangeFeed }): WorkspaceSnapshotTracker;
    makeCandidates(input: {
        store: WorkspaceSnapshotStore;
        feed: WorkspaceChangeFeed;
        userGit: WorkspaceTrackerAcquireInput["git"];
    }): WorkspaceCandidates;
    makeWriterLeases(): WorkspaceWriterLeaseRegistry;
    makeSnapshotSource(input: {
        store: WorkspaceSnapshotStore;
        tracker: WorkspaceSnapshotTracker;
        candidates: WorkspaceCandidates;
    }): Promise<WorkspaceCheckpointSnapshotSource>;
}

interface WorkspaceTrackerRegistryResource {
    store: WorkspaceSnapshotStore;
    mutationLog: WorkspaceSnapshotStore["mutationLog"];
    tracker: WorkspaceSnapshotTracker;
    candidates: WorkspaceCandidates;
    writerLeases: WorkspaceWriterLeaseRegistry;
    snapshotSource: WorkspaceCheckpointSnapshotSource;
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
    makeCandidates: ({ store, feed, userGit }) =>
        new WorkspaceCandidates({
            workspaceRoot: store.identity.canonicalRoot,
            feed,
            userGit,
            shadowGit: store.git,
            reconcile: async (signal) => {
                const scope = await discoverWorkspaceScope({
                    identity: store.identity,
                    git: userGit,
                    maxEntries: WorkspaceCheckpointLimits.maxEntries,
                    maxUntrackedBytes: WorkspaceCheckpointLimits.maxUntrackedFileBytes,
                    signal,
                });
                return scope.entries.flatMap((entry) => (entry.path ? [entry.path] : []));
            },
        }),
    makeWriterLeases: () => new WorkspaceWriterLeaseRegistry(),
    makeSnapshotSource: ({ store, tracker, candidates }) =>
        initializeWorkspaceCheckpointSnapshotSource({ store, legacyCapture: tracker, candidates }),
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
                store: resource.store,
                mutationLog: resource.mutationLog,
                candidates: resource.candidates,
                writerLeases: resource.writerLeases,
                snapshotSource: resource.snapshotSource,
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
            let tracker: WorkspaceSnapshotTracker | undefined;
            try {
                tracker = this.dependencies.makeTracker({ store, feed });
                const candidates = this.dependencies.makeCandidates({ store, feed, userGit: input.git });
                const writerLeases = this.dependencies.makeWriterLeases();
                const snapshotSource = await this.dependencies.makeSnapshotSource({ store, tracker, candidates });
                return {
                    store,
                    mutationLog: store.mutationLog,
                    tracker,
                    candidates,
                    writerLeases,
                    snapshotSource,
                };
            } catch (error) {
                try {
                    await (tracker ? tracker.dispose() : feed.dispose());
                } catch (cleanupError) {
                    throw new AggregateError(
                        [error, cleanupError],
                        "Workspace resource initialization and hint cleanup failed"
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
            .then(async (resource) => {
                const failures: unknown[] = [];
                if (resource.snapshotSource.dispose) {
                    try {
                        await resource.snapshotSource.dispose();
                    } catch (error) {
                        failures.push(error);
                    }
                }
                try {
                    await resource.tracker.dispose();
                } catch (error) {
                    failures.push(error);
                }
                if (failures.length === 1) throw failures[0];
                if (failures.length > 1) {
                    throw new AggregateError(failures, "Workspace in-memory resource disposal failed");
                }
            })
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
