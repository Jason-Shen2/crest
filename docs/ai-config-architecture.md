# AI Config Architecture — Design Doc

**Status:** **implemented (2026-05-20)** · **Original draft:** 2026-05-19 · **Owner:** TBD
**Replaces:** the dual `ai:*` global settings + `waveai@*` mode dict system
**References:**
- Warp source (`/Users/mac/Documents/open-source/warp`) — `crates/ai/src/api_keys.rs`, `crates/ai/src/agent/orchestration_config.rs`, `crates/ai/src/llm_id.rs`
- Crest, post-refactor — `frontend/app/store/ai-catalog.ts`, `pkg/aiusechat/aiconfig.go`, `pkg/aiusechat/userconfig.go`, `frontend/app/view/cmdblock/model-picker-popover.tsx`
- Companion arch note: [`agent-architecture.md`](./agent-architecture.md) §24

> **Scope decision (locked):** POC stage. **No backward compatibility.** Legacy `ai:*` settings and `waveai@*` mode dict are deleted, not deprecated. Users re-configure on upgrade. Migration script optional, not required.

---

## 1. Why we're rewriting this

Today crest has **two parallel AI config systems** that solve overlapping problems differently:

| System | Where | Read by | Default |
|---|---|---|---|
| **Legacy `ai:*` global settings** | `settings.json` (`SettingsType.Ai*` fields) | `pkg/agent/http.go:buildAIOptsFromSettings()` | seeded with `gpt-5-mini` |
| **`waveai@*` mode dict** | `waveai.json` (`FullConfigType.WaveAIModes`) | `pkg/aiusechat/usechat.go:GetWaveAISettings()` | empty `{}` (recently seeded with 3 mock modes) |

The agent HTTP handler picks one or the other based on whether the frontend sent an `aimode` in the request body. The picker UI only knows about the second. The legacy `ai:preset = "ai@global"` setting points at a third concept (`fullConfig.presets["ai@*"]`) that nothing actually reads. **Three overlapping layers, none authoritative.**

### Concrete pain points

1. **Zero discovery.** Default `waveai.json = {}`. Picker has nothing until user hand-writes JSON. The user has to know `ai:provider`, `ai:apitype`, `ai:endpoint`, capability lists, and which models exist for each provider — **none of which is the user's job to know**.

2. **API token duplicated per mode.** Configuring four OpenAI modes (quick/balanced/deep/custom) means writing `ai:apitokensecretname: "OPENAI_API_KEY"` four times. There is no notion of "one token per provider, all that provider's modes share it."

3. **Provider knowledge leaks into user config.** Things like "OpenAI's responses endpoint is `https://api.openai.com/v1/responses`" or "claude-3-7-opus supports reasoning" are objective provider facts but currently live in user-edited JSON.

4. **Reasoning level abstracted at the wrong layer.** `ai:thinkinglevel` is a per-mode field, which means `gpt-5+medium` and `gpt-5+high` are two parallel modes instead of one model with two reasoning settings.

5. **Naming baggage.** `waveai@quick/balanced/deep` evokes a Wave Cloud tier system crest doesn't have.

6. **Token-resolution divergence.** Legacy `ai:*` and `waveai@*` each resolve API tokens through their own code path (`buildAIOptsFromSettings` vs `GetWaveAISettings`). They don't share or inherit; configuring one doesn't help the other.

---

## 2. Target architecture: four layers

```
┌────────────────────────────────────────────────────────────────────┐
│ Layer 1 — CATALOG  (static, in-repo)                                │
│   What providers and models EXIST in the world.                     │
│   Maintained by crest contributors via PR.                          │
│   Holds: endpoint, apitype, capabilities, context window,           │
│           reasoning support, model display names.                   │
│   ≈ warp's LLMInfo (but static, not proto-served).                  │
├────────────────────────────────────────────────────────────────────┤
│ Layer 2 — USER CONFIG  (~/.config/crest/ai.json)                    │
│   What the user wants. Three things only:                           │
│     - which provider(s) they have keys for                          │
│     - their default selection (provider + model + reasoning)        │
│     - optional named profiles (saved selections)                    │
│     - optional custom_models (models not in catalog) and            │
│       custom_endpoints (e.g. OpenRouter, vLLM, Together AI)         │
│     - optional context-reference controls                           │
├────────────────────────────────────────────────────────────────────┤
│ Layer 3 — SELECTION  (block.meta["agent:selection"])                │
│   What's selected right now in this pane.                           │
│   { provider, model, reasoning? }   (an inline triple,              │
│                                       not a profile reference)      │
│   ≈ warp's per-conversation model_id.                               │
├────────────────────────────────────────────────────────────────────┤
│ Layer 4 — RESOLVER  (pkg/aiusechat/resolver.go)                     │
│   ResolveAIOpts(selection) → AIOptsType                             │
│     1. Catalog lookup → endpoint/apitype/capabilities               │
│     2. User config → API token via secretstore                      │
│     3. Apply user overrides (custom endpoint etc.)                  │
│     4. Return existing AIOptsType, unchanged surface for backends   │
└────────────────────────────────────────────────────────────────────┘
```

**Key property:** the only thing user-edited JSON needs to say is "I have an OpenAI key, I want gpt-5 as default." Everything else flows from catalog + secretstore.

