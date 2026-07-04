// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { MonacoModelRegistry } from "@/app/righteditor/monaco-model-registry";
import { getRightEditorLanguage } from "@/app/righteditor/right-editor-language";
import { RightEditorProductionRpc } from "@/app/righteditor/right-editor-rpc";
import type { RightEditorOpenFile, RightEditorState } from "@/app/righteditor/right-editor-types";
import {
    acquireRightEditorLspForActiveFile,
    getRightEditorLspLifecycleKeyForActiveFile,
    getRightEditorLspStatusForActiveFile,
    getRightEditorLspStatusLabel,
} from "@/app/righteditor/right-editor-workbench";
import { languageClientManager } from "@/app/righteditor/lsp/language-client-manager";
import { getRightEditorLspSupport } from "@/app/righteditor/lsp/language-server-registry";
import { globalStore } from "@/app/store/jotaiStore";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import type { Atom, PrimitiveAtom } from "jotai";
import { useEffect, useMemo, useSyncExternalStore } from "react";

function normalizePathSeparators(path: string): string {
    return path.replace(/\\/g, "/");
}

function basename(path: string): string {
    const normalizedPath = normalizePathSeparators(path).replace(/\/+$/, "");
    const idx = normalizedPath.lastIndexOf("/");
    return idx >= 0 ? normalizedPath.slice(idx + 1) : normalizedPath;
}

function dirname(path: string): string {
    const normalizedPath = normalizePathSeparators(path).replace(/\/+$/, "");
    const idx = normalizedPath.lastIndexOf("/");
    return idx > 0 ? normalizedPath.slice(0, idx) : "";
}

function pathToFileUri(path: string): string {
    const normalizedPath = path.replace(/\\/g, "/");
    const driveMatch = /^([A-Za-z]:)(\/.*)?$/.exec(normalizedPath);
    if (driveMatch) {
        const [, drive, rest = ""] = driveMatch;
        const encodedRest = rest
            .split("/")
            .map((part) => encodeURIComponent(part))
            .join("/");
        return `file:///${drive}${encodedRest}`;
    }
    return `file://${normalizedPath.split("/").map(encodeURIComponent).join("/")}`;
}

function makeBlockScopedModelPath(blockId: string, filePath: string): string {
    return `codeeditor:${blockId}:${filePath}`;
}

function getLspStatusInput(activeFile: RightEditorOpenFile, workspaceRoot: string) {
    if (!activeFile) return null;
    const activeWorkspaceRoot = activeFile.workspaceRoot || workspaceRoot;
    const support = getRightEditorLspSupport(activeFile.language, activeWorkspaceRoot);
    if (!support.supported) return null;
    return {
        workspaceRoot: activeWorkspaceRoot,
        language: activeFile.language,
        languages: support.server.languages,
        serverId: support.server.serverId,
        displayName: support.server.displayName,
    };
}

function useFileEditorLspStatusVersion(activeFile: RightEditorOpenFile, workspaceRoot: string): number {
    const statusInput = getLspStatusInput(activeFile, workspaceRoot);
    return useSyncExternalStore(
        (onStoreChange) => {
            if (!statusInput || !languageClientManager.subscribeStatus) return () => undefined;
            return languageClientManager.subscribeStatus(statusInput, onStoreChange);
        },
        () => {
            if (!statusInput || !languageClientManager.getStatusSnapshot) return 0;
            return languageClientManager.getStatusSnapshot(statusInput);
        },
        () => {
            if (!statusInput || !languageClientManager.getStatusSnapshot) return 0;
            return languageClientManager.getStatusSnapshot(statusInput);
        }
    );
}

export class FileEditorViewModel implements ViewModel {
    readonly viewType = "codeeditor";
    readonly blockId: string;
    readonly stateAtom: PrimitiveAtom<RightEditorState>;
    readonly filePathAtom: Atom<string>;
    readonly cwdAtom: Atom<string>;
    readonly viewIcon = atom("file-code");
    readonly viewName: Atom<string>;
    readonly noPadding = atom(true);
    readonly viewComponent = FileEditorView;
    private readonly pendingOpenFiles = new Map<string, { promise: Promise<void>; requestId: number; workspaceRoot: string }>();
    private openRequestId = 0;

