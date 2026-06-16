// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMagnifyToggle } from "./keymodel";

const mockKeyModel = vi.hoisted(() => ({
    focusedNodeAtom: { key: "focused-node" },
    focusedNode: { id: "node-a", data: { blockId: "block-a" } },
    layoutModel: {
        focusedNode: null as any,
        magnifyNodeToggle: vi.fn(),
    },
    rightPanelModel: {
        toggleFocusedRightToolPanelMagnified: vi.fn(),
    },
}));

vi.mock("@/app/store/global", () => ({
    atoms: {
        staticTabId: { key: "static-tab-id" },
        modalOpen: { key: "modal-open" },
        controlShiftDelayAtom: { key: "control-shift-delay" },
    },
    createBlock: vi.fn(),
    createBlockSplitHorizontally: vi.fn(),
    createBlockSplitVertically: vi.fn(),
    createTab: vi.fn(),
    getAllBlockComponentModels: vi.fn(() => []),
    getApi: vi.fn(() => ({
        registerGlobalWebviewKeys: vi.fn(),
        setKeyboardChordMode: vi.fn(),
    })),
    getBlockComponentModel: vi.fn(),
    getFocusedBlockId: vi.fn(),
    getSettingsKeyAtom: vi.fn((key: string) => ({ key })),
    globalStore: {
        get: vi.fn((atom: unknown) => {
            if (atom === mockKeyModel.focusedNodeAtom) {
                return mockKeyModel.focusedNode;
            }
            return undefined;
        }),
        set: vi.fn(),
    },
    recordTEvent: vi.fn(),
    refocusNode: vi.fn(),
    replaceBlock: vi.fn(),
    WOS: {},
}));

vi.mock("@/app/store/tab-model", () => ({
    getActiveTabModel: vi.fn(),
}));

vi.mock("@/app/workspace/workspace-layout-model", () => ({
    WorkspaceLayoutModel: {
        getInstance: () => mockKeyModel.rightPanelModel,
    },
}));

vi.mock("@/layout/index", () => ({
    deleteLayoutModelForTab: vi.fn(),
    getLayoutModelForStaticTab: () => mockKeyModel.layoutModel,
    NavigateDirection: {
        Up: "up",
        Down: "down",
        Left: "left",
        Right: "right",
    },
}));

vi.mock("@/util/keyutil", () => ({
    checkKeyPressed: vi.fn(),
    isInputEvent: vi.fn(() => false),
}));

vi.mock("@/util/sharedconst", () => ({
    CHORD_TIMEOUT: 1000,
}));

vi.mock("@/util/util", () => ({
    fireAndForget: vi.fn(),
}));

vi.mock("./modalmodel", () => ({
    modalsModel: {
        isModalOpen: vi.fn(() => false),
        popModal: vi.fn(),
        pushModal: vi.fn(),
    },
}));

vi.mock("./windowtype", () => ({
    isBuilderWindow: () => false,
    isTabWindow: () => true,
}));

describe("handleMagnifyToggle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockKeyModel.layoutModel.focusedNode = mockKeyModel.focusedNodeAtom;
        mockKeyModel.focusedNode = { id: "node-a", data: { blockId: "block-a" } };
    });

    it("toggles a focused right tool panel before falling back to block magnify", () => {
        mockKeyModel.rightPanelModel.toggleFocusedRightToolPanelMagnified.mockReturnValue(true);

        expect(handleMagnifyToggle()).toBe(true);

        expect(mockKeyModel.rightPanelModel.toggleFocusedRightToolPanelMagnified).toHaveBeenCalledTimes(1);
        expect(mockKeyModel.layoutModel.magnifyNodeToggle).not.toHaveBeenCalled();
    });

    it("falls back to block magnify when the right tool panel cannot be magnified", () => {
        mockKeyModel.rightPanelModel.toggleFocusedRightToolPanelMagnified.mockReturnValue(false);

        expect(handleMagnifyToggle()).toBe(true);

        expect(mockKeyModel.layoutModel.magnifyNodeToggle).toHaveBeenCalledWith("node-a");
    });
});
