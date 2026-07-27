# Pi-Style Package Extraction — Progress / Handoff

> Live status for executing `docs/superpowers/plans/2026-07-26-pi-style-packages.md`
> (spec: `docs/superpowers/specs/2026-07-26-pi-style-packages-design.md`).
> Updated after every task; safe to resume from any checkpoint.

## Where the work happens

- **Worktree:** `/Users/bytedance/Documents/crest/.worktrees/pi-style-packages`
  (main checkout is occupied by the `feat/terax-terminal-port` workstream — do NOT switch
  its branch; all pi-style-packages work stays in this worktree)
- **Branch:** `pi-style-packages`, tracks `origin/pi-style-packages`, pushed after every task
- **Branched from:** `main` @ `dfd1299e`
- **Execution mode:** subagent-driven (implementer → spec review → quality review per task)

## Baselines (recorded before any change, in this worktree)

- `npx tsc --noEmit`: **69 pre-existing errors** (frontend/preview, ai-resolver, emain-window,
  wave.ts, ...). Gate for every task = **no NEW errors**, not zero errors.
  Full list: scratchpad `tsc-baseline.txt` (regenerate: `npx tsc --noEmit | grep "error TS" | sort`).
- `npx vitest run emain`: 435 tests pass; **7 test files fail at collection** (pre-existing):
  `agent-ipc`, `agent/harness/session/batch-storage`, `agent/harness/session/sqlite-storage`,
  `agent/observability/sqlite-trace-store`, `agent/sessions`, `agent/skills-loader`,
  `aiconfig/list-provider-models`. Several of these move into `packages/` during extraction —
  they may keep failing for the same root cause (transitive electron import at collection);
  the gate is no NEW failing files (track the moved files under their new paths).
- `npm run build:dev`: not yet run at baseline (checked per task from Task 1 on).

## Task status

| Task | Description | Status | Commit(s) | Pushed |
| --- | --- | --- | --- | --- |
| 0 | Branch + worktree + baselines + this doc | ✅ done | (this commit) | ✅ |
| 1 | Spike: workspace source-import (electron-vite / vitest / tsx) | ✅ done | `a6c41086` | ✅ |
| 2 | Move `emain/ai` → `packages/ai` (`@crest/ai`) | ✅ done | `2df3b0df` | ✅ |
| 3 | Move agent-core → `packages/agent` (`@crest/agent`) | ✅ done | `e32d13e4` | ✅ |
| 4 | Pty family → `emain/agent-tools/`, barrel + factory injection | ✅ done | `9c76b1c2` | ✅ |
| 5 | Rest of `emain/agent` → `packages/coding-agent` | ✅ done | `9fe401ac` | ✅ |
| 6 | Boundary test, slim config, Electron-free acceptance | ⬜ | | |

## Task log

### Task 0 (2026-07-26)

- Active worktrees that will hit rename conflicts when rebased over this branch (user decision
  on landing order): `agent-architecture-refactor`, `agent-extension-integration`,
  `crest-agent-pi-alignment-d12267`, `codex/context-overlay`, `codex/phase4a-task6`,
  `codex/workspace-renderer-phase1`.
- pi upstream reference `~/Documents/pi-reference` updated to **v0.82.1** (2026-07-26).
- Deviation from plan text: plan says "tsc exits 0" — actual baseline is 69 pre-existing
  errors; all task gates interpret this as "no new errors" (same for the 7 vitest files).

### Task 1 (2026-07-27)

- **Spike PASSED on all three paths** — workspace packages exporting raw TS source resolve in
  vitest, electron-vite main build (`npm run build:dev`, 2382 modules), and tsx. The
  tsconfig-paths fallback is NOT needed; later tasks proceed with real package.json exports.
- Gotcha for later tasks: `tsx -e` compiles eval snippets as CJS → top-level `await` fails.
  Use promise-chain form (plan Task 6.3 already updated).
- Gotcha: after deleting a workspace dir, `npm install` (and even `--package-lock-only` /
  fresh `.package-lock.json`) does NOT drop the stale "extraneous" lockfile entry; a full
  lockfile regen drags in ~4800 lines of unrelated churn. Surgical hand-edit of the entry
  (validated JSON + stable under reinstall) was the right fix.
- Reviews: spec ❌→fix→✅ (lockfile residue caught and amended in place), quality ✅.

### Task 2 (2026-07-27)

- `@crest/ai` landed: 33 files moved R100 byte-identical, `models-dev-overlay.ts` pulled back
  to `emain/` (one-line import fix), ~52 import + 8 `vi.mock` specifiers rewritten. All gates
  zero-delta vs baseline (69 tsc errors, same 7 vitest collection failures, build green,
  main bundle verified to inline the package).
