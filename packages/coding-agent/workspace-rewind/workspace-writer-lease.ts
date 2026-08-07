// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface WorkspaceWriterLease {
    workspaceKey: string;
    sessionId: string;
    boundaryToken: string;
    release(): void;
}

interface WorkspaceWriterLeaseInput {
    workspaceKey: string;
    sessionId: string;
    boundaryToken: string;
    signal?: AbortSignal;
}

interface PendingAcquisition {
    key: string;
    input: WorkspaceWriterLeaseInput;
    promise: Promise<WorkspaceWriterLease>;
    resolve: (lease: WorkspaceWriterLease) => void;
    reject: (reason: unknown) => void;
    abortListener?: () => void;
}

interface WorkspaceLeaseState {
    active?: PendingAcquisition;
    queue: PendingAcquisition[];
    acquisitions: Map<string, PendingAcquisition>;
}

export class WorkspaceWriterLeaseRegistry {
    workspaces = new Map<string, WorkspaceLeaseState>();

    acquire(input: WorkspaceWriterLeaseInput): Promise<WorkspaceWriterLease> {
        assertValidInput(input);
        const key = JSON.stringify([input.sessionId, input.boundaryToken]);
        let state = this.workspaces.get(input.workspaceKey);
        const existing = state?.acquisitions.get(key);
        if (existing) {
            return existing.promise;
        }
        if (input.signal?.aborted) {
            return Promise.reject(abortReason(input.signal));
        }
        if (!state) {
            state = { queue: [], acquisitions: new Map() };
            this.workspaces.set(input.workspaceKey, state);
        }
        let resolve!: (lease: WorkspaceWriterLease) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<WorkspaceWriterLease>((done, fail) => {
            resolve = done;
            reject = fail;
        });
        const pending: PendingAcquisition = { key, input, promise, resolve, reject };
        state.acquisitions.set(key, pending);
        state.queue.push(pending);
        if (input.signal) {
            pending.abortListener = () => this.abortQueued(state, pending);
            input.signal.addEventListener("abort", pending.abortListener, { once: true });
        }
        this.grantNext(state);
        return promise;
    }

    grantNext(state: WorkspaceLeaseState): void {
        if (state.active) {
            return;
        }
        const pending = state.queue.shift();
        if (!pending) {
            return;
        }
        this.cleanupAbortListener(pending);
        const lease: WorkspaceWriterLease = {
            workspaceKey: pending.input.workspaceKey,
            sessionId: pending.input.sessionId,
            boundaryToken: pending.input.boundaryToken,
            release: () => {
                if (state.active !== pending) {
                    throw new Error("Only the active workspace writer lease can be released");
                }
                state.acquisitions.delete(pending.key);
                state.active = undefined;
                this.grantNext(state);
            },
        };
        state.active = pending;
        pending.resolve(lease);
    }

    abortQueued(state: WorkspaceLeaseState, pending: PendingAcquisition): void {
        const index = state.queue.indexOf(pending);
        if (index < 0) {
            return;
        }
        state.queue.splice(index, 1);
        if (state.acquisitions.get(pending.key) === pending) {
            state.acquisitions.delete(pending.key);
        }
        this.cleanupAbortListener(pending);
        pending.reject(abortReason(pending.input.signal!));
        this.grantNext(state);
    }

    cleanupAbortListener(pending: PendingAcquisition): void {
        if (!pending.input.signal || !pending.abortListener) {
            return;
        }
        pending.input.signal.removeEventListener("abort", pending.abortListener);
        pending.abortListener = undefined;
    }
}

function assertValidInput(input: WorkspaceWriterLeaseInput): void {
    assertNonEmptyString("workspaceKey", input?.workspaceKey);
    assertNonEmptyString("sessionId", input?.sessionId);
    assertNonEmptyString("boundaryToken", input?.boundaryToken);
}

function assertNonEmptyString(name: string, value: unknown): void {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${name} must be a non-empty string`);
    }
}

function abortReason(signal: AbortSignal): unknown {
    if (signal.reason != null) {
        return signal.reason;
    }
    const error = new Error("Workspace writer lease acquisition aborted");
    error.name = "AbortError";
    return error;
}
