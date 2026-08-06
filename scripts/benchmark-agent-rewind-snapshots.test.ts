// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { WorkspaceSnapshotStoreError } from "../packages/coding-agent/workspace-rewind/snapshot-store";
import { runAgentRewindSnapshotBenchmark } from "./benchmark-agent-rewind-snapshots";

describe("agent rewind snapshot benchmark", () => {
    test("uses an injected fixture factory without doing import-time benchmark work", async () => {
        const sentinel = new Error("injected fixture factory");
        const run = runAgentRewindSnapshotBenchmark as unknown as (
            options: { entryCounts: number[]; iterations: number },
            onRow: (row: unknown) => void,
            dependencies: { makeFixture(): Promise<never> }
        ) => Promise<unknown>;

        await expect(
            run({ entryCounts: [0], iterations: 1 }, () => undefined, {
                makeFixture: async () => {
                    throw sentinel;
                },
            })
        ).rejects.toBe(sentinel);
    });

    test("continues after capture timeouts and releases every measured session lease", async () => {
        const captureTimeout = () => new WorkspaceSnapshotStoreError("capture_timeout", "timed out");
        const cleaned: string[] = [];
        const acquired: number[] = [];
        let released = 0;
        const makeFixture = async (entryCount: number, shape: "deep" | "wide", contentCardinality: number) => {
            const unique = contentCardinality === entryCount;
            let captureCount = 0;
            const tracker = {
                capture: async () => {
                    captureCount++;
                    if (unique || shape === "deep" || (shape === "wide" && captureCount === 2)) {
                        throw captureTimeout();
                    }
                    return { coverage: { newlyHashedBytes: 0 } };
                },
            };
            return {
                root: `${shape}:${unique ? "unique" : "representative"}`,
                shape,
                workspaceRoot: "/fixture",
                directoryCount: 0,
                contentCardinality,
                paths: Array.from({ length: entryCount }, (_, index) => `file-${index}`),
                store: {},
                tracker,
                feed: { record: () => undefined },
                metrics: {
                    fullReconcileCount: 0,
                    enumeratedEntries: 0,
                    workerActive: 0,
                    workerPeak: 0,
                    newlyHashedBytes: 0,
                    hooks: {},
                    reset() {
                        this.fullReconcileCount = 0;
                        this.enumeratedEntries = 0;
                        this.workerActive = 0;
                        this.workerPeak = 0;
                        this.newlyHashedBytes = 0;
                    },
                },
            };
        };
        const run = runAgentRewindSnapshotBenchmark as unknown as (
            options: { entryCounts: number[]; iterations: number },
            onRow: (row: Record<string, unknown>) => void,
            dependencies: Record<string, unknown>
        ) => Promise<Array<Record<string, unknown>>>;

        const rows = await run(
            { entryCounts: [10], iterations: 1 },
            () => {
                throw new Error("row observer failed");
            },
            {
                makeFixture,
                countLooseObjects: async () => 0,
                mutatePaths: async () => undefined,
                now: () => 1,
                cleanupFixture: async (fixture: { root: string }) => cleaned.push(fixture.root),
                acquireLeases: async (fixture: { tracker: unknown }, count: number) => {
                    acquired.push(count);
                    return Array.from({ length: count }, () => ({
                        tracker: fixture.tracker,
                        release: async () => {
                            released++;
                        },
                    }));
                },
            }
        );

        expect(rows).toHaveLength(22);
        expect(rows.filter((row) => row.outcome === "capture-timeout")).toHaveLength(4);
        expect(rows.filter((row) => row.outcome === "baseline-unavailable")).toHaveLength(9);
        expect(rows.every((row) => Object.keys(row).length === 15)).toBe(true);
        expect(acquired).toEqual([1, 2, 4, 1, 2, 4, 1, 2, 4]);
        expect(released).toBe(21);
        expect(cleaned).toHaveLength(4);
    });

    test("keeps unexpected failures nonzero while cleaning the fixture", async () => {
        const failure = new Error("unexpected capture failure");
        let cleaned = 0;
        const run = runAgentRewindSnapshotBenchmark as unknown as (
            options: { entryCounts: number[]; iterations: number },
            onRow: (row: unknown) => void,
            dependencies: Record<string, unknown>
        ) => Promise<unknown>;

        await expect(
            run({ entryCounts: [10], iterations: 1 }, () => undefined, {
                makeFixture: async () => ({
                    root: "unexpected",
                    shape: "deep",
                    workspaceRoot: "/fixture",
                    directoryCount: 0,
                    contentCardinality: 10,
                    paths: ["file"],
                    store: {},
                    tracker: { capture: async () => Promise.reject(failure) },
                    feed: { record: () => undefined },
                    metrics: {
                        fullReconcileCount: 0,
                        enumeratedEntries: 0,
                        workerActive: 0,
                        workerPeak: 0,
                        newlyHashedBytes: 0,
                        hooks: {},
                        reset: () => undefined,
                    },
                }),
                countLooseObjects: async () => 0,
                cleanupFixture: async () => {
                    cleaned++;
                },
            })
        ).rejects.toBe(failure);
        expect(cleaned).toBe(1);
    });

    test("drains queued captures before releasing leases or starting the next row", async () => {
        const captureTimeout = new WorkspaceSnapshotStoreError("capture_timeout", "timed out");
        const queued = Array.from({ length: 3 }, () => makeDeferred<{ coverage: { newlyHashedBytes: number } }>());
        const allQueuedStarted = makeDeferred<void>();
        let queuedStarted = 0;
        let representativeState:
            | {
                  captureCount: number;
                  resetCount: number;
                  mutationCount: number;
                  acquired: number[];
                  released: number;
                  cleaned: boolean;
              }
            | undefined;
        const states = new Map<string, NonNullable<typeof representativeState>>();
        const makeFixture = async (entryCount: number, shape: "deep" | "wide", contentCardinality: number) => {
            const root = `${shape}:${contentCardinality}`;
            const state = {
                captureCount: 0,
                resetCount: 0,
                mutationCount: 0,
                acquired: [] as number[],
                released: 0,
                cleaned: false,
            };
            states.set(root, state);
            if (shape === "deep" && contentCardinality === 64) representativeState = state;
            const tracker = {
                capture: async () => {
                    state.captureCount++;
                    if (shape === "deep" && contentCardinality === 64 && state.captureCount === 5) {
                        throw captureTimeout;
                    }
                    if (
                        shape === "deep" &&
                        contentCardinality === 64 &&
                        state.captureCount >= 6 &&
                        state.captureCount <= 8
                    ) {
                        const current = queued[state.captureCount - 6]!;
                        queuedStarted++;
                        if (queuedStarted === queued.length) allQueuedStarted.resolve();
                        return await current.promise;
                    }
                    return { coverage: { newlyHashedBytes: 0 } };
                },
            };
            return {
                root,
                shape,
                workspaceRoot: root,
                directoryCount: 0,
                contentCardinality,
                paths: Array.from({ length: entryCount }, (_, index) => `file-${index}`),
                store: {},
                tracker,
                feed: { record: () => undefined },
                metrics: {
                    fullReconcileCount: 0,
                    enumeratedEntries: 0,
                    workerActive: 0,
                    workerPeak: 0,
                    newlyHashedBytes: 0,
                    hooks: {},
                    reset: () => {
                        state.resetCount++;
                    },
                },
            };
        };
        const run = runAgentRewindSnapshotBenchmark as unknown as (
            options: { entryCounts: number[]; iterations: number },
            onRow: (row: Record<string, unknown>) => void,
            dependencies: Record<string, unknown>
        ) => Promise<Array<Record<string, unknown>>>;
        const pending = run({ entryCounts: [10], iterations: 1 }, () => undefined, {
            makeFixture,
            countLooseObjects: async () => 0,
            mutatePaths: async (workspaceRoot: string) => {
                states.get(workspaceRoot)!.mutationCount++;
            },
            now: () => 1,
            cleanupFixture: async (fixture: { root: string }) => {
                states.get(fixture.root)!.cleaned = true;
            },
            acquireLeases: async (fixture: { root: string; tracker: unknown }, count: number) => {
                const state = states.get(fixture.root)!;
                state.acquired.push(count);
                return Array.from({ length: count }, () => ({
                    tracker: fixture.tracker,
                    release: async () => {
                        state.released++;
                    },
                }));
            },
        });
        await allQueuedStarted.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(representativeState).toMatchObject({
            resetCount: 4,
            mutationCount: 3,
            acquired: [1, 2, 4],
            released: 3,
            cleaned: false,
        });

        const unexpected = new Error("queued capture failed");
        queued[0]!.resolve({ coverage: { newlyHashedBytes: 0 } });
        queued[1]!.reject(unexpected);
        queued[2]!.resolve({ coverage: { newlyHashedBytes: 0 } });
        await expect(pending).rejects.toBe(unexpected);
        expect(representativeState).toMatchObject({
            acquired: [1, 2, 4],
            released: 7,
            cleaned: true,
        });
    });
});

function makeDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}
