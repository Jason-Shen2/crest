// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeAgentSurfaceActivityController } from "@/app/agent/agent-surface-activity";
import {
    adoptInitialSessionMetadata,
    composerRestoreMintedSessionPathFromSendError,
    composerRestoreTextFromSendError,
    getOptimisticAbortStatus,
    type PiAgentMessage,
    reducePiChatEvent,
    reducePiTurnsEvent,
    resolveAbortSessionPath,
    usePiChat,
    type UsePiChatModel,
} from "./use-pi-chat";

afterEach(cleanup);

function makeSession(path: string, cwd = "/repo"): AgentSessionMeta {
    return { id: path.split("/").pop() ?? "session", createdAt: "now", cwd, path };
}

function makeExecutionContext(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
    return {
        workspaceId: "workspace-a",
        workspaceDir: "/repo",
        environment: { CREST: "1" },
        gitBranch: "main",
        ...overrides,
    };
}

function makeModel(): UsePiChatModel {
    return { provider: "openai", model: "gpt-test", reasoning: "low", tokenSecretName: "secret" };
}

function makeRewindState(overrides: Partial<AgentRewindSessionStateView> = {}): AgentRewindSessionStateView {
    return {
        enabled: true,
        semanticLeafId: "state-1",
        displayLeafId: "user-1",
        eligibleTurnIds: ["user-1"],
        busy: false,
        frozen: false,
        quota: {
            status: "ok",
            usedBytes: 128,
            softQuotaBytes: 5 * 1024 ** 3,
            cleanupAvailable: false,
        },
        redo: {
            operationId: "op-1",
            targetPrompt: "restore this prompt",
            messageCount: 2,
            fileCount: 0,
            files: [],
        },
        ...overrides,
    };
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function makeClient() {
    const subscribers = new Map<string, Array<(event: unknown) => void>>();
    const unsubscribed: string[] = [];
    const client = {
        createSession: vi.fn(async () => makeSession("/repo/.agent/new.jsonl")),
        getSessionState: vi.fn(async (session: AgentSessionMeta) => ({
            type: "session_state",
            messages: [{ role: "user", content: [{ type: "text", text: `snapshot:${session.path}` }] }],
            turns: [],
            status: "idle",
            steer: [],
            followUp: [],
            commands: [],
        })),
        prepareContextDraft: vi.fn(),
        summarizeContextDraft: vi.fn(),
        discardContextDraft: vi.fn(),
        listReferencePoints: vi.fn(async () => []),
        listContextState: vi.fn(async () => ({ drafts: [], contextReports: [] })),
        send: vi.fn(async (opts: AgentSendOptions) => ({
            sessionMetadata: opts.sessionMetadata ?? makeSession("/repo/.agent/sent.jsonl"),
            turnId: "turn-1",
        })),
        abort: vi.fn(async () => {}),
        subscribe: vi.fn((sessionPath: string, callback: (event: unknown) => void) => {
            const list = subscribers.get(sessionPath) ?? [];
            list.push(callback);
            subscribers.set(sessionPath, list);
            return () => {
                unsubscribed.push(sessionPath);
            };
        }),
        emit(sessionPath: string, event: unknown) {
            for (const callback of subscribers.get(sessionPath) ?? []) {
                callback(event);
            }
        },
        emitCaptured(callback: (event: unknown) => void, event: unknown) {
            callback(event);
        },
        getSubscriber(sessionPath: string, index = 0) {
            return subscribers.get(sessionPath)?.[index];
        },
        unsubscribed,
    };
    return client;
}

describe("usePiChat lifecycle", () => {
    it("sends through the injected client with authenticated workspace context and no block id", async () => {
        const client = makeClient();
        const context = makeExecutionContext();
        const { result } = renderHook(() =>
            usePiChat({
                client,
                executionContext: context,
                modelSelection: makeModel(),
                allowedTools: ["spawn_cli_agent"],
            })
        );

        await act(async () => {
            await result.current.send("hello");
        });

        expect(client.createSession).toHaveBeenCalledOnce();
        expect(client.send).toHaveBeenCalledWith(
            expect.objectContaining({
                context,
                text: "hello",
                provider: "openai",
                model: "gpt-test",
                reasoning: "low",
                tokenSecretName: "secret",
                allowedTools: ["spawn_cli_agent"],
            })
        );
        expect(client.send.mock.calls[0][0]).not.toHaveProperty("blockId");
        expect(client.send.mock.calls[0][0].context).not.toHaveProperty("blockId");
    });

    it("subscribes by session path only when visible and without a block option", async () => {
        const client = makeClient();
        const session = makeSession("/repo/.agent/a.jsonl");
        renderHook(() =>
            usePiChat({
                client,
                initialSession: session,
                executionContext: makeExecutionContext({ sessionPath: session.path }),
                modelSelection: makeModel(),
            })
        );

        await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());

        expect(client.getSessionState).not.toHaveBeenCalled();
        expect(client.subscribe).toHaveBeenCalledWith(session.path, expect.any(Function));
    });

    it("hydrates and wholesale replaces authoritative rewind state from subscription replay", async () => {
        const client = makeClient();
        const session = makeSession("/repo/.agent/a.jsonl");
        const { result } = renderHook(() =>
            usePiChat({
                client,
                initialSession: session,
                executionContext: makeExecutionContext({ sessionPath: session.path }),
                modelSelection: makeModel(),
            })
        );

        await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());
        act(() => {
            client.emit(session.path, {
                type: "session_state",
                messages: [],
                turns: [],
                status: "idle",
                steer: [],
                followUp: [],
                rewindState: makeRewindState(),
            });
        });

        expect(result.current.rewindState).toEqual(makeRewindState());

        const replacement = makeRewindState({
            semanticLeafId: "state-2",
            displayLeafId: "assistant-2",
            eligibleTurnIds: ["user-2", "user-3"],
            busy: true,
            frozen: true,
            redo: undefined,
        });
        act(() => {
            client.emit(session.path, {
                type: "session_state",
                messages: [],
                turns: [],
                status: "streaming",
                steer: [],
                followUp: [],
                rewindState: replacement,
            });
        });

        expect(result.current.rewindState).toEqual(replacement);
        expect(result.current.rewindState.redo).toBeUndefined();
    });

    it("hydrates persisted redo from a cold getSessionState result without starting a competing pull", async () => {
        const client = makeClient();
        const session = makeSession("/repo/.agent/resumed.jsonl");
        const coldState = {
            type: "session_state",
            messages: [],
            turns: [],
            status: "idle",
            steer: [],
            followUp: [],
            commands: [],
            rewindState: makeRewindState(),
        };
        client.getSessionState.mockResolvedValue(coldState);
        const { result } = renderHook(() =>
            usePiChat({
                client,
                initialSession: session,
                executionContext: makeExecutionContext({ sessionPath: session.path }),
                modelSelection: makeModel(),
            })
        );

        await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());
        const persistedReplay = await client.getSessionState(session);
        act(() => client.emit(session.path, persistedReplay));

        expect(result.current.rewindState.redo).toEqual(
            expect.objectContaining({
                operationId: "op-1",
            })
        );
        expect(client.getSessionState).toHaveBeenCalledOnce();
    });

    it("uses explicit empty rewind state when authoritative replay omits rewindState", async () => {
        const client = makeClient();
        const session = makeSession("/repo/.agent/a.jsonl");
        const { result } = renderHook(() =>
            usePiChat({
                client,
                initialSession: session,
                executionContext: makeExecutionContext({ sessionPath: session.path }),
                modelSelection: makeModel(),
            })
        );

        await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());
        act(() => {
            client.emit(session.path, {
                type: "session_state",
                messages: [],
                turns: [],
                status: "idle",
                steer: [],
                followUp: [],
                rewindState: makeRewindState(),
            });
            client.emit(session.path, {
                type: "session_state",
                messages: [],
                turns: [],
                status: "idle",
                steer: [],
                followUp: [],
            });
        });

        expect(result.current.rewindState).toEqual({
            enabled: false,
            semanticLeafId: null,
            displayLeafId: null,
            eligibleTurnIds: [],
            busy: false,
            frozen: false,
            quota: {
                status: "ok",
                usedBytes: 0,
                softQuotaBytes: 5 * 1024 ** 3,
                cleanupAvailable: false,
            },
        });
    });

    it("switching controlled sessions resets A, unsubscribes it, and subscribes B without a competing pull", async () => {
        const client = makeClient();
        const sessionA = makeSession("/repo/.agent/a.jsonl");
        const sessionB = makeSession("/repo/.agent/b.jsonl");
        const { result, rerender } = renderHook(
            ({ session }) =>
                usePiChat({
                    client,
                    initialSession: session,
                    controlledSession: { metadata: session },
                    executionContext: makeExecutionContext({ sessionPath: session.path }),
                    modelSelection: makeModel(),
                }),
            { initialProps: { session: sessionA } }
        );

        await waitFor(() => expect(client.subscribe).toHaveBeenCalledWith(sessionA.path, expect.any(Function)));
        act(() => {
            client.emit(sessionA.path, {
                type: "session_state",
                messages: [{ role: "user", content: [{ type: "text", text: "session A" }] }],
                turns: [{ turnId: "turn-a", responseMessages: [], status: "done" }],
                status: "error",
                steer: [{ role: "user", content: [{ type: "text", text: "queued A" }] }],
                followUp: [],
                commands: [{ commandId: "cmd-a" }],
                rewindState: makeRewindState(),
            });
        });
        rerender({ session: sessionB });

        await waitFor(() => expect(client.subscribe).toHaveBeenCalledWith(sessionB.path, expect.any(Function)));
        expect(client.unsubscribed).toContain(sessionA.path);
        expect(client.getSessionState).not.toHaveBeenCalled();
        expect(result.current.messages).toEqual([]);
        expect(result.current.turns).toEqual([]);
        expect(result.current.queuedMessages).toEqual([]);
        expect(result.current.commands).toEqual([]);
        expect(result.current.status).toBe("idle");
        expect(result.current.errorMessage).toBeUndefined();
        expect(result.current.rewindState.redo).toBeUndefined();
    });

    it("explicitly clearing a controlled session resets session-local state and releases its subscription", async () => {
        const client = makeClient();
        const session = makeSession("/repo/.agent/a.jsonl");
        const { result, rerender } = renderHook(
            ({ session }: { session: AgentSessionMeta | undefined }) =>
                usePiChat({
                    client,
                    initialSession: session,
                    controlledSession: { metadata: session },
                    executionContext: makeExecutionContext({ sessionPath: session?.path }),
                    modelSelection: makeModel(),
                }),
            { initialProps: { session } }
        );

        await waitFor(() => expect(client.subscribe).toHaveBeenCalledWith(session.path, expect.any(Function)));
        act(() => {
            client.emit(session.path, {
                type: "session_state",
                messages: [{ role: "user", content: [{ type: "text", text: "old" }] }],
                turns: [{ turnId: "turn-a", responseMessages: [], status: "done" }],
                status: "error",
                steer: [{ role: "user", content: [{ type: "text", text: "queued" }] }],
                commands: [{ commandId: "cmd-a" }],
            });
        });

        rerender({ session: undefined });

        await waitFor(() => expect(result.current.sessionMetadata).toBeUndefined());
        expect(client.unsubscribed).toContain(session.path);
        expect(result.current.messages).toEqual([]);
        expect(result.current.turns).toEqual([]);
        expect(result.current.queuedMessages).toEqual([]);
        expect(result.current.commands).toEqual([]);
        expect(result.current.status).toBe("idle");
        expect(result.current.errorMessage).toBeUndefined();
    });

    it("does not clear a locally minted session when the initial session prop was omitted", async () => {
        const client = makeClient();
        const { result, rerender } = renderHook(
            ({ marker }) => {
                void marker;
                return usePiChat({
                    client,
                    executionContext: makeExecutionContext(),
                    modelSelection: makeModel(),
                });
            },
            { initialProps: { marker: 0 } }
        );

        await act(async () => {
            await result.current.send("mint");
        });
        rerender({ marker: 1 });

        expect(result.current.sessionMetadata?.path).toBe("/repo/.agent/new.jsonl");
        expect(client.subscribe).toHaveBeenCalledWith("/repo/.agent/new.jsonl", expect.any(Function));
    });

    it("ignores a pending send result after the controlled session switches from A to B", async () => {
        const client = makeClient();
        const sessionA = makeSession("/repo/.agent/a.jsonl");
        const sessionB = makeSession("/repo/.agent/b.jsonl");
        const pendingSend = deferred<{ sessionMetadata: AgentSessionMeta; turnId: string }>();
        client.send.mockImplementationOnce(() => pendingSend.promise);
        const onSessionChange = vi.fn();
        const { result, rerender } = renderHook(
            ({ session }) =>
                usePiChat({
                    client,
                    initialSession: session,
                    controlledSession: { metadata: session },
                    executionContext: makeExecutionContext({ sessionPath: session.path }),
                    modelSelection: makeModel(),
                    onSessionChange,
                }),
            { initialProps: { session: sessionA } }
        );

        await waitFor(() => expect(client.subscribe).toHaveBeenCalledWith(sessionA.path, expect.any(Function)));
        let sending!: Promise<void>;
        act(() => {
            sending = result.current.send("pending A");
        });
        await waitFor(() => expect(client.send).toHaveBeenCalledOnce());

        rerender({ session: sessionB });
        await waitFor(() => expect(client.subscribe).toHaveBeenCalledWith(sessionB.path, expect.any(Function)));
        pendingSend.resolve({ sessionMetadata: sessionA, turnId: "turn-a" });
        await act(async () => {
            await sending;
        });

        expect(result.current.sessionMetadata).toEqual(sessionB);
        expect(result.current.status).toBe("idle");
        expect(result.current.errorMessage).toBeUndefined();
        expect(onSessionChange).not.toHaveBeenCalled();
        act(() => result.current.abort());
        expect(client.abort).toHaveBeenLastCalledWith(sessionB.path);
        expect(client.unsubscribed).not.toContain(sessionB.path);
    });

    it("opens a fresh request epoch before caller layout effects after a controlled reset", async () => {
        const client = makeClient();
        const staleSession = makeSession("/repo/.agent/stale.jsonl");
        const freshSession = makeSession("/repo/.agent/fresh.jsonl");
        const staleCreate = deferred<AgentSessionMeta>();
        const freshCreate = deferred<AgentSessionMeta>();
        client.createSession
            .mockImplementationOnce(() => staleCreate.promise)
            .mockImplementationOnce(() => freshCreate.promise);
        const onSessionChange = vi.fn();
        let freshSend: Promise<void> | undefined;
        const { result, rerender } = renderHook(
            ({ revision, startFresh }: { revision: number; startFresh: boolean }) => {
                const chat = usePiChat({
                    client,
                    controlledSession: { metadata: undefined, revision },
                    executionContext: makeExecutionContext(),
                    modelSelection: makeModel(),
                    onSessionChange,
                });
                useLayoutEffect(() => {
                    if (startFresh) {
                        staleCreate.resolve(staleSession);
                        freshSend = chat.send("fresh");
                    }
                }, [startFresh]);
                return chat;
            },
            { initialProps: { revision: 0, startFresh: false } }
        );

        let staleSend!: Promise<void>;
        act(() => {
            staleSend = result.current.send("stale");
        });
        await waitFor(() => expect(client.createSession).toHaveBeenCalledOnce());

        rerender({ revision: 1, startFresh: true });
        expect(client.createSession).toHaveBeenCalledTimes(2);
        await act(async () => {
            freshCreate.resolve(freshSession);
            await freshSend;
            await staleSend;
        });

        expect(client.send).toHaveBeenCalledOnce();
        expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ sessionMetadata: freshSession }));
        expect(onSessionChange).toHaveBeenCalledOnce();
        expect(onSessionChange).toHaveBeenCalledWith(freshSession);
    });

    it("ignores a pending send error after the controlled session switches", async () => {
        const client = makeClient();
        const sessionA = makeSession("/repo/.agent/a.jsonl");
        const sessionB = makeSession("/repo/.agent/b.jsonl");
        const pendingSend = deferred<{ sessionMetadata: AgentSessionMeta; turnId: string }>();
        client.send.mockImplementationOnce(() => pendingSend.promise);
        const { result, rerender } = renderHook(
            ({ session }) =>
                usePiChat({
                    client,
                    initialSession: session,
                    controlledSession: { metadata: session },
                    executionContext: makeExecutionContext({ sessionPath: session.path }),
                    modelSelection: makeModel(),
                }),
            { initialProps: { session: sessionA } }
        );

        let sending!: Promise<void>;
        act(() => {
            sending = result.current.send("pending A");
        });
        await waitFor(() => expect(client.send).toHaveBeenCalledOnce());
        rerender({ session: sessionB });
        await waitFor(() => expect(result.current.sessionMetadata).toEqual(sessionB));

        pendingSend.reject(new Error("stale A failure"));
        await act(async () => {
            await sending;
        });

        expect(result.current.sessionMetadata).toEqual(sessionB);
        expect(result.current.status).toBe("idle");
        expect(result.current.errorMessage).toBeUndefined();
    });

    it("marks a failed first send with the accepted minted session identity", async () => {
        const client = makeClient();
        const mintedSession = makeSession("/repo/.agent/minted.jsonl");
        client.createSession.mockResolvedValueOnce(mintedSession);
        client.send.mockRejectedValueOnce(new Error("send failed"));
        const onSessionChange = vi.fn();
        const { result } = renderHook(() =>
            usePiChat({
                client,
                executionContext: makeExecutionContext(),
                modelSelection: makeModel(),
                onSessionChange,
            })
        );

        let failure: unknown;
        await act(async () => {
            try {
                await result.current.send("restore me");
            } catch (error) {
                failure = error;
            }
        });

        expect(onSessionChange).toHaveBeenCalledWith(mintedSession);
        expect(composerRestoreTextFromSendError(failure)).toBe("restore me");
        expect(composerRestoreMintedSessionPathFromSendError(failure)).toBe(mintedSession.path);
    });

    it("ignores a pending createSession result after a same-value controlled clear revision", async () => {
        const client = makeClient();
        const createdSession = makeSession("/repo/.agent/created.jsonl");
        const pendingCreate = deferred<AgentSessionMeta>();
        client.createSession.mockImplementationOnce(() => pendingCreate.promise);
        const onSessionChange = vi.fn();
        const { result, rerender } = renderHook(
            ({ revision }) =>
                usePiChat({
                    client,
                    controlledSession: { metadata: undefined, revision },
                    executionContext: makeExecutionContext(),
                    modelSelection: makeModel(),
                    onSessionChange,
                }),
            { initialProps: { revision: 0 } }
        );

        let sending!: Promise<void>;
        act(() => {
            sending = result.current.send("pending create");
        });
        await waitFor(() => expect(client.createSession).toHaveBeenCalledOnce());

        rerender({ revision: 1 });
        pendingCreate.resolve(createdSession);
        await act(async () => {
            await sending;
        });

        expect(client.send).not.toHaveBeenCalled();
        expect(onSessionChange).not.toHaveBeenCalled();
        expect(result.current.sessionMetadata).toBeUndefined();
        expect(result.current.status).toBe("idle");
        expect(result.current.errorMessage).toBeUndefined();
        expect(client.subscribe).not.toHaveBeenCalled();
    });

    it("acknowledges a first controlled mint once while its send is pending", async () => {
        const client = makeClient();
        const createdSession = makeSession("/repo/.agent/created.jsonl");
        const pendingCreate = deferred<AgentSessionMeta>();
        const pendingSend = deferred<{ sessionMetadata: AgentSessionMeta; turnId: string }>();
        client.createSession.mockImplementationOnce(() => pendingCreate.promise);
        client.send.mockImplementationOnce(() => pendingSend.promise);
        const onSessionChange = vi.fn();
        const { result } = renderHook(() => {
            const [control, setControl] = useState<{
                metadata?: AgentSessionMeta;
                revision: number;
            }>({ metadata: undefined, revision: 0 });
            const chat = usePiChat({
                client,
                controlledSession: control,
                executionContext: makeExecutionContext(),
                modelSelection: makeModel(),
                onSessionChange: (metadata) => {
                    onSessionChange(metadata);
                    setControl((current) => ({
                        metadata,
                        revision: current.revision + 1,
                    }));
                },
            });
            return { chat, control };
        });

        let sending!: Promise<void>;
        act(() => {
            sending = result.current.chat.send("first prompt");
        });
        await waitFor(() => expect(client.createSession).toHaveBeenCalledOnce());
        await act(async () => {
            pendingCreate.resolve(createdSession);
            await Promise.resolve();
        });
        await waitFor(() => expect(client.send).toHaveBeenCalledOnce());
        await waitFor(() => expect(result.current.control.revision).toBe(1));

        await act(async () => {
            pendingSend.resolve({ sessionMetadata: createdSession, turnId: "turn-created" });
            await sending;
        });

        expect(onSessionChange).toHaveBeenCalledTimes(1);
        expect(onSessionChange).toHaveBeenCalledWith(createdSession);
        expect(result.current.control).toEqual({ metadata: createdSession, revision: 1 });
        expect(result.current.chat.sessionMetadata).toEqual(createdSession);
        expect(result.current.chat.status).toBe("streaming");
        expect(result.current.chat.errorMessage).toBeUndefined();
        expect(client.subscribe).toHaveBeenCalledWith(createdSession.path, expect.any(Function));
    });

    it("acknowledges a genuinely different runtime session path once", async () => {
        const client = makeClient();
        const sessionA = makeSession("/repo/.agent/a.jsonl");
        const sessionB = makeSession("/repo/.agent/b.jsonl");
        const pendingSend = deferred<{ sessionMetadata: AgentSessionMeta; turnId: string }>();
        client.send.mockImplementationOnce(() => pendingSend.promise);
        const onSessionChange = vi.fn();
        const { result } = renderHook(() => {
            const [control, setControl] = useState({
                metadata: sessionA as AgentSessionMeta | undefined,
                revision: 0,
            });
            const chat = usePiChat({
                client,
                controlledSession: control,
                executionContext: makeExecutionContext({ sessionPath: control.metadata?.path }),
                modelSelection: makeModel(),
                onSessionChange: (metadata) => {
                    onSessionChange(metadata);
                    setControl((current) => ({
                        metadata,
                        revision: current.revision + 1,
                    }));
                },
            });
            return { chat, control };
        });

        let sending!: Promise<void>;
        act(() => {
            sending = result.current.chat.send("switch runtime path");
        });
        await waitFor(() => expect(client.send).toHaveBeenCalledOnce());
        await act(async () => {
            pendingSend.resolve({ sessionMetadata: sessionB, turnId: "turn-b" });
            await sending;
        });

        expect(onSessionChange).toHaveBeenCalledTimes(1);
        expect(onSessionChange).toHaveBeenCalledWith(sessionB);
        expect(result.current.control).toEqual({ metadata: sessionB, revision: 1 });
        expect(result.current.chat.sessionMetadata).toEqual(sessionB);
        expect(result.current.chat.status).toBe("streaming");
        expect(client.subscribe).toHaveBeenCalledWith(sessionB.path, expect.any(Function));
    });

    it("shares one pending session creation across rapid submits", async () => {
        const client = makeClient();
        const createdSession = makeSession("/repo/.agent/shared.jsonl");
        const pendingCreate = deferred<AgentSessionMeta>();
        client.createSession.mockImplementation(() => pendingCreate.promise);
        const onSessionChange = vi.fn();
        const { result } = renderHook(() => {
            const [control, setControl] = useState<{
                metadata?: AgentSessionMeta;
                revision: number;
            }>({ metadata: undefined, revision: 0 });
            const chat = usePiChat({
                client,
                controlledSession: control,
                executionContext: makeExecutionContext(),
                modelSelection: makeModel(),
                onSessionChange: (metadata) => {
                    onSessionChange(metadata);
                    setControl((current) => ({
                        metadata,
                        revision: current.revision + 1,
                    }));
                },
            });
            return chat;
        });

        let firstSend!: Promise<void>;
        let secondSend!: Promise<void>;
        act(() => {
            firstSend = result.current.send("first");
            secondSend = result.current.send("second");
        });
        await waitFor(() => expect(client.createSession).toHaveBeenCalled());
        await act(async () => {
            pendingCreate.resolve(createdSession);
            await Promise.all([firstSend, secondSend]);
        });

        expect(client.createSession).toHaveBeenCalledTimes(1);
        expect(client.send).toHaveBeenCalledTimes(2);
        expect(client.send.mock.calls[0][0].sessionMetadata).toEqual(createdSession);
        expect(client.send.mock.calls[1][0].sessionMetadata).toEqual(createdSession);
        expect(onSessionChange).toHaveBeenCalledTimes(1);
    });

    it("starts a fresh session creation after a controlled reset", async () => {
        const client = makeClient();
        const staleSession = makeSession("/repo/.agent/stale.jsonl");
        const freshSession = makeSession("/repo/.agent/fresh.jsonl");
        const staleCreate = deferred<AgentSessionMeta>();
        const freshCreate = deferred<AgentSessionMeta>();
        client.createSession
            .mockImplementationOnce(() => staleCreate.promise)
            .mockImplementationOnce(() => freshCreate.promise);
        const onSessionChange = vi.fn();
        const { result, rerender } = renderHook(
            ({ revision }) =>
                usePiChat({
                    client,
                    controlledSession: { metadata: undefined, revision },
                    executionContext: makeExecutionContext(),
                    modelSelection: makeModel(),
                    onSessionChange,
                }),
            { initialProps: { revision: 0 } }
        );

        let staleSend!: Promise<void>;
        act(() => {
            staleSend = result.current.send("stale");
        });
        await waitFor(() => expect(client.createSession).toHaveBeenCalledTimes(1));
        rerender({ revision: 1 });

        let freshSend!: Promise<void>;
        act(() => {
            freshSend = result.current.send("fresh");
        });
        await waitFor(() => expect(client.createSession).toHaveBeenCalledTimes(2));
        await act(async () => {
            freshCreate.resolve(freshSession);
            await freshSend;
        });
        await act(async () => {
            staleCreate.resolve(staleSession);
            await staleSend;
        });

        expect(client.send).toHaveBeenCalledTimes(1);
        expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ sessionMetadata: freshSession }));
        expect(onSessionChange).toHaveBeenCalledTimes(1);
        expect(onSessionChange).toHaveBeenCalledWith(freshSession);
    });

    it("changes session subscription activity without rerendering the chat hook", async () => {
        const client = makeClient();
        const session = makeSession("/repo/.agent/a.jsonl");
        const activity = makeAgentSurfaceActivityController(true);
        let renderCount = 0;
        const { result } = renderHook(() => {
            renderCount++;
            return usePiChat({
                client,
                initialSession: session,
                executionContext: makeExecutionContext({ sessionPath: session.path }),
                modelSelection: makeModel(),
                activity,
            });
        });

        await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());
        act(() => {
            client.emit(session.path, {
                type: "session_state",
                messages: [{ role: "user", content: [{ type: "text", text: `snapshot:${session.path}` }] }],
                turns: [],
                status: "idle",
                steer: [],
                followUp: [],
                commands: [],
            });
        });
        const rendersAfterSnapshot = renderCount;

        act(() => activity.setActive(false));
        await waitFor(() => expect(client.unsubscribed).toContain(session.path));
        expect(result.current.messages[0]?.content?.[0]?.text).toBe(`snapshot:${session.path}`);
        expect(renderCount).toBe(rendersAfterSnapshot);

        act(() => activity.setActive(true));
        await waitFor(() => expect(client.subscribe).toHaveBeenCalledTimes(2));
        expect(renderCount).toBe(rendersAfterSnapshot);
    });

    it("mirrors hosted PTY command snapshots from session state only while visible", async () => {
        const client = makeClient();
        const session = makeSession("/repo/.agent/a.jsonl");
        const activity = makeAgentSurfaceActivityController(true);
        const snapshot: AgentPtySnapshot = {
            commandId: "cmd-1",
            command: "npm test",
            cwd: "/repo",
            tail: "ready",
            screen: {
                rows: [{ text: "ready", cells: [{ char: "r" }] }],
                cursor: { row: 0, col: 0, visible: true, shape: "block", blink: false },
                isAltScreenActive: false,
            },
            running: true,
            cols: 80,
            rows: 24,
            needsUserInput: true,
        };
        const { result } = renderHook(() =>
            usePiChat({
                client,
                initialSession: session,
                executionContext: makeExecutionContext({ sessionPath: session.path }),
                modelSelection: makeModel(),
                activity,
            })
        );

        await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());
        act(() => {
            client.emit(session.path, {
                type: "session_state",
                messages: [],
                turns: [],
                status: "idle",
                steer: [],
                followUp: [],
                commands: [snapshot],
            });
        });
        expect(result.current.commands[0]?.commandId).toBe("cmd-1");

        act(() => activity.setActive(false));

        expect(result.current.commands).toEqual([snapshot]);
        expect(client.unsubscribed).toContain(session.path);
    });

    it("late events from the previous subscribed session are ignored after switching", async () => {
        const client = makeClient();
        const sessionA = makeSession("/repo/.agent/a.jsonl");
        const sessionB = makeSession("/repo/.agent/b.jsonl");
        const { result, rerender } = renderHook(
            ({ session }) =>
                usePiChat({
                    client,
                    initialSession: session,
                    controlledSession: { metadata: session },
                    executionContext: makeExecutionContext({ sessionPath: session.path }),
                    modelSelection: makeModel(),
                }),
            { initialProps: { session: sessionA } }
        );

        await waitFor(() => expect(client.getSubscriber(sessionA.path)).toBeDefined());
        const oldCallback = client.getSubscriber(sessionA.path);
        act(() => {
            client.emit(sessionA.path, {
                type: "session_state",
                messages: [{ role: "user", content: [{ type: "text", text: "session A" }] }],
                turns: [],
                status: "idle",
                steer: [],
                followUp: [],
                rewindState: makeRewindState(),
            });
        });
        rerender({ session: sessionB });
        expect(result.current.rewindState.redo).toBeUndefined();
        await waitFor(() => expect(client.getSubscriber(sessionB.path)).toBeDefined());
        act(() => {
            client.emit(sessionB.path, {
                type: "session_state",
                messages: [{ role: "user", content: [{ type: "text", text: `snapshot:${sessionB.path}` }] }],
                turns: [],
                status: "idle",
                steer: [],
                followUp: [],
                rewindState: makeRewindState({
                    semanticLeafId: "state-b",
                    displayLeafId: "user-b",
                    eligibleTurnIds: ["user-b"],
                    redo: undefined,
                }),
            });
        });

        act(() => {
            client.emitCaptured(oldCallback!, {
                type: "session_state",
                messages: [{ role: "assistant", content: [{ type: "text", text: "stale A" }] }],
                turns: [],
                status: "idle",
                steer: [],
                followUp: [],
                rewindState: makeRewindState(),
            });
        });

        expect(result.current.messages[0]?.content?.[0]?.text).toBe(`snapshot:${sessionB.path}`);
        expect(result.current.rewindState).toEqual(
            expect.objectContaining({
                semanticLeafId: "state-b",
                displayLeafId: "user-b",
                redo: undefined,
            })
        );
    });

    it("never starts an independent session-state pull that can race subscribe replay", async () => {
        const client = makeClient();
        const session = makeSession("/repo/.agent/a.jsonl");
        const stalePull = new Promise<Awaited<ReturnType<typeof client.getSessionState>>>(() => {});
        client.getSessionState.mockReturnValue(stalePull);
        const { result } = renderHook(() =>
            usePiChat({
                client,
                initialSession: session,
                executionContext: makeExecutionContext({ sessionPath: session.path }),
                modelSelection: makeModel(),
            })
        );

        await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());
        act(() => {
            client.emit(session.path, {
                type: "session_state",
                messages: [{ role: "assistant", content: [{ type: "text", text: "authoritative replay" }] }],
                turns: [],
                status: "idle",
                steer: [],
                followUp: [],
                commands: [],
            });
        });

        expect(client.getSessionState).not.toHaveBeenCalled();
        expect(result.current.messages[0]?.content?.[0]?.text).toBe("authoritative replay");
    });

    it("keeps an assistant error visible when agent_end follows message_end", async () => {
        const client = makeClient();
        const session = makeSession("/repo/.agent/a.jsonl");
        const { result } = renderHook(() =>
            usePiChat({
                client,
                initialSession: session,
                executionContext: makeExecutionContext({ sessionPath: session.path }),
                modelSelection: makeModel(),
            })
        );

        await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());
        act(() => {
            client.emit(session.path, {
                type: "message_end",
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "provider unavailable",
                    content: [{ type: "text", text: "" }],
                },
            });
            client.emit(session.path, { type: "agent_end", messages: [] });
        });

        expect(result.current.status).toBe("error");
        expect(result.current.errorMessage).toBe("provider unavailable");
    });

    it("a hidden running session remains main-owned and can still be aborted by session path", async () => {
        const client = makeClient();
        const session = makeSession("/repo/.agent/running.jsonl");
        const activity = makeAgentSurfaceActivityController(false);
        const { result } = renderHook(() =>
            usePiChat({
                client,
                initialSession: session,
                executionContext: makeExecutionContext({ sessionPath: session.path }),
                modelSelection: makeModel(),
                activity,
            })
        );

        await act(async () => {
            result.current.abort();
        });

        expect(client.subscribe).not.toHaveBeenCalled();
        expect(client.abort).toHaveBeenCalledWith(session.path);
    });
});

