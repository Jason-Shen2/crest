// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
    buildContextInventory,
    buildContextSnapshot,
    markContextSnapshotLifecycle,
    reconcileContextAttribution,
} from "./inspector";
import type { BuildContextSnapshotInput, ContextSnapshotItem } from "./inspector-types";
import { buildSessionContext } from "@crest/agent/harness/session/session";
import { createTransactionManifestData } from "@crest/agent/harness/session/entry-transaction";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import type { AgentMessage } from "@crest/agent/types";
import { appendHistoricalReference, renderHistoricalReference } from "./history";
import { ContextCustomTypes } from "./journal";

const GeneratedAt = "2026-08-01T00:00:00.000Z";

function item(overrides: Partial<ContextSnapshotItem> = {}): ContextSnapshotItem {
    return {
        id: "base-prompt",
        category: "agent_instructions",
        kind: "base_prompt",
        title: "Base instructions",
        preview: "You are an expert coding assistant.",
        tokens: 120,
        tokenAccuracy: "estimated",
        source: {},
        ...overrides,
    };
}

function fixture(overrides: Partial<BuildContextSnapshotInput> = {}): BuildContextSnapshotInput {
    return {
        identity: {
            sessionPath: "/sessions/current.jsonl",
            sessionId: "session-1",
            leafId: "leaf-1",
            modelKey: "openai/gpt-5",
            revision: 1,
        },
        generatedAt: GeneratedAt,
        lifecycle: "ready",
        accuracy: "exact",
        modelLabel: "GPT-5",
        contextWindow: 200_000,
        outputReserve: 16_000,
        providerInputTokens: 25_053,
        items: [item()],
        ...overrides,
    };
}

describe("Context Inspector snapshot", () => {
    it("subtracts output reserve from usable input capacity", () => {
        const snapshot = buildContextSnapshot(fixture());

        expect(snapshot.inputCapacity).toBe(184_000);
    });

    it("uses provider input without adding cache, output, or reasoning usage", () => {
        const snapshot = buildContextSnapshot(
            fixture({
                providerInputTokens: 25_053,
                providerUsage: {
                    cachedInputTokens: 23_424,
                    outputTokens: 79,
                    reasoningTokens: 29,
                },
            })
        );

        expect(snapshot.effectiveInputTokens).toBe(25_053);
    });

    it("keeps semantic categories in product order", () => {
        const snapshot = buildContextSnapshot(
            fixture({
                items: [
                    item({ id: "reference", category: "added_context", kind: "context_reference" }),
                    item({ id: "turn", category: "conversation", kind: "turn" }),
                    item({ id: "tool", category: "tools", kind: "tool_definition" }),
                    item(),
                ],
            })
        );

        expect(snapshot.categories.map((category) => category.category)).toEqual([
            "agent_instructions",
            "tools",
            "conversation",
            "added_context",
        ]);
    });

    it("accounts for a non-negative unassigned request overhead", () => {
        expect(reconcileContextAttribution(500, 420)).toEqual({
            requestOverheadTokens: 80,
            attributionDeltaTokens: undefined,
        });
    });

    it("reports attribution overlap without rescaling semantic items", () => {
        expect(reconcileContextAttribution(400, 420)).toEqual({
            requestOverheadTokens: 0,
            attributionDeltaTokens: -20,
        });
    });

    it("falls back to estimated semantic input when provider counting is unavailable", () => {
        const snapshot = buildContextSnapshot(
            fixture({ providerInputTokens: undefined, accuracy: "estimated", items: [item({ tokens: 240 })] })
        );

        expect(snapshot).toMatchObject({
            accuracy: "estimated",
            effectiveInputTokens: 240,
            remainingInputTokens: 183_760,
        });
    });

    it("keeps inventory while token counts are unavailable", () => {
        const snapshot = buildContextSnapshot(
            fixture({
                providerInputTokens: undefined,
                accuracy: "unavailable",
                items: [item({ tokens: undefined, tokenAccuracy: "unavailable" })],
            })
        );

        expect(snapshot.effectiveInputTokens).toBeUndefined();
        expect(snapshot.remainingInputTokens).toBeUndefined();
        expect(snapshot.items).toHaveLength(1);
    });

    it("clamps remaining capacity at zero", () => {
        const snapshot = buildContextSnapshot(fixture({ providerInputTokens: 190_000 }));

        expect(snapshot.remainingInputTokens).toBe(0);
    });

    it("changes lifecycle without mutating the prior snapshot", () => {
        const snapshot = buildContextSnapshot(fixture());
        const waiting = markContextSnapshotLifecycle(snapshot, "waiting_for_tool", "Waiting for tool result");

        expect(waiting).not.toBe(snapshot);
        expect(waiting).toMatchObject({ lifecycle: "waiting_for_tool", diagnostic: "Waiting for tool result" });
        expect(snapshot).toMatchObject({ lifecycle: "ready", diagnostic: undefined });
    });
});

