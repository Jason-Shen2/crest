// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

type SenderView = {
    waveTabId?: string;
    waveWindowId?: string;
};

type SenderWindowLookup<TWindow> = {
    getWaveTabViewByWebContentsId: (webContentsId: number) => SenderView;
    getWorkspaceViewByWebContentsId: (webContentsId: number) => SenderView;
    getWaveWindowByTabId: (tabId: string) => TWindow;
    getWaveWindowById: (windowId: string) => TWindow;
};

type WorkspaceCommandRoute = {
    getWaveWindowByWebContentsId: (webContentsId: number) => { waveWindowId: string };
    sendWorkspaceCommand: (windowId: string, command: unknown) => void;
};

type WorkspaceCloseResponseRoute = {
    getWaveWindowByWebContentsId: (webContentsId: number) => {
        resolveWorkspaceClose(webContentsId: number, response: WorkspaceCloseResponse): void;
    };
};

export function resolveWaveWindowByWebContentsId<TWindow>(
    webContentsId: number,
    lookup: SenderWindowLookup<TWindow>
): TWindow {
    if (webContentsId == null) {
        return null;
    }
    const tabView = lookup.getWaveTabViewByWebContentsId(webContentsId);
    if (tabView != null) {
        return lookup.getWaveWindowByTabId(tabView.waveTabId);
    }
    const workspaceView = lookup.getWorkspaceViewByWebContentsId(webContentsId);
    if (workspaceView != null) {
        return lookup.getWaveWindowById(workspaceView.waveWindowId);
    }
    return null;
}

export function routeWorkspaceCloseResponseByWebContentsId(
    webContentsId: number,
    response: WorkspaceCloseResponse,
    route: WorkspaceCloseResponseRoute
): void {
    route.getWaveWindowByWebContentsId(webContentsId)?.resolveWorkspaceClose(webContentsId, response);
}

export function routeWorkspaceCommandByWebContentsId(
    webContentsId: number,
    command: unknown,
    route: WorkspaceCommandRoute
): void {
    const windowId = route.getWaveWindowByWebContentsId(webContentsId)?.waveWindowId;
    if (!windowId) {
        return;
    }
    route.sendWorkspaceCommand(windowId, command);
}
