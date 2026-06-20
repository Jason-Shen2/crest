// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFileExplorer = vi.hoisted(() => ({
    createBlock: vi.fn(),
    layoutModel: {
        openRightTool: vi.fn(),
        openRightEditorTool: vi.fn(),
    },
}));

vi.mock("@/store/global", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    return {
        atoms: {
            staticTabId: jotaiActual.atom("tab-a"),
        },
        createBlock: mockFileExplorer.createBlock,
        getApi: () => ({
            createTab: vi.fn(),
            getHomeDir: () => "/repo",
            watchDir: vi.fn(),
            unwatchDir: vi.fn(),
        }),
        getFocusedBlockId: () => null,
    };
});

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        ControllerInputCommand: vi.fn(),
        FileCreateCommand: vi.fn(),
        FileDeleteCommand: vi.fn(),
        FileListStreamCommand: vi.fn(),
        FileMkdirCommand: vi.fn(),
        FileMoveCommand: vi.fn(),
        FileReadCommand: vi.fn(async () => ({
            data64: "aW5pdGlhbA==",
            info: { readonly: false },
        })),
        FileWriteCommand: vi.fn(),
    },
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: { routeid: "tab" },
}));

vi.mock("@/app/workspace/workspace-layout-model", () => ({
    WorkspaceLayoutModel: {
        getInstance: () => mockFileExplorer.layoutModel,
    },
}));

import { RpcApi } from "@/app/store/wshclientapi";
import { RightEditorModel } from "@/app/righteditor/right-editor-model";
import { FileExplorerModel } from "./file-explorer-model";

describe("FileExplorerModel", () => {
    beforeEach(() => {
        (FileExplorerModel as any).instance = null;
        RightEditorModel.resetInstance();
        mockFileExplorer.createBlock.mockClear();
        mockFileExplorer.layoutModel.openRightTool.mockClear();
        mockFileExplorer.layoutModel.openRightEditorTool.mockClear();
        mockFileExplorer.layoutModel.openRightEditorTool.mockImplementation(() => {
            mockFileExplorer.layoutModel.openRightTool("editor");
        });
        vi.mocked(RpcApi.FileReadCommand).mockClear();
    });

    it("opens non-directory files in the right editor before the panel renders", async () => {
        const model = FileExplorerModel.getInstance();
        globalStore.set(model.rootAtom, "/repo");

        await model.openFile({
            path: "/repo/src/app.ts",
            name: "app.ts",
            isdir: false,
        });

        expect(mockFileExplorer.layoutModel.openRightTool).toHaveBeenCalledWith("editor");
        expect(vi.mocked(RpcApi.FileReadCommand).mock.calls[0][1]).toMatchObject({
            info: { path: "/repo/src/app.ts" },
        });
        expect(RightEditorModel.getInstance().getOpenFileNow("/repo/src/app.ts")).toMatchObject({
            savedText: "initial",
        });
        expect(mockFileExplorer.createBlock).not.toHaveBeenCalled();
    });
});
