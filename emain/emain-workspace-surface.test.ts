// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
    applyWorkspaceSurface,
    isWorkspaceSurfaceState,
    makeTerminalMembershipValidator,
    prepareWorkspaceSurface,
} from "./emain-workspace-surface";

function makeView(tabId: string) {
    return {
        waveTabId: tabId,
        positionTabOnScreen: vi.fn(),
        positionTabOffScreen: vi.fn(),
    };
}

describe("workspace surface integration", () => {
    const identity = { workspaceId: "workspace-1", generation: 3 };

    function makeSurface(overrides: Partial<WorkspaceSurfaceState> = {}): WorkspaceSurfaceState {
        return {
            kind: "agent",
            workspaceId: identity.workspaceId,
            generation: identity.generation,
            revision: 1,
            bounds: { x: 8, y: 10, width: 100, height: 80 },
            ...overrides,
        } as WorkspaceSurfaceState;
    }

    it("keeps workspace chrome mounted and shows only the active terminal in the central bounds", () => {
        const terminalOne = makeView("terminal-1");
        const terminalTwo = makeView("terminal-2");
        const workspaceView = {};
        const window = {
            workspaceView,
            activeTabView: terminalOne,
            allLoadedTabViews: new Map([
                ["terminal-1", terminalOne],
                ["terminal-2", terminalTwo],
            ]),
            bringToFront: vi.fn(),
        };
        const windowBounds = { x: 0, y: 0, width: 1200, height: 800 };
        const contentBounds = { x: 240, y: 72, width: 760, height: 680 };

        applyWorkspaceSurface(
            window,
            {
                kind: "terminal",
                terminalTabId: "terminal-1",
                workspaceId: identity.workspaceId,
                generation: identity.generation,
                revision: 1,
                bounds: contentBounds,
            },
            windowBounds
        );

        expect(window.workspaceView).toBe(workspaceView);
        expect(terminalOne.positionTabOnScreen).toHaveBeenCalledWith(contentBounds);
        expect(terminalTwo.positionTabOffScreen).toHaveBeenCalledWith(windowBounds);
        expect(window.bringToFront).toHaveBeenCalledWith(terminalOne);
        expect(terminalOne.positionTabOnScreen.mock.invocationCallOrder[0]).toBeLessThan(
            window.bringToFront.mock.invocationCallOrder[0]
        );
    });

    it.each(["agent", "top-tab"] as const)("moves every legacy terminal offscreen for %s content", (kind) => {
        const terminalOne = makeView("terminal-1");
        const terminalTwo = makeView("terminal-2");
        const window = {
            workspaceView: {},
            activeTabView: terminalOne,
            allLoadedTabViews: new Map([
                ["terminal-1", terminalOne],
                ["terminal-2", terminalTwo],
            ]),
            bringToFront: vi.fn(),
        };
        const windowBounds = { x: 0, y: 0, width: 1200, height: 800 };

        applyWorkspaceSurface(
            window,
            {
                kind,
                workspaceId: identity.workspaceId,
                generation: identity.generation,
                revision: 1,
                bounds: { x: 240, y: 72, width: 760, height: 680 },
            },
            windowBounds
        );

        expect(terminalOne.positionTabOffScreen).toHaveBeenCalledWith(windowBounds);
        expect(terminalTwo.positionTabOffScreen).toHaveBeenCalledWith(windowBounds);
        expect(window.bringToFront).not.toHaveBeenCalled();
    });

    it("rejects malformed bounds and extra protocol fields", () => {
        expect(
            isWorkspaceSurfaceState({
                kind: "terminal",
                terminalTabId: "terminal-1",
                workspaceId: identity.workspaceId,
                generation: identity.generation,
                revision: 1,
                bounds: { x: 0, y: 0, width: Number.NaN, height: 400 },
            })
        ).toBe(false);
        expect(
            isWorkspaceSurfaceState({
                kind: "agent",
                workspaceId: identity.workspaceId,
                generation: identity.generation,
                revision: 1,
                bounds: { x: 0, y: 0, width: 800, height: 400 },
                terminalTabId: "terminal-1",
            })
        ).toBe(false);
    });

    it.each([
        { zoomFactor: 1.25, expected: { x: 10, y: 13, width: 125, height: 100 } },
        { zoomFactor: 2, expected: { x: 16, y: 20, width: 200, height: 160 } },
    ])("converts renderer CSS pixels to DIP at zoom $zoomFactor", async ({ zoomFactor, expected }) => {
        const result = await prepareWorkspaceSurface({
            surface: makeSurface(),
            getCurrentIdentity: () => identity,
            getLastRevision: () => 0,
            zoomFactor,
            windowBounds: { x: 0, y: 0, width: 500, height: 400 },
            validateTerminalTab: vi.fn(),
        });

        expect(result).toMatchObject({ surface: { bounds: expected }, revision: 1 });
    });

    it.each([
        { name: "workspace", overrides: { workspaceId: "workspace-old" } },
        { name: "generation", overrides: { generation: 2 } },
        { name: "revision", overrides: { revision: 4 }, lastRevision: 4 },
        { name: "out-of-order revision", overrides: { revision: 3 }, lastRevision: 4 },
    ])("rejects stale $name surface updates", async ({ overrides, lastRevision = 0 }) => {
        const result = await prepareWorkspaceSurface({
            surface: makeSurface(overrides),
            getCurrentIdentity: () => identity,
            getLastRevision: () => lastRevision,
            zoomFactor: 1,
            windowBounds: { x: 0, y: 0, width: 500, height: 400 },
            validateTerminalTab: vi.fn(),
        });

        expect(result).toBeNull();
    });

    it.each(["cross-workspace-terminal", "mixed-terminal"])(
        "rejects a non-authoritative %s target",
        async (terminalTabId) => {
            const validateTerminalTab = vi.fn().mockResolvedValue(false);
            const result = await prepareWorkspaceSurface({
                surface: makeSurface({ kind: "terminal", terminalTabId }),
                getCurrentIdentity: () => identity,
                getLastRevision: () => 0,
                zoomFactor: 1,
                windowBounds: { x: 0, y: 0, width: 500, height: 400 },
                validateTerminalTab,
            });

            expect(validateTerminalTab).toHaveBeenCalledWith(identity.workspaceId, terminalTabId);
            expect(result).toBeNull();
        }
    );

    it("rejects a terminal update when workspace identity changes during validation", async () => {
        let currentIdentity = identity;
        const validateTerminalTab = vi.fn().mockImplementation(async () => {
            currentIdentity = { workspaceId: "workspace-2", generation: 4 };
            return true;
        });
        const result = await prepareWorkspaceSurface({
            surface: makeSurface({ kind: "terminal", terminalTabId: "terminal-1" }),
            getCurrentIdentity: () => currentIdentity,
            getLastRevision: () => 0,
            zoomFactor: 1,
            windowBounds: { x: 0, y: 0, width: 500, height: 400 },
            validateTerminalTab,
        });

        expect(result).toBeNull();
    });

    it("rejects an update that becomes stale during terminal validation", async () => {
        let lastRevision = 0;
        const result = await prepareWorkspaceSurface({
            surface: makeSurface({ kind: "terminal", terminalTabId: "terminal-1", revision: 2 }),
            getCurrentIdentity: () => identity,
            getLastRevision: () => lastRevision,
            zoomFactor: 1,
            windowBounds: { x: 0, y: 0, width: 500, height: 400 },
            validateTerminalTab: async () => {
                lastRevision = 3;
                return true;
            },
        });

        expect(result).toBeNull();
    });

    it("contains authoritative terminal validation failures", async () => {
        const result = await prepareWorkspaceSurface({
            surface: makeSurface({ kind: "terminal", terminalTabId: "terminal-1" }),
            getCurrentIdentity: () => identity,
            getLastRevision: () => 0,
            zoomFactor: 1,
            windowBounds: { x: 0, y: 0, width: 500, height: 400 },
            validateTerminalTab: async () => {
                throw new Error("backend unavailable");
            },
        });

        expect(result).toBeNull();
    });

    it("does not retain successful membership across structural surface revisions", async () => {
        const validate = vi
            .fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const membership = makeTerminalMembershipValidator(validate);

        await expect(membership.validate(identity, "terminal-1")).resolves.toBe(true);
        await expect(membership.validate(identity, "terminal-1")).resolves.toBe(true);
        expect(validate).toHaveBeenCalledTimes(2);

        await expect(membership.validate(identity, "terminal-2")).resolves.toBe(false);
        await expect(membership.validate(identity, "terminal-2")).resolves.toBe(true);
        expect(validate).toHaveBeenCalledTimes(4);
    });

    it("rejects warm and cold higher-revision targets after authoritative removal", async () => {
        let present = true;
        const membership = makeTerminalMembershipValidator(async () => present);
        const prepare = (terminalTabId: string, revision: number) =>
            prepareWorkspaceSurface({
                surface: makeSurface({ kind: "terminal", terminalTabId, revision }),
                getCurrentIdentity: () => identity,
                getLastRevision: () => revision - 1,
                zoomFactor: 1,
                windowBounds: { x: 0, y: 0, width: 500, height: 400 },
                validateTerminalTab: (_workspaceId, targetId) => membership.validate(identity, targetId),
            });

        await expect(prepare("terminal-warm", 1)).resolves.not.toBeNull();
        present = false;
        await expect(prepare("terminal-warm", 2)).resolves.toBeNull();
        await expect(prepare("terminal-cold", 3)).resolves.toBeNull();
    });
});
