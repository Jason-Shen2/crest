// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// StatusBar — direct port of terax-ai/src/modules/statusbar/StatusBar.tsx.
//
// Footer className is verbatim terax:
//   `flex h-8 shrink-0 items-center justify-between gap-3
//    border-t border-border/60 bg-card/60 px-3 text-[11px]`
// (mapped to crest's tailwind tokens; see status-bar.scss for the
// border-bg color values).
//
// Data source mirrors vtab-detail-sidecar.tsx — focused block's meta:
//   file:path (preview) → cmd:cwd (terminal) → empty.
//
// onCd is wired to ControllerInputCommand ("cd <path>\n") for
// focused terminal blocks; no-op otherwise — matches terax's
// terminal-only behavior.

import { CwdBreadcrumb } from "@/app/statusbar/cwd-breadcrumb";
import { atoms, createBlock, getApi, getFocusedBlockId } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import type { LayoutNode } from "@/layout/lib/types";
import { fireAndForget, NullAtom, stringToBase64 } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { quote as shellQuote } from "shell-quote";
import "./status-bar.scss";

export function StatusBar() {
    const tabId = useAtomValue(atoms.staticTabId ?? NullAtom);
    const layoutModel = useMemo(() => (tabId ? getLayoutModelForStaticTab() : null), [tabId]);
    const focusedNodeAtom = layoutModel?.focusedNode ?? NullAtom;
    const focusedNode = useAtomValue(focusedNodeAtom) as LayoutNode | null;
    const focusedBlockId = focusedNode?.data?.blockId ?? null;

    const blockAtom = useMemo(
        () => (focusedBlockId ? WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", focusedBlockId)) : NullAtom),
        [focusedBlockId]
    );
    const block = useAtomValue(blockAtom) as Block | null;

    const home = useMemo(() => {
        try {
            return getApi().getHomeDir() ?? "";
        } catch {
            return "";
        }
    }, []);

    // Priority: file:path (preview) → cmd:cwd (terminal) → empty.
    const filePath = (block?.meta?.["file:path"] as string) || "";
    const cwd = (block?.meta?.["cmd:cwd"] as string) || "";

    // onCd — direct port of FileExplorerModel.cdToDir
    // (frontend/app/fileexplorer/file-explorer-model.ts:374):
    //   1. If a block is focused, inject `cd <quoted>\n` into it via
    //      ControllerInputCommand.
    //   2. Otherwise, open a new term block rooted at the target dir.
    // No view-type gate — file-explorer doesn't gate, and any focused
    // block here is user-chosen.
    const onCd = useCallback((target: string) => {
        const blockId = getFocusedBlockId();
        if (blockId) {
            const cmd = `cd ${shellQuote([target])}\n`;
            fireAndForget(async () => {
                try {
                    await RpcApi.ControllerInputCommand(TabRpcClient, {
                        blockid: blockId,
                        inputdata64: stringToBase64(cmd),
                    });
                } catch (e) {
                    console.log("statusbar cd failed", e);
                }
            });
        } else {
            fireAndForget(async () => {
                try {
                    await createBlock({ meta: { controller: "shell", view: "term", "cmd:cwd": target } });
                } catch (e) {
                    console.log("statusbar createBlock failed", e);
                }
            });
        }
    }, []);

    return (
        <footer className="statusbar-root" aria-label="Workspace status">
            {/* Left region — mirrors terax's `flex min-w-0 flex-1
                items-center gap-2`.  CwdBreadcrumb renders its own
                "no directory" fallback when both cwd and filePath
                are empty, so we always pass it through. */}
            <div className="statusbar-left">
                <CwdBreadcrumb
                    cwd={filePath ? null : cwd || null}
                    filePath={filePath || null}
                    home={home || null}
                    onCd={onCd}
                />
            </div>
            {/* Right region — terax's `flex shrink-0 items-center
                gap-1.5`.  Reserved for future crest chrome
                (LSP status, AI panel toggle, etc.).  Empty for v1
                because those are terax-specific features. */}
            <div className="statusbar-right" />
        </footer>
    );
}
