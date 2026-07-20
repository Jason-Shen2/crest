// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    CompositeAttachmentAdapter,
    SimpleImageAttachmentAdapter,
    SimpleTextAttachmentAdapter,
    useExternalStoreRuntime,
    type AppendMessage,
    type AssistantRuntime,
    type Attachment,
    type AttachmentAdapter,
    type CompleteAttachment,
    type ExternalStoreAdapter,
    type MessageStatus,
    type PendingAttachment,
    type ThreadAssistantMessagePart,
    type ThreadMessage,
    type ThreadUserMessagePart,
    type ToolCallMessagePart,
} from "@assistant-ui/react";
import { useMemo } from "react";

import { type PiAgentMessage, type PiTurn, type UsePiChatReturn, type UsePiChatStatus } from "@/app/store/use-pi-chat";
import { arrayToBase64 } from "@/util/util";

interface ToolResultPayload {
    content?: unknown;
    details?: unknown;
    isError?: boolean;
}

type PiContentPart = NonNullable<PiAgentMessage["content"]>[number];

export interface CrestAssistantRuntimeBridge {
    turns: PiTurn[];
    status: UsePiChatStatus;
    submit: (text: string, images?: string[]) => boolean | Promise<boolean | void> | void;
    abort: () => void;
}

type CrestAssistantRuntimeSource = UsePiChatReturn | CrestAssistantRuntimeBridge;

export function piTurnsToAuiMessages(turns: PiTurn[]): ThreadMessage[] {
    const messages: ThreadMessage[] = [];
    for (const turn of turns) {
        messages.push(createUserMessage(turn));
        messages.push(createAssistantMessage(turn));
    }
    return messages;
}

export function createCrestAssistantRuntimeAdapter(
    source: CrestAssistantRuntimeSource
): ExternalStoreAdapter<ThreadMessage> {
    return {
        messages: piTurnsToAuiMessages(source.turns),
        isRunning: source.status === "streaming",
        adapters: {
            attachments: new CompositeAttachmentAdapter([
                new SimpleImageAttachmentAdapter(),
                new SimpleTextAttachmentAdapter(),
                new CrestFileAttachmentAdapter(),
            ]),
        },
        onNew: async (message: AppendMessage): Promise<void> => {
            if (message.role !== "user") return;
            const text = textFromUserMessage(message);
            const textWithQuote = injectQuoteContext(text, quoteFromUserMessage(message));
            const images = imagesFromUserMessage(message);
            if (!textWithQuote && images.length === 0) return;
            if ("send" in source) {
                if (images.length > 0) {
                    await source.send(textWithQuote, { images });
                    return;
                }
                await source.send(textWithQuote);
                return;
            }
            await source.submit(textWithQuote, images.length > 0 ? images : undefined);
        },
        onCancel: async (): Promise<void> => {
            source.abort();
        },
    };
}

export class CrestFileAttachmentAdapter implements AttachmentAdapter {
    accept = "*";

    async add({ file }: { file: File }): Promise<PendingAttachment> {
        return {
            id: file.name,
            type: "file",
            name: file.name,
            contentType: file.type || "application/octet-stream",
            file,
            status: { type: "requires-action", reason: "composer-send" },
        };
    }

    async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
        const mimeType = attachment.contentType || attachment.file.type || "application/octet-stream";
        const bytes = new Uint8Array(await attachment.file.arrayBuffer());
        return {
            ...attachment,
            status: { type: "complete" },
            content: [
                {
                    type: "file",
                    filename: attachment.name,
                    mimeType,
                    data: arrayToBase64(bytes),
                },
            ],
        };
    }

    async remove(_attachment: Attachment): Promise<void> {}
}

export function useCrestAssistantRuntime(source: CrestAssistantRuntimeSource): AssistantRuntime {
    const adapter = useMemo(() => createCrestAssistantRuntimeAdapter(source), [source]);
    return useExternalStoreRuntime(adapter);
}

function createUserMessage(turn: PiTurn): ThreadMessage {
    return {
        id: `user-${turn.turnId}`,
        role: "user",
        createdAt: dateFromPiMessage(turn.userMessage),
        content: userContentFromPiMessage(turn.userMessage),
        attachments: [],
        metadata: metadataForTurn(turn),
    };
}

function createAssistantMessage(turn: PiTurn): ThreadMessage {
    return {
        id: `assistant-${turn.turnId}`,
        role: "assistant",
        createdAt: dateFromPiMessage(firstResponseMessage(turn)),
        content: assistantContentFromTurn(turn),
        status: statusFromPiTurn(turn),
        metadata: {
            ...metadataForTurn(turn),
            unstable_state: undefined,
            unstable_annotations: [],
            unstable_data: [],
            steps: [],
        },
    };
}

function userContentFromPiMessage(message: PiAgentMessage | undefined): ThreadUserMessagePart[] {
    const parts: ThreadUserMessagePart[] = [];
    for (const content of message?.content ?? []) {
        if (content.type === "text" && typeof content.text === "string") {
            parts.push({ type: "text", text: content.text });
            continue;
        }
        if (content.type === "image") {
            const image = imageContentSrc(content);
            if (image) parts.push({ type: "image", image });
        }
    }
    return parts;
}

