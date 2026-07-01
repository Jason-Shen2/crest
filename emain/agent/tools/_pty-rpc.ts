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
