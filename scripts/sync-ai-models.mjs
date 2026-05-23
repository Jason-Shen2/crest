// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// sync-ai-models.mjs — pulls the LiteLLM model registry (the de-facto
// industry standard for "what LLMs exist with what capabilities") and
// emits frontend/app/store/ai-catalog-models.gen.ts, the model-level
// portion of crest's AI catalog.
//
// Why LiteLLM:
//   - 2700+ models with capability + context window metadata.
//   - Maintained by an active OSS project; many downstream tools
//     (Aider, OpenWebUI, ...) sync from the same source.
//   - Reduces our manual catalog drift to provider-level facts only
//     (endpoint, apitype, token secret name) which actually are stable.
//
// What this script does NOT touch:
//   - Provider-level entries (ai-catalog.ts CATALOG array) — those are
//     curated because LiteLLM doesn't model the endpoint/apitype split
//     crest needs (responses vs chat completions, gemini's per-model URL
//     template, openrouter as aggregator, etc.).
//
// Usage:
//   node scripts/sync-ai-models.mjs                 # writes the .gen.ts
//   node scripts/sync-ai-models.mjs --dry-run       # prints stats only
//
// Wired into Taskfile.yml as `task sync:models`.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE_URL =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OUTPUT_FILE = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "frontend",
    "app",
    "store",
    "ai-catalog-models.gen.ts"
);

// LiteLLM provider id → crest provider id (kind: "direct" only).
// Aggregators (openrouter) are intentionally absent: their model list
// is fetched live from the upstream /models endpoint at picker open
// time; baking it in here would re-introduce the drift this whole
// refactor was meant to kill.
const PROVIDER_MAP = {
    openai: "openai",
    anthropic: "anthropic",
    gemini: "google",
    // vertex_ai is the same family but exposed via Google's enterprise
    // endpoint — skip for v1 to avoid duplicate ids; users on Vertex
    // configure it via ai.json custom_endpoints today.
};

// Modal/non-text variants we never want in the chat picker. Some are
// chat mode in LiteLLM but useless from a "talk to the model" stance.
const ID_BLOCKLIST_SUBSTR = [
    "audio",
    "realtime",
    "search-api",
    "image",
    "embedding",
    "tts",
    "whisper",
    "transcribe",
    "moderation",
    "rerank",
];

// apiTypeOverride heuristic: anything in the gpt-3.x / gpt-4 / gpt-4o
// / gpt-4-turbo families uses the OpenAI Chat Completions API (the old
// one). Newer gpt-5+ / o-series use the Responses API. The provider
// default is "openai-responses"; we tag the legacy families.
function openaiApiTypeOverride(id) {
    if (/^(gpt-3|gpt-4(?![5-9])|gpt-4o|gpt-4-turbo)/.test(id)) {
        return "openai-chat";
    }
    return null; // use provider default
}

// Strip the LiteLLM-style "provider/" prefix some keys carry. Gemini
// is the main offender ("gemini/gemini-2.5-pro" → "gemini-2.5-pro").
function stripProviderPrefix(key, litellmProvider) {
    if (litellmProvider && key.startsWith(`${litellmProvider}/`)) {
        return key.slice(litellmProvider.length + 1);
    }
    return key;
}

