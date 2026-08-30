// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { projectRegistryCatalog, ProviderEntry } from "./ai-catalog";
import { resolveAIConfig } from "./ai-resolver";
import { UserConfig } from "./ai-types";

// Test catalog — minimal but covers the branches the resolver actually
// uses (regular model, model with reasoning, apitype override, {model}
// endpoint template).  Independent of the production CATALOG so changes
// to production data don't churn this suite.
const TEST_CATALOG: ProviderEntry[] = [
    {
        id: "openai",
        displayName: "OpenAI",
        defaultEndpoint: "https://api.openai.com/v1/responses",
        defaultApiType: "openai-responses",
        tokenSecretName: "OPENAI_API_KEY",
        icon: "stars-01",
        models: [
            {
                id: "gpt-5",
                displayName: "GPT-5",
                capabilities: ["tools", "images", "reasoning"],
                contextWindow: 200000,
                reasoningLevels: ["low", "medium", "high"],
            },
            {
                id: "gpt-4o",
                displayName: "GPT-4o",
                capabilities: ["tools"],
                contextWindow: 128000,
                apiTypeOverride: "openai-chat",
            },
        ],
    },
    {
        id: "google",
        displayName: "Gemini",
        // Template — resolver must substitute {model}.
        defaultEndpoint: "https://example.com/v1/models/{model}:run",
        defaultApiType: "google-gemini",
        tokenSecretName: "GOOGLE_AI_KEY",
        icon: "stars-01",
        models: [{ id: "gemini-flash", displayName: "Gemini Flash", capabilities: ["tools"], contextWindow: 1000000 }],
    },
    {
        // Aggregator — kind: "aggregator" + empty models[]. Resolver
        // must still succeed by synthesizing from provider defaults
        // when the user picks an id from the live list.
        id: "openrouter-test",
        displayName: "OpenRouter (test)",
        kind: "aggregator",
        defaultEndpoint: "https://example.com/openrouter/v1/chat/completions",
        defaultApiType: "openai-chat",
        tokenSecretName: "OPENROUTER_TEST_KEY",
        icon: "stars-01",
        models: [],
    },
];

const BASE_CONFIG: UserConfig = {
    providers: {
        openai: { tokensecretname: "OPENAI_API_KEY" },
        google: { tokensecretname: "GOOGLE_AI_KEY" },
        "openrouter-test": { tokensecretname: "OPENROUTER_TEST_KEY" },
    },
    default: { provider: "openai", model: "gpt-5" },
};

