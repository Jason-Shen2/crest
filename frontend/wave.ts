// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import "./renderer-styles";
import { GlobalModel } from "@/app/store/global-model";
import { WshClient } from "@/app/store/wshclient";
import { RpcApi } from "@/app/store/wshclientapi";
import { makeWorkspaceRouteId } from "@/app/store/wshrouter";
import { initWshrpc, shutdownRendererWshrpc, TabRpcClient } from "@/app/store/wshrpcutil";
import { ThemeModel } from "@/app/theme/theme-model";
import { WorkspaceApp } from "@/app/workspace/workspace-app";
import { WorkspaceInitCoordinator } from "@/app/workspace/workspace-init-coordinator";
import { WorkspaceModel } from "@/app/workspace/workspace-model";
import { workspaceModelOptionsFromLoadedWorkspace } from "@/app/workspace/workspace-model-init";
import { WorkspaceObjectSubscription } from "@/app/workspace/workspace-object-subscription";
import { teardownWorkspaceRenderer as runWorkspaceRendererTeardown } from "@/app/workspace/workspace-renderer-lifecycle";
import { countersClear, countersPrint } from "@/store/counters";
import { atoms, getApi, globalStore, initGlobal, loadConnStatus } from "@/store/global";
import * as WOS from "@/store/wos";
import { loadFonts } from "@/util/fontutil";
import { setKeyUtilPlatform } from "@/util/keyutil";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const Platform = getApi().getPlatform();
const WorkspaceInit = new WorkspaceInitCoordinator();
const WorkspaceSubscription = new WorkspaceObjectSubscription();
let workspaceRoot: Root = null;
let activeWorkspaceModel: WorkspaceModel = null;
let workspaceLifecycleRegistered = false;

function exposeWorkspaceRuntime(): void {
    (window as any).WOS = WOS;
    (window as any).globalStore = globalStore;
    (window as any).globalAtoms = atoms;
    (window as any).RpcApi = RpcApi;
    (window as any).isFullScreen = false;
    (window as any).countersPrint = countersPrint;
    (window as any).countersClear = countersClear;
}

function registerWorkspaceLifecycle(): void {
    if (workspaceLifecycleRegistered) {
        return;
    }
    workspaceLifecycleRegistered = true;
    window.addEventListener("beforeunload", () => {
        runWorkspaceRendererTeardown({
            flush: () => activeWorkspaceModel?.flush() ?? Promise.resolve(),
            clearSubscriptions: () => WorkspaceSubscription.clear(),
            shutdownWshrpc: shutdownRendererWshrpc,
        });
    });
}

export function initializeWorkspaceRenderer(initOpts: WorkspaceInitOpts): void {
    exposeWorkspaceRuntime();
    registerWorkspaceLifecycle();
    setKeyUtilPlatform(Platform);
    loadFonts();
    const identity = { workspaceId: initOpts.workspaceId, generation: initOpts.generation };
    void WorkspaceInit.run(identity, async (isCurrent) => {
        try {
            await initializeCurrentWorkspace(initOpts, isCurrent);
        } catch (error) {
            if (isCurrent()) {
                WorkspaceSubscription.clear();
                getApi().setWindowInitStatus("workspace-init-failed", identity);
                getApi().sendLog(`Error in initializeWorkspaceRenderer ${error.message}\n${error.stack}`);
                console.error("Error in initializeWorkspaceRenderer", error);
            }
        } finally {
            if (isCurrent()) {
                document.body.style.visibility = null;
                document.body.style.opacity = null;
                document.body.classList.remove("is-transparent");
            }
        }
    });
}

async function initializeCurrentWorkspace(initOpts: WorkspaceInitOpts, isCurrent: () => boolean): Promise<void> {
    if (!isCurrent()) {
        return;
    }
    WorkspaceSubscription.clear();
    const globalInitOpts: GlobalInitOptions = {
        clientId: initOpts.clientId,
        windowId: initOpts.windowId,
        workspaceId: initOpts.workspaceId,
        generation: initOpts.generation,
        platform: Platform,
        environment: "renderer",
        rendererKind: "workspace",
    };
    await GlobalModel.getInstance().initialize(globalInitOpts);
    if (!isCurrent()) {
        return;
    }
    initGlobal(globalInitOpts);
    (window as any).globalAtoms = atoms;

    const globalWS = initWshrpc(makeWorkspaceRouteId(initOpts.workspaceId), (routeId) => new WshClient(routeId));
    (window as any).globalWS = globalWS;
    (window as any).TabRpcClient = TabRpcClient;
    await loadConnStatus();
    if (!isCurrent()) {
        return;
    }
    const [_client, _waveWindow, workspace] = await Promise.all([
        WOS.loadAndPinWaveObject(WOS.makeORef("client", initOpts.clientId)),
        WOS.loadAndPinWaveObject<WaveWindow>(WOS.makeORef("window", initOpts.windowId)),
        WOS.loadAndPinWaveObject<Workspace>(WOS.makeORef("workspace", initOpts.workspaceId)),
    ]);
    if (!isCurrent()) {
        return;
    }
    WorkspaceSubscription.replace(WOS.wpsSubscribeToObject(WOS.makeORef("workspace", initOpts.workspaceId)));
    activeWorkspaceModel = await WorkspaceModel.replaceInstance(
        workspaceModelOptionsFromLoadedWorkspace(initOpts.windowId, workspace, initOpts.generation)
    );
    if (!isCurrent()) {
        return;
    }

    const fullConfig = await RpcApi.GetFullConfigCommand(TabRpcClient);
    if (!isCurrent()) {
        return;
    }
    globalStore.set(atoms.fullConfigAtom, fullConfig);
    ThemeModel.getInstance().initialize();
    document.title = workspace.name ? `Wave Terminal - ${workspace.name}` : "Wave Terminal";

    let firstRenderResolve: () => void = null;
    const firstRender = new Promise<void>((resolve) => {
        firstRenderResolve = resolve;
    });
    workspaceRoot ??= createRoot(document.getElementById("main"));
    workspaceRoot.render(
        createElement(WorkspaceApp, {
            key: `${workspace.oid}:${initOpts.generation}`,
            init: { windowId: initOpts.windowId, generation: initOpts.generation, workspace },
            onFirstRender: firstRenderResolve,
        })
    );
    await firstRender;
    if (!isCurrent()) {
        return;
    }
    getApi().setWindowInitStatus("workspace-ready", {
        workspaceId: initOpts.workspaceId,
        generation: initOpts.generation,
    });
}
