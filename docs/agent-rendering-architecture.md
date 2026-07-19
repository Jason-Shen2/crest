# Agent Rendering & Conversation-State Architecture

How crest gets a streaming agent conversation from the Electron **main**
process (where the agent runs) onto the screen in the **renderer**, and
how agent output is positioned in the terminal timeline alongside shell
blocks.

This doc exists because the first cut got this wrong and produced a
recurring class of bug ("…loading agent run…" stuck forever; replies not
rendering). The fix is grounded in how the agent harness's own author
(pi / earendil-works) and Warp solve the same problem — not invented.

Cross-ref: `docs/agent-runtime-architecture.md` (the runtime/IPC layer).

---

## 1. The problem we hit

The original cut represented one agent conversation **twice** and linked
the two by a **re-derived key**:

1. **Engine blocks** — `TerminalModel` owns the ordered timeline (shell
   blocks + agent blocks). An agent block is a marker that freezes a
   `runId` (`block.agentRef.runId`). [jotai state]
2. **`usePiChat.messages`** — the renderer rebuilds the conversation from
   a fire-and-forget IPC event stream, then `slicePiRuns()` cuts it into
   runs and `indexRunsById()` builds a `Map<runId, PiRun>`. [React state]

`BlockListElement` renders an agent block by looking its run up in that
map: `agentRunsById.get(block.agentRef.runId)`. Miss → "…loading…".

Two independent failure modes fell out of this:

- **Derived-id desync.** `slicePiRuns` originally keyed runs by **array
  index** (`run-0`). The block froze that id, but the map was recomputed
  from the current array — and the array re-indexes (mid-stream subscribe
  starts local messages at 0; `agent_end` then replaces the array with
  the authoritative snapshot at the true indices). Frozen `run-0` stopped
  matching any recomputed key → stuck forever.
- **Lossy reconstruction.** The renderer subscribes to the event stream
  only *after* `agent:send` returns the session. The main process starts
  `harness.prompt()` immediately (fire-and-forget); a fast turn (observed:
  **13 ms**) streamed its entire first run **before the renderer
  subscribed**. Those events were missed and nothing back-filled them, so
  the first run's user message never entered `usePiChat.messages` — its
  block could never find a run.

Both are symptoms of one root: **two representations of the same data,
synced by a derived key, with the renderer reconstructing state from a
lossy delta stream instead of mirroring an authoritative source.**

---

## 2. Evidence: how pi (our harness's author) and Warp do it

We use pi's `AgentHarness` (`earendil-works/pi`). pi's *own* coding-agent
is the reference implementation for consuming it — the strongest possible
evidence for "best practice" here.

### pi — single owner, read owned state, key by stable data ids

- **The conversation is owned, not reconstructed.** `AgentSession`
  exposes the authoritative transcript directly:
  `packages/coding-agent/src/core/agent-session.ts:810`
  ```ts
  get messages(): AgentMessage[] {
      return this.agent.state.messages;   // the owned conversation
  }
  ```
- **`AgentSession` is the single aggregator.** It subscribes to the
  harness once (`agent-session.ts:336`), persists on `message_end`
  (`sessionManager.appendMessage(...)`), and re-emits to its own
  listeners. The UI consumes `AgentSession`, not the raw harness.
- **The TUI subscribes for a *signal* and reads owned state to render.**
  `packages/coding-agent/src/modes/interactive/interactive-mode.ts`:
  ```ts
  :2646  this.unsubscribe = this.session.subscribe(async (event) => { … })  // re-render signal
  :862   if (this.session.state.messages.length > 0)                        // read owned state
  :280   private pendingTools = new Map<string, ToolExecutionComponent>()   // components by stable id
  :2731  if (!this.pendingTools.has(content.id)) { … }                      // reuse by content.id, not position
  ```
  It never rebuilds the conversation from deltas, and it has **no "run"
  grouping** — it renders the owned message array directly, reusing
  components by **stable ids carried in the data** (`content.id`).

### Warp — same shape, independently

(From `/Users/mac/projects/warp`, GPUI/Rust.)

- `AIConversation` (`app/src/ai/agent/conversation.rs:128`) is the single
  authoritative owner of an agent conversation; exchanges get a **UUID at
  creation** that never changes.
- Streaming tokens **mutate that owned model in place**
  (`conversation.rs:2731 append_to_message_content`) and emit an
  `UpdatedStreamingExchange` event that is *only a re-render signal*
  (`model_impl.rs:194`); the view then **reads the live model**.
