// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ViewComponentProps } from "@/app/block/blocktypes";
import { MonacoDiffViewer } from "@/app/monaco/monaco-react";
import { getRightEditorLanguage } from "@/app/righteditor/right-editor-language";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GitDiffContent, GitDiffMeta, GitDiffMode } from "./git-diff-types";
import type { GitDiffViewModel } from "./git-diff-view-model";

type GitDiffPaneState = {
    loading: boolean;
    content: GitDiffContent | null;
    error: string | null;
};

export type { GitDiffContent, GitDiffMeta, GitDiffMode };

const GitDiffMonacoOptions = {
    readOnly: true,
    originalEditable: false,
    renderSideBySide: false,
    diffAlgorithm: "advanced",
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    overviewRulerLanes: 0,
    renderOverviewRuler: false,
    renderIndicators: true,
    ignoreTrimWhitespace: false,
    scrollbar: {
        useShadows: false,
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
    },
    hideUnchangedRegions: {
        enabled: true,
        minimumLineCount: 6,
        contextLineCount: 3,
    },
} as MonacoTypes.editor.IDiffEditorOptions;

export function parseGitDiffMeta(meta: MetaType | undefined | null): GitDiffMeta {
    const rawMode = (meta?.["gitdiff:mode"] as string) || "-";
    return {
        repoRoot: ((meta?.["gitdiff:repo"] as string) || "").trim(),
        path: ((meta?.["gitdiff:path"] as string) || "").trim(),
        mode: rawMode === "+" ? "+" : "-",
        originalPath: ((meta?.["gitdiff:originalpath"] as string) || "").trim(),
    };
}

export async function loadGitDiffContent(input: GitDiffMeta): Promise<GitDiffContent> {
    const result = await RpcApi.GitGetDiffContentCommand(TabRpcClient, {
        cwd: input.repoRoot,
        path: input.path,
        staged: input.mode === "+",
        originalpath: input.originalPath ?? "",
    });
    return normalizeGitDiffContent(result);
}

export function normalizeGitDiffContent(result: any): GitDiffContent {
    return {
        originalContent: result?.originalcontent ?? result?.originalContent ?? "",
        modifiedContent: result?.modifiedcontent ?? result?.modifiedContent ?? "",
        isBinary: result?.isbinary ?? result?.isBinary ?? false,
        fallbackPatch: result?.fallbackpatch ?? result?.fallbackPatch ?? "",
        truncated: result?.truncated ?? false,
    };
}

export function GitDiffPane({ model }: ViewComponentProps<GitDiffViewModel>) {
    const block = useAtomValue(model.blockAtom);
    const meta = useMemo(() => parseGitDiffMeta(block?.meta), [block?.meta]);
    return <GitDiffContent descriptor={meta} />;
}

export function GitDiffContent({
    descriptor,
    loadContent = loadGitDiffContent,
}: {
    descriptor: GitDiffMeta;
    loadContent?: (input: GitDiffMeta) => Promise<GitDiffContent>;
}) {
    const [state, setState] = useState<GitDiffPaneState>({ loading: true, content: null, error: null });
    const [retryGeneration, setRetryGeneration] = useState(0);
    const requestGeneration = useRef(0);

    useEffect(() => {
        const generation = ++requestGeneration.current;
        setState({ loading: true, content: null, error: null });
        loadContent(descriptor)
            .then((content) => {
                if (generation === requestGeneration.current) {
                    setState({ loading: false, content, error: null });
                }
            })
            .catch((error: any) => {
                if (generation === requestGeneration.current) {
                    setState({ loading: false, content: null, error: error?.message ?? String(error) });
                }
            });
        return () => {
            requestGeneration.current++;
        };
    }, [descriptor.repoRoot, descriptor.path, descriptor.mode, descriptor.originalPath, loadContent, retryGeneration]);

    return (
        <GitDiffBody
            loading={state.loading}
            content={state.content}
            error={state.error}
            path={descriptor.path}
            onRetry={() => setRetryGeneration((generation) => generation + 1)}
        />
    );
}

export function GitDiffBody({
    loading = false,
    content = null,
    error = null,
    path = "",
    onRetry,
}: {
    loading?: boolean;
    content?: GitDiffContent | null;
    error?: string | null;
    path?: string;
    onRetry?: () => void;
}) {
    if (loading) {
        return (
            <div className="flex h-full items-center justify-center text-xs text-[#a1a1aa]" role="status">
                Loading diff...
            </div>
        );
    }
    if (error) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-red-300" role="alert">
                <p>Failed to load Git diff: {error}</p>
                {onRetry ? (
                    <button
                        aria-label="Retry Git diff"
                        className="cursor-pointer rounded px-3 py-1"
                        type="button"
                        onClick={onRetry}
                    >
                        Retry
                    </button>
                ) : null}
            </div>
        );
    }
    if (!content) {
        return <div className="p-4 text-xs text-[#a1a1aa]">No diff content.</div>;
    }
    if (content.isBinary || content.truncated) {
        return (
            <pre className="h-full overflow-auto whitespace-pre-wrap bg-[#18181b] p-4 font-mono text-xs text-[#d4d4d8]">
                {content.fallbackPatch || (content.isBinary ? "Binary file changed." : "Diff content is truncated.")}
            </pre>
        );
    }
    if (content.originalContent === content.modifiedContent) {
        return <div className="p-4 text-xs text-[#a1a1aa]">No changes.</div>;
    }

    return (
        <div className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-[#18181b]">
            <MonacoDiffViewer
                original={content.originalContent}
                modified={content.modifiedContent}
                language={getRightEditorLanguage(path)}
                path={path || "gitdiff"}
                options={GitDiffMonacoOptions}
            />
        </div>
    );
}
