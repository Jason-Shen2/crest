// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, SessionTreeEntry } from "@crest/agent/harness/types";
import { describe, expect, it, vi } from "vitest";

import { RewindConfirmationRegistry } from "@crest/coding-agent/workspace-rewind/confirmation-token";
import type { RestorePlanV1 } from "@crest/coding-agent/workspace-rewind/restore-plan";
import { WorkspaceControlCustomTypes, type WorkspaceCheckpointV1 } from "@crest/coding-agent/workspace-rewind/types";
import { AgentRewindService } from "./agent-rewind-service";

const Identity = "1".repeat(64);
const Incarnation = "2".repeat(64);
const Metadata: JsonlSessionMetadata = {
    id: "session-1",
    cwd: "/workspace",
    path: "/sessions/session-1.db",
    createdAt: "2026-07-29T00:00:00.000Z",
};
const Workspace = {
    canonicalRoot: "/workspace",
    workspaceIdentity: Identity,
    workspaceIncarnation: Incarnation,
    storeKey: "workspace",
    ancestorIdentityChain: [],
};
const Snapshot = {
    id: "a".repeat(40),
    tree: "b".repeat(40),
    scopeManifest: "c".repeat(40),
    workspaceIdentity: Identity,
    workspaceIncarnation: Incarnation,
};
const LinkedSourceSnapshot = { ...Snapshot, id: "d".repeat(40) };
const LinkedResultSnapshot = { ...Snapshot, id: "e".repeat(40) };

function linkedOperation(operationId: string) {
    return {
        operationId,
        sourceSnapshot: LinkedSourceSnapshot,
        currentSnapshot: LinkedResultSnapshot,
    };
}

function plan(): RestorePlanV1 {
    return {
        target: { kind: "rewind", targetTurnId: "turn-1" },
        sessionId: Metadata.id,
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        semanticLeafId: "checkpoint-1",
        commitParentId: null,
        paths: [],
        coverageWarnings: [],
        forceRequired: false,
        hardBlocked: false,
    };
}

function branch(): SessionTreeEntry[] {
    const checkpoint: WorkspaceCheckpointV1 = {
        schemaVersion: 1,
        status: "available",
        originSessionId: Metadata.id,
        turnId: "turn-1",
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        before: Snapshot,
        after: Snapshot,
        changes: [],
        coverage: {
            complete: true,
            eligibleEntryCount: 1,
            newlyHashedBytes: 0,
            exclusions: [],
        },
    };
    return [
        {
            type: "message",
            id: "turn-1",
            parentId: null,
            timestamp: "2026-07-29T00:00:00.000Z",
            message: {
                role: "user",
                content: [
                    { type: "text", text: "original " },
                    { type: "image", data: "ignored", mimeType: "image/png" },
                    { type: "text", text: "prompt" },
                ],
                timestamp: 0,
            },
        } as SessionTreeEntry,
        {
            type: "custom",
            id: "checkpoint-1",
            parentId: "turn-1",
            timestamp: "2026-07-29T00:00:01.000Z",
            customType: WorkspaceControlCustomTypes.checkpoint,
            data: checkpoint,
        },
    ];
}

