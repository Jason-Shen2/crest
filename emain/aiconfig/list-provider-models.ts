// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// TS port of the old pkg/aiusechat/listmodels.go. Hits a provider's
// /v1/models (or equivalent) endpoint and normalizes the response into
// the ProviderModelInfo shape the renderer's picker consumes.
//
// Three provider variants:
//   - openai-compat (OpenAI, OpenRouter, Together, Mistral, Groq, DeepSeek)
//   - anthropic-messages (Anthropic, header + x-api-key)
//   - google-gemini (?key=... query string, displayName/inputTokenLimit shape)

import type { ModelCatalog } from "@crest/ai/model-catalog";
import { getSupportedThinkingLevels } from "@crest/ai/models";
import type { Api, Model } from "@crest/ai/types";
import { getSecret } from "./secrets";

const REQUEST_TIMEOUT_MS = 15_000;

// Mirror of the old wshrpc.ProviderModelInfo Go struct. Lowercase JSON
// keys preserved so the renderer doesn't need a translation layer.
export interface ProviderModelInfo {
    id: string;
    name?: string;
    description?: string;
    context?: number;
    maxoutputtokens?: number;
    promptcost?: number;
    completioncost?: number;
    imagecost?: number;
    requestcost?: number;
    inputmodalities?: string[];
    tokenizer?: string;
    ismoderated?: boolean;
    // Derived from OpenRouter's supported_parameters array. These are the
    // only authoritative *capability* facts the live /models response
    // carries — without them aggregator rows fall back to a stale static
    // snapshot. true = the model accepts that parameter; absent = the
    // endpoint didn't report it (non-OpenRouter providers).
    reasoning?: boolean;
    supportstools?: boolean;
}

// Capability-rich model metadata sourced from the authoritative
// emain/ai model registry (models.generated.ts). Unlike ProviderModelInfo
// (a thin /models HTTP echo), this carries the same reasoning / input
// modality / thinking-level facts the *backend* uses when actually
// building a request — so the picker can show capabilities that match
// what the model will really do, instead of re-deriving (or guessing)
// them from an incomplete live response.
//
// Keys are lowercase to match the ProviderModelInfo convention so the
// renderer consumes both shapes without a translation layer.
export interface RegistryModelInfo {
    id: string;
    name?: string;
    reasoning: boolean;
    // pi ThinkingLevels the model actually accepts ("off" filtered out).
    // Empty when reasoning is false.
    thinkinglevels: string[];
    inputmodalities: string[];
    context?: number;
    maxoutputtokens?: number;
    promptcost?: number;
    completioncost?: number;
}

function toRegistryModelInfo(model: Model<Api>): RegistryModelInfo {
    return {
        id: model.id,
        name: model.name,
        reasoning: !!model.reasoning,
        thinkinglevels: model.reasoning ? getSupportedThinkingLevels(model).filter((lvl) => lvl !== "off") : [],
        inputmodalities: [...(model.input ?? [])],
        context: model.contextWindow,
        maxoutputtokens: model.maxTokens,
        promptcost: model.cost?.input,
        completioncost: model.cost?.output,
    };
}

export function listRegistryModels(catalog: ModelCatalog, provider: string): RegistryModelInfo[] {
    return catalog.getModels(provider).map(toRegistryModelInfo);
}

export interface ListProviderModelsInput {
    apitype: string;
    baseurl?: string;
    apitoken?: string;
    tokensecretname?: string;
    // Optional override for the /models URL. When set, the IPC uses
    // this URL directly instead of deriving one from baseurl. Lets
    // providers whose chat and model-list endpoints live at different
    // paths (e.g. minimax: chat at /anthropic, models at /v1/models)
    // serve a live model list.  Only honored for apitypes that accept
    // a separate models URL — see the per-apitype branches below.
    modelsendpoint?: string;
}

// Match the API-type string constants from pkg/aiusechat/uctypes/userconfig.go.
export const APIType_AnthropicMessages = "anthropic-messages";
export const APIType_GoogleGemini = "google-gemini";
export const APIType_OpenAIChat = "openai-chat";
export const APIType_OpenAIResponses = "openai-responses";

