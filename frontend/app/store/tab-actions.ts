// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms, globalStore, refocusNode, WOS } from "@/app/store/global";
import { sendWorkspaceCommand } from "@/app/store/workspace-command-client";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { isBuilderWindow } from "./windowtype";

function closeStaticTab(): void {
    sendWorkspaceCommand({ type: "close-active" });
}

export function uxCloseBlock(blockId: string): void {
    const tabId = globalStore.get(atoms.staticTabId);
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    if (tab?.blockids?.length === 1) {
        closeStaticTab();
        return;
    }
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel.getNodeByBlockId(blockId);
    if (node != null) {
        fireAndForget(() => layoutModel.closeNode(node.id));
    }
}

export function globalRefocus(): void {
    if (isBuilderWindow()) {
        return;
    }
    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = globalStore.get(layoutModel.focusedNode);
    if (focusedNode == null) {
        layoutModel.focusFirstNode();
        return;
    }
    const blockId = focusedNode.data?.blockId;
    if (blockId != null) {
        refocusNode(blockId);
    }
}

export function globalRefocusWithTimeout(timeoutMs: number): void {
    setTimeout(globalRefocus, timeoutMs);
}
