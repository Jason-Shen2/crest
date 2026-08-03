// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { convertToLlm } from "@crest/agent/harness/messages";
import { createTransactionManifestData } from "@crest/agent/harness/session/entry-transaction";
import { buildSessionContext } from "@crest/agent/harness/session/session";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import type { AgentMessage, AgentTool } from "@crest/agent/types";
import { appendHistoricalReference, renderHistoricalReference } from "./history";
import {
    buildContextInventory,
    buildContextSnapshot,
    markContextSnapshotLifecycle,
    reconcileContextAttribution,
} from "./inspector";
import type { BuildContextSnapshotInput, ContextSnapshotItem } from "./inspector-types";
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

    it("keeps negative attribution delta accounting out of snapshot diagnostics", () => {
        const snapshot = buildContextSnapshot(fixture({ providerInputTokens: 100, items: [item({ tokens: 120 })] }));

        expect(snapshot.attributionDeltaTokens).toBe(-20);
        expect(snapshot.diagnostic).toBeUndefined();
    });

    it("preserves explicit diagnostics when attribution has a negative delta", () => {
        const snapshot = buildContextSnapshot(
            fixture({ providerInputTokens: 100, items: [item({ tokens: 120 })], diagnostic: "counter failed" })
        );

        expect(snapshot.attributionDeltaTokens).toBe(-20);
        expect(snapshot.diagnostic).toBe("counter failed");
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

    it("does not share mutable model content with the inventory input", () => {
        const content = { role: "user", content: [{ type: "text", text: "Original" }] };
        const snapshot = buildContextSnapshot(fixture({ items: [item({ content } as Partial<ContextSnapshotItem>)] }));

        content.content[0]!.text = "Mutated";

        expect(snapshot.items[0]?.content).toEqual({
            role: "user",
            content: [{ type: "text", text: "Original" }],
        });
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
    it("keeps exact instruction text and complete model tool definitions", () => {
        const instructionText = "Follow this exact instruction.\n\nPreserve spacing and punctuation: !";
        const parameters = {
            type: "object",
            properties: {
                path: { type: "string", description: "Absolute file path" },
            },
            required: ["path"],
        };
        const items = buildContextInventory({
            entries: [],
            context: {
                messages: [],
                messageEntryIds: [],
                thinkingLevel: "off",
                model: null,
            },
            tools: [
                {
                    name: "read",
                    description: "Read a file from disk.",
                    parameters,
                } as unknown as AgentTool,
            ],
            systemPromptManifest: {
                text: instructionText,
                segments: [
                    {
                        id: "base-prompt",
                        kind: "base_prompt",
                        title: "Base instructions",
                        text: instructionText,
                    },
                ],
            },
        });

        expect(items.find((candidate) => candidate.kind === "base_prompt")?.content).toBe(instructionText);
        expect(items.find((candidate) => candidate.kind === "tool_definition")?.content).toEqual({
            name: "read",
            description: "Read a file from disk.",
            parameters,
        });
    });

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

    it("omits bash executions excluded from provider context", () => {
        const message = {
            role: "bashExecution",
            command: "printf hidden",
            output: "hidden",
            exitCode: 0,
            cancelled: false,
            truncated: false,
            timestamp: 1,
            excludeFromContext: true,
        } as AgentMessage;

        const items = buildContextInventory({
            entries: [],
            context: {
                messages: [message],
                messageEntryIds: ["bash-hidden"],
                thinkingLevel: "off",
                model: null,
            },
            tools: [],
        });

        expect(items).toEqual([]);
    });

    it("keeps the exact provider-visible text for included bash executions", () => {
        const message = {
            role: "bashExecution",
            command: "printf visible",
            output: "visible",
            exitCode: 0,
            cancelled: false,
            truncated: false,
            timestamp: 1,
        } as AgentMessage;

        const items = buildContextInventory({
            entries: [],
            context: {
                messages: [message],
                messageEntryIds: ["bash-visible"],
                thinkingLevel: "off",
                model: null,
            },
            tools: [],
        });

        const messageItem = items
            .flatMap((candidate) => candidate.children ?? [])
            .find((candidate) => candidate.id === "message:bash-visible");

        expect(messageItem?.content).toEqual({
            role: "user",
            content: [{ type: "text", text: "Ran `printf visible`\n```\nvisible\n```" }],
        });
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

        expect(turn).toMatchObject({
            id: "turn:user-1",
            source: { entryIds: ["user-1", "assistant-1", "result-1", "assistant-2"] },
        });
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
        expect(turn?.children?.map((child) => child.content)).toEqual([
            { role: "user", content: [{ type: "text", text: "Read package.json" }] },
            {
                role: "assistant",
                content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json" } }],
            },
            {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "read",
                content: [{ type: "text", text: "package contents" }],
                isError: false,
            },
            { role: "assistant", content: [{ type: "text", text: "The package is valid." }] },
        ]);
    });

    it("keeps provider-normalized summaries as durable top-level conversation items", () => {
        const oldUser = entry("user-old", null, {
            role: "user",
            content: [{ type: "text", text: "Old question" }],
        });
        const keptUser = entry("user-kept", "user-old", {
            role: "user",
            content: [{ type: "text", text: "Kept question" }],
        });
        const compaction = {
            type: "compaction",
            id: "compact-1",
            parentId: "user-kept",
            timestamp: "2026-08-01T00:01:00.000Z",
            summary: "Old summarized history",
            firstKeptEntryId: "user-kept",
            tokensBefore: 400,
        } as SessionTreeEntry;
        const branchSummary = {
            type: "branch_summary",
            id: "branch-summary-1",
            parentId: "compact-1",
            timestamp: "2026-08-01T00:02:00.000Z",
            fromId: "abandoned-assistant",
            summary: "An alternate parser was investigated.",
        } as unknown as SessionTreeEntry;
        const userAfterBranch = entry("user-after-branch", "branch-summary-1", {
            role: "user",
            content: [{ type: "text", text: "Continue" }],
        });
        const entries = [oldUser, keptUser, compaction, branchSummary, userAfterBranch];
        const agentContext = buildSessionContext(entries);
        const normalizedMessages = convertToLlm(agentContext.messages);

        const items = buildContextInventory({
            entries,
            context: { ...agentContext, messages: normalizedMessages },
            tools: [],
        });

        const normalizedCompaction = normalizedMessages[0]!;
        const normalizedBranchSummary = normalizedMessages[2]!;
        expect(items.find((candidate) => candidate.kind === "compaction_summary")).toMatchObject({
            id: "compaction:compact-1",
            content: { role: normalizedCompaction.role, content: normalizedCompaction.content },
            source: {
                entryIds: ["compact-1"],
                coveredEntryIds: ["user-old"],
            },
        });
        expect(items.find((candidate) => candidate.kind === "branch_summary")).toMatchObject({
            id: "branch-summary:branch-summary-1",
            content: { role: normalizedBranchSummary.role, content: normalizedBranchSummary.content },
            source: { entryIds: ["branch-summary-1"] },
        });
        expect(items.filter((candidate) => candidate.kind === "turn").map((candidate) => candidate.id)).toEqual([
            "turn:user-kept",
            "turn:user-after-branch",
        ]);
        expect(
            items
                .flatMap((candidate) => candidate.children ?? [])
                .some((candidate) =>
                    candidate.source.entryIds?.some((entryId) => ["compact-1", "branch-summary-1"].includes(entryId))
                )
        ).toBe(false);
    });

    it("keeps model-visible assistant reasoning blocks with their provider continuity data", () => {
        const signedThinking = {
            type: "thinking",
            thinking: "Inspect the parser state before choosing a fix.",
            thinkingSignature: "signed-reasoning",
        };
        const redactedThinking = {
            type: "thinking",
            thinking: "",
            thinkingSignature: "encrypted-redacted-reasoning",
            redacted: true,
        };
        const emptyThinking = {
            type: "thinking",
        };
        const entries = [
            entry("user-1", null, { role: "user", content: [{ type: "text", text: "Inspect this" }] }),
            entry("assistant-1", "user-1", {
                role: "assistant",
                content: [
                    { type: "text", text: "I will inspect it." },
                    signedThinking,
                    redactedThinking,
                    emptyThinking,
                ],
            }),
        ];

        const items = buildContextInventory({ entries, context: buildSessionContext(entries), tools: [] });
        const reasoning = items
            .flatMap((candidate) => candidate.children ?? [])
            .filter((candidate) => candidate.kind === "assistant_reasoning");

        expect(reasoning).toHaveLength(2);
        expect(reasoning[0]).toMatchObject({
            id: "assistant-reasoning:assistant-1:1",
            title: "Reasoning",
            preview: "Inspect the parser state before choosing a fix.",
            content: { role: "assistant", content: [signedThinking] },
            tokens: Math.ceil(JSON.stringify(signedThinking).length / 4),
            source: { entryIds: ["assistant-1"] },
        });
        expect(reasoning[1]).toMatchObject({
            id: "assistant-reasoning:assistant-1:2",
            title: "Reasoning",
            preview: "Redacted reasoning",
            content: { role: "assistant", content: [redactedThinking] },
            tokens: Math.ceil(JSON.stringify(redactedThinking).length / 4),
            source: { entryIds: ["assistant-1"] },
        });
        expect(reasoning[1]?.preview).not.toContain(redactedThinking.thinkingSignature);
    });

    it("keeps signed-only assistant reasoning without exposing its signature in the preview", () => {
        const signedOnlyThinking = {
            type: "thinking",
            thinking: "",
            thinkingSignature: '{"id":"reasoning-item-1","encrypted_content":"opaque"}',
        };
        const entries = [
            entry("user-signed", null, { role: "user", content: [{ type: "text", text: "Continue" }] }),
            entry("assistant-signed", "user-signed", {
                role: "assistant",
                content: [signedOnlyThinking],
            }),
        ];

        const items = buildContextInventory({ entries, context: buildSessionContext(entries), tools: [] });
        const reasoning = items
            .flatMap((candidate) => candidate.children ?? [])
            .find((candidate) => candidate.kind === "assistant_reasoning");

        expect(reasoning).toMatchObject({
            id: "assistant-reasoning:assistant-signed:0",
            title: "Reasoning",
            preview: "Signed reasoning",
            content: { role: "assistant", content: [signedOnlyThinking] },
            tokens: Math.ceil(JSON.stringify(signedOnlyThinking).length / 4),
            source: { entryIds: ["assistant-signed"] },
        });
        expect(reasoning?.preview).not.toContain(signedOnlyThinking.thinkingSignature);
    });

    it("replaces covered turns with a compaction summary item", () => {
        const before = [
            entry("user-old", null, { role: "user", content: [{ type: "text", text: "Old question" }] }),
            entry("assistant-old", "user-old", { role: "assistant", content: [{ type: "text", text: "Old answer" }] }),
            entry("user-kept", "assistant-old", { role: "user", content: [{ type: "text", text: "Kept question" }] }),
            entry("assistant-kept", "user-kept", {
                role: "assistant",
                content: [{ type: "text", text: "Kept answer" }],
            }),
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
            content: {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nOld summarized history\n</summary>",
                    },
                ],
            },
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
            content: {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "The following is a summary of a branch that this conversation came back from:\n\n<summary>\nThe abandoned branch investigated an alternate parser.</summary>",
                    },
                ],
            },
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
        for (const contextItem of items.filter((candidate) => candidate.category === "added_context")) {
            expect(contextItem.content).toBeUndefined();
            expect(contextItem.preview).toBe("Referenced source");
        }
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
