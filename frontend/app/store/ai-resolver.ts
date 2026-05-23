// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AI config resolver — converts a user's selection (provider + model +
// optional reasoning) into a fully-resolved ResolvedAIConfig the agent
// backend can consume directly.  Single source of truth for catalog
// vs custom lookup precedence and credential routing.
//
// Design: see docs/ai-config-architecture.md §6.
//
// Flow:
//   1. Find provider — catalog first, then user_config.custom_endpoints.
//   2. Find model — provider.models first, then user_config.custom_models.
//   3. Read credentials from user_config.providers (literal token wins
//      over secretstore name when both set; we log via the warning slot).
//   4. Drop reasoning silently if the resolved model doesn't support it.
//   5. Substitute the {model} template in the endpoint URL.
//   6. Compose ResolvedAIConfig; return as a discriminated union with
//      typed error codes for the UI to switch on.

import {
    CATALOG,
    ProviderEntry,
    ModelEntry,
    ApiType,
    Capability,
    resolveApiType,
    resolveEndpoint,
} from "./ai-catalog";
import {
    AgentSelection,
    ResolvedAIConfig,
    ResolveResult,
    UserConfig,
} from "./ai-types";
// UserCustomEndpoint and UserCustomModel are ambient gotypes — no
// import needed.  See ai-types.ts for the rationale.

export function resolveAIConfig(
    selection: AgentSelection | undefined,
    userConfig: UserConfig | undefined,
    catalog: ProviderEntry[] = CATALOG
): ResolveResult {
    if (!userConfig) {
        return {
            ok: false,
            error: {
                code: "no_config",
                message:
                    "AI config not loaded. Create ~/.config/crest/ai.json with at least one provider and a default selection.",
            },
        };
    }
    // selection is allowed to be undefined — we fall back to the
    // user's default.  If both are missing, fail.
    const effective = selection ?? userConfig.default;
    if (!effective) {
        return {
            ok: false,
            error: {
                code: "no_default",
                message: "No selection and no default in ai.json. Add a `default` block.",
            },
        };
    }

    // Step 1 — locate provider.  Catalog beats custom_endpoints when
    // the id collides (catalog is canonical; users shouldn't shadow
    // built-ins).  Result is a tuple of (provider data, isCustom) so
    // the rest of the resolver can branch on origin where needed.
    const catalogProvider = catalog.find((p) => p.id === effective.provider);
    const customEndpoint =
        userConfig.custom_endpoints?.[effective.provider] as UserCustomEndpoint | undefined;
    if (!catalogProvider && !customEndpoint) {
        return {
            ok: false,
            error: {
                code: "unknown_provider",
                message: `Unknown provider "${effective.provider}".  Add it to catalog or define in ai.json custom_endpoints.`,
                hint: { provider: effective.provider },
            },
        };
    }

    // Step 2 — locate model.  Search the provider's own model list
    // first, then user_config.custom_models filtered by provider id.
    let model: ResolvedModelView | undefined;
    if (catalogProvider) {
        const m = catalogProvider.models.find((mm) => mm.id === effective.model);
        if (m) model = viewFromCatalogModel(m, catalogProvider);
    }
    if (!model && customEndpoint) {
        const m = customEndpoint.models.find((mm) => mm.id === effective.model);
        if (m) model = viewFromCustomEndpointModel(m, customEndpoint);
    }
    if (!model) {
        const custom = userConfig.custom_models?.find(
            (cm) => cm.provider === effective.provider && cm.id === effective.model
        );
        if (custom) model = viewFromCustomModel(custom, catalogProvider, customEndpoint);
    }
    // Catalog-provider-defaults fallback. Two cases this serves:
    //
    //   1. kind: "aggregator" (OpenRouter et al) — catalog.models[] is
    //      empty by design, live /models is authoritative. The id the
    //      user picked came from the live list; we use provider defaults
    //      for endpoint/apitype since aggregators don't vary those per
    //      model.
    //
    //   2. kind: "direct" (OpenAI, Anthropic, Google) — user picked a
    //      newer model the curated catalog hasn't picked up yet but
    //      that's in the provider's live /models response. Same path:
    //      provider defaults for endpoint/apitype work because direct
    //      providers also don't vary those per model (apiTypeOverride
    //      on ModelEntry is the explicit per-model escape hatch, and
    //      it only applies when the model IS in catalog.models).
    //
    // Capabilities / contextWindow default to the empty shape — the
    // backend treats them as "unknown" rather than failing. UX win in
    // Phase D: the chip / picker shows live name+context, the resolver
    // synthesizes a request, the agent runs. Catalog and live now use
    // the same fallback chain — no more "configured but unsendable".
    if (!model && catalogProvider) {
        model = viewFromCatalogProviderDefaults(effective.model, catalogProvider);
    }
    if (!model) {
        return {
            ok: false,
            error: {
                code: "unknown_model",
                message: `Model "${effective.model}" is not configured for provider "${effective.provider}".`,
                hint: { provider: effective.provider, model: effective.model },
            },
        };
    }

    // Step 3 — credentials.  An empty tokensecretname is valid (some
    // local endpoints accept unauthed requests) but the providers
    // entry must exist so the user has explicitly opted into using
    // this provider.
    const creds = userConfig.providers?.[effective.provider];
    if (!creds) {
        return {
            ok: false,
            error: {
                code: "no_credentials",
                message: `No credentials configured for provider "${effective.provider}".  Add it to ai.json providers.`,
                hint: { provider: effective.provider },
            },
        };
    }

    // Step 4 — reasoning gate.  Silently drop the level when the
    // model doesn't support it (rather than error) so the UI can
    // safely persist `reasoning` on a selection and have it survive a
    // model switch.
    const reasoning =
        effective.reasoning && model.capabilities.includes("reasoning")
            ? effective.reasoning
            : undefined;

    // Step 5 — compose.  Token literal wins over secret name when
    // both are set (testing path).  Only one of the two is forwarded
    // so the backend doesn't have to decide.
    const config: ResolvedAIConfig = {
        provider: effective.provider,
        model: model.id,
        endpoint: model.endpoint,
        apitype: model.apiType,
        capabilities: model.capabilities,
        contextwindow: model.contextWindow,
        ...(reasoning ? { reasoning } : {}),
        ...(creds.token
            ? { token: creds.token }
            : creds.tokensecretname != null
                ? { tokensecretname: creds.tokensecretname }
                : {}),
    };
    return { ok: true, config };
}

