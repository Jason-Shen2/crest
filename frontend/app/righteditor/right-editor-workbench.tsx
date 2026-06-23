// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import { languageClientManager } from "./lsp/language-client-manager";
import {
    getRightEditorLanguageServer,
    getRightEditorLspSupport,
    isRightEditorLspSupported,
} from "./lsp/language-server-registry";
import { MonacoModelRegistry } from "./monaco-model-registry";
import type { RightEditorModel } from "./right-editor-model";
import type { RightEditorLspStatus, RightEditorOpenFile } from "./right-editor-types";

function normalizePathSeparators(path: string): string {
    return path.replace(/\\/g, "/");
}

function basename(path: string): string {
    const normalizedPath = normalizePathSeparators(path);
    const idx = normalizedPath.lastIndexOf("/");
    return idx >= 0 ? normalizedPath.slice(idx + 1) : normalizedPath;
}

type RightEditorWorkbenchProps = {
    model: RightEditorModel;
};

function trimTrailingSlashes(path: string): string {
    return normalizePathSeparators(path).replace(/\/+$/, "");
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
    return isRightEditorLspSupported(language, workspaceRoot);
}

export function getRightEditorLspLifecycleKeyForActiveFile(input: {
    activeFile: RightEditorOpenFile | null | undefined;
    workspaceRoot: string;
}): string | undefined {
    if (!input.activeFile) return undefined;
    const workspaceRoot = input.activeFile.workspaceRoot || input.workspaceRoot;
    const server = getRightEditorLanguageServer(input.activeFile.language);
    if (!workspaceRoot || !server) return undefined;
    return `${workspaceRoot}\u0000${server.serverId}`;
}

type LspLifecycleManager = {
    acquireClient: (input: {
        workspaceRoot: string;
        language: string;
        languages: string[];
        serverId: string;
        displayName: string;
    }) => () => void;
};

type LspStatusManager = {
    getStatus: (input: {
        workspaceRoot: string;
        language: string;
        languages?: string[];
        serverId?: string | null;
        displayName?: string;
    }) => RightEditorLspStatus;
};

export type RightEditorLspStatusDetails = {
    supported: boolean;
    status: RightEditorLspStatus;
    installHint: string | null;
};

export function acquireRightEditorLspForActiveFile(input: {
    activeFile: RightEditorOpenFile;
    workspaceRoot: string;
    lspManager: LspLifecycleManager;
}): (() => void) | undefined {
    if (!input.activeFile) return undefined;
    const workspaceRoot = input.activeFile.workspaceRoot || input.workspaceRoot;
    const server = getRightEditorLanguageServer(input.activeFile.language);
    if (!workspaceRoot || !server) return undefined;
    return input.lspManager.acquireClient({
        workspaceRoot,
        language: input.activeFile.language,
        languages: server.languages,
        serverId: server.serverId,
        displayName: server.displayName,
    });
}

export function getRightEditorLspStatusForActiveFile(input: {
    activeFile: RightEditorOpenFile | null | undefined;
    workspaceRoot: string;
    lspManager: LspStatusManager;
}): RightEditorLspStatusDetails | undefined {
    if (!input.activeFile) return undefined;
    const workspaceRoot = input.activeFile.workspaceRoot || input.workspaceRoot;
    const support = getRightEditorLspSupport(input.activeFile.language, workspaceRoot);
    if (!support.supported) {
        return {
            supported: false,
            installHint: null,
            status: support.status,
        };
    }
    return {
        supported: true,
        installHint: support.server.installHint ?? null,
        status: input.lspManager.getStatus({
            workspaceRoot,
            language: input.activeFile.language,
            languages: support.server.languages,
            serverId: support.server.serverId,
            displayName: support.server.displayName,
        }),
    };
}

export function getRightEditorLspStatusLabel(status: RightEditorLspStatus | undefined, installHint?: string | null): string {
    if (!status) return "";
    if (status.state === "running") return `${status.displayName} LSP ready`;
    if (status.state === "starting") return `${status.displayName} LSP starting`;
    if (status.state === "unavailable") {
        return status.message ?? installHint ?? `${status.displayName} LSP unavailable`;
    }
    if (status.state === "error") return status.message ?? `${status.displayName} LSP error`;
    return status.message ?? `${status.displayName} LSP stopped`;
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
    const activeLspLifecycleKey = getRightEditorLspLifecycleKeyForActiveFile({
        activeFile,
        workspaceRoot: activeFile?.workspaceRoot ?? state.workspaceRoot,
    });
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
    }, [activeLspLifecycleKey]);

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
    const lspStatusDetails = getRightEditorLspStatusForActiveFile({
        activeFile,
        workspaceRoot: activeFile.workspaceRoot || state.workspaceRoot,
        lspManager: languageClientManager,
    });
    const lspStatusLabel = getRightEditorLspStatusLabel(
        lspStatusDetails?.status,
        lspStatusDetails?.installHint
    );
    const footerStatusLabel = activeFile.saveStatus === "error" ? activeFile.error : lspStatusLabel;

    return (
        <div className="flex h-full min-h-0 flex-col bg-[#111113]">
            <div
                aria-label="Right editor file tabs"
                data-overflow-behavior="horizontal-scroll"
                className="flex h-8 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-[#27272a] bg-[#111113] text-[12px]"
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
                                "group/tab flex h-8 min-w-24 max-w-56 flex-1 basis-0 items-center rounded-sm border border-transparent",
                                active
                                    ? "border-[#3f3f46] bg-[#252529] text-[#f4f4f5] outline-solid outline-1 outline-[#4b5563]"
                                    : "bg-[#18181b] text-[#a1a1aa] hover:border-[#3f3f46] hover:bg-[#202024] hover:text-[#f4f4f5]"
                            )}
                        >
                            <button
                                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2"
                                aria-label={`Select ${file.path}`}
                                onClick={() => model.selectFile(file.path)}
                                title={file.path}
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
                                aria-label={`Close ${file.path}`}
                                data-close-visibility={active ? "always" : "hover"}
                                className={cn(
                                    "mr-1 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[#71717a] transition-opacity hover:bg-[#3f3f46] hover:text-[#f4f4f5] focus:opacity-100",
                                    active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100"
                                )}
                                title={file.path}
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
                <span className="min-w-0 truncate" title={activeFile.path}>
                    {activeLabel}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                    <span className="max-w-64 truncate" title={footerStatusLabel ?? activeFile.path}>
                        {footerStatusLabel}
                    </span>
                    <button
                        type="button"
                        aria-label={`Save ${activeFile.path}`}
                        className="cursor-pointer rounded px-1.5 py-0.5 text-[#a1a1aa] hover:bg-[#2f2f35] hover:text-[#f4f4f5]"
                        title={activeFile.path}
                        onClick={() => fireAndForget(() => model.saveFile(activeFile.path))}
                    >
                        <i className="fa-solid fa-floppy-disk" />
                    </button>
                </div>
            </div>
        </div>
    );
}
