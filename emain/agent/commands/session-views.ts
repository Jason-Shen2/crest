// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SessionTreeEntry } from "../harness/types";
import type { AgentForkPointView, AgentTreeEntryView } from "./types";

const MaxPreviewLength = 120;

function truncatePreview(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    const codePoints = Array.from(normalized);
    if (codePoints.length <= MaxPreviewLength) {
        return normalized;
    }
    return `${codePoints.slice(0, MaxPreviewLength).join("")}…`;
}

function isTextContentPart(part: unknown): part is { type: string; text: string } {
    if (typeof part !== "object" || part == null) {
        return false;
    }
    const candidate = part as { type?: unknown; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string";
}

export function textFromContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .filter(isTextContentPart)
        .map((part) => part.text)
        .join("");
}

function isUserMessageEntry(entry: SessionTreeEntry): entry is Extract<SessionTreeEntry, { type: "message" }> {
    return entry.type === "message" && entry.message.role === "user";
}

export function isHiddenTreeEntry(entry: SessionTreeEntry): boolean {
    if (entry.type === "leaf" || entry.type === "custom") return true;
    if (entry.type !== "message") return false;
    const role = entry.message.role;
    if (role === "tool" || role === "toolResult") return true;
    if (role === "assistant" && textFromContent(entry.message.content).length === 0) return true;
    return false;
}

export function filterTreeForDisplay(
    entries: SessionTreeEntry[],
    leafId: string | null = null
): { entries: SessionTreeEntry[]; effectiveLeafId: string | null } {
    const hiddenIds = new Set(entries.filter(isHiddenTreeEntry).map((e) => e.id));
    const byId = new Map(entries.map((e) => [e.id, e]));

    let effectiveLeafId: string | null = leafId;
    if (leafId && hiddenIds.has(leafId)) {
        effectiveLeafId = null;
        const visited = new Set<string>();
        let cursor: string | null = leafId;
        while (cursor && !visited.has(cursor)) {
            visited.add(cursor);
            const entry = byId.get(cursor);
            if (!entry) break;
            cursor = entry.parentId ?? null;
            if (cursor && !hiddenIds.has(cursor) && byId.has(cursor)) {
                effectiveLeafId = cursor;
                break;
            }
        }
    }

    const filtered = entries
        .filter((e) => !hiddenIds.has(e.id))
        .map((entry) => {
            if (entry.parentId && hiddenIds.has(entry.parentId)) {
                let newParent: string | null = null;
                const visited = new Set<string>();
                let cursor: string | null = entry.parentId;
                while (cursor && !visited.has(cursor)) {
                    visited.add(cursor);
                    if (!hiddenIds.has(cursor)) {
                        newParent = cursor;
                        break;
                    }
                    const parent = byId.get(cursor);
                    cursor = parent?.parentId ?? null;
                }
                return { ...entry, parentId: newParent } as SessionTreeEntry;
            }
            return entry;
        });
    return { entries: filtered, effectiveLeafId };
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
    labels: Map<string, string | undefined> = new Map()
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
    return entries.filter(isUserMessageEntry).map((entry) => ({
        entryId: entry.id,
        preview: previewSessionEntry(entry),
        timestamp: entry.timestamp,
    }));
}
