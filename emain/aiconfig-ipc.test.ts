// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelCatalog } from "@crest/ai";

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, (...args: any[]) => any>(),
    getSecret: vi.fn(),
    getAllWebContents: vi.fn(),
    listProviderModels: vi.fn(),
    listRegistryModels: vi.fn(),
}));

vi.mock("electron", () => ({
    ipcMain: {
        handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
            mocks.handlers.set(channel, handler);
        }),
    },
    webContents: {
        getAllWebContents: mocks.getAllWebContents,
    },
}));
vi.mock("./aiconfig/list-provider-models", () => ({
    listProviderModels: mocks.listProviderModels,
    listRegistryModels: mocks.listRegistryModels,
}));
vi.mock("./aiconfig/secrets", () => ({ getSecret: mocks.getSecret }));
vi.mock("./aiconfig/user-config", () => ({
    readAIUserConfig: vi.fn(),
    writeAIUserConfig: vi.fn(),
}));

import { registerAiConfigIpcHandlers } from "./aiconfig-ipc";

describe("AI config IPC model catalog handlers", () => {
    let catalog: ModelCatalog;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.handlers.clear();
        mocks.getAllWebContents.mockReturnValue([]);
        mocks.listRegistryModels.mockReturnValue([{ id: "gpt-next" }]);
        catalog = fakeCatalog();
        registerAiConfigIpcHandlers(catalog);
    });

    it("activates and freshness-gates normal registry listing", async () => {
        const handler = mocks.handlers.get("ai:list-registry-models");

        await expect(handler?.({}, "openai")).resolves.toEqual([{ id: "gpt-next" }]);

        expect(catalog.activateProvider).toHaveBeenCalledWith("openai");
        expect(catalog.refreshProvider).toHaveBeenCalledWith("openai");
        expect(mocks.listRegistryModels).toHaveBeenCalledWith(catalog, "openai");
    });

    it("returns the last good registry snapshot when the freshness check fails", async () => {
        vi.mocked(catalog.refreshProvider).mockRejectedValueOnce(new Error("catalog unavailable"));
        const handler = mocks.handlers.get("ai:list-registry-models");

        await expect(handler?.({}, "openai")).resolves.toEqual([{ id: "gpt-next" }]);

        expect(mocks.listRegistryModels).toHaveBeenCalledWith(catalog, "openai");
    });

    it("forces refresh before returning a manually refreshed registry snapshot", async () => {
        const handler = mocks.handlers.get("ai:refresh-registry-models");

        await expect(handler?.({}, "openai")).resolves.toEqual([{ id: "gpt-next" }]);

        expect(catalog.activateProvider).toHaveBeenCalledWith("openai");
        expect(catalog.refreshProvider).toHaveBeenCalledWith("openai", { force: true });
        expect(mocks.listRegistryModels).toHaveBeenCalledWith(catalog, "openai");
    });

    it("broadcasts changed providers to live renderer web contents", () => {
        const send = vi.fn();
        mocks.getAllWebContents.mockReturnValue([
            { isDestroyed: () => false, send },
            { isDestroyed: () => true, send: vi.fn() },
        ]);
        const listener = vi.mocked(catalog.subscribe).mock.calls[0]?.[0];

        listener?.("openai");

        expect(send).toHaveBeenCalledWith("ai:registry-models-refreshed", "openai");
    });

    it("continues broadcasting when one renderer closes during delivery", () => {
        const send = vi.fn();
        mocks.getAllWebContents.mockReturnValue([
            {
                isDestroyed: () => false,
                send: () => {
                    throw new Error("renderer closed");
                },
            },
            { isDestroyed: () => false, send },
        ]);
        const listener = vi.mocked(catalog.subscribe).mock.calls[0]?.[0];

        expect(() => listener?.("openai")).not.toThrow();
        expect(send).toHaveBeenCalledWith("ai:registry-models-refreshed", "openai");
    });

    it("forwards provider discovery fields without mutating the shared catalog", async () => {
        mocks.getSecret.mockResolvedValue("resolved-token");
        mocks.listProviderModels.mockResolvedValue([{ id: "deployment-model" }]);
        const handler = mocks.handlers.get("ai:list-provider-models");

        await expect(
            handler?.(
                {},
                {
                    apitype: "anthropic-messages",
                    baseurl: "https://api.minimax.io/anthropic",
                    tokensecretname: "minimax-key",
                    modelsendpoint: "https://api.minimax.io/v1/models",
                }
            )
        ).resolves.toEqual([{ id: "deployment-model" }]);

        expect(mocks.listProviderModels).toHaveBeenCalledWith({
            apitype: "anthropic-messages",
            baseurl: "https://api.minimax.io/anthropic",
            apitoken: "resolved-token",
            tokensecretname: "minimax-key",
            modelsendpoint: "https://api.minimax.io/v1/models",
        });
        expect(catalog.activateProvider).not.toHaveBeenCalled();
        expect(catalog.refreshProvider).not.toHaveBeenCalled();
    });
});

function fakeCatalog(): ModelCatalog {
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
    };
}
