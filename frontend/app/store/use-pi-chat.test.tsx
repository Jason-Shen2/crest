// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    adoptInitialSessionMetadata,
    attachContextReportsToTurns,
    composerRestoreTextFromSendError,
    getOptimisticAbortStatus,
    type PiAgentEvent,
    type PiAgentMessage,
    type PiTurn,
    reducePiChatEvent,
    reducePiTurnsEvent,
    resolveAbortSessionPath,
    usePiChat,
} from "./use-pi-chat";

function makeSession(path = "/sessions/target.jsonl"): AgentSessionMeta {
    return { path, id: path, cwd: "/workspace", createdAt: "2026-07-25T00:00:00.000Z" } as AgentSessionMeta;
}

function makeDraft(id: string, targetSessionPath = "/sessions/target.jsonl"): AgentContextDraftView {
    return {
        draftId: id,
        targetSessionPath,
        provenance: {
            sourceKind: "turn",
            sourceSessionId: `source-${id}`,
            sourceSessionPath: `/sessions/source-${id}.jsonl`,
            sourceCwd: "/workspace",
            sourceTurnId: `turn-${id}`,
            sourceLeafId: `leaf-${id}`,
            sourceMessageEntryIds: [`message-${id}`],
            preview: `preview ${id}`,
            capturedAt: "2026-07-25T00:00:00.000Z",
        },
        summaryStatus: "none",
        expiresAt: "2026-07-25T01:00:00.000Z",
    };
}

