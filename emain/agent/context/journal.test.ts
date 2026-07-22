// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createTransactionManifestData } from "../harness/session/entry-transaction";
import type { SessionTreeEntry } from "../harness/types";
import { ContextCustomTypes, foldContextJournal, isContextCustomEntry } from "./journal";

const Hash = "a".repeat(64);

function custom(id: string, customType: string, data: unknown, transactionId?: string, parentId: string | null = null): SessionTreeEntry {
    return {
        type: "custom",
        id,
        parentId,
        timestamp: `t-${id}`,
        customType,
        data,
        ...(transactionId == null ? {} : { transactionId }),
    } as unknown as SessionTreeEntry;
}

function user(id = "turn", transactionId = "tx", parentId = "manifest"): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
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
    const orderedMembers = members.map((member, index) => ({
        ...member,
        parentId: index === members.length - 1 ? "manifest" : index === 0 ? member.parentId : members[index - 1]!.id,
    })) as SessionTreeEntry[];
    const manifestParentId = orderedMembers.at(-2)?.id ?? null;
    return [
        ...orderedMembers.slice(0, -1),
        custom("manifest", ContextCustomTypes.transactionManifest, createTransactionManifestData(transactionId, orderedMembers), transactionId, manifestParentId),
        orderedMembers.at(-1)!,
    ];
}

function projection(transactionId = "tx", targetTurnId = "turn") {
    return {
        schemaVersion: 1,
        transactionId,
        targetTurnId,
        createdAt: "2026-07-22T00:00:00.000Z",
        contextWindow: 100,
        effectiveOutputReserve: 10,
        inputLimit: 90,
        baseInputTokens: 20,
        finalInputTokens: 30,
        referenceTokens: 10,
        countAccuracy: "exact",
        overlaySha256: Hash,
        items: [],
    };
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
        const state = foldContextJournal([...validButMissingArtifact, ...committed([invalid, unknownTurn], "unknown-tx")], "turn");

        expect(state.activeAttachments).toMatchObject([{ attachmentEntryId: "attach", artifact: undefined }]);
        expect(state.diagnostics).toHaveLength(2);
        expect(foldContextJournal([once, turn]).diagnostics).not.toEqual([]);
    });

    it("retains a missing pinned artifact through updates until a later detach", () => {
        const attachEntry = custom("attach", ContextCustomTypes.attach, attach("pinned"), "tx");
        const initial = committed([attachEntry, user()]);
        const update = custom("update", ContextCustomTypes.update, { schemaVersion: 1, attachmentEntryId: "attach", requestedRepresentation: "metadata" });
        const detached = custom("detach", ContextCustomTypes.detach, { schemaVersion: 1, attachmentEntryId: "attach" });

        expect(foldContextJournal([...initial, update]).activeAttachments).toMatchObject([
            { attachmentEntryId: "attach", artifact: undefined, data: { requestedRepresentation: "metadata" } },
        ]);
        expect(foldContextJournal([...initial, update, detached]).activeAttachments).toEqual([]);
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

    it("requires once targets to bind to the manifest user", () => {
        const artifactEntry = custom("artifact", ContextCustomTypes.artifact, artifact(), "tx");
        const attachEntry = custom("attach", ContextCustomTypes.attach, attach("once", "other-turn"), "tx");
        const state = foldContextJournal(committed([artifactEntry, attachEntry, user()]), "turn");

        expect(state.activeAttachments).toEqual([]);
        expect(state.diagnostics).toMatchObject([{ entryId: "attach", message: expect.stringMatching(/targetTurnId/) }]);
    });

    it("folds only projection reports bound to their committed transaction and user", () => {
        const report = custom("projection", ContextCustomTypes.projection, projection(), "tx");
        const valid = foldContextJournal(committed([report, user()]));
        const badReport = custom("bad-projection", ContextCustomTypes.projection, projection("other-tx"), "bad-tx");
        const bad = foldContextJournal(committed([badReport, user("bad-turn", "bad-tx")], "bad-tx"));

        expect(valid.projectionReports).toMatchObject([{ transactionId: "tx", targetTurnId: "turn" }]);
        expect(bad.projectionReports).toEqual([]);
        expect(bad.diagnostics).toMatchObject([{ entryId: "bad-projection", message: expect.stringMatching(/transactionId/) }]);
    });

    it("reports invalid projection payloads without making the journal unreadable", () => {
        const invalidReport = custom("projection", ContextCustomTypes.projection, { ...projection(), overlaySha256: "bad" }, "tx");
        const state = foldContextJournal(committed([invalidReport, user()]));

        expect(state.projectionReports).toEqual([]);
        expect(state.diagnostics).toMatchObject([{ entryId: "projection", message: expect.stringMatching(/overlaySha256/) }]);
    });

    it("folds only the caller-selected active path, excluding abandoned records", () => {
        const activeArtifact = custom("active-artifact", ContextCustomTypes.artifact, artifact(), "active");
        const activeAttach = custom("active-attach", ContextCustomTypes.attach, { ...attach("pinned"), transactionId: "active", artifactEntryId: "active-artifact" }, "active");
        const activePath = committed([activeArtifact, activeAttach, user("active-user", "active")], "active");
        const abandonedArtifact = custom("abandoned-artifact", ContextCustomTypes.artifact, artifact(), "abandoned");
        const abandonedAttach = custom("abandoned-attach", ContextCustomTypes.attach, { ...attach("pinned"), transactionId: "abandoned", artifactEntryId: "abandoned-artifact" }, "abandoned");
        const abandonedPath = committed([abandonedArtifact, abandonedAttach, user("abandoned-user", "abandoned")], "abandoned");
        const fullTree = [...activePath, ...abandonedPath];
        const selectedActivePath = fullTree.filter((entry) => (entry as { transactionId?: string }).transactionId === "active");

        expect(foldContextJournal(selectedActivePath).activeAttachments.map((attachment) => attachment.attachmentEntryId)).toEqual(["active-attach"]);
        expect(foldContextJournal(abandonedPath).activeAttachments.map((attachment) => attachment.attachmentEntryId)).toEqual(["abandoned-attach"]);
    });
});
