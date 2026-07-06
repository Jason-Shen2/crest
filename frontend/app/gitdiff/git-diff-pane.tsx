// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ViewComponentProps } from "@/app/block/blocktypes";
import { MonacoDiffViewer } from "@/app/monaco/monaco-react";
import { getRightEditorLanguage } from "@/app/righteditor/right-editor-language";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import type { GitDiffViewModel } from "./git-diff-view-model";
import type { GitDiffContent, GitDiffMeta, GitDiffMode } from "./git-diff-types";

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
    const [state, setState] = useState<GitDiffPaneState>({ loading: true, content: null, error: null });

    useEffect(() => {
        let cancelled = false;
        setState({ loading: true, content: null, error: null });
        loadGitDiffContent(meta)
            .then((content) => {
                if (!cancelled) {
                    setState({ loading: false, content, error: null });
                }
            })
            .catch((error: any) => {
                if (!cancelled) {
                    setState({ loading: false, content: null, error: error?.message ?? String(error) });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [meta.repoRoot, meta.path, meta.mode, meta.originalPath]);

    return <GitDiffBody loading={state.loading} content={state.content} error={state.error} path={meta.path} />;
}

export function GitDiffBody({
    loading = false,
    content = null,
    error = null,
    path = "",
}: {
    loading?: boolean;
    content?: GitDiffContent | null;
    error?: string | null;
    path?: string;
}) {
    if (loading) {
        return <div className="flex h-full items-center justify-center text-xs text-[#a1a1aa]">Loading diff...</div>;
    }
    if (error) {
        return <div className="p-4 text-xs text-red-300">Failed to load Git diff: {error}</div>;
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
