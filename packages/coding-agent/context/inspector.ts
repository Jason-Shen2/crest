// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    BRANCH_SUMMARY_PREFIX,
    BRANCH_SUMMARY_SUFFIX,
    COMPACTION_SUMMARY_PREFIX,
    COMPACTION_SUMMARY_SUFFIX,
    bashExecutionToText,
} from "@crest/agent/harness/messages";
import type { SessionContext, SessionTreeEntry } from "@crest/agent/harness/types";
import type { AgentMessage, AgentTool } from "@crest/agent/types";
import type { SystemPromptManifest } from "../build-system-prompt";
import { stripHistoricalReferences } from "./history";
import type {
    AgentContextSnapshot,
    BuildContextSnapshotInput,
    ContextAttributionReconciliation,
    ContextSnapshotCategory,
    ContextSnapshotCategorySummary,
    ContextSnapshotItem,
    ContextSnapshotLifecycle,
} from "./inspector-types";
import { foldContextJournal } from "./journal";

export interface BuildContextInventoryInput {
    entries: SessionTreeEntry[];
    context: SessionContext;
    tools: AgentTool[];
    systemPromptManifest?: SystemPromptManifest;
    activeTurnId?: string;
}

export const ContextSnapshotCategoryOrder: readonly ContextSnapshotCategory[] = [
    "agent_instructions",
    "tools",
    "conversation",
    "added_context",
];

function validTokenCount(value: number | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function attributedItemTokens(items: readonly ContextSnapshotItem[]): number | undefined {
    let total = 0;
    for (const item of items) {
        if (!validTokenCount(item.tokens)) return undefined;
        total += item.tokens;
    }
    return total;
}

export function summarizeContextCategories(items: readonly ContextSnapshotItem[]): ContextSnapshotCategorySummary[] {
    return ContextSnapshotCategoryOrder.map((category) => {
        const categoryItems = items.filter((item) => item.category === category);
        return {
            category,
            tokens: attributedItemTokens(categoryItems),
            itemCount: categoryItems.length,
        };
    });
}

export function reconcileContextAttribution(
    effectiveInputTokens: number,
    attributedTokens: number
): ContextAttributionReconciliation {
    const difference = effectiveInputTokens - attributedTokens;
    if (difference >= 0) {
        return {
            requestOverheadTokens: difference,
            attributionDeltaTokens: undefined,
        };
    }
    return {
        requestOverheadTokens: 0,
        attributionDeltaTokens: difference,
    };
}

export function buildContextSnapshot(input: BuildContextSnapshotInput): AgentContextSnapshot {
    const contextWindow = Math.max(0, Math.trunc(input.contextWindow));
    const outputReserve = Math.max(0, Math.trunc(input.outputReserve));
    const inputCapacity = Math.max(0, contextWindow - outputReserve);
    const categories = summarizeContextCategories(input.items);
    const semanticTokens = attributedItemTokens(input.items);
    const providerInputTokens = validTokenCount(input.providerInputTokens)
        ? Math.trunc(input.providerInputTokens)
        : undefined;
    const effectiveInputTokens =
        providerInputTokens ?? (input.accuracy === "estimated" && semanticTokens != null ? semanticTokens : undefined);
    const reconciliation =
        effectiveInputTokens != null && semanticTokens != null
            ? reconcileContextAttribution(effectiveInputTokens, semanticTokens)
            : undefined;
    const attributionDiagnostic =
        reconciliation?.attributionDeltaTokens == null
            ? undefined
            : `Estimated source attribution exceeds provider input by ${Math.abs(reconciliation.attributionDeltaTokens)} tokens.`;

    return {
        schemaVersion: 1,
        identity: { ...input.identity },
        generatedAt: input.generatedAt,
        lifecycle: input.lifecycle,
        accuracy: input.accuracy,
        modelLabel: input.modelLabel,
        contextWindow,
        outputReserve,
        inputCapacity,
        effectiveInputTokens,
        remainingInputTokens:
            effectiveInputTokens == null ? undefined : Math.max(0, inputCapacity - effectiveInputTokens),
        requestOverheadTokens: reconciliation?.requestOverheadTokens,
        attributionDeltaTokens: reconciliation?.attributionDeltaTokens,
        categories,
        items: input.items.map((item) => structuredClone(item)),
        diagnostic: input.diagnostic ?? attributionDiagnostic,
    };
}

export function markContextSnapshotLifecycle(
    snapshot: AgentContextSnapshot,
    lifecycle: ContextSnapshotLifecycle,
    diagnostic?: string
): AgentContextSnapshot {
    return {
        ...snapshot,
        lifecycle,
        diagnostic,
    };
}

function estimateTextTokens(value: string): number {
    return Math.ceil(value.length / 4);
}

function messageContent(message: AgentMessage): unknown[] {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return [{ type: "text", text: content }];
    return Array.isArray(content) ? content : [];
}

function previewValue(value: unknown, limit = 180): string {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const normalized = (text ?? "").replace(/\s+/g, " ").trim();
    return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function messagePreview(message: AgentMessage): string {
    const role = (message as { role?: string }).role;
    if (role === "compactionSummary" || role === "branchSummary") {
        return previewValue((message as { summary?: string }).summary ?? "");
    }
    const blocks = messageContent(message);
    const text = blocks
        .filter((block): block is { type: string; text: string } =>
            Boolean(block && typeof block === "object" && (block as { type?: string }).type === "text")
        )
        .map((block) => block.text)
        .join(" ");
    return previewValue(text || blocks);
}

function messageTokens(message: AgentMessage): number {
    return estimateTextTokens(JSON.stringify(message));
}

function userMessageContent(message: AgentMessage): unknown {
    if (message.role === "user") {
        const effectiveMessage = stripHistoricalReferences(message);
        return { role: "user", content: (effectiveMessage as { content: unknown }).content };
    }
    if (message.role === "custom") {
        const content =
            typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
        return { role: "user", content };
    }
    if (message.role === "bashExecution") {
        return { role: "user", content: [{ type: "text", text: bashExecutionToText(message) }] };
    }
    return undefined;
}

function summaryContent(message: AgentMessage): unknown {
    if (message.role === "compactionSummary") {
        return {
            role: "user",
            content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX }],
        };
    }
    if (message.role === "branchSummary") {
        return {
            role: "user",
            content: [{ type: "text", text: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX }],
        };
    }
    return undefined;
}

