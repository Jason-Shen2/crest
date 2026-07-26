// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const electronFakes = vi.hoisted(() => ({
    nextWebContentsId: 200,
}));

vi.mock("electron", () => ({
    WebContentsView: class {
        webContents: {
            id: number;
            close: ReturnType<typeof vi.fn>;
            send: ReturnType<typeof vi.fn>;
            isDestroyed: ReturnType<typeof vi.fn>;
            loadFile: ReturnType<typeof vi.fn>;
            loadURL: ReturnType<typeof vi.fn>;
            on: ReturnType<typeof vi.fn>;
            emitDestroyed: () => void;
        };
        setBackgroundColor = vi.fn();
        setBounds = vi.fn();

        constructor() {
            const listeners = new Map<string, () => void>();
            this.webContents = {
                id: electronFakes.nextWebContentsId++,
                close: vi.fn(() => listeners.get("destroyed")?.()),
                send: vi.fn(),
                isDestroyed: vi.fn(() => false),
                loadFile: vi.fn(() => Promise.resolve()),
                loadURL: vi.fn(() => Promise.resolve()),
                on: vi.fn((event: string, callback: () => void) => listeners.set(event, callback)),
                emitDestroyed: () => listeners.get("destroyed")?.(),
            };
        }
    },
}));
vi.mock("./emain-platform", () => ({
    getElectronAppBasePath: () => "/tmp",
    isDevVite: false,
}));

import {
    getOrCreateWorkspaceView,
    getWorkspaceViewByWebContentsId,
    handleWorkspaceRendererInitStatus,
    makeIdempotentWorkspaceViewCleanup,
    positionWorkspaceView,
    removeWorkspaceView,
    resetWorkspaceViewRegistryForTests,
    resolveWorkspaceReady,
    runClosedWindowWorkspaceCleanup,
    sendCurrentWorkspaceInit,
    sendWorkspaceCommand,
    sendWorkspaceInit,
    waitForWorkspaceViewInitialization,
    WorkspaceView,
} from "./emain-workspaceview";

class FakeWorkspaceView {
    webContents = {
        id: 101,
        close: vi.fn(),
        send: vi.fn(),
        isDestroyed: vi.fn(() => false),
    };
    isDestroyed = false;
    waveWindowId: string;
    workspaceId: string;
    setBounds = vi.fn();

    constructor(init: WorkspaceInitOpts) {
        this.waveWindowId = init.windowId;
        this.workspaceId = init.workspaceId;
    }

    destroy() {
        this.webContents.close();
    }
}

function makeOptions() {
    const init: WorkspaceInitOpts = {
        clientId: "client-1",
        windowId: "window-1",
        workspaceId: "workspace-1",
        generation: 1,
    };
    return {
        init,
        fullConfig: {} as FullConfigType,
        createView: () => new FakeWorkspaceView(init),
    };
}

