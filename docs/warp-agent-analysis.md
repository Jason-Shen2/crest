# Warp Agent → Crest: Source-Grounded Analysis

Reference document for crest agent improvements derived from a reading of Warp's source tree. This is not a parity tracker — it is a one-time architectural read with a prioritized backlog of items judged worth porting.

## Status

- Generated: 2026-05-19
- Warp tree analyzed: `/Users/mac/Documents/open-source/warp`
- Crest baseline: this repo, at the analysis date
- All Warp paths below are relative to the Warp tree root. Line numbers are anchors from a read on the generation date — treat them as starting points, not eternal truths.
- Three items from the initial recommendation set were dropped as low-ROI for crest's roadmap; they remain in Section 2's capability tables with **SKIP — dropped** verdicts so future readers can see the decision was deliberate, not an oversight. See Section 3 "Dropped from roadmap" for the list.

---

## 1. Warp Agent Architecture Overview

### Top-level shape

Warp's agent is a **client-orchestrator + server-harness** split, not a self-contained loop. The Rust client owns terminal state, action dispatch, UI, and persistence; the *LLM loop itself* is delegated to a server-side service (`warp_multi_agent_api` / "Oz") with pluggable "harnesses" (Oz, Claude Code, Gemini, OpenCode, Codex). This is the most important architectural fact for a crest reader, and it is the source of both Warp's strengths (one client, many model loops) and weaknesses (you cannot run Warp's agent against your own API key without their service).

- **Entry**: `app/src/ai/blocklist/input_model.rs:50-121` — `InputConfig { input_type, is_locked }` toggles Shell vs AI; `app/src/ai/blocklist/agent_view/controller.rs:42-193` — `AgentViewController` manages full-screen vs inline display; `AgentViewEntryOrigin` (`:102-192`) enumerates ~40 entry points (keybinding, palette, CLI, etc.).
- **Driver**: `app/src/ai/agent_sdk/driver.rs:664-756` (`AgentDriver::run`) → `:1232-1320` (`run_internal`) sets up terminal session, MCP servers, cloud env, then invokes the harness.
- **Harness boundary**: harness is a trait; the actual model streaming happens behind `warp_multi_agent_api`. The driver registers an event consumer at `:699-701` and lets the harness drive.
- **Event stream**: `app/src/ai/blocklist/orchestration_event_streamer.rs` and `…/orchestration_events.rs:71-150` queue `AgentEvent` protos and route them to consumers; supports per-parent → per-child lifecycle subscriptions for multi-agent orchestration.
- **Action queue**: `app/src/ai/blocklist/action_model.rs:1-150` — `BlocklistAIActionModel` with `AIActionStatus` state machine (`Preprocessing → Queued → Blocked → RunningAsync → Finished`). Async **preprocessing** before queueing lets actions like `SearchCodebase` warm up while the user is still reading.
- **Conversation store**: `app/src/ai/blocklist/history_model.rs:185-200` — `BlocklistAIHistoryModel` keyed by `AIConversationId` (UUID). Persisted via `crates/persistence/` (Diesel + SQLite).
- **Orchestration config**: `crates/ai/src/agent/orchestration_config.rs:11-50` — `OrchestrationConfig { model_id, harness_type, execution_mode: Local | Remote { environment_id, worker_host } }` + `OrchestrationConfigStatus { None | Approved | Disapproved }`. `matches_active_config()` (`:64-96`) lets sub-agent spawns auto-launch if they do not change the approved config.

### Tool/action system — the 28-variant enum

`crates/ai/src/agent/action/mod.rs:32-177` defines `AIAgentActionType` with 28 variants. Each has a mirrored `AIAgentActionResultType` in `…/action_result/mod.rs`. Key clusters:

- **Shell**: `RequestCommandOutput { command, is_read_only: Option<bool>, is_risky: Option<bool>, wait_until_completion, uses_pager, rationale, citations }` (`:36-59`), `WriteToLongRunningShellCommand`, `ReadShellCommandOutput`, `TransferShellCommandControlToUser`.
- **Files**: `ReadFiles`, `RequestFileEdits { file_edits: Vec<FileEdit>, title }` (`:76-79`), `UploadArtifact`.
- **Search**: `SearchCodebase` (vector RAG), `Grep`, `FileGlob`/`FileGlobV2`.
- **Documents**: `ReadDocuments`, `EditDocuments`, `CreateDocuments` — Warp's first-class "AI document" concept (`crates/ai/src/document.rs`).
- **MCP**: `CallMCPTool`, `ReadMCPResource`.
- **Multi-agent**: `StartAgent` (`:148-154`), `SendMessageToAgent`, `RunAgents` (`:176`) with `RunAgentsRequest { summary, base_prompt, skills, model_id, harness_type, execution_mode, agent_run_configs }` (`:186-195`).
- **UX**: `AskUserQuestion { questions: Vec<AskUserQuestionItem> }` (`:167-169`), `SuggestNewConversation`, `SuggestPrompt`.
- **Computer use**: `UseComputer`, `RequestComputerUse` (live: `crates/computer_use/src/` — mac/linux/windows mouse/keyboard/screenshot, `lib.rs:76-106` enumerates `Action::MouseDown/Up/Move/Wheel/TypeText/KeyDown/KeyUp/Wait/Screenshot`).
- **Code review**: `InsertCodeReviewComments { repo_path, comments, base_branch }` (`:133-137`).
- **Skills**: `ReadSkill` (`:142`) — loads a skill MD at runtime.

Conversion API ⇄ internal lives in `…/action/convert.rs` (~600 LOC of `TryFrom` impls) and `…/action_result/convert.rs`. Tool args are **not streamed** — the full call is reassembled before conversion. (This is a real limitation; see Section 4.)

### Skills

`crates/ai/src/skills/` — skills are **knowledge artifacts, not tools**. Each is a Markdown file with optional YAML front matter (`parser.rs:38-97`) located at `~/.{agents,warp,claude,codex,cursor,gemini,copilot,factory,github,opencode}/skills/{name}/SKILL.md` or in-repo at the same relative paths. Provider ranks: Agents > Warp > Claude > Codex > Cursor > Gemini > Copilot > Droid > GitHub > OpenCode (`skill_provider.rs:104-158`). Scope is `Home | Project | Bundled`. The `ReadSkill` action loads one into the prompt when the agent needs it.

### Project/workspace context

`crates/ai/src/project_context/model.rs:1-712`. `ProjectContextModel` is a singleton that scans for `WARP.md` / `AGENTS.md` files **up to 3 levels deep, max 5000 files** (`:20`), gitignore-aware via the `ignore` crate, and emits `KnownRulesChanged(RulesDelta)` events when files change. `find_applicable_rules(path)` returns ancestor-applicable rules → injected into the next prompt.

### Codebase RAG

`crates/ai/src/index/full_source_code_embedding/` is a real RAG pipeline:
- `manager.rs:166-196` — per-workspace `CodebaseIndex` with a `BulkFilesystemWatcher` (10 s debounce) and a `BuildQueue`.
- `chunker.rs` — semantic (language-aware) chunking; tree-sitter via `crates/syntax_tree/`.
- Merkle-tree snapshots every ~10 min for incremental sync.
- Multi-model embedding: OpenAI `text-embedding-3-small` (256d), Voyage Code 3 / 3.5 / 3.5 Lite (512d).
- Retrieval is **on-demand**, invoked when the agent emits `SearchCodebase` — *not* auto-stuffed into every prompt.

### Streaming UI

- **Network**: `app/src/ai/blocklist/controller/response_stream.rs:45-261` — `ResponseStream` spawns the SSE consumer, 3-retry backoff, yields `ResponseStreamEvent::ReceivedEvent`.
- **State**: `history_model.rs:2177-2203` — `UpdatedStreamingExchange` event per delta.
- **Render**: `app/src/ai/blocklist/block/view_impl.rs:1-97`, output rendering at `…/view_impl/output.rs:219`.
- **Delta calc**: `crates/markdown_parser/src/lib.rs:64-107` — `compute_formatted_text_delta` produces `{ common_prefix_lines, old_suffix, new_suffix }` so the UI re-renders only changed lines (important for very long agent responses).
- **Inline previews**: `app/src/ai/blocklist/inline_action/requested_command.rs:1607-1620` (command suggestion chip), `…/code_diff_view.rs:1-100` (`warp_editor::DiffViewer` for file edits). Accept: `ACCEPT_PROMPT_SUGGESTION_KEYBINDING` (Cmd+Enter / Ctrl+Shift+Enter).
- **Citations**: `crates/ai/src/agent/citation.rs:6-26` — `AIAgentCitation::{WarpDriveObject, WarpDocumentation, WebPage}` attached to `RequestCommandOutput`; rendered as clickable chips at `view_impl.rs:655-728`.

### Safety / providers

- **Permission gate**: `app/src/ai/blocklist/permissions.rs:850-950`. Denylist → allowlist → `AgentDecides` mode (allows non-risky read-only if feature flag enabled) → `AlwaysAsk`. Per-action `is_read_only`/`is_risky` flags come *from the LLM* — defense-in-depth, not authoritative.
- **Command signatures**: `crates/command-signatures-v2/` and `command-signatures-v2/js/` — these are for **completion/parse**, not risk classification. Do not confuse them.
- **API keys**: `crates/ai/src/api_keys.rs:19-34` — `ApiKeys { google, anthropic, openai, open_router }` stored in OS keyring under one JSON blob ("AiApiKeys"); `aws_credentials.rs:10-49` uses the AWS chain (not persisted).
- **Providers**: `llm_id.rs:3-11` — `LLMId` is just a string wrapper. No local model support found (no ollama/llama.cpp/candle in the agent path; `candle` is used only by `input_classifier`).
- **Telemetry**: `crates/ai/src/telemetry.rs:13-47` — Rudderstack events for index ops; gated by feature flags; UGC-marked events route separately.
- **Sandbox/isolation**: `crates/isolation_platform/src/lib.rs:31-45` — `Docker | DockerSandbox | Kubernetes | Namespace` for self-hosted deployments. Client itself does **no** filesystem chroot — isolation is deployment-level (containers, pods).

### NLD ("is this NL vs shell?")

`crates/input_classifier/` (the active path; `crates/natural_language_detection/` is the older word-list crate it depends on). Two tiers: heuristic (`heuristic_classifier/mod.rs`) + ONNX `bert_tiny.onnx` with dual backends (`onnx/ort.rs` and `onnx/candle.rs`). Word lists at `crates/natural_language_detection/{words.txt, stack_overflow.txt, stack_overflow_overlap_command.txt}`. Eval harness at `src/bin/evaluate.rs`. Invoked from `app/src/ai/blocklist/input_model.rs:617-749`.

---

## 2. Capability-by-Capability Evaluation

Legend: **PORT** = take directly, **ADAPT** = good idea, needs rework, **SKIP** = does not apply or crest already has it, **SKIP — dropped** = considered and removed from roadmap.

### A. Agent loop & harness abstraction

| Item | Verdict | Reason |
|---|---|---|
| Top-level driver pattern (`AgentDriver`) | **SKIP — at parity** | Crest has `pkg/agent/agent.go` + `pkg/aiusechat/usechat.go` with `RunAgent`/`RunAIChat` step loop. Same shape, simpler. |
| Server-side harness abstraction (Oz/Claude/Gemini/etc.) | **SKIP** | Warp-specific; depends on their proprietary MAA service. Crest's provider abstraction (`pkg/aiusechat/anthropic\|openai\|google\|gemini`) is the right shape for an OSS product. |
| Async **action preprocessing** before queueing (`BlocklistAIActionModel`) | **ADAPT** | Latency win for `SearchCodebase`-style heavy actions. Crest's `processToolCall` is mostly inline; adding a "preprocess" phase per-tool would help if/when crest adds RAG. |
| `OrchestrationConfig.matches_active_config()` for sub-agent auto-launch | **ADAPT** | Useful pattern if crest's `spawn_task` grows. Currently overkill. |
| Generation-counter idle-timeout (`driver.rs:149-204`) | **SKIP** | Clever in Rust async; Go's `context.WithTimeout` makes it unnecessary. |

### B. Tool/action system

| Item | Verdict | Reason |
|---|---|---|
| Per-action `is_read_only` + `is_risky` LLM-emitted flags | **SKIP — dropped** | Low ROI for crest's current roadmap. Regex-based `pkg/agent/tools/dangerous.go` stays as the primary safety gate. |
| `rationale: Option<String>` on every tool call | **SKIP — dropped** | Low ROI; users have other signals (diff preview, audit log) for trust. |
| **Long-running command tools**: `WriteToLongRunningShellCommand` + `ReadShellCommandOutput` + `TransferShellCommandControlToUser` | **PORT** | Crest's `shell_exec.go` runs to completion. Warp lets the agent kick off a server, watch logs, send Ctrl-C, **hand back to the user**. This is a meaningful capability gap. |
| `AskUserQuestion { questions: Vec<AskUserQuestionItem> }` as a first-class tool | **PORT** | Crest has approval cards but not "agent asks a structured multi-choice question." Cheap to add; clarifies a lot of conversations. |
| `RequestFileEdits { file_edits: Vec<FileEdit>, title }` — batched edits with a single title | **ADAPT** | Crest has `multi_edit.go`; check whether it groups edits into a single approve-card. Title field improves UI. |
| `SuggestNewConversation` / `SuggestPrompt` actions | **SKIP** | Warp-specific UX (sidebar-driven). Low value for crest. |
| `InsertCodeReviewComments` tool | **ADAPT later** | Only relevant when crest builds a code-review surface. |
| `RunAgents` / `StartAgent` / `SendMessageToAgent` multi-agent | **ADAPT** | Crest has `spawn_task.go` (sub-tasks?). Warp's structure (shared `base_prompt` + per-child `agent_run_configs`) is cleaner; worth studying when crest's spawn tool grows. |
| `UseComputer` (mouse/keyboard/screenshot) | **SKIP** | Out of scope for a terminal-first product; crest has `tools_screenshot.go` for the basic case. |
| Skill system (Markdown SKILL.md with YAML front matter, multi-vendor scopes) | **SKIP — dropped** | Cross-vendor discovery convention judged low ROI. Crest's `pkg/agent/skills.go` + `pkg/agent/prompts/` is sufficient. |

### C. Prompt / context / session

| Item | Verdict | Reason |
|---|---|---|
| **WARP.md / AGENTS.md ancestor scan** with gitignore + 3-deep / 5000-file cap | **SKIP — dropped** | Monorepo win, but crest's single-file `CLAUDE.md` read is sufficient for current scope. |
| **Codebase RAG**: incremental Merkle-tree embedding index, on-demand retrieval | **ADAPT** | Real lift. Warp's pipeline (`crates/ai/src/index/full_source_code_embedding/`) is non-trivial. Worth it if crest plans repo-aware tasks; skip if focus stays single-file. |
| File-mention `FileLocations` with line ranges + `expand_surrounding_context` + grouping | **PORT (later)** | `crates/ai/src/agent/file_locations.rs:1-147`. Lightweight, clean abstraction; replaces ad-hoc "stuff file path strings in prompts" with a typed struct that also formats for display. Useful once @-mentions land in cmdblock-input. |
| Typed `AIAgentCitation` enum + UI chips | **PORT** | `crates/ai/src/agent/citation.rs:6-26`. Cheap, gives users "why did the agent pick this command/doc." |
| **Conversation/task DAG persistence** (`agent_conversations` ⇄ `agent_tasks` ⇄ `messages`) | **ADAPT** | Crest's chatstore is conversation-flat. Warp's two-level (conversation has many tasks, task has many messages) becomes valuable when sub-agents enter — `parent_task_id` lets you restore a fanned-out tree. Premature today; revisit when `RunAgents` lands. |
| Server-side prompt assembly via MAA | **SKIP** | Closed-source dependency. Crest's client-side assembly (`pkg/aiusechat/usechat-prompts.go`) is the correct architectural choice for OSS. |

### D. Streaming UI & previews

| Item | Verdict | Reason |
|---|---|---|
| `compute_formatted_text_delta` (line-level diff, only re-render the changed suffix) | **PORT** | `crates/markdown_parser/src/lib.rs:64-107`. Crest's inline blocks likely re-render the whole content per token; a TS port of this delta is a clear perf win for long responses. |
| Dedicated `DiffViewer` for proposed file edits with accept/reject keybinding | **SKIP — at parity** | Crest has `TermAgentInlineDiff` via jsdiff (`docs/agent-architecture.md:179-203`). |
| Inline command-preview chip with citations + rationale | **ADAPT** | Crest already has command preview; add citation chips under it (rationale dropped above). |
| GFM-table parser as a separate step (`crates/ai/src/gfm_table.rs:62-107`) | **SKIP** | Markdown lib choice. Crest can pick a TS lib with GFM-table support out of the box. |
| Citation chips with icon-by-source + click handler | **PORT** | Pairs with the citation typing recommendation. |
| Voice input (`crates/voice_input/`) | **SKIP** | Not a priority; out-of-scope for the terminal. |
| `ResponseStream` 3-retry SSE consumer | **SKIP — at parity** | Crest has `httpretry.go` on the backend; SSE retry is a frontend concern not in Warp's source on the client. |

### E. Safety / providers

| Item | Verdict | Reason |
|---|---|---|
| Denylist > allowlist > AgentDecides > AlwaysAsk gate | **SKIP — at parity** | Crest has `pkg/agent/permissions/` already. The LLM-flagged tier (`is_risky`) was dropped above. |
| `OrchestrationConfigStatus::{Approved, Disapproved}` — once user approves a config, sub-agent invocations matching it auto-launch | **ADAPT** | Good UX for multi-agent flows. Defer until crest does that. |
| Multi-provider keys in OS keyring as single JSON blob | **SKIP — at parity** | Crest stores via `pkg/wconfig` / `pkg/secretstore`. |
| Sandbox/isolation (`crates/isolation_platform/`) | **SKIP** | Deployment concern; not a client-side library. |
| Telemetry trait + UGC flag separation | **ADAPT** | If crest grows telemetry, the `contains_ugc: bool` boundary on each event is a clean privacy pattern. |
| `command-signatures-v2` | **SKIP** | Completion-time data; not safety. Crest uses different completion tooling. |
| Read-only session mode (block all agent commands at the session level) | **PORT** | Cheap, very useful "I want the agent to look but not touch." Crest does not expose this cleanly today. |

### F. NLD

The dedicated comparison concludes **crest is at parity or ahead** on NLD: tier-1 + tier-2 with multilingual MiniLM, explicit thresholds, training pipeline, quantization tooling. Three genuine gaps:

| Item | Verdict |
|---|---|
| Dual-backend tier-2 (ORT + Candle fallback) | **SKIP** — single ort-web path is fine for browser. |
| FastText alternate model | **SKIP** — multilingual MiniLM is better. |
| **Inline server-side telemetry** for classifier verdicts (Warp logs to backend, crest only `console.log`) | **PORT** when crest has a telemetry backend. |
| Online correction loop (collect user overrides → retrain) | **PORT — already scaffolded** (`training/finetune_classifier.py` + `corrections.jsonl` referenced in `frontend/app/term/nld/nld-model.ts:208`). Just needs the UI + persistence wiring. Neither Warp nor crest has it productionized. |

---

## 3. Prioritized Recommendations for crest

Four items, ordered by impact ÷ effort. Each names the Warp source pointer, the crest landing zone, an effort tag (S = days, M = ~week, L = ~weeks), and the risk that bites you.

### Dropped from roadmap

These were considered and excluded from the prioritized list as low ROI for crest's current direction:

- Per-call `rationale` / `is_read_only` / `is_risky` flags on tool calls — regex denylist + existing approval cards are deemed sufficient.
- Ancestor `CREST.md` / `AGENTS.md` scanning — single-file `CLAUDE.md` read is enough at current repo scale.
- Cross-vendor `~/.<vendor>/skills/` discovery convention — crest's local skill/prompt loader is sufficient; cross-vendor interop is not a near-term goal.

If future requirements change (heavy monorepo users, cross-tool skill sharing, model-declared safety becoming meaningfully better), revisit Section 2's PORT verdicts that pointed to these items.

### 1. Long-running command tools (`write_long_running`, `read_long_running`, `transfer_to_user`) (M)

- **Why**: Crest's `shell_exec` runs to completion. Real workflows ("start the dev server, tail the logs, hit Ctrl-C if it hangs, hand the terminal back") require the three-action set Warp has. This is the most user-facing capability gap.
- **Warp pointer**: `crates/ai/src/agent/action/mod.rs:61-65` (`WriteToLongRunningShellCommand`), `:126-129` (`ReadShellCommandOutput`), `:162-165` (`TransferShellCommandControlToUser`); the result variant `LongRunningCommandSnapshot` in `action_result/mod.rs`.
- **Crest landing zone**:
  - `pkg/agent/tools/shell_exec.go` — extend with `wait_until_completion: bool`. When `false`, return a snapshot + block ID.
  - New tools: `pkg/agent/tools/long_running_write.go`, `long_running_read.go`, `transfer_to_user.go`.
  - PTY plumbing: reuse `pkg/jobmanager/` (already has `JobCmd`, streams). The block ID returned to the LLM is the existing `oid`.
  - UI: `frontend/app/view/cmdblock/cmdblock-status.tsx` — render a "agent is watching this" badge + a "take over" button that wires `TransferShellCommandControlToUser`.
- **Effort**: **M**.
- **Risk**: PTY hand-off semantics (who owns the FD when control transfers). Test with `vim`, `top`, `python -i`, `npm run dev`.

### 2. `ask_user_question` as a first-class tool (S)

- **Why**: Reduces "agent guesses and then apologizes" loops. Multiple choice with optional free-form fallback.
- **Warp pointer**: `crates/ai/src/agent/action/mod.rs:167-169` + `AskUserQuestionItem`.
- **Crest landing zone**:
  - `pkg/agent/tools/ask_user_question.go` (new).
  - `pkg/aiusechat/uctypes/uctypes.go` — extend `UIMessageDataToolUse` if needed for the multiple-choice payload, or piggyback on existing approval card.
  - `frontend/app/view/term/term-agent.tsx` — new `TermAgentAskCard` component (a focused button grid + optional input).
  - Schema: each item has `question`, `header`, `options: [{label, description}]`, `multiSelect: bool`.
- **Effort**: **S**.
- **Risk**: None significant. Keep the UI keyboard-driven (1–9 to pick).

### 3. Markdown-render delta computation (`compute_formatted_text_delta` port) (S–M)

- **Why**: Streaming agent responses with code blocks re-render the entire body per token in many React setups. Warp computes a line-level common-prefix + new-suffix and only mutates the changed lines, which is meaningfully faster for long responses.
- **Warp pointer**: `crates/markdown_parser/src/lib.rs:64-107` (`compute_formatted_text_delta`).
- **Crest landing zone**:
  - `frontend/app/view/term/term-agent.tsx` (or a new `term-agent-markdown.tsx`).
  - Pure TS function; no backend change.
  - Hook into the `TimelineEntry` rendering inside the inline-agent block timeline (`frontend/app/view/termblocks/termblocks.tsx`).
- **Effort**: **S–M**.
- **Risk**: React reconciliation can mask the savings if you are already keying lines correctly — profile first to confirm there is actually a problem.

### 4. Typed `Citation` with chip rendering (S)

- **Why**: When the agent runs a command derived from your docs/web search/internal note, the UI should show the source. Currently crest has nothing typed for this.
- **Warp pointer**: `crates/ai/src/agent/citation.rs:6-26` (`AIAgentCitation::{WarpDriveObject, WarpDocumentation, WebPage}`); render at `app/src/ai/blocklist/block/view_impl.rs:655-728`.
- **Crest landing zone**:
  - `pkg/aiusechat/uctypes/uctypes.go` — add `Citation { kind: "web" | "doc" | "history"; url?: string; title: string }` to `ToolAuditEvent` or the message stream.
  - `pkg/agent/tools/web_fetch.go`, `search.go`, `cmd_history.go` — populate citations.
  - `frontend/app/view/term/term-agent.tsx` — new `TermAgentCitationChips` component (icon + truncated label, click → open URL/file).
- **Effort**: **S**.
- **Risk**: None. Easy iterative add.

### Honorable mentions (just below the cutoff)

- **Codebase RAG (`SearchCodebase` + Merkle-tree incremental index)** — high impact, but **L** effort (chunker, embedding provider integration, snapshot persistence). Defer until crest has a clear repo-aware-task feature driving it.
- **Conversation/task DAG persistence** — premature without multi-agent spawn.
- **Read-only session mode** — small but useful; promote to the prioritized list if a user-visible "lookbook" mode lands on the roadmap.

---

## 4. Anti-patterns in Warp to *not* copy

1. **Server-side prompt assembly via opaque MAA service.** Warp's client does not own the system prompt — it ships structured `InputContext` to `warp_multi_agent_api` and the server assembles the actual prompt. Convenient for them; opaque to users, and incompatible with an OSS / BYOK product. Crest's client-side `pkg/aiusechat/usechat-prompts.go` is correct; do not migrate to server-side.

2. **The 28-variant `AIAgentActionType` enum.** Each tool added requires touching the enum, `convert.rs`, `action_result/mod.rs`, `action_result/convert.rs`, plus the UI's inline-action match. Crest's tool-registry pattern (`pkg/aiusechat/tools.go` + `pkg/aiusechat/tools_builder.go`) is the right shape; do not enumify. Add new tools as registry entries.

3. **Harness sprawl (Oz/ClaudeCode/Gemini/OpenCode/Codex).** Five harness names, each a different proto branch (`orchestration_config.rs:189-214`). This is a marketing surface, not a technical abstraction — every harness ends up streaming the same thing. Crest's provider abstraction (one driver, many providers via `pkg/aiusechat/{anthropic,openai,gemini,google}`) avoids this. Keep it.

4. **Non-streamed tool-call arguments.** Warp reassembles the full tool-call JSON before converting to action — long file edits sit in suspense. Crest's SSE pipeline already streams; do not lose that.

5. **LLM-flagged `is_risky` treated as authoritative in `AgentDecides` mode.** Warp's docs and code rely on the model honestly classifying its own commands. The model can lie. Even though crest is not adopting `is_risky` (Section 3 "Dropped"), the meta-lesson stands: if a future change ever does, the regex denylist must stay as a non-overridable hard gate.

6. **Computer-use cross-platform sprawl.** `crates/computer_use/src/{mac,linux,windows,linux/wayland,linux/x11}/{keyboard,mouse,screenshot}.rs` — five OS targets × three input types × Wayland-vs-X11 = a lot of code. crest is a terminal app; the value-per-line is low here. Skip.

7. **`SuggestNewConversation` / `SuggestPrompt` as tools.** Warp uses these to drive sidebar UX. Building the underlying tools without the sidebar is dead code. Skip until/unless the UX exists.

8. **"Skills" overload.** Warp treats skills as *both* runtime-loaded knowledge and a config surface that ranks across 10 vendor paths. The cross-vendor convention is interop bait; the ranking is a maintenance burden. (Already dropped from the roadmap above for the same reason.)

9. **`OrchestrationStatus::Disapproved` round-tripping in protos when `None` would do.** A wart from API-versioning, not a pattern.

---

## 5. Open questions

These are points that could not be fully nailed down from the source alone and would need clarification before implementing:

1. **`crates/natural_language_detection` vs `crates/input_classifier`** — both exist, both compile. They are related (NL detection word lists vs. the binary input classifier). Worth a 30-min dive before any crest NLD module unification — there may be a reason Warp keeps them split.

2. **Codebase index storage shape** — `crates/ai/src/index/full_source_code_embedding/store_client.rs` and `sync_client.rs` were listed but not opened. Are embeddings stored locally (sqlite/vss?) or only server-side? Affects whether crest can replicate without a backend.

3. **`AskUserQuestion` rendering** — the action type is mapped but not the rendering component path. Quickly grepping `app/src/ai/blocklist/inline_action/` for `AskUser` before building crest's `TermAgentAskCard` will save reinventing the UX.

4. **Trajectory / audit-log format compatibility.** Crest writes `.crest-trajectories/<chatid>.json` (`docs/agent-architecture.md:114`). Warp ships `AgentEvent` proto records. If we ever want eval-harness interop, decide now whether crest's format should be a strict superset of Warp's or stay independent.

---

## Summary

Crest already has a thoughtfully built native agent (multi-provider, MCP, parallel tools, prompt caching, audit, inline blocks, diff preview, plan-to-do, model switcher, token counter). Warp's value-adds — relative to what crest has, after dropping the three low-ROI items — cluster in two buckets:

- **More tool surface** (recommendation #1, #2 — long-running command lifecycle, `ask_user_question`).
- **Polish on streaming/provenance** (recommendation #3, #4 — markdown delta rendering, typed citations).

Everything else (RAG index, multi-agent spawn, computer use, harness abstraction, server-side prompt assembly) is either premature, Warp-specific, or directly opposed to crest's OSS positioning. The four prioritized recommendations are **~3 S-weeks + 1 M-week** of work.
