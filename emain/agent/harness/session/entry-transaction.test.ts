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

function manifest(id: string, parentId: string, transactionId: string, members: SessionTreeEntry[]): SessionTreeEntry {
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

    it("hides malformed groups without hiding interleaved ordinary entries", () => {
        const artifact = entry("artifact", null, "tx");
        const turn = user("user", "manifest", "tx");
        const commit = manifest("manifest", "artifact", "tx", [artifact, turn]);
        const extra = entry("extra", "manifest", "tx");

        const result = filterCommittedTransactionEntries([artifact, entry("ordinary", null), commit, turn, extra]);

        expect(result.entries.map((item) => item.id)).toEqual(["ordinary"]);
        expect(result.diagnostics).toHaveLength(1);
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