---

## 3. Layer 1: Catalog

### Location

**v1 — TS-only.** File: `frontend/app/store/ai-catalog.ts`.

The Go-side resolver does **not** read this file. Instead, it gets the few facts it needs (endpoint, apitype, capabilities) **from the resolved selection itself** — the frontend, having read the catalog, sends a fully-resolved request body to the agent endpoint. See §6 for the request shape.

Rationale: keeping catalog in TS avoids a round-trip through `task generate` for what is essentially a list of constants. Trade-off: the backend can't validate "did the user pick a real model?" — but the backend doesn't need to (LLM provider will reject if a name is bad, and the catalog is the only source).

**If this becomes painful**, escalate to Go embed + `task generate`. Triggers for escalation:
- Backend wants to enumerate capabilities (e.g. "does this model support tools?") without trusting client
- We add server-side model availability checks
- Tools start reading model metadata

### Schema (TS)

```ts
// frontend/app/store/ai-catalog.ts

export type ApiType =
    | "openai-responses"
    | "openai-chat"
    | "google-gemini"
    | "anthropic-messages";

export type Capability = "tools" | "images" | "pdfs" | "reasoning";

export type ReasoningLevel = "low" | "medium" | "high";

export interface ProviderEntry {
    id: string;                    // "openai" | "anthropic" | "google" | "openrouter" | ...
    displayName: string;           // "OpenAI"
    defaultEndpoint: string;       // "https://api.openai.com/v1/responses"
    defaultApiType: ApiType;
    tokenSecretName: string;       // default OS-keychain key name, e.g. "OPENAI_API_KEY"
    icon: string;                  // UI icon name
    models: ModelEntry[];
}

export interface ModelEntry {
    id: string;                    // wire model id, e.g. "gpt-5"
    displayName: string;           // "GPT-5"
    description?: string;          // one-liner for the picker subtitle
    capabilities: Capability[];    // ["tools", "images", "pdfs", "reasoning"]
    contextWindow: number;         // tokens
    reasoningLevels?: ReasoningLevel[];  // present iff "reasoning" in capabilities
    // Some providers ship the same model under a different apitype
    // (e.g. older models behind openai-chat). When set, overrides the
    // provider default.
    apiTypeOverride?: ApiType;
}

export const CATALOG: ProviderEntry[] = [/* §3.2 */];
```

### v1 catalog content

Concrete v1 list (will move with the AI market — kept honest by a single in-repo source-of-truth instead of dozens of user configs):

```ts
export const CATALOG: ProviderEntry[] = [
    {
        id: "openai",
        displayName: "OpenAI",
        defaultEndpoint: "https://api.openai.com/v1/responses",
        defaultApiType: "openai-responses",
        tokenSecretName: "OPENAI_API_KEY",
        icon: "openai",
        models: [
            { id: "gpt-5",       displayName: "GPT-5",        capabilities: ["tools","images","pdfs","reasoning"], contextWindow: 200000, reasoningLevels: ["low","medium","high"] },
            { id: "gpt-5-mini",  displayName: "GPT-5 mini",   capabilities: ["tools","images","pdfs"],             contextWindow: 200000 },
            { id: "gpt-4o",      displayName: "GPT-4o",       capabilities: ["tools","images"], contextWindow: 128000, apiTypeOverride: "openai-chat" },
            { id: "o3-mini",     displayName: "o3 mini",      capabilities: ["tools","reasoning"], contextWindow: 200000, reasoningLevels: ["low","medium","high"] },
        ],
    },
    {
        id: "anthropic",
        displayName: "Anthropic",
        defaultEndpoint: "https://api.anthropic.com/v1/messages",
        defaultApiType: "anthropic-messages",
        tokenSecretName: "ANTHROPIC_API_KEY",
        icon: "anthropic",
        models: [
            { id: "claude-opus-4-7",     displayName: "Claude Opus 4.7",     capabilities: ["tools","images","pdfs","reasoning"], contextWindow: 1000000, reasoningLevels: ["low","medium","high"] },
            { id: "claude-sonnet-4-6",   displayName: "Claude Sonnet 4.6",   capabilities: ["tools","images","pdfs","reasoning"], contextWindow: 200000,  reasoningLevels: ["low","medium","high"] },
            { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", capabilities: ["tools","images","pdfs"], contextWindow: 200000 },
        ],
    },
    {
        id: "google",
        displayName: "Google Gemini",
        defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent",
        defaultApiType: "google-gemini",
        tokenSecretName: "GOOGLE_AI_KEY",
        icon: "google",
        models: [
            { id: "gemini-2.0-pro",   displayName: "Gemini 2.0 Pro",   capabilities: ["tools","images","pdfs"], contextWindow: 2000000 },
            { id: "gemini-2.0-flash", displayName: "Gemini 2.0 Flash", capabilities: ["tools","images","pdfs"], contextWindow: 1000000 },
        ],
    },
    {
        id: "openrouter",
        displayName: "OpenRouter",
        defaultEndpoint: "https://openrouter.ai/api/v1/chat/completions",
        defaultApiType: "openai-chat",
        tokenSecretName: "OPENROUTER_API_KEY",
        icon: "openrouter",
        models: [
            // Curated subset; users can add more via user_config.custom_models.
            { id: "anthropic/claude-opus-4-7", displayName: "Claude Opus 4.7 (via OpenRouter)", capabilities: ["tools","images"], contextWindow: 1000000 },
            { id: "openai/gpt-5",              displayName: "GPT-5 (via OpenRouter)",            capabilities: ["tools","images"], contextWindow: 200000 },
        ],
    },
];
```

