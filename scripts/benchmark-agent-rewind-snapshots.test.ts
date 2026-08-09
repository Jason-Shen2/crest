// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
    type BenchmarkRow,
    type BenchmarkScenario,
    cleanupBenchmarkFixture,
    profileAgentRewindColdBaseline,
    runAgentRewindSnapshotBenchmark,
    runAgentRewindSnapshotFixture,
} from "./benchmark-agent-rewind-snapshots";

const ExpectedScenarios: BenchmarkScenario[] = [
    "cold",
    "no-tool-fresh",
    "warm-no-change",
    "dirty-paths",
    "session-contention",
    "overlap",
    "restore",
];

function row(scenario: BenchmarkScenario, overrides: Partial<BenchmarkRow> = {}): BenchmarkRow {
    return {
        scenario,
        shape: "wide",
        outcome: "pass",
        entryCount: 10,
        dirtyPathCount: 0,
        sessionCount: 1,
        iterations: 1,
        candidateCount: 0,
        bytesRead: 0,
        commitsTraversed: 0,
        fallbackCount: 0,
        p50Ms: 1,
        p95Ms: 1,
        ...overrides,
    };
}

describe("agent rewind V3 production benchmark contract", () => {
    test("emits the required production matrix and V3 measurements", async () => {
        const rows = await runAgentRewindSnapshotBenchmark({ entryCounts: [10], iterations: 2 }, () => undefined, {
            makeFixture: async (_entryCount, shape) => ({ root: shape, shape }),
            measureFixture: async (fixture) => [
                row("cold", { shape: fixture.shape, iterations: 2 }),
                row("no-tool-fresh", { shape: fixture.shape, iterations: 2 }),
                row("warm-no-change", { shape: fixture.shape, iterations: 2 }),
                ...([1, 10, 100] as const).map((dirtyPathCount) =>
                    row("dirty-paths", { shape: fixture.shape, dirtyPathCount, iterations: 2 })
                ),
                ...([1, 2, 4] as const).map((sessionCount) =>
                    row("session-contention", { shape: fixture.shape, sessionCount, iterations: 2 })
                ),
                row("overlap", { shape: fixture.shape, dirtyPathCount: 1, sessionCount: 2, iterations: 2 }),
                row("restore", { shape: fixture.shape, dirtyPathCount: 1, iterations: 2 }),
            ],
            cleanupFixture: async () => undefined,
        });

        expect(rows).toHaveLength(22);
        for (const shape of ["deep", "wide"] as const) {
            const shapeRows = rows.filter((item) => item.shape === shape);
            expect(new Set(shapeRows.map((item) => item.scenario))).toEqual(new Set(ExpectedScenarios));
            expect(
                shapeRows.filter((item) => item.scenario === "dirty-paths").map((item) => item.dirtyPathCount)
            ).toEqual([1, 10, 100]);
            expect(
                shapeRows.filter((item) => item.scenario === "session-contention").map((item) => item.sessionCount)
            ).toEqual([1, 2, 4]);
        }
        expect(
            rows.every(
                (item) =>
                    Number.isSafeInteger(item.candidateCount) &&
                    Number.isSafeInteger(item.bytesRead) &&
                    Number.isSafeInteger(item.commitsTraversed) &&
                    Number.isSafeInteger(item.fallbackCount)
            )
        ).toBe(true);
    });

    test("records unavailable work without fabricating zero latency", async () => {
        const unavailable = row("warm-no-change", {
            outcome: "timeout",
            p50Ms: null,
            p95Ms: null,
            reason: "terminal capture timed out",
        });
        const rows = await runAgentRewindSnapshotBenchmark({ entryCounts: [10], iterations: 1 }, () => undefined, {
            makeFixture: async (_entryCount, shape) => ({ root: shape, shape }),
            measureFixture: async (fixture) => [{ ...unavailable, shape: fixture.shape }],
            cleanupFixture: async () => undefined,
        });

        expect(rows).toHaveLength(2);
        expect(rows.every((item) => item.outcome === "timeout")).toBe(true);
        expect(rows.every((item) => item.p50Ms === null && item.p95Ms === null)).toBe(true);
        expect(rows.every((item) => item.reason === "terminal capture timed out")).toBe(true);
    });

    test("runs the complete matrix against one shared V3 authority", async () => {
        const rows = await runAgentRewindSnapshotFixture(12, "wide", 1, "smoke");

        expect(rows).toHaveLength(7);
        expect(
            rows.every((item) => item.outcome === "pass" || item.outcome === "fallback"),
            JSON.stringify(rows)
        ).toBe(true);
        expect(rows.filter((item) => item.scenario === "cold").every((item) => item.fallbackCount === 0)).toBe(true);
        expect(rows.filter((item) => item.scenario === "cold").every((item) => item.outcome === "pass")).toBe(true);
        expect(rows.filter((item) => item.scenario === "cold").every((item) => item.bytesRead > 0)).toBe(true);
        expect(
            rows
                .filter((item) => item.scenario === "dirty-paths")
                .every((item) => item.candidateCount > 0 && item.bytesRead > 0)
        ).toBe(true);
        expect(
            rows.filter((item) => item.scenario === "session-contention").every((item) => item.fallbackCount === 0)
        ).toBe(true);
        expect(rows.filter((item) => item.scenario === "overlap").every((item) => item.commitsTraversed > 0)).toBe(
            true
        );
    }, 60_000);

    test("profiles cold fixture and authority stages without changing production limits", async () => {
        const profile = await profileAgentRewindColdBaseline(12, "wide");

        expect(profile).toMatchObject({
            entryCount: 12,
            shape: "wide",
            outcome: "pass",
            fixture: {
                createEntriesMs: expect.any(Number),
                initializeGitMs: expect.any(Number),
            },
            authority: {
                registryInitializeMs: expect.any(Number),
                captureTotalMs: expect.any(Number),
                discoverScopeMs: expect.any(Number),
                stableReaderAndHashMs: expect.any(Number),
                treeMaterializeMs: expect.any(Number),
            },
        });
        expect(profile.authority.captureTotalMs).toBeLessThanOrEqual(30_000 + 1_000);
    }, 30_000);

    test("reports observer failures only after fixture cleanup", async () => {
        const observerFailure = new Error("row observer failed");
        const events: string[] = [];

        await expect(
            runAgentRewindSnapshotBenchmark(
                { entryCounts: [10], iterations: 1 },
                () => {
                    events.push("observe");
                    throw observerFailure;
                },
                {
                    makeFixture: async (_entryCount, shape) => ({ root: shape, shape }),
                    measureFixture: async (fixture) => [row("cold", { shape: fixture.shape })],
                    cleanupFixture: async () => {
                        events.push("cleanup");
                    },
                }
            )
        ).rejects.toBe(observerFailure);
        expect(events).toEqual(["observe", "cleanup"]);
    });

    test("removes fixture roots even when keeper release fails", async () => {
        const releaseFailure = new Error("keeper release failed");
        let removed = 0;
        await expect(
            cleanupBenchmarkFixture(
                {
                    root: "/fixture",
                    keeperLease: { release: async () => Promise.reject(releaseFailure) },
                },
                async () => {
                    removed++;
                }
            )
        ).rejects.toBe(releaseFailure);
        expect(removed).toBe(1);
    });
});
