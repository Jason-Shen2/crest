// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { buildFileExplorerContextMenu } from "./file-explorer-tree";

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
    it("offers right editor and main area open actions for files", () => {
        const menu = buildFileExplorerContextMenu({
            model: {
                openFile: vi.fn(),
                openInNewTab: vi.fn(),
                startRename: vi.fn(),
                deleteFile: vi.fn(),
                startNewFile: vi.fn(),
                startNewFolder: vi.fn(),
                cdToDir: vi.fn(),
            },
            finfo: {
                path: "/repo/src/app.ts",
                dir: "/repo/src",
                name: "app.ts",
                isdir: false,
            },
            root: "/repo",
        });
        const menuLabels = menu.map((item) => item.label);

        expect(menuLabels).toContain("Open in Right Editor");
        expect(menuLabels).toContain("Open in Main Area");
    });

    it("hides the right editor open action for directories", () => {
        const menu = buildFileExplorerContextMenu({
            model: {
                openFile: vi.fn(),
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
        expect(menuLabels).toContain("Open in Main Area");
    });
});
