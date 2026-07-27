// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ContextArtifactDraft, ContextDraftView } from "./types";
import { ContextReferenceError } from "./types";

const DefaultTtlMs = 30 * 60 * 1_000;

interface StoredContextDraft {
    draft: ContextArtifactDraft;
    summaryStatus: ContextDraftView["summaryStatus"];
    expiresAt: number;
    reservation?: symbol;
}

interface ContextDraftRegistryState {
    entriesByTarget: Map<string, Map<string, StoredContextDraft>>;
    ttlMs: number;
    now: () => number;
    idFactory: () => string;
}

const RegistryStates = new WeakMap<ContextDraftRegistry, ContextDraftRegistryState>();

function getRegistryState(registry: ContextDraftRegistry): ContextDraftRegistryState {
    return RegistryStates.get(registry)!;
}

function deleteTargetIfEmpty(
    registry: ContextDraftRegistry,
    targetSessionPath: string,
    targetEntries: Map<string, StoredContextDraft>
): void {
    if (targetEntries.size === 0) getRegistryState(registry).entriesByTarget.delete(targetSessionPath);
}

function selectMany(
    registry: ContextDraftRegistry,
    targetSessionPath: string,
    draftIds: string[],
    access: "inspect" | "read" | "mutate"
): Array<{ draftId: string; stored: StoredContextDraft }> {
    if (new Set(draftIds).size !== draftIds.length) {
        throw new ContextDraftRegistryError("invalid_input", "Draft IDs must be unique", draftIds);
    }
    const state = getRegistryState(registry);
    const targetEntries = state.entriesByTarget.get(targetSessionPath);
    const missingIds = draftIds.filter((draftId) => !targetEntries?.has(draftId));
    if (missingIds.length > 0) {
        throw new ContextDraftRegistryError("invalid_input", "Drafts do not belong to the target session", missingIds);
    }

    const now = state.now();
    const selected = draftIds.map((draftId) => ({ draftId, stored: targetEntries!.get(draftId)! }));
    const expiredIds = selected
        .filter(
            ({ stored }) =>
                stored.reservation == null && stored.summaryStatus !== "summarizing" && stored.expiresAt <= now
        )
        .map(({ draftId }) => draftId);
    if (expiredIds.length > 0) {
        for (const draftId of expiredIds) {
            targetEntries!.delete(draftId);
        }
        deleteTargetIfEmpty(registry, targetSessionPath, targetEntries!);
        throw new ContextDraftRegistryError("draft_expired", "Context drafts expired", expiredIds);
    }
    if (access === "mutate") {
        const reservedIds = selected.filter(({ stored }) => stored.reservation != null).map(({ draftId }) => draftId);
        if (reservedIds.length > 0) {
            throw new ContextDraftRegistryError("invalid_input", "Context drafts are being committed", reservedIds);
        }
        for (const { stored } of selected) {
            stored.expiresAt = now + state.ttlMs;
        }
        return selected;
    }
    if (access === "read") {
        for (const { stored } of selected) {
            stored.expiresAt = now + state.ttlMs;
        }
    }
    return selected;
}

async function commitReservedDrafts<TResult>(
    registry: ContextDraftRegistry,
    targetSessionPath: string,
    draftIds: string[],
    commit: (drafts: ContextArtifactDraft[]) => Promise<TResult>
): Promise<TResult> {
    const selected = selectMany(registry, targetSessionPath, draftIds, "inspect");
    const unavailableIds = selected
        .filter(({ stored }) => stored.reservation != null || stored.summaryStatus === "summarizing")
        .map(({ draftId }) => draftId);
    if (unavailableIds.length > 0) {
        throw new ContextDraftRegistryError("invalid_input", "Context drafts are not ready to commit", unavailableIds);
    }

    const reservation = Symbol("contextDraftReservation");
    const state = getRegistryState(registry);
    const expiresAt = state.now() + state.ttlMs;
    for (const { stored } of selected) {
        stored.reservation = reservation;
        stored.expiresAt = expiresAt;
    }

    try {
        const result = await commit(selected.map(({ stored }) => structuredClone(stored.draft)));
        const targetEntries = getRegistryState(registry).entriesByTarget.get(targetSessionPath);
        if (!targetEntries) return result;
        for (const { draftId, stored } of selected) {
            if (targetEntries.get(draftId) === stored && stored.reservation === reservation) {
                targetEntries.delete(draftId);
            }
        }
        deleteTargetIfEmpty(registry, targetSessionPath, targetEntries);
        return result;
    } catch (error) {
        const state = getRegistryState(registry);
        const expiresAt = state.now() + state.ttlMs;
        for (const { stored } of selected) {
            if (stored.reservation !== reservation) continue;
            delete stored.reservation;
            stored.expiresAt = expiresAt;
        }
        throw error;
    }
}

