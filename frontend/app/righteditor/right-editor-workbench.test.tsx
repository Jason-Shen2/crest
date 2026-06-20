// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { acquireRightEditorLspForActiveFile, RightEditorWorkbench, shouldStartRightEditorLsp } from "./right-editor-workbench";

const rpc = {
    readFile: vi.fn(async () => ({ text: "const x = 1;", readonly: false })),
    writeFile: vi.fn(async () => undefined),
};

function renderWithStore(element: ReactElement): string {
    return renderToStaticMarkup(<Provider store={globalStore}>{element}</Provider>);
}

describe("RightEditorWorkbench", () => {
    beforeEach(() => {
        RightEditorModel.resetInstance();
        mockWorkbench.codeEditorProps = [];
        mockWorkbench.getOrCreateModel.mockClear();
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
        expect(shouldStartRightEditorLsp("javascript", "/repo")).toBe(true);
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

    it("does not acquire LSP for unsupported active files", () => {
        const lspManager = {
            acquireClient: vi.fn(() => vi.fn()),
        };

        const cleanup = acquireRightEditorLspForActiveFile({
            activeFile: {
                path: "/repo/package.json",
                uri: "file:///repo/package.json",
                language: "json",
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
});
