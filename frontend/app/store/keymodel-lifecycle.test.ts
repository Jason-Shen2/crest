// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    commands: [] as WorkspaceCommand[],
    reinjectCleanup: vi.fn(),
    controlShiftCleanup: vi.fn(),
    registeredWebviewKeys: [] as string[],
}));

vi.mock("@/app/store/global", () => ({
    atoms: {},
    createBlock: vi.fn(),
    createBlockSplitHorizontally: vi.fn(),
    createBlockSplitVertically: vi.fn(),
    getAllBlockComponentModels: () => [],
    getApi: () => ({
        onReinjectKey: vi.fn(() => mocks.reinjectCleanup),
        onControlShiftStateUpdate: vi.fn(() => mocks.controlShiftCleanup),
        registerGlobalWebviewKeys: vi.fn((keys: string[]) => {
            mocks.registeredWebviewKeys = keys;
        }),
        setKeyboardChordMode: vi.fn(),
    }),
    getBlockComponentModel: vi.fn(),
    getFocusedBlockId: vi.fn(),
    getSettingsKeyAtom: vi.fn(),
    globalStore: { get: vi.fn(), set: vi.fn() },
    recordTEvent: vi.fn(),
    refocusNode: vi.fn(),
    replaceBlock: vi.fn(),
    WOS: {},
}));

vi.mock("@/app/store/workspace-command-client", () => ({
    sendWorkspaceCommand: (command: WorkspaceCommand) => mocks.commands.push(command),
}));

vi.mock("@/layout/index", () => ({
    getLayoutModelForStaticTab: vi.fn(),
    NavigateDirection: { Up: "up", Down: "down", Left: "left", Right: "right" },
}));

vi.mock("@/util/keyutil", () => ({
    checkKeyPressed: (event: { binding: string }, binding: string) => event.binding === binding,
    isInputEvent: () => false,
    keydownWrapper: (handler: (event: WaveKeyboardEvent) => boolean) => handler,
}));

vi.mock("./modalmodel", () => ({
    modalsModel: { isModalOpen: vi.fn(), popModal: vi.fn(), pushModal: vi.fn() },
}));

vi.mock("./windowtype", () => ({
    isBuilderWindow: () => false,
    isTabWindow: () => false,
}));

describe("Global key lifecycle", () => {
    beforeEach(() => {
        mocks.commands = [];
        mocks.registeredWebviewKeys = [];
        mocks.reinjectCleanup.mockClear();
        mocks.controlShiftCleanup.mockClear();
    });

    it("registers Workspace commands and clears keys and Electron listeners", async () => {
        const keymodel = await import("./keymodel");
        const cleanups = [
            keymodel.registerGlobalKeys(),
            keymodel.registerElectronReinjectKeyHandler(),
            keymodel.registerControlShiftStateUpdateHandler(),
        ];

        expect(mocks.registeredWebviewKeys).toEqual(
            expect.arrayContaining(["Cmd:t", "Cmd:w", "Cmd:[", "Cmd:]", "Cmd:1"])
        );
        for (const binding of ["Cmd:t", "Cmd:w", "Cmd:[", "Cmd:]", "Cmd:1"]) {
            expect(keymodel.tryReinjectKey({ binding } as unknown as WaveKeyboardEvent)).toBe(true);
        }
        expect(mocks.commands).toEqual([
            { type: "new-terminal" },
            { type: "close-active" },
            { type: "previous-content" },
            { type: "next-content" },
            { type: "activate-terminal-index", index: 0 },
        ]);

        cleanups.reverse().forEach((cleanup) => cleanup());
        expect(keymodel.tryReinjectKey({ binding: "Cmd:t" } as unknown as WaveKeyboardEvent)).toBe(false);
        expect(mocks.reinjectCleanup).toHaveBeenCalledOnce();
        expect(mocks.controlShiftCleanup).toHaveBeenCalledOnce();
    });

    it("registers Workspace keys against the current router without Terminal-only keys", async () => {
        const keymodel = await import("./keymodel");
        const dispatch = vi.fn();
        const cleanup = keymodel.registerWorkspaceGlobalKeys(dispatch);

        expect(mocks.registeredWebviewKeys).toEqual(
            expect.arrayContaining(["Cmd:t", "Cmd:w", "Cmd:[", "Cmd:]", "Cmd:1"])
        );
        expect(mocks.registeredWebviewKeys).not.toContain("Cmd:d");
        for (const binding of ["Cmd:t", "Cmd:w", "Cmd:[", "Cmd:]", "Cmd:1"]) {
            expect(keymodel.tryReinjectKey({ binding } as unknown as WaveKeyboardEvent)).toBe(true);
        }
        expect(dispatch.mock.calls.map(([command]) => command)).toEqual([
            { type: "new-terminal" },
            { type: "close-active" },
            { type: "previous-content" },
            { type: "next-content" },
            { type: "activate-terminal-index", index: 0 },
        ]);

        cleanup();
        expect(keymodel.tryReinjectKey({ binding: "Cmd:t" } as unknown as WaveKeyboardEvent)).toBe(false);
    });
});
