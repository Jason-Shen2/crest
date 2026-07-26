// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./wos", () => ({
    getObjectValue: vi.fn((oref: string) =>
        oref === "window:window-1" ? { workspaceid: "workspace-from-window" } : null
    ),
    makeORef: vi.fn((otype: string, oid: string) => `${otype}:${oid}`),
}));

import { initGlobal } from "./global";
import { getAtoms, initGlobalAtoms } from "./global-atoms";
import { getWaveWindowType } from "./windowtype";

const BaseOpts = {
    clientId: "client-1",
    windowId: "window-1",
    platform: "darwin",
    environment: "renderer",
} as const;

describe("global renderer atoms", () => {
    beforeEach(() => {
        window.api = {
            getIsFullScreen: vi.fn(() => false),
            getUpdaterStatus: vi.fn(() => "up-to-date"),
            getZoomFactor: vi.fn(() => 1),
            onFullScreenChange: vi.fn(),
            onUpdaterStatusChange: vi.fn(),
            onZoomFactorChange: vi.fn(),
        } as unknown as ElectronApi;
        window.matchMedia = vi.fn(
            () =>
                ({
                    addEventListener: vi.fn(),
                    matches: false,
                }) as unknown as MediaQueryList
        );
    });

    test("repeated initialization reuses global listeners and updates the latest atoms", () => {
        const fullScreenListeners: Array<(value: boolean) => void> = [];
        const zoomListeners: Array<(value: number) => void> = [];
        const updaterListeners: Array<(value: UpdaterStatus) => void> = [];
        const mediaListeners: Array<() => void> = [];
        let prefersReducedMotion = false;
        const windowListeners = new Map<string, Array<() => void>>();
        const addWindowListener = vi.spyOn(window, "addEventListener").mockImplementation((type, listener) => {
            const listeners = windowListeners.get(type) ?? [];
            listeners.push(listener as () => void);
            windowListeners.set(type, listeners);
        });
        window.api = {
            getIsFullScreen: vi.fn(() => false),
            getUpdaterStatus: vi.fn(() => "up-to-date"),
            getZoomFactor: vi.fn(() => 1),
            onFullScreenChange: vi.fn((listener) => fullScreenListeners.push(listener)),
            onUpdaterStatusChange: vi.fn((listener) => updaterListeners.push(listener)),
            onZoomFactorChange: vi.fn((listener) => zoomListeners.push(listener)),
        } as unknown as ElectronApi;
        window.matchMedia = vi.fn(
            () =>
                ({
                    addEventListener: vi.fn((_type, listener) => mediaListeners.push(listener)),
                    get matches() {
                        return prefersReducedMotion;
                    },
                }) as unknown as MediaQueryList
        );

        initGlobalAtoms({ ...BaseOpts, rendererKind: "workspace", workspaceId: "workspace-first" });
        initGlobalAtoms({ ...BaseOpts, rendererKind: "workspace", workspaceId: "workspace-second" });
        const latestAtoms = getAtoms();

        expect(fullScreenListeners).toHaveLength(1);
        expect(zoomListeners).toHaveLength(1);
        expect(updaterListeners).toHaveLength(1);
        expect(mediaListeners).toHaveLength(1);
        expect(windowListeners.get("focus")).toHaveLength(1);
        expect(windowListeners.get("blur")).toHaveLength(1);

        fullScreenListeners[0](true);
        zoomListeners[0](1.5);
        prefersReducedMotion = true;
        mediaListeners[0]();
        windowListeners.get("blur")[0]();
        expect(globalStore.get(latestAtoms.isFullScreen)).toBe(true);
        expect(globalStore.get(latestAtoms.zoomFactorAtom)).toBe(1.5);
        expect(globalStore.get(latestAtoms.prefersReducedMotionAtom)).toBe(true);
        expect(globalStore.get(latestAtoms.documentHasFocus)).toBe(false);

        addWindowListener.mockRestore();
    });

    test("repeated global initialization registers the About listener once", () => {
        const onMenuItemAbout = vi.fn();
        window.api = {
            ...window.api,
            onMenuItemAbout,
        } as ElectronApi;

        initGlobal({ ...BaseOpts, rendererKind: "workspace", workspaceId: "workspace-first" });
        initGlobal({ ...BaseOpts, rendererKind: "workspace", workspaceId: "workspace-second" });

        expect(onMenuItemAbout).toHaveBeenCalledTimes(1);
    });

    test("workspace renderer uses its direct workspace identity without a static tab", () => {
        initGlobalAtoms({
            ...BaseOpts,
            rendererKind: "workspace",
            workspaceId: "workspace-direct",
            generation: 9,
        });

        const atoms = getAtoms();
        expect(getWaveWindowType()).toBe("workspace");
        expect(globalStore.get(atoms.workspaceId)).toBe("workspace-direct");
        expect(globalStore.get(atoms.workspaceGeneration)).toBe(9);
        expect(atoms.staticTabId).toBeUndefined();
    });

    test("terminal renderer retains static tab and window-derived workspace behavior", () => {
        initGlobalAtoms({
            ...BaseOpts,
            rendererKind: "terminal",
            tabId: "tab-1",
        });

        const atoms = getAtoms();
        expect(getWaveWindowType()).toBe("tab");
        expect(globalStore.get(atoms.staticTabId)).toBe("tab-1");
        expect(globalStore.get(atoms.workspaceId)).toBe("workspace-from-window");
        expect(globalStore.get(atoms.workspaceGeneration)).toBe(0);
    });

    test.each([
        ["workspace", "workspace renderer requires workspaceId"],
        ["terminal", "terminal renderer requires tabId"],
        ["builder", "builder renderer requires builderId"],
    ] as const)("rejects malformed %s renderer identity", (rendererKind, errorMessage) => {
        const initOpts = {
            ...BaseOpts,
            rendererKind,
        } as GlobalInitOptions;

        expect(() => initGlobalAtoms(initOpts)).toThrow(errorMessage);
    });

    test("rejects an unknown renderer kind", () => {
        const initOpts = {
            ...BaseOpts,
            rendererKind: "bogus",
        } as unknown as GlobalInitOptions;

        expect(() => initGlobalAtoms(initOpts)).toThrow("unknown renderer kind: bogus");
    });

    test.each([{ rendererKind: "builder", builderId: "builder-1" }, { rendererKind: "preview" }] as const)(
        "$rendererKind renderer omits the static tab atom",
        (rendererOpts) => {
            initGlobalAtoms({
                ...BaseOpts,
                ...rendererOpts,
            });

            expect(getAtoms().staticTabId).toBeUndefined();
        }
    );
});
