// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// _pty-screen.ts — renderer screen-snapshot seam for pty_read's screen
// branch. The subagent command block is a top-level term block, so its
// grid lives in the tab's renderer TerminalModel; we resolve the tab's
// webContents from the block id and query it via webPtyScreenSnapshot.
// Throws when the renderer has no live snapshot so pty_read degrades to
// the transcript tail (spec §3a fallback). Mirrors Warp's
// LongRunningCommandSnapshot.

import { RpcApi } from "@/app/store/wshclientapi";
import { ElectronWshClient } from "../../emain-wsh";

export interface ScreenSnapshot {
    grid_contents: string;
    cursor: string;
    is_alt_screen_active: boolean;
    block_id: string;
}

export async function getScreenSnapshot(blockId: string): Promise<ScreenSnapshot> {
    // Lazy-import the electron-touching modules: emain-tabview →
    // emain-platform runs app.setName() at load, which blows up under
    // vitest's node runtime. Deferring the require keeps merely importing
    // this seam (via the tool index) side-effect free for tests.
    const { webPtyScreenSnapshot } = await import("../../emain-web");
    const { getWaveTabView } = await import("../../emain-tabview");
    // Resolve the tab that owns this command block, then its live renderer.
    const info = await RpcApi.BlockInfoCommand(ElectronWshClient, blockId);
    const tabView = getWaveTabView(info.tabid);
    const wc = tabView?.webContents;
    if (!wc) {
        throw new Error(`no renderer found for block ${blockId}`);
    }
    const snap = await webPtyScreenSnapshot(wc, blockId);
    if (!snap) {
        throw new Error(`no screen snapshot available for block ${blockId}`);
    }
    return snap;
}
