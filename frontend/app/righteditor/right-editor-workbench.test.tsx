// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as rightEditorWorkbench from "./right-editor-workbench";

const mockWorkbench = vi.hoisted(() => {
    const registryModel = { id: "registry-model" };
    return {
        codeEditorProps: [] as any[],
        registryModel,
        getOrCreateModel: vi.fn(() => registryModel),
        lspSnapshot: 0,
        lspStatus: null as any,
        lspStatusListeners: new Set<() => void>(),
        emitLspStatus(status: any) {
            mockWorkbench.lspStatus = status;
            mockWorkbench.lspSnapshot++;
            for (const listener of mockWorkbench.lspStatusListeners) {
                listener();
            }
        },
        useSyncExternalStore: vi.fn((subscribe: any, getSnapshot: any) => getSnapshot()),
    };
});

vi.mock("react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react")>();
    return {
        ...actual,
        useSyncExternalStore: mockWorkbench.useSyncExternalStore,
    };
});

vi.mock("@/app/view/codeeditor/codeeditor", () => ({
    CodeEditor: (props: any) => {
        mockWorkbench.codeEditorProps.push(props);
        return <div>Code Editor</div>;
    },
}));

vi.mock("./monaco-model-registry", () => ({
    MonacoModelRegistry: {
        getInstance: () => ({
            getOrCreateModel: mockWorkbench.getOrCreateModel,
        }),
    },
}));

vi.mock("./lsp/language-client-manager", () => ({
    languageClientManager: {
        acquireClient: vi.fn(() => vi.fn()),
        getStatus: vi.fn(),
        getStatusSnapshot: vi.fn(),
        subscribeStatus: vi.fn(),
    },
}));

import { languageClientManager } from "./lsp/language-client-manager";
import { RightEditorModel } from "./right-editor-model";
import {
    acquireRightEditorLspForActiveFile,
    closeRightEditorFileWithConfirmation,
    getRightEditorFileTabDisplay,
    getRightEditorLspLifecycleKeyForActiveFile,
    getRightEditorLspStatusForActiveFile,
    getRightEditorLspStatusLabel,
    handleRightEditorKeyDown,
    RightEditorWorkbench,
    shouldStartRightEditorLsp,
} from "./right-editor-workbench";

const rpc = {
    readFile: vi.fn(async () => ({ text: "const x = 1;", readonly: false })),
    writeFile: vi.fn(async () => undefined),
};

type TestOpenFileInput = {
    path: string;
    language: string;
    workspaceRoot?: string;
};

type KeyDownEvent = {
    browserEvent: {
        key: string;
        metaKey: boolean;
        ctrlKey: boolean;
        shiftKey?: boolean;
        altKey?: boolean;
    };
    preventDefault: () => void;
    stopPropagation: () => void;
};

type RightEditorWorkbenchExports = typeof rightEditorWorkbench & {
    getRightEditorTabPathSuffix?: (path: string, workspaceRoot: string) => string;
};

function renderWithStore(element: ReactElement): string {
    return renderToStaticMarkup(<Provider store={globalStore}>{element}</Provider>);
}

function renderWithMountedStore(element: ReactElement): { getMarkup: () => string; getChangeCount: () => number } {
    let changeCount = 0;
    mockWorkbench.useSyncExternalStore.mockImplementation(
        (subscribe: (onStoreChange: () => void) => () => void, getSnapshot: () => unknown) => {
            subscribe(() => {
                changeCount++;
            });
            return getSnapshot();
        }
    );

    return {
        getMarkup: () => renderWithStore(element),
        getChangeCount: () => changeCount,
    };
}

