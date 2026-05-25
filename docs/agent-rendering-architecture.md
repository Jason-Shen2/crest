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

### Why not adopt pi's `AgentSession` wholesale

`AgentSession` lives in pi's `coding-agent` package, which crest did not
vendor (only `agent` + `ai`). It pulls in `session-manager`, runtime,
extensions, etc. The three principles above capture what we need without
that surface. Adopting `AgentSession` (and collapsing the renderer to a
single mirrored conversation model with the block list referencing
exchanges purely by stable id for *positioning*) is the cleaner long-term
end state — tracked as deferred below.

---

## 4. Implementation map

- `emain/agent-ipc.ts`
  - `sessionMessages: Map<path, AgentMessage[]>` — per-session
    authoritative transcript cache.
  - `ensurePaneHarness` attaches an internal `harness.subscribe` (before
    `prompt()` is ever called) that updates the cache on `agent_end`
    (full authoritative array per turn).
  - `agent:subscribe` replays the cached transcript as a `snapshot` event
    to the newly-subscribed sender.
  - `agent:send` concurrency: tries `harness.prompt(text)`; if the harness
    rejects with `AgentHarnessError.code === "busy"` (a turn is already
    streaming), routes the message to `harness.followUp(text)` so it runs
    after the current turn — pi's intended concurrent-send path (queue,
    not interrupt). pi drains its own follow-up queue.
- `frontend/app/store/use-pi-chat.ts`
  - `reducePiChatEvent` handles a `snapshot` event by replacing
    `messages` with the authoritative array (no status side-effects).
- `frontend/app/store/slice-pi-runs.ts`
  - `runId = run-${userMessage.timestamp}` (stable; not positional).
- `frontend/app/term/render/block-list-element.tsx`
  - Looks a run up by the (now-stable) block `runId`; warns with the
    available ids when it can't (diagnostic for any future drift).

---

## 5. Deferred / known-separate

- **Concurrent-send UX polish.** The functional fix is done (send-while-
  streaming routes to `followUp`, queuing after the current turn — see §4).
  Remaining polish: surface the queued message(s) in the UI (pi emits a
  queue-update via `AgentSession`; we use the raw harness so we'd track it
  ourselves), and optionally a "Stop" affordance. Warp instead *interrupts*
  (cancels the in-flight turn) with no queue — we chose pi's queue model on
  purpose so in-flight tool calls / output aren't discarded.
- **Full `AgentSession` adoption** (vendor it; collapse the renderer to a
  single mirrored conversation model; block list positions by stable id
  only). The end state closest to pi/Warp; not required to fix the bugs.
- **`read` image branch** and other pi-tool gaps (see
  `docs/agent-runtime-architecture.md`).

---

## 6. Status

- [x] Principles documented with evidence (this doc).
- [x] Runs keyed by stable message timestamp (`slice-pi-runs.ts`).
- [x] Snapshot-on-subscribe (`agent-ipc.ts` cache + replay;
      `use-pi-chat.ts` snapshot reducer). Unit-tested.
- [x] Concurrent send → `followUp` queue instead of a busy error
      (`agent-ipc.ts`).
- [ ] Verified against the stuck-loading + concurrent-send repros in the
      running app.
