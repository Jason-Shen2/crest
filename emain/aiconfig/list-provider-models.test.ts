// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Api, Model, ModelCatalog } from "@crest/ai";

vi.mock("./secrets", () => ({ getSecret: vi.fn() }));

import { APIType_AnthropicMessages, listProviderModels, listRegistryModels } from "./list-provider-models";

describe("listProviderModels", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("does not fetch /models for Anthropic-compatible providers", async () => {
        const fetch = vi.fn(() => {
            throw new Error("fetch should not be called");
        });
        vi.stubGlobal("fetch", fetch);

        await expect(
            listProviderModels({
                apitype: APIType_AnthropicMessages,
                baseurl: "https://api.minimax.io/anthropic",
                apitoken: "token",
            })
        ).resolves.toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("maps the shared catalog snapshot without mutating it", () => {
        const sourceModel = model("gpt-next");
        const catalog = {
            getModels: vi.fn(() => [sourceModel]),
        } as unknown as ModelCatalog;

        expect(listRegistryModels(catalog, "openai")).toEqual([
            {
                id: "gpt-next",
                name: "GPT Next",
                reasoning: true,
                thinkinglevels: ["minimal", "low", "medium", "high", "xhigh"],
                inputmodalities: ["text", "image"],
                context: 250_000,
                maxoutputtokens: 32_000,
                promptcost: 2,
                completioncost: 8,
            },
        ]);
        expect(catalog.getModels).toHaveBeenCalledWith("openai");
        expect(sourceModel).toEqual(model("gpt-next"));
    });
});

function model(id: string): Model<Api> {
    return {
        id,
        name: "GPT Next",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 },
        contextWindow: 250_000,
        maxTokens: 32_000,
        thinkingLevelMap: { off: null, xhigh: "xhigh" },
    };
}
