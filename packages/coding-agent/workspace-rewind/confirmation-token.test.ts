// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { assertRestorePlanMatchesConfirmation, RewindConfirmationRegistry } from "./confirmation-token";
import type { RestorePlanV1 } from "./restore-plan";

function linkedOperation(operationId: string) {
    const snapshot = (id: string) => ({
        id,
        workspaceIdentity: "workspace-1",
        workspaceIncarnation: "incarnation-1",
        tree: "a".repeat(40),
        scopeManifest: "b".repeat(40),
    });
    return { operationId, sourceSnapshot: snapshot("c".repeat(40)), currentSnapshot: snapshot("d".repeat(40)) };
}

function plan(overrides: Partial<RestorePlanV1> = {}): RestorePlanV1 {
    return {
        target: { kind: "rewind", targetTurnId: "turn-1" },
        sessionId: "session-1",
        workspaceIdentity: "workspace-1",
        workspaceIncarnation: "incarnation-1",
        semanticLeafId: "leaf-1",
        commitParentId: "boundary-1",
        paths: [
            {
                path: "b.ts",
                operation: "delete",
                target: { state: "absent" },
                expectedCurrent: { state: "file", oid: "b".repeat(40), executable: false },
                liveFingerprint: "fingerprint-b",
                conflict: "forceable-drift",
            },
            {
                path: "a.ts",
                operation: "write",
                target: { state: "file", oid: "a".repeat(40), executable: false },
                expectedCurrent: { state: "file", oid: "c".repeat(40), executable: false },
                liveFingerprint: "fingerprint-a",
                conflict: "none",
            },
        ],
        coverageWarnings: [],
        forceRequired: true,
        hardBlocked: false,
        ...overrides,
    };
}