function makeReport(targetTurnId = "turn-sent"): AgentContextProjectionReportView {
    return {
        schemaVersion: 1,
        transactionId: `transaction-${targetTurnId}`,
        targetTurnId,
        createdAt: "2026-07-25T00:00:00.000Z",
        contextWindow: 1000,
        effectiveOutputReserve: 100,
        inputLimit: 900,
        baseInputTokens: 100,
        finalInputTokens: 200,
        referenceTokens: 100,
        countAccuracy: "exact",
        overlaySha256: "sha",
        items: [],
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function makeAgentApi(overrides: Record<string, unknown> = {}) {
    const session = makeSession();
    return {
        createSession: vi.fn(async () => session),
        listSessionsForCwd: vi.fn(async () => []),
        getSessionState: vi.fn(async () => ({
            type: "session_state",
            messages: [],
            turns: [],
            status: "idle",
            steer: [],
            followUp: [],
            contextReports: [],
        })),
        send: vi.fn(async (_input: AgentSendOptions) => ({ sessionMetadata: session, turnId: "turn-sent" })),
        abort: vi.fn(),
        subscribe: vi.fn(() => vi.fn()),
        prepareContextDraft: vi.fn(async (input: AgentPrepareContextDraftInput) =>
            makeDraft("draft", input.targetSessionPath)
        ),
        summarizeContextDraft: vi.fn(async (input: AgentSummarizeContextDraftInput) => ({
            ...makeDraft(input.draftId, input.targetSessionPath),
            summaryStatus: "ready" as const,
        })),
        discardContextDraft: vi.fn(async () => ({ discarded: true })),
        listReferencePoints: vi.fn(async () => []),
        listContextState: vi.fn(async () => ({ drafts: [], contextReports: [] })),
        ...overrides,
    };
}

function installAgentApi(agent: ReturnType<typeof makeAgentApi>): void {
    Object.defineProperty(window, "api", {
        configurable: true,
        value: { agent },
    });
}

function hookOptions(initialSession = makeSession()) {
    return {
        initialSession,
        paneContext: { cwd: "/workspace" },
        modelSelection: { provider: "provider", model: "model" },
    };
}

afterEach(cleanup);

beforeEach(() => {
    installAgentApi(makeAgentApi());
});

describe("usePiChat context references", () => {
    it("sends message/full references by default and clears them after commit", async () => {
        const agent = makeAgentApi();
        installAgentApi(agent);
        const { result } = renderHook(() => usePiChat(hookOptions()));

        await act(async () => {
            await result.current.prepareContextDraft({
                sourceSessionPath: "/sessions/source.jsonl",
                sourceKind: "turn",
                sourceTurnId: "source-turn",
            });
        });
        await act(async () => {
            await result.current.send("question");
        });

        expect(agent.send).toHaveBeenCalledWith(
            expect.objectContaining({
                contextAttachments: [
                    {
                        draftId: "draft",
                        deliveryScope: "message",
                        requestedRepresentation: "full",
                    },
                ],
            })
        );
        expect(result.current.contextState.drafts).toEqual([]);
    });

    it("passes conversation delivery selected before the draft enters the composer", async () => {
        const agent = makeAgentApi();
        installAgentApi(agent);
        const { result } = renderHook(() => usePiChat(hookOptions()));

        await act(async () => {
            await result.current.prepareContextDraft({
                sourceSessionPath: "/sessions/source.jsonl",
                sourceKind: "session",
                deliveryScope: "conversation",
            });
            await result.current.send("question");
        });

        expect(agent.send.mock.calls.at(0)![0].contextAttachments![0]).toEqual({
            draftId: "draft",
            deliveryScope: "conversation",
            requestedRepresentation: "full",
        });
    });

    it("shows Summary loading in composer before background generation finishes", async () => {
        const summary = deferred<AgentContextDraftView>();
        const agent = makeAgentApi({ summarizeContextDraft: vi.fn(() => summary.promise) });
        installAgentApi(agent);
        const { result } = renderHook(() => usePiChat(hookOptions()));

        await act(async () => {
            await result.current.prepareContextDraft({
                sourceSessionPath: "/sessions/source.jsonl",
                sourceKind: "turn",
                sourceTurnId: "source-turn",
                requestedRepresentation: "summary",
            });
        });
        expect(result.current.contextState.drafts[0]).toMatchObject({
            requestedRepresentation: "summary",
            status: "summarizing",
        });

        await act(async () => {
            summary.resolve({ ...makeDraft("draft"), summaryStatus: "ready" });
            await summary.promise;
        });
        await waitFor(() => expect(result.current.contextState.drafts[0].status).toBe("ready"));
    });

    it("omits context fields for ordinary sends", async () => {
        const agent = makeAgentApi();
        installAgentApi(agent);
        const { result } = renderHook(() => usePiChat(hookOptions()));

        await act(async () => {
            await result.current.send("plain");
        });

        expect(agent.send.mock.calls.at(0)![0]).not.toHaveProperty("contextAttachments");
        expect(agent.send.mock.calls.at(0)![0]).not.toHaveProperty("excludedPinAttachmentIds");
        expect(agent.send.mock.calls.at(0)![0]).not.toHaveProperty("contextBudgetRevision");
    });

    it("hydrates reports without pin state", async () => {
        const report = makeReport();
        const agent = makeAgentApi({
            getSessionState: vi.fn(async () => ({
                type: "session_state",
                messages: [],
                turns: [],
                status: "idle",
                steer: [],
                followUp: [],
                contextReports: [report],
            })),
        });
        installAgentApi(agent);
        const { result } = renderHook(() => usePiChat(hookOptions()));

        await waitFor(() => expect(result.current.contextState.reportsByTurn["turn-sent"]).toBe(report));
        expect(result.current.contextState).not.toHaveProperty("pins");
        expect(result.current.contextState).not.toHaveProperty("budget");
    });

    it("rejects stale guarded preparation before calling main", async () => {
        const agent = makeAgentApi();
        installAgentApi(agent);
        const { result } = renderHook(() => usePiChat(hookOptions()));

        await expect(
            result.current.prepareContextDraft({
                sourceSessionPath: "/sessions/source.jsonl",
                sourceKind: "session",
                expectedTarget: { targetSessionPath: "/sessions/old.jsonl", targetGeneration: 0 },
            })
        ).rejects.toThrow("session changed");
        expect(agent.prepareContextDraft).not.toHaveBeenCalled();
    });
});

describe("context projection turn binding", () => {
    it("attaches reports by target turn identity", () => {
        const turns: PiTurn[] = [
            { turnId: "turn-one", responseMessages: [], status: "done" },
            { turnId: "turn-two", responseMessages: [], status: "done" },
        ];
        const report = makeReport("turn-two");
        const attached = attachContextReportsToTurns(turns, [report]);

        expect(attached[0]).toBe(turns[0]);
        expect(attached[1].contextProjection).toBe(report);
    });
});

describe("usePiChat pure helpers", () => {
    it("mirrors message and turn session state", () => {
        const message = { role: "user", content: [{ type: "text", text: "hello" }] } as PiAgentMessage;
        const turn = { turnId: "turn", userMessage: message, responseMessages: [], status: "done" } as PiTurn;
        const event = { type: "session_state", messages: [message], turns: [turn] } as PiAgentEvent;

        expect(reducePiChatEvent([], event)).toEqual([message]);
        expect(reducePiTurnsEvent([], event)).toEqual([turn]);
    });

    it("resolves abort paths and optimistic status", () => {
        expect(resolveAbortSessionPath(makeSession("/committed"), "/active")).toBe("/committed");
        expect(resolveAbortSessionPath(undefined, "/active")).toBe("/active");
        expect(getOptimisticAbortStatus("streaming")).toBe("idle");
        expect(getOptimisticAbortStatus("error")).toBe("error");
    });

    it("adopts newly supplied session metadata", () => {
        expect(adoptInitialSessionMetadata(undefined, makeSession("/new"))?.path).toBe("/new");
        expect(adoptInitialSessionMetadata(makeSession("/old"), undefined)?.path).toBe("/old");
    });

    it("marks send errors for exact composer restoration", () => {
        const error = new Error("failed");
        const marked = Object.assign(error, { composerRestoreText: "unused" });
        expect(composerRestoreTextFromSendError(marked)).toBeUndefined();
    });
});