export async function listProviderModels(input: ListProviderModelsInput): Promise<ProviderModelInfo[]> {
    const apiType = (input.apitype ?? "").trim();
    const baseUrl = (input.baseurl ?? "").trim();
    const apiToken = (input.apitoken ?? "").trim();
    const tokensecretname = (input.tokensecretname ?? "").trim();
    const modelsEndpoint = (input.modelsendpoint ?? "").trim();
    if (!apiType) throw new Error("apitype is required");
    validateBaseUrl(baseUrl);
    switch (apiType) {
        case APIType_AnthropicMessages:
            // Anthropic's API has never exposed a /models endpoint on
            // the chat surface, and Anthropic-compatible surfaces
            // (minimax, minimax-cn) inherit that gap. But many
            // Anthropic-compatible providers expose their authoritative
            // model list on a separate path, usually the OpenAI-
            // compatible `/v1/models` on the same host (minimax does
            // this). When the catalog declares `modelsEndpoint`, route
            // the live fetch through that URL with OpenAI-compat
            // decoding (Bearer auth, `{data: [...]}` envelope) instead
            // of trying to derive /models from the chat URL.
            if (modelsEndpoint) {
                validateBaseUrl(modelsEndpoint);
                return listOpenAiCompatibleModels(modelsEndpoint, apiToken, tokensecretname);
            }
            // No override → no live model list possible. Return [] so
            // the picker falls back to the static catalog / registry
            // path silently. Direct Anthropic users land here; minimax
            // users only land here when the catalog's `modelsEndpoint`
            // is missing or wrong.
            return [];
        case APIType_GoogleGemini:
            return listGeminiModels(baseUrl, apiToken);
        case APIType_OpenAIChat:
        case APIType_OpenAIResponses:
            return listOpenAiCompatibleModels(baseUrl, apiToken, tokensecretname);
        default:
            // Unknown apiType — best-effort try the OpenAI-compatible path.
            return listOpenAiCompatibleModels(baseUrl, apiToken, tokensecretname);
    }
}

