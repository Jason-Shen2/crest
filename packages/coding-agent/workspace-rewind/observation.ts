// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export function observeSafely(observer: (() => void) | undefined): void {
    try {
        observer?.();
    } catch {
        return;
    }
}
