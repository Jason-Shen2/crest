// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import type * as monaco from "monaco-editor";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { WorkspaceFileRuntime } from "./workspace-editor-registry";

export function FileTopTab({
    runtime,
    onClose,
    onLocate,
}: {
    runtime: WorkspaceFileRuntime;
    onClose?: () => void;
    onLocate?: () => void;
}) {
    const snapshot = useSyncExternalStore(
        (listener) => runtime.subscribe(listener),
        () => runtime.getSnapshot(),
        () => runtime.getSnapshot()
    );
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor>(null);
    const attachedModelRef = useRef<monaco.editor.ITextModel>(runtime.model);

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

    return (
        <CodeEditor
            blockId={`workspace-file:${runtime.id}`}
            fileName={runtime.path}
            language={runtime.language}
            model={runtime.model}
            onChange={(value) => runtime.setValue(value)}
            onMount={(editor) => {
                editorRef.current = editor;
                attachedModelRef.current = runtime.model;
                if (runtime.viewState) {
                    editor.restoreViewState(runtime.viewState);
                }
                runtime.attach(editor);
                return () => {
                    runtime.detach(editor);
                    editorRef.current = null;
                };
            }}
            readonly={runtime.readonly}
            text={runtime.value}
        />
    );
}