function entry(id: string, parentId: string | null, message: Record<string, unknown>): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: `2026-08-01T00:00:0${id.length}.000Z`,
        message,
    } as unknown as SessionTreeEntry;
}

function customEntry(
    id: string,
    parentId: string | null,
    customType: string,
    data: unknown,
    transactionId: string
): SessionTreeEntry {
    return {
        type: "custom",
        id,
        parentId,
        timestamp: "2026-08-01T00:00:00.000Z",
        customType,
        data,
        transactionId,
    } as SessionTreeEntry;
}

describe("Context Inspector semantic inventory", () => {
    it("attributes generated historical reference blocks only to Added context", () => {
        const userMessage = { role: "user", content: [{ type: "text", text: "Use the reference" }] } as AgentMessage;
        const decoratedMessage = appendHistoricalReference(
            userMessage,
            renderHistoricalReference([{ value: { source: "historical", content: "large injected value" } }])
        );
        const plain = buildContextInventory({
            entries: [],
            context: {
                messages: [userMessage],
                messageEntryIds: ["user-1"],
                thinkingLevel: "off",
                model: null,
            },
            tools: [],
        });
        const decorated = buildContextInventory({
            entries: [],
            context: {
                messages: [decoratedMessage],
                messageEntryIds: ["user-1"],
                thinkingLevel: "off",
                model: null,
            },
            tools: [],
        });

        expect(decorated.find((item) => item.id === "turn:user-1")?.tokens).toBe(
            plain.find((item) => item.id === "turn:user-1")?.tokens
        );
    });

    it("groups a complete conversation turn and pairs tool calls with their results", () => {
        const entries = [
            entry("user-1", null, { role: "user", content: [{ type: "text", text: "Read package.json" }] }),
            entry("assistant-1", "user-1", {
                role: "assistant",
                content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json" } }],
            }),
            entry("result-1", "assistant-1", {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "read",
                content: [{ type: "text", text: "package contents" }],
                isError: false,
            }),
            entry("assistant-2", "result-1", {
                role: "assistant",
                content: [{ type: "text", text: "The package is valid." }],
            }),
        ];

        const items = buildContextInventory({ entries, context: buildSessionContext(entries), tools: [] });
        const turn = items.find((candidate) => candidate.kind === "turn");

        expect(turn).toMatchObject({ id: "turn:user-1", source: { entryIds: ["user-1", "assistant-1", "result-1", "assistant-2"] } });
        expect(turn?.children?.map((child) => child.kind)).toEqual([
            "user_message",
            "tool_call",
            "tool_result",
            "assistant_message",
        ]);
        expect(turn?.children?.find((child) => child.kind === "tool_call")?.source).toMatchObject({
            toolCallId: "call-1",
            pairedResultEntryId: "result-1",
        });
    });

    it("replaces covered turns with a compaction summary item", () => {
        const before = [
            entry("user-old", null, { role: "user", content: [{ type: "text", text: "Old question" }] }),
            entry("assistant-old", "user-old", { role: "assistant", content: [{ type: "text", text: "Old answer" }] }),
            entry("user-kept", "assistant-old", { role: "user", content: [{ type: "text", text: "Kept question" }] }),
            entry("assistant-kept", "user-kept", { role: "assistant", content: [{ type: "text", text: "Kept answer" }] }),
        ];
        const compaction = {
            type: "compaction",
            id: "compact-1",
            parentId: "assistant-kept",
            timestamp: "2026-08-01T00:01:00.000Z",
            summary: "Old summarized history",
            firstKeptEntryId: "user-kept",
            tokensBefore: 400,
        } as SessionTreeEntry;
        const entries = [...before, compaction];

        const items = buildContextInventory({ entries, context: buildSessionContext(entries), tools: [] });

        expect(items.filter((candidate) => candidate.kind === "turn").map((candidate) => candidate.id)).toEqual([
            "turn:user-kept",
        ]);
        expect(items.find((candidate) => candidate.kind === "compaction_summary")).toMatchObject({
            id: "compaction:compact-1",
            source: { coveredEntryIds: ["user-old", "assistant-old"] },
        });
    });

    it("keeps an effective branch summary as a durable conversation item", () => {
        const branchSummary = {
            type: "branch_summary",
            id: "branch-summary-1",
            parentId: null,
            timestamp: "2026-08-01T00:01:00.000Z",
            fromId: "abandoned-assistant",
            summary: "The abandoned branch investigated an alternate parser.",
        } as unknown as SessionTreeEntry;
        const user = entry("user-after-branch", "branch-summary-1", {
            role: "user",
            content: [{ type: "text", text: "Continue from the summary" }],
        });
        const entries = [branchSummary, user];

        const items = buildContextInventory({ entries, context: buildSessionContext(entries), tools: [] });

        expect(items.find((candidate) => candidate.kind === "branch_summary")).toMatchObject({
            id: "branch-summary:branch-summary-1",
            preview: "The abandoned branch investigated an alternate parser.",
            source: { entryIds: ["branch-summary-1"] },
        });
    });

    it("keeps message and conversation references in Added context", () => {
        const transactionId = "tx-1";
        const artifactData = {
            schemaVersion: 1,
            provenance: {
                sourceKind: "turn",
                sourceSessionId: "source-session",
                sourceSessionPath: "/source.jsonl",
                sourceCwd: "/source",
                sourceTurnId: "source-turn",
                sourceLeafId: "source-leaf",
                sourceMessageEntryIds: ["source-message"],
                preview: "Referenced source",
                capturedAt: "2026-08-01T00:00:00.000Z",
            },
            messages: [{ role: "user", content: [{ type: "text", text: "Referenced source" }] }],
            snapshotSha256: "a".repeat(64),
            canonicalByteLength: 17,
        };
        const artifact = customEntry("artifact", null, ContextCustomTypes.artifact, artifactData, transactionId);
        const messageAttach = customEntry(
            "message-attach",
            "artifact",
            ContextCustomTypes.attach,
            {
                schemaVersion: 1,
                transactionId,
                artifactEntryId: "artifact",
                deliveryScope: "message",
                requestedRepresentation: "full",
                targetTurnId: "user-1",
                selectionOrder: 0,
            },
            transactionId
        );
        const conversationAttach = customEntry(
            "conversation-attach",
            "message-attach",
            ContextCustomTypes.attach,
            {
                schemaVersion: 1,
                transactionId,
                artifactEntryId: "artifact",
                deliveryScope: "conversation",
                requestedRepresentation: "full",
                targetTurnId: "user-1",
                selectionOrder: 1,
            },
            transactionId
        );
        const user = {
            ...entry("user-1", "manifest", { role: "user", content: [{ type: "text", text: "Use context" }] }),
            transactionId,
        } as SessionTreeEntry;
        const members = [artifact, messageAttach, conversationAttach, user];
        const manifest = customEntry(
            "manifest",
            "conversation-attach",
            ContextCustomTypes.transactionManifest,
            createTransactionManifestData(transactionId, members),
            transactionId
        );
        const entries = [artifact, messageAttach, conversationAttach, manifest, user];

        const items = buildContextInventory({
            entries,
            context: buildSessionContext(entries),
            tools: [],
            activeTurnId: "user-1",
        });

        expect(items.filter((candidate) => candidate.category === "added_context")).toEqual([
            expect.objectContaining({ id: "context:message-attach", kind: "context_reference" }),
            expect.objectContaining({ id: "context:conversation-attach", kind: "context_reference" }),
        ]);
    });

    it("keeps a malformed attachment visible without inventing token attribution", () => {
        const transactionId = "tx-missing-artifact";
        const attachment = customEntry(
            "missing-source-attach",
            null,
            ContextCustomTypes.attach,
            {
                schemaVersion: 1,
                transactionId,
                artifactEntryId: "missing-artifact",
                deliveryScope: "conversation",
                requestedRepresentation: "summary",
                targetTurnId: "user-1",
                selectionOrder: 0,
            },
            transactionId
        );
        const user = {
            ...entry("user-1", "manifest", { role: "user", content: [{ type: "text", text: "Use context" }] }),
            transactionId,
        } as SessionTreeEntry;
        const members = [attachment, user];
        const manifest = customEntry(
            "manifest",
            "missing-source-attach",
            ContextCustomTypes.transactionManifest,
            createTransactionManifestData(transactionId, members),
            transactionId
        );
        const entries = [attachment, manifest, user];

        const items = buildContextInventory({ entries, context: buildSessionContext(entries), tools: [] });

        expect(items.find((candidate) => candidate.id === "context:missing-source-attach")).toMatchObject({
            tokenAccuracy: "unavailable",
            tokens: undefined,
            diagnostic: "Context attachment source is unavailable.",
            source: { attachmentEntryId: "missing-source-attach", artifactEntryId: "missing-artifact" },
        });
    });
});
