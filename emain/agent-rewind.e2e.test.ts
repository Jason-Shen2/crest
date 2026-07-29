// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata } from "@crest/agent/harness/types";
import type {
    AgentCheckpointQuotaView,
    AgentRewindPreviewResult,
    AgentRewindSessionStateView,
    AgentWorkspaceRecoveryView,
} from "@crest/coding-agent/workspace-rewind/api-types";
import { describe, expect, it } from "vitest";

import { AgentRuntimeClient } from "../frontend/app/agent/agent-runtime-client";

const Metadata: JsonlSessionMetadata = {
    id: "session-e2e",
    path: "/sessions/session-e2e.db",
    cwd: "/workspace",
    createdAt: "2026-07-30T00:00:00.000Z",
};

type ConflictMode = "clean" | "drift" | "hard-blocker";

function makeMainCoordinator() {
    const subscribers = new Set<(event: unknown) => void>();
    const softQuotaBytes = 5 * 1024 ** 3;
    let workspaceBytes = "before";
    let workspaceRevision = 0;
    let semanticLeafId: string | null = null;
    let displayLeafId: string | null = null;
    let eligibleTurnIds: string[] = [];
    let conflictMode: ConflictMode = "clean";
    let frozen = false;
    let crashedBoundary = false;
    let redo: AgentRewindSessionStateView["redo"];
    let quota: AgentCheckpointQuotaView = {
        status: "ok",
        usedBytes: 1024,
        softQuotaBytes,
        cleanupAvailable: false,
    };
    let owners = [
        {
            sessionId: "trash-session",
            title: "Deleted task",
            referencedBytes: 6 * 1024 ** 3,
            confirmationToken: "purge-token",
        },
    ];
    const confirmations = new Map<string, number>();
    const calls = {
        snapshots: 0,
        treeNavigations: 0,
        recoveryActions: [] as string[],
    };

    const rewindState = (): AgentRewindSessionStateView => ({
        enabled: true,
        semanticLeafId,
        displayLeafId,
        eligibleTurnIds,
        busy: false,
        frozen,
        quota,
        ...(redo ? { redo } : {}),
    });
    const publish = () => {
        const event = {
            type: "session_state",
            status: "idle",
            queuedMessages: [],
            commands: [],
            rewindState: rewindState(),
        };
        for (const subscriber of subscribers) subscriber(event);
    };
    const preview = (target: AgentRewindPreviewResult["target"]): AgentRewindPreviewResult => {
        const token = `confirmation-${confirmations.size + 1}`;
        confirmations.set(token, workspaceRevision);
        return {
            ...(conflictMode === "hard-blocker" || frozen ? {} : { confirmationToken: token }),
            target,
            targetPrompt: "Original user prompt",
            semanticLeafId,
            displayLeafId,
            expectedSemanticLeafId: semanticLeafId,
            messageCount: 2,
            fileCount: 1,
            files: [
                {
                    path: "src/changed.ts",
                    operation: "write",
                    coverage: "covered",
                    conflict:
                        conflictMode === "clean"
                            ? "none"
                            : conflictMode === "drift"
                              ? "forceable-drift"
                              : "hard-blocker",
                },
            ],
            coverageWarnings:
                conflictMode === "hard-blocker" ? ["src/changed.ts: directory collision cannot be forced"] : [],
            forceRequired: conflictMode === "drift",
            hardBlocked: conflictMode === "hard-blocker" || frozen,
        };
    };
    const api = {
        subscribe: (_identity: unknown, _path: string, callback: (event: unknown) => void) => {
            subscribers.add(callback);
            publish();
            return () => subscribers.delete(callback);
        },
        getSessionState: async () => ({
            type: "session_state",
            status: "idle",
            queuedMessages: [],
            commands: [],
            rewindState: rewindState(),
        }),
        send: async (_identity: unknown, options: { sessionMetadata: JsonlSessionMetadata; message: unknown }) => {
            const turnId = `turn-${workspaceRevision + 1}`;
            semanticLeafId = turnId;
            displayLeafId = turnId;
            workspaceBytes = "after";
            workspaceRevision++;
            calls.snapshots += crashedBoundary ? 1 : 2;
            if (!crashedBoundary) eligibleTurnIds = [turnId];
            publish();
            return { sessionMetadata: options.sessionMetadata };
        },
        listRewindPoints: async () => ({
            points: eligibleTurnIds.map((turnId) => ({
                turnId,
                preview: "Original user prompt",
                eligible: true,
            })),
            semanticLeafId,
            displayLeafId,
        }),
        previewRewind: async (_identity: unknown, input: { target: AgentRewindPreviewResult["target"] }) =>
            preview(input.target),
        rewindTree: async (
            _identity: unknown,
            input: {
                sessionMetadata: JsonlSessionMetadata;
                mode: "normal" | "force-drift";
                confirmationToken: string;
            }
        ) => {
            if (frozen) throw new Error("Workspace recovery is required; Force is unavailable");
            if (confirmations.get(input.confirmationToken) !== workspaceRevision) {
                throw new Error("Workspace changed after restore confirmation");
            }
            if (conflictMode === "drift" && input.mode !== "force-drift") {
                throw new Error("Force confirmation is required");
            }
            if (conflictMode === "hard-blocker") throw new Error("Hard blocker cannot be forced");
            workspaceBytes = "before";
            workspaceRevision++;
            semanticLeafId = "rewind-leaf";
            displayLeafId = null;
            redo = {
                operationId: "rewind-operation",
                targetPrompt: "Original user prompt",
                messageCount: 2,
                fileCount: 1,
                files: [],
            };
            publish();
            return {
                sessionMetadata: input.sessionMetadata,
                semanticLeafId,
                displayLeafId,
                editorText: "Original user prompt",
            };
        },
        redoRewind: async (
            _identity: unknown,
            input: { sessionMetadata: JsonlSessionMetadata; confirmationToken: string }
        ) => {
            if (confirmations.get(input.confirmationToken) !== workspaceRevision) {
                throw new Error("Workspace changed after restore confirmation");
            }
            workspaceBytes = "after";
            workspaceRevision++;
            semanticLeafId = "redo-leaf";
            displayLeafId = "turn-1";
            redo = undefined;
            publish();
            return { sessionMetadata: input.sessionMetadata, semanticLeafId, displayLeafId };
        },
        getWorkspaceRecovery: async (): Promise<AgentWorkspaceRecoveryView | undefined> =>
            frozen
                ? {
                      operationId: "crashed-operation",
                      phase: "applying_files",
                      corrupt: false,
                      message: "Recovery required",
                      paths: [{ path: "src/changed.ts", classification: "unknown" }],
                      allowedActions: ["retry", "abandon-current"],
                  }
                : undefined,
        resolveWorkspaceRecovery: async (_identity: unknown, input: { action: string }) => {
            calls.recoveryActions.push(input.action);
            frozen = false;
            publish();
        },
        cleanupWorkspaceCheckpoints: async () => {
            quota = {
                status: "referenced-over-quota",
                usedBytes: 6 * 1024 ** 3,
                softQuotaBytes,
                cleanupAvailable: true,
            };
            publish();
            return { removedUnownedBytes: 4096, quota };
        },
        listCheckpointStorageOwners: async () => ({ trashOwners: owners }),
        purgeTrashedSession: async (
            _identity: unknown,
            input: { trashedSessionId: string; confirmationToken: string }
        ) => {
            if (input.confirmationToken !== owners[0]?.confirmationToken) throw new Error("Stale purge token");
            owners = owners.filter((owner) => owner.sessionId !== input.trashedSessionId);
            quota = { status: "ok", usedBytes: 1024, softQuotaBytes, cleanupAvailable: false };
            publish();
            return { purgedSessionId: input.trashedSessionId, quota };
        },
        listTree: async () => {
            calls.treeNavigations++;
            return [{ id: semanticLeafId, type: "message" }];
        },
        navigateTree: async () => {
            calls.treeNavigations++;
            semanticLeafId = "conversation-only-leaf";
            publish();
            return { sessionMetadata: Metadata, semanticLeafId, displayLeafId };
        },
    };
    return {
        api,
        calls,
        client: () => new AgentRuntimeClient(api as never, { workspaceId: "workspace-e2e", generation: 1 }),
        state: () => ({ workspaceBytes, workspaceRevision, rewindState: rewindState(), owners }),
        setConflictMode(mode: ConflictMode) {
            conflictMode = mode;
        },
        externalWrite(bytes: string) {
            workspaceBytes = bytes;
            workspaceRevision++;
        },
        setFrozen(value: boolean) {
            frozen = value;
            publish();
        },
        setCrashBoundary(value: boolean) {
            crashedBoundary = value;
        },
    };
}

