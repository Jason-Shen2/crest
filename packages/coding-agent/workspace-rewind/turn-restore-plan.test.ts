// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makeCommittedContextTransaction } from "@crest/agent/harness/session/context-transaction-fixture";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { RewindConfirmationRegistry } from "./confirmation-token";
import { planTurnRedo, planTurnUndo } from "./turn-restore-plan";
import type { CapturedPathStateV1, WorkspaceCheckpointV1, WorkspaceStateV1 } from "./types";
import { WorkspaceControlCustomTypes } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import type { WorkspaceMutationLog } from "./workspace-mutation-log";

const OidA = "a".repeat(40);
const OidB = "b".repeat(40);
const OidC = "c".repeat(40);
const OidD = "d".repeat(40);

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

function leaf(targetId: string): SessionTreeEntry {
    return { type: "leaf", id: "leaf", parentId: targetId, timestamp: "t-leaf", targetId };
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
    changes: Array<{ path: string; before: CapturedPathStateV1; after: CapturedPathStateV1 }>,
    overrides: Partial<Extract<WorkspaceCheckpointV1, { status: "available" }>> = {}
): Extract<WorkspaceCheckpointV1, { status: "available" }> {
    return {
        schemaVersion: 1,
        status: "available",
        originSessionId: "session-1",
        turnId: "u1",
        workspaceIdentity: Workspace.workspaceIdentity,
        workspaceIncarnation: Workspace.workspaceIncarnation,
        before: snapshot(`${OidA.slice(0, -1)}1`),
        after: snapshot(`${OidB.slice(0, -1)}1`),
        changes,
        coverage: { complete: true, eligibleEntryCount: changes.length, newlyHashedBytes: 0, exclusions: [] },
        ...overrides,
    };
}

function turnState(kind: "turn-undo" | "turn-redo", operationId: string, undoOperationId?: string): WorkspaceStateV1 {
    return {
        schemaVersion: 1,
        sessionId: "session-1",
        operationId,
        workspaceIdentity: Workspace.workspaceIdentity,
        workspaceIncarnation: Workspace.workspaceIncarnation,
        kind,
        sourceTurnId: "u1",
        ...(kind === "turn-redo" ? { undoOperationId: undoOperationId! } : {}),
        applyMode: "normal",
        forcedPaths: [],
        currentSnapshot: snapshot(OidC),
        currentStates: [],
    } as WorkspaceStateV1;
}

function branch(checkpointValue: WorkspaceCheckpointV1, tail: SessionTreeEntry[] = []): SessionTreeEntry[] {
    const user = message("u1", null, "user");
    const assistant = message("a1", user.id, "assistant");
    const checkpointEntry = custom("c1", assistant.id, WorkspaceControlCustomTypes.checkpoint, checkpointValue);
    const entries = [user, assistant, checkpointEntry];
    let parentId = checkpointEntry.id;
    for (const entry of tail) {
        entry.parentId = parentId;
        entries.push(entry);
        parentId = entry.id;
    }
    return [...entries, leaf(parentId)];
}

function live(state: CapturedPathStateV1) {
    if (state.state === "file") return { ...state, fingerprint: `${state.oid}:${state.executable}` };
    if (state.state === "symlink") return { ...state, fingerprint: state.oid };
    return { state: "absent" as const, fingerprint: "absent" };
}

type TestMutationLog = Pick<WorkspaceMutationLog, "read" | "findForeignOverlap">;

function mutationLog(
    overrides: Partial<{
        mutation: Awaited<ReturnType<WorkspaceMutationLog["read"]>>;
        overlaps: Awaited<ReturnType<WorkspaceMutationLog["findForeignOverlap"]>>;
    }> = {}
): TestMutationLog {
    return {
        read: vi.fn(
            async () =>
                overrides.mutation ?? {
                    parent: `${OidA.slice(0, -1)}1`,
                    tree: OidA,
                    metadata: {
                        schemaversion: 1 as const,
                        workspaceidentity: Workspace.workspaceIdentity,
                        workspaceincarnation: Workspace.workspaceIncarnation,
                        kind: "agent-turn" as const,
                        sessionid: "session-1",
                        turnid: "u1",
                    },
                }
        ),
        findForeignOverlap: vi.fn(async () => overrides.overlaps ?? []),
    };
}

