// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { contextBridge, ipcRenderer, Rectangle, webUtils, WebviewTag } from "electron";

// Single shared dispatcher for directory-watch events (main fans them out here).
const dirWatchCallbacks = new Map<string, Set<(eventType: string, filename: string) => void>>();
ipcRenderer.on("dir-changed", (_event, path: string, eventType: string, filename: string) => {
    const cbs = dirWatchCallbacks.get(path);
    if (!cbs) return;
    for (const cb of cbs) {
        try {
            cb(eventType, filename);
        } catch (e) {
            console.error("dir-changed callback error", e);
        }
    }
});

// Agent event fan-out — mirrors the dir-watch pattern. Main emits
// "agent:event" with {workspaceId, generation, sessionPath, event}; route by
// Workspace identity as well as path so a renderer generation cannot consume
// stale subscription events.
const agentEventCallbacks = new Map<string, Set<(event: unknown) => void>>();
function getAgentCallbackKey(context: unknown, sessionPath: string): string {
    const identity = context as { workspaceId?: unknown; generation?: unknown };
    return JSON.stringify([identity.workspaceId, identity.generation, sessionPath]);
}
ipcRenderer.on(
    "agent:event",
    (_event, payload: { workspaceId: string; generation: number; sessionPath: string; event: unknown }) => {
        const cbs = agentEventCallbacks.get(getAgentCallbackKey(payload, payload.sessionPath));
        if (!cbs) return;
        for (const cb of cbs) {
            try {
                cb(payload.event);
            } catch (e) {
                console.error("agent:event callback error", e);
            }
        }
    }
);

const agentObservabilityCallbacks = new Map<string, Set<(event: unknown) => void>>();
ipcRenderer.on(
    "agent-observability:event",
    (_event, payload: { sessionId?: string; traceId: string; detail: unknown }) => {
        if (!payload.sessionId) return;
        const cbs = agentObservabilityCallbacks.get(payload.sessionId);
        if (!cbs) return;
        for (const cb of cbs) {
            try {
                cb(payload);
            } catch (e) {
                console.error("agent-observability:event callback error", e);
            }
        }
    }
);
type AgentIpcEnvelope<T> =
    | { ok: true; value: T }
    | {
          ok: false;
          error:
              | { kind: "context"; code: string; message: string; budget?: unknown }
              | { kind: "generic"; message: string };
      };

async function invokeAgentContext<T>(channel: string, context: unknown, input: unknown): Promise<T> {
    const envelope = (await ipcRenderer.invoke(channel, context, input)) as AgentIpcEnvelope<T>;
    if (envelope?.ok === true) return envelope.value;
    if (envelope?.ok === false) {
        const error = new Error(envelope.error.message);
        if (envelope.error.kind === "generic") throw error;
        error.name = "ContextReferenceError";
        Object.assign(error, {
            code: envelope.error.code,
            ...(envelope.error.budget == null ? {} : { budget: envelope.error.budget }),
        });
        throw error;
    }
    throw new Error(`Invalid context IPC response from ${channel}`);
}

// update type in custom.d.ts (ElectronApi type)
contextBridge.exposeInMainWorld("waveRuntime", {
    lspWebSocketUrl: process.env.CREST_LSP_WEBSOCKET_URL ?? "",
});