    constructor({ blockId, waveEnv }: ViewModelInitType) {
        this.blockId = blockId;
        this.filePathAtom = waveEnv.getBlockMetaKeyAtom(blockId, "file");
        this.cwdAtom = waveEnv.getBlockMetaKeyAtom(blockId, "cmd:cwd");
        this.stateAtom = atom({
            openFiles: [],
            activePath: null,
            workspaceRoot: "",
        });
        this.viewName = atom((get) => {
            const filePath = get(this.filePathAtom);
            return filePath ? basename(filePath) : "Code Editor";
        });
    }

    getWorkspaceRoot(filePath: string): string {
        return globalStore.get(this.cwdAtom) || dirname(filePath);
    }

    openFile(filePath: string, workspaceRoot = this.getWorkspaceRoot(filePath)): Promise<void> {
        const existing = this.getOpenFileNow(filePath);
        if (existing) {
            this.openRequestId++;
            globalStore.set(this.stateAtom, {
                openFiles: [{ ...existing, workspaceRoot }],
                activePath: filePath,
                workspaceRoot,
            });
            return Promise.resolve();
        }
        const requestId = ++this.openRequestId;
        const pendingOpen = this.pendingOpenFiles.get(filePath);
        if (pendingOpen) {
            pendingOpen.requestId = requestId;
            pendingOpen.workspaceRoot = workspaceRoot;
            return pendingOpen.promise;
        }
        const pendingOpenEntry = {
            promise: null as Promise<void>,
            requestId,
            workspaceRoot,
        };
        const openPromise = (async () => {
            try {
                await this.readAndOpenFile(filePath, pendingOpenEntry);
            } finally {
                if (this.pendingOpenFiles.get(filePath)?.promise === openPromise) {
                    this.pendingOpenFiles.delete(filePath);
                }
            }
        })();
        pendingOpenEntry.promise = openPromise;
        this.pendingOpenFiles.set(filePath, pendingOpenEntry);
        return openPromise;
    }

    private shouldApplyPendingOpen(filePath: string, pendingOpenEntry: { requestId: number }): boolean {
        const currentMetaFile = globalStore.get(this.filePathAtom);
        const pendingOpen = this.pendingOpenFiles.get(filePath);
        return (
            pendingOpen === pendingOpenEntry &&
            pendingOpenEntry.requestId === this.openRequestId &&
            (!currentMetaFile || currentMetaFile === filePath)
        );
    }

    getStateNow(): RightEditorState {
        return globalStore.get(this.stateAtom);
    }

