# Pi-Style Package Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `emain/ai` and `emain/agent` into three npm workspace packages (`@crest/ai`, `@crest/agent`, `@crest/coding-agent`) mirroring pi-mono, with zero Electron/frontend imports inside packages.

**Architecture:** Whole-tree `git mv` moves (intra-package relative imports survive unchanged), mechanical sed rewrites for cross-boundary imports, workspace packages exporting TS source directly (no build step — electron-vite bundles the main process fully). The three Electron-coupled pty tool files plus `models-dev-overlay.ts` stay in `emain/`.

**Tech Stack:** npm workspaces, electron-vite, vitest, tsx. Spec: `docs/superpowers/specs/2026-07-26-pi-style-packages-design.md`.

**Key facts (verified 2026-07-26):**

- All Electron/frontend coupling in the two trees lives in exactly 3 files: `emain/agent/tools/_pty-rpc.ts`, `emain/agent/tools/_pty-screen.ts` (both import `@/app/store/wshclientapi` + `../../emain-wsh`), and `emain/ai/models-dev-overlay.ts` (imports `../emain-platform`; nothing from ai internals).
- `emain/agent/tools/index.ts:34` (`export { createSpawnCliAgentTool } from "./spawn-cli-agent";`) spreads the pty coupling into the tools barrel.
- `emain/agent/index.ts` is a line-for-line copy of pi's `packages/agent/src/index.ts`. Agent-core = `{index,node,types,agent,agent-loop,proxy}.ts` + `harness/`.
- `harness/agent-harness.ts:9` imports `../agent-loop`; `harness/**` imports `../../types` — both stay valid relative paths once agent-core moves as one unit.
- `emain/agent/context/types.ts` and `emain/agent/commands/types.ts` exist — seds that rewrite `"./types"` must ONLY run on `emain/agent/*.ts` (depth 1), never inside subdirectories.
- Upstream reference: `~/Documents/pi-reference` at v0.82.1 (packages: agent, ai, coding-agent, evals, server, storage, tui).
- macOS sed: use `sed -i '' -E`. Run all commands from the repo root `/Users/bytedance/Documents/crest`.

---

### Task 0: Branch and preflight baseline

**Files:** none created.

- [ ] **Step 0.1: Check for active worktrees touching agent code**

Run: `git worktree list`

If worktrees like `agent-architecture-refactor`, `agent-extension-integration`, or `crest-agent-pi-alignment` are still active, note them in the final report: they will hit per-file rename conflicts when rebased across this change. This is informational — do not block.

- [ ] **Step 0.2: Create the feature branch**

```bash
git checkout -b pi-style-packages
```

- [ ] **Step 0.3: Record the typecheck + test baseline**

```bash
npx tsc --noEmit
npx vitest run emain 2>&1 | tail -5
```

