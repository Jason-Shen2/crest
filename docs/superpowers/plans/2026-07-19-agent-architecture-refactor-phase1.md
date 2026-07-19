# Agent Architecture Refactor Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove obsolete pane terminology and collapse the renderer Agent surface contract without changing Agent behavior.

**Architecture:** Rename the main-process per-session owner and Harness adapter to match their real session/runtime responsibilities. Rename the renderer hook and component to workspace Agent surface terminology, reduce its context to the five values it consumes, and keep the hidden backing block as the temporary TerminalModel/PTY carrier.

**Tech Stack:** TypeScript, React 19, Jotai, Electron IPC, Vitest, ESLint

---

## File Map

### Main process

- Rename `emain/agent/pane-agent-session.ts` to `emain/agent/agent-session-runtime.ts`.
  - Owns one persisted session's live messages, turns, queues, status, Harness and subscribers.
- Rename `emain/agent/pane-agent-session.test.ts` to `emain/agent/agent-session-runtime.test.ts`.
  - Preserves the full owner behavior suite under the new public name.
- Modify `emain/agent/harness-factory.ts`.
  - Rename `PaneHarness` to `AgentHarnessHost`.
- Modify `emain/agent-ipc.ts` and `emain/agent-ipc.test.ts`.
  - Consume `AgentSessionRuntime` and `AgentHarnessHost`.

### Renderer

- Rename `frontend/app/term/render/agent-pane.tsx` to `frontend/app/term/render/agent-surface.tsx`.
  - Export `WorkspaceAgentSurface` and `AgentSurfaceContext`.
- Rename `frontend/app/term/render/agent-pane.test.tsx` to `frontend/app/term/render/agent-surface.test.tsx`.
  - Cover the reduced context and surface output.
- Modify `frontend/app/term/render/terminal-view.tsx`.
  - Build only the five-field `AgentSurfaceContext` and mount the surface component directly.
- Modify `frontend/app/view/agentblock/agent-model.tsx` and test.
  - Pass `WorkspaceAgentSurface` to `TerminalView` without an adapter slot.

### Documentation

- Modify current architecture docs that describe production names:
  - `docs/agent-rendering-architecture.md`
  - `docs/agent-runtime-architecture.md`
  - `docs/code-wiki/02-system-architecture.md`
  - `docs/code-wiki/05-electron-ai-agent.md`
  - `docs/code-wiki/07-module-index.md`
- Historical plans/specs are not rewritten.

---

### Task 1: Rename the Harness Adapter

**Files:**
- Modify: `emain/agent/harness-factory.ts`
- Modify: `emain/agent/pane-agent-session.test.ts`
- Modify: `emain/agent/pane-agent-session.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `emain/agent/_spike.ts`
- Modify: `emain/agent/cli-subagent-factory.ts`
- Modify: `emain/agent/tools/index.ts`

- [ ] **Step 1: Write the failing public-name contract test**

Add this test near the imports in `emain/agent/pane-agent-session.test.ts`:

```ts
import { readFileSync } from "node:fs";

