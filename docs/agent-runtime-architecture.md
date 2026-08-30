# Agent Runtime Architecture — Design Doc

**Status:** **Phase 3 implemented for Workspace Agent** · Phase 4A File/Preview/Git Diff automated implementation complete, Electron smoke pending · Browser Top Tab deferred
**Replaces:** the deleted `pkg/agent/` Go agent loop + `pkg/aiusechat/` four hand-rolled backends
**Companion docs:**

- [`ai-config-architecture.md`](./ai-config-architecture.md) — model selection, catalog, resolver (Layer 1–4 of the AI stack)
- [`ai-sdk-provider-migration-eval.md`](./ai-sdk-provider-migration-eval.md) — why Option D (agent loop in Electron main + pi) was chosen over A/B/C

This doc captures the **runtime** layer: how a Workspace Agent conversation runs in the Electron main process on top of pi-agent-core (`emain/agent/`) and pi-ai (`emain/ai/`), how sessions are persisted, how cwd flows through requests, how the Workspace binds to sessions, and the cross-workspace / lifecycle behavior.

**Phase 3 topology:**

```text
Workspace AgentContent
  -> AgentRuntimeClient
  -> authenticated Agent IPC
  -> AgentRuntimeRegistry
  -> AgentSessionRuntime
       -> AgentHarness
       -> AgentPtyHost
            -> AgentPtyScreen
```

Agent execution no longer depends on `block.meta`, `staticTabId`, backing
Agent Tabs, or `TerminalModel`. Session/model selection live in Workspace
agent state and use a separate `agentrevision`. Hosted command execution is
owned by Electron main through `AgentPtyHost`; the renderer only displays
snapshots and sends input/resize/abort requests through authenticated IPC.

File, Preview, and Git Diff now use the Workspace renderer's production Top
Tab model without backend Tab, Block, or LayoutState objects. File runtime
resources are Workspace-owned; Preview and Git Diff remount from persisted
descriptors. Browser Top Tabs remain deferred, so URL launchers continue to
open the existing right-side Browser tool. This cutover is covered by the
automated gate; the Electron runtime smoke has not yet been performed.

Sections that mention pane/block binding document the pre-Phase-3 design
history and are retained only as migration context.

References that informed the design are inline. Major sources:

- **warp** AI / agent code at `/Users/mac/projects/warp/app/src/` (read May 2026)
- **pi-agent-core** in-tree at `emain/agent/` (started from `earendil-works/pi v0.75.5`)

---

## 1. The premise

crest used to:

- Run the agent loop in a separate Go daemon (`wavesrv`, via `pkg/agent/` + `pkg/aiusechat/`)
- Use four hand-rolled LLM backends (openaichat, openairesponses, anthropic, gemini, ~3000 LOC Go)
- Route per-pane conversations by an ephemeral chatId minted in the React renderer

After the [migration eval](./ai-sdk-provider-migration-eval.md), the project committed to **Option D**:

- Agent loop in **Electron main** (Node), not wavesrv (which keeps PTY + block IO duties only)
- **pi-agent-core + pi-ai** as the underlying agent / LLM stack, integrated in-tree (not vendored)
- Renderer becomes a pure UI surface that talks to main via IPC

This doc takes those decisions as given and specifies the Workspace-scoped runtime that lives on top.

---

## 2. The runtime layers