    getOpenFileNow(path: string): RightEditorOpenFile {
        return this.getStateNow().openFiles.find((file) => file.path === path);
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
            await RightEditorProductionRpc.writeFile(path, textToSave);
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

    private async readAndOpenFile(
        filePath: string,
        pendingOpen: { requestId: number; workspaceRoot: string }
    ): Promise<void> {
        const file = await RightEditorProductionRpc.readFile(filePath);
        if (!this.shouldApplyPendingOpen(filePath, pendingOpen)) {
            return;
        }
        const openFile: RightEditorOpenFile = {
            path: filePath,
            uri: pathToFileUri(filePath),
            language: getRightEditorLanguage(filePath),
            workspaceRoot: pendingOpen.workspaceRoot,
            readonly: file.readonly,
            savedText: file.text,
            dirtyText: null,
            saveStatus: "idle",
            error: null,
        };
        globalStore.set(this.stateAtom, {
            openFiles: [openFile],
            activePath: filePath,
            workspaceRoot: pendingOpen.workspaceRoot,
        });
    }

    private patchFile(path: string, patch: Partial<RightEditorOpenFile>): void {
        const state = this.getStateNow();
        globalStore.set(this.stateAtom, {
            ...state,
            openFiles: state.openFiles.map((file) => (file.path === path ? { ...file, ...patch } : file)),
        });
    }
}

function FileEditorView({ blockId, model }: ViewComponentProps<FileEditorViewModel>) {
    const filePath = useAtomValue(model.filePathAtom);
    const cwd = useAtomValue(model.cwdAtom);
    const state = useAtomValue(model.stateAtom);
    const workspaceRoot = cwd || (filePath ? dirname(filePath) : state.workspaceRoot);
    const activeFile = filePath ? state.openFiles.find((file) => file.path === filePath) : null;
    const text = activeFile ? (activeFile.dirtyText ?? activeFile.savedText) : "";
    const activeLspLifecycleKey = getRightEditorLspLifecycleKeyForActiveFile({
        activeFile,
        workspaceRoot,
    });
    const lspStatusVersion = useFileEditorLspStatusVersion(activeFile, workspaceRoot);
    const activeMonacoModel = useMemo(() => {
        if (!activeFile) return null;
        return MonacoModelRegistry.getInstance().getOrCreateModel({
            path: makeBlockScopedModelPath(blockId, activeFile.path),
            uri: activeFile.uri,
            text,
            language: activeFile.language,
        });
    }, [activeFile?.path, activeFile?.uri, activeFile?.language, text]);
    const blockScopedModelPath = activeFile ? makeBlockScopedModelPath(blockId, activeFile.path) : null;

    useEffect(() => {
        if (!filePath) return;
        fireAndForget(() => model.openFile(filePath, workspaceRoot));
    }, [model, filePath, workspaceRoot]);

    useEffect(() => {
        return () => {
            if (blockScopedModelPath) {
                MonacoModelRegistry.getInstance().disposePath(blockScopedModelPath);
            }
        };
    }, [blockScopedModelPath]);

    useEffect(() => {
        if (!activeFile) return;
        return acquireRightEditorLspForActiveFile({
            activeFile,
            workspaceRoot,
            lspManager: languageClientManager,
        });
    }, [activeLspLifecycleKey]);

    if (!filePath) {
        return (
            <div className="flex h-full items-center justify-center p-6 text-sm text-secondary">
                No file configured for this editor.
            </div>
        );
    }

    if (!activeFile) {
        return (
            <div className="flex h-full items-center justify-center p-6 text-sm text-secondary">
                Opening {filePath}...
            </div>
        );
    }

    const lspStatusDetails = getRightEditorLspStatusForActiveFile({
        activeFile,
        workspaceRoot,
        lspManager: languageClientManager,
    });
    void lspStatusVersion;
    const lspStatusLabel = getRightEditorLspStatusLabel(lspStatusDetails?.status, lspStatusDetails?.installHint);

    return (
        <div className="flex h-full min-h-0 flex-col bg-[#111113]">
            <div className="min-h-0 flex-1">
                <CodeEditor
                    blockId={blockId}
                    text={text}
                    fileName={activeFile.path}
                    language={activeFile.language}
                    readonly={activeFile.readonly}
                    onChange={(nextText) => model.updateText(activeFile.path, nextText)}
                    onMount={(editor) => {
                        const keyDownSub = editor.onKeyDown((event) => {
                            const primary =
                                (event.browserEvent.metaKey || event.browserEvent.ctrlKey) &&
                                event.browserEvent.metaKey !== event.browserEvent.ctrlKey;
                            if (
                                !primary ||
                                event.browserEvent.shiftKey ||
                                event.browserEvent.altKey ||
                                event.browserEvent.key.toLowerCase() !== "s"
                            ) {
                                return;
                            }
                            fireAndForget(() => model.saveFile(activeFile.path));
                            event.preventDefault();
                            event.stopPropagation();
                        });
                        return () => keyDownSub.dispose();
                    }}
                    model={activeMonacoModel}
                />
            </div>
            <div className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-[#27272a] bg-[#18181b] px-2 text-[11px] text-[#a1a1aa]">
                <span className="min-w-0 truncate" title={activeFile.path}>
                    {activeFile.path}
                </span>
                <span role="status" aria-live="polite" className="max-w-64 truncate" title={lspStatusLabel}>
                    {activeFile.saveStatus === "error" ? activeFile.error : lspStatusLabel}
                </span>
            </div>
        </div>
    );
}
