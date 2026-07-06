// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitDiffBody, loadGitDiffContent, parseGitDiffMeta, type GitDiffContent } from "./git-diff-pane";

const mockRpcApi = vi.hoisted(() => ({
    GitGetDiffContentCommand: vi.fn(),
    GitGetDiffForFileCommand: vi.fn(),
}));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: mockRpcApi,
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: { routeid: "tab" },
}));

vi.mock("@/app/monaco/monaco-react", () => ({
    MonacoDiffViewer: (props: any) => (
        <div
            data-monaco-diff-viewer
            data-original={props.original}
            data-modified={props.modified}
            data-language={props.language}
            data-path={props.path}
            data-render-side-by-side={String(props.options.renderSideBySide)}
            data-hide-unchanged={String(props.options.hideUnchangedRegions?.enabled)}
            data-minimap={String(props.options.minimap?.enabled)}
            data-overview-ruler-lanes={String(props.options.overviewRulerLanes)}
            data-render-overview-ruler={String(props.options.renderOverviewRuler)}
            data-vertical-scrollbar-size={String(props.options.scrollbar?.verticalScrollbarSize)}
            data-horizontal-scrollbar-size={String(props.options.scrollbar?.horizontalScrollbarSize)}
        />
    ),
}));

describe("git diff pane", () => {
    beforeEach(() => {
        mockRpcApi.GitGetDiffContentCommand.mockReset();
        mockRpcApi.GitGetDiffForFileCommand.mockReset();
    });

    it("parses gitdiff block metadata and defaults invalid mode to unstaged", () => {
        expect(
            parseGitDiffMeta({
                "gitdiff:repo": "/repo",
                "gitdiff:path": "src/app.ts",
                "gitdiff:mode": "unexpected",
                "gitdiff:originalpath": "src/old.ts",
            } as MetaType)
        ).toEqual({
            repoRoot: "/repo",
            path: "src/app.ts",
            mode: "-",
            originalPath: "src/old.ts",
        });
    });

    it("loads staged diff content with original path forwarded to RPC", async () => {
        mockRpcApi.GitGetDiffContentCommand.mockResolvedValue({
            originalcontent: "old",
            modifiedcontent: "new",
            isbinary: false,
            fallbackpatch: "",
            truncated: false,
        });

        await expect(
            loadGitDiffContent({ repoRoot: "/repo", path: "src/new.ts", mode: "+", originalPath: "src/old.ts" })
        ).resolves.toEqual({
            originalContent: "old",
            modifiedContent: "new",
            isBinary: false,
            fallbackPatch: "",
            truncated: false,
        });
        expect(mockRpcApi.GitGetDiffContentCommand).toHaveBeenCalledWith(
            { routeid: "tab" },
            {
                cwd: "/repo",
                path: "src/new.ts",
                staged: true,
                originalpath: "src/old.ts",
            }
        );
    });

    it("loads unstaged diff content with staged false", async () => {
        mockRpcApi.GitGetDiffContentCommand.mockResolvedValue({
            originalcontent: "",
            modifiedcontent: "new",
            isbinary: false,
            fallbackpatch: "",
            truncated: false,
        });

        await loadGitDiffContent({ repoRoot: "/repo", path: "src/new.ts", mode: "-", originalPath: "" });

        expect(mockRpcApi.GitGetDiffContentCommand).toHaveBeenCalledWith(
            { routeid: "tab" },
            expect.objectContaining({ staged: false, originalpath: "" })
        );
        expect(mockRpcApi.GitGetDiffForFileCommand).not.toHaveBeenCalled();
    });

    it("renders normal text diffs with MonacoDiffViewer", () => {
        const html = renderToStaticMarkup(
            <GitDiffBody
                content={{
                    originalContent: "old\nshared\n",
                    modifiedContent: "new\nshared\n",
                    isBinary: false,
                    fallbackPatch: "",
                    truncated: false,
                }}
                path="src/app.ts"
            />
        );

        expect(html).toContain("data-monaco-diff-viewer");
        expect(html).toContain('data-original="old');
        expect(html).toContain('data-modified="new');
        expect(html).toContain('data-language="typescript"');
        expect(html).toContain('data-path="src/app.ts"');
        expect(html).toContain('data-render-side-by-side="false"');
        expect(html).toContain('data-hide-unchanged="true"');
        expect(html).toContain('data-minimap="false"');
    });

    it("renders normal text diffs with a clean Terax-style right edge", () => {
        const html = renderToStaticMarkup(
            <GitDiffBody
                content={{
                    originalContent: "old\nshared\n",
                    modifiedContent: "new\nshared\n",
                    isBinary: false,
                    fallbackPatch: "",
                    truncated: false,
                }}
                path="src/app.ts"
            />
        );

        expect(html).toContain("overflow-hidden");
        expect(html).toContain('data-overview-ruler-lanes="0"');
        expect(html).toContain('data-render-overview-ruler="false"');
        expect(html).toContain('data-vertical-scrollbar-size="8"');
        expect(html).toContain('data-horizontal-scrollbar-size="8"');
    });

    it("renders binary diff fallback patch instead of MonacoDiffViewer", () => {
        const html = renderToStaticMarkup(
            <GitDiffBody
                content={
                    {
                        originalContent: "",
                        modifiedContent: "",
                        isBinary: true,
                        fallbackPatch: "Binary files differ",
                        truncated: false,
                    } satisfies GitDiffContent
                }
                path="asset.png"
            />
        );

        expect(html).toContain("Binary files differ");
        expect(html).not.toContain("data-monaco-diff-viewer");
    });

    it("renders truncated diff fallback patch instead of MonacoDiffViewer", () => {
        const html = renderToStaticMarkup(
            <GitDiffBody
                content={{
                    originalContent: "old",
                    modifiedContent: "new",
                    isBinary: false,
                    fallbackPatch: "diff --git a/file b/file",
                    truncated: true,
                }}
                path="file.ts"
            />
        );

        expect(html).toContain("diff --git a/file b/file");
        expect(html).not.toContain("data-monaco-diff-viewer");
    });

    it("renders failed RPC errors", () => {
        const html = renderToStaticMarkup(<GitDiffBody error="failed to load diff" />);

        expect(html).toContain("failed to load diff");
    });
});