```
┌────────────────────────────────────────────────────────────────────┐
│  Renderer (React)                                                  │
│    useChat → usePiChat (task #12)                                  │
│    block.meta["agent:session"] holds AgentSessionMeta              │
│    block.meta["agent:selection"] holds picker selection            │
└─────────────────────────┬──────────────────────────────────────────┘
                          │   IPC (task #9)
                          │   - agent:send / abort / subscribe
                          │   - agent:list-sessions-for-cwd
                          │   - agent:open-session
                          ▼
┌────────────────────────────────────────────────────────────────────┐
│  Electron main — "the agent process"                               │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Sessions layer (emain/agent/sessions.ts)                     │  │
│  │   - one JsonlSessionRepo for the whole process               │  │
│  │   - cwd-grouped JSONL files under                            │  │
│  │     ~/.config/crest{-dev}/sessions/<encodedCwd>/...jsonl     │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Runtime cache (per-session-path)                             │  │
│  │   Map<sessionPath, AgentSessionRuntime>                     │  │
│  │   Each runtime owns one AgentHarnessHost containing:        │  │
│  │     - pi AgentHarness (the actual stateful agent)            │  │
│  │     - NodeExecutionEnv (cwd, shell config — mutable)         │  │
│  │     - prompt-input state (cwd, gitBranch)                    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Tools (task #10) — crest-specific TS tools, ported from           │
│  pkg/agent/tools/*.go; bash/file/web run in main process;          │
│  block/scrollback/focus call wavesrv via wshrpc.                   │
│                                                                    │
│  Permissions (task #11) — beforeToolCall hook; simple allowlist    │
│  + bench-mode bypass; no posture/rules engine.                     │
└─────────────────────────┬──────────────────────────────────────────┘
                          │   stdio / HTTP to upstream LLM APIs
                          ▼
              OpenAI / Anthropic / Google / OpenRouter
              (via pi-ai providers in emain/ai/providers/)
```

The crest-specific integration layer (`emain/agent/sessions.ts`, `build-system-prompt.ts`, `harness-factory.ts`) is intentionally **small** — targeting under 250 LOC total. The bulk of the work lives in pi (vendored as in-tree code) and we wire it to crest's workspace and session model.

---

## 3. Foundation choice — pi over custom

Three alternatives were considered (see [migration eval](./ai-sdk-provider-migration-eval.md) §5–7):

- **Option A** (FE provider plugins in renderer): rejected — API keys would leak into the renderer process.
- **Option B** (Go SDK swap, keep wavesrv): rejected — doesn't address the "wavesrv shouldn't own the agent" structural issue.
- **Option C** (BE proxy + FE providers): rejected — still has to move the agent loop to renderer.
- **Option D** (agent loop in Electron main + pi-agent-core): **chosen**.

Of the libraries that could underlie Option D, **pi-agent-core was chosen** over building from scratch because pi gives us for free:

- Stateful agent class with typed event stream (`AgentHarness`)
- 13 LLM providers under one interface (`pi-ai`)
- Compaction + branch summarization (`harness/compaction/`)
- JSONL session storage with cwd grouping (`harness/session/jsonl-repo.ts`)
- Skill system + prompt templates (`harness/skills.ts`, `harness/prompt-templates.ts`)
- Parallel + sequential tool execution
- `beforeToolCall` / `afterToolCall` / `shouldStopAfterTurn` hooks
- Compaction triggers on context-window pressure

The cost: bus factor 1 (Mario Zechner), mitigated by integrating in-tree so we can fork-edit any time. Trimmed providers we don't use (Bedrock / Vertex / Azure / Codex / Mistral / Cloudflare / Faux / image generation); kept openai-responses, openai-completions, anthropic, google. OpenRouter rides on openai-completions with a base URL override.

**Posture for adding crest-specific code:** when crest's convention disagrees with pi's design, **pi's design wins by default**. crest's conventions are mostly POC-era ad-hoc choices; pi is OSS-validated and considered. Diverge from pi only with an explicit recorded reason. (Lesson learned the expensive way — see decision §7.2 below.)

---

## 4. Session model

### 4.1 The Session type

A "session" is one continuous AI conversation thread, persisted to a JSONL file. The canonical type is **pi's `Session<JsonlSessionMetadata>`** — we do NOT wrap it.

`JsonlSessionMetadata` shape (`emain/agent/harness/types.ts:439`):

```ts
interface JsonlSessionMetadata extends SessionMetadata {
  id: string; // UUID minted by pi
  createdAt: string; // ISO 8601 timestamp
  cwd: string; // creation-time cwd, immutable
  path: string; // absolute JSONL file path
  parentSessionPath?: string; // for forks; unused in v1
}
```

The JSONL file is append-mode: header on line 1, one entry per line. Each entry is an `AgentMessage`, `ModelChangeEntry`, `CompactionEntry`, etc. The file IS the authoritative session state — restart-resilient by construction.

