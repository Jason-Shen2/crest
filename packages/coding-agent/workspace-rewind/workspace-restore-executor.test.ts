// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, SessionTreeEntry } from "@crest/agent/harness/types";
import { describe, expect, it, vi } from "vitest";

import { RewindConfirmationRegistry } from "./confirmation-token";
import type { WorkspaceOperationJournalV2 } from "./recovery-journal";
import type { RestorePlanV1, RestoreTargetV1 } from "./restore-plan";
import { WorkspaceControlCustomTypes, type WorkspaceSnapshotRefV1 } from "./types";
import {
    WorkspaceRestoreExecutor,
    workspaceStateFromJournal,
    type WorkspaceRestoreCommitStrategy,
} from "./workspace-restore-executor";

const Identity = "1".repeat(64);
const Incarnation = "2".repeat(64);

function snapshot(id: string): WorkspaceSnapshotRefV1 {
    return {
        id,
        tree: "3".repeat(40),
        scopeManifest: "4".repeat(40),
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
    };
}

const Safety = snapshot("5".repeat(40));
const Result = snapshot("6".repeat(40));
const Workspace = {
    canonicalRoot: "/workspace",
    workspaceIdentity: Identity,
    workspaceIncarnation: Incarnation,
    storeKey: "workspace",
    ancestorIdentityChain: [],
};

function plan(target: RestoreTargetV1, commitParentId = "current-leaf"): RestorePlanV1 {
    return {
        target,
        sessionId: "session-1",
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        semanticLeafId: "current-leaf",
        commitParentId,
        paths: [],
        coverageWarnings: [],
        forceRequired: false,
        hardBlocked: false,
    };
}

function sessionFixture() {
    const metadata: JsonlSessionMetadata = {
        id: "session-1",
        cwd: "/workspace",
        path: "/sessions/session-1.db",
        createdAt: new Date(0).toISOString(),
    };
    const entries: SessionTreeEntry[] = [
        {
            type: "message",
            id: "current-leaf",
            parentId: null,
            timestamp: new Date(0).toISOString(),
            message: { role: "user", content: "keep visible", timestamp: 0 },
        } as SessionTreeEntry,
    ];
    let leafId: string | null = "current-leaf";
    const session = {
        getMetadata: vi.fn(async () => metadata),
        getEntries: vi.fn(async () => [...entries]),
        getLeafId: vi.fn(async () => leafId),
        getEntry: vi.fn(async (id: string) => entries.find((entry) => entry.id === id)),
        getStorage: vi.fn(() => ({ createEntryId: vi.fn(async () => "operation-leaf") })),
        appendEntries: vi.fn(async (next: SessionTreeEntry[], options: { expectedLeafId: string | null }) => {
            expect(options.expectedLeafId).toBe(leafId);
            entries.push(...next);
            leafId = next.at(-1)!.id;
        }),
    };
    return { session: session as never, entries };
}

function harness() {
    const durableOrder: string[] = [];
    let record: WorkspaceOperationJournalV2;
    let captures = 0;
    const store = {
        identity: Workspace,
        withWorkspaceLock: vi.fn(async (operation: () => Promise<unknown>) => {
            durableOrder.push("lock");
            return operation();
        }),
        capture: vi.fn(async () => {
            captures++;
            durableOrder.push(captures === 1 ? "safety" : "result");
            return { ref: captures === 1 ? Safety : Result, coverage: {} };
        }),
        readPathState: vi.fn(),
        readBlob: vi.fn(),
        anchorSnapshot: vi.fn(async () => durableOrder.push("anchor")),
    };
    const journal = {
        beginUnlocked: vi.fn(async (next: WorkspaceOperationJournalV2) => {
            record = structuredClone(next);
            durableOrder.push("prepared");
        }),
        transitionUnlocked: vi.fn(async (_id: string, phase: WorkspaceOperationJournalV2["phase"], patch = {}) => {
            record = { ...record, ...patch, phase };
            durableOrder.push(phase);
            return structuredClone(record);
        }),
        updatePathProgressUnlocked: vi.fn(async () => structuredClone(record)),
        read: vi.fn(async () => structuredClone(record)),
        completeCleanupUnlocked: vi.fn(async () => durableOrder.push("cleanup")),
    };
    const recovery = {
        recoverRecord: vi.fn(),
        isExactOperationLeaf: vi.fn(async (_session, candidate: WorkspaceOperationJournalV2, leaf: string | null) => {
            return candidate.workspaceStateEntryId === leaf;
        }),
    };
    const applyPath = vi.fn();
    const verifyPath = vi.fn();
    const onCommitted = vi.fn(async () => {});
    const executor = new WorkspaceRestoreExecutor({
        store: store as never,
        journal: journal as never,
        recovery: recovery as never,
        inspectLivePaths: vi.fn(async () => new Map()),
        applyPath,
        verifyPath,
        createOperationId: () => "operation-1",
        now: () => new Date(1),
        onCommitted,
    });
    return {
        executor,
        store,
        journal,
        recovery,
        applyPath,
        verifyPath,
        onCommitted,
        durableOrder,
        record: () => record!,
    };
}

