// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makeCommittedContextTransaction } from "@crest/agent/harness/session/context-transaction-fixture";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { planRedo, planRewind as planRewindImpl, type PlanRewindInput } from "./restore-plan";
import type { CapturedPathStateV1, WorkspaceCheckpointV1, WorkspaceStateBaseV1, WorkspaceStateV1 } from "./types";
import { WorkspaceControlCustomTypes } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import type { WorkspaceMutationLog } from "./workspace-mutation-log";

const OidA = "a".repeat(40);
const OidB = "b".repeat(40);
const OidC = "c".repeat(40);
const OidD = "d".repeat(40);
const OidE = "e".repeat(40);

const Workspace = {
    canonicalRoot: "/workspace",
    workspaceIdentity: "workspace-1",
    workspaceIncarnation: "incarnation-1",
    storeKey: "store",
    ancestorIdentityChain: [],
} as CanonicalWorkspaceIdentity;

function message(id: string, parentId: string | null, role: "user" | "assistant"): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: `t-${id}`,
        message: { role, content: [{ type: "text", text: id }] },
    } as SessionTreeEntry;
}

function custom(id: string, parentId: string | null, customType: string, data: unknown): SessionTreeEntry {
    return { type: "custom", id, parentId, timestamp: `t-${id}`, customType, data };
}

function leaf(id: string, targetId: string | null): SessionTreeEntry {
    return { type: "leaf", id, parentId: targetId, timestamp: `t-${id}`, targetId };
}

function snapshot(id: string) {
    return {
        id,
        workspaceIdentity: Workspace.workspaceIdentity,
        workspaceIncarnation: Workspace.workspaceIncarnation,
        tree: OidA,
        scopeManifest: OidB,
    };
}

function checkpoint(
    turnId: string,
    changes: Array<{ path: string; before: CapturedPathStateV1; after: CapturedPathStateV1 }>
): Extract<WorkspaceCheckpointV1, { status: "available" }> {
    return {
        schemaVersion: 1,
        status: "available",
        originSessionId: "session-1",
        turnId,
        workspaceIdentity: Workspace.workspaceIdentity,
        workspaceIncarnation: Workspace.workspaceIncarnation,
        before: snapshot(`${OidA.slice(0, -1)}${turnId === "u1" ? "1" : "2"}`),
        after: snapshot(`${OidB.slice(0, -1)}${turnId === "u1" ? "1" : "2"}`),
        changes,
        coverage: { complete: true, eligibleEntryCount: changes.length, newlyHashedBytes: 0, exclusions: [] },
    };
}

function live(state: CapturedPathStateV1) {
    if (state.state === "file") {
        return { ...state, fingerprint: `${state.oid}:${state.executable}` };
    }
    if (state.state === "symlink") {
        return { ...state, fingerprint: state.oid };
    }
    return { state: "absent" as const, fingerprint: "absent" };
}

type TestMutationLog = Pick<WorkspaceMutationLog, "read" | "findForeignOverlap">;
type TestPlanRewindInput = Omit<PlanRewindInput, "mutationLog" | "diffSnapshots"> & {
    mutationLog?: TestMutationLog;
    diffSnapshots?: PlanRewindInput["diffSnapshots"];
};

function mutationLog(
    overrides: Partial<{
        read: WorkspaceMutationLog["read"];
        overlaps: Awaited<ReturnType<WorkspaceMutationLog["findForeignOverlap"]>>;
    }> = {}
): TestMutationLog {
    return {
        read:
            overrides.read ??
            vi.fn(async (commit: string) => {
                const turnId = commit.endsWith("1") ? "u1" : "u2";
                return {
                    parent: `${OidA.slice(0, -1)}${commit.at(-1)}`,
                    tree: OidA,
                    metadata: {
                        schemaversion: 1 as const,
                        workspaceidentity: Workspace.workspaceIdentity,
                        workspaceincarnation: Workspace.workspaceIncarnation,
                        kind: "agent-turn" as const,
                        sessionid: "session-1",
                        turnid: turnId,
                    },
                };
            }),
        findForeignOverlap: vi.fn(async () => overrides.overlaps ?? []),
    };
}

function planRewind(input: TestPlanRewindInput) {
    const diffSnapshots =
        input.diffSnapshots ??
        (async (before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>) => {
            for (const entry of input.rawEntries) {
                if (entry.type !== "custom" || entry.customType !== WorkspaceControlCustomTypes.checkpoint) continue;
                const value = entry.data as WorkspaceCheckpointV1;
                if (value.status === "available" && value.before.id === before.id && value.after.id === after.id) {
                    return value.changes;
                }
            }
            return [];
        });
    return planRewindImpl({
        ...input,
        mutationLog: input.mutationLog ?? mutationLog(),
        diffSnapshots,
    } as PlanRewindInput);
}

