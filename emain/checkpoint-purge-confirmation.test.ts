// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CheckpointPurgeConfirmationRegistry } from "./checkpoint-purge-confirmation";

const Binding = {
    workspaceIdentity: "workspace-1",
    workspaceIncarnation: "incarnation-1",
    trashedSessionId: "session-1",
    trashLifecycleGeneration: "trash-generation-1",
    canonicalTrashPath: "/sessions/.trash/generation-1/session-1.db",
    canonicalDatabaseIdentity: "/sessions/.trash/session-1.db",
};

describe("CheckpointPurgeConfirmationRegistry", () => {
    it("issues opaque 32-byte single-use tokens with a five minute lifetime", () => {
        const registry = new CheckpointPurgeConfirmationRegistry();
        const token = registry.issue(Binding, 1_000);
        expect(Buffer.from(token, "base64url")).toHaveLength(32);
        expect(registry.take(token, 300_999)).toEqual(Binding);
        expect(() => registry.take(token, 300_999)).toThrow(/invalid|used/i);
    });

    it("rejects expired and foreign tokens", () => {
        const registry = new CheckpointPurgeConfirmationRegistry();
        const token = registry.issue(Binding, 1_000);
        expect(() => registry.take(token, 301_000)).toThrow(/expired/i);
        expect(() => registry.take("not-a-token", 1_001)).toThrow(/invalid/i);
    });
});
