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

function trimTrailingSlashes(path: string): string {
    return path.replace(/\/+$/, "");
}

function dirname(path: string): string {
    const normalizedPath = trimTrailingSlashes(path);
    const idx = normalizedPath.lastIndexOf("/");
    return idx > 0 ? normalizedPath.slice(0, idx) : "";
}

function stripLeadingSlash(path: string): string {
    return path.replace(/^\/+/, "");
}

export function getRightEditorTabPathSuffix(path: string, workspaceRoot: string): string {
    const parentPath = dirname(path);
    if (!parentPath) return "";
    const normalizedWorkspaceRoot = trimTrailingSlashes(workspaceRoot);
    if (workspaceRoot === "/") return stripLeadingSlash(parentPath);
    if (normalizedWorkspaceRoot && parentPath === normalizedWorkspaceRoot) return "";
    if (normalizedWorkspaceRoot && parentPath.startsWith(`${normalizedWorkspaceRoot}/`)) {
        return parentPath.slice(normalizedWorkspaceRoot.length + 1);
    }
    return basename(parentPath);
}

export function shouldStartRightEditorLsp(language: string, workspaceRoot: string): boolean {
    if (!workspaceRoot) return false;
    return (
        language === "typescript" ||
        language === "typescriptreact" ||
        language === "javascript" ||
        language === "javascriptreact"
    );
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
    const workspaceRoot = input.activeFile.workspaceRoot || input.workspaceRoot;
    if (!shouldStartRightEditorLsp(input.activeFile.language, workspaceRoot)) return undefined;
    return input.lspManager.acquireClient({
        workspaceRoot,
        language: input.activeFile.language,
    });
}

export function closeRightEditorFileWithConfirmation(input: {
    file: RightEditorOpenFile;
    name: string;
    closeFile: (path: string) => void;
    confirmDiscard?: (message: string) => boolean;
}): void {
    const confirmDiscard = input.confirmDiscard ?? ((message: string) => window.confirm(message));
    if (input.file.dirtyText != null && !confirmDiscard(`Discard changes to "${input.name}"?`)) {
        return;
    }
    input.closeFile(input.file.path);
}

