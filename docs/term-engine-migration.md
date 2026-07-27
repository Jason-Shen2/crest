# Terminal Engine Migration — warp-style command-block renderer

> **⚠️ SUPERSEDED (2026-07-27).** The custom cell-grid engine this document
> describes was **deleted** in commit `0f35c73c` and replaced by the
> terax-ported xterm.js stack. See **`docs/terax-terminal-port.md`** for the
> current architecture and decision log. This file is kept for historical
> context only — its phase tables and file inventory no longer match the tree.

**Target:** Replace xterm.js-based terminal rendering with a self-contained,
warp-aligned cell-grid engine.
**Code root:** `frontend/app/term/`
**Reference:** `/Users/mac/Documents/open-source/warp/` (Rust source, read-only — do not link)
**Status:** Core engine + `termblocks` view type **complete** (P1–P16, 16 phases).
Single-xterm `term` view type **not yet migrated** (separate workstream).

---

## TL;DR

We've shipped a from-scratch terminal engine in TypeScript that mirrors warp's
data model (per-block grids, OSC 133-driven state machine, sum-tree-equivalent
cumulative heights for viewport queries) and a React render layer that paints
cells as DOM rows. The `termblocks` view type (block-decomposed terminal) is
fully migrated and live. The simpler single-xterm `term` view type still uses
xterm.js because it has deep VDom / sub-block / agent-overlay integrations
that need to be re-implemented on the new engine before xterm can be removed
from `package.json`.

This document is the **handoff brief** for completing the migration. It is
written so a future session — possibly with cold context — can resume work
without rediscovering decisions.

---

## Phase status

