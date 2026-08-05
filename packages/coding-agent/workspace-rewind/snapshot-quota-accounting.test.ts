// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
    resetSnapshotQuotaAccountingRegistryForTest,
    SnapshotQuotaAccounting,
    SnapshotQuotaExceededError,
} from "./snapshot-quota-accounting";

const CleanupRoots: string[] = [];
const GenerationA = "a".repeat(64);
const GenerationB = "b".repeat(64);

afterEach(async () => {
    resetSnapshotQuotaAccountingRegistryForTest();
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("snapshot quota accounting", () => {
    test("durably reserves content and metadata against the cached hard limit", async () => {
        const fixture = await makeFixture();
        const accounting = await openAccounting(fixture, { maxBytes: 5_000 });

        const first = await accounting.reserve({ contentBytes: 4_000, metadataBytes: 512 });
        await expect(accounting.reserve({ contentBytes: 1_000, metadataBytes: 512 })).rejects.toBeInstanceOf(
            SnapshotQuotaExceededError
        );

        expect(accounting.measuredBytes).toBe(4_512);
        expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toEqual({
            generation: GenerationA,
            measuredat: expect.any(String),
            measuredbytes: 4_512,
            schemaversion: 1,
        });
        await first.release();
    });

    test("serializes simultaneous reservations and supports idempotent commit and release", async () => {
        const fixture = await makeFixture();
        const accounting = await openAccounting(fixture, { maxBytes: 1_000 });

        const [first, second] = await Promise.allSettled([
            accounting.reserve({ contentBytes: 700, metadataBytes: 0 }),
            accounting.reserve({ contentBytes: 700, metadataBytes: 0 }),
        ]);

        expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
        const reservation =
            first.status === "fulfilled" ? first.value : (second as PromiseFulfilledResult<never>).value;
        await reservation.commit({ actualNewLooseBytes: 125 });
        await reservation.commit({ actualNewLooseBytes: 125 });
        await reservation.release();
        expect(accounting.measuredBytes).toBe(125);

        const released = await accounting.reserve({ contentBytes: 500, metadataBytes: 100 });
        await released.release();
        await released.release();
        expect(accounting.measuredBytes).toBe(125);
    });

    test("preserves active reservations across exact reconciliation and settles them exactly", async () => {
        const fixture = await makeFixture();
        const accounting = await openAccounting(fixture, { exactBytes: 200, maxBytes: 1_000 });
        const first = await accounting.reserve({ contentBytes: 400, metadataBytes: 0 });
        const second = await accounting.reserve({ contentBytes: 400, metadataBytes: 0 });

        await accounting.reconcileExactUsage();

        expect(accounting.measuredBytes).toBe(1_000);
        await expect(accounting.reserve({ contentBytes: 700, metadataBytes: 0 })).rejects.toMatchObject({
            code: "quota_exceeded",
        });

        fixture.exactBytes = 300;
        await first.commit({ actualNewLooseBytes: 100 });
        expect(accounting.measuredBytes).toBe(700);
        await second.release();
        expect(accounting.measuredBytes).toBe(300);
    });

    test("reuses one accounting instance for the same store and generation", async () => {
        const fixture = await makeFixture();
        const first = await openAccounting(fixture);
        const second = await openAccounting(fixture);

        expect(second).toBe(first);
        const reservation = await first.reserve({ contentBytes: 600, metadataBytes: 0 });
        await expect(second.reserve({ contentBytes: 500, metadataBytes: 0 })).rejects.toMatchObject({
            code: "quota_exceeded",
        });
        await reservation.release();
    });

    test("forces exact reconciliation after a crash leaves a durable reservation", async () => {
        const fixture = await makeFixture();
        const first = await openAccounting(fixture, { exactBytes: 100 });
        await first.reserve({ contentBytes: 700, metadataBytes: 0 });
        expect(first.measuredBytes).toBe(800);
        resetSnapshotQuotaAccountingRegistryForTest();
        fixture.exactBytes = 240;

        const restarted = await openAccounting(fixture, { generation: GenerationB });

        expect(fixture.exactScans).toBe(2);
        expect(restarted.measuredBytes).toBe(240);
        expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
            generation: GenerationB,
            measuredbytes: 240,
        });
    });

    test.each([
        ["corrupt", Buffer.from("{broken")],
        ["truncated", Buffer.from('{"generation":"a"')],
        [
            "invalid measured time",
            Buffer.from(
                `{"generation":"${GenerationA}","measuredat":"not-a-date","measuredbytes":1,"schemaversion":1}\n`
            ),
        ],
        [
            "noncanonical",
            Buffer.from(
                '{"schemaversion":1,"measuredbytes":1,"measuredat":"2026-01-01T00:00:00.000Z","generation":"' +
                    GenerationA +
                    '","extra":true}\n'
            ),
        ],
        ["logically oversized", Buffer.alloc(8 * 1024, 0x20)],
    ])("reconciles exact usage for %s cached state", async (_name, bytes) => {
        const fixture = await makeFixture();
        await openAccounting(fixture, { exactBytes: 10 });
        resetSnapshotQuotaAccountingRegistryForTest();
        await writeFile(fixture.statePath, bytes, { mode: 0o600 });
        fixture.exactBytes = 321;

        const accounting = await openAccounting(fixture);

        expect(accounting.measuredBytes).toBe(321);
        expect(fixture.exactScans).toBe(2);
        expect((await readFile(fixture.statePath)).length).toBeLessThan(1024);
    });

    test("does not publish a guessed state when exact reconciliation fails", async () => {
        const fixture = await makeFixture();
        fixture.scanFailure = new Error("exact scan failed");

        await expect(openAccounting(fixture)).rejects.toThrow("exact scan failed");
        await expect(readFile(fixture.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("reconciles before retrying after an ambiguous state publication failure", async () => {
        const fixture = await makeFixture();
        const accounting = await openAccounting(fixture, {
            hooks: {
                afterStateWrite: (() => {
                    let calls = 0;
                    return () => {
                        calls++;
                        if (calls === 3) throw new Error("lost quota publication acknowledgement");
                    };
                })(),
            },
        });
        const reservation = await accounting.reserve({ contentBytes: 100, metadataBytes: 0 });
        fixture.exactBytes = 25;

        await expect(reservation.commit({ actualNewLooseBytes: 25 })).rejects.toThrow(/acknowledgement/i);
        const retry = await accounting.reserve({ contentBytes: 50, metadataBytes: 0 });

        expect(fixture.exactScans).toBe(2);
        expect(accounting.measuredBytes).toBe(75);
        await retry.release();
    });

    test("fails closed when the anchored tracker root is swapped before a reservation", async () => {
        const fixture = await makeFixture();
        const heldTracker = join(fixture.root, "held-tracker");
        const replacement = join(fixture.root, "replacement-tracker");
        let writes = 0;
        const accounting = await openAccounting(fixture, {
            hooks: {
                beforeStateWrite: async () => {
                    writes++;
                    if (writes !== 2) return;
                    await mkdir(replacement, { mode: 0o700 });
                    await rename(fixture.trackerRoot, heldTracker);
                    await rename(replacement, fixture.trackerRoot);
                },
            },
        });

        await expect(accounting.reserve({ contentBytes: 1, metadataBytes: 0 })).rejects.toThrow(/anchor|changed/i);
    });

    test("fails closed for a symlinked tracker directory", async () => {
        const fixture = await makeFixture();
        const external = join(fixture.root, "external");
        await mkdir(external, { mode: 0o700 });
        await rm(fixture.trackerRoot, { recursive: true, force: true });
        await symlink(external, fixture.trackerRoot);
        resetSnapshotQuotaAccountingRegistryForTest();
        await expect(openAccounting(fixture)).rejects.toThrow(/unsafe|directory/i);
    });

    test("reconciles exact usage without reading a hard-oversized cached state", async () => {
        const fixture = await makeFixture();
        await mkdir(fixture.trackerRoot, { mode: 0o700 });
        await writeFile(fixture.statePath, Buffer.alloc(2 * 1024 * 1024), { mode: 0o600 });
        fixture.exactBytes = 321;

        const accounting = await openAccounting(fixture);

        expect(accounting.measuredBytes).toBe(321);
        expect(fixture.exactScans).toBe(1);
        expect((await readFile(fixture.statePath)).length).toBeLessThan(1024);
    });
});

interface Fixture {
    root: string;
    storeRoot: string;
    trackerRoot: string;
    statePath: string;
    exactBytes: number;
    exactScans: number;
    scanFailure?: Error;
}

async function makeFixture(): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "crest-snapshot-quota-"));
    CleanupRoots.push(root);
    const storeRoot = join(root, "repo.git");
    await mkdir(storeRoot, { mode: 0o700 });
    await chmod(storeRoot, 0o700);
    return {
        root,
        storeRoot,
        trackerRoot: join(storeRoot, "tracker"),
        statePath: join(storeRoot, "tracker", "quota-v1.json"),
        exactBytes: 0,
        exactScans: 0,
    };
}

function openAccounting(
    fixture: Fixture,
    options: {
        maxBytes?: number;
        exactBytes?: number;
        generation?: string;
        hooks?: Parameters<typeof SnapshotQuotaAccounting.open>[0]["testHooks"];
    } = {}
): Promise<SnapshotQuotaAccounting> {
    if (options.exactBytes != null) fixture.exactBytes = options.exactBytes;
    return SnapshotQuotaAccounting.open({
        storeRoot: fixture.storeRoot,
        maxBytes: options.maxBytes ?? 1_000,
        generation: options.generation ?? GenerationA,
        measureExactUsage: async () => {
            fixture.exactScans++;
            if (fixture.scanFailure) throw fixture.scanFailure;
            return fixture.exactBytes;
        },
        testHooks: options.hooks,
    });
}
