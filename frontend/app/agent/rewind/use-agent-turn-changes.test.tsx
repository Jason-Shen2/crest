// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentRuntimeClient } from "@/app/agent/agent-runtime-client";
import type { PiTurn } from "@/app/store/use-pi-chat";
import { useAgentTurnChanges, type UseAgentTurnChangesOptions } from "./use-agent-turn-changes";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

function summary(turnId: string, fileCount = 1): AgentTurnChangeSummaryView {
    return {
        turnId,
        semanticLeafId: "leaf-1",
        fileCount,
        additions: fileCount ? 3 : 0,
        deletions: fileCount ? 1 : 0,
        files: fileCount ? [{ path: `${turnId}.tsx`, operation: "write", additions: 3, deletions: 1 }] : [],
    };
}

function fileRow(path = "turn-1.tsx"): AgentRewindFileRowView {
    return {
        path,
        operation: "write",
        additions: 3,
        deletions: 1,
        conflict: "none",
        coverage: "covered",
        diff: "@@ -1 +1 @@\n-old\n+new",
    };
}

function preview(kind: "turn-undo" | "turn-redo", turnId = "turn-1"): AgentTurnMutationPreviewResult {
    return {
        confirmationToken: "confirm-1",
        target:
            kind === "turn-undo"
                ? { kind, sourceTurnId: turnId }
                : { kind, sourceTurnId: turnId, undoOperationId: "undo-1" },
        semanticLeafId: "leaf-1",
        displayLeafId: "display-1",
        expectedSemanticLeafId: "leaf-1",
        fileCount: 1,
        files: [fileRow(`${turnId}.tsx`)],
        coverageWarnings: [],
        forceRequired: false,
        hardBlocked: false,
    };
}

function rewindState(
    turnChanges: AgentRewindSessionStateView["turnChanges"] = [{ turnId: "turn-1", action: "undo" }],
    overrides: Partial<AgentRewindSessionStateView> = {}
): AgentRewindSessionStateView {
    return {
        enabled: true,
        semanticLeafId: "leaf-1",
        displayLeafId: "display-1",
        eligibleTurnIds: turnChanges.map((change) => change.turnId),
        turnChanges,
        busy: false,
        frozen: false,
        quota: { status: "ok", usedBytes: 0, softQuotaBytes: 100, cleanupAvailable: false },
        ...overrides,
    };
}

function turn(turnId: string, status: PiTurn["status"] = "done"): PiTurn {
    return { turnId, responseMessages: [], status };
}

function client(overrides: Record<string, unknown> = {}) {
    return {
        getTurnChangeSummary: vi.fn(async (input: AgentTurnTargetInput) => summary(input.turnId)),
        reviewTurnChanges: vi.fn(async (input: AgentTurnTargetInput) => ({
            turnId: input.turnId,
            semanticLeafId: "leaf-1",
            files: [fileRow(`${input.turnId}.tsx`)],
        })),
        previewTurnUndo: vi.fn(async (input: AgentPreviewTurnMutationInput) => preview("turn-undo", input.turnId)),
        previewTurnRedo: vi.fn(async (input: AgentPreviewTurnMutationInput) => preview("turn-redo", input.turnId)),
        applyTurnUndo: vi.fn(async () => ({
            sessionMetadata: { id: "session-1", path: "/repo/session.jsonl", cwd: "/repo", createdAt: "now" },
            semanticLeafId: "leaf-1",
            displayLeafId: "display-1",
        })),
        applyTurnRedo: vi.fn(async () => ({
            sessionMetadata: { id: "session-1", path: "/repo/session.jsonl", cwd: "/repo", createdAt: "now" },
            semanticLeafId: "leaf-1",
            displayLeafId: "display-1",
        })),
        ...overrides,
    } as unknown as AgentRuntimeClient;
}

function options(overrides: Partial<UseAgentTurnChangesOptions> = {}): UseAgentTurnChangesOptions {
    return {
        client: client(),
        sessionMetadata: { id: "session-1", path: "/repo/session.jsonl", cwd: "/repo", createdAt: "now" },
        sessionRevision: 1,
        rewindState: rewindState(),
        turns: [turn("turn-1")],
        running: false,
        onError: vi.fn(),
        ...overrides,
    };
}

