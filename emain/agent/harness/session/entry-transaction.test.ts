// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
    canonicalJson,
    createTransactionManifestData,
    filterCommittedTransactionEntries,
    getTransactionForkBoundary,
    SessionEntryTransactionError,
} from "./entry-transaction";
import type { SessionTreeEntry } from "../types";

function entry(id: string, parentId: string | null, transactionId?: string): SessionTreeEntry {
    return {
        type: "custom",
        id,
        parentId,
        timestamp: `t-${id}`,
        customType: "record",
        data: { id },
        ...(transactionId == null ? {} : { transactionId }),
    } as unknown as SessionTreeEntry;
}

function user(id: string, parentId: string, transactionId: string): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: `t-${id}`,
        message: { role: "user", content: [{ type: "text", text: id }] },
        transactionId,
    } as unknown as SessionTreeEntry;
}

function manifest(id: string, parentId: string | null, transactionId: string, members: SessionTreeEntry[]): SessionTreeEntry {
    return {
        type: "custom",
        id,
        parentId,
        timestamp: `t-${id}`,
        customType: "session_tx_manifest",
        data: createTransactionManifestData(transactionId, members),
        transactionId,
    } as SessionTreeEntry;
}

describe("entry transactions", () => {
    it("canonicalizes recursively without changing special JSON keys", () => {
        const value = JSON.parse('{"z":{"b":1,"a":2},"__proto__":{"x":true},"constructor":"safe"}');
        expect(canonicalJson(value)).toBe(
            '{"__proto__":{"x":true},"constructor":"safe","z":{"a":2,"b":1}}'
        );
    });

    it("rejects getters, cycles, and non-JSON values without executing input methods", () => {
        let getterCalled = false;
        const withGetter = {};
        Object.defineProperty(withGetter, "value", {
            enumerable: true,
            get() {
                getterCalled = true;
                return "unsafe";
            },
        });
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;

        expect(() => canonicalJson(withGetter)).toThrow(SessionEntryTransactionError);
        expect(getterCalled).toBe(false);
        expect(() => canonicalJson(cycle)).toThrow(/cycles/);
        expect(() => canonicalJson({ value: undefined })).toThrow(/not JSON/);
    });

    it("only exposes a complete ordered manifest group", () => {
        const artifact = entry("artifact", null, "tx");
        const attached = entry("attach", "artifact", "tx");
        const turn = user("user", "manifest", "tx");
        const commit = manifest("manifest", "attach", "tx", [artifact, attached, turn]);

        const result = filterCommittedTransactionEntries([entry("ordinary", null), artifact, attached, commit, turn]);

        expect(result.entries.map((item) => item.id)).toEqual(["ordinary", "artifact", "attach", "manifest", "user"]);
        expect(result.diagnostics).toEqual([]);
    });

    it("commits a single user member after its manifest and resolves both fork boundaries", () => {
        const root = entry("root", null);
        const turn = user("user", "manifest", "tx");
        const commit = manifest("manifest", "root", "tx", [turn]);
        const entries = [root, commit, turn];

        expect(createTransactionManifestData("tx", [turn]).orderedMemberEntryIds).toEqual(["user"]);
        expect(filterCommittedTransactionEntries(entries).entries.map((item) => item.id)).toEqual(["root", "manifest", "user"]);
        expect(getTransactionForkBoundary(entries, "user", "before")).toBe("root");
        expect(getTransactionForkBoundary(entries, "user", "at")).toBe("user");
    });

    it("hides malformed groups without hiding interleaved ordinary entries", () => {
        const artifact = entry("artifact", null, "tx");
        const turn = user("user", "manifest", "tx");
        const commit = manifest("manifest", "artifact", "tx", [artifact, turn]);
        const extra = entry("extra", "manifest", "tx");

        const result = filterCommittedTransactionEntries([artifact, entry("ordinary", null), commit, turn, extra]);

        expect(result.entries.map((item) => item.id)).toEqual(["ordinary"]);
        expect(result.diagnostics).toHaveLength(1);
    });

    it("accepts a valid transaction around interleaved non-transaction entries", () => {
        const artifact = entry("artifact", "root", "tx");
        const attached = entry("attach", "artifact", "tx");
        const turn = user("user", "manifest", "tx");
        const commit = manifest("manifest", "attach", "tx", [artifact, attached, turn]);

        expect(filterCommittedTransactionEntries([artifact, entry("ordinary-1", null), attached, commit, entry("ordinary-2", null), turn]).entries.map((item) => item.id)).toEqual([
            "artifact", "ordinary-1", "attach", "manifest", "ordinary-2", "user",
        ]);
    });

    it("hides every duplicate ID, including collisions between ordinary and transaction entries", () => {
        const ordinary = entry("shared", null);
        const artifact = entry("shared", "root", "tx");
        const turn = user("user", "manifest", "tx");
        const commit = manifest("manifest", "shared", "tx", [artifact, turn]);

        const result = filterCommittedTransactionEntries([ordinary, artifact, commit, turn]);

        expect(result.entries).toEqual([]);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]!.message).toMatch(/shared/);
    });

    it("invalidates both transaction groups and ordinary entries that share a global ID", () => {
        const firstArtifact = entry("shared", "root-a", "tx-a");
        const firstUser = user("user-a", "manifest-a", "tx-a");
        const firstManifest = manifest("manifest-a", "shared", "tx-a", [firstArtifact, firstUser]);
        const secondArtifact = entry("shared", "root-b", "tx-b");
        const secondUser = user("user-b", "manifest-b", "tx-b");
        const secondManifest = manifest("manifest-b", "shared", "tx-b", [secondArtifact, secondUser]);
        const normalFirst = entry("normal", null);
        const normalSecond = entry("normal", null);

        const result = filterCommittedTransactionEntries([
            firstArtifact, firstManifest, firstUser,
            secondArtifact, secondManifest, secondUser,
            normalFirst, normalSecond,
        ]);

        expect(result.entries).toEqual([]);
        expect(result.diagnostics).toHaveLength(2);
        expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(expect.arrayContaining([
            expect.stringMatching(/shared/),
            expect.stringMatching(/normal/),
        ]));
    });

    it("hides normal-only duplicate entries without exposing an ambiguous record", () => {
        const result = filterCommittedTransactionEntries([entry("duplicate", null), entry("duplicate", null)]);

        expect(result.entries).toEqual([]);
        expect(result.diagnostics).toEqual([{ message: "duplicate session entry ID duplicate" }]);
    });

    it("rejects multiple manifests, missing members, non-final users, bad order, and bad digests", () => {
        const artifact = entry("artifact", null, "tx");
        const turn = user("user", "manifest", "tx");
        const commit = manifest("manifest", "artifact", "tx", [artifact, turn]);
        const variants: SessionTreeEntry[][] = [
            [artifact, commit, manifest("manifest-2", "manifest", "tx", [artifact, turn]), turn],
            [artifact, commit],
            [artifact, turn, commit],
            [artifact, { ...commit, data: { ...((commit as Extract<SessionTreeEntry, { type: "custom" }>).data as object), orderedMemberEntryIds: [turn.id, artifact.id] } } as SessionTreeEntry, turn],
            [artifact, { ...commit, data: { ...((commit as Extract<SessionTreeEntry, { type: "custom" }>).data as object), membersSha256: "0".repeat(64) } } as SessionTreeEntry, turn],
        ];

        for (const entries of variants) {
            expect(filterCommittedTransactionEntries(entries).entries).toEqual([]);
        }
    });

    it("hides missing manifests, mismatched manifest users, and broken transaction ancestry", () => {
        const artifact = entry("artifact", "root", "tx");
        const attached = entry("attach", "artifact", "tx");
        const turn = user("user", "manifest", "tx");
        const commit = manifest("manifest", "attach", "tx", [artifact, attached, turn]);
        const mismatchedUser = {
            ...commit,
            data: { ...((commit as Extract<SessionTreeEntry, { type: "custom" }>).data as object), userEntryId: "other-user" },
        } as SessionTreeEntry;
        const brokenAncestry = { ...attached, parentId: "root" } as SessionTreeEntry;
        const brokenAncestryCommit = manifest("manifest", "attach", "tx", [artifact, brokenAncestry, turn]);

        expect(filterCommittedTransactionEntries([artifact, attached, turn]).entries).toEqual([]);
        expect(filterCommittedTransactionEntries([artifact, attached, mismatchedUser, turn]).entries).toEqual([]);
        expect(filterCommittedTransactionEntries([artifact, brokenAncestry, brokenAncestryCommit, turn]).entries).toEqual([]);
        expect(getTransactionForkBoundary([artifact, brokenAncestry, brokenAncestryCommit, turn], "user", "before")).toBeNull();
        expect(getTransactionForkBoundary([artifact, brokenAncestry, brokenAncestryCommit, turn], "user", "at")).toBeNull();
    });

    it("rejects physical transaction chains that re-enter their own group", () => {
        const reenteringFirst = entry("artifact", "user", "tx");
        const attached = entry("attach", "artifact", "tx");
        const turn = user("user", "manifest", "tx");
        const commit = manifest("manifest", "attach", "tx", [reenteringFirst, attached, turn]);
        const singleTurn = user("single-user", "single-manifest", "single-tx");
        const singleManifestCycle = manifest("single-manifest", "single-user", "single-tx", [singleTurn]);

        expect(filterCommittedTransactionEntries([reenteringFirst, attached, commit, turn]).entries).toEqual([]);
        expect(filterCommittedTransactionEntries([singleManifestCycle, singleTurn]).entries).toEqual([]);
    });

    it("finds before and at fork boundaries for a transactional user", () => {
        const root = entry("root", null);
        const artifact = entry("artifact", "root", "tx");
        const turn = user("user", "manifest", "tx");
        const commit = manifest("manifest", "artifact", "tx", [artifact, turn]);
        const entries = [root, artifact, commit, turn, entry("after", "user")];

        expect(getTransactionForkBoundary(entries, "user", "before")).toBe("root");
        expect(getTransactionForkBoundary(entries, "user", "at")).toBe("user");
    });
});
