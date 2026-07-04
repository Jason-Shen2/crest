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
        globalStore: (await vi.importActual<typeof import("@/app/store/jotaiStore")>("@/app/store/jotaiStore"))
            .globalStore,
    };
});

describe("open editor tab from file explorer", () => {
    let consoleLog: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
        mockServices.CreateTabWithBlock.mockReset();
        mockServices.SetActiveTab.mockReset();
        globalStore.set(atoms.workspace as any, {
            oid: "workspace-1",
            tabids: ["tab-1", "tab-2"],
        } as Workspace);
        updateWaveObject("tab", "tab-1", {
            blockids: ["block-1"],
        });
        updateWaveObject("tab", "tab-2", {
            blockids: ["block-2"],
        });
        updateWaveObject("block", "block-1", {
            meta: { view: "termblocks", "cmd:cwd": "/repo" },
        });
        updateWaveObject("block", "block-2", {
            meta: { view: "codeeditor", file: "/repo/src/app.ts" },
        });
    });

    afterEach(() => {
        consoleLog.mockRestore();
    });

    it("finds an existing codeeditor tab for the same file path", () => {
        expect(findEditorTabForPath("/repo/src/app.ts")).toBe("tab-2");
    });

    it("activates an existing editor tab instead of creating a duplicate", async () => {
        await openFileInEditorTab("/repo/src/app.ts");

        expect(mockServices.SetActiveTab).toHaveBeenCalledWith("workspace-1", "tab-2");
        expect(mockServices.CreateTabWithBlock).not.toHaveBeenCalled();
    });

    it("creates a codeeditor tab when the file is not already open", async () => {
        mockServices.CreateTabWithBlock.mockResolvedValue("tab-3");

        const result = await openFileInEditorTab("/repo/src/new.ts");

        expect(result).toEqual({ tabId: "tab-3", created: true });
        expect(mockServices.CreateTabWithBlock).toHaveBeenCalledWith("workspace-1", "", true, {
            meta: {
                view: "codeeditor",
                file: "/repo/src/new.ts",
                connection: "",
            },
        });
        expect(mockServices.SetActiveTab).not.toHaveBeenCalled();
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