describe("reducePiChatEvent", () => {
    it("appends a user message_start", () => {
        const user: PiAgentMessage = { role: "user", content: [{ type: "text", text: "hi" }] };
        const out = reducePiChatEvent([], { type: "message_start", message: user });
        expect(out).toEqual([user]);
    });

    it("replaces the tail on message_update (streaming message state)", () => {
        const user: PiAgentMessage = { role: "user", content: [{ type: "text", text: "hi" }] };
        const partial: PiAgentMessage = {
            role: "assistant",
            content: [{ type: "text", text: "th" }],
        };
        const fuller: PiAgentMessage = {
            role: "assistant",
            content: [{ type: "text", text: "there" }],
        };
        const after1 = reducePiChatEvent([user], { type: "message_start", message: partial });
        const after2 = reducePiChatEvent(after1, { type: "message_update", message: fuller });
        expect(after2[after2.length - 1]).toEqual(fuller);
        expect(after2[0]).toEqual(user);
        expect(after2).toHaveLength(2);
    });

    it("message_end replaces the tail with the final message", () => {
        const partial: PiAgentMessage = {
            role: "assistant",
            content: [{ type: "text", text: "p" }],
        };
        const final: PiAgentMessage = {
            role: "assistant",
            content: [{ type: "text", text: "full" }],
            stopReason: "stop",
        };
        const after1 = reducePiChatEvent([], { type: "message_start", message: partial });
        const after2 = reducePiChatEvent(after1, { type: "message_end", message: final });
        expect(after2).toEqual([final]);
    });

    it("agent_end does NOT replace the transcript (its messages are turn-scoped)", () => {
        // agent_end.messages carries only the latest turn's messages, not the
        // whole conversation. The message_start/_end stream already appended
        // this turn's messages, so the reducer leaves state untouched.
        const accumulated: PiAgentMessage[] = [
            { role: "user", content: [{ type: "text", text: "q1" }] },
            { role: "assistant", content: [{ type: "text", text: "a1" }] },
            { role: "user", content: [{ type: "text", text: "q2" }] },
            { role: "assistant", content: [{ type: "text", text: "a2" }] },
        ];
        const runScoped: PiAgentMessage[] = [
            { role: "user", content: [{ type: "text", text: "q2" }] },
            { role: "assistant", content: [{ type: "text", text: "a2" }] },
        ];
        const out = reducePiChatEvent(accumulated, { type: "agent_end", messages: runScoped });
        expect(out).toBe(accumulated);
    });

    it("queue_update leaves the message array untouched (queue is separate state)", () => {
        const existing: PiAgentMessage[] = [{ role: "user", content: [{ type: "text", text: "q" }] }];
        const out = reducePiChatEvent(existing, {
            type: "queue_update",
            steer: [],
            followUp: [{ role: "user", content: [{ type: "text", text: "queued" }] }],
        });
        expect(out).toBe(existing);
    });

    it("session_state seeds the mirror with main's authoritative transcript", () => {
        // Sent once on (re)subscribe. A renderer that missed the first
        // turn's events (subscribed late) must back-fill from this. Replaces
        // local state wholesale.
        const authoritative: PiAgentMessage[] = [
            { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1000 },
            { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" },
        ];
        const out = reducePiChatEvent([], { type: "session_state", messages: authoritative });
        expect(out).toEqual(authoritative);
    });

    it("handles message_start on empty state without crashing", () => {
        const msg: PiAgentMessage = { role: "user", content: [] };
        expect(reducePiChatEvent([], { type: "message_start", message: msg })).toEqual([msg]);
    });

    it("handles message_update on empty state by seeding the message", () => {
        const msg: PiAgentMessage = { role: "assistant", content: [{ type: "text", text: "x" }] };
        expect(reducePiChatEvent([], { type: "message_update", message: msg })).toEqual([msg]);
    });

    it("returns the same reference for events with missing required payload", () => {
        const start: PiAgentMessage[] = [{ role: "user", content: [] }];
        expect(reducePiChatEvent(start, { type: "message_update" })).toBe(start);
        expect(reducePiChatEvent(start, { type: "agent_end" })).toBe(start);
    });

    it("returns the same reference for unknown event types", () => {
        const start: PiAgentMessage[] = [{ role: "user", content: [] }];
        expect(reducePiChatEvent(start, { type: "tool_execution_start" })).toBe(start);
        expect(reducePiChatEvent(start, { type: "something_we_dont_handle" })).toBe(start);
    });

    it("ignores legacy snapshot events", () => {
        const start: PiAgentMessage[] = [{ role: "user", content: [{ type: "text", text: "current" }] }];
        const legacy: PiAgentMessage[] = [{ role: "user", content: [{ type: "text", text: "legacy" }] }];

        expect(reducePiChatEvent(start, { type: "snapshot", messages: legacy })).toBe(start);
    });
});

describe("reducePiTurnsEvent", () => {
    it("keeps the same turn reference for events without main-owned turns", () => {
        const turns = [
            {
                turnId: "turn-owned",
                userMessage: { role: "user", content: [] } as PiAgentMessage,
                responseMessages: [],
                status: "streaming" as const,
            },
        ];

        expect(reducePiTurnsEvent(turns, { type: "message_start", message: turns[0].userMessage })).toBe(turns);
    });

    it("mirrors main-owned turns from session_state", () => {
        const userMessage = { role: "user", content: [{ type: "text", text: "q" }] } as PiAgentMessage;
        const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "a" }],
            stopReason: "stop",
        } as PiAgentMessage;

        const turns = [
            {
                turnId: "entry-xyz",
                userMessage,
                responseMessages: [assistantMessage],
                status: "done" as const,
            },
        ];

        const out = reducePiTurnsEvent([], {
            type: "session_state",
            turns: [
                {
                    turnId: "entry-xyz",
                    userMessage,
                    responseMessages: [assistantMessage],
                    status: "done",
                },
            ],
        });

        expect(out).toEqual(turns);
    });

    it("ignores legacy snapshot turn payloads", () => {
        const turns = [
            {
                turnId: "current",
                userMessage: { role: "user", content: [] } as PiAgentMessage,
                responseMessages: [],
                status: "streaming" as const,
            },
        ];

        expect(reducePiTurnsEvent(turns, { type: "snapshot", turns: [] })).toBe(turns);
    });
});

