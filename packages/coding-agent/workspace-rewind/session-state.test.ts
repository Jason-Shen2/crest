// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { makeCommittedContextTransaction } from "@crest/agent/harness/session/context-transaction-fixture";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import {
    decodeWorkspaceCheckpointEntry,
    decodeWorkspaceStateEntry,
    foldWorkspaceSessionState,
    isWorkspaceControlEntry,
} from "./session-state";
import { WorkspaceControlCustomTypes } from "./types";

const OidA = "a".repeat(40);
const OidB = "b".repeat(40);

function message(id: string, parentId: string | null, role: "user" | "assistant"): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: `t-${id}`,
        message: { role, content: [{ type: "text", text: id }] },
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
    };
}

describe("workspace rewind session state", () => {
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