describe("AgentHarnessHost naming", () => {
    it("exports the session-scoped harness adapter without pane terminology", () => {
        const source = readFileSync(new URL("./harness-factory.ts", import.meta.url), "utf8");
        expect(source).toContain("export interface AgentHarnessHost");
        expect(source).not.toContain("export interface PaneHarness");
    });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run emain/agent/pane-agent-session.test.ts -t "AgentHarnessHost naming"
```

Expected: FAIL because `harness-factory.ts` still exports `PaneHarness`.

- [ ] **Step 3: Rename the adapter type**

In `emain/agent/harness-factory.ts`:

```ts
export interface AgentHarnessHost {
    readonly harness: AgentHarness
    readonly session: Session
    appendCustomEntry(customType: string, data?: unknown): Promise<void>
    promptWithCustomEntry(customType: string, data: unknown, text: string): Promise<unknown>
    update(inputs: SystemPromptInputs): void
}

export function buildAgentHarnessHost(opts: BuildAgentHarnessHostOptions): AgentHarnessHost
```

Rename `BuildPaneHarnessOptions` to `BuildAgentHarnessHostOptions`. Update imports and calls in:

- `emain/agent/pane-agent-session.ts`;
- `emain/agent/pane-agent-session.test.ts`;
- `emain/agent-ipc.ts`;
- `emain/agent-ipc.test.ts`;
- `emain/agent/_spike.ts`;
- `emain/agent/cli-subagent-factory.ts`;
- `emain/agent/tools/index.ts`.

Do not change Harness behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run emain/agent/pane-agent-session.test.ts emain/agent-ipc.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add emain/agent/harness-factory.ts emain/agent/pane-agent-session.ts emain/agent/pane-agent-session.test.ts emain/agent-ipc.ts emain/agent-ipc.test.ts emain/agent/_spike.ts emain/agent/cli-subagent-factory.ts emain/agent/tools/index.ts
git commit -m "refactor(agent): rename harness host adapter"
```

---

### Task 2: Rename the Session Owner

**Files:**
- Rename: `emain/agent/pane-agent-session.ts` to `emain/agent/agent-session-runtime.ts`
- Rename: `emain/agent/pane-agent-session.test.ts` to `emain/agent/agent-session-runtime.test.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`

- [ ] **Step 1: Write the failing runtime-name contract test**

Before renaming files, add this test to `emain/agent/pane-agent-session.test.ts`:

```ts
import { readFileSync } from "node:fs";

describe("AgentSessionRuntime naming", () => {
    it("exports the session owner without pane terminology", () => {
        const source = readFileSync(new URL("./pane-agent-session.ts", import.meta.url), "utf8");
        expect(source).toContain("export class AgentSessionRuntime");
        expect(source).not.toContain("export class PaneAgentSession");
    });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run emain/agent/pane-agent-session.test.ts -t "AgentSessionRuntime naming"
```

Expected: FAIL because the class is still named `PaneAgentSession`.

- [ ] **Step 3: Rename class, state types, file and tests**

Use non-interactive moves:

```bash
mv emain/agent/pane-agent-session.ts emain/agent/agent-session-runtime.ts
mv emain/agent/pane-agent-session.test.ts emain/agent/agent-session-runtime.test.ts
```

Apply these production renames:

```ts
PaneAgentSession -> AgentSessionRuntime
PaneAgentSessionOptions -> AgentSessionRuntimeOptions
PaneSessionState -> AgentSessionRuntimeState
PaneSessionStatus -> AgentSessionRuntimeStatus
PaneSessionListener -> AgentSessionRuntimeListener
PaneTurnFinishedHook -> AgentTurnFinishedHook
PaneSessionStateEvent -> AgentSessionRuntimeStateEvent
```

Update the source-contract test to read:

```ts
const source = readFileSync(new URL("./agent-session-runtime.ts", import.meta.url), "utf8")
```

Update all imports and generic references in `emain/agent-ipc.ts` and `emain/agent-ipc.test.ts`. Keep the cache variable unchanged in this phase; Phase 2 replaces it with `AgentRuntimeRegistry`.

- [ ] **Step 4: Verify no production references remain**

Run:

```bash
rg -n "PaneAgentSession|PaneSession(State|Status|Listener)|pane-agent-session" emain --glob '*.{ts,tsx}'
```

Expected: no output.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run emain/agent/agent-session-runtime.test.ts emain/agent-ipc.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add emain/agent/agent-session-runtime.ts emain/agent/agent-session-runtime.test.ts emain/agent-ipc.ts emain/agent-ipc.test.ts
git add -u emain/agent/pane-agent-session.ts emain/agent/pane-agent-session.test.ts
git commit -m "refactor(agent): rename session runtime owner"
```

---

### Task 3: Rename and Reduce the Renderer Surface

**Files:**
- Rename: `frontend/app/term/render/agent-pane.tsx` to `frontend/app/term/render/agent-surface.tsx`
- Rename: `frontend/app/term/render/agent-pane.test.tsx` to `frontend/app/term/render/agent-surface.test.tsx`
- Modify: `frontend/app/term/render/terminal-view.tsx`
- Modify: `frontend/app/view/agentblock/agent-model.tsx`
- Modify: `frontend/app/view/agentblock/agent-model.test.ts`

- [ ] **Step 1: Write the failing minimal-context contract test**

Add to `frontend/app/term/render/agent-pane.test.tsx`:

```ts
import { readFileSync } from "node:fs";

describe("Agent surface context", () => {
    it("uses a direct workspace surface with only consumed context", () => {
        const source = readFileSync(new URL("./agent-pane.tsx", import.meta.url), "utf8");
        const context = source.match(/export interface AgentSurfaceContext \{([\s\S]*?)\n\}/)?.[1] ?? "";
        expect(source).toContain("export function WorkspaceAgentSurface");
        expect(source).not.toContain("export interface AgentSlot");
        expect(source).not.toContain("children: (slot:");
        expect(context).toContain("workspaceDir: string");
        expect(context).toContain("liveGitBranch?: string");
        expect(context).toContain("recentCmds: string[]");
        expect(context).toContain("liveConnection: string");
        expect(context).toContain("inAltScreen: boolean");
        expect(context).not.toContain("fontSize:");
        expect(context).not.toContain("commandHistory:");
        expect(context).not.toContain("onModeChange:");
    });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run frontend/app/term/render/agent-pane.test.tsx -t "Agent surface context"
```

Expected: FAIL because `AgentSurfaceContext` does not exist.

- [ ] **Step 3: Rename the renderer file and public API**

Move files:

```bash
mv frontend/app/term/render/agent-pane.tsx frontend/app/term/render/agent-surface.tsx
mv frontend/app/term/render/agent-pane.test.tsx frontend/app/term/render/agent-surface.test.tsx
```

Apply these renames:

```ts
AgentPaneDeps -> AgentSurfaceContext
AgentPane -> WorkspaceAgentSurface
```

Define the context exactly as:

```ts
export interface AgentSurfaceContext {
    workspaceDir: string
    liveGitBranch?: string
    recentCmds: string[]
    liveConnection: string
    inAltScreen: boolean
}
```

Define direct component props:

```ts
export interface WorkspaceAgentSurfaceProps {
    outerBlockId: string
    model: TerminalModel
    context: AgentSurfaceContext
}
```

Move the existing hook body into `WorkspaceAgentSurface`. Replace `deps.*` reads with `context.*` and return the current `chatHost` JSX directly. Delete:

- `AgentSlot`;
- `AgentPaneProps`;
- `useAgentPane`;
- the trailing `AgentPane` children wrapper;
- `commandResults`, `inputBar`, and `replacesBlockList` constants.

- [ ] **Step 4: Reduce TerminalView's surface context**

In `frontend/app/term/render/terminal-view.tsx`, rename:

```ts
agentSlotComponent -> agentSurfaceComponent
AgentSlotComponentProps -> AgentSurfaceComponentProps
AgentSlotComponent -> AgentSurfaceComponent
agentSlotDeps -> agentSurfaceContext
```

Construct only:

```ts
const agentSurfaceContext: AgentSurfaceContext = {
    workspaceDir,
    liveGitBranch: liveBlock?.gitBranch ?? chipValues.gitBranch,
    recentCmds,
    liveConnection,
    inAltScreen,
}
```

Define:

```ts
export interface AgentSurfaceComponentProps {
    outerBlockId: string
    model: TerminalModel
    context: AgentSurfaceContext
}
```

Inside the shared terminal body:

```tsx
const agentSurface = AgentSurfaceComponent ? (
    <AgentSurfaceComponent
        outerBlockId={outerBlockId}
        model={model}
        context={agentSurfaceContext}
    />
) : null
```

Preserve `topSlot`, `FindBar`, error, `overlaySlot`, and notification rendering. Move the existing loading/welcome/block-list, spacer, and `CmdBlockInput` branches into `renderTerminalContent()`, then render:

```tsx
{agentSurface ?? renderTerminalContent()}
```

The Agent path renders no terminal block list and no terminal input, matching current `replacesBlockList: true` and `inputBar: null` behavior.

- [ ] **Step 5: Update AgentViewModel wiring**

In `frontend/app/view/agentblock/agent-model.tsx`:

```tsx
import { WorkspaceAgentSurface } from "@/app/term/render/agent-surface"
```

Pass the component directly:

```tsx
<TerminalView
    outerBlockId={blockId}
    fontSize={fontSize}
    focusRequest={focusRequest}
    agentSurfaceComponent={WorkspaceAgentSurface}
/>
```

Delete `AgentPaneSlot`/`AgentSurfaceSlot`; `TerminalView` owns the local `TerminalModel` and passes it to the surface component.

- [ ] **Step 6: Update tests and verify no old production names remain**

Update test imports and source assertions. Run:

```bash
rg -n "AgentPane|useAgentPane|AgentPaneDeps|AgentSlot|agent-pane" frontend/app --glob '*.{ts,tsx}'
```

Expected: no output outside historical test descriptions that are intentionally updated in this task.

- [ ] **Step 7: Run renderer tests and verify GREEN**

Run:

```bash
npx vitest run \
  frontend/app/term/render/agent-surface.test.tsx \
  frontend/app/view/agentblock/agent-model.test.ts \
  frontend/app/term/render/terminal-view-tui.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/term/render/agent-surface.tsx frontend/app/term/render/agent-surface.test.tsx frontend/app/term/render/terminal-view.tsx frontend/app/view/agentblock/agent-model.tsx frontend/app/view/agentblock/agent-model.test.ts
git add -u frontend/app/term/render/agent-pane.tsx frontend/app/term/render/agent-pane.test.tsx
git commit -m "refactor(agent): rename workspace agent surface"
```

---

### Task 4: Update Current Architecture Documentation

**Files:**
- Modify: `docs/agent-rendering-architecture.md`
- Modify: `docs/agent-runtime-architecture.md`
- Modify: `docs/code-wiki/02-system-architecture.md`
- Modify: `docs/code-wiki/05-electron-ai-agent.md`
- Modify: `docs/code-wiki/07-module-index.md`

- [ ] **Step 1: Write a failing documentation contract check**

Run:

```bash
rg -n "PaneAgentSession|PaneHarness|AgentPane|agent-pane\\.tsx" \
  docs/agent-rendering-architecture.md \
  docs/agent-runtime-architecture.md \
  docs/code-wiki/02-system-architecture.md \
  docs/code-wiki/05-electron-ai-agent.md \
  docs/code-wiki/07-module-index.md
```

Expected: output lists stale production names.

- [ ] **Step 2: Update current documentation**

Use these replacements only where the text describes current production code:

```text
PaneAgentSession -> AgentSessionRuntime
PaneHarness -> AgentHarnessHost
AgentPane -> WorkspaceAgentSurface
agent-pane.tsx -> agent-surface.tsx
pane-agent-session.ts -> agent-session-runtime.ts
```

Do not rewrite historical design/plan documents.

- [ ] **Step 3: Verify documentation contract GREEN**

Re-run the `rg` command from Step 1.

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add docs/agent-rendering-architecture.md docs/agent-runtime-architecture.md docs/code-wiki/02-system-architecture.md docs/code-wiki/05-electron-ai-agent.md docs/code-wiki/07-module-index.md
git commit -m "docs: align agent runtime terminology"
```

---

### Task 5: Phase 1 Verification

**Files:**
- Verify all Phase 1 changes

- [ ] **Step 1: Run all Agent owner and renderer tests**

```bash
npx vitest run \
  emain/agent/agent-session-runtime.test.ts \
  emain/agent-ipc.test.ts \
  frontend/app/term/render/agent-surface.test.tsx \
  frontend/app/view/agentblock/agent-model.test.ts \
  frontend/app/term/render/terminal-view-tui.test.tsx \
  frontend/app/workspace/workspace.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 2: Run ESLint on changed TypeScript files**

```bash
npx eslint \
  emain/agent/agent-session-runtime.ts \
  emain/agent/harness-factory.ts \
  emain/agent-ipc.ts \
  frontend/app/term/render/agent-surface.tsx \
  frontend/app/term/render/terminal-view.tsx \
  frontend/app/view/agentblock/agent-model.tsx
```

Expected: exit 0.

- [ ] **Step 3: Run scoped TypeScript verification**

The repository has unrelated existing TypeScript errors, so capture only changed-file diagnostics:

```bash
npx tsc --noEmit 2>&1 | rg \
  "agent-session-runtime|harness-factory|agent-ipc|agent-surface|terminal-view|agent-model" || true
```

Expected: no output.

- [ ] **Step 4: Verify terminology and diff hygiene**

```bash
rg -n "PaneAgentSession|PaneHarness|AgentPaneDeps|useAgentPane" emain frontend/app --glob '*.{ts,tsx}'
git diff --check
git status --short
```

Expected:

- terminology search has no output;
- `git diff --check` exits 0;
- status contains only intentional Phase 1 changes, or is clean if every task commit has landed.

- [ ] **Step 5: Record active-worktree migration note**

Do not edit either active worktree. In the Phase 1 completion message, report that:

- `agent-extension-integration` must rename its `PaneAgentSession` extension host to `AgentSessionRuntime`;
- `agent-observability-langfuse` must attach to `AgentSessionRuntime`/Harness events without pane terminology;
- their uncommitted work remains untouched.
