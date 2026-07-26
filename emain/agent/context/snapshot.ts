// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { JsonlSessionMetadata, SessionTreeEntry } from "@crest/agent/harness/types";
import type {
    ContextArtifact,
    ContextArtifactDraft,
    ContextSnapshotBlock,
    ContextSnapshotMessage,
    ContextSourceKind,
} from "./types";
import { ContextReferenceError } from "./types";

const MaxSnapshotBytes = 2 * 1024 * 1024;

export interface ContextCaptureInput {
    sourceMetadata: JsonlSessionMetadata;
    sourceEntries: SessionTreeEntry[];
    sourceLeafId: string | null;
    sourceTitle?: string;
    sourceKind: ContextSourceKind;
    sourceTurnId?: string;
    now?: () => Date;
}

function isUserMessageEntry(entry: SessionTreeEntry): boolean {
    return entry.type === "message" && entry.message.role === "user";
}

function invalidInput(message: string): never {
    throw new ContextReferenceError("invalid_input", message);
}

function getBase64ByteLength(data: string): number {
    const paddingStart = data.indexOf("=");
    const unpadded = paddingStart < 0 ? data : data.slice(0, paddingStart);
    if (!/^[A-Za-z0-9+/]*$/.test(unpadded)) invalidInput("Image data must be valid standard base64");

    if (paddingStart < 0) {
        const remainder = data.length % 4;
        if (remainder === 1) invalidInput("Image data must be valid standard base64");
        return Math.floor(data.length / 4) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
    }

    const padding = data.length - paddingStart;
    if (padding > 2 || !/^=+$/.test(data.slice(paddingStart)) || data.length % 4 !== 0) {
        invalidInput("Image data must be valid standard base64");
    }
    if ((padding === 1 && unpadded.length % 4 !== 3) || (padding === 2 && unpadded.length % 4 !== 2)) {
        invalidInput("Image data must be valid standard base64");
    }
    return (data.length / 4) * 3 - padding;
}

function normalizedImageBlock(block: { data?: unknown; mimeType?: unknown }): ContextSnapshotBlock {
    if (typeof block.data !== "string" || typeof block.mimeType !== "string") {
        invalidInput("Image data and mimeType must be strings");
    }
    return { type: "image_omitted", mimeType: block.mimeType, byteLength: getBase64ByteLength(block.data) };
}

function isPlainObject(value: object): value is Record<string, unknown> {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function normalizeJsonValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (Number.isFinite(value)) return value;
        invalidInput("Tool arguments must contain only finite JSON numbers");
    }
    if (typeof value !== "object") invalidInput("Tool arguments must contain only JSON values");

    try {
        if (ancestors.has(value)) invalidInput("Tool arguments must not contain cycles");
        ancestors.add(value);
        if (Array.isArray(value)) {
            const ownNames = Object.getOwnPropertyNames(value);
            if (
                Object.getOwnPropertySymbols(value).length > 0 ||
                ownNames.length !== value.length + 1 ||
                !ownNames.includes("length")
            ) {
                invalidInput("Tool argument arrays must contain only indexed JSON values");
            }
            const result = new Array<unknown>(value.length);
            for (let index = 0; index < value.length; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (!descriptor || !("value" in descriptor)) {
                    invalidInput("Tool argument arrays must contain only indexed JSON values");
                }
                result[index] = normalizeJsonValue(descriptor.value, ancestors);
            }
            ancestors.delete(value);
            return result;
        }
        if (!isPlainObject(value)) invalidInput("Tool arguments must contain only plain JSON objects");
        if (Object.getOwnPropertySymbols(value).length > 0) {
            invalidInput("Tool arguments must not contain symbol keys");
        }
        const result = Object.create(null) as Record<string, unknown>;
        for (const key of Object.keys(value).sort()) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !("value" in descriptor)) invalidInput("Tool arguments must not contain accessors");
            result[key] = normalizeJsonValue(descriptor.value, ancestors);
        }
        ancestors.delete(value);
        return result;
    } catch (error) {
        if (error instanceof ContextReferenceError) throw error;
        throw new ContextReferenceError(
            "invalid_input",
            "Tool arguments must contain only JSON values",
            error instanceof Error ? error : undefined
        );
    }
}

function normalizeContent(content: unknown, includeToolCalls: boolean): ContextSnapshotBlock[] {
    if (typeof content === "string") {
        return content.length === 0 ? [] : [{ type: "text", text: content }];
    }
    if (!Array.isArray(content)) return [];

    const blocks: ContextSnapshotBlock[] = [];
    for (const contentBlock of content) {
        if (typeof contentBlock !== "object" || contentBlock == null) continue;
        const block = contentBlock as {
            type?: unknown;
            text?: unknown;
            data?: unknown;
            mimeType?: unknown;
            id?: unknown;
            name?: unknown;
            arguments?: unknown;
        };
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            blocks.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
            blocks.push(normalizedImageBlock(block));
        } else if (
            includeToolCalls &&
            block.type === "toolCall" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
        ) {
            blocks.push({
                type: "tool_call",
                id: block.id,
                name: block.name,
                arguments: normalizeJsonValue(block.arguments),
            });
        }
    }
    return blocks;
}