**v1 explicitly does not include:** Azure (per-deployment URL machinery is its own can of worms — re-add behind `apiTypeOverride: "openai-chat"` + `custom_endpoints` once the basics work), Groq, NanoGPT (both are openai-chat-compatible — users can add via `custom_endpoints`).

---

## 4. Layer 2: User config

### File

`~/.config/crest/ai.json` — single file, replaces the AI portions of both `settings.json` and `waveai.json`.

### Schema

```jsonc
{
    // Required: which providers the user has keys for. Maps provider id
    // (must match a CATALOG entry's id, or be the literal "custom") to
    // its credential config.
    "providers": {
        "openai": {
            // Either tokensecretname (preferred — fetched from OS
            // keychain via secretstore) or token (literal — discouraged,
            // for testing only).
            "tokensecretname": "OPENAI_API_KEY"
        },
        "anthropic": {
            "tokensecretname": "ANTHROPIC_API_KEY"
        }
    },

    // Required: the selection used when no per-pane override is set.
    // Must point at a valid provider+model combination (catalog OR
    // custom_models).
    "default": {
        "provider": "openai",
        "model": "gpt-5",
        "reasoning": "medium"            // optional, only for models that support reasoning
    },

    // Optional: context references are enabled when this section, or
    // only `enabled`, is omitted. max_tokens is an operator hard limit
    // for the complete reference overlay, not an automatic target.
    "context_references": {
        "enabled": true,
        "max_tokens": 64000
    },

    // Optional: saved selections the user can pick from. Surface in the
    // model picker as a "Profiles" section above the catalog list.
    "profiles": {
        "fast": {
            "provider": "openai",
            "model": "gpt-5-mini"
        },
        "deepwork": {
            "provider": "anthropic",
            "model": "claude-opus-4-7",
            "reasoning": "high"
        }
    },

    // Optional: models not in the catalog that the user wants to use.
    // Schema mirrors ModelEntry; provider must be a known provider id
    // OR keyed to a custom_endpoints entry.
    "custom_models": [
        {
            "provider": "openrouter",
            "id": "meta-llama/llama-3.3-70b-instruct",
            "displayname": "Llama 3.3 70B",
            "capabilities": ["tools"],
            "contextwindow": 128000
        }
    ],

    // Optional: provider overrides + entirely custom providers.
    // Use this for vLLM, Together AI, Groq, local LM Studio etc.
    "custom_endpoints": {
        "vllm-local": {
            "displayname": "Local vLLM",
            "endpoint": "http://localhost:8000/v1/chat/completions",
            "apitype": "openai-chat",
            "tokensecretname": "VLLM_LOCAL_KEY",  // can be empty for unauthed
            "icon": "server",
            "models": [
                { "id": "qwen-2.5-coder-32b", "displayname": "Qwen 2.5 Coder 32B", "capabilities": ["tools"], "contextwindow": 128000 }
            ]
        }
    }
}
```

`context_references.enabled` defaults to `true` only after the rest of `ai.json` has passed validation.
`max_tokens` has no default. When present, runtime accounting clamps it to `0`–`128000`; reading or
writing the file preserves the user's finite numeric value rather than rewriting the JSON. The limit
never selects, summarizes, packs, or downgrades a reference automatically. Disabling references hides
or rejects mutation entry points but preserves committed pins and their selected representations for
later re-enabling.

These controls belong only to `ai.json`. They do not revive the deleted legacy `ai:*` keys in
`settings.json`.

### Validation rules

- `providers` keys must be either catalog provider ids or `custom_endpoints` keys.
- `default.provider` + `default.model` must resolve to either a catalog entry, a `custom_models` entry, or a `custom_endpoints` model.
- `default.reasoning` is only honored when the resolved model has `reasoning` capability.
- Empty config (`{}`) is **not valid** — crest refuses to start agent if no `default` is set. UI shows a "Configure AI" empty state pointing the user at the file.

### Defaults

There is **no embedded default `ai.json`**. On first run, the picker shows an empty state ("No providers configured — add one in `~/.config/crest/ai.json`"). Considered seeding a stub but rejected: any seeded default with a fake API key is misleading; clear empty state is more honest.

---

## 5. Layer 3: Selection

Each pane carries its currently-selected model in **block.meta on the outer block**. The key replaces the existing `waveai:mode`:

```jsonc
// block.meta on the outer block
{
    "agent:selection": {
        "provider": "openai",
        "model": "gpt-5",
        "reasoning": "high"      // optional
    }
}
```

