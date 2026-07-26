# Pi-Style Package Extraction Design

## Purpose

Crest carries in-tree copies of pi-mono code: `emain/ai` is pi-ai v0.75.5 and
`emain/agent/harness` is pi-agent-core, with the rest of `emain/agent` playing the role of
pi-coding-agent. Today all three layers live under `emain/`, which makes two things harder
than they should be:

1. **Reuse outside Electron.** Eval, training, and any future CLI must import from inside the
   Electron main-process tree, and nothing structurally prevents agent code from growing
   Electron dependencies.
2. **Upstream sync.** The mapping between crest directories and pi-mono packages is implicit,
   so diffing against upstream (local checkout at `~/Documents/pi-reference`) is manual
   archaeology instead of a mechanical per-package diff.

This design extracts the three layers into npm workspace packages that mirror pi-mono's
package layout. It is deliberately **not** a whole-repo monorepo conversion: `frontend/`,
`pkg/` (Go), and `tsunami/` are untouched. Crest ships one product; the only code with a
second consumer is the agent stack.

## Scope

In scope:

- Create `packages/ai`, `packages/agent`, `packages/coding-agent` and move the corresponding
  trees out of `emain/`.
- Fix the four coupling points (listed below) so packages have zero imports of `electron`,
  `emain/`, or `frontend/`.
- Build/test wiring: workspace resolution, tsconfig include, watch ignores, vitest slim config.
- A boundary check that enforces package purity constructively.
- Per-package upstream-sync metadata (source package, last-synced version, known deviations).

Out of scope:

- Splitting `frontend/` into packages, or any `apps/` restructure.
- Publishing packages to a registry (layout allows it later; nothing depends on it).
- Go-side module changes.
- Injecting a config-home resolver into `sessions.ts` (env-var driven today, works outside
  Electron as-is; noted as a follow-up).

## Package Layout

```
packages/
  ai/            @crest/ai            <- emain/ai (minus models-dev-overlay.ts)
  agent/         @crest/agent         <- emain/agent/{index,node,types,agent,agent-loop,proxy}.ts
                                          + emain/agent/harness/   (pi-agent-core copy)
  coding-agent/  @crest/coding-agent  <- emain/agent rest (tools, system prompt, sessions,
                                                           permissions, commands, context,
                                                           change-review, observability, eval)
```

Dependency direction is strictly one-way: `coding-agent -> agent -> ai`, matching pi-mono.
Internal file layout of each package mirrors the corresponding pi-mono package so upstream
sync is a mechanical diff.

**Boundary refinement (planning-stage finding):** the original draft put only `harness/`
into `packages/agent`. Verification against upstream (pi-reference updated to v0.82.1 on
2026-07-26) showed `emain/agent/index.ts` is a line-for-line copy of pi's
`packages/agent/src/index.ts`, and the six top-level units (`index.ts`, `node.ts`,
`types.ts`, `agent.ts`, `agent-loop.ts`, `proxy.ts`) are pi-agent-core files. Moving
`harness/` alone would also break: `harness/agent-harness.ts` imports `../agent-loop`. So
all six move together with `harness/` — this is exactly upstream's `src/` file set, and it
subsumes the earlier "sink AgentMessage/ThinkingLevel" idea (the whole `types.ts` is
pi-agent-core and moves as a unit).

## Boundary Decisions

Audit result: exactly three files carry all Electron/frontend coupling, plus one re-export
line that spreads it.

