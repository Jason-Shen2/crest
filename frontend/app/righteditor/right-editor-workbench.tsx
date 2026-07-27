// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useSyncExternalStore } from "react";
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

function splitSuffixSegments(suffix: string): string[] {
    return stripLeadingSlash(suffix)
        .split("/")
        .filter((segment) => segment.length > 0);
}

function getWorkspaceLabel(workspaceRoot: string): string {
    return basename(trimTrailingSlashes(workspaceRoot)) || ".";
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

type RightEditorFileTabInput = Pick<RightEditorOpenFile, "path" | "workspaceRoot">;

export function getRightEditorFileTabDisplay(
    file: RightEditorFileTabInput,
    openFiles: RightEditorFileTabInput[],
    fallbackWorkspaceRoot = ""
): { name: string; suffix: string } {
    const name = basename(trimTrailingSlashes(file.path));
    const sameNameFiles = openFiles.filter((candidate) => basename(trimTrailingSlashes(candidate.path)) === name);
    if (sameNameFiles.length <= 1) {
        return { name, suffix: "" };
    }

    const baseSegments = new Map<RightEditorFileTabInput, string[]>();
    const getBaseSegments = (candidate: RightEditorFileTabInput): string[] => {
        const workspaceRoot = candidate.workspaceRoot || fallbackWorkspaceRoot;
        const suffix = getRightEditorTabPathSuffix(candidate.path, workspaceRoot);
        const segments = splitSuffixSegments(suffix);
        return segments.length > 0 ? segments : [getWorkspaceLabel(workspaceRoot)];
    };
    for (const candidate of sameNameFiles) {
        baseSegments.set(candidate, getBaseSegments(candidate));
    }

    const getDisplaySegments = (candidate: RightEditorFileTabInput): string[] => {
        const workspaceRoot = candidate.workspaceRoot || fallbackWorkspaceRoot;
        const segments = baseSegments.get(candidate) ?? getBaseSegments(candidate);
        const key = segments.join("/");
        const hasCollision = sameNameFiles.some((other) => {
            if (other === candidate) return false;
            const otherSegments = baseSegments.get(other) ?? getBaseSegments(other);
            return otherSegments.join("/") === key;
        });
        const workspaceLabel = getWorkspaceLabel(workspaceRoot);
        return hasCollision ? [workspaceLabel, ...segments] : segments;
    };

    const fileSegments = new Map<RightEditorFileTabInput, string[]>();
    for (const candidate of sameNameFiles) {
        fileSegments.set(candidate, getDisplaySegments(candidate));
    }

    const currentSegments = fileSegments.get(file) ?? getDisplaySegments(file);
    const maxDepth = Math.max(...sameNameFiles.map((candidate) => fileSegments.get(candidate)?.length ?? 1));
    for (let depth = 1; depth <= maxDepth; depth++) {
        const currentSuffix = currentSegments.slice(-depth).join("/");
        const matchingCount = sameNameFiles.filter((candidate) => {
            const segments = fileSegments.get(candidate) ?? getDisplaySegments(candidate);
            return segments.slice(-depth).join("/") === currentSuffix;
        }).length;
        if (currentSuffix && matchingCount === 1) {
            return { name, suffix: currentSuffix };
        }
    }

    return { name, suffix: currentSegments.join("/") };
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
    getStatusSnapshot?: (input: {
        workspaceRoot: string;
        language: string;
        languages?: string[];
        serverId?: string | null;
        displayName?: string;
    }) => number;
    subscribeStatus?: (
        input: {
            workspaceRoot: string;
            language: string;
            languages?: string[];
            serverId?: string | null;
            displayName?: string;
        },
        listener: () => void
    ) => () => void;
};

export type RightEditorLspStatusDetails = {
    supported: boolean;
    status: RightEditorLspStatus;
    installHint: string | null;
};

type RightEditorLspStatusInput = {
    workspaceRoot: string;
    language: string;
    languages: string[];
    serverId: string;
    displayName: string;
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

function getRightEditorLspStatusInputForActiveFile(
    activeFile: RightEditorOpenFile | null | undefined,
    workspaceRoot: string
): RightEditorLspStatusInput | undefined {
    if (!activeFile) return undefined;
    const activeWorkspaceRoot = activeFile.workspaceRoot || workspaceRoot;
    const support = getRightEditorLspSupport(activeFile.language, activeWorkspaceRoot);
    if (!support.supported) return undefined;
    return {
        workspaceRoot: activeWorkspaceRoot,
        language: activeFile.language,
        languages: support.server.languages,
        serverId: support.server.serverId,
        displayName: support.server.displayName,
    };
}

function useRightEditorLspStatusVersion(
    activeFile: RightEditorOpenFile | null | undefined,
    workspaceRoot: string
): number {
    const statusInput = getRightEditorLspStatusInputForActiveFile(activeFile, workspaceRoot);
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

export function getRightEditorLspStatusLabel(
    status: RightEditorLspStatus | undefined,
    installHint?: string | null
): string {
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
    const lspStatusVersion = useRightEditorLspStatusVersion(
        activeFile,
        activeFile?.workspaceRoot ?? state.workspaceRoot
    );
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

    const activeDisplay = getRightEditorFileTabDisplay(activeFile, state.openFiles, state.workspaceRoot);
    const displayName = activeDisplay.name;
    const activeSuffix = activeDisplay.suffix;
    const activeLabel = activeSuffix ? `${displayName} ${activeSuffix}` : displayName;
    const lspStatusDetails = getRightEditorLspStatusForActiveFile({
        activeFile,
        workspaceRoot: activeFile.workspaceRoot || state.workspaceRoot,
        lspManager: languageClientManager,
    });
    void lspStatusVersion;
    const lspStatusLabel = getRightEditorLspStatusLabel(lspStatusDetails?.status, lspStatusDetails?.installHint);
    const footerStatusLabel = activeFile.saveStatus === "error" ? activeFile.error : lspStatusLabel;

    return (
        <div className="flex h-full min-h-0 flex-col bg-[#111113]">
            <div
                aria-label="Right editor file tabs"
                data-overflow-behavior="no-horizontal-scroll"
                data-tab-sizing="adaptive-fill"
                data-tab-width="adaptive-by-count"
                className="flex h-8 shrink-0 items-stretch gap-0 overflow-hidden border-b border-[#2a2b2f] bg-[#111113] text-[12px]"
            >
                {state.openFiles.map((file) => {
                    const active = file.path === activeFile.path;
                    const { name, suffix } = getRightEditorFileTabDisplay(file, state.openFiles, state.workspaceRoot);
                    const dirty = file.dirtyText != null;
                    return (
                        <div
                            key={file.path}
                            className={cn(
                                "group/tab relative flex h-8 min-w-0 max-w-[24rem] flex-1 items-center border-r border-[#2a2b2f]",
                                active
                                    ? "bg-[#202124] text-[#f4f4f5] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                                    : "bg-[#18191b] text-[#a1a1aa] hover:bg-[#202124] hover:text-[#f4f4f5]"
                            )}
                            style={{ containerType: "inline-size" }}
                        >
                            <button
                                className="flex h-full min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 overflow-hidden px-6 [@container(max-width:9rem)]:px-2"
                                aria-label={`Select ${file.path}`}
                                data-tab-content-align="center"
                                data-label-collapse="hide-on-narrow"
                                onClick={() => model.selectFile(file.path)}
                                title={file.path}
                            >
                                <i className="fa-regular fa-file-code shrink-0 text-[12px] text-[#a1a1aa]" />
                                <span
                                    className="min-w-0 max-w-[15rem] truncate font-medium [@container(max-width:9rem)]:hidden"
                                    data-name-display="full-priority"
                                >
                                    {name}
                                </span>
                                {suffix ? (
                                    <span
                                        className="min-w-0 max-w-[8rem] flex-shrink-[999] truncate text-[11px] text-[#71717a] [@container(max-width:12rem)]:hidden"
                                        data-suffix-priority="shrink-first"
                                    >
                                        {stripLeadingSlash(suffix)}
                                    </span>
                                ) : null}
                                {dirty ? <span className="shrink-0 text-[#d4d4d8]">●</span> : null}
                            </button>
                            <button
                                type="button"
                                aria-label={`Close ${file.path}`}
                                data-close-visibility="hover"
                                className={cn(
                                    "pointer-events-none absolute right-1.5 flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-[#71717a] transition-[opacity,font-weight,color] duration-100 hover:font-semibold hover:text-[#f4f4f5] focus:pointer-events-auto focus:opacity-100",
                                    "opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100"
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
                    <span
                        role="status"
                        aria-live="polite"
                        className="max-w-64 truncate"
                        title={footerStatusLabel ?? activeFile.path}
                    >
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
