// Smoke runner — runs the same assertions as ai-resolver.test.ts via
// plain Node + tsx, bypassing vitest because this env's node_modules
// has corrupted oxc-resolver and picomatch installs.  Delete once
// vitest is back (npm reinstall).
//
// Run with: node_modules/.bin/tsx frontend/app/store/ai-resolver-smoke.ts

import type { ProviderEntry } from "./ai-catalog";
import { resolveAIConfig } from "./ai-resolver";
import type { UserConfig } from "./ai-types";

const CATALOG: ProviderEntry[] = [
    {
        id: "openai",
        displayName: "OpenAI",
        defaultEndpoint: "https://api.openai.com/v1/responses",
        defaultApiType: "openai-responses",
        tokenSecretName: "OPENAI_API_KEY",
        icon: "stars-01",
        models: [
            { id: "gpt-5", displayName: "GPT-5", capabilities: ["tools", "reasoning"], contextWindow: 200000, reasoningLevels: ["low", "medium", "high"] },
            { id: "gpt-4o", displayName: "GPT-4o", capabilities: ["tools"], contextWindow: 128000, apiTypeOverride: "openai-chat" },
        ],
    },
    {
        id: "google",
        displayName: "Gemini",
        defaultEndpoint: "https://example.com/v1/models/{model}:run",
        defaultApiType: "google-gemini",
        tokenSecretName: "GOOGLE_AI_KEY",
        icon: "stars-01",
        models: [{ id: "gemini-flash", displayName: "Gemini Flash", capabilities: ["tools"], contextWindow: 1000000 }],
    },
];

const CFG: UserConfig = {
    providers: {
        openai: { tokensecretname: "OPENAI_API_KEY" },
        google: { tokensecretname: "GOOGLE_AI_KEY" },
    },
    default: { provider: "openai", model: "gpt-5" },
};

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
    if (cond) {
        pass++;
        console.log("  ✓", name);
    } else {
        fail++;
        console.error("  ✗", name, detail ?? "");
    }
}

console.log("happy path");
{
    const r = resolveAIConfig({ provider: "openai", model: "gpt-5" }, CFG, CATALOG);
    check("ok", r.ok);
    if (r.ok) {
        check("endpoint", r.config.endpoint === "https://api.openai.com/v1/responses");
        check("apitype", r.config.apitype === "openai-responses");
        check("caps", r.config.capabilities.join(",") === "tools,reasoning");
        check("contextwindow", r.config.contextwindow === 200000);
        check("tokensecretname", r.config.tokensecretname === "OPENAI_API_KEY");
        check("no reasoning unless requested", r.config.reasoning === undefined);
        check("no literal token", r.config.token === undefined);
    }
}

console.log("default fallback (selection undefined)");
{
    const r = resolveAIConfig(undefined, CFG, CATALOG);
    if (r.ok) check("falls back to default", r.config.model === "gpt-5");
    else check("ok", false, r.error);
}

console.log("apitypeoverride beats provider default");
{
    const r = resolveAIConfig({ provider: "openai", model: "gpt-4o" }, CFG, CATALOG);
    if (r.ok) check("openai-chat for gpt-4o", r.config.apitype === "openai-chat");
}

console.log("{model} substitution");
{
    const r = resolveAIConfig({ provider: "google", model: "gemini-flash" }, CFG, CATALOG);
    if (r.ok) check("substituted", r.config.endpoint === "https://example.com/v1/models/gemini-flash:run", r.config.endpoint);
}

console.log("reasoning gating");
{
    const r1 = resolveAIConfig({ provider: "openai", model: "gpt-5", reasoning: "high" }, CFG, CATALOG);
    if (r1.ok) check("forwarded when supported", r1.config.reasoning === "high");
    const r2 = resolveAIConfig({ provider: "openai", model: "gpt-4o", reasoning: "high" }, CFG, CATALOG);
    if (r2.ok) check("dropped when unsupported", r2.config.reasoning === undefined);
}

console.log("credential precedence");
{
    const cfg: UserConfig = { ...CFG, providers: { openai: { token: "sk-lit", tokensecretname: "X" }, google: { tokensecretname: "Y" } } };
    const r = resolveAIConfig({ provider: "openai", model: "gpt-5" }, cfg, CATALOG);
    if (r.ok) {
        check("literal wins", r.config.token === "sk-lit");
        check("secretname dropped when literal set", r.config.tokensecretname === undefined);
    }
}

console.log("empty tokensecretname (local unauthed)");
{
    const cfg: UserConfig = { providers: { openai: { tokensecretname: "" } }, default: { provider: "openai", model: "gpt-5" } };
    const r = resolveAIConfig({ provider: "openai", model: "gpt-5" }, cfg, CATALOG);
    if (r.ok) check("empty kept", r.config.tokensecretname === "");
}

console.log("custom_endpoints");
{
    const cfg: UserConfig = {
        providers: { "vllm-local": { tokensecretname: "" } },
        default: { provider: "vllm-local", model: "qwen-coder-32b" },
        custom_endpoints: {
            "vllm-local": {
                displayname: "Local vLLM",
                endpoint: "http://localhost:8000/v1/chat/completions",
                apitype: "openai-chat",
                tokensecretname: "",
                models: [{ id: "qwen-coder-32b", displayName: "Qwen 2.5 Coder", capabilities: ["tools"], contextWindow: 128000 }],
            },
        },
    };
    const r = resolveAIConfig({ provider: "vllm-local", model: "qwen-coder-32b" }, cfg, CATALOG);
    if (r.ok) {
        check("endpoint", r.config.endpoint === "http://localhost:8000/v1/chat/completions");
        check("apitype", r.config.apitype === "openai-chat");
    } else check("ok", false, r.error);
}

console.log("custom_models");
{
    const cfg: UserConfig = {
        ...CFG,
        custom_models: [{ provider: "openai", id: "gpt-x", displayname: "GPT X", capabilities: ["tools"], contextwindow: 50000 }],
    };
    const r = resolveAIConfig({ provider: "openai", model: "gpt-x" }, cfg, CATALOG);
    if (r.ok) {
        check("resolved", r.config.model === "gpt-x");
        check("inherits provider apitype", r.config.apitype === "openai-responses");
        check("contextwindow", r.config.contextwindow === 50000);
    } else check("ok", false, r.error);
}

console.log("error paths");
{
    const r = resolveAIConfig({ provider: "openai", model: "gpt-5" }, undefined, CATALOG);
    check("no_config", !r.ok && r.error.code === "no_config");
}
{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = resolveAIConfig(undefined, { providers: { openai: { tokensecretname: "X" } } } as any, CATALOG);
    check("no_default", !r.ok && r.error.code === "no_default");
}
{
    const r = resolveAIConfig({ provider: "nope", model: "x" }, CFG, CATALOG);
    check("unknown_provider", !r.ok && r.error.code === "unknown_provider");
}
{
    const r = resolveAIConfig({ provider: "openai", model: "gpt-9000" }, CFG, CATALOG);
    check("unknown_model", !r.ok && r.error.code === "unknown_model");
}
{
    const cfg: UserConfig = { providers: {}, default: { provider: "openai", model: "gpt-5" } };
    const r = resolveAIConfig({ provider: "openai", model: "gpt-5" }, cfg, CATALOG);
    check("no_credentials", !r.ok && r.error.code === "no_credentials");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
