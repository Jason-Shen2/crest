# Migrating the AI Agent Layer — Evaluation

**Status:** evaluation only · **Owner:** TBD · **Decision deadline:** none set
**Companion:** [`ai-config-architecture.md`](./ai-config-architecture.md)

This doc evaluates moving crest's LLM client layer off the four hand-rolled Go backends in `pkg/aiusechat/`. It does **not** propose a schedule; the goal is to hand whoever picks this up a clear picture of scope, risk, and trigger conditions.

> **Recommended path:** Option D (move agent loop into Electron main, use ai-sdk providers). See §3 / §7 for the reasoning. Options A–C in §6 are alternative paths kept around because future shifts in priorities (e.g. dropping Electron, going pure-web) could make them relevant — they are not the recommendation.

---

## 1. Current architecture (May 2026)

The AI request path runs:

```
FE useChat (@ai-sdk/react)            ← Electron renderer (JS)
   → POST /api/post-agent-message     ← HTTP, app-internal
       → pkg/agent/http.go            ← Go wavesrv (independent daemon)
         → pkg/agent/run.go           ← agent loop: tools, checkpoints, posture
           → pkg/aiusechat/<backend>/ ← one of 4 hand-rolled backends
             → upstream LLM HTTP API  ← OpenAI / Anthropic / Google / OpenRouter
           ← SSE chunks
         ← UIMessagePart stream       ← ai-sdk wire shape
       ← SSE chunks
   ← ai-sdk UIMessage updates
```

`pkg/aiusechat/` totals ~3000 LOC across the four backends (`openaichat/`, `openairesponses/`, `anthropic/`, `gemini/`). Each implementation re-derives:

- Provider-specific request body shapes (different JSON per vendor)
- SSE → `UIMessagePart` translation (so the FE sees a uniform shape)
- Crest tool-call protocol ↔ provider tool-call JSON (different per vendor)
- Provider-specific errors (throttling, content policy, context-window exceeded)

