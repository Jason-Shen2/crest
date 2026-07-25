// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    SimpleImageAttachmentAdapter,
    type AppendMessage,
    type PendingAttachment,
    type ThreadMessage,
} from "@assistant-ui/react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { contextSendDisabledReason, createContextReferenceState } from "@/app/store/context-references";
import type { PiTurn, UsePiChatReturn } from "@/app/store/use-pi-chat";

import {
    CanonicalComposerSubmissionLease,
    canonicalComposerPayloadFromState,
    createCrestAssistantRuntimeAdapter,
    piTurnsToAuiMessages,
    submitCrestAppendMessage,
    useCrestAssistantRuntime,
} from "./runtime-bridge";

function user(text: string, timestamp = 1): PiTurn["userMessage"] {
    return { role: "user", timestamp, content: [{ type: "text", text }] };
}

function makeTurn(overrides: Partial<PiTurn> = {}): PiTurn {
    return {
        turnId: "turn-1",
        userMessage: user("hello"),
        responseMessages: [],
        status: "done",
        ...overrides,
    };
}

function assistantContent(message: ThreadMessage): ThreadMessage["content"] {
    expect(message.role).toBe("assistant");
    return message.content;
}

function makeChat(overrides: Partial<UsePiChatReturn> = {}): UsePiChatReturn {
    return {
        messages: [],
        turns: [],
        status: "idle",
        errorMessage: undefined,
        sessionMetadata: undefined,
        queuedMessages: [],
        send: vi.fn(),
        abort: vi.fn(),
        contextState: createContextReferenceState(),
        prepareContextDraft: vi.fn(),
        discardContextDraft: vi.fn(),
        summarizeContextDraft: vi.fn(),
        retryContextSend: vi.fn(),
        ...overrides,
    };
}

