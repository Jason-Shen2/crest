// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { WorkspaceSnapshotCoverage, WorkspaceSnapshotRefV1 } from "./types";
import {
    loadWorkspaceTrackerState,
    publishWorkspaceTrackerState,
    type WorkspaceTrackerStateSnapshotVerifier,
} from "./workspace-tracker-state";

const WorkspaceIdentity = "a".repeat(64);
const WorkspaceIncarnation = "b".repeat(64);
const Ref: WorkspaceSnapshotRefV1 = {
    id: "1".repeat(40),
    workspaceIdentity: WorkspaceIdentity,
    workspaceIncarnation: WorkspaceIncarnation,
    tree: "2".repeat(40),
    scopeManifest: "3".repeat(40),
};
const Coverage: WorkspaceSnapshotCoverage = {
    complete: false,
    eligibleEntryCount: 2,
    newlyHashedBytes: 7,
    exclusions: [{ path: "ignored.txt", reason: "ignored" }],
};
const CleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace tracker state", () => {
    test("publishes canonical durable state bound to the committed cursor and reloads an owned snapshot", async () => {
        const fixture = await makeFixture();

        await publishWorkspaceTrackerState({
            storeRoot: fixture.storeRoot,
            workspaceIdentity: WorkspaceIdentity,
            workspaceIncarnation: WorkspaceIncarnation,
            current: Ref,
            coverage: Coverage,
        });

        const cursorHash = createHash("sha256").update(fixture.cursorBytes).digest("hex");
        expect(await readFile(fixture.statePath, "utf8")).toBe(
            `${JSON.stringify({
                coverage: {
                    complete: false,
                    eligibleentrycount: 2,
                    exclusions: [{ path: "ignored.txt", reason: "ignored" }],
                },
                current: {
                    id: Ref.id,
                    scopemanifest: Ref.scopeManifest,
                    tree: Ref.tree,
                    workspaceidentity: WorkspaceIdentity,
                    workspaceincarnation: WorkspaceIncarnation,
                },
                cursorhash: cursorHash,
                schemaversion: 1,
                workspaceidentity: WorkspaceIdentity,
                workspaceincarnation: WorkspaceIncarnation,
            })}\n`
        );
        await expect(loadWorkspaceTrackerState(fixture.loadInput)).resolves.toEqual({
            status: "trusted",
            current: Ref,
            coverage: { complete: false, eligibleEntryCount: 2, exclusions: Coverage.exclusions },
        });
        expect(fixture.verifier.verifyOwnedSnapshot).toHaveBeenCalledWith(Ref);
    });

    test.each([
        ["truncated state", async (fixture: Fixture) => writeFile(fixture.statePath, '{"schemaversion":1')],
        [
            "noncanonical state",
            async (fixture: Fixture) => writeFile(fixture.statePath, JSON.stringify(validWireState())),
        ],
        ["unknown state field", async (fixture: Fixture) => tamperState(fixture, { extra: true })],
        ["wrong identity", async (fixture: Fixture) => tamperState(fixture, { workspaceidentity: "c".repeat(64) })],
        [
            "wrong incarnation",
            async (fixture: Fixture) => tamperState(fixture, { workspaceincarnation: "d".repeat(64) }),
        ],
        [
            "cursor truncation",
            async (fixture: Fixture) => writeFile(fixture.cursorPath, fixture.cursorBytes.subarray(0, 3)),
        ],
        ["cursor tampering", async (fixture: Fixture) => writeFile(fixture.cursorPath, Buffer.from("tampered"))],
        ["cursor missing", async (fixture: Fixture) => unlink(fixture.cursorPath)],
    ])("treats %s as untrusted without guessing or repairing it", async (_name, tamper) => {
        const fixture = await makePublishedFixture();
        const before = await readFile(fixture.statePath).catch(() => undefined);
        await tamper(fixture);
        const afterTamper = await readFile(fixture.statePath).catch(() => undefined);

        await expect(loadWorkspaceTrackerState(fixture.loadInput)).resolves.toEqual({ status: "untrusted" });
        expect(await readFile(fixture.statePath).catch(() => undefined)).toEqual(afterTamper ?? before);
    });

    test.each(["owned ref", "manifest", "tree"])("treats a missing or corrupt %s as untrusted", async (part) => {
        const fixture = await makePublishedFixture();
        fixture.verifier.verifyOwnedSnapshot.mockRejectedValueOnce(new Error(`${part} missing`));

        await expect(loadWorkspaceTrackerState(fixture.loadInput)).resolves.toEqual({ status: "untrusted" });
    });

    test("rejects an anchored state publication when the expected destination changes", async () => {
        const fixture = await makePublishedFixture();

        await expect(
            publishWorkspaceTrackerState({
                ...fixture.publishInput,
                testHooks: {
                    afterPublishRead: async () => writeFile(fixture.statePath, "tampered", { mode: 0o600 }),
                },
            })
        ).rejects.toThrow(/destination|changed/i);

        await expect(readFile(fixture.statePath, "utf8")).resolves.toBe("tampered");
    });

    test("rejects when the committed cursor changes after anchored state publication", async () => {
        const fixture = await makeFixture();

        await expect(
            publishWorkspaceTrackerState({
                ...fixture.publishInput,
                testHooks: {
                    afterStateWrite: async () => writeFile(fixture.cursorPath, "cursor-v2\n", { mode: 0o600 }),
                },
            })
        ).rejects.toThrow(/cursor.*changed/i);
    });

    test("treats a tracker directory replacement between cursor and state reads as untrusted", async () => {
        const fixture = await makePublishedFixture();
        const held = join(fixture.root, "held-tracker");
        const replacement = join(fixture.root, "replacement-tracker");

        await expect(
            loadWorkspaceTrackerState({
                ...fixture.loadInput,
                testHooks: {
                    afterCursorRead: async () => {
                        await rename(fixture.trackerRoot, held);
                        await mkdir(replacement, { mode: 0o700 });
                        await copyFile(join(held, "committed.cursor"), join(replacement, "committed.cursor"));
                        await copyFile(join(held, "state-v1.json"), join(replacement, "state-v1.json"));
                        await rename(replacement, fixture.trackerRoot);
                    },
                },
            })
        ).resolves.toEqual({ status: "untrusted" });
    });

    test("treats a symlinked or oversized state entry as untrusted", async () => {
        const symlinked = await makePublishedFixture();
        const heldState = join(symlinked.trackerRoot, "held-state.json");
        await rename(symlinked.statePath, heldState);
        await symlink(heldState, symlinked.statePath);
        await expect(loadWorkspaceTrackerState(symlinked.loadInput)).resolves.toEqual({ status: "untrusted" });

        const oversized = await makePublishedFixture();
        await writeFile(oversized.statePath, Buffer.alloc(1024 * 1024 + 1, 0x20), { mode: 0o600 });
        await expect(loadWorkspaceTrackerState(oversized.loadInput)).resolves.toEqual({ status: "untrusted" });
    });

    test("rejects an oversized committed cursor before state publication", async () => {
        const fixture = await makeFixture();
        await writeFile(fixture.cursorPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x63), { mode: 0o600 });

        await expect(publishWorkspaceTrackerState(fixture.publishInput)).rejects.toThrow(/cursor|maximum|output/i);
    });
});

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

