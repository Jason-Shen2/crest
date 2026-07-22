// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createTransactionManifestData } from "../harness/session/entry-transaction";
import type { SessionTreeEntry } from "../harness/types";
import { ContextCustomTypes, foldContextJournal, isContextCustomEntry } from "./journal";

const Hash = "a".repeat(64);

function custom(id: string, customType: string, data: unknown, transactionId?: string): SessionTreeEntry {
    return {
        type: "custom",
        id,
        parentId: null,
        timestamp: `t-${id}`,
        customType,
        data,
        ...(transactionId == null ? {} : { transactionId }),
    } as unknown as SessionTreeEntry;
}

function user(id = "turn", transactionId = "tx"): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId: "manifest",
        timestamp: `t-${id}`,
        message: { role: "user", content: [{ type: "text", text: "ask" }] },
        transactionId,
    } as unknown as SessionTreeEntry;
}

function artifact() {
    return {
        schemaVersion: 1,
        provenance: {
            sourceKind: "turn",
            sourceSessionId: "source",
            sourceSessionPath: "/source",
            sourceCwd: "/cwd",
            sourceTurnId: "source-turn",
            sourceLeafId: "source-leaf",
            sourceMessageEntryIds: ["source-message"],
            preview: "source",
            capturedAt: "2026-07-22T00:00:00.000Z",
        },
        messages: [{ role: "user", content: [{ type: "text", text: "source" }] }],
        snapshotSha256: Hash,
        canonicalByteLength: 6,
    };
}

function attach(lifecycle: "once" | "pinned", targetTurnId?: string) {
    return {
        schemaVersion: 1,
        transactionId: "tx",
        artifactEntryId: "artifact",
        lifecycle,
        requestedRepresentation: "full",
        selectionOrder: 0,
        ...(targetTurnId == null ? {} : { targetTurnId }),
    };
}

function committed(members: SessionTreeEntry[], transactionId = "tx"): SessionTreeEntry[] {
    return [...members.slice(0, -1), custom("manifest", ContextCustomTypes.transactionManifest, createTransactionManifestData(transactionId, members), transactionId), members.at(-1)!];
}

describe("context journal", () => {
    it("recognizes only context custom entries", () => {
        expect(isContextCustomEntry(custom("artifact", ContextCustomTypes.artifact, artifact()))).toBe(true);
        expect(isContextCustomEntry(custom("other", "other", {}))).toBe(false);
        expect(isContextCustomEntry(user())).toBe(false);
    });

    it("activates a complete once attachment only for its exact target turn", () => {
        const artifactEntry = custom("artifact", ContextCustomTypes.artifact, artifact(), "tx");
        const attachEntry = custom("attach", ContextCustomTypes.attach, attach("once", "turn"), "tx");
        const turn = user();
        const entries = committed([artifactEntry, attachEntry, turn]);

        expect(foldContextJournal(entries, "turn").activeAttachments.map((item) => item.attachmentEntryId)).toEqual(["attach"]);
        expect(foldContextJournal(entries, "other").activeAttachments).toEqual([]);
    });

    it("folds pinned update and detach in journal order while retaining the latest summary", () => {
        const artifactEntry = custom("artifact", ContextCustomTypes.artifact, artifact(), "tx");
        const attachEntry = custom("attach", ContextCustomTypes.attach, attach("pinned"), "tx");
        const turn = user();
        const initial = committed([artifactEntry, attachEntry, turn]);
        const summary = { text: "summary", summarySha256: Hash, modelKey: "m", promptVersion: "v", generatedAt: "2026-07-22T00:00:00.000Z" };
        const update = custom("update", ContextCustomTypes.update, { schemaVersion: 1, attachmentEntryId: "attach", requestedRepresentation: "summary", summary });
        const full = custom("full", ContextCustomTypes.update, { schemaVersion: 1, attachmentEntryId: "attach", requestedRepresentation: "full" });
        const detached = custom("detach", ContextCustomTypes.detach, { schemaVersion: 1, attachmentEntryId: "attach" });

        const updated = foldContextJournal([...initial, update, full]);
        expect(updated.activeAttachments[0]).toMatchObject({ data: { requestedRepresentation: "full" }, summary });
        expect(foldContextJournal([...initial, update, full, detached]).activeAttachments).toEqual([]);
    });

    it("reports invalid lifecycle records, unknown schemas, missing artifacts, and bad commits without throwing", () => {
        const once = custom("attach", ContextCustomTypes.attach, attach("once", "turn"), "tx");
        const turn = user();
        const validButMissingArtifact = committed([once, turn]);
        const invalid = custom("unknown", ContextCustomTypes.artifact, { schemaVersion: 2 }, "unknown-tx");
        const unknownTurn = user("unknown-turn", "unknown-tx");
        const state = foldContextJournal([...validButMissingArtifact, ...committed([invalid, unknownTurn], "unknown-tx")]);

        expect(state.activeAttachments).toEqual([]);
        expect(state.diagnostics).toHaveLength(2);
        expect(foldContextJournal([once, turn]).diagnostics).not.toEqual([]);
    });

    it("rejects an attachment whose data transaction ID differs from its committed entry", () => {
        const artifactEntry = custom("artifact", ContextCustomTypes.artifact, artifact(), "tx");
        const attachEntry = custom("attach", ContextCustomTypes.attach, { ...attach("pinned"), transactionId: "other-tx" }, "tx");
        const state = foldContextJournal(committed([artifactEntry, attachEntry, user()]));

        expect(state.activeAttachments).toEqual([]);
        expect(state.diagnostics[0]).toMatchObject({ entryId: "attach", message: expect.stringMatching(/transactionId/) });
    });

    it("ignores update and detach events for once attachments", () => {
        const artifactEntry = custom("artifact", ContextCustomTypes.artifact, artifact(), "tx");
        const attachEntry = custom("attach", ContextCustomTypes.attach, attach("once", "turn"), "tx");
        const turn = user();
        const update = custom("update", ContextCustomTypes.update, { schemaVersion: 1, attachmentEntryId: "attach", requestedRepresentation: "metadata" });
        const detached = custom("detach", ContextCustomTypes.detach, { schemaVersion: 1, attachmentEntryId: "attach" });
        const state = foldContextJournal([...committed([artifactEntry, attachEntry, turn]), update, detached], "turn");

        expect(state.activeAttachments).toHaveLength(1);
        expect(state.diagnostics).toHaveLength(2);
    });
});
