// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFileExplorer = vi.hoisted(() => ({
    createBlock: vi.fn(),
    layoutModel: {
        openRightTool: vi.fn(),
        openRightEditorTool: vi.fn(),
    },
    settingsAtoms: new Map<string, any>(),
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
        getSettingsKeyAtom: (key: string) => {
            let settingAtom = mockFileExplorer.settingsAtoms.get(key);
            if (settingAtom != null) {
                return settingAtom;
            }
            settingAtom = jotaiActual.atom(null);
            mockFileExplorer.settingsAtoms.set(key, settingAtom);
            return settingAtom;
        },
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
import { getSettingsKeyAtom } from "@/store/global";
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
        for (const settingAtom of mockFileExplorer.settingsAtoms.values()) {
            globalStore.set(settingAtom, null);
        }
        vi.mocked(RpcApi.FileReadCommand).mockClear();
        vi.mocked(RpcApi.FileListStreamCommand).mockClear();
        vi.mocked(RpcApi.FileMoveCommand).mockClear();
        vi.mocked(RpcApi.FileDeleteCommand).mockClear();
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

    it("hides dotfiles from fetched children by default", async () => {
        vi.mocked(RpcApi.FileListStreamCommand).mockReturnValue(makeFileListStream([
            { path: "/repo/.env", name: ".env", isdir: false },
            { path: "/repo/src", name: "src", isdir: true },
            { path: "/repo/app.ts", name: "app.ts", isdir: false },
        ]));
        const model = FileExplorerModel.getInstance();

        await model.fetchChildren("/repo");

        expect(model.getChildren("/repo")?.map((entry) => entry.name)).toEqual(["src", "app.ts"]);
    });

    it("includes dotfiles when the file explorer show hidden setting is enabled", async () => {
        globalStore.set(getSettingsKeyAtom("preview:showhiddenfiles") as PrimitiveAtom<boolean>, true);
        vi.mocked(RpcApi.FileListStreamCommand).mockReturnValue(makeFileListStream([
            { path: "/repo/.env", name: ".env", isdir: false },
            { path: "/repo/src", name: "src", isdir: true },
            { path: "/repo/app.ts", name: "app.ts", isdir: false },
        ]));
        const model = FileExplorerModel.getInstance();

        await model.fetchChildren("/repo");

        expect(model.getChildren("/repo")?.map((entry) => entry.name)).toEqual(["src", ".env", "app.ts"]);
    });

    it("syncs successful renames to the right editor", async () => {
        const model = FileExplorerModel.getInstance();
        globalStore.set(model.rootAtom, "/repo");
        await RightEditorModel.getInstance(makeTestRpc()).openFile("/repo/a.ts", "/repo");
        RightEditorModel.getInstance().updateText("/repo/a.ts", "dirty");

        await model.commitRename("/repo/a.ts", "b.ts");

        expect(vi.mocked(RpcApi.FileMoveCommand)).toHaveBeenCalled();
        expect(RightEditorModel.getInstance().getOpenFileNow("/repo/a.ts")).toBeUndefined();
        expect(RightEditorModel.getInstance().getOpenFileNow("/repo/b.ts")?.dirtyText).toBe("dirty");
    });

    it("syncs directory renames to open child files in the right editor", async () => {
        const model = FileExplorerModel.getInstance();
        globalStore.set(model.rootAtom, "/repo");
        await RightEditorModel.getInstance(makeTestRpc()).openFile("/repo/src/a.ts", "/repo");
        RightEditorModel.getInstance().updateText("/repo/src/a.ts", "dirty");

        await model.commitRename("/repo/src", "lib");

        expect(vi.mocked(RpcApi.FileMoveCommand)).toHaveBeenCalled();
        expect(RightEditorModel.getInstance().getOpenFileNow("/repo/src/a.ts")).toBeUndefined();
        expect(RightEditorModel.getInstance().getOpenFileNow("/repo/lib/a.ts")?.dirtyText).toBe("dirty");
    });

    it("does not create a right editor model when syncing a rename with no open editor", async () => {
        const model = FileExplorerModel.getInstance();
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await model.commitRename("/repo/a.ts", "b.ts");

        expect(vi.mocked(RpcApi.FileMoveCommand)).toHaveBeenCalled();
        expect(RightEditorModel.hasInstance()).toBe(false);
        expect(consoleError).not.toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it("syncs successful deletes to the right editor", async () => {
        const model = FileExplorerModel.getInstance();
        globalStore.set(model.rootAtom, "/repo");
        await RightEditorModel.getInstance(makeTestRpc()).openFile("/repo/a.ts", "/repo");

        await model.deleteFile("/repo/a.ts");

        expect(vi.mocked(RpcApi.FileDeleteCommand)).toHaveBeenCalled();
        expect(RightEditorModel.getInstance().getOpenFileNow("/repo/a.ts")).toBeUndefined();
    });

    it("syncs directory deletes to open child files in the right editor", async () => {
        const model = FileExplorerModel.getInstance();
        globalStore.set(model.rootAtom, "/repo");
        await RightEditorModel.getInstance(makeTestRpc()).openFile("/repo/src/a.ts", "/repo");
        await RightEditorModel.getInstance().openFile("/repo/src-not-child/b.ts", "/repo");

        await model.deleteFile("/repo/src");

        expect(vi.mocked(RpcApi.FileDeleteCommand)).toHaveBeenCalled();
        expect(RightEditorModel.getInstance().getOpenFileNow("/repo/src/a.ts")).toBeUndefined();
        expect(RightEditorModel.getInstance().getOpenFileNow("/repo/src-not-child/b.ts")).toBeDefined();
    });

    it("does not create a right editor model when syncing a delete with no open editor", async () => {
        const model = FileExplorerModel.getInstance();
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await model.deleteFile("/repo/a.ts");

        expect(vi.mocked(RpcApi.FileDeleteCommand)).toHaveBeenCalled();
        expect(RightEditorModel.hasInstance()).toBe(false);
        expect(consoleError).not.toHaveBeenCalled();
        consoleError.mockRestore();
    });
});

function makeTestRpc() {
    return {
        readFile: vi.fn(async () => ({ text: "initial", readonly: false })),
        writeFile: vi.fn(async () => undefined),
    };
}

async function* makeFileListStream(fileinfo: FileInfo[]): AsyncGenerator<CommandRemoteListEntriesRtnData, void, boolean> {
    yield { fileinfo };
}
