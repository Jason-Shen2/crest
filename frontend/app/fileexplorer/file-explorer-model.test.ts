// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFileExplorer = vi.hoisted(() => ({
    createBlock: vi.fn(),
    openFileInEditorTab: vi.fn(),
    objectService: {
        DeleteBlock: vi.fn(),
        UpdateObjectMeta: vi.fn(),
    },
    workspaceService: {
        CloseTab: vi.fn(),
    },
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
            workspace: jotaiActual.atom(null),
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

vi.mock("@/app/store/windowtype", () => ({
    isPreviewWindow: () => true,
    setWaveWindowType: vi.fn(),
}));

vi.mock("@/app/store/services", () => ({
    ObjectService: mockFileExplorer.objectService,
    WorkspaceService: mockFileExplorer.workspaceService,
}));

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

vi.mock("./open-editor-tab", () => ({
    openFileInEditorTab: mockFileExplorer.openFileInEditorTab,
}));

import { RpcApi } from "@/app/store/wshclientapi";
import { RightEditorModel } from "@/app/righteditor/right-editor-model";
import * as WOS from "@/app/store/wos";
import { atoms, getSettingsKeyAtom } from "@/store/global";
import { FileExplorerModel } from "./file-explorer-model";

let nextWaveObjectVersion = 1;

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
        mockFileExplorer.openFileInEditorTab.mockReset();
        mockFileExplorer.openFileInEditorTab.mockResolvedValue({ tabId: "tab-editor", created: true });
        mockFileExplorer.objectService.DeleteBlock.mockReset();
        mockFileExplorer.objectService.UpdateObjectMeta.mockReset();
        mockFileExplorer.workspaceService.CloseTab.mockReset();
        vi.mocked(RpcApi.FileReadCommand).mockClear();
        vi.mocked(RpcApi.FileListStreamCommand).mockClear();
        vi.mocked(RpcApi.FileMoveCommand).mockClear();
        vi.mocked(RpcApi.FileDeleteCommand).mockClear();
        globalStore.set(atoms.workspace as any, {
            oid: "workspace-1",
            tabids: [],
        } as Workspace);
    });

    it("opens non-directory files in a main editor tab without opening the right editor", async () => {
        const model = FileExplorerModel.getInstance();
        globalStore.set(model.rootAtom, "/repo");

        await model.openFile({
            path: "/repo/src/app.ts",
            name: "app.ts",
            isdir: false,
        });

        expect(mockFileExplorer.openFileInEditorTab).toHaveBeenCalledWith("/repo/src/app.ts", "/repo");
        expect(mockFileExplorer.layoutModel.openRightTool).not.toHaveBeenCalled();
        expect(mockFileExplorer.layoutModel.openRightEditorTool).not.toHaveBeenCalled();
        expect(vi.mocked(RpcApi.FileReadCommand)).not.toHaveBeenCalled();
        expect(RightEditorModel.hasInstance()).toBe(false);
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

    it("syncs successful renames to matching codeeditor block metadata", async () => {
        const model = FileExplorerModel.getInstance();
        globalStore.set(model.rootAtom, "/repo");
        seedWorkspaceTabs([
            makeTab("tab-1", ["block-1"]),
            makeTab("tab-2", ["block-2"]),
        ]);
        seedBlock("block-1", { view: "termblocks", "cmd:cwd": "/repo" });
        seedBlock("block-2", { view: "codeeditor", file: "/repo/a.ts", connection: "" });

        await model.commitRename("/repo/a.ts", "b.ts");

        expect(vi.mocked(RpcApi.FileMoveCommand)).toHaveBeenCalled();
        expect(mockFileExplorer.objectService.UpdateObjectMeta).toHaveBeenCalledWith("block:block-2", {
            view: "codeeditor",
            file: "/repo/b.ts",
            connection: "",
        });
        expect(mockFileExplorer.workspaceService.CloseTab).not.toHaveBeenCalled();
        expect(mockFileExplorer.objectService.DeleteBlock).not.toHaveBeenCalled();
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

    it("syncs directory renames to matching child codeeditor block metadata only", async () => {
        const model = FileExplorerModel.getInstance();
        globalStore.set(model.rootAtom, "/repo");
        seedWorkspaceTabs([makeTab("tab-1", ["block-1"]), makeTab("tab-2", ["block-2"])]);
        seedBlock("block-1", { view: "codeeditor", file: "/repo/src/a.ts", connection: "" });
        seedBlock("block-2", { view: "codeeditor", file: "/repo/src-not-child/b.ts", connection: "" });

        await model.commitRename("/repo/src", "lib");

        expect(mockFileExplorer.objectService.UpdateObjectMeta).toHaveBeenCalledTimes(1);
        expect(mockFileExplorer.objectService.UpdateObjectMeta).toHaveBeenCalledWith("block:block-1", {
            view: "codeeditor",
            file: "/repo/lib/a.ts",
            connection: "",
        });
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

    it("closes the codeeditor tab when deleting the file in its sole block", async () => {
        const model = FileExplorerModel.getInstance();
        globalStore.set(model.rootAtom, "/repo");
        seedWorkspaceTabs([makeTab("tab-1", ["block-1"])]);
        seedBlock("block-1", { view: "codeeditor", file: "/repo/a.ts", connection: "" });

        await model.deleteFile("/repo/a.ts");

        expect(vi.mocked(RpcApi.FileDeleteCommand)).toHaveBeenCalled();
        expect(mockFileExplorer.workspaceService.CloseTab).toHaveBeenCalledWith("workspace-1", "tab-1", false);
        expect(mockFileExplorer.objectService.DeleteBlock).not.toHaveBeenCalled();
        expect(mockFileExplorer.objectService.UpdateObjectMeta).not.toHaveBeenCalled();
    });

    it("removes only the matching codeeditor block when deleting a file in a multi-block tab", async () => {
        const model = FileExplorerModel.getInstance();
        globalStore.set(model.rootAtom, "/repo");
        seedWorkspaceTabs([makeTab("tab-1", ["block-1", "block-2"])]);
        seedBlock("block-1", { view: "codeeditor", file: "/repo/a.ts", connection: "" });
        seedBlock("block-2", { view: "termblocks", "cmd:cwd": "/repo" });

        await model.deleteFile("/repo/a.ts");

        expect(mockFileExplorer.objectService.DeleteBlock).toHaveBeenCalledWith("block-1");
        expect(mockFileExplorer.workspaceService.CloseTab).not.toHaveBeenCalled();
        expect(mockFileExplorer.objectService.UpdateObjectMeta).not.toHaveBeenCalled();
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

    it("removes child codeeditor tabs and preserves sibling-like paths when deleting a directory", async () => {
        const model = FileExplorerModel.getInstance();
        globalStore.set(model.rootAtom, "/repo");
        seedWorkspaceTabs([makeTab("tab-1", ["block-1"]), makeTab("tab-2", ["block-2"])]);
        seedBlock("block-1", { view: "codeeditor", file: "/repo/src/a.ts", connection: "" });
        seedBlock("block-2", { view: "codeeditor", file: "/repo/src-not-child/b.ts", connection: "" });

        await model.deleteFile("/repo/src");

        expect(mockFileExplorer.workspaceService.CloseTab).toHaveBeenCalledTimes(1);
        expect(mockFileExplorer.workspaceService.CloseTab).toHaveBeenCalledWith("workspace-1", "tab-1", false);
        expect(mockFileExplorer.objectService.DeleteBlock).not.toHaveBeenCalled();
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

function seedWorkspaceTabs(tabs: Tab[]): void {
    globalStore.set(atoms.workspace as any, {
        oid: "workspace-1",
        tabids: tabs.map((tab) => tab.oid),
    } as Workspace);
    for (const tab of tabs) {
        WOS.mockObjectForPreview(WOS.makeORef("tab", tab.oid), tab);
        WOS.updateWaveObject({ otype: "tab", oid: tab.oid, updatetype: "update", obj: tab });
    }
}

function seedBlock(blockId: string, meta: MetaType): void {
    const block = {
        oid: blockId,
        otype: "block",
        version: nextWaveObjectVersion++,
        meta,
    } as Block;
    WOS.mockObjectForPreview(WOS.makeORef("block", blockId), block);
    WOS.updateWaveObject({
        otype: "block",
        oid: blockId,
        updatetype: "update",
        obj: block,
    });
}

function makeTab(tabId: string, blockids: string[]): Tab {
    return {
        oid: tabId,
        otype: "tab",
        version: nextWaveObjectVersion++,
        blockids,
    } as Tab;
}
