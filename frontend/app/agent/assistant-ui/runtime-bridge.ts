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
    type QuoteInfo,
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
    isHydrating?: boolean;
    submit: (text: string, images?: string[]) => boolean | Promise<boolean | void> | void;
    abort: () => void;
    isSendDisabled?: boolean;
    onSubmissionError?: (error: unknown) => void;
    submissionLease?: CanonicalComposerSubmissionLease;
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
    const submissionLease = "submissionLease" in source ? source.submissionLease : undefined;
    return {
        messages: piTurnsToAuiMessages(source.turns),
        isLoading: source.isHydrating ?? false,
        isRunning: source.status === "streaming",
        ...(!("send" in source) ? { isSendDisabled: source.isSendDisabled } : {}),
        adapters: {
            attachments: new CompositeAttachmentAdapter([
                new CachedImageAttachmentAdapter(submissionLease),
                new SimpleTextAttachmentAdapter(),
                new CrestFileAttachmentAdapter(),
            ]),
        },
        onNew: (message: AppendMessage): Promise<void> => {
            void submitCrestAppendMessage(source, message).catch((error) => {
                if ("onSubmissionError" in source && source.onSubmissionError) {
                    source.onSubmissionError(error);
                    return;
                }
                console.error("Agent submission failed", error);
            });
            return Promise.resolve();
        },
        onCancel: async (): Promise<void> => {
            source.abort();
        },
    };
}