describe("restore planning", () => {
    it("hard-blocks full rewind when checkpoint changes omit an authoritative path", async () => {
        const stored = checkpoint("u1", [
            { path: "a.ts", before: { state: "absent" }, after: { state: "file", oid: OidA, executable: false } },
        ]);
        const authoritative = [
            ...stored.changes,
            {
                path: "b.ts",
                before: { state: "absent" as const },
                after: { state: "file" as const, oid: OidB, executable: false },
            },
        ];
        const user = message("u1", null, "user");
        const checkpointEntry = custom("c1", user.id, WorkspaceControlCustomTypes.checkpoint, stored);
        const history = mutationLog();
        const inspectLivePath = vi.fn(async () => live(stored.changes[0]!.after));

        const plan = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [user, checkpointEntry],
            semanticLeafId: checkpointEntry.id,
            targetTurnId: user.id,
            inspectLivePath,
            verifySnapshot: async () => {},
            mutationLog: history,
            diffSnapshots: vi.fn(async () => authoritative),
        });

        expect(plan.hardBlocked).toBe(true);
        expect(history.findForeignOverlap).not.toHaveBeenCalled();
        expect(inspectLivePath).not.toHaveBeenCalled();
    });

    it("rejects an oversized full-rewind transition set before history or live inspection", async () => {
        const changes = Array.from({ length: 4_097 }, (_, index) => ({
            path: `file-${index}.ts`,
            before: { state: "absent" as const },
            after: { state: "file" as const, oid: OidA, executable: false },
        }));
        const stored = checkpoint("u1", changes);
        const user = message("u1", null, "user");
        const checkpointEntry = custom("c1", user.id, WorkspaceControlCustomTypes.checkpoint, stored);
        const history = mutationLog();
        const inspectLivePath = vi.fn(async () => ({ state: "absent" as const, fingerprint: "absent" }));

        const plan = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [user, checkpointEntry],
            semanticLeafId: checkpointEntry.id,
            targetTurnId: user.id,
            inspectLivePath,
            verifySnapshot: async () => {},
            mutationLog: history,
        });

        expect(plan.hardBlocked).toBe(true);
        expect(plan.coverageWarnings).toContainEqual(
            expect.objectContaining({ reason: expect.stringMatching(/inspection limit/i) })
        );
        expect(history.findForeignOverlap).not.toHaveBeenCalled();
        expect(inspectLivePath).not.toHaveBeenCalled();
    });

    it.each([
        ["kind", { kind: "external" }],
        ["owner", { sessionid: "session-2" }],
        ["turn", { turnid: "u2" }],
        ["parent", { parent: OidE }],
    ] as const)(
        "hard-blocks full rewind when a changed checkpoint has malformed %s authority",
        async (_label, override) => {
            const cp = checkpoint("u1", [
                { path: "a.ts", before: { state: "absent" }, after: { state: "file", oid: OidA, executable: false } },
            ]);
            const read = vi.fn(async () => ({
                parent: cp.before.id,
                tree: cp.after.tree,
                metadata: {
                    schemaversion: 1 as const,
                    workspaceidentity: Workspace.workspaceIdentity,
                    workspaceincarnation: Workspace.workspaceIncarnation,
                    kind: "agent-turn" as const,
                    sessionid: "session-1",
                    turnid: "u1",
                    ...("parent" in override ? {} : override),
                },
                ...("parent" in override ? { parent: override.parent } : {}),
            }));
            const history = mutationLog({ read });
            const user = message("u1", null, "user");
            const checkpointEntry = custom("c1", user.id, WorkspaceControlCustomTypes.checkpoint, cp);
            const inspectLivePath = vi.fn(async () => live(cp.changes[0]!.after));

            const plan = await planRewind({
                sessionId: "session-1",
                workspace: Workspace,
                rawEntries: [user, checkpointEntry],
                semanticLeafId: checkpointEntry.id,
                targetTurnId: user.id,
                inspectLivePath,
                verifySnapshot: async () => {},
                mutationLog: history,
            });

            expect(plan.hardBlocked).toBe(true);
            expect(inspectLivePath).not.toHaveBeenCalled();
            expect(history.findForeignOverlap).not.toHaveBeenCalled();
        }
    );

    it("folds later selected checkpoint commits into full-rewind overlap inspection", async () => {
        const first = checkpoint("u1", [
            { path: "a.ts", before: { state: "absent" }, after: { state: "file", oid: OidA, executable: false } },
        ]);
        const second = checkpoint("u2", [
            {
                path: "a.ts",
                before: { state: "file", oid: OidA, executable: false },
                after: { state: "file", oid: OidB, executable: false },
            },
        ]);
        const u1 = message("u1", null, "user");
        const c1 = custom("c1", u1.id, WorkspaceControlCustomTypes.checkpoint, first);
        const u2 = message("u2", c1.id, "user");
        const c2 = custom("c2", u2.id, WorkspaceControlCustomTypes.checkpoint, second);
        const history = mutationLog();

        await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [u1, c1, u2, c2],
            semanticLeafId: c2.id,
            targetTurnId: u1.id,
            inspectLivePath: async () => live(first.changes[0]!.after),
            verifySnapshot: async () => {},
            mutationLog: history,
        });

        expect(history.findForeignOverlap).toHaveBeenCalledWith({
            afterCommit: first.after.id,
            paths: ["a.ts"],
            includedCommits: new Set([second.after.id]),
            ownerSessionId: "session-1",
        });
    });

    it("hard-blocks same-path Crest ABA history even when live bytes already match the rewind target", async () => {
        const cp = checkpoint("u1", [
            { path: "a.ts", before: { state: "absent" }, after: { state: "file", oid: OidA, executable: false } },
        ]);
        const history = mutationLog({
            overlaps: [{ commit: OidE, path: "a.ts", sessionId: "session-2" }],
        });
        const user = message("u1", null, "user");
        const checkpointEntry = custom("c1", user.id, WorkspaceControlCustomTypes.checkpoint, cp);

        const plan = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [user, checkpointEntry],
            semanticLeafId: checkpointEntry.id,
            targetTurnId: user.id,
            inspectLivePath: async () => live(cp.changes[0]!.before),
            verifySnapshot: async () => {},
            mutationLog: history,
        });

        expect(plan).toMatchObject({ hardBlocked: true, forceRequired: false });
        expect(plan.paths).toEqual([expect.objectContaining({ path: "a.ts", conflict: "hard-blocker" })]);
    });

    it("uses the active suffix, earliest before, latest after, hidden override, exclusions, and no-ops", async () => {
        const first = checkpoint("u1", [
            {
                path: "a.ts",
                before: { state: "file", oid: OidA, executable: false },
                after: { state: "file", oid: OidB, executable: false },
            },
            { path: "noop.ts", before: { state: "absent" }, after: { state: "file", oid: OidB, executable: false } },
            {
                path: "excluded.ts",
                before: { state: "excluded", reason: "ignored" },
                after: { state: "file", oid: OidB, executable: false },
            },
        ]);
        const second = checkpoint("u2", [
            {
                path: "a.ts",
                before: { state: "file", oid: OidB, executable: false },
                after: { state: "file", oid: OidC, executable: false },
            },
            { path: "b.ts", before: { state: "absent" }, after: { state: "file", oid: OidD, executable: false } },
        ]);
        const u1 = message("u1", null, "user");
        const a1 = message("a1", "u1", "assistant");
        const c1 = custom("c1", "a1", WorkspaceControlCustomTypes.checkpoint, first);
        const u2 = message("u2", "c1", "user");
        const a2 = message("a2", "u2", "assistant");
        const c2 = custom("c2", "a2", WorkspaceControlCustomTypes.checkpoint, second);
        const abandoned = custom("abandoned", "u1", WorkspaceControlCustomTypes.checkpoint, checkpoint("u1", []));
        const currentWorkspaceState = {
            schemaVersion: 1,
            sessionId: "session-1",
            operationId: "old-rewind",
            workspaceIdentity: Workspace.workspaceIdentity,
            workspaceIncarnation: Workspace.workspaceIncarnation,
            kind: "redo",
            applyMode: "normal",
            forcedPaths: [],
            currentSnapshot: snapshot(OidC),
            currentStates: [
                { path: "a.ts", state: { state: "file", oid: OidD, executable: false } },
                { path: "noop.ts", state: { state: "absent" } },
            ],
        } satisfies WorkspaceStateV1;
        const stateMarker = custom("state-marker", "c2", WorkspaceControlCustomTypes.state, currentWorkspaceState);

        const plan = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [u1, a1, c1, u2, a2, c2, stateMarker, abandoned, leaf("leaf", "state-marker")],
            semanticLeafId: "state-marker",
            targetTurnId: "u1",
            currentWorkspaceState,
            inspectLivePath: async (path) =>
                live(
                    path === "a.ts"
                        ? currentWorkspaceState.currentStates[0]!.state
                        : { state: "file", oid: OidD, executable: false }
                ),
            verifySnapshot: vi.fn(async () => {}),
        });

        expect(plan.target).toEqual({ kind: "rewind", targetTurnId: "u1" });
        expect(plan.commitParentId).toBeNull();
        expect(plan.paths.map((item) => item.path)).toEqual(["a.ts", "b.ts"]);
        expect(plan.paths.find((item) => item.path === "a.ts")).toMatchObject({
            target: first.changes[0]!.before,
            expectedCurrent: currentWorkspaceState.currentStates[0]!.state,
            conflict: "none",
        });
        expect(plan.coverageWarnings).toEqual([
            expect.objectContaining({ path: "excluded.ts", reason: expect.any(String) }),
        ]);
    });

    it.each(["missing", "duplicate", "unavailable"] as const)(
        "hard-blocks a %s terminal checkpoint",
        async (variant) => {
            const u1 = message("u1", null, "user");
            const a1 = message("a1", "u1", "assistant");
            const available = checkpoint("u1", []);
            const entries = [u1, a1];
            if (variant !== "missing") {
                entries.push(
                    custom(
                        "c1",
                        "a1",
                        WorkspaceControlCustomTypes.checkpoint,
                        variant === "unavailable"
                            ? {
                                  schemaVersion: 1,
                                  status: "unavailable",
                                  originSessionId: "session-1",
                                  turnId: "u1",
                                  workspaceIdentity: Workspace.workspaceIdentity,
                                  reasonCode: "capture_timeout",
                                  message: "timeout",
                              }
                            : available
                    )
                );
            }
            if (variant === "duplicate") {
                entries.push(custom("c2", "c1", WorkspaceControlCustomTypes.checkpoint, available));
            }

            const plan = await planRewind({
                sessionId: "session-1",
                workspace: Workspace,
                rawEntries: entries,
                semanticLeafId: entries.at(-1)!.id,
                targetTurnId: "u1",
                inspectLivePath: async () => ({ state: "absent", fingerprint: "absent" }),
                verifySnapshot: async () => {},
            });

            expect(plan.hardBlocked).toBe(true);
        }
    );

    it("hard-blocks snapshot failures and workspace identity mismatches", async () => {
        const cp = checkpoint("u1", [
            { path: "a.ts", before: { state: "absent" }, after: { state: "file", oid: OidA, executable: false } },
        ]);
        const u1 = message("u1", null, "user");
        const c1 = custom("c1", "u1", WorkspaceControlCustomTypes.checkpoint, cp);

        const missingSnapshot = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [u1, c1],
            semanticLeafId: "c1",
            targetTurnId: "u1",
            inspectLivePath: async () => live(cp.changes[0]!.after),
            verifySnapshot: async () => {
                throw new Error("missing");
            },
        });
        const wrongWorkspace = await planRewind({
            sessionId: "session-1",
            workspace: { ...Workspace, workspaceIncarnation: "other" },
            rawEntries: [u1, c1],
            semanticLeafId: "c1",
            targetTurnId: "u1",
            inspectLivePath: async () => live(cp.changes[0]!.after),
            verifySnapshot: async () => {},
        });

        expect(missingSnapshot.hardBlocked).toBe(true);
        expect(wrongWorkspace.hardBlocked).toBe(true);
    });

    it("uses the transaction-aware before boundary for a prepared target user", async () => {
        const root = message("root", null, "assistant");
        const transaction = makeCommittedContextTransaction({ parentId: "root", prefix: "prepared" });
        const turn = transaction.at(-1)!;
        const cp = checkpoint(turn.id, []);
        const checkpointEntry = custom("checkpoint", turn.id, WorkspaceControlCustomTypes.checkpoint, cp);
        const history = mutationLog({
            read: vi.fn(async () => ({
                parent: cp.before.id,
                tree: cp.after.tree,
                metadata: {
                    schemaversion: 1 as const,
                    workspaceidentity: Workspace.workspaceIdentity,
                    workspaceincarnation: Workspace.workspaceIncarnation,
                    kind: "agent-turn" as const,
                    sessionid: "session-1",
                    turnid: turn.id,
                },
            })),
        });

        const plan = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [root, ...transaction, checkpointEntry],
            semanticLeafId: "checkpoint",
            targetTurnId: turn.id,
            inspectLivePath: async () => ({ state: "absent", fingerprint: "absent" }),
            verifySnapshot: async () => {},
            mutationLog: history,
        });

        expect(plan.commitParentId).toBe("root");
        expect(plan.hardBlocked).toBe(false);
    });

    it("ignores incomplete transaction workspace states for authority and suffix validation", async () => {
        const cp = checkpoint("u1", []);
        const user = message("u1", null, "user");
        const checkpointEntry = custom("c1", user.id, WorkspaceControlCustomTypes.checkpoint, cp);
        const authoritative = {
            schemaVersion: 1,
            sessionId: "session-1",
            operationId: "authoritative",
            workspaceIdentity: Workspace.workspaceIdentity,
            workspaceIncarnation: Workspace.workspaceIncarnation,
            kind: "redo",
            applyMode: "normal",
            forcedPaths: [],
            currentSnapshot: snapshot(OidA),
            currentStates: [],
        } satisfies WorkspaceStateV1;
        const marker = custom("authoritative", checkpointEntry.id, WorkspaceControlCustomTypes.state, authoritative);
        const incompleteValid = {
            ...custom("incomplete-valid", marker.id, WorkspaceControlCustomTypes.state, {
                ...authoritative,
                operationId: "incomplete-valid",
            }),
            transactionId: "incomplete-valid-transaction",
        } as SessionTreeEntry;
        const incompleteMalformed = {
            ...custom("incomplete-malformed", incompleteValid.id, WorkspaceControlCustomTypes.state, {
                schemaVersion: 1,
            }),
            transactionId: "incomplete-malformed-transaction",
        } as SessionTreeEntry;

        const plan = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [user, checkpointEntry, marker, incompleteValid, incompleteMalformed],
            semanticLeafId: incompleteMalformed.id,
            targetTurnId: user.id,
            currentWorkspaceState: authoritative,
            inspectLivePath: async () => ({ state: "absent", fingerprint: "absent" }),
            verifySnapshot: async () => {},
        });

        expect(plan.hardBlocked).toBe(false);
    });

    it("accepts a turn marker as rewind authority after a conversation rewind marker", async () => {
        const cp = checkpoint("u1", []);
        const user = message("u1", null, "user");
        const checkpointEntry = custom("c1", user.id, WorkspaceControlCustomTypes.checkpoint, cp);
        const stateBase = {
            schemaVersion: 1,
            sessionId: "session-1",
            workspaceIdentity: Workspace.workspaceIdentity,
            workspaceIncarnation: Workspace.workspaceIncarnation,
            applyMode: "normal",
            forcedPaths: [],
            currentSnapshot: snapshot(OidA),
            currentStates: [],
        } satisfies Omit<WorkspaceStateBaseV1, "operationId">;
        const rewindState = {
            ...stateBase,
            operationId: "conversation-rewind",
            kind: "rewind",
            rewind: {
                fromLeafId: checkpointEntry.id,
                targetTurnId: user.id,
                targetBoundaryId: null,
                redoSnapshot: snapshot(OidB),
                redoStates: [],
            },
        } satisfies WorkspaceStateV1;
        const turnState = {
            ...stateBase,
            operationId: "turn-undo",
            kind: "turn-undo",
            sourceTurnId: user.id,
        } satisfies WorkspaceStateV1;
        const rewind = custom(
            "conversation-rewind",
            checkpointEntry.id,
            WorkspaceControlCustomTypes.state,
            rewindState
        );
        const turnUndo = custom("turn-undo", rewind.id, WorkspaceControlCustomTypes.state, turnState);

        const plan = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [user, checkpointEntry, rewind, turnUndo],
            semanticLeafId: turnUndo.id,
            targetTurnId: user.id,
            currentWorkspaceState: turnState,
            inspectLivePath: async () => ({ state: "absent", fingerprint: "absent" }),
            verifySnapshot: async () => {},
        });

        expect(plan.hardBlocked).toBe(false);
        expect(plan.coverageWarnings).not.toContainEqual(
            expect.objectContaining({ reason: expect.stringMatching(/caller workspace state differs/) })
        );
    });

    it("folds hidden state chronologically and lets a later checkpoint supersede it", async () => {
        const cp1 = checkpoint("u1", [
            {
                path: "a.ts",
                before: { state: "file", oid: OidA, executable: false },
                after: { state: "file", oid: OidB, executable: false },
            },
        ]);
        const cp2 = checkpoint("u2", [
            {
                path: "a.ts",
                before: { state: "file", oid: OidC, executable: false },
                after: { state: "file", oid: OidD, executable: false },
            },
        ]);
        const state = {
            schemaVersion: 1,
            sessionId: "session-1",
            operationId: "between-turns",
            workspaceIdentity: Workspace.workspaceIdentity,
            workspaceIncarnation: Workspace.workspaceIncarnation,
            kind: "redo",
            applyMode: "normal",
            forcedPaths: [],
            currentSnapshot: snapshot(OidC),
            currentStates: [{ path: "a.ts", state: { state: "file", oid: OidC, executable: false } }],
        } satisfies WorkspaceStateV1;
        const u1 = message("u1", null, "user");
        const c1 = custom("c1", "u1", WorkspaceControlCustomTypes.checkpoint, cp1);
        const marker = custom("marker", "c1", WorkspaceControlCustomTypes.state, state);
        const u2 = message("u2", "marker", "user");
        const c2 = custom("c2", "u2", WorkspaceControlCustomTypes.checkpoint, cp2);
        const offBranchState = {
            ...state,
            operationId: "off-branch",
            currentStates: [{ path: "a.ts", state: { state: "file" as const, oid: OidA, executable: false } }],
        };
        const abandoned = custom("abandoned", "c1", WorkspaceControlCustomTypes.state, offBranchState);

        const plan = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [u1, c1, marker, u2, c2, abandoned, leaf("leaf", "c2")],
            semanticLeafId: "c2",
            targetTurnId: "u1",
            currentWorkspaceState: state,
            inspectLivePath: async () => ({
                state: "file",
                oid: OidD,
                executable: false,
                fingerprint: "current-d",
            }),
            verifySnapshot: async () => {},
        });

        expect(plan.hardBlocked).toBe(false);
        expect(plan.paths[0]).toMatchObject({
            target: { state: "file", oid: OidA, executable: false },
            expectedCurrent: { state: "file", oid: OidD, executable: false },
            conflict: "none",
        });
    });

    it.each(["currentSnapshot", "currentStates"] as const)(
        "hard-blocks caller state whose %s differs from the authoritative active-branch marker",
        async (field) => {
            const cp = checkpoint("u1", [
                { path: "a.ts", before: { state: "absent" }, after: { state: "file", oid: OidA, executable: false } },
            ]);
            const authoritative = {
                schemaVersion: 1,
                sessionId: "session-1",
                operationId: "same-operation",
                workspaceIdentity: Workspace.workspaceIdentity,
                workspaceIncarnation: Workspace.workspaceIncarnation,
                kind: "redo",
                applyMode: "normal",
                forcedPaths: [],
                currentSnapshot: snapshot(OidA),
                currentStates: [{ path: "a.ts", state: { state: "file", oid: OidA, executable: false } }],
            } satisfies WorkspaceStateV1;
            const forged = {
                ...authoritative,
                ...(field === "currentSnapshot" ? { currentSnapshot: snapshot(OidD) } : {}),
                ...(field === "currentStates"
                    ? {
                          currentStates: [
                              { path: "a.ts", state: { state: "file" as const, oid: OidD, executable: false } },
                          ],
                      }
                    : {}),
            };
            const u1 = message("u1", null, "user");
            const c1 = custom("c1", "u1", WorkspaceControlCustomTypes.checkpoint, cp);
            const marker = custom("marker", "c1", WorkspaceControlCustomTypes.state, authoritative);

            const plan = await planRewind({
                sessionId: "session-1",
                workspace: Workspace,
                rawEntries: [u1, c1, marker],
                semanticLeafId: "marker",
                targetTurnId: "u1",
                currentWorkspaceState: forged,
                inspectLivePath: async () => ({ state: "absent", fingerprint: "absent" }),
                verifySnapshot: async () => {},
            });

            expect(plan.hardBlocked).toBe(true);
        }
    );

    it("hard-blocks a checkpoint owned by another session", async () => {
        const cp = { ...checkpoint("u1", []), originSessionId: "session-2" };
        const u1 = message("u1", null, "user");
        const c1 = custom("c1", "u1", WorkspaceControlCustomTypes.checkpoint, cp);

        const plan = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [u1, c1],
            semanticLeafId: "c1",
            targetTurnId: "u1",
            inspectLivePath: async () => ({ state: "absent", fingerprint: "absent" }),
            verifySnapshot: async () => {},
        });

        expect(plan.hardBlocked).toBe(true);
    });

    it("uses one batch inspection for the effective restore set", async () => {
        const changes = Array.from({ length: 128 }, (_, index) => ({
            path: `file-${index}`,
            before: { state: "absent" as const },
            after: { state: "file" as const, oid: OidA, executable: false },
        }));
        const cp = checkpoint("u1", changes);
        const u1 = message("u1", null, "user");
        const c1 = custom("c1", "u1", WorkspaceControlCustomTypes.checkpoint, cp);
        const inspectLivePaths = vi.fn(
            async (paths: string[]) =>
                new Map(
                    paths.map((path) => [
                        path,
                        {
                            state: "file" as const,
                            oid: OidA,
                            executable: false,
                            fingerprint: `fingerprint-${path}`,
                        },
                    ])
                )
        );

        const plan = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [u1, c1],
            semanticLeafId: "c1",
            targetTurnId: "u1",
            inspectLivePath: async () => {
                throw new Error("single-path fallback must not run");
            },
            inspectLivePaths,
            verifySnapshot: async () => {},
        });

        expect(plan.hardBlocked).toBe(false);
        expect(plan.paths).toHaveLength(128);
        expect(inspectLivePaths).toHaveBeenCalledTimes(1);
    });

    it("ignores corrupt and unavailable workspace state strictly before the target suffix", async () => {
        const u1 = message("u1", null, "user");
        const c1 = custom("c1", "u1", WorkspaceControlCustomTypes.checkpoint, checkpoint("u1", []));
        const unavailableSnapshot = snapshot(OidD);
        const preTargetStateData = {
            schemaVersion: 1,
            sessionId: "session-1",
            operationId: "pre-target",
            workspaceIdentity: Workspace.workspaceIdentity,
            workspaceIncarnation: Workspace.workspaceIncarnation,
            kind: "redo",
            applyMode: "normal",
            forcedPaths: [],
            currentSnapshot: unavailableSnapshot,
            currentStates: [],
        } satisfies WorkspaceStateV1;
        const preTargetState = custom("pre-target-state", "c1", WorkspaceControlCustomTypes.state, preTargetStateData);
        const malformed = custom("malformed-pre-target", "pre-target-state", WorkspaceControlCustomTypes.state, {
            schemaVersion: 1,
            sessionId: "session-1",
        });
        const u2 = message("u2", "malformed-pre-target", "user");
        const cp2 = checkpoint("u2", [
            { path: "a.ts", before: { state: "absent" }, after: { state: "file", oid: OidA, executable: false } },
        ]);
        const c2 = custom("c2", "u2", WorkspaceControlCustomTypes.checkpoint, cp2);
        const verifySnapshot = vi.fn(async (candidate: ReturnType<typeof snapshot>) => {
            if (candidate.id === unavailableSnapshot.id) {
                throw new Error("pre-target snapshot is unavailable");
            }
        });

        const plan = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [u1, c1, preTargetState, malformed, u2, c2],
            semanticLeafId: "c2",
            targetTurnId: "u2",
            currentWorkspaceState: preTargetStateData,
            inspectLivePath: async () => ({
                state: "file",
                oid: OidA,
                executable: false,
                fingerprint: "current-a",
            }),
            verifySnapshot,
        });

        expect(plan.hardBlocked).toBe(false);
        expect(verifySnapshot).not.toHaveBeenCalledWith(expect.objectContaining({ id: unavailableSnapshot.id }));
    });

    it.each([
        ["malformed", { schemaVersion: 1, sessionId: "session-1" }],
        [
            "foreign-session",
            {
                schemaVersion: 1,
                sessionId: "session-2",
                operationId: "foreign",
                workspaceIdentity: Workspace.workspaceIdentity,
                workspaceIncarnation: Workspace.workspaceIncarnation,
                kind: "redo",
                applyMode: "normal",
                forcedPaths: [],
                currentSnapshot: snapshot(OidA),
                currentStates: [],
            },
        ],
    ])("hard-blocks a %s workspace state inside the target suffix", async (_label, stateData) => {
        const u1 = message("u1", null, "user");
        const c1 = custom("c1", "u1", WorkspaceControlCustomTypes.checkpoint, checkpoint("u1", []));
        const state = custom("state", "c1", WorkspaceControlCustomTypes.state, stateData);

        const plan = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [u1, c1, state],
            semanticLeafId: "state",
            targetTurnId: "u1",
            inspectLivePath: async () => ({ state: "absent", fingerprint: "absent" }),
            verifySnapshot: async () => {},
        });

        expect(plan.hardBlocked).toBe(true);
    });

    it.each([
        ["path escape", "../outside", { state: "absent" as const, fingerprint: "absent" }],
        [
            "symlink ancestor",
            "safe/file",
            { state: "blocked" as const, reason: "path has a symlink ancestor", fingerprint: "blocked" },
        ],
        ["unsafe kind", "safe/file", { state: "unsafe" as const, kind: "socket", fingerprint: "unsafe" }],
        ["file-directory collision", "safe/file", { state: "directory" as const, empty: false, fingerprint: "dir" }],
    ])("hard-blocks %s", async (_label, path, liveState) => {
        const cp = checkpoint("u1", [
            { path, before: { state: "absent" }, after: { state: "file", oid: OidA, executable: false } },
        ]);
        const u1 = message("u1", null, "user");
        const c1 = custom("c1", "u1", WorkspaceControlCustomTypes.checkpoint, cp);

        const plan = await planRewind({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [u1, c1],
            semanticLeafId: "c1",
            targetTurnId: "u1",
            inspectLivePath: async () => liveState,
            verifySnapshot: async () => {},
        });

        expect(plan.hardBlocked).toBe(true);
        expect(plan.forceRequired).toBe(false);
    });

    it("offers redo only from the current same-session rewind marker and blocks all redo drift", async () => {
        const rewindState = {
            schemaVersion: 1,
            sessionId: "session-1",
            operationId: "rewind-op",
            workspaceIdentity: Workspace.workspaceIdentity,
            workspaceIncarnation: Workspace.workspaceIncarnation,
            kind: "rewind",
            applyMode: "normal",
            forcedPaths: [],
            currentSnapshot: snapshot(OidA),
            currentStates: [{ path: "a.ts", state: { state: "absent" } }],
            rewind: {
                fromLeafId: "assistant",
                targetTurnId: "u1",
                targetBoundaryId: null,
                redoSnapshot: snapshot(OidB),
                redoStates: [{ path: "a.ts", state: { state: "file", oid: OidA, executable: false } }],
            },
        } satisfies WorkspaceStateV1;
        const marker = custom("marker", "assistant", WorkspaceControlCustomTypes.state, rewindState);

        const clean = await planRedo({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [message("assistant", null, "assistant"), marker],
            semanticLeafId: "marker",
            rewindState,
            inspectLivePath: async () => ({ state: "absent", fingerprint: "absent" }),
            verifySnapshot: async () => {},
        });
        const drift = await planRedo({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [message("assistant", null, "assistant"), marker],
            semanticLeafId: "marker",
            rewindState,
            inspectLivePath: async () => ({ state: "file", oid: OidB, executable: false, fingerprint: "drift" }),
            verifySnapshot: async () => {},
        });
        const stale = await planRedo({
            sessionId: "session-1",
            workspace: Workspace,
            rawEntries: [message("assistant", null, "assistant"), marker, message("new", "marker", "user")],
            semanticLeafId: "new",
            rewindState,
            inspectLivePath: async () => ({ state: "absent", fingerprint: "absent" }),
            verifySnapshot: async () => {},
        });
        const otherSession = await planRedo({
            sessionId: "session-2",
            workspace: Workspace,
            rawEntries: [message("assistant", null, "assistant"), marker],
            semanticLeafId: "marker",
            rewindState,
            inspectLivePath: async () => ({ state: "absent", fingerprint: "absent" }),
            verifySnapshot: async () => {},
        });
        const forgedStates: Array<Extract<WorkspaceStateV1, { kind: "rewind" }>> = [
            { ...rewindState, currentSnapshot: snapshot(OidD) },
            {
                ...rewindState,
                currentStates: [{ path: "a.ts", state: { state: "file" as const, oid: OidD, executable: false } }],
            },
            {
                ...rewindState,
                rewind: { ...rewindState.rewind!, redoSnapshot: snapshot(OidD) },
            },
            {
                ...rewindState,
                rewind: {
                    ...rewindState.rewind!,
                    redoStates: [{ path: "a.ts", state: { state: "file" as const, oid: OidD, executable: false } }],
                },
            },
        ];
        const forged = await Promise.all(
            forgedStates.map((rewindState) =>
                planRedo({
                    sessionId: "session-1",
                    workspace: Workspace,
                    rawEntries: [message("assistant", null, "assistant"), marker],
                    semanticLeafId: "marker",
                    rewindState,
                    inspectLivePath: async () => ({ state: "absent", fingerprint: "absent" }),
                    verifySnapshot: async () => {},
                })
            )
        );

        expect(clean).toMatchObject({ hardBlocked: false, forceRequired: false, commitParentId: "assistant" });
        expect(drift).toMatchObject({ hardBlocked: true, forceRequired: false });
        expect(stale.hardBlocked).toBe(true);
        expect(otherSession.hardBlocked).toBe(true);
        expect(forged.every((plan) => plan.hardBlocked)).toBe(true);
    });
});
