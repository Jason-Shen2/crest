// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TopTab } from "./workspace-content-state";

export type TopTabCloseDecision = "save" | "discard" | "cancel";

export interface TopTabCloseRequest {
    topTabId: string;
    title: string;
}

export interface TopTabCloseCoordinator {
    close(topTabId: string): Promise<boolean>;
    prepareWorkspaceClose(): Promise<boolean>;
    prepareFileMutation(topTabId: string): Promise<boolean>;
    prepareFileMutations(topTabIds: readonly string[]): Promise<boolean>;
    prepareFileMutationsSession(topTabIds: readonly string[]): Promise<PreparedTopTabCloseSession>;
    prepareWorkspaceCloseSession(): Promise<PreparedTopTabCloseSession>;
}

export interface PreparedTopTabCloseSession {
    commit(): void;
    rollback(): void;
}

interface ClosableFileRuntime {
    savedValue: string;
    setValue?(value: string): void;
    discard?(): void;
    save(): Promise<void>;
    getSnapshot(): { dirty: boolean; title: string };
    captureClosePreparationState(): unknown;
    restoreClosePreparationState(state: unknown): void;
}

interface CloseModel {
    closeTopTab(topTabId: string): void;
    flush(): Promise<void>;
}

interface CloseCoordinatorOptions {
    model: CloseModel;
    getTopTabs(): readonly TopTab[];
    getFileRuntime(topTabId: string): ClosableFileRuntime;
    requestDecision(request: TopTabCloseRequest): Promise<TopTabCloseDecision>;
    closeRuntime?(topTabId: string): Promise<void> | void;
}

export function makeTopTabCloseCoordinator(options: CloseCoordinatorOptions): TopTabCloseCoordinator {
    const pendingClose = new Map<string, Promise<boolean>>();
    let operationTail = Promise.resolve();

    async function acquire(): Promise<() => void> {
        const previous = operationTail;
        let release: () => void;
        operationTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        return release;
    }

    async function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const release = await acquire();
        try {
            return await operation();
        } finally {
            release();
        }
    }

    async function prepareTransaction(
        topTabIds: readonly string[],
        flush: boolean
    ): Promise<{ allowed: boolean; rollback(): void }> {
        let rollback: { runtime: ClosableFileRuntime; state: unknown }[] = [];
        const restore = () => {
            for (const { runtime, state } of rollback) {
                try {
                    runtime.restoreClosePreparationState(state);
                } catch {
                    // Best-effort continuation ensures one broken runtime cannot prevent restoration of the others.
                }
            }
        };
        try {
            const entries = options
                .getTopTabs()
                .filter((tab) => tab.kind === "file" && topTabIds.includes(tab.id))
                .map((tab) => ({ tab, runtime: options.getFileRuntime(tab.id) }))
                .filter((entry): entry is { tab: TopTab; runtime: ClosableFileRuntime } =>
                    Boolean(entry.runtime?.getSnapshot().dirty)
                );
            const decisions: { runtime: ClosableFileRuntime; decision: TopTabCloseDecision }[] = [];
            for (const entry of entries) {
                const decision = await options.requestDecision({
                    topTabId: entry.tab.id,
                    title: entry.runtime.getSnapshot().title || entry.tab.title,
                });
                decisions.push({ runtime: entry.runtime, decision });
            }
            if (decisions.some(({ decision }) => decision === "cancel")) {
                return { allowed: false, rollback: () => {} };
            }
            for (const { runtime, decision } of decisions) {
                if (decision === "save") {
                    await runtime.save();
                    if (runtime.getSnapshot().dirty) {
                        throw new Error("File changed while save was in flight");
                    }
                }
            }
            rollback = decisions
                .filter(({ decision }) => decision === "discard")
                .map(({ runtime }) => ({ runtime, state: runtime.captureClosePreparationState() }));
            for (const { runtime, decision } of decisions) {
                if (decision !== "discard") {
                    continue;
                }
                if (runtime.discard) {
                    runtime.discard();
                } else {
                    runtime.setValue?.(runtime.savedValue);
                }
            }
            if (flush && decisions.some(({ decision }) => decision === "discard")) {
                await options.model.flush();
            }
            return { allowed: true, rollback: restore };
        } catch {
            restore();
            return { allowed: false, rollback: () => {} };
        }
    }

    async function prepare(topTabIds: readonly string[], flush: boolean): Promise<boolean> {
        return (await prepareTransaction(topTabIds, flush)).allowed;
    }

    async function closeRuntimeSafely(topTabId: string): Promise<void> {
        try {
            await options.closeRuntime?.(topTabId);
        } catch {
            // Descriptor close has already succeeded, so runtime cleanup is best-effort.
        }
    }

    return {
        close(topTabId) {
            const current = pendingClose.get(topTabId);
            if (current) {
                return current;
            }
            const closing = runExclusive(async () => {
                const transaction = await prepareTransaction([topTabId], false);
                if (transaction.allowed) {
                    try {
                        options.model.closeTopTab(topTabId);
                    } catch {
                        transaction.rollback();
                        return false;
                    }
                    await closeRuntimeSafely(topTabId);
                }
                return transaction.allowed;
            }).finally(() => pendingClose.delete(topTabId));
            pendingClose.set(topTabId, closing);
            return closing;
        },
        prepareWorkspaceClose() {
            return runExclusive(() =>
                prepare(
                    options.getTopTabs().map((tab) => tab.id),
                    true
                )
            );
        },
        prepareFileMutation(topTabId) {
            return runExclusive(() => prepare([topTabId], false));
        },
        prepareFileMutations(topTabIds) {
            return runExclusive(() => prepare(topTabIds, false));
        },
        async prepareFileMutationsSession(topTabIds) {
            const release = await acquire();
            const transaction = await prepareTransaction(topTabIds, false);
            if (!transaction.allowed) {
                release();
                return undefined;
            }
            let finalized = false;
            return {
                commit() {
                    if (finalized) return;
                    finalized = true;
                    release();
                },
                rollback() {
                    if (finalized) return;
                    finalized = true;
                    transaction.rollback();
                    release();
                },
            };
        },
        async prepareWorkspaceCloseSession() {
            const release = await acquire();
            const transaction = await prepareTransaction(
                options.getTopTabs().map((tab) => tab.id),
                true
            );
            if (!transaction.allowed) {
                release();
                return undefined;
            }
            let finalized = false;
            return {
                commit() {
                    if (finalized) {
                        return;
                    }
                    finalized = true;
                    release();
                },
                rollback() {
                    if (finalized) {
                        return;
                    }
                    finalized = true;
                    transaction.rollback();
                    release();
                },
            };
        },
    };
}
