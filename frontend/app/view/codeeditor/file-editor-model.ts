// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { FileExplorerModel } from "@/app/fileexplorer/file-explorer-model";
import { MonacoModelRegistry } from "@/app/righteditor/monaco-model-registry";
import { pathToFileUri } from "@/app/righteditor/right-editor-model";
import { getRightEditorLanguage } from "@/app/righteditor/right-editor-language";
import { RightEditorProductionRpc } from "@/app/righteditor/right-editor-rpc";
import type { RightEditorSaveStatus } from "@/app/righteditor/right-editor-types";
import { getAllBlockComponentModels } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import type { TabModel } from "@/app/store/tab-model";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { getBlockMetaKeyAtom } from "@/store/global";
import * as jotai from "jotai";
import { FileEditorView } from "./file-editor-view";

// A single-file, LSP-backed code editor bound to one block. Mirrors the right
// panel's RightEditorWorkbench (Monaco + language intelligence), but each crest
// tab holds exactly one file, so state lives per-block instead of in the
// multi-file RightEditorModel singleton.
export class FileEditorViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;

    filePathAtom: jotai.Atom<string>;
    viewIcon: jotai.Atom<string>;
    viewName: jotai.Atom<string>;
    noPadding: jotai.Atom<boolean>;
    hideViewName: jotai.Atom<boolean>;

    // Per-file editing state.
    savedTextAtom: jotai.PrimitiveAtom<string>;
    dirtyTextAtom: jotai.PrimitiveAtom<string | null>;
    readonlyAtom: jotai.PrimitiveAtom<boolean>;
    saveStatusAtom: jotai.PrimitiveAtom<RightEditorSaveStatus>;
    errorAtom: jotai.PrimitiveAtom<string | null>;
    loadedAtom: jotai.PrimitiveAtom<boolean>;
    workspaceRoot: string;

    private loadedPath: string | null = null;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.viewType = "codeeditor";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.workspaceRoot = FileExplorerModel.getInstance().getRootNow() ?? "";

        this.filePathAtom = getBlockMetaKeyAtom(blockId, "file") as jotai.Atom<string>;
        this.savedTextAtom = jotai.atom("");
        this.dirtyTextAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        this.readonlyAtom = jotai.atom(false);
        this.saveStatusAtom = jotai.atom("idle") as jotai.PrimitiveAtom<RightEditorSaveStatus>;
        this.errorAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        this.loadedAtom = jotai.atom(false);
        this.noPadding = jotai.atom(true);
        this.hideViewName = jotai.atom(true);
        this.viewIcon = jotai.atom("file-code");
        this.viewName = jotai.atom((get) => {
            const path = get(this.filePathAtom);
            return path ? basename(path) : "Editor";
        });
    }

    getFilePathNow(): string {
        return globalStore.get(this.filePathAtom) ?? "";
    }

    getLanguage(): string {
        return getRightEditorLanguage(this.getFilePathNow());
    }

    getFileUri(): string {
        return pathToFileUri(this.getFilePathNow());
    }

    getText(): string {
        const dirty = globalStore.get(this.dirtyTextAtom);
        return dirty ?? globalStore.get(this.savedTextAtom);
    }

    async loadFile(): Promise<void> {
        const path = this.getFilePathNow();
        if (!path || this.loadedPath === path) return;
        this.loadedPath = path;
        try {
            const file = await RightEditorProductionRpc.readFile(path);
            globalStore.set(this.savedTextAtom, file.text);
            globalStore.set(this.dirtyTextAtom, null);
            globalStore.set(this.readonlyAtom, file.readonly);
            globalStore.set(this.errorAtom, null);
            globalStore.set(this.loadedAtom, true);
        } catch (e: unknown) {
            globalStore.set(this.errorAtom, e instanceof Error ? e.message : String(e));
            globalStore.set(this.loadedAtom, true);
        }
    }

    updateText(text: string): void {
        const saved = globalStore.get(this.savedTextAtom);
        const saveStatus = globalStore.get(this.saveStatusAtom);
        globalStore.set(this.dirtyTextAtom, text === saved && saveStatus !== "saving" ? null : text);
    }

    async saveFile(): Promise<void> {
        const path = this.getFilePathNow();
        const dirtyText = globalStore.get(this.dirtyTextAtom);
        if (!path || dirtyText == null || globalStore.get(this.readonlyAtom)) return;
        globalStore.set(this.saveStatusAtom, "saving");
        globalStore.set(this.errorAtom, null);
        try {
            await RightEditorProductionRpc.writeFile(path, dirtyText);
            globalStore.set(this.savedTextAtom, dirtyText);
            if (globalStore.get(this.dirtyTextAtom) === dirtyText) {
                globalStore.set(this.dirtyTextAtom, null);
            }
            globalStore.set(this.saveStatusAtom, "saved");
        } catch (e: unknown) {
            globalStore.set(this.saveStatusAtom, "error");
            globalStore.set(this.errorAtom, e instanceof Error ? e.message : String(e));
        }
    }

    get viewComponent(): ViewComponent {
        return FileEditorView;
    }

    // Point this editor at newPath after the file (or an ancestor dir) was
    // renamed on disk. Rewrites block meta so filePathAtom follows the move and
    // migrates the Monaco model to the new URI.
    handleFileRenamed(oldPath: string, newPath: string): void {
        const path = this.getFilePathNow();
        if (!path || !isPathOrChild(path, oldPath)) return;
        const nextPath = replacePathPrefix(path, oldPath, newPath);
        if (this.loadedPath === path) {
            MonacoModelRegistry.getInstance().migratePath(path, nextPath);
            this.loadedPath = nextPath;
        }
        fireAndForget(() =>
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("block", this.blockId),
                meta: { file: nextPath },
            })
        );
    }

    // The file (or an ancestor dir) was deleted; close this editor tab.
    handleFileDeleted(path: string): void {
        const filePath = this.getFilePathNow();
        if (!filePath || !isPathOrChild(filePath, path)) return;
        this.nodeModel.onClose();
    }

    dispose(): void {
        const path = this.loadedPath;
        if (path) {
            MonacoModelRegistry.getInstance().disposePath(path);
        }
    }

    // Notify every open code-editor block that a file moved on disk.
    static handleFileRenamed(oldPath: string, newPath: string): void {
        for (const model of getAllFileEditorViewModels()) {
            model.handleFileRenamed(oldPath, newPath);
        }
    }

    // Notify every open code-editor block that a file was deleted on disk.
    static handleFileDeleted(path: string): void {
        for (const model of getAllFileEditorViewModels()) {
            model.handleFileDeleted(path);
        }
    }
}

function getAllFileEditorViewModels(): FileEditorViewModel[] {
    return getAllBlockComponentModels()
        .map((bcm) => bcm?.viewModel)
        .filter((viewModel): viewModel is FileEditorViewModel => viewModel instanceof FileEditorViewModel);
}

function isPathOrChild(path: string, targetPath: string): boolean {
    return path === targetPath || path.startsWith(`${targetPath}/`);
}

function replacePathPrefix(path: string, oldPrefix: string, newPrefix: string): string {
    if (path === oldPrefix) return newPrefix;
    return `${newPrefix}${path.slice(oldPrefix.length)}`;
}

function basename(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    const idx = normalized.lastIndexOf("/");
    return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}