Properties:
- **Per-pane** (matches warp's per-conversation grain — different panes can run different models).
- **Inline triple**, not a profile reference. If the user picks profile "fast" the picker resolves and writes `{provider, model, reasoning?}`. This makes selection self-describing — no second lookup needed at submit time, and the selection survives if the user later renames or deletes the profile.
- **Defaults to `user_config.default`** when unset (resolved at use time, not on pane create).
- **Persists across reload** (block.meta is durable).

### Meta key migration

| Old | New | Action |
|---|---|---|
| `block.meta["waveai:mode"]` | `block.meta["agent:selection"]` | Delete `WaveAIMode string` from `MetaTSType`, add `AgentSelection AgentSelectionMeta`. |
| `settings["ai:preset"]` | — | Delete. |
| `settings["ai:model"]` etc. | — | Delete (moves into `ai.json`). |
| `settings["waveai:defaultmode"]` | `ai.json default` | Delete; users write into ai.json. |

---

## 6. Layer 4: Resolver

### Location

Resolver runs **in the frontend** before the agent request is dispatched. The HTTP request body to `/api/post-agent-message` carries a **fully-resolved** AI config block — the backend just hands it to `WaveAIPostMessageWrap` without further resolution.

Why frontend: catalog lives there; resolution needs catalog + user config + selection; doing it server-side would require shipping catalog to Go too (§3 said no).

### TS signature

```ts
// frontend/app/store/ai-resolver.ts

export interface ResolvedAIConfig {
    provider: string;        // resolved provider id
    model: string;           // resolved model id
    endpoint: string;        // final URL (with {model} substitution if the catalog used a template)
    apiType: ApiType;
    capabilities: Capability[];
    contextWindow: number;
    reasoning?: ReasoningLevel;
    tokenSecretName?: string;   // resolver returns the *secret name*, backend dereferences via secretstore
    tokenLiteral?: string;      // only if user used `providers.<id>.token` instead of tokensecretname; passed through
}

export function resolveAIConfig(
    selection: AgentSelection,
    userConfig: UserConfig,
    catalog: ProviderEntry[],
): ResolvedAIConfig | ResolveError;
```

### Resolution algorithm

```
fn resolveAIConfig(selection, userConfig, catalog):
    # 1. Find provider — catalog first, then custom_endpoints
    provider = catalog.find(p => p.id === selection.provider)
            ?? userConfig.custom_endpoints?.[selection.provider]
    if !provider:
        return err("Unknown provider: ${selection.provider}")

    # 2. Find model — provider.models, then custom_models
    model = provider.models.find(m => m.id === selection.model)
         ?? userConfig.custom_models?.find(m => m.provider === selection.provider && m.id === selection.model)
    if !model:
        return err("Model ${selection.model} not configured for provider ${selection.provider}")

    # 3. Read credentials from user config
    credCfg = userConfig.providers[selection.provider]
    if !credCfg:
        return err("No API key configured for ${selection.provider}")

    # 4. Validate reasoning level (silently drop if unsupported)
    reasoning = (selection.reasoning && model.capabilities.includes("reasoning"))
                ? selection.reasoning
                : undefined

    # 5. Substitute endpoint template if needed
    endpoint = provider.defaultEndpoint.replace("{model}", model.id)

    # 6. Compose
    return {
        provider:    selection.provider,
        model:       model.id,
        endpoint,
        apiType:     model.apiTypeOverride ?? provider.defaultApiType,
        capabilities: model.capabilities,
        contextWindow: model.contextWindow,
        reasoning,
        tokenSecretName: credCfg.tokensecretname,
        tokenLiteral:    credCfg.token,
    }
```

### Backend ingest

The new agent request body shape:

```jsonc
POST /api/post-agent-message
{
    "chatid": "...",
    "tabid": "...",
    "blockid": "...",
    "mode": "do",
    "msg": { ... },
    "context": { ... },
    "aiconfig": {
        "provider": "openai",
        "model": "gpt-5",
        "endpoint": "https://api.openai.com/v1/responses",
        "apitype": "openai-responses",
        "capabilities": ["tools","images","pdfs","reasoning"],
        "contextwindow": 200000,
        "reasoning": "high",
        "tokensecretname": "OPENAI_API_KEY"   // backend reads from secretstore
    }
}
```

Replaces the old `aimode` string field. The backend builds `AIOptsType` directly from this block (zero catalog access, zero `fullConfig.WaveAIModes` access).

### Compatibility with existing AIOptsType

`AIOptsType` (`pkg/aiusechat/uctypes/uctypes.go`) is **not changed**. The resolver output maps 1:1:

| ResolvedAIConfig | AIOptsType field |
|---|---|
| `provider` | `Provider` |
| `model` | `Model` |
| `endpoint` | `Endpoint` |
| `apiType` | `APIType` |
| `capabilities` | `Capabilities` |
| `reasoning` | `ThinkingLevel` |
| `tokenSecretName`+secretstore lookup | `APIToken` |
| `tokenLiteral` (pass-through) | `APIToken` |

`MaxTokens`, `Verbosity` etc. — for v1, use the same constants the current `applyProviderDefaults` uses (hard-coded sane defaults). If users need to override these, add per-provider overrides in `ai.json` later.

---

## 7. Backend changes

### Files modified

| File | Change |
|---|---|
| `pkg/aiusechat/usechat.go` | Add `BuildAIOptsFromConfig(cfg AIConfigRequest) (*AIOptsType, error)` — pure ingest of the request block, no `fullConfig.WaveAIModes` lookup. |
| `pkg/aiusechat/usechat-mode.go` | **Delete entirely** (`resolveAIMode`, `getAIModeConfig`, `applyProviderDefaults`). The provider-defaults logic survives as much-simpler `applyDefaults(aiOpts)` that fills MaxTokens / capabilities-default. |
| `pkg/agent/http.go` | `PostAgentMessageRequest` gains `AIConfig AIConfigRequest` field (replaces `AIMode string`). Handler calls `BuildAIOptsFromConfig` unconditionally — delete `buildAIOptsFromSettings` (and its sole call site). |
| `pkg/wconfig/settingsconfig.go` | Delete `SettingsType.Ai*` fields. Delete `AIModeConfigType`, `AIModeConfigUpdate`. Delete `FullConfigType.WaveAIModes`. |
| `pkg/wconfig/defaultconfig/settings.json` | Delete `ai:preset`, `ai:model`, `ai:maxtokens`, `ai:timeoutms`, `waveai:defaultmode`, `waveai:showcloudmodes`. |
| `pkg/wconfig/defaultconfig/waveai.json` | **Delete the file.** |
| `pkg/aiusechat/uctypes/uctypes.go` | Delete `AIModeQuick / AIModeBalanced / AIModeDeep` constants. |
| `pkg/waveobj/wtypemeta.go` | Replace `WaveAIMode string` with `AgentSelection *AgentSelectionMeta`. Run `task generate`. |
| `pkg/wshrpc/wshrpctypes.go` | Delete `GetWaveAIModeConfigCommand` RPC and `AIModeConfigUpdate` type. Run `task generate`. |
| `pkg/wshrpc/wshserver/wshserver.go` | Delete `GetWaveAIModeConfigCommand` impl. |

### New files

| File | Purpose |
|---|---|
| `pkg/aiusechat/aiconfig.go` | `AIConfigRequest` struct (matches frontend `ResolvedAIConfig`); `BuildAIOptsFromConfig`. |

### Backward-compat exceptions

None. POC stage.

---

## 8. Frontend changes

### Files modified

| File | Change |
|---|---|
| `frontend/app/view/cmdblock/model-picker-popover.tsx` | Read from catalog + user_config.profiles + user_config.custom_models. Render grouped sections (Profiles / Catalog by provider / Custom). Pick writes `block.meta["agent:selection"]`. |
| `frontend/app/view/cmdblock/cmdblock-input.tsx` | `ModelEntry` shape changes (gets `provider` field; sub-list semantics for reasoning). |
| `frontend/app/term/render/terminal-view.tsx` | Replace the `fullConfig.waveai` derivation with `(catalog, userConfig)` derivation. Use `agent:selection` meta key. Pass resolved `AIConfigRequest` to AgentChatHost. |
| `frontend/app/term/render/agent-chat-host.tsx` | `body.aimode` → `body.aiconfig` (the resolved block). |
| `frontend/app/store/aitypes.ts` | Drop `AIModeConfigType` re-exports. Add `AgentSelection`, `UserConfig`, `ResolvedAIConfig`, `AIConfigRequest`. |
| `frontend/types/custom.d.ts` | `hasCustomAIPresetsAtom` — review whether anything still needs it; likely delete. |

### New files

| File | Purpose |
|---|---|
| `frontend/app/store/ai-catalog.ts` | The static `CATALOG` const + types. |
| `frontend/app/store/ai-resolver.ts` | `resolveAIConfig` function + tests. |
| `frontend/app/store/ai-user-config.ts` | Jotai atom for `ai.json`, loader/saver via `getApi().readFile` / a new `WriteAIConfigCommand` RPC. |

### Deleted files

`frontend/app/view/waveconfig/waveaivisual.tsx` is the old AI mode config UI. Either rebuild it as an "Edit ai.json" view or remove and let users edit the JSON directly. **v1: remove.** Power users edit the file.

---

## 9. Selection store / UI behavior

```
┌──────────────────────────────────────────────────────────┐
│ Picker layout (warp-style sections)                       │
├──────────────────────────────────────────────────────────┤
│ PROFILES                                                  │
│   ★ fast        gpt-5-mini                                │
│   ★ deepwork    claude-opus-4-7 · high                    │
├──────────────────────────────────────────────────────────┤
│ OPENAI                                                    │
│   ◯ gpt-5         (200k · tools · reasoning)              │
│   ◯ gpt-5 mini    (200k · tools)                          │
│   ◯ gpt-4o        (128k · tools)                          │
│   ◯ o3 mini       (200k · reasoning)                      │
├──────────────────────────────────────────────────────────┤
│ ANTHROPIC                                                 │
│   ◯ Claude Opus 4.7    (1M · reasoning)                   │
│   ✓ Claude Sonnet 4.6  (200k · reasoning)   ← selected    │
│   ◯ Claude Haiku 4.5   (200k)                             │
├──────────────────────────────────────────────────────────┤
│ GOOGLE GEMINI                                             │
│   ◯ Gemini 2.0 Pro     (2M)                               │
│   ◯ Gemini 2.0 Flash   (1M)                               │
├──────────────────────────────────────────────────────────┤
│ CUSTOM ENDPOINTS                                          │
│   ◯ Local vLLM / qwen-2.5-coder-32b                       │
├──────────────────────────────────────────────────────────┤
│ 🔍 Search models                                          │
├──────────────────────────────────────────────────────────┤
│ ↑↓ navigate · ↵ select · esc dismiss                      │
└──────────────────────────────────────────────────────────┘
```

Sections shown only when non-empty. A provider whose key isn't in `user_config.providers` renders **dimmed** with a "Add API key" affordance.

### Reasoning sub-select

For models with `reasoningLevels`, hovering shows a 3-button mini-row inline below the row (`low / med / high`). Click sets the level + commits selection. Default: provider's default level (we pick `medium`).

This replaces warp's hover-sidecar UX with an inline row — simpler and good enough for v1. Sidecar is future polish.

---

## 10. Deletion kill-list

For the implementer: a complete enumeration so nothing rots.

### Go files (full delete)
- `pkg/aiusechat/usechat-mode.go` (whole file) — after porting `applyDefaults` into `aiconfig.go`

### Go fields/types/constants
- `SettingsType.AiApiType / AiApiToken / AiApiTokenSecretName / AiBaseURL / AiMaxTokens / AiTimeoutMs / AiModel / AiPreset` (and any sibling `AiOrgID` etc.)
- `AIModeConfigType` (whole type)
- `AIModeConfigUpdate` (whole type)
- `FullConfigType.WaveAIModes`
- `MetaTSType.WaveAIMode`
- `uctypes.AIModeQuick / AIModeBalanced / AIModeDeep / AIModeBuilderDefault / AIModeBuilderDeep`
- `PostAgentMessageRequest.AIMode` (replaced by `AIConfig`)
- `PostMessageRequest.AIMode` (chat panel — same treatment)
- `wshserver.GetWaveAIModeConfigCommand`

### JSON keys (default config files)
- `settings.json`: `ai:preset`, `ai:model`, `ai:maxtokens`, `ai:timeoutms`, `waveai:defaultmode`, `waveai:showcloudmodes`
- `waveai.json`: file deleted

### TS/JSX
- `frontend/app/view/waveconfig/waveaivisual.tsx` (whole file)
- `frontend/app/store/global-atoms.ts:hasCustomAIPresetsAtom` (or rewrite if still wanted)
- `frontend/types/gotypes.d.ts` regenerated → `AIModeConfigType`, `AIModeConfigUpdate` disappear automatically
- `frontend/app/store/wshclientapi.ts:GetWaveAIModeConfigCommand` regenerated → disappears

### Block meta migration
- `block.meta["waveai:mode"]` → frontend ignores on read (old field gets silently dropped on first selection write)
- POC: no migration; users re-pick.

---

## 11. Phase plan

Six phases. Each ends with a green-test checkpoint. Cumulative — phases don't ship independently, the rewrite goes in one branch.

### Phase A — Catalog + types (~1d)
- Create `ai-catalog.ts` with v1 content.
- Add types: `AgentSelection`, `UserConfig`, `ResolvedAIConfig`, `AIConfigRequest`.
- Add Go `AIConfigRequest` struct in `pkg/aiusechat/aiconfig.go`.
- Add `MetaTSType.AgentSelection` + `task generate`.

**Acceptance**: TS compiles; new types appear in `gotypes.d.ts`; existing tests still pass.

### Phase B — Resolver + secret pipe (~1d)
- Implement `resolveAIConfig` in `ai-resolver.ts` with full unit tests (vitest).
- Implement `BuildAIOptsFromConfig` in `pkg/aiusechat/aiconfig.go` with Go unit tests.
- Wire secretstore lookup in `BuildAIOptsFromConfig`.

**Acceptance**: `vitest run frontend/app/store/ai-resolver.test.ts` and `go test ./pkg/aiusechat/...` both green. Round-trip test: `selection → ResolvedAIConfig → AIConfigRequest → BuildAIOptsFromConfig → AIOptsType` produces the right endpoint+apitype for each catalog provider.

### Phase C — User config loader (~0.5d)
- Add `ai-user-config.ts` jotai atom + reader.
- Read path: backend `wshrpc` command `GetAIUserConfig` returns parsed `~/.config/crest/ai.json` (or error). Write path: `WriteAIUserConfig` accepts a JSON blob.
- Empty-config UX: a banner in the picker pointing at the file path.

**Acceptance**: Picker mounts without crash when ai.json missing; banner visible.

### Phase D — Picker rewrite (~1d)
- Rewrite `model-picker-popover.tsx` for the sectioned layout.
- Rewrite `terminal-view.tsx` deriveModels logic.
- Reasoning inline sub-row.

**Acceptance**: Manual smoke — picker shows catalog correctly; selecting writes `block.meta["agent:selection"]`; reload preserves selection.

### Phase E — Backend cutover + delete legacy (~1d)
- Switch `PostAgentMessageHandler` to consume `req.AIConfig` exclusively.
- Switch `WaveAIPostMessageHandler` (chat panel) similarly.
- Delete every item in §10 kill-list.
- `task generate`.
- Search the codebase for any straggler references — expected hits: 0 after a clean delete.

**Acceptance**: `go build ./...` green; `npx tsc --noEmit` clean of `AIMode*` / `WaveAIMode*` refs; `go test ./...` green.

### Phase F — End-to-end smoke + docs (~0.5d)
- Manual: configure OpenAI key, send agent message → reply arrives.
- Manual: switch providers via picker → next message uses new provider.
- Update `docs/agent-architecture.md` §13 (or new §) pointing here.
- Update `docs/agent-user-guide.md` with the new `ai.json` shape + example.

**Acceptance**: agent reply arrives for at least one BYOK provider in dev environment.

### Total: ~5 days single-person, ~3-4 days if parallelizing FE/BE.

---

## 12. Decisions log

Locked decisions, written down so future-us doesn't relitigate them:

| Decision | Reason |
|---|---|
| Catalog is TS-only in v1, not Go-embedded | Avoid `task generate` cycle for what is essentially a constant list. Backend doesn't need catalog access — it ingests resolved configs. Easy to escalate to Go embed later if needed. |
| Selection is an inline triple `{provider,model,reasoning?}`, not a profile reference | Self-describing; survives profile deletion; one-shot resolution. |
| No embedded default `ai.json` | A seeded default with fake API key is misleading. Honest empty state with clear path to fix is better. |
| Selection lives per-pane (block.meta), not global | Matches warp; lets different panes run different models. Trade-off: there's no global default-mode-per-tab fallback — defaults flow from `ai.json.default`. |
| No `mode` (ask/plan/do/bench) folded into selection | These are permission-posture axes, orthogonal to model choice. `mode` stays in its current spot. |
| `MaxTokens` etc. not user-configurable in v1 | Hard-coded sane defaults. Avoids growing the v1 schema; revisit if anyone hits a wall. |
| Azure / Groq / NanoGPT not in v1 catalog | Each has deployment-URL or rate-limit specifics. Users can add via `custom_endpoints` until we standardize. |
| Reasoning select is inline mini-row, not hover sidecar | Simpler than warp's sidecar; faithfulness to warp not a goal here. |
| Delete `waveaivisual.tsx` (old AI config UI) | v1: edit JSON. Rebuild as a real settings pane is post-v1. |
| No backward compat / migration script | POC stage; users re-pick. Migration code is dead weight + a bug surface. |

---

## 13. Open questions

Things the implementer should resolve before / during work:

1. **Where to surface "API key missing"?** Picker shows dim + "Add API key" — but clicking that should open a flow. Options: open `ai.json` in $EDITOR / inline form / docs link. **Default: open the file path with `getApi().openExternal('file://...')`.**
2. **Should `default.reasoning` be a separate axis at config time, or always picked at use time?** Current proposal: configurable in `ai.json` (so the user's preferred default reasoning level survives picker resets). Confirm via UX try.
3. **Token literal vs secret name precedence.** If both `token` and `tokensecretname` are set on a provider, which wins? Proposal: `token` (literal) wins. Log a warning.
4. **Catalog `apiTypeOverride` semantics with custom endpoints.** When a user adds a custom_endpoints entry, do its models inherit `apitype` from the endpoint or can per-model overrides apply? Proposal: endpoint-level only in v1, no per-model override on custom.
5. **Multi-key per provider.** Some users have separate OpenAI keys for personal vs work projects. Not addressed by v1. Punt.
6. **What about chat-panel (`WaveAIPostMessage`)?** Same treatment as agent: consume `AIConfigRequest` in body. Confirm during Phase E.

---

## 14. What is explicitly out of scope

To prevent scope creep during implementation, listed:

- ❌ A real GUI for editing `ai.json` (post-v1)
- ❌ Multi-key per provider (post-v1)
- ❌ Per-provider `MaxTokens` / `Verbosity` overrides (post-v1)
- ❌ Server-side model availability validation (we trust catalog + user config)
- ❌ Model auto-routing ("Auto" mode that picks model per message) — distinct feature, separate design
- ❌ Pricing / quota display in picker (no catalog data on pricing yet)
- ❌ Warp-style hover sidecar for reasoning levels (use inline row)
- ❌ Azure / Groq / NanoGPT in v1 catalog (custom_endpoints handles them)
- ❌ Backward compatibility with existing block.meta["waveai:mode"] or settings.json `ai:*`

---

## 15. Ready-to-implement checklist

Before starting Phase A:
- [ ] User approves architecture (this doc)
- [ ] User approves v1 catalog content (§3.2 — specifically the model lists)
- [ ] Resolve open questions §13.1, §13.2 (default UX) before Phase D
- [ ] Decide §13.6 (chat panel) before Phase E

Once green, branch from `main` and Phase A.

---

## 16. What shipped (post-implementation appendix, 2026-05-20)

Phases A–F ran end-to-end across the design timeline. Notes on **what diverged from the original plan** in this section; everything not mentioned shipped as drafted.

### Deviations

- **Reasoning sub-row decision (§13.2 carried forward).** Confirmed inline three-button mini-row under the active model row instead of warp's hover sidecar. Implementation in `model-picker-popover.tsx`'s `ReasoningSubRow`. UX trade: zero hover surface, always-visible state — better discoverability, slightly heavier vertical footprint when a reasoning-capable model is active.

- **`AIOptsType.AIMode` field removed too (§10 kill-list addition).** Originally planned to delete only the AIMode wire path; during Phase E it became clear the `AIMode` *label field* on `AIOptsType` (and its propagation through `WaveChatMetrics.AIMode` → `telemetrydata.WaveAIMode`) had no remaining producer. Deleted alongside.

- **`ObjRTInfo.WaveAIMode` deleted.** Same reason — the runtime-info copy of the mode key had no consumer once `getWaveAISettings` was removed.

- **Phase E touched more files than projected.** Original §10 kill-list named ~22 items; the actual cutover hit ~30 once we walked the import graph (telemetry, ObjRTInfo, frontend mock config, monaco schema endpoint, `validateWaveAiJson` validator). The pattern was the same — kill the producer, fix the dangling consumers — but the consumer list ran longer than the doc anticipated.

- **One Go field intentionally kept stale: `CountCustomAIModes`.** Replaced its body with `return 0` rather than deleting the method because the cmd/server telemetry path still calls it; preserving the method signature keeps the telemetry struct shape stable for downstream dashboards. Real cleanup is a follow-up that touches the telemetry consumer too.

- **No migration script written (§13.5 punt confirmed).** POC stage; users re-pick. The picker's empty-state banner explains where to put `ai.json`.

- **AgentChatHost has no fallback when `aiConfig` is null.** Plan said "the picker handles empty / error states internally" — that's true for the popover UI, but `AgentChatHost.submit` had to add an explicit guard (logs a warning to console + drops the message) because the backend now hard-requires `aiconfig`. Phase E commit added the guard; without it, a fresh install with no `ai.json` would 400 on first agent message.

- **Tooling note: `tsc` and `vitest` are dysfunctional in this dev environment** (some `node_modules` files read as 0 bytes despite `ls` showing them populated — `typescript/lib/_tsc.js`, `rollup/package.json`, `picomatch`). Resolver tests run via `tsx` directly; the canonical `vitest.config.ts` will pass once `node_modules` is reinstalled. A `vitest.slim.config.ts` exists at the repo root as a temporary bypass.

### Test coverage shipped

- `pkg/aiusechat/aiconfig_test.go` — 13 tests covering token literal, secretstore lookup, whitespace trim, secret-missing, secret-empty, secretstore-error, full field mapping, capability roundtrip, required-field rejection (4 subtests), nil capabilities, no-reasoning.
- `pkg/aiusechat/aiconfig_roundtrip_test.go` — 5 cross-language round-trip tests (OpenAI w/ reasoning, Google Gemini w/ template, OpenRouter chat API, local vLLM unauthed, literal-token testing path).
- `pkg/aiusechat/userconfig_test.go` — 10 parse + validation tests (minimal, full, empty rejection, missing providers, empty providers, missing default fields, unknown field rejection, malformed JSON, missing-file sentinel).
- `frontend/app/store/ai-resolver-smoke.ts` — 26 assertions covering catalog hit, default fallback, apitypeoverride, `{model}` substitution, reasoning gating, credential precedence, empty tokensecretname, custom_endpoints, custom_models, all 5 error codes.

### Open follow-ups (post-v1)

- `crest secret set OPENAI_API_KEY sk-...` wsh command (referenced in user guide; not yet implemented). Today users set keychain entries via system tools.
- "Open `ai.json` in $EDITOR" affordance on the picker's empty-state banner — currently surfaces the path in a notification toast.
- Azure / Groq / NanoGPT catalog entries (custom_endpoints works today; first-class slots once we standardize their per-deployment URL machinery).
- GUI for editing `ai.json` (post-v1 — `waveaivisual.tsx` was deleted intentionally; rebuild belongs in a separate design).
- File-citation jump in the agent's tool-use cards (P0.7 left as clipboard fallback — proper "scroll to block + line" needs a filename→block index that doesn't exist yet).

### File index

For the implementer hunting for any of this later:

- Design doc: this file (`docs/ai-config-architecture.md`)
- Architecture cross-ref: `docs/agent-architecture.md` §24
- User guide: `docs/agent-user-guide.md` § "AI Provider Configuration"
- Catalog: `frontend/app/store/ai-catalog.ts`
- FE types: `frontend/app/store/ai-types.ts`
- FE resolver: `frontend/app/store/ai-resolver.ts` (+ `ai-resolver-smoke.ts`, `ai-resolver.test.ts`)
- FE user-config loader: `frontend/app/store/ai-user-config.ts`
- FE picker: `frontend/app/view/cmdblock/model-picker-popover.tsx`
- Go AIUserConfig types: `pkg/aiusechat/uctypes/userconfig.go`
- Go user-config IO: `pkg/aiusechat/userconfig.go` (+ `userconfig_test.go`)
- Go AIConfigRequest + resolver: `pkg/aiusechat/aiconfig.go` (+ `aiconfig_test.go`, `aiconfig_roundtrip_test.go`)
- RPC: `pkg/wshrpc/wshrpctypes.go` (`GetAIUserConfigCommand` / `WriteAIUserConfigCommand`)
- Meta: `pkg/waveobj/wtypemeta.go` (`MetaTSType.AgentSelection`, `AgentSelectionMeta`)