describe("Agent rewind renderer-to-main E2E contract", () => {
    it("sends, previews, applies, restores the composer, persists the redo dock across reload, and redoes", async () => {
        const main = makeMainCoordinator();
        const client = main.client();
        const received: unknown[] = [];
        client.subscribe(Metadata.path, (event) => received.push(event));
        await client.send({ sessionMetadata: Metadata, message: { role: "user", content: "change it" } } as never);
        const points = await client.listRewindPoints({ sessionMetadata: Metadata });
        const planned = await client.previewRewind({
            sessionMetadata: Metadata,
            expectedSemanticLeafId: points.semanticLeafId,
            target: { kind: "rewind", targetTurnId: points.points[0].turnId },
        });
        const result = await client.rewindTree({
            sessionMetadata: Metadata,
            expectedSemanticLeafId: planned.expectedSemanticLeafId,
            targetTurnId: points.points[0].turnId,
            mode: "normal",
            confirmationToken: planned.confirmationToken!,
        });

        expect(result.editorText).toBe("Original user prompt");
        expect(main.state().workspaceBytes).toBe("before");
        expect(main.state().rewindState.redo?.targetPrompt).toBe("Original user prompt");
        const reloadedClient = main.client();
        expect(await reloadedClient.getSessionState(Metadata as never)).toMatchObject({
            rewindState: { redo: { targetPrompt: "Original user prompt" } },
        });
        const redoPreview = await reloadedClient.previewRewind({
            sessionMetadata: Metadata,
            expectedSemanticLeafId: result.semanticLeafId,
            target: { kind: "redo" },
        });
        await reloadedClient.redoRewind({
            sessionMetadata: Metadata,
            expectedSemanticLeafId: result.semanticLeafId,
            confirmationToken: redoPreview.confirmationToken!,
        });
        expect(main.state().workspaceBytes).toBe("after");
        expect(main.state().rewindState.redo).toBeUndefined();
        expect(received.length).toBeGreaterThanOrEqual(3);
    });

    it("enforces stale-token, Force, hard-blocker, and recovery-without-Force boundaries", async () => {
        const main = makeMainCoordinator();
        const client = main.client();
        await client.send({ sessionMetadata: Metadata, message: "change" } as never);
        const point = (await client.listRewindPoints({ sessionMetadata: Metadata })).points[0];
        const stale = await client.previewRewind({
            sessionMetadata: Metadata,
            expectedSemanticLeafId: "turn-1",
            target: { kind: "rewind", targetTurnId: point.turnId },
        });
        main.externalWrite("post-preview writer");
        await expect(
            client.rewindTree({
                sessionMetadata: Metadata,
                expectedSemanticLeafId: "turn-1",
                targetTurnId: point.turnId,
                mode: "force-drift",
                confirmationToken: stale.confirmationToken!,
            })
        ).rejects.toThrow(/changed after restore confirmation/i);

        main.setConflictMode("drift");
        const drift = await client.previewRewind({
            sessionMetadata: Metadata,
            expectedSemanticLeafId: "turn-1",
            target: { kind: "rewind", targetTurnId: point.turnId },
        });
        expect(drift.forceRequired).toBe(true);
        await client.rewindTree({
            sessionMetadata: Metadata,
            expectedSemanticLeafId: "turn-1",
            targetTurnId: point.turnId,
            mode: "force-drift",
            confirmationToken: drift.confirmationToken!,
        });

        main.setConflictMode("hard-blocker");
        const blocked = await client.previewRewind({
            sessionMetadata: Metadata,
            expectedSemanticLeafId: "rewind-leaf",
            target: { kind: "rewind", targetTurnId: point.turnId },
        });
        expect(blocked.hardBlocked).toBe(true);
        expect(blocked).not.toHaveProperty("confirmationToken");
        main.setFrozen(true);
        expect(await client.getWorkspaceRecovery({ sessionMetadata: Metadata })).toMatchObject({
            operationId: "crashed-operation",
            allowedActions: ["retry", "abandon-current"],
        });
        const recoveryPreview = await client.previewRewind({
            sessionMetadata: Metadata,
            expectedSemanticLeafId: "rewind-leaf",
            target: { kind: "rewind", targetTurnId: point.turnId },
        });
        expect(recoveryPreview.confirmationToken).toBeUndefined();
        expect(JSON.stringify(await client.getWorkspaceRecovery({ sessionMetadata: Metadata }))).not.toMatch(/force/i);
    });

    it("surfaces crash gaps and quota ownership while keeping /tree conversation-only", async () => {
        const main = makeMainCoordinator();
        const client = main.client();
        main.setCrashBoundary(true);
        await client.send({ sessionMetadata: Metadata, message: "crash mid-turn" } as never);
        expect((await client.listRewindPoints({ sessionMetadata: Metadata })).points).toEqual([]);
        expect(main.calls.snapshots).toBe(1);

        main.setFrozen(true);
        await client.resolveWorkspaceRecovery({
            sessionMetadata: Metadata,
            operationId: "crashed-operation",
            action: "retry",
        });
        expect(main.calls.recoveryActions).toEqual(["retry"]);
        const cleanup = await client.cleanupWorkspaceCheckpoints({ sessionMetadata: Metadata });
        expect(cleanup.quota).toMatchObject({
            status: "referenced-over-quota",
            softQuotaBytes: 5 * 1024 ** 3,
        });
        const owner = (await client.listCheckpointStorageOwners({ sessionMetadata: Metadata })).trashOwners[0];
        await client.purgeTrashedSession({
            sessionMetadata: Metadata,
            trashedSessionId: owner.sessionId,
            confirmationToken: owner.confirmationToken,
        });
        expect(main.state().owners).toEqual([]);
        expect(main.state().rewindState.quota.status).toBe("ok");

        const beforeTree = main.state().workspaceBytes;
        const snapshotsBeforeTree = main.calls.snapshots;
        await client.listTree(Metadata as never);
        await client.navigateTree({ sessionMetadata: Metadata, leafId: "conversation-only-leaf" } as never);
        expect(main.state().workspaceBytes).toBe(beforeTree);
        expect(main.calls.snapshots).toBe(snapshotsBeforeTree);
        expect(main.calls.treeNavigations).toBe(2);
    });
});
