// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import "../../renderer-styles";
import { registerTerminalBlockViewModels } from "@/app/block/terminal-blockregistry";
import { loadBadges } from "@/app/store/badge";
import { GlobalModel } from "@/app/store/global-model";
import { activeTabIdAtom } from "@/app/store/tab-model";
import { RpcApi } from "@/app/store/wshclientapi";
import { makeTabRouteId } from "@/app/store/wshrouter";
import { initWshrpc, shutdownRendererWshrpc, TabRpcClient } from "@/app/store/wshrpcutil";
import { getPtyScreenSnapshot } from "@/app/term/terminal-model";
import { ThemeModel } from "@/app/theme/theme-model";
import { countersClear, countersPrint } from "@/store/counters";
import {
    atoms,
    getApi,
    globalStore,
    initGlobal,
    initGlobalWaveEventSubs,
    loadConnStatus,
    subscribeToConnEvents,
} from "@/store/global";
import * as WOS from "@/store/wos";
import { loadFonts } from "@/util/fontutil";
import { setKeyUtilPlatform } from "@/util/keyutil";
import { isMacOS, setMacOSVersion } from "@/util/platformutil";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TerminalApp } from "./terminal-app";

const Platform = getApi().getPlatform();
let savedInitOpts: WaveInitOpts = null;
let terminalRoot: Root = null;
let workspaceUnsubscribe: () => void = null;
let runtimePrepared = false;

function prepareTerminalRuntime(): void {
    if (runtimePrepared) {
        return;
    }
    runtimePrepared = true;
    registerTerminalBlockViewModels();
    setKeyUtilPlatform(Platform);
    loadFonts();
    (window as any).WOS = WOS;
    (window as any).globalStore = globalStore;
    (window as any).globalAtoms = atoms;
    (window as any).RpcApi = RpcApi;
    (window as any).isFullScreen = false;
    (window as any).countersPrint = countersPrint;
    (window as any).countersClear = countersClear;
    (window as any).getPtyScreenSnapshot = getPtyScreenSnapshot;
    window.addEventListener(
        "beforeunload",
        () => {
            workspaceUnsubscribe?.();
            workspaceUnsubscribe = null;
            shutdownRendererWshrpc();
        },
        { once: true }
    );
}

export async function initializeTerminalRenderer(initOpts: WaveInitOpts): Promise<void> {
    if (initOpts.rendererKind !== "terminal") {
        throw new Error("terminal bootstrap requires a Terminal renderer identity");
    }
    prepareTerminalRuntime();
    try {
        if (savedInitOpts != null) {
            await reinitializeTerminalRenderer(initOpts);
            return;
        }
        savedInitOpts = initOpts;
        await initializeTerminal(initOpts);
    } catch (error) {
        getApi().sendLog(`Error in initializeTerminalRenderer ${error.message}\n${error.stack}`);
        console.error("Error in initializeTerminalRenderer", error);
    } finally {
        document.body.style.visibility = null;
        document.body.style.opacity = null;
        document.body.classList.remove("is-transparent");
    }
}

async function reinitializeTerminalRenderer(initOpts: WaveInitOpts): Promise<void> {
    if (initOpts.tabId !== savedInitOpts.tabId) {
        throw new Error("Terminal renderer identity cannot change tabs");
    }
    await WOS.reloadWaveObject(WOS.makeORef("client", initOpts.clientId));
    const waveWindow = await WOS.reloadWaveObject<WaveWindow>(WOS.makeORef("window", initOpts.windowId));
    const workspace = await WOS.reloadWaveObject<Workspace>(WOS.makeORef("workspace", waveWindow.workspaceid));
    const tab = await WOS.reloadWaveObject<Tab>(WOS.makeORef("tab", initOpts.tabId));
    await WOS.reloadWaveObject<LayoutState>(WOS.makeORef("layout", tab.layoutstate));
    document.title = `Wave Terminal - ${tab.name}`;
    savedInitOpts = initOpts;
    globalStore.set(atoms.reinitVersion, globalStore.get(atoms.reinitVersion) + 1);
    globalStore.set(atoms.updaterStatusAtom, getApi().getUpdaterStatus());
    if (!workspace.terminaltabids?.includes(initOpts.tabId)) {
        throw new Error("Terminal renderer tab left the authoritative Terminal inventory");
    }
    getApi().setWindowInitStatus("wave-ready");
}

async function initializeTerminal(initOpts: WaveInitOpts): Promise<void> {
    const globalInitOpts: GlobalInitOptions = {
        tabId: initOpts.tabId,
        clientId: initOpts.clientId,
        windowId: initOpts.windowId,
        platform: Platform,
        environment: "renderer",
        rendererKind: "terminal",
        primaryTabStartup: initOpts.primaryTabStartup,
    };
    globalStore.set(activeTabIdAtom, initOpts.tabId);
    await GlobalModel.getInstance().initialize(globalInitOpts);
    initGlobal(globalInitOpts);
    (window as any).globalAtoms = atoms;
    const globalWS = initWshrpc(makeTabRouteId(initOpts.tabId));
    (window as any).globalWS = globalWS;
    (window as any).TabRpcClient = TabRpcClient;

    await loadConnStatus();
    await loadBadges();
    initGlobalWaveEventSubs(initOpts);
    subscribeToConnEvents();
    if (isMacOS()) {
        setMacOSVersion(await RpcApi.MacOSVersionCommand(TabRpcClient));
    }
    const [_client, waveWindow, tab] = await Promise.all([
        WOS.loadAndPinWaveObject(WOS.makeORef("client", initOpts.clientId)),
        WOS.loadAndPinWaveObject<WaveWindow>(WOS.makeORef("window", initOpts.windowId)),
        WOS.loadAndPinWaveObject<Tab>(WOS.makeORef("tab", initOpts.tabId)),
    ]);
    const [workspace] = await Promise.all([
        WOS.loadAndPinWaveObject<Workspace>(WOS.makeORef("workspace", waveWindow.workspaceid)),
        WOS.reloadWaveObject<LayoutState>(WOS.makeORef("layout", tab.layoutstate)),
    ]);
    if (!workspace.terminaltabids?.includes(initOpts.tabId)) {
        throw new Error("Terminal renderer requires authoritative Terminal membership");
    }
    workspaceUnsubscribe?.();
    workspaceUnsubscribe = WOS.wpsSubscribeToObject(WOS.makeORef("workspace", workspace.oid));
    document.title = `Wave Terminal - ${tab.name}`;
    globalStore.set(atoms.fullConfigAtom, await RpcApi.GetFullConfigCommand(TabRpcClient));
    ThemeModel.getInstance().initialize();

    let firstRenderResolve: () => void = null;
    const firstRender = new Promise<void>((resolve) => {
        firstRenderResolve = resolve;
    });
    terminalRoot ??= createRoot(document.getElementById("main"));
    terminalRoot.render(
        createElement(TerminalApp, {
            key: initOpts.tabId,
            tabId: initOpts.tabId,
            onFirstRender: firstRenderResolve,
        })
    );
    await firstRender;
    getApi().setWindowInitStatus("wave-ready");
}
