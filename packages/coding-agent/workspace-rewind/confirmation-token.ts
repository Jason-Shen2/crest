// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import type { RewindConflictClass } from "./live-path-state";
import type { RestorePlanV1, RestoreTargetV1 } from "./restore-plan";
import type { WorkspaceLinkedOperationV1 } from "./types";
import { decodeWorkspaceSnapshotRefV1 } from "./validation";

const ConfirmationTtlMs = 5 * 60 * 1_000;
const ConfirmationRegistryCapacity = 1_024;
const ConfirmationTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const AuthorityHeadPattern = /^[0-9a-f]{40}$/;

export interface ConfirmedRestorePlanV1 {
    plan: RestorePlanV1;
    authorityHead: string;
    issuedAt: number;
    expiresAt: number;
    binding: {
        authorityHead: string;
        workspaceIdentity: string;
        workspaceIncarnation: string;
        sessionId: string;
        semanticLeafId: string | null;
        commitParentId: string | null;
        target: RestoreTargetV1;
        effectivePaths: string[];
        pathStates: Array<{
            path: string;
            target: RestorePlanV1["paths"][number]["target"];
            expectedCurrent: RestorePlanV1["paths"][number]["expectedCurrent"];
        }>;
        liveFingerprints: Array<{ path: string; fingerprint: string; conflict: RewindConflictClass }>;
    };
}

function deepFreeze<T>(value: T): T {
    if (typeof value !== "object" || value == null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) {
        deepFreeze(child);
    }
    return value;
}

function clonePlan(plan: RestorePlanV1): RestorePlanV1 {
    return structuredClone(plan);
}

function targetKeysAre(target: object, expected: string[]): boolean {
    return Object.keys(target).sort().join("\0") === [...expected].sort().join("\0");
}

function canonicalTarget(target: RestoreTargetV1): RestoreTargetV1 {
    if (target.kind === "rewind" && targetKeysAre(target, ["kind", "targetTurnId"]) && target.targetTurnId) {
        return { kind: "rewind", targetTurnId: target.targetTurnId };
    }
    if (
        target.kind === "redo" &&
        targetKeysAre(target, ["kind", "sourceRewindOperationId", "linkedOperation"]) &&
        target.sourceRewindOperationId
    ) {
        const linkedOperation = canonicalLinkedOperation(target.linkedOperation);
        if (linkedOperation.operationId !== target.sourceRewindOperationId) {
            throw new Error("Cannot issue a confirmation token with an invalid restore target");
        }
        return { kind: "redo", sourceRewindOperationId: target.sourceRewindOperationId, linkedOperation };
    }
    if (target.kind === "turn-undo" && targetKeysAre(target, ["kind", "sourceTurnId"]) && target.sourceTurnId) {
        return { kind: "turn-undo", sourceTurnId: target.sourceTurnId };
    }
    if (
        target.kind === "turn-redo" &&
        targetKeysAre(target, ["kind", "sourceTurnId", "undoOperationId", "linkedOperation"]) &&
        target.sourceTurnId &&
        target.undoOperationId
    ) {
        const linkedOperation = canonicalLinkedOperation(target.linkedOperation);
        if (linkedOperation.operationId !== target.undoOperationId) {
            throw new Error("Cannot issue a confirmation token with an invalid restore target");
        }
        return {
            kind: "turn-redo",
            sourceTurnId: target.sourceTurnId,
            undoOperationId: target.undoOperationId,
            linkedOperation,
        };
    }
    throw new Error("Cannot issue a confirmation token with an invalid restore target");
}

function canonicalLinkedOperation(value: WorkspaceLinkedOperationV1): WorkspaceLinkedOperationV1 {
    if (!value || !targetKeysAre(value, ["operationId", "sourceSnapshot", "currentSnapshot"])) {
        throw new Error("Cannot issue a confirmation token with an invalid restore target");
    }
    const sourceSnapshot = decodeWorkspaceSnapshotRefV1(value.sourceSnapshot);
    const currentSnapshot = decodeWorkspaceSnapshotRefV1(value.currentSnapshot);
    if (
        typeof value.operationId !== "string" ||
        value.operationId.length === 0 ||
        !sourceSnapshot ||
        !currentSnapshot ||
        sourceSnapshot.id === currentSnapshot.id ||
        sourceSnapshot.workspaceIdentity !== currentSnapshot.workspaceIdentity ||
        sourceSnapshot.workspaceIncarnation !== currentSnapshot.workspaceIncarnation
    ) {
        throw new Error("Cannot issue a confirmation token with an invalid restore target");
    }
    return { operationId: value.operationId, sourceSnapshot, currentSnapshot };
}

