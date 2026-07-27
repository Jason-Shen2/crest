// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Rectangle, WebContentsView } from "electron";
import path from "path";

import { isAbsoluteLocalPath } from "../frontend/util/local-path";
import { getElectronAppBasePath, isDevVite } from "./emain-platform";

export const WorkspaceInitTimeoutMs = 5000;

export type WorkspaceViewHandle = {
    readonly waveWindowId: string;
    readonly workspaceId: string;
    readonly webContents: {
        readonly id: number;
        close: () => void;
        send: (channel: string, ...args: unknown[]) => void;
        getZoomFactor?: () => number;
        isDestroyed?: () => boolean;
    };
    setBounds: (bounds: Rectangle) => void;
    destroy: () => void;
    initResolve?: () => void;
    workspaceReadyResolve?: () => void;
    updateWorkspace?: (clientId: string, workspaceId: string) => void;
    initOpts?: WorkspaceInitOpts;
    isDestroyed?: boolean;
};

export function resolveWorkspaceReady(view: WorkspaceViewHandle, ready: WorkspaceReadyStatus): boolean {
    if (ready?.workspaceId !== view.initOpts?.workspaceId || ready?.generation !== view.initOpts?.generation) {
        return false;
    }
    workspaceInitRetriesByView.delete(view);
    view.workspaceReadyResolve?.();
    return true;
}

export type WorkspaceViewOptions = {
    init: WorkspaceInitOpts;
    fullConfig: FullConfigType;
    createView?: () => WorkspaceViewHandle;
};

const workspaceViewsByWindowId = new Map<string, WorkspaceViewHandle>();
const workspaceViewsByWebContentsId = new Map<number, WorkspaceViewHandle>();
const workspaceWebContentsIdsByView = new WeakMap<object, number>();
const sentWorkspaceInitByView = new WeakMap<object, string>();
const workspaceInitRetriesByView = new WeakMap<object, { key: string; count: number }>();
const MaxWorkspaceInitRetries = 2;

function isWorkspaceCommand(command: unknown): command is WorkspaceCommand {
    if (typeof command !== "object" || command == null) {
        return false;
    }
    const record = command as Record<PropertyKey, unknown>;
    const ownKeys = Reflect.ownKeys(record);
    if (!Object.hasOwn(record, "type") || typeof record.type !== "string") {
        return false;
    }
    switch (record.type) {
        case "open-url": {
            if (ownKeys.length !== 2 || !ownKeys.includes("url") || typeof record.url !== "string") {
                return false;
            }
            try {
                const protocol = new URL(record.url).protocol;
                return protocol === "http:" || protocol === "https:";
            } catch {
                return false;
            }
        }
        case "open-file":
        case "open-preview":
            return ownKeys.length === 2 && ownKeys.includes("path") && isAbsoluteLocalPath(record.path);
        case "open-git-diff": {
            const allowedKeys = new Set(["type", "repoRoot", "path", "mode", "originalPath"]);
            return (
                ownKeys.length >= 4 &&
                ownKeys.length <= 5 &&
                ownKeys.every((key) => typeof key === "string" && allowedKeys.has(key)) &&
                isAbsoluteLocalPath(record.repoRoot) &&
                typeof record.path === "string" &&
                record.path.trim() !== "" &&
                (record.mode === "+" || record.mode === "-") &&
                (record.originalPath == null || typeof record.originalPath === "string")
            );
        }
        case "activate-agent":
        case "new-terminal":
        case "close-active":
        case "next-content":
        case "previous-content":
            return ownKeys.length === 1 && ownKeys[0] === "type";
        case "activate-terminal":
            return (
                ownKeys.length === 2 &&
                ownKeys.includes("type") &&
                ownKeys.includes("terminalTabId") &&
                Object.hasOwn(record, "terminalTabId") &&
                typeof record.terminalTabId === "string" &&
                record.terminalTabId.trim() !== ""
            );
        case "activate-top-tab":
            return (
                ownKeys.length === 2 &&
                ownKeys.includes("type") &&
                ownKeys.includes("topTabId") &&
                Object.hasOwn(record, "topTabId") &&
                typeof record.topTabId === "string" &&
                record.topTabId.trim() !== ""
            );
        default:
            return false;
    }
}

