# Crest Agent — Architecture & Design Decisions

This document describes the design and implementation of every major feature in Crest's native coding agent. It's the entry point for new contributors.

## Layout

```
pkg/agent/              ← policy: modes, tools, sandbox, checkpoints, prompts
pkg/agent/tools/        ← tool implementations (read, write, shell, browser, ...)
pkg/agent/eval/         ← golden transcript replay framework
pkg/agent/mcp/          ← MCP client (external tool servers)
pkg/aiusechat/          ← mechanism: step loop, backends, streaming, retries
pkg/aiusechat/httpretry/← retry-with-backoff HTTP client
frontend/app/view/termblocks/  ← terminal view + inline agent rendering
frontend/app/view/term/term-agent.tsx  ← reusable agent UI components
```

**Dependency rule:** `pkg/agent` imports `pkg/aiusechat`, never the reverse. Tools cannot import the parent `agent` package.

---

## 1. LLM retry with exponential backoff

**Problem:** A single 429 or 5xx from the AI provider would kill the entire turn, losing all in-flight work.

**Approach:** Wrap `http.Client.Do` with a custom retry layer that buffers the request body once, replays on retry, and respects `Retry-After` headers. Equal-jitter backoff to avoid thundering-herd retries from concurrent users.

**Files:**

- `pkg/aiusechat/httpretry/httpretry.go` — `Do()`, `MakeRetryClient()`
- Wired into all 4 backends: `pkg/aiusechat/anthropic/anthropic-backend.go`, `pkg/aiusechat/openairesponses/`, `pkg/aiusechat/openaichat/`, `pkg/aiusechat/google/`

**Data flow:**

1. Backend calls `httpretry.Do(client, req)`
2. Body is read into `[]byte` once, then re-set on each attempt
3. On 429/500/502/503/504: wait `min(initial * 2^attempt, max) ± jitter`, retry
4. `Retry-After` header overrides the computed backoff
5. After N attempts (default 3), return last response/error

**Trade-offs:** Buffering the body means request size is bounded by memory. Acceptable for agent traffic (LLM requests are small). Streaming uploads would not work but we don't need them.

---

## 2. Step budget enforcement

**Problem:** A confused agent could loop forever, burning tokens and never returning.

**Approach:** Hard cap on the number of LLM calls per turn. Soft warning injected at 80% so the model can wrap up gracefully.

**Files:**

- `pkg/aiusechat/uctypes/uctypes.go` — `MaxSteps int` field on `WaveChatOpts`
- `pkg/aiusechat/usechat.go` — `RunAIChat` checks before each step
- `pkg/agent/agent.go` — sets `DefaultMaxAgentSteps = 50`

**Data flow:**

1. At top of step loop: if `step >= maxSteps`, return `StopKindStepBudget`
2. At 80%: prepend "you have N steps remaining" to the system prompt for that step only
3. Frontend renders the stop reason as a visible warning

**Trade-offs:** Hard limits feel artificial but are necessary. The 80% warning gives the model a chance to summarize before the cap.

---

## 3. Context compaction

**Problem:** Long sessions accumulate tokens until the model's context window overflows.

**Approach:** Sliding-window compaction. When the last step's input tokens exceed 80% of the configured budget, drop middle messages and keep only the first user message + last 10 messages. No AI summarization (too slow, too expensive at MVP scale).

**Files:**

- `pkg/aiusechat/uctypes/uctypes.go` — `ContextBudget int` on `WaveChatOpts`
- `pkg/aiusechat/chatstore/chatstore.go` — `CompactMessages(chatId, keepFirst, keepLast)`
- `pkg/aiusechat/usechat.go` — checks `Usage.InputTokens > budget * 0.8` and triggers compaction

**Data flow:**

1. After each step, read `metrics.Usage.InputTokens`
2. If over threshold: `chatstore.CompactMessages(chatId, 1, 10)` drops everything in between
3. Next step sends the truncated history to the model

**Trade-offs:** No summarization means lost context, but the agent can re-read files via `read_text_file` if needed. Simpler than AI summarization, no extra API calls.

---

## 4. Dangerous command detection

**Problem:** Shell commands like `rm -rf /` could destroy the user's system if approval is auto-granted by mode policy.

**Approach:** Pattern-match the command text in `ToolVerifyInput` and override `approval` to `NeedsApproval` regardless of mode policy.

**Files:**

- `pkg/agent/tools/dangerous.go` — `IsDangerousCommand(cmd string) bool`
- `pkg/agent/tools/shell_exec.go` — `ToolVerifyInput` calls `IsDangerousCommand` and forces approval

**Patterns covered (12):** `rm -rf`, `git push --force`, `git reset --hard`, `dd if=/of=`, `mkfs`, `chmod 777`, `:(){:|:&};:` (fork bomb), `curl ... | sh|bash`, `wget ... | sh`, `eval $(curl)`, `> /dev/sd*`, `kill -9 1`.

**Data flow:**

1. Agent emits `shell_exec` with cmd
2. `processToolCallInternal` calls `ToolVerifyInput(input, toolUseData)`
3. `verifyShellExec` runs `IsDangerousCommand(cmd)` — if true, sets `toolUseData.Approval = NeedsApproval`
4. Step loop sees the override and prompts the user even in auto-approve mode

**Trade-offs:** Regex patterns can be bypassed (`r''m -rf`, base64-encoded commands). Defense in depth, not a security boundary.

---

## 5. Structured audit log

**Problem:** No way to inspect what the agent did after the fact — hard to debug failures or build trust.

**Approach:** Every tool call appends a `ToolAuditEvent` to `AIMetrics.AuditLog`. A `MetricsCallback` on `WaveChatOpts` lets external consumers (e.g. trajectory writer) persist the log.

**Files:**