| Coupling point | Decision |
| --- | --- |
| `emain/agent/tools/_pty-rpc.ts`, `_pty-screen.ts` (import `ElectronWshClient`, frontend `RpcApi`, lazy `emain-web`/`emain-tabview`) | Stay in Electron land. Move to `emain/agent-tools/` together with `pty-read`, `pty-write`, `pty-transfer`, and `spawn-cli-agent`. These are host-provided tools, injected into coding-agent via the existing tool-injection parameters. |
| `emain/agent/tools/index.ts:33` static re-export of `spawn-cli-agent` | Delete the re-export. This alone makes `tools/` and `eval/` import-clean. |
| `cli-subagent-factory.ts` imports three pty tool factories | Change signature to accept the pty tools as an `AgentTool[]` parameter; the file itself is pure and moves into `packages/coding-agent`. |
| `emain/ai/models-dev-overlay.ts` (transitively Electron- and frontend-coupled via `emain-platform`) | Moves to `emain/models-dev-overlay.ts` (the `emain/ai` directory goes away). It is not exported from the `ai` barrel; its only consumers are `emain/emain.ts` and `emain/aiconfig/`, which repoint. It imports nothing from ai internals (only `fs`, `path`, `../emain-platform`), so the move is a one-line import fix. |
| Harness upward dependency: `harness/**` imports `AgentMessage`/`ThinkingLevel` from `agent/types.ts` (a layering inversion and a deviation from pi upstream) | Resolved by the boundary refinement above: `types.ts` moves into `packages/agent` whole, so the harness's `../../types` relative imports keep resolving in-package unchanged. Coding-agent-side relative imports into agent-core files (`../types`, `./harness/...`, `./node`, ...) are rewritten mechanically to `@crest/agent/...` — no re-export shim files. |
| `agent-event-routing.ts` (zero imports, but semantically IPC payload shaping; sole consumer is `agent-ipc.ts`) | Stays in `emain/`. |
| Execution-stage finding: `harness/types.ts` imported `ContextProjectionReport` from `agent/context/types.ts` (crest's cross-session context feature leaked an upward dep into the harness), and `harness/session/sqlite-storage.test.ts` imported `context/journal` | Dependency inverted, not repointed: the 7-type projection-report closure (`ContextSourceKind`, `ContextDeliveryScope`, `ContextRepresentation`, `ContextRenderedRepresentation`, `ContextCountAccuracy`, `ContextProjectionItemReport`, `ContextProjectionReport`) sinks into `packages/agent/harness/types.ts` as a documented crest-local extension; the coding-agent `context/types.ts` re-exports them so downstream imports are unchanged. The cross-layer sqlite/journal interchange test relocates to the coding-agent side (same precedent as `sessions.test.ts`). Rationale: repointing at `context/` would have created a circular `agent ⇄ coding-agent` package dependency. |

`_spike.ts` (dev script, not in any build graph) moves with `packages/coding-agent`.

## Module Resolution

Preferred mechanism: real workspace packages imported by name (`@crest/agent`), with each
`package.json` `exports` pointing directly at TypeScript source. No per-package build step:
the Electron main bundle already inlines everything (`externalizeDeps: false`), and vitest
resolves through the same pipeline.

Workspace-source-import has no working precedent in this repo (the existing
`tsunami/frontend` workspace entry is used only for dependency hoisting), so the
implementation plan starts with a ~30-minute spike proving the electron-vite main build and
vitest both resolve a source-exporting workspace package.

Fallback if the spike fails: tsconfig `paths` aliases (`@crest/ai` -> `packages/ai/index.ts`
etc.), which the repo's existing `tsconfigPaths()` plugin setup already proves out. The only
loss is by-name publishability, which is out of scope anyway. Exactly one mechanism is used;
never both, to avoid duplicate module instances.

Some consumers bypass the ai barrel today (`emain/aiconfig/list-provider-models.ts` imports
`../ai/models` directly, and `models-dev-overlay.ts` uses ai internals). Package `exports`
therefore include a wildcard subpath entry so deep imports like `@crest/ai/models` resolve;
rewriting them to the barrel is optional cleanup, not a migration requirement.

Supporting wiring in either case:

- Root `tsconfig.json` `include` gains `packages/**/*` (packages are otherwise invisible to
  typecheck).
- `electron.vite.config.ts` renderer `server.watch.ignored` gains `**/packages/**` (it
  currently ignores `**/emain/**` only).
- `vitest.slim.config.ts` `include` gains `packages/**/*.test.ts`. The main
  `vitest.config.ts` needs no change: its default glob discovers package tests.

## Upstream Sync

- Each package keeps `LICENSE.pi` at its root.
- Each package README records: the upstream pi-mono package it mirrors, the last-synced
  upstream version (ai already documents v0.75.5), and the known-deviations list (pi-tui
  stripped, providers removed, crest-specific extensions).
- Sync workflow: diff the package against the matching package in `~/Documents/pi-reference`,
  port hunks, update the version line.

## Landing Strategy

One PR, structured as:

1. Whole-tree `git mv` (intra-package relative imports survive unchanged; history preserved).
2. Cross-boundary import rewrites — the full set is small and known:
   - ~30 imports in `emain/agent-ipc.ts`, 4 in `emain/agent-observability-ipc.ts`;
   - `../ai` / `../../ai` style imports inside moved agent code -> `@crest/ai` (~22 sites);
   - `emain/aiconfig/list-provider-models.ts` (3 imports) and `emain/aiconfig/user-config.test.ts`;
   - two frontend test files importing observability types from `emain/agent/observability/`;
   - `emain/emain.ts` keeps importing `models-dev-overlay` from its unmoved location.
3. Boundary fixes from the table above (pty extraction, barrel line, factory parameter,
   types sink).

**Sequencing risk:** active worktrees (`agent-architecture-refactor`,
`agent-extension-integration`, `crest-agent-pi-alignment`) all touch agent code. Land or
abandon those branches before this PR merges; rebasing them across a tree move means
per-file rename conflicts.

## Testing and Acceptance

- The 37 existing test files under `emain/agent` move with their packages and must stay
  green — that is the migration-is-lossless check.
- New constructive boundary check: a test (or eslint `no-restricted-imports` rule) asserting
  no file under `packages/**` imports `electron`, `emain/`, or `frontend/` (`@/`).
- Reuse acceptance: `eval/run-regression.ts` runs to completion under `tsx` with no Electron
  process, using injected default tools (possible once the tools barrel no longer drags in
  `emain-wsh`).