// Heuristic to drop dated variants when the un-dated alias also exists.
// LiteLLM lists both "claude-opus-4-7" and "claude-opus-4-7-20260416" —
// we want the alias only.
function isDatedVariant(id) {
    return /-\d{8}$|-\d{4}-\d{2}-\d{2}$/.test(id);
}
function dateStrippedBase(id) {
    return id
        .replace(/-\d{8}$/, "")
        .replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

// Title-case fallback when LiteLLM doesn't ship a friendly name.
// Examples:
//   "gpt-5-mini"          → "GPT-5 Mini"
//   "claude-opus-4-7"     → "Claude Opus 4.7"
//   "gemini-2.5-pro"      → "Gemini 2.5 Pro"
//   "o3-mini"             → "o3 Mini"   (preserve "o3" as written)
//
// Heuristics — kept narrow so we don't break less common ids:
//   - "gpt" prefix uppercases (gpt-5 → GPT-5), hyphen kept before digits.
//   - "claude-opus-4-7" → "4.7" (rejoin trailing single-digit segments
//     with a dot rather than space when the head looks like "vendor model
//     major minor").
//   - Single-letter prefixes (o1, o3, o4) keep their lower case.
const ACRONYMS = new Set(["gpt", "ai", "api", "tts"]);
function deriveDisplayName(id) {
    const parts = id.split("-");
    // Detect a numeric tail like ["4", "7"] (major + minor → "4.7")
    // when the head ends with a non-numeric token. Only merge when
    // there are 2+ trailing numeric segments (otherwise "gpt-5" would
    // wrongly become "GPT 5" — single-digit tails stay attached to
    // the head via the normal join below).
    const numTailCount = (() => {
        let n = 0;
        for (let i = parts.length - 1; i >= 0 && /^\d+$/.test(parts[i]); i--) n++;
        return n;
    })();
    let numericTail = "";
    if (numTailCount >= 2) {
        const tail = parts.splice(parts.length - numTailCount, numTailCount);
        numericTail = tail.join(".");
    }
    const headLabel = parts
        .map((part) => {
            if (ACRONYMS.has(part.toLowerCase())) return part.toUpperCase();
            if (/^o\d+$/.test(part)) return part; // o1/o3/o4 stay lowercase
            return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(/^gpt$/i.test(parts[0] ?? "") ? "-" : " ")
        .replace(/^GPT (\d)/, "GPT-$1");
    return numericTail ? `${headLabel} ${numericTail}`.trim() : headLabel;
}

// LiteLLM → crest capability set. Only flag a capability when LiteLLM
// explicitly says true; null/undefined means "unknown" and we omit
// (resolver treats absent capabilities as "feature disabled" which is
// the safe default — model might silently fail rather than crash).
function mapCapabilities(entry) {
    const caps = [];
    if (entry.supports_function_calling === true) caps.push("tools");
    if (entry.supports_vision === true) caps.push("images");
    // LiteLLM has no clean "pdfs" flag — supports_pdf_input is rare
    // and inconsistent. Punt: crest's catalog never sets it from sync.
    if (entry.supports_reasoning === true) caps.push("reasoning");
    return caps;
}

function shouldKeep(key, entry) {
    if (entry.mode !== "chat") return false;
    if (key.startsWith("ft:")) return false; // fine-tuned variants
    for (const sub of ID_BLOCKLIST_SUBSTR) {
        if (key.toLowerCase().includes(sub)) return false;
    }
    // No context window / no max_tokens almost always means this isn't
    // a real chat model in the picker sense (e.g. OpenAI's "container",
    // which is a tool-use surface, not a model id you'd send messages to).
    const ctx = entry.max_input_tokens ?? entry.max_tokens ?? 0;
    if (!ctx) return false;
    return true;
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");

    console.log(`Fetching ${SOURCE_URL} ...`);
    const res = await fetch(SOURCE_URL);
    if (!res.ok) {
        throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
    }
    const raw = await res.json();
    delete raw.sample_spec;

    // Group by crest provider id, dedup dated variants per provider.
    const byProvider = {};
    for (const crestId of Object.values(PROVIDER_MAP)) {
        byProvider[crestId] = [];
    }

    for (const [rawKey, entry] of Object.entries(raw)) {
        const llmProvider = entry.litellm_provider;
        const crestProvider = PROVIDER_MAP[llmProvider];
        if (!crestProvider) continue;
        if (!shouldKeep(rawKey, entry)) continue;
        const id = stripProviderPrefix(rawKey, llmProvider);
        byProvider[crestProvider].push({ id, entry });
    }

    // Dedup dated variants per provider — drop "foo-20251001" when
    // "foo" is also present.
    for (const crestId of Object.keys(byProvider)) {
        const list = byProvider[crestId];
        const aliases = new Set(
            list.filter(({ id }) => !isDatedVariant(id)).map(({ id }) => id)
        );
        byProvider[crestId] = list.filter(({ id }) => {
            if (!isDatedVariant(id)) return true;
            return !aliases.has(dateStrippedBase(id));
        });
    }

    // Build the final ModelEntry shape per provider.
    const modelsByProvider = {};
    for (const [crestProvider, items] of Object.entries(byProvider)) {
        items.sort((a, b) => a.id.localeCompare(b.id));
        modelsByProvider[crestProvider] = items.map(({ id, entry }) => {
            const m = {
                id,
                displayName: deriveDisplayName(id),
                capabilities: mapCapabilities(entry),
                contextWindow:
                    entry.max_input_tokens ?? entry.max_tokens ?? 0,
            };
            if (m.capabilities.includes("reasoning")) {
                // LiteLLM doesn't tell us which levels a model accepts.
                // Default to the full triple; resolver will silently
                // drop levels the model rejects via the existing
                // capability gate.
                m.reasoningLevels = ["low", "medium", "high"];
            }
            if (crestProvider === "openai") {
                const override = openaiApiTypeOverride(id);
                if (override) m.apiTypeOverride = override;
            }
            return m;
        });
    }

    // Stats for visibility.
    for (const [p, models] of Object.entries(modelsByProvider)) {
        console.log(`  ${p}: ${models.length} models`);
    }

    if (dryRun) {
        console.log("(dry-run: no file written)");
        return;
    }

    const fetchedAt = new Date().toISOString();
    const body = `// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AUTO-GENERATED — do not edit by hand.
// Source:  scripts/sync-ai-models.mjs
// Upstream: ${SOURCE_URL}
// Fetched: ${fetchedAt}
//
// Re-run via:  task sync:models   (or  node scripts/sync-ai-models.mjs)
//
// Per-provider model lists derived from the LiteLLM registry. Curated
// provider-level entries (endpoint, apitype, token secret name, kind)
// continue to live in ai-catalog.ts; this file supplies only the
// "what models does each provider offer + with what capabilities"
// half.

import type { ApiType, Capability, ModelEntry, ReasoningLevel } from "./ai-catalog";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _GuardImports = ApiType | Capability | ReasoningLevel;

export const MODELS_BY_PROVIDER: Record<string, ModelEntry[]> = ${JSON.stringify(
        modelsByProvider,
        null,
        4
    )};
`;
    await writeFile(OUTPUT_FILE, body, "utf8");
    console.log(`Wrote ${OUTPUT_FILE}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
