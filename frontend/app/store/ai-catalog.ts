// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AI provider / model catalog.  In-repo source of truth for "what
// providers + models exist in the world" — endpoints, apitypes,
// capabilities, context windows, reasoning support.
//
// Maintained by crest contributors via PR.  Crest does not have a
// backend catalog service (unlike warp's Oz proto API), so this list
// is the authoritative discovery surface for the UI picker.
//
// Design: see docs/ai-config-architecture.md §3.
//
// To add a model: append to the appropriate provider's `models` array.
// To add a provider: append a new ProviderEntry to CATALOG.
// To override or extend at the user level: users add to their
// ~/.config/crest/ai.json `custom_models` or `custom_endpoints` — they
// do NOT touch this file.

// =========================================================================
// Types
// =========================================================================

// Wire-level apitype the backend agent code expects on AIOptsType.APIType.
// Values mirror uctypes.APIType_* constants on the Go side; keep in sync
// when adding a new backend.
export type ApiType = "openai-responses" | "openai-chat" | "google-gemini" | "anthropic-messages";

// What a model can do — feeds into capability badges in the picker and
// gates request features (tools, image attachments, PDF attachments,
// reasoning level support).
export type Capability = "tools" | "images" | "pdfs" | "reasoning";

// Reasoning effort, only meaningful when the model has the "reasoning"
// capability.  Maps directly to ThinkingLevel on AIOptsType.
export type ReasoningLevel = "low" | "medium" | "high";

export interface ProviderEntry {
    // Stable id used as a key in user config and selection meta.  Must
    // be lowercase, alphanumeric + dashes only.
    id: string;
    displayName: string;
    // Default URL the resolver uses unless a per-model override or user
    // override applies.  May contain the literal `{model}` placeholder
    // which the resolver substitutes with the selected model id (used
    // by Google Gemini today; see ApiType_GoogleGemini below).
    defaultEndpoint: string;
    defaultApiType: ApiType;
    // OS-keychain key name the secretstore looks up by default when the
    // user's ai.json provider entry doesn't override it.  Matches the
    // existing convention in pkg/aiusechat/usechat-mode.go:
    //   OpenAIAPITokenSecretName="OPENAI_API_KEY"
    //   AnthropicAPITokenSecretName="ANTHROPIC_API_KEY"
    //   GoogleAIAPITokenSecretName="GOOGLE_AI_KEY"
    //   OpenRouterAPITokenSecretName="OPENROUTER_API_KEY"
    tokenSecretName: string;
    // UI icon name; resolved against the ui-icon set.
    icon: string;
    models: ModelEntry[];
}

export interface ModelEntry {
    // Wire model id sent to the upstream provider.  Provider-specific:
    // OpenAI uses things like "gpt-5", Anthropic uses "claude-opus-4-7",
    // OpenRouter uses "vendor/model" pairs.
    id: string;
    displayName: string;
    // One-liner shown as the picker row subtitle.
    description?: string;
    // What the model can do.  reasoning here means the model accepts a
    // reasoning-effort hint; presence of "tools" gates whether the
    // agent will offer it tool calls; etc.
    capabilities: Capability[];
    // Native context window in tokens.  Displayed in the picker (e.g.
    // "200k") and informs prompt budgeting in the agent loop.
    contextWindow: number;
    // Only meaningful when capabilities includes "reasoning".  Lists
    // the discrete levels the model accepts.  All current "reasoning"
    // models accept the full low/medium/high triple; carved out so a
    // future model with only two settings can constrain its options.
    reasoningLevels?: ReasoningLevel[];
    // When set, overrides the provider.defaultApiType for this model.
    // Used for older OpenAI models that don't speak the Responses API
    // (e.g. gpt-4o is openai-chat even though provider default is
    // openai-responses).
    apiTypeOverride?: ApiType;
}

// =========================================================================
// v1 catalog content
// =========================================================================
//
// Conservative v1 list — popular models per provider, no exhaustive
// coverage.  Users extend via custom_models in ai.json.  Update via PR
// as the AI market shifts.

