// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { openCodeReviewFromTopBar } from "@/app/topbar/topbar-code-review";
import * as jotai from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultRightToolPanelState } from "./right-tool-panel-state";
import { RightToolPanelMetaKey, WorkspaceLayoutModel } from "./workspace-layout-model";

const mockGlobal = vi.hoisted(() => ({
    workspaceAtom: null as jotai.PrimitiveAtom<Workspace>,
    metaAtoms: new Map<string, jotai.PrimitiveAtom<any>>(),
    metaValues: new Map<string, Record<string, any>>(),
    settingsAtoms: new Map<string, jotai.PrimitiveAtom<any>>(),
    refocusNode: vi.fn(),
    layoutModel: {
        focusedNode: null as jotai.PrimitiveAtom<any>,
        magnifiedNodeId: undefined as string | undefined,
        magnifyNodeToggle: vi.fn(),
    },
}));

vi.mock("@/store/global", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    mockGlobal.workspaceAtom = jotaiActual.atom(null as Workspace) as jotai.PrimitiveAtom<Workspace>;

    const getTestMetaAtom = (oref: string, key: string) => {
        const atomKey = `${oref}:${key}`;
        let metaAtom = mockGlobal.metaAtoms.get(atomKey);
        if (metaAtom != null) {
            return metaAtom;
        }
        metaAtom = jotaiActual.atom(mockGlobal.metaValues.get(oref)?.[key]);
        mockGlobal.metaAtoms.set(atomKey, metaAtom);
        return metaAtom;
    };

    const getTestSettingsAtom = (key: string) => {
        let settingsAtom = mockGlobal.settingsAtoms.get(key);
        if (settingsAtom != null) {
            return settingsAtom;
        }
        settingsAtom = jotaiActual.atom("top");
        mockGlobal.settingsAtoms.set(key, settingsAtom);
        return settingsAtom;
    };

    return {
        atoms: {
            workspace: mockGlobal.workspaceAtom,
        },
        getOrefMetaKeyAtom: getTestMetaAtom,
        getSettingsKeyAtom: getTestSettingsAtom,
        refocusNode: mockGlobal.refocusNode,
    };
});

vi.mock("@/app/store/windowtype", () => ({
    isBuilderWindow: () => false,
}));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: vi.fn(),
    },
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: { routeid: "tab" },
}));

vi.mock("@/layout/lib/layoutModelHooks", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    mockGlobal.layoutModel.focusedNode = jotaiActual.atom(null) as jotai.PrimitiveAtom<any>;
    return {
        getLayoutModelForStaticTab: () => mockGlobal.layoutModel,
    };
});

function setWindowWidth(width: number): void {
    if (globalThis.window == null) {
        vi.stubGlobal("window", { innerWidth: width });
        return;
    }
    Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: width,
    });
}

function setWorkspace(oid: string, meta: Record<string, any> = {}): void {
    const workspace: Workspace = {
        otype: "workspace",
        oid,
        version: 1,
        meta,
        tabids: [],
        activetabid: "",
    };
    mockGlobal.metaValues.set(`workspace:${oid}`, meta);
    globalStore.set(mockGlobal.workspaceAtom, workspace);
}

function getPersistedRightToolPanelState() {
    const calls = vi.mocked(RpcApi.SetMetaCommand).mock.calls;
    const lastCall = calls[calls.length - 1];
    return lastCall?.[1]?.meta?.[RightToolPanelMetaKey];
}

