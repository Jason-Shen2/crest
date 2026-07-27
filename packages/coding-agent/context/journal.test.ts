// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createTransactionManifestData } from "@crest/agent/harness/session/entry-transaction";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { ContextCustomTypes, foldContextJournal, isContextCustomEntry } from "./journal";

const Hash = "a".repeat(64);

function custom(
    id: string,
    customType: string,
    data: unknown,
    transactionId?: string,
    parentId: string | null = null
): SessionTreeEntry {
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

function attach(deliveryScope: "message" | "conversation", targetTurnId: string, artifactEntryId = "artifact") {
    return {
        schemaVersion: 1,
        transactionId: "tx",
        artifactEntryId,
        deliveryScope,
        requestedRepresentation: "full",
        targetTurnId,
        selectionOrder: 0,
    };
}

function committed(members: SessionTreeEntry[], transactionId = "tx", manifestId = "manifest"): SessionTreeEntry[] {
    const orderedMembers = members.map((member, index) => ({
        ...member,
        parentId: index === members.length - 1 ? manifestId : index === 0 ? member.parentId : members[index - 1]!.id,
    })) as SessionTreeEntry[];
    const manifestParentId = orderedMembers.at(-2)?.id ?? null;
    return [
        ...orderedMembers.slice(0, -1),
        custom(
            manifestId,
            ContextCustomTypes.transactionManifest,
            createTransactionManifestData(transactionId, orderedMembers),
            transactionId,
            manifestParentId
        ),
        orderedMembers.at(-1)!,
    ];
}

describe("context journal", () => {
    it("recognizes only supported immutable context custom entries", () => {
        expect(isContextCustomEntry(custom("artifact", ContextCustomTypes.artifact, artifact()))).toBe(true);
        expect(isContextCustomEntry(custom("update", "context_update", {}))).toBe(false);
        expect(isContextCustomEntry(user())).toBe(false);
    });

    it("indexes message and conversation attachments by their target turn", () => {
        const entries = committed([
            custom("artifact", ContextCustomTypes.artifact, artifact(), "tx"),
            custom("message", ContextCustomTypes.attach, attach("message", "turn"), "tx"),
            custom("conversation", ContextCustomTypes.attach, attach("conversation", "turn"), "tx"),
            user("turn"),
        ]);
        const state = foldContextJournal(entries);

        expect(state.attachmentsForTurn("turn").map((item) => item.data.deliveryScope)).toEqual([
            "message",
            "conversation",
        ]);
        expect(state.conversationAttachmentsForTurns(["turn"]).map((item) => item.attachmentEntryId)).toEqual([
            "conversation",
        ]);
        expect(state.conversationAttachmentsForTurns(["other"])).toEqual([]);
    });

    it("records obsolete pin events as diagnostics without mutable state", () => {
        const entries = committed([
            custom("artifact", ContextCustomTypes.artifact, artifact(), "tx"),
            custom("attach", ContextCustomTypes.attach, attach("conversation", "turn"), "tx"),
            user("turn"),
        ]);
        const state = foldContextJournal([
            ...entries,
            custom("update", "context_update", { schemaVersion: 1, attachmentEntryId: "attach" }),
            custom("detach", "context_detach", { schemaVersion: 1, attachmentEntryId: "attach" }),
        ]);

        expect(state.attachmentsForTurn("turn")).toHaveLength(1);
        expect(state.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ entryId: "update", message: expect.stringMatching(/obsolete/) }),
                expect.objectContaining({ entryId: "detach", message: expect.stringMatching(/obsolete/) }),
            ])
        );
    });

    it("rejects attachments whose target turn differs from the committed transaction user", () => {
        const state = foldContextJournal(
            committed([
                custom("artifact", ContextCustomTypes.artifact, artifact(), "tx"),
                custom("attach", ContextCustomTypes.attach, attach("message", "other"), "tx"),
                user("turn"),
            ])
        );

        expect(state.attachmentsForTurn("turn")).toEqual([]);
        expect(state.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ entryId: "attach", message: expect.stringMatching(/targetTurnId/) }),
            ])
        );
    });
});
