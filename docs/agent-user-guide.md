# Crest Agent User Guide

Crest includes a built-in coding agent that runs directly in your terminal. Invoke it with `:` prefix commands in the terminal input. Agent responses appear inline alongside your command blocks.

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

The shipped catalog (`frontend/app/store/ai-catalog.ts`) covers OpenAI, Anthropic, Google Gemini, and OpenRouter. Each entry knows its endpoint, API protocol, default token secret name, and the popular models for that provider with their context window + capabilities. You don't write any of this in `ai.json` — only credentials and the default selection.

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
OpenRouter
Custom Endpoints         (your custom_endpoints entries)
```

Models with reasoning capability expose an inline `[low] [med] [high]` row when selected. The chip shows the picked model's display name; the choice persists on the pane's outer block until you pick something else.

### Where reasoning goes

Reasoning level is **part of the selection**, not the catalog. `gpt-5 + high` and `gpt-5 + low` are the same model with different effort hints — picking either updates the reasoning sub-row and the chip badge (`GPT-5 · high`). Reasoning is silently dropped when the resolved model doesn't support it, so old selections survive model swaps cleanly.

### Architecture reference

For maintainers / contributors: see [`docs/ai-config-architecture.md`](./ai-config-architecture.md) — covers the 4-layer design (catalog / user config / selection / resolver) and the rationale for each decision.

---

## Modes

Crest's agent operates in three modes, each with different permission levels.

### :ask — Read-Only Q&A

Explores your codebase and answers questions without making any changes.

```
:ask what does the auth middleware do?
:ask where is the database connection configured?
```

- All read tools (file reads, directory listings, web fetches) are auto-approved.
- Cannot write files, run shell commands, or modify anything.

### :plan — Plan Creation

Analyzes a task and produces a step-by-step plan file.

```
:plan add a dark mode toggle to the settings page
:plan refactor the payment module to use the new API
```

- Read tools are auto-approved.
- Plan file writes (to `.crest-plans/`) are auto-approved.
- Cannot write project files or run shell commands.
- When complete, an **Execute Plan** button appears (see Plan-to-Do Handoff below).

### :do — Full Mutation

Performs real changes: writes files, runs commands, creates blocks.

```
:do add input validation to the signup form
:do fix the failing test in auth.test.ts
```

- Read tools are auto-approved.
- File writes, edits, and shell commands require your approval.
- MCP tools always require approval.

---

## Inline Agent Blocks

- Type `:` in the terminal input to activate agent mode. A mode badge (ask/plan/do) appears in the input area.
- Press **Escape** to clear the agent input and return to normal terminal mode.
- Agent responses render inline in the terminal block stream, not as a floating overlay or separate panel.

---

## Tools

The agent has access to the following tools. Tools marked "auto" are approved automatically in the indicated modes. Tools marked "approval" require explicit confirmation before execution.

### File & Directory

| Tool | Description | Approval |
|------|-------------|----------|
| `read_text_file` | Read file contents | Auto (all modes) |
| `read_dir` | List directory contents | Auto (all modes) |
| `write_text_file` | Create or overwrite a file | Approval (:do only) |
| `edit_text_file` | Search/replace edits in a file | Approval (:do only) |

### Shell & System

| Tool | Description | Approval |
|------|-------------|----------|
| `shell_exec` | Run a shell command in a visible terminal block | Approval |
| `cmd_history` | View recent command history | Auto |
| `get_scrollback` | Read terminal output from a block | Auto |
| `web_fetch` | Fetch a URL and extract text content | Auto in :ask, Approval in :do |

### Workspace

| Tool | Description | Approval |
|------|-------------|----------|
| `write_plan` | Write a plan file (used in :plan mode) | Auto in :plan |
| `create_block` | Create a new terminal or preview block | Approval |
| `focus_block` | Bring focus to a specific block | Auto |
| `spawn_task` | Delegate a sub-task to a child agent | Approval (:do only) |

### Browser

| Tool | Description | Approval |
|------|-------------|----------|
| `browser.navigate` | Navigate to a URL | Approval |
| `browser.read_text` | Read text content from the page | Approval |
| `browser.click` | Click an element on the page | Approval |
| `browser.screenshot` | Capture a screenshot of the page | Approval |

---

## Session Commands

All session commands are prefixed with `:`.

| Command | Description |
|---------|-------------|
| `:new` | Clear the conversation and start a fresh session. |
| `:model <name>` | Switch to a different model. Resets the chat. |
| `:rewind` | Restore files changed by the last agent turn to their previous state. |
| `:worktree [name]` | Create a git worktree for sandboxed changes. |
| `:worktree exit` | Remove the active worktree and return to the main tree. |

### Switching Models

Use the **model chip** at the right end of the input bar (see "AI Provider Configuration" above). Open the picker, pick a model, the next message uses it. The choice persists on the current pane's outer block — different panes can run different models.

The `:model` slash command from earlier crest versions is gone; the picker replaces it.

---

## Diff Preview

When the agent writes or edits a file, the approval card includes a diff preview:

- Changed lines are shown with **3 lines of surrounding context** for orientation.
- **New files** display a green "New file" indicator.
- If a write produces no changes, a **"No changes"** label appears instead.

---

## Plan-to-Do Handoff

After `:plan` finishes and creates a plan file:

1. An **Execute Plan** button appears below the agent response.
2. Clicking it switches to `:do` mode and sends "go" to begin execution.
3. The plan is already in the conversation history, so the agent has full context.

---

## File Checkpointing and :rewind

Every file write or edit the agent performs automatically creates a backup of the original content.

```
:rewind
```

- **Modified files** are restored to their pre-turn state.
- **Newly created files** are deleted.
- **Conversation history is not affected** — only files on disk change.
- Only tracks changes made by the Write and Edit tools. Changes made by shell commands (e.g., `sed`, `mv`) are not tracked.

---

## Git Worktree Sandboxing

Worktrees let you isolate agent changes in a separate git branch without affecting your working tree.

```
:worktree                   # creates worktree with random name (e.g., "calm-brook")
:worktree my-feature        # creates worktree with a specific name
:worktree exit              # removes the active worktree
```

- Creates `.crest/worktrees/<name>/` with branch `worktree-<name>`.
- All subsequent `:do` operations target the worktree directory.
- Persists across turns — the worktree stays active until you exit it.
- Add `.crest/worktrees/` to your `.gitignore`.

---

## Sub-Agent Delegation

The `spawn_task` tool (available in `:do` mode) delegates a scoped sub-task to a child agent.

- The child agent runs with the same model and tools but in an **isolated conversation context**.
- Each sub-task is limited to **15 steps**.
- The child returns a completion summary when finished.
- Requires approval before spawning.

---

## Background Shell Execution

Run long-lived processes without blocking the agent:

```
shell_exec with background: true
```

- Returns immediately with the block ID.
- Useful for dev servers, file watchers, and long builds.
- Monitor output with `get_scrollback` using the returned block ID.

---

## Dangerous Command Detection

Certain destructive commands force an approval prompt regardless of context:

- `rm -rf`
- `git push --force`, `git reset --hard`
- `curl | sh`, `wget | sh`
- `dd`, `mkfs`, `chmod 777`
- And other patterns covering destructive disk, git, and permission operations.

There are 12 regex patterns in total. These commands will never auto-approve.

---

## MCP Server Integration

Extend the agent with external tools via the Model Context Protocol.

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

MCP tools appear with the naming convention `mcp__<server>__<tool>` and **always require approval**, regardless of mode.

---

## Token Counter

Cumulative token usage is displayed in the agent response area when the provider returns usage data. Models that report zero usage (some free-tier models) will not show a counter.