describe("WorkspaceView registry", () => {
    afterEach(() => {
        resetWorkspaceViewRegistryForTests();
    });

    it("keeps one workspace view for the lifetime of a window", () => {
        const options = makeOptions();
        const first = getOrCreateWorkspaceView("window-1", options);
        const second = getOrCreateWorkspaceView("window-1", options);

        expect(second).toBe(first);
        expect(getWorkspaceViewByWebContentsId(first.webContents.id)).toBe(first);
    });

    it("preserves one workspace webContents identity across Agent, Terminal, and every production Top Tab", () => {
        const options = makeOptions();
        const createView = vi.fn(options.createView);
        const workspaceView = getOrCreateWorkspaceView("window-1", {
            ...options,
            createView,
        });
        const workspaceWebContentsId = workspaceView.webContents.id;
        const activate = (command: WorkspaceCommand) => {
            expect(sendWorkspaceCommand("window-1", command)).toBe(true);
            expect(
                getOrCreateWorkspaceView("window-1", {
                    ...options,
                    createView,
                }).webContents.id
            ).toBe(workspaceWebContentsId);
        };

        activate({ type: "activate-agent" });
        activate({ type: "activate-terminal", terminalTabId: "terminal-1" });
        activate({ type: "activate-top-tab", topTabId: "file-1" });
        activate({ type: "activate-top-tab", topTabId: "preview-1" });
        activate({ type: "activate-top-tab", topTabId: "diff-1" });
        activate({ type: "activate-agent" });

        expect(createView).toHaveBeenCalledOnce();
        expect(getWorkspaceViewByWebContentsId(workspaceWebContentsId)).toBe(workspaceView);

        removeWorkspaceView("window-1");
        expect(getWorkspaceViewByWebContentsId(workspaceWebContentsId)).toBeUndefined();
    });

    it("sends validated workspace commands only to the requested window WorkspaceView", () => {
        const first = getOrCreateWorkspaceView("window-1", makeOptions());
        const secondOptions = makeOptions();
        secondOptions.init.windowId = "window-2";
        secondOptions.init.workspaceId = "workspace-2";
        const second = getOrCreateWorkspaceView("window-2", secondOptions);

        expect(sendWorkspaceCommand("window-1", { type: "activate-agent" })).toBe(true);
        expect(sendWorkspaceCommand("window-1", { type: "activate-terminal", terminalTabId: "" })).toBe(false);
        expect(sendWorkspaceCommand("missing", { type: "next-content" })).toBe(false);

        expect(first.webContents.send).toHaveBeenCalledOnce();
        expect(first.webContents.send).toHaveBeenCalledWith("workspace-command", { type: "activate-agent" });
        expect(second.webContents.send).not.toHaveBeenCalled();
    });

    it.each(["/repo/a.ts", "C:\\repo\\a.ts", "\\\\server\\share\\a.ts"])(
        "accepts cross-platform absolute Workspace command path %s",
        (path) => {
            const view = getOrCreateWorkspaceView("window-1", makeOptions());
            expect(sendWorkspaceCommand("window-1", { type: "open-file", path })).toBe(true);
            expect(view.webContents.send).toHaveBeenCalledWith("workspace-command", { type: "open-file", path });
        }
    );

    it.each(["repo/a.ts", "C:repo\\a.ts", "\\\\server", "file:///repo/a.ts"])(
        "rejects invalid Workspace command path %s",
        (path) => {
            const view = getOrCreateWorkspaceView("window-1", makeOptions());
            expect(sendWorkspaceCommand("window-1", { type: "open-preview", path })).toBe(false);
            expect(view.webContents.send).not.toHaveBeenCalled();
        }
    );

    it.each([
        null,
        undefined,
        {},
        { type: "unknown" },
        { type: "activate-terminal" },
        { type: "activate-terminal", terminalTabId: 1 },
        { type: "activate-terminal", terminalTabId: "" },
        { type: "activate-terminal", terminalTabId: "   " },
        { type: "activate-top-tab" },
        { type: "activate-top-tab", topTabId: 1 },
        { type: "activate-top-tab", topTabId: "" },
        { type: "activate-top-tab", topTabId: "   " },
        { type: "activate-agent", extra: true },
        { type: "activate-top-tab", topTabId: "tab-1", extra: true },
        { type: "next-content", [Symbol("extra")]: true },
        Object.assign(Object.create({ type: "activate-agent" }), {}),
        Object.assign(Object.create({ terminalTabId: "terminal-1" }), { type: "activate-terminal" }),
    ])("rejects malformed or non-exact workspace command %#", (command) => {
        const view = getOrCreateWorkspaceView("window-1", makeOptions());

        expect(sendWorkspaceCommand("window-1", command)).toBe(false);
        expect(view.webContents.send).not.toHaveBeenCalled();
    });

    it("does not send during destroyed and throwing WebContents races", () => {
        const view = getOrCreateWorkspaceView("window-1", makeOptions());
        view.isDestroyed = true;
        expect(sendWorkspaceCommand("window-1", { type: "activate-agent" })).toBe(false);
        expect(view.webContents.send).not.toHaveBeenCalled();

        view.isDestroyed = false;
        view.webContents.isDestroyed.mockReturnValue(true);
        expect(sendWorkspaceCommand("window-1", { type: "activate-agent" })).toBe(false);
        expect(view.webContents.send).not.toHaveBeenCalled();

        view.webContents.isDestroyed.mockReturnValue(false);
        view.webContents.send.mockImplementation(() => {
            throw new Error("destroyed during send");
        });
        expect(sendWorkspaceCommand("window-1", { type: "activate-agent" })).toBe(false);
    });

    it("preserves accepted IDs after using their trimmed value only for validation", () => {
        const view = getOrCreateWorkspaceView("window-1", makeOptions());
        const command = { type: "activate-terminal", terminalTabId: " terminal-1 " };

        expect(sendWorkspaceCommand("window-1", command)).toBe(true);
        expect(view.webContents.send).toHaveBeenCalledWith("workspace-command", command);
    });

    it("sends to a registered replacement rather than a removed WorkspaceView", () => {
        const first = getOrCreateWorkspaceView("window-1", makeOptions());
        removeWorkspaceView("window-1");
        const replacement = getOrCreateWorkspaceView("window-1", makeOptions());

        expect(sendWorkspaceCommand("window-1", { type: "activate-agent" })).toBe(true);
        expect(first.webContents.send).not.toHaveBeenCalled();
        expect(replacement.webContents.send).toHaveBeenCalledOnce();
    });

    it("clears both indexes and destroys the view when removed", () => {
        const view = getOrCreateWorkspaceView("window-1", makeOptions());

        removeWorkspaceView("window-1");

        expect(getWorkspaceViewByWebContentsId(view.webContents.id)).toBeUndefined();
        expect(view.webContents.close).toHaveBeenCalledOnce();
        expect(getOrCreateWorkspaceView("window-1", makeOptions())).not.toBe(view);
    });

    it("does not let a replaced view remove the replacement when its destroyed event arrives late", () => {
        const options = makeOptions();
        const oldView = getOrCreateWorkspaceView("window-1", {
            init: options.init,
            fullConfig: options.fullConfig,
        });
        removeWorkspaceView("window-1", false);
        const replacement = getOrCreateWorkspaceView("window-1", {
            init: options.init,
            fullConfig: options.fullConfig,
        });

        (oldView.webContents as typeof oldView.webContents & { emitDestroyed: () => void }).emitDestroyed();

        expect(getWorkspaceViewByWebContentsId(replacement.webContents.id)).toBe(replacement);
        expect(getWorkspaceViewByWebContentsId(oldView.webContents.id)).toBeUndefined();
    });

    it("removes a view when Electron makes webContents unavailable before the destroyed callback", () => {
        const options = makeOptions();
        const view = getOrCreateWorkspaceView("window-1", {
            init: options.init,
            fullConfig: options.fullConfig,
        });
        const webContents = view.webContents as typeof view.webContents & { emitDestroyed: () => void };
        const webContentsId = webContents.id;
        vi.mocked(webContents.close).mockImplementation(() => {
            Object.defineProperty(view, "webContents", {
                configurable: true,
                get: () => undefined,
            });
            webContents.emitDestroyed();
        });

        expect(() => removeWorkspaceView("window-1")).not.toThrow();
        expect(getWorkspaceViewByWebContentsId(webContentsId)).toBeUndefined();
        expect(getOrCreateWorkspaceView("window-1", makeOptions())).not.toBe(view);
    });

    it("uses complete content bounds and sends init without waiting for workspace-ready", () => {
        const view = getOrCreateWorkspaceView("window-1", makeOptions());
        const bounds = { x: 7, y: 9, width: 1200, height: 800 };

        positionWorkspaceView(view, bounds);
        sendWorkspaceInit(view, makeOptions().init);
        sendWorkspaceInit(view, makeOptions().init);

        expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
        expect(view.webContents.send).toHaveBeenCalledWith("workspace-init", makeOptions().init);
        expect(view.webContents.send).toHaveBeenCalledOnce();
    });

    it("sends a new init payload when the persistent view switches workspace", () => {
        const view = getOrCreateWorkspaceView("window-1", makeOptions());
        sendWorkspaceInit(view, makeOptions().init);

        sendWorkspaceInit(view, {
            ...makeOptions().init,
            workspaceId: "workspace-2",
        });

        expect(view.webContents.send).toHaveBeenCalledTimes(2);
        expect(view.webContents.send).toHaveBeenLastCalledWith("workspace-init", {
            ...makeOptions().init,
            workspaceId: "workspace-2",
        });
    });

    it("creates a tab-independent production view with explicit readiness", async () => {
        const options = makeOptions();
        const view = getOrCreateWorkspaceView("window-1", {
            init: options.init,
            fullConfig: options.fullConfig,
        });
        let workspaceReady = false;
        view.workspaceReadyPromise.then(() => {
            workspaceReady = true;
        });

        expect(view).toBeInstanceOf(WorkspaceView);
        expect("waveTabId" in view).toBe(false);
        expect(view.webContents.loadFile).toHaveBeenCalledOnce();
        expect(workspaceReady).toBe(false);

        view.workspaceReadyResolve();
        await view.workspaceReadyPromise;
        expect(workspaceReady).toBe(true);

        view.destroy();
        expect(getWorkspaceViewByWebContentsId(view.webContents.id)).toBeUndefined();
    });

    it("requires a fresh workspace-ready signal after the persistent view switches workspace", async () => {
        const options = makeOptions();
        const view = getOrCreateWorkspaceView("window-1", {
            init: options.init,
            fullConfig: options.fullConfig,
        });
        view.workspaceReadyResolve();
        await view.workspaceReadyPromise;
        const firstReadyPromise = view.workspaceReadyPromise;

        view.updateWorkspace("client-1", "workspace-2");
        let secondReady = false;
        view.workspaceReadyPromise.then(() => {
            secondReady = true;
        });
        await Promise.resolve();

        expect(view.workspaceReadyPromise).not.toBe(firstReadyPromise);
        expect(secondReady).toBe(false);
        view.workspaceReadyResolve();
        await view.workspaceReadyPromise;
        expect(secondReady).toBe(true);
    });

    it("allocates a fresh generation for every authoritative workspace init", () => {
        const options = makeOptions();
        const view = getOrCreateWorkspaceView("window-1", {
            init: options.init,
            fullConfig: options.fullConfig,
        });
        const firstGeneration = view.initOpts.generation;
        const firstReadyPromise = view.workspaceReadyPromise;

        view.updateWorkspace("client-1", "workspace-1");

        expect(view.initOpts.generation).toBe(firstGeneration + 1);
        expect(view.workspaceReadyPromise).not.toBe(firstReadyPromise);
    });

    it("ignores a workspace-ready signal from an older workspace generation", async () => {
        const options = makeOptions();
        const view = getOrCreateWorkspaceView("window-1", {
            init: options.init,
            fullConfig: options.fullConfig,
        });
        const oldReady = {
            workspaceId: view.initOpts.workspaceId,
            generation: view.initOpts.generation,
        };
        view.updateWorkspace("client-1", "workspace-2");

        expect(resolveWorkspaceReady(view, oldReady)).toBe(false);
        let ready = false;
        view.workspaceReadyPromise.then(() => {
            ready = true;
        });
        await Promise.resolve();
        expect(ready).toBe(false);

        expect(
            resolveWorkspaceReady(view, {
                workspaceId: view.initOpts.workspaceId,
                generation: view.initOpts.generation,
            })
        ).toBe(true);
        await view.workspaceReadyPromise;
        expect(ready).toBe(true);
    });
});