function assistantContentFromTurn(turn: PiTurn): ThreadAssistantMessagePart[] {
    const resultsByCallId = indexToolResults(turn.responseMessages);
    const parts: ThreadAssistantMessagePart[] = [];
    for (const message of turn.responseMessages) {
        if (message.role !== "assistant" || !message.content) continue;
        for (const content of message.content) {
            const part = assistantPartFromPiContent(content, resultsByCallId);
            if (part) parts.push(part);
        }
    }
    return parts;
}

function assistantPartFromPiContent(
    content: PiContentPart,
    resultsByCallId: Map<string, ToolResultPayload>
): ThreadAssistantMessagePart | undefined {
    if (content.type === "text" && typeof content.text === "string") {
        return { type: "text", text: content.text };
    }
    if (content.type === "thinking" && typeof content.thinking === "string") {
        return { type: "reasoning", text: content.thinking };
    }
    if (content.type === "image") {
        const image = imageContentSrc(content);
        return image ? { type: "image", image } : undefined;
    }
    if (content.type === "toolCall") {
        return toolCallPartFromPiContent(content, resultsByCallId);
    }
    return undefined;
}

function toolCallPartFromPiContent(
    content: PiContentPart,
    resultsByCallId: Map<string, ToolResultPayload>
): ToolCallMessagePart {
    const toolCallId = String(content.id ?? content.toolCallId ?? content.toolUseId ?? "");
    const args = content.input ?? content.arguments ?? {};
    const result = resultsByCallId.get(toolCallId);
    return {
        type: "tool-call",
        toolCallId,
        toolName: String(content.name ?? content.toolName ?? ""),
        args,
        argsText: safeJsonStringify(args),
        ...(result ? { result: resultValue(result), isError: result.isError === true } : {}),
    } as ToolCallMessagePart;
}

function indexToolResults(messages: PiAgentMessage[]): Map<string, ToolResultPayload> {
    const map = new Map<string, ToolResultPayload>();
    for (const message of messages) {
        if (message.role !== "toolResult") continue;
        const messageToolUseId = stringValue(message.toolUseId) || stringValue(message.toolCallId);
        if (messageToolUseId) {
            map.set(messageToolUseId, {
                content: message.content,
                details: message.details,
                isError: message.isError === true,
            });
            continue;
        }
        for (const content of message.content ?? []) {
            if (content.type !== "toolResult") continue;
            const contentToolUseId = stringValue(content.toolUseId) || stringValue(content.toolCallId);
            if (!contentToolUseId) continue;
            map.set(contentToolUseId, {
                content: content.content,
                details: content.details,
                isError: content.isError === true,
            });
        }
    }
    return map;
}

function resultValue(result: ToolResultPayload): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    if (result.content != null) value.content = result.content;
    if (result.details != null) value.details = result.details;
    return value;
}

function statusFromPiTurn(turn: PiTurn): MessageStatus {
    if (turn.status === "streaming") return { type: "running" };
    if (turn.status === "error") {
        return { type: "incomplete", reason: "error", error: turn.errorMessage ?? "agent error" };
    }
    const stopReason = lastAssistantStopReason(turn);
    if (stopReason === "aborted") return { type: "incomplete", reason: "cancelled" };
    if (stopReason === "length") return { type: "incomplete", reason: "length" };
    return { type: "complete", reason: "stop" };
}

function textFromUserMessage(message: AppendMessage): string {
    const textParts: string[] = [];
    for (const part of message.content) {
        if (part.type === "text") {
            textParts.push(part.text);
        }
    }
    return textParts.join("\n");
}

function quoteFromUserMessage(message: AppendMessage): { text: string; messageId: string } | undefined {
    const quote = message.metadata?.custom?.quote;
    if (!quote || typeof quote !== "object") return undefined;

    const text = stringValue((quote as { text?: unknown }).text).trim();
    if (!text) return undefined;

    return {
        text,
        messageId: stringValue((quote as { messageId?: unknown }).messageId),
    };
}

function injectQuoteContext(text: string, quote: { text: string } | undefined): string {
    if (!quote?.text.trim()) return text;

    const quotedText = quote.text
        .trim()
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n");
    if (!text) return quotedText;
    return `${quotedText}\n\n${text}`;
}

function imagesFromUserMessage(message: AppendMessage): string[] {
    const images: string[] = [];
    for (const part of message.content) {
        if (part.type === "image" && typeof part.image === "string") {
            images.push(part.image);
        }
    }
    return images;
}

function dateFromPiMessage(message: PiAgentMessage | undefined): Date {
    return new Date(typeof message?.timestamp === "number" ? message.timestamp : Date.now());
}

function firstResponseMessage(turn: PiTurn): PiAgentMessage | undefined {
    return turn.responseMessages[0] ?? turn.userMessage;
}

function lastAssistantStopReason(turn: PiTurn): string {
    for (let i = turn.responseMessages.length - 1; i >= 0; i--) {
        const message = turn.responseMessages[i];
        if (message.role === "assistant" && typeof message.stopReason === "string") return message.stopReason;
    }
    return "";
}

function metadataForTurn(turn: PiTurn) {
    return {
        custom: {
            turnId: turn.turnId,
            changeOutline: turn.changeOutline,
        },
    };
}

function imageContentSrc(content: PiContentPart): string {
    const explicit = stringValue(content.image) || stringValue(content.url) || stringValue(content.src);
    if (explicit) return explicit;
    const data = stringValue(content.data);
    if (!data) return "";
    if (data.startsWith("data:image/")) return data;
    const mimeType = stringValue(content.mimeType) || "image/png";
    return `data:${mimeType};base64,${data}`;
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return "";
    }
}
