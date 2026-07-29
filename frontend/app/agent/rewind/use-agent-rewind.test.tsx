// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeClient } from "../agent-runtime-client";
import { useAgentRewind, type UseAgentRewindOptions } from "./use-agent-rewind";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function makeSession(path: string): AgentSessionMeta {
    return { path, id: path.split("/").pop() ?? path } as AgentSessionMeta;
}

function makeRewindState(overrides: Partial<AgentRewindSessionStateView> = {}): AgentRewindSessionStateView {
    return {
        enabled: true,
        semanticLeafId: "leaf-a",
        displayLeafId: "turn-a",
        eligibleTurnIds: ["turn-a"],
        busy: false,
        frozen: false,
        quota: {
            status: "ok",
            usedBytes: 0,
            softQuotaBytes: 5 * 1024 ** 3,
            cleanupAvailable: false,
        },
        ...overrides,
    };
}

function makePreview(
    target: AgentRewindPreviewResult["target"],
    overrides: Partial<AgentRewindPreviewResult> = {}
): AgentRewindPreviewResult {
    return {
        confirmationToken: "opaque.token/with+bytes==",
        target,
        semanticLeafId: "leaf-a",
        displayLeafId: target.kind === "rewind" ? target.targetTurnId : "turn-a",
        expectedSemanticLeafId: "leaf-a",
        messageCount: 2,
        fileCount: 1,
        files: [
            {
                path: "src/index.ts",
                operation: "write",
                additions: 1,
                deletions: 2,
                coverage: "covered",
                conflict: "none",
            },
        ],
        coverageWarnings: [],
        forceRequired: false,
        hardBlocked: false,
        ...overrides,
    };
}

function makeClient(overrides: Partial<AgentRuntimeClient> = {}) {
    return {
        listRewindPoints: vi.fn(async () => ({
            points: [{ turnId: "turn-a", preview: "First prompt", eligible: true }],
            semanticLeafId: "leaf-a",
            displayLeafId: "turn-a",
        })),
        previewRewind: vi.fn(async (input: AgentPreviewRewindInput) => makePreview(input.target)),
        rewindTree: vi.fn(async () => ({
            sessionMetadata: makeSession("/sessions/a.jsonl"),
            semanticLeafId: "turn-a",
            displayLeafId: "turn-a",
            editorText: "restored draft",
        })),
        redoRewind: vi.fn(async () => ({
            sessionMetadata: makeSession("/sessions/a.jsonl"),
            semanticLeafId: "leaf-redone",
            displayLeafId: "turn-redone",
        })),
        ...overrides,
    } as unknown as AgentRuntimeClient;
}

function options(client: AgentRuntimeClient, overrides: Partial<UseAgentRewindOptions> = {}): UseAgentRewindOptions {
    return {
        client,
        sessionMetadata: makeSession("/sessions/a.jsonl"),
        sessionRevision: 1,
        rewindState: makeRewindState(),
        onRevealTurn: vi.fn(async () => true),
        onEditorText: vi.fn(),
        onError: vi.fn(),
        ...overrides,
    };
}