### 4.2 Storage layout

```
~/.config/crest{-dev}/sessions/             ← root, mirrors WAVETERM_CONFIG_HOME
├── --Users-mac-projects-crest--/           ← one dir per cwd (pi encodeCwd)
│   ├── 2026-05-23T14-30-12_<uuid1>.jsonl
│   ├── 2026-05-23T18-04-55_<uuid2>.jsonl
│   └── 2026-05-23T22-58-30_<uuid3>.jsonl
├── --Users-mac-projects-edgeFlow.js--/
│   └── 2026-05-22T09-15-00_<uuid4>.jsonl
└── --Users-mac--/                          ← home-dir scratch convos
    └── ...
```

**Decision rationale** (warp says flat, pi says cwd-grouped):

- warp stores everything in one SQLite DB indexed by id, with no per-cwd discovery API — they don't surface a "recent conversations in this project" UX
- pi groups by cwd at the filesystem level; `repo.list({cwd})` is one `ls`
- crest wants the per-cwd discovery affordance (see §6.4 cross-pane behavior), so **pi's layout wins**
- Filesystem JSONL is also restart-resilient without a DB migration story

### 4.3 Why we don't roll our own SessionStore

An earlier task #8 iteration wrote a flat per-chatId `SessionStore`. This was a mistake — re-justified as "simpler" but actually:

- The "simpler" version cost us discovery, append-mode persistence, fork support, and metadata-without-load APIs (pi has all of these)
- `JsonlSessionRepo` already takes `NodeExecutionEnv` (already in the tree) for its FileSystem dependency — there is no "complex abstraction" to wrestle with
- The bare cwd-flat structure is exactly what we need

Lesson: **don't write code that already exists in pi without an explicit comparison showing why.**

---

## 5. Pane ↔ session binding

### 5.1 Binding direction

The pane → session reference is stored in **block.meta**:

```go
// pkg/waveobj/wtypemeta.go
AgentSession *AgentSessionMeta `json:"agent:session,omitempty"`

type AgentSessionMeta struct {
    Id        string `json:"id"`
    CreatedAt string `json:"createdAt"`
    Cwd       string `json:"cwd"`
    Path      string `json:"path"`
}
```

This shape is **structurally compatible** with pi's `JsonlSessionMetadata` (subset — missing only optional `parentSessionPath` which is for fork tracking we don't yet wire). The renderer round-trips this object to/from main process IPC without translation; main passes it directly to `repo.open(meta)`.

**Naming exception:** `createdAt` is camelCase, not crest's standard lowercase-no-underscore. Rationale in §7.2 below.

The renderer-side picker / banner UI reads `agent:session` to know whether the Agent surface is bound to a session. Main process keeps `Map<sessionPath, AgentSessionRuntime>` as a cache; the cache is a memory optimization, not the source of truth.

This differs from **warp**, which stores the binding in a global `ActiveAgentViewsModel.agent_view_handles: HashMap<terminal_view_id, controller>` (`app/src/ai/active_agent_views_model.rs:88`) rather than in pane state. crest's block.meta is already a persistent per-pane store — using it is more direct.

### 5.2 Lazy creation

A pane has **no session by default**. `agent:session` is null until the user sends their first agent message in that pane.

On first send:

1. IPC `agent:send` arrives at main with no session metadata
2. Main process: `repo.create({cwd: paneCurrentCwd})` mints a fresh Session
3. Main returns the new `AgentSessionMeta` to renderer
4. Renderer writes `block.meta["agent:session"] = meta`
5. Main caches the `AgentSessionRuntime` in `Map<path, AgentSessionRuntime>`
6. Subsequent sends reuse the same session runtime + harness host

**Warp does the same lazy pattern** (`app/src/pane_group/mod.rs:6831–6864`) — pane open does NOT create a conversation; the first user input does.

### 5.3 Cwd at session creation vs cwd at send time

Two cwds matter:

- **Session.cwd** — fixed at creation time, drives storage dir and grouping. Immutable.
- **Pane's current cwd** — mutable, updates when user types `cd`.

