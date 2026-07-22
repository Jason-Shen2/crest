// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
    decodeContextArtifact,
    parseContextLifecycle,
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

    it("requires target turn IDs for once attachments", () => {
        expect(() => validateContextAttachmentData({
            schemaVersion: 1,
            transactionId: "tx-1",
            artifactEntryId: "artifact-1",
            lifecycle: "once",
            requestedRepresentation: "full",
            selectionOrder: 0,
        })).toThrow(/targetTurnId/);
    });

    it("rejects target turn IDs for pinned attachments", () => {
        expect(() => validateContextAttachmentData({
            schemaVersion: 1,
            transactionId: "tx-1",
            artifactEntryId: "artifact-1",
            lifecycle: "pinned",
            requestedRepresentation: "full",
            targetTurnId: "turn-1",
            selectionOrder: 0,
        })).toThrow(/targetTurnId/);

        expect(() => validateContextAttachmentData({
            schemaVersion: 1,
            transactionId: "tx-1",
            artifactEntryId: "artifact-1",
            lifecycle: "pinned",
            requestedRepresentation: "full",
            targetTurnId: null,
            selectionOrder: 0,
        })).toThrow(/targetTurnId/);
    });

    it("rejects arbitrary renderer enum values", () => {
        expect(() => parseContextLifecycle("later")).toThrow(/lifecycle/);
        expect(() => parseContextRepresentation("compact")).toThrow(/representation/);
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
        expect(parseContextReferenceConfig({ context_references: { max_tokens: -2 } })).toEqual({ enabled: true, maxTokens: 0 });
        expect(parseContextReferenceConfig({ context_references: { max_tokens: 200000 } })).toEqual({ enabled: true, maxTokens: 128000 });
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
});