function strategy(): WorkspaceRestoreCommitStrategy {
    return {
        makeWorkspaceState: workspaceStateFromJournal,
        makeResult: ({ folded, sessionMetadata }) => ({
            sessionMetadata,
            semanticLeafId: folded.semanticLeafId,
            displayLeafId: folded.displayLeafId,
        }),
    };
}

describe("WorkspaceRestoreExecutor", () => {
    it.each([
        { kind: "rewind", targetTurnId: "turn-1" },
        { kind: "redo" },
        { kind: "turn-undo", sourceTurnId: "turn-1" },
        { kind: "turn-redo", sourceTurnId: "turn-1", undoOperationId: "undo-operation-1" },
    ] satisfies RestoreTargetV1[])("executes the shared durable transaction for $kind", async (target) => {
        const value = harness();
        const session = sessionFixture();
        const restorePlan = plan(target);
        const confirmations = new RewindConfirmationRegistry();
        const confirmation = confirmations.take(confirmations.issue(restorePlan));

        const result = await value.executor.execute({
            session: session.session,
            workspace: Workspace,
            plan: restorePlan,
            confirmation,
            mode: "normal",
            commit: strategy(),
        });

        expect(value.store.withWorkspaceLock).toHaveBeenCalledOnce();
        expect(value.durableOrder).toEqual([
            "lock",
            "safety",
            "prepared",
            "applying_files",
            "result",
            "files_verified",
            "anchor",
            "anchor",
            "committing_session",
            "completed",
            "cleanup",
        ]);
        expect(value.applyPath).not.toHaveBeenCalled();
        expect(value.verifyPath).not.toHaveBeenCalled();
        expect(value.onCommitted).toHaveBeenCalledWith("session-1", "operation-1");
        expect(value.record()).toMatchObject({ target, commitParentId: "current-leaf" });
        expect(value.record()).not.toHaveProperty("kind");
        expect(value.record()).not.toHaveProperty("targetTurnId");
        expect(value.record()).not.toHaveProperty("targetBoundaryId");
        const marker = session.entries.at(-1) as Extract<SessionTreeEntry, { type: "custom" }>;
        expect(marker).toMatchObject({
            id: "operation-leaf",
            parentId: "current-leaf",
            customType: WorkspaceControlCustomTypes.state,
            data: workspaceStateFromJournal(value.record()),
        });
        expect(result).toMatchObject({ semanticLeafId: "operation-leaf", displayLeafId: "current-leaf" });
    });

    it("constructs exact turn marker provenance from the journal target", () => {
        const record = {
            schemaVersion: 2,
            phase: "completed",
            workspaceIdentity: Identity,
            workspaceIncarnation: Incarnation,
            sessionId: "session-1",
            sessionPath: "/sessions/session-1.db",
            operationId: "operation-1",
            target: { kind: "turn-redo", sourceTurnId: "turn-7", undoOperationId: "undo-7" },
            commitParentId: "current-leaf",
            applyMode: "normal",
            expectedSemanticLeafId: "current-leaf",
            safetySnapshot: Safety,
            confirmedConflictFingerprints: [],
            paths: [],
            workspaceStateEntryId: "operation-leaf",
            resultSnapshot: Result,
        } satisfies WorkspaceOperationJournalV2;

        expect(workspaceStateFromJournal(record)).toMatchObject({
            kind: "turn-redo",
            sourceTurnId: "turn-7",
            undoOperationId: "undo-7",
        });
    });
});