function instructionItems(manifest?: SystemPromptManifest): ContextSnapshotItem[] {
    if (!manifest) return [];
    return manifest.segments.map((segment) => ({
        id: segment.id,
        category: "agent_instructions",
        kind: segment.kind,
        title: segment.title,
        preview: previewValue(segment.text),
        content: segment.text,
        tokens: estimateTextTokens(segment.text),
        tokenAccuracy: "estimated",
        source: {
            ...(segment.path == null ? {} : { path: segment.path }),
            ...(segment.skillName == null ? {} : { skillName: segment.skillName }),
        },
    }));
}

function toolItems(tools: AgentTool[]): ContextSnapshotItem[] {
    return tools.map((tool) => {
        const serialized = JSON.stringify({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        });
        return {
            id: `tool:${tool.name}`,
            category: "tools",
            kind: "tool_definition",
            title: tool.name,
            preview: previewValue(tool.description ?? serialized),
            content: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
            tokens: estimateTextTokens(serialized),
            tokenAccuracy: "estimated",
            source: { toolName: tool.name },
        };
    });
}

function latestCompaction(entries: SessionTreeEntry[]): Extract<SessionTreeEntry, { type: "compaction" }> | undefined {
    for (let index = entries.length - 1; index >= 0; index--) {
        if (entries[index]?.type === "compaction") {
            return entries[index] as Extract<SessionTreeEntry, { type: "compaction" }>;
        }
    }
    return undefined;
}

