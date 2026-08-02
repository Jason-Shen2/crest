// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { cn } from "@/util/util";
import type * as monaco from "monaco-editor";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MarkdownFilePreview } from "./markdown-file-preview";
import type { WorkspaceFileRuntime } from "./workspace-editor-registry";

type FileViewMode = "preview" | "edit";

export function FileTopTab({
    runtime,
    onClose,
    onLocate,
}: {
    runtime: WorkspaceFileRuntime;
    onClose?: () => void;
    onLocate?: () => void;
}) {
    const subscribe = useCallback((listener: () => void) => runtime.subscribe(listener), [runtime]);
    const getSnapshot = useCallback(() => runtime.getSnapshot(), [runtime]);
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor>(null);
    const attachedModelRef = useRef<monaco.editor.ITextModel>(runtime.model);
    const isMarkdown = runtime.language === "markdown";
    const [viewMode, setViewMode] = useState<FileViewMode>(() => (isMarkdown ? "preview" : "edit"));

    useEffect(() => {
        setViewMode(isMarkdown ? "preview" : "edit");
    }, [isMarkdown]);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor || attachedModelRef.current === runtime.model) {
            return;
        }
        runtime.detach(editor);
        if (runtime.viewState) {
            editor.restoreViewState(runtime.viewState);
        }
        runtime.attach(editor);
        attachedModelRef.current = runtime.model;
    }, [runtime, runtime.model]);

    if (snapshot.status === "error" && snapshot.operation !== "save") {
        return (
            <div className="flex h-full items-center justify-center p-6" role="alert">
                <div className="flex max-w-lg flex-col gap-3">
                    <div className="font-medium">Unable to open {snapshot.title}</div>
                    <div className="text-secondary">{snapshot.error}</div>
                    <div className="flex gap-2">
                        <button
                            className="cursor-pointer rounded bg-accent/80 px-3 py-1 text-primary"
                            onClick={() => void runtime.reload()}
                            type="button"
                        >
                            Retry
                        </button>
                        {onClose ? (
                            <button className="cursor-pointer rounded px-3 py-1" onClick={onClose} type="button">
                                Close
                            </button>
                        ) : null}
                        {onLocate ? (
                            <button className="cursor-pointer rounded px-3 py-1" onClick={onLocate} type="button">
                                Locate
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>
        );
    }

    const editor = (
        <CodeEditor
            blockId={`workspace-file:${runtime.id}`}
            fileName={runtime.path}
            language={runtime.language}
            model={runtime.model}
            onChange={(value) => runtime.setValue(value)}
            onMount={(mountedEditor) => {
                editorRef.current = mountedEditor;
                attachedModelRef.current = runtime.model;
                if (runtime.viewState) {
                    mountedEditor.restoreViewState(runtime.viewState);
                }
                runtime.attach(mountedEditor);
                return () => {
                    if (editorRef.current !== mountedEditor) {
                        return;
                    }
                    runtime.detach(mountedEditor);
                    editorRef.current = null;
                };
            }}
            readonly={runtime.readonly}
            text={runtime.value}
        />
    );

    if (!isMarkdown) {
        return editor;
    }

    const breadcrumb = runtime.path.replaceAll("\\", "/").split("/").filter(Boolean).slice(-2).join(" / ");

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
                <div className="min-w-0 truncate text-sm text-secondary" title={runtime.path}>
                    {breadcrumb}
                </div>
                <div role="group" aria-label="Markdown view mode" className="flex shrink-0 items-center gap-1">
                    <button
                        aria-pressed={viewMode === "preview"}
                        className={cn(
                            "cursor-pointer rounded px-2 py-1 text-xs transition-colors",
                            viewMode === "preview"
                                ? "bg-fg-overlay-2 text-primary"
                                : "text-secondary hover:bg-fg-overlay-1 hover:text-primary"
                        )}
                        onClick={() => setViewMode("preview")}
                        type="button"
                    >
                        Preview
                    </button>
                    <button
                        aria-pressed={viewMode === "edit"}
                        className={cn(
                            "cursor-pointer rounded px-2 py-1 text-xs transition-colors",
                            viewMode === "edit"
                                ? "bg-fg-overlay-2 text-primary"
                                : "text-secondary hover:bg-fg-overlay-1 hover:text-primary"
                        )}
                        onClick={() => setViewMode("edit")}
                        type="button"
                    >
                        Edit
                    </button>
                </div>
            </div>
            <div className="min-h-0 flex-1">
                {viewMode === "preview" ? <MarkdownFilePreview path={runtime.path} text={runtime.value} /> : editor}
            </div>
        </div>
    );
}
