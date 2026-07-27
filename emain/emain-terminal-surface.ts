// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Rectangle } from "electron";

export interface TerminalSurfaceView {
    terminalTabId: string;
}

export class TerminalRendererKindMismatchError extends Error {
    constructor(actualRendererKind: string) {
        super(`expected terminal renderer, received ${actualRendererKind}`);
        this.name = "TerminalRendererKindMismatchError";
    }
}

export interface TerminalSurfaceControllerDeps {
    getCurrentIdentity: () => Pick<WorkspaceInitOpts, "workspaceId" | "generation">;
    getView: (terminalTabId: string) => TerminalSurfaceView;
    createView: (terminalTabId: string) => TerminalSurfaceView | Promise<TerminalSurfaceView>;
    registerView: (view: TerminalSurfaceView) => void;
    disposeView: (view: TerminalSurfaceView) => void;
    isTerminalView: (view: TerminalSurfaceView) => boolean;
    initializeView: (view: TerminalSurfaceView) => Promise<void>;
    getViews: () => Iterable<TerminalSurfaceView>;
    showView: (view: TerminalSurfaceView, bounds: Rectangle) => void;
    hideView: (view: TerminalSurfaceView) => void;
    raiseView: (view: TerminalSurfaceView) => void;
    focusTerminal: (view: TerminalSurfaceView) => void;
    focusWorkspace: () => void;
    emitStatus: (status: TerminalSurfaceStatus) => void;
}

type TerminalSurfaceToken = {
    workspaceId: string;
    generation: number;
    revision: number;
    terminalTabId?: string;
};

type TerminalSurfaceCreation = {
    view: TerminalSurfaceView;
    claimed: boolean;
    disposed: boolean;
};

type TerminalSurfaceInitialization = {
    ownerKey: string;
    view: TerminalSurfaceView;
    promise: Promise<void>;
};

