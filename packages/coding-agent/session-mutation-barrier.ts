// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export class SessionMutationBarrier {
    tail: Promise<void> = Promise.resolve();
    pendingCount = 0;
    idleWaiters = new Set<() => void>();

    constructor(readonly onIdle?: () => void) {}

    isBusy(): boolean {
        return this.pendingCount > 0;
    }

    run<T>(operation: () => Promise<T>): Promise<T> {
        this.pendingCount++;
        const previous = this.tail;
        let result: Promise<T>;
        if (this.pendingCount === 1) {
            result = callOperation(operation);
        } else {
            result = previous.then(operation);
        }
        const settled = result.then(
            () => undefined,
            () => undefined
        );
        this.tail = settled;
        settled.finally(() => {
            this.pendingCount--;
            if (this.pendingCount !== 0) {
                return;
            }
            const waiters = [...this.idleWaiters];
            this.idleWaiters.clear();
            for (const waiter of waiters) {
                waiter();
            }
            this.onIdle?.();
        });
        return result;
    }

    async waitForIdle(): Promise<void> {
        if (!this.isBusy()) {
            return;
        }
        await new Promise<void>((resolve) => {
            this.idleWaiters.add(resolve);
        });
    }
}

function callOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return Promise.resolve(operation());
    } catch (error) {
        return Promise.reject(error);
    }
}
