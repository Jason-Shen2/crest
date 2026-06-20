// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import { languageClientManager } from "./lsp/language-client-manager";
import { MonacoModelRegistry } from "./monaco-model-registry";
import type { RightEditorModel } from "./right-editor-model";
import type { RightEditorOpenFile } from "./right-editor-types";

function basename(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx >= 0 ? path.slice(idx + 1) : path;
}

type RightEditorWorkbenchProps = {
    model: RightEditorModel;
};

export function shouldStartRightEditorLsp(language: string, workspaceRoot: string): boolean {
    if (!workspaceRoot) return false;
    return language === "typescript" || language === "javascript";
}

type LspLifecycleManager = {
    acquireClient: (input: { workspaceRoot: string; language: string }) => () => void;
};

export function acquireRightEditorLspForActiveFile(input: {
    activeFile: RightEditorOpenFile;
    workspaceRoot: string;
    lspManager: LspLifecycleManager;
}): (() => void) | undefined {
    if (!input.activeFile) return undefined;
    if (!shouldStartRightEditorLsp(input.activeFile.language, input.workspaceRoot)) return undefined;
    return input.lspManager.acquireClient({
        workspaceRoot: input.workspaceRoot,
        language: input.activeFile.language,
    });
}

export function RightEditorWorkbench({ model }: RightEditorWorkbenchProps) {
    const state = useAtomValue(model.stateAtom);
    const activeFile = state.openFiles.find((file) => file.path === state.activePath);
    const text = activeFile ? (activeFile.dirtyText ?? activeFile.savedText) : "";
    const activeMonacoModel = useMemo(() => {
        if (!activeFile) return null;
        return MonacoModelRegistry.getInstance().getOrCreateModel({
            path: activeFile.path,
            uri: activeFile.uri,
            text,
            language: activeFile.language,
        });
    }, [activeFile?.path, activeFile?.uri, activeFile?.language, text]);

    useEffect(() => {
        return acquireRightEditorLspForActiveFile({
            activeFile,
            workspaceRoot: state.workspaceRoot,
            lspManager: languageClientManager,
        });
    }, [state.workspaceRoot, activeFile?.language]);

    if (!activeFile) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-secondary">
                <i className="fa-solid fa-code text-xl" />
                <div className="text-sm text-primary">Open a file from the explorer</div>
                <div className="text-xs">Double-click a source file to edit it here with language intelligence.</div>
            </div>
        );
    }

    const displayName = basename(activeFile.path);

    return (
        <div className="flex h-full min-h-0 flex-col bg-black/20">
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
                {state.openFiles.map((file) => {
                    const active = file.path === activeFile.path;
                    const name = basename(file.path);
                    const dirty = file.dirtyText != null;
                    return (
                        <div
                            key={file.path}
                            className={cn(
                                "flex min-w-0 items-center rounded-md text-xs",
                                active ? "bg-hoverbg text-white" : "text-secondary hover:bg-hoverbg hover:text-white"
                            )}
                        >
                            <button
                                className="min-w-0 cursor-pointer truncate px-2 py-1"
                                onClick={() => model.selectFile(file.path)}
                            >
                                {dirty ? "● " : ""}
                                {name}
                            </button>
                            <button
                                type="button"
                                aria-label={`Close ${name}`}
                                className="cursor-pointer px-1.5 py-1 text-muted hover:text-white"
                                onClick={() => model.closeFile(file.path)}
                            >
                                <i className="fa-solid fa-xmark" />
                            </button>
                        </div>
                    );
                })}
                <button
                    type="button"
                    aria-label={`Save ${displayName}`}
                    className="ml-auto cursor-pointer rounded px-2 py-1 text-muted hover:bg-hoverbg hover:text-white"
                    onClick={() => fireAndForget(() => model.saveFile(activeFile.path))}
                >
                    <i className="fa-solid fa-floppy-disk" />
                </button>
            </div>
            <div className="min-h-0 flex-1">
                <CodeEditor
                    blockId="right-editor"
                    text={text}
                    fileName={activeFile.path}
                    language={activeFile.language}
                    readonly={activeFile.readonly}
                    onChange={(nextText) => model.updateText(activeFile.path, nextText)}
                    model={activeMonacoModel}
                />
            </div>
            <div className="flex h-6 shrink-0 items-center justify-between border-t border-border px-2 text-[11px] text-secondary">
                <span className="truncate">{activeFile.path}</span>
                <span>{activeFile.saveStatus === "error" ? activeFile.error : activeFile.language}</span>
            </div>
        </div>
    );
}
