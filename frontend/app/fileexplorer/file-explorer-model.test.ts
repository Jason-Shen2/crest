// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/global", async () => {
    const jotai = await vi.importActual<typeof import("jotai")>("jotai");
    const settings = new Map<string, ReturnType<typeof jotai.atom>>();
    return {
        getApi: () => ({ watchDir: vi.fn(), unwatchDir: vi.fn(), getHomeDir: () => "/repo" }),
        getSettingsKeyAtom: (key: string) => {
            if (!settings.has(key)) settings.set(key, jotai.atom(false));
            return settings.get(key);
        },
    };
});

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        FileCreateCommand: vi.fn(),
        FileMkdirCommand: vi.fn(),
        FileListStreamCommand: vi.fn(),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { RpcApi } from "@/app/store/wshclientapi";
import { FileExplorerModel } from "./file-explorer-model";

describe("FileExplorerModel Workspace boundary", () => {
    const actions = {
        openFile: vi.fn(),
        renamePath: vi.fn(),
        deletePath: vi.fn(),
        createTerminal: vi.fn(),
    };

    beforeEach(() => {
        (FileExplorerModel as any).instance = null;
        vi.clearAllMocks();
        Object.values(actions).forEach((mock) => mock.mockReset());
        actions.renamePath.mockResolvedValue(true);
        actions.deletePath.mockResolvedValue(true);
    });

    it("routes open, rename, delete, and Terminal creation through bound Workspace actions", async () => {
        const model = FileExplorerModel.getInstance();
        model.bindWorkspaceActions(actions);
        await model.openFile({ path: "/repo/a.ts", isdir: false } as FileInfo);
        await model.commitRename("/repo/a.ts", "b.ts");
        await model.deleteFile("/repo/b.ts");
        await model.cdToDir("/repo");

        expect(actions.openFile).toHaveBeenCalledWith("/repo/a.ts");
        expect(actions.renamePath).toHaveBeenCalledWith("/repo/a.ts", "/repo/b.ts");
        expect(actions.deletePath).toHaveBeenCalledWith("/repo/b.ts");
        expect(actions.createTerminal).toHaveBeenCalledWith("/repo");
    });

    it("does not let cleanup from a stale workspace unbind its replacement", async () => {
        const model = FileExplorerModel.getInstance();
        const oldActions = { ...actions, openFile: vi.fn() };
        const currentActions = { ...actions, openFile: vi.fn() };
        const unbindOld = model.bindWorkspaceActions(oldActions);
        model.bindWorkspaceActions(currentActions);
        unbindOld();

        await model.openFile({ path: "/repo/current.ts", isdir: false } as FileInfo);
        expect(oldActions.openFile).not.toHaveBeenCalled();
        expect(currentActions.openFile).toHaveBeenCalledWith("/repo/current.ts");
    });

    it("streams, filters hidden entries, sorts, and caches directory children", async () => {
        vi.mocked(RpcApi.FileListStreamCommand).mockReturnValue(
            (async function* () {
                yield {
                    fileinfo: [
                        { path: "/repo/z.ts", name: "z.ts", isdir: false },
                        { path: "/repo/.hidden", name: ".hidden", isdir: false },
                    ],
                };
                yield { fileinfo: [{ path: "/repo/src", name: "src", isdir: true }] };
            })() as any
        );
        const model = FileExplorerModel.getInstance();

        await model.fetchChildren("/repo");

        expect(model.getChildren("/repo")?.map((entry) => entry.name)).toEqual(["src", "z.ts"]);
        expect(model.isLoading("/repo")).toBe(false);
        expect(model.getError("/repo")).toBeUndefined();
    });

    it("deduplicates in-flight streams and records errors without caching partial results", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.mocked(RpcApi.FileListStreamCommand).mockReturnValue(
            (async function* () {
                yield { fileinfo: [{ path: "/repo/a.ts", name: "a.ts", isdir: false }] };
                await gate;
                throw new Error("stream failed");
            })() as any
        );
        const model = FileExplorerModel.getInstance();
        const first = model.fetchChildren("/repo");
        const second = model.fetchChildren("/repo");
        release();
        await Promise.all([first, second]);

        expect(RpcApi.FileListStreamCommand).toHaveBeenCalledOnce();
        expect(model.getChildren("/repo")).toBeUndefined();
        expect(model.getError("/repo")).toBe("stream failed");
    });

    it("creates files and folders with normalized root-safe paths", async () => {
        vi.mocked(RpcApi.FileListStreamCommand).mockReturnValue((async function* () {})() as any);
        const model = FileExplorerModel.getInstance();

        await model.commitNewFile("/", "a.ts");
        await model.commitNewFolder("\\\\server\\share", "docs");

        expect(RpcApi.FileCreateCommand).toHaveBeenCalledWith(expect.anything(), {
            info: { path: "wsh://local//a.ts" },
        });
        expect(RpcApi.FileMkdirCommand).toHaveBeenCalledWith(expect.anything(), {
            info: { path: expect.stringContaining("//server/share/docs") },
        });
        expect(globalStore.get(model.editingAtom)).toBeNull();
    });

    it("renames children of POSIX roots and UNC shares without producing a false UNC root", async () => {
        vi.mocked(RpcApi.FileListStreamCommand).mockReturnValue((async function* () {})() as any);
        const model = FileExplorerModel.getInstance();
        model.bindWorkspaceActions(actions);

        await model.commitRename("/old", "new");
        await model.commitRename("\\\\server\\share\\old", "new");

        expect(actions.renamePath).toHaveBeenNthCalledWith(1, "/old", "/new");
        expect(actions.renamePath).toHaveBeenNthCalledWith(2, "\\\\server\\share\\old", "//server/share/new");
    });
});