function confirmationBinding(plan: RestorePlanV1, authorityHead: string): ConfirmedRestorePlanV1["binding"] {
    const orderedPaths = [...plan.paths].sort((left, right) => left.path.localeCompare(right.path));
    return {
        authorityHead,
        workspaceIdentity: plan.workspaceIdentity,
        workspaceIncarnation: plan.workspaceIncarnation,
        sessionId: plan.sessionId,
        semanticLeafId: plan.semanticLeafId,
        commitParentId: plan.commitParentId,
        target: canonicalTarget(plan.target),
        effectivePaths: orderedPaths.map((item) => item.path),
        pathStates: orderedPaths.map((item) => ({
            path: item.path,
            target: structuredClone(item.target),
            expectedCurrent: structuredClone(item.expectedCurrent),
        })),
        liveFingerprints: orderedPaths.map((item) => ({
            path: item.path,
            fingerprint: item.liveFingerprint,
            conflict: item.conflict,
        })),
    };
}

function bindingsEqual(left: ConfirmedRestorePlanV1["binding"], right: ConfirmedRestorePlanV1["binding"]): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function validateIssuable(plan: RestorePlanV1): void {
    canonicalTarget(plan.target);
    if (plan.hardBlocked || plan.paths.some((path) => path.conflict === "hard-blocker")) {
        throw new Error("Cannot issue a confirmation token for a hard-blocked restore preview");
    }
    if (plan.target.kind === "rewind" && !plan.target.targetTurnId) {
        throw new Error("Cannot issue a confirmation token without a rewind target");
    }
    const redoLike = plan.target.kind === "redo" || plan.target.kind === "turn-redo";
    if (redoLike && (plan.forceRequired || plan.paths.some((path) => path.conflict !== "none"))) {
        throw new Error("Cannot issue a confirmation token for a Redo preview with drift");
    }
    const paths = plan.paths.map((item) => item.path);
    if (new Set(paths).size !== paths.length) {
        throw new Error("Cannot issue a confirmation token for duplicate effective paths");
    }
    const requiresForce = plan.paths.some((path) => path.conflict === "forceable-drift");
    if (requiresForce !== plan.forceRequired) {
        throw new Error("Cannot issue a confirmation token for an inconsistent conflict projection");
    }
}

export class RewindConfirmationRegistry {
    entries = new Map<string, ConfirmedRestorePlanV1>();

    issue(plan: RestorePlanV1, authorityHead: string, now = Date.now()): string {
        this.sweepExpired(now);
        validateIssuable(plan);
        if (!AuthorityHeadPattern.test(authorityHead)) {
            throw new Error("Rewind confirmation authority head must be a SHA-1 commit OID");
        }
        if (this.entries.size >= ConfirmationRegistryCapacity) {
            throw new Error("Rewind confirmation registry reached capacity");
        }
        const copiedPlan = clonePlan(plan);
        const confirmed = deepFreeze({
            plan: copiedPlan,
            authorityHead,
            issuedAt: now,
            expiresAt: now + ConfirmationTtlMs,
            binding: confirmationBinding(copiedPlan, authorityHead),
        });
        let token: string;
        do {
            token = randomBytes(32).toString("base64url");
        } while (this.entries.has(token));
        this.entries.set(token, confirmed);
        return token;
    }

    take(token: string, now = Date.now()): ConfirmedRestorePlanV1 {
        if (!ConfirmationTokenPattern.test(token)) {
            throw new Error("Invalid rewind confirmation token format");
        }
        const confirmed = this.entries.get(token);
        this.sweepExpired(now);
        if (!confirmed) {
            throw new Error("Invalid or already consumed rewind confirmation token");
        }
        this.entries.delete(token);
        if (now >= confirmed.expiresAt) {
            throw new Error("Rewind confirmation token expired");
        }
        return confirmed;
    }

    invalidateSession(sessionId: string): void {
        for (const [token, confirmed] of this.entries) {
            if (confirmed.binding.sessionId === sessionId) {
                this.entries.delete(token);
            }
        }
    }

    sweepExpired(now: number): void {
        for (const [token, confirmed] of this.entries) {
            if (now >= confirmed.expiresAt) {
                this.entries.delete(token);
            }
        }
    }
}

export function assertRestorePlanMatchesConfirmation(input: {
    confirmation: ConfirmedRestorePlanV1;
    plan: RestorePlanV1;
    mode: "normal" | "force-drift";
}): void {
    validateIssuable(input.plan);
    const recomputed = confirmationBinding(input.plan, input.confirmation.authorityHead);
    if (!bindingsEqual(input.confirmation.binding, recomputed)) {
        throw new Error("Rewind confirmation is stale");
    }
    const forceAllowed = input.plan.target.kind === "rewind" || input.plan.target.kind === "turn-undo";
    if (input.mode === "force-drift" && !forceAllowed) {
        throw new Error("Force mode is available only for rewind");
    }
    if (input.mode === "normal" && input.plan.forceRequired) {
        throw new Error("Normal rewind cannot apply forceable drift");
    }
}
