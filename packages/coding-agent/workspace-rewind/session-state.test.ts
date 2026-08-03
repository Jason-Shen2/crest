// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makeCommittedContextTransaction } from "@crest/agent/harness/session/context-transaction-fixture";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import {
    buildAgentRewindSessionStateView,
    decodeWorkspaceCheckpointEntry,
    decodeWorkspaceStateEntry,
    foldWorkspaceSessionState,
    isWorkspaceControlEntry,
} from "./session-state";
import { WorkspaceControlCustomTypes } from "./types";

const OidA = "a".repeat(40);
const OidB = "b".repeat(40);
const OidC = "c".repeat(40);

function message(id: string, parentId: string | null, role: "user" | "assistant", text: string = id): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: `t-${id}`,
        message: { role, content: [{ type: "text", text }] },
    } as unknown as SessionTreeEntry;
}

function custom(id: string, parentId: string | null, customType: string, data: unknown): SessionTreeEntry {
    return {
        type: "custom",
        id,
        parentId,
        timestamp: `t-${id}`,
        customType,
        data,
    };
}

function leaf(id: string, parentId: string | null, targetId: string | null): SessionTreeEntry {
    return { type: "leaf", id, parentId, timestamp: `t-${id}`, targetId };
}

function snapshot(id: string) {
    return {
        id,
        workspaceIdentity: "workspace-1",
        workspaceIncarnation: "incarnation-1",
        tree: OidA,
        scopeManifest: OidB,
    };
}

function checkpoint(turnId: string, status: "available" | "unavailable" = "available") {
    const common = {
        schemaVersion: 1,
        originSessionId: "session-1",
        turnId,
        workspaceIdentity: "workspace-1",
    };
    if (status === "unavailable") {
        return {
            ...common,
            status,
            reasonCode: "capture_timeout",
            message: "timeout",
        };
    }
    return {
        ...common,
        status,
        workspaceIncarnation: "incarnation-1",
        before: snapshot(OidA),
        after: snapshot(OidB),
        changes: [],
        coverage: {
            complete: true,
            eligibleEntryCount: 0,
            newlyHashedBytes: 0,
            exclusions: [],
        },
    };
}

function workspaceState(sessionId = "session-1", kind: "rewind" | "redo" = "rewind") {
    return {
        schemaVersion: 1,
        sessionId,
        operationId: `${kind}-operation`,
        workspaceIdentity: "workspace-1",
        workspaceIncarnation: "incarnation-1",
        kind,
        applyMode: "normal",
        forcedPaths: [],
        currentSnapshot: snapshot(OidA),
        currentStates: [],
        ...(kind === "rewind"
            ? {
                  rewind: {
                      fromLeafId: "leaf-1",
                      targetTurnId: "u1",
                      targetBoundaryId: null,
                      redoSnapshot: snapshot(OidB),
                      redoStates: [],
                  },
              }
            : {}),
    };
}

function turnState(
    kind: "turn-undo" | "turn-redo",
    sourceTurnId: string,
    operationId: string,
    sessionId = "session-1",
    undoOperationId?: string
) {
    return {
        ...workspaceState(sessionId, "redo"),
        operationId,
        kind,
        sourceTurnId,
        ...(undoOperationId == null ? {} : { undoOperationId }),
    };
}

function changedCheckpoint(turnId: string) {
    return {
        ...checkpoint(turnId),
        changes: [
            {
                path: `${turnId}.txt`,
                before: { state: "absent" },
                after: { state: "file", oid: OidA, executable: false },
            },
        ],
    };
}

