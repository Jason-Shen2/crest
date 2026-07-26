// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Rectangle } from "electron";

export type WorkspaceSurfaceView = {
    waveTabId: string;
    positionTabOnScreen: (bounds: Rectangle) => void;
    positionTabOffScreen: (bounds: Rectangle) => void;
};

export type WorkspaceSurfaceWindow = {
    workspaceView: unknown;
    activeTabView: WorkspaceSurfaceView;
    allLoadedTabViews: Map<string, WorkspaceSurfaceView>;
    bringToFront: (view: WorkspaceSurfaceView) => void;
};

type WorkspaceIdentity = Pick<WorkspaceInitOpts, "workspaceId" | "generation">;

export function makeTerminalMembershipValidator(
    validateTerminalTab: (workspaceId: string, terminalTabId: string) => Promise<boolean>
) {
    const cache = new Map<string, Promise<boolean>>();
    return {
        validate(identity: WorkspaceIdentity, terminalTabId: string): Promise<boolean> {
            const key = `${identity.workspaceId}:${identity.generation}:${terminalTabId}`;
            const cached = cache.get(key);
            if (cached) {
                return cached;
            }
            const validation = validateTerminalTab(identity.workspaceId, terminalTabId).finally(() => {
                if (cache.get(key) === validation) {
                    cache.delete(key);
                }
            });
            cache.set(key, validation);
            return validation;
        },
        clear(): void {
            cache.clear();
        },
    };
}

function matchesIdentity(surface: WorkspaceSurfaceState, identity: WorkspaceIdentity): boolean {
    return surface.workspaceId === identity.workspaceId && surface.generation === identity.generation;
}

export function isWorkspaceSurfaceState(value: unknown): value is WorkspaceSurfaceState {
    if (typeof value !== "object" || value == null) {
        return false;
    }
    const surface = value as Record<string, unknown>;
    if (surface.kind !== "agent" && surface.kind !== "terminal" && surface.kind !== "top-tab") {
        return false;
    }
    const expectedKeys =
        surface.kind === "terminal"
            ? ["kind", "terminalTabId", "workspaceId", "generation", "revision", "bounds"]
            : ["kind", "workspaceId", "generation", "revision", "bounds"];
    if (
        Reflect.ownKeys(surface).length !== expectedKeys.length ||
        !expectedKeys.every((key) => Object.hasOwn(surface, key))
    ) {
        return false;
    }
    if (surface.kind === "terminal" && (typeof surface.terminalTabId !== "string" || !surface.terminalTabId.trim())) {
        return false;
    }
    if (
        typeof surface.workspaceId !== "string" ||
        !surface.workspaceId.trim() ||
        typeof surface.generation !== "number" ||
        !Number.isInteger(surface.generation) ||
        surface.generation <= 0 ||
        typeof surface.revision !== "number" ||
        !Number.isInteger(surface.revision) ||
        surface.revision <= 0
    ) {
        return false;
    }
    const bounds = surface.bounds as Record<string, unknown>;
    return (
        typeof bounds === "object" &&
        bounds != null &&
        ["x", "y", "width", "height"].every(
            (key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]) && bounds[key] >= 0
        )
    );
}

export async function prepareWorkspaceSurface(opts: {
    surface: WorkspaceSurfaceState;
    getCurrentIdentity: () => WorkspaceIdentity;
    getLastRevision: () => number;
    zoomFactor: number;
    windowBounds: Rectangle;
    validateTerminalTab: (workspaceId: string, terminalTabId: string) => Promise<boolean>;
}): Promise<{ surface: WorkspaceSurfaceState; revision: number }> {
    const { surface } = opts;
    if (!matchesIdentity(surface, opts.getCurrentIdentity()) || surface.revision <= opts.getLastRevision()) {
        return null;
    }
    if (surface.kind === "terminal") {
        try {
            if (!(await opts.validateTerminalTab(surface.workspaceId, surface.terminalTabId))) {
                return null;
            }
        } catch {
            return null;
        }
    }
    if (!matchesIdentity(surface, opts.getCurrentIdentity()) || surface.revision <= opts.getLastRevision()) {
        return null;
    }
    const zoomFactor = Number.isFinite(opts.zoomFactor) && opts.zoomFactor > 0 ? opts.zoomFactor : 1;
    const scaledBounds = {
        x: Math.round(surface.bounds.x * zoomFactor),
        y: Math.round(surface.bounds.y * zoomFactor),
        width: Math.round(surface.bounds.width * zoomFactor),
        height: Math.round(surface.bounds.height * zoomFactor),
    };
    const bounds = {
        x: Math.min(scaledBounds.x, opts.windowBounds.width),
        y: Math.min(scaledBounds.y, opts.windowBounds.height),
        width: Math.min(scaledBounds.width, Math.max(0, opts.windowBounds.width - scaledBounds.x)),
        height: Math.min(scaledBounds.height, Math.max(0, opts.windowBounds.height - scaledBounds.y)),
    };
    return { surface: { ...surface, bounds }, revision: surface.revision };
}

export function applyWorkspaceSurface(
    window: WorkspaceSurfaceWindow,
    surface: WorkspaceSurfaceState,
    windowBounds: Rectangle
): void {
    const activeTerminal =
        surface.kind === "terminal" ? window.allLoadedTabViews.get(surface.terminalTabId) : undefined;
    for (const tabView of window.allLoadedTabViews.values()) {
        if (tabView === activeTerminal) {
            tabView.positionTabOnScreen(surface.bounds);
            continue;
        }
        tabView.positionTabOffScreen(windowBounds);
    }
    if (activeTerminal) {
        window.bringToFront(activeTerminal);
    }
}