function normalizeMessage(entry: SessionTreeEntry): ContextSnapshotMessage | undefined {
    if (entry.type !== "message") return undefined;
    const message = entry.message as {
        role?: unknown;
        content?: unknown;
        toolCallId?: unknown;
        toolName?: unknown;
        isError?: unknown;
    };
    if (message.role === "user") {
        return { role: "user", content: normalizeContent(message.content, false) };
    }
    if (message.role === "assistant") {
        return { role: "assistant", content: normalizeContent(message.content, true) };
    }
    if (message.role === "toolResult") {
        return {
            role: "tool_result",
            content: normalizeContent(message.content, false),
            ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
            ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
            ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
        };
    }
    return undefined;
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (typeof value !== "object" || value == null) return value;
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
        result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function hasUsefulContent(messages: ContextSnapshotMessage[]): boolean {
    return messages.some((message) =>
        message.content.some(
            (block) => block.type === "tool_call" || (block.type === "text" && block.text.trim().length > 0)
        )
    );
}

function makePreview(messages: ContextSnapshotMessage[]): string {
    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === "text") {
                const preview = block.text.replace(/\s+/g, " ").trim();
                if (preview.length > 0) return preview;
            }
            if (block.type === "tool_call") return `Tool call: ${block.name}`;
        }
        if (message.role === "tool_result") return `Tool result: ${message.toolName ?? "tool"}`;
    }
    return "Referenced context";
}

function selectEntries(input: ContextCaptureInput): SessionTreeEntry[] {
    if (input.sourceKind === "session") {
        if (input.sourceLeafId == null) {
            throw new ContextReferenceError("source_not_found", "The active source branch has no leaf");
        }
        return input.sourceEntries;
    }

    if (input.sourceTurnId == null) {
        throw new ContextReferenceError("invalid_input", "sourceTurnId is required for turn captures");
    }
    const selectedIndex = input.sourceEntries.findIndex((entry) => entry.id === input.sourceTurnId);
    const selected = input.sourceEntries[selectedIndex];
    if (!selected || !isUserMessageEntry(selected)) {
        throw new ContextReferenceError("invalid_input", "Only active-branch user messages can be referenced");
    }
    const turnEntries: SessionTreeEntry[] = [];
    for (let index = selectedIndex; index < input.sourceEntries.length; index++) {
        const entry = input.sourceEntries[index]!;
        if (index > selectedIndex && isUserMessageEntry(entry)) break;
        turnEntries.push(entry);
    }
    return turnEntries;
}

export function captureContextArtifactDraft(input: ContextCaptureInput): ContextArtifactDraft {
    const selectedEntries = selectEntries(input);
    const captured = selectedEntries.flatMap((entry) => {
        const message = normalizeMessage(entry);
        return message == null ? [] : [{ entryId: entry.id, message }];
    });
    const messages = canonicalize(captured.map(({ message }) => message)) as ContextSnapshotMessage[];
    if (!hasUsefulContent(messages)) {
        throw new ContextReferenceError("invalid_input", "The selected source has no useful text or tool content");
    }

    const canonical = canonicalJson(messages);
    const canonicalByteLength = Buffer.byteLength(canonical, "utf8");
    if (canonicalByteLength > MaxSnapshotBytes) {
        throw new ContextReferenceError("source_too_large", "The normalized source snapshot exceeds 2 MiB");
    }

    const artifact: ContextArtifact = {
        schemaVersion: 1,
        provenance: {
            sourceKind: input.sourceKind,
            sourceSessionId: input.sourceMetadata.id,
            sourceSessionPath: input.sourceMetadata.path,
            ...(input.sourceTitle == null ? {} : { sourceSessionTitle: input.sourceTitle }),
            sourceCwd: input.sourceMetadata.cwd,
            ...(input.sourceKind === "turn" ? { sourceTurnId: input.sourceTurnId! } : {}),
            sourceLeafId: input.sourceLeafId,
            sourceMessageEntryIds: captured.map(({ entryId }) => entryId),
            preview: makePreview(messages),
            capturedAt: (input.now ?? (() => new Date()))().toISOString(),
        },
        messages,
        snapshotSha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
        canonicalByteLength,
    };
    return { artifact };
}

export function getModelVisibleMessageEntryIds(entries: SessionTreeEntry[]): string[] {
    let latestCompactionIndex = -1;
    for (let index = 0; index < entries.length; index++) {
        if (entries[index]!.type === "compaction") latestCompactionIndex = index;
    }
    if (latestCompactionIndex < 0) {
        return entries.filter((entry) => entry.type === "message").map((entry) => entry.id);
    }

    const latestCompaction = entries[latestCompactionIndex]!;
    const firstKeptEntryId = latestCompaction.type === "compaction" ? latestCompaction.firstKeptEntryId : "";
    const visible: string[] = [];
    let foundFirstKept = false;
    for (let index = 0; index < latestCompactionIndex; index++) {
        const entry = entries[index]!;
        if (entry.id === firstKeptEntryId) foundFirstKept = true;
        if (foundFirstKept && entry.type === "message") visible.push(entry.id);
    }
    for (let index = latestCompactionIndex + 1; index < entries.length; index++) {
        const entry = entries[index]!;
        if (entry.type === "message") visible.push(entry.id);
    }
    return visible;
}
