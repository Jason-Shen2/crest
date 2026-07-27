// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { UserMessage } from "@crest/ai";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { ContextDraftRegistry } from "./draft-registry";
import { createContextTurnPreparation, type ContextTurnPreparationInput } from "./turn-preparer";
import type { ContextArtifact, ContextArtifactDraft } from "./types";

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (typeof value !== "object" || value == null) return value;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
        const child = (value as Record<string, unknown>)[key];
        if (child !== undefined) result[key] = canonicalize(child);
    }
    return result;
}

function artifact(text = "referenced source"): ContextArtifact {
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text }] }];
    const canonical = JSON.stringify(canonicalize(messages));
    return {
        schemaVersion: 1,
        provenance: {
            sourceKind: "turn",
            sourceSessionId: "source-session",
            sourceSessionPath: "/sessions/source.jsonl",
            sourceCwd: "/source",
            sourceTurnId: "source-turn",
            sourceLeafId: "source-leaf",
            sourceMessageEntryIds: ["source-message"],
            preview: text,
            capturedAt: "2026-07-25T00:00:00.000Z",
        },
        messages,
        snapshotSha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
        canonicalByteLength: Buffer.byteLength(canonical, "utf8"),
    };
}

function setup(deliveryScope: "message" | "conversation", requestedRepresentation: "full" | "summary" = "full") {
    const appended: SessionTreeEntry[][] = [];
    const registry = new ContextDraftRegistry({ idFactory: () => "draft" });
    const draft: ContextArtifactDraft = { artifact: artifact() };
    if (requestedRepresentation === "summary") {
        const text = "ready summary";
        draft.artifact.summary = {
            text,
            summarySha256: createHash("sha256").update(text, "utf8").digest("hex"),
            modelKey: "summary-model",
            promptVersion: "context-summary-v1",
            generatedAt: "2026-07-25T00:00:00.000Z",
        };
    }
    registry.create("/sessions/target.jsonl", draft);
    const ids = ["transaction", "target-user", "artifact", "attachment", "projection", "manifest"];
    const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: "current request" }],
        timestamp: 0,
    };
    const input: ContextTurnPreparationInput = {
        session: {
            getBranch: vi.fn(async () => []),
            appendEntries: vi.fn(async (entries) => {
                appended.push(structuredClone(entries));
            }),
        },
        draftRegistry: registry,
        targetSessionPath: "/sessions/target.jsonl",
        userMessage,
        attachments: [{ draftId: "draft", deliveryScope, requestedRepresentation }],
        provider: "provider",
        modelKey: "model",
        request: {
            systemPrompt: "system",
            tools: [],
            history: [],
            currentUserContent: userMessage.content,
        },
        idFactory: () => ids.shift()!,
        now: () => new Date("2026-07-25T00:00:00.000Z"),
    };
    return { input, appended, registry };
}

describe("createContextTurnPreparation", () => {
    it("commits message-scoped references to the target turn and returns an overlay", async () => {
        const { input, appended } = setup("message");

        const result = await createContextTurnPreparation(input)();

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const attachment = appended[0]!.find(
            (entry) => entry.type === "custom" && entry.customType === "context_attach"
        ) as Extract<SessionTreeEntry, { type: "custom" }>;
        expect(attachment.data).toMatchObject({
            deliveryScope: "message",
            targetTurnId: "target-user",
            requestedRepresentation: "full",
        });
        expect(result.systemPromptSuffix).toContain("Context Overlay");
        expect(result.transformedContextMessages).toBeUndefined();
    });

    it("injects a conversation-scoped reference into the current user message", async () => {
        const { input, appended } = setup("conversation");

        const result = await createContextTurnPreparation(input)();

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const attachment = appended[0]!.find(
            (entry) => entry.type === "custom" && entry.customType === "context_attach"
        ) as Extract<SessionTreeEntry, { type: "custom" }>;
        expect(attachment.data).toMatchObject({
            deliveryScope: "conversation",
            targetTurnId: "target-user",
        });
        expect(result.systemPromptSuffix).toBe("");
        expect(JSON.stringify(result.transformedContextMessages)).toContain("Historical Context Reference");
        expect(JSON.stringify(result.transformedContextMessages)).toContain("referenced source");
    });

    it("commits a ready Summary representation without changing it later", async () => {
        const { input, appended } = setup("conversation", "summary");

        const result = await createContextTurnPreparation(input)();

        expect(result.ok).toBe(true);
        const storedArtifact = appended[0]!.find(
            (entry) => entry.type === "custom" && entry.customType === "context_artifact"
        ) as Extract<SessionTreeEntry, { type: "custom" }>;
        expect(storedArtifact.data).toMatchObject({ summary: { text: "ready summary" } });
        expect(JSON.stringify(result.ok ? result.transformedContextMessages : [])).toContain("ready summary");
        expect(JSON.stringify(result.ok ? result.transformedContextMessages : [])).not.toContain('"messages"');
    });

    it("does not append anything when a selected Summary is not ready", async () => {
        const { input, appended, registry } = setup("message");
        input.attachments[0]!.requestedRepresentation = "summary";

        const result = await createContextTurnPreparation(input)();

        expect(result).toMatchObject({ ok: false, error: { code: "summary_not_ready" } });
        expect(appended).toEqual([]);
        expect(registry.peek("/sessions/target.jsonl", "draft")).toBeDefined();
    });
});