// Guards against settings that would smuggle the user's API key to a
// non-http scheme (file://, gopher://) or to a host-less URL.
function validateBaseUrl(baseUrl: string): void {
    if (!baseUrl) return;
    let u: URL;
    try {
        u = new URL(baseUrl);
    } catch (err) {
        throw new Error(`invalid baseurl: ${(err as Error).message}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error(`baseurl must use http or https scheme, got "${u.protocol}"`);
    }
    if (!u.host) {
        throw new Error("baseurl must include a host");
    }
}

// modelsUrlFromChatUrl — derive the /models endpoint from a provider's
// configured *chat* URL. Works for OpenAI / OpenRouter / Together /
// Mistral / Groq / DeepSeek / Anthropic. Identity for already-correct URLs.
function modelsUrlFromChatUrl(chatUrl: string): string {
    if (!chatUrl) return "";
    const s = chatUrl.replace(/\/+$/, "");
    for (const suffix of ["/chat/completions", "/responses", "/messages", "/completions"]) {
        if (s.endsWith(suffix)) return s.slice(0, -suffix.length) + "/models";
    }
    if (s.endsWith("/models")) return s;
    return s + "/models";
}

async function listOpenAiCompatibleModels(
    baseUrl: string,
    apiToken: string,
    tokensecretname?: string
): Promise<ProviderModelInfo[]> {
    const endpoint = modelsUrlFromChatUrl(baseUrl) || "https://api.openai.com/v1/models";
    const headers: Record<string, string> = {};
    // Prefer the literal token when the caller passes one (testing /
    // unauthed local endpoint path). Otherwise resolve the keychain
    // secret under tokensecretname — minimax's `/v1/models` route via
    // the catalog's modelsEndpoint lands here with just the secret
    // name (no literal token in flight).
    if (apiToken) {
        headers.Authorization = `Bearer ${apiToken}`;
    } else if (tokensecretname) {
        const resolved = await getSecret(tokensecretname);
        if (resolved) headers.Authorization = `Bearer ${resolved}`;
    }
    const body = await doRequest(endpoint, { headers });
    // OpenAI returns {data: [{id, ...}]}. OpenRouter returns the same
    // envelope with name/description/context_length plus nested pricing
    // and architecture / top_provider blocks. One decode absorbs both.
    interface OaiDataItem {
        id?: string;
        name?: string;
        description?: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string; image?: string; request?: string };
        top_provider?: { max_completion_tokens?: number; is_moderated?: boolean };
        architecture?: { input_modalities?: string[]; tokenizer?: string };
        // OpenRouter only — the live capability flags. Contains entries
        // like "reasoning", "tools", "response_format", etc. for every
        // parameter the model accepts.
        supported_parameters?: string[];
    }
    const resp = JSON.parse(body) as { data?: OaiDataItem[] };
    const out: ProviderModelInfo[] = [];
    for (const m of resp.data ?? []) {
        if (!m.id) continue;
        const params = m.supported_parameters;
        out.push({
            id: m.id,
            name: m.name,
            description: m.description,
            context: m.context_length,
            maxoutputtokens: m.top_provider?.max_completion_tokens,
            promptcost: parseUsdRate(m.pricing?.prompt),
            completioncost: parseUsdRate(m.pricing?.completion),
            imagecost: parseUsdRate(m.pricing?.image),
            requestcost: parseUsdRate(m.pricing?.request),
            inputmodalities: m.architecture?.input_modalities,
            tokenizer: m.architecture?.tokenizer,
            ismoderated: m.top_provider?.is_moderated,
            // Leave undefined when the endpoint omits supported_parameters
            // (non-OpenRouter) so the picker can tell "no capability data"
            // apart from "explicitly unsupported".
            reasoning: params ? params.includes("reasoning") : undefined,
            supportstools: params ? params.includes("tools") : undefined,
        });
    }
    return sortModels(out);
}

async function listAnthropicModels(baseUrl: string, apiToken: string): Promise<ProviderModelInfo[]> {
    if (!apiToken) throw new Error("Anthropic /models requires an API key");
    const endpoint = modelsUrlFromChatUrl(baseUrl) || "https://api.anthropic.com/v1/models";
    const body = await doRequest(endpoint, {
        headers: {
            "x-api-key": apiToken,
            "anthropic-version": "2023-06-01",
        },
    });
    interface AnthropicItem {
        id?: string;
        display_name?: string;
    }
    const resp = JSON.parse(body) as { data?: AnthropicItem[] };
    const out: ProviderModelInfo[] = [];
    for (const m of resp.data ?? []) {
        if (!m.id) continue;
        out.push({ id: m.id, name: m.display_name });
    }
    return sortModels(out);
}

async function listGeminiModels(baseUrl: string, apiToken: string): Promise<ProviderModelInfo[]> {
    if (!apiToken) throw new Error("Gemini /models requires an API key");
    // Gemini puts the key in the query string. The chat URL is per-model
    // (.../models/<id>:streamGenerateContent), so derive the v1beta root
    // by snipping at /models, then list at /models with ?key=...
    const endpoint = geminiModelsUrl(baseUrl);
    const parsed = new URL(endpoint);
    parsed.searchParams.set("key", apiToken);
    const body = await doRequest(parsed.toString(), { headers: {} });
    interface GeminiItem {
        name?: string;
        displayName?: string;
        description?: string;
        inputTokenLimit?: number;
        supportedGenerationMethods?: string[];
    }
    const resp = JSON.parse(body) as { models?: GeminiItem[] };
    const out: ProviderModelInfo[] = [];
    for (const m of resp.models ?? []) {
        if (!supportsGeneration(m.supportedGenerationMethods)) continue;
        const id = (m.name ?? "").replace(/^models\//, "");
        if (!id) continue;
        out.push({
            id,
            name: m.displayName,
            description: m.description,
            context: m.inputTokenLimit,
        });
    }
    return sortModels(out);
}

function geminiModelsUrl(chatUrl: string): string {
    if (!chatUrl) return "https://generativelanguage.googleapis.com/v1beta/models";
    const s = chatUrl.replace(/\/+$/, "");
    const idx = s.indexOf("/models");
    if (idx >= 0) return s.slice(0, idx) + "/models";
    return s + "/models";
}

function supportsGeneration(methods?: string[]): boolean {
    if (!methods) return false;
    return methods.includes("generateContent") || methods.includes("streamGenerateContent");
}

function parseUsdRate(s?: string): number {
    if (!s) return 0;
    const v = Number.parseFloat(s.trim());
    return Number.isFinite(v) ? v : 0;
}

function sortModels(models: ProviderModelInfo[]): ProviderModelInfo[] {
    return models.sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
}

async function doRequest(
    url: string,
    init: { headers: Record<string, string> },
    timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { method: "GET", headers: init.headers, signal: ctrl.signal });
        const text = await res.text();
        if (res.status < 200 || res.status >= 300) {
            const snippet = text.length > 500 ? text.slice(0, 500) + "..." : text;
            throw new Error(`provider returned ${res.status}: ${snippet}`);
        }
        return text;
    } catch (err: unknown) {
        if ((err as Error).name === "AbortError") {
            throw new Error(`request timed out after ${timeoutMs}ms`);
        }
        if (err instanceof TypeError && err.message === "fetch failed") {
            throw new Error(`fetch failed for ${url}: ${formatFetchCause(err)}`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function formatFetchCause(err: TypeError): string {
    const cause = (err as TypeError & { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    if (cause && typeof cause === "object") {
        const details = cause as {
            code?: unknown;
            errno?: unknown;
            syscall?: unknown;
            address?: unknown;
            port?: unknown;
        };
        if (details.code === "ECONNREFUSED" && details.address === "127.0.0.1") {
            return `proxy connection refused at ${details.address}:${details.port}; check HTTP_PROXY/HTTPS_PROXY or start the local proxy`;
        }
        return [details.code, details.errno, details.syscall, details.address, details.port]
            .filter((part) => part !== undefined && part !== "")
            .join(" ");
    }
    return err.message;
}