- Terminal `Block`s and `AIConversation`s are **separate sovereign
  models** composed at the view layer by stable id — never one dual
  representation synced by a recomputed key.

### The shared pattern

1. **One authoritative owner** of the conversation.
2. **Stable ids minted once at creation, carried in the data** — never
   re-derived from array position.
3. **The view subscribes for a re-render signal and reads the owned
   state** — it does not reconstruct state from the delta stream.

---

## 3. Decision (crest, adapted for the process split)

pi's UI and harness share a process, so the TUI reads
`session.state.messages` synchronously. crest's harness is in **main**
and the UI is in the **renderer** — it cannot read owned state across the
IPC boundary. So crest **mirrors** the authoritative state across IPC,
applying the same three principles:

1. **Main is the source of truth.** The agent's authoritative transcript
   lives where the harness runs. The renderer holds a *mirror*, never an
   independently-reconstructed copy.

2. **Snapshot on subscribe + deltas (no missed history).** `agent-ipc`
   attaches an internal harness subscription **at harness-build time,
   before `prompt()` runs**, so it never misses events (this is what
   closed the 13 ms race). It caches the latest authoritative transcript
   per session. On `agent:subscribe`, it replays that snapshot to the new
   subscriber before live deltas flow. The renderer seeds its mirror from
   the snapshot, then applies deltas — a late or re-subscribing renderer
   always converges to the authoritative state.

3. **Runs keyed by a stable property of the data.** `slicePiRuns` keys a
   run by the user message's **timestamp** (assigned once in main, carried
   unchanged through every event and the session snapshot), never by
   array index. This mirrors pi's data model, where a message's identity
   is `{role, content, timestamp}` (no separate id field) and the TUI
   keys finer-grained units by `content.id`.

### The owner: pi's `AgentSession` *pattern*, at the harness layer

pi exposes the agent at two levels:

- **`Agent`** (`packages/.../agent.ts`) — the low-level loop. Exposes
  **synchronous** `state.messages` and `state.isStreaming`, plus
  `subscribe` / `prompt` / `steer` / `followUp`.
- **`AgentHarness`** (`harness/agent-harness.ts`) — a batteries-included
  wrapper that owns a `Session` (JSONL persistence), manages the
  steer/followUp queues, and is **event-only**: it has *no* synchronous
  `messages` getter; the transcript surfaces through the event stream
  (`message_start/update/end`, `agent_end` with the full array) plus
  `queue_update` (steer + followUp arrays).

pi's own coding-agent wraps the **`Agent`** in an `AgentSession`
(`core/agent-session.ts:157` `agent: Agent`, `:336` `subscribe`, `:811`
`get messages() { return this.agent.state.messages }`). `AgentSession`
is an **owner/aggregator**: subscribe once, own the authoritative
transcript + queues, persist, and re-emit to the UI — which works because
the TUI is in the *same process* and can read `state.messages`
synchronously.

