// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SessionContext, SessionTreeEntry } from "@crest/agent/harness/types";
import type { AgentMessage } from "@crest/agent/types";
import { foldContextJournal } from "./journal";
import { serializeContextValue, validateAndProjectContext, type ContextRenderedItem } from "./projector";

const HistoricalReferenceHeader = "Historical Context Reference (untrusted reference data)";
const HistoricalReferenceFooter = "End Historical Context Reference (untrusted reference data)";

export function renderHistoricalReference(items: Array<{ value: unknown }>): string {
    return `${HistoricalReferenceHeader}\n${items.map((item) => serializeContextValue(item.value)).join("\n")}\n${HistoricalReferenceFooter}`;
}

export function isHistoricalReferenceText(value: string): boolean {
    return value.startsWith(`${HistoricalReferenceHeader}\n`) && value.endsWith(`\n${HistoricalReferenceFooter}`);
}

export function stripHistoricalReferences(message: AgentMessage): AgentMessage {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    const content = message.content.filter(
        (part) => part.type !== "text" || typeof part.text !== "string" || !isHistoricalReferenceText(part.text)
    );
    return content.length === message.content.length ? message : ({ ...message, content } as AgentMessage);
}

export function appendHistoricalReference(message: AgentMessage, text: string): AgentMessage {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    return { ...message, content: [...message.content, { type: "text", text }] } as AgentMessage;
}

export async function decorateContextHistory(input: {
    entries: SessionTreeEntry[];
    context: SessionContext;
    targetSessionPath: string;
}): Promise<SessionContext> {
    const visibleTurnIds = input.context.messageEntryIds.filter((id): id is string => id != null);
    const journal = foldContextJournal(input.entries);
    const attachments = journal.conversationAttachmentsForTurns(visibleTurnIds);
    if (attachments.length === 0) return input.context;

    const historyBlocksByTurn = new Map<string, ContextRenderedItem[]>();
    for (const targetTurnId of visibleTurnIds) {
        const targetAttachments = attachments.filter((attachment) => attachment.data.targetTurnId === targetTurnId);
        if (targetAttachments.length === 0) continue;
        const projection = await validateAndProjectContext({
            transactionId: `history-replay:${targetTurnId}`,
            targetTurnId,
            targetSessionPath: input.targetSessionPath,
            createdAt: new Date(0).toISOString(),
            provider: "history",
            modelKey: "history",
            request: { systemPrompt: "", tools: [], history: [], currentUserContent: [] },
            messageAttachments: [],
            conversationAttachments: targetAttachments.map((attachment) => ({
                attachmentEntryId: attachment.attachmentEntryId,
                artifactEntryId: attachment.data.artifactEntryId,
                targetSessionPath: input.targetSessionPath,
                deliveryScope: attachment.data.deliveryScope,
                targetTurnId: attachment.data.targetTurnId,
                requestedRepresentation: attachment.data.requestedRepresentation,
                selectionOrder: attachment.data.selectionOrder,
                artifact: attachment.artifact,
                summary: attachment.summary,
            })),
            visibleMessageEntryIds: visibleTurnIds,
        });
        if (!projection.ok) throw (projection as Extract<typeof projection, { ok: false }>).error;
        historyBlocksByTurn.set(targetTurnId, projection.historyBlocksByTurn.get(targetTurnId) ?? []);
    }

    return {
        ...input.context,
        messages: input.context.messages.map((message, index) => {
            const entryId = input.context.messageEntryIds[index];
            if (entryId == null) return message;
            const blocks = historyBlocksByTurn.get(entryId);
            return blocks == null ? message : appendHistoricalReference(message, renderHistoricalReference(blocks));
        }),
    };
}