describe("WorkspaceLayoutModel right tool panel state", () => {
    beforeEach(() => {
        setWindowWidth(1200);
        vi.mocked(RpcApi.SetMetaCommand).mockClear();
        mockGlobal.metaAtoms.clear();
        mockGlobal.metaValues.clear();
        mockGlobal.settingsAtoms.clear();
        mockGlobal.layoutModel.magnifiedNodeId = undefined;
        mockGlobal.layoutModel.magnifyNodeToggle.mockClear();
        WorkspaceLayoutModel.resetInstance();
    });

    it("hydrates right tool panel state from workspace metadata", () => {
        setWorkspace("ws-a", {
            [RightToolPanelMetaKey]: {
                visible: false,
                width: 99999,
                openedTools: ["editor", "editor", "bad-tool", "browser"],
                activeTool: "browser",
                toolState: { editor: { path: "a.ts" }, "bad-tool": { value: true } },
                focused: true,
                magnified: true,
            },
        });

        const model = WorkspaceLayoutModel.getInstance();

        expect(globalStore.get(model.rightToolPanelAtom)).toEqual({
            visible: false,
            width: 840,
            openedTools: ["editor", "browser"],
            activeTool: "browser",
            toolState: { editor: { path: "a.ts" } },
            focused: false,
            magnified: false,
        });
    });

    it("persists right tool panel state changes to current workspace metadata", () => {
        setWorkspace("ws-a");
        const model = WorkspaceLayoutModel.getInstance();

        model.openRightTool("editor");
        model.setRightToolPanelWidth(99999);
        model.setRightToolPanelVisible(false);
        model.setRightToolPanelFocused(true);
        model.setRightToolPanelMagnified(true);

        expect(globalStore.get(model.rightToolPanelAtom)).toMatchObject({
            visible: false,
            width: 620,
            openedTools: ["editor"],
            activeTool: "editor",
            focused: true,
            magnified: false,
        });
        expect(getPersistedRightToolPanelState()).toEqual({
            visible: false,
            width: 620,
            openedTools: ["editor"],
            activeTool: "editor",
            toolState: {},
        });
        expect(vi.mocked(RpcApi.SetMetaCommand).mock.calls.at(-1)?.[1]).toMatchObject({
            oref: "workspace:ws-a",
        });
    });

    it("reserves visible left panels and the main content floor when clamping right panel width", () => {
        setWorkspace("ws-a");
        const model = WorkspaceLayoutModel.getInstance();
        globalStore.set(model.vtabVisibleAtom, true);
        globalStore.set(model.vtabWidthAtom, 248);
        globalStore.set(model.fileExplorerVisibleAtom, true);
        globalStore.set(model.fileExplorerWidthAtom, 260);

        expect(model.getRightToolPanelMaxWidth(1200, true, 248, true, 260)).toBe(372);

        model.setRightToolPanelWidth(99999);

        expect(globalStore.get(model.rightToolPanelAtom).width).toBe(372);
        expect(getPersistedRightToolPanelState()).toMatchObject({
            width: 372,
        });
    });

    it("previews right panel drag widths without persisting until resize end", () => {
        setWorkspace("ws-a");
        const model = WorkspaceLayoutModel.getInstance();
        vi.mocked(RpcApi.SetMetaCommand).mockClear();

        model.previewRightToolPanelWidth(430);
        model.previewRightToolPanelWidth(440);

        expect(globalStore.get(model.rightToolPanelAtom).width).toBe(440);
        expect(vi.mocked(RpcApi.SetMetaCommand)).not.toHaveBeenCalled();

        model.setRightToolPanelWidth(440);

        expect(vi.mocked(RpcApi.SetMetaCommand)).toHaveBeenCalledTimes(1);
        expect(getPersistedRightToolPanelState()).toMatchObject({
            width: 440,
        });
    });

    it("rehydrates right tool panel state when the current workspace changes", () => {
        setWorkspace("ws-a", {
            [RightToolPanelMetaKey]: {
                ...DefaultRightToolPanelState,
                openedTools: ["editor"],
                activeTool: "editor",
            },
        });
        const model = WorkspaceLayoutModel.getInstance();
        expect(globalStore.get(model.rightToolPanelAtom).activeTool).toBe("editor");

        setWorkspace("ws-b", {
            [RightToolPanelMetaKey]: {
                ...DefaultRightToolPanelState,
                openedTools: ["browser"],
                activeTool: "browser",
            },
        });
        model.hydrateRightToolPanelFromWorkspace();

        expect(globalStore.get(model.rightToolPanelAtom).openedTools).toEqual(["browser"]);
        expect(globalStore.get(model.rightToolPanelAtom).activeTool).toBe("browser");
    });

    it("automatically hydrates before reads and writes when the workspace changes", () => {
        setWorkspace("ws-a", {
            [RightToolPanelMetaKey]: {
                ...DefaultRightToolPanelState,
                openedTools: ["editor"],
                activeTool: "editor",
            },
        });
        const model = WorkspaceLayoutModel.getInstance();
        expect(model.getRightToolPanelState().activeTool).toBe("editor");

        setWorkspace("ws-b", {
            [RightToolPanelMetaKey]: {
                ...DefaultRightToolPanelState,
                openedTools: ["browser"],
                activeTool: "browser",
            },
        });

        expect(model.getRightToolPanelState().activeTool).toBe("browser");

        setWorkspace("ws-c", {
            [RightToolPanelMetaKey]: {
                ...DefaultRightToolPanelState,
                openedTools: ["terminal"],
                activeTool: "terminal",
            },
        });

        model.openRightTool("terminal");

        expect(getPersistedRightToolPanelState()).toMatchObject({
            openedTools: ["terminal"],
            activeTool: "terminal",
        });
        expect(vi.mocked(RpcApi.SetMetaCommand).mock.calls.at(-1)?.[1]).toMatchObject({
            oref: "workspace:ws-c",
        });
    });

    it("reads a target workspace right tool panel state without mutating the singleton atom", () => {
        setWorkspace("ws-a", {
            [RightToolPanelMetaKey]: {
                ...DefaultRightToolPanelState,
                openedTools: ["codeReview"],
                activeTool: "codeReview",
            },
        });
        const model = WorkspaceLayoutModel.getInstance();
        const wsAState = globalStore.get(model.rightToolPanelAtom);
        setWorkspace("ws-b", {
            [RightToolPanelMetaKey]: {
                ...DefaultRightToolPanelState,
                visible: false,
                openedTools: [],
                activeTool: undefined,
            },
        });

        const wsBState = model.getRightToolPanelStateForWorkspace("ws-b", wsAState);

        expect(wsBState).toMatchObject({
            visible: false,
            openedTools: [],
            activeTool: undefined,
        });
        expect(globalStore.get(model.rightToolPanelAtom)).toMatchObject({
            openedTools: ["codeReview"],
            activeTool: "codeReview",
        });
    });

    it("bridges setCodeReviewVisible to the right tool panel codeReview tool", () => {
        setWorkspace("ws-a");
        const model = WorkspaceLayoutModel.getInstance();

        model.setCodeReviewVisible(true);

        expect(globalStore.get(model.codeReviewVisibleAtom)).toBe(true);
        expect(globalStore.get(model.rightToolPanelAtom)).toMatchObject({
            visible: true,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
        });
        expect(getPersistedRightToolPanelState()).toMatchObject({
            visible: true,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
        });

        model.setCodeReviewVisible(false);

        expect(globalStore.get(model.codeReviewVisibleAtom)).toBe(false);
        expect(globalStore.get(model.rightToolPanelAtom)).toMatchObject({
            openedTools: [],
            activeTool: undefined,
        });
        expect(getPersistedRightToolPanelState()).toMatchObject({
            openedTools: [],
            activeTool: undefined,
        });
    });

    it("syncs legacy code review visibility when hydrating right panel state", () => {
        setWorkspace("ws-a", {
            [RightToolPanelMetaKey]: {
                ...DefaultRightToolPanelState,
                visible: true,
                openedTools: ["codeReview"],
                activeTool: "codeReview",
            },
        });
        const model = WorkspaceLayoutModel.getInstance();

        expect(globalStore.get(model.codeReviewVisibleAtom)).toBe(true);

        setWorkspace("ws-b", {
            [RightToolPanelMetaKey]: {
                ...DefaultRightToolPanelState,
                visible: true,
                openedTools: ["editor"],
                activeTool: "editor",
            },
        });
        expect(model.getRightToolPanelState().activeTool).toBe("editor");

        expect(globalStore.get(model.codeReviewVisibleAtom)).toBe(false);
    });

    it("syncs legacy code review visibility for direct right panel state changes", () => {
        setWorkspace("ws-a");
        const model = WorkspaceLayoutModel.getInstance();

        model.openRightTool("codeReview");

        expect(globalStore.get(model.codeReviewVisibleAtom)).toBe(true);

        model.closeRightTool("codeReview");

        expect(globalStore.get(model.codeReviewVisibleAtom)).toBe(false);

        model.openRightTool("codeReview");
        model.setRightToolPanelVisible(false);

        expect(globalStore.get(model.codeReviewVisibleAtom)).toBe(false);
    });

    it("toggles Cmd+M only for a focused visible right panel and clears block magnify on activation", () => {
        setWorkspace("ws-a");
        const model = WorkspaceLayoutModel.getInstance();
        globalStore.set(model.codeReviewWideAtom, true);

        expect(model.toggleFocusedRightToolPanelMagnified()).toBe(false);
        expect(globalStore.get(model.rightToolPanelAtom).magnified).toBe(false);

        model.openRightTool("editor");
        expect(model.toggleFocusedRightToolPanelMagnified()).toBe(false);

        model.setRightToolPanelFocused(true);
        mockGlobal.layoutModel.magnifiedNodeId = "node-a";
        expect(model.toggleFocusedRightToolPanelMagnified()).toBe(true);
        expect(globalStore.get(model.rightToolPanelAtom).magnified).toBe(true);
        expect(mockGlobal.layoutModel.magnifyNodeToggle).toHaveBeenCalledWith("node-a");
        expect(globalStore.get(model.codeReviewWideAtom)).toBe(false);

        expect(model.toggleFocusedRightToolPanelMagnified()).toBe(true);
        expect(globalStore.get(model.rightToolPanelAtom).magnified).toBe(false);

        model.setRightToolPanelVisible(false);
        expect(model.toggleFocusedRightToolPanelMagnified()).toBe(false);
    });

    it("clears focus when hiding and requires real panel focus after a non-panel reopen for Cmd+M", () => {
        setWorkspace("ws-a");
        const model = WorkspaceLayoutModel.getInstance();

        model.openRightTool("codeReview");
        model.setRightToolPanelFocused(true);
        model.setRightToolPanelVisible(false);

        expect(globalStore.get(model.rightToolPanelAtom)).toMatchObject({
            visible: false,
            focused: false,
            magnified: false,
        });

        openCodeReviewFromTopBar(model);

        expect(globalStore.get(model.rightToolPanelAtom)).toMatchObject({
            visible: true,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
            focused: false,
        });
        expect(model.toggleFocusedRightToolPanelMagnified()).toBe(false);

        model.setRightToolPanelFocused(true);

        expect(model.toggleFocusedRightToolPanelMagnified()).toBe(true);
        expect(globalStore.get(model.rightToolPanelAtom).magnified).toBe(true);
    });
});