function getRightEditorFileTabsMarkup(markup: string): string {
    const labelIndex = markup.indexOf('aria-label="Right editor file tabs"');
    expect(labelIndex).toBeGreaterThan(-1);
    const tabBarStart = markup.lastIndexOf("<div", labelIndex);
    expect(tabBarStart).toBeGreaterThan(-1);

    const divTagPattern = /<\/?div(?:\s[^>]*)?>/g;
    divTagPattern.lastIndex = tabBarStart;
    let depth = 0;
    let match: RegExpExecArray | null;
    while ((match = divTagPattern.exec(markup)) != null) {
        if (match[0].startsWith("</")) {
            depth--;
            if (depth === 0) {
                return markup.slice(tabBarStart, match.index + match[0].length);
            }
            continue;
        }
        depth++;
    }
    throw new Error("Right editor file tabs markup is missing a closing div");
}

function getVisibleText(markup: string): string {
    return markup.replace(/<[^>]*>/g, "");
}

function countMatches(markup: string, pattern: RegExp): number {
    return markup.match(pattern)?.length ?? 0;
}

function makeTestOpenFile(input: TestOpenFileInput) {
    return {
        path: input.path,
        uri: `file://${input.path}`,
        language: input.language,
        workspaceRoot: input.workspaceRoot ?? "/repo",
        readonly: false,
        savedText: "",
        dirtyText: null,
        saveStatus: "idle" as const,
        error: null,
    };
}

function mountCapturedEditor(): (event: KeyDownEvent) => void {
    let keyDownHandler: (event: KeyDownEvent) => void;
    mockWorkbench.codeEditorProps[0].onMount({
        onKeyDown: (handler: (event: KeyDownEvent) => void) => {
            keyDownHandler = handler;
            return { dispose: vi.fn() };
        },
    });
    return keyDownHandler;
}