- **Lesson for Tasks 3/5: `from "..."`-anchored seds miss `vi.mock()` string specifiers.**
  6 instances in this task (5 self-caught, 1 caught by spec review as a latent regression
  masked by a pre-existing collection failure). Also: never reuse `grep -v aiconfig`-style
  exclusions in verification scans — it blinded the implementer's mock scan to a whole dir.
- README accuracy matters: Cloudflare provider is NOT stripped (it's live in 3 providers);
  boundary test phrased as "added later in this extraction" until Task 6 lands.
- Reviews: spec ❌→fix→✅ (stale mocks), quality ✅ approved (2 README facts fixed on its
  recommendation).

### Task 3 (2026-07-27)

- `@crest/agent` landed: 32 R100 renames + 2 authorized content edits. All gates zero-delta
  (69 tsc / 435 tests / same 7 collection failures path-adjusted / build green).
- **Architectural decision made during execution** (also recorded in the spec's boundary
  table): the six-unit set was NOT self-contained — commit `712ea282` (cross-session context
  references) had leaked `ContextProjectionReport` into `harness/types.ts`, and
  `sqlite-storage.test.ts` imported `context/journal`. Repointing would have created a
  circular agent ⇄ coding-agent dependency. Resolution: 7-type projection-report closure
  sunk into `packages/agent/harness/types.ts` (crest-local, documented); coding-agent's
  `context/types.ts` re-exports them; the cross-layer test relocated to
  `emain/agent/sqlite-storage.test.ts` (precedent: sessions.test.ts).
- Two more plan blind spots caught and fixed: `vi.mock("./agent/index")` in agent-ipc.test.ts
  (same vi.mock lesson), and `agent-observability-ipc.test.ts` missing from the plan's
  Step 3.5 file list.
- Reviews: spec ✅ (first pass), quality ✅ approved (minor pre-existing style debt noted only).

### Task 4 (2026-07-27)

- Pty family (11 files) moved to `emain/agent-tools/`; tools barrel is now Electron-free
  (spawn-cli-agent re-export dropped); `buildCliSubagentHarness` takes injected
  `tools: AgentTool[]`. Test-first: factory test proven failing before the interface change.
- Quality review escalated one Important issue beyond the plan: `blockId`/`initialCommand`
  became dead fields in `BuildCliSubagentOptions` and the module header was stale — removed
  now (not deferred), with replacement coverage in spawn-cli-agent.test.ts that
  mutation-sensitively proves blockId/initialCommand still flow via the tool constructors.
- `spawn-cli-agent.ts` still imports the factory via temporary relative path
  `../agent/cli-subagent-factory` — Task 5 rewrites it to `@crest/coding-agent/...`.
- Operational lesson recorded: the shell can silently reset cwd to the main checkout
  (which is on an unrelated branch) — every verification command must `cd` into the
  worktree explicitly; one reviewer also briefly mutated the worktree with a
  `git checkout <base> -- .` and restored it (verified clean afterwards).
- Reviews: spec ✅ (first pass), quality ❌→fix→✅ (dead options + stale header).

### Task 5 (2026-07-27)

- `@crest/coding-agent` landed: 84 files moved (81 R100 byte-identical; 3 retain 94–99%
  similarity after comment-only path corrections), `agent-event-routing` kept in `emain/`,
  and all runtime/test/mock consumers repointed to workspace package exports.
- Package-boundary scans found no imports from `packages/` to Electron, `emain/`, or
  `frontend/`; the old `emain/agent` import tree has no remaining source references.
- Fresh gates: 69 tsc errors (zero count delta); full Vitest 1478/1484 tests passed, with
  all 6 failures confined to 3 files unchanged by Task 5; observability type tests 2/2
  passed; `npm run build:dev` exited 0.
- Two plan omissions are explicitly deferred to Task 6: `.github/workflows/agent-tests.yml`
  still filters on moved paths, and root `NOTICE` still cites the old agent/ai directories
  and license location.
- Reviews: spec ✅ (first pass); quality ✅ after fixing stale usage/reference comments in
  `_spike.ts`, `eval/run-regression.ts`, and `harness-factory.ts`.

## How to resume after an interruption

1. `cd /Users/bytedance/Documents/crest/.worktrees/pi-style-packages`
2. Read the task table above; find the first ⬜ task.
3. Open `docs/superpowers/plans/2026-07-26-pi-style-packages.md` at that task; every step is
   checkbox-tracked with exact commands.
4. Before continuing, re-verify the previous task's gate:
   `npx tsc --noEmit` (compare vs 69-error baseline) + `npx vitest run emain packages` +
   `npm run build:dev`.
5. Push after each completed task: `git push`.