describe("WorkspaceView window lifecycle", () => {
    it.each([
        ["quitting", true, false],
        ["updater installing", false, true],
        ["normal close", false, false],
    ])("cleans the workspace view before the %s branch", (_name, isQuitting, isUpdaterInstalling) => {
        const cleanup = vi.fn();
        const continueNormalClose = runClosedWindowWorkspaceCleanup({
            isQuitting,
            isUpdaterInstalling,
            cleanup,
        });

        expect(cleanup).toHaveBeenCalledOnce();
        expect(continueNormalClose).toBe(!isQuitting && !isUpdaterInstalling);
    });

    it("cleans only once when explicit destroy is followed by closed", () => {
        const cleanupViews = vi.fn();
        const cleanup = makeIdempotentWorkspaceViewCleanup(cleanupViews);

        cleanup();
        runClosedWindowWorkspaceCleanup({
            isQuitting: false,
            isUpdaterInstalling: false,
            cleanup,
        });

        expect(cleanupViews).toHaveBeenCalledOnce();
    });
});

describe("WorkspaceView staged initialization", () => {
    it("times out init without rejecting or waiting forever", async () => {
        let rejectInit: (error: Error) => void;
        const initPromise = new Promise<void>((_resolve, reject) => {
            rejectInit = reject;
        });
        const result = await waitForWorkspaceViewInitialization(
            { initPromise, workspaceReadyPromise: Promise.resolve() },
            { waitForWorkspaceReady: false, timeoutMs: 1 }
        );

        expect(result).toEqual({ initReady: false, workspaceReady: false });
        rejectInit(new Error("late preload failure"));
        await Promise.resolve();
    });

    it("does not wait for workspace-ready until staged activation is enabled", async () => {
        const workspaceReadyPromise = new Promise<void>(() => {});
        const result = await waitForWorkspaceViewInitialization(
            { initPromise: Promise.resolve(), workspaceReadyPromise },
            { waitForWorkspaceReady: false, timeoutMs: 1 }
        );

        expect(result).toEqual({ initReady: true, workspaceReady: false });
    });

    it("bounds the workspace-ready wait when staged activation is enabled", async () => {
        const workspaceReadyPromise = new Promise<void>(() => {});
        const result = await waitForWorkspaceViewInitialization(
            { initPromise: Promise.resolve(), workspaceReadyPromise },
            { waitForWorkspaceReady: true, timeoutMs: 1 }
        );

        expect(result).toEqual({ initReady: true, workspaceReady: false });
    });

    it("runs init delivery before waiting for workspace-ready", async () => {
        let workspaceReadyResolve: () => void;
        const workspaceReadyPromise = new Promise<void>((resolve) => {
            workspaceReadyResolve = resolve;
        });
        const onInitReady = vi.fn(() => workspaceReadyResolve());
        const result = await waitForWorkspaceViewInitialization(
            { initPromise: Promise.resolve(), workspaceReadyPromise },
            { waitForWorkspaceReady: true, timeoutMs: 10, onInitReady }
        );

        expect(onInitReady).toHaveBeenCalledOnce();
        expect(result).toEqual({ initReady: true, workspaceReady: true });
    });

    it("sends the current generation when renderer ready arrives after the init wait timed out", async () => {
        const options = makeOptions();
        const view = getOrCreateWorkspaceView("window-late", {
            init: { ...options.init, windowId: "window-late", clientId: "", generation: 0 },
            fullConfig: options.fullConfig,
        });
        view.updateWorkspace("client-current", "workspace-current");
        const currentInit = { ...view.initOpts };
        const result = await waitForWorkspaceViewInitialization(view, {
            waitForWorkspaceReady: false,
            timeoutMs: 1,
        });

        expect(result.initReady).toBe(false);
        expect(handleWorkspaceRendererInitStatus(view, "ready")).toBe(true);
        expect(view.webContents.send).toHaveBeenCalledOnce();
        expect(view.webContents.send).toHaveBeenCalledWith("workspace-init", currentInit);
    });

    it("deduplicates the normal init delivery and never sends the unarmed generation", async () => {
        const options = makeOptions();
        const view = getOrCreateWorkspaceView("window-normal", {
            init: { ...options.init, windowId: "window-normal", clientId: "", generation: 0 },
            fullConfig: options.fullConfig,
        });

        expect(sendCurrentWorkspaceInit(view)).toBe(false);
        view.updateWorkspace("client-current", "workspace-current");
        expect(handleWorkspaceRendererInitStatus(view, "ready")).toBe(true);
        const result = await waitForWorkspaceViewInitialization(view, {
            waitForWorkspaceReady: false,
            onInitReady: () => sendCurrentWorkspaceInit(view),
        });

        expect(result.initReady).toBe(true);
        expect(sendCurrentWorkspaceInit(view)).toBe(false);
        expect(view.webContents.send).toHaveBeenCalledOnce();
        expect(view.webContents.send).toHaveBeenCalledWith("workspace-init", view.initOpts);
    });

    it("retries a failed current generation without accepting stale failures or retrying forever", () => {
        const options = makeOptions();
        const view = getOrCreateWorkspaceView("window-retry", {
            init: { ...options.init, windowId: "window-retry", clientId: "", generation: 0 },
            fullConfig: options.fullConfig,
        });
        view.updateWorkspace("client-current", "workspace-current");
        const current = {
            workspaceId: view.initOpts.workspaceId,
            generation: view.initOpts.generation,
        };

        expect(sendCurrentWorkspaceInit(view)).toBe(true);
        expect(handleWorkspaceRendererInitStatus(view, "workspace-init-failed", current)).toBe(true);
        expect(view.webContents.send).toHaveBeenCalledTimes(2);
        expect(
            handleWorkspaceRendererInitStatus(view, "workspace-init-failed", {
                workspaceId: "workspace-old",
                generation: current.generation - 1,
            })
        ).toBe(false);
        expect(handleWorkspaceRendererInitStatus(view, "workspace-init-failed", current)).toBe(true);
        expect(handleWorkspaceRendererInitStatus(view, "workspace-init-failed", current)).toBe(false);
        expect(view.webContents.send).toHaveBeenCalledTimes(4);
        expect(view.webContents.send).toHaveBeenLastCalledWith("workspace-init-fatal", current);
    });
});