The FE uses `@ai-sdk/react` (`useChat`) and emits the `UIMessage` wire shape from Go — but **does not** consume any ai-sdk provider package (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`). The Go backends re-implement what those packages already do.

## 2. The framing trap

A naive read of the problem is "do we want ai-sdk providers on the FE or do we keep the Go backend?". That framing produces three bad options (covered in §6 as Options A/B/C), each with a serious tradeoff:

- **A (FE provider plugins direct to upstream)** — moves API keys into the Electron renderer (security regression).
- **B (replace `pkg/aiusechat/` with Go SDKs)** — doesn't actually use ai-sdk; only collapses the per-vendor code shape; still leaves crest with multi-vendor maintenance.
- **C (BE proxy + FE provider plugins)** — still requires migrating the agent loop to the renderer (largest blast radius, displaced tool execution).

These look like three flavors of the same constraint. They aren't — they're three flavors of an **assumed** constraint: that the agent loop lives in Go wavesrv and must stay there. That assumption is what makes the choice feel stuck.

The right question is: **why does our agent loop live in a separate daemon at all?**

## 3. Industry tells: nobody else does this

Every comparable product runs `{ agent loop, LLM client, tool execution }` **in the same process**. The only thing that varies is *which* process.

| Product | Surface | Where the agent lives | LLM client | Tool exec |
|---|---|---|---|---|
| **Claude Code** (CLI) | terminal | Node CLI process | `@anthropic-ai/sdk` | Same process |
| **Aider** (CLI) | terminal | Python process | LiteLLM | Same process |
| **Cursor** (Electron) | IDE | VS Code extension host (Node) | Custom client | Same process |
| **Continue.dev** | VS Code ext | Extension host (Node) | ai-sdk + custom | Same process |
| **Cline / Roo Code** | VS Code ext | Extension host (Node) | ai-sdk | Same process |
| **Claude Desktop** | Electron app | Electron main (Node) | `@anthropic-ai/sdk` | Same process |
| **ChatGPT Desktop** | Tauri app | Tauri backend (Rust) | Custom | Same process |
| **OpenWebUI** | web app | Python server | LiteLLM | Same process |
| **OpenHands / OpenDevin** | web app | Python server | LiteLLM | Same process |
| **crest** (today) | Electron app | **Separate Go wavesrv daemon** | 4 hand-rolled Go backends | wavesrv |

Crest is the only entry whose agent loop runs in a process that's **not** the obvious "main app process". Every other Electron-based product in the table puts the agent in the Electron main process — not the renderer, not a sidecar daemon.

This isn't an accident of small sample size. It's a recurring choice because **the agent loop touches three things at once** — model client, conversation persistence, tool execution against the host machine — and splitting any of them across a process boundary buys complexity (IPC, error propagation, lifecycle coordination) for no offsetting benefit.

### Why crest looks different

Git archaeology (see ai-config-architecture refactor history): `pkg/aiusechat/` was added in **2025-10** during the Wave Terminal era, when Wave was "a terminal with an AI sidebar". Wave's pre-existing architecture was `Electron renderer ↔ wavesrv` because PTY management requires a long-lived backend. AI got bolted into wavesrv because **the infrastructure was already there** (secretstore, websocket transport, chatstore-able SQLite).

Crest forked from Wave in **2026-04** and built `pkg/agent/` (native coding agent, 100% crest-original) on top of the same `pkg/aiusechat/`. The agent's location in wavesrv is **not** a design decision; it's the path of least resistance for the original Wave authors. Nobody picked it for crest's needs.

## 4. The actual best practice

For an Electron AI product, the standard layout is:

```
┌────────┐    IPC    ┌────────────────────┐
│Renderer│←─────────→│Electron Main (Node)│
│(React) │           │ - agent loop       │
│        │           │ - ai-sdk providers │
│useChat │←─stream───│ - tool dispatch    │
└────────┘           │ - keychain access  │
                     │ - conversation     │
                     │   persistence      │
                     └────────────────────┘
                              ↓
                    upstream LLM API
```

The renderer stays a pure UI surface. The main process owns everything the agent does. API keys never leave the main process. Tool execution runs in the same process as orchestration, so there's no inter-process round-trip per tool call.

ai-sdk's [official docs](https://sdk.vercel.ai/docs) describe the "server-side route handler that calls `streamText`" pattern. In a web app the "server side" is a Next.js API route. In an Electron app the equivalent is the main process — same role, different host. The shape is identical: UI hook ↔ in-process route ↔ ai-sdk provider ↔ upstream.

## 5. Option D — Move the agent into Electron main (recommended)

Proposed target architecture:

```
┌────────┐  IPC   ┌──────────────────┐         ┌──────────────┐
│Renderer│←─────→│Electron Main      │←wshrpc→ │Go wavesrv    │
│(React) │       │ (Node)            │         │              │
│        │       │ ─ agent loop      │         │ Stays as:    │
│useChat │←──────│ ─ ai-sdk client   │         │ ─ PTY mgr    │
│        │       │ ─ tool dispatch   │         │ ─ block IO   │
└────────┘       │ ─ chatstore       │         │ ─ blockmeta  │
                 │ ─ checkpointstore │         │ ─ wstore DB  │
                 │ ─ secretstore     │         │ ─ tab events │
                 └──────────────────┘         └──────────────┘
                          ↓
                  upstream LLM API
```

What moves:

- `pkg/agent/run.go` → Electron main (`emain/agent/` or similar) — agent loop, posture enforcement, plan progression, tool gating
- `pkg/agent/tools/` → Electron main — file IO and shell exec become Node calls; tools that need wavesrv (block snapshots, PTY input) keep using wshrpc as a remote call
- `pkg/aiusechat/*` → **deleted** — replaced by `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@openrouter/ai-sdk-provider`
- `pkg/agent/chatstore.go` → main-side SQLite via `better-sqlite3`
- `pkg/agent/checkpoint.go` → main-side filesystem
- `pkg/secretstore/` → Electron's `safeStorage` API (system-keychain-backed) **or** stays in wavesrv and main calls via wshrpc — open question, see §8

What stays in wavesrv:

- PTY management (the original reason wavesrv exists)
- Block IO (terminal output capture, scroll buffer, ANSI parsing)
- `wstore` DB (block / tab / window persistence, meta key reads)
- WPS event bus (only meaningful for terminal-side events anyway)

What the renderer sees:

- ai-sdk's `useChat` still works exactly as today, but its transport posts to an Electron IPC channel instead of HTTP to wavesrv. The wire format (`UIMessage` parts) stays the same — that's an ai-sdk standard.

### Why Option D dissolves the A/B/C tradeoffs

| Concern | A | B | C | **D** |
|---|---|---|---|---|
| Uses ai-sdk providers | ✅ | ❌ | ✅ | ✅ |
| API keys stay out of renderer | ❌ | ✅ | ✅ | ✅ |
| Agent loop stays out of renderer | ❌ | ✅ | ❌ | ✅ |
| Per-tool inter-process round-trip | yes (FE→BE for each tool) | no | yes | no |
| Deletes `pkg/aiusechat/*` (~3000 LOC) | ✅ | ⚠️ replaced, not deleted | ✅ | ✅ |
| wavesrv keeps its single responsibility | ❌ | ❌ | ❌ | ✅ |

Option D is the only path that scores ✅ on every dimension. It is also the path that aligns with what every other Electron AI product does.

### Effort

Calendar estimate: **2–3 weeks** for a working migration, ~1 additional week for production-quality (regression tests, parity bench across providers).

LOC delta:

- `pkg/aiusechat/*` removed (~3000 LOC Go)
- `pkg/agent/run.go` + tools removed from Go (~1500 LOC Go)
- Electron main agent layer added (~2500 LOC TS) — smaller because ai-sdk handles streaming/tool-protocol/error-classification for free
- Net: **~−2000 LOC** for crest, plus the maintenance burden of the 4 vendor backends moves to Vercel

Risk: medium. The blast radius is large (deletes a whole subsystem) but well-bounded — the FE wire shape doesn't change, and wavesrv's terminal responsibilities are untouched.

### Open questions for the implementer

1. **Where does `secretstore` end up?** Two choices:
   - Move secrets to Electron `safeStorage` (system-keychain-backed). Cleaner, no IPC for token reads. Requires migrating existing user keychain entries.
   - Keep secrets in wavesrv; main calls `GetSecret` via wshrpc on each LLM request. One extra round-trip per request (~ms), no migration.
   - **Default proposal:** keep in wavesrv for v1 (one round-trip is cheap; migration is annoying), revisit if it shows up in latency profiling.
2. **chatstore migration.** wavesrv's chatstore is JSON files in `~/.local/share/crest{-dev}/chatstore/`. Main-side equivalent is trivial (Node `fs`), but existing user conversations need either a copy on first run or a wshrpc-shim that lets main read wavesrv's directory.
3. **Tool execution boundary.** Some tools naturally belong in wavesrv (block snapshots, shell input injection); others naturally belong in main (filesystem ops, git, web fetch). Need an explicit list — most tools probably move to main because wavesrv has nothing they need.
4. **wavesrv's existing `/api/post-agent-message` HTTP handler.** Delete it, or keep as a back door for external callers (CLI scripts, harness)? Bench harness (`task bench`) currently calls it directly — needs to either migrate to call main process via IPC or stay on the wavesrv path with a clean separation.

## 6. Alternative paths (kept for completeness, not recommended)

These were the only options visible when the dilemma was framed as "FE provider plugins vs Go backend". Each carries the cost Option D avoids; document here so future readers can see why they were considered and ruled out.

### Option A — Use ai-sdk providers in the renderer; tool calls round-trip to wavesrv

```
Renderer → streamText({ model: anthropic(...), tools }) — direct to upstream
       ↑                                                       ↓
       └── wshrpc ── wavesrv tool executor ── wshrpc ──────────┘
```

- API keys **in the renderer process**, transmitted to upstream APIs from there. Security regression vs current setup. Mitigations all reinvent a backend signing layer.
- Per-tool round-trip: each tool call is renderer → wavesrv → renderer.
- Loses the central place to put rate limiting, request logging, audit.

### Option B — Replace `pkg/aiusechat/*` with Go SDKs (`openai-go`, `anthropic-sdk-go`, `google.golang.org/genai`)

- Doesn't actually adopt ai-sdk; uses different per-vendor official Go SDKs.
- Preserves the wavesrv-owned agent loop, so no IPC reshape.
- Saves maintenance on the SSE/tool-protocol code but doesn't address the structural source-of-truth issue (still 3 vendor SDKs to track).
- Smaller calendar (~1 week) but doesn't deliver the ai-sdk ecosystem benefits.

### Option C — Hybrid: wavesrv proxies, renderer uses ai-sdk providers with `baseURL` pointing at wavesrv

- API keys stay server-side (good).
- Each ai-sdk provider has its own assumption about base URL shape; some proxy cleanly, others don't (Gemini's `{model}` URL template, OpenAI Responses' nested path).
- Tool execution still needs round-tripping; **agent loop still has to move to the renderer**, which is the largest cost piece.
- All the work of D, without the win of putting orchestration in main.

## 7. Recommendation

Pick **Option D** when the work can be scheduled.

The case for D is structural, not aesthetic:

- It corrects the historical accident (agent in wavesrv) that turned a clean problem into a stuck tradeoff.
- It aligns crest with the de facto pattern every comparable Electron product uses.
- It deletes more code than it adds, with maintenance work shifted onto upstream (Vercel).
- It moves crest's architecture toward the dominant ecosystem (ai-sdk + Node), making future feature pickup (structured-output schemas, tool middleware, multi-modal inputs) cheaper.

Do not do Option A under any circumstance — moving keys to the renderer is the only outcome whose cost is hard to walk back. B and C exist as fallbacks if Option D is blocked (e.g. team decides to deprecate Electron in favor of a web frontend, in which case "Electron main" disappears and the calculus changes).

## 8. Trigger conditions for actually scheduling this

Don't schedule Option D today (the P0-#1 through P0-#5 items just landed; ride those for a release or two and see what falls out). Schedule it when **any** of the following hits:

- A new major LLM provider goes on the roadmap and would require adding another ~700 LOC Go backend to `pkg/aiusechat/`.
- A bug touches the same per-vendor SSE/tool-translation logic in 2+ backends within a quarter.
- ai-sdk adds a feature crest wants (streaming object schemas, server-side tools, multi-modal inputs) and rolling it ourselves would mean ~300+ LOC across all 4 backends.
- We start losing more than ~2 days/quarter to provider-quirk bugs in `pkg/aiusechat/`.
- We have a 2–3 week stretch where the core team isn't load-bearing on user-visible features (D is internal restructuring; doesn't ship a feature directly).

## 9. Minimal Option D execution plan

Once scheduled, the work splits cleanly:

**Week 1 — main-side agent skeleton**
1. Create `emain/agent/` with: ai-sdk transport, conversation state, tool dispatcher, secret/chat persistence shims (initially calling wavesrv via wshrpc for both).
2. Stand up a parallel IPC channel for `useChat` (`electron-main:agent-stream`) without removing the wavesrv HTTP path yet.
3. Smoke test: `/api/post-agent-message` and the new IPC channel can both serve the same renderer.

**Week 2 — vendor swap-in + tool migration**
4. Replace the 4 wavesrv backends with `@ai-sdk/openai` / `@ai-sdk/anthropic` / `@ai-sdk/google` / `@openrouter/ai-sdk-provider` in main.
5. Migrate tools that don't need wavesrv (filesystem ops, git, web fetch, shell exec via Node `child_process`) into main.
6. Keep wavesrv-required tools (block snapshot, PTY input) as wshrpc calls from main.

**Week 3 — cutover + cleanup**
7. Flip `useChat` transport to the IPC channel; delete `/api/post-agent-message` and `pkg/aiusechat/*`.
8. Move chatstore + checkpointstore to main-side SQLite + filesystem.
9. Decide secretstore destination (see §5 question 1).
10. Run bench harness for parity check across providers.
11. Update `docs/agent-architecture.md` to reflect the new boundary.

The order matters: stand the new path up alongside the old, prove parity, then delete. No big-bang flip.

---

## tl;dr

The "FE vs BE for LLM client" framing produces a stuck tradeoff because it accepts the wrong premise — that the agent loop has to live in Go wavesrv. Every other Electron AI product runs the agent in the main process; doing the same dissolves the tradeoff. **Option D (agent in Electron main + ai-sdk providers in Node) is the path that matches industry practice and scores cleanly on every dimension that Options A/B/C trade off against each other.** Don't schedule it this quarter, but schedule it when one of the §8 triggers fires.