function statusIdentity(surface: WorkspaceSurfaceState) {
    return {
        workspaceid: surface.workspaceId,
        generation: surface.generation,
        revision: surface.revision,
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class TerminalSurfaceController {
    deps: TerminalSurfaceControllerDeps;
    desired: TerminalSurfaceToken;
    lastRevision = 0;
    destroyed = false;
    creationPromises = new Map<string, Promise<TerminalSurfaceCreation>>();
    initializationEntries = new Map<string, TerminalSurfaceInitialization>();
    unreadyViews = new Set<TerminalSurfaceView>();
    disposedViews = new WeakSet<TerminalSurfaceView>();

    constructor(deps: TerminalSurfaceControllerDeps) {
        this.deps = deps;
    }

    async request(surface: WorkspaceSurfaceState): Promise<void> {
        if (!this.accepts(surface)) {
            return;
        }
        this.lastRevision = surface.revision;
        const token: TerminalSurfaceToken = {
            workspaceId: surface.workspaceId,
            generation: surface.generation,
            revision: surface.revision,
            terminalTabId: surface.kind === "terminal" ? surface.terminalTabId : undefined,
        };
        this.desired = token;
        if (surface.kind !== "terminal") {
            this.hideAll();
            this.deps.focusWorkspace();
            this.deps.emitStatus({ state: "idle", ...statusIdentity(surface) });
            return;
        }

        let view = this.deps.getView(surface.terminalTabId);
        if (!view || this.unreadyViews.has(view)) {
            this.deps.emitStatus({
                state: "loading",
                ...statusIdentity(surface),
                terminaltabid: surface.terminalTabId,
            });
        }
        if (!view) {
            try {
                const creationKey = this.creationKey(token);
                const pendingCreation = this.creationPromises.get(creationKey);
                if (pendingCreation) {
                    const result = await pendingCreation;
                    if (!this.isDesired(token)) {
                        await Promise.resolve();
                        this.disposeUnclaimed(result);
                        return;
                    }
                    view = result.view;
                    if (!result.claimed) {
                        result.claimed = true;
                        this.deps.registerView(view);
                        this.deps.hideView(view);
                        this.unreadyViews.add(view);
                    }
                } else {
                    const created = this.deps.createView(surface.terminalTabId);
                    if (created instanceof Promise) {
                        const creation = created.then((createdView) => ({
                            view: createdView,
                            claimed: false,
                            disposed: false,
                        }));
                        this.creationPromises.set(creationKey, creation);
                        const result = await creation.finally(() => {
                            this.creationPromises.delete(creationKey);
                        });
                        if (!this.isDesired(token)) {
                            await Promise.resolve();
                            this.disposeUnclaimed(result);
                            return;
                        }
                        result.claimed = true;
                        view = result.view;
                    } else {
                        view = created;
                    }
                    this.deps.registerView(view);
                    this.deps.hideView(view);
                    this.unreadyViews.add(view);
                }
            } catch (error) {
                this.emitErrorIfDesired(surface, token, error);
                return;
            }
        }
        if (!this.isDesired(token)) {
            this.releaseIfUnowned(view);
            return;
        }
        if (this.unreadyViews.has(view)) {
            let initialization: TerminalSurfaceInitialization | undefined;
            try {
                const ownerKey = this.creationKey(token);
                initialization = this.initializationEntries.get(surface.terminalTabId);
                if (initialization?.ownerKey !== ownerKey || initialization.view !== view) {
                    let newInitialization: TerminalSurfaceInitialization;
                    const promise = this.deps
                        .initializeView(view)
                        .then(() => {
                            if (this.initializationEntries.get(surface.terminalTabId) === newInitialization) {
                                this.unreadyViews.delete(view);
                            }
                        })
                        .finally(() => {
                            if (this.initializationEntries.get(surface.terminalTabId) === newInitialization) {
                                this.initializationEntries.delete(surface.terminalTabId);
                            }
                        });
                    newInitialization = { ownerKey, view, promise };
                    initialization = newInitialization;
                    this.initializationEntries.set(surface.terminalTabId, initialization);
                }
                await initialization.promise;
            } catch (error) {
                if (error instanceof TerminalRendererKindMismatchError) {
                    if (
                        this.isDesiredInitialization(initialization, view) ||
                        !this.isViewOwnedByCurrentWork(view)
                    ) {
                        this.disposeView(view);
                    }
                } else if (!this.isDesired(token)) {
                    this.releaseIfUnowned(view);
                }
                this.emitErrorIfDesired(surface, token, error);
                return;
            }
        }
        if (!this.isDesired(token)) {
            this.releaseIfUnowned(view);
            return;
        }
        if (!this.deps.isTerminalView(view)) {
            this.disposeView(view);
            this.emitErrorIfDesired(surface, token, new Error("renderer is not terminal"));
            return;
        }
        if (surface.bounds.width <= 0 || surface.bounds.height <= 0) {
            this.hideAll();
            this.deps.focusWorkspace();
            return;
        }
        this.deps.showView(view, surface.bounds);
        this.deps.raiseView(view);
        for (const candidate of this.deps.getViews()) {
            if (candidate !== view) {
                this.deps.hideView(candidate);
            }
        }
        this.deps.focusTerminal(view);
        this.deps.emitStatus({
            state: "ready",
            ...statusIdentity(surface),
            terminaltabid: surface.terminalTabId,
        });
    }

    destroy(): void {
        this.destroyed = true;
        this.desired = undefined;
        this.initializationEntries.clear();
        this.hideAll();
    }

    reset(): void {
        this.desired = undefined;
        this.lastRevision = 0;
        this.initializationEntries.clear();
        this.hideAll();
        this.deps.focusWorkspace();
    }

    accepts(surface: WorkspaceSurfaceState): boolean {
        if (this.destroyed || surface.revision <= this.lastRevision) {
            return false;
        }
        const identity = this.deps.getCurrentIdentity();
        return surface.workspaceId === identity.workspaceId && surface.generation === identity.generation;
    }

    isDesired(token: TerminalSurfaceToken): boolean {
        if (this.destroyed || this.desired !== token) {
            return false;
        }
        const identity = this.deps.getCurrentIdentity();
        return token.workspaceId === identity.workspaceId && token.generation === identity.generation;
    }

    hideAll(): void {
        for (const view of this.deps.getViews()) {
            this.deps.hideView(view);
        }
    }

    creationKey(token: TerminalSurfaceToken): string {
        return `${token.workspaceId}:${token.generation}:${token.terminalTabId}`;
    }

    disposeUnclaimed(creation: TerminalSurfaceCreation): void {
        if (!creation.claimed && !creation.disposed) {
            creation.disposed = true;
            this.disposeView(creation.view);
        }
    }

    disposeView(view: TerminalSurfaceView): void {
        if (this.disposedViews.has(view)) {
            return;
        }
        this.disposedViews.add(view);
        this.unreadyViews.delete(view);
        this.deps.disposeView(view);
    }

    releaseIfUnowned(view: TerminalSurfaceView): void {
        if (this.isViewOwnedByCurrentWork(view)) {
            return;
        }
        this.disposeView(view);
    }

    isViewOwnedByCurrentWork(view: TerminalSurfaceView): boolean {
        if (this.destroyed) {
            return false;
        }
        for (const initialization of this.initializationEntries.values()) {
            if (initialization.view === view) {
                return true;
            }
        }
        const desired = this.desired;
        if (!desired?.terminalTabId || this.deps.getView(desired.terminalTabId) !== view) {
            return false;
        }
        const identity = this.deps.getCurrentIdentity();
        return desired.workspaceId === identity.workspaceId && desired.generation === identity.generation;
    }

    isDesiredInitialization(
        initialization: TerminalSurfaceInitialization | undefined,
        view: TerminalSurfaceView
    ): boolean {
        const desired = this.desired;
        if (!initialization || !desired?.terminalTabId) {
            return false;
        }
        return (
            initialization.view === view &&
            desired.terminalTabId === view.terminalTabId &&
            initialization.ownerKey === this.creationKey(desired) &&
            this.isViewOwnedByCurrentWork(view)
        );
    }

    emitErrorIfDesired(
        surface: Extract<WorkspaceSurfaceState, { kind: "terminal" }>,
        token: TerminalSurfaceToken,
        error: unknown
    ) {
        if (this.isDesired(token)) {
            this.deps.emitStatus({
                state: "error",
                ...statusIdentity(surface),
                terminaltabid: surface.terminalTabId,
                message: errorMessage(error),
            });
        }
    }
}