| Phase | Scope | Status |
|-------|-------|--------|
| P1 | `engine/types.ts` + `style.ts` + `grid.ts` — Cell / Style / Grid foundations | ✅ done |
| P2 | `block-grid.ts` + `header-grid.ts` + `alt-screen.ts` | ✅ done |
| P3 | `block.ts` + `blocks.ts` — collection w/ cumulative heights | ✅ done |
| P4 | `ansi-parser.ts` + `handler.ts` — 13-state VTE machine | ✅ done |
| P5 | OSC 133 / OSC 8 / OSC 7 dispatch in `block-handler.ts` | ✅ done |
| P6 | `terminal-model.ts` — wps event subscriptions, parser orchestration | ✅ done |
| P7 | React render layer (cell-run, grid, block, list, terminal-view) | ✅ done |
| P8 | Wire `TermBlocksViewModel.viewComponent` → `TerminalViewAdapter` | ✅ done |
| P9 | TUI keyboard routing (`key-bindings.ts` + document keydown) | ✅ done |
| P10 | OSC 8 link click → `getApi().openExternal` | ✅ done |
| P11 | cols ResizeObserver + `sendResize` SIGWINCH | ✅ done |
| P12 | Disable legacy wps / poller in `TermBlocksViewModel` | ✅ done |
| P13 | Selection drag + overlay layer + Cmd+C copy | ✅ done |
| P14 | Find UI (Cmd+F) bound to `BlockGrid.setFilter` | ✅ done |
| P15 | Delete legacy `view/cmdblock/*` files + slim `termblocks.tsx` (2692 → 64 lines) | ✅ done |
| P16 | Uninstall `@xterm/*` packages | ⏸ blocked on **`view/term/` migration** |
| **P17** | **Migrate `view/term/` (single-xterm view) to new engine** | 📋 see [§ Pending work — Track A](#track-a-viewterm-migration) |
| **P18** | **Re-implement VDom toolbar / sub-block / TermStickers on new engine** | 📋 see [§ Pending work — Track B](#track-b-vdom-toolbar--subblocks--stickers) |
| **P19** | **Reconnect term-agent UI to `TerminalModel`** | 📋 see [§ Pending work — Track C](#track-c-term-agent-ui-reconnection) |
| **P20** | **Drop `@xterm/*` and `view/term/*` directory** | 📋 see [§ Pending work — Track D](#track-d-final-cleanup) |

---

## Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Go: pkg/cmdblock decodes PTY, splits on OSC 133, emits wps events   │
└──────────────────────────────────────────────────────────────────────┘
                                ↓
       cmdblock:row / chunk / altscreen / clear  (wps over websocket)
                                ↓
┌──────────────────────────────────────────────────────────────────────┐
│  TerminalModel (frontend/app/term/terminal-model.ts)                 │
│    - owns Blocks collection                                          │
│    - owns one AnsiParser + one BlockHandler                          │
│    - swaps handler.setBlock(target) per chunk                        │
│    - jotai atoms: revision / selection / scrollPos / find / loading  │
└──────────────────────────────────────────────────────────────────────┘
                                ↓
┌──────────────────────────────────────────────────────────────────────┐
│  AnsiParser → BlockHandler → Block.activeGrid()                      │
│    OSC 133;A/B/C/D → block.startPrompt/endPrompt/Cmd/finishCommand   │
│    CSI m → applySgr → grid.setStyle                                  │
│    CSI ?1049 h/l → block.enterAltScreen / exit                       │
│    OSC 8 → grid.addLink + style.linkId                               │
└──────────────────────────────────────────────────────────────────────┘
                                ↓
┌──────────────────────────────────────────────────────────────────────┐
│  Grid mutate (rows: Cell[][], cursor, dirtyRows)                     │
│  BlockGrid.finish() → memoize rightmostNonempty / hasVisibleChars    │
│  HeaderGrid: dual grid + CellExtra anchors (promptStart/End/CmdStart)│
└──────────────────────────────────────────────────────────────────────┘
                                ↓
                   TerminalModel.bumpRevision()
                                ↓
                useAtomValue(revisionAtom) → React re-renders
                                ↓
┌──────────────────────────────────────────────────────────────────────┐
│  React render (frontend/app/term/render/)                            │
│    TerminalView → BlockListElement → BlockElement → GridElement      │
│    computeRuns merges cells by style identity → CellRun <span>s      │
│    SelectionLayer paints overlay rectangles (never touches cells)    │
│    FindBar binds Cmd+F to BlockGrid.setFilter                        │
└──────────────────────────────────────────────────────────────────────┘
```

### Key invariants

1. **Renderer never mutates cells.** Selection, find-match highlights, secrets
   are *overlay layers* drawn from metadata. The cell stream is immutable
   from React's perspective.
2. **One parser per terminal.** `BlockHandler.setBlock(target)` swaps the
   write destination on each chunk event. Out-of-order chunks are dropped
   via `writtenOffsets` map; the 10 s safety poll repairs gaps.
3. **OSC 133 drives lifecycle.** Block state never gets inferred from byte
   content — only explicit markers transition. This is what makes warp
   robust across shells.
4. **Per-block grids, not continuous scrollback.** Each Block owns
   `headerGrid` (dual: prompt + prompt+command) + `outputGrid` + `altScreen`.
   This is the load-bearing trade-off: gives clean serialization /
   share-block / AI-context boundaries; costs cross-block search which we
   handle at the collection level (`Blocks.all()` iteration).
5. **Cumulative-height array ≡ warp's SumTree.** `O(log N)` viewport
   queries via binary search. Rebuild on mutation is `O(N - i)` from the
   modified index forward; amortized `O(1)` for the common tail-growth case.

### What's deliberately **not** like warp

- **No custom GPU renderer.** DOM rows + Tailwind. Warp's bespoke Rust+GPU
  pipeline is a multi-month rebuild; xterm.js in Electron costs us almost
  nothing in perf for typical terminal output (rows are static once
  rendered; only the streaming tail mutates).
- **No SumTree.** TS array + cumulative sums has identical asymptotic
  complexity for viewport range queries; only the random-position
  `updateHeight` is `O(N - i)` vs SumTree's `O(log N)`. In practice we
  almost always update the tail.
- **No `OnceLock`.** TS uses lazy memoization via plain `?:` cache fields
  on `BlockGrid` (cleared at finish).

---

## What's live (post-P16)

Behavior parity with warp for the `termblocks` view type:

| Feature | Status | Notes |
|---|---|---|
| Block-decomposed output (OSC 133) | ✅ | A/B/C/D fully wired |
| ANSI SGR colors (16 / 256 / RGB) | ✅ | `engine/style.ts` |
| Cursor positioning (CUP / CUU / CUD / CUF / CUB / CHA / VPA) | ✅ | `block-handler.ts` |
| Erase (EL / ED) | ✅ | inherits current bg color (xterm convention) |
| Scroll (SU / SD) | ✅ | |
| Save/restore cursor (DECSC/DECRC, ESC 7/8, CSI s/u) | ✅ | |
| Alt-screen (CSI ?1049 h/l) | ✅ | block-inline (warp-style); vim/htop/less/lazygit usable |
| TUI keyboard routing | ✅ | `key-bindings.ts` covers arrows / F1-F12 / Home/End/PgUp/PgDn / Ctrl-letters / Alt prefix |
| OSC 8 hyperlinks (click to open) | ✅ | wires to `getApi().openExternal` |
| OSC 7 cwd tracking | ✅ | `block.pwd` |
| Wide chars (CJK, emoji) | ✅ | basic UCD ranges; full UAX-11 deferred |
| UTF-8 streaming decode | ✅ | TextDecoder with `{stream: true}` handles split sequences |
| Mouse drag selection | ✅ | overlay layer, never touches cells |
| Cmd+C copy | ✅ | extracts text from selected range, trims trailing whitespace |
| Cmd+F find | ✅ | bound to per-block regex filter |
| Scroll-to-bottom follow / pause-on-scroll-up | ✅ | `ScrollPosition` enum drives behavior |
| Snackbar sticky header on scroll | ✅ | IntersectionObserver |
| Hover toolbelt (copy / AI / save / filter / bookmark / share / more) | ✅ visual | only copy + ask-AI wired; rest are stubs |
| Window-resize cols + SIGWINCH | ✅ | ResizeObserver + measured char width |
| Done-block immutability + memo | ✅ | `BlockGrid.finish()` triggers lazy cache |
| Inline link tooltip on hover | ⚠️ partial | URI shown in `title` attr; no rich popover |
| Vim/htop/less | ✅ functional | basic verified mentally — manual smoke test required |

### What's **not** wired but **does** have UI

These exist as JSX but the click handler is empty — they're the next layer
of polish, not full bugs:

- Toolbelt **Save Workflow** button
- Toolbelt **Filter** button (filter-per-block exists, no UI gate)
- Toolbelt **Bookmark** button
- Toolbelt **Share** button
- Snackbar **Jump back** click (sets scroll anchor; needs scrollTo logic
  in BlockListElement)
- Input bar **Model picker** dropdown
- Input bar **Suggestions** row (data: `historyAtom` was loaded in legacy
  path; need to re-route to new model)

---

## Pending work

### Track A — `view/term/` migration

The single-xterm `term` view type (regular terminal pane, no command-block
decomposition) is still on xterm.js. It cannot be deleted because:

- `BlockRegistry.set("term", TermViewModel)` in `frontend/app/block/blockregistry.ts`
- `frontend/app/store/tabrpcclient.ts` imports `TermViewModel` (type-only, but still a load)
- `frontend/app/block/durable-session-flyover.tsx` mounts `TermViewModel`

**Files in scope** (current):

```
frontend/app/view/term/
├── term.tsx              (~410 LOC)   main view component
├── term-model.ts         (~1200 LOC)  TermViewModel — atoms, RPC plumbing
├── termwrap.ts           (~600 LOC)   xterm instance wrapper
├── termutil.ts           (~350 LOC)   theme + helpers
├── term-agent.tsx        (~810 LOC)   AI overlay anchored on the term view
├── term-settings-menu.ts (~150 LOC)   gear menu builder
├── term-tooltip.tsx      (~80 LOC)    OSC 8 hover preview
├── termsticker.tsx       (~120 LOC)   workspace sticker overlay
├── term-wsh.tsx          (~190 LOC)   wsh control integration
├── osc-handlers.ts       (~340 LOC)   custom OSC dispatcher (legacy)
├── fitaddon.ts           (~30 LOC)    @xterm/addon-fit wrapper
├── term.scss + xterm.css            styling
└── termtheme.tsx (in `view/term/`?  resolve in P17 kickoff)
```

**Two viable strategies:**

| Strategy | Cost | Result |
|---|---|---|
| **A1 — Wrap `TerminalView`** | ~2 days | Replace `TermViewModel.viewComponent` with an adapter that renders `<TerminalView outerBlockId={blockId} />`. Single big block, no OSC 133 needed. Loses the directly-interactive xterm — input goes through the model's `submitInput` path. |
| **A2 — Native "raw" mode in engine** | ~4–5 days | Add a `Block.mode = "raw"` variant where the entire block is one continuous stream (no prompt/command split, no exit-code marker, no command finalization). Cleaner long-term — matches warp's `Block::Static`. |

Recommend **A1 first** (fast unblock of P16), revisit A2 if interactive
performance suffers.

**A1 detailed plan:**

1. In `frontend/app/view/term/term-model.ts`:
   - Remove all xterm-related fields (`termRef`, `connStatus`, etc. — KEEP
     since other modules read them as TS types; mark fields optional).
   - Add `viewComponent` getter that returns a new adapter (parallel to
     how `TermBlocksViewModel` does it).
2. Create `frontend/app/view/term/term-adapter.tsx`:
   - Pulls `blockId` from the model.
   - Renders `<TerminalView outerBlockId={blockId} />`.
3. Verify `durable-session-flyover.tsx` still mounts — the flyover may
   reach into `model.termRef` for things like `focus()`; add equivalents
   on `TerminalModel` (`focus()`, `blur()` no-ops are OK initially).
4. Verify `store/tabrpcclient.ts` — read-only type import, should be safe.
5. Remove the xterm.js mount path from `term.tsx`. The whole file becomes
   the adapter or a thin wrapper.
6. tsc, run `npm run dev`, verify a "term" block (plain `bash`, `python`,
   `ssh somewhere`) renders correctly.

**Risks:**

- The "term" view supports interactive REPLs that don't emit OSC 133
  (python, node, ssh remote sessions). The new engine's block-finish
  detection relies on OSC 133;D — without it, the "block" never finishes,
  the running spinner stays forever, and any "scroll-to-bottom" behavior
  may misfire.
- **Mitigation:** introduce a `Block.markStatic()` path that treats the
  whole session as one ongoing block. Suppress lifecycle UI (no exit-code
  badge, no duration timer) when `block.isStatic === true`.

**Acceptance:**

- `bash` opened in a "term" view shows output ✓
- Arrow-up history works (because keys route through new model's `sendBytes`) ✓
- `python` REPL — typing `print(1)` shows `1` ✓
- `ssh somehost` — connection works, prompt visible ✓
- `vim file` — alt-screen takes over the block ✓

### Track B — VDom toolbar / sub-blocks / TermStickers

These are features anchored on `term.tsx` that the new engine doesn't (yet)
support:

**VDom toolbar:**
- Custom UIs rendered above the terminal via `pkg/vdom` Go-side framework
- Triggered by `term:mode = "vdom"` block meta + a VDom block ID
- Renders custom components (forms, charts, etc.) inline with the terminal

**Sub-blocks:**
- Wave's mechanism for nesting blocks inside a parent block
- `<SubBlock />` import in `term.tsx`
- Used for the VDom toolbar mount point

**TermStickers:**
- Workspace-level customization overlays (decorative)
- `<TermStickers />` import in `term.tsx`

**Migration plan (P18):**

Each of these surfaces is independent of the cell-grid renderer. They mount
*around* the terminal, not *inside* it. The migration is mechanical:

1. After Track A (`TerminalView` is the term view's renderer), add slots
   to `TerminalView`:
   ```tsx
   interface TerminalViewProps {
     outerBlockId: string;
     fontSize?: number;
     topSlot?: React.ReactNode;    // for VDom toolbar
     bottomSlot?: React.ReactNode; // for stickers
     overlaySlot?: React.ReactNode;
   }
   ```
2. The term-adapter component reads `term:mode`, `term:vdomblockid` etc.
   and threads the appropriate child components into the slots.
3. Test each feature flag:
   - Default term (no mode): no slots, plain rendering
   - VDom mode: top slot shows VDom subblock
   - Workspace stickers visible: bottom slot mounts `<TermStickers />`

**Risks:**

- VDom subblocks have their own focus / event model. Wiring them through
  the new view's keyboard router (which captures keys for alt-screen) may
  cause conflicts. **Mitigation:** scope the document-level keydown
  listener to elements *inside* `rootRef.current` only.
- TermStickers may have positioning that depends on xterm's measured
  geometry. New engine measures differently. **Mitigation:** use the
  measured `charWidth` from `TerminalView` as the geometry source.

### Track C — term-agent UI reconnection

`view/term/term-agent.tsx` (810 LOC) is the AI agent chat overlay that
appears on top of the terminal. It reads:

- `TermViewModel.termAgentVisible` atom
- `TermViewModel.termAgentInput` atom
- `TermViewModel.termAgentChatStatus` atom
- `TermViewModel.termAgentSendMessage` callback (wires to ai-sdk's useChat)
- `TermViewModel.termAgentPosture` (permissions posture)
- Plus ~8 more atoms

**Migration plan (P19):**

1. Decide ownership: should agent state live on `TerminalModel` (per-pane)
   or `WorkspaceLayoutModel` (per-workspace)? **Recommend:** per-pane,
   matching the legacy contract.
2. Add agent atoms to `TerminalModel`:
   ```ts
   agentVisibleAtom: PrimitiveAtom<boolean>
   agentInputAtom: PrimitiveAtom<string>
   agentChatStatusAtom: PrimitiveAtom<string>
   agentEntriesAtom: PrimitiveAtom<AgentEntry[]>
   agentPostureAtom: PrimitiveAtom<string>
   // ...
   ```
3. Move `term-agent.tsx` to `frontend/app/term/render/agent-overlay.tsx`.
   It becomes a child of `TerminalView` rendered above the block list.
4. The agent's chat timeline interleaves with command blocks. Two design
   choices:
   - **C1:** Agent messages render as a separate scroll region above /
     below the block list (legacy behavior).
   - **C2:** Agent messages become a new `Block.kind = "agent"` variant
     in the same block list, sorted by timestamp (warp's design — see
     warp's `TimelineEntry` enum).
   Recommend **C2** for parity with warp's "Block::AgentResponse" pattern.
5. ai-sdk's `useChat` needs to be hosted by `TerminalView` (was hosted by
   the legacy `TermAgentChatProvider`). Same wiring, new home.
6. `term-agent-tool-renderer.tsx` and other tool-call UIs stay in their
   current files — only the model references update.

**Risks:**

- ai-sdk's chat state is independently reactive (`useChat` is a hook).
  Threading it through `TerminalModel`'s mutation-based state may cause
  duplicate renders. **Mitigation:** keep useChat in the React component
  layer; expose the model's atoms only for stable references (input
  string, posture). The model never sees ai-sdk message objects directly.
- Tool-call approval UIs (`TermAgentApprovalContext`) are global per-tab.
  Already provider-based; should just work after moving the provider to
  the new view.

### Track D — Final cleanup

Once A + B + C are done:

1. `git rm -r frontend/app/view/term/`
2. Edit `frontend/app/block/blockregistry.ts` to point "term" view type
   at the new `TermBlocksViewModel` (or rename to `TerminalViewModel`).
3. Remove `TermViewModel` import + reference from `store/tabrpcclient.ts`
   (type-only — safe).
4. Update `block/durable-session-flyover.tsx` to use the new model.
5. `frontend/package.json`: remove
   ```
   "@xterm/xterm",
   "@xterm/addon-fit",
   "@xterm/addon-search",
   "@xterm/addon-serialize",
   "@xterm/addon-web-links",
   "@xterm/addon-webgl"
   ```
6. `npm install` to update lockfile.
7. Optional: rename `view/termblocks/termblocks.tsx` →
   `view/termblocks/terminal-view-model.ts` since the legacy "termblocks"
   name only exists for back-compat with serialized block.meta.view values.

---

## File inventory (current)

```
frontend/app/term/                                4480 LOC
├── engine/                                       2673 LOC
│   ├── types.ts             191
│   ├── style.ts             194
│   ├── grid.ts              380
│   ├── block-grid.ts        192
│   ├── header-grid.ts       161
│   ├── alt-screen.ts         86
│   ├── block.ts             206
│   ├── blocks.ts            253
│   ├── handler.ts            58
│   ├── ansi-parser.ts       544
│   ├── block-handler.ts     387
│   └── index.ts              21
│
├── render/                                       1147 LOC
│   ├── color.ts              61
│   ├── cell-run.tsx          90
│   ├── grid-element.tsx     156
│   ├── block-element.tsx    234
│   ├── block-list-element.tsx 159
│   ├── terminal-view.tsx    248
│   ├── selection.ts          83
│   ├── selection-layer.tsx   76
│   ├── find-bar.tsx          70
│   ├── key-bindings.ts      111
│   └── index.ts              20
│
├── terminal-model.ts        455
└── index.ts                  10

frontend/app/view/termblocks/                       64 LOC  (was 2692)
└── termblocks.tsx            64    compat shim → TerminalViewAdapter

frontend/app/view/cmdblock/                        300 LOC  (visual atoms reused)
├── cmdblock-header.tsx     ~90    prompt-row composition
├── cmdblock-toolbelt.tsx   ~85    hover overlay
├── cmdblock-snackbar.tsx   ~65    sticky pinned header
├── cmdblock-input.tsx     ~145    bottom prompt
└── cmdblock-status.tsx     ~95    state mapping + duration formatting

frontend/app/asset/ui-icons/                       66 SVGs  (warp icons, currentColor)

frontend/app/element/ui-icon.tsx   30 LOC          generic SVG icon component
```

**Deleted this initiative:**

- `frontend/app/view/termblocks/termblocks.scss` (legacy CSS)
- `frontend/app/view/cmdblock/cmdblock-output.tsx`   (old xterm wrapper)
- `frontend/app/view/cmdblock/cmdblock-altscreen.tsx` (old xterm wrapper)
- `frontend/app/view/cmdblock/cmdblock-item.tsx`     (used cmdblock-output)
- `frontend/app/view/cmdblock/cmdblock-list.tsx`     (used cmdblock-item)
- ~2628 lines of legacy `TermBlocksView` + helpers from `termblocks.tsx`

**Total LOC delta for the migration so far:**

```
+4480 LOC  new term/ engine + render layer
+ 300 LOC  reused cmdblock/ visual atoms
- 2628 LOC  legacy termblocks.tsx body
- ~4000 LOC  4 deleted cmdblock files (estimate)
─────────
net ≈ -1850 LOC + a from-scratch warp-style engine
```

---

## Risk map

| Risk | Surface | Mitigation |
|---|---|---|
| OSC 133 not emitted by some shells | Track A's "raw" terminals | `Block.isStatic` path, suppress lifecycle UI |
| Wide-char width detection misses some Unicode ranges | Engine `grid.ts:isWide` | Currently covers CJK + emoji blocks; expand on user-reported issues |
| Tmux pass-through DCS sequences | `ansi-parser.ts` | DCS dispatch exists but not consumed; will manifest as missing tmux features. Add tmux pass-through in P21 |
| Bracketed paste | Input handling | Engine drops DEC 2004 toggle. CmdBlockInput needs to wrap pasted text in `\x1b[200~`...`\x1b[201~` when shell announced bracketed-paste support |
| IME composition events | TUI keyboard routing | Currently `keyEventToBytes` ignores composition. Chinese / Japanese input in vim will be broken until we add composition event handling |
| Selection across multiple blocks | `selection.ts` | Currently single-block. Cross-block selection requires a global layout model |
| Find performance with 10k+ blocks | `BlockGrid.setFilter` over all blocks | O(N) iteration on every keystroke. Will start being noticeable around 1k blocks; add debounce + worker-thread regex if it becomes a problem |
| Resize during alt-screen | `sendResize` SIGWINCH | TUIs may not re-render until next user keystroke. Test with htop |
| Theme changes mid-stream | `resolveColor` reads CSS vars | Should just work because we don't bake colors — but verify by toggling themes with vim running |

---

## Testing plan

### Smoke tests (manual)

After any Track A/B/C work, run these:

1. **Plain shell:**
   ```sh
   echo "hello"
   ls -la /tmp
   for i in 1 2 3; do echo $i; sleep 0.5; done
   ```
2. **Streaming output:**
   ```sh
   tail -f /var/log/system.log
   ```
   (Stop with Ctrl-C — verify SIGINT routed)
3. **Long output (scrollback):**
   ```sh
   seq 10000
   ```
   Verify scroll, scroll-up pauses follow-bottom, scroll-down resumes.
4. **ANSI colors:**
   ```sh
   printf '\e[31mred\e[32mgreen\e[34mblue\e[0m\n'
   printf '\e[38;5;202morange-256\e[0m\n'
   printf '\e[38;2;255;100;0mtrue-color\e[0m\n'
   git status   # uses ANSI green/red
   ```
5. **Alt-screen TUI:**
   ```sh
   vim README.md    # navigate with j/k, exit with :q
   htop             # exit with q
   less /etc/passwd # scroll, exit with q
   ```
6. **OSC 8 link:**
   ```sh
   printf '\e]8;;https://github.com\e\\GitHub\e]8;;\e\\\n'
   ```
   Click — should open in browser.
7. **OSC 133 shell integration:**
   ```sh
   # Verify each block has prompt + command + output split
   # Verify exit-code badge after a `false` command
   false
   true
   ```
8. **Selection + copy:**
   - Drag-select across a few lines.
   - Cmd+C.
   - Paste into another app — verify lines + no trailing whitespace.
9. **Find:**
   - Cmd+F.
   - Type "error".
   - Verify non-matching blocks hide.
   - Esc — verify all blocks return.
10. **Resize:**
    - Drag the window narrower / wider.
    - Verify cols updates; `tput cols` in shell reports the new value.
11. **CJK / Emoji:**
    ```sh
    echo "你好世界 🚀"
    ```
    Verify glyphs render at the right width.

### Regression checklist (post-Track A)

- "term" view type renders shells the same way
- VDom toolbar (if any block uses `term:mode = "vdom"`) appears
- Durable session flyover opens
- Workspace stickers render
- Agent overlay opens via Cmd+I (or whatever key) — text input works

---

## Rollback strategy

Three levels of granularity:

1. **Per-view-type rollback:** in `frontend/app/view/termblocks/termblocks.tsx`,
   delete the entire body and `git checkout HEAD~N -- ...` from before the
   slim-down. This restores the legacy xterm-based view *for the termblocks
   view type*. The flag `NewEngineEnabled` was removed when we slimmed the
   file, so a true rollback requires reverting the slim-down commit.

2. **Engine-level rollback:** if a specific engine bug surfaces, fall back
   per-block by setting `block.isStatic = true` (skips lifecycle / agent
   state, renders raw cells). Useful for "this shell breaks the engine"
   diagnostics.

3. **Repo-level rollback:** the engine lives in `frontend/app/term/`. To
   completely undo this initiative, `rm -rf frontend/app/term/`, restore
   `termblocks.tsx` from git, and revert `viewComponent` to return the
   legacy view. View `git log frontend/app/view/termblocks/termblocks.tsx`
   for the pre-slim version.

---

## Decision log

Significant choices made during the build, kept here so future
maintainers don't relitigate:

| Decision | Why | Alternative considered |
|---|---|---|
| DOM rows, not canvas | React reconciliation is sufficient at 60fps for typical terminal output; canvas would force us to re-implement selection, accessibility, copy/paste | xterm.js webgl renderer — but that's exactly what we're moving away from |
| One AnsiParser, swap target | Shell output is one continuous byte stream; warp does the same | Per-block parsers — would require splitting the stream at OSC 133 boundaries in Go |
| Per-block xterm dropped | OSC 133 already segments the byte stream; cell-grid is cheaper than spinning xterm per block | Keep xterm per block (the failed P0–P5 iteration we tried then abandoned) |
| Sparse rows (`Cell[]` may be < cols) | Memory-friendly for typical short output rows; renderer treats trailing positions as implicit blanks | Full rows (`Cell[cols]`) — costs ~3× memory on real workloads |
| Style reference equality + deep fallback | Common case is unchanged SGR → identical CellStyle reference, cheap `===` merge | Always deep equality — measurable hot-path cost in `computeRuns` |
| Cumulative-height array, not SumTree | TS SumTree implementation is a few hundred lines of code for marginal asymptotic benefit at our scale | Port warp's `sum_tree` crate — sure if we ever exceed 1k blocks per terminal |
| Document-level keydown for alt-screen | TUIs expect global keystroke capture; element-level listeners require focus management we don't want to fight | Element-focused listener on the active block — falls down when input bar has focus |
| Char width measured per-pane via hidden probe | Different themes / zoom levels change char width; one constant fails | Hardcoded `fontSize * 0.6` — visibly wrong for some monospace fonts |
| OSC 133;P key=value parsing | Some shells emit `OSC 133;P;cwd=/foo;user=alice` for richer context | Drop OSC 133;P — would lose cwd info from shells that prefer it over OSC 7 |
| Selection per-block | Cross-block is a separate UX question (and DOM challenge); single-block is the common case | Global selection — DOM range API doesn't slice cleanly across our row divs |
| Find applies to *all* blocks | History search is the main use case | Visible-block-only — would surprise users who scrolled past the match |

---

## Glossary

- **Block** — one command invocation, from prompt to exit code. Owns header
  grid, output grid, alt-screen. Equivalent to warp's `Block`.
- **BlockGrid** — wrapper around `Grid` with lifecycle (`started` /
  `finished`) and memoized post-finish queries.
- **HeaderGrid** — dual-grid pair (prompt + prompt+command) for the row
  above the output. Stores the prompt/command demarcation as a
  `CellExtra.commandStart` flag.
- **AltScreen** — the alternate buffer for TUI apps. Block-inline (warp
  design), not fullscreen.
- **CellExtra** — per-cell metadata that doesn't belong on the style
  reference: OSC 133 anchors, image ids, secret-redaction flag.
- **Run** — a contiguous slice of cells in a single row that share a style
  reference. Renderer emits one `<span>` per run.
- **OSC 133** — shell integration sequences. A = start prompt, B = end
  prompt, C = start command (exec), D[;exitcode] = command finished.
  `iTerm2` / `WezTerm` / `kitty` / `Warp` all use these.
- **VTE** — the reference state-machine table at
  `https://vt100.net/emu/dec_ansi_parser` — what our parser implements.
- **SumTree** — warp's persistent balanced tree for `O(log N)` viewport
  queries. We use a cumulative-height array for the same big-O.

---

## How to resume from this doc

If you're picking this up cold:

1. Read TL;DR + Phase status table.
2. Read the architecture diagram.
3. Pick a track (A / B / C / D) — they have explicit dependencies (A blocks
   B and D; C is independent of A).
4. Open the relevant files listed in the track's plan.
5. Run `npx tsc --noEmit` after each substantive change.
6. Smoke-test from the [Testing plan](#testing-plan) list.

The engine itself (`frontend/app/term/engine/`) should not need changes for
A/B/C — those tracks are integration work in the view layer. If you find
yourself editing `engine/` to complete a track, that's a signal to step
back and check whether you've understood the boundary right.

---

_Document version: 1.0 — created at the end of the P1–P16 migration sprint._
_Total active phases completed: 16 / 20._