When the pane's cwd changes (`cd /other-proj`), the session does NOT move. The session stays grouped under its original cwd's directory. **This matches warp's semantics** (`active_session.rs` updates `current_working_directory` per block event, but `conversation.rs:1491 update_for_new_request_input` keeps the same conversation):

> warp `controller.rs:277`:
>
> ```rust
> let working_directory = active_session.as_ref(app).current_working_directory().cloned();
> ```
>
> warp `conversation.rs:1529` — the cwd lands on the new **exchange** struct, not on the conversation:
>
> ```rust
> let new_exchange = AIAgentExchange {
>     working_directory: working_directory.clone(),
>     ...
> };
> self.append_exchange_to_task(&task_id, new_exchange)?;
> ```

For crest, the equivalent is: rebuild the system prompt with the **current** pane cwd on each send. The session's stored cwd reflects where it was born; the LLM always sees fresh context.

We do **NOT** record per-message cwd metadata in v1. pi's `AgentMessage` shape doesn't have a `workingDirectory` field. We could extend it via pi's `declare module` mechanism, but that's a YAGNI feature for now — the LLM gets fresh cwd via system prompt, which is 99% of warp's value. Revisit when a "show conversation history with cwd context" UX lands.

### 5.4 Per-send cwd update mechanism

Pi's `NodeExecutionEnv.cwd: string` is a public mutable field (`emain/agent/harness/env/nodejs.ts:218`). The AgentHarnessHost wrapper exposes a single `update()` method:

```ts
interface AgentHarnessHost {
  readonly harness: AgentHarness;
  /** Update mutable workspace state. Call before each send if anything changed. */
  update(inputs: SystemPromptInputs): void;
}
```

`update()` does two things:

1. Mutates `env.cwd` so tool execution targets the new directory
2. Updates the closure that `systemPrompt: () => buildSystemPrompt(...)` reads, so the next turn's prompt reflects the new cwd / gitBranch

This is the only "wrapper" we add around AgentHarness, and it exists strictly to expose the env mutation seam that pi otherwise leaves implicit. It is not an "AgentRuntime" — it does not re-implement subscribe / send / abort / message storage. Those are direct AgentHarness methods.

---

## 6. Workspace surface / session lifecycle

### 6.1 New pane opens

The pane has no `agent:session`. UI behavior:

1. Renderer calls `agent:list-sessions-for-cwd(paneCurrentCwd)` via IPC
2. If non-empty → render an inline banner: "You have N past conversations in this project. [Resume most recent] [Show all] [Dismiss]"
3. User picks Resume → renderer writes `block.meta["agent:session"] = meta`, subsequent sends use it
4. User picks Dismiss or just starts typing → next send creates a fresh session (see §5.2)

This banner **exceeds warp's behavior** — warp has zero affordance for cross-pane resume (`view_components/agent_toast.rs` is for completion notifications only, not session resumption). The decision to surface it reflects an explicit product judgment that this is good UX, validated by Aider and Claude Code which do similar.

### 6.2 First send (no session)

See §5.2.

### 6.3 Subsequent sends (cwd may have changed)

1. Renderer IPC: `agent:send({sessionMetadata, text, context: {workspaceId, workspaceDir, sessionPath?, environment, gitBranch?}})`
2. Main resolves the current model, reasoning level, auth resolver, tool permissions, and prompt inputs
3. `AgentRuntimeRegistry.getOrCreate(sessionMetadata.path, createRuntime)` reuses or constructs the session runtime
4. `runtime.sendWithExecutionConfig(text, config)` serializes config application with send dispatch, then routes prompt vs follow-up
5. Events stream back via the single `agent:event` IPC channel with `sessionPath` in the payload

### 6.4 Surface unsubscribes

- Renderer removes its session event subscription.
- IPC releases the renderer's subscriber key from `AgentRuntimeRegistry`.
- Running runtimes remain protected even without subscribers.
- Idle unreferenced runtimes are evicted after five minutes by a one-minute sweep.
- Session storage stays on disk and block meta retains `agent:session`.

### 6.5 App restart

