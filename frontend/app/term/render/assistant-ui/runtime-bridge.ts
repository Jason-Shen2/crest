// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    CompositeAttachmentAdapter,
    SimpleImageAttachmentAdapter,
    SimpleTextAttachmentAdapter,
    useExternalStoreRuntime,
    type AppendMessage,
    type AssistantRuntime,
    type ExternalStoreAdapter,
    type MessageStatus,
    type ThreadAssistantMessagePart,
    type ThreadMessage,
    type ThreadUserMessagePart,
    type ToolCallMessagePart,
} from "@assistant-ui/react";
import { useMemo } from "react";

import { type PiAgentMessage, type PiRun, type UsePiChatReturn, type UsePiChatStatus } from "@/app/store/use-pi-chat";

interface ToolResultPayload {
    content?: unknown;
    details?: unknown;
    isError?: boolean;
}

type PiContentPart = NonNullable<PiAgentMessage["content"]>[number];

export interface CrestAssistantRuntimeBridge {
    runs: PiRun[];
    status: UsePiChatStatus;
    submit: (text: string, images?: string[]) => boolean | Promise<boolean | void> | void;
    abort: () => void;
}

type CrestAssistantRuntimeSource = UsePiChatReturn | CrestAssistantRuntimeBridge;

export function piRunToAuiMessages(runs: PiRun[]): ThreadMessage[] {
    const messages: ThreadMessage[] = [];
    for (const run of runs) {
        messages.push(createUserMessage(run));
        messages.push(createAssistantMessage(run));
    }
    return messages;
}

export function createCrestAssistantRuntimeAdapter(
    source: CrestAssistantRuntimeSource
): ExternalStoreAdapter<ThreadMessage> {
    return {
        messages: piRunToAuiMessages(source.runs),
        isRunning: source.status === "streaming",
        adapters: {
            attachments: new CompositeAttachmentAdapter([
                new SimpleImageAttachmentAdapter(),
                new SimpleTextAttachmentAdapter(),
            ]),
        },
        onNew: async (message: AppendMessage): Promise<void> => {
            if (message.role !== "user") return;
            const text = textFromUserMessage(message);
            const images = imagesFromUserMessage(message);
            if (!text && images.length === 0) return;
            if ("send" in source) {
                await source.send(text);
                return;
            }
            await source.submit(text, images);
        },
        onCancel: async (): Promise<void> => {
            source.abort();
        },
    };
}

export function useCrestAssistantRuntime(source: CrestAssistantRuntimeSource): AssistantRuntime {
    const adapter = useMemo(() => createCrestAssistantRuntimeAdapter(source), [source]);
    return useExternalStoreRuntime(adapter);
}

function createUserMessage(run: PiRun): ThreadMessage {
    return {
        id: `user-${run.runId}`,
        role: "user",
        createdAt: dateFromPiMessage(run.userMessage),
        content: userContentFromPiMessage(run.userMessage),
        attachments: [],
        metadata: metadataForRun(run),
    };
}

function createAssistantMessage(run: PiRun): ThreadMessage {
    return {
        id: `assistant-${run.runId}`,
        role: "assistant",
        createdAt: dateFromPiMessage(firstResponseMessage(run)),
        content: assistantContentFromRun(run),
        status: statusFromPiRun(run),
        metadata: {
            ...metadataForRun(run),
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

function assistantContentFromRun(run: PiRun): ThreadAssistantMessagePart[] {
    const resultsByCallId = indexToolResults(run.responseMessages);
    const parts: ThreadAssistantMessagePart[] = [];
    for (const message of run.responseMessages) {
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

function statusFromPiRun(run: PiRun): MessageStatus {
    if (run.status === "streaming") return { type: "running" };
    if (run.status === "error") {
        return { type: "incomplete", reason: "error", error: run.errorMessage ?? "agent error" };
    }
    const stopReason = lastAssistantStopReason(run);
    if (stopReason === "aborted") return { type: "incomplete", reason: "cancelled" };
    if (stopReason === "length") return { type: "incomplete", reason: "length" };
    return { type: "complete", reason: "stop" };
}

function textFromUserMessage(message: AppendMessage): string {
    return message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
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

function firstResponseMessage(run: PiRun): PiAgentMessage | undefined {
    return run.responseMessages[0] ?? run.userMessage;
}

function lastAssistantStopReason(run: PiRun): string {
    for (let i = run.responseMessages.length - 1; i >= 0; i--) {
        const message = run.responseMessages[i];
        if (message.role === "assistant" && typeof message.stopReason === "string") return message.stopReason;
    }
    return "";
}

function metadataForRun(run: PiRun) {
    return {
        custom: {
            runId: run.runId,
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
