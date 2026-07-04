// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { MonacoModelRegistry } from "@/app/righteditor/monaco-model-registry";
import { languageClientManager } from "@/app/righteditor/lsp/language-client-manager";
import {
    acquireRightEditorLspForActiveFile,
    getRightEditorLspLifecycleKeyForActiveFile,
    getRightEditorLspStatusForActiveFile,
    getRightEditorLspStatusLabel,
    handleRightEditorKeyDown,
    useRightEditorLspStatusVersion,
} from "@/app/righteditor/right-editor-workbench";
import type { RightEditorOpenFile } from "@/app/righteditor/right-editor-types";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { Icon } from "@/app/icon/Icon";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import { FileEditorViewModel } from "./file-editor-model";

// Shape a RightEditorOpenFile so the right-editor LSP helpers (acquire, status)
// can be reused without duplicating their logic.
function makeLspFile(path: string, language: string, workspaceRoot: string, readonly: boolean): RightEditorOpenFile {
    return {
        path,
        uri: "",
        language,
        workspaceRoot,
        readonly,
        savedText: "",
        dirtyText: null,
        saveStatus: "idle",
        error: null,
    };
}

export const FileEditorView: React.FC<ViewComponentProps<FileEditorViewModel>> = ({ model, contentRef }) => {
    const filePath = useAtomValue(model.filePathAtom);
    const savedText = useAtomValue(model.savedTextAtom);
    const dirtyText = useAtomValue(model.dirtyTextAtom);
    const readonly = useAtomValue(model.readonlyAtom);
    const saveStatus = useAtomValue(model.saveStatusAtom);
    const error = useAtomValue(model.errorAtom);
    const loaded = useAtomValue(model.loadedAtom);
    const workspaceRoot = model.workspaceRoot;
    const language = model.getLanguage();
    const text = dirtyText ?? savedText;

    useEffect(() => {
        fireAndForget(() => model.loadFile());
    }, [filePath]);

    const lspFile = useMemo(
        () => (filePath ? makeLspFile(filePath, language, workspaceRoot, readonly) : null),
        [filePath, language, workspaceRoot, readonly]
    );

    const lspLifecycleKey = getRightEditorLspLifecycleKeyForActiveFile({ activeFile: lspFile, workspaceRoot });
    const lspStatusVersion = useRightEditorLspStatusVersion(lspFile, workspaceRoot);
    void lspStatusVersion;

    useEffect(() => {
        if (!lspFile) return undefined;
        return acquireRightEditorLspForActiveFile({ activeFile: lspFile, workspaceRoot, lspManager: languageClientManager });
    }, [lspLifecycleKey]);

    const monacoModel = useMemo(() => {
        if (!filePath || !loaded) return null;
        return MonacoModelRegistry.getInstance().getOrCreateModel({
            path: filePath,
            uri: model.getFileUri(),
            text,
            language,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filePath, loaded, language]);

    if (!filePath) {
        return (
            <div
                ref={contentRef}
                className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-secondary"
            >
                <Icon name="code" size={14} className="text-xl" />
                <div className="text-sm text-primary">No file open</div>
            </div>
        );
    }

    const lspStatusDetails = lspFile
        ? getRightEditorLspStatusForActiveFile({ activeFile: lspFile, workspaceRoot, lspManager: languageClientManager })
        : undefined;
    const lspStatusLabel = getRightEditorLspStatusLabel(lspStatusDetails?.status, lspStatusDetails?.installHint);
    const footerStatusLabel = saveStatus === "error" ? error : lspStatusLabel;

    return (
        <div ref={contentRef} className="flex h-full min-h-0 w-full flex-col bg-[#111113]">
            <div className="min-h-0 flex-1">
                {monacoModel ? (
                    <CodeEditor
                        blockId={model.blockId}
                        text={text}
                        fileName={filePath}
                        language={language}
                        readonly={readonly}
                        onChange={(nextText) => model.updateText(nextText)}
                        onMount={(editor) => {
                            const keyDownSub = editor.onKeyDown((event) => {
                                const handled = handleRightEditorKeyDown({
                                    key: event.browserEvent.key,
                                    metaKey: event.browserEvent.metaKey,
                                    ctrlKey: event.browserEvent.ctrlKey,
                                    shiftKey: event.browserEvent.shiftKey,
                                    altKey: event.browserEvent.altKey,
                                    activePath: model.getFilePathNow(),
                                    saveFile: () => fireAndForget(() => model.saveFile()),
                                    closeFile: () => model.nodeModel.onClose(),
                                });
                                if (!handled) return;
                                event.preventDefault();
                                event.stopPropagation();
                            });
                            return () => keyDownSub.dispose();
                        }}
                        model={monacoModel}
                    />
                ) : null}
            </div>
            <div className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-[#27272a] bg-[#18181b] px-2 text-[11px] text-[#a1a1aa]">
                <span className="min-w-0 truncate" title={filePath}>
                    {filePath}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                    <span role="status" aria-live="polite" className="max-w-64 truncate" title={footerStatusLabel ?? filePath}>
                        {footerStatusLabel}
                    </span>
                    <button
                        type="button"
                        aria-label={`Save ${filePath}`}
                        className="cursor-pointer rounded px-1.5 py-0.5 text-[#a1a1aa] hover:bg-[#2f2f35] hover:text-[#f4f4f5]"
                        title={filePath}
                        onClick={() => fireAndForget(() => model.saveFile())}
                    >
                        <Icon name="floppy-disk" size={14} className="" />
                    </button>
                </div>
            </div>
        </div>
    );
};
