// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createTransactionManifestData } from "@crest/agent/harness/session/entry-transaction";
import { buildSessionContext } from "@crest/agent/harness/session/session";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { decorateContextHistory } from "./history";

function sha256(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value == null || typeof value !== "object") return JSON.stringify(value);
    return `{${Object.keys(value as object)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
        .join(",")}}`;
}

function conversationEntries(
    options: {
        prefix?: string;
        targetTurnId?: string;
        parentId?: string | null;
        sourceText?: string;
    } = {}
): SessionTreeEntry[] {
    const prefix = options.prefix ?? "one";
    const targetTurnId = options.targetTurnId ?? "turn-a";
    const transactionId = `${prefix}-tx`;
    const artifactId = `${prefix}-artifact`;
    const attachId = `${prefix}-attach`;
    const manifestId = `${prefix}-manifest`;
    const messages = [{ role: "user", content: [{ type: "text", text: options.sourceText ?? "source" }] }];
    const serializedMessages = canonicalJson(messages);
    const artifact: SessionTreeEntry = {
        type: "custom",
        id: artifactId,
        parentId: options.parentId ?? null,
        timestamp: "2026-07-25T00:00:00.000Z",
        transactionId,
        customType: "context_artifact",
        data: {
            schemaVersion: 1,
            provenance: {
                sourceKind: "turn",
                sourceSessionId: "source",
                sourceSessionPath: "/sessions/source.jsonl",
                sourceCwd: "/source",
                sourceTurnId: "source-turn",
                sourceMessageEntryIds: ["source-turn"],
                preview: "source",
                capturedAt: "2026-07-25T00:00:00.000Z",
            },
            messages,
            snapshotSha256: sha256(serializedMessages),
            canonicalByteLength: Buffer.byteLength(serializedMessages, "utf8"),
        },
    };
    const attach: SessionTreeEntry = {
        type: "custom",
        id: attachId,
        parentId: artifactId,
        timestamp: "2026-07-25T00:00:00.000Z",
        transactionId,
        customType: "context_attach",
        data: {
            schemaVersion: 1,
            transactionId,
            artifactEntryId: artifactId,
            deliveryScope: "conversation",
            requestedRepresentation: "full",
            targetTurnId,
            selectionOrder: 0,
        },
    };
    const turn: SessionTreeEntry = {
        type: "message",
        id: targetTurnId,
        parentId: manifestId,
        timestamp: "2026-07-25T00:00:00.000Z",
        transactionId,
        message: { role: "user", content: [{ type: "text", text: "first" }] } as any,
    };
    const manifest: SessionTreeEntry = {
        type: "custom",
        id: manifestId,
        parentId: attachId,
        timestamp: "2026-07-25T00:00:00.000Z",
        transactionId,
        customType: "session_tx_manifest",
        data: createTransactionManifestData(transactionId, [artifact, attach, turn]),
    };
    return [artifact, attach, manifest, turn];
}

describe("decorateContextHistory", () => {
    it("adds a conversation reference only to its model-visible target user turn", async () => {
        const result = await decorateContextHistory({
            entries: conversationEntries(),
            context: {
                messages: [
                    { role: "user", timestamp: 0, content: [{ type: "text", text: "first" }] } as any,
                    { role: "user", timestamp: 0, content: [{ type: "text", text: "second" }] } as any,
                ],
                messageEntryIds: ["turn-a", "turn-b"],
                thinkingLevel: "off",
                model: null,
            },
            targetSessionPath: "/sessions/target.jsonl",
        });

        expect((result.messages[0] as any).content).toContainEqual(
            expect.objectContaining({ text: expect.stringContaining("Historical Context Reference") })
        );
        expect((result.messages[1] as any).content).toEqual([{ type: "text", text: "second" }]);
    });

    it("allows the same immutable snapshot to be referenced by different visible turns", async () => {
        const first = conversationEntries({ prefix: "first", targetTurnId: "turn-a", sourceText: "shared" });
        const second = conversationEntries({
            prefix: "second",
            targetTurnId: "turn-b",
            parentId: "turn-a",
            sourceText: "shared",
        });

        const result = await decorateContextHistory({
            entries: [...first, ...second],
            context: {
                messages: [
                    { role: "user", timestamp: 0, content: [{ type: "text", text: "first" }] } as any,
                    { role: "user", timestamp: 0, content: [{ type: "text", text: "second" }] } as any,
                ],
                messageEntryIds: ["turn-a", "turn-b"],
                thinkingLevel: "off",
                model: null,
            },
            targetSessionPath: "/sessions/target.jsonl",
        });

        expect((result.messages[0] as any).content.at(-1).text).toContain("Historical Context Reference");
        expect((result.messages[1] as any).content.at(-1).text).toContain("Historical Context Reference");
    });

    it("does not replay a conversation reference after compaction removes its target turn", async () => {
        const transaction = conversationEntries();
        const laterUser: SessionTreeEntry = {
            type: "message",
            id: "later-user",
            parentId: "turn-a",
            timestamp: "2026-07-25T00:01:00.000Z",
            message: { role: "user", timestamp: 0, content: [{ type: "text", text: "later" }] } as any,
        };
        const compaction: SessionTreeEntry = {
            type: "compaction",
            id: "compaction",
            parentId: "later-user",
            timestamp: "2026-07-25T00:02:00.000Z",
            summary: "earlier context",
            firstKeptEntryId: "later-user",
            tokensBefore: 100,
        };
        const entries = [...transaction, laterUser, compaction];
        const context = buildSessionContext(entries);

        const result = await decorateContextHistory({
            entries,
            context,
            targetSessionPath: "/sessions/target.jsonl",
        });

        expect(JSON.stringify(result.messages)).not.toContain("Historical Context Reference");
    });

    it("serializes historical blocks canonically", async () => {
        const result = await decorateContextHistory({
            entries: conversationEntries(),
            context: {
                messages: [{ role: "user", timestamp: 0, content: [{ type: "text", text: "first" }] } as any],
                messageEntryIds: ["turn-a"],
                thinkingLevel: "off",
                model: null,
            },
            targetSessionPath: "/sessions/target.jsonl",
        });
        const text = (result.messages[0] as any).content.at(-1).text as string;

        expect(text.indexOf('"messages"')).toBeLessThan(text.indexOf('"provenance"'));
        expect(text.indexOf('"provenance"')).toBeLessThan(text.indexOf('"representation"'));
    });
});
