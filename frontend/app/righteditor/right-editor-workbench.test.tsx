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
        ensureClient: vi.fn(async () => undefined),
    },
}));

import { RightEditorModel } from "./right-editor-model";
import {
    acquireRightEditorLspForActiveFile,
    closeRightEditorFileWithConfirmation,
    handleRightEditorKeyDown,
    RightEditorWorkbench,
    shouldStartRightEditorLsp,
} from "./right-editor-workbench";

const rpc = {
    readFile: vi.fn(async () => ({ text: "const x = 1;", readonly: false })),
    writeFile: vi.fn(async () => undefined),
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
        vi.unstubAllGlobals();
    });

    it("renders an empty state when no file is open", () => {
        const markup = renderWithStore(<RightEditorWorkbench model={RightEditorModel.getInstance(rpc)} />);
        expect(markup).toContain("Open a file from the explorer");
    });

    it("renders open file tabs", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");
        const markup = renderWithStore(<RightEditorWorkbench model={model} />);
        expect(markup).toContain("app.ts");
        expect(markup).toContain('aria-label="Save app.ts"');
    });

    it("returns relative parent suffixes for right editor tabs", () => {
        const getRightEditorTabPathSuffix = (rightEditorWorkbench as RightEditorWorkbenchExports)
            .getRightEditorTabPathSuffix;

        expect(getRightEditorTabPathSuffix).toBeTypeOf("function");
        expect(getRightEditorTabPathSuffix?.("/repo/src/app.ts", "/repo")).toBe("src/");
        expect(getRightEditorTabPathSuffix?.("/repo/packages/web/src/app.ts", "/repo")).toBe("packages/web/src/");
        expect(getRightEditorTabPathSuffix?.("/repo/app.ts", "/repo")).toBe("");
    });

    it("renders Trae-style file tabs with filename and relative parent suffix", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");
        await model.openFile("/repo/test/app.ts", "/repo");

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);

        expect(markup).toContain("app.ts");
        expect(markup).toContain("src/");
        expect(markup).toContain("test/");
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

    it("starts LSP only for JavaScript and TypeScript files with a workspace root", () => {
        expect(shouldStartRightEditorLsp("typescript", "/repo")).toBe(true);
        expect(shouldStartRightEditorLsp("typescriptreact", "/repo")).toBe(true);
        expect(shouldStartRightEditorLsp("javascript", "/repo")).toBe(true);
        expect(shouldStartRightEditorLsp("javascriptreact", "/repo")).toBe(true);
        expect(shouldStartRightEditorLsp("typescript", "")).toBe(false);
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

        expect(lspManager.acquireClient).toHaveBeenCalledWith({ workspaceRoot: "/repo", language: "typescript" });
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

        expect(lspManager.acquireClient).toHaveBeenCalledWith({ workspaceRoot: "/repo-a", language: "typescript" });
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