describe("workspace rewind session state", () => {
    it("reports one reverted message in the authoritative redo view", async () => {
        const retained = message("retained", null, "assistant");
        const reverted = message("reverted", retained.id, "user");
        const assistantA = message("assistant-a", reverted.id, "assistant");
        const assistantB = message("assistant-b", assistantA.id, "assistant");
        const rewindData = workspaceState("session-1", "rewind");
        rewindData.rewind.fromLeafId = assistantB.id;
        rewindData.rewind.targetTurnId = reverted.id;
        const rewind = custom("rewind", retained.id, WorkspaceControlCustomTypes.state, rewindData);

        const view = await buildAgentRewindSessionStateView(
            [retained, reverted, assistantA, assistantB, rewind],
            "session-1",
            {
                enabled: true,
                busy: false,
                frozen: false,
                verifySnapshot: async () => {},
                readBlob: async () => Buffer.alloc(0),
                getQuota: async () => ({
                    status: "ok",
                    usedBytes: 0,
                    softQuotaBytes: 100,
                    cleanupAvailable: false,
                }),
            }
        );

        expect(view.redo?.messageCount).toBe(1);
    });

    it("publishes reverted user messages and snapshot-backed redo files", async () => {
        const retained = message("retained", null, "assistant");
        const first = message("first", retained.id, "user", "First request");
        const firstReply = message("first-reply", first.id, "assistant");
        const second = message("second", firstReply.id, "user", "Second request");
        const secondReply = message("second-reply", second.id, "assistant");
        const rewindData = workspaceState("session-1", "rewind");
        rewindData.currentStates = [
            {
                path: "docs/README.md",
                state: { state: "file", oid: OidA, executable: false },
            },
        ];
        rewindData.rewind.fromLeafId = secondReply.id;
        rewindData.rewind.targetTurnId = first.id;
        rewindData.rewind.redoStates = [
            {
                path: "docs/README.md",
                state: { state: "file", oid: OidC, executable: false },
            },
        ];
        const rewind = custom("rewind", retained.id, WorkspaceControlCustomTypes.state, rewindData);

        const view = await buildAgentRewindSessionStateView(
            [retained, first, firstReply, second, secondReply, rewind],
            "session-1",
            {
                enabled: true,
                busy: false,
                frozen: false,
                verifySnapshot: async () => {},
                readBlob: async (oid: string) => {
                    if (oid === OidA) return Buffer.from("before\n");
                    if (oid === OidC) return Buffer.from("after\nextra\n");
                    throw new Error("unexpected oid");
                },
                getQuota: async () => ({
                    status: "ok",
                    usedBytes: 0,
                    softQuotaBytes: 100,
                    cleanupAvailable: false,
                }),
            }
        );

        expect(view.redo).toMatchObject({
            messages: ["First request", "Second request"],
            messageCount: 2,
            fileCount: 1,
            files: [
                expect.objectContaining({
                    path: "docs/README.md",
                    operation: "write",
                    additions: 2,
                    deletions: 1,
                }),
            ],
        });
    });

    it("verifies snapshot objects before advertising eligible rewind points", async () => {
        const u1 = message("u1", null, "user");
        const a1 = message("a1", "u1", "assistant");
        const c1 = custom("c1", "a1", WorkspaceControlCustomTypes.checkpoint, checkpoint("u1"));
        const entries = [u1, a1, c1, leaf("leaf", c1.id, c1.id)];
        const verifySnapshot = vi.fn(async (ref: { id: string }) => {
            if (ref.id === OidB) throw new Error("missing object");
        });

        const view = await buildAgentRewindSessionStateView(entries, "session-1", {
            enabled: true,
            busy: false,
            frozen: false,
            verifySnapshot,
            readBlob: async () => Buffer.alloc(0),
            getQuota: async () => ({
                status: "ok",
                usedBytes: 10,
                softQuotaBytes: 100,
                cleanupAvailable: false,
            }),
        });

        expect(verifySnapshot).toHaveBeenCalledTimes(2);
        expect(view.eligibleTurnIds).toEqual([]);
        expect(view.turnChanges).toEqual([]);
        expect(view.quota.usedBytes).toBe(10);
        expect(view.semanticLeafId).toBe("c1");
        expect(view.displayLeafId).toBe("a1");
    });

    it("recognizes only the two stable workspace custom entry types", () => {
        const checkpointEntry = custom("checkpoint", null, WorkspaceControlCustomTypes.checkpoint, checkpoint("turn"));
        const stateEntry = custom("state", null, WorkspaceControlCustomTypes.state, workspaceState());
        const unknownCustom = custom("unknown", null, "future_workspace_control", {});

        expect(isWorkspaceControlEntry(checkpointEntry)).toBe(true);
        expect(isWorkspaceControlEntry(stateEntry)).toBe(true);
        expect(isWorkspaceControlEntry(unknownCustom)).toBe(false);
        expect(isWorkspaceControlEntry(message("user", null, "user"))).toBe(false);
    });

    it("decodes matching entries and safely rejects invalid or mismatched entries", () => {
        const checkpointEntry = custom("checkpoint", null, WorkspaceControlCustomTypes.checkpoint, checkpoint("turn"));
        const stateEntry = custom("state", "checkpoint", WorkspaceControlCustomTypes.state, workspaceState());

        expect(decodeWorkspaceCheckpointEntry(checkpointEntry)).toEqual(checkpoint("turn"));
        expect(decodeWorkspaceStateEntry(stateEntry)).toEqual(workspaceState());
        expect(decodeWorkspaceCheckpointEntry(stateEntry)).toBeUndefined();
        expect(
            decodeWorkspaceStateEntry(custom("invalid", null, WorkspaceControlCustomTypes.state, { schemaVersion: 1 }))
        ).toBeUndefined();
    });

    it("folds only unique terminal checkpoints on the active raw branch", () => {
        const u1 = message("u1", null, "user");
        const a1 = message("a1", "u1", "assistant");
        const c1 = custom("c1", "a1", WorkspaceControlCustomTypes.checkpoint, checkpoint("u1"));
        const u2 = message("u2", "c1", "user");
        const early = custom("early", "u2", WorkspaceControlCustomTypes.checkpoint, checkpoint("u2"));
        const a2 = message("a2", "early", "assistant");
        const terminal = custom("terminal", "a2", WorkspaceControlCustomTypes.checkpoint, checkpoint("u2"));
        const abandonedUser = message("abandoned-user", "u1", "user");
        const abandonedCheckpoint = custom(
            "abandoned-checkpoint",
            "abandoned-user",
            WorkspaceControlCustomTypes.checkpoint,
            checkpoint("abandoned-user")
        );

        const folded = foldWorkspaceSessionState(
            [
                u1,
                a1,
                c1,
                u2,
                early,
                a2,
                terminal,
                abandonedUser,
                abandonedCheckpoint,
                leaf("leaf", terminal.id, terminal.id),
            ],
            "session-1"
        );

        expect([...folded.checkpointsByTurnId.keys()]).toEqual(["u1"]);
        expect(folded.eligibleTurnIds).toEqual(["u1"]);
        expect(folded.checkpointGaps).toEqual([expect.objectContaining({ turnId: "u2", reason: expect.any(String) })]);
        expect(folded.semanticLeafId).toBe("terminal");
    });

    it("rejects duplicated, wrong-turn, and malformed checkpoints as gaps", () => {
        const u1 = message("u1", null, "user");
        const a1 = message("a1", "u1", "assistant");
        const c1 = custom("c1", "a1", WorkspaceControlCustomTypes.checkpoint, checkpoint("u1"));
        const c2 = custom("c2", "c1", WorkspaceControlCustomTypes.checkpoint, checkpoint("u1"));
        const u2 = message("u2", "c2", "user");
        const wrong = custom("wrong", "u2", WorkspaceControlCustomTypes.checkpoint, checkpoint("other"));
        const u3 = message("u3", "wrong", "user");
        const malformed = custom("malformed", "u3", WorkspaceControlCustomTypes.checkpoint, {
            ...checkpoint("u3"),
            unexpected: true,
        });

        const folded = foldWorkspaceSessionState([u1, a1, c1, c2, u2, wrong, u3, malformed], "session-1");

        expect([...folded.checkpointsByTurnId.keys()]).toEqual([]);
        expect(folded.eligibleTurnIds).toEqual([]);
        expect(folded.checkpointGaps.map((gap) => gap.turnId)).toEqual(["u1", "u2", "u3"]);
    });

    it("keeps unavailable checkpoints indexed but reports them as ineligible gaps", () => {
        const user = message("u1", null, "user");
        const unavailable = custom(
            "checkpoint",
            "u1",
            WorkspaceControlCustomTypes.checkpoint,
            checkpoint("u1", "unavailable")
        );

        const folded = foldWorkspaceSessionState([user, unavailable], "session-1");

        expect(folded.checkpointsByTurnId.get("u1")).toEqual(checkpoint("u1", "unavailable"));
        expect(folded.eligibleTurnIds).toEqual([]);
        expect(folded.checkpointGaps).toEqual([
            expect.objectContaining({ turnId: "u1", reason: expect.stringContaining("capture_timeout") }),
        ]);
    });

    it("uses the last valid matching workspace state from the active branch", () => {
        const user = message("u1", null, "user");
        const matching = custom(
            "matching",
            "u1",
            WorkspaceControlCustomTypes.state,
            workspaceState("session-1", "rewind")
        );
        const otherSession = custom(
            "other-session",
            "matching",
            WorkspaceControlCustomTypes.state,
            workspaceState("session-2", "redo")
        );
        const malformed = custom("malformed", "other-session", WorkspaceControlCustomTypes.state, {
            ...workspaceState("session-1", "redo"),
            unexpected: true,
        });
        const abandoned = custom(
            "abandoned",
            "u1",
            WorkspaceControlCustomTypes.state,
            workspaceState("session-1", "redo")
        );

        const folded = foldWorkspaceSessionState(
            [user, matching, otherSession, malformed, abandoned, leaf("leaf", malformed.id, malformed.id)],
            "session-1"
        );

        expect(folded.activeWorkspaceState).toEqual(workspaceState("session-1", "rewind"));
        expect(folded.semanticLeafId).toBe("malformed");
        expect(folded.displayLeafId).toBe("u1");
    });

    it("separates the latest turn marker from leaf-only conversation redo authority", async () => {
        const user = message("u1", null, "user");
        const checkpointEntry = custom(
            "c1",
            user.id,
            WorkspaceControlCustomTypes.checkpoint,
            changedCheckpoint(user.id)
        );
        const rewind = custom(
            "rewind",
            checkpointEntry.id,
            WorkspaceControlCustomTypes.state,
            workspaceState("session-1", "rewind")
        );
        const turnUndoState = turnState("turn-undo", user.id, "turn-undo-operation");
        const turnUndo = custom("turn-undo", rewind.id, WorkspaceControlCustomTypes.state, turnUndoState);

        const folded = foldWorkspaceSessionState([user, checkpointEntry, rewind, turnUndo], "session-1");
        const view = await buildAgentRewindSessionStateView([user, checkpointEntry, rewind, turnUndo], "session-1", {
            enabled: true,
            busy: false,
            frozen: false,
            verifySnapshot: async () => {},
            readBlob: async () => Buffer.alloc(0),
            getQuota: async () => ({
                status: "ok",
                usedBytes: 0,
                softQuotaBytes: 100,
                cleanupAvailable: false,
            }),
        });

        expect(folded.activeWorkspaceState).toEqual(turnUndoState);
        expect(folded.conversationRedoState).toBeUndefined();
        expect(view.redo).toBeUndefined();
    });

    it("ignores workspace states in incomplete and invalid transactions", async () => {
        const user = message("u1", null, "user");
        const checkpointEntry = custom(
            "c1",
            user.id,
            WorkspaceControlCustomTypes.checkpoint,
            changedCheckpoint(user.id)
        );
        const baselineState = workspaceState("session-1", "redo");
        const baseline = custom("baseline", checkpointEntry.id, WorkspaceControlCustomTypes.state, baselineState);
        const incompleteRewind = {
            ...custom("incomplete-rewind", baseline.id, WorkspaceControlCustomTypes.state, workspaceState()),
            transactionId: "incomplete-transaction",
        } as SessionTreeEntry;
        const invalidTransaction = makeCommittedContextTransaction({
            parentId: incompleteRewind.id,
            prefix: "invalid-state",
        });
        invalidTransaction[0] = {
            ...invalidTransaction[0]!,
            customType: WorkspaceControlCustomTypes.state,
            data: workspaceState("session-1", "rewind"),
        } as SessionTreeEntry;
        invalidTransaction[1] = {
            ...invalidTransaction[1]!,
            customType: WorkspaceControlCustomTypes.state,
            data: turnState("turn-undo", user.id, "invalid-turn-undo"),
        } as SessionTreeEntry;

        const entries = [user, checkpointEntry, baseline, incompleteRewind, ...invalidTransaction];
        const folded = foldWorkspaceSessionState(entries, "session-1");
        const incompleteTurnUndo = {
            ...custom(
                "incomplete-turn-undo",
                checkpointEntry.id,
                WorkspaceControlCustomTypes.state,
                turnState("turn-undo", user.id, "incomplete-turn-undo")
            ),
            transactionId: "incomplete-turn-transaction",
        } as SessionTreeEntry;
        const turnFolded = foldWorkspaceSessionState([user, checkpointEntry, incompleteTurnUndo], "session-1");
        const view = await buildAgentRewindSessionStateView(entries, "session-1", {
            enabled: true,
            busy: false,
            frozen: false,
            verifySnapshot: async () => {},
            readBlob: async () => Buffer.alloc(0),
            getQuota: async () => ({
                status: "ok",
                usedBytes: 0,
                softQuotaBytes: 100,
                cleanupAvailable: false,
            }),
        });

        expect(folded.activeWorkspaceState).toEqual(baselineState);
        expect(turnFolded.turnMutationsByTurnId.get(user.id)).toEqual({ action: "undo" });
        expect(folded.conversationRedoState).toBeUndefined();
        expect(view.redo).toBeUndefined();
    });

    it("folds the last valid marker per source turn on only the active branch", () => {
        const u1 = message("u1", null, "user");
        const c1 = custom("c1", u1.id, WorkspaceControlCustomTypes.checkpoint, changedCheckpoint(u1.id));
        const u2 = message("u2", c1.id, "user");
        const c2 = custom("c2", u2.id, WorkspaceControlCustomTypes.checkpoint, changedCheckpoint(u2.id));
        const undo1 = custom(
            "undo-1",
            c2.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", u1.id, "undo-operation-1")
        );
        const undo2 = custom(
            "undo-2",
            undo1.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", u2.id, "undo-operation-2")
        );
        const redo1 = custom(
            "redo-1",
            undo2.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-redo", u1.id, "redo-operation-1", "session-1", "undo-operation-1")
        );
        const wrongReference = custom(
            "wrong-reference",
            redo1.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-redo", u2.id, "redo-operation-2", "session-1", "other-undo-operation")
        );
        const crossSession = custom(
            "cross-session",
            wrongReference.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", u1.id, "cross-session-operation", "session-2")
        );
        const abandoned = custom(
            "abandoned",
            c2.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-redo", u2.id, "abandoned-redo", "session-1", "undo-operation-2")
        );

        const folded = foldWorkspaceSessionState(
            [
                u1,
                c1,
                u2,
                c2,
                undo1,
                undo2,
                redo1,
                wrongReference,
                crossSession,
                abandoned,
                leaf("leaf", crossSession.id, crossSession.id),
            ],
            "session-1"
        );

        expect([...folded.turnMutationsByTurnId]).toEqual([
            [u1.id, { action: "undo" }],
            [u2.id, { action: "redo", undoOperationId: "undo-operation-2" }],
        ]);
    });

    it("keeps multiple source turns independently undone", () => {
        const u1 = message("u1", null, "user");
        const c1 = custom("c1", u1.id, WorkspaceControlCustomTypes.checkpoint, changedCheckpoint(u1.id));
        const u2 = message("u2", c1.id, "user");
        const c2 = custom("c2", u2.id, WorkspaceControlCustomTypes.checkpoint, changedCheckpoint(u2.id));
        const undo1 = custom(
            "undo-1",
            c2.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", u1.id, "undo-operation-1")
        );
        const undo2 = custom(
            "undo-2",
            undo1.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", u2.id, "undo-operation-2")
        );

        const folded = foldWorkspaceSessionState([u1, c1, u2, c2, undo1, undo2], "session-1");

        expect([...folded.turnMutationsByTurnId]).toEqual([
            [u1.id, { action: "redo", undoOperationId: "undo-operation-1" }],
            [u2.id, { action: "redo", undoOperationId: "undo-operation-2" }],
        ]);
    });

    it("ignores turn markers that precede their source turn checkpoint", () => {
        const beforeUndo = custom(
            "before-undo",
            null,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", "u1", "before-undo-operation")
        );
        const beforeRedo = custom(
            "before-redo",
            beforeUndo.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-redo", "u2", "before-redo-operation", "session-1", "future-undo-operation")
        );
        const u1 = message("u1", beforeRedo.id, "user");
        const c1 = custom("c1", u1.id, WorkspaceControlCustomTypes.checkpoint, changedCheckpoint(u1.id));
        const u2 = message("u2", c1.id, "user");
        const c2 = custom("c2", u2.id, WorkspaceControlCustomTypes.checkpoint, changedCheckpoint(u2.id));

        const folded = foldWorkspaceSessionState([beforeUndo, beforeRedo, u1, c1, u2, c2], "session-1");

        expect([...folded.turnMutationsByTurnId]).toEqual([
            [u1.id, { action: "undo" }],
            [u2.id, { action: "undo" }],
        ]);
    });

    it("accepts only undo-to-redo and matching-redo-to-undo transitions", () => {
        const user = message("u1", null, "user");
        const checkpointEntry = custom(
            "checkpoint",
            user.id,
            WorkspaceControlCustomTypes.checkpoint,
            changedCheckpoint(user.id)
        );
        const undo = custom(
            "undo",
            checkpointEntry.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", user.id, "undo-operation")
        );
        const duplicateUndo = custom(
            "duplicate-undo",
            undo.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", user.id, "duplicate-undo-operation")
        );
        const wrongRedo = custom(
            "wrong-redo",
            duplicateUndo.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-redo", user.id, "wrong-redo-operation", "session-1", "duplicate-undo-operation")
        );
        const matchingRedo = custom(
            "matching-redo",
            wrongRedo.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-redo", user.id, "matching-redo-operation", "session-1", "undo-operation")
        );

        const beforeMatchingRedo = foldWorkspaceSessionState(
            [user, checkpointEntry, undo, duplicateUndo, wrongRedo],
            "session-1"
        );
        const folded = foldWorkspaceSessionState(
            [user, checkpointEntry, undo, duplicateUndo, wrongRedo, matchingRedo],
            "session-1"
        );

        expect(beforeMatchingRedo.turnMutationsByTurnId.get(user.id)).toEqual({
            action: "redo",
            undoOperationId: "undo-operation",
        });
        expect(folded.turnMutationsByTurnId.get(user.id)).toEqual({ action: "undo" });
    });

    it("ignores workspace-mismatched markers and foreign-session checkpoints", () => {
        const user = message("u1", null, "user");
        const checkpointEntry = custom(
            "checkpoint",
            user.id,
            WorkspaceControlCustomTypes.checkpoint,
            changedCheckpoint(user.id)
        );
        const mismatchedUndo = custom("mismatched-undo", checkpointEntry.id, WorkspaceControlCustomTypes.state, {
            ...turnState("turn-undo", user.id, "mismatched-undo-operation"),
            workspaceIdentity: "workspace-2",
        });
        const undo = custom(
            "undo",
            mismatchedUndo.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", user.id, "undo-operation")
        );
        const mismatchedRedo = custom("mismatched-redo", undo.id, WorkspaceControlCustomTypes.state, {
            ...turnState("turn-redo", user.id, "mismatched-redo-operation", "session-1", "undo-operation"),
            workspaceIncarnation: "incarnation-2",
        });
        const foreignUser = message("foreign-user", mismatchedRedo.id, "user");
        const foreignCheckpoint = custom("foreign-checkpoint", foreignUser.id, WorkspaceControlCustomTypes.checkpoint, {
            ...changedCheckpoint(foreignUser.id),
            originSessionId: "session-2",
        });

        const folded = foldWorkspaceSessionState(
            [user, checkpointEntry, mismatchedUndo, undo, mismatchedRedo, foreignUser, foreignCheckpoint],
            "session-1"
        );

        expect(folded.turnMutationsByTurnId.get(user.id)).toEqual({
            action: "redo",
            undoOperationId: "undo-operation",
        });
        expect(folded.checkpointsByTurnId.has(foreignUser.id)).toBe(false);
        expect(folded.eligibleTurnIds).not.toContain(foreignUser.id);
        expect(folded.turnMutationsByTurnId.has(foreignUser.id)).toBe(false);
    });

    it("publishes turn actions only for readable non-empty available checkpoints", async () => {
        const missing = message("missing", null, "user");
        const unavailable = message("unavailable", missing.id, "user");
        const unavailableEntry = custom(
            "unavailable-checkpoint",
            unavailable.id,
            WorkspaceControlCustomTypes.checkpoint,
            checkpoint(unavailable.id, "unavailable")
        );
        const empty = message("empty", unavailableEntry.id, "user");
        const emptyCheckpoint = custom(
            "empty-checkpoint",
            empty.id,
            WorkspaceControlCustomTypes.checkpoint,
            checkpoint(empty.id)
        );
        const readable = message("readable", emptyCheckpoint.id, "user");
        const readableCheckpoint = custom(
            "readable-checkpoint",
            readable.id,
            WorkspaceControlCustomTypes.checkpoint,
            changedCheckpoint(readable.id)
        );
        const unreadable = message("unreadable", readableCheckpoint.id, "user");
        const unreadableCheckpoint = custom(
            "unreadable-checkpoint",
            unreadable.id,
            WorkspaceControlCustomTypes.checkpoint,
            { ...changedCheckpoint(unreadable.id), after: snapshot(OidC) }
        );
        const undo = custom(
            "undo-readable",
            unreadableCheckpoint.id,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", readable.id, "undo-readable-operation")
        );

        const view = await buildAgentRewindSessionStateView(
            [
                missing,
                unavailable,
                unavailableEntry,
                empty,
                emptyCheckpoint,
                readable,
                readableCheckpoint,
                unreadable,
                unreadableCheckpoint,
                undo,
            ],
            "session-1",
            {
                enabled: true,
                busy: false,
                frozen: false,
                verifySnapshot: async (ref) => {
                    if (ref.id === OidC) throw new Error("missing object");
                },
                readBlob: async () => Buffer.alloc(0),
                getQuota: async () => ({
                    status: "ok",
                    usedBytes: 0,
                    softQuotaBytes: 100,
                    cleanupAvailable: false,
                }),
            }
        );

        expect(view.eligibleTurnIds).toEqual([empty.id, readable.id]);
        expect(view.turnChanges).toEqual([
            { turnId: readable.id, action: "redo", undoOperationId: "undo-readable-operation" },
        ]);
    });

    it("ends the previous turn before the next committed context transaction prefix", () => {
        const user = message("u1", null, "user");
        const assistant = message("a1", user.id, "assistant");
        const firstCheckpoint = custom("c1", assistant.id, WorkspaceControlCustomTypes.checkpoint, checkpoint(user.id));
        const contextTurn = makeCommittedContextTransaction({
            parentId: firstCheckpoint.id,
            prefix: "next",
        });
        const nextUser = contextTurn.at(-1)!;
        const nextAssistant = message("a2", nextUser.id, "assistant");
        const nextCheckpoint = custom(
            "c2",
            nextAssistant.id,
            WorkspaceControlCustomTypes.checkpoint,
            checkpoint(nextUser.id)
        );

        const folded = foldWorkspaceSessionState(
            [user, assistant, firstCheckpoint, ...contextTurn, nextAssistant, nextCheckpoint],
            "session-1"
        );

        expect([...folded.checkpointsByTurnId.keys()]).toEqual([user.id, nextUser.id]);
        expect(folded.eligibleTurnIds).toEqual([user.id, nextUser.id]);
        expect(folded.checkpointGaps).toEqual([]);
    });

    it("does not move a turn boundary across a malformed context transaction prefix", () => {
        const user = message("u1", null, "user");
        const checkpointEntry = custom("c1", user.id, WorkspaceControlCustomTypes.checkpoint, checkpoint(user.id));
        const malformedTurn = makeCommittedContextTransaction({
            parentId: checkpointEntry.id,
            prefix: "malformed",
        }).map((entry) =>
            entry.type === "custom" && entry.customType === "session_tx_manifest"
                ? { ...entry, data: { schemaVersion: 1 } }
                : entry
        ) as SessionTreeEntry[];

        const folded = foldWorkspaceSessionState([user, checkpointEntry, ...malformedTurn], "session-1");

        expect(folded.checkpointsByTurnId.has(user.id)).toBe(false);
        expect(folded.checkpointGaps).toEqual([
            expect.objectContaining({ turnId: user.id, reason: "workspace checkpoint is not terminal" }),
            expect.objectContaining({ turnId: "malformed-user" }),
        ]);
    });

    it("fails closed when the active ancestry has a missing parent", () => {
        const user = message("orphan-user", "missing-parent", "user");
        const checkpointEntry = custom(
            "orphan-checkpoint",
            user.id,
            WorkspaceControlCustomTypes.checkpoint,
            checkpoint(user.id)
        );
        const stateEntry = custom(
            "orphan-state",
            checkpointEntry.id,
            WorkspaceControlCustomTypes.state,
            workspaceState()
        );

        const folded = foldWorkspaceSessionState([user, checkpointEntry, stateEntry], "session-1");

        expect(folded.semanticLeafId).toBe(stateEntry.id);
        expect(folded.displayLeafId).toBeNull();
        expect(folded.checkpointsByTurnId.size).toBe(0);
        expect(folded.eligibleTurnIds).toEqual([]);
        expect(folded.checkpointGaps).toEqual([]);
        expect(folded.activeWorkspaceState).toBeUndefined();
    });

    it("fails closed when the active ancestry contains a cycle", () => {
        const user = message("cycle-user", "cycle-state", "user");
        const checkpointEntry = custom(
            "cycle-checkpoint",
            user.id,
            WorkspaceControlCustomTypes.checkpoint,
            checkpoint(user.id)
        );
        const stateEntry = custom(
            "cycle-state",
            checkpointEntry.id,
            WorkspaceControlCustomTypes.state,
            workspaceState()
        );

        const folded = foldWorkspaceSessionState([user, checkpointEntry, stateEntry], "session-1");

        expect(folded.semanticLeafId).toBe(stateEntry.id);
        expect(folded.displayLeafId).toBeNull();
        expect(folded.checkpointsByTurnId.size).toBe(0);
        expect(folded.eligibleTurnIds).toEqual([]);
        expect(folded.checkpointGaps).toEqual([]);
        expect(folded.activeWorkspaceState).toBeUndefined();
    });

    it("fails closed when an active ancestor ID is ambiguous", () => {
        const firstUser = message("duplicate-user", null, "user");
        const secondUser = message("duplicate-user", null, "user");
        const checkpointEntry = custom(
            "duplicate-checkpoint",
            firstUser.id,
            WorkspaceControlCustomTypes.checkpoint,
            checkpoint(firstUser.id)
        );
        const stateEntry = custom(
            "duplicate-state",
            checkpointEntry.id,
            WorkspaceControlCustomTypes.state,
            workspaceState()
        );

        const folded = foldWorkspaceSessionState([firstUser, secondUser, checkpointEntry, stateEntry], "session-1");

        expect(folded.semanticLeafId).toBe(stateEntry.id);
        expect(folded.displayLeafId).toBeNull();
        expect(folded.checkpointsByTurnId.size).toBe(0);
        expect(folded.eligibleTurnIds).toEqual([]);
        expect(folded.checkpointGaps).toEqual([]);
        expect(folded.activeWorkspaceState).toBeUndefined();
    });
});