describe("resolveAIConfig — happy paths", () => {
    it("catalog provider + catalog model produces a complete ResolvedAIConfig", () => {
        const r = resolveAIConfig({ provider: "openai", model: "gpt-5" }, BASE_CONFIG, TEST_CATALOG);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config).toMatchObject({
            provider: "openai",
            model: "gpt-5",
            endpoint: "https://api.openai.com/v1/responses",
            apitype: "openai-responses",
            capabilities: ["tools", "images", "reasoning"],
            contextwindow: 200000,
            tokensecretname: "OPENAI_API_KEY",
        });
        // No reasoning in selection → no reasoning on output.
        expect(r.config.reasoning).toBeUndefined();
        // tokensecretname (not token) when secretname is configured.
        expect(r.config.token).toBeUndefined();
    });

    it("falls back to userConfig.default when selection is undefined", () => {
        const r = resolveAIConfig(undefined, BASE_CONFIG, TEST_CATALOG);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config.provider).toBe("openai");
        expect(r.config.model).toBe("gpt-5");
    });

    it("model with apitypeoverride overrides provider default apitype", () => {
        const r = resolveAIConfig({ provider: "openai", model: "gpt-4o" }, BASE_CONFIG, TEST_CATALOG);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config.apitype).toBe("openai-chat");
    });

    it("substitutes the {model} placeholder in the endpoint", () => {
        const r = resolveAIConfig({ provider: "google", model: "gemini-flash" }, BASE_CONFIG, TEST_CATALOG);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config.endpoint).toBe("https://example.com/v1/models/gemini-flash:run");
    });

    it("forwards reasoning level when the model supports it", () => {
        const r = resolveAIConfig({ provider: "openai", model: "gpt-5", reasoning: "high" }, BASE_CONFIG, TEST_CATALOG);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config.reasoning).toBe("high");
    });

    it("silently drops reasoning when the model does not support it", () => {
        const r = resolveAIConfig(
            { provider: "openai", model: "gpt-4o", reasoning: "high" },
            BASE_CONFIG,
            TEST_CATALOG
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config.reasoning).toBeUndefined();
    });

    it("literal token beats tokensecretname when both are set", () => {
        const cfg: UserConfig = {
            ...BASE_CONFIG,
            providers: {
                openai: { tokensecretname: "OPENAI_API_KEY", token: "sk-literal" },
                google: { tokensecretname: "GOOGLE_AI_KEY" },
            },
        };
        const r = resolveAIConfig({ provider: "openai", model: "gpt-5" }, cfg, TEST_CATALOG);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config.token).toBe("sk-literal");
        expect(r.config.tokensecretname).toBeUndefined();
    });

    it("allows empty tokensecretname (local unauthed endpoint pattern)", () => {
        const cfg: UserConfig = {
            providers: {
                openai: { tokensecretname: "" },
            },
            default: { provider: "openai", model: "gpt-5" },
        };
        const r = resolveAIConfig({ provider: "openai", model: "gpt-5" }, cfg, TEST_CATALOG);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config.tokensecretname).toBe("");
    });

    it("uses context metadata from the projected registry catalog", () => {
        const catalog = projectRegistryCatalog(TEST_CATALOG, {
            openai: {
                status: "ok",
                models: [
                    {
                        id: "gpt-5",
                        name: "GPT-5 refreshed",
                        reasoning: true,
                        thinkinglevels: ["low", "medium", "high"],
                        inputmodalities: ["text", "image"],
                        context: 250_000,
                    },
                ],
                fetchedAt: 1,
            },
        });

        const r = resolveAIConfig({ provider: "openai", model: "gpt-5" }, BASE_CONFIG, catalog);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config.contextwindow).toBe(250_000);
    });
});

describe("resolveAIConfig — custom_endpoints", () => {
    const CFG: UserConfig = {
        providers: {
            "vllm-local": { tokensecretname: "" },
        },
        default: { provider: "vllm-local", model: "qwen-coder-32b" },
        custom_endpoints: {
            "vllm-local": {
                displayname: "Local vLLM",
                endpoint: "http://localhost:8000/v1/chat/completions",
                apitype: "openai-chat",
                tokensecretname: "",
                models: [
                    {
                        id: "qwen-coder-32b",
                        displayName: "Qwen 2.5 Coder",
                        capabilities: ["tools"],
                        contextWindow: 128000,
                    },
                ],
            },
        },
    };

    it("resolves provider + model from custom_endpoints", () => {
        const r = resolveAIConfig({ provider: "vllm-local", model: "qwen-coder-32b" }, CFG, TEST_CATALOG);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config.endpoint).toBe("http://localhost:8000/v1/chat/completions");
        expect(r.config.apitype).toBe("openai-chat");
    });

    it("substitutes {model} in custom_endpoints url too", () => {
        const cfg: UserConfig = {
            ...CFG,
            custom_endpoints: {
                "vllm-local": {
                    ...CFG.custom_endpoints!["vllm-local"],
                    endpoint: "http://localhost:8000/models/{model}/run",
                },
            },
        };
        const r = resolveAIConfig({ provider: "vllm-local", model: "qwen-coder-32b" }, cfg, TEST_CATALOG);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config.endpoint).toBe("http://localhost:8000/models/qwen-coder-32b/run");
    });
});

