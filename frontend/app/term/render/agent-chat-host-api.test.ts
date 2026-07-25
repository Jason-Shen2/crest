// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { createContextReferenceState } from "@/app/store/context-references";
import { markSendErrorForComposerRestore, usePiChat, type UsePiChatReturn } from "@/app/store/use-pi-chat";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentChatHost, createAgentChatHostApi, type AgentChatHostContextApi } from "./agent-chat-host";

type AgentRuntimeApi = NonNullable<ReturnType<Parameters<typeof createAgentChatHostApi>[0]["getRuntimeApi"]>>;

vi.mock("@/app/store/use-pi-chat", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/store/use-pi-chat")>();
    return { ...actual, usePiChat: vi.fn() };
});

afterEach(() => {
    cleanup();
    vi.mocked(usePiChat).mockReset();
});

function makeSession(): AgentSessionMeta {
    return { id: "s1", createdAt: "now", cwd: "/repo", path: "/tmp/session.jsonl" };
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

function makeContextApi() {
    return {
        prepareContextDraft: vi.fn<AgentChatHostContextApi["prepareContextDraft"]>().mockResolvedValue(undefined),
        discardContextDraft: vi.fn<AgentChatHostContextApi["discardContextDraft"]>().mockResolvedValue(undefined),
        summarizeContextDraft: vi.fn<AgentChatHostContextApi["summarizeContextDraft"]>().mockResolvedValue(undefined),
        retryContextSend: vi.fn<AgentChatHostContextApi["retryContextSend"]>().mockResolvedValue(undefined),
    };
}

function makeChatReturn(overrides: Partial<UsePiChatReturn> = {}): UsePiChatReturn {
    return {
        messages: [],
        turns: [],
        status: "idle",
        errorMessage: undefined,
        sessionMetadata: makeSession(),
        queuedMessages: [],
        send: vi.fn(),
        abort: vi.fn(),
        contextState: createContextReferenceState(makeSession().path),
        contextSendRecovery: undefined,
        ...makeContextApi(),
        ...overrides,
    };
}

describe("createAgentChatHostApi", () => {
    it("emits context through one host state callback without a composer budget preview", () => {
        const contextState = createContextReferenceState(makeSession().path);
        const contextSendRecovery = {
            text: "retry this",
            draftIds: ["draft-1"],
            errorMessage: "budget stale",
        };
        const chat = makeChatReturn({ contextState, contextSendRecovery });
        const onStateChange = vi.fn();
        vi.mocked(usePiChat).mockReturnValue(chat);

        render(
            createElement(AgentChatHost, {
                outerBlockId: "block-1",
                sessionMetadata: makeSession(),
                modelSelection: { provider: "openai", model: "gpt-5" },
                paneContext: { cwd: "/repo" },
                contextReferencesEnabled: false,
                onStateChange,
            })
        );

        const hookOptions = vi.mocked(usePiChat).mock.calls[0][0];
        expect(hookOptions).not.toHaveProperty("contextPreview");
        expect(hookOptions.contextReferencesEnabled).toBe(false);
        expect(onStateChange).toHaveBeenCalledWith({
            status: "idle",
            queuedMessages: [],
            context: contextState,
            contextSendRecovery,
        });
    });

    it("routes tree and fork slash commands to selector requests without sending prompts", () => {
        const sendPrompt = vi.fn(() => true);
        const onSelectorRequest = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onSelectorRequest,
        });

        expect(api.submit("/tree")).toBe(true);
        expect(api.submit("/fork")).toBe(true);

        expect(sendPrompt).not.toHaveBeenCalled();
        expect(onSelectorRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "tree" }));
        expect(onSelectorRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "fork" }));
    });

    it("passes images through when submitting a normal prompt", async () => {
        const sendPrompt = vi.fn(async () => true);
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
        });

        await expect(api.submit("describe this", ["data:image/png;base64,abc123"])).resolves.toBe(true);

        expect(sendPrompt).toHaveBeenCalledWith("describe this", ["data:image/png;base64,abc123"]);
    });

    it("routes the hidden resume alias to the session selector without sending prompts", async () => {
        const session = makeSession();
        const detail = {
            ...session,
            modifiedAt: "later",
            messageCount: 2,
            firstMessage: "debug sqlite resume",
            previewText: "debug sqlite resume assistant reply",
        };
        const sendPrompt = vi.fn(() => true);
        const onSelectorRequest = vi.fn();
        const onSessionMinted = vi.fn();
        const runtimeApi = {
            listTree: vi.fn(),
            listForkPoints: vi.fn(),
            navigateTree: vi.fn(),
            forkSession: vi.fn(),
            cloneSession: vi.fn(),
            runCommand: vi.fn(),
            listSessionsForCwd: vi.fn(async () => [session]),
            listSessionDetailsForCwd: vi.fn(async () => [detail]),
            listAllSessionDetails: vi.fn(),
            listReferencePoints: vi.fn(),
        };
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: makeSession,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onSelectorRequest,
            onSessionMinted,
        });

        expect(api.submit("/resume")).toBe(true);

        expect(sendPrompt).not.toHaveBeenCalled();
        expect(onSelectorRequest).toHaveBeenCalledWith(expect.objectContaining({ type: "session" }));
        const request = onSelectorRequest.mock.calls[0][0];
        await expect(request.listSessions("/repo")).resolves.toEqual([detail]);
        expect(runtimeApi.listSessionDetailsForCwd).toHaveBeenCalledWith("/repo");
        await expect(request.resumeSession(detail)).resolves.toEqual({ sessionMetadata: detail });
        expect(onSessionMinted).toHaveBeenCalledWith(detail);
    });

    it("exposes tree reference preparation without changing tree navigation", async () => {
        const session = makeSession();
        const context = makeContextApi();
        const onSelectorRequest = vi.fn();
        const runtimeApi = {
            listTree: vi.fn(),
            listForkPoints: vi.fn(),
            navigateTree: vi.fn(async () => ({ sessionMetadata: session })),
            forkSession: vi.fn(),
            cloneSession: vi.fn(),
            runCommand: vi.fn(),
            listSessionsForCwd: vi.fn(),
            listSessionDetailsForCwd: vi.fn(),
            listAllSessionDetails: vi.fn(),
            listReferencePoints: vi.fn(),
        };
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(async () => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            context,
            onSelectorRequest,
        });

        expect(api.submit("/tree")).toBe(true);
        const request = onSelectorRequest.mock.calls[0][0];
        await request.prepareTurnReference("turn-1");
        await request.navigateTree("turn-1");

        expect(context.prepareContextDraft).toHaveBeenCalledWith({
            sourceSessionPath: session.path,
            sourceKind: "turn",
            sourceTurnId: "turn-1",
        });
        expect(runtimeApi.navigateTree).toHaveBeenCalledWith({
            sessionMetadata: session,
            targetId: "turn-1",
            blockId: "b_test",
        });
    });

    it.each(["/session", "/resume"])(
        "opens %s as a session request with resume and reference operations",
        async (command) => {
            const currentSession = makeSession();
            const source = {
                ...currentSession,
                id: "source",
                path: "/tmp/source.jsonl",
                modifiedAt: "later",
                messageCount: 2,
                firstMessage: "source question",
                previewText: "source question and answer",
            };
            const referencePoints: AgentReferencePointView[] = [{ entryId: "turn-1", preview: "source question" }];
            const context = makeContextApi();
            const onSelectorRequest = vi.fn();
            const onSessionMinted = vi.fn();
            const runtimeApi = {
                listTree: vi.fn(),
                listForkPoints: vi.fn(),
                navigateTree: vi.fn(),
                forkSession: vi.fn(),
                cloneSession: vi.fn(),
                runCommand: vi.fn(),
                listSessionsForCwd: vi.fn(),
                listSessionDetailsForCwd: vi.fn(async () => [source]),
                listAllSessionDetails: vi.fn(async () => [source]),
                listReferencePoints: vi.fn(async () => referencePoints),
            };
            const api = createAgentChatHostApi({
                sendPrompt: vi.fn(async () => true),
                abort: vi.fn(),
                getTurns: () => [],
                getRuntimeApi: () => runtimeApi,
                getSessionMetadata: () => currentSession,
                getContextTargetIdentity: () => ({
                    targetSessionPath: currentSession.path,
                    targetGeneration: 4,
                }),
                getPaneCwd: () => "/repo",
                getBlockId: () => "b_test",
                context,
                onSelectorRequest,
                onSessionMinted,
            });

            expect(api.submit(command)).toBe(true);
            expect(onSessionMinted).not.toHaveBeenCalled();
            const request = onSelectorRequest.mock.calls[0][0];
            expect(request).toEqual(
                expect.objectContaining({
                    type: "session",
                    cwd: "/repo",
                    currentSessionPath: currentSession.path,
                })
            );
            await expect(request.listSessions()).resolves.toEqual([source]);
            await expect(request.listSessions("/repo")).resolves.toEqual([source]);
            await expect(request.listReferencePoints(source)).resolves.toEqual(referencePoints);
            await expect(request.resumeSession(source)).resolves.toEqual({ sessionMetadata: source });
            await request.prepareSessionReference(source);
            await request.prepareTurnReference(source, "turn-1");

            expect(runtimeApi.listAllSessionDetails).toHaveBeenCalledOnce();
            expect(runtimeApi.listSessionDetailsForCwd).toHaveBeenCalledWith("/repo");
            expect(runtimeApi.listReferencePoints).toHaveBeenCalledWith({ sourceSessionPath: source.path });
            expect(onSessionMinted).toHaveBeenCalledWith(source);
            expect(context.prepareContextDraft).toHaveBeenNthCalledWith(1, {
                sourceSessionPath: source.path,
                sourceKind: "session",
                expectedTarget: {
                    targetSessionPath: currentSession.path,
                    targetGeneration: 4,
                },
            });
            expect(context.prepareContextDraft).toHaveBeenNthCalledWith(2, {
                sourceSessionPath: source.path,
                sourceKind: "turn",
                sourceTurnId: "turn-1",
                expectedTarget: {
                    targetSessionPath: currentSession.path,
                    targetGeneration: 4,
                },
            });
            expect(context.prepareContextDraft.mock.calls[0][0]).not.toHaveProperty("artifact");
            expect(context.prepareContextDraft.mock.calls[1][0]).not.toHaveProperty("artifact");
        }
    );

    it("exposes composer-added source turns to the session selector", () => {
        const currentSession = makeSession();
        const source = { ...currentSession, id: "source", path: "/tmp/source.jsonl" };
        const contextState = createContextReferenceState(currentSession.path);
        const provenance = {
            sourceKind: "turn" as const,
            sourceSessionId: source.id,
            sourceSessionPath: source.path,
            sourceCwd: source.cwd,
            sourceLeafId: "leaf-1",
            sourceMessageEntryIds: ["message-1"],
            preview: "source turn",
            capturedAt: "2026-07-24T00:00:00.000Z",
        };
        contextState.drafts = [
            {
                view: {
                    draftId: "draft-1",
                    targetSessionPath: currentSession.path,
                    provenance: { ...provenance, sourceTurnId: "turn-1" },
                    summaryStatus: "none",
                    expiresAt: "2026-07-24T01:00:00.000Z",
                },
                deliveryScope: "message",
                requestedRepresentation: "full",
                status: "ready",
            },
        ];
        const onSelectorRequest = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(async () => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: () => currentSession,
            getContextState: () => contextState,
            getPaneCwd: () => currentSession.cwd,
            getBlockId: () => "b_test",
            context: makeContextApi(),
            onSelectorRequest,
        });

        expect(api.submit("/session")).toBe(true);
        const request = onSelectorRequest.mock.calls[0][0];
        expect(request.getAddedTurnIds(source)).toEqual(new Set(["turn-1"]));
    });

    it("allows cross-session reference preparation before the target session exists", async () => {
        const source = makeSession();
        const context = makeContextApi();
        const onSelectorRequest = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(async () => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: () => undefined,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            context,
            onSelectorRequest,
        });

        expect(api.submit("/session")).toBe(true);
        const request = onSelectorRequest.mock.calls[0][0];
        await expect(request.prepareSessionReference(source)).resolves.toBeUndefined();
        expect(context.prepareContextDraft).toHaveBeenCalledWith({
            sourceSessionPath: source.path,
            sourceKind: "session",
            expectedTarget: {
                targetSessionPath: undefined,
                targetGeneration: 0,
            },
        });
    });

    it("rejects every stale session-manager operation before it can affect a newer target", async () => {
        const sessionA = makeSession();
        const sessionC = { ...sessionA, id: "c", path: "/tmp/session-c.jsonl" };
        const source = { ...sessionA, id: "source", path: "/tmp/source.jsonl" };
        let currentSession = sessionA;
        let targetGeneration = 7;
        const context = makeContextApi();
        const onSelectorRequest = vi.fn();
        const onSessionMinted = vi.fn();
        const runtimeApi = {
            listSessionDetailsForCwd: vi.fn(async () => [source]),
            listAllSessionDetails: vi.fn(async () => [source]),
            listReferencePoints: vi.fn(async () => []),
        };
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(async () => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi as unknown as AgentRuntimeApi,
            getSessionMetadata: () => currentSession,
            getContextTargetIdentity: () => ({
                targetSessionPath: currentSession.path,
                targetGeneration,
            }),
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            context,
            onSelectorRequest,
            onSessionMinted,
        });

        api.submit("/session");
        const request = onSelectorRequest.mock.calls[0][0];
        currentSession = sessionC;
        targetGeneration += 1;

        await expect(request.listSessions()).rejects.toThrow(/session changed/i);
        await expect(request.listReferencePoints(source)).rejects.toThrow(/session changed/i);
        await expect(request.resumeSession(source)).rejects.toThrow(/session changed/i);
        await expect(request.prepareSessionReference(sessionC)).rejects.toThrow(/session changed/i);
        await expect(request.prepareTurnReference(source, "turn-1")).rejects.toThrow(/session changed/i);

        expect(runtimeApi.listAllSessionDetails).not.toHaveBeenCalled();
        expect(runtimeApi.listReferencePoints).not.toHaveBeenCalled();
        expect(context.prepareContextDraft).not.toHaveBeenCalled();
        expect(onSessionMinted).not.toHaveBeenCalled();
    });

    it.each(["sessions", "detail", "session-reference", "turn-reference"] as const)(
        "rejects deferred stale session-manager %s results",
        async (operation) => {
            const sessionA = makeSession();
            const sessionC = { ...sessionA, id: "c", path: "/tmp/session-c.jsonl" };
            const source = { ...sessionA, id: "source", path: "/tmp/source.jsonl" };
            let currentSession = sessionA;
            let targetGeneration = 2;
            const pending = deferred<unknown>();
            const context = makeContextApi();
            context.prepareContextDraft.mockImplementation(async () => {
                await pending.promise;
            });
            const onSelectorRequest = vi.fn();
            const runtimeApi = {
                listSessionDetailsForCwd: vi.fn(() => pending.promise as Promise<AgentSessionDetail[]>),
                listAllSessionDetails: vi.fn(() => pending.promise as Promise<AgentSessionDetail[]>),
                listReferencePoints: vi.fn(() => pending.promise as Promise<AgentReferencePointView[]>),
            };
            const api = createAgentChatHostApi({
                sendPrompt: vi.fn(async () => true),
                abort: vi.fn(),
                getTurns: () => [],
                getRuntimeApi: () => runtimeApi as unknown as AgentRuntimeApi,
                getSessionMetadata: () => currentSession,
                getContextTargetIdentity: () => ({
                    targetSessionPath: currentSession.path,
                    targetGeneration,
                }),
                getPaneCwd: () => "/repo",
                getBlockId: () => "b_test",
                context,
                onSelectorRequest,
            });
            api.submit("/session");
            const request = onSelectorRequest.mock.calls[0][0];
            const operationPromise =
                operation === "sessions"
                    ? request.listSessions()
                    : operation === "detail"
                      ? request.listReferencePoints(source)
                      : operation === "session-reference"
                        ? request.prepareSessionReference(source)
                        : request.prepareTurnReference(source, "turn-1");

            currentSession = sessionC;
            targetGeneration += 1;
            pending.resolve(operation === "sessions" ? [source] : []);

            await expect(operationPromise).rejects.toThrow(/session changed/i);
        }
    );

    it("does not apply a resume when the target changes before its async commit point", async () => {
        const sessionA = makeSession();
        const sessionC = { ...sessionA, id: "c", path: "/tmp/session-c.jsonl" };
        const source = { ...sessionA, id: "source", path: "/tmp/source.jsonl" };
        let currentSession = sessionA;
        let targetGeneration = 1;
        const onSelectorRequest = vi.fn();
        const onSessionMinted = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(async () => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: () => currentSession,
            getContextTargetIdentity: () => ({
                targetSessionPath: currentSession.path,
                targetGeneration,
            }),
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onSelectorRequest,
            onSessionMinted,
        });
        api.submit("/session");
        const request = onSelectorRequest.mock.calls[0][0];

        const resume = request.resumeSession(source);
        currentSession = sessionC;
        targetGeneration += 1;

        await expect(resume).rejects.toThrow(/session changed/i);
        expect(onSessionMinted).not.toHaveBeenCalled();
    });

    it("propagates send failure and restores exact composer text", async () => {
        const failure = new Error("send failed");
        const onRestoreComposerText = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(async () => {
                throw markSendErrorForComposerRestore(failure, "  preserve me exactly  ");
            }),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onRestoreComposerText,
        });

        await expect(api.submit("  preserve me exactly  ")).rejects.toBe(failure);
        expect(onRestoreComposerText).toHaveBeenCalledOnce();
        expect(onRestoreComposerText).toHaveBeenCalledWith("  preserve me exactly  ");
    });

    it("does not restore composer text for a stale unmarked send failure", async () => {
        const failure = new Error("stale A failure");
        const onRestoreComposerText = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(async () => {
                throw failure;
            }),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onRestoreComposerText,
        });

        await expect(api.submit("from A")).rejects.toBe(failure);
        expect(onRestoreComposerText).not.toHaveBeenCalled();
    });

    it.each(["tree", "fork"] as const)(
        "rejects stale %s selector operations before using the new session or IPC",
        async (selectorType) => {
            const sessionA = makeSession();
            const sessionB = { ...sessionA, id: "s2", path: "/tmp/session-b.jsonl" };
            let currentSession = sessionA;
            const context = makeContextApi();
            const onSelectorRequest = vi.fn();
            const runtimeApi = {
                listTree: vi.fn(),
                listForkPoints: vi.fn(),
                navigateTree: vi.fn(),
                forkSession: vi.fn(),
                cloneSession: vi.fn(),
                runCommand: vi.fn(),
                listSessionsForCwd: vi.fn(),
                listSessionDetailsForCwd: vi.fn(),
                listAllSessionDetails: vi.fn(),
                listReferencePoints: vi.fn(),
            };
            const getRuntimeApi = vi.fn(() => runtimeApi);
            const api = createAgentChatHostApi({
                sendPrompt: vi.fn(async () => true),
                abort: vi.fn(),
                getTurns: () => [],
                getRuntimeApi,
                getSessionMetadata: () => currentSession,
                getPaneCwd: () => "/repo",
                getBlockId: () => "b_test",
                context,
                onSelectorRequest,
            });

            expect(api.submit(`/${selectorType}`)).toBe(true);
            const request = onSelectorRequest.mock.calls[0][0];
            currentSession = sessionB;

            if (request.type === "tree") {
                await expect(request.listTree()).rejects.toThrow(/session changed/i);
                await expect(request.navigateTree("a-row")).rejects.toThrow(/session changed/i);
                await expect(request.prepareTurnReference("a-row")).rejects.toThrow(/session changed/i);
            } else if (request.type === "fork") {
                await expect(request.listForkPoints()).rejects.toThrow(/session changed/i);
                await expect(request.forkSession("a-row")).rejects.toThrow(/session changed/i);
            } else {
                throw new Error("unexpected selector request");
            }

            expect(getRuntimeApi).not.toHaveBeenCalled();
            expect(runtimeApi.listTree).not.toHaveBeenCalled();
            expect(runtimeApi.listForkPoints).not.toHaveBeenCalled();
            expect(runtimeApi.navigateTree).not.toHaveBeenCalled();
            expect(runtimeApi.forkSession).not.toHaveBeenCalled();
            expect(context.prepareContextDraft).not.toHaveBeenCalled();
        }
    );

    it.each(["tree-list", "tree-navigate", "tree-prepare", "fork-list", "fork-commit"] as const)(
        "rejects %s results when the session changes while the operation is pending",
        async (operationName) => {
            const sessionA = makeSession();
            const sessionB = { ...sessionA, id: "s2", path: "/tmp/session-b.jsonl" };
            let currentSession = sessionA;
            const pending = deferred<unknown>();
            const context = makeContextApi();
            context.prepareContextDraft.mockImplementation(async () => {
                await pending.promise;
            });
            const onSelectorRequest = vi.fn();
            const onSessionMinted = vi.fn();
            const runtimeApi = {
                listTree: vi.fn(() => pending.promise as Promise<AgentTreeResult>),
                listForkPoints: vi.fn(() => pending.promise as Promise<AgentForkPointView[]>),
                navigateTree: vi.fn(() => pending.promise as Promise<AgentNavigateTreeResult>),
                forkSession: vi.fn(() => pending.promise as Promise<AgentForkSessionResult>),
                cloneSession: vi.fn(),
                runCommand: vi.fn(),
                listSessionsForCwd: vi.fn(),
                listSessionDetailsForCwd: vi.fn(),
                listAllSessionDetails: vi.fn(),
                listReferencePoints: vi.fn(),
            };
            const api = createAgentChatHostApi({
                sendPrompt: vi.fn(async () => true),
                abort: vi.fn(),
                getTurns: () => [],
                getRuntimeApi: () => runtimeApi,
                getSessionMetadata: () => currentSession,
                getPaneCwd: () => "/repo",
                getBlockId: () => "b_test",
                context,
                onSelectorRequest,
                onSessionMinted,
            });
            const selectorType = operationName.startsWith("tree") ? "tree" : "fork";

            expect(api.submit(`/${selectorType}`)).toBe(true);
            const request = onSelectorRequest.mock.calls[0][0];
            let operation: Promise<unknown>;
            if (request.type === "tree" && operationName === "tree-list") {
                operation = request.listTree();
            } else if (request.type === "tree" && operationName === "tree-navigate") {
                operation = request.navigateTree("a-row");
            } else if (request.type === "tree" && operationName === "tree-prepare") {
                operation = request.prepareTurnReference("a-row");
            } else if (request.type === "fork" && operationName === "fork-list") {
                operation = request.listForkPoints();
            } else if (request.type === "fork" && operationName === "fork-commit") {
                operation = request.forkSession("a-row");
            } else {
                throw new Error("unexpected selector operation");
            }

            currentSession = sessionB;
            if (operationName === "tree-list") {
                pending.resolve({ entries: [], leafId: null });
            } else if (operationName === "tree-navigate") {
                pending.resolve({ sessionMetadata: sessionA, editorText: "stale A text" });
            } else if (operationName === "fork-list") {
                pending.resolve([{ entryId: "a-row", preview: "A row" }]);
            } else if (operationName === "fork-commit") {
                pending.resolve({ sessionMetadata: { ...sessionA, path: "/tmp/fork-a.jsonl" } });
            } else {
                pending.resolve(undefined);
            }

            await expect(operation).rejects.toThrow(/session changed/i);
            expect(onSessionMinted).not.toHaveBeenCalled();
            expect(currentSession).toBe(sessionB);
        }
    );

    it("delegates context actions to the current chat context API", async () => {
        const context = makeContextApi();
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(async () => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            context,
        });
        const draftInput = {
            sourceSessionPath: "/tmp/source.jsonl",
            sourceKind: "turn" as const,
            sourceTurnId: "turn-1",
        };

        await api.prepareContextDraft(draftInput);
        await api.discardContextDraft("draft-1");
        await api.summarizeContextDraft("draft-1");
        await api.retryContextSend();

        expect(context.prepareContextDraft).toHaveBeenCalledWith(draftInput);
        expect(context.discardContextDraft).toHaveBeenCalledWith("draft-1");
        expect(context.summarizeContextDraft).toHaveBeenCalledWith("draft-1");
        expect(context.retryContextSend).toHaveBeenCalledOnce();
    });

    it("exposes session tree helpers for selector UI consumption", async () => {
        const session = makeSession();
        const tree = { entries: [], leafId: null };
        const forkPoints: AgentForkPointView[] = [{ entryId: "e1", preview: "first turn" }];
        const runtimeApi = {
            listTree: vi.fn(async () => tree),
            listForkPoints: vi.fn(async () => forkPoints),
            navigateTree: vi.fn(async () => ({ sessionMetadata: session, editorText: "restore me" })),
            forkSession: vi.fn(async () => ({ sessionMetadata: { ...session, path: "/tmp/fork.jsonl" } })),
            cloneSession: vi.fn(async () => ({ sessionMetadata: { ...session, path: "/tmp/clone.jsonl" } })),
            runCommand: vi.fn(),
            listSessionsForCwd: vi.fn(),
            listSessionDetailsForCwd: vi.fn(),
            listAllSessionDetails: vi.fn(),
            listReferencePoints: vi.fn(),
        };
        const onSessionMinted = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onSessionMinted,
        });

        await expect(api.listTree()).resolves.toBe(tree);
        await expect(api.listForkPoints()).resolves.toBe(forkPoints);
        await expect(api.navigateTree("e1")).resolves.toEqual({ sessionMetadata: session, editorText: "restore me" });
        await expect(api.forkSession("e1")).resolves.toEqual({
            sessionMetadata: { ...session, path: "/tmp/fork.jsonl" },
        });
        await expect(api.cloneSession()).resolves.toEqual({
            sessionMetadata: { ...session, path: "/tmp/clone.jsonl" },
        });

        expect(runtimeApi.listTree).toHaveBeenCalledWith(session);
        expect(runtimeApi.listForkPoints).toHaveBeenCalledWith(session);
        expect(runtimeApi.navigateTree).toHaveBeenCalledWith({
            sessionMetadata: session,
            targetId: "e1",
            blockId: "b_test",
        });
        expect(runtimeApi.forkSession).toHaveBeenCalledWith({ sessionMetadata: session, cwd: "/repo", entryId: "e1" });
        expect(runtimeApi.cloneSession).toHaveBeenCalledWith({ sessionMetadata: session, cwd: "/repo" });
        expect(onSessionMinted).toHaveBeenCalledWith({ ...session, path: "/tmp/fork.jsonl" });
        expect(onSessionMinted).toHaveBeenCalledWith({ ...session, path: "/tmp/clone.jsonl" });
    });

    it("keeps model and clone command behavior while bypassing prompt send", async () => {
        const session = makeSession();
        const sendPrompt = vi.fn(() => true);
        const onOpenModelPicker = vi.fn();
        const runtimeApi = {
            listTree: vi.fn(),
            listForkPoints: vi.fn(),
            navigateTree: vi.fn(),
            forkSession: vi.fn(),
            cloneSession: vi.fn(async () => ({ sessionMetadata: { ...session, path: "/tmp/clone.jsonl" } })),
            runCommand: vi.fn(),
            listSessionsForCwd: vi.fn(),
            listSessionDetailsForCwd: vi.fn(),
            listAllSessionDetails: vi.fn(),
            listReferencePoints: vi.fn(),
        };
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onOpenModelPicker,
        });

        expect(api.submit("/model")).toBe(true);
        expect(api.submit("/clone")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onOpenModelPicker).toHaveBeenCalledOnce();
        expect(runtimeApi.cloneSession).toHaveBeenCalledWith({ sessionMetadata: session, cwd: "/repo" });
        expect(sendPrompt).not.toHaveBeenCalled();
    });

    it("surfaces clone no-op messages to the user", async () => {
        const session = makeSession();
        const sendPrompt = vi.fn(() => true);
        const onUserError = vi.fn();
        const runtimeApi = {
            listTree: vi.fn(),
            listForkPoints: vi.fn(),
            navigateTree: vi.fn(),
            forkSession: vi.fn(),
            cloneSession: vi.fn(async () => ({ message: "No session branch to clone yet." })),
            runCommand: vi.fn(),
            listSessionsForCwd: vi.fn(),
            listSessionDetailsForCwd: vi.fn(),
            listAllSessionDetails: vi.fn(),
            listReferencePoints: vi.fn(),
        };
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onUserError,
        });

        expect(api.submit("/clone")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onUserError).toHaveBeenCalledWith("No session branch to clone yet.");
        expect(sendPrompt).not.toHaveBeenCalled();
    });

    it.each([
        "/new",
        "/compact keep errors",
        "/info",
        "/copy",
        "/export /tmp/a.jsonl",
        "/import /tmp/a.jsonl",
        "/reload",
    ])("routes %s to inline command results without sending prompts or toast notifications", async (commandText) => {
        const sendPrompt = vi.fn(() => true);
        const runCommand = vi.fn(async () => ({ status: "success" as const, message: "ok" }));
        const onUserError = vi.fn();
        const onCommandResult = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onUserError,
            onCommandResult,
            runCommand,
        });

        expect(api.submit(commandText)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(sendPrompt).not.toHaveBeenCalled();
        expect(runCommand).toHaveBeenCalledOnce();
        expect(onUserError).not.toHaveBeenCalled();
        expect(onCommandResult).toHaveBeenCalledWith({
            command: commandText.slice(1).split(/\s+/)[0],
            status: "success",
            message: "ok",
        });
    });

    it("switches to a new session after /new", async () => {
        const onSessionMinted = vi.fn();
        const runCommand = vi.fn(async () => ({
            status: "success" as const,
            message: "Created a new agent session.",
            sessionMetadata: { id: "s2", createdAt: "later", cwd: "/tmp", path: "/tmp/session.jsonl" },
        }));
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onSessionMinted,
            runCommand,
        });

        expect(api.submit("/new")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onSessionMinted).toHaveBeenCalledWith({
            id: "s2",
            createdAt: "later",
            cwd: "/tmp",
            path: "/tmp/session.jsonl",
        });
    });
});