- block.meta survives in wstore (SQLite)
- Pane mounts; reads `agent:session`; if present, next send opens via `repo.open(meta)`
- Pi's `repo.open()` reads the JSONL, reconstructs the Session, message history is intact
- No additional restore plumbing needed — pi's append-mode storage + wstore's block.meta together give restart-resilience for free

### 6.6 Home-dir / no-explicit-project conversations

When the pane's cwd is `~/Users/mac` (or any directory), pi's `encodeCwd` produces `--Users-mac--`. No special "scratch" handling. The pane behaves identically to a project-scoped pane.

If the user wants a true "ephemeral, no persistence" mode, that's a future feature (a setting or a `/scratch` slash command). Not v1.

---

## 7. Decisions log

Locked decisions, with the reasoning recorded so future-us doesn't relitigate them.

### 7.1 block.meta shape

`AgentSessionMeta = {id, createdAt, cwd, path}`, structurally a subset of pi's `JsonlSessionMetadata`.

**Reasoning:** Storing the full pi metadata (vs just `{cwd, path}`) costs nothing and buys us (a) UI display without IO ("Session from May 22"), (b) recovery hook if path goes stale (search by id), (c) 1:1 round-trip with pi types so future enrichments are free. Subset shapes always introduce information loss at conversion boundaries; we avoid the boundary entirely.

### 7.2 JSON naming exception — camelCase for foreign-data round-trip

`createdAt` is camelCase in `AgentSessionMeta` even though `rules.md` says "All fields must be lowercase, without underscores".

**Reasoning:** For data structures that round-trip into a foreign library without translation, we mirror the library's naming. The alternative (lowercase + 4-line translator) introduces a conversion boundary that adds testing surface and risk of drift. The rule lives in `CLAUDE.md` as a documented narrow exception.

**Future:** task #15 tracks an opt-in project-wide migration to camelCase for all existing block.meta fields. Until that lands, **only round-trip data** uses camelCase; **new crest-original fields** stay lowercase to match neighbors.

### 7.3 Use pi's `JsonlSessionRepo`, not a custom SessionStore

Discussed in §4.3. The earlier "we'll write a tiny SessionStore" instinct was wrong; pi's repo gives discovery / append-mode / forking / metadata-without-load, all of which we want.

### 7.4 Use pi's `AgentHarness`, not a custom AgentRuntime wrapper

An earlier task #8 iteration wrote a 250-LOC `AgentRuntime` class that re-implemented ~80% of pi's `AgentHarness` (subscribe, prompt, abort, message storage, lazy lifecycle) — but worse, keyed by chatId instead of Session, with flat untyped subscriber sets instead of typed handlers, and zero compaction / skill / prompt-template support.

**The wrong code was deleted. AgentHarnessHost is a 30-LOC adapter** that exposes the env mutation seam (§5.4) and nothing more. All other behavior is direct AgentHarness usage.

### 7.5 Session = locked-to-creation-cwd; per-send cwd via system-prompt rebuild

§5.3, §5.4. Matches warp's pattern. Avoids the "session migrates with cwd" semantic which would be surprising, AND avoids the "every cd opens a new session" semantic which would fragment history.

### 7.6 Cross-pane resume: banner, not auto

§6.1. Warp does nothing; Aider / Claude Code do similar banners. The list data is free via `repo.list({cwd})`; the UX cost is small (one banner component) and the user benefit is real.

### 7.7 Cwd metadata on individual messages: deferred

§5.3 last paragraph. Pi's `AgentMessage` doesn't carry cwd; we get warp's "current cwd in LLM context" via system prompt rebuild, which covers the 99% case. Per-message cwd recording (warp's `Exchange.working_directory`) is a v2 feature when a history-with-cwd UX is on the roadmap.

### 7.8 No backward compat for old `agent:chatid`