function coveredCompactionEntryIds(entries: SessionTreeEntry[], firstKeptEntryId: string): string[] {
    const firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
    if (firstKeptIndex <= 0) return [];
    return entries
        .slice(0, firstKeptIndex)
        .filter(
            (entry) => entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary"
        )
        .map((entry) => entry.id);
}

function childItem(
    message: AgentMessage,
    entryId: string | undefined,
    index: number,
    resultIdsByCall: Map<string, string>
): ContextSnapshotItem[] {
    const role = (message as { role?: string }).role;
    const stableId = entryId ?? `synthetic:${index}`;
    if (role === "user" || role === "custom" || role === "bashExecution") {
        const conversationMessage = stripHistoricalReferences(message);
        return [
            {
                id: `message:${stableId}`,
                category: "conversation",
                kind: "user_message",
                title: "User",
                preview: messagePreview(conversationMessage),
                content: userMessageContent(conversationMessage),
                tokens: messageTokens(conversationMessage),
                tokenAccuracy: "estimated",
                source: { entryIds: entryId == null ? [] : [entryId] },
            },
        ];
    }
    if (role === "toolResult") {
        const toolResultMessage = message as {
            toolCallId?: string;
            toolName?: string;
            content?: unknown;
            isError?: boolean;
        };
        const toolCallId = toolResultMessage.toolCallId;
        return [
            {
                id: `tool-result:${toolCallId ?? stableId}`,
                category: "conversation",
                kind: "tool_result",
                title: toolResultMessage.toolName ?? "Tool result",
                preview: messagePreview(message),
                content: {
                    role: "toolResult",
                    toolCallId: toolResultMessage.toolCallId,
                    toolName: toolResultMessage.toolName,
                    content: toolResultMessage.content,
                    isError: toolResultMessage.isError,
                },
                tokens: messageTokens(message),
                tokenAccuracy: "estimated",
                source: {
                    entryIds: entryId == null ? [] : [entryId],
                    ...(toolCallId == null ? {} : { toolCallId }),
                },
            },
        ];
    }
    if (role !== "assistant") return [];
    const children: ContextSnapshotItem[] = [];
    for (const [blockIndex, block] of messageContent(message).entries()) {
        if (!block || typeof block !== "object") continue;
        const value = block as { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };
        if (value.type === "toolCall") {
            const callId = value.id ?? `${stableId}:${blockIndex}`;
            children.push({
                id: `tool-call:${callId}`,
                category: "conversation",
                kind: "tool_call",
                title: value.name ?? "Tool call",
                preview: previewValue(value.arguments),
                content: { role: "assistant", content: [block] },
                tokens: estimateTextTokens(JSON.stringify(value)),
                tokenAccuracy: "estimated",
                source: {
                    entryIds: entryId == null ? [] : [entryId],
                    toolCallId: callId,
                    toolName: value.name,
                    pairedResultEntryId: resultIdsByCall.get(callId),
                },
            });
        } else if (value.type === "text" && value.text?.trim()) {
            children.push({
                id: `assistant:${stableId}:${blockIndex}`,
                category: "conversation",
                kind: "assistant_message",
                title: "Assistant",
                preview: previewValue(value.text),
                content: { role: "assistant", content: [block] },
                tokens: estimateTextTokens(value.text),
                tokenAccuracy: "estimated",
                source: { entryIds: entryId == null ? [] : [entryId] },
            });
        }
    }
    return children;
}

