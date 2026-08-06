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
});