The Phase D / E (`ai-config-architecture.md`) chatId path is being deleted entirely (tasks #12 + #13). No migration script for users who have ongoing conversations in the old wstore chatstore — POC stage, users re-start conversations.

### 7.9 `posture` (ask/plan/do/bench) permissions engine: dropped

See task #11 description. Pi's `beforeToolCall` hook + a per-pane "trusted tools" allowlist + a bench-mode bypass flag covers the use cases; the 1500-LOC Go posture/rules/matcher engine doesn't carry over.

### 7.10 MCP: dropped from v1

No active users. `pkg/agent/mcp/` gets deleted in task #13. Can re-add via `@modelcontextprotocol/sdk` TS package on top of pi's tool API later.

### 7.11 Workspace rewind: turn-boundary snapshots, selective restore

Workspace rewind is a default-on TypeScript runtime capability on Linux and
macOS. Windows remains feature-unavailable until owner-only checkpoint-store
ACLs, reparse-safe inspection/apply, case-only replacement, and directory
fsync durability are implemented and pass the full gate. Its authority is the filesystem snapshot captured before and
after a durable user turn, not `write`/`edit` tool metadata. Consequently bash,
hosted PTYs, CLI subagents, and future tools receive the same coverage. An
active transferred PTY, incomplete capture, or crash before finalization
records an explicit unavailable checkpoint rather than guessing.

The private store lives under
`<wave-data>/agent-checkpoints/workspaces/<workspace-identity>-<incarnation>/repo.git`.
It is a bare internal object store and never changes the user's Git HEAD,
index, branches, commits, or stash; non-Git workspaces use the same capture and
restore protocol. The store has a 5 GiB soft quota per canonical workspace.
Automatic cleanup removes only unowned objects. Referenced bytes remain owned
by live or trashed sessions, and purging a trashed owner requires its
server-issued confirmation token.

Revert and `/rewind` share a server-authored preview. Normal Revert fails
closed if live bytes drifted. Only the displayed red drift paths may be
overwritten by `Force revert`, with the exact warning
`files changed on disk since the agent last wrote them`; missing snapshots,
unsafe path/type or directory collisions, stale leaves, busy state, and
recovery remain hard blockers. Restore is a selective path transaction—never
`reset --hard`, `clean -fd`, or a whole-workspace checkout—and conversation
movement commits only after file verification.

A durable journal and canonical-workspace lock serialize multi-session
transactions across the filesystem/SQLite boundary. Unknown post-crash or
post-verification bytes freeze the workspace for explicit Retry,
Abandon-current, or corrupt-journal quarantine; recovery never offers Force.
A successful Revert persists a one-step Redo safety snapshot and dock across
reload. Redo has no Force mode and disappears after Redo, new work, or branch
navigation. `/tree` remains conversation-only and never restores snapshots.

Runtime APIs preserve four separate meanings instead of treating every diff as
the current workspace state:

1. Message Revert and `/rewind` plan conversation movement plus selective
   workspace restore; `/redo` applies the paired conversation/workspace Redo.
2. Turn-card Undo/Redo plans only one available checkpoint's exact path set.
   It uses the shared lock, confirmation, safety snapshot, journal, apply, and
   verification executor, but commits `turn-undo`/`turn-redo` markers on the
   current semantic branch without moving messages, display leaf, or composer.
3. `git-diff` reads current Git/worktree state and is not historical authority.
4. `agent-turn-diff` and turn Review project immutable `before -> after`
   snapshot blobs. A missing/unavailable historical checkpoint produces no
   card and no Git/live-disk fallback.

Normal turn Undo refuses same-path drift. Its Force capability is bound to the
exact red regular-file paths and fingerprints from preview; turn Redo refuses
all drift and never issues Force authority. Different-path concurrent sessions
remain isolated because no operation expands beyond checkpoint `changes`.

The storage/selective-restore precedent comes from OpenCode Core v2; turn
lifecycle and the `/rewind` picker come from Pi/pi-rewind. Drift/Force UX,
multi-session ownership, workspace identity, locking, durability, recovery,
quota, and one-step Redo are Crest-owned hardening. The deleted Go
`CheckpointStore`/`filebackup` and tool-level `FileChange` semantics are
historical and are not authoritative for this implementation.

The approved next physical-state architecture replaces the custom durable
incremental tracker with one Shared Shadow Git commit log per Workspace and a
generic Agent Runtime Workspace Writer Lease. Git commit history becomes the
single snapshot, ordering, ownership, and ABA authority; no persistent watcher
event log or separate Path MVCC database is added. See
[`2026-08-08-agent-workspace-rewind-shadow-git-design.md`](superpowers/specs/2026-08-08-agent-workspace-rewind-shadow-git-design.md).
This paragraph records the accepted successor design, not current runtime
behavior.

### 7.12 Effective-context inspection is runtime-owned and read-only

The Context Inspector describes the input projection that the current Agent will carry into its next model call. It is not reconstructed from cumulative provider usage and it is not a second transcript browser.

The inspection pipeline has two observation levels:

- `packages/coding-agent/context/inspector.ts` builds the semantic inventory from the system-prompt manifest, tool definitions, the effective active-branch messages, and explicitly added context. This preserves provenance and stable categories even when provider rendering later changes message shape.
- `AgentHarness` observes the final provider-ready request after model-specific transforms. When the provider exposes an exact counter, that result is authoritative; otherwise the inspector reports an estimate and keeps unattributed request overhead or discrepancy explicit instead of rescaling semantic categories.

`AgentSessionRuntime` owns the live snapshot and its monotonically increasing revision. It publishes lifecycle changes (`in_use`, `waiting_for_tool`, `updating`, `out_of_date`, or `unavailable`) without allowing inspection failures to fail a send, tool execution, or session persistence. The same snapshot is carried through session state and live runtime events, so the context ring and right-panel inspector share one numerator, denominator, lifecycle, and accuracy source.

`agent:inspect-context` supports two paths. An existing managed session asks its runtime for the current snapshot. Before a session exists, the IPC handler builds a stateless preview with an in-memory session repository; opening the panel therefore exposes instructions and tools without creating a session or writing history.

The renderer stores this data in a transient atom rather than persisted workspace state. Every publish is checked against workspace generation, session generation/path, model key, active leaf, and snapshot revision. A model or session switch clears the old identity immediately, and late responses are discarded. A refresh failure may retain only the same-identity snapshot, marked `out_of_date`.

The first release is intentionally read-only. A future management feature can alter the next-call projection while preserving transcript history, but it must extend this provenance and identity model rather than deleting durable messages from the inspector UI.

---

## 8. Open questions and v2 candidates

Things explicitly out of scope for the current sprint:

- **Session forking UX** — pi has `repo.fork(source, opts)` and tracks `parentSessionPath`. We don't surface it yet. v2 affordance: "branch this conversation from message N".
- **Per-message cwd recording** — §7.7.
- **A real "session manager" / "history browser" UI** — `repo.list({})` walks all cwds; the data exists. A side-panel that lets users browse / search / delete sessions globally is a real feature, not v1.
- **Sharing sessions across team members** — pi has no story; warp does (server-side). Out of scope.
- **Skill marketplace** — pi has skills via TS extensions. We don't expose this yet.
- **Custom system prompts per project** — pi's `harness/system-prompt.ts` supports it; crest's `buildSystemPrompt` doesn't read project-level overrides yet.

---

## 9. References

### pi source (in-tree at `emain/agent/`)

- `harness/agent-harness.ts:164` — `AgentHarness` class
- `harness/session/jsonl-repo.ts:38` — `JsonlSessionRepo`
- `harness/session/session.ts:78` — `Session<TMetadata>` class
- `harness/env/nodejs.ts:217` — `NodeExecutionEnv` (implements `ExecutionEnv` / `FileSystem`)
- `harness/types.ts:439` — `JsonlSessionMetadata`
- `harness/system-prompt.ts` — pi's built-in system prompt builder (we use our own instead)
- `harness/compaction/compaction.ts` — pi's compaction algorithm (auto-fires via `prepareNextTurn`)

### warp source (read May 2026, at `/Users/mac/projects/warp/app/src/`)

- `ai/agent/conversation.rs:128,273,1491,1529` — `AIConversation` + `update_for_new_request_input` (per-exchange cwd)
- `ai/agent_conversations_model.rs:513` — global conversation collection
- `ai/active_agent_views_model.rs:88,142,197` — pane → controller → conversation reverse lookup
- `terminal/model/session/active_session.rs:32` — `current_working_directory` updates from block events
- `ai/blocklist/controller.rs:253,277` — `RequestInput::new_with_common_fields` reads current cwd
- `persistence/agent.rs:37,46` — SQLite persistence (flat by id, max 100)
- `pane_group/mod.rs:6831,7155` — pane lifecycle, startup cwd inheritance

### Related crest docs

- [`ai-config-architecture.md`](./ai-config-architecture.md) — Layer 1–4 (catalog, ai.json, selection, resolver)
- [`ai-sdk-provider-migration-eval.md`](./ai-sdk-provider-migration-eval.md) — why Electron-main + pi

---

## 10. Implementation status

Tasks (cross-ref with the task list):

- [x] **#6** — Integrate pi source into `emain/agent` + `emain/ai` (`2a4945ba`)
- [x] **#7** — Spike: prove Agent.prompt() works end-to-end (`2a4945ba`)
- [x] **#8** — Session bridge + system-prompt builder + AgentHarnessHost factory (`6494b288`)
- [x] **#9** — IPC bridge renderer ↔ main (`ce6c9735`)
- [x] **#10** — First-pass tool baseline: 6 hand-written pure-Node tools (`18c9a001`). Superseded by **#16**, which replaced them with pi's own tools.
- [x] **#11** — Simple permissions hook, allowlist + bench bypass (`aa5a8e54`)
- [x] **#12** — `usePiChat` React hook + drop `@ai-sdk/react` (`c0222e13`)
- [x] **#13** — Delete Go agent stack. Done as four sequenced commits:
  - `b42f5e99` — port live `/models` listing to electron-main IPC
  - `9774a614` — port `ai.json` read/write to electron-main IPC
  - `e6c41d94` — delete Wave-era `aifilediff` view + previews
  - `2994635c` — delete `pkg/agent/`, `pkg/aiusechat/`, 5 dead web routes, 7 wshrpc commands, `wsh ai` CLI, dead test utilities; regen Go/TS bindings
- [x] **#16** — Reuse pi's coding-agent tools (TUI render layer stripped), replacing the #10 hand-written set. Final set (8, all cwd-bound): `read` `write` `edit` `ls` `bash` `find` `grep` + crest's own `web_fetch`.
  - `cc5ddcc0` (regression harness) → `fb9d4c43` (read/write/edit/ls) → `ce2f5968` (bash, replaces shell_exec) → `7b8ef069` (find/grep, pure-Node — no fd/ripgrep download)
  - Deviations from verbatim pi, flagged in-code: pi-tui render dropped (crest renders in React); `read`'s image branch deferred; `find`/`grep` use a pure-Node `glob` + `ignore` backend (root `.gitignore` only) instead of fd/ripgrep, to avoid runtime binary downloads in the Electron app.
- ~~**#14** — E2E regression across all 4 providers~~ — **cancelled.** A repeatable harness exists (`emain/agent/eval/`) and OpenRouter is validated end-to-end; running the other three providers needs their API keys and wasn't worth pursuing. Run manually anytime: `<PROVIDER>_API_KEY=… npx tsx emain/agent/eval/run-regression.ts`.
- ~~**#15** — Migrate block.meta JSON tags to camelCase~~ — **cancelled.** Large, high-blast-radius housekeeping with no capability gain; not pursued.

### Post-#13 surface

After #13, all AI-related state and IO lives in TypeScript:

- Provider /models listing → `emain/aiconfig/list-provider-models.ts` (IPC: `ai:list-provider-models`)
- `~/.config/crest/ai.json` read/write → `emain/aiconfig/user-config.ts` (IPC: `ai:get-user-config`, `ai:write-user-config`)
- Secret resolution (`tokensecretname` → plaintext) → `emain/aiconfig/secrets.ts`, reading `secrets.enc` directly via `safeStorage` (no Go roundtrip)
- Agent loop, sessions, tools → `emain/agent/` (covered by §2–§9)

Secret _writes_ still go through the Go `SetSecretsCommand` wshrpc (general-purpose, not AI-specific — also used by waveconfig and the builder). That's deliberate; the architecture goal was "AI lives in TS", not "all of pkg/secretstore lives in TS".