Expected: tsc exits 0. Record any pre-existing vitest failures — later tasks must not add new ones (compare against this list, don't chase pre-existing reds).

---

### Task 1: Spike — workspace source-import resolution

Proves electron-vite (main build), vitest, and tsx can all resolve a workspace package whose `exports` point at raw TS source. ~30 min. This mechanism has no precedent in this repo (`tsunami/frontend` is hoisting-only).

**Files:**
- Modify: `package.json` (workspaces field, line ~173)
- Create (temporary): `packages/spike/package.json`, `packages/spike/index.ts`, `emain/spike-workspace.test.ts`
- Modify (temporarily): `emain/emain.ts`

- [ ] **Step 1.1: Add packages/* to workspaces**

In `package.json` change:

```json
    "workspaces": [
        "tsunami/frontend"
    ]
```

to:

```json
    "workspaces": [
        "tsunami/frontend",
        "packages/*"
    ]
```

- [ ] **Step 1.2: Create the spike package**

`packages/spike/package.json`:

```json
{
    "name": "@crest/spike",
    "version": "0.0.0",
    "private": true,
    "type": "module",
    "exports": {
        ".": "./index.ts"
    }
}
```

`packages/spike/index.ts`:

```ts
export const SPIKE_OK = true;
```

- [ ] **Step 1.3: Link the workspace**

Run: `npm install`
Expected: exits 0; `ls -l node_modules/@crest/spike` shows a symlink to `../../packages/spike`.

- [ ] **Step 1.4: Prove vitest resolution**

`emain/spike-workspace.test.ts`:

```ts
import { SPIKE_OK } from "@crest/spike";
import { describe, expect, it } from "vitest";

describe("workspace source import", () => {
    it("resolves @crest/spike from TS source", () => {
        expect(SPIKE_OK).toBe(true);
    });
});
```

Run: `npx vitest run emain/spike-workspace.test.ts`
Expected: 1 passed.

- [ ] **Step 1.5: Prove electron-vite main-build resolution**

Add these two lines to the top of the import block in `emain/emain.ts` (temporary):

```ts
import { SPIKE_OK } from "@crest/spike";
void SPIKE_OK;
```

Run: `npm run build:dev`
Expected: build exits 0 (a resolution failure would error out the main bundle).

- [ ] **Step 1.6: Prove tsx (Electron-free runtime) resolution**

```bash
npx tsx -e 'const m = await import("@crest/spike"); console.log("spike:", m.SPIKE_OK)'
```

Expected output: `spike: true`

- [ ] **Step 1.7: Clean up spike artifacts**

Remove the two temporary lines from `emain/emain.ts`. Delete `emain/spike-workspace.test.ts` and `packages/spike/`. Run `npm install` again to drop the spike from the lockfile. Keep the `workspaces` change.

- [ ] **Step 1.8: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add packages/* npm workspaces entry"
```

**FALLBACK (only if 1.4/1.5/1.6 fails):** skip per-package `package.json` resolution and instead add to `tsconfig.json` `paths` (the repo-proven `tsconfigPaths()` mechanism — resolves in electron-vite, vitest, and tsx via `--tsconfig`):

```json
"@crest/ai": ["packages/ai/index.ts"],
"@crest/ai/*": ["packages/ai/*"],
"@crest/agent": ["packages/agent/index.ts"],
"@crest/agent/*": ["packages/agent/*"],
"@crest/coding-agent/tools": ["packages/coding-agent/tools/index.ts"],
"@crest/coding-agent/*": ["packages/coding-agent/*"]
```

Import specifiers in all later tasks are spelled identically, so the rest of this plan is unchanged either way. Record which mechanism won in the task report.

---

### Task 2: Move emain/ai → packages/ai

**Files:**
- Move: `emain/ai/` → `packages/ai/` (whole tree), then `packages/ai/models-dev-overlay.ts` → `emain/models-dev-overlay.ts`
- Create: `packages/ai/package.json`, `packages/ai/LICENSE.pi`, `packages/ai/README.md`
- Modify: `emain/models-dev-overlay.ts`, `emain/agent/**` (ai import sed), `emain/agent-ipc.ts`, `emain/agent-ipc.test.ts`, `emain/emain.ts`, `emain/aiconfig/list-provider-models.ts`, `tsconfig.json`, `electron.vite.config.ts`

- [ ] **Step 2.1: Move the tree, pull the overlay back out**

```bash
git mv emain/ai packages/ai
git mv packages/ai/models-dev-overlay.ts emain/models-dev-overlay.ts
```

- [ ] **Step 2.2: Fix the overlay's one relative import**

In `emain/models-dev-overlay.ts` change:

```ts
import { getWaveDataDir } from "../emain-platform";
```

to:

```ts
import { getWaveDataDir } from "./emain-platform";
```

- [ ] **Step 2.3: Create package metadata**

`packages/ai/package.json`:

```json
{
    "name": "@crest/ai",
    "version": "0.0.0",
    "private": true,
    "type": "module",
    "description": "crest's integrated AI client, started from @earendil-works/pi-ai v0.75.5",
    "exports": {
        ".": "./index.ts",
        "./*": "./*.ts"
    }
}
```

```bash
cp emain/agent/LICENSE.pi packages/ai/LICENSE.pi
```

`packages/ai/README.md`:

```markdown
# @crest/ai

In-tree fork of [`@earendil-works/pi-ai`](https://github.com/badlogic/pi-mono), started
from **v0.75.5**. Exports TypeScript source directly; the app bundle inlines it.

Upstream mapping: `pi-mono/packages/ai`. Sync by diffing against
`~/Documents/pi-reference/packages/ai` (last checked upstream: v0.82.1).

Known deviations from upstream:

- Image generation, Bedrock, Vertex, Azure, Codex, Mistral, Cloudflare, and Faux
  providers are stripped — re-add by copying back from upstream.
- `models-dev-overlay.ts` is crest-only and lives in `emain/` (Electron-coupled).

Boundary rule: nothing in this package may import `electron`, `emain/`, or `frontend/`
(enforced by `packages/boundary.test.ts`).
```

Run: `npm install` (links `node_modules/@crest/ai`).

- [ ] **Step 2.4: Rewrite ai imports inside emain/agent (all depths, harness included)**

```bash
find emain/agent -name "*.ts" -exec sed -i '' -E \
  -e 's|from "(\.\./)+ai"|from "@crest/ai"|g' \
  -e 's|from "(\.\./)+ai/|from "@crest/ai/|g' {} +
```

(The trailing `"` / `/` anchors keep `../aiconfig` safe — nothing under `emain/agent` imports it anyway.)

- [ ] **Step 2.5: Rewrite the remaining emain consumers**

```bash
sed -i '' -e 's|from "\./ai"|from "@crest/ai"|g' emain/agent-ipc.ts emain/agent-ipc.test.ts
sed -i '' -e 's|from "\./ai/models-dev-overlay"|from "./models-dev-overlay"|' emain/emain.ts
sed -i '' -E \
  -e 's|from "\.\./ai/models-dev-overlay"|from "../models-dev-overlay"|' \
  -e 's|from "\.\./ai/|from "@crest/ai/|g' emain/aiconfig/list-provider-models.ts
```

(Order matters in the last command: the overlay line must rewrite before the generic `../ai/` rule.)

- [ ] **Step 2.6: Wire packages into typecheck and dev-server ignores**

In `tsconfig.json` line 2 change:

```json
    "include": ["frontend/**/*", "emain/**/*"],
```

to:

```json
    "include": ["frontend/**/*", "emain/**/*", "packages/**/*"],
```

In `electron.vite.config.ts` (renderer `server.watch.ignored` array, ~line 210) insert after `"dist/**",`:

```ts
                    "**/packages/**",
```

- [ ] **Step 2.7: Verify no stale references, typecheck, test, build**

```bash
grep -rn '"\.\.*/ai"\|"\.\.*/ai/' emain --include="*.ts" | grep -v aiconfig
npx tsc --noEmit
npx vitest run packages/ai emain 2>&1 | tail -5
npm run build:dev
```

Expected: grep prints nothing; tsc exits 0; vitest matches the Task 0 baseline (no new failures); build exits 0.

- [ ] **Step 2.8: Commit**

```bash
git add -A
git commit -m "refactor: extract emain/ai into @crest/ai workspace package"
```

---

### Task 3: Move agent-core → packages/agent

**Files:**
- Move: `emain/agent/{index.ts,node.ts,types.ts,agent.ts,agent-loop.ts,proxy.ts,harness/}` → `packages/agent/`
- Create: `packages/agent/package.json`, `packages/agent/LICENSE.pi`, `packages/agent/README.md`
- Modify: remaining `emain/agent/**` (sed), `emain/agent-ipc.ts`, `emain/agent-ipc.test.ts`, `emain/agent-observability-ipc.ts`

- [ ] **Step 3.1: Move the six agent-core units as one commit-unit**

```bash
mkdir -p packages/agent
git mv emain/agent/index.ts emain/agent/node.ts emain/agent/types.ts \
       emain/agent/agent.ts emain/agent/agent-loop.ts emain/agent/proxy.ts \
       emain/agent/harness packages/agent/
```

Intra-package relative paths (`harness/agent-harness.ts` → `../agent-loop`, `harness/compaction/*` → `../../types`, `node.ts` → `./harness/env/nodejs` and `./index`, the `declare module "../types"` augmentation in `harness/messages.ts`) all still resolve — that is the point of moving the exact pi `src/` file set together.

- [ ] **Step 3.2: Create package metadata**

`packages/agent/package.json`:

```json
{
    "name": "@crest/agent",
    "version": "0.0.0",
    "private": true,
    "type": "module",
    "description": "crest's agent core + harness, an in-tree fork of @earendil-works/pi-agent-core",
    "exports": {
        ".": "./index.ts",
        "./*": "./*.ts"
    }
}
```

```bash
cp emain/agent/LICENSE.pi packages/agent/LICENSE.pi
```

`packages/agent/README.md`:

```markdown
# @crest/agent

In-tree fork of [`@earendil-works/pi-agent-core`](https://github.com/badlogic/pi-mono)
(pi-mono `packages/agent`). The file set mirrors upstream `src/`: `index.ts`, `node.ts`,
`types.ts`, `agent.ts`, `agent-loop.ts`, `proxy.ts`, `harness/`.

Sync by diffing against `~/Documents/pi-reference/packages/agent/src` (last checked
upstream: v0.82.1). The last full upstream sync predates this extraction — the next sync
should start from that diff.

Known deviations from upstream:

- No `stream-fn.ts`; no `harness/tools/` (crest's tools live in `@crest/coding-agent`).
- Crest adds SQLite session storage (`harness/session/sqlite-*`).
- `harness/messages.ts` augments `../types` CustomAgentMessages with crest message kinds.

Boundary rule: nothing in this package may import `electron`, `emain/`, or `frontend/`
(enforced by `packages/boundary.test.ts`).
```

Run: `npm install`.

- [ ] **Step 3.3: Rewrite agent-core imports in the remaining emain/agent top-level files (depth 1 ONLY)**

```bash
find emain/agent -maxdepth 1 -name "*.ts" -exec sed -i '' -E \
  -e 's|from "\./harness/|from "@crest/agent/harness/|g' \
  -e 's|from "\./types"|from "@crest/agent/types"|g' \
  -e 's|from "\./node"|from "@crest/agent/node"|g' \
  -e 's|from "\./agent-loop"|from "@crest/agent/agent-loop"|g' \
  -e 's|from "\./agent"|from "@crest/agent/agent"|g' \
  -e 's|from "\./proxy"|from "@crest/agent/proxy"|g' \
  -e 's|from "\./index"|from "@crest/agent"|g' {} +
```

- [ ] **Step 3.4: Rewrite agent-core imports in emain/agent subdirectories (depth 2+)**

The one-deep dirs are `tools/ commands/ context/ change-review/ observability/ eval/`. Their local `./types` files must NOT be touched — these seds only match `../`-prefixed specifiers:

```bash
find emain/agent -mindepth 2 -name "*.ts" -exec sed -i '' -E \
  -e 's|from "\.\./harness/|from "@crest/agent/harness/|g' \
  -e 's|from "\.\./types"|from "@crest/agent/types"|g' \
  -e 's|from "\.\./node"|from "@crest/agent/node"|g' \
  -e 's|from "\.\./agent-loop"|from "@crest/agent/agent-loop"|g' \
  -e 's|from "\.\./proxy"|from "@crest/agent/proxy"|g' \
  -e 's|from "\.\./index"|from "@crest/agent"|g' {} +
```

- [ ] **Step 3.5: Rewrite the emain-level consumers**

```bash
sed -i '' -E \
  -e 's|from "\./agent/harness/|from "@crest/agent/harness/|g' \
  -e 's|from "\./agent/types"|from "@crest/agent/types"|g' \
  emain/agent-ipc.ts emain/agent-ipc.test.ts emain/agent-observability-ipc.ts
```

- [ ] **Step 3.6: Verify, typecheck, test, build**

```bash
grep -rnE 'from "\.\.?/(harness/|types"|node"|agent"|agent-loop"|proxy"|index")' emain --include="*.ts" | grep -v '/context/\|/commands/\|/tools/'
npx tsc --noEmit
npx vitest run packages emain 2>&1 | tail -5
npm run build:dev
```

Expected: grep prints nothing (subdir-local `./types` hits are excluded by the `grep -v`); tsc 0; no new vitest failures; build 0.

- [ ] **Step 3.7: Commit**

```bash
git add -A
git commit -m "refactor: extract agent core into @crest/agent workspace package"
```

---

### Task 4: Pull the pty tool family into emain/agent-tools, fix barrel + factory

**Files:**
- Move: 11 files from `emain/agent/tools/` → `emain/agent-tools/`
- Modify: `emain/agent/tools/index.ts`, `emain/agent/cli-subagent-factory.ts`, `emain/agent/cli-subagent-factory.test.ts`, `emain/agent-tools/{_pty-rpc.ts,_pty-screen.ts,spawn-cli-agent.ts}` + their tests, `emain/agent-ipc.ts`

- [ ] **Step 4.1: Drop the pty re-export from the tools barrel**

In `emain/agent/tools/index.ts` delete this line (line 34):

```ts
export { createSpawnCliAgentTool } from "./spawn-cli-agent";
```

Then clean `emain/agent/tools/tools.test.ts`: delete its `vi.mock("../../emain-wsh", ...)` block (it existed only because the barrel used to drag in the pty transport) and remove any assertion that references `createSpawnCliAgentTool` or the `spawn_cli_agent` tool — that tool is host-provided now and no longer part of this barrel.

Run: `npx vitest run emain/agent/tools/tools.test.ts`
Expected: PASS.

- [ ] **Step 4.2: Update the factory test to injected tools (test-first)**

In `emain/agent/cli-subagent-factory.test.ts`: remove any imports of `./tools/pty-read`, `./tools/pty-write`, `./tools/pty-transfer`, add a stub helper, and pass stubs at every `buildCliSubagentHarness(...)` call site as a new `tools` option:

```ts
import { Type } from "typebox";
import type { AgentTool } from "@crest/agent/types";

function makeStubPtyTool(name: string): AgentTool {
    return {
        name,
        label: name,
        description: `stub ${name}`,
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "stub" }], details: undefined }),
    };
}

const stubTools = [makeStubPtyTool("pty_write"), makeStubPtyTool("pty_read"), makeStubPtyTool("pty_transfer_to_user")];
```

Call sites become `buildCliSubagentHarness({ ...existing options..., tools: stubTools })`. If a test asserted on real pty tool names/order, assert against `stubTools` instead.

Run: `npx vitest run emain/agent/cli-subagent-factory.test.ts`
Expected: FAIL (factory doesn't accept `tools` yet).

- [ ] **Step 4.3: Change the factory to accept injected tools**

In `emain/agent/cli-subagent-factory.ts`: delete the three imports of `./tools/pty-read`, `./tools/pty-transfer`, `./tools/pty-write`; add `tools` to the options; stop building tools internally:

```ts
export interface BuildCliSubagentOptions {
    session: Session;
    model: Model<Api>;
    blockId: string;
    cwd: string;
    initialCommand: string;
    /** The three PTY tools, constructed by the Electron host (emain/agent-tools). */
    tools: AgentTool[];
    getApiKeyAndHeaders?: (
        model: Model<Api>,
    ) => Promise<{ apiKey: string; headers?: Record<string, string> } | undefined>;
}
```

and in `buildCliSubagentHarness` replace the `const tools: AgentTool[] = [...]` block with:

```ts
    const tools = opts.tools;
