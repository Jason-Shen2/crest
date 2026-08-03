// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Renderer provider presentation plus an offline/first-paint model
// fallback. Electron's ModelCatalogService is authoritative for current
// model facts and projects them over these arrays after IPC hydration.
//
// Design: see docs/ai-config-architecture.md.
//
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

// Provider kind — distinguishes direct providers from aggregators whose
// account-visible IDs are open-ended.
//
// Consumer rules:
//   - kind: "direct"     → checked-in models provide first paint until
//                          the Electron registry projection arrives.
//   - kind: "aggregator" → checked-in models stay empty. Electron supplies
//                          facts; /models optionally filters account-visible
//                          IDs and may contribute provisional deployment IDs.
//
// Why: hard-coding even 2 OpenRouter models in catalog created a UX
// trap (chip showed model name → user thought it was set → resolver
// returned unknown_model → silent toast).  Aggregator kind makes the
// "we don't enumerate this provider" intent explicit.
export type ProviderKind = "direct" | "aggregator";

export interface ProviderEntry {
    // Stable id used as a key in user config and selection meta.  Must
    // be lowercase, alphanumeric + dashes only.
    id: string;
    displayName: string;
    // See ProviderKind above for semantics.  Defaults to "direct" when
    // omitted so adding a new catalog entry doesn't accidentally turn
    // it into a live-only aggregator.
    kind?: ProviderKind;
    // Default URL the resolver uses unless a per-model override or user
    // override applies.  May contain the literal `{model}` placeholder
    // which the resolver substitutes with the selected model id (used
    // by Google Gemini today; see ApiType_GoogleGemini below).
    defaultEndpoint: string;
    defaultApiType: ApiType;
    // Optional override for the /models endpoint used by the picker's
    // live fetch. When omitted, the IPC derives it from defaultEndpoint
    // (strip `/chat/completions` / `/messages` etc., append `/models`).
    // Set this when a provider's chat and model-list endpoints live at
    // different paths on the same host — e.g. minimax: chat goes
    // through the Anthropic-compatible `/anthropic` path but the
    // account-visible model list is served by the OpenAI-compatible
    // `/v1/models` on the same host.  Anthropic itself doesn't expose
    // any /models, so omitting the override on the direct Anthropic
    // entry correctly degrades to the static catalog fallback.
    modelsEndpoint?: string;
    // OS-keychain key name the secretstore looks up by default when the
    // user's ai.json provider entry doesn't override it.
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
// Catalog content
// =========================================================================
//
// Provider-level entries (endpoint, apitype, token secret name, kind)
// are CURATED here — these are the facts that don't change with the
// AI market churn (OpenAI's Responses API URL is stable; OpenRouter is
// always an aggregator; Gemini always uses its {model} URL template).
//
// Model-level fallback entries are synced from the LiteLLM
// registry by `scripts/sync-ai-models.mjs` (run via `task sync:models`).
// The synced file is ai-catalog-models.gen.ts; Electron overlays current
// metadata from its shared catalog after renderer hydration.
//
// Aggregator providers get an empty checked-in models[] by design.

import { MODELS_BY_PROVIDER } from "./ai-catalog-models.gen";
import type { RegistryModelsState } from "./ai-registry-models";

// minimax M-series model list — curated inline because LiteLLM's
// minimax provider doesn't currently expose the full generated baseline
// set (M2.7 / M2.7-highspeed are missing upstream). It mirrors the
// @crest/ai registry so the resolver's model id matches what Electron will
// accept.  Capabilities: all M-series are reasoning models with
// function calling — LiteLLM confirms `supports_function_calling`
// and `supports_reasoning` on every chat entry under
// `litellm_provider: "minimax"`.  Context windows follow the
// LiteLLM-published numbers (M2 = 200k, M2.1+ = 1M, M3 = 1M).
// M2.7 sits at 200k to match the public model card; the resolver
// falls back to `endpoint` substitution regardless so a mismatch is
// a budgeting concern, not a correctness one.
//
// This inline list is the first-paint/offline fallback. Electron registry
// hydration supplies current metadata; `/v1/models` only filters what the
// configured account can see.
function makeMinimaxModel(id: string, displayName: string, contextWindow: number): ModelEntry {
    return {
        id,
        displayName,
        capabilities: ["tools", "reasoning"],
        contextWindow,
        reasoningLevels: ["low", "medium", "high"],
    };
}

const MINIMAX_MODELS: ModelEntry[] = [
    makeMinimaxModel("MiniMax-M2", "MiniMax-M2", 200000),
    makeMinimaxModel("MiniMax-M2.1", "MiniMax-M2.1", 1000000),
    makeMinimaxModel("MiniMax-M2.1-highspeed", "MiniMax-M2.1 Highspeed", 1000000),
    makeMinimaxModel("MiniMax-M2.5", "MiniMax-M2.5", 1000000),
    makeMinimaxModel("MiniMax-M2.5-highspeed", "MiniMax-M2.5 Highspeed", 1000000),
    makeMinimaxModel("MiniMax-M2.7", "MiniMax-M2.7", 200000),
    makeMinimaxModel("MiniMax-M2.7-highspeed", "MiniMax-M2.7 Highspeed", 200000),
    makeMinimaxModel("MiniMax-M3", "MiniMax-M3", 1000000),
];

// minimax-cn ships the same model family as the global endpoint
// (M2 through M3). Earlier revisions of this file mirrored an older
// generated snapshot that omitted M3 on the CN
// provider, but minimax's China endpoint now exposes M3 in full.
// This inline list is the first-paint fallback before Electron registry
// hydration; `/v1/models` only filters account-visible IDs.
const MINIMAX_CN_MODELS: ModelEntry[] = MINIMAX_MODELS;

export const CATALOG: ProviderEntry[] = [
    {
        id: "openai",
        displayName: "OpenAI",
        defaultEndpoint: "https://api.openai.com/v1/responses",
        defaultApiType: "openai-responses",
        tokenSecretName: "OPENAI_API_KEY",
        icon: "stars-01",
        models: MODELS_BY_PROVIDER.openai ?? [],
    },
    {
        id: "anthropic",
        displayName: "Anthropic",
        defaultEndpoint: "https://api.anthropic.com/v1/messages",
        defaultApiType: "anthropic-messages",
        tokenSecretName: "ANTHROPIC_API_KEY",
        icon: "stars-01",
        models: MODELS_BY_PROVIDER.anthropic ?? [],
    },
    {
        id: "google",
        displayName: "Google Gemini",
        // {model} placeholder — resolver substitutes the selected model id.
        defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent",
        defaultApiType: "google-gemini",
        tokenSecretName: "GOOGLE_AI_KEY",
        icon: "stars-01",
        models: MODELS_BY_PROVIDER.google ?? [],
    },
    {
        // minimax global — Anthropic-compatible endpoint at api.minimax.io.
        // Mirrors emain/ai/models.generated.ts lines 5392+ (provider block).
        // Model list is curated inline (see MINIMAX_MODELS above) rather
        // than pulled from LiteLLM sync because the LiteLLM `minimax`
        // provider block is missing M2.7 / M2.7-highspeed.
        //
        // `modelsEndpoint` overrides the picker live fetch so it hits
        // the OpenAI-compatible `/v1/models` on the same host — that's
        // where minimax serves its account-visible IDs. Without this
        // override the IPC would
        // derive `/anthropic/models` from defaultEndpoint, which 404s
        // (Anthropic's surface has no /models, and minimax's compat
        // surface inherits that gap).
        id: "minimax",
        displayName: "minimax",
        defaultEndpoint: "https://api.minimax.io/anthropic",
        defaultApiType: "anthropic-messages",
        modelsEndpoint: "https://api.minimax.io/v1/models",
        tokenSecretName: "MINIMAX_API_KEY",
        icon: "stars-01",
        models: MINIMAX_MODELS,
    },
    {
        // minimax-cn — Anthropic-compatible endpoint at api.minimaxi.com
        // for users behind the GFW / on Chinese egress.  Same apitype;
        // model list is the global set minus M3 (matches emain registry).
        // modelsEndpoint: same routing logic as the global entry —
        // hit the OpenAI-compatible `/v1/models` so live fetches work.
        id: "minimax-cn",
        displayName: "minimax (China)",
        defaultEndpoint: "https://api.minimaxi.com/anthropic",
        defaultApiType: "anthropic-messages",
        modelsEndpoint: "https://api.minimaxi.com/v1/models",
        tokenSecretName: "MINIMAX_CN_API_KEY",
        icon: "stars-01",
        models: MINIMAX_CN_MODELS,
    },
    {
        // OpenRouter is an aggregator — it routes to 300+ upstream models
        // we couldn't curate in catalog without immediate drift.  The
        // checked-in fallback stays empty; Electron supplies catalog facts
        // and /models optionally filters account-visible IDs. This entry
        // provides endpoint/apitype/icon defaults for provisional IDs.
        id: "openrouter",
        displayName: "OpenRouter",
        kind: "aggregator",
        defaultEndpoint: "https://openrouter.ai/api/v1/chat/completions",
        defaultApiType: "openai-chat",
        tokenSecretName: "OPENROUTER_API_KEY",
        icon: "stars-01",
        models: [],
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
export function findModel(providerId: string, modelId: string): ModelEntry | undefined {
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

const CAPABILITY_ORDER: Capability[] = ["tools", "images", "pdfs", "reasoning"];
const RENDERER_REASONING_LEVELS = new Set<ReasoningLevel>(["low", "medium", "high"]);

export function projectRegistryModels(
    provider: ProviderEntry,
    registryModels: readonly RegistryModelInfo[]
): ProviderEntry {
    const staticById = new Map(provider.models.map((model) => [model.id, model]));
    const models = registryModels.map((registryModel): ModelEntry => {
        const staticModel = staticById.get(registryModel.id);
        const capabilities = new Set(staticModel?.capabilities ?? []);

        if (registryModel.supportstools != null) {
            setCapability(capabilities, "tools", registryModel.supportstools);
        }
        setCapability(capabilities, "images", registryModel.inputmodalities.includes("image"));
        setCapability(capabilities, "reasoning", registryModel.reasoning);

        const reasoningLevels = registryModel.reasoning
            ? registryModel.thinkinglevels.filter((level): level is ReasoningLevel =>
                  RENDERER_REASONING_LEVELS.has(level as ReasoningLevel)
              )
            : undefined;

        return {
            ...(staticModel ?? {}),
            id: registryModel.id,
            displayName: registryModel.name ?? staticModel?.displayName ?? registryModel.id,
            capabilities: CAPABILITY_ORDER.filter((capability) => capabilities.has(capability)),
            contextWindow: registryModel.context ?? staticModel?.contextWindow ?? 0,
            ...(reasoningLevels?.length ? { reasoningLevels } : { reasoningLevels: undefined }),
        };
    });

    return { ...provider, models };
}

export function projectRegistryCatalog(
    catalog: readonly ProviderEntry[],
    states: Readonly<Record<string, RegistryModelsState>>
): ProviderEntry[] {
    return catalog.map((provider) => {
        const state = states[provider.id];
        return state?.status === "ok" ? projectRegistryModels(provider, state.models) : provider;
    });
}

function setCapability(capabilities: Set<Capability>, capability: Capability, supported: boolean): void {
    if (supported) capabilities.add(capability);
    else capabilities.delete(capability);
}