function conversationItems(input: BuildContextInventoryInput): ContextSnapshotItem[] {
    const items: ContextSnapshotItem[] = [];
    const resultIdsByCall = new Map<string, string>();
    input.context.messages.forEach((message, index) => {
        if (message.role !== "toolResult") return;
        const callId = message.toolCallId;
        const entryId = input.context.messageEntryIds[index];
        if (callId && entryId) resultIdsByCall.set(callId, entryId);
    });
    const compaction = latestCompaction(input.entries);
    let currentTurn: ContextSnapshotItem | undefined;
    const flushTurn = (): void => {
        if (!currentTurn) return;
        currentTurn.tokens = currentTurn.children?.reduce((total, child) => total + (child.tokens ?? 0), 0);
        items.push(currentTurn);
        currentTurn = undefined;
    };
    input.context.messages.forEach((message, index) => {
        if (message.role === "bashExecution" && message.excludeFromContext) return;
        const entryId = input.context.messageEntryIds[index];
        if (message.role === "compactionSummary") {
            flushTurn();
            items.push({
                id: `compaction:${entryId ?? index}`,
                category: "conversation",
                kind: "compaction_summary",
                title: "Compacted history",
                preview: messagePreview(message),
                content: summaryContent(message),
                tokens: messageTokens(message),
                tokenAccuracy: "estimated",
                source: {
                    entryIds: entryId == null ? [] : [entryId],
                    coveredEntryIds: compaction
                        ? coveredCompactionEntryIds(input.entries, compaction.firstKeptEntryId)
                        : [],
                },
            });
            return;
        }
        if (message.role === "branchSummary") {
            flushTurn();
            items.push({
                id: `branch-summary:${entryId ?? index}`,
                category: "conversation",
                kind: "branch_summary",
                title: "Branch summary",
                preview: messagePreview(message),
                content: summaryContent(message),
                tokens: messageTokens(message),
                tokenAccuracy: "estimated",
                source: { entryIds: entryId == null ? [] : [entryId] },
            });
            return;
        }
        if (message.role === "user") {
            flushTurn();
            const conversationMessage = stripHistoricalReferences(message);
            currentTurn = {
                id: `turn:${entryId ?? index}`,
                category: "conversation",
                kind: "turn",
                title: messagePreview(conversationMessage) || "Conversation turn",
                preview: messagePreview(conversationMessage),
                tokenAccuracy: "estimated",
                source: { entryIds: [] },
                children: [],
            };
        }
        if (!currentTurn) {
            currentTurn = {
                id: `turn:synthetic:${index}`,
                category: "conversation",
                kind: "turn",
                title: "Conversation turn",
                preview: messagePreview(message),
                tokenAccuracy: "estimated",
                source: { entryIds: [] },
                children: [],
            };
        }
        if (entryId) currentTurn.source.entryIds!.push(entryId);
        currentTurn.children!.push(...childItem(message, entryId, index, resultIdsByCall));
    });
    flushTurn();
    return items;
}

function addedContextItems(input: BuildContextInventoryInput): ContextSnapshotItem[] {
    const journal = foldContextJournal(input.entries);
    const visibleIds = new Set(input.context.messageEntryIds.filter((id): id is string => id != null));
    const attachments = [...journal.attachmentsByTurn.values()]
        .flat()
        .filter(
            (attachment) =>
                visibleIds.has(attachment.data.targetTurnId) &&
                (attachment.data.deliveryScope === "conversation" ||
                    attachment.data.targetTurnId === input.activeTurnId)
        );
    const reportItems = journal.projectionReports.flatMap((report) => report.items);
    return attachments.map((attachment) => {
        const report = reportItems.find((item) => item.attachmentEntryId === attachment.attachmentEntryId);
        const artifact = attachment.artifact;
        return {
            id: `context:${attachment.attachmentEntryId}`,
            category: "added_context",
            kind: "context_reference",
            title: artifact?.provenance.sourceSessionTitle ?? "Added context",
            preview: artifact?.provenance.preview ?? "Context source unavailable",
            tokens: report?.advisoryTokens,
            tokenAccuracy: report == null ? "unavailable" : "estimated",
            source: {
                attachmentEntryId: attachment.attachmentEntryId,
                artifactEntryId: attachment.data.artifactEntryId,
                entryIds: artifact?.provenance.sourceMessageEntryIds ?? [],
            },
            ...(artifact == null ? { diagnostic: "Context attachment source is unavailable." } : {}),
        } satisfies ContextSnapshotItem;
    });
}

export function buildContextInventory(input: BuildContextInventoryInput): ContextSnapshotItem[] {
    return [
        ...instructionItems(input.systemPromptManifest),
        ...toolItems(input.tools),
        ...conversationItems(input),
        ...addedContextItems(input),
    ];
}