function harness(options: { rejectOpenSessionWith?: Error; release?: () => Promise<void> } = {}) {
    const order: string[] = [];
    const confirmations = new RewindConfirmationRegistry();
    const sessionEntries = branch();
    const session = {
        getEntries: vi.fn(async () => sessionEntries),
        getEntry: vi.fn(async (id: string) => sessionEntries.find((entry) => entry.id === id)),
        getLeafId: vi.fn(async () => "checkpoint-1"),
        close: vi.fn(),
    };
    const registry = {
        withSessionAccess: vi.fn(async (_path, operation) => {
            order.push("session-access");
            try {
                return await operation({ path: Metadata.path, token: Symbol("access") });
            } finally {
                order.push("release-session-access");
            }
        }),
        withRetainedSessionMutation: vi.fn(async (_path, _options, operation) => {
            order.push("session-lease");
            try {
                return await operation({ path: Metadata.path, token: Symbol("lease") });
            } finally {
                order.push("release-session-lease");
            }
        }),
    };
    const store = {
        withWorkspaceLock: vi.fn(async (operation) => {
            order.push("workspace-lock");
            try {
                return await operation();
            } finally {
                order.push("release-workspace-lock");
            }
        }),
    };
    const previewResult = {
        confirmationToken: "preview-token",
        target: { kind: "rewind" as const, targetTurnId: "turn-1" },
        targetPrompt: "original prompt",
        semanticLeafId: "checkpoint-1",
        displayLeafId: "turn-1",
        expectedSemanticLeafId: "checkpoint-1",
        messageCount: 1,
        fileCount: 0,
        files: [],
        coverageWarnings: [],
        forceRequired: false,
        hardBlocked: false,
    };
    let publishState: (() => Promise<void>) | undefined;
    const engine = {
        getTurnChangeSummary: vi.fn(async () => ({
            turnId: "turn-1",
            semanticLeafId: "checkpoint-1",
            fileCount: 0,
            additions: 0,
            deletions: 0,
            files: [],
        })),
        getTurnFileDiff: vi.fn(async () => ({
            turnId: "turn-1",
            path: "file.txt",
            operation: "write" as const,
            additions: 0,
            deletions: 0,
            originalContent: "",
            modifiedContent: "",
            isBinary: false,
            fallbackPatch: "",
            truncated: false,
        })),
        reviewTurnChanges: vi.fn(async () => ({
            turnId: "turn-1",
            semanticLeafId: "checkpoint-1",
            files: [],
        })),
        previewRewind: vi.fn(async () => previewResult),
        previewRedo: vi.fn(async () => ({
            ...previewResult,
            target: {
                kind: "redo" as const,
                sourceRewindOperationId: "rewind-1",
                linkedOperation: linkedOperation("rewind-1"),
            },
        })),
        previewTurnUndo: vi.fn(async () => {
            const target = { kind: "turn-undo" as const, sourceTurnId: "turn-1" };
            return {
                ...previewResult,
                confirmationToken: confirmations.issue({ ...plan(), target }),
                target,
            };
        }),
        previewTurnRedo: vi.fn(async () => {
            const target = {
                kind: "turn-redo" as const,
                sourceTurnId: "turn-1",
                undoOperationId: "undo-1",
                linkedOperation: linkedOperation("undo-1"),
            };
            return {
                ...previewResult,
                confirmationToken: confirmations.issue({ ...plan(), target }),
                target,
            };
        }),
        applyRewind: vi.fn(async () => {
            order.push("engine-apply");
            await publishState?.();
            return {
                sessionMetadata: Metadata,
                semanticLeafId: "operation-leaf",
                displayLeafId: null,
                editorText: "original prompt",
            };
        }),
        applyRedo: vi.fn(async () => {
            order.push("engine-redo");
            await publishState?.();
            return {
                sessionMetadata: Metadata,
                semanticLeafId: "redo-leaf",
                displayLeafId: "checkpoint-1",
            };
        }),
        applyTurnUndo: vi.fn(async () => {
            order.push("engine-turn-undo");
            await publishState?.();
            return {
                sessionMetadata: Metadata,
                semanticLeafId: "turn-undo-leaf",
                displayLeafId: "checkpoint-1",
            };
        }),
        applyTurnRedo: vi.fn(async () => {
            order.push("engine-turn-redo");
            await publishState?.();
            return {
                sessionMetadata: Metadata,
                semanticLeafId: "turn-redo-leaf",
                displayLeafId: "checkpoint-1",
            };
        }),
    };
    const broadcaster = {
        publishForLease: vi.fn(async () => {
            order.push("broadcast");
        }),
    };
    const service = new AgentRewindService({
        registry: registry as never,
        confirmations,
        openSession: vi.fn(async () => {
            if (options.rejectOpenSessionWith) throw options.rejectOpenSessionWith;
            return session as never;
        }),
        resolveWorkspace: vi.fn(async (input) => {
            if ("publishState" in input) publishState = input.publishState;
            return {
                workspace: Workspace,
                store: store as never,
                engine: engine as never,
                ...(options.release ? { release: options.release } : {}),
            };
        }),
        broadcaster: broadcaster as never,
    });
    return {
        service,
        confirmations,
        session,
        registry,
        store,
        engine,
        broadcaster,
        order,
        getPublishState: () => publishState,
    };
}

