// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    BlockId,
    BlockKind,
    BlockLifecycleState,
    mouseReportingActive,
    TermMode,
} from "./types";

export const LONG_RUNNING_COMMAND_DURATION_MS = 50;

export type TerminalInputState =
    | { kind: "not-bootstrapped" }
    | { kind: "input-editor" }
    | { kind: "long-running-command"; blockId: BlockId }
    | { kind: "alt-screen"; blockId: BlockId }
    | { kind: "terminal-capture"; blockId: BlockId };

export interface TerminalStateBlock {
    id: BlockId;
    kind?: BlockKind;
    state: BlockLifecycleState;
    altScreen: { active: boolean };
    durationMs?: () => number | undefined;
}

export interface DeriveTerminalInputStateOpts {
    loading?: boolean;
    blocks: readonly TerminalStateBlock[];
    mode: TermMode | null | undefined;
}

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

export function deriveTerminalInputState(opts: DeriveTerminalInputStateOpts): TerminalInputState {
    if (opts.loading) {
        return { kind: "not-bootstrapped" };
    }

    for (let i = opts.blocks.length - 1; i >= 0; i--) {
        const block = opts.blocks[i];
        if (block.kind === "agent") continue;
        if (block.altScreen.active) {
            return { kind: "alt-screen", blockId: block.id };
        }
    }

    const running = findActiveRunningBlock(opts.blocks);
    if (!running) {
        return { kind: "input-editor" };
    }
    if (terminalCaptureActive(opts.mode)) {
        return { kind: "terminal-capture", blockId: running.id };
    }
    if ((running.durationMs?.() ?? 0) > LONG_RUNNING_COMMAND_DURATION_MS) {
        return { kind: "long-running-command", blockId: running.id };
    }
    return { kind: "input-editor" };
}

function findActiveRunningBlock(blocks: readonly TerminalStateBlock[]): TerminalStateBlock | null {
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block.kind === "agent") continue;
        if (block.state === "running") return block;
    }
    return null;
}
