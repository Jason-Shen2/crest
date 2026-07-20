// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppendMessage, PendingAttachment, ThreadMessage } from "@assistant-ui/react";
import { describe, expect, it, vi } from "vitest";

import { makeEmptyPiExtUiState, type PiTurn, type UsePiChatReturn } from "@/app/store/use-pi-chat";

import { createCrestAssistantRuntimeAdapter, piTurnsToAuiMessages } from "./runtime-bridge";

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
        extUi: makeEmptyPiExtUiState(),
        send: vi.fn(),
        abort: vi.fn(),
        respondExtUi: vi.fn(),
        respondWidgetEvent: vi.fn(),
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
                    makeTurn({ responseMessages: [{ role: "assistant", content: [{ type: "text", text: "answer" }] }] }),
                ],
                status: "streaming",
            })
        );

        expect(adapter.messages).toHaveLength(2);
        expect(adapter.isRunning).toBe(true);
    });

    it("sends the latest user message text through usePiChat.send", async () => {
        const send = vi.fn<UsePiChatReturn["send"]>();
        const adapter = createCrestAssistantRuntimeAdapter(makeChat({ send }));
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

        await adapter.onNew(message);

        expect(send).toHaveBeenCalledWith("hello\nworld");
    });

    it("injects quote metadata into the submitted text as markdown blockquote context", async () => {
        const send = vi.fn<UsePiChatReturn["send"]>();
        const adapter = createCrestAssistantRuntimeAdapter(makeChat({ send }));
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

        await adapter.onNew(message);

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