describe("RightEditorWorkbench", () => {
    beforeEach(() => {
        RightEditorModel.resetInstance();
        mockWorkbench.codeEditorProps = [];
        mockWorkbench.getOrCreateModel.mockClear();
        mockWorkbench.lspSnapshot = 0;
        mockWorkbench.lspStatus = null;
        mockWorkbench.lspStatusListeners.clear();
        mockWorkbench.useSyncExternalStore.mockReset();
        mockWorkbench.useSyncExternalStore.mockImplementation((_subscribe: any, getSnapshot: any) => getSnapshot());
        vi.mocked(languageClientManager.acquireClient).mockClear();
        vi.mocked(languageClientManager.getStatus).mockReset();
        vi.mocked(languageClientManager.getStatus).mockImplementation((input) => ({
            ...(mockWorkbench.lspStatus ?? {
                workspaceRoot: input.workspaceRoot,
                language: input.language,
                serverId: input.serverId ?? null,
                displayName: input.displayName ?? input.language,
                state: "stopped",
                message: null,
            }),
        }));
        vi.mocked(languageClientManager.getStatusSnapshot).mockReset();
        vi.mocked(languageClientManager.getStatusSnapshot).mockImplementation(() => mockWorkbench.lspSnapshot);
        vi.mocked(languageClientManager.subscribeStatus).mockReset();
        vi.mocked(languageClientManager.subscribeStatus).mockImplementation((_input, listener) => {
            mockWorkbench.lspStatusListeners.add(listener);
            return () => {
                mockWorkbench.lspStatusListeners.delete(listener);
            };
        });
        vi.unstubAllGlobals();
    });

    it("renders an empty state when no file is open", () => {
        const markup = renderWithStore(<RightEditorWorkbench model={RightEditorModel.getInstance(rpc)} />);
        expect(markup).toContain("Open a file from the explorer");
    });

    it("renders open file tabs", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");
        await model.openFile("/repo/test/app.ts", "/repo");
        model.updateText("/repo/test/app.ts", "dirty");

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);
        expect(markup).toContain('aria-label="Right editor file tabs"');
        expect(markup).toContain('aria-label="Save /repo/test/app.ts"');
        const fileTabsMarkup = getRightEditorFileTabsMarkup(markup);
        expect(fileTabsMarkup).toContain("app.ts");
        expect(fileTabsMarkup).toContain("●");
        expect(fileTabsMarkup).not.toContain("Save app.ts");
        const visibleText = getVisibleText(fileTabsMarkup);
        expect(visibleText).not.toContain("/repo/");
        expect(visibleText).not.toContain("src/");
        expect(visibleText).not.toContain("test/");
    });

    it("returns relative parent suffixes for right editor tabs", () => {
        const getRightEditorTabPathSuffix = (rightEditorWorkbench as RightEditorWorkbenchExports)
            .getRightEditorTabPathSuffix;

        expect(getRightEditorTabPathSuffix).toBeTypeOf("function");
        expect(getRightEditorTabPathSuffix?.("/repo/src/app.ts", "/repo")).toBe("src");
        expect(getRightEditorTabPathSuffix?.("/repo/packages/web/src/app.ts", "/repo")).toBe("packages/web/src");
        expect(getRightEditorTabPathSuffix?.("/a/src/app.ts", "/")).toBe("a/src");
        expect(getRightEditorTabPathSuffix?.("/other/src/app.ts", "/repo")).toBe("src");
        expect(getRightEditorTabPathSuffix?.("/repo/app.ts", "/repo")).toBe("");
        expect(getRightEditorTabPathSuffix?.(String.raw`C:\repo\src\app.ts`, String.raw`C:\repo`)).toBe("src");
    });

    it("shows suffixes only when open files need name disambiguation", () => {
        const files = [
            { path: "/repo/src/app.ts", workspaceRoot: "/repo" },
            { path: "/repo/test/app.ts", workspaceRoot: "/repo" },
            { path: "/repo/docs/readme.md", workspaceRoot: "/repo" },
        ];

        expect(getRightEditorFileTabDisplay(files[0], files)).toEqual({ name: "app.ts", suffix: "src" });
        expect(getRightEditorFileTabDisplay(files[1], files)).toEqual({ name: "app.ts", suffix: "test" });
        expect(getRightEditorFileTabDisplay(files[2], files)).toEqual({ name: "readme.md", suffix: "" });
    });

    it("uses the shortest unique parent suffix for deeply nested duplicate file names", () => {
        const files = [
            { path: "/repo/packages/web/src/index.ts", workspaceRoot: "/repo" },
            { path: "/repo/apps/web/src/index.ts", workspaceRoot: "/repo" },
            { path: "/repo/packages/api/src/index.ts", workspaceRoot: "/repo" },
        ];

        expect(getRightEditorFileTabDisplay(files[0], files).suffix).toBe("packages/web/src");
        expect(getRightEditorFileTabDisplay(files[1], files).suffix).toBe("apps/web/src");
        expect(getRightEditorFileTabDisplay(files[2], files).suffix).toBe("api/src");
    });

    it("includes workspace labels when duplicate file names share the same relative parent suffix", () => {
        const files = [
            { path: "/repo-a/src/app.ts", workspaceRoot: "/repo-a" },
            { path: "/repo-b/src/app.ts", workspaceRoot: "/repo-b" },
        ];

        expect(getRightEditorFileTabDisplay(files[0], files).suffix).toBe("repo-a/src");
        expect(getRightEditorFileTabDisplay(files[1], files).suffix).toBe("repo-b/src");
    });

    it("disambiguates duplicate tabs when the requested file is an equivalent object from outside openFiles", () => {
        const files = [
            { path: "/repo-a/src/app.ts", workspaceRoot: "/repo-a" },
            { path: "/repo-b/src/app.ts", workspaceRoot: "/repo-b" },
        ];

        expect(getRightEditorFileTabDisplay({ ...files[0] }, files)).toEqual({
            name: "app.ts",
            suffix: "repo-a/src",
        });
    });

    it("renders Trae-style file tabs with filename and relative parent suffix", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");
        await model.openFile("/repo/test/app.ts", "/repo");

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);
        const fileTabsMarkup = getRightEditorFileTabsMarkup(markup);

        expect(fileTabsMarkup).toContain("app.ts");
        expect(fileTabsMarkup).toContain("src");
        expect(fileTabsMarkup).toContain("test");
        expect(fileTabsMarkup).toContain('data-overflow-behavior="no-horizontal-scroll"');
        const visibleText = getVisibleText(fileTabsMarkup);
        expect(visibleText).not.toContain("/repo/");
        expect(visibleText).not.toContain("src/");
        expect(visibleText).not.toContain("test/");
    });

    it("renders Windows file tabs with filename and relative parent suffix without showing the drive path", async () => {
        const model = RightEditorModel.getInstance(rpc);
        const path = String.raw`C:\repo\src\app.ts`;
        await model.openFile(path, String.raw`C:\repo`);

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);
        const fileTabsMarkup = getRightEditorFileTabsMarkup(markup);
        const visibleText = getVisibleText(fileTabsMarkup);

        expect(visibleText).toContain("app.ts");
        expect(visibleText).not.toContain("src");
        expect(visibleText).not.toContain(String.raw`C:\repo`);
        expect(fileTabsMarkup).toContain(`title="${path}"`);
        expect(fileTabsMarkup).toContain(`aria-label="Select ${path}"`);
        expect(fileTabsMarkup).toContain(`aria-label="Close ${path}"`);
    });

    it("centers file tab content and hides all file tab close buttons until hover", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");
        await model.openFile("/repo/test/app.ts", "/repo");

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);
        const fileTabsMarkup = getRightEditorFileTabsMarkup(markup);

        expect(fileTabsMarkup).toContain('data-tab-content-align="center"');
        expect(fileTabsMarkup).toContain('data-close-visibility="hover"');
        expect(fileTabsMarkup).not.toContain('data-close-visibility="always"');
        expect(fileTabsMarkup).not.toContain(" opacity-100");
    });

    it("keeps every file tab select and close control rendered when many tabs are open", async () => {
        const model = RightEditorModel.getInstance(rpc);
        const paths = [
            "/repo/src/app.ts",
            "/repo/test/app.ts",
            "/repo/docs/readme.md",
            "/repo/packages/web/index.tsx",
            "/repo/scripts/build.ts",
        ];
        for (const path of paths) {
            await model.openFile(path, "/repo");
        }

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);
        const fileTabsMarkup = getRightEditorFileTabsMarkup(markup);

        expect(fileTabsMarkup).toContain('data-overflow-behavior="no-horizontal-scroll"');
        expect(countMatches(fileTabsMarkup, /aria-label="Select /g)).toBe(paths.length);
        expect(countMatches(fileTabsMarkup, /aria-label="Close /g)).toBe(paths.length);
        for (const path of paths) {
            expect(fileTabsMarkup).toContain(`aria-label="Select ${path}"`);
            expect(fileTabsMarkup).toContain(`aria-label="Close ${path}"`);
        }
    });

    it("uses adaptive file tab widths without horizontal scrolling and hides labels when narrow", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/packages/web/src/index.ts", "/repo");
        await model.openFile("/repo/apps/web/src/index.ts", "/repo");

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);
        const fileTabsMarkup = getRightEditorFileTabsMarkup(markup);
        const visibleText = getVisibleText(fileTabsMarkup);

        expect(fileTabsMarkup).toContain('data-overflow-behavior="no-horizontal-scroll"');
        expect(fileTabsMarkup).toContain('data-tab-sizing="adaptive-fill"');
        expect(fileTabsMarkup).toContain('data-tab-width="adaptive-by-count"');
        expect(fileTabsMarkup).toContain('data-label-collapse="hide-on-narrow"');
        expect(fileTabsMarkup).toContain("container-type:inline-size");
        expect(fileTabsMarkup).toContain("[@container(max-width:9rem)]:hidden");
        expect(fileTabsMarkup).not.toContain("overflow-x-auto");
        expect(fileTabsMarkup).not.toContain("no-scrollbar");
        expect(fileTabsMarkup).not.toContain("scrollbar-width:none");
        expect(fileTabsMarkup).toContain('data-name-display="full-priority"');
        expect(fileTabsMarkup).toContain("overflow-hidden");
        expect(fileTabsMarkup).not.toContain("min-w-8");
        expect(fileTabsMarkup).not.toContain("shrink-0 truncate font-medium");
        expect(fileTabsMarkup).toContain('data-suffix-priority="shrink-first"');
        expect(fileTabsMarkup).not.toContain("basis-0");
        expect(fileTabsMarkup).not.toContain("max-w-56");
        expect(fileTabsMarkup).not.toContain("whitespace-nowrap");
        expect(fileTabsMarkup).not.toContain("h-9");
        expect(fileTabsMarkup).not.toContain("min-w-[14rem]");
        expect(visibleText).toContain("index.ts");
        expect(visibleText).toContain("packages/web/src");
        expect(visibleText).toContain("apps/web/src");
    });

    it("keeps full paths discoverable for same-name tabs without showing them as visible tab text", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo-a/src/app.ts", "/repo-a");
        await model.openFile("/repo-b/src/app.ts", "/repo-b");

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);
        const fileTabsMarkup = getRightEditorFileTabsMarkup(markup);
        const visibleText = getVisibleText(fileTabsMarkup);

        expect(fileTabsMarkup).toContain('title="/repo-a/src/app.ts"');
        expect(fileTabsMarkup).toContain('aria-label="Select /repo-a/src/app.ts"');
        expect(fileTabsMarkup).toContain('aria-label="Close /repo-a/src/app.ts"');
        expect(fileTabsMarkup).toContain('title="/repo-b/src/app.ts"');
        expect(fileTabsMarkup).toContain('aria-label="Select /repo-b/src/app.ts"');
        expect(fileTabsMarkup).toContain('aria-label="Close /repo-b/src/app.ts"');
        expect(markup).toContain('aria-label="Save /repo-b/src/app.ts"');
        expect(markup).toContain('title="/repo-b/src/app.ts"');
        expect(markup.match(/title="\/repo-b\/src\/app\.ts"/g)?.length).toBeGreaterThanOrEqual(4);
        expect(visibleText).not.toContain("/repo-a/");
        expect(visibleText).not.toContain("/repo-b/");
        expect(visibleText).toContain("repo-a/src");
        expect(visibleText).toContain("repo-b/src");
    });

    it("uses the file uri model from MonacoModelRegistry for the active file", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");

        renderWithStore(<RightEditorWorkbench model={model} />);

        expect(mockWorkbench.getOrCreateModel).toHaveBeenCalledWith({
            path: "/repo/src/app.ts",
            uri: "file:///repo/src/app.ts",
            text: "const x = 1;",
            language: "typescript",
        });
        expect(mockWorkbench.codeEditorProps[0].model).toBe(mockWorkbench.registryModel);
    });

    it("starts LSP for registered languages with a workspace root", () => {
        expect(shouldStartRightEditorLsp("typescript", "/repo")).toBe(true);
        expect(shouldStartRightEditorLsp("typescriptreact", "/repo")).toBe(true);
        expect(shouldStartRightEditorLsp("javascript", "/repo")).toBe(true);
        expect(shouldStartRightEditorLsp("javascriptreact", "/repo")).toBe(true);
        expect(shouldStartRightEditorLsp("go", "/repo")).toBe(true);
        expect(shouldStartRightEditorLsp("typescript", "")).toBe(false);
        expect(shouldStartRightEditorLsp("go", "")).toBe(false);
        expect(shouldStartRightEditorLsp("json", "/repo")).toBe(false);
    });

    it("acquires LSP for supported active files and releases on effect cleanup", () => {
        const release = vi.fn();
        const lspManager = {
            acquireClient: vi.fn(() => release),
        };

        const cleanup = acquireRightEditorLspForActiveFile({
            activeFile: {
                path: "/repo/src/app.ts",
                uri: "file:///repo/src/app.ts",
                language: "typescript",
                workspaceRoot: "/repo",
                readonly: false,
                savedText: "",
                dirtyText: null,
                saveStatus: "idle",
                error: null,
            },
            workspaceRoot: "/repo",
            lspManager,
        });

        expect(lspManager.acquireClient).toHaveBeenCalledWith({
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
        });
        cleanup();
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("acquires LSP with the active file workspace root", () => {
        const lspManager = {
            acquireClient: vi.fn(() => vi.fn()),
        };

        acquireRightEditorLspForActiveFile({
            activeFile: {
                path: "/repo-a/src/app.ts",
                uri: "file:///repo-a/src/app.ts",
                language: "typescript",
                workspaceRoot: "/repo-a",
                readonly: false,
                savedText: "",
                dirtyText: null,
                saveStatus: "idle",
                error: null,
            },
            workspaceRoot: "/repo-b",
            lspManager,
        });

        expect(lspManager.acquireClient).toHaveBeenCalledWith({
            workspaceRoot: "/repo-a",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
        });
    });

    it("acquires Go LSP through gopls", () => {
        const release = vi.fn();
        const lspManager = {
            acquireClient: vi.fn(() => release),
        };

        const cleanup = acquireRightEditorLspForActiveFile({
            activeFile: {
                path: "/repo/main.go",
                uri: "file:///repo/main.go",
                language: "go",
                workspaceRoot: "/repo",
                readonly: false,
                savedText: "package main\n",
                dirtyText: null,
                saveStatus: "idle",
                error: null,
            },
            workspaceRoot: "/repo",
            lspManager,
        });

        expect(lspManager.acquireClient).toHaveBeenCalledWith({
            workspaceRoot: "/repo",
            language: "go",
            serverId: "gopls",
            displayName: "Go",
            languages: ["go"],
        });
        cleanup();
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("does not acquire LSP for unsupported active files", () => {
        const lspManager = {
            acquireClient: vi.fn(() => vi.fn()),
        };

        const cleanup = acquireRightEditorLspForActiveFile({
            activeFile: {
                path: "/repo/package.json",
                uri: "file:///repo/package.json",
                language: "json",
                workspaceRoot: "/repo",
                readonly: false,
                savedText: "",
                dirtyText: null,
                saveStatus: "idle",
                error: null,
            },
            workspaceRoot: "/repo",
            lspManager,
        });

        expect(lspManager.acquireClient).not.toHaveBeenCalled();
        expect(cleanup).toBeUndefined();
    });

    it("returns basic editing status for unsupported active files", () => {
        const lspManager = {
            getStatus: vi.fn(),
        };

        const details = getRightEditorLspStatusForActiveFile({
            activeFile: makeTestOpenFile({ path: "/repo/package.json", language: "json" }),
            workspaceRoot: "/repo",
            lspManager,
        });

        expect(lspManager.getStatus).not.toHaveBeenCalled();
        expect(details).toEqual({
            supported: false,
            installHint: null,
            status: {
                workspaceRoot: "/repo",
                language: "json",
                serverId: null,
                displayName: "JSON",
                state: "stopped",
                message: "Basic editing",
            },
        });
        expect(getRightEditorLspStatusLabel(details?.status)).toBe("Basic editing");
    });

    it("returns shared server status metadata for supported active files", () => {
        const lspManager = {
            getStatus: vi.fn(() => ({
                workspaceRoot: "/repo",
                language: "typescriptreact",
                serverId: "typescript-language-server",
                displayName: "TypeScript/JavaScript",
                state: "running" as const,
                message: null,
            })),
        };

        const details = getRightEditorLspStatusForActiveFile({
            activeFile: makeTestOpenFile({ path: "/repo/src/app.tsx", language: "typescriptreact" }),
            workspaceRoot: "/repo",
            lspManager,
        });

        expect(lspManager.getStatus).toHaveBeenCalledWith({
            workspaceRoot: "/repo",
            language: "typescriptreact",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
        });
        expect(details?.supported).toBe(true);
        expect(details?.installHint).toBeNull();
        expect(getRightEditorLspStatusLabel(details?.status)).toBe("TypeScript/JavaScript LSP ready");
    });

    it("renders basic editing status for unsupported active files", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/package.json", "/repo");

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);

        expect(markup).toContain("Basic editing");
        expect(markup).not.toContain("LSP ready");
    });

    it("renders LSP ready status for running active files", async () => {
        vi.mocked(languageClientManager.getStatus).mockImplementation((input) => ({
            workspaceRoot: input.workspaceRoot,
            language: input.language,
            serverId: input.serverId ?? null,
            displayName: input.displayName ?? input.language,
            state: "running",
            message: null,
        }));
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);

        expect(markup).toContain("TypeScript/JavaScript LSP ready");
    });

    it("renders unavailable LSP status with the install hint", async () => {
        vi.mocked(languageClientManager.getStatus).mockImplementation((input) => ({
            workspaceRoot: input.workspaceRoot,
            language: input.language,
            serverId: input.serverId ?? null,
            displayName: input.displayName ?? input.language,
            state: "unavailable",
            message: null,
        }));
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/main.go", "/repo");

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);

        expect(markup).toContain("Install gopls: go install golang.org/x/tools/gopls@latest");
    });

    it("updates the mounted LSP footer when manager status changes after mount", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");
        const mounted = renderWithMountedStore(<RightEditorWorkbench model={model} />);

        expect(mounted.getMarkup()).toContain("TypeScript/JavaScript LSP stopped");

        mockWorkbench.emitLspStatus({
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            state: "starting",
            message: null,
        });
        expect(mounted.getChangeCount()).toBeGreaterThan(0);
        expect(mounted.getMarkup()).toContain("TypeScript/JavaScript LSP starting");

        mockWorkbench.emitLspStatus({
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            state: "running",
            message: null,
        });
        expect(mounted.getMarkup()).toContain("TypeScript/JavaScript LSP ready");

        mockWorkbench.emitLspStatus({
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            state: "error",
            message: "server crashed",
        });
        expect(mounted.getMarkup()).toContain("server crashed");
    });

    it("updates the mounted LSP footer to unavailable with install hint and polite live status", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/main.go", "/repo");
        const mounted = renderWithMountedStore(<RightEditorWorkbench model={model} />);

        mockWorkbench.emitLspStatus({
            workspaceRoot: "/repo",
            language: "go",
            serverId: "gopls",
            displayName: "Go",
            state: "unavailable",
            message: null,
        });

        const markup = mounted.getMarkup();
        expect(markup).toContain("Install gopls: go install golang.org/x/tools/gopls@latest");
        expect(markup).toContain('role="status"');
        expect(markup).toContain('aria-live="polite"');
    });

    it("keeps shared LSP acquisition when active file switches within the same workspace and server", () => {
        const releaseTs = vi.fn();
        const releaseGo = vi.fn();
        const lspManager = {
            acquireClient: vi.fn().mockReturnValueOnce(releaseTs).mockReturnValueOnce(releaseGo),
        };
        let lifecycleKey: string | undefined;
        let cleanup: (() => void) | undefined;
        const syncActiveFile = (activeFile: ReturnType<typeof makeTestOpenFile>) => {
            const nextLifecycleKey = getRightEditorLspLifecycleKeyForActiveFile({
                activeFile,
                workspaceRoot: activeFile.workspaceRoot,
            });
            if (nextLifecycleKey === lifecycleKey) return;
            cleanup?.();
            lifecycleKey = nextLifecycleKey;
            cleanup = acquireRightEditorLspForActiveFile({
                activeFile,
                workspaceRoot: activeFile.workspaceRoot,
                lspManager,
            });
        };

        syncActiveFile(makeTestOpenFile({ path: "/repo/src/app.ts", language: "typescript" }));
        syncActiveFile(makeTestOpenFile({ path: "/repo/src/app.tsx", language: "typescriptreact" }));
        expect(lspManager.acquireClient).toHaveBeenCalledTimes(1);
        expect(releaseTs).not.toHaveBeenCalled();

        syncActiveFile(makeTestOpenFile({ path: "/repo/main.go", language: "go" }));
        expect(releaseTs).toHaveBeenCalledTimes(1);
        expect(lspManager.acquireClient).toHaveBeenCalledTimes(2);

        syncActiveFile(makeTestOpenFile({ path: "/repo/package.json", language: "json" }));
        expect(releaseGo).toHaveBeenCalledTimes(1);
        expect(lspManager.acquireClient).toHaveBeenCalledTimes(2);
    });

    it("asks before closing a dirty file", () => {
        const closeFile = vi.fn();
        const confirmDiscard = vi.fn(() => false);

        closeRightEditorFileWithConfirmation({
            file: {
                path: "/repo/src/app.ts",
                uri: "file:///repo/src/app.ts",
                language: "typescript",
                workspaceRoot: "/repo",
                readonly: false,
                savedText: "saved",
                dirtyText: "dirty",
                saveStatus: "idle",
                error: null,
            },
            name: "app.ts",
            closeFile,
            confirmDiscard,
        });

        expect(confirmDiscard).toHaveBeenCalledWith('Discard changes to "app.ts"?');
        expect(closeFile).not.toHaveBeenCalled();
    });

    it("handles primary save and close shortcuts for the active file", () => {
        const saveFile = vi.fn();
        const closeFile = vi.fn();
        const saveHandler = (keybind: string) =>
            handleRightEditorKeyDown({
                key: keybind.slice(keybind.lastIndexOf(":") + 1),
                metaKey: keybind.startsWith("Cmd:"),
                ctrlKey: keybind.startsWith("Ctrl:"),
                shiftKey: false,
                altKey: false,
                activePath: "/repo/src/app.ts",
                saveFile,
                closeFile,
            });
        const closeHandler = saveHandler;

        expect(saveHandler("Cmd:s")).toBe(true);
        expect(closeHandler("Cmd:w")).toBe(true);
        expect(saveHandler("Cmd:m")).toBe(false);
        expect(saveFile).toHaveBeenCalledWith("/repo/src/app.ts");
        expect(closeFile).toHaveBeenCalledWith("/repo/src/app.ts");
    });

    it("does not close for Cmd+Shift+W", () => {
        const saveFile = vi.fn();
        const closeFile = vi.fn();

        const handled = handleRightEditorKeyDown({
            key: "w",
            metaKey: true,
            ctrlKey: false,
            shiftKey: true,
            altKey: false,
            activePath: "/repo/src/app.ts",
            saveFile,
            closeFile,
        });

        expect(handled).toBe(false);
        expect(closeFile).not.toHaveBeenCalled();
    });

    it("keeps a dirty active file open when Cmd+W discard confirmation is canceled", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");
        model.updateText("/repo/src/app.ts", "dirty");
        const confirmSpy = vi.fn(() => false);
        vi.stubGlobal("window", { confirm: confirmSpy });
        renderWithStore(<RightEditorWorkbench model={model} />);

        const keyDownHandler = mountCapturedEditor();
        keyDownHandler({
            browserEvent: { key: "w", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        });

        expect(confirmSpy).toHaveBeenCalledWith('Discard changes to "app.ts"?');
        expect(model.getOpenFileNow("/repo/src/app.ts")).toBeTruthy();
    });

    it("closes a dirty active file when Cmd+W discard confirmation is accepted", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");
        model.updateText("/repo/src/app.ts", "dirty");
        const confirmSpy = vi.fn(() => true);
        vi.stubGlobal("window", { confirm: confirmSpy });
        renderWithStore(<RightEditorWorkbench model={model} />);

        const keyDownHandler = mountCapturedEditor();
        keyDownHandler({
            browserEvent: { key: "w", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        });

        expect(confirmSpy).toHaveBeenCalledWith('Discard changes to "app.ts"?');
        expect(model.getOpenFileNow("/repo/src/app.ts")).toBeFalsy();
    });
});
