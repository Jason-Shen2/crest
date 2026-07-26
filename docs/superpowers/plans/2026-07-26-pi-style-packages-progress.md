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
| 2 | Move `emain/ai` → `packages/ai` (`@crest/ai`) | ⬜ | | |
| 3 | Move agent-core → `packages/agent` (`@crest/agent`) | ⬜ | | |
| 4 | Pty family → `emain/agent-tools/`, barrel + factory injection | ⬜ | | |
| 5 | Rest of `emain/agent` → `packages/coding-agent` | ⬜ | | |
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

## How to resume after an interruption

1. `cd /Users/bytedance/Documents/crest/.worktrees/pi-style-packages`
2. Read the task table above; find the first ⬜ task.
3. Open `docs/superpowers/plans/2026-07-26-pi-style-packages.md` at that task; every step is
   checkbox-tracked with exact commands.
4. Before continuing, re-verify the previous task's gate:
   `npx tsc --noEmit` (compare vs 69-error baseline) + `npx vitest run emain packages` +
   `npm run build:dev`.
5. Push after each completed task: `git push`.
