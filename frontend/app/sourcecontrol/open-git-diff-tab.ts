// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WorkspaceService } from "@/app/store/services";
import * as WOS from "@/app/store/wos";
import { atoms, getApi, globalStore } from "@/store/global";

export type GitDiffMode = "+" | "-";

export type OpenGitDiffTabInput = {
    repoRoot: string;
    path: string;
    mode: GitDiffMode;
    originalPath?: string | null;
};

export type OpenGitDiffTabResult = {
    tabId: string;
    created: boolean;
};

const inFlightGitDiffTabOpens = new Map<string, Promise<OpenGitDiffTabResult>>();

export async function findGitDiffTab(input: OpenGitDiffTabInput): Promise<string | null> {
    const workspace = globalStore.get(atoms.workspace);
    const tabIds = workspace?.tabids ?? [];
    for (const tabId of tabIds) {
        let tab: Tab | null = null;
        try {
            tab = await WOS.loadAndPinWaveObject<Tab>(WOS.makeORef("tab", tabId));
        } catch (e) {
            console.warn("failed to load tab while searching for existing git diff tab", tabId, e);
            continue;
        }
        for (const blockId of tab?.blockids ?? []) {
            let block: Block | null = null;
            try {
                block = await WOS.loadAndPinWaveObject<Block>(WOS.makeORef("block", blockId));
            } catch (e) {
                console.warn("failed to load block while searching for existing git diff tab", blockId, e);
                continue;
            }
            if (isMatchingGitDiffBlock(block, input)) {
                return tabId;
            }
        }
    }
    return null;
}

export async function openGitDiffTab(input: OpenGitDiffTabInput): Promise<OpenGitDiffTabResult> {
    const workspace = globalStore.get(atoms.workspace);
    if (!workspace?.oid) {
        throw new Error("cannot open git diff tab without an active workspace");
    }
    const existingTabId = await findGitDiffTab(input);
    if (existingTabId) {
        getApi().setActiveTab(existingTabId);
        return { tabId: existingTabId, created: false };
    }
    const inFlightKey = getInFlightGitDiffTabOpenKey(input, workspace.oid);
    const inFlightOpen = inFlightGitDiffTabOpens.get(inFlightKey);
    if (inFlightOpen) {
        return inFlightOpen;
    }
    const meta: MetaType = {
        view: "gitdiff",
        "gitdiff:repo": input.repoRoot,
        "gitdiff:path": input.path,
        "gitdiff:mode": input.mode,
        "gitdiff:originalpath": input.originalPath ?? "",
        connection: "",
    };
    const openPromise = (async (): Promise<OpenGitDiffTabResult> => {
        const tabId = await WorkspaceService.CreateTabWithBlock(workspace.oid, "", false, {
            meta: {
                ...meta,
            },
        });
        getApi().setActiveTab(tabId);
        return { tabId, created: true };
    })();
    inFlightGitDiffTabOpens.set(inFlightKey, openPromise);
    try {
        return await openPromise;
    } finally {
        if (inFlightGitDiffTabOpens.get(inFlightKey) === openPromise) {
            inFlightGitDiffTabOpens.delete(inFlightKey);
        }
    }
}

function isMatchingGitDiffBlock(block: Block | null, input: OpenGitDiffTabInput): boolean {
    return (
        block?.meta?.view === "gitdiff" &&
        block.meta["gitdiff:repo"] === input.repoRoot &&
        block.meta["gitdiff:path"] === input.path &&
        block.meta["gitdiff:mode"] === input.mode &&
        ((block.meta["gitdiff:originalpath"] as string) || "") === (input.originalPath ?? "")
    );
}

function getInFlightGitDiffTabOpenKey(input: OpenGitDiffTabInput, workspaceId: string): string {
    return JSON.stringify([workspaceId, input.repoRoot, input.path, input.mode, input.originalPath ?? ""]);
}
