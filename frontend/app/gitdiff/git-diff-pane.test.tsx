// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    GitDiffBody,
    GitDiffContent,
    loadGitDiffContent,
    parseGitDiffMeta,
    type GitDiffContent as GitDiffContentValue,
} from "./git-diff-pane";

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
        cleanup();
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
                    } satisfies GitDiffContentValue
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

    it("loads a prop-driven staged descriptor and renders its renamed path", async () => {
        const loadContent = vi.fn().mockResolvedValue({
            originalContent: "old",
            modifiedContent: "new",
            isBinary: false,
            fallbackPatch: "",
            truncated: false,
        });

        render(
            <GitDiffContent
                descriptor={{
                    repoRoot: "/repo",
                    path: "src/new.ts",
                    mode: "+",
                    originalPath: "src/old.ts",
                }}
                loadContent={loadContent}
            />
        );

        expect(screen.getByRole("status").textContent).toContain("Loading diff");
        await screen.findByText((_, element) => element?.hasAttribute("data-monaco-diff-viewer") ?? false);
        expect(loadContent).toHaveBeenCalledWith({
            repoRoot: "/repo",
            path: "src/new.ts",
            mode: "+",
            originalPath: "src/old.ts",
        });
        expect(document.querySelector("[data-path]")?.getAttribute("data-path")).toBe("src/new.ts");
    });

    it("renders empty content, failed loads, and retries the same descriptor", async () => {
        const loadContent = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
            originalContent: "same",
            modifiedContent: "same",
            isBinary: false,
            fallbackPatch: "",
            truncated: false,
        });
        const descriptor = { repoRoot: "/repo", path: "same.ts", mode: "-" as const, originalPath: "" };

        render(<GitDiffContent descriptor={descriptor} loadContent={loadContent} />);

        expect((await screen.findByRole("alert")).textContent).toContain("offline");
        fireEvent.click(screen.getByRole("button", { name: "Retry Git diff" }));
        expect(await screen.findByText("No changes.")).toBeTruthy();
        expect(loadContent).toHaveBeenNthCalledWith(2, descriptor);
    });

    it("ignores late responses after descriptor switches", async () => {
        let resolveFirst: (content: GitDiffContentValue) => void;
        const first = new Promise<GitDiffContentValue>((resolve) => {
            resolveFirst = resolve;
        });
        const loadContent = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce({
            originalContent: "b-old",
            modifiedContent: "b-new",
            isBinary: false,
            fallbackPatch: "",
            truncated: false,
        });
        const view = render(
            <GitDiffContent
                descriptor={{ repoRoot: "/repo", path: "a.ts", mode: "-", originalPath: "" }}
                loadContent={loadContent}
            />
        );

        view.rerender(
            <GitDiffContent
                descriptor={{ repoRoot: "/repo", path: "b.ts", mode: "+", originalPath: "old-b.ts" }}
                loadContent={loadContent}
            />
        );
        await vi.waitFor(() =>
            expect(document.querySelector("[data-modified]")?.getAttribute("data-modified")).toBe("b-new")
        );
        resolveFirst!({
            originalContent: "a-old",
            modifiedContent: "a-late",
            isBinary: false,
            fallbackPatch: "",
            truncated: false,
        });
        await Promise.resolve();

        expect(document.querySelector("[data-modified]")?.getAttribute("data-modified")).toBe("b-new");
    });

    it.each(["resolve", "reject"] as const)(
        "fences a deferred load that %ss after GitDiffContent unmounts",
        async (settlement) => {
            let resolveLoad: (content: GitDiffContentValue) => void;
            let rejectLoad: (error: Error) => void;
            const deferredLoad = new Promise<GitDiffContentValue>((resolve, reject) => {
                resolveLoad = resolve;
                rejectLoad = reject;
            });
            const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
            const unhandledRejection = vi.fn();
            window.addEventListener("unhandledrejection", unhandledRejection);
            const view = render(
                <GitDiffContent
                    descriptor={{ repoRoot: "/repo", path: "late.ts", mode: "-", originalPath: "" }}
                    loadContent={() => deferredLoad}
                />
            );

            expect(screen.getByRole("status").textContent).toContain("Loading diff");
            view.unmount();
            await act(async () => {
                if (settlement === "resolve") {
                    resolveLoad!({
                        originalContent: "old",
                        modifiedContent: "late",
                        isBinary: false,
                        fallbackPatch: "",
                        truncated: false,
                    });
                } else {
                    rejectLoad!(new Error("late failure"));
                }
                await deferredLoad.catch(() => {});
            });

            expect(view.container.innerHTML).toBe("");
            expect(consoleError).not.toHaveBeenCalled();
            expect(unhandledRejection).not.toHaveBeenCalled();
            window.removeEventListener("unhandledrejection", unhandledRejection);
            consoleError.mockRestore();
        }
    );
});