describe("resolveAbortSessionPath", () => {
    it("uses the active in-flight session path before React state commits metadata", () => {
        expect(resolveAbortSessionPath(undefined, "/tmp/agent.jsonl")).toBe("/tmp/agent.jsonl");
    });

    it("prefers committed session metadata over the in-flight path", () => {
        expect(
            resolveAbortSessionPath({ path: "/tmp/committed.jsonl" } as AgentSessionMeta, "/tmp/inflight.jsonl")
        ).toBe("/tmp/committed.jsonl");
    });
});

describe("getOptimisticAbortStatus", () => {
    it("unblocks a locally streaming renderer while waiting for the owner abort event", () => {
        expect(getOptimisticAbortStatus("streaming")).toBe("idle");
    });

    it("does not erase existing error state", () => {
        expect(getOptimisticAbortStatus("error")).toBe("error");
    });
});

describe("adoptInitialSessionMetadata", () => {
    it("adopts a session path that arrives after the hook mounted", () => {
        const incoming = { path: "/tmp/session.jsonl", id: "s1", cwd: "/tmp", createdAt: "" } as AgentSessionMeta;

        expect(adoptInitialSessionMetadata(undefined, incoming)).toBe(incoming);
    });

    it("clears the current session when the controlled value is empty", () => {
        const current = { path: "/tmp/current.jsonl", id: "s1", cwd: "/tmp", createdAt: "" } as AgentSessionMeta;

        expect(adoptInitialSessionMetadata(current, undefined)).toBeUndefined();
    });
});
