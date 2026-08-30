// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
    createModelCatalogService,
    createPiModelCatalogSource,
    getModels,
    getProviders,
    type Api,
    type Model,
    type ModelCatalog,
} from "@crest/ai";

import { readAIUserConfig, type AIUserConfigReadResult } from "./aiconfig/user-config";
import { getWaveDataDir } from "./emain-platform";
import { getWaveVersion } from "./emain-wavesrv";
import { FileModelCatalogStore } from "./model-catalog-store";

interface DesktopModelCatalogUserConfig {
    providers?: Record<string, unknown>;
}

export interface DesktopModelCatalogLifecycleDependencies {
    createCatalog(): ModelCatalog;
    readUserConfig(): Promise<AIUserConfigReadResult>;
}

export interface DesktopModelCatalogLifecycle {
    initialize(): Promise<ModelCatalog>;
    boot(registerIpc: (catalog: ModelCatalog) => void): Promise<ModelCatalog>;
    start(userConfig?: DesktopModelCatalogUserConfig): void;
    stop(): void;
}

export function createDesktopModelCatalogLifecycle(
    dependencies: DesktopModelCatalogLifecycleDependencies
): DesktopModelCatalogLifecycle {
    let catalog: ModelCatalog | undefined;
    let initializing: Promise<ModelCatalog> | undefined;

    async function initialize(): Promise<ModelCatalog> {
        if (catalog) return catalog;
        if (initializing) return initializing;
        initializing = (async () => {
            const created = dependencies.createCatalog();
            await created.hydrate();
            catalog = created;
            return created;
        })();
        try {
            return await initializing;
        } finally {
            initializing = undefined;
        }
    }

    function start(userConfig?: DesktopModelCatalogUserConfig): void {
        if (!catalog) throw new Error("desktop model catalog has not been initialized");
        for (const providerId of Object.keys(userConfig?.providers ?? {})) {
            catalog.activateProvider(providerId);
        }
        catalog.start();
        void catalog.refreshActive().catch((error) => {
            console.log("desktop model catalog: initial refresh failed", error);
        });
    }

    return {
        initialize,
        async boot(registerIpc) {
            const initialized = await initialize();
            registerIpc(initialized);
            const result = await dependencies.readUserConfig();
            start(result.status === "ok" ? result.config : undefined);
            return initialized;
        },
        start,
        stop() {
            catalog?.stop();
        },
    };
}

function createDesktopModelCatalog(): ModelCatalog {
    const baseline = getProviders().flatMap((provider) => getModels(provider as never) as Model<Api>[]);
    return createModelCatalogService({
        baseline,
        source: createPiModelCatalogSource({ userAgent: `Crest/${getWaveVersion().version}` }),
        store: new FileModelCatalogStore(path.join(getWaveDataDir(), "model-catalog.json")),
    });
}

const desktopModelCatalogLifecycle = createDesktopModelCatalogLifecycle({
    createCatalog: createDesktopModelCatalog,
    readUserConfig: readAIUserConfig,
});

export function initializeDesktopModelCatalog(): Promise<ModelCatalog> {
    return desktopModelCatalogLifecycle.initialize();
}

export function bootDesktopModelCatalog(registerIpc: (catalog: ModelCatalog) => void): Promise<ModelCatalog> {
    return desktopModelCatalogLifecycle.boot(registerIpc);
}

export function startDesktopModelCatalog(userConfig?: DesktopModelCatalogUserConfig): void {
    desktopModelCatalogLifecycle.start(userConfig);
}

export function stopDesktopModelCatalog(): void {
    desktopModelCatalogLifecycle.stop();
}
