// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mouseReportingActive, type BlockLifecycleState, type TermMode } from "../engine/types";

// Mirrors Warp's LONG_RUNNING_COMMAND_DURATION_MS. Once the foreground command
// crosses this threshold, input belongs to the PTY rather than Crest's editor.
export const LONG_RUNNING_COMMAND_DURATION_MS = 50;

export function terminalCaptureActive(mode: TermMode | null | undefined): boolean {
    if (!mode) return false;
    return (
        mode.appCursor ||
        mode.appKeypad ||
        mode.focusReport ||
        mode.alternateScroll ||
        mouseReportingActive(mode) ||
        mode.kittyKeyboardFlags !== 0
    );
}

export function blockIsActiveTuiSurface(
    block: {
        state: BlockLifecycleState;
        altScreen: { active: boolean };
        durationMs?: () => number | undefined;
    },
    mode: TermMode | null | undefined
): boolean {
    const isRunning = block.state === "running";
    const isLongRunning = isRunning && (block.durationMs?.() ?? 0) > LONG_RUNNING_COMMAND_DURATION_MS;
    return block.altScreen.active || (isRunning && terminalCaptureActive(mode)) || isLongRunning;
}
