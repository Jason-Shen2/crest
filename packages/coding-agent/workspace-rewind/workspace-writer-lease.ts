// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface WorkspaceWriterLease {
    readonly workspaceKey: string;
    readonly sessionId: string;
    readonly boundaryToken: string;
    release(): void;
}

interface WorkspaceWriterLeaseInput {
    readonly workspaceKey: string;
    readonly sessionId: string;
    readonly boundaryToken: string;
    readonly signal?: AbortSignal;
}

interface PendingAcquisition {
    key: string;
    snapshot: WorkspaceWriterLeaseInput;
    promise: Promise<WorkspaceWriterLease>;
    resolve: (lease: WorkspaceWriterLease) => void;
    reject: (reason: unknown) => void;
    abortListener?: () => void;
}

interface WorkspaceLeaseState {
    readonly workspaceKey: string;
    active?: PendingAcquisition;
    queue: PendingAcquisition[];
    acquisitions: Map<string, PendingAcquisition>;
}

export class WorkspaceWriterLeaseRegistry {
    workspaces = new Map<string, WorkspaceLeaseState>();

    acquire(input: WorkspaceWriterLeaseInput): Promise<WorkspaceWriterLease> {
        const snapshot: WorkspaceWriterLeaseInput = {
            workspaceKey: input?.workspaceKey,
            sessionId: input?.sessionId,
            boundaryToken: input?.boundaryToken,
            signal: input?.signal,
        };
        assertValidInput(snapshot);
        const key = JSON.stringify([snapshot.sessionId, snapshot.boundaryToken]);
        let state = this.workspaces.get(snapshot.workspaceKey);
        const existing = state?.acquisitions.get(key);
        if (existing) {
            return existing.promise;
        }
        if (snapshot.signal?.aborted) {
            return Promise.reject(abortReason(snapshot.signal));
        }
        if (!state) {
            state = { workspaceKey: snapshot.workspaceKey, queue: [], acquisitions: new Map() };
            this.workspaces.set(snapshot.workspaceKey, state);
        }
        let resolve!: (lease: WorkspaceWriterLease) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<WorkspaceWriterLease>((done, fail) => {
            resolve = done;
            reject = fail;
        });
        const pending: PendingAcquisition = { key, snapshot, promise, resolve, reject };
        state.acquisitions.set(key, pending);
        state.queue.push(pending);
        if (snapshot.signal) {
            pending.abortListener = () => this.abortQueued(state, pending);
            snapshot.signal.addEventListener("abort", pending.abortListener, { once: true });
        }
        this.grantNext(state);
        return promise;
    }

    grantNext(state: WorkspaceLeaseState): void {
        if (state.active) {
            return;
        }
        while (true) {
            const pending = state.queue.shift();
            if (!pending) {
                this.deleteIdleState(state.workspaceKey, state);
                return;
            }
            if (pending.snapshot.signal?.aborted) {
                if (state.acquisitions.get(pending.key) === pending) {
                    state.acquisitions.delete(pending.key);
                }
                this.cleanupAbortListener(pending);
                pending.reject(abortReason(pending.snapshot.signal));
                continue;
            }
            this.grant(state, pending);
            return;
        }
    }

    grant(state: WorkspaceLeaseState, pending: PendingAcquisition): void {
        this.cleanupAbortListener(pending);
        const lease: WorkspaceWriterLease = {
            workspaceKey: pending.snapshot.workspaceKey,
            sessionId: pending.snapshot.sessionId,
            boundaryToken: pending.snapshot.boundaryToken,
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
        pending.reject(abortReason(pending.snapshot.signal!));
        this.grantNext(state);
    }

    cleanupAbortListener(pending: PendingAcquisition): void {
        if (!pending.snapshot.signal || !pending.abortListener) {
            return;
        }
        pending.snapshot.signal.removeEventListener("abort", pending.abortListener);
        pending.abortListener = undefined;
    }

    deleteIdleState(workspaceKey: string, state: WorkspaceLeaseState): void {
        if (state.active || state.queue.length > 0 || state.acquisitions.size > 0) {
            return;
        }
        if (this.workspaces.get(workspaceKey) !== state) {
            return;
        }
        this.workspaces.delete(workspaceKey);
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