describe("piTurnsToAuiMessages", () => {
    it("converts empty turns to empty messages", () => {
        expect(piTurnsToAuiMessages([])).toEqual([]);
    });

    it("converts one PiTurn to one user message and one assistant message", () => {
        const messages = piTurnsToAuiMessages([
            makeTurn({
                responseMessages: [{ role: "assistant", content: [{ type: "text", text: "world" }] }],
            }),
        ]);

        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({
            id: "user-turn-1",
            role: "user",
            content: [{ type: "text", text: "hello" }],
            attachments: [],
            metadata: { custom: { turnId: "turn-1" } },
        });
        expect(messages[1]).toMatchObject({
            id: "assistant-turn-1",
            role: "assistant",
            content: [{ type: "text", text: "world" }],
            status: { type: "complete" },
            metadata: { custom: { turnId: "turn-1" } },
        });
    });

    it("stores a turn projection report in assistant message custom metadata", () => {
        const contextProjection = {
            schemaVersion: 1,
            transactionId: "transaction-1",
            targetTurnId: "turn-1",
            createdAt: "2026-07-23T00:00:00.000Z",
            contextWindow: 1000,
            effectiveOutputReserve: 100,
            inputLimit: 900,
            baseInputTokens: 100,
            finalInputTokens: 200,
            referenceTokens: 100,
            countAccuracy: "exact",
            overlaySha256: "sha",
            items: [],
        } satisfies AgentContextProjectionReportView;

        const [userMessage, assistant] = piTurnsToAuiMessages([makeTurn({ contextProjection })]);

        expect(userMessage.metadata.custom).not.toHaveProperty("contextProjection");
        expect(assistant.metadata.custom).toMatchObject({ turnId: "turn-1", contextProjection });
    });

    it("maps user text and image parts without reordering", () => {
        const messages = piTurnsToAuiMessages([
            makeTurn({
                userMessage: {
                    role: "user",
                    timestamp: 1,
                    content: [
                        { type: "text", text: "before" },
                        { type: "image", data: "userimg", mimeType: "image/jpeg" },
                        { type: "text", text: "after" },
                    ],
                },
            }),
        ]);

        expect(messages[0].content).toEqual([
            { type: "text", text: "before" },
            { type: "image", image: "data:image/jpeg;base64,userimg" },
            { type: "text", text: "after" },
        ]);
    });

    it("keeps multiple turns in user assistant order", () => {
        const messages = piTurnsToAuiMessages([
            makeTurn({
                turnId: "a",
                userMessage: user("first"),
                responseMessages: [{ role: "assistant", content: [{ type: "text", text: "one" }] }],
            }),
            makeTurn({
                turnId: "b",
                userMessage: user("second"),
                responseMessages: [{ role: "assistant", content: [{ type: "text", text: "two" }] }],
            }),
        ]);

        expect(messages.map((message) => message.id)).toEqual(["user-a", "assistant-a", "user-b", "assistant-b"]);
        expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    });

    it("maps assistant text thinking and image parts without reordering", () => {
        const messages = piTurnsToAuiMessages([
            makeTurn({
                responseMessages: [
                    {
                        role: "assistant",
                        content: [
                            { type: "text", text: "before" },
                            { type: "thinking", thinking: "inspect files" },
                            { type: "image", data: "abc123", mimeType: "image/png" },
                            { type: "text", text: "after" },
                        ],
                    },
                ],
            }),
        ]);

        expect(assistantContent(messages[1])).toEqual([
            { type: "text", text: "before" },
            { type: "reasoning", text: "inspect files" },
            { type: "image", image: "data:image/png;base64,abc123" },
            { type: "text", text: "after" },
        ]);
    });

    it("pairs top-level toolCallId tool results with tool-call parts", () => {
        const messages = piTurnsToAuiMessages([
            makeTurn({
                responseMessages: [
                    {
                        role: "assistant",
                        content: [
                            { type: "text", text: "before" },
                            { type: "toolCall", id: "tc1", name: "read_text_file", input: { path: "a.ts" } },
                            { type: "text", text: "after" },
                        ],
                    },
                    {
                        role: "toolResult",
                        toolCallId: "tc1",
                        content: [{ type: "text", text: "file contents" }],
                        details: { ok: true },
                    },
                ],
            }),
        ]);

        expect(assistantContent(messages[1])).toEqual([
            { type: "text", text: "before" },
            {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "read_text_file",
                args: { path: "a.ts" },
                argsText: JSON.stringify({ path: "a.ts" }),
                result: {
                    content: [{ type: "text", text: "file contents" }],
                    details: { ok: true },
                },
                isError: false,
            },
            { type: "text", text: "after" },
        ]);
    });

    it("pairs nested toolUseId tool results with tool-call parts", () => {
        const messages = piTurnsToAuiMessages([
            makeTurn({
                responseMessages: [
                    {
                        role: "assistant",
                        content: [{ type: "toolCall", id: "use-1", name: "grep", arguments: { pattern: "x" } }],
                    },
                    {
                        role: "toolResult",
                        content: [
                            {
                                type: "toolResult",
                                toolUseId: "use-1",
                                content: [{ type: "text", text: "match" }],
                                isError: true,
                            },
                        ],
                    },
                ],
            }),
        ]);

        expect(assistantContent(messages[1])).toEqual([
            {
                type: "tool-call",
                toolCallId: "use-1",
                toolName: "grep",
                args: { pattern: "x" },
                argsText: JSON.stringify({ pattern: "x" }),
                result: {
                    content: [{ type: "text", text: "match" }],
                },
                isError: true,
            },
        ]);
    });

    it("maps turn status to assistant-ui message status", () => {
        const messages = piTurnsToAuiMessages([
            makeTurn({ turnId: "running", status: "streaming" }),
            makeTurn({ turnId: "done", status: "done" }),
            makeTurn({ turnId: "error", status: "error", errorMessage: "boom" }),
        ]);

        expect(messages[1]).toMatchObject({ status: { type: "running" } });
        expect(messages[3]).toMatchObject({ status: { type: "complete" } });
        expect(messages[5]).toMatchObject({ status: { type: "incomplete", reason: "error", error: "boom" } });
    });

    it("maps done turns with aborted or length stop reasons to incomplete statuses", () => {
        const messages = piTurnsToAuiMessages([
            makeTurn({
                turnId: "aborted",
                status: "done",
                responseMessages: [
                    { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "stopped" }] },
                ],
            }),
            makeTurn({
                turnId: "length",
                status: "done",
                responseMessages: [
                    { role: "assistant", stopReason: "length", content: [{ type: "text", text: "truncated" }] },
                ],
            }),
        ]);

        expect(messages[1]).toMatchObject({ status: { type: "incomplete", reason: "cancelled" } });
        expect(messages[3]).toMatchObject({ status: { type: "incomplete", reason: "length" } });
    });
});

