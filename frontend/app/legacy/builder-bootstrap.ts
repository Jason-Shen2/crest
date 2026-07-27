// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import "../../renderer-styles";
import { loadMonaco } from "@/app/monaco/monaco-env";
import { initAIUserConfig } from "@/app/store/ai-user-config";
import { GlobalModel } from "@/app/store/global-model";
import { registerBuilderGlobalKeys, registerElectronReinjectKeyHandler } from "@/app/store/keymodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { makeBuilderRouteId } from "@/app/store/wshrouter";
import { initWshrpc, TabRpcClient } from "@/app/store/wshrpcutil";
import { ThemeModel } from "@/app/theme/theme-model";
import { BuilderApp } from "@/builder/builder-app";
import { atoms, getApi, globalStore, initGlobal, loadConnStatus } from "@/store/global";
import * as WOS from "@/store/wos";
import { loadFonts } from "@/util/fontutil";
import { setKeyUtilPlatform } from "@/util/keyutil";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

const Platform = getApi().getPlatform();
let runtimePrepared = false;

function prepareBuilderRuntime(): void {
    if (runtimePrepared) {
        return;
    }
    runtimePrepared = true;
    setKeyUtilPlatform(Platform);
    loadFonts();
}

export async function initializeBuilderRenderer(initOpts: BuilderInitOpts): Promise<void> {
    prepareBuilderRuntime();
    try {
        const globalInitOpts: GlobalInitOptions = {
            clientId: initOpts.clientId,
            windowId: initOpts.windowId,
            platform: Platform,
            environment: "renderer",
            rendererKind: "builder",
            builderId: initOpts.builderId,
        };
        await GlobalModel.getInstance().initialize(globalInitOpts);
        initGlobal(globalInitOpts);
        (window as any).globalAtoms = atoms;
        const globalWS = initWshrpc(makeBuilderRouteId(initOpts.builderId));
        (window as any).globalWS = globalWS;
        (window as any).TabRpcClient = TabRpcClient;
        await loadConnStatus();

        let appId: string = null;
        try {
            const rtInfo = await RpcApi.GetRTInfoCommand(TabRpcClient, {
                oref: WOS.makeORef("builder", initOpts.builderId),
            });
            appId = rtInfo?.["builder:appid"] ?? null;
        } catch (error) {
            console.log("Could not load saved builder appId from rtinfo:", error);
        }
        document.title = appId ? `WaveApp Builder (${appId})` : "WaveApp Builder";
        globalStore.set(atoms.builderAppId, appId);
        await WOS.loadAndPinWaveObject(WOS.makeORef("client", initOpts.clientId));
        registerBuilderGlobalKeys();
        registerElectronReinjectKeyHandler();
        await loadMonaco();
        globalStore.set(atoms.fullConfigAtom, await RpcApi.GetFullConfigCommand(TabRpcClient));
        initAIUserConfig();
        ThemeModel.getInstance().initialize();

        let firstRenderResolve: () => void = null;
        const firstRender = new Promise<void>((resolve) => {
            firstRenderResolve = resolve;
        });
        createRoot(document.getElementById("main")).render(
            createElement(BuilderApp, { initOpts, onFirstRender: firstRenderResolve })
        );
        await firstRender;
    } catch (error) {
        getApi().sendLog(`Error in initializeBuilderRenderer ${error.message}\n${error.stack}`);
        console.error("Error in initializeBuilderRenderer", error);
    } finally {
        document.body.style.visibility = null;
        document.body.style.opacity = null;
        document.body.classList.remove("is-transparent");
    }
}