export interface ContextDraftRegistryOptions {
    ttlMs?: number;
    now?: () => number;
    idFactory?: () => string;
}

export class ContextDraftRegistryError extends ContextReferenceError {
    draftIds: string[];

    constructor(code: "invalid_input" | "draft_expired", message: string, draftIds: string[]) {
        super(code, message);
        this.name = "ContextDraftRegistryError";
        this.draftIds = [...draftIds];
    }
}

export class ContextDraftRegistry {
    constructor(options: ContextDraftRegistryOptions = {}) {
        const ttlMs = options.ttlMs ?? DefaultTtlMs;
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
            throw new ContextDraftRegistryError("invalid_input", "Draft TTL must be a positive finite number", []);
        }
        RegistryStates.set(this, {
            entriesByTarget: new Map(),
            ttlMs,
            now: options.now ?? (() => Date.now()),
            idFactory: options.idFactory ?? (() => crypto.randomUUID()),
        });
    }

    create(targetSessionPath: string, draft: ContextArtifactDraft): ContextDraftView {
        const targetEntries = this.getOrCreateTarget(targetSessionPath);
        const state = this.getState();
        const draftId = state.idFactory();
        if (!draftId || targetEntries.has(draftId)) {
            throw new ContextDraftRegistryError("invalid_input", "Draft ID must be unique and non-empty", [draftId]);
        }
        const stored: StoredContextDraft = {
            draft: structuredClone(draft),
            summaryStatus: draft.artifact.summary == null ? "none" : "ready",
            expiresAt: state.now() + state.ttlMs,
        };
        targetEntries.set(draftId, stored);
        return this.toView(draftId, targetSessionPath, stored);
    }

    peek(targetSessionPath: string, draftId: string): ContextDraftView | undefined {
        const state = this.getState();
        const targetEntries = state.entriesByTarget.get(targetSessionPath);
        const stored = targetEntries?.get(draftId);
        if (!stored) return undefined;
        const now = state.now();
        if (stored.reservation == null && stored.summaryStatus !== "summarizing" && stored.expiresAt <= now) {
            targetEntries!.delete(draftId);
            deleteTargetIfEmpty(this, targetSessionPath, targetEntries!);
            return undefined;
        }
        stored.expiresAt = now + state.ttlMs;
        return this.toView(draftId, targetSessionPath, stored);
    }

    list(targetSessionPath: string): ContextDraftView[] {
        const targetEntries = this.getState().entriesByTarget.get(targetSessionPath);
        if (!targetEntries) return [];
        return [...targetEntries.keys()].flatMap((draftId) => {
            const view = this.peek(targetSessionPath, draftId);
            return view == null ? [] : [view];
        });
    }

    findTarget(draftId: string): string | undefined {
        for (const [targetSessionPath, targetEntries] of this.getState().entriesByTarget) {
            if (targetEntries.has(draftId)) return targetSessionPath;
        }
        return undefined;
    }

    readMany(targetSessionPath: string, draftIds: string[]): ContextArtifactDraft[] {
        return selectMany(this, targetSessionPath, draftIds, "read").map(({ stored }) => structuredClone(stored.draft));
    }

    beginSummary(targetSessionPath: string, draftId: string): ContextDraftView {
        const stored = selectMany(this, targetSessionPath, [draftId], "mutate")[0]!.stored;
        if (stored.summaryStatus === "summarizing") {
            throw new ContextDraftRegistryError("invalid_input", "Context draft summary is already in progress", [
                draftId,
            ]);
        }
        stored.summaryStatus = "summarizing";
        return this.toView(draftId, targetSessionPath, stored);
    }

    completeSummary(
        targetSessionPath: string,
        draftId: string,
        summary: NonNullable<ContextArtifactDraft["artifact"]["summary"]>
    ): ContextDraftView {
        const stored = selectMany(this, targetSessionPath, [draftId], "mutate")[0]!.stored;
        if (stored.summaryStatus !== "summarizing") {
            throw new ContextDraftRegistryError("invalid_input", "Context draft summary is not in progress", [draftId]);
        }
        stored.draft = {
            artifact: {
                ...stored.draft.artifact,
                summary: structuredClone(summary),
            },
        };
        stored.summaryStatus = "ready";
        return this.toView(draftId, targetSessionPath, stored);
    }

    failSummary(targetSessionPath: string, draftId: string): ContextDraftView {
        const stored = selectMany(this, targetSessionPath, [draftId], "mutate")[0]!.stored;
        if (stored.summaryStatus !== "summarizing") {
            throw new ContextDraftRegistryError("invalid_input", "Context draft summary is not in progress", [draftId]);
        }
        stored.summaryStatus = stored.draft.artifact.summary == null ? "failed" : "ready";
        return this.toView(draftId, targetSessionPath, stored);
    }

    consumeMany(targetSessionPath: string, draftIds: string[]): ContextArtifactDraft[] {
        const selected = selectMany(this, targetSessionPath, draftIds, "mutate");
        if (selected.length === 0) return [];
        const targetEntries = this.getState().entriesByTarget.get(targetSessionPath)!;
        for (const draftId of draftIds) {
            targetEntries.delete(draftId);
        }
        deleteTargetIfEmpty(this, targetSessionPath, targetEntries);
        return selected.map(({ stored }) => structuredClone(stored.draft));
    }

    discard(targetSessionPath: string, draftId: string): boolean {
        const targetEntries = this.getState().entriesByTarget.get(targetSessionPath);
        if (!targetEntries) return false;
        const stored = targetEntries.get(draftId);
        if (stored?.reservation != null) {
            throw new ContextDraftRegistryError("invalid_input", "Context draft is being committed", [draftId]);
        }
        const discarded = targetEntries.delete(draftId);
        deleteTargetIfEmpty(this, targetSessionPath, targetEntries);
        return discarded;
    }

    clearTarget(targetSessionPath: string): number {
        const state = this.getState();
        const targetEntries = state.entriesByTarget.get(targetSessionPath);
        if (!targetEntries) return 0;
        const reservedIds = [...targetEntries]
            .filter(([, stored]) => stored.reservation != null)
            .map(([draftId]) => draftId);
        if (reservedIds.length > 0) {
            throw new ContextDraftRegistryError("invalid_input", "Context drafts are being committed", reservedIds);
        }
        state.entriesByTarget.delete(targetSessionPath);
        return targetEntries.size;
    }

    sweepExpired(): number {
        const state = this.getState();
        const now = state.now();
        let swept = 0;
        for (const [targetSessionPath, targetEntries] of state.entriesByTarget) {
            for (const [draftId, stored] of targetEntries) {
                if (stored.reservation != null || stored.summaryStatus === "summarizing" || stored.expiresAt > now) {
                    continue;
                }
                targetEntries.delete(draftId);
                swept++;
            }
            deleteTargetIfEmpty(this, targetSessionPath, targetEntries);
        }
        return swept;
    }

    private getState(): ContextDraftRegistryState {
        return RegistryStates.get(this)!;
    }

    private getOrCreateTarget(targetSessionPath: string): Map<string, StoredContextDraft> {
        const state = this.getState();
        const existing = state.entriesByTarget.get(targetSessionPath);
        if (existing) return existing;
        const created = new Map<string, StoredContextDraft>();
        state.entriesByTarget.set(targetSessionPath, created);
        return created;
    }

    private toView(draftId: string, targetSessionPath: string, stored: StoredContextDraft): ContextDraftView {
        return {
            draftId,
            targetSessionPath,
            provenance: structuredClone(stored.draft.artifact.provenance),
            summaryStatus: stored.summaryStatus,
            expiresAt: new Date(stored.expiresAt).toISOString(),
        };
    }
}

export async function withContextDrafts<TResult>(
    registry: ContextDraftRegistry,
    targetSessionPath: string,
    draftIds: string[],
    commit: (drafts: ContextArtifactDraft[]) => Promise<TResult>
): Promise<TResult> {
    // Preparation and budget checks must use readMany; this wrapper is reserved for the durable append boundary.
    return commitReservedDrafts(registry, targetSessionPath, draftIds, commit);
}
