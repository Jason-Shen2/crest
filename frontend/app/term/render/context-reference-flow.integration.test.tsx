// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePiChat } from "@/app/store/use-pi-chat";

afterEach(cleanup);

function session(): AgentSessionMeta {
    return {
        id: "target",
        path: "/sessions/target.jsonl",
        cwd: "/workspace",
        createdAt: "2026-07-25T00:00:00.000Z",
    };
}

function draft(summaryStatus: AgentContextDraftView["summaryStatus"] = "none"): AgentContextDraftView {
    return {
        draftId: "draft",
        targetSessionPath: session().path,
        provenance: {
            sourceKind: "turn",
            sourceSessionId: "source",
            sourceSessionPath: "/sessions/source.jsonl",
            sourceCwd: "/workspace",
            sourceTurnId: "source-turn",
            sourceLeafId: "source-leaf",
            sourceMessageEntryIds: ["source-message"],
            preview: "source preview",
            capturedAt: "2026-07-25T00:00:00.000Z",
        },
        summaryStatus,
        expiresAt: "2026-07-25T01:00:00.000Z",
    };
}

function installApi(overrides: Record<string, unknown> = {}) {
    const api = {
        createSession: vi.fn(async () => session()),
        listSessionsForCwd: vi.fn(async () => []),
        getSessionState: vi.fn(async () => ({
            type: "session_state",
            messages: [],
            turns: [],
            status: "idle",
            contextReports: [],
        })),
        inspectContext: vi.fn(async (options: AgentInspectContextOptions) => ({
            snapshot: {
                schemaVersion: 1 as const,
                identity: {
                    sessionPath: options.sessionMetadata?.path,
                    leafId: null,
                    modelKey: `${options.provider}/${options.model}`,
                    revision: 1,
                },
                generatedAt: "2026-08-01T00:00:00.000Z",
                lifecycle: "ready" as const,
                accuracy: "estimated" as const,
                modelLabel: options.model,
                contextWindow: 100_000,
                outputReserve: 10_000,
                inputCapacity: 90_000,
                effectiveInputTokens: 0,
                remainingInputTokens: 90_000,
                categories: [],
                items: [],
            },
        })),
        subscribe: vi.fn(() => vi.fn()),
        abort: vi.fn(),
        send: vi.fn(async (_input: AgentSendOptions) => ({ sessionMetadata: session(), turnId: "target-turn" })),
        prepareContextDraft: vi.fn(async () => draft()),
        summarizeContextDraft: vi.fn(async () => draft("ready")),
        discardContextDraft: vi.fn(async () => ({ discarded: true })),
        listReferencePoints: vi.fn(async () => []),
        listContextState: vi.fn(async () => ({ drafts: [], contextReports: [] })),
        ...overrides,
    };
    return api;
}

function options(client: ReturnType<typeof installApi>) {
    return {
        client,
        initialSession: session(),
        executionContext: {
            workspaceId: "workspace",
            workspaceDir: "/workspace",
            environment: {},
        },
        modelSelection: { provider: "provider", model: "model" },
    };
}

describe("context reference renderer flow", () => {
    it("selects a conversation reference, sends it, and clears the composer chip", async () => {
        const api = installApi();
        const { result } = renderHook(() => usePiChat(options(api)));

        await act(async () => {
            await result.current.prepareContextDraft({
                sourceSessionPath: "/sessions/source.jsonl",
                sourceKind: "turn",
                sourceTurnId: "source-turn",
                deliveryScope: "conversation",
            });
        });
        expect(result.current.contextState.drafts[0]).toMatchObject({
            deliveryScope: "conversation",
            requestedRepresentation: "full",
        });

        await act(async () => {
            await result.current.send("continue with this context");
        });

        expect(api.send.mock.calls.at(0)![0].contextAttachments).toEqual([
            { draftId: "draft", deliveryScope: "conversation", requestedRepresentation: "full" },
        ]);
        expect(result.current.contextState.drafts).toEqual([]);
    });

    it("keeps Summary in loading state until generation succeeds", async () => {
        let resolveSummary!: (value: AgentContextDraftView) => void;
        const summary = new Promise<AgentContextDraftView>((resolve) => {
            resolveSummary = resolve;
        });
        const api = installApi({ summarizeContextDraft: vi.fn(() => summary) });
        const { result } = renderHook(() => usePiChat(options(api)));

        await act(async () => {
            await result.current.prepareContextDraft({
                sourceSessionPath: "/sessions/source.jsonl",
                sourceKind: "turn",
                sourceTurnId: "source-turn",
                requestedRepresentation: "summary",
            });
        });
        expect(result.current.contextState.drafts[0].status).toBe("summarizing");

        await act(async () => resolveSummary(draft("ready")));
        await waitFor(() => expect(result.current.contextState.drafts[0].status).toBe("ready"));
    });
});