describe("createCrestAssistantRuntimeAdapter", () => {
    it("bridges Pi turns and running state into an external-store adapter", () => {
        const adapter = createCrestAssistantRuntimeAdapter(
            makeChat({
                turns: [
                    makeTurn({
                        responseMessages: [{ role: "assistant", content: [{ type: "text", text: "answer" }] }],
                    }),
                ],
                status: "streaming",
            })
        );

        expect(adapter.messages).toHaveLength(2);
        expect(adapter.isRunning).toBe(true);
    });

    it("sends the latest user message text through usePiChat.send", async () => {
        const send = vi.fn<UsePiChatReturn["send"]>();
        const message = {
            role: "user",
            content: [
                { type: "text", text: "hello" },
                { type: "text", text: "world" },
            ],
            parentId: null,
            sourceId: null,
            runConfig: undefined,
            metadata: { custom: {} },
            attachments: [],
            createdAt: new Date(0),
        } as AppendMessage;

        await submitCrestAppendMessage(makeChat({ send }), message);

        expect(send).toHaveBeenCalledWith("hello\nworld");
    });

    it("reads resolved user images from complete message attachments", async () => {
        const submit = vi.fn();
        const message = {
            role: "user",
            content: [{ type: "text", text: "describe this" }],
            parentId: null,
            sourceId: null,
            runConfig: undefined,
            metadata: { custom: {} },
            attachments: [
                {
                    id: "image-1",
                    type: "image",
                    name: "pixel.png",
                    contentType: "image/png",
                    status: { type: "complete" },
                    content: [{ type: "image", image: "data:image/png;base64,abc123" }],
                },
            ],
            createdAt: new Date(0),
        } as AppendMessage;

        await submitCrestAppendMessage(
            {
                turns: [],
                status: "idle",
                submit,
                abort: vi.fn(),
            },
            message
        );

        expect(submit).toHaveBeenCalledWith("describe this", ["data:image/png;base64,abc123"]);
    });

    it("uses one canonical payload for a real composer image, quote preview, and final submit", async () => {
        const submit = vi.fn().mockResolvedValue(undefined);
        const bridge = {
            turns: [],
            status: "idle" as const,
            submit,
            abort: vi.fn(),
        };
        const { result } = renderHook(() => useCrestAssistantRuntime(bridge));
        const composer = result.current.thread.composer;
        const file = new File([new Uint8Array([1, 2, 3])], "pixel.png", { type: "image/png" });
        const quote = { text: "quoted\ncontext", messageId: "assistant-source" };

        await act(async () => {
            await composer.addAttachment(file);
            composer.setText("describe it");
            composer.setQuote(quote);
        });
        const pendingState = composer.getState();
        expect(pendingState.attachments[0]?.status.type).toBe("requires-action");

        const preview = await canonicalComposerPayloadFromState({
            text: pendingState.text,
            quote: pendingState.quote,
            attachments: pendingState.attachments,
        });
        expect(preview).toEqual({
            text: ["> quoted", "> context", "", "describe it"].join("\n"),
            images: ["data:image/png;base64,AQID"],
        });

        act(() => {
            composer.send();
        });
        await waitFor(() => expect(submit).toHaveBeenCalledOnce());
        expect(submit).toHaveBeenCalledWith(preview.text, preview.images);
    });

    it("resolves the same pending image only once across rapid text and quote previews", async () => {
        const file = new File([new Uint8Array([1, 2, 3])], "pixel.png", { type: "image/png" });
        const attachment = {
            id: "image-1",
            type: "image",
            name: file.name,
            contentType: file.type,
            file,
            status: { type: "requires-action", reason: "composer-send" },
        } as PendingAttachment;
        const imageAdapter = new SimpleImageAttachmentAdapter();
        const send = vi.spyOn(imageAdapter, "send").mockResolvedValue({
            ...attachment,
            status: { type: "complete" },
            content: [{ type: "image", image: "data:image/png;base64,AQID" }],
        });

        const [first, second] = await Promise.all([
            canonicalComposerPayloadFromState({ text: "first", attachments: [attachment] }, imageAdapter),
            canonicalComposerPayloadFromState(
                {
                    text: "second",
                    quote: { text: "quote", messageId: "source" },
                    attachments: [attachment],
                },
                imageAdapter
            ),
        ]);

        expect(send).toHaveBeenCalledOnce();
        expect(first.images).toEqual(["data:image/png;base64,AQID"]);
        expect(second).toEqual({
            text: ["> quote", "", "second"].join("\n"),
            images: ["data:image/png;base64,AQID"],
        });
    });

    it("holds the verified reference preview while a real composer clears for image submission", async () => {
        const reads: Array<() => void> = [];
        class DelayedFileReader {
            result: string | ArrayBuffer | null = null;
            onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
            onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

            readAsDataURL(): void {
                reads.push(() => {
                    this.result = "data:image/png;base64,AQID";
                    this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
                });
            }
        }
        vi.stubGlobal("FileReader", DelayedFileReader);
        const submissionLease = new CanonicalComposerSubmissionLease();
        let settleSubmit!: () => void;
        const submit = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    settleSubmit = resolve;
                })
        );
        const bridge = {
            turns: [],
            status: "idle" as const,
            submit,
            abort: vi.fn(),
            submissionLease,
        };
        const { result } = renderHook(() => useCrestAssistantRuntime(bridge));
        const composer = result.current.thread.composer;
        const file = new File([new Uint8Array([1, 2, 3])], "lease.png", { type: "image/png" });
        await act(async () => {
            await composer.addAttachment(file);
            composer.setText("send with reference");
        });
        const composerState = composer.getState();
        const previewPromise = canonicalComposerPayloadFromState(composerState);
        expect(reads).toHaveLength(1);
        reads.shift()?.();
        const verifiedPreview = await previewPromise;
        submissionLease.registerPreview(composerState, verifiedPreview);
        const referenceState = {
            ...createContextReferenceState(),
            drafts: [
                {
                    status: "ready",
                    deliveryScope: "message",
                    requestedRepresentation: "full",
                    view: {
                        draftId: "draft",
                        targetSessionPath: "/sessions/target.jsonl",
                        provenance: {
                            sourceKind: "turn",
                            sourceSessionId: "source",
                            sourceSessionPath: "/sessions/source.jsonl",
                            sourceCwd: "/workspace",
                            sourceTurnId: "turn",
                            sourceLeafId: "leaf",
                            sourceMessageEntryIds: ["message"],
                            preview: "preview",
                            capturedAt: "2026-07-25T00:00:00.000Z",
                        },
                        summaryStatus: "none",
                        expiresAt: "2026-07-25T01:00:00.000Z",
                    },
                },
            ],
        } as ReturnType<typeof createContextReferenceState>;
        expect(contextSendDisabledReason(referenceState)).toBeUndefined();

        const observedAfterClear: Array<typeof verifiedPreview> = [];
        const unsubscribe = composer.subscribe(() => {
            const state = composer.getState();
            if (state.text || state.attachments.length || state.quote) return;
            const observed = submissionLease.payloadForObserver(state, { text: "" });
            observedAfterClear.push(observed);
        });

        act(() => {
            expect(composer.send()).toBeUndefined();
        });
        await waitFor(() => expect(submit).toHaveBeenCalledWith(verifiedPreview.text, verifiedPreview.images));
        expect(reads).toHaveLength(0);
        expect(observedAfterClear).toContain(verifiedPreview);
        expect(contextSendDisabledReason(referenceState)).toBeUndefined();

        settleSubmit();
        await waitFor(() => expect(submissionLease.active).toBeUndefined());
        unsubscribe();
        vi.unstubAllGlobals();
    });

    it("reports a rejected real composer send once without leaking the detached promise", async () => {
        const error = new Error("send rejected");
        const onSubmissionError = vi.fn();
        const bridge = {
            turns: [],
            status: "idle" as const,
            submit: vi.fn().mockRejectedValue(error),
            abort: vi.fn(),
            onSubmissionError,
        };
        const { result } = renderHook(() => useCrestAssistantRuntime(bridge));
        const composer = result.current.thread.composer;
        act(() => {
            composer.setText("will reject");
            expect(composer.send()).toBeUndefined();
        });

        await waitFor(() => expect(onSubmissionError).toHaveBeenCalledOnce());
        expect(onSubmissionError).toHaveBeenCalledWith(error);
        expect(bridge.submit).toHaveBeenCalledOnce();
    });

    it("consumes runtime callback rejection and reports it through the explicit error sink", async () => {
        const error = new Error("budget changed");
        const onSubmissionError = vi.fn();
        const adapter = createCrestAssistantRuntimeAdapter({
            turns: [],
            status: "idle",
            submit: vi.fn().mockRejectedValue(error),
            abort: vi.fn(),
            onSubmissionError,
        } as any);
        const message = {
            role: "user",
            content: [{ type: "text", text: "preserve exactly" }],
            parentId: null,
            sourceId: null,
            runConfig: undefined,
            metadata: { custom: {} },
            attachments: [],
            createdAt: new Date(0),
        } as AppendMessage;

        const result = adapter.onNew(message);
        await expect(result).resolves.toBeUndefined();
        await waitFor(() => expect(onSubmissionError).toHaveBeenCalledWith(error));
    });

    it("awaits async submit completion and propagates rejection", async () => {
        let rejectSubmit!: (error: Error) => void;
        const submit = vi.fn(
            () =>
                new Promise<void>((_resolve, reject) => {
                    rejectSubmit = reject;
                })
        );
        const message = {
            role: "user",
            content: [{ type: "text", text: "preserve exactly" }],
            parentId: null,
            sourceId: null,
            runConfig: undefined,
            metadata: { custom: {} },
            attachments: [],
            createdAt: new Date(0),
        } as AppendMessage;

        const submission = submitCrestAppendMessage(
            {
                turns: [],
                status: "idle",
                submit,
                abort: vi.fn(),
            },
            message
        );
        let settled = false;
        void submission.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            }
        );
        await Promise.resolve();
        expect(settled).toBe(false);

        const error = new Error("budget changed");
        rejectSubmit(error);
        await expect(submission).rejects.toBe(error);
    });

    it("passes the context send gate to the external runtime", () => {
        const adapter = createCrestAssistantRuntimeAdapter({
            turns: [],
            status: "idle",
            submit: vi.fn(),
            abort: vi.fn(),
            isSendDisabled: true,
        });

        expect(adapter.isSendDisabled).toBe(true);
    });

    it("injects quote metadata into the submitted text as markdown blockquote context", async () => {
        const send = vi.fn<UsePiChatReturn["send"]>();
        const message = {
            role: "user",
            content: [{ type: "text", text: "Can you explain how the layers connect?" }],
            parentId: null,
            sourceId: null,
            runConfig: undefined,
            metadata: {
                custom: {
                    quote: {
                        text: "The runtime system follows a layered architecture\nwith runtime and primitives.",
                        messageId: "assistant-quote-source",
                    },
                },
            },
            attachments: [],
            createdAt: new Date(0),
        } as AppendMessage;

        await submitCrestAppendMessage(makeChat({ send }), message);

        expect(send).toHaveBeenCalledWith(
            [
                "> The runtime system follows a layered architecture",
                "> with runtime and primitives.",
                "",
                "Can you explain how the layers connect?",
            ].join("\n")
        );
    });

    it("bridges cancel to usePiChat.abort", async () => {
        const abort = vi.fn<UsePiChatReturn["abort"]>();
        const adapter = createCrestAssistantRuntimeAdapter(makeChat({ abort }));

        await adapter.onCancel?.();

        expect(abort).toHaveBeenCalledTimes(1);
    });

    it("accepts generic files so drag-and-drop does not silently reject them", async () => {
        const adapter = createCrestAssistantRuntimeAdapter(makeChat());
        const fileAdapter = adapter.adapters?.attachments;
        const file = new File([new Uint8Array([1, 2, 3])], "archive.bin", {
            type: "application/octet-stream",
        });

        const pending = (await fileAdapter!.add({ file })) as PendingAttachment;
        const complete = await fileAdapter!.send(pending);

        expect(pending).toMatchObject({
            type: "file",
            name: "archive.bin",
            contentType: "application/octet-stream",
            status: { type: "requires-action", reason: "composer-send" },
        });
        expect(complete).toMatchObject({
            type: "file",
            name: "archive.bin",
            contentType: "application/octet-stream",
            status: { type: "complete" },
            content: [
                {
                    type: "file",
                    filename: "archive.bin",
                    mimeType: "application/octet-stream",
                    data: "AQID",
                },
            ],
        });
    });
});