describe("useAgentTurnChanges", () => {
    it("retries a transient summary failure without caching a permanent absence", async () => {
        const getTurnChangeSummary = vi
            .fn()
            .mockRejectedValueOnce(new Error("temporary read failure"))
            .mockResolvedValueOnce(summary("turn-1"));
        const runtime = client({ getTurnChangeSummary });
        const onError = vi.fn();
        const { result } = renderHook(() => useAgentTurnChanges(options({ client: runtime, onError })));

        await waitFor(() => expect(getTurnChangeSummary).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(result.current.cards.has("turn-1")).toBe(true));
        expect(onError).not.toHaveBeenCalled();
    });

    it("bounds summary retries and reports only the terminal failure", async () => {
        const getTurnChangeSummary = vi.fn(async () => Promise.reject(new Error("snapshot temporarily busy")));
        const runtime = client({ getTurnChangeSummary });
        const onError = vi.fn();
        const initial = options({ client: runtime, onError });
        const { result } = renderHook((props: UseAgentTurnChangesOptions) => useAgentTurnChanges(props), {
            initialProps: initial,
        });

        await waitFor(() => expect(getTurnChangeSummary).toHaveBeenCalledTimes(3));
        await waitFor(() => expect(onError).toHaveBeenCalledOnce());
        expect(result.current.cards.size).toBe(0);
    });

    it("cancels a scheduled summary retry when the session changes", async () => {
        const first = deferred<AgentTurnChangeSummaryView>();
        const getTurnChangeSummary = vi.fn(() => first.promise);
        const runtime = client({ getTurnChangeSummary });
        const initial = options({ client: runtime });
        const { rerender } = renderHook((props: UseAgentTurnChangesOptions) => useAgentTurnChanges(props), {
            initialProps: initial,
        });
        await waitFor(() => expect(getTurnChangeSummary).toHaveBeenCalledOnce());
        await act(async () => first.reject(new Error("temporary read failure")));

        const sessionTwo = {
            ...initial,
            sessionMetadata: { id: "session-2", path: "/repo/other.jsonl", cwd: "/repo", createdAt: "now" },
            sessionRevision: 2,
            rewindState: rewindState([], { semanticLeafId: "leaf-2" }),
            turns: [],
        };
        rerender(sessionTwo);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(getTurnChangeSummary).toHaveBeenCalledOnce();
    });

    it("loads only available completed turns and omits zero-change summaries", async () => {
        const runtime = client({
            getTurnChangeSummary: vi.fn(async (input: AgentTurnTargetInput) => summary(input.turnId, 0)),
        });
        const { result } = renderHook(() =>
            useAgentTurnChanges(
                options({
                    client: runtime,
                    turns: [turn("turn-1"), turn("turn-streaming", "streaming"), turn("turn-history")],
                    rewindState: rewindState([
                        { turnId: "turn-1", action: "undo" },
                        { turnId: "turn-streaming", action: "undo" },
                    ]),
                })
            )
        );

        await waitFor(() => expect(runtime.getTurnChangeSummary).toHaveBeenCalledOnce());
        await waitFor(() => expect(result.current.cards.size).toBe(0));
        expect(runtime.getTurnChangeSummary).toHaveBeenCalledWith({
            sessionMetadata: expect.objectContaining({ path: "/repo/session.jsonl" }),
            expectedSemanticLeafId: "leaf-1",
            turnId: "turn-1",
        });
    });

    it("fences stale summary responses by session, semantic leaf, and turn", async () => {
        const first = deferred<AgentTurnChangeSummaryView>();
        const runtime = client({ getTurnChangeSummary: vi.fn(() => first.promise) });
        const initial = options({ client: runtime });
        const { result, rerender } = renderHook((props: UseAgentTurnChangesOptions) => useAgentTurnChanges(props), {
            initialProps: initial,
        });
        await waitFor(() => expect(runtime.getTurnChangeSummary).toHaveBeenCalledOnce());

        rerender({
            ...initial,
            sessionRevision: 2,
            rewindState: rewindState([], { semanticLeafId: "leaf-2" }),
            turns: [],
        });
        await act(async () => first.resolve(summary("turn-1")));

        expect(result.current.cards.size).toBe(0);
    });

    it("opens forward review without a mutation token", async () => {
        const runtime = client();
        const { result } = renderHook(() => useAgentTurnChanges(options({ client: runtime })));
        await waitFor(() => expect(result.current.cards.has("turn-1")).toBe(true));

        await act(async () => result.current.openReview("turn-1"));

        expect(runtime.reviewTurnChanges).toHaveBeenCalledWith({
            sessionMetadata: expect.objectContaining({ path: "/repo/session.jsonl" }),
            expectedSemanticLeafId: "leaf-1",
            turnId: "turn-1",
        });
        expect(result.current.dialog).toMatchObject({ open: true, kind: "review", phase: "ready" });
        expect(result.current.dialog.files[0].diff).toContain("-old\n+new");
    });

    it("waits for authoritative turn action before releasing undo and isolates other turns", async () => {
        const runtime = client();
        const initial = options({
            client: runtime,
            turns: [turn("turn-1"), turn("turn-2")],
            rewindState: rewindState([
                { turnId: "turn-1", action: "undo" },
                { turnId: "turn-2", action: "undo" },
            ]),
        });
        const { result, rerender } = renderHook((props: UseAgentTurnChangesOptions) => useAgentTurnChanges(props), {
            initialProps: initial,
        });
        await waitFor(() => expect(result.current.cards.size).toBe(2));

        await act(async () => result.current.openMutation("turn-1"));
        expect(result.current.dialog.kind).toBe("undo");
        await act(async () => result.current.confirmMutation("normal"));

        expect(runtime.applyTurnUndo).toHaveBeenCalledWith(
            expect.objectContaining({ turnId: "turn-1", confirmationToken: "confirm-1" })
        );
        expect(result.current.awaitingAuthoritativeAck).toBe(true);
        expect(result.current.controlsDisabled).toBe(true);
        expect(result.current.cards.get("turn-1")?.action).toBe("undo");
        expect(result.current.cards.get("turn-2")?.action).toBe("undo");

        rerender({
            ...initial,
            rewindState: rewindState([
                { turnId: "turn-1", action: "redo", undoOperationId: "undo-1" },
                { turnId: "turn-2", action: "undo" },
            ]),
        });
        await waitFor(() => expect(result.current.awaitingAuthoritativeAck).toBe(false));
        expect(result.current.cards.get("turn-1")?.action).toBe("redo");
        expect(result.current.cards.get("turn-2")?.action).toBe("undo");
    });

    it("preserves an in-flight apply across semantic leaf advance until its turn action is acknowledged", async () => {
        const apply = deferred<AgentRewindMutationResult>();
        const runtime = client({ applyTurnUndo: vi.fn(() => apply.promise) });
        const initial = options({ client: runtime });
        const { result, rerender } = renderHook((props: UseAgentTurnChangesOptions) => useAgentTurnChanges(props), {
            initialProps: initial,
        });
        await waitFor(() => expect(result.current.cards.has("turn-1")).toBe(true));
        await act(async () => result.current.openMutation("turn-1"));
        let applying!: Promise<void>;
        act(() => {
            applying = result.current.confirmMutation("normal");
        });
        await waitFor(() => expect(runtime.applyTurnUndo).toHaveBeenCalledOnce());

        rerender({
            ...initial,
            rewindState: rewindState(undefined, { semanticLeafId: "leaf-2", displayLeafId: "display-2" }),
        });
        expect(result.current.awaitingAuthoritativeAck).toBe(true);
        expect(result.current.dialog.phase).toBe("applying");

        await act(async () => {
            apply.resolve({
                sessionMetadata: initial.sessionMetadata!,
                semanticLeafId: "leaf-2",
                displayLeafId: "display-2",
            });
            await applying;
        });
        expect(result.current.awaitingAuthoritativeAck).toBe(true);
        expect(result.current.dialog.open).toBe(true);

        rerender({
            ...initial,
            rewindState: rewindState([{ turnId: "turn-1", action: "redo", undoOperationId: "undo-1" }], {
                semanticLeafId: "leaf-2",
                displayLeafId: "display-2",
            }),
        });
        await waitFor(() => expect(result.current.awaitingAuthoritativeAck).toBe(false));
        expect(result.current.dialog.open).toBe(false);
    });

    it.each(["success", "error"] as const)(
        "cancels an old apply on session revision advance and ignores its late %s",
        async (completion) => {
            const apply = deferred<AgentRewindMutationResult>();
            const runtime = client({ applyTurnUndo: vi.fn(() => apply.promise) });
            const onError = vi.fn();
            const initial = options({ client: runtime, onError });
            const { result, rerender } = renderHook((props: UseAgentTurnChangesOptions) => useAgentTurnChanges(props), {
                initialProps: initial,
            });
            await waitFor(() => expect(result.current.cards.has("turn-1")).toBe(true));
            await act(async () => result.current.openMutation("turn-1"));
            act(() => void result.current.confirmMutation("normal"));
            await waitFor(() => expect(runtime.applyTurnUndo).toHaveBeenCalledOnce());

            rerender({ ...initial, sessionRevision: 2 });
            expect(result.current.awaitingAuthoritativeAck).toBe(false);
            expect(result.current.dialog.open).toBe(false);

            await act(async () => {
                if (completion === "success") {
                    apply.resolve({
                        sessionMetadata: initial.sessionMetadata!,
                        semanticLeafId: "leaf-after-old-apply",
                        displayLeafId: "display-after-old-apply",
                    });
                    return;
                }
                apply.reject(new Error("old revision apply failed"));
            });
            expect(result.current.awaitingAuthoritativeAck).toBe(false);
            expect(result.current.dialog.open).toBe(false);
            expect(onError).not.toHaveBeenCalledWith("old revision apply failed");
        }
    );

    it("does not unlock after an unrelated leaf advance and safely ignores completion after a session switch", async () => {
        const apply = deferred<AgentRewindMutationResult>();
        const runtime = client({ applyTurnUndo: vi.fn(() => apply.promise) });
        const initial = options({ client: runtime });
        const { result, rerender } = renderHook((props: UseAgentTurnChangesOptions) => useAgentTurnChanges(props), {
            initialProps: initial,
        });
        await waitFor(() => expect(result.current.cards.has("turn-1")).toBe(true));
        await act(async () => result.current.openMutation("turn-1"));
        act(() => void result.current.confirmMutation("normal"));
        await waitFor(() => expect(runtime.applyTurnUndo).toHaveBeenCalledOnce());

        rerender({ ...initial, rewindState: rewindState(undefined, { semanticLeafId: "unrelated-leaf" }) });
        expect(result.current.awaitingAuthoritativeAck).toBe(true);
        expect(result.current.controlsDisabled).toBe(true);

        rerender({
            ...initial,
            sessionMetadata: { id: "session-2", path: "/repo/other.jsonl", cwd: "/repo", createdAt: "now" },
            sessionRevision: 3,
            rewindState: rewindState([], { semanticLeafId: "other-leaf" }),
            turns: [],
        });
        expect(result.current.awaitingAuthoritativeAck).toBe(false);
        expect(result.current.dialog.open).toBe(false);
        await act(async () => apply.reject(new Error("old session apply failed after switch")));
        expect(initial.onError).not.toHaveBeenCalledWith("old session apply failed after switch");
    });

    it("fences a rapidly replaced review dialog and executes redo with its authoritative undo id", async () => {
        const review = deferred<AgentReviewTurnChangesResult>();
        const runtime = client({ reviewTurnChanges: vi.fn(() => review.promise) });
        const state = rewindState([{ turnId: "turn-1", action: "redo", undoOperationId: "undo-1" }]);
        const { result } = renderHook(() => useAgentTurnChanges(options({ client: runtime, rewindState: state })));
        await waitFor(() => expect(result.current.cards.has("turn-1")).toBe(true));

        act(() => void result.current.openReview("turn-1"));
        await waitFor(() => expect(runtime.reviewTurnChanges).toHaveBeenCalledOnce());
        await act(async () => result.current.openMutation("turn-1"));
        expect(runtime.previewTurnRedo).toHaveBeenCalledWith(
            expect.objectContaining({ turnId: "turn-1", undoOperationId: "undo-1" })
        );
        expect(result.current.dialog.kind).toBe("redo");

        await act(async () => review.resolve({ turnId: "turn-1", semanticLeafId: "leaf-1", files: [fileRow()] }));
        expect(result.current.dialog.kind).toBe("redo");

        await act(async () => result.current.confirmMutation("force-drift"));
        expect(runtime.applyTurnRedo).not.toHaveBeenCalled();
        await act(async () => result.current.confirmMutation("normal"));
        expect(runtime.applyTurnRedo).toHaveBeenCalledWith(
            expect.objectContaining({ turnId: "turn-1", undoOperationId: "undo-1", mode: "normal" })
        );
    });

    it("keeps the mutation dialog open with its error and disables controls during unsafe states", async () => {
        const runtime = client({ applyTurnUndo: vi.fn(async () => Promise.reject(new Error("disk changed"))) });
        const { result, rerender } = renderHook((props: UseAgentTurnChangesOptions) => useAgentTurnChanges(props), {
            initialProps: options({ client: runtime }),
        });
        await waitFor(() => expect(result.current.cards.has("turn-1")).toBe(true));
        await act(async () => result.current.openMutation("turn-1"));
        await act(async () => result.current.confirmMutation("normal"));

        expect(result.current.dialog).toMatchObject({ open: true, kind: "undo", phase: "error" });
        expect(result.current.dialog.errorMessage).toBe("disk changed");

        rerender(options({ client: runtime, running: true }));
        expect(result.current.cards.get("turn-1")?.disabled).toBe(true);
        rerender(options({ client: runtime, rewindState: rewindState(undefined, { busy: true }) }));
        expect(result.current.cards.get("turn-1")?.disabled).toBe(true);
        rerender(options({ client: runtime, rewindState: rewindState(undefined, { frozen: true }) }));
        expect(result.current.cards.get("turn-1")?.disabled).toBe(true);
    });
});
