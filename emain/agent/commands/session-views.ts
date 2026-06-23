// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SessionTreeEntry } from "../harness/types";
import type { AgentForkPointView, AgentTreeEntryView } from "./types";

const MaxPreviewLength = 120;

function truncatePreview(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= MaxPreviewLength) {
        return normalized;
    }
    return `${normalized.slice(0, MaxPreviewLength)}…`;
}

function isTextContentPart(part: unknown): part is { type: string; text?: string } {
    if (typeof part !== "object" || part == null) {
        return false;
    }
    return (part as { type?: unknown }).type === "text";
}

function textFromContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .filter(isTextContentPart)
        .map((part) => part.text ?? "")
        .join("");
}

function isUserMessageEntry(entry: SessionTreeEntry): entry is Extract<SessionTreeEntry, { type: "message" }> {
    return entry.type === "message" && entry.message.role === "user";
}

export function previewSessionEntry(entry: SessionTreeEntry): string {
    if (entry.type === "message") {
        return truncatePreview(textFromContent(entry.message.content));
    }
    if (entry.type === "custom_message") {
        return truncatePreview(textFromContent(entry.content));
    }
    if (entry.type === "branch_summary") {
        return truncatePreview(entry.summary);
    }
    if (entry.type === "compaction") {
        return truncatePreview(entry.summary);
    }
    return entry.type;
}

export function buildAgentTreeEntryViews(
    entries: SessionTreeEntry[],
    leafId: string | null,
    labels: Map<string, string | undefined> = new Map(),
): AgentTreeEntryView[] {
    return entries.map((entry) => {
        const label = labels.get(entry.id);
        return {
            id: entry.id,
            ...(entry.parentId != null ? { parentId: entry.parentId } : {}),
            type: entry.type,
            ...(entry.type === "message" ? { role: entry.message.role } : {}),
            ...(label ? { label } : {}),
            preview: previewSessionEntry(entry),
            timestamp: entry.timestamp,
            isLeaf: entry.id === leafId,
            isCurrent: entry.id === leafId,
        };
    });
}

export function buildAgentForkPointViews(entries: SessionTreeEntry[]): AgentForkPointView[] {
    return entries
        .filter(isUserMessageEntry)
        .map((entry) => ({
            entryId: entry.id,
            preview: previewSessionEntry(entry),
            timestamp: entry.timestamp,
        }));
}