describe("AgentRewindService", () => {
    it("releases the resolved workspace when opening the session fails", async () => {
        const openError = new Error("open failed");
        const release = vi.fn(async () => {});
        const value = harness({ rejectOpenSessionWith: openError, release });

        await expect(value.service.listPoints({ sessionMetadata: Metadata })).rejects.toBe(openError);

        expect(release).toHaveBeenCalledOnce();
        expect(value.session.close).not.toHaveBeenCalled();
    });

    it("releases the resolved workspace when closing the session fails", async () => {
        const closeError = new Error("close failed");
        const release = vi.fn(async () => {});
        const value = harness({ release });
        value.session.close.mockImplementation(() => {
            throw closeError;
        });

        await expect(value.service.listPoints({ sessionMetadata: Metadata })).rejects.toBe(closeError);

        expect(release).toHaveBeenCalledOnce();
    });

    it("lists transaction-safe points from the authoritative raw leaf under the short lock order", async () => {
        const value = harness();

        const result = await value.service.listPoints({ sessionMetadata: Metadata });

        expect(result).toEqual({
            points: [
                {
                    turnId: "turn-1",
                    preview: "original prompt",
                    timestamp: "2026-07-29T00:00:00.000Z",
                    eligible: true,
                },
            ],
            semanticLeafId: "checkpoint-1",
            displayLeafId: "turn-1",
        });
        expect(value.getPublishState()).toHaveLength(0);
        expect(value.order).toEqual(["session-lease", "release-session-lease"]);
    });

    it.each(["rewind", "redo"] as const)("previews %s without safety, journal, or mutation writes", async (kind) => {
        const value = harness();

        const preview = await value.service.preview({
            sessionMetadata: Metadata,
            expectedSemanticLeafId: "checkpoint-1",
            target: kind === "rewind" ? { kind, targetTurnId: "turn-1" } : { kind },
        });

        expect(preview.target).toEqual(kind === "rewind" ? { kind, targetTurnId: "turn-1" } : { kind });
        expect(kind === "rewind" ? value.engine.previewRewind : value.engine.previewRedo).toHaveBeenCalledOnce();
        expect(value.engine.applyRewind).not.toHaveBeenCalled();
        expect(value.engine.applyRedo).not.toHaveBeenCalled();
        expect(value.order).toEqual(["session-lease", "release-session-lease"]);
    });

    it("consumes the confirmation and broadcasts inside the retained session mutation", async () => {
        const value = harness();
        const token = value.confirmations.issue(plan());
        const originalTake = value.confirmations.take.bind(value.confirmations);
        vi.spyOn(value.confirmations, "take").mockImplementation((valueToken, now) => {
            value.order.push("consume-token");
            return originalTake(valueToken, now);
        });

        const result = await value.service.rewind({
            sessionMetadata: Metadata,
            expectedSemanticLeafId: "checkpoint-1",
            targetTurnId: "turn-1",
            mode: "normal",
            confirmationToken: token,
        });

        expect(result.editorText).toBe("original prompt");
        expect(value.order).toEqual([
            "session-lease",
            "consume-token",
            "engine-apply",
            "broadcast",
            "release-session-lease",
        ]);
        expect(value.broadcaster.publishForLease).toHaveBeenCalledOnce();
        expect(value.broadcaster.publishForLease).toHaveBeenCalledWith(expect.any(Object), Metadata);
        expect(value.session.close).toHaveBeenCalledOnce();
    });

    it("offers redo only in normal mode and uses the same retained publication path", async () => {
        const value = harness();
        const redoPlan = {
            ...plan(),
            target: {
                kind: "redo" as const,
                sourceRewindOperationId: "rewind-1",
                linkedOperation: linkedOperation("rewind-1"),
            },
        };
        const token = value.confirmations.issue(redoPlan);

        const result = await value.service.redo({
            sessionMetadata: Metadata,
            expectedSemanticLeafId: "checkpoint-1",
            confirmationToken: token,
        });

        expect(result).toMatchObject({ semanticLeafId: "redo-leaf" });
        expect(value.engine.applyRedo).toHaveBeenCalledWith(
            expect.objectContaining({
                semanticLeafId: "checkpoint-1",
                confirmation: expect.objectContaining({
                    plan: expect.objectContaining({ target: expect.objectContaining({ kind: "redo" }) }),
                }),
            })
        );
        expect(value.order).toEqual(["session-lease", "engine-redo", "broadcast", "release-session-lease"]);
    });

    it("revalidates current authorization inside the retained session mutation before consuming", async () => {
        const value = harness();
        const token = value.confirmations.issue(plan());
        const assertCurrent = vi.fn(async () => {
            throw new Error("stale sender");
        });

        await expect(
            value.service.rewind(
                {
                    sessionMetadata: Metadata,
                    expectedSemanticLeafId: "checkpoint-1",
                    targetTurnId: "turn-1",
                    mode: "normal",
                    confirmationToken: token,
                },
                assertCurrent
            )
        ).rejects.toThrow(/stale sender/);

        expect(value.engine.applyRewind).not.toHaveBeenCalled();
        expect(value.confirmations.take(token)).toBeDefined();
        expect(value.order).toEqual(["session-lease", "release-session-lease"]);
    });

    it.each(["summary", "diff", "review"] as const)(
        "serves immutable turn %s without issuing or consuming a confirmation",
        async (kind) => {
            const value = harness();
            const issue = vi.spyOn(value.confirmations, "issue");
            const take = vi.spyOn(value.confirmations, "take");
            const input = {
                sessionMetadata: Metadata,
                expectedSemanticLeafId: "checkpoint-1",
                turnId: "turn-1",
            };

            if (kind === "summary") await value.service.getTurnChangeSummary(input);
            if (kind === "diff") await value.service.getTurnFileDiff({ ...input, path: "file.txt" });
            if (kind === "review") await value.service.reviewTurnChanges(input);

            expect(value.engine.getTurnChangeSummary).toHaveBeenCalledTimes(kind === "summary" ? 1 : 0);
            expect(value.engine.getTurnFileDiff).toHaveBeenCalledTimes(kind === "diff" ? 1 : 0);
            expect(value.engine.reviewTurnChanges).toHaveBeenCalledTimes(kind === "review" ? 1 : 0);
            expect(issue).not.toHaveBeenCalled();
            expect(take).not.toHaveBeenCalled();
            expect(value.order).toEqual(["session-access", "release-session-access"]);
            expect(value.store.withWorkspaceLock).not.toHaveBeenCalled();
        }
    );

    it.each(["undo", "redo"] as const)(
        "previews and applies turn %s under retained session mutation with one-shot confirmation and publication",
        async (kind) => {
            const value = harness();
            const previewInput = {
                sessionMetadata: Metadata,
                expectedSemanticLeafId: "checkpoint-1",
                turnId: "turn-1",
                ...(kind === "redo" ? { undoOperationId: "undo-1" } : {}),
            };
            const preview =
                kind === "undo"
                    ? await value.service.previewTurnUndo(previewInput)
                    : await value.service.previewTurnRedo(previewInput);
            const token = preview.confirmationToken!;
            const applyInput = {
                ...previewInput,
                mode: "normal" as const,
                confirmationToken: token,
            };

            const result =
                kind === "undo"
                    ? await value.service.applyTurnUndo(applyInput)
                    : await value.service.applyTurnRedo(applyInput);

            expect(preview.target).toEqual(
                kind === "undo"
                    ? { kind: "turn-undo", sourceTurnId: "turn-1" }
                    : { kind: "turn-redo", sourceTurnId: "turn-1", undoOperationId: "undo-1" }
            );
            expect(preview).not.toHaveProperty("messageCount");
            expect(preview).not.toHaveProperty("targetPrompt");
            expect(result.semanticLeafId).toBe(kind === "undo" ? "turn-undo-leaf" : "turn-redo-leaf");
            expect(value.broadcaster.publishForLease).toHaveBeenCalledOnce();
            const applied = kind === "undo" ? value.engine.applyTurnUndo : value.engine.applyTurnRedo;
            const confirmedTarget =
                kind === "undo"
                    ? preview.target
                    : expect.objectContaining({
                          kind: "turn-redo",
                          sourceTurnId: "turn-1",
                          undoOperationId: "undo-1",
                          linkedOperation: linkedOperation("undo-1"),
                      });
            expect(applied).toHaveBeenCalledWith(
                expect.objectContaining({
                    confirmation: expect.objectContaining({
                        binding: expect.objectContaining({ target: confirmedTarget }),
                    }),
                })
            );
            expect(() => value.confirmations.take(token)).toThrow(/already consumed/i);
            expect(value.order).toEqual([
                "session-lease",
                "release-session-lease",
                "session-lease",
                `engine-turn-${kind}`,
                "broadcast",
                "release-session-lease",
            ]);
        }
    );

    it("requires undoOperationId for turn redo and rejects force redo before consuming a token", async () => {
        const value = harness();
        await expect(
            value.service.previewTurnRedo({
                sessionMetadata: Metadata,
                expectedSemanticLeafId: "checkpoint-1",
                turnId: "turn-1",
            })
        ).rejects.toThrow(/undoOperationId/i);

        const token = value.confirmations.issue({
            ...plan(),
            target: {
                kind: "turn-redo",
                sourceTurnId: "turn-1",
                undoOperationId: "undo-1",
                linkedOperation: linkedOperation("undo-1"),
            },
        });
        await expect(
            value.service.applyTurnRedo({
                sessionMetadata: Metadata,
                expectedSemanticLeafId: "checkpoint-1",
                turnId: "turn-1",
                undoOperationId: "undo-1",
                mode: "force-drift",
                confirmationToken: token,
            })
        ).rejects.toThrow(/force/i);
        expect(value.confirmations.take(token)).toBeDefined();
    });
});
