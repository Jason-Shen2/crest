// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Api, Model, ModelCatalog } from "@crest/ai";

const mocks = vi.hoisted(() => ({
    createModelCatalogService: vi.fn(),
    createPiModelCatalogSource: vi.fn(() => ({ fetchProvider: vi.fn() })),
    getModels: vi.fn(),
    getProviders: vi.fn(),
    readAIUserConfig: vi.fn(),
    storePaths: [] as string[],
}));

vi.mock("@crest/ai", () => ({
    createModelCatalogService: mocks.createModelCatalogService,
    createPiModelCatalogSource: mocks.createPiModelCatalogSource,
    getModels: mocks.getModels,
    getProviders: mocks.getProviders,
}));
vi.mock("./aiconfig/user-config", () => ({ readAIUserConfig: mocks.readAIUserConfig }));
vi.mock("./emain-platform", () => ({ getWaveDataDir: () => "/crest-data" }));
vi.mock("./emain-wavesrv", () => ({ getWaveVersion: () => ({ version: "0.14.5", buildTime: 0 }) }));
vi.mock("./model-catalog-store", () => ({
    FileModelCatalogStore: class {
        constructor(cachePath: string) {
            mocks.storePaths.push(cachePath);
        }
    },
}));

import {
    createDesktopModelCatalogLifecycle,
    initializeDesktopModelCatalog,
    stopDesktopModelCatalog,
} from "./model-catalog";

describe("desktop model catalog", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.storePaths.length = 0;
    });

    it("composes the production service from the generated registry and data directory", async () => {
        const catalog = fakeCatalog();
        const openAiModel = model("gpt-next", "openai");
        const anthropicModel = model("claude-next", "anthropic");
        mocks.getProviders.mockReturnValue(["openai", "anthropic"]);
        mocks.getModels.mockImplementation((provider: string) =>
            provider === "openai" ? [openAiModel] : [anthropicModel]
        );
        mocks.createModelCatalogService.mockReturnValue(catalog);

        await initializeDesktopModelCatalog();

        expect(mocks.storePaths).toEqual([path.join("/crest-data", "model-catalog.json")]);
        expect(mocks.createPiModelCatalogSource).toHaveBeenCalledWith({ userAgent: "Crest/0.14.5" });
        expect(mocks.createModelCatalogService).toHaveBeenCalledWith(
            expect.objectContaining({ baseline: [openAiModel, anthropicModel] })
        );
        expect(catalog.hydrate).toHaveBeenCalledOnce();
    });

    it("hydrates before IPC registration and launches the first refresh without awaiting it", async () => {
        const calls: string[] = [];
        const neverCompletes = new Promise<void>(() => undefined);
        const catalog = fakeCatalog({
            hydrate: vi.fn(async () => {
                calls.push("catalog.hydrate");
            }),
            activateProvider: vi.fn((providerId: string) => {
                calls.push(`catalog.activate:${providerId}`);
            }),
            start: vi.fn(() => {
                calls.push("catalog.start");
            }),
            refreshActive: vi.fn(() => {
                calls.push("catalog.refresh-active");
                return neverCompletes;
            }),
        });
        const lifecycle = createDesktopModelCatalogLifecycle({
            createCatalog: () => catalog,
            readUserConfig: async () => {
                calls.push("config.read");
                return {
                    status: "ok",
                    config: {
                        providers: { openai: {}, anthropic: {} },
                        default: { provider: "openai", model: "gpt-next" },
                    },
                };
            },
        });

        await lifecycle.boot(() => {
            calls.push("ipc.register");
        });

        expect(calls).toEqual([
            "catalog.hydrate",
            "ipc.register",
            "config.read",
            "catalog.activate:openai",
            "catalog.activate:anthropic",
            "catalog.start",
            "catalog.refresh-active",
        ]);
    });

    it("does not activate providers from a missing or malformed config", async () => {
        const catalog = fakeCatalog();
        const lifecycle = createDesktopModelCatalogLifecycle({
            createCatalog: () => catalog,
            readUserConfig: async () => ({ status: "malformed", error: "broken" }),
        });

        await lifecycle.boot(vi.fn());

        expect(catalog.activateProvider).not.toHaveBeenCalled();
        expect(catalog.start).toHaveBeenCalledOnce();
        expect(catalog.refreshActive).toHaveBeenCalledOnce();
    });

    it("stops the singleton catalog during shutdown", async () => {
        const catalog = await initializeDesktopModelCatalog();

        stopDesktopModelCatalog();

        expect(catalog.stop).toHaveBeenCalledOnce();
    });
});

function fakeCatalog(overrides: Partial<ModelCatalog> = {}): ModelCatalog {
    return {
        hydrate: vi.fn().mockResolvedValue(undefined),
        getModels: vi.fn(() => []),
        getModel: vi.fn(),
        getRevision: vi.fn(() => 0),
        activateProvider: vi.fn(),
        refreshProvider: vi.fn().mockResolvedValue(undefined),
        refreshActive: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(() => vi.fn()),
        start: vi.fn(),
        stop: vi.fn(),
        ...overrides,
    };
}

function model(id: string, provider: string): Model<Api> {
    return {
        id,
        name: id,
        api: "openai-responses",
        provider,
        baseUrl: "https://example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
    };
}