async function resolvesBeforeTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            resolve(result);
        };
        const timeoutHandle = setTimeout(() => finish(false), timeoutMs);
        promise.then(
            () => finish(true),
            () => finish(false)
        );
    });
}

export async function waitForWorkspaceViewInitialization(
    view: Pick<WorkspaceView, "initPromise" | "workspaceReadyPromise">,
    opts: { waitForWorkspaceReady: boolean; timeoutMs?: number; onInitReady?: () => void }
): Promise<{ initReady: boolean; workspaceReady: boolean }> {
    const timeoutMs = opts.timeoutMs ?? WorkspaceInitTimeoutMs;
    const initReady = await resolvesBeforeTimeout(view.initPromise, timeoutMs);
    if (!initReady) {
        return { initReady: false, workspaceReady: false };
    }
    opts.onInitReady?.();
    if (!opts.waitForWorkspaceReady) {
        return { initReady, workspaceReady: false };
    }
    const workspaceReady = await resolvesBeforeTimeout(view.workspaceReadyPromise, timeoutMs);
    return { initReady, workspaceReady };
}

export function makeIdempotentWorkspaceViewCleanup(cleanup: () => void): () => void {
    let didCleanup = false;
    return () => {
        if (didCleanup) {
            return;
        }
        didCleanup = true;
        cleanup();
    };
}

export function runClosedWindowWorkspaceCleanup(opts: {
    isQuitting: boolean;
    isUpdaterInstalling: boolean;
    cleanup: () => void;
}): boolean {
    opts.cleanup();
    return !opts.isQuitting && !opts.isUpdaterInstalling;
}

function computeWorkspaceBackgroundColor(fullConfig: FullConfigType): string {
    const settings = fullConfig?.settings;
    if (settings?.["window:transparent"] || settings?.["window:blur"]) {
        return "#00000000";
    }
    return "#222222";
}

export class WorkspaceView extends WebContentsView implements WorkspaceViewHandle {
    readonly waveWindowId: string;
    workspaceId: string;
    readonly initPromise: Promise<void>;
    workspaceReadyPromise: Promise<void>;
    initResolve: () => void;
    workspaceReadyResolve: () => void;
    initOpts: WorkspaceInitOpts;
    isDestroyed = false;

