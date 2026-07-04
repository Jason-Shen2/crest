// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// list-subdirs — RPC wrapper used by the cwd breadcrumb's subfolder
// dropdown (mirrors terax-ai's `invoke("list_subdirs", …)` call).
//
// Wired to crest's `FileListCommand` (wshcmd `filelist`) which returns
// all entries under `path`; we filter to directories and return their
// names sorted alphabetically (case-insensitive, matching `ls`).

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";

export type ListSubdirsOpts = {
    /** Include dot-prefixed entries.  Default false. */
    showHidden?: boolean;
    /** Reserved for forward-compat — crest currently has no per-
     *  workspace / per-connection scoping for this RPC. */
    workspace?: string;
};

/**
 * List the immediate subdirectories of `path`.  Returns a sorted
 * array of names (no full paths, no slash suffix).  Throws on
 * permission errors / non-existent dirs so the caller can render
 * an error state.
 *
 * Wire-up:
 *   - Backend:  `FileListCommand` (wshcmd `filelist`, handler at
 *               pkg/wshrpc/wshserver/wshserver.go:372 → wshfs.ListEntries).
 *   - Frontend: `RpcApi.FileListCommand` (TS binding at
 *               frontend/app/store/wshclientapi.ts:352).
 *
 * The handler runs locally; remote connections aren't routed through
 * here because the cwd breadcrumb is tied to a local terminal block.
 * If we later want to support remote / WSL, swap the call for
 * `RemoteListEntriesCommand` and gate on `opts.workspace`.
 */
export async function listSubdirsRpc(path: string, opts: ListSubdirsOpts = {}): Promise<string[]> {
    const showHidden = opts.showHidden ?? false;
    const entries = await RpcApi.FileListCommand(
        TabRpcClient,
        {
            path,
            opts: { all: showHidden },
        },
        { timeout: 5000 }
    );
    const dirs = entries
        .filter((e) => e.isdir && e.name)
        .map((e) => e.name as string)
        // case-insensitive sort, matching `ls` default
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return dirs;
}
