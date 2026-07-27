// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ContextReferenceError } from "./types";
import {
    decodeContextArtifact,
    decodeContextAttachmentData,
    decodeContextProjectionReport,
    parseContextDeliveryScope,
    parseContextReferenceConfig,
    parseContextRepresentation,
    validateContextArtifact,
    validateContextAttachmentData,
} from "./validation";

function validArtifact() {
    return {
        schemaVersion: 1,
        provenance: {
            sourceKind: "turn",
            sourceSessionId: "source-session",
            sourceSessionPath: "/tmp/source.jsonl",
            sourceCwd: "/tmp",
            sourceTurnId: "turn-1",
            sourceLeafId: "leaf-1",
            sourceMessageEntryIds: ["message-1"],
            preview: "A preview",
            capturedAt: "2026-07-21T00:00:00.000Z",
        },
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        snapshotSha256: "a".repeat(64),
        canonicalByteLength: 5,
    };
}

describe("context validation", () => {
    it("requires a source turn ID and source message IDs for turn artifacts", () => {
        const withoutTurn = validArtifact();
        delete withoutTurn.provenance.sourceTurnId;
        const withoutMessageIds = validArtifact();
        withoutMessageIds.provenance.sourceMessageEntryIds = [];

        expect(() => validateContextArtifact(withoutTurn)).toThrow(/sourceTurnId/);
        expect(() => validateContextArtifact(withoutMessageIds)).toThrow(/sourceMessageEntryIds/);
    });

    it("allows session artifacts without a source turn only when a leaf is recorded", () => {
        const artifact = validArtifact();
        artifact.provenance.sourceKind = "session";
        delete artifact.provenance.sourceTurnId;

        expect(validateContextArtifact(artifact).provenance.sourceLeafId).toBe("leaf-1");

        artifact.provenance.sourceLeafId = null;
        expect(() => validateContextArtifact(artifact)).toThrow(/sourceLeafId/);
    });

    it("requires target turn IDs for every immutable attachment", () => {
        expect(() =>
            validateContextAttachmentData({
                schemaVersion: 1,
                transactionId: "tx-1",
                artifactEntryId: "artifact-1",
                deliveryScope: "message",
                requestedRepresentation: "full",
                selectionOrder: 0,
            })
        ).toThrow(/targetTurnId/);
        expect(() =>
            validateContextAttachmentData({
                schemaVersion: 1,
                transactionId: "tx-1",
                artifactEntryId: "artifact-1",
                deliveryScope: "conversation",
                requestedRepresentation: "full",
                selectionOrder: 0,
            })
        ).toThrow(/targetTurnId/);
    });

    it("normalizes message and conversation attachments with a target turn", () => {
        const attachment = validateContextAttachmentData({
            schemaVersion: 1,
            transactionId: "tx-1",
            artifactEntryId: "artifact-1",
            deliveryScope: "conversation",
            requestedRepresentation: "full",
            targetTurnId: "turn-1",
            selectionOrder: 0,
        });

        expect(attachment).toMatchObject({ deliveryScope: "conversation", targetTurnId: "turn-1" });
        expect(validateContextAttachmentData(attachment)).toEqual(attachment);
    });

    it("accepts only message or conversation scope and Full or Summary", () => {
        expect(parseContextDeliveryScope("message")).toBe("message");
        expect(parseContextDeliveryScope("conversation")).toBe("conversation");
        expect(() => parseContextDeliveryScope("pinned")).toThrow(/delivery scope/);
        expect(() => parseContextRepresentation("metadata")).toThrow(/representation/);
        expect(() => parseContextRepresentation("compact")).toThrow(/representation/);
    });

    it("uses ContextReferenceError invalid_input codes for invalid IPC input", () => {
        let thrown: unknown;
        try {
            parseContextDeliveryScope("later");
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(ContextReferenceError);
        expect((thrown as ContextReferenceError).code).toBe("invalid_input");

        const cause = new Error("underlying failure");
        expect(new ContextReferenceError("invalid_input", "invalid input", cause).cause).toBe(cause);
    });

    it("requires lowercase SHA-256 artifact hashes", () => {
        const artifact = validArtifact();
        artifact.snapshotSha256 = "A".repeat(64);

        expect(() => validateContextArtifact(artifact)).toThrow(/snapshotSha256/);
    });

    it("defaults only enabled when valid config omits context_references", () => {
        expect(parseContextReferenceConfig({})).toEqual({ enabled: true });
    });

    it("keeps max tokens optional and clamps it when present", () => {
        expect(parseContextReferenceConfig({ context_references: {} })).toEqual({ enabled: true });
        expect(parseContextReferenceConfig({ context_references: { max_tokens: -2 } })).toEqual({
            enabled: true,
            maxTokens: 0,
        });
        expect(parseContextReferenceConfig({ context_references: { max_tokens: 200000 } })).toEqual({
            enabled: true,
            maxTokens: 128000,
        });
    });

    it("rejects explicit null context reference configuration fields", () => {
        expect(() => parseContextReferenceConfig({ context_references: null })).toThrow(/context_references/);
        expect(() => parseContextReferenceConfig({ context_references: { enabled: null } })).toThrow(/enabled/);
        expect(() => parseContextReferenceConfig({ context_references: { max_tokens: null } })).toThrow(/max_tokens/);
    });

    it("returns an unknown artifact schema diagnostic without throwing", () => {
        expect(decodeContextArtifact({ ...validArtifact(), schemaVersion: 2 })).toEqual({
            diagnostic: expect.stringMatching(/schemaVersion/),
        });
    });

    it("returns an unknown attachment schema diagnostic without throwing", () => {
        expect(decodeContextAttachmentData({ schemaVersion: 2 })).toEqual({
            diagnostic: expect.stringMatching(/schemaVersion/),
        });
    });

    it("returns diagnostics for invalid projection counts and overlay hashes without throwing", () => {
        const projection = {
            schemaVersion: 1,
            transactionId: "tx",
            targetTurnId: "turn",
            createdAt: "2026-07-22T00:00:00.000Z",
            contextWindow: 10,
            effectiveOutputReserve: 1,
            inputLimit: 9,
            baseInputTokens: 2,
            finalInputTokens: 3,
            referenceTokens: 1,
            countAccuracy: "exact",
            overlaySha256: "a".repeat(64),
            items: [
                {
                    attachmentEntryId: "attachment",
                    deliveryScope: "message",
                    renderedRepresentation: "full",
                    advisoryTokens: 1,
                    reason: "selected",
                },
            ],
        };

        expect(decodeContextProjectionReport({ ...projection, contextWindow: -1 })).toHaveProperty("diagnostic");
        expect(decodeContextProjectionReport({ ...projection, referenceTokens: Number.NaN })).toHaveProperty(
            "diagnostic"
        );
        expect(decodeContextProjectionReport({ ...projection, overlaySha256: "bad" })).toHaveProperty("diagnostic");
        expect(
            decodeContextProjectionReport({ ...projection, items: [{ ...projection.items[0], advisoryTokens: -1 }] })
        ).toHaveProperty("diagnostic");
    });
});