export const CATALOG: ProviderEntry[] = [
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
                description: "Top-tier reasoning + tool use",
                capabilities: ["tools", "images", "pdfs", "reasoning"],
                contextWindow: 200000,
                reasoningLevels: ["low", "medium", "high"],
            },
            {
                id: "gpt-5-mini",
                displayName: "GPT-5 mini",
                description: "Fast, low-cost",
                capabilities: ["tools", "images", "pdfs"],
                contextWindow: 200000,
            },
            {
                id: "gpt-4o",
                displayName: "GPT-4o",
                description: "Previous-gen flagship, openai-chat API",
                capabilities: ["tools", "images"],
                contextWindow: 128000,
                apiTypeOverride: "openai-chat",
            },
            {
                id: "o3-mini",
                displayName: "o3 mini",
                description: "Reasoning-optimized small model",
                capabilities: ["tools", "reasoning"],
                contextWindow: 200000,
                reasoningLevels: ["low", "medium", "high"],
            },
        ],
    },
    {
        id: "anthropic",
        displayName: "Anthropic",
        defaultEndpoint: "https://api.anthropic.com/v1/messages",
        defaultApiType: "anthropic-messages",
        tokenSecretName: "ANTHROPIC_API_KEY",
        icon: "stars-01",
        models: [
            {
                id: "claude-opus-4-7",
                displayName: "Claude Opus 4.7",
                description: "Largest Claude — 1M context",
                capabilities: ["tools", "images", "pdfs", "reasoning"],
                contextWindow: 1000000,
                reasoningLevels: ["low", "medium", "high"],
            },
            {
                id: "claude-sonnet-4-6",
                displayName: "Claude Sonnet 4.6",
                description: "Balanced default",
                capabilities: ["tools", "images", "pdfs", "reasoning"],
                contextWindow: 200000,
                reasoningLevels: ["low", "medium", "high"],
            },
            {
                id: "claude-haiku-4-5-20251001",
                displayName: "Claude Haiku 4.5",
                description: "Fastest Claude",
                capabilities: ["tools", "images", "pdfs"],
                contextWindow: 200000,
            },
        ],
    },
    {
        id: "google",
        displayName: "Google Gemini",
        // {model} placeholder — resolver substitutes the selected model id.
        defaultEndpoint:
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent",
        defaultApiType: "google-gemini",
        tokenSecretName: "GOOGLE_AI_KEY",
        icon: "stars-01",
        models: [
            {
                id: "gemini-2.0-pro",
                displayName: "Gemini 2.0 Pro",
                description: "2M token context",
                capabilities: ["tools", "images", "pdfs"],
                contextWindow: 2000000,
            },
            {
                id: "gemini-2.0-flash",
                displayName: "Gemini 2.0 Flash",
                description: "Fast, 1M context",
                capabilities: ["tools", "images", "pdfs"],
                contextWindow: 1000000,
            },
        ],
    },
    {
        id: "openrouter",
        displayName: "OpenRouter",
        defaultEndpoint: "https://openrouter.ai/api/v1/chat/completions",
        defaultApiType: "openai-chat",
        tokenSecretName: "OPENROUTER_API_KEY",
        icon: "stars-01",
        models: [
            {
                id: "anthropic/claude-opus-4-7",
                displayName: "Claude Opus 4.7 (OpenRouter)",
                description: "Routed via OpenRouter",
                capabilities: ["tools", "images"],
                contextWindow: 1000000,
            },
            {
                id: "openai/gpt-5",
                displayName: "GPT-5 (OpenRouter)",
                description: "Routed via OpenRouter",
                capabilities: ["tools", "images"],
                contextWindow: 200000,
            },
        ],
    },
];

// =========================================================================
// Lookup helpers
// =========================================================================

// findProvider — case-sensitive id match against CATALOG; returns
// undefined for unknown ids (resolver will fall back to user's
// custom_endpoints).
export function findProvider(providerId: string): ProviderEntry | undefined {
    return CATALOG.find((p) => p.id === providerId);
}

// findModel — looks up a model within a specific provider.  Does not
// search across providers (model ids are not globally unique —
// "openai/gpt-5" is an OpenRouter id, not an OpenAI id).
export function findModel(
    providerId: string,
    modelId: string
): ModelEntry | undefined {
    const provider = findProvider(providerId);
    return provider?.models.find((m) => m.id === modelId);
}

// resolveApiType — model's per-model override beats provider default.
// Pure helper; resolver consumes this when building ResolvedAIConfig.
export function resolveApiType(provider: ProviderEntry, model: ModelEntry): ApiType {
    return model.apiTypeOverride ?? provider.defaultApiType;
}

// resolveEndpoint — substitutes the `{model}` placeholder when the
// provider uses a per-model URL template (Google Gemini).  No-op for
// providers without the placeholder.
export function resolveEndpoint(provider: ProviderEntry, model: ModelEntry): string {
    return provider.defaultEndpoint.replace("{model}", model.id);
}