contextBridge.exposeInMainWorld("api", {
    getAuthKey: () => ipcRenderer.sendSync("get-auth-key"),
    getIsDev: () => ipcRenderer.sendSync("get-is-dev"),
    getPlatform: () => ipcRenderer.sendSync("get-platform"),
    getCursorPoint: () => ipcRenderer.sendSync("get-cursor-point"),
    getUserName: () => ipcRenderer.sendSync("get-user-name"),
    getHostName: () => ipcRenderer.sendSync("get-host-name"),
    getDataDir: () => ipcRenderer.sendSync("get-data-dir"),
    getConfigDir: () => ipcRenderer.sendSync("get-config-dir"),
    getHomeDir: () => ipcRenderer.sendSync("get-home-dir"),
    getAboutModalDetails: () => ipcRenderer.sendSync("get-about-modal-details"),
    getWebviewPreload: () => ipcRenderer.sendSync("get-webview-preload"),
    getZoomFactor: () => ipcRenderer.sendSync("get-zoom-factor"),
    getIsFullScreen: () => ipcRenderer.sendSync("get-is-full-screen"),
    openNewWindow: () => ipcRenderer.send("open-new-window"),
    showWorkspaceAppMenu: (workspaceId) => ipcRenderer.send("workspace-appmenu-show", workspaceId),
    showBuilderAppMenu: (builderId) => ipcRenderer.send("builder-appmenu-show", builderId),
    showContextMenu: (workspaceId, menu, position) => ipcRenderer.send("contextmenu-show", workspaceId, menu, position),
    onContextMenuClick: (callback: (id: string | null) => void) =>
        ipcRenderer.on("contextmenu-click", (_event, id: string | null) => callback(id)),
    downloadFile: (filePath) => ipcRenderer.send("download", { filePath }),
    openExternal: (url) => {
        if (url && typeof url === "string") {
            ipcRenderer.send("open-external", url);
        } else {
            console.error("Invalid URL passed to openExternal:", url);
        }
    },
    getEnv: (varName) => ipcRenderer.sendSync("get-env", varName),
    onFullScreenChange: (callback) =>
        ipcRenderer.on("fullscreen-change", (_event, isFullScreen) => callback(isFullScreen)),
    onZoomFactorChange: (callback) =>
        ipcRenderer.on("zoom-factor-change", (_event, zoomFactor) => callback(zoomFactor)),
    onUpdaterStatusChange: (callback) => ipcRenderer.on("app-update-status", (_event, status) => callback(status)),
    getUpdaterStatus: () => ipcRenderer.sendSync("get-app-update-status"),
    getUpdaterChannel: () => ipcRenderer.sendSync("get-updater-channel"),
    installAppUpdate: () => ipcRenderer.send("install-app-update"),
    onMenuItemAbout: (callback) => ipcRenderer.on("menu-item-about", callback),
    updateWindowControlsOverlay: (rect) => ipcRenderer.send("update-window-controls-overlay", rect),
    onReinjectKey: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, waveEvent: WaveKeyboardEvent) => callback(waveEvent);
        ipcRenderer.on("reinject-key", listener);
        return () => ipcRenderer.removeListener("reinject-key", listener);
    },
    setWebviewFocus: (focused: number) => ipcRenderer.send("webview-focus", focused),
    registerGlobalWebviewKeys: (keys) => ipcRenderer.send("register-global-webview-keys", keys),
    onControlShiftStateUpdate: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, state: boolean) => callback(state);
        ipcRenderer.on("control-shift-state-update", listener);
        return () => ipcRenderer.removeListener("control-shift-state-update", listener);
    },
    createWorkspace: (dir: string) => ipcRenderer.send("create-workspace", dir),
    selectDirectory: () => ipcRenderer.invoke("select-directory"),
    selectFile: () => ipcRenderer.invoke("select-file"),
    switchWorkspace: (workspaceId) => ipcRenderer.send("switch-workspace", workspaceId),
    deleteWorkspace: (workspaceId) => ipcRenderer.send("delete-workspace", workspaceId),
    setWindowInitStatus: (status, workspaceReady) => ipcRenderer.send("set-window-init-status", status, workspaceReady),
    onWorkspaceInit: (callback) => ipcRenderer.on("workspace-init", (_event, initOpts) => callback(initOpts)),
    onWorkspaceInitFatal: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, status: WorkspaceReadyStatus) => callback(status);
        ipcRenderer.on("workspace-init-fatal", listener);
        return () => ipcRenderer.removeListener("workspace-init-fatal", listener);
    },
    sendWorkspaceCommand: (command) => ipcRenderer.send("workspace-command", command),
    setWorkspaceSurface: (surface) => ipcRenderer.send("workspace-surface", surface),
    onTerminalSurfaceStatus: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, status: TerminalSurfaceStatus) => callback(status);
        ipcRenderer.on("terminal-surface-status", listener);
        return () => ipcRenderer.removeListener("terminal-surface-status", listener);
    },
    onWorkspaceCommand: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, command: WorkspaceCommand) => callback(command);
        ipcRenderer.on("workspace-command", listener);
        return () => ipcRenderer.removeListener("workspace-command", listener);
    },
    onWorkspaceCloseRequest: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, request: WorkspaceCloseRequest) => callback(request);
        ipcRenderer.on("workspace-close-request", listener);
        return () => ipcRenderer.removeListener("workspace-close-request", listener);
    },
    respondWorkspaceClose: (response) => ipcRenderer.send("workspace-close-response", response),
    onWorkspaceCloseFinalize: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, finalize: WorkspaceCloseFinalize) => callback(finalize);
        ipcRenderer.on("workspace-close-finalize", listener);
        return () => ipcRenderer.removeListener("workspace-close-finalize", listener);
    },
    onWaveInit: (callback) => ipcRenderer.on("wave-init", (_event, initOpts) => callback(initOpts)),
    onBuilderInit: (callback) => ipcRenderer.on("builder-init", (_event, initOpts) => callback(initOpts)),
    sendLog: (log) => ipcRenderer.send("fe-log", log),
    onQuicklook: (filePath: string) => ipcRenderer.send("quicklook", filePath),
    openNativePath: (filePath: string) => ipcRenderer.send("open-native-path", filePath),
    captureScreenshot: (rect: Rectangle) => ipcRenderer.invoke("capture-screenshot", rect),
    setKeyboardChordMode: () => ipcRenderer.send("set-keyboard-chord-mode"),
    clearWebviewStorage: (webContentsId: number) => ipcRenderer.invoke("clear-webview-storage", webContentsId),
    setWaveAIOpen: (isOpen: boolean) => ipcRenderer.send("set-waveai-open", isOpen),
    closeBuilderWindow: () => ipcRenderer.send("close-builder-window"),
    incrementTermCommands: (opts?: { isRemote?: boolean; isWsl?: boolean; isDurable?: boolean }) =>
        ipcRenderer.send("increment-term-commands", opts),
    nativePaste: () => ipcRenderer.send("native-paste"),
    openBuilder: (appId?: string) => ipcRenderer.send("open-builder", appId),
    setBuilderWindowAppId: (appId: string) => ipcRenderer.send("set-builder-window-appid", appId),
    doRefresh: () => ipcRenderer.send("do-refresh"),
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
    saveTextFile: (fileName: string, content: string) => ipcRenderer.invoke("save-text-file", fileName, content),
    setIsActive: () => ipcRenderer.invoke("set-is-active"),
    watchDir: (path: string, callback: (eventType: string, filename: string) => void): void => {
        // Register (or fan-out) a per-path callback. Main process de-duplicates at its end;
        // we track callbacks per path so unwatchDir only removes the intended listener.
        let entry = dirWatchCallbacks.get(path);
        if (!entry) {
            entry = new Set();
            dirWatchCallbacks.set(path, entry);
        }
        entry.add(callback);
        ipcRenderer.send("watch-dir", path);
    },
    unwatchDir: (path: string, callback?: (eventType: string, filename: string) => void): void => {
        const entry = dirWatchCallbacks.get(path);
        if (entry) {
            if (callback) {
                entry.delete(callback);
            } else {
                entry.clear();
            }
            if (entry.size === 0) {
                dirWatchCallbacks.delete(path);
                ipcRenderer.send("unwatch-dir", path);
            }
        } else {
            ipcRenderer.send("unwatch-dir", path);
        }
    },
    // ─── AI config / provider listing ────────────────────────────────
    // See emain/aiconfig-ipc.ts. Replaces the Go ListProviderModelsCommand.
    ai: {
        listProviderModels: (input: unknown) => ipcRenderer.invoke("ai:list-provider-models", input),
        listRegistryModels: (provider: string) => ipcRenderer.invoke("ai:list-registry-models", provider),
        getUserConfig: () => ipcRenderer.invoke("ai:get-user-config"),
        writeUserConfig: (cfg: unknown) => ipcRenderer.invoke("ai:write-user-config", cfg),
    },
    // ─── Agent runtime (Electron main agent loop) ────────────────────
    // See docs/agent-runtime-architecture.md §2 + emain/agent-ipc.ts.
    agent: {
        createSession: (context: unknown) => ipcRenderer.invoke("agent:create-session", context),
        listSessions: (context: unknown) => ipcRenderer.invoke("agent:list-sessions", context),
        listSessionDetails: (context: unknown, limit?: number) =>
            ipcRenderer.invoke("agent:list-session-details", context, limit),
        listCommands: (context: unknown) => ipcRenderer.invoke("agent:list-commands", context),
        getSessionState: (context: unknown, sessionMetadata: unknown) =>
            ipcRenderer.invoke("agent:get-session-state", context, sessionMetadata),
        inspectContext: (context: unknown, options: unknown) =>
            ipcRenderer.invoke("agent:inspect-context", context, options),
        listTree: (context: unknown, sessionMetadata: unknown) =>
            ipcRenderer.invoke("agent:list-tree", context, sessionMetadata),
        listForkPoints: (context: unknown, sessionMetadata: unknown) =>
            ipcRenderer.invoke("agent:list-fork-points", context, sessionMetadata),
        navigateTree: (context: unknown, input: unknown) => ipcRenderer.invoke("agent:navigate-tree", context, input),
        forkSession: (context: unknown, input: unknown) => ipcRenderer.invoke("agent:fork-session", context, input),
        cloneSession: (context: unknown, input: unknown) => ipcRenderer.invoke("agent:clone-session", context, input),
        runCommand: (context: unknown, input: unknown) => ipcRenderer.invoke("agent:run-command", context, input),
        commandRead: (context: unknown, sessionMetadata: unknown, input: unknown) =>
            ipcRenderer.invoke("agent:command-read", context, sessionMetadata, input),
        commandWrite: (context: unknown, sessionMetadata: unknown, input: unknown) =>
            ipcRenderer.invoke("agent:command-write", context, sessionMetadata, input),
        commandResize: (context: unknown, sessionMetadata: unknown, input: unknown) =>
            ipcRenderer.invoke("agent:command-resize", context, sessionMetadata, input),
        commandStop: (context: unknown, sessionMetadata: unknown, input: unknown) =>
            ipcRenderer.invoke("agent:command-stop", context, sessionMetadata, input),
        renameSession: (context: unknown, input: unknown) => ipcRenderer.invoke("agent:rename-session", context, input),
        archiveSession: (context: unknown, sessionMetadata: unknown) =>
            ipcRenderer.invoke("agent:archive-session", context, sessionMetadata),
        deleteSession: (context: unknown, sessionMetadata: unknown) =>
            ipcRenderer.invoke("agent:delete-session", context, sessionMetadata),
        prepareContextDraft: (context: unknown, input: unknown) =>
            invokeAgentContext("agent:prepare-context-draft", context, input),
        summarizeContextDraft: (context: unknown, input: unknown) =>
            invokeAgentContext("agent:summarize-context-draft", context, input),
        discardContextDraft: (context: unknown, input: unknown) =>
            invokeAgentContext("agent:discard-context-draft", context, input),
        listReferencePoints: (context: unknown, input: unknown) =>
            invokeAgentContext("agent:list-reference-points", context, input),
        listContextState: (context: unknown, input: unknown) =>
            invokeAgentContext("agent:list-context-state", context, input),
        send: (context: unknown, opts: unknown) => invokeAgentContext("agent:send", context, opts),
        abort: (context: unknown, sessionPath: string) => ipcRenderer.invoke("agent:abort", context, sessionPath),
        subscribe: (context: unknown, sessionPath: string, callback: (event: unknown) => void): (() => void) => {
            const key = getAgentCallbackKey(context, sessionPath);
            let entry = agentEventCallbacks.get(key);
            const isNew = !entry;
            if (!entry) {
                entry = new Set();
                agentEventCallbacks.set(key, entry);
            }
            entry.add(callback);
            if (isNew) {
                void ipcRenderer
                    .invoke("agent:subscribe", context, sessionPath)
                    .catch((err) => console.error("agent:subscribe failed", err));
            }
            return () => {
                const cur = agentEventCallbacks.get(key);
                if (!cur) return;
                cur.delete(callback);
                if (cur.size === 0) {
                    agentEventCallbacks.delete(key);
                    void ipcRenderer
                        .invoke("agent:unsubscribe", context, sessionPath)
                        .catch((err) => console.error("agent:unsubscribe failed", err));
                }
            };
        },
    },
    agentObservability: {
        listTraces: (sessionId: string) => ipcRenderer.invoke("agent-observability:list-traces", sessionId),
        getTrace: (traceId: string, sessionId: string) =>
            ipcRenderer.invoke("agent-observability:get-trace", traceId, sessionId),
        subscribe: (sessionId: string, callback: (event: unknown) => void): (() => void) => {
            let entry = agentObservabilityCallbacks.get(sessionId);
            const isNew = !entry;
            if (!entry) {
                entry = new Set();
                agentObservabilityCallbacks.set(sessionId, entry);
            }
            entry.add(callback);
            if (isNew) {
                ipcRenderer.send("agent-observability:subscribe", sessionId);
            }
            return () => {
                const cur = agentObservabilityCallbacks.get(sessionId);
                if (!cur) return;
                cur.delete(callback);
                if (cur.size === 0) {
                    agentObservabilityCallbacks.delete(sessionId);
                    ipcRenderer.send("agent-observability:unsubscribe", sessionId);
                }
            };
        },
    },
});

// Custom event for "new-window"
ipcRenderer.on("webview-new-window", (e, webContentsId, details) => {
    const event = new CustomEvent("new-window", { detail: details });
    document.getElementById("webview").dispatchEvent(event);
});

ipcRenderer.on("webcontentsid-from-blockid", (e, blockId, responseCh) => {
    const webviewElem: WebviewTag = document.querySelector("div[data-blockid='" + blockId + "'] webview");
    const wcId = webviewElem?.dataset?.webcontentsid;
    ipcRenderer.send(responseCh, wcId);
});
