// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Provider matrix for the agent regression harness. Each entry knows how
// to build a pi-ai Model for a cheap, tool-capable model on that provider
// and which env var carries the API key.
//
// Anthropic / OpenAI / Google models come straight from pi-ai's registry
// (getModel). OpenRouter free-tier models aren't enumerated in the
// registry, so we hand-build the Model shape the same way the live
// catalog path does (openai-completions api, baseUrl override).

import type { Api, Model } from "@crest/ai";
import { getModel } from "@crest/ai";

export interface ProviderConfig {
    id: string;
    // Env var that must be set for this provider to run. The model id can
    // be overridden via <ID>_MODEL (e.g. ANTHROPIC_MODEL).
    envKey: string;
    modelEnvKey: string;
    defaultModel: string;
    buildModel(modelId: string): Model<Api>;
}

function registryModel(provider: string, modelId: string): Model<Api> {
    // getModel is typed against literal registry keys; our runtime strings
    // can't satisfy that, so cast. Returns undefined for unknown ids —
    // caller throws a clear error in that case.
    const model = (getModel as unknown as (p: string, m: string) => Model<Api> | undefined)(
        provider,
        modelId,
    );
    if (!model) {
        throw new Error(`regression: model "${provider}/${modelId}" not in pi-ai registry`);
    }
    return model;
}

function openRouterModel(modelId: string): Model<Api> {
    return {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: "openrouter",
        // openai SDK appends /chat/completions itself — base path only.
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
    };
}

export const PROVIDERS: ProviderConfig[] = [
    {
        id: "anthropic",
        envKey: "ANTHROPIC_API_KEY",
        modelEnvKey: "ANTHROPIC_MODEL",
        defaultModel: "claude-haiku-4-5",
        buildModel: (m) => registryModel("anthropic", m),
    },
    {
        id: "openai",
        envKey: "OPENAI_API_KEY",
        modelEnvKey: "OPENAI_MODEL",
        defaultModel: "gpt-4o-mini",
        buildModel: (m) => registryModel("openai", m),
    },
    {
        id: "google",
        envKey: "GEMINI_API_KEY",
        modelEnvKey: "GOOGLE_MODEL",
        defaultModel: "gemini-2.0-flash",
        buildModel: (m) => registryModel("google", m),
    },
    {
        id: "openrouter",
        envKey: "OPENROUTER_API_KEY",
        modelEnvKey: "OPENROUTER_MODEL",
        // gpt-oss-20b:free reliably handles tool calls and is less
        // aggressively rate-limited than llama-3.3-70b:free (which
        // returns upstream 429s under light load). Override via
        // OPENROUTER_MODEL.
        defaultModel: "openai/gpt-oss-20b:free",
        buildModel: openRouterModel,
    },
];

export function resolveModelId(p: ProviderConfig): string {
    return process.env[p.modelEnvKey] ?? p.defaultModel;
}

export function apiKeyFor(p: ProviderConfig): string | undefined {
    const v = process.env[p.envKey];
    return v && v.trim() ? v.trim() : undefined;
}