export function handleRightEditorKeyDown(input: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    activePath: string | null;
    saveFile: (path: string) => void;
    closeFile: (path: string) => void;
}): boolean {
    if (!input.activePath) return false;
    const primary = (input.metaKey || input.ctrlKey) && input.metaKey !== input.ctrlKey;
    if (!primary || input.shiftKey || input.altKey) return false;
    if (primary && input.key.toLowerCase() === "s") {
        input.saveFile(input.activePath);
        return true;
    }
    if (primary && input.key.toLowerCase() === "w") {
        input.closeFile(input.activePath);
        return true;
    }
    return false;
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
            workspaceRoot: activeFile?.workspaceRoot ?? state.workspaceRoot,
            lspManager: languageClientManager,
        });
    }, [state.workspaceRoot, activeFile?.workspaceRoot, activeFile?.language]);

    if (!activeFile) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-secondary">
                <i className="fa-solid fa-code text-xl" />
                <div className="text-sm text-primary">Open a file from the explorer</div>
                <div className="text-xs">Double-click a source file to edit it here with language intelligence.</div>
            </div>
        );
    }

    const displayName = basename(trimTrailingSlashes(activeFile.path));
    const activeSuffix = getRightEditorTabPathSuffix(activeFile.path, activeFile.workspaceRoot || state.workspaceRoot);
    const activeLabel = activeSuffix ? `${displayName} ${activeSuffix}` : displayName;

    return (
        <div className="flex h-full min-h-0 flex-col bg-[#111113]">
            <div
                aria-label="Right editor file tabs"
                className="flex h-9 shrink-0 items-stretch overflow-hidden border-b border-[#27272a] bg-[#18181b] text-[12px]"
            >
                {state.openFiles.map((file) => {
                    const active = file.path === activeFile.path;
                    const name = basename(trimTrailingSlashes(file.path));
                    const suffix = getRightEditorTabPathSuffix(file.path, file.workspaceRoot || state.workspaceRoot);
                    const dirty = file.dirtyText != null;
                    return (
                        <div
                            key={file.path}
                            className={cn(
                                "flex min-w-0 max-w-56 items-center border-r border-[#2b2b30]",
                                active
                                    ? "bg-[#252529] text-[#f4f4f5]"
                                    : "text-[#a1a1aa] hover:bg-[#202024] hover:text-[#f4f4f5]"
                            )}
                        >
                            <button
                                className="flex min-w-0 cursor-pointer items-center gap-1.5 px-3 py-1.5"
                                onClick={() => model.selectFile(file.path)}
                                title={suffix ? `${name} ${suffix}` : name}
                            >
                                <span className="truncate font-medium">{name}</span>
                                {suffix ? (
                                    <span className="truncate text-[10px] text-[#71717a]">
                                        {stripLeadingSlash(suffix)}
                                    </span>
                                ) : null}
                                {dirty ? <span className="text-[#d4d4d8]">●</span> : null}
                            </button>
                            <button
                                type="button"
                                aria-label={`Close ${name}`}
                                className="mr-1 cursor-pointer rounded px-1.5 py-1 text-[#71717a] hover:bg-[#3f3f46] hover:text-[#f4f4f5]"
                                onClick={() =>
                                    closeRightEditorFileWithConfirmation({
                                        file,
                                        name,
                                        closeFile: (path) => model.closeFile(path),
                                    })
                                }
                            >
                                <i className="fa-solid fa-xmark" />
                            </button>
                        </div>
                    );
                })}
            </div>
            <div className="min-h-0 flex-1">
                <CodeEditor
                    blockId="right-editor"
                    text={text}
                    fileName={activeFile.path}
                    language={activeFile.language}
                    readonly={activeFile.readonly}
                    onChange={(nextText) => model.updateText(activeFile.path, nextText)}
                    onMount={(editor) => {
                        const keyDownSub = editor.onKeyDown((event) => {
                            const handled = handleRightEditorKeyDown({
                                key: event.browserEvent.key,
                                metaKey: event.browserEvent.metaKey,
                                ctrlKey: event.browserEvent.ctrlKey,
                                shiftKey: event.browserEvent.shiftKey,
                                altKey: event.browserEvent.altKey,
                                activePath: model.getStateNow().activePath,
                                saveFile: (path) => fireAndForget(() => model.saveFile(path)),
                                closeFile: (path) => {
                                    const file = model.getOpenFileNow(path);
                                    if (!file) return;
                                    closeRightEditorFileWithConfirmation({
                                        file,
                                        name: basename(path),
                                        closeFile: (filePath) => model.closeFile(filePath),
                                    });
                                },
                            });
                            if (!handled) return;
                            event.preventDefault();
                            event.stopPropagation();
                        });
                        return () => keyDownSub.dispose();
                    }}
                    model={activeMonacoModel}
                />
            </div>
            <div className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-[#27272a] bg-[#18181b] px-2 text-[11px] text-[#a1a1aa]">
                <span className="min-w-0 truncate">{activeLabel}</span>
                <div className="flex shrink-0 items-center gap-2">
                    <span className="max-w-64 truncate">
                        {activeFile.saveStatus === "error" ? activeFile.error : activeFile.language}
                    </span>
                    <button
                        type="button"
                        aria-label={`Save ${displayName}`}
                        className="cursor-pointer rounded px-1.5 py-0.5 text-[#a1a1aa] hover:bg-[#2f2f35] hover:text-[#f4f4f5]"
                        onClick={() => fireAndForget(() => model.saveFile(activeFile.path))}
                    >
                        <i className="fa-solid fa-floppy-disk" />
                    </button>
                </div>
            </div>
        </div>
    );
}
