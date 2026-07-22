// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SessionTreeEntry } from "../harness/types";
import type { AgentForkPointView, AgentReferencePointView, AgentTreeEntryView } from "./types";

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

/**
 * Only PURELY STRUCTURAL entries are stripped at the backend. Everything else
 * — tool results, model/thinking/session bookkeeping, assistant tool-only
 * turns — is sent to the renderer, which applies Pi's FilterMode
 * (default/no-tools/user-only/labeled-only/all) at display time. This mirrors
 * Pi: its `default` view SHOWS toolResults; only `no-tools` hides them (see
 * pi coding-agent tree-selector.ts applyFilter). `leaf` records the active
 * leaf pointer and `label` records a label pointer whose text crest instead
 * attaches to the target node via the labels map — neither is a real node.
 */
export function isHiddenTreeEntry(entry: SessionTreeEntry): boolean {
    return entry.type === "leaf" || entry.type === "label";
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

/** Tool-call args captured from assistant turns, keyed by toolCallId. */
type ToolCallArgsMap = Map<string, { name: string; arguments: Record<string, unknown> }>;

/**
 * Collect `toolCall` content blocks from every assistant message so a
 * following `toolResult` (which only carries a toolCallId + toolName) can be
 * rendered with the original arguments. Ported from Pi's toolCallMap
 * (tree-selector.ts flattenTree).
 */
export function buildToolCallArgsMap(entries: SessionTreeEntry[]): ToolCallArgsMap {
    const map: ToolCallArgsMap = new Map();
    for (const entry of entries) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        const content = (entry.message as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (typeof block === "object" && block !== null && "type" in block && (block as { type: unknown }).type === "toolCall") {
                const tc = block as { id: string; name: string; arguments?: Record<string, unknown> };
                map.set(tc.id, { name: tc.name, arguments: tc.arguments ?? {} });
            }
        }
    }
    return map;
}

function shortenHomePath(p: string): string {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
    return p;
}

/**
 * Human-friendly one-line summary of a tool call. Returns the INNER text only
 * (no surrounding brackets); the renderer adds its own bracket styling.
 * Ported from Pi's formatToolCall (tree-selector.ts).
 */
export function formatToolCallPreview(name: string, args: Record<string, unknown>): string {
    switch (name) {
        case "read": {
            const path = shortenHomePath(String(args.path || args.file_path || ""));
            const offset = args.offset as number | undefined;
            const limit = args.limit as number | undefined;
            let display = path;
            if (offset !== undefined || limit !== undefined) {
                const start = offset ?? 1;
                const end = limit !== undefined ? start + limit - 1 : "";
                display += `:${start}${end ? `-${end}` : ""}`;
            }
            return `read: ${display}`;
        }
        case "write":
            return `write: ${shortenHomePath(String(args.path || args.file_path || ""))}`;
        case "edit":
            return `edit: ${shortenHomePath(String(args.path || args.file_path || ""))}`;
        case "bash": {
            const rawCmd = String(args.command || "");
            const cmd = rawCmd.replace(/[\n\t]/g, " ").trim().slice(0, 50);
            return `bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}`;
        }
        case "grep":
            return `grep: /${String(args.pattern || "")}/ in ${shortenHomePath(String(args.path || "."))}`;
        case "find":
            return `find: ${String(args.pattern || "")} in ${shortenHomePath(String(args.path || "."))}`;
        case "ls":
            return `ls: ${shortenHomePath(String(args.path || "."))}`;
        default: {
            const full = JSON.stringify(args);
            const argsStr = full.slice(0, 40);
            return `${name}: ${argsStr}${full.length > 40 ? "..." : ""}`;
        }
    }
}

export function previewSessionEntry(entry: SessionTreeEntry, toolCalls?: ToolCallArgsMap): string {
    if (entry.type === "message") {
        const role = entry.message.role;
        if (role === "toolResult") {
            const msg = entry.message as { toolCallId?: string; toolName?: string };
            const tc = msg.toolCallId ? toolCalls?.get(msg.toolCallId) : undefined;
            if (tc) return truncatePreview(formatToolCallPreview(tc.name, tc.arguments));
            return msg.toolName ?? "tool";
        }
        return truncatePreview(textFromContent((entry.message as { content?: unknown }).content));
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
    if (entry.type === "model_change") {
        return `model: ${entry.modelId}`;
    }
    if (entry.type === "thinking_level_change") {
        return `thinking: ${entry.thinkingLevel}`;
    }
    if (entry.type === "session_info") {
        return entry.name ? `title: ${entry.name}` : "title";
    }
    if (entry.type === "custom") {
        return entry.customType;
    }
    return entry.type;
}

export function buildAgentTreeEntryViews(
    entries: SessionTreeEntry[],
    leafId: string | null,
    labels: Map<string, string | undefined> = new Map()
): AgentTreeEntryView[] {
    const toolCalls = buildToolCallArgsMap(entries);
    const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    const activeIds = new Set<string>();
    let activeEntry = leafId == null ? undefined : entriesById.get(leafId);
    while (activeEntry && !activeIds.has(activeEntry.id)) {
        activeIds.add(activeEntry.id);
        activeEntry = activeEntry.parentId == null ? undefined : entriesById.get(activeEntry.parentId);
    }
    return entries.map((entry) => {
        const label = labels.get(entry.id);
        const stopReason =
            entry.type === "message" && entry.message.role === "assistant"
                ? (entry.message as { stopReason?: string }).stopReason
                : undefined;
        return {
            id: entry.id,
            ...(entry.parentId != null ? { parentId: entry.parentId } : {}),
            type: entry.type,
            ...(entry.type === "message" ? { role: entry.message.role } : {}),
            ...(label ? { label } : {}),
            ...(stopReason ? { stopReason } : {}),
            preview: previewSessionEntry(entry, toolCalls),
            timestamp: entry.timestamp,
            isLeaf: entry.id === leafId,
            isCurrent: entry.id === leafId,
            ...(activeIds.has(entry.id) && isUserMessageEntry(entry) ? { referenceable: true } : {}),
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

export function buildAgentReferencePointViews(entries: SessionTreeEntry[]): AgentReferencePointView[] {
    return entries.filter(isUserMessageEntry).map((entry) => ({
        entryId: entry.id,
        preview: previewSessionEntry(entry),
        timestamp: entry.timestamp,
    }));
}
