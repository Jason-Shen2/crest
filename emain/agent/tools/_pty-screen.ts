// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// _pty-screen.ts — renderer screen-snapshot seam for pty_read's screen
// branch. Wired to the renderer in Task 11. Until then it throws so
// pty_read degrades to transcript tail (spec §3a fallback).

export interface ScreenSnapshot {
    grid_contents: string;
    cursor: string;
    is_alt_screen_active: boolean;
    block_id: string;
}

export async function getScreenSnapshot(_blockId: string): Promise<ScreenSnapshot> {
    throw new Error("screen snapshot not implemented (Task 11)");
}
