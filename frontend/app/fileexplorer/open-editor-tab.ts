// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WorkspaceService } from "@/app/store/services";
import * as WOS from "@/app/store/wos";
import { atoms, getApi, globalStore } from "@/store/global";

export type OpenFileInEditorTabResult = {
    tabId: string;
    created: boolean;
};

export type OpenFileInEditorTabOptions = {
    workspaceRoot?: string;
    cwd?: string;
};

export async function findEditorTabForPath(path: string): Promise<string | null> {
    const workspace = globalStore.get(atoms.workspace);
    const tabIds = workspace?.tabids ?? [];
    for (const tabId of tabIds) {
        const tab = await WOS.loadAndPinWaveObject<Tab>(WOS.makeORef("tab", tabId));
        for (const blockId of tab?.blockids ?? []) {
            const block = await WOS.loadAndPinWaveObject<Block>(WOS.makeORef("block", blockId));
            if (block?.meta?.view === "codeeditor" && block.meta.file === path) {
                return tabId;
            }
        }
    }
    return null;
}

export async function openFileInEditorTab(
    path: string,
    opts: OpenFileInEditorTabOptions = {}
): Promise<OpenFileInEditorTabResult> {
    const workspace = globalStore.get(atoms.workspace);
    if (!workspace?.oid) {
        throw new Error("cannot open editor tab without an active workspace");
    }
    const existingTabId = await findEditorTabForPath(path);
    if (existingTabId) {
        getApi().setActiveTab(existingTabId);
        return { tabId: existingTabId, created: false };
    }
    const cwd = opts.cwd ?? opts.workspaceRoot;
    const meta: MetaType = {
        view: "codeeditor",
        file: path,
        connection: "",
    };
    if (cwd) {
        meta["cmd:cwd"] = cwd;
    }
    const tabId = await WorkspaceService.CreateTabWithBlock(workspace.oid, "", false, {
        meta: {
            ...meta,
        },
    });
    getApi().setActiveTab(tabId);
    return { tabId, created: true };
}
