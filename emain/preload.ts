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
// "agent:event" with {sessionPath, event}; we route to per-sessionPath
// callbacks the renderer registered via api.agent.subscribe().
const agentEventCallbacks = new Map<string, Set<(event: unknown) => void>>();
ipcRenderer.on("agent:event", (_event, payload: { sessionPath: string; event: unknown }) => {
    const cbs = agentEventCallbacks.get(payload.sessionPath);
    if (!cbs) return;
    for (const cb of cbs) {
        try {
            cb(payload.event);
        } catch (e) {
            console.error("agent:event callback error", e);
        }
    }
});

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

async function invokeAgentContext<T>(channel: string, input: unknown): Promise<T> {
    const envelope = (await ipcRenderer.invoke(channel, input)) as AgentIpcEnvelope<T>;
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
    onReinjectKey: (callback) => ipcRenderer.on("reinject-key", (_event, waveEvent) => callback(waveEvent)),
    setWebviewFocus: (focused: number) => ipcRenderer.send("webview-focus", focused),
    registerGlobalWebviewKeys: (keys) => ipcRenderer.send("register-global-webview-keys", keys),
    onControlShiftStateUpdate: (callback) =>
        ipcRenderer.on("control-shift-state-update", (_event, state) => callback(state)),
    createWorkspace: (dir: string) => ipcRenderer.send("create-workspace", dir),
    selectDirectory: () => ipcRenderer.invoke("select-directory"),
    switchWorkspace: (workspaceId) => ipcRenderer.send("switch-workspace", workspaceId),
    deleteWorkspace: (workspaceId) => ipcRenderer.send("delete-workspace", workspaceId),
    setActiveTab: (tabId) => ipcRenderer.send("set-active-tab", tabId),
    createTab: () => ipcRenderer.send("create-tab"),
    closeTab: (workspaceId, tabId, confirmClose) => ipcRenderer.invoke("close-tab", workspaceId, tabId, confirmClose),
    setWindowInitStatus: (status) => ipcRenderer.send("set-window-init-status", status),
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
        createSession: (cwd: string) => ipcRenderer.invoke("agent:create-session", cwd),
        listSessionsForCwd: (cwd: string) => ipcRenderer.invoke("agent:list-sessions-for-cwd", cwd),
        listSessionDetailsForCwd: (cwd: string, limit?: number) =>
            ipcRenderer.invoke("agent:list-session-details-for-cwd", cwd, limit),
        listAllSessionDetails: (limit?: number) => ipcRenderer.invoke("agent:list-all-session-details", limit),
        listCommands: () => ipcRenderer.invoke("agent:list-commands"),
        getSessionState: (sessionMetadata: unknown) => ipcRenderer.invoke("agent:get-session-state", sessionMetadata),
        listTree: (sessionMetadata: unknown) => ipcRenderer.invoke("agent:list-tree", sessionMetadata),
        listForkPoints: (sessionMetadata: unknown) => ipcRenderer.invoke("agent:list-fork-points", sessionMetadata),
        navigateTree: (input: unknown) => ipcRenderer.invoke("agent:navigate-tree", input),
        forkSession: (input: unknown) => ipcRenderer.invoke("agent:fork-session", input),
        cloneSession: (input: unknown) => ipcRenderer.invoke("agent:clone-session", input),
        runCommand: (input: unknown) => ipcRenderer.invoke("agent:run-command", input),
        prepareContextDraft: (input: unknown) => invokeAgentContext("agent:prepare-context-draft", input),
        summarizeContextDraft: (input: unknown) => invokeAgentContext("agent:summarize-context-draft", input),
        discardContextDraft: (input: unknown) => invokeAgentContext("agent:discard-context-draft", input),
        listReferencePoints: (input: unknown) => invokeAgentContext("agent:list-reference-points", input),
        listContextState: (input: unknown) => invokeAgentContext("agent:list-context-state", input),
        send: (opts: unknown) => invokeAgentContext("agent:send", opts),
        abort: (sessionPath: string) => ipcRenderer.send("agent:abort", sessionPath),
        subscribe: (sessionPath: string, callback: (event: unknown) => void): (() => void) => {
            let entry = agentEventCallbacks.get(sessionPath);
            const isNew = !entry;
            if (!entry) {
                entry = new Set();
                agentEventCallbacks.set(sessionPath, entry);
            }
            entry.add(callback);
            if (isNew) {
                ipcRenderer.send("agent:subscribe", sessionPath);
            }
            return () => {
                const cur = agentEventCallbacks.get(sessionPath);
                if (!cur) return;
                cur.delete(callback);
                if (cur.size === 0) {
                    agentEventCallbacks.delete(sessionPath);
                    ipcRenderer.send("agent:unsubscribe", sessionPath);
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
