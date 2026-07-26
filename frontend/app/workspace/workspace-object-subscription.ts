// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export class WorkspaceObjectSubscription {
    unsubscribe: () => void;

    replace(unsubscribe: () => void): void {
        this.clear();
        this.unsubscribe = unsubscribe;
    }

    clear(): void {
        const unsubscribe = this.unsubscribe;
        this.unsubscribe = undefined;
        unsubscribe?.();
    }
}
