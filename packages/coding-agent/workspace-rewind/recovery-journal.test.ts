// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { encodeDurableJson } from "./durability";
import {
    WorkspaceRecoveryJournal,
    decodeWorkspaceOperationJournalV1,
    type WorkspaceOperationJournalV1,
} from "./recovery-journal";
import type { WorkspaceSnapshotRefV1 } from "./types";

const Identity = "1".repeat(64);
const Incarnation = "2".repeat(64);
const Oid = "3".repeat(40);

function snapshot(id = Oid): WorkspaceSnapshotRefV1 {
    return {
        id,
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        tree: "4".repeat(40),
        scopeManifest: "5".repeat(40),
    };
}

function operation(phase: WorkspaceOperationJournalV1["phase"] = "prepared"): WorkspaceOperationJournalV1 {
    return {
        schemaVersion: 1,
        phase,
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        sessionId: "session-1",
        sessionPath: "/diagnostic/session.sqlite",
        operationId: "operation-1",
        target: { kind: "rewind", targetTurnId: "target-turn" },
        applyMode: "normal",
        expectedSemanticLeafId: "leaf-before",
        commitParentId: "target-boundary",
        safetySnapshot: snapshot(),
        confirmedConflictFingerprints: [],
        paths: [
            {
                path: "src/file.ts",
                preState: { state: "file", oid: "6".repeat(40), executable: false },
                target: { state: "file", oid: "7".repeat(40), executable: false },
                expectedCurrent: { state: "file", oid: "6".repeat(40), executable: false },
                confirmedLiveFingerprint: "8".repeat(64),
                createdParentDirectories: [],
            },
        ],
        workspaceStateEntryId: "state-entry",
    };
}

async function fixture() {
    const storeRoot = await mkdtemp(join(tmpdir(), "crest-recovery-journal-"));
    await mkdir(join(storeRoot, "journal"), { recursive: true });
    const order: string[] = [];
    let owners: import("./pending-boundary-store").WorkspaceOperationOwnerV1[] = [];
    const store = {
        storeRoot,
        identity: {
            workspaceIdentity: Identity,
            workspaceIncarnation: Incarnation,
        },
        anchorOperation: vi.fn(async (owner: import("./pending-boundary-store").WorkspaceOperationOwnerV1) => {
            order.push("operation-ref");
            owners = [owner];
        }),
        deleteCrestRef: vi.fn(async () => {
            order.push("operation-ref-remove");
            owners = [];
        }),
        scanOperationOwners: vi.fn(async () => owners),
    };
    const journal = new WorkspaceRecoveryJournal(store, {
        onDurableBoundary: async (boundary) => {
            order.push(boundary);
        },
    });
    return { storeRoot, store, journal, order };
}