- `pkg/aiusechat/uctypes/uctypes.go` — `ToolAuditEvent`, `AIMetrics.AuditLog`, `MetricsCallback`
- `pkg/aiusechat/usechat.go` — `processToolCall` populates the event, `applyOutcome` appends
- `pkg/agent/agent.go` — `makeTrajectoryWriter(cwd, chatID)` writes JSON to `.crest-trajectories/<chatid>.json`

**Event fields:** timestamp, chat_id, tool_name, tool_call_id, input_args (truncated to 200 chars), approval, duration_ms, outcome, error_text.

**Data flow:**

1. Tool starts → `startTs := time.Now()`
2. Tool finishes → build `ToolAuditEvent` with elapsed time + outcome
3. Returned in `ToolCallOutcome.Audit`
4. `applyOutcome` appends to `metrics.AuditLog`
5. End of turn → `MetricsCallback(metrics)` triggers trajectory file write

**Trade-offs:** Args truncated at 200 chars so secrets in long inputs don't leak to disk. Trade vs full reproducibility — chose privacy.

---

## 6. Anthropic prompt caching

**Problem:** System prompt + tool schemas are repeated on every step. With Claude, that's ~80% of input tokens duplicated. Anthropic charges full price unless you mark cache breakpoints.

**Approach:** Set `cache_control: {type: "ephemeral"}` on the last system prompt block and the last tool definition. Anthropic caches everything up to those points for 5 minutes.

**Files:**

- `pkg/aiusechat/anthropic/anthropic-convertmessage.go` — applies cache_control during request building
- `pkg/aiusechat/anthropic/anthropic-types.go` — `anthropicCachedToolDef` wrapper

**Why a wrapper type for tools:** `ToolDefinition` is shared across all backends and shouldn't carry Anthropic-specific cache fields. The wrapper inlines tool fields + adds `cache_control` only when serializing for Anthropic.

**Data flow:**

1. Build system prompt array
2. Mark last block with cache_control
3. Build tool array
4. Wrap last tool in `anthropicCachedToolDef` with cache_control
5. Subsequent requests within 5 min get cache hits — usage is reported in `cache_creation_input_tokens` and `cache_read_input_tokens`

**Trade-offs:** Only Anthropic supports this. OpenAI/Google have automatic caching but no explicit control. 5-min TTL means idle sessions lose cache (acceptable).

---

## 7. Parallel tool execution

**Problem:** When the model emits 5 `read_text_file` calls in one step, running them sequentially wastes time. Each is independent and side-effect-free.

**Approach:** Add a `Parallel bool` field to `ToolDefinition`. If ALL tools in a step have `Parallel: true` AND none need approval, run them concurrently. Otherwise sequential (preserves approval ordering).

**Files:**

- `pkg/aiusechat/uctypes/uctypes.go` — `Parallel bool` on `ToolDefinition`
- `pkg/aiusechat/usechat.go` — `processAllToolCalls` decides serial vs parallel
- `pkg/aiusechat/usechat.go` — `processToolCall` returns `ToolCallOutcome` (immutable) for thread safety; `applyOutcome` mutates metrics on the main goroutine

**Tools marked parallel:** `read_text_file`, `read_dir`, `get_scrollback`, `cmd_history`. (Read-only, no shared state.)

**Data flow:**

1. `processAllToolCalls` checks: `allParallel && noApprovalNeeded`?
2. If yes: spawn `sync.WaitGroup`, one goroutine per tool, collect outcomes
3. If no: loop sequentially as before
4. Either way: apply outcomes serially on main goroutine (audit order preserved)