export async function submitCrestAppendMessage(
    source: CrestAssistantRuntimeSource,
    message: AppendMessage
): Promise<void> {
    if (message.role !== "user") return;
    const payload = await canonicalComposerPayloadFromState({
        text: textFromUserMessage(message),
        quote: quoteFromUserMessage(message),
        attachments: message.attachments ?? [],
    });
    if (!payload.text && (payload.images?.length ?? 0) === 0) return;
    const leaseToken = "submissionLease" in source ? source.submissionLease?.claim(payload) : undefined;
    try {
        if ("send" in source) {
            if (payload.images?.length) {
                await source.send(payload.text, { images: payload.images });
                return;
            }
            await source.send(payload.text);
            return;
        }
        await source.submit(payload.text, payload.images);
    } finally {
        if ("submissionLease" in source && leaseToken != null) {
            source.submissionLease?.release(leaseToken);
        }
    }
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
    const turnMetadata = metadataForTurn(turn);
    return {
        id: `assistant-${turn.turnId}`,
        role: "assistant",
        createdAt: dateFromPiMessage(firstResponseMessage(turn)),
        content: assistantContentFromTurn(turn),
        status: statusFromPiTurn(turn),
        metadata: {
            ...turnMetadata,
            custom: {
                ...turnMetadata.custom,
                contextProjection: turn.contextProjection,
            },
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

function quoteFromUserMessage(message: AppendMessage): QuoteInfo | undefined {
    const quote = message.metadata?.custom?.quote;
    if (!quote || typeof quote !== "object") return undefined;

    const text = stringValue((quote as { text?: unknown }).text).trim();
    if (!text) return undefined;

    return {
        text,
        messageId: stringValue((quote as { messageId?: unknown }).messageId),
    };
}

export function injectQuoteContext(text: string, quote: Pick<QuoteInfo, "text"> | undefined): string {
    if (!quote?.text.trim()) return text;

    const quotedText = quote.text
        .trim()
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n");
    if (!text) return quotedText;
    return `${quotedText}\n\n${text}`;
}

export interface CanonicalComposerPayload {
    text: string;
    images?: string[];
}

export interface CanonicalComposerState {
    text: string;
    quote?: QuoteInfo;
    attachments: readonly Attachment[];
}

interface CanonicalPreviewRecord {
    token: number;
    payload: CanonicalComposerPayload;
    files: Set<File>;
}

function canonicalPayloadEqual(left: CanonicalComposerPayload, right: CanonicalComposerPayload): boolean {
    return (
        left.text === right.text &&
        left.images?.length === right.images?.length &&
        (left.images?.every((image, index) => image === right.images?.[index]) ?? true)
    );
}

function isClearedComposerState(state: CanonicalComposerState): boolean {
    return !state.text && !state.quote && state.attachments.length === 0;
}

export class CanonicalComposerSubmissionLease {
    sequence = 0;
    preview?: CanonicalPreviewRecord;
    active?: { token: number; payload: CanonicalComposerPayload };
    listeners = new Set<() => void>();

    registerPreview(state: CanonicalComposerState, payload: CanonicalComposerPayload): void {
        this.sequence += 1;
        this.preview = {
            token: this.sequence,
            payload,
            files: new Set(
                state.attachments.flatMap((attachment) =>
                    attachment.status.type === "complete" || !("file" in attachment) ? [] : [attachment.file]
                )
            ),
        };
    }

    beginForFile(file: File): number | undefined {
        if (!this.preview?.files.has(file)) return undefined;
        this.active = {
            token: this.preview.token,
            payload: this.preview.payload,
        };
        return this.active.token;
    }

    payloadForObserver(state: CanonicalComposerState, payload: CanonicalComposerPayload): CanonicalComposerPayload {
        if (this.active && isClearedComposerState(state)) {
            return this.active.payload;
        }
        return payload;
    }

    claim(payload: CanonicalComposerPayload): number | undefined {
        if (!this.active || !canonicalPayloadEqual(this.active.payload, payload)) return undefined;
        return this.active.token;
    }

    release(token: number): void {
        if (this.active?.token !== token) return;
        this.active = undefined;
        for (const listener of this.listeners) {
            listener();
        }
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

function attachmentImage(attachment: Attachment): string | undefined {
    for (const part of attachment.content ?? []) {
        if (part.type === "image" && typeof part.image === "string" && part.image) {
            return part.image;
        }
    }
}

const ImageResolutionCache = new WeakMap<File, Promise<string>>();

function resolvePendingImage(
    attachment: PendingAttachment,
    imageAdapter: SimpleImageAttachmentAdapter
): Promise<string> {
    return resolvePendingImageWith(attachment, () => imageAdapter.send(attachment));
}

function resolvePendingImageWith(
    attachment: PendingAttachment,
    resolve: () => Promise<CompleteAttachment>
): Promise<string> {
    const cached = ImageResolutionCache.get(attachment.file);
    if (cached) return cached;

    const resolution = resolve().then((resolved) => {
        const image = attachmentImage(resolved);
        if (!image) {
            throw new Error(`Image attachment "${attachment.name}" is not ready`);
        }
        return image;
    });
    ImageResolutionCache.set(attachment.file, resolution);
    void resolution.catch(() => {
        if (ImageResolutionCache.get(attachment.file) === resolution) {
            ImageResolutionCache.delete(attachment.file);
        }
    });
    return resolution;
}

class CachedImageAttachmentAdapter extends SimpleImageAttachmentAdapter {
    submissionLease?: CanonicalComposerSubmissionLease;

    constructor(submissionLease?: CanonicalComposerSubmissionLease) {
        super();
        this.submissionLease = submissionLease;
    }

    override async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
        const leaseToken = this.submissionLease?.beginForFile(attachment.file);
        try {
            const image = await resolvePendingImageWith(attachment, () => super.send(attachment));
            return {
                ...attachment,
                status: { type: "complete" },
                content: [{ type: "image", image }],
            };
        } catch (error) {
            if (leaseToken != null) {
                this.submissionLease?.release(leaseToken);
            }
            throw error;
        }
    }
}

export function composerImagesNeedResolution(attachments: readonly Attachment[]): boolean {
    return attachments.some((attachment) => attachment.type === "image" && attachmentImage(attachment) == null);
}

export async function canonicalComposerPayloadFromState(
    state: CanonicalComposerState,
    imageAdapter = new SimpleImageAttachmentAdapter()
): Promise<CanonicalComposerPayload> {
    const images: string[] = [];
    for (const attachment of state.attachments) {
        if (attachment.type !== "image") {
            continue;
        }
        let image = attachmentImage(attachment);
        if (!image && attachment.status.type !== "complete") {
            image = await resolvePendingImage(attachment as PendingAttachment, imageAdapter);
        }
        if (!image) {
            throw new Error(`Image attachment "${attachment.name}" is not ready`);
        }
        images.push(image);
    }
    return {
        text: injectQuoteContext(state.text, state.quote),
        ...(images.length ? { images } : {}),
    };
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