// =========================================================================
// internal: a unified view over the three possible model sources
// =========================================================================
//
// Each branch (catalog model / custom_endpoints model / custom_models
// entry) resolves to a common shape with endpoint + apitype already
// substituted, so the composer above doesn't need to repeat the lookup
// logic per branch.

interface ResolvedModelView {
    id: string;
    endpoint: string;
    apiType: ApiType;
    capabilities: Capability[];
    contextWindow: number;
}

function viewFromCatalogModel(model: ModelEntry, provider: ProviderEntry): ResolvedModelView {
    return {
        id: model.id,
        endpoint: resolveEndpoint(provider, model),
        apiType: resolveApiType(provider, model),
        capabilities: model.capabilities,
        contextWindow: model.contextWindow,
    };
}

function viewFromCustomEndpointModel(
    model: Omit<ModelEntry, "apiTypeOverride">,
    endpoint: UserCustomEndpoint
): ResolvedModelView {
    return {
        id: model.id,
        endpoint: endpoint.endpoint.replace("{model}", model.id),
        // Custom endpoints don't support per-model apitype overrides
        // (design decision §13.4) — apitype is endpoint-level only.
        apiType: endpoint.apitype,
        capabilities: model.capabilities,
        contextWindow: model.contextWindow,
    };
}

function viewFromCatalogProviderDefaults(
    modelId: string,
    provider: ProviderEntry
): ResolvedModelView {
    return {
        id: modelId,
        endpoint: provider.defaultEndpoint.replace("{model}", modelId),
        apiType: provider.defaultApiType,
        capabilities: [],
        contextWindow: 0,
    };
}

function viewFromCustomModel(
    custom: UserCustomModel,
    catalogProvider: ProviderEntry | undefined,
    customEndpoint: UserCustomEndpoint | undefined
): ResolvedModelView {
    // A custom_models entry must reference a known provider id.  Its
    // own apitypeoverride beats the provider default; failing that we
    // inherit from whichever provider object we found.
    const baseApi = catalogProvider?.defaultApiType ?? customEndpoint?.apitype;
    if (!baseApi) {
        // Should be unreachable — caller already checked provider exists.
        throw new Error(`custom model ${custom.id} has no resolvable apitype`);
    }
    const baseEndpoint = catalogProvider?.defaultEndpoint ?? customEndpoint?.endpoint ?? "";
    return {
        id: custom.id,
        endpoint: baseEndpoint.replace("{model}", custom.id),
        apiType: custom.apitypeoverride ?? baseApi,
        capabilities: custom.capabilities,
        contextWindow: custom.contextwindow,
    };
}