describe("rewind confirmation registry", () => {
    it("issues opaque 32-byte, five-minute, one-use tokens with canonical bindings", () => {
        const registry = new RewindConfirmationRegistry();
        const token = registry.issue(plan(), 1_000);

        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const confirmed = registry.take(token, 300_999);
        expect(confirmed).toMatchObject({ issuedAt: 1_000, expiresAt: 301_000 });
        expect(confirmed.binding).toEqual({
            workspaceIdentity: "workspace-1",
            workspaceIncarnation: "incarnation-1",
            sessionId: "session-1",
            semanticLeafId: "leaf-1",
            commitParentId: "boundary-1",
            target: { kind: "rewind", targetTurnId: "turn-1" },
            effectivePaths: ["a.ts", "b.ts"],
            pathStates: [
                {
                    path: "a.ts",
                    target: { state: "file", oid: "a".repeat(40), executable: false },
                    expectedCurrent: { state: "file", oid: "c".repeat(40), executable: false },
                },
                {
                    path: "b.ts",
                    target: { state: "absent" },
                    expectedCurrent: { state: "file", oid: "b".repeat(40), executable: false },
                },
            ],
            liveFingerprints: [
                { path: "a.ts", fingerprint: "fingerprint-a", conflict: "none" },
                { path: "b.ts", fingerprint: "fingerprint-b", conflict: "forceable-drift" },
            ],
        });
        expect(() => registry.take(token, 301_000)).toThrow(/token/i);
    });

    it("rejects random, expired, invalidated, hard-blocked, and drifting redo previews", () => {
        const registry = new RewindConfirmationRegistry();
        expect(() => registry.take("random", 0)).toThrow(/token/i);

        const expired = registry.issue(plan(), 0);
        expect(() => registry.take(expired, 300_000)).toThrow(/expired/i);

        const invalidated = registry.issue(plan(), 1);
        registry.invalidateSession("session-1");
        expect(() => registry.take(invalidated, 2)).toThrow(/token/i);

        expect(() => registry.issue(plan({ hardBlocked: true }), 0)).toThrow(/blocked/i);
        expect(() =>
            registry.issue(
                plan({
                    target: {
                        kind: "redo",
                        sourceRewindOperationId: "rewind-1",
                        linkedOperation: linkedOperation("rewind-1"),
                    },
                    forceRequired: true,
                }),
                0
            )
        ).toThrow(/redo/i);
    });

    it("stores an immutable projection so callers cannot expand force authority", () => {
        const registry = new RewindConfirmationRegistry();
        const source = plan();
        const token = registry.issue(source, 0);
        source.paths.push({
            path: "later.ts",
            operation: "delete",
            target: { state: "absent" },
            expectedCurrent: { state: "absent" },
            liveFingerprint: "later",
            conflict: "none",
        });
        source.paths[0]!.liveFingerprint = "changed";

        const confirmed = registry.take(token, 1);
        expect(confirmed.binding.effectivePaths).toEqual(["a.ts", "b.ts"]);
        expect(confirmed.binding.liveFingerprints[1]).toEqual({
            path: "b.ts",
            fingerprint: "fingerprint-b",
            conflict: "forceable-drift",
        });
        expect(() => {
            confirmed.binding.effectivePaths.push("evil.ts");
        }).toThrow();
    });

    it.each([
        ["workspace", { workspaceIdentity: "workspace-2" }],
        ["incarnation", { workspaceIncarnation: "incarnation-2" }],
        ["session", { sessionId: "session-2" }],
        ["leaf", { semanticLeafId: "leaf-2" }],
        ["commit parent", { commitParentId: "boundary-2" }],
        ["target", { target: { kind: "rewind", targetTurnId: "turn-2" } }],
    ] as const)("rejects a recomputed plan with a changed %s binding", (_label, override) => {
        const registry = new RewindConfirmationRegistry();
        const token = registry.issue(plan(), 0);
        const confirmation = registry.take(token, 1);

        expect(() =>
            assertRestorePlanMatchesConfirmation({
                confirmation,
                plan: plan(override),
                mode: "force-drift",
            })
        ).toThrow(/stale/i);
    });

    it.each(["target state", "expected state"] as const)("rejects changed %s after confirmation", (change) => {
        const registry = new RewindConfirmationRegistry();
        const confirmation = registry.take(registry.issue(plan(), 0), 1);
        const recomputed = plan();
        if (change === "target state") {
            recomputed.paths[0]!.target = { state: "file", oid: "d".repeat(40), executable: false };
        } else {
            recomputed.paths[0]!.expectedCurrent = { state: "file", oid: "d".repeat(40), executable: false };
        }

        expect(() =>
            assertRestorePlanMatchesConfirmation({ confirmation, plan: recomputed, mode: "force-drift" })
        ).toThrow(/stale/i);
    });

    it.each(["added", "removed", "fingerprint", "conflict"] as const)(
        "rejects %s post-preview path drift",
        (change) => {
            const registry = new RewindConfirmationRegistry();
            const confirmation = registry.take(registry.issue(plan(), 0), 1);
            const recomputed = plan();
            if (change === "added") {
                recomputed.paths.push({
                    path: "c.ts",
                    operation: "delete",
                    target: { state: "absent" },
                    expectedCurrent: { state: "file", oid: "d".repeat(40), executable: false },
                    liveFingerprint: "fingerprint-c",
                    conflict: "none",
                });
            } else if (change === "removed") {
                recomputed.paths.pop();
            } else if (change === "fingerprint") {
                recomputed.paths[0]!.liveFingerprint = "new-fingerprint";
            } else {
                recomputed.paths[0]!.conflict = "none";
                recomputed.forceRequired = false;
            }

            expect(() =>
                assertRestorePlanMatchesConfirmation({
                    confirmation,
                    plan: recomputed,
                    mode: change === "removed" || change === "conflict" ? "normal" : "force-drift",
                })
            ).toThrow();
        }
    );

    it("rejects normal drift, force path expansion, and force across a hard blocker", () => {
        const registry = new RewindConfirmationRegistry();
        const confirmation = registry.take(registry.issue(plan(), 0), 1);

        expect(() => assertRestorePlanMatchesConfirmation({ confirmation, plan: plan(), mode: "normal" })).toThrow(
            /normal/i
        );
        expect(() =>
            assertRestorePlanMatchesConfirmation({
                confirmation,
                plan: plan({
                    paths: [
                        ...plan().paths,
                        {
                            path: "expanded.ts",
                            operation: "delete",
                            target: { state: "absent" },
                            expectedCurrent: { state: "file", oid: "e".repeat(40), executable: false },
                            liveFingerprint: "expanded",
                            conflict: "forceable-drift",
                        },
                    ],
                }),
                mode: "force-drift",
            })
        ).toThrow(/stale/i);
        expect(() =>
            assertRestorePlanMatchesConfirmation({
                confirmation,
                plan: plan({ hardBlocked: true }),
                mode: "force-drift",
            })
        ).toThrow(/blocked/i);
    });

    it("binds turn targets exactly and allows force only for rewind-like targets", () => {
        const registry = new RewindConfirmationRegistry();
        const undoPlan = plan({ target: { kind: "turn-undo", sourceTurnId: "source-1" } });
        const undo = registry.take(registry.issue(undoPlan, 0), 1);
        expect(undo.binding.target).toEqual({ kind: "turn-undo", sourceTurnId: "source-1" });

        const redoPlan = plan({
            target: {
                kind: "turn-redo",
                sourceTurnId: "source-1",
                undoOperationId: "undo-1",
                linkedOperation: linkedOperation("undo-1"),
            },
            paths: plan().paths.map((path) => ({ ...path, conflict: "none" as const })),
            forceRequired: false,
        });
        const redo = registry.take(registry.issue(redoPlan, 0), 1);
        expect(redo.binding.target).toEqual({
            kind: "turn-redo",
            sourceTurnId: "source-1",
            undoOperationId: "undo-1",
            linkedOperation: linkedOperation("undo-1"),
        });
        expect(() =>
            assertRestorePlanMatchesConfirmation({ confirmation: redo, plan: redoPlan, mode: "force-drift" })
        ).toThrow(/only.*rewind/i);
        expect(() => registry.issue({ ...redoPlan, forceRequired: true }, 0)).toThrow(/redo/i);
    });

    it("rejects incomplete turn targets instead of weakening their binding", () => {
        const registry = new RewindConfirmationRegistry();
        expect(() =>
            registry.issue(
                plan({
                    target: { kind: "turn-redo", sourceTurnId: "source-1" } as RestorePlanV1["target"],
                }),
                0
            )
        ).toThrow(/target/i);
    });

    it("sweeps expired entries during issue", () => {
        const registry = new RewindConfirmationRegistry();
        registry.issue(plan({ sessionId: "expired" }), 0);
        registry.issue(plan({ sessionId: "current" }), 300_001);

        expect(registry.entries.size).toBe(1);
    });

    it("sweeps other expired entries during take", () => {
        const registry = new RewindConfirmationRegistry();
        registry.issue(plan({ sessionId: "expired" }), 0);
        const current = registry.issue(plan({ sessionId: "current" }), 1);

        expect(registry.take(current, 300_000).binding.sessionId).toBe("current");
        expect(registry.entries.size).toBe(0);
    });

    it("rejects malformed tokens before lookup", () => {
        const registry = new RewindConfirmationRegistry();
        const get = vi.spyOn(registry.entries, "get");

        expect(() => registry.take("a".repeat(42), 0)).toThrow(/format/i);
        expect(() => registry.take(`${"a".repeat(42)}=`, 0)).toThrow(/format/i);
        expect(get).not.toHaveBeenCalled();
    });

    it("never evicts an unexpired token when capacity is reached", () => {
        const registry = new RewindConfirmationRegistry();
        const first = registry.issue(plan({ sessionId: "first" }), 0);
        for (let index = 1; index < 1_024; index++) {
            registry.issue(plan({ sessionId: `session-${index}` }), 0);
        }

        expect(() => registry.issue(plan({ sessionId: "overflow" }), 0)).toThrow(/capacity/i);
        expect(registry.take(first, 1).binding.sessionId).toBe("first");
    });
});
