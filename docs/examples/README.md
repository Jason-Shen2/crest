# Crest Configuration Examples

Working, copy-pasteable starting points for the user-editable config files.

| File | Drop into | What it's for |
|---|---|---|
| `ai.json.example` | `~/.config/crest/ai.json` | AI provider credentials, default model selection, named profiles, custom endpoints. Reference: [`../agent-user-guide.md`](../agent-user-guide.md) § "AI Provider Configuration". |

## `ai.json.example` — minimal vs full

The shipped example is the **full** shape — every section populated to show what's possible. **Strip the parts you don't need before saving.** A working minimal `ai.json` is just:

```jsonc
{
    "providers": {
        "openai": { "tokensecretname": "OPENAI_API_KEY" }
    },
    "default": {
        "provider": "openai",
        "model": "gpt-5"
    }
}
```

That's the smallest valid config — one provider with credentials, one default selection.

## Schema rules

- `providers` and `default` are **required**. Everything else is optional.
- `providers` keys must be either a catalog provider id (`openai`, `anthropic`, `google`, `openrouter`) or a key from `custom_endpoints`.
- `default.provider` + `default.model` must resolve to a real model (catalog, custom_models, or custom_endpoints).
- `tokensecretname` is preferred over inline `token`. The OS keychain stores the literal value, looked up by this name at request time.
- Empty string `"tokensecretname": ""` is valid and means "this endpoint accepts unauthed requests" (typical for local vLLM, LM Studio).
- Unknown top-level fields are rejected at parse time — typos surface as a "malformed config" banner in the picker.
