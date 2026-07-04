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
import { atoms, getApi } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import type { LayoutNode } from "@/layout/lib/types";
import { fireAndForget, NullAtom } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import "./status-bar.scss";

export function StatusBar() {
    const tabId = useAtomValue(atoms.staticTabId);
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

    // onCd — wire to a terminal-cd only when the focused block is a
    // term/termblocks.  File preview + other views: no-op.
    const isTermFocused = (block?.meta?.view === "term" || block?.meta?.view === "termblocks") && !!focusedBlockId;
    const onCd = useCallback(
        (target: string) => {
            if (!isTermFocused || !focusedBlockId) return;
            fireAndForget(async () => {
                try {
                    await RpcApi.ControllerInputCommand(TabRpcClient, {
                        blockid: focusedBlockId,
                        inputdata64: Buffer.from(`cd ${target}\n`, "utf8").toString("base64"),
                    });
                } catch (e) {
                    console.log("statusbar cd failed", e);
                }
            });
        },
        [isTermFocused, focusedBlockId]
    );

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
