// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { JsonlSessionMetadata, SessionTreeEntry } from "../harness/types";
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

function normalizedImageBlock(block: { data?: unknown; mimeType?: unknown }): ContextSnapshotBlock | undefined {
    if (typeof block.data !== "string" || typeof block.mimeType !== "string") return undefined;
    return { type: "image_omitted", mimeType: block.mimeType, byteLength: Buffer.byteLength(block.data, "base64") };
}

function normalizeContent(content: unknown, includeToolCalls: boolean): ContextSnapshotBlock[] {
    if (typeof content === "string") {
        return content.length === 0 ? [] : [{ type: "text", text: content }];
    }
    if (!Array.isArray(content)) return [];

    const blocks: ContextSnapshotBlock[] = [];
    for (const contentBlock of content) {
        if (typeof contentBlock !== "object" || contentBlock == null) continue;
        const block = contentBlock as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            blocks.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
            const image = normalizedImageBlock(block);
            if (image) blocks.push(image);
        } else if (includeToolCalls && block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
            blocks.push({ type: "tool_call", id: block.id, name: block.name, arguments: block.arguments });
        }
    }
    return blocks;
}

function normalizeMessage(entry: SessionTreeEntry): ContextSnapshotMessage | undefined {
    if (entry.type !== "message") return undefined;
    const message = entry.message as { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown };
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
        message.content.some((block) => block.type === "tool_call" || (block.type === "text" && block.text.trim().length > 0))
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
    const messages = captured.map(({ message }) => message);
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
