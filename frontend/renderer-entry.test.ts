// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const RendererEntryModulePath = "./renderer-entry";

function makeLoaders() {
    return {
        workspace: vi.fn(async () => ({ initializeWorkspaceRenderer: vi.fn() })),
        terminal: vi.fn(async () => ({ initializeTerminalRenderer: vi.fn() })),
        builder: vi.fn(async () => ({ initializeBuilderRenderer: vi.fn() })),
    };
}

describe("renderer identity dispatcher", () => {
    it.each([
        ["workspace", { kind: "workspace", initOpts: { workspaceId: "workspace-1" } }, "workspace"],
        ["terminal", { kind: "wave", initOpts: { tabId: "terminal-1", rendererKind: "terminal" } }, "terminal"],
        ["builder", { kind: "builder", initOpts: { builderId: "builder-1" } }, "builder"],
    ] as const)("loads only the %s bootstrap", async (_name, event, expectedLoader) => {
        const { createRendererDispatcher } = await import(RendererEntryModulePath);
        const loaders = makeLoaders();
        const dispatcher = createRendererDispatcher(loaders);

        await dispatcher.dispatch(event);

        for (const [name, loader] of Object.entries(loaders)) {
            expect(loader).toHaveBeenCalledTimes(name === expectedLoader ? 1 : 0);
        }
    });

    it("never defaults an unclassified Wave Tab to the Terminal bootstrap", async () => {
        const { createRendererDispatcher } = await import(RendererEntryModulePath);
        const loaders = makeLoaders();
        const dispatcher = createRendererDispatcher(loaders);

        await expect(dispatcher.dispatch({ kind: "wave", initOpts: { tabId: "unknown" } })).rejects.toThrow(
            "wave renderer requires an explicit rendererKind"
        );
        expect(loaders.terminal).not.toHaveBeenCalled();
        expect(loaders.builder).not.toHaveBeenCalled();
    });

    it("does not load a Terminal bootstrap for a zero-Terminal Workspace", async () => {
        const { createRendererDispatcher } = await import(RendererEntryModulePath);
        const loaders = makeLoaders();
        const dispatcher = createRendererDispatcher(loaders);

        await dispatcher.dispatch({
            kind: "workspace",
            initOpts: { workspaceId: "workspace-empty", terminalTabIds: [], activeTerminalTabId: "" },
        });

        expect(loaders.workspace).toHaveBeenCalledOnce();
        expect(loaders.terminal).not.toHaveBeenCalled();
        expect(loaders.builder).not.toHaveBeenCalled();
    });

    it("serializes repeated initialization for the selected renderer family", async () => {
        const { createRendererDispatcher } = await import(RendererEntryModulePath);
        let releaseFirst: () => void;
        const firstPending = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const initializeTerminalRenderer = vi
            .fn()
            .mockImplementationOnce(() => firstPending)
            .mockResolvedValueOnce(undefined);
        const loaders = makeLoaders();
        loaders.terminal.mockResolvedValue({ initializeTerminalRenderer });
        const dispatcher = createRendererDispatcher(loaders);

        const first = dispatcher.dispatch({
            kind: "wave",
            initOpts: { tabId: "terminal-1", rendererKind: "terminal" },
        });
        await vi.waitFor(() => expect(initializeTerminalRenderer).toHaveBeenCalledTimes(1));
        const second = dispatcher.dispatch({
            kind: "wave",
            initOpts: { tabId: "terminal-1", rendererKind: "terminal" },
        });
        await Promise.resolve();

        expect(initializeTerminalRenderer).toHaveBeenCalledTimes(1);
        releaseFirst();
        await Promise.all([first, second]);
        expect(initializeTerminalRenderer).toHaveBeenCalledTimes(2);
    });

    it("continues the renderer queue after an initialization failure", async () => {
        const { createRendererDispatcher } = await import(RendererEntryModulePath);
        const initializeTerminalRenderer = vi
            .fn()
            .mockRejectedValueOnce(new Error("first initialization failed"))
            .mockResolvedValueOnce(undefined);
        const loaders = makeLoaders();
        loaders.terminal.mockResolvedValue({ initializeTerminalRenderer });
        const dispatcher = createRendererDispatcher(loaders);

        await expect(
            dispatcher.dispatch({
                kind: "wave",
                initOpts: { tabId: "terminal-1", rendererKind: "terminal" },
            })
        ).rejects.toThrow("first initialization failed");
        await expect(
            dispatcher.dispatch({
                kind: "wave",
                initOpts: { tabId: "terminal-1", rendererKind: "terminal" },
            })
        ).resolves.toBeUndefined();
        expect(initializeTerminalRenderer).toHaveBeenCalledTimes(2);
    });
});
