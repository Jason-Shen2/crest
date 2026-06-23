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
    },
}));

import { languageClientManager } from "./lsp/language-client-manager";
import { RightEditorModel } from "./right-editor-model";
import {
    acquireRightEditorLspForActiveFile,
    closeRightEditorFileWithConfirmation,
    getRightEditorLspStatusForActiveFile,
    getRightEditorLspLifecycleKeyForActiveFile,
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
        vi.mocked(languageClientManager.acquireClient).mockClear();
        vi.mocked(languageClientManager.getStatus).mockReset();
        vi.mocked(languageClientManager.getStatus).mockImplementation((input) => ({
            workspaceRoot: input.workspaceRoot,
            language: input.language,
            serverId: input.serverId ?? null,
            displayName: input.displayName ?? input.language,
            state: "stopped",
            message: null,
        }));
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
        expect(fileTabsMarkup).toContain("src");
        expect(fileTabsMarkup).toContain("test");
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

    it("renders Trae-style file tabs with filename and relative parent suffix", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");
        await model.openFile("/repo/test/app.ts", "/repo");

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);
        const fileTabsMarkup = getRightEditorFileTabsMarkup(markup);

        expect(fileTabsMarkup).toContain("app.ts");
        expect(fileTabsMarkup).toContain("src");
        expect(fileTabsMarkup).toContain("test");
        expect(fileTabsMarkup).toContain('data-overflow-behavior="horizontal-scroll"');
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
        expect(visibleText).toContain("src");
        expect(visibleText).not.toContain(String.raw`C:\repo`);
        expect(fileTabsMarkup).toContain(`title="${path}"`);
        expect(fileTabsMarkup).toContain(`aria-label="Select ${path}"`);
        expect(fileTabsMarkup).toContain(`aria-label="Close ${path}"`);
    });

    it("hides file tab close buttons until hover while keeping the active tab close button visible", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");
        await model.openFile("/repo/test/app.ts", "/repo");

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);
        const fileTabsMarkup = getRightEditorFileTabsMarkup(markup);

        expect(fileTabsMarkup).toContain('data-close-visibility="hover"');
        expect(fileTabsMarkup).toContain('data-close-visibility="always"');
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

        expect(fileTabsMarkup).toContain('data-overflow-behavior="horizontal-scroll"');
        expect(countMatches(fileTabsMarkup, /aria-label="Select /g)).toBe(paths.length);
        expect(countMatches(fileTabsMarkup, /aria-label="Close /g)).toBe(paths.length);
        for (const path of paths) {
            expect(fileTabsMarkup).toContain(`aria-label="Select ${path}"`);
            expect(fileTabsMarkup).toContain(`aria-label="Close ${path}"`);
        }
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
