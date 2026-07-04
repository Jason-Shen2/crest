// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WorkspaceService } from "@/app/store/services";
import * as WOS from "@/app/store/wos";
import { atoms, globalStore } from "@/store/global";

export type OpenFileInEditorTabResult = {
    tabId: string;
    created: boolean;
};

function getBlockForId(blockId: string): Block | null {
    return globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId))) ?? null;
}

function getTabForId(tabId: string): Tab | null {
    return globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId))) ?? null;
}

export function findEditorTabForPath(path: string): string | null {
    const workspace = globalStore.get(atoms.workspace);
    const tabIds = workspace?.tabids ?? [];
    for (const tabId of tabIds) {
        const tab = getTabForId(tabId);
        for (const blockId of tab?.blockids ?? []) {
            const block = getBlockForId(blockId);
            if (block?.meta?.view === "codeeditor" && block.meta.file === path) {
                return tabId;
            }
        }
    }
    return null;
}

export async function openFileInEditorTab(path: string): Promise<OpenFileInEditorTabResult> {
    const workspace = globalStore.get(atoms.workspace);
    if (!workspace?.oid) {
        throw new Error("cannot open editor tab without an active workspace");
    }
    const existingTabId = findEditorTabForPath(path);
    if (existingTabId) {
        await WorkspaceService.SetActiveTab(workspace.oid, existingTabId);
        return { tabId: existingTabId, created: false };
    }
    const tabId = await WorkspaceService.CreateTabWithBlock(workspace.oid, "", true, {
        meta: {
            view: "codeeditor",
            file: path,
            connection: "",
        },
    });
    return { tabId, created: true };
}
