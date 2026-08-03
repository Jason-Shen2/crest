// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { findProvider, projectRegistryCatalog, projectRegistryModels, type ProviderEntry } from "./ai-catalog";

describe("AI catalog", () => {
    it("registers minimax as an Anthropic-compatible built-in provider", () => {
        const provider = findProvider("minimax");

        expect(provider).toMatchObject({
            id: "minimax",
            defaultEndpoint: "https://api.minimax.io/anthropic",
            defaultApiType: "anthropic-messages",
            tokenSecretName: "MINIMAX_API_KEY",
        });
        expect(provider?.models.map((model) => model.id)).toContain("MiniMax-M2.7");
    });

    it("projects registry facts while preserving renderer-only capabilities", () => {
        const provider: ProviderEntry = {
            id: "test",
            displayName: "Test",
            defaultEndpoint: "https://example.com/v1/responses",
            defaultApiType: "openai-responses",
            tokenSecretName: "TEST_KEY",
            icon: "stars-01",
            models: [
                {
                    id: "model-a",
                    displayName: "Old name",
                    capabilities: ["tools", "images", "pdfs"],
                    contextWindow: 100_000,
                    reasoningLevels: ["low"],
                },
            ],
        };
        const registryModel: RegistryModelInfo = {
            id: "model-a",
            name: "Fresh name",
            reasoning: true,
            thinkinglevels: ["minimal", "low", "medium", "high", "xhigh"],
            inputmodalities: ["text", "image"],
            context: 250_000,
        };

        expect(projectRegistryModels(provider, [registryModel])).toEqual({
            ...provider,
            models: [
                expect.objectContaining({
                    id: "model-a",
                    displayName: "Fresh name",
                    contextWindow: 250_000,
                    capabilities: ["tools", "images", "pdfs", "reasoning"],
                    reasoningLevels: ["low", "medium", "high"],
                }),
            ],
        });
    });

    it("adds registry-only models without inventing unsupported metadata", () => {
        const provider = findProvider("openai")!;
        const registryModel: RegistryModelInfo = {
            id: "gpt-future",
            name: "GPT Future",
            reasoning: true,
            supportstools: true,
            thinkinglevels: ["minimal", "high", "xhigh"],
            inputmodalities: ["text", "image"],
            context: 300_000,
        };

        const projected = projectRegistryModels(provider, [registryModel]);
        expect(projected.models.at(-1)).toMatchObject({
            id: "gpt-future",
            displayName: "GPT Future",
            capabilities: ["tools", "images", "reasoning"],
            reasoningLevels: ["high"],
            contextWindow: 300_000,
        });
        expect(projected.models.at(-1)?.capabilities).not.toContain("pdfs");
    });

    it("projects only successful registry states over the supplied catalog", () => {
        const provider = findProvider("openai")!;
        const projected = projectRegistryCatalog([provider], {
            openai: {
                status: "ok",
                models: [
                    {
                        id: "only-in-registry",
                        name: "Registry model",
                        reasoning: false,
                        thinkinglevels: [],
                        inputmodalities: ["text"],
                    },
                ],
                fetchedAt: 1,
            },
        });

        expect(projected).toHaveLength(1);
        expect(projected[0].models.some((model) => model.id === "only-in-registry")).toBe(true);
    });

    it("projects the last good registry models while a later refresh is failing", () => {
        const provider = findProvider("openai")!;
        const projected = projectRegistryCatalog([provider], {
            openai: {
                status: "error",
                models: [
                    {
                        id: "last-good-model",
                        name: "Last good model",
                        reasoning: false,
                        thinkinglevels: [],
                        inputmodalities: ["text"],
                    },
                ],
                error: "catalog unavailable",
                fetchedAt: 1,
            },
        });

        expect(projected[0].models.some((model) => model.id === "last-good-model")).toBe(true);
    });
});