```

Run: `npx vitest run emain/agent/cli-subagent-factory.test.ts`
Expected: PASS.

- [ ] **Step 4.4: Move the pty family out to emain/agent-tools**

```bash
mkdir -p emain/agent-tools
git mv emain/agent/tools/_pty-rpc.ts emain/agent/tools/_pty-rpc.test.ts \
       emain/agent/tools/_pty-screen.ts \
       emain/agent/tools/pty-read.ts emain/agent/tools/pty-read.test.ts \
       emain/agent/tools/pty-write.ts emain/agent/tools/pty-write.test.ts \
       emain/agent/tools/pty-transfer.ts emain/agent/tools/pty-transfer.test.ts \
       emain/agent/tools/spawn-cli-agent.ts emain/agent/tools/spawn-cli-agent.test.ts \
       emain/agent-tools/
```

- [ ] **Step 4.5: Fix the moved files' emain-relative imports (one level shallower now)**

```bash
sed -i '' -E \
  -e 's|"\.\./\.\./emain-wsh"|"../emain-wsh"|g' \
  -e 's|"\.\./\.\./emain-web"|"../emain-web"|g' \
  -e 's|"\.\./\.\./emain-tabview"|"../emain-tabview"|g' \
  -e 's|from "\.\./cli-subagent-factory"|from "../agent/cli-subagent-factory"|g' \
  emain/agent-tools/*.ts
```

Covers both static imports and the `vi.mock("../../emain-wsh", ...)` strings plus the lazy `await import("../../emain-web")` / `"../../emain-tabview"` in `_pty-screen.ts` (quote-anchored patterns, no `from` prefix). The `../agent/cli-subagent-factory` path is temporary; Task 5 rewrites it to `@crest/coding-agent/cli-subagent-factory`.

- [ ] **Step 4.6: Feed the pty tools into the factory at the spawn call site**

In `emain/agent-tools/spawn-cli-agent.ts`, at the `buildCliSubagentHarness({ ... })` call, add a `tools` entry constructed exactly as the factory used to (add the pty factory imports at top of file — they are now siblings):

```ts
import { createPtyReadTool } from "./pty-read";
import { createPtyTransferTool } from "./pty-transfer";
import { createPtyWriteTool } from "./pty-write";
```

```ts
        tools: [
            createPtyWriteTool(blockId, { initialCommand, cwd }),
            createPtyReadTool(blockId),
            createPtyTransferTool(blockId),
        ],
```

(Use the call site's actual local variable names for `blockId`/`initialCommand`/`cwd` — they were previously forwarded into the factory options; the same values now also feed the tool constructors.)

- [ ] **Step 4.7: Repoint agent-ipc and verify nothing else references the old paths**

```bash
sed -i '' -e 's|from "\./agent/tools/spawn-cli-agent"|from "./agent-tools/spawn-cli-agent"|' emain/agent-ipc.ts
grep -rn 'tools/pty\|tools/spawn-cli-agent\|tools/_pty' emain frontend --include="*.ts" --include="*.tsx" | grep -v agent-tools/
```

Expected: grep prints nothing.

- [ ] **Step 4.8: Typecheck, test, commit**

```bash
npx tsc --noEmit
npx vitest run emain 2>&1 | tail -5
git add -A
git commit -m "refactor: move pty tool family to emain/agent-tools, inject into cli-subagent factory"
```

Expected: tsc 0; no new vitest failures.

---

### Task 5: Move the rest of emain/agent → packages/coding-agent

**Files:**
- Move: `emain/agent/agent-event-routing.ts` + `.test.ts` → `emain/`; then `emain/agent/` → `packages/coding-agent/`
- Create: `packages/coding-agent/package.json`, `packages/coding-agent/README.md`
- Modify: `emain/agent-ipc.ts`, `emain/agent-ipc.test.ts`, `emain/agent-observability-ipc.ts`, `emain/aiconfig/user-config.test.ts`, `emain/agent-tools/spawn-cli-agent.ts` + `.test.ts`, `frontend/app/observability/observability-panel.test.tsx`, `frontend/app/observability/observability-types.test-d.ts`

- [ ] **Step 5.1: Keep the IPC glue in emain**

```bash
git mv emain/agent/agent-event-routing.ts emain/agent-event-routing.ts
git mv emain/agent/agent-event-routing.test.ts emain/agent-event-routing.test.ts
sed -i '' -e 's|from "\./agent/agent-event-routing"|from "./agent-event-routing"|' emain/agent-ipc.ts
```

- [ ] **Step 5.2: Move the remaining tree**

```bash
git mv emain/agent packages/coding-agent
```

`LICENSE.pi` travels with the tree. All imports inside the tree are already either intra-tree relative (unchanged) or `@crest/ai` / `@crest/agent` (rewritten in Tasks 2–3), so the package needs zero internal edits.

- [ ] **Step 5.3: Create package metadata**

`packages/coding-agent/package.json`:

```json
{
    "name": "@crest/coding-agent",
    "version": "0.0.0",
    "private": true,
    "type": "module",
    "description": "crest's coding-agent layer (tools, system prompt, sessions, permissions), mirroring pi's coding-agent role",
    "exports": {
        "./tools": "./tools/index.ts",
        "./*": "./*.ts"
    }
}
```

(No `"."` entry: crest's former `emain/agent/index.ts` barrel belonged to agent-core and moved to `@crest/agent`; consumers use deep subpaths.)

`packages/coding-agent/README.md`:

```markdown
# @crest/coding-agent

Crest's counterpart to pi-mono `packages/coding-agent`: the layer that tells the LLM how
to use tools — tool definitions, system prompt assembly, sessions, permissions, commands,
context management, change review, observability, eval.

Sync by diffing against `~/Documents/pi-reference/packages/coding-agent` (last checked
upstream: v0.82.1). This package deviates from upstream by design:

- pi-tui render layer stripped (crest has its own renderer).
- `find`/`grep` are pure-Node (upstream shells out to fd/ripgrep); `web_fetch` is crest-only.
- The PTY tool family (`pty-read`/`pty-write`/`pty-transfer`/`spawn-cli-agent`) is
  Electron-host-provided and lives in `emain/agent-tools/`, injected via factory options.

Boundary rule: nothing in this package may import `electron`, `emain/`, or `frontend/`
(enforced by `packages/boundary.test.ts`).
```

Run: `npm install`.

- [ ] **Step 5.4: Rewrite all remaining consumers**

```bash
sed -i '' -E \
  -e 's|from "\./agent/|from "@crest/coding-agent/|g' \
  emain/agent-ipc.ts emain/agent-ipc.test.ts emain/agent-observability-ipc.ts
sed -i '' -e 's|from "\.\./agent/context/validation"|from "@crest/coding-agent/context/validation"|' emain/aiconfig/user-config.test.ts
sed -i '' -E -e 's|"\.\./agent/cli-subagent-factory"|"@crest/coding-agent/cli-subagent-factory"|g' emain/agent-tools/*.ts
sed -i '' -E -e 's|from "\.\./\.\./\.\./emain/agent/observability/|from "@crest/coding-agent/observability/|g' \
  frontend/app/observability/observability-panel.test.tsx frontend/app/observability/observability-types.test-d.ts
```

(The first sed's `./agent/` prefix rule also covers `from "./agent/tools"` → `from "@crest/coding-agent/tools"`, which resolves via the explicit `"./tools"` export. This must run AFTER Step 5.1's `agent-event-routing` rewrite, as ordered here.)

- [ ] **Step 5.5: Verify zero references to the old tree remain**

```bash
grep -rn 'emain/agent\b\|"\./agent/\|"\.\./agent/' emain frontend packages --include="*.ts" --include="*.tsx" | grep -v agent-tools | grep -v agent-event-routing | grep -v agent-ipc | grep -v agent-observability
```

Expected: nothing (comments mentioning the old path may remain; only import specifiers matter — if a hit is a comment, leave it).

- [ ] **Step 5.6: Full typecheck, full test run, build**

```bash
npx tsc --noEmit
npx vitest run 2>&1 | tail -8
npm run test:observability-types
npm run build:dev
```

Expected: tsc 0; vitest matches Task 0 baseline (no new failures); the observability typecheck script passes; build 0.

- [ ] **Step 5.7: Commit**

```bash
git add -A
git commit -m "refactor: extract coding-agent layer into @crest/coding-agent workspace package"
```

---

### Task 6: Boundary enforcement, slim config, Electron-free acceptance

**Files:**
- Create: `packages/boundary.test.ts`
- Modify: `vitest.slim.config.ts`

- [ ] **Step 6.1: Write the boundary test (write it first; it should already pass — it's a regression fence)**

`packages/boundary.test.ts`:

```ts
// Constructive boundary check for the pi-style packages: nothing under
// packages/ may depend on Electron, the Electron main process (emain/),
// or the renderer (frontend/, "@/"). See
// docs/superpowers/specs/2026-07-26-pi-style-packages-design.md.
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PackagesRoot = path.dirname(fileURLToPath(import.meta.url));

const ForbiddenSpecifier = /^(electron$|@\/|.*\/emain\/|.*\/emain-|.*\/frontend\/)/;
const ImportSpecifierRe = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;

function collectTsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectTsFiles(full, out);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
            out.push(full);
        }
    }
    return out;
}

describe("package boundary", () => {
    it("packages never import electron, emain, or frontend", () => {
        const offenders: string[] = [];
        for (const file of collectTsFiles(PackagesRoot)) {
            const src = readFileSync(file, "utf8");
            for (const match of src.matchAll(ImportSpecifierRe)) {
                if (ForbiddenSpecifier.test(match[1])) {
                    offenders.push(`${path.relative(PackagesRoot, file)} -> ${match[1]}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
```

Run: `npx vitest run packages/boundary.test.ts`
Expected: PASS. (If it fails, a rewrite in Tasks 2–5 was missed — fix the offending import, do not weaken the test.)

- [ ] **Step 6.2: Let the slim config see package tests**

In `vitest.slim.config.ts` change:

```ts
        include: ["frontend/**/*.test.ts"],
