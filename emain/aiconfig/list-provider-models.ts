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
}

export interface ListProviderModelsInput {
    apitype: string;
    baseurl?: string;
    apitoken?: string;
}

// Match the API-type string constants from pkg/aiusechat/uctypes/userconfig.go.
export const APIType_AnthropicMessages = "anthropic-messages";
export const APIType_GoogleGemini = "google-gemini";
export const APIType_OpenAIChat = "openai-chat";
export const APIType_OpenAIResponses = "openai-responses";

export async function listProviderModels(
    input: ListProviderModelsInput,
): Promise<ProviderModelInfo[]> {
    const apiType = (input.apitype ?? "").trim();
    const baseUrl = (input.baseurl ?? "").trim();
    const apiToken = (input.apitoken ?? "").trim();
    if (!apiType) throw new Error("apitype is required");
    validateBaseUrl(baseUrl);
    switch (apiType) {
        case APIType_AnthropicMessages:
            return listAnthropicModels(baseUrl, apiToken);
        case APIType_GoogleGemini:
            return listGeminiModels(baseUrl, apiToken);
        case APIType_OpenAIChat:
        case APIType_OpenAIResponses:
            return listOpenAiCompatibleModels(baseUrl, apiToken);
        default:
            // Unknown apiType — best-effort try the OpenAI-compatible path.
            return listOpenAiCompatibleModels(baseUrl, apiToken);
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
): Promise<ProviderModelInfo[]> {
    const endpoint = modelsUrlFromChatUrl(baseUrl) || "https://api.openai.com/v1/models";
    const headers: Record<string, string> = {};
    if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
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
    }
    const resp = JSON.parse(body) as { data?: OaiDataItem[] };
    const out: ProviderModelInfo[] = [];
    for (const m of resp.data ?? []) {
        if (!m.id) continue;
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
        });
    }
    return sortModels(out);
}

async function listAnthropicModels(
    baseUrl: string,
    apiToken: string,
): Promise<ProviderModelInfo[]> {
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

async function listGeminiModels(
    baseUrl: string,
    apiToken: string,
): Promise<ProviderModelInfo[]> {
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
): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(url, { method: "GET", headers: init.headers, signal: ctrl.signal });
        const text = await res.text();
        if (res.status < 200 || res.status >= 300) {
            // Surface the upstream body verbatim (truncated) so the user can
            // see "invalid api key" / etc. directly in the picker.
            const snippet = text.length > 500 ? text.slice(0, 500) + "..." : text;
            throw new Error(`provider returned ${res.status}: ${snippet}`);
        }
        return text;
    } catch (err: unknown) {
        if ((err as Error).name === "AbortError") {
            throw new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