crest consumes the **`AgentHarness`**, and that is the correct layer for
an embedder: the renderer is in another process and **cannot read
synchronous state across IPC anyway**, so an event-driven source fits
*better* than `Agent`'s sync-state model, and the harness already bundles
persistence + queues. Vendoring `coding-agent`'s `AgentSession` wholesale
would be wrong — it drags in `extensions/`, `export-html/`,
`slash-commands`, `settings-manager`, `theme`, `model-registry`,
`compaction`, etc. (a CLI app's worth of surface).

What crest was missing was not the harness layer — it was the **owner**.
Harness events were scattered into a loose `Map` (updated only on
`agent_end`, so stale mid-turn) and concurrent sends were handled by
*catching* `AgentHarnessError("busy")`. So crest applies the
`AgentSession` *pattern* at the harness layer: a single per-session owner,
`AgentSessionRuntime` (`emain/agent/agent-session-runtime.ts`), that subscribes
to the harness once, owns the transcript + queue + status, and decides
send routing from its own tracked state.

---

## 4. Implementation map

- `emain/agent/agent-session-runtime.ts` — **the owner.** One
  `AgentSessionRuntime` per session JSONL path. Subscribes to the harness
  once at construction (before any `prompt()`), so it never misses events.
  - Owns `messages`: seeded from the persisted session at construction
    (so reopened conversations show history), then appends on
    `message_start` and replaces the tail on `message_update` /
    `message_end`. **`agent_end` does NOT replace the array** — its
    `messages` field is *run-scoped* (only the latest `prompt()`'s
    messages; `agent-loop.ts` builds it as `[...prompts]` + responses, not
    the whole conversation). Replacing on `agent_end` was the second
    incarnation of the "…loading agent run…" bug: after a 2nd send the
    transcript collapsed to just that run, so every prior run's block lost
    its run in the map. The live `message_start/_end` stream already
    accumulates the full transcript, so `agent_end` is only a run-lifecycle
    signal (status → idle, clear `running`).
  - Mirrors `steerQueue` / `followUpQueue` from the harness's own
    `queue_update` events.
  - Tracks `status` (idle / streaming / error) + `errorMessage`.
  - `getSnapshot()` returns the owned state for replay.
  - `send(text)` routes prompt-vs-followUp from a **synchronously tracked
    `running` flag** — not by catching a busy error. `prompt()` flips the
    harness phase synchronously (`agent-harness.ts:606`) and `followUp()`
    only guards on idle, so a same-tick burst routes deterministically:
    first send starts the run, the rest queue via `followUp`.
  - Re-emits the harness event stream to its own subscribers and clears
    `running` on `agent_end` / `abort` / prompt-settle.
- `emain/agent-ipc.ts` — thin IPC ↔ owner adapter.
  - `AgentRuntimeRegistry<AgentSessionRuntime>` deduplicates runtime creation
    by canonical session path, protects running/subscribed runtimes, and
    evicts idle unreferenced runtimes after five minutes.
  - `agent:send` resolves the current model, reasoning, auth, permissions,
    and prompt inputs, then calls
    `runtime.sendWithExecutionConfig(text, config)`.
  - `agent:subscribe` acquires a Registry subscriber reference, attaches
    `runtime.subscribe(cb)`, then replays `runtime.getSessionState()` as a
    `session_state` event so a late/re-subscribing renderer mirrors the
    owned state, including a turn that is *mid-stream*.
  - `agent:unsubscribe` and renderer destruction release the Registry
    subscriber reference.
  - `agent:abort` → `runtime.abort()`.
- `frontend/app/store/use-pi-chat.ts`
  - `reducePiChatEvent` replaces `messages` only on `session_state` (the owner's
    full accumulated array); `agent_end` is a no-op for messages (same
    run-scoped reasoning as the owner). The subscribe callback also seeds
    `status` from the snapshot so a mid-stream re-subscribe reflects
    "streaming".
- `frontend/app/store/slice-pi-runs.ts`
  - `runId = run-${userMessage.timestamp}` (stable; not positional).
- `frontend/app/term/render/block-list-element.tsx`
  - Looks a run up by the (now-stable) block `runId`; warns with the
    available ids when it can't (diagnostic for any future drift).

---

## 5. Deferred / known-separate

- **Concurrent-send UX (renderer).** The owner already mirrors the queues
  (`queue_update`) and forwards them in the snapshot + live stream, so the
  data is on the renderer side. Remaining: `usePiChat` exposing the queued
  messages and the UI rendering a "queued" chip + a "Stop" affordance.
  Warp instead *interrupts* (cancels the in-flight turn) with no queue — we
  chose pi's queue model on purpose so in-flight tool calls / output aren't
  discarded.
- **Renderer single-model collapse.** Main now has a clean owner; the
  renderer still derives runs from the mirrored array via `slicePiRuns`
  and references them from timeline blocks by stable `runId`. Collapsing
  this to one mirrored conversation model (block list positions by stable
  id only) is a further simplification, not a correctness fix.
- **`read` image branch** and other pi-tool gaps (see
  `docs/agent-runtime-architecture.md`).

---

## 6. Status

- [x] Principles documented with evidence (this doc).
- [x] Runs keyed by stable message timestamp (`slice-pi-runs.ts`).
- [x] **Owner introduced** — `AgentSessionRuntime` owns the transcript +
      queue + status; `agent-ipc` is a thin IPC↔owner adapter. The loose
      transcript `Map` and the catch-`busy` control flow are gone.
      Unit-tested (`agent-session-runtime.test.ts`).
- [x] Snapshot-on-subscribe replays the owned state (messages + status +
      queues), valid mid-stream — not just on completed turns.
- [x] Concurrent send routed from the owner's tracked run state (queue via
      `followUp`), no exception-as-control-flow.
- [ ] Verified against the stuck-loading + concurrent-send repros in the
      running app.