describe("workspace recovery journal", () => {
    it("durably anchors the operation before publishing prepared and advances phases monotonically", async () => {
        const { journal, order } = await fixture();

        await journal.begin(operation());
        await journal.transition("operation-1", "applying_files");
        await journal.transition("operation-1", "files_verified", { resultSnapshot: snapshot("9".repeat(40)) });
        await journal.transition("operation-1", "committing_session");
        await journal.transition("operation-1", "completed");

        expect(order).toEqual([
            "operation-ref",
            "before-prepared",
            "after-prepared",
            "before-applying_files",
            "after-applying_files",
            "before-files_verified",
            "after-files_verified",
            "before-committing_session",
            "after-committing_session",
            "before-completed",
            "after-completed",
        ]);
        expect((await journal.read("operation-1")).phase).toBe("completed");
        await expect(journal.transition("operation-1", "applying_files")).rejects.toThrow(/transition/i);
    });

    it("validates exact schema, identity, states, paths, and canonical JSON", async () => {
        expect(decodeWorkspaceOperationJournalV1(operation())).toEqual(operation());
        expect(
            decodeWorkspaceOperationJournalV1({
                ...operation(),
                kind: "rewind",
            })
        ).toBeUndefined();
        expect(
            decodeWorkspaceOperationJournalV1({
                ...operation(),
                target: { kind: "turn-redo", sourceTurnId: "turn-1" },
            })
        ).toBeUndefined();
        expect(
            decodeWorkspaceOperationJournalV1({
                ...operation(),
                target: { kind: "redo" },
                applyMode: "force-drift",
            })
        ).toBeUndefined();
        expect(decodeWorkspaceOperationJournalV1({ ...operation(), extra: true })).toBeUndefined();
        expect(
            decodeWorkspaceOperationJournalV1({
                ...operation(),
                paths: [{ ...operation().paths[0], path: "../outside" }],
            })
        ).toBeUndefined();
        expect(
            decodeWorkspaceOperationJournalV1({
                ...operation(),
                safetySnapshot: { ...snapshot(), workspaceIncarnation: "a".repeat(64) },
            })
        ).toBeUndefined();
        expect(
            decodeWorkspaceOperationJournalV1({
                ...operation(),
                paths: [
                    {
                        ...operation().paths[0],
                        target: operation().paths[0]!.preState,
                    },
                ],
            })
        ).toBeUndefined();
        expect(
            decodeWorkspaceOperationJournalV1({
                ...operation("files_verified"),
            })
        ).toBeUndefined();
    });

    it("reports corrupt and truncated records without deleting them", async () => {
        const { journal } = await fixture();
        await journal.begin(operation());
        await writeFile(journal.path("operation-1"), '{"phase":');

        const scanned = await journal.scan();

        expect(scanned).toHaveLength(1);
        expect(scanned[0]).toMatchObject({ operationId: "operation-1", corrupt: true });
        await expect(readFile(journal.path("operation-1"), "utf8")).resolves.toBe('{"phase":');
    });

    it("maps an invalid journal filename to a strict quarantine token", async () => {
        const { journal } = await fixture();
        await mkdir(journal.root, { recursive: true, mode: 0o700 });
        await writeFile(join(journal.root, "bad name"), "{corrupt", { mode: 0o600 });
        const [scanned] = await journal.scan();

        expect(scanned).toMatchObject({ corrupt: true });
        expect(scanned!.operationId).toMatch(/^corrupt-[0-9a-f]{40}$/);
        await journal.resolveToAudit(scanned!.operationId, "quarantine-corrupt");

        await expect(readdir(journal.root)).resolves.toEqual([]);
    });

    it("recovers a complete atomic temp publication and quarantines an invalid one", async () => {
        const { journal } = await fixture();
        await mkdir(journal.root, { recursive: true, mode: 0o700 });
        await writeFile(join(journal.root, `.${"a".repeat(32)}.tmp`), encodeDurableJson(operation()), {
            mode: 0o600,
        });

        await expect(journal.scan()).resolves.toEqual([
            expect.objectContaining({ operationId: "operation-1", corrupt: false }),
        ]);
        await expect(journal.read("operation-1")).resolves.toEqual(operation());

        await writeFile(join(journal.root, `.${"b".repeat(32)}.tmp`), "{truncated", { mode: 0o600 });
        const corrupt = (await journal.scan()).find((entry) => entry.corrupt);
        expect(corrupt?.operationId).toMatch(/^corrupt-[0-9a-f]{40}$/);
        await journal.resolveToAudit(corrupt!.operationId, "quarantine-corrupt", 1_000);

        await expect(readdir(journal.root)).resolves.toEqual(["operation-1.json"]);
        await expect(readdir(journal.resolvedRoot)).resolves.toContain(
            `${corrupt!.operationId}-1000-quarantine-corrupt.json`
        );
    });

    it("fails closed when journal entry or byte limits are exceeded", async () => {
        const { journal } = await fixture();
        await mkdir(journal.root, { recursive: true, mode: 0o700 });
        for (let index = 0; index <= 4_096; index++) {
            await writeFile(join(journal.root, `operation-${index}.json`), "{}", { mode: 0o600 });
        }

        await expect(journal.scan()).rejects.toThrow(/limit/i);
    }, 30_000);

    it("does not follow a replacement restore-journal directory", async () => {
        const { journal, storeRoot } = await fixture();
        await journal.begin(operation());
        const outside = await mkdtemp(join(tmpdir(), "crest-recovery-journal-outside-"));
        await rename(journal.root, `${journal.root}-held`);
        await symlink(outside, journal.root);
        await writeFile(join(outside, "operation-1.json"), encodeDurableJson(operation()), { mode: 0o600 });

        await expect(journal.scan()).rejects.toThrow(/unsafe|changed|directory/i);
        await expect(readFile(join(outside, "operation-1.json"), "utf8")).resolves.toBe(
            encodeDurableJson(operation()).toString("utf8")
        );
        expect(storeRoot).toBeTruthy();
    });

    it("reconciles operation owners on both sides of journal publication", async () => {
        const { journal, store } = await fixture();
        await journal.begin(operation());
        store.anchorOperation.mockClear();
        store.scanOperationOwners.mockResolvedValueOnce([]);

        await journal.reconcileOwnership();

        expect(store.anchorOperation).toHaveBeenCalledWith(
            expect.objectContaining({ operationId: "operation-1", snapshot: snapshot() })
        );

        await journal.completeCleanup("operation-1");
        store.deleteCrestRef.mockClear();
        store.scanOperationOwners.mockResolvedValueOnce([
            {
                operationId: "operation-1",
                sessionId: "session-1",
                workspaceIdentity: Identity,
                workspaceIncarnation: Incarnation,
                snapshot: snapshot(),
            },
        ]);

        await journal.reconcileOwnership();

        expect(store.deleteCrestRef).toHaveBeenCalledWith("refs/crest/ops/operation-1");
    });

    it("removes the journal before its operation ref and archives resolutions for 30 days", async () => {
        const { journal, order, storeRoot } = await fixture();
        await journal.begin(operation());

        await journal.completeCleanup("operation-1");

        expect(order.slice(-5)).toEqual([
            "before-journal-remove",
            "after-journal-remove",
            "operation-ref-remove",
            "after-operation-ref-remove",
            "after-operation-owner-remove",
        ]);
        await expect(journal.read("operation-1")).rejects.toThrow(/not found/i);

        await journal.begin({ ...operation(), operationId: "operation-2" });
        await journal.resolveToAudit("operation-2", "abandon-current", 1_000);
        const audit = await readFile(
            join(storeRoot, "journal", "resolved", "operation-2-1000-abandon-current.json"),
            "utf8"
        );
        expect(JSON.parse(audit)).toMatchObject({ operationId: "operation-2", resolution: "abandon-current" });

        await journal.pruneResolvedAudit(1_000 + 30 * 24 * 60 * 60 * 1_000 - 1);
        await expect(
            readFile(join(storeRoot, "journal", "resolved", "operation-2-1000-abandon-current.json"), "utf8")
        ).resolves.toBe(audit);
        await journal.pruneResolvedAudit(1_000 + 30 * 24 * 60 * 60 * 1_000);
        await expect(
            readFile(join(storeRoot, "journal", "resolved", "operation-2-1000-abandon-current.json"), "utf8")
        ).rejects.toMatchObject({ code: "ENOENT" });
    });
});