describe("resolveAIConfig — custom_models", () => {
    it("resolves a model not in catalog but listed in custom_models", () => {
        const cfg: UserConfig = {
            ...BASE_CONFIG,
            custom_models: [
                {
                    provider: "openai",
                    id: "gpt-experimental",
                    displayname: "GPT Experimental",
                    capabilities: ["tools"],
                    contextwindow: 50000,
                },
            ],
        };
        const r = resolveAIConfig({ provider: "openai", model: "gpt-experimental" }, cfg, TEST_CATALOG);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config.model).toBe("gpt-experimental");
        expect(r.config.apitype).toBe("openai-responses"); // inherited from provider default
        expect(r.config.contextwindow).toBe(50000);
    });

    it("custom_models can override apitype per-model", () => {
        const cfg: UserConfig = {
            ...BASE_CONFIG,
            custom_models: [
                {
                    provider: "openai",
                    id: "ancient-completions",
                    displayname: "Ancient Completions",
                    capabilities: ["tools"],
                    contextwindow: 4096,
                    apitypeoverride: "openai-chat",
                },
            ],
        };
        const r = resolveAIConfig({ provider: "openai", model: "ancient-completions" }, cfg, TEST_CATALOG);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config.apitype).toBe("openai-chat");
    });
});

describe("resolveAIConfig — error paths", () => {
    it("no_config when userConfig is undefined", () => {
        const r = resolveAIConfig({ provider: "openai", model: "gpt-5" }, undefined, TEST_CATALOG);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("no_config");
    });

    it("no_default when neither selection nor default exists", () => {
        const cfg = { providers: { openai: { tokensecretname: "X" } } } as unknown as UserConfig;
        const r = resolveAIConfig(undefined, cfg, TEST_CATALOG);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("no_default");
    });

    it("unknown_provider when id matches neither catalog nor custom_endpoints", () => {
        const r = resolveAIConfig({ provider: "nope", model: "x" }, BASE_CONFIG, TEST_CATALOG);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("unknown_provider");
        expect(r.error.hint?.provider).toBe("nope");
    });

    it("synthesizes provider defaults when catalog provider exists but model isn't enumerated", () => {
        // Live /models endpoints surface ids the catalog doesn't enumerate
        // (direct providers occasionally lag behind upstream releases). The
        // picker writes those to Workspace Agent selection and the resolver must still
        // produce a usable ResolvedAIConfig instead of erroring with
        // unknown_model.
        const r = resolveAIConfig({ provider: "openai", model: "gpt-9000" }, BASE_CONFIG, TEST_CATALOG);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config).toMatchObject({
            provider: "openai",
            model: "gpt-9000",
            endpoint: "https://api.openai.com/v1/responses",
            apitype: "openai-responses",
            capabilities: [],
            contextwindow: 0,
            tokensecretname: "OPENAI_API_KEY",
        });
    });

    it("aggregator provider with empty catalog.models[] resolves any live-picked id", () => {
        // Aggregators (OpenRouter et al) ship empty catalog.models[] by
        // design — live /models is the only source. This is the primary
        // path the synth fallback exists to serve.
        const r = resolveAIConfig(
            { provider: "openrouter-test", model: "anthropic/claude-opus-4-7" },
            BASE_CONFIG,
            TEST_CATALOG
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.config).toMatchObject({
            provider: "openrouter-test",
            model: "anthropic/claude-opus-4-7",
            endpoint: "https://example.com/openrouter/v1/chat/completions",
            apitype: "openai-chat",
            capabilities: [],
            contextwindow: 0,
            tokensecretname: "OPENROUTER_TEST_KEY",
        });
    });

    it("no_credentials when provider is valid but ai.json has no providers entry", () => {
        const cfg: UserConfig = {
            providers: {},
            default: { provider: "openai", model: "gpt-5" },
        };
        const r = resolveAIConfig({ provider: "openai", model: "gpt-5" }, cfg, TEST_CATALOG);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("no_credentials");
    });
});