```

to:

```ts
        include: ["frontend/**/*.test.ts", "packages/**/*.test.ts"],
```

- [ ] **Step 6.3: Electron-free reuse acceptance (the spec's headline goal)**

```bash
npx tsx -e '
const { getDefaultTools } = await import("@crest/coding-agent/tools");
const { AgentHarness } = await import("@crest/agent");
const tools = getDefaultTools(process.cwd());
console.log("tools:", tools.length, "harness:", typeof AgentHarness);
'
```

Expected output: `tools: 8 harness: function` — the agent stack loads and constructs with no Electron process. (Before this change, importing the tools barrel dragged in `emain-wsh` and `@/app/store/wshclientapi` and this could not run.)

- [ ] **Step 6.4: Final full gate**

```bash
npx tsc --noEmit
npx vitest run 2>&1 | tail -8
npm run build:dev
```

Expected: all match the Task 0 baseline or better.

- [ ] **Step 6.5: Commit**

```bash
git add -A
git commit -m "test: add package boundary fence; wire packages into slim vitest config"
```

---

## Out of scope (deliberate, from the spec)

- Publishing packages to a registry; per-package dependency declarations (npm hoisting via the root package.json serves resolution; revisit only if publishing).
- Injecting a config-home resolver into `sessions.ts` (works outside Electron via env vars today).
- Splitting `frontend/`, Go modules, or `tsunami/`.
- Rewriting deep imports (`@crest/ai/models`) to barrels — the wildcard export supports them.

## Risks and recovery

- **Active worktrees** (`agent-architecture-refactor`, `agent-extension-integration`, `crest-agent-pi-alignment`, ...) will hit rename conflicts on rebase. Surface this in the final report; landing order is the user's call.
- **Spike failure** (Task 1) has a fully specified tsconfig-paths fallback; import specifiers are identical either way.
- Every task ends in a commit with tsc + vitest + build green, so `git revert`/`git reset` to the last good task is always available.
