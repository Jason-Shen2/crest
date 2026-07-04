// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { atoms } from "@/store/global";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findEditorTabForPath, openFileInEditorTab } from "./open-editor-tab";

const mockServices = vi.hoisted(() => ({
    CreateTabWithBlock: vi.fn(),
    SetActiveTab: vi.fn(),
}));

const mockElectronApi = vi.hoisted(() => ({
    setActiveTab: vi.fn(),
}));

vi.mock("@/app/store/windowtype", () => ({
    isPreviewWindow: () => true,
    setWaveWindowType: vi.fn(),
}));

vi.mock("@/app/store/services", () => ({
    WorkspaceService: mockServices,
}));

vi.mock("@/store/global", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    return {
        atoms: {
            workspace: jotaiActual.atom(null),
        },
        getApi: () => mockElectronApi,
        globalStore: (await vi.importActual<typeof import("@/app/store/jotaiStore")>("@/app/store/jotaiStore"))
            .globalStore,
    };
});

describe("open editor tab from file explorer", () => {
    let consoleLog: ReturnType<typeof vi.spyOn>;
    let consoleWarn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.restoreAllMocks();
        consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
        consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        mockServices.CreateTabWithBlock.mockReset();
        mockServices.SetActiveTab.mockReset();
        mockElectronApi.setActiveTab.mockReset();
        globalStore.set(atoms.workspace as any, {
            oid: "workspace-1",
            tabids: ["tab-1", "tab-2"],
        } as Workspace);
        updateWaveObject<Tab>("tab", "tab-1", {
            blockids: ["block-1"],
        });
        updateWaveObject<Tab>("tab", "tab-2", {
            blockids: ["block-2"],
        });
        updateWaveObject<Block>("block", "block-1", {
            meta: { view: "termblocks", "cmd:cwd": "/repo" },
        });
        updateWaveObject<Block>("block", "block-2", {
            meta: { view: "codeeditor", file: "/repo/src/app.ts" },
        });
    });

    afterEach(() => {
        consoleLog.mockRestore();
        consoleWarn.mockRestore();
        vi.restoreAllMocks();
    });

    it("finds an existing codeeditor tab for the same file path", async () => {
        await expect(findEditorTabForPath("/repo/src/app.ts")).resolves.toBe("tab-2");
    });

    it("activates an existing editor tab through the Electron API instead of creating a duplicate", async () => {
        await openFileInEditorTab("/repo/src/app.ts");

        expect(mockElectronApi.setActiveTab).toHaveBeenCalledWith("tab-2");
        expect(mockServices.SetActiveTab).not.toHaveBeenCalled();
        expect(mockServices.CreateTabWithBlock).not.toHaveBeenCalled();
    });

    it("loads unprewarmed tabs and blocks before deciding whether to create a duplicate", async () => {
        globalStore.set(atoms.workspace as any, {
            oid: "workspace-1",
            tabids: ["tab-cold"],
        } as Workspace);
        const loadAndPinWaveObject = vi.spyOn(WOS, "loadAndPinWaveObject").mockImplementation(async (oref: string) => {
            if (oref === WOS.makeORef("tab", "tab-cold")) {
                return { oid: "tab-cold", otype: "tab", version: 1, blockids: ["block-cold"] } as Tab;
            }
            if (oref === WOS.makeORef("block", "block-cold")) {
                return {
                    oid: "block-cold",
                    otype: "block",
                    version: 1,
                    meta: { view: "codeeditor", file: "/repo/src/cold.ts" },
                } as Block;
            }
            throw new Error(`unexpected oref ${oref}`);
        });

        const result = await openFileInEditorTab("/repo/src/cold.ts");

        expect(result).toEqual({ tabId: "tab-cold", created: false });
        expect(loadAndPinWaveObject).toHaveBeenCalledWith(WOS.makeORef("tab", "tab-cold"));
        expect(loadAndPinWaveObject).toHaveBeenCalledWith(WOS.makeORef("block", "block-cold"));
        expect(mockElectronApi.setActiveTab).toHaveBeenCalledWith("tab-cold");
        expect(mockServices.CreateTabWithBlock).not.toHaveBeenCalled();
    });

    it("continues scanning when an individual tab load fails and activates a later matching editor tab", async () => {
        const loadAndPinWaveObject = vi.spyOn(WOS, "loadAndPinWaveObject").mockImplementation(async (oref: string) => {
            if (oref === WOS.makeORef("tab", "tab-1")) {
                throw new Error("tab load failed");
            }
            if (oref === WOS.makeORef("tab", "tab-2")) {
                return { oid: "tab-2", otype: "tab", version: 1, blockids: ["block-2"] } as Tab;
            }
            if (oref === WOS.makeORef("block", "block-2")) {
                return {
                    oid: "block-2",
                    otype: "block",
                    version: 1,
                    meta: { view: "codeeditor", file: "/repo/src/app.ts" },
                } as Block;
            }
            throw new Error(`unexpected oref ${oref}`);
        });

        const result = await openFileInEditorTab("/repo/src/app.ts");

        expect(result).toEqual({ tabId: "tab-2", created: false });
        expect(loadAndPinWaveObject).toHaveBeenCalledWith(WOS.makeORef("tab", "tab-1"));
        expect(loadAndPinWaveObject).toHaveBeenCalledWith(WOS.makeORef("tab", "tab-2"));
        expect(consoleWarn).toHaveBeenCalledWith(
            "failed to load tab while searching for existing editor tab",
            "tab-1",
            expect.any(Error)
        );
        expect(mockElectronApi.setActiveTab).toHaveBeenCalledWith("tab-2");
        expect(mockServices.CreateTabWithBlock).not.toHaveBeenCalled();
    });

    it("continues scanning when an individual block load fails and activates a later matching editor tab", async () => {
        updateWaveObject<Tab>("tab", "tab-1", {
            blockids: ["block-fails", "block-ignored"],
        });
        const loadAndPinWaveObject = vi.spyOn(WOS, "loadAndPinWaveObject").mockImplementation(async (oref: string) => {
            if (oref === WOS.makeORef("tab", "tab-1")) {
                return { oid: "tab-1", otype: "tab", version: 1, blockids: ["block-fails", "block-ignored"] } as Tab;
            }
            if (oref === WOS.makeORef("block", "block-fails")) {
                throw new Error("block load failed");
            }
            if (oref === WOS.makeORef("block", "block-ignored")) {
                return {
                    oid: "block-ignored",
                    otype: "block",
                    version: 1,
                    meta: { view: "termblocks", "cmd:cwd": "/repo" },
                } as Block;
            }
            if (oref === WOS.makeORef("tab", "tab-2")) {
                return { oid: "tab-2", otype: "tab", version: 1, blockids: ["block-2"] } as Tab;
            }
            if (oref === WOS.makeORef("block", "block-2")) {
                return {
                    oid: "block-2",
                    otype: "block",
                    version: 1,
                    meta: { view: "codeeditor", file: "/repo/src/app.ts" },
                } as Block;
            }
            throw new Error(`unexpected oref ${oref}`);
        });

        const result = await openFileInEditorTab("/repo/src/app.ts");

        expect(result).toEqual({ tabId: "tab-2", created: false });
        expect(loadAndPinWaveObject).toHaveBeenCalledWith(WOS.makeORef("block", "block-fails"));
        expect(loadAndPinWaveObject).toHaveBeenCalledWith(WOS.makeORef("tab", "tab-2"));
        expect(consoleWarn).toHaveBeenCalledWith(
            "failed to load block while searching for existing editor tab",
            "block-fails",
            expect.any(Error)
        );
        expect(mockElectronApi.setActiveTab).toHaveBeenCalledWith("tab-2");
        expect(mockServices.CreateTabWithBlock).not.toHaveBeenCalled();
    });

    it("creates a codeeditor tab when the file is not already open", async () => {
        mockServices.CreateTabWithBlock.mockResolvedValue("tab-3");

        const result = await openFileInEditorTab("/repo/src/new.ts");

        expect(result).toEqual({ tabId: "tab-3", created: true });
        expect(mockServices.CreateTabWithBlock).toHaveBeenCalledWith("workspace-1", "", false, {
            meta: {
                view: "codeeditor",
                file: "/repo/src/new.ts",
                connection: "",
            },
        });
        expect(mockElectronApi.setActiveTab).toHaveBeenCalledWith("tab-3");
        expect(mockServices.SetActiveTab).not.toHaveBeenCalled();
    });

    it("deduplicates concurrent tab creation for the same file before creation resolves", async () => {
        globalStore.set(atoms.workspace as any, {
            oid: "workspace-1",
            tabids: [],
        } as Workspace);
        const createTab = deferred<string>();
        mockServices.CreateTabWithBlock.mockReturnValue(createTab.promise);

        const firstOpen = openFileInEditorTab("/repo/src/new.ts", "/repo");
        const secondOpen = openFileInEditorTab("/repo/src/new.ts", "/repo");
        await Promise.resolve();

        expect(mockServices.CreateTabWithBlock).toHaveBeenCalledTimes(1);

        createTab.resolve("tab-3");
        const [firstResult, secondResult] = await Promise.all([firstOpen, secondOpen]);

        expect(firstResult).toEqual({ tabId: "tab-3", created: true });
        expect(secondResult).toEqual({ tabId: "tab-3", created: true });
        expect(mockElectronApi.setActiveTab).toHaveBeenCalledTimes(1);
        expect(mockElectronApi.setActiveTab).toHaveBeenCalledWith("tab-3");
    });

    it("includes optional cwd metadata when creating a codeeditor tab", async () => {
        mockServices.CreateTabWithBlock.mockResolvedValue("tab-3");

        await openFileInEditorTab("/repo/src/new.ts", { workspaceRoot: "/repo", cwd: "/repo/src" });

        expect(mockServices.CreateTabWithBlock).toHaveBeenCalledWith("workspace-1", "", false, {
            meta: {
                view: "codeeditor",
                file: "/repo/src/new.ts",
                connection: "",
                "cmd:cwd": "/repo/src",
            },
        });
    });
});

function updateWaveObject<T extends WaveObj>(otype: string, oid: string, obj: Partial<T>): void {
    const value = {
        otype,
        oid,
        version: Date.now(),
        meta: {},
        ...obj,
    } as T;
    const oref = WOS.makeORef(otype, oid);
    WOS.mockObjectForPreview(oref, value);
    WOS.getWaveObjectAtom<T>(oref);
    WOS.setObjectValue(value);
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}
