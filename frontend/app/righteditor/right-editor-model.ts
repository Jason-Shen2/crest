// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";
import { getRightEditorLanguage } from "./right-editor-language";
import type { RightEditorOpenFile, RightEditorState } from "./right-editor-types";

type RightEditorRpc = {
    readFile: (path: string) => Promise<{ text: string; readonly: boolean }>;
    writeFile: (path: string, text: string) => Promise<void>;
};

function pathToFileUri(path: string): string {
    return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

export class RightEditorModel {
    private static instance: RightEditorModel | null = null;
    readonly stateAtom: jotai.PrimitiveAtom<RightEditorState>;
    private readonly rpc: RightEditorRpc;
    private readonly pendingOpenFiles = new Map<string, Promise<void>>();

    private constructor(rpc: RightEditorRpc) {
        this.rpc = rpc;
        this.stateAtom = jotai.atom({
            openFiles: [],
            activePath: null,
            workspaceRoot: "",
        });
    }

    static getInstance(rpc?: RightEditorRpc): RightEditorModel {
        if (!RightEditorModel.instance) {
            if (!rpc) throw new Error("RightEditorModel requires rpc on first construction");
            RightEditorModel.instance = new RightEditorModel(rpc);
        }
        return RightEditorModel.instance;
    }

    static resetInstance(): void {
        RightEditorModel.instance = null;
    }

    getStateNow(): RightEditorState {
        return globalStore.get(this.stateAtom);
    }

    getOpenFileNow(path: string): RightEditorOpenFile | undefined {
        return this.getStateNow().openFiles.find((file) => file.path === path);
    }

    async openFile(path: string, workspaceRoot: string): Promise<void> {
        const existing = this.getOpenFileNow(path);
        if (existing) {
            globalStore.set(this.stateAtom, { ...this.getStateNow(), activePath: path, workspaceRoot });
            return;
        }
        const pendingOpen = this.pendingOpenFiles.get(path);
        if (pendingOpen) {
            await pendingOpen;
            if (this.getOpenFileNow(path)) {
                globalStore.set(this.stateAtom, { ...this.getStateNow(), activePath: path, workspaceRoot });
            }
            return;
        }
        const openPromise = this.readAndOpenFile(path, workspaceRoot);
        this.pendingOpenFiles.set(path, openPromise);
        try {
            await openPromise;
        } finally {
            if (this.pendingOpenFiles.get(path) === openPromise) {
                this.pendingOpenFiles.delete(path);
            }
        }
    }

    private async readAndOpenFile(path: string, workspaceRoot: string): Promise<void> {
        const file = await this.rpc.readFile(path);
        if (this.getOpenFileNow(path)) {
            globalStore.set(this.stateAtom, { ...this.getStateNow(), activePath: path, workspaceRoot });
            return;
        }
        const openFile: RightEditorOpenFile = {
            path,
            uri: pathToFileUri(path),
            language: getRightEditorLanguage(path),
            readonly: file.readonly,
            savedText: file.text,
            dirtyText: null,
            saveStatus: "idle",
            error: null,
        };
        const state = this.getStateNow();
        globalStore.set(this.stateAtom, {
            openFiles: [...state.openFiles, openFile],
            activePath: path,
            workspaceRoot,
        });
    }

    selectFile(path: string): void {
        if (!this.getOpenFileNow(path)) return;
        globalStore.set(this.stateAtom, { ...this.getStateNow(), activePath: path });
    }

    updateText(path: string, text: string): void {
        const state = this.getStateNow();
        globalStore.set(this.stateAtom, {
            ...state,
            openFiles: state.openFiles.map((file) =>
                file.path === path
                    ? { ...file, dirtyText: text === file.savedText && file.saveStatus !== "saving" ? null : text }
                    : file
            ),
        });
    }

    async saveFile(path: string): Promise<void> {
        const file = this.getOpenFileNow(path);
        if (!file || file.dirtyText == null || file.readonly) return;
        const textToSave = file.dirtyText;
        this.patchFile(path, { saveStatus: "saving", error: null });
        try {
            await this.rpc.writeFile(path, textToSave);
            const currentFile = this.getOpenFileNow(path);
            if (!currentFile) return;
            this.patchFile(path, {
                savedText: textToSave,
                dirtyText: currentFile.dirtyText === textToSave ? null : currentFile.dirtyText,
                saveStatus: "saved",
                error: null,
            });
        } catch (e: unknown) {
            this.patchFile(path, {
                saveStatus: "error",
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    closeFile(path: string): void {
        const state = this.getStateNow();
        const idx = state.openFiles.findIndex((file) => file.path === path);
        if (idx < 0) return;
        const openFiles = state.openFiles.filter((file) => file.path !== path);
        const activePath = state.activePath === path ? openFiles[Math.max(0, idx - 1)]?.path ?? null : state.activePath;
        globalStore.set(this.stateAtom, { ...state, openFiles, activePath });
    }

    private patchFile(path: string, patch: Partial<RightEditorOpenFile>): void {
        const state = this.getStateNow();
        globalStore.set(this.stateAtom, {
            ...state,
            openFiles: state.openFiles.map((file) => (file.path === path ? { ...file, ...patch } : file)),
        });
    }
}
