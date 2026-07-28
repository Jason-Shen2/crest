// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@crest/ai/models", () => ({
    getModels: vi.fn(() => []),
    getSupportedThinkingLevels: vi.fn(() => []),
}));
vi.mock("../models-dev-overlay", () => ({ getCapabilityOverlay: vi.fn() }));
vi.mock("./secrets", () => ({
    getSecret: vi.fn(),
    _resetSecretsCacheForTests: vi.fn(),
}));

import { APIType_AnthropicMessages, listProviderModels } from "./list-provider-models";

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
});
