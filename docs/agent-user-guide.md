# Crest Agent User Guide

Crest includes a built-in coding agent that runs directly in your terminal. The same input bar handles shell commands and agent prompts; the active **Input Mode** (terminal / agent / auto) decides what Enter does. Agent responses appear inline alongside your command blocks.

---

## AI Provider Configuration

Crest is BYO-API-key. You configure providers + credentials in **`~/.config/crest/ai.json`**. The file is required — the agent refuses to send a message until at least one provider with credentials and a `default` selection are set.

### Minimal example

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

That's it. After saving, the model picker (the chip next to the input bar) populates with OpenAI's catalog models; selecting one writes the choice to the pane's meta and the next agent message uses it.

### Where credentials live

Two ways to provide an API key:

1. **`tokensecretname` (preferred)** — the OS keychain holds the token under this name; crest's `secretstore` resolves it at request time. Set the keychain entry via system tools or via `crest secret set OPENAI_API_KEY sk-...` (forthcoming wsh command).

2. **`token` (testing only)** — literal token in the JSON. Plaintext, not recommended; takes precedence over `tokensecretname` if both are set.

### Built-in providers

The shipped catalog (`frontend/app/store/ai-catalog.ts`) covers OpenAI, Anthropic, Google Gemini, minimax, minimax-cn, and OpenRouter. Each entry knows its endpoint, API protocol, default token secret name, and the popular models for that provider with their context window + capabilities. You don't write any of this in `ai.json` — only credentials and the default selection.

### Profiles (optional)

Save named selections you switch between:

```jsonc
{
    "providers": {
        "openai":    { "tokensecretname": "OPENAI_API_KEY" },
        "anthropic": { "tokensecretname": "ANTHROPIC_API_KEY" }
    },
    "default":  { "provider": "openai", "model": "gpt-5-mini" },
    "profiles": {
        "fast":     { "provider": "openai",    "model": "gpt-5-mini" },
        "deepwork": { "provider": "anthropic", "model": "claude-opus-4-7", "reasoning": "high" }
    }
}
```

Profiles render as a `★ Profiles` section at the top of the picker. Picking one writes the resolved `{provider, model, reasoning}` triple to the pane's `agent:selection` meta — the profile *name* isn't stored, so renaming or deleting a profile later doesn't break already-selected panes.

### Custom models (not in catalog)

Provider is in the catalog but the model isn't (newly released, etc.):

```jsonc
{
    "providers": { "openai": { "tokensecretname": "OPENAI_API_KEY" } },
    "default":   { "provider": "openai", "model": "gpt-experimental" },
    "custom_models": [
        {
            "provider": "openai",
            "id": "gpt-experimental",
            "displayname": "GPT Experimental",
            "capabilities": ["tools"],
            "contextwindow": 50000
        }
    ]
}
```

Inherits the provider's endpoint + apitype. Override per-model with `"apitypeoverride": "openai-chat"` if the model needs a different API protocol than the provider's default.

### Custom endpoints (entirely new provider)

For local vLLM, Together AI, Groq, LM Studio, or anywhere not in the catalog — declare the endpoint inline:

```jsonc
{
    "providers": {
        "vllm-local": { "tokensecretname": "" }    // empty == no auth header
    },
    "default": { "provider": "vllm-local", "model": "qwen-coder-32b" },
    "custom_endpoints": {
        "vllm-local": {
            "displayname": "Local vLLM",
            "endpoint":  "http://localhost:8000/v1/chat/completions",
            "apitype":   "openai-chat",
            "tokensecretname": "",
            "models": [
                {
                    "id": "qwen-coder-32b",
                    "displayName": "Qwen 2.5 Coder",
                    "capabilities": ["tools"],
                    "contextWindow": 128000
                }
            ]
        }
    }
}
```

`apitype` values: `openai-chat`, `openai-responses`, `anthropic-messages`, `google-gemini`. Pick whichever the endpoint speaks; most non-OpenAI compatible servers are `openai-chat`.

### Picker UI

Open the picker by clicking the model chip at the right end of the input bar. Sections from top to bottom:

```
★ Profiles               (your saved selections)
OpenAI                   (catalog models — dimmed when no key)
Anthropic
Google Gemini
minimax
minimax (China)
OpenRouter
Custom Endpoints         (your custom_endpoints entries)
```

Models with reasoning capability expose an inline `[low] [med] [high]` row when selected. The chip shows the picked model's display name; the choice persists on the pane's outer block until you pick something else.

### Where reasoning goes

Reasoning level is **part of the selection**, not the catalog. `gpt-5 + high` and `gpt-5 + low` are the same model with different effort hints — picking either updates the reasoning sub-row and the chip badge (`GPT-5 · high`). Reasoning is silently dropped when the resolved model doesn't support it, so old selections survive model swaps cleanly.

### Architecture reference

For maintainers / contributors: see [`docs/ai-config-architecture.md`](./ai-config-architecture.md) — covers the 4-layer design (catalog / user config / selection / resolver) and the rationale for each decision.

---

## Input Mode

The input bar has three modes, controlled by the mode toggle in the input area:

| Mode | Behavior on Enter |
|------|-------------------|
| **terminal** | Send the line to the shell. |
| **agent** | Send the line to the configured AI model as a prompt. |
| **auto** | The NLD classifier (tier-1 heuristic + tier-2 embedder) decides per line — see [`docs/agent-architecture.md`](./agent-architecture.md). |

In `auto` mode, lines that look like shell (`git status`, `ls -la`, `npm test`) go to the shell; natural-language prompts go to the agent. The classifier also biases toward the previous turn's mode for short follow-ups ("yes", "continue", "do it") so you don't have to repeat yourself.

The mode badge in the input area shows the current **effective** mode — the one that will fire if you press Enter right now.

---

## Inline Agent Blocks

- Slash commands (`/tree`, `/new`, `/model`, …) activate agent features regardless of input mode. The full list is below.
- Agent responses render inline in the terminal block stream, not as a floating overlay or separate panel.

---

## Tools

The current v1 tool surface is enabled by the Electron main process when it builds a pane's `AgentHarness`. There is no interactive approval card yet: unless a caller passes an explicit `allowedTools` list, the runtime defaults to `allowAll`. Treat tool execution as trusted local automation and review edits/commands carefully.

| Category | Tools | Notes |
|----------|-------|-------|
| File reading | `read`, `ls`, `find`, `grep` | Bound to the pane's cwd; search tools avoid downloading runtime binaries. |
| File mutation | `write`, `edit` | Changes are emitted as tool events; review diffs in the normal workspace surfaces. |
| Shell | `bash` | Runs in the pane's cwd with optional timeout, process-tree kill on abort/timeout, and truncated output with a full-output temp file. |
| Web | `web_fetch` | Fetches web content through Crest's built-in tool. |
| Subagent | `spawn_cli_agent` | Main pane only; delegates long-running or interactive command work to an ephemeral CLI subagent session. |

Browser automation and MCP-backed Agent tools are roadmap items, not currently enabled tools in the default Agent runtime.

---

## Slash Commands

All built-in commands start with `/` and fire in the current input bar. The list lives in [`frontend/app/term/render/agent-slash-command-routing.ts`](../frontend/app/term/render/agent-slash-command-routing.ts) and the LocalSlashCommands fallback in [`frontend/app/view/cmdblock/cmdblock-input.tsx`](../frontend/app/view/cmdblock/cmdblock-input.tsx).

| Command | Aliases | Action |
|---------|---------|--------|
| `/tree` | — | Open the agent tree view (session lineage). |
| `/fork` | — | Fork the current session into a new branch. |
| `/clone` | — | Clone the current agent session branch. |
| `/model` | — | Open the model picker (shortcut for clicking the model chip). |
| `/new` | `/clear` | Clear the conversation and start a fresh session. |
| `/resume` | — | Resume an existing agent session for this workspace. |
| `/compact` | — | Compact the current session context. |
| `/session` | — | Show current agent session information. |
| `/copy` | — | Copy the last assistant response. |
| `/export` | — | Export the current session as JSONL `[path]`. |
| `/import` | — | Import a JSONL session `<path>`. |
| `/reload` | — | Reload agent command metadata. |

Unknown commands (anything not in the table) pass through to the agent as a normal prompt — the agent decides what to do.

### Switching Models

Use the **model chip** at the right end of the input bar (see "AI Provider Configuration" above). Open the picker, pick a model, the next message uses it. The choice persists on the current pane's outer block — different panes can run different models.

`/model` is a shortcut for opening the picker; the legacy `<name>` argument form was removed when the picker replaced it.

---

## Reviewing File Changes

When the agent writes or edits a file, review the resulting changes through the normal editor and source-control surfaces. Fine-grained interactive approval cards and dedicated per-tool diff approval are still being completed.

---

## Shell Execution

The `bash` tool runs commands in the pane's cwd and streams output back to the Agent. Provide a `timeout` when the command may hang or run for a long time. For long-running or interactive command work, the main pane Agent can use `spawn_cli_agent`, which runs an ephemeral CLI subagent and returns a summarized tool result.

---

## Permissions Status

Current v1 behavior is intentionally simple: bench mode always allows tools, and normal panes default to `allowAll` when the renderer has not passed an `allowedTools` list. If an `allowedTools` list is provided, the permissions hook blocks tools outside that list. A richer approval UI, dangerous-command review, and per-tool confirmation flow are still being completed.

---

## MCP Server Integration

MCP-backed Agent tools are a planned extension point, not part of the default enabled tool surface yet.

### Configuration

Add MCP servers in your `settings.json` under the `ai:mcpservers` key:

```json
{
    "ai:mcpservers": {
        "filesystem": {
            "command": "npx",
            "args": ["-y", "@anthropic/mcp-filesystem"],
            "type": "stdio"
        }
    }
}
```

### Supported Transports

- **stdio** — spawns a local process
- **SSE** — Server-Sent Events over HTTP
- **HTTP** — standard HTTP transport

### Using MCP Tools

The intended naming convention is `mcp__<server>__<tool>`, with explicit approval before execution. That approval path is not enabled in the current Agent runtime.

---

## Token Counter

Cumulative token usage is displayed in the agent response area when the provider returns usage data. Models that report zero usage (some free-tier models) will not show a counter.
