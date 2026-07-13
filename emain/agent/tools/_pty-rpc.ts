// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// _pty-rpc.ts — thin wrappers over the wshrpc channel the CLI subagent's
// PTY tools use. Keeps RPC plumbing out of the tool bodies so tools stay
// testable with a mocked RpcApi. See spec §2.4 decisions 2, 3, 5.

import { RpcApi } from "@/app/store/wshclientapi";
import { ElectronWshClient } from "../../emain-wsh";

/** Write raw bytes to a running block's PTY (ControllerInput → Go SendInput). */
export async function sendControllerInput(blockId: string, input: string): Promise<void> {
    await RpcApi.ControllerInputCommand(ElectronWshClient, {
        blockid: blockId,
        inputdata64: Buffer.from(input, "utf8").toString("base64"),
    });
}

export interface CmdBlockTail {
    text: string;
    isrunning: boolean;
    exitcode?: number;
    altscreen: boolean;
}

/** Read the recent transcript tail + running/exit/alt-screen status. */
export async function getCmdBlockTail(
    blockId: string,
    opts?: { oid?: string; maxLines?: number; maxBytes?: number },
): Promise<CmdBlockTail> {
    return RpcApi.GetCmdBlockTailCommand(ElectronWshClient, {
        blockid: blockId,
        oid: opts?.oid,
        maxlines: opts?.maxLines,
        maxbytes: opts?.maxBytes,
    }) as Promise<CmdBlockTail>;
}

/**
 * Start a term block that RUNS `command` in `cwd` (controller:"cmd"), on the
 * same tab as the parent terminal block. Returns the new block's bare id.
 *
 * Verified RPC surface (Task 10 Step 1):
 *  - CreateBlockCommand requires `tabid`; resolve it from the parent block via
 *    BlockInfoCommand. It returns an ORef string "block:<uuid>" — split off the id.
 *  - controller:"cmd" + MetaKey_Cmd runs a one-shot command (see wshcmd-run.go).
 *  - There is no `source` meta key; do not set one.
 */
export async function startAgentCommandBlock(
    parentBlockId: string,
    cwd: string,
    command: string,
): Promise<string> {
    const info = await RpcApi.BlockInfoCommand(ElectronWshClient, parentBlockId);
    const oref = await RpcApi.CreateBlockCommand(ElectronWshClient, {
        tabid: info.tabid,
        focused: true,
        blockdef: {
            meta: {
                view: "term",
                controller: "cmd",
                "cmd:cwd": cwd,
                cmd: command,
                "cmd:runonce": true,
                "cmd:runonstart": true,
            },
        },
    });
    const sep = oref.indexOf(":");
    const blockId = sep >= 0 ? oref.slice(sep + 1) : oref;
    try {
        await RpcApi.ControllerResyncCommand(ElectronWshClient, {
            tabid: info.tabid,
            blockid: blockId,
        });
    } catch (err) {
        await RpcApi.DeleteBlockCommand(ElectronWshClient, { blockid: blockId });
        throw err;
    }
    return blockId;
}

/** Stop and remove a failed/aborted delegated command block. */
export async function stopBlock(blockId: string): Promise<void> {
    try {
        await RpcApi.ControllerDestroyCommand(ElectronWshClient, blockId);
    } finally {
        await RpcApi.DeleteBlockCommand(ElectronWshClient, { blockid: blockId });
    }
}
