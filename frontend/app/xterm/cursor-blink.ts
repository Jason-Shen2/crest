// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export function shouldCursorBlink(blinkEnabled: boolean, windowActive: boolean, slotFocused: boolean): boolean {
    return blinkEnabled && windowActive && slotFocused;
}