async function makePublishedFixture(): Promise<Fixture> {
    const fixture = await makeFixture();
    await publishWorkspaceTrackerState(fixture.publishInput);
    return fixture;
}

async function makeFixture() {
    const root = await mkdtemp(join(tmpdir(), "crest-workspace-tracker-state-"));
    CleanupRoots.push(root);
    const storeRoot = join(root, "repo.git");
    const trackerRoot = join(storeRoot, "tracker");
    await mkdir(trackerRoot, { recursive: true, mode: 0o700 });
    const cursorPath = join(trackerRoot, "committed.cursor");
    const cursorBytes = Buffer.from("cursor-v1\n");
    await writeFile(cursorPath, cursorBytes, { mode: 0o600 });
    const verifier = {
        verifyOwnedSnapshot: vi.fn(async () => undefined),
    } satisfies WorkspaceTrackerStateSnapshotVerifier;
    return {
        root,
        storeRoot,
        trackerRoot,
        cursorPath,
        cursorBytes,
        statePath: join(trackerRoot, "state-v1.json"),
        verifier,
        publishInput: {
            storeRoot,
            workspaceIdentity: WorkspaceIdentity,
            workspaceIncarnation: WorkspaceIncarnation,
            current: Ref,
            coverage: Coverage,
        },
        loadInput: {
            storeRoot,
            workspaceIdentity: WorkspaceIdentity,
            workspaceIncarnation: WorkspaceIncarnation,
            verifier,
        },
    };
}

async function tamperState(fixture: Fixture, fields: Record<string, unknown>): Promise<void> {
    const parsed = JSON.parse(await readFile(fixture.statePath, "utf8"));
    await writeFile(fixture.statePath, canonicalJson({ ...parsed, ...fields }));
}

function validWireState(): Record<string, unknown> {
    return {
        schemaversion: 1,
        workspaceidentity: WorkspaceIdentity,
        workspaceincarnation: WorkspaceIncarnation,
        current: {
            id: Ref.id,
            workspaceidentity: WorkspaceIdentity,
            workspaceincarnation: WorkspaceIncarnation,
            tree: Ref.tree,
            scopemanifest: Ref.scopeManifest,
        },
        coverage: {
            complete: false,
            eligibleentrycount: 2,
            exclusions: [{ path: "ignored.txt", reason: "ignored" }],
        },
        cursorhash: createHash("sha256").update("cursor-v1\n").digest("hex"),
    };
}

function canonicalJson(value: unknown): string {
    return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJson);
    if (typeof value !== "object" || value == null) return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, sortJson(item)])
    );
}
