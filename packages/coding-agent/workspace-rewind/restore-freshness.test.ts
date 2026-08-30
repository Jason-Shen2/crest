// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { RewindConfirmationRegistry } from "./confirmation-token";
import type { RestorePlanV1 } from "./restore-plan";
import { assertConfirmedRestoreFresh } from "./restore-freshness";

const Identity = "1".repeat(64);
const Incarnation = "2".repeat(64);
const Fingerprint = "3".repeat(64);
const AuthorityHead = "a".repeat(40);
const CurrentHead = "b".repeat(40);

function plan(conflict: "none" | "forceable-drift" = "none"): RestorePlanV1 {
    return {
        target: { kind: "rewind", targetTurnId: "turn-1" },
        sessionId: "session-1",
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        semanticLeafId: "leaf-1",
        commitParentId: "parent-1",
        paths: [
            {
                path: "src/file.ts",
                operation: "write",
                target: { state: "file", oid: "4".repeat(40), executable: false },
                expectedCurrent: { state: "file", oid: "5".repeat(40), executable: false },
                liveFingerprint: Fingerprint,
                conflict,
            },
        ],
        coverageWarnings: [],
        forceRequired: conflict === "forceable-drift",
        hardBlocked: false,
    };
}

function confirmation(conflict: "none" | "forceable-drift" = "none") {
    const registry = new RewindConfirmationRegistry();
    return registry.take(registry.issue(plan(conflict), AuthorityHead));
}

describe("confirmed restore freshness", () => {
    it("accepts the unchanged authority head without traversing history", async () => {
        const findForeignOverlap = vi.fn();

        await expect(
            assertConfirmedRestoreFresh({
                confirmation: confirmation(),
                currentHead: AuthorityHead,
                mode: "normal",
                mutationLog: { findForeignOverlap },
            })
        ).resolves.toBeUndefined();

        expect(findForeignOverlap).not.toHaveBeenCalled();
    });

    it("accepts unrelated history added after Preview", async () => {
        const findForeignOverlap = vi.fn(async () => []);
        const confirmed = confirmation();

        await expect(
            assertConfirmedRestoreFresh({
                confirmation: confirmed,
                currentHead: CurrentHead,
                mode: "normal",
                mutationLog: { findForeignOverlap },
            })
        ).resolves.toBeUndefined();

        expect(findForeignOverlap).toHaveBeenCalledWith({
            afterCommit: AuthorityHead,
            head: CurrentHead,
            paths: ["src/file.ts"],
            includedCommits: new Set(),
            ownerSessionId: "session-1",
        });
    });

    it("rejects same-path Session-owned history including ABA", async () => {
        const findForeignOverlap = vi.fn(async () => [
            { commit: CurrentHead, path: "src/file.ts", sessionId: "session-2" },
            { commit: "c".repeat(40), path: "src/file.ts", sessionId: "session-2" },
        ]);

        await expect(
            assertConfirmedRestoreFresh({
                confirmation: confirmation(),
                currentHead: CurrentHead,
                mode: "normal",
                mutationLog: { findForeignOverlap },
            })
        ).rejects.toThrow(/stale.*src\/file\.ts/i);
    });

    it("rejects external same-path history in normal mode", async () => {
        const findForeignOverlap = vi.fn(async () => [{ commit: CurrentHead, path: "src/file.ts" }]);

        await expect(
            assertConfirmedRestoreFresh({
                confirmation: confirmation("forceable-drift"),
                currentHead: CurrentHead,
                mode: "normal",
                mutationLog: { findForeignOverlap },
            })
        ).rejects.toThrow(/normal rewind/i);
    });

    it("rejects external same-path drift added after a Force preview", async () => {
        const findForeignOverlap = vi.fn(async () => [{ commit: CurrentHead, path: "src/file.ts" }]);

        await expect(
            assertConfirmedRestoreFresh({
                confirmation: confirmation("forceable-drift"),
                currentHead: CurrentHead,
                mode: "force-drift",
                mutationLog: { findForeignOverlap },
            })
        ).rejects.toThrow(/stale.*src\/file\.ts/i);
    });

    it("fails closed when the current head is not descended from Preview authority", async () => {
        const findForeignOverlap = vi.fn(async () => {
            throw new Error("The requested mutation boundary is not in the workspace commit chain");
        });

        await expect(
            assertConfirmedRestoreFresh({
                confirmation: confirmation(),
                currentHead: CurrentHead,
                mode: "normal",
                mutationLog: { findForeignOverlap },
            })
        ).rejects.toThrow(/not in the workspace commit chain/i);
    });
});