**Trade-offs:** Approval prompts force serial mode (you can't parallel-prompt). Mixed parallel+serial in one step also forces serial (simpler invariant). Could be smarter but YAGNI for now.

---

## 8. Diff preview

**Problem:** Approving a write means clicking "OK" without seeing what changes. Trust requires visibility.

**Approach:** Backend computes original + modified content for write/edit. Frontend uses `jsdiff.structuredPatch` to render unified diff with 3 lines of context. Line-level coloring (green/red/blue) inline in the approval card.

**Files:**

- `pkg/aiusechat/tools_writefile.go` — `verifyWriteTextFileInput`, `verifyEditTextFileInput` populate `OriginalContent` and `ModifiedContent` on `UIMessageDataToolUse`
- `pkg/aiusechat/uctypes/uctypes.go` — `OriginalContent`, `ModifiedContent` fields
- `frontend/app/view/term/term-agent.tsx` — `TermAgentInlineDiff` component using jsdiff

**Why jsdiff over Monaco:** Monaco is heavy (~5MB), overkill for a small inline diff. jsdiff is 50KB and gives us hunks with context.

**Why jsdiff over hand-rolled Go diff:** Frontend is the right place — it's where rendering happens. The backend just sends raw content; the diff itself is computed in the browser.

**Data flow:**

1. Tool's `ToolVerifyInput` reads existing file (or returns nil for new file) → sets `OriginalContent`
2. Same callback computes the modified content → sets `ModifiedContent`
3. Both included in `data-tooluse` SSE event sent to frontend
4. `TermAgentInlineDiff` runs `Diff.structuredPatch(filename, filename, original, modified, "", "", {context: 3})`
5. Renders hunks with `+` (green), `-` (red), `@@` (blue) lines

**Edge cases:**

- New file (no original) → green-tinted preview
- Identical content → "No changes" badge
- File too large → diff truncated with "(N more lines)" suffix

**Trade-offs:** Sending full file content over SSE doubles the payload for write tool calls. Acceptable for files under 100KB (the tool's max).

---

## 9. Plan-to-Do handoff

**Problem:** After `:plan` writes a plan file, the user has to manually retype the task in `:do` mode and remember the plan path.

**Approach:** Frontend detects `write_plan` completion in `data-tooluse` events, shows an "Execute Plan" button. Click switches to `:do` mode and sends "go" trigger. Backend reads the plan file and injects it into the system prompt.

**Files:**

- `pkg/agent/http.go` — `PostAgentMessageRequest.PlanPath`, reads file → `PlanContext` on `AgentOpts`
- `pkg/agent/agent.go` — appends `## Active Plan\n...` to system prompt when `PlanContext != ""`
- `frontend/app/view/termblocks/termblocks.tsx` — `termAgentLastPlanPath`, `executePlan()` method
- Frontend: `useEffect` scans messages for `data-tooluse` parts where `toolname === "write_plan"` and `status === "completed"`

**Data flow:**

1. `:plan build a feature` → agent calls `write_plan` → tool sets `InputFileName = .crest-plans/feature.md`
2. SSE event with `data-tooluse {toolname: "write_plan", status: "completed", inputfilename: "..."}` reaches frontend
3. Frontend stores `termAgentLastPlanPath`
4. UI shows "Execute Plan" button after streaming completes
5. Click → `executePlan()` sets pending mode to "do", sends "go" message with `planpath` in body
6. Backend reads file, injects into system prompt for the new turn

**Trade-offs:** Plan path is sent once per request and cleared. If the user clicks Execute multiple times, it works on the first click only. Acceptable — second click would just re-send "go" without a plan.

---

## 10. Runtime model switcher

**Problem:** Switching models requires editing `settings.json` and restarting. Want to A/B test models mid-session.

**Approach (current — §24 ai-config refactor):** Model chip popover in the input bar reads the in-repo catalog + `~/.config/crest/ai.json` and writes the selected `{provider, model, reasoning?}` triple to `block.meta["agent:selection"]`. Each agent request resolves the selection client-side into a complete `AIConfigRequest` and posts it; the backend ingests via `aiusechat.BuildAIOptsFromConfig`. No legacy `:model` slash command.

**Files:**

- `frontend/app/view/cmdblock/model-picker-popover.tsx` — sectioned popover
- `frontend/app/store/ai-resolver.ts` — `resolveAIConfig` (catalog + user_config → ResolvedAIConfig)
- `frontend/app/term/render/terminal-view.tsx` — derives `activeSelection` from meta + `userConfig.default`, computes `resolvedAIConfig`, threads to AgentChatHost
- `pkg/agent/http.go` — `PostAgentMessageRequest.AIConfig`, no longer reads ai:\* settings
- `pkg/aiusechat/aiconfig.go` — `BuildAIOptsFromConfig`

**Trade-offs:** `modeloverride` (the old wire-level escape hatch) still works for eval harnesses that need to override a single field without authoring a full `ai.json` — passed in the request body, overrides `aiOpts.Model` after resolution.

**Historical (pre-2026-05):** Earlier crest had a `:model <name>` slash command + `termAgentModelOverride` state in the input bar. Replaced by the picker UI as part of §24 (the ai-config refactor); the chatstore still uses its existing model-mismatch handling — switching models mid-conversation may force a fresh chat id depending on provider compatibility, same behavior as before.

---

## 11. Live token counter

**Problem:** Users have no visibility into token usage / cost during a session.

**Approach:** Backend sends `data-usage` SSE event after each step with cumulative input/output tokens. Frontend renders the latest counts in the agent area.

**Files:**

- `pkg/aiusechat/usechat.go` — emits `data-usage` event in step loop
- `frontend/app/view/term/term-agent.tsx` — `TermAgentTokenCounter` component scans message parts for latest `data-usage`

**Data flow:**

1. Step completes → backend reads `metrics.Usage.InputTokens` + `OutputTokens`
2. Sends `data-usage {input, output, model}` SSE event
3. ai-sdk pushes it as a message part of type `data-usage` on the assistant message
4. `TermAgentTokenCounter` finds the most recent `data-usage` part and renders `1,234 in / 567 out`
5. Hidden when both are 0 (free models that don't report usage)

**Trade-offs:** No cost calculation (would need a per-model price table maintained somewhere). Tokens are the proxy.

---

## 12. Inline agent blocks (Warp-style)

**Problem:** The floating overlay covered terminal content, captured scroll, and disconnected agent text from tool results. Modal UX felt out of place in a terminal.

**Approach:** Render agent messages as blocks inline in the termblocks timeline. Two data sources (PTY events + ai-sdk SSE) merge into one timeline atom sorted by timestamp.

**Files:**

- `frontend/app/view/termblocks/termblocks.tsx` — `TimelineEntry` union, `timelineAtom`, `TermAgentChatProvider`, `InlineAgentUserMsg`, `InlineAgentResponse`, `syncAgentMessages()`
- `frontend/app/view/term/term-agent.tsx` — exported `TermAgentMessagePartView` (reused inline), `TermAgentChatProvider` (hosts useChat invisibly)

**Key decision: derived atom**

```ts
timelineAtom = atom((get) => {
  const cmds = get(blocksAtom).filter(visible).map(toCmdEntry);
  const agent = get(agentEntriesAtom);
  return [...cmds, ...agent].sort((a, b) => a.ts - b.ts);
});
```

**Data flow:**

1. PTY events update `blocksAtom` (existing pipeline, unchanged)
2. `useChat` messages update via `syncAgentMessages(messages, status)` → writes `agentEntriesAtom`
3. `timelineAtom` merges and sorts
4. `TermBlocksView` maps timeline entries to either `TermBlockRow` (cmd) or `InlineAgentResponse` (agent)
5. `:` prefix in `TermBlocksInput` activates agent mode → Enter routes to `submitTermAgentPrompt` instead of PTY

**Trade-offs:** Two data sources increase complexity vs single store. But fully unifying them would require restructuring the PTY pipeline — out of scope. The merge-by-timestamp approach is small and additive.

---

## 13. File checkpointing + rewind

> **Superseded architecture.** The deleted Go `CheckpointStore`,
> `FileChangeCallback`, `ChangeOperation`, `beforeContentHash`, and
> `filebackup.MakeFileBackup` flow described in older revisions is no longer
> present or authoritative. Tool write/edit callbacks cannot see bash, hosted
> PTY, CLI-subagent, or future-tool mutations.

The current Electron/TypeScript Agent captures the whole supported workspace
scope at durable user-turn boundaries. It stores raw file bytes in a private
bare object store at
`<wave-data>/agent-checkpoints/workspaces/<workspace-identity>-<incarnation>/repo.git`
without touching user Git HEAD/index/stash, and works identically in non-Git
workspaces. Session entries own before/after descriptors and an exact
changed-path manifest. The 5 GiB per-workspace soft quota cleans only unowned
objects; referenced trashed-session data requires an owner-specific confirmed
purge.

Revert restores only paths in the selected active-branch suffix. Normal mode
does no mutation on drift. `Force revert` may overwrite only previewed red
drift rows and shows the exact warning
`files changed on disk since the agent last wrote them`; unsafe types,
directory collisions, missing coverage, stale state, and recovery are never
forceable. A workspace lock, safety snapshot, durable phase journal, per-path
verification, and SQLite leaf compare-and-swap make file restore and
conversation movement one recoverable operation. Unknown bytes freeze recovery
without whole-workspace reset or Force.

Successful Revert restores the selected prompt to the composer and persists a
single Redo dock across reload. Redo uses the same checks but never offers
Force. `/rewind` uses the same preview/apply path as message-side Revert;
`/tree` remains conversation-only. Workspace rewind initializes by default on
supported platforms; real platform, identity, storage, and recovery failures
remain explicit hard blocks.

OpenCode Core v2 is the reference for private snapshot/selective restore and
the persistent revert surface. Pi/pi-rewind is the reference for user-turn
checkpoint lifecycle and `/rewind` selection. Multi-session isolation,
drift/Force behavior, durability, recovery, quota, canonical identity, and
one-step Redo are Crest-owned.

---

## 14. Git worktree sandboxing

**Problem:** When the agent works on risky changes (refactor, migration), the user wants isolation from main working tree.

**Approach:** `:worktree [name]` command creates `.crest/worktrees/<name>/` with branch `worktree-<name>` (Claude Code model). Opt-in, persistent across turns. When active, agent operations use the worktree as cwd.

**Files:**

- `pkg/agent/sandbox.go` — `MakeWorktree`, `Worktree.HasChanges`, `Worktree.Remove`, random name generator
- `pkg/agent/http.go` — `AgentWorktreeHandler` at `/api/agent-worktree` (create/remove/status)
- `frontend/app/view/termblocks/termblocks.tsx` — `:worktree` command, `worktreePath` state, `buildTermAgentContext` returns worktree as cwd

**Why per-session not per-task:** Per-task means creating/destroying for every `:do` invocation — too much overhead, lose changes between turns. Per-session matches user mental model (start a feature → work on it → merge or discard).

**Data flow:**

1. User types `:worktree feature-auth`
2. Frontend POSTs `/api/agent-worktree {action: create, cwd, name: "feature-auth"}`
3. Backend: `git rev-parse --show-toplevel` → repo root, then `git worktree add .crest/worktrees/feature-auth -b worktree-feature-auth`
4. Returns `{name, path, branch}`
5. Frontend stores `worktreePath`
6. Subsequent `buildTermAgentContext()` returns `worktreePath` as cwd → agent tools operate there
7. `:worktree exit` → backend `git worktree remove --force` + `git branch -D`

**Trade-offs:** Adds `.crest/worktrees/` to repo (user must gitignore). Doesn't auto-clean on crash (manual `git worktree prune` if needed).

---

## 15. Sub-agent delegation

**Problem:** Some tasks are scoped well-defined sub-problems (e.g. "summarize this file"). Running them in the main conversation pollutes context with their tool-call noise.

**Approach:** `spawn_task` tool runs a child agent with isolated chat context, same model + tools, 15-step budget. Returns a completion summary to the parent.

**Files:**

- `pkg/agent/tools/spawn_task.go` — `SpawnTask`, `SpawnTaskConfig`, `runSpawnTask`
- `pkg/agent/registry.go` — `case "spawn_task"` builds `SpawnTaskConfig` with closure pointers to `SystemPromptForMode` + `ToolsForMode`

**Why closures in config:** `pkg/agent/tools` cannot import `pkg/agent` (would cycle). Closures inject the needed functions at registration time without breaking the dependency rule.

**Data flow:**

1. Agent calls `spawn_task {task: "...", mode: "ask"}`
2. Tool generates new chatId, builds `WaveChatOpts` with the parent's AI config but isolated chatstore entry; subtask context is derived from parent so cancellation propagates
3. Uses `MakeDiscardSSEHandlerCh` (not `httptest.NewRecorder`) so SSE writes drain rather than fill a buffer and error out after ~10 messages
4. Calls `aiusechat.RunAIChat(ctx, sseHandler, backend, chatOpts)` directly; auto-approves all non-dangerous tools (the sub-agent has no UI)
5. Returns metrics summary (steps, tool calls, tokens) — not the actual response text (would require extracting from chatstore, complex)
6. `defer chatstore.DefaultChatStore.Delete(subChatId)` cleans up the isolated chat entry

**Approval handling:** Sub-agent auto-approves every tool call by default. _However_, `shell_exec.ToolVerifyInput` overrides `Approval = NeedsApproval` for any command flagged by `IsDangerousCommand` (rm -rf, fork bomb, eval $(curl), etc.) — and the sub-agent has no UI to grant approval. **Dangerous commands inside a sub-agent therefore block until the 120s spawn-task timeout.** This is intentional: a sub-agent silently running `rm -rf /` would be far worse than blocking. Callers should structure sub-tasks to avoid dangerous shell commands; if you genuinely need them, run the sub-task as a foreground turn instead.

**Trade-offs:** Returning summary instead of text means the parent agent gets a thumbs-up but not the answer. For "summarize this file" this is wrong. For "go run a long-running test" this is fine. We chose the simpler implementation; future work could extract the last assistant text from the sub-chatstore.

---

## 16. Background shell_exec

**Problem:** `npm run dev`, `python -m http.server`, etc. run forever. The agent shouldn't block on them.

**Approach:** Add `background: true` to `shell_exec`. When true, the tool returns immediately after starting the process, without waiting for completion. The block remains visible — user can monitor it.

**Files:**

- `pkg/agent/tools/shell_exec.go` — `shellExecInput.Background`, early-return after `ResyncController`

**Data flow:**

1. Agent calls `shell_exec {cmd: "npm run dev", background: true}`
2. Tool creates the cmd block, queues layout, starts the controller (same as foreground)
3. With `Background: true`: skip the poll-wait loop, return `{block_id, stdout_tail: "started in background"}`
4. Block keeps running in user's tab; agent can read state later via `get_scrollback`

**Trade-offs:** No way for the agent to kill the background process from another tool call (would need a kill_block tool). User can close the block manually. Acceptable for MVP.

---

## 17. Web fetch tool

**Problem:** Agent can't read external docs/APIs without leaving the terminal.

**Approach:** `web_fetch {url}` tool that GETs the URL, strips HTML to text, returns up to 100KB. Available in all 3 modes.

**Files:**

- `pkg/agent/tools/web_fetch.go` — `WebFetch`, `fetchAndExtract`, `extractText`

**HTML extraction:** Uses `golang.org/x/net/html` tokenizer. Skips `<script>`, `<style>`, `<noscript>`, `<svg>` elements. Preserves block-level breaks (`<p>`, `<div>`, `<li>`, `<h*>`, `<tr>`, `<br>`).

**Limits:**

- 15s timeout
- 512KB download max (LimitReader)
- 100KB output max (truncated)
- User-Agent: `Crest/1.0 (coding agent)`

**Data flow:**

1. Agent calls `web_fetch {url: "https://docs.foo.com/api"}`
2. Validate URL has http(s) scheme
3. HTTP GET with timeout
4. If `Content-Type: text/html`: tokenize and extract text
5. Otherwise: return raw content (handles JSON, markdown, etc.)
6. Truncate to 100KB

**Trade-offs:** No JS execution (static HTML only). Some sites are SPA-only and return empty bodies. Agent can fall back to `browser.navigate` + `browser.read_text` for those.

---

## 18. Golden transcript test framework

**Problem:** Hard to verify agent behavior without spending API credits. Hard to catch regressions.

**Approach:** Mock `UseChatBackend` that replays recorded LLM responses against real tools running in a temp directory. Assertions check tool call sequence, final text, and file system state.

**Files:**

- `pkg/agent/eval/types.go` — `GoldenTranscript`, `GoldenTurn`, `GoldenResponse`, `GoldenAssertions`
- `pkg/agent/eval/mock_backend.go` — `MockBackend` implementing `UseChatBackend` with response queue
- `pkg/agent/eval/replay.go` — `RunGoldenTest`, `setupWorkspace`, `checkAssertions`, `RunAllGoldenTests`
- `pkg/agent/eval/testdata/*.golden.json` — 21 test cases

**Format:**

```json
{
  "name": "ask-read-file",
  "mode": "ask",
  "setup": { "files": { "hello.txt": "Hello, World!" } },
  "turns": [
    {
      "user": "What's in hello.txt?",
      "responses": [
        { "tool_calls": [{ "name": "read_text_file", "input": { "filename": "{{CWD}}/hello.txt" } }] },
        { "text": "The file contains: \"Hello, World!\"" }
      ]
    }
  ],
  "assertions": {
    "tools_called": ["read_text_file"],
    "final_text_contains": ["Hello, World!"]
  }
}
```

**`{{CWD}}` substitution:** Tool inputs are JSON-traversed and `{{CWD}}` is replaced with the test's temp dir before each run. Lets transcripts work with absolute-path tools without hardcoding paths.

**Auto-approve override:** Eval forces all `ToolApproval` callbacks to return `AutoApproved`. Otherwise mutation tools would block on user prompt.

**Coverage (21 tests):** ask-read-file, ask-list-dir, do-write-file, do-edit-file, plan-write-plan, multi-turn flows, error recovery, web_fetch, etc.

**Trade-offs:** Mocked LLM means we can't test prompt quality, only tool plumbing. Real agent behavior diverges from transcripts when models update. Acceptable as a regression net for tool/loop logic.

---

## 19. CI workflows

**`.github/workflows/agent-tests.yml`** — runs on PRs touching `pkg/agent/**` or `pkg/aiusechat/**`:

- `go test -race ./pkg/agent/... ./pkg/aiusechat/...`
- Golden transcripts via `TestGoldenTranscripts`
- Race detector catches concurrent map access bugs

**`.github/workflows/harbor-nightly.yml`** — runs terminal-bench 2.0 on schedule (3:37 AM UTC daily) + manual trigger:

- Builds `wavesrv` from source
- Installs Harbor via pip
- Runs the full benchmark with configurable model + task count
- Uploads results + logs as artifacts
- Requires `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` repo secret

**Trade-offs:** Harbor nightly is expensive (~30 min on the full suite, real API costs). Manual trigger lets contributors run cheaper smoke tests on demand. Results aren't auto-tracked over time — would need a leaderboard repo.

---

## 20. Track C — agent UI on the new term engine

**Problem:** The term-engine migration (P1–P16 in `docs/term-engine-migration.md`) removed the legacy `view/term/term-agent.tsx` overlay and its `TermAgentChatProvider`. The Go backend kept emitting `data-tooluse` SSE events into a void; new dev sessions show shell blocks but agent output and tool-use cards never render.

**Approach:** Add a `Block.kind` discriminator (`shell` | `agent`) so agent exchanges become first-class blocks alongside command output. Append-only positioning by call order — no timestamp re-sort — mirrors warp's `BlockList::append_item_to_blocklist` semantics (`app/src/terminal/model/blocks.rs:1074`). A new `AgentChatHost` owns ai-sdk's `useChat` hook and bridges its message stream into per-block state on `TerminalModel`, so jotai and useChat each own their natural domain.

**Files:**

- `frontend/app/term/engine/block.ts`, `engine/types.ts`, `engine/blocks.ts` — kind discriminator + `AgentPayload` + `appendAgentBlock` factory
- `frontend/app/term/engine/block-handler.ts:110-111` — `isAgent()` gate skips ANSI dispatch for agent blocks
- `frontend/app/term/terminal-model.ts` — `agentVisible/Posture/ChatStatus/ChatId/ModelOverride/Parts` atoms + `submitAgentMessage`/`applyAgentDelta`/`applyAgentStatus`/`applyAgentParts`/`getRecentCommands`
- `frontend/app/term/render/agent-block-element.tsx` — block view (header + user msg + markdown body / parts stream)
- `frontend/app/term/render/agent-chat-host.tsx` — useChat host, request body builder, message-stream sync
- `frontend/app/term/render/block-list-element.tsx:246-262` — kind-based dispatch
- `frontend/app/term/render/terminal-view.tsx:326-339` — onSubmit picks PTY vs useChat by mode

**Data flow:**

1. `cmdblock-input` submits with mode resolved to "agent" (explicit pick or NLD verdict).
2. `TerminalView.onSubmit` calls the `submit` fn exposed via `AgentChatHost.onReady`.
3. `submit` mints exchangeId, calls `model.submitAgentMessage(text)` to append an agent block, then `useChat.sendMessage(text, {messageId: exchangeId})`.
4. useChat POSTs `/api/post-agent-message` and streams; a sync `useEffect` walks messages, finds the user-message id as exchangeId, calls `applyAgentParts` / `applyAgentText`.
5. `AgentBlockElement` re-renders via revision bump; tool-use parts route to `ToolUseCard`.

**Trade-offs:** Append-only positioning means an agent block created during a still-running shell command appears below it (matches warp). Engine changes are pure additions — the shell-block path is untouched, so regression risk is contained to the kind-discriminator dispatch.

---

## 21. Typed citations + chip rendering

**Problem:** Agents emit commands and answers, but users can't easily verify what those are based on. A command suggestion may come from a stale README or an irrelevant blog post; the user should be able to click the source.

**Approach:** A `Citation` value attached to tool-use records, rendered as clickable chips beneath each tool-use card. Mirrors warp's `AIAgentCitation` enum (`crates/ai/src/agent/citation.rs:5-11`) but adds `file` and `history` kinds with `LineStart`/`LineEnd` to cover crest's `search` and `cmd_history` tools (warp's three-kind enum doesn't cover those use cases — recorded in `docs/warp-agent-improvement-plan.md` → Audit C-class decisions).

**Files:**

- `pkg/aiusechat/uctypes/uctypes.go` — `Citation` struct + `CitationKind_*` consts + `AddCitation` helper with dedup; mirrored field on `UIMessageDataToolUse` and `ToolAuditEvent`
- `pkg/aiusechat/usechat.go` — finalize copies `toolusedata.Citations` into the per-call audit row; new fast path so `ToolAnyCallback` returning a plain string passes through raw (no JSON quoting)
- `pkg/agent/tools/web_fetch.go`, `search.go`, `cmd_history.go` — each populates citations during the callback
- `frontend/app/store/aitypes.ts` — TS mirror of Citation + tooluse field
- `frontend/app/term/render/citation-chips.tsx` — chip render + per-kind click dispatch (web → openExternal, file → onFileJump, history → clipboard, doc → openExternal)
- `frontend/app/term/render/tool-use-card.tsx` — chips at card bottom

**Data flow:**

1. Tool callback emits citations via `data.AddCitation({kind, url, title, linestart, lineend})`.
2. usechat finalize copies them into the audit row for trajectory replay.
3. SSE `data-tooluse` event carries them to the FE.
4. `CitationChips` renders one button per entry; click dispatches per kind.

**Trade-offs:** The `web_fetch` and `search` tools migrated from `ToolTextCallback` to `ToolAnyCallback` so they can write into `*UIMessageDataToolUse`; the dispatcher patch ensures plain-string outputs aren't accidentally JSON-quoted. File-jump click currently copies `path:line` to clipboard rather than scrolling to a block — proper scroll-to-block needs a filename→block index and is a P0.7 carry-over.

---

## 22. `ask_user_question` tool

**Problem:** Agents at a genuine fork ("did you mean dev or main?", "framework X or Y?") otherwise guess and waste turns on retracted choices, or apologize in prose. Neither is as good as just asking once with explicit options.

**Approach:** A first-class tool that pauses the turn with a multi-choice card. Schema and data shape mirror warp's `AskUserQuestionItem` (`crates/ai/src/agent/action/mod.rs:611-657`): up to four questions per call, each with a nested `questiontype` discriminator (today only `multiplechoice`); 2–4 options each; optional `supportsother` for free-form fallback; `recommended` flag highlights the agent's default. The user's answers ride back through the existing approval RPC.

**Files:**

- `pkg/aiusechat/uctypes/uctypes.go` — `AskUserQuestion{Option, Type, Item, Payload, Answer}` types
- `pkg/aiusechat/toolapproval.go` — `ApprovalRequest.askAnswers` + `UpdateToolApprovalWithAnswers` + `WaitForToolApproval` returns `(approval, answers, err)`
- `pkg/aiusechat/usechat.go:386-404` — dispatcher copies answers onto `toolusedata.AskAnswers` before the tool callback runs
- `pkg/wshrpc/wshrpctypes.go` — `CommandWaveAIToolApproveData.AskAnswers`
- `pkg/wshrpc/wshserver/wshserver.go:1310` — routes through `UpdateToolApprovalWithAnswers`
- `pkg/agent/tools/ask_user_question.go` — tool definition, nested schema, strict parser
- `pkg/agent/registry.go` + `profile.go` — registered in ask / plan / do modes (not bench — bench expects deterministic non-interactive runs)
- `frontend/app/term/render/tool-ask-card.tsx` — interactive card (1–9 select, ← → between questions, ⌘↵ submit, Esc cancel) + `ToolAskSummary` read-only render for resolved state
- `frontend/app/term/render/tool-use-card.tsx` — dispatch by `needsApproval` between interactive card and summary

**Data flow:**

1. Agent emits `ask_user_question`; `ToolVerifyInput` populates `toolusedata.AskQuestion`.
2. FE renders `ToolAskCard`; user picks options.
3. User submits via `WaveAIToolApproveCommand({approval: "user-approved", askanswers: [...]})`.
4. Server calls `UpdateToolApprovalWithAnswers`; approval loop wakes; answers copy onto `toolusedata.AskAnswers`.
5. Tool callback formats answers as `{ answers: [...] }` JSON for the agent's next turn.
6. After resolution the card switches to `ToolAskSummary` (read-only chips).

**Trade-offs:** Keyboard left/right matches warp's `ask_user_question_view.rs:1400-1401`. Cancel binding is Esc rather than warp's Ctrl-C (`ask_user_question_view.rs:759`) because Ctrl-C in Electron is reserved for the surrounding shell. The system prompt explicitly tells the agent "use only on genuine forks" — without that, models love asking permission for trivia.

---

## 23. Long-running command tools (read / write / transfer)

**Problem:** `shell_exec(background: true)` lets the agent detach from a long-running process (dev server, watcher), but the agent then has no way to follow up — look at the log, send input, hand off when the process needs human attention.

**Approach:** Three new tools that operate on a background block by its `block_id`. Strict ports of warp's `ReadShellCommandOutput`, `WriteToLongRunningShellCommand`, and `TransferShellCommandControlToUser` actions (`crates/ai/src/agent/action/mod.rs:126-129, 61-65, 161-165`). The write tool's three modes (`raw` / `line` / `block`) match warp's `AIAgentPtyWriteMode` byte decoration (`action/mod.rs:762-812`): raw passes through, line wraps with SOH + LF for readline-style editors, block wraps in bracketed-paste markers.

**Files:**

- `pkg/agent/tools/long_running_read.go` — tail + nested `delay` (`{kind:"duration", duration_ms}` or `{kind:"oncompletion"}`) mirroring warp's `ShellCommandDelay::{Duration, OnCompletion}` enum
- `pkg/agent/tools/long_running_write.go` — `decorateLongRunningWriteBytes` matches warp's `decorate_bytes`; `SendInput` delivers to `blockcontroller`'s input pipe
- `pkg/agent/tools/transfer_to_user.go` — `wcore.QueueLayoutActionForTab` makes a hidden background block visible; agent is expected to stop driving it on subsequent turns
- `pkg/agent/tools/shell_exec.go` — `readBlockTail` refactored into `readBlockTailN(n)` + new `readBlockTotalBytes` so long_running_read shares the same filestore path
- `pkg/agent/registry.go` + `profile.go` — registered in do (all three) + bench (read + write; transfer excluded since bench expects non-interactive runs)
- `frontend/app/view/cmdblock/cmdblock-status.tsx` — exported `AgentWatchingBadge` + `TakeOverButton` scaffolding (not yet mounted into block headers — wiring deferred to a separate design pass)

**Data flow (typical dev-server workflow):**

1. Agent: `shell_exec({cmd: "npm run dev", background: true})` → returns `block_id`.
2. Agent: `long_running_read({block_id, delay: {kind:"duration", duration_ms: 2000}})` to give the server time to bind.
3. Reads the tail, confirms "Local: http://localhost:5173"; moves on to verification work.
4. If an interactive prompt appears: `long_running_write({block_id, input: "y", mode: "line"})`.
5. If the user is needed (OTP, auth prompt): `transfer_to_user({block_id, reason: "needs the GitHub OTP"})` — hidden block becomes visible; agent stops driving.

**Trade-offs:** `tail_bytes` cap is a crest extension over warp (warp's agent doesn't have an LLM context window to worry about). An earlier prototype of `long_running_write` exposed signal-sending (`mode: "control"` + `signal`); audit pass removed it — warp's `WriteToLongRunningShellCommand` doesn't carry signals, and exposing kill capability through the same tool without a dedicated approval gate is the wrong default. If we need it later, a separate `signal_block` tool with always-NeedsApproval is the right shape. `transfer_to_user` takes `block_id` explicitly because crest's Go tool system has no implicit "current block" session state the way warp's runtime tracks it.

---

## 24. AI configuration: catalog + user config + resolver

**Problem:** Earlier crest had two parallel AI config systems running side-by-side — legacy `ai:*` global settings (read by `pkg/agent/http.go:buildAIOptsFromSettings`) and a new `waveai@*` mode dict (read by `pkg/aiusechat/usechat-mode.go:getWaveAISettings`). The agent HTTP handler picked one or the other based on whether the request carried `aimode`. Three overlapping layers (`settings.json`, `waveai.json`, `presets.json:ai@*`), no single source of truth, API tokens duplicated per mode, provider knowledge (endpoint URLs, apitype mapping) leaked into user-edited JSON.

**Approach:** Four-layer architecture. (1) **Catalog** — static in-repo TS describing all known providers + popular models with endpoint, apitype, capabilities, context window, reasoning support. Maintained by crest contributors via PR. Lives in `frontend/app/store/ai-catalog.ts`. (2) **User config** — `~/.config/crest/ai.json` carries only what the user owns: their providers/credentials, default selection, optional saved profiles, optional custom models / custom endpoints not in the catalog. (3) **Selection** — per-pane `{provider, model, reasoning?}` triple persisted to `block.meta["agent:selection"]` by the model picker. (4) **Resolver** — `frontend/app/store/ai-resolver.ts` consumes (selection, user_config, catalog) and produces a `ResolvedAIConfig`. The frontend sends this on every agent request as the `aiconfig` field; backend's `aiusechat.BuildAIOptsFromConfig` ingests it 1:1 with no further catalog or settings lookups.

**Files:**

- `frontend/app/store/ai-catalog.ts` — the catalog (TS source of truth)
- `frontend/app/store/ai-types.ts` — `AgentSelection`, `UserConfig`, `ResolvedAIConfig`, error types
- `frontend/app/store/ai-resolver.ts` — `resolveAIConfig(selection, userConfig, catalog)`
- `frontend/app/store/ai-user-config.ts` — jotai atom + loader for ai.json
- `frontend/app/view/cmdblock/model-picker-popover.tsx` — sectioned picker UI
- `pkg/aiusechat/uctypes/userconfig.go` — Go mirror of the ai.json schema
- `pkg/aiusechat/userconfig.go` — `ReadAIUserConfig` / `WriteAIUserConfig` + validation
- `pkg/aiusechat/aiconfig.go` — `BuildAIOptsFromConfig(req AIConfigRequest) (*AIOptsType, error)` + `secretLookup` injection point
- `pkg/waveobj/wtypemeta.go` — `MetaTSType.AgentSelection` + `AgentSelectionMeta` shape
- `pkg/wshrpc/wshrpctypes.go` — `GetAIUserConfigCommand` + `WriteAIUserConfigCommand` RPCs, `GetAIUserConfigRtnData` (status-tagged: `ok`/`missing`/`malformed`)

**Data flow (per agent message):**

1. User edits `~/.config/crest/ai.json` → backend `wshrpc.GetAIUserConfigCommand` reads it → FE `aiUserConfigAtom` hydrates.
2. User clicks the model chip → `ModelPickerPopover` renders catalog + profiles + custom entries.
3. User picks → `block.meta["agent:selection"] = {provider, model, reasoning?}` via `ObjectService.UpdateObjectMeta`.
4. On submit, `terminal-view.tsx` reads the meta, runs `resolveAIConfig` (with catalog + userConfig) → `ResolvedAIConfig`.
5. `AgentChatHost`'s `prepareSendMessagesRequest` puts the resolved config in the request body's `aiconfig` field.
6. Backend `PostAgentMessageHandler` calls `aiusechat.BuildAIOptsFromConfig(req.AIConfig)`. Token resolution: literal `Token` > `TokenSecretName` via `secretstore.GetSecret` > empty (unauthed local endpoint).
7. `AIOptsType` flows to existing backends (`openai-responses`, `openai-chat`, `google-gemini`, `anthropic-messages`) unchanged.

**Deletions vs the old system (Phase E of the refactor):** Removed entirely — `pkg/aiusechat/usechat-mode.go` (`resolveAIMode`, `getAIModeConfig`, `applyProviderDefaults`), `pkg/agent/http.go:buildAIOptsFromSettings`, `SettingsType.AiApiType / AiBaseURL / AiApiToken / AiApiTokenSecretName / AiModel / AiMaxTokens / AiTimeoutMs`, `AIModeConfigType`, `AIModeConfigUpdate`, `FullConfigType.WaveAIModes`, `MetaTSType.WaveAIMode`, `ObjRTInfo.WaveAIMode`, `telemetrydata.WaveAIMode`, `AIOptsType.AIMode`, `uctypes.AIModeQuick/Balanced/Deep/Builder*` constants, `wshserver.GetWaveAIModeConfigCommand`, `frontend/app/view/waveconfig/waveaivisual.tsx`, `global-atoms.hasCustomAIPresetsAtom`, default `waveai.json` + `schema/waveai.json`. The 5 ai/waveai keys in `defaultconfig/settings.json` (`ai:preset`, `ai:model`, `ai:maxtokens`, `ai:timeoutms`, `waveai:defaultmode`, `waveai:showcloudmodes`) are also gone.

**Trade-offs:** Catalog is static (vs warp's proto-served Oz catalog) because crest doesn't have a backend catalog service and adding one would conflict with the BYO-API-key philosophy. Trade-off: model availability isn't backend-validated; a user picking a stale model gets the upstream provider's 404 instead of an early friendly error. Update cadence: in-repo PR to `ai-catalog.ts`. Reasoning is folded into the selection triple rather than a separate axis because most "models with reasoning" are really one model + a hint, not two models. POC stage: no migration script for existing legacy configs — users re-pick after upgrading.

**Reference:** Full design doc at [`docs/ai-config-architecture.md`](./ai-config-architecture.md).

### Workspace rewind rollout platform boundary

Workspace rewind's first release is supported on Linux and macOS. Windows is
an explicit hard-block, not a partially supported mode: the feature stays
unavailable until owner-only checkpoint-store ACLs, reparse-safe
inspection/apply, case-only replacement, and directory-fsync durability have
production implementations and pass the same coordinator and UI gate.