function baseInput(
    entries: SessionTreeEntry[],
    liveStates: Record<string, ReturnType<typeof live>>,
    history: TestMutationLog = mutationLog()
) {
    return {
        sessionId: "session-1",
        workspace: Workspace,
        rawEntries: entries,
        semanticLeafId: entries.at(-2)!.id,
        sourceTurnId: "u1",
        inspectLivePath: vi.fn(async (path: string) => liveStates[path]!),
        verifySnapshot: vi.fn(async () => {}),
        mutationLog: history,
    };
}

describe("per-turn restore planning", () => {
    it.each([
        ["kind", { kind: "external" }],
        ["owner", { sessionid: "session-2" }],
        ["turn", { turnid: "u2" }],
        ["parent", { parent: OidD }],
    ] as const)("hard-blocks changed checkpoints with malformed %s authority", async (_label, override) => {
        const change = {
            path: "a.ts",
            before: { state: "file", oid: OidA, executable: false } as const,
            after: { state: "file", oid: OidB, executable: false } as const,
        };
        const history = mutationLog();
        vi.mocked(history.read).mockResolvedValueOnce({
            parent: `${OidA.slice(0, -1)}1`,
            tree: OidA,
            metadata: {
                schemaversion: 1,
                workspaceidentity: Workspace.workspaceIdentity,
                workspaceincarnation: Workspace.workspaceIncarnation,
                kind: "agent-turn",
                sessionid: "session-1",
                turnid: "u1",
            },
            ...("parent" in override ? { parent: override.parent } : {}),
            ...("parent" in override
                ? {}
                : {
                      metadata: {
                          schemaversion: 1,
                          workspaceidentity: Workspace.workspaceIdentity,
                          workspaceincarnation: Workspace.workspaceIncarnation,
                          kind: "agent-turn",
                          sessionid: "session-1",
                          turnid: "u1",
                          ...override,
                      },
                  }),
        });
        const input = baseInput(branch(checkpoint([change])), { "a.ts": live(change.after) }, history);

        const plan = await planTurnUndo(input);

        expect(plan.hardBlocked).toBe(true);
        expect(input.inspectLivePath).not.toHaveBeenCalled();
        expect(history.findForeignOverlap).not.toHaveBeenCalled();
    });

    it("accepts a no-change checkpoint without requiring an agent-turn commit", async () => {
        const unchanged = checkpoint([], { after: snapshot(`${OidA.slice(0, -1)}1`) });
        const history = mutationLog();
        vi.mocked(history.read).mockRejectedValue(new Error("must not read a no-change mutation"));

        const plan = await planTurnUndo(baseInput(branch(unchanged), {}, history));

        expect(plan.hardBlocked).toBe(false);
        expect(history.read).not.toHaveBeenCalled();
        expect(history.findForeignOverlap).not.toHaveBeenCalled();
    });

    it("validates an agent-turn commit when only snapshot semantics changed", async () => {
        const history = mutationLog({
            mutation: {
                parent: `${OidA.slice(0, -1)}1`,
                tree: OidA,
                metadata: {
                    schemaversion: 1,
                    workspaceidentity: Workspace.workspaceIdentity,
                    workspaceincarnation: Workspace.workspaceIncarnation,
                    kind: "external",
                },
            },
        });

        const plan = await planTurnUndo(baseInput(branch(checkpoint([])), {}, history));

        expect(plan.hardBlocked).toBe(true);
        expect(history.read).toHaveBeenCalledWith(`${OidB.slice(0, -1)}1`);
    });

    it("hard-blocks a later Crest-owned same-path mutation before inspecting live bytes", async () => {
        const change = {
            path: "a.ts",
            before: { state: "file", oid: OidA, executable: false } as const,
            after: { state: "file", oid: OidB, executable: false } as const,
        };
        const history = mutationLog({
            overlaps: [{ commit: OidD, path: "a.ts", sessionId: "session-2" }],
        });
        const input = baseInput(branch(checkpoint([change])), { "a.ts": live(change.before) }, history);

        const plan = await planTurnUndo(input);

        expect(history.findForeignOverlap).toHaveBeenCalledWith({
            afterCommit: `${OidB.slice(0, -1)}1`,
            paths: ["a.ts"],
            includedCommits: new Set(),
            ownerSessionId: "session-1",
        });
        expect(vi.mocked(history.findForeignOverlap).mock.invocationCallOrder[0]).toBeLessThan(
            input.inspectLivePath.mock.invocationCallOrder[0]
        );
        expect(plan).toMatchObject({ hardBlocked: true, forceRequired: false });
        expect(plan.paths).toEqual([expect.objectContaining({ path: "a.ts", conflict: "hard-blocker" })]);
    });

    it("keeps external same-path drift forceable when the path is present in the preview", async () => {
        const change = {
            path: "a.ts",
            before: { state: "file", oid: OidA, executable: false } as const,
            after: { state: "file", oid: OidB, executable: false } as const,
        };
        const history = mutationLog({ overlaps: [{ commit: OidD, path: "a.ts" }] });

        const plan = await planTurnUndo(
            baseInput(
                branch(checkpoint([change])),
                { "a.ts": live({ state: "file", oid: OidC, executable: false }) },
                history
            )
        );

        expect(plan).toMatchObject({ hardBlocked: false, forceRequired: true });
        expect(plan.paths).toEqual([expect.objectContaining({ path: "a.ts", conflict: "forceable-drift" })]);
    });

    it("plans Undo from checkpoint after to before and Redo from before to after", async () => {
        const change = {
            path: "a.ts",
            before: { state: "file", oid: OidA, executable: false } as const,
            after: { state: "file", oid: OidB, executable: false } as const,
        };
        const undoEntries = branch(checkpoint([change]));
        const undo = await planTurnUndo(baseInput(undoEntries, { "a.ts": live(change.after) }));

        expect(undo).toMatchObject({
            target: { kind: "turn-undo", sourceTurnId: "u1" },
            semanticLeafId: "c1",
            commitParentId: "c1",
            forceRequired: false,
            hardBlocked: false,
        });
        expect(undo.paths).toEqual([
            expect.objectContaining({ path: "a.ts", expectedCurrent: change.after, target: change.before }),
        ]);

        const undoMarker = custom(
            "undo-marker",
            null,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", "undo-operation-1")
        );
        const redoEntries = branch(checkpoint([change]), [undoMarker]);
        const redo = await planTurnRedo({
            ...baseInput(redoEntries, { "a.ts": live(change.before) }),
            undoOperationId: "undo-operation-1",
        });

        expect(redo).toMatchObject({
            target: { kind: "turn-redo", sourceTurnId: "u1", undoOperationId: "undo-operation-1" },
            semanticLeafId: "undo-marker",
            commitParentId: "undo-marker",
            forceRequired: false,
            hardBlocked: false,
        });
        expect(redo.paths).toEqual([
            expect.objectContaining({ path: "a.ts", expectedCurrent: change.before, target: change.after }),
        ]);
    });

    it("omits paths already at the target and classifies regular-file drift consistently", async () => {
        const changes = [
            {
                path: "clean.ts",
                before: { state: "file", oid: OidA, executable: false } as const,
                after: { state: "file", oid: OidB, executable: false } as const,
            },
            {
                path: "already.ts",
                before: { state: "file", oid: OidA, executable: false } as const,
                after: { state: "file", oid: OidB, executable: false } as const,
            },
            {
                path: "drift.ts",
                before: { state: "file", oid: OidA, executable: false } as const,
                after: { state: "file", oid: OidB, executable: false } as const,
            },
        ];
        const plan = await planTurnUndo(
            baseInput(branch(checkpoint(changes)), {
                "clean.ts": live(changes[0]!.after),
                "already.ts": live(changes[1]!.before),
                "drift.ts": live({ state: "file", oid: OidC, executable: false }),
            })
        );

        expect(plan.paths.map((item) => item.path)).toEqual(["clean.ts", "drift.ts"]);
        expect(plan.paths[0]!.conflict).toBe("none");
        expect(plan.paths[1]).toMatchObject({
            conflict: "forceable-drift",
            reason: "files changed on disk since the agent last wrote them",
        });
        expect(plan.forceRequired).toBe(true);
        expect(plan.hardBlocked).toBe(false);
    });

    it("hard-blocks every Redo drift and permits force only for Undo forceable drift", async () => {
        const change = {
            path: "a.ts",
            before: { state: "file", oid: OidA, executable: false } as const,
            after: { state: "file", oid: OidB, executable: false } as const,
        };
        const undo = await planTurnUndo(
            baseInput(branch(checkpoint([change])), {
                "a.ts": live({ state: "file", oid: OidC, executable: false }),
            })
        );
        expect(undo).toMatchObject({ forceRequired: true, hardBlocked: false });

        const marker = custom(
            "undo-marker",
            null,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", "undo-operation-1")
        );
        const redo = await planTurnRedo({
            ...baseInput(branch(checkpoint([change]), [marker]), {
                "a.ts": live({ state: "file", oid: OidC, executable: false }),
            }),
            undoOperationId: "undo-operation-1",
        });
        expect(redo).toMatchObject({ forceRequired: false, hardBlocked: true });
        expect(redo.paths[0]).toMatchObject({ conflict: "hard-blocker" });
    });

    it("requires the current last source-turn marker to point at the requested Undo operation", async () => {
        const change = {
            path: "a.ts",
            before: { state: "file", oid: OidA, executable: false } as const,
            after: { state: "file", oid: OidB, executable: false } as const,
        };
        const wrongUndo = custom(
            "wrong-undo",
            null,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", "undo-operation-2")
        );
        const plan = await planTurnRedo({
            ...baseInput(branch(checkpoint([change]), [wrongUndo]), { "a.ts": live(change.before) }),
            undoOperationId: "undo-operation-1",
        });

        expect(plan.hardBlocked).toBe(true);
        expect(plan.coverageWarnings).toEqual([
            expect.objectContaining({ reason: expect.stringMatching(/current.*undoOperationId/i) }),
        ]);
    });

    it("uses the legal turn-mutation state machine for Redo authority", async () => {
        const change = {
            path: "a.ts",
            before: { state: "file", oid: OidA, executable: false } as const,
            after: { state: "file", oid: OidB, executable: false } as const,
        };
        const firstUndo = custom(
            "undo-1",
            null,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", "undo-operation-1")
        );
        const duplicateUndo = custom(
            "undo-2",
            null,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", "undo-operation-2")
        );
        const duplicateEntries = branch(checkpoint([change]), [firstUndo, duplicateUndo]);
        const input = baseInput(duplicateEntries, { "a.ts": live(change.before) });

        expect(
            (
                await planTurnRedo({
                    ...input,
                    undoOperationId: "undo-operation-1",
                })
            ).hardBlocked
        ).toBe(false);
        expect(
            (
                await planTurnRedo({
                    ...input,
                    undoOperationId: "undo-operation-2",
                })
            ).hardBlocked
        ).toBe(true);

        const matchingRedo = custom(
            "redo-1",
            null,
            WorkspaceControlCustomTypes.state,
            turnState("turn-redo", "redo-operation-1", "undo-operation-1")
        );
        const redoneEntries = branch(checkpoint([change]), [firstUndo, duplicateUndo, matchingRedo]);
        const redoneInput = baseInput(redoneEntries, { "a.ts": live(change.before) });
        for (const undoOperationId of ["undo-operation-1", "undo-operation-2"]) {
            expect((await planTurnRedo({ ...redoneInput, undoOperationId })).hardBlocked).toBe(true);
        }
    });

    it("blocks duplicate Undo until a matching Redo returns authority to Undo", async () => {
        const change = {
            path: "a.ts",
            before: { state: "file", oid: OidA, executable: false } as const,
            after: { state: "file", oid: OidB, executable: false } as const,
        };
        const undoMarker = custom(
            "undo-1",
            null,
            WorkspaceControlCustomTypes.state,
            turnState("turn-undo", "undo-operation-1")
        );
        const duplicate = await planTurnUndo(
            baseInput(branch(checkpoint([change]), [undoMarker]), {
                "a.ts": live({ state: "file", oid: OidC, executable: false }),
            })
        );

        expect(duplicate).toMatchObject({ hardBlocked: true, forceRequired: false, paths: [] });
        expect(() => new RewindConfirmationRegistry().issue(duplicate)).toThrow(/blocked/i);

        const redoMarker = custom(
            "redo-1",
            null,
            WorkspaceControlCustomTypes.state,
            turnState("turn-redo", "redo-operation-1", "undo-operation-1")
        );
        const restored = await planTurnUndo(
            baseInput(branch(checkpoint([change]), [undoMarker, redoMarker]), {
                "a.ts": live(change.after),
            })
        );
        expect(restored).toMatchObject({ hardBlocked: false, forceRequired: false });
        expect(restored.paths).toEqual([
            expect.objectContaining({ path: "a.ts", expectedCurrent: change.after, target: change.before }),
        ]);
    });

    it.each([
        ["session", { originSessionId: "session-2" }, /session/i],
        ["workspace", { workspaceIdentity: "workspace-2" }, /identity/i],
        ["incarnation", { workspaceIncarnation: "incarnation-2" }, /incarnation/i],
    ] as const)("hard-blocks a checkpoint with the wrong %s", async (_label, overrides, reason) => {
        const plan = await planTurnUndo(baseInput(branch(checkpoint([], overrides)), {}));
        expect(plan.hardBlocked).toBe(true);
        expect(plan.coverageWarnings[0]!.reason).toMatch(reason);
    });

    it("validates active branch membership, terminal uniqueness, canonical paths, and readable snapshots", async () => {
        const noncanonical = checkpoint([
            { path: "../escape", before: { state: "absent" }, after: { state: "file", oid: OidA, executable: false } },
        ]);
        const base = branch(noncanonical);
        const inactive = await planTurnUndo({ ...baseInput(base, {}), sourceTurnId: "other" });
        expect(inactive.hardBlocked).toBe(true);

        const extraCheckpoint = custom("c2", null, WorkspaceControlCustomTypes.checkpoint, checkpoint([]));
        const duplicate = await planTurnUndo(baseInput(branch(checkpoint([]), [extraCheckpoint]), {}));
        expect(duplicate.hardBlocked).toBe(true);

        const afterCheckpoint = message("late", null, "assistant");
        const nonterminal = await planTurnUndo(baseInput(branch(checkpoint([]), [afterCheckpoint]), {}));
        expect(nonterminal.hardBlocked).toBe(true);

        const canonical = await planTurnUndo(baseInput(base, {}));
        expect(canonical.hardBlocked).toBe(true);
        expect(canonical.coverageWarnings[0]!.reason).toMatch(/invalid|canonical/i);

        const readableEntries = branch(checkpoint([]));
        const readableInput = baseInput(readableEntries, {});
        readableInput.verifySnapshot.mockRejectedValueOnce(new Error("missing object"));
        const unreadable = await planTurnUndo(readableInput);
        expect(unreadable.hardBlocked).toBe(true);
        expect(unreadable.coverageWarnings[0]!.reason).toMatch(/unavailable.*missing object/i);
    });

    it("hard-blocks multiple visible checkpoint entries before decoding or checking ownership", async () => {
        const own = checkpoint([]);
        const foreign = custom(
            "foreign-checkpoint",
            null,
            WorkspaceControlCustomTypes.checkpoint,
            checkpoint([], { originSessionId: "session-2" })
        );
        const invalid = custom("invalid-checkpoint", null, WorkspaceControlCustomTypes.checkpoint, {
            schemaVersion: 1,
        });

        for (const second of [foreign, invalid]) {
            const plan = await planTurnUndo(baseInput(branch(own, [second]), {}));
            expect(plan.hardBlocked).toBe(true);
            expect(plan.coverageWarnings[0]!.reason).toMatch(/not unique/i);
        }
    });

    it("keeps explicit workspace exclusions as warnings while planning covered turn changes", async () => {
        const own = checkpoint(
            [{ path: "own.ts", before: { state: "absent" }, after: { state: "file", oid: OidA, executable: false } }],
            {
                coverage: {
                    complete: false,
                    eligibleEntryCount: 1,
                    newlyHashedBytes: 0,
                    exclusions: [
                        { path: ".DS_Store", reason: "ignored" },
                        { path: ".git", reason: "nested-repository" },
                        { path: ".vite", reason: "ignored" },
                        { path: "node_modules", reason: "ignored" },
                    ],
                },
            }
        );
        const input = baseInput(branch(own), {
            "own.ts": live({ state: "file", oid: OidA, executable: false }),
        });
        const plan = await planTurnUndo(input);

        expect(plan.hardBlocked).toBe(false);
        expect(plan.paths).toEqual([
            expect.objectContaining({
                path: "own.ts",
                expectedCurrent: own.changes[0]!.after,
                target: own.changes[0]!.before,
            }),
        ]);
        expect(input.inspectLivePath).toHaveBeenCalledWith("own.ts");
        expect(plan.coverageWarnings).toEqual([
            { path: ".DS_Store", reason: "ignored" },
            { path: ".git", reason: "nested-repository" },
            { path: ".vite", reason: "ignored" },
            { path: "node_modules", reason: "ignored" },
        ]);
        expect(() => new RewindConfirmationRegistry().issue(plan)).not.toThrow();
    });

    it("hard-blocks unexplained incomplete checkpoint coverage and cannot issue a confirmation", async () => {
        const own = checkpoint(
            [{ path: "own.ts", before: { state: "absent" }, after: { state: "file", oid: OidA, executable: false } }],
            {
                coverage: {
                    complete: false,
                    eligibleEntryCount: 1,
                    newlyHashedBytes: 0,
                    exclusions: [],
                },
            }
        );
        const input = baseInput(branch(own), {
            "own.ts": live({ state: "file", oid: OidA, executable: false }),
        });
        const plan = await planTurnUndo(input);

        expect(plan.hardBlocked).toBe(true);
        expect(input.inspectLivePath).not.toHaveBeenCalled();
        expect(plan.coverageWarnings).toContainEqual({
            path: "",
            reason: "workspace checkpoint coverage is incomplete",
        });
        expect(() => new RewindConfirmationRegistry().issue(plan)).toThrow(/blocked/i);
    });

    it.each([
        [{ pathBytesBase64: "/w==", reason: "non-utf8-path" }],
        [{ scope: "workspace-root", reason: "capture-budget" }],
    ] as const)("hard-blocks an unaddressable checkpoint coverage exclusion", async (exclusion) => {
        const own = checkpoint(
            [{ path: "own.ts", before: { state: "absent" }, after: { state: "file", oid: OidA, executable: false } }],
            {
                coverage: {
                    complete: false,
                    eligibleEntryCount: 1,
                    newlyHashedBytes: 0,
                    exclusions: [exclusion],
                },
            }
        );
        const input = baseInput(branch(own), {
            "own.ts": live({ state: "file", oid: OidA, executable: false }),
        });
        const plan = await planTurnUndo(input);

        expect(plan.hardBlocked).toBe(true);
        expect(input.inspectLivePath).not.toHaveBeenCalled();
        expect(() => new RewindConfirmationRegistry().issue(plan)).toThrow(/blocked/i);
    });

    it.each(["before", "after"] as const)("hard-blocks a path excluded from %s coverage", async (side) => {
        const excluded = { state: "excluded", reason: "ignored" } as const;
        const covered = { state: "file", oid: OidA, executable: false } as const;
        const value = checkpoint([
            {
                path: "excluded.ts",
                before: side === "before" ? excluded : covered,
                after: side === "after" ? excluded : covered,
            },
        ]);
        const plan = await planTurnUndo(baseInput(branch(value), { "excluded.ts": live(covered) }));

        expect(plan.hardBlocked).toBe(true);
        expect(plan.coverageWarnings).toEqual([
            expect.objectContaining({ path: "excluded.ts", reason: expect.stringMatching(/excluded/i) }),
        ]);
    });

    it("treats the next prepared turn transaction as outside the source turn", async () => {
        const source = message("u1", null, "user");
        const checkpointEntry = custom("c1", source.id, WorkspaceControlCustomTypes.checkpoint, checkpoint([]));
        const nextTransaction = makeCommittedContextTransaction({ parentId: checkpointEntry.id, prefix: "next" });
        const entries = [source, checkpointEntry, ...nextTransaction];
        const plan = await planTurnUndo({
            ...baseInput(entries, {}),
            semanticLeafId: nextTransaction.at(-1)!.id,
        });

        expect(plan.hardBlocked).toBe(false);
    });
});