    constructor(init: WorkspaceInitOpts, fullConfig: FullConfigType) {
        super({
            webPreferences: {
                preload: path.join(getElectronAppBasePath(), "preload", "index.cjs"),
                webviewTag: true,
            },
        });
        this.waveWindowId = init.windowId;
        this.workspaceId = init.workspaceId;
        this.initOpts = { ...init, generation: init.generation ?? 1 };
        this.initPromise = new Promise((resolve) => {
            this.initResolve = resolve;
        });
        this.resetWorkspaceReady();
        this.setBackgroundColor(computeWorkspaceBackgroundColor(fullConfig));
        const loadPromise = isDevVite
            ? this.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL}/index.html`)
            : this.webContents.loadFile(path.join(getElectronAppBasePath(), "frontend", "index.html"));
        void loadPromise.catch((error) => {
            console.log("workspace frontend load failed", this.waveWindowId, error);
        });
        this.webContents.on("destroyed", () => {
            removeWorkspaceViewInstance(this, false);
            this.isDestroyed = true;
        });
    }

    updateWorkspace(clientId: string, workspaceId: string) {
        this.resetWorkspaceReady();
        this.workspaceId = workspaceId;
        this.initOpts = {
            clientId,
            windowId: this.waveWindowId,
            workspaceId,
            generation: this.initOpts.generation + 1,
        };
    }

    resetWorkspaceReady() {
        this.workspaceReadyPromise = new Promise((resolve) => {
            this.workspaceReadyResolve = resolve;
        });
    }

    destroy() {
        removeWorkspaceViewInstance(this, false);
        if (!this.isDestroyed) {
            this.webContents.close();
        }
        this.isDestroyed = true;
    }
}

export function getOrCreateWorkspaceView<T extends WorkspaceViewHandle>(
    windowId: string,
    options: WorkspaceViewOptions & { createView: () => T }
): T;
export function getOrCreateWorkspaceView(
    windowId: string,
    options: WorkspaceViewOptions & { createView?: undefined }
): WorkspaceView;
export function getOrCreateWorkspaceView(windowId: string, options: WorkspaceViewOptions): WorkspaceViewHandle {
    const existing = workspaceViewsByWindowId.get(windowId);
    if (existing) {
        return existing;
    }
    const view = options.createView?.() ?? new WorkspaceView(options.init, options.fullConfig);
    workspaceViewsByWindowId.set(windowId, view);
    workspaceViewsByWebContentsId.set(view.webContents.id, view);
    workspaceWebContentsIdsByView.set(view, view.webContents.id);
    return view;
}

export function getWorkspaceViewByWebContentsId(webContentsId: number): WorkspaceViewHandle | undefined {
    return workspaceViewsByWebContentsId.get(webContentsId);
}

export function positionWorkspaceView(view: WorkspaceViewHandle, bounds: Rectangle) {
    view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
}

export function sendWorkspaceInit(view: WorkspaceViewHandle, init: WorkspaceInitOpts): boolean {
    const initKey = JSON.stringify(init);
    if (sentWorkspaceInitByView.get(view) === initKey) {
        return false;
    }
    sentWorkspaceInitByView.set(view, initKey);
    view.webContents.send("workspace-init", init);
    return true;
}

export function sendCurrentWorkspaceInit(view: WorkspaceViewHandle): boolean {
    const init = view.initOpts;
    if (!init?.clientId || !init.workspaceId || !Number.isInteger(init.generation) || init.generation <= 0) {
        return false;
    }
    return sendWorkspaceInit(view, init);
}

export function sendWorkspaceCommand(windowId: string, command: unknown): boolean {
    const view = workspaceViewsByWindowId.get(windowId);
    if (!view || view.isDestroyed || view.webContents.isDestroyed?.() || !isWorkspaceCommand(command)) {
        return false;
    }
    try {
        view.webContents.send("workspace-command", command);
        return true;
    } catch {
        return false;
    }
}

export function handleWorkspaceRendererInitStatus(
    view: WorkspaceViewHandle,
    status: "ready" | "workspace-ready" | "workspace-init-failed",
    workspaceReady?: WorkspaceReadyStatus
): boolean {
    if (status === "ready") {
        view.initResolve?.();
        return sendCurrentWorkspaceInit(view);
    }
    if (status === "workspace-ready") {
        return resolveWorkspaceReady(view, workspaceReady);
    }
    const init = view.initOpts;
    if (workspaceReady?.workspaceId !== init?.workspaceId || workspaceReady?.generation !== init?.generation) {
        return false;
    }
    const key = JSON.stringify(workspaceReady);
    const retryState = workspaceInitRetriesByView.get(view);
    const count = retryState?.key === key ? retryState.count : 0;
    if (count >= MaxWorkspaceInitRetries) {
        view.webContents.send("workspace-init-fatal", workspaceReady);
        return false;
    }
    workspaceInitRetriesByView.set(view, { key, count: count + 1 });
    sentWorkspaceInitByView.delete(view);
    return sendCurrentWorkspaceInit(view);
}

export function removeWorkspaceView(windowId: string, destroy = true) {
    const view = workspaceViewsByWindowId.get(windowId);
    if (!view) {
        return;
    }
    removeWorkspaceViewInstance(view, destroy);
}

function removeWorkspaceViewInstance(view: WorkspaceViewHandle, destroy: boolean) {
    if (workspaceViewsByWindowId.get(view.waveWindowId) === view) {
        workspaceViewsByWindowId.delete(view.waveWindowId);
    }
    const webContentsId = workspaceWebContentsIdsByView.get(view);
    if (webContentsId != null && workspaceViewsByWebContentsId.get(webContentsId) === view) {
        workspaceViewsByWebContentsId.delete(webContentsId);
    }
    workspaceWebContentsIdsByView.delete(view);
    if (destroy) {
        view.destroy();
    }
}

export function resetWorkspaceViewRegistryForTests() {
    for (const windowId of [...workspaceViewsByWindowId.keys()]) {
        removeWorkspaceView(windowId);
    }
}
