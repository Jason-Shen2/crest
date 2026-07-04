// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { buildFileExplorerContextMenu, handleFileExplorerRowClick } from "./file-explorer-tree";

const mockFileExplorerTree = vi.hoisted(() => ({
    createBlock: vi.fn(),
    showContextMenu: vi.fn(),
}));

vi.mock("@/store/global", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    return {
        atoms: {
            builderId: jotaiActual.atom("builder"),
            fullConfigAtom: jotaiActual.atom({}),
            workspaceId: jotaiActual.atom("workspace"),
        },
        createBlock: mockFileExplorerTree.createBlock,
        getApi: () => ({
            getHomeDir: () => "/repo",
            openNativePath: vi.fn(),
            showContextMenu: mockFileExplorerTree.showContextMenu,
            watchDir: vi.fn(),
            unwatchDir: vi.fn(),
        }),
    };
});

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        FileListStreamCommand: vi.fn(),
    },
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: { routeid: "tab" },
}));

describe("buildFileExplorerContextMenu", () => {
    it("offers editor tab and explicit right editor open actions for files", () => {
        const model = {
            openFile: vi.fn(),
            openFileInRightEditor: vi.fn(),
            openInNewTab: vi.fn(),
            startRename: vi.fn(),
            deleteFile: vi.fn(),
            startNewFile: vi.fn(),
            startNewFolder: vi.fn(),
            cdToDir: vi.fn(),
        };
        const menu = buildFileExplorerContextMenu({
            model,
            finfo: {
                path: "/repo/src/app.ts",
                dir: "/repo/src",
                name: "app.ts",
                isdir: false,
            },
            root: "/repo",
        });
        const menuLabels = menu.map((item) => item.label);

        expect(menuLabels).toContain("Open in Editor Tab");
        expect(menuLabels).toContain("Open in Right Editor");
        expect(menuLabels).not.toContain("Open in Main Area");

        menu.find((item) => item.label === "Open in Editor Tab")?.click?.();
        menu.find((item) => item.label === "Open in Right Editor")?.click?.();

        expect(model.openFile).toHaveBeenCalledWith({
            path: "/repo/src/app.ts",
            dir: "/repo/src",
            name: "app.ts",
            isdir: false,
        });
        expect(model.openFileInRightEditor).toHaveBeenCalledWith({
            path: "/repo/src/app.ts",
            dir: "/repo/src",
            name: "app.ts",
            isdir: false,
        });
    });

    it("hides file editor actions for directories and keeps directory tab action", () => {
        const menu = buildFileExplorerContextMenu({
            model: {
                openFile: vi.fn(),
                openFileInRightEditor: vi.fn(),
                openInNewTab: vi.fn(),
                startRename: vi.fn(),
                deleteFile: vi.fn(),
                startNewFile: vi.fn(),
                startNewFolder: vi.fn(),
                cdToDir: vi.fn(),
            },
            finfo: {
                path: "/repo/src",
                name: "src",
                isdir: true,
            },
            root: "/repo",
        });
        const menuLabels = menu.map((item) => item.label);

        expect(menuLabels).not.toContain("Open in Right Editor");
        expect(menuLabels).not.toContain("Open in Editor Tab");
        expect(menuLabels).toContain("Open in New Tab");
        expect(menuLabels).not.toContain("Open in Main Area");
    });
});

describe("handleFileExplorerRowClick", () => {
    it("opens files through the model on single row click", () => {
        const finfo = {
            path: "/repo/src/app.ts",
            dir: "/repo/src",
            name: "app.ts",
            isdir: false,
        };
        const model = {
            setSelected: vi.fn(),
            toggleExpand: vi.fn(),
            openFile: vi.fn(),
        };

        handleFileExplorerRowClick({ model, finfo, path: finfo.path, isDir: false });

        expect(model.setSelected).toHaveBeenCalledWith("/repo/src/app.ts");
        expect(model.openFile).toHaveBeenCalledWith(finfo);
        expect(model.toggleExpand).not.toHaveBeenCalled();
    });

    it("keeps directory row clicks scoped to expand and select", () => {
        const finfo = {
            path: "/repo/src",
            name: "src",
            isdir: true,
        };
        const model = {
            setSelected: vi.fn(),
            toggleExpand: vi.fn(),
            openFile: vi.fn(),
        };

        handleFileExplorerRowClick({ model, finfo, path: finfo.path, isDir: true });

        expect(model.setSelected).toHaveBeenCalledWith("/repo/src");
        expect(model.toggleExpand).toHaveBeenCalledWith("/repo/src");
        expect(model.openFile).not.toHaveBeenCalled();
    });
});
