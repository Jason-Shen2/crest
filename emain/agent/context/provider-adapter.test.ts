// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ai/providers/anthropic", () => ({
    buildAnthropicPayload: vi.fn(() => ({ providerPayload: "anthropic" })),
    countAnthropicPayload: vi.fn(async () => 41),
    getAnthropicReasoningOptions: vi.fn((_model, reasoning) => ({
        thinkingEnabled: reasoning !== "off",
    })),
}));
vi.mock("../../ai/providers/openai-responses", () => ({
    buildOpenAIResponsesPayload: vi.fn(() => ({ providerPayload: "openai" })),
    countOpenAIResponsesPayload: vi.fn(async () => 42),
    getOpenAIResponsesReasoningOptions: vi.fn((_model, reasoning) => ({
        reasoningEffort: reasoning === "off" ? undefined : reasoning,
    })),
}));
vi.mock("../../ai/providers/google", () => ({
    buildGooglePayload: vi.fn(() => ({ providerPayload: "google" })),
    countGooglePayload: vi.fn(async () => 43),
    getGoogleReasoningOptions: vi.fn((_model, reasoning) => ({
        thinking: { enabled: reasoning !== "off" },
    })),
}));
vi.mock("../../ai/env-api-keys", () => ({
    getEnvApiKey: vi.fn(),
}));

import type { Api, Model } from "../../ai";
import { getEnvApiKey } from "../../ai/env-api-keys";
import { countAnthropicPayload } from "../../ai/providers/anthropic";
import { countGooglePayload } from "../../ai/providers/google";
import { countOpenAIResponsesPayload } from "../../ai/providers/openai-responses";
import { createContextProviderAdapter } from "./provider-adapter";

function model(api: Api, provider: string, id = "model"): Model<Api> {
    return {
        api,
        provider,
        id,
        contextWindow: 100_000,
        maxTokens: 4_000,
    } as Model<Api>;
}

describe("context provider adapter", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        ["anthropic-messages", "anthropic", countAnthropicPayload, 41],
        ["openai-responses", "openai", countOpenAIResponsesPayload, 42],
        ["google-generative-ai", "google", countGooglePayload, 43],
    ] as const)(
        "counts the complete %s final payload with the official counter",
        async (api, provider, counter, tokens) => {
            const adapter = createContextProviderAdapter(model(api, provider), "secret", "off")!;
            const finalPayload = {
                model: "model",
                history: ["history"],
                tools: [{ name: "tool" }],
                image: "base64",
                overlay: "overlay",
            };
            const signal = new AbortController().signal;

            const result = await adapter.tokenCounter.countFinalRequest({
                provider,
                modelKey: `${provider}/model`,
                contextWindow: 100_000,
                maxOutputTokens: 4_000,
                payload: finalPayload,
                signal,
            });

            expect(result).toEqual({ inputTokens: tokens, accuracy: "exact" });
            expect(counter).toHaveBeenCalledWith(expect.any(Object), finalPayload, "secret", signal);
        }
    );

    it("supports reasoning for authoritative providers and rejects only unsupported or unauthenticated providers", () => {
        expect(createContextProviderAdapter(model("openai-completions", "openai"), "secret", "off")).toBeUndefined();
        expect(createContextProviderAdapter(model("anthropic-messages", "anthropic"), "secret", "high")).toBeDefined();
        expect(createContextProviderAdapter(model("openai-responses", "openai"), "secret", "high")).toBeDefined();
        expect(createContextProviderAdapter(model("google-generative-ai", "google"), "secret", "high")).toBeDefined();
        expect(createContextProviderAdapter(model("openai-responses", "openai"), undefined, "off")).toBeUndefined();
    });

    it.each(["minimax", "minimax-cn"])(
        "uses the documented Anthropic token counter for MiniMax-M3 on %s",
        async (provider) => {
            const miniMaxModel = model("anthropic-messages", provider, "MiniMax-M3");
            const adapter = createContextProviderAdapter(miniMaxModel, "secret", "off");
            const payload = { model: "MiniMax-M3", messages: [] };

            expect(adapter).toBeDefined();
            await expect(
                adapter!.tokenCounter.countFinalRequest({
                    provider,
                    modelKey: `${provider}/MiniMax-M3`,
                    contextWindow: 1_000_000,
                    maxOutputTokens: 4_000,
                    payload,
                })
            ).resolves.toEqual({ inputTokens: 41, accuracy: "exact" });
            expect(countAnthropicPayload).toHaveBeenCalledWith(miniMaxModel, payload, "secret", undefined);
        }
    );

    it("uses the same provider environment credential fallback as normal MiniMax requests", async () => {
        vi.mocked(getEnvApiKey).mockReturnValue("environment-secret");
        const miniMaxModel = model("anthropic-messages", "minimax", "MiniMax-M3");
        const adapter = createContextProviderAdapter(miniMaxModel, undefined, "off");
        const payload = { model: "MiniMax-M3", messages: [] };

        expect(adapter).toBeDefined();
        await adapter!.tokenCounter.countFinalRequest({
            provider: "minimax",
            modelKey: "minimax/MiniMax-M3",
            contextWindow: 1_000_000,
            maxOutputTokens: 4_000,
            payload,
        });
        expect(countAnthropicPayload).toHaveBeenCalledWith(miniMaxModel, payload, "environment-secret", undefined);
    });

    it.each([
        ["minimax", "MiniMax-M2.7"],
        ["minimax-cn", "MiniMax-M2.7"],
        ["fireworks", "MiniMax-M3"],
        ["custom", "MiniMax-M3"],
    ])("does not assume %s/%s implements an authoritative counter", (provider, id) => {
        expect(
            createContextProviderAdapter(model("anthropic-messages", provider, id), "secret", "off")
        ).toBeUndefined();
    });
});
