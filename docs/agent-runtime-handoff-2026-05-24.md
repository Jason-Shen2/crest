# Agent Runtime Migration — Overnight Handoff (2026-05-24)

This is a status snapshot of the autonomous work I did while you slept. Read this first when you come back, then `git log` for the commit details.

**Branch:** `main` (ahead of `origin/main` by **5 commits**, nothing pushed — you decide when to push)
**Working tree:** **clean**
**Test suite:** **171/171 passing**
**TS:** `tsc --noEmit -p tsconfig.json` — 0 errors in any of the new code (58 pre-existing errors unchanged)

---

## What's done (and committed)

| # | Task | Commit | State |
|---|---|---|---|
| #6 | Integrate pi source into emain/agent + emain/ai | `2a4945ba` | ✅ Done (pre-handoff) |
| #7 | Spike: Agent.prompt() works end-to-end | `2a4945ba` | ✅ Done (pre-handoff) |
| #8 | Per-pane session bridge (sessions / harness / system-prompt) | `6494b288` | ✅ Done (pre-handoff) |
| #9 | IPC bridge: main ↔ renderer | `ce6c9735` | ✅ **Done overnight** |
| #11 | Permissions hook (allowlist + bench bypass) | `aa5a8e54` | ✅ **Done overnight** |
| #10 | Crest-specific tools (v1 baseline) | `18c9a001` | ⚠️ **Partial — 6 of 24 ported** |
| #12 | usePiChat hook + drop @ai-sdk/react | `a394befc` | ⚠️ **Half — hook only, wiring deferred** |
| #13 | Delete Go agent stack | — | 🚫 **Blocked on #12 wiring** |
| #14 | E2E regression | — | 🚫 **Blocked on #12 wiring + live API keys** |
| #15 | Migrate block.meta JSON naming to camelCase | — | 📋 Deferred (independent housekeeping) |

(Commit hashes are short-form. Use `git log --oneline -8` to verify.)

---

## What I deliberately did NOT do, and why

### Task #10 — 18 of 24 tools deferred

**Done (6 pure-Node tools):**
- `read_file` — file IO with offset/limit
- `write_file` — overwrites + mkdir -p
- `multi_edit` — atomic, exact-string replacements
- `list_dir` — typed entries, cap on count
- `web_fetch` — Node fetch, 1 MB cap, timeout
- `shell_exec` — `/bin/sh -c`, captures stdout/stderr/exit, SIGTERM-then-SIGKILL on abort

**Deferred (18 tools)** — all need design decisions I wasn't going to make for you:

| Tool | Why deferred |
|---|---|
| `ask_user_question` | Needs renderer prompt UI design |
| `browser` | Needs Electron BrowserView decision + automation lib |
| `create_block`, `focus_block`, `get_scrollback`, `headless_shell_exec` | Need wavesrv state access via wshrpc; defining that bridge is a design call |
| `transfer_to_user` | Needs UI handoff semantics |
| `spawn_task` | Sub-agent — needs orchestration design |
| `search` | Bundle ripgrep? Use Node glob+readline? Different answer per platform |
| `cmd_history` | Needs access to pane's shell history (wavesrv) |
| `dangerous`, `file_tracker`, `long_running_read`, `long_running_write`, `multi_edit` (already done), `todo`, `write_plan` | Some are extensions of file IO (need decision on persistence); others are crest-specific orchestration tools |

The 6 we shipped cover the **minimum viable agent** — read code, edit it, run shell, fetch URLs. With these, the agent can do real coding work as soon as #12 wiring lands.

### Task #12 — Hook implemented, wiring deferred

I wrote `frontend/app/store/use-pi-chat.ts` (290 LOC + reducer tests) but **deliberately did not replace the live useChat path**. The reason: shape mismatch between ai-sdk `UIMessage.parts[]` and pi `AgentMessage.content[]` means the wiring touches:

- `AgentChatHost.tsx` (swap useChat for usePiChat)
- `agent-block-element.tsx` (rewrite the parts-iteration render loop)
- `terminal-model.ts` (apply* APIs may need new shape, or be deleted entirely)
- `terminal-view.tsx` (mint sessions, pass onSessionMinted, etc.)
- `package.json` (drop `@ai-sdk/react`)

Doing all of that wrong = agent panel breaks entirely. Best done with eyes on the screen.

**Wiring checklist** is also in the doc-comment at the top of `use-pi-chat.ts` so it can't get lost.

### Task #13 — Delete Go agent stack

Cannot run safely until #12 wiring is verified end-to-end. Otherwise we delete the path the renderer is still using.

### Task #14 — E2E regression

Needs:
1. #12 wiring done (so the new path is what's being tested)
2. Live API keys (I don't have access)
3. Manual verification with a real model in the live app

---

## Architecture invariants you can rely on

(These match `docs/agent-runtime-architecture.md` — read that doc if you haven't.)

1. **block.meta["agent:session"]** holds `{id, createdAt, cwd, path}` — pi's JsonlSessionMetadata shape (`createdAt` camelCase, Y1 exception). On `task generate` it shows up as `AgentSessionMeta` in `frontend/types/gotypes.d.ts`.

2. **block.meta["agent:chatid"]** is **gone** from the schema; `terminal-view.tsx` regenerates an in-memory `chatId = useMemo(crypto.randomUUID())` per pane lifetime. This is short-lived — when you do the #12 wiring, replace it with `onSessionMinted` writing `agent:session`.

3. **Sessions live on disk** at `~/.config/crest{-dev}/sessions/<encodedCwd>/<timestamp>_<id>.jsonl`. Pi's `JsonlSessionRepo` owns the layout; we never write to those files directly.

4. **The harness cache** (`emain/agent-ipc.ts` `harnessCache: Map<sessionPath, PaneHarness>`) is the only thing that holds live `AgentHarness` instances. Lifetime: created on first IPC `agent:send` for a session; survives renderer remount; released only on `_resetAgentIpcForTests()` (no production GC path yet — fine for v1).

5. **Per-pane cwd** flows through `PaneHarness.update(inputs)` on every IPC `agent:send` — mutates `env.cwd` (for tool execution) AND the closure that `systemPrompt: () => buildSystemPrompt(inputs)` reads. Matches warp's "session pinned to creation cwd, exchange carries latest" pattern.

6. **Permissions** default to `allowAll` in v1 (no UX gate). Setting `CREST_AGENT_BENCH=1` forces allowAll regardless. Sending `allowedTools: [...]` via IPC switches to enforcement mode.

7. **Tool execution** runs in the Electron main process by default. Tools needing wavesrv state (blocks / scrollback / etc.) would go through wshrpc — none of those are wired yet (see Task #10 deferrals).

---

## Files added overnight

```
emain/agent-ipc.ts                       — ipcMain handlers + harness cache (~250 LOC)
emain/agent/permissions.ts               — buildPermissionsHook + isBenchMode (~80 LOC)
emain/agent/permissions.test.ts          — 8 tests
emain/agent/tools/_paths.ts              — expandHome / requireAbsolute helpers
emain/agent/tools/read-file.ts           — read_file tool
emain/agent/tools/write-file.ts          — write_file tool
emain/agent/tools/multi-edit.ts          — multi_edit tool
emain/agent/tools/list-dir.ts            — list_dir tool
emain/agent/tools/web-fetch.ts           — web_fetch tool
emain/agent/tools/shell-exec.ts          — shell_exec tool
emain/agent/tools/index.ts               — getDefaultTools() + DEFAULT_TOOL_NAMES
emain/agent/tools/tools.test.ts          — 29 tests (incl. loopback HTTP for web_fetch)
frontend/app/store/use-pi-chat.ts        — React hook (NOT yet wired in)
frontend/app/store/use-pi-chat.test.tsx  — 8 reducer tests

(plus modifications to emain/emain-ipc.ts, emain/preload.ts,
 emain/agent/harness-factory.ts, frontend/types/custom.d.ts)
```

## Files in their previous shape (intentionally not touched)

```
frontend/app/term/render/agent-chat-host.tsx       — still uses ai-sdk useChat
frontend/app/term/render/agent-block-element.tsx   — still consumes UIMessagePart
frontend/app/term/terminal-model.ts                — apply* APIs unchanged
frontend/app/term/render/terminal-view.tsx         — useMemo(crypto.randomUUID()) chatId
pkg/agent/**                                       — Go agent stack alive
pkg/aiusechat/**                                   — 4 hand-rolled backends alive
pkg/agent/mcp/**                                   — MCP module alive (to be deleted)
package.json                                       — @ai-sdk/react still a dep
```

---

## Recommended pick-up order when you come back

**If you have ~30 min** — review and push:
- `git log --oneline -8` to see the 5 new commits
- Read this doc + `docs/agent-runtime-architecture.md` if you want the deep version
- `git push` to send to Jason-Shen2/crest
- Sleep on whether to proceed with #12 wiring

**If you have ~1-2 hours** — start the #12 wiring:
- Open `frontend/app/store/use-pi-chat.ts`, read the module-doc + the checklist at the bottom of this doc
- Make the AgentChatHost swap first (smallest blast radius)
- Run `npx vitest run` after each step
- Stop and ask Claude when you hit the agent-block-element rewrite — that's the biggest pain point

**If you have a full day** — finish #12 + #13:
- #12 wiring per the checklist above
- Once `task electron:quickdev` shows a working agent panel end-to-end (manually verify with one LLM provider), delete `pkg/agent/` and `pkg/aiusechat/` and the `/api/post-agent-message` route
- Then commit and update the architecture doc §10 implementation status

**If you want to do something orthogonal** — task #15 (camelCase migration) is fully independent and can be done any time.

---

## Things I changed but want to flag for your eyes

1. **`emain/agent/tools/list-dir.ts:81`** — has a slightly hacky `void path.sep` to avoid an unused-import warning. The `path` import is for future when list-dir might join base + entry name; for now it's not used. Either:
   - Leave it (current state, harmless)
   - Drop the import + the `void path.sep` line

2. **`emain/agent/tools/shell-exec.ts`** — hardcodes `/bin/sh`. Won't work on Windows. Fine for macOS-first development; needs `os.platform() === "win32"` branch before Windows ships. Documented in code.

3. **`frontend/app/store/use-pi-chat.ts`** — defines a `PiAgentMessage` interface at the renderer boundary instead of importing `AgentMessage` from `emain/agent/types`. Renderer must not import main-process modules. This means the two types can drift; the doc-comment notes this and asks for review when wiring.

4. **No integration test against a real LLM was run**. The spike (`emain/agent/_spike.ts`) is the closest thing — running it with `ANTHROPIC_API_KEY=... npx tsx emain/agent/_spike.ts "hi"` is the quickest sanity check that the integrated agent actually works end-to-end. I didn't run it because I'd be burning your tokens without consent.

---

## What's safe to do without me

- Read code, review commits, push to remote.
- Run the test suite (`npx vitest run`) — 171 should pass.
- Run the spike with your own API key to manually verify the agent stack works in main.
- Inspect the architecture doc (`docs/agent-runtime-architecture.md`) and disagree with anything.

## What needs me back

- The actual #12 wiring (high blast radius).
- Any decision about the deferred 18 tools (they need design calls).
- The #14 E2E test against live LLMs.
- The #13 deletion (depends on #12 wiring being verified).

---

End of handoff. Commit count: 5. LOC delta: ~+1700 / ~−5 (mostly the architecture doc + new tool/IPC code).
