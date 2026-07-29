// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import type { RewindConflictClass } from "./live-path-state";
import type { RestorePlanV1 } from "./restore-plan";

const ConfirmationTtlMs = 5 * 60 * 1_000;
const ConfirmationRegistryCapacity = 1_024;
const ConfirmationTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export interface ConfirmedRestorePlanV1 {
    plan: RestorePlanV1;
    issuedAt: number;
    expiresAt: number;
    binding: {
        workspaceIdentity: string;
        workspaceIncarnation: string;
        sessionId: string;
        semanticLeafId: string | null;
        target: { kind: "rewind"; targetTurnId: string } | { kind: "redo" };
        effectivePaths: string[];
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

function confirmationBinding(plan: RestorePlanV1): ConfirmedRestorePlanV1["binding"] {
    const orderedPaths = [...plan.paths].sort((left, right) => left.path.localeCompare(right.path));
    return {
        workspaceIdentity: plan.workspaceIdentity,
        workspaceIncarnation: plan.workspaceIncarnation,
        sessionId: plan.sessionId,
        semanticLeafId: plan.semanticLeafId,
        target: plan.kind === "rewind" ? { kind: "rewind", targetTurnId: plan.targetTurnId! } : { kind: "redo" },
        effectivePaths: orderedPaths.map((item) => item.path),
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
    if (plan.hardBlocked || plan.paths.some((path) => path.conflict === "hard-blocker")) {
        throw new Error("Cannot issue a confirmation token for a hard-blocked restore preview");
    }
    if (plan.kind === "rewind" && !plan.targetTurnId) {
        throw new Error("Cannot issue a confirmation token without a rewind target");
    }
    if (plan.kind === "redo" && (plan.forceRequired || plan.paths.some((path) => path.conflict !== "none"))) {
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

    issue(plan: RestorePlanV1, now = Date.now()): string {
        this.sweepExpired(now);
        validateIssuable(plan);
        if (this.entries.size >= ConfirmationRegistryCapacity) {
            throw new Error("Rewind confirmation registry reached capacity");
        }
        const copiedPlan = clonePlan(plan);
        const confirmed = deepFreeze({
            plan: copiedPlan,
            issuedAt: now,
            expiresAt: now + ConfirmationTtlMs,
            binding: confirmationBinding(copiedPlan),
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
    const recomputed = confirmationBinding(input.plan);
    if (!bindingsEqual(input.confirmation.binding, recomputed)) {
        throw new Error("Rewind confirmation is stale");
    }
    if (input.mode === "force-drift" && input.plan.kind !== "rewind") {
        throw new Error("Force mode is available only for rewind");
    }
    if (input.mode === "normal" && input.plan.forceRequired) {
        throw new Error("Normal rewind cannot apply forceable drift");
    }
}