describe("useAgentRewind", () => {
    it("uses one rewind preview path for message and selector actions, revealing selector picks first", async () => {
        const client = makeClient();
        const hookOptions = options(client);
        const { result } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openRewind("turn-a"));
        act(() => result.current.cancelPreview());
        await act(() => result.current.openSelector());
        await act(() => result.current.selectRewindPoint("turn-a"));

        expect(hookOptions.onRevealTurn).toHaveBeenCalledWith("turn-a", expect.any(AbortSignal));
        expect(vi.mocked(hookOptions.onRevealTurn).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(client.previewRewind).mock.invocationCallOrder[1]!
        );
        expect(client.previewRewind).toHaveBeenCalledTimes(2);
        expect(vi.mocked(client.previewRewind).mock.calls[0]).toEqual(vi.mocked(client.previewRewind).mock.calls[1]);
        expect(client.previewRewind).toHaveBeenLastCalledWith({
            sessionMetadata: hookOptions.sessionMetadata,
            expectedSemanticLeafId: "leaf-a",
            target: { kind: "rewind", targetTurnId: "turn-a" },
        });
    });

    it("supersedes a pending selector reveal when a second point is picked rapidly", async () => {
        const firstReveal = deferred<boolean>();
        const secondReveal = deferred<boolean>();
        const onRevealTurn = vi.fn((turnId: string) =>
            turnId === "turn-a" ? firstReveal.promise : secondReveal.promise
        );
        const client = makeClient({
            listRewindPoints: vi.fn(async () => ({
                points: [
                    { turnId: "turn-a", preview: "First", eligible: true },
                    { turnId: "turn-b", preview: "Second", eligible: true },
                ],
                semanticLeafId: "leaf-a",
                displayLeafId: "turn-a",
            })) as never,
        });
        const { result } = renderHook(() => useAgentRewind(options(client, { onRevealTurn })));

        await act(() => result.current.openSelector());
        let firstPick!: Promise<void>;
        let secondPick!: Promise<void>;
        act(() => {
            firstPick = result.current.selectRewindPoint("turn-a");
            secondPick = result.current.selectRewindPoint("turn-b");
        });
        await act(async () => {
            firstReveal.resolve(true);
            await firstPick;
        });
        expect(client.previewRewind).not.toHaveBeenCalled();

        await act(async () => {
            secondReveal.resolve(true);
            await secondPick;
        });
        expect(client.previewRewind).toHaveBeenCalledOnce();
        expect(client.previewRewind).toHaveBeenCalledWith(
            expect.objectContaining({ target: { kind: "rewind", targetTurnId: "turn-b" } })
        );
    });

    it("aborts a never-mounted reveal when the selector closes", async () => {
        const onRevealTurn = vi.fn(
            (_turnId: string, signal?: AbortSignal) =>
                new Promise<boolean>((resolve) =>
                    signal?.addEventListener("abort", () => resolve(false), { once: true })
                )
        );
        const client = makeClient();
        const { result } = renderHook(() => useAgentRewind(options(client, { onRevealTurn })));

        await act(() => result.current.openSelector());
        let pick!: Promise<void>;
        act(() => {
            pick = result.current.selectRewindPoint("turn-a");
        });
        const signal = onRevealTurn.mock.calls[0]?.[1];
        expect(signal).toBeInstanceOf(AbortSignal);
        act(() => result.current.closeSelector());
        if (signal) {
            await act(() => pick);
        }

        expect(signal?.aborted).toBe(true);
        expect(client.previewRewind).not.toHaveBeenCalled();
    });

    it("aborts a never-mounted reveal when the controlled session switches", async () => {
        const onRevealTurn = vi.fn(
            (_turnId: string, signal?: AbortSignal) =>
                new Promise<boolean>((resolve) =>
                    signal?.addEventListener("abort", () => resolve(false), { once: true })
                )
        );
        const client = makeClient();
        let hookOptions = options(client, { onRevealTurn });
        const { result, rerender } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openSelector());
        let pick!: Promise<void>;
        act(() => {
            pick = result.current.selectRewindPoint("turn-a");
        });
        const signal = onRevealTurn.mock.calls[0]?.[1];
        hookOptions = options(client, {
            onRevealTurn,
            sessionMetadata: makeSession("/sessions/b.jsonl"),
            sessionRevision: 2,
            rewindState: makeRewindState({ semanticLeafId: "leaf-b", eligibleTurnIds: ["turn-b"] }),
        });
        rerender();
        await act(() => pick);

        expect(signal?.aborted).toBe(true);
        expect(client.previewRewind).not.toHaveBeenCalled();
    });

    it("hydrates selector points only for the captured session revision and semantic leaf", async () => {
        const pending = deferred<AgentListRewindPointsResult>();
        const client = makeClient({ listRewindPoints: vi.fn(() => pending.promise) as never });
        let hookOptions = options(client);
        const { result, rerender } = renderHook(() => useAgentRewind(hookOptions));

        act(() => {
            void result.current.openSelector();
        });
        hookOptions = options(client, {
            sessionMetadata: makeSession("/sessions/b.jsonl"),
            sessionRevision: 2,
            rewindState: makeRewindState({ semanticLeafId: "leaf-b", eligibleTurnIds: ["turn-b"] }),
        });
        rerender();
        pending.resolve({
            points: [{ turnId: "turn-a", preview: "Stale A", eligible: true }],
            semanticLeafId: "leaf-a",
            displayLeafId: "turn-a",
        });

        await waitFor(() => expect(result.current.selector.open).toBe(false));
        expect(result.current.selector.points).toEqual([]);
        await act(() => result.current.selectRewindPoint("turn-a"));
        expect(hookOptions.onRevealTurn).not.toHaveBeenCalled();
        expect(client.previewRewind).not.toHaveBeenCalled();

        vi.mocked(client.listRewindPoints).mockResolvedValueOnce({
            points: [{ turnId: "turn-b", preview: "Wrong leaf", eligible: true }],
            semanticLeafId: "different-leaf",
            displayLeafId: "turn-b",
        });
        await act(() => result.current.openSelector());
        expect(result.current.selector.points).toEqual([]);
        expect(result.current.selector.phase).toBe("error");
    });

    it("drops a late preview and prevents apply after the captured session becomes stale", async () => {
        const pending = deferred<AgentRewindPreviewResult>();
        const client = makeClient({ previewRewind: vi.fn(() => pending.promise) as never });
        let hookOptions = options(client);
        const { result, rerender } = renderHook(() => useAgentRewind(hookOptions));

        act(() => {
            void result.current.openRewind("turn-a");
        });
        hookOptions = options(client, {
            sessionMetadata: makeSession("/sessions/b.jsonl"),
            sessionRevision: 2,
            rewindState: makeRewindState({ semanticLeafId: "leaf-b", eligibleTurnIds: ["turn-b"] }),
        });
        rerender();
        pending.resolve(makePreview({ kind: "rewind", targetTurnId: "turn-a" }));

        await waitFor(() => expect(result.current.preview.open).toBe(false));
        await act(() => result.current.confirmPreview("normal"));
        expect(client.rewindTree).not.toHaveBeenCalled();
    });

    it("drops a late apply result after the captured session becomes stale", async () => {
        const pending = deferred<AgentRewindMutationResult>();
        const client = makeClient({ rewindTree: vi.fn(() => pending.promise) as never });
        let hookOptions = options(client);
        const onEditorText = hookOptions.onEditorText;
        const { result, rerender } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openRewind("turn-a"));
        act(() => {
            void result.current.confirmPreview("normal");
        });
        hookOptions = options(client, {
            sessionMetadata: makeSession("/sessions/b.jsonl"),
            sessionRevision: 2,
            rewindState: makeRewindState({ semanticLeafId: "leaf-b", eligibleTurnIds: ["turn-b"] }),
        });
        rerender();
        pending.resolve({
            sessionMetadata: makeSession("/sessions/a.jsonl"),
            semanticLeafId: "turn-a",
            displayLeafId: "turn-a",
            editorText: "stale A draft",
        });

        await waitFor(() => expect(result.current.preview.open).toBe(false));
        expect(onEditorText).not.toHaveBeenCalled();
    });

    it("returns the opaque token unchanged, preserves preview rows, and restores editor text after normal apply", async () => {
        const preview = makePreview({ kind: "rewind", targetTurnId: "turn-a" });
        const client = makeClient({ previewRewind: vi.fn(async () => preview) as never });
        const hookOptions = options(client);
        const { result } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openRewind("turn-a"));
        expect(result.current.preview.result).toBe(preview);
        expect(result.current.preview.result?.files).toBe(preview.files);
        await act(() => result.current.confirmPreview("normal"));

        expect(client.rewindTree).toHaveBeenCalledWith({
            sessionMetadata: hookOptions.sessionMetadata,
            expectedSemanticLeafId: "leaf-a",
            targetTurnId: "turn-a",
            mode: "normal",
            confirmationToken: "opaque.token/with+bytes==",
        });
        expect(hookOptions.onEditorText).toHaveBeenCalledWith("restored draft");
        expect(result.current.preview.open).toBe(false);
    });

    it("uses force-drift only when explicitly confirmed", async () => {
        const client = makeClient();
        const hookOptions = options(client);
        const { result } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openRewind("turn-a"));
        await act(() => result.current.confirmPreview("force-drift"));

        expect(client.rewindTree).toHaveBeenCalledWith(
            expect.objectContaining({
                mode: "force-drift",
                confirmationToken: "opaque.token/with+bytes==",
            })
        );
    });

    it("uses one authoritative redo preview/apply path without inventing local redo state", async () => {
        const redo = {
            operationId: "redo-op",
            targetPrompt: "restore this",
            messageCount: 2,
            fileCount: 1,
            files: [],
        };
        const client = makeClient();
        const hookOptions = options(client, { rewindState: makeRewindState({ redo }) });
        const { result } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openRedo());
        await act(() => result.current.confirmPreview("normal"));

        expect(client.previewRewind).toHaveBeenCalledWith({
            sessionMetadata: hookOptions.sessionMetadata,
            expectedSemanticLeafId: "leaf-a",
            target: { kind: "redo" },
        });
        expect(client.redoRewind).toHaveBeenCalledWith({
            sessionMetadata: hookOptions.sessionMetadata,
            expectedSemanticLeafId: "leaf-a",
            confirmationToken: "opaque.token/with+bytes==",
        });
        expect(hookOptions.rewindState.redo).toBe(redo);
    });

    it("clears the in-memory confirmation on cancel and semantic-leaf changes", async () => {
        const client = makeClient();
        let hookOptions = options(client);
        const { result, rerender } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openRewind("turn-a"));
        act(() => result.current.cancelPreview());
        await act(() => result.current.confirmPreview("normal"));
        expect(client.rewindTree).not.toHaveBeenCalled();

        await act(() => result.current.openRewind("turn-a"));
        hookOptions = options(client, {
            rewindState: makeRewindState({ semanticLeafId: "leaf-changed" }),
        });
        rerender();
        await act(() => result.current.confirmPreview("normal"));
        expect(client.rewindTree).not.toHaveBeenCalled();
    });

    it("does not reopen a selector after it is closed while loading", async () => {
        const pending = deferred<AgentListRewindPointsResult>();
        const client = makeClient({ listRewindPoints: vi.fn(() => pending.promise) as never });
        const hookOptions = options(client);
        const { result } = renderHook(() => useAgentRewind(hookOptions));
        let request!: Promise<void>;

        act(() => {
            request = result.current.openSelector();
        });
        act(() => result.current.closeSelector());
        await act(async () => {
            pending.resolve({
                points: [{ turnId: "turn-a", preview: "Late point", eligible: true }],
                semanticLeafId: "leaf-a",
                displayLeafId: "turn-a",
            });
            await request;
        });

        expect(result.current.selector).toEqual({
            open: false,
            phase: "idle",
            points: [],
        });
        expect(hookOptions.onError).not.toHaveBeenCalled();
    });

    it("keeps only the newest selector request for the same session identity", async () => {
        const first = deferred<AgentListRewindPointsResult>();
        const second = deferred<AgentListRewindPointsResult>();
        const listRewindPoints = vi
            .fn()
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);
        const client = makeClient({ listRewindPoints: listRewindPoints as never });
        const { result } = renderHook(() => useAgentRewind(options(client)));
        let firstRequest!: Promise<void>;
        let secondRequest!: Promise<void>;

        act(() => {
            firstRequest = result.current.openSelector();
            secondRequest = result.current.openSelector();
        });
        await act(async () => {
            second.resolve({
                points: [{ turnId: "turn-new", preview: "Newest history", eligible: true }],
                semanticLeafId: "leaf-a",
                displayLeafId: "turn-new",
            });
            await secondRequest;
        });
        await act(async () => {
            first.resolve({
                points: [{ turnId: "turn-old", preview: "Stale history", eligible: true }],
                semanticLeafId: "leaf-a",
                displayLeafId: "turn-old",
            });
            await firstRequest;
        });

        expect(result.current.selector.points.map((point) => point.turnId)).toEqual(["turn-new"]);
    });

    it("does not reopen or restore a token after a loading preview is cancelled", async () => {
        const pending = deferred<AgentRewindPreviewResult>();
        const client = makeClient({ previewRewind: vi.fn(() => pending.promise) as never });
        const { result } = renderHook(() => useAgentRewind(options(client)));
        let request!: Promise<void>;

        act(() => {
            request = result.current.openRewind("turn-a");
        });
        act(() => result.current.cancelPreview());
        await act(async () => {
            pending.resolve(makePreview({ kind: "rewind", targetTurnId: "turn-a" }));
            await request;
        });
        await act(() => result.current.confirmPreview("normal"));

        expect(result.current.preview.open).toBe(false);
        expect(client.rewindTree).not.toHaveBeenCalled();
    });

    it("keeps only the newest preview request for the same session identity", async () => {
        const first = deferred<AgentRewindPreviewResult>();
        const second = deferred<AgentRewindPreviewResult>();
        const previewRewind = vi
            .fn()
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);
        const client = makeClient({ previewRewind: previewRewind as never });
        const { result } = renderHook(() => useAgentRewind(options(client)));
        let firstRequest!: Promise<void>;
        let secondRequest!: Promise<void>;

        act(() => {
            firstRequest = result.current.openRewind("turn-old");
            secondRequest = result.current.openRewind("turn-new");
        });
        await act(async () => {
            second.resolve(
                makePreview({ kind: "rewind", targetTurnId: "turn-new" }, { confirmationToken: "newest-token" })
            );
            await secondRequest;
        });
        await act(async () => {
            first.resolve(
                makePreview({ kind: "rewind", targetTurnId: "turn-old" }, { confirmationToken: "stale-token" })
            );
            await firstRequest;
        });
        await act(() => result.current.confirmPreview("normal"));

        expect(client.rewindTree).toHaveBeenCalledWith(
            expect.objectContaining({
                targetTurnId: "turn-new",
                confirmationToken: "newest-token",
            })
        );
    });

    it("rejects a new preview while apply is in flight", async () => {
        const apply = deferred<AgentRewindMutationResult>();
        const client = makeClient({ rewindTree: vi.fn(() => apply.promise) as never });
        const hookOptions = options(client);
        const { result } = renderHook(() => useAgentRewind(hookOptions));
        let applyRequest!: Promise<void>;

        await act(() => result.current.openRewind("turn-a"));
        act(() => {
            applyRequest = result.current.confirmPreview("normal");
        });
        await act(() => result.current.openRewind("turn-b"));

        expect(client.previewRewind).toHaveBeenCalledTimes(1);
        expect(result.current.preview.phase).toBe("applying");

        await act(async () => {
            apply.resolve({
                sessionMetadata: makeSession("/sessions/a.jsonl"),
                semanticLeafId: "turn-a",
                displayLeafId: "turn-a",
                editorText: "applied A",
            });
            await applyRequest;
        });
        expect(hookOptions.onEditorText).toHaveBeenCalledWith("applied A");
        expect(result.current.preview.open).toBe(false);
    });

    it("keeps mutations locked after apply resolves until a newer authoritative state arrives", async () => {
        const client = makeClient();
        let hookOptions = options(client);
        const { result, rerender } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openRewind("turn-a"));
        await act(() => result.current.confirmPreview("normal"));

        expect(result.current.busy).toBe(true);
        await act(() => result.current.openRewind("turn-a"));
        expect(client.previewRewind).toHaveBeenCalledTimes(1);

        hookOptions = {
            ...hookOptions,
            rewindState: makeRewindState({
                semanticLeafId: "turn-a",
                displayLeafId: "turn-a",
                redo: {
                    operationId: "rewind-operation",
                    targetPrompt: "First prompt",
                    messageCount: 2,
                    fileCount: 1,
                    files: [],
                },
            }),
        };
        rerender();

        expect(result.current.busy).toBe(false);
        await act(() => result.current.openRewind("turn-a"));
        expect(client.previewRewind).toHaveBeenCalledTimes(2);
    });

    it("does not unlock an apply for an equivalent or semantically stale state object", async () => {
        const client = makeClient();
        let hookOptions = options(client);
        const { result, rerender } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openRewind("turn-a"));
        await act(() => result.current.confirmPreview("normal"));
        hookOptions = { ...hookOptions, rewindState: makeRewindState() };
        rerender();

        expect(result.current.busy).toBe(true);
    });

    it("accepts a matching authoritative rewind state that arrives before the RPC result", async () => {
        const apply = deferred<AgentRewindMutationResult>();
        const onEditorText = vi.fn();
        const client = makeClient({ rewindTree: vi.fn(() => apply.promise) as never });
        let hookOptions = options(client, { onEditorText });
        const { result, rerender } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openRewind("turn-a"));
        let applyRequest!: Promise<void>;
        act(() => {
            applyRequest = result.current.confirmPreview("normal");
        });
        hookOptions = {
            ...hookOptions,
            rewindState: makeRewindState({
                semanticLeafId: "rewound-leaf",
                displayLeafId: "rewound-turn",
                redo: {
                    operationId: "rewind-operation",
                    targetPrompt: "First prompt",
                    messageCount: 2,
                    fileCount: 1,
                    files: [],
                },
            }),
        };
        rerender();
        await act(async () => {
            apply.resolve({
                sessionMetadata: makeSession("/sessions/a.jsonl"),
                semanticLeafId: "rewound-leaf",
                displayLeafId: "rewound-turn",
                editorText: "restored once",
            });
            await applyRequest;
        });

        expect(result.current.busy).toBe(false);
        expect(onEditorText).toHaveBeenCalledOnce();
        expect(onEditorText).toHaveBeenCalledWith("restored once");
    });

    it("unlocks redo only when the result leaf is authoritative and the original redo marker is gone", async () => {
        const redo = {
            operationId: "redo-op",
            targetPrompt: "restore this",
            messageCount: 2,
            fileCount: 1,
            files: [],
        };
        const client = makeClient();
        let hookOptions = options(client, { rewindState: makeRewindState({ redo }) });
        const { result, rerender } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openRedo());
        await act(() => result.current.confirmPreview("normal"));
        hookOptions = {
            ...hookOptions,
            rewindState: makeRewindState({ semanticLeafId: "leaf-redone", displayLeafId: "turn-redone", redo }),
        };
        rerender();
        expect(result.current.busy).toBe(true);

        hookOptions = {
            ...hookOptions,
            rewindState: makeRewindState({
                semanticLeafId: "leaf-redone",
                displayLeafId: "turn-redone",
                redo: { ...redo, operationId: "replacement-redo" },
            }),
        };
        rerender();
        expect(result.current.busy).toBe(true);

        hookOptions = {
            ...hookOptions,
            rewindState: makeRewindState({ semanticLeafId: "leaf-redone", displayLeafId: "turn-redone" }),
        };
        rerender();
        expect(result.current.busy).toBe(false);
    });

    it("unlocks rewind only when its authoritative redo marker differs from the captured marker", async () => {
        const priorRedo = {
            operationId: "prior-redo",
            targetPrompt: "prior prompt",
            messageCount: 1,
            fileCount: 0,
            files: [],
        };
        const client = makeClient();
        let hookOptions = options(client, { rewindState: makeRewindState({ redo: priorRedo }) });
        const { result, rerender } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openRewind("turn-a"));
        await act(() => result.current.confirmPreview("normal"));
        hookOptions = {
            ...hookOptions,
            rewindState: makeRewindState({
                semanticLeafId: "turn-a",
                displayLeafId: "turn-a",
                redo: priorRedo,
            }),
        };
        rerender();
        expect(result.current.busy).toBe(true);

        hookOptions = {
            ...hookOptions,
            rewindState: makeRewindState({
                semanticLeafId: "turn-a",
                displayLeafId: "turn-a",
                redo: { ...priorRedo, operationId: "new-rewind" },
            }),
        };
        rerender();
        expect(result.current.busy).toBe(false);
    });

    it.each(["busy", "frozen"] as const)("blocks preview and confirm while authoritative state is %s", async (key) => {
        const client = makeClient();
        let hookOptions = options(client);
        const { result, rerender } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openRewind("turn-a"));
        hookOptions = {
            ...hookOptions,
            rewindState: makeRewindState({ [key]: true }),
        };
        rerender();
        await act(() => result.current.confirmPreview("normal"));
        await act(() => result.current.openRewind("turn-a"));
        await act(() => result.current.openSelector());

        expect(client.rewindTree).not.toHaveBeenCalled();
        expect(client.previewRewind).toHaveBeenCalledTimes(1);
        expect(client.listRewindPoints).not.toHaveBeenCalled();
    });

    it("never applies redo with force-drift even when called programmatically", async () => {
        const client = makeClient();
        const hookOptions = options(client, {
            rewindState: makeRewindState({
                redo: {
                    operationId: "redo-op",
                    targetPrompt: "restore this",
                    messageCount: 2,
                    fileCount: 0,
                    files: [],
                },
            }),
        });
        const { result } = renderHook(() => useAgentRewind(hookOptions));

        await act(() => result.current.openRedo());
        await act(() => result.current.confirmPreview("force-drift"));

        expect(client.redoRewind).not.toHaveBeenCalled();
    });

    it("ignores cancellation and new previews while an apply is in flight", async () => {
        const apply = deferred<AgentRewindMutationResult>();
        const client = makeClient({ rewindTree: vi.fn(() => apply.promise) as never });
        const hookOptions = options(client);
        const { result } = renderHook(() => useAgentRewind(hookOptions));
        let applyRequest!: Promise<void>;

        await act(() => result.current.openRewind("turn-a"));
        act(() => {
            applyRequest = result.current.confirmPreview("normal");
        });
        act(() => result.current.cancelPreview());
        await act(() => result.current.openRewind("turn-b"));
        await act(async () => {
            apply.resolve({
                sessionMetadata: makeSession("/sessions/a.jsonl"),
                semanticLeafId: "turn-a",
                displayLeafId: "turn-a",
                editorText: "stale A",
            });
            await applyRequest;
        });

        expect(client.previewRewind).toHaveBeenCalledTimes(1);
        expect(result.current.preview.open).toBe(false);
        expect(hookOptions.onEditorText).toHaveBeenCalledWith("stale A");
    });

    it("does not call external callbacks after unmount when async work settles", async () => {
        const list = deferred<AgentListRewindPointsResult>();
        const listOptions = options(makeClient({ listRewindPoints: vi.fn(() => list.promise) as never }));
        const listHook = renderHook(() => useAgentRewind(listOptions));
        let listRequest!: Promise<void>;
        act(() => {
            listRequest = listHook.result.current.openSelector();
        });
        listHook.unmount();
        list.reject(new Error("late list failure"));
        await listRequest;
        expect(listOptions.onError).not.toHaveBeenCalled();

        const preview = deferred<AgentRewindPreviewResult>();
        const previewOptions = options(makeClient({ previewRewind: vi.fn(() => preview.promise) as never }));
        const previewHook = renderHook(() => useAgentRewind(previewOptions));
        let previewRequest!: Promise<void>;
        act(() => {
            previewRequest = previewHook.result.current.openRewind("turn-a");
        });
        previewHook.unmount();
        preview.reject(new Error("late preview failure"));
        await previewRequest;
        expect(previewOptions.onError).not.toHaveBeenCalled();

        const apply = deferred<AgentRewindMutationResult>();
        const applyOptions = options(makeClient({ rewindTree: vi.fn(() => apply.promise) as never }));
        const applyHook = renderHook(() => useAgentRewind(applyOptions));
        await act(() => applyHook.result.current.openRewind("turn-a"));
        let applyRequest!: Promise<void>;
        act(() => {
            applyRequest = applyHook.result.current.confirmPreview("normal");
        });
        applyHook.unmount();
        apply.resolve({
            sessionMetadata: makeSession("/sessions/a.jsonl"),
            semanticLeafId: "turn-a",
            displayLeafId: "turn-a",
            editorText: "late draft",
        });
        await applyRequest;
        expect(applyOptions.onEditorText).not.toHaveBeenCalled();
        expect(applyOptions.onError).not.toHaveBeenCalled();
    });
});
