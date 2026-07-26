# Workspace Top Tabs Phase 4A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move File, Preview, and Git Diff into lightweight Top Tabs owned by the persistent Workspace Renderer, keep Browser in the existing right-side tool, then remove every non-Terminal Wave Tab path in one hard cut.

**Architecture:** `WorkspaceModel` remains the navigation source of truth, while a workspace-scoped `WorkspaceTopTabController` owns typed open intents and a `WorkspaceTopTabRuntimeRegistry` owns non-persisted runtime resources. File keeps Monaco models and dirty buffers in a workspace editor registry; Preview and Git Diff mount only while active. URL launchers target the existing right-side Browser model instead of creating a Top Tab or Wave Tab. All three Top Tab types become functional before legacy non-Terminal creation, activation, renderer, and Block-probing paths are deleted.

**Tech Stack:** React 19, Jotai, Monaco, Electron `WebContentsView` and `<webview>`, TypeScript/Vitest, Go WaveObj/SQLite/WshRPC, Tailwind v4.

---

## Scope and execution rules

- This is one Phase 4 branch and one product cutover. Tasks are separate commits so they can be reviewed and debugged independently; they are not compatibility phases.
- Do not migrate legacy mixed Tabs. New-domain workspaces only route `terminaltabids` to `WaveTabView`.
- Do not introduce a fake Block, `TabModelContext`, `LayoutState`, or `staticTabId` for Top Tabs.
- Persist descriptors, order, and selection. Do not persist Monaco undo/view state, dirty buffers, preview caches, or diff caches.
- File paths are deduplicated after normalization. Preview paths and Git Diff identities are deduplicated.
- Browser Top Tabs, Browser descriptor persistence, and Browser guest LRU are deferred. Existing right-side Browser behavior remains only where URL launchers must stop creating Wave Tabs.
- Preview and Git Diff may unmount on switch.
- File close, workspace replacement, and window close use the same Save / Discard / Cancel guard.
- Never run `go build`. Modify Go RPC types first and run `task generate`; never hand-edit generated TypeScript.
- When implementing Electron APIs, read `.kilocode/skills/electron-api/SKILL.md` before editing preload/IPC.
- Use TDD for every task. Request a spec-compliance review and then a code-quality review before moving to the next task.

## Target file structure

Create these focused Workspace modules:

```text
frontend/app/workspace/
  top-tab-controller.ts              typed open intents, IDs, identity dedupe
  top-tab-controller-context.tsx     current Workspace controller for launchers
  top-tab-navigation-queue.ts        ordered local/Terminal navigation intents
  top-tab-strip.tsx                  activate, close, reorder, keyboard, dirty marker
  top-tab-runtime-registry.ts        runtime registration and workspace disposal
  top-tab-runtime-host.tsx           lifecycle routing by TopTab.kind
  top-tab-close-coordinator.ts       Save / Discard / Cancel orchestration
  workspace-editor-registry.ts       File buffer, Monaco model, view state, dirty owner
  file-top-tab.tsx                   File editor surface
  preview-repository.ts              Block-free preview loading
  preview-top-tab.tsx                read-only preview surface
  git-diff-top-tab.tsx               descriptor-driven Git Diff surface
```

Keep descriptor reducers in `workspace-content-state.ts`, checkpoint ownership in
`workspace-model.ts`. Keep the existing right-side Browser model and panel outside the
Top Tab runtime.

### Task 1: Finalize the persisted Top Tab contract

**Files:**
- Modify: `pkg/waveobj/wtype.go`
- Modify: `pkg/service/workspaceservice/contentstate.go`
- Modify: `pkg/service/workspaceservice/contentstate_test.go`
- Modify: `frontend/app/workspace/workspace-content-state.ts`
- Modify: `frontend/app/workspace/workspace-content-state.test.ts`
- Modify: `frontend/app/workspace/workspace-model.ts`
- Modify: `frontend/app/workspace/workspace-model.test.ts`
- Generate: `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Write failing frontend and Go schema tests**

Add cases proving that Git Diff persists its actual identity
`(repoRoot, path, mode, originalPath)`, Preview deduplicates normalized paths, Browser
descriptors are rejected in this phase, and malformed mode/path values are dropped
individually without discarding valid sibling descriptors.

```ts
const diff: TopTab = {
    id: "diff-1",
    kind: "git-diff",
    repoRoot: "/repo",
    path: "src/app.ts",
    mode: "+",
    originalPath: "",
    title: "app.ts",
};
expect(hydrateWorkspaceContentState(serializeForTest([diff]), "")).toMatchObject({
    topTabs: [diff],
});
```

```go
descriptor := waveobj.TopTabDescriptor{
    Id:           "diff-1",
    Kind:         waveobj.TopTabKindGitDiff,
    RepoRoot:     "/repo",
    Path:         "src/app.ts",
    Mode:         "+",
    OriginalPath: "",
    Title:        "app.ts",
}
normalized, ok := normalizeTopTabDescriptor(descriptor)
if !ok || normalized != descriptor {
    t.Fatalf("normalized descriptor mismatch: %#v", normalized)
}
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-content-state.test.ts frontend/app/workspace/workspace-model.test.ts
go test ./pkg/service/workspaceservice -run 'ContentState|Checkpoint'
```

Expected: FAIL because the current descriptor uses `oldPath/newPath` and Preview has no
identity dedupe.

- [ ] **Step 3: Replace the Git Diff contract consistently**

Use this frontend union:

```ts
export type GitDiffMode = "+" | "-";

export type TopTab =
    | { id: string; kind: "file"; path: string; title: string }
    | { id: string; kind: "preview"; path: string; title: string }
    | {
          id: string;
          kind: "git-diff";
          repoRoot: string;
          path: string;
          mode: GitDiffMode;
          originalPath: string;
          title: string;
      };
```

Use lowercase JSON fields `reporoot`, `path`, `mode`, and `originalpath` in Go. Add pure
identity helpers for File, Preview, and Git Diff. Remove Browser from the accepted
frontend/backend descriptor kinds; persisted Browser descriptors are dropped during
hydration because Browser Top Tabs are deferred.

- [ ] **Step 4: Generate types and run GREEN**

Run:

```bash
task generate
npx vitest run frontend/app/workspace/workspace-content-state.test.ts frontend/app/workspace/workspace-model.test.ts
go test ./pkg/service/workspaceservice -run 'ContentState|Checkpoint'
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/waveobj/wtype.go pkg/service/workspaceservice/contentstate.go pkg/service/workspaceservice/contentstate_test.go frontend/app/workspace/workspace-content-state.ts frontend/app/workspace/workspace-content-state.test.ts frontend/app/workspace/workspace-model.ts frontend/app/workspace/workspace-model.test.ts frontend/types/gotypes.d.ts
git commit -m "refactor: finalize top tab descriptors"
```

### Task 2: Serialize navigation intents and preserve dirty Top Tabs

**Files:**
- Create: `frontend/app/workspace/top-tab-navigation-queue.ts`
- Create: `frontend/app/workspace/top-tab-navigation-queue.test.ts`
- Modify: `frontend/app/workspace/workspace-model.ts`
- Modify: `frontend/app/workspace/workspace-model.test.ts`
- Modify: `frontend/app/workspace/terminal-navigation.ts`
- Modify: `frontend/app/workspace/terminal-navigation.test.ts`
- Modify: `pkg/service/workspaceservice/checkpoint.go`
- Modify: `pkg/service/workspaceservice/checkpoint_test.go`
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Generate: `frontend/types/gotypes.d.ts`
- Generate: `frontend/app/store/services.ts`

- [ ] **Step 1: Write a deferred concurrency test**

Prove that local Top Tab intents made while a Terminal mutation is pending survive a newer
authoritative checkpoint and are replayed exactly once.

```ts
queue.enqueue({ type: "open-top-tab", tab: fileTab });
const terminalMutation = queue.runTerminalMutation(() => terminalDeferred.promise);
queue.enqueue({ type: "update-top-tab", topTabId: fileTab.id, updates: { title: "dirty.ts" } });
terminalDeferred.resolve(authoritativeCheckpoint);
await terminalMutation;
expect(getTopTabs()).toEqual([{ ...fileTab, title: "dirty.ts" }]);
```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run frontend/app/workspace/top-tab-navigation-queue.test.ts frontend/app/workspace/workspace-model.test.ts frontend/app/workspace/terminal-navigation.test.ts
```

Expected: FAIL because `reconcileCheckpoint()` currently invalidates pending local
checkpoint state.

- [ ] **Step 3: Make checkpoint acknowledgement authoritative**

Change `SaveWorkspaceCheckpoint` to accept `expectedrevision` and return a non-error
discriminated result:

```go
type SaveWorkspaceCheckpointResult struct {
    Status     string              `json:"status"`
    Checkpoint WorkspaceCheckpoint `json:"checkpoint"`
}
```

`status` is `"committed"` or `"conflict"`. In one backend transaction, a mismatched
revision returns `{status:"conflict", checkpoint:<current>}` with a nil Go error; on
success increment once, persist, and return `{status:"committed",
checkpoint:<stored>}`. Only transport, validation, or database failures return a Go error.
This matches the existing service transport, which discards response data when `error` is
non-empty. Regenerate `gotypes.d.ts` and `services.ts`.

A `"committed"` result is the only acknowledgement for local intents; scheduling a call or
receiving an unrelated WOS update is not an acknowledgement.

- [ ] **Step 4: Implement the explicit queue state machine**

The queue owns:

```ts
interface PendingTopTabIntent {
    sequence: number;
    action: WorkspaceContentAction;
}

interface NavigationQueueState {
    confirmed: WorkspaceCheckpoint;
    pending: PendingTopTabIntent[];
    projected: WorkspaceContentState;
    nextSequence: number;
}
```

`enqueue(action)` appends a sequence and immediately recomputes `projected` by folding all
pending actions over `confirmed.contentstate`. One promise tail serializes both local
checkpoint batches and Terminal structural RPCs:

1. A local batch captures `maxSequence`, sends the full projected state with
   `expectedrevision = confirmed.navigationrevision`, and waits for the returned
   checkpoint.
2. On success, set `confirmed` to the returned checkpoint, remove only intents whose
   sequence is `<= maxSequence`, then replay newer pending intents to recompute projected.
3. On a `"conflict"` result, replace `confirmed` with the returned authoritative checkpoint,
   keep every unacknowledged intent, replay them once in sequence order, and retry through
   the same tail.
4. On transport/save failure, keep all intents, expose `error`, and retry the same batch;
   never duplicate or discard an intent.
5. Before a Terminal create/activate/close/reorder RPC, drain local intents. Call the
   Terminal RPC with the confirmed revision, adopt its returned checkpoint, then replay
   only intents enqueued after that RPC began.

Repeated `update-top-tab` actions for the same ID may coalesce only when no intervening
open/close/reorder action references that ID.

The queue implementation retains the serial tail:

```ts
export class TopTabNavigationQueue {
    tail = Promise.resolve();

    run<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.tail.then(operation, operation);
        this.tail = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    }
}
```

Add deferred tests for Terminal pending + local open/update, conflict + replay, save failure
+ retry, intents enqueued during an in-flight save, coalesced updates, and repeated
authoritative WOS delivery. Each test must prove every intent is applied once.

- [ ] **Step 5: Run GREEN**

Run:

```bash
task generate
npx vitest run frontend/app/workspace/top-tab-navigation-queue.test.ts frontend/app/workspace/workspace-model.test.ts frontend/app/workspace/terminal-navigation.test.ts
go test ./pkg/service/workspaceservice -run Checkpoint
```

Expected: PASS with no unhandled rejection.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/workspace/top-tab-navigation-queue.ts frontend/app/workspace/top-tab-navigation-queue.test.ts frontend/app/workspace/workspace-model.ts frontend/app/workspace/workspace-model.test.ts frontend/app/workspace/terminal-navigation.ts frontend/app/workspace/terminal-navigation.test.ts pkg/service/workspaceservice/checkpoint.go pkg/service/workspaceservice/checkpoint_test.go pkg/wshrpc/wshrpctypes.go frontend/types/gotypes.d.ts frontend/app/store/services.ts
git commit -m "fix: serialize workspace navigation intents"
```

### Task 3: Add the workspace-scoped Top Tab controller

**Files:**
- Create: `frontend/app/workspace/top-tab-controller.ts`
- Create: `frontend/app/workspace/top-tab-controller.test.ts`
- Create: `frontend/app/workspace/top-tab-controller-context.tsx`
- Create: `frontend/app/workspace/top-tab-controller-context.test.tsx`
- Modify: `frontend/app/workspace/workspace-app.tsx`

- [ ] **Step 1: Write failing controller tests**

Cover stable ID generation, concurrent File/Preview/Git Diff dedupe, activation of an
existing identity, and rejection after workspace disposal.

```ts
const first = controller.openFile("/repo/src/app.ts");
const second = controller.openFile("/repo/src/../src/app.ts");
expect(first).toBe(second);
expect(model.openTopTab).toHaveBeenCalledTimes(1);

```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run frontend/app/workspace/top-tab-controller.test.ts frontend/app/workspace/top-tab-controller-context.test.tsx
```

Expected: FAIL because the controller and context do not exist.

- [ ] **Step 3: Implement typed open methods**

Expose this public boundary:

```ts
export interface WorkspaceTopTabController {
    openFile(path: string): string;
    openPreview(path: string): string;
    openGitDiff(input: {
        repoRoot: string;
        path: string;
        mode: GitDiffMode;
        originalPath?: string;
    }): string;
    activate(topTabId: string): void;
    close(topTabId: string): Promise<boolean>;
}
```

Generate IDs with `crypto.randomUUID()`. Store concurrent identity opens in a map owned by
the controller. Provide the controller through React context from `WorkspaceAppInner`;
business launchers receive or resolve this context rather than reading `atoms.workspace`
or a global singleton.

- [ ] **Step 4: Run GREEN**

Run the command from Step 2 and
`npx vitest run frontend/app/workspace/workspace-app.test.tsx`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/workspace/top-tab-controller.ts frontend/app/workspace/top-tab-controller.test.ts frontend/app/workspace/top-tab-controller-context.tsx frontend/app/workspace/top-tab-controller-context.test.tsx frontend/app/workspace/workspace-app.tsx
git commit -m "feat: add workspace top tab controller"
```

### Task 4: Build the production Top Tab strip and runtime host

**Files:**
- Create: `frontend/app/workspace/top-tab-strip.tsx`
- Create: `frontend/app/workspace/top-tab-strip.test.tsx`
- Create: `frontend/app/workspace/top-tab-runtime-registry.ts`
- Create: `frontend/app/workspace/top-tab-runtime-registry.test.ts`
- Create: `frontend/app/workspace/top-tab-runtime-host.tsx`
- Create: `frontend/app/workspace/top-tab-runtime-host.test.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.test.tsx`

- [ ] **Step 1: Write failing UI and lifecycle tests**

Test click activation, close without accidental activation, pointer reorder, roving keyboard
focus, a fake runtime changing dirty/title after registration, one active panel,
Preview/Diff active-only, and registry disposal on workspace replacement. Use injected
surface factories in this task; production File/Preview/Diff factories arrive in Tasks
5, 7, and 8.

```tsx
expect(screen.getByRole("tab", { name: "app.ts" })).toHaveAttribute("aria-selected", "true");
await user.click(screen.getByLabelText("Close app.ts"));
expect(close).toHaveBeenCalledWith("file-1");
expect(activate).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run frontend/app/workspace/top-tab-strip.test.tsx frontend/app/workspace/top-tab-runtime-registry.test.ts frontend/app/workspace/top-tab-runtime-host.test.tsx frontend/app/workspace/workspace-main-content.test.tsx
```

Expected: FAIL because the current strip is a title-only button list and the surface is a
placeholder.

- [ ] **Step 3: Implement the shared host boundary**

Use a subscribable registry contract that does not know Block or Layout types:

```ts
export interface TopTabRuntimeSnapshot {
    dirty: boolean;
    title: string;
    status: "cold" | "loading" | "ready" | "error";
}

export interface TopTabRuntime {
    getSnapshot(): TopTabRuntimeSnapshot;
    subscribe(listener: () => void): () => void;
    dispose(): void | Promise<void>;
}

export class WorkspaceTopTabRuntimeRegistry {
    runtimes = new Map<string, TopTabRuntime>();

    getOrCreate(topTabId: string, factory: () => TopTabRuntime): TopTabRuntime;
    get(topTabId: string): TopTabRuntime | undefined;
    close(topTabId: string): Promise<void>;
    dispose(): Promise<void>;
}
```

`TopTabStrip` reads runtime snapshots with `useSyncExternalStore`. A runtime emits when
dirty/title/status changes, so the dirty dot and accessible label update without mutating
the persisted descriptor on each keystroke. The registry creates a File runtime on first
activation, owns it until Top Tab close or workspace disposal, and never unregisters it on
React surface unmount. Preview/Diff use ephemeral adapters that report loading/error while
mounted and are disposed on unmount.

`TopTabRuntimeHost` dispatches by `tab.kind`. It renders only the active File component
while keeping the File runtime in the registry, and renders Preview/Git Diff only while
active. Wrap each active surface in an error boundary whose retry key belongs to that Top
Tab. Its injected contract is:

```ts
export interface TopTabSurfaceFactories {
    renderFile(tab: FileTopTab, runtime: TopTabRuntime): ReactNode;
    renderPreview(tab: PreviewTopTab): ReactNode;
    renderGitDiff(tab: GitDiffTopTab): ReactNode;
}
```

- [ ] **Step 4: Run GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/workspace/top-tab-strip.tsx frontend/app/workspace/top-tab-strip.test.tsx frontend/app/workspace/top-tab-runtime-registry.ts frontend/app/workspace/top-tab-runtime-registry.test.ts frontend/app/workspace/top-tab-runtime-host.tsx frontend/app/workspace/top-tab-runtime-host.test.tsx frontend/app/workspace/workspace-main-content.tsx frontend/app/workspace/workspace-main-content.test.tsx
git commit -m "feat: host lightweight top tabs"
```

### Task 5: Implement the workspace File editor registry

**Files:**
- Create: `frontend/app/workspace/workspace-editor-registry.ts`
- Create: `frontend/app/workspace/workspace-editor-registry.test.ts`
- Create: `frontend/app/workspace/file-top-tab.tsx`
- Create: `frontend/app/workspace/file-top-tab.test.tsx`
- Modify: `frontend/app/righteditor/monaco-model-registry.ts`
- Modify: `frontend/app/righteditor/monaco-model-registry.test.ts`
- Modify: `frontend/app/workspace/top-tab-runtime-host.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.test.tsx`
- Modify: `frontend/app/workspace/workspace-app.tsx`
- Modify: `frontend/app/workspace/workspace-app.test.tsx`
- Reuse: `frontend/app/righteditor/right-editor-rpc.ts`
- Reuse: `frontend/app/righteditor/right-editor-types.ts`

- [ ] **Step 1: Write failing registry tests**

Test one model per normalized path, concurrent read dedupe, stale read rejection, dirty
buffer retention across React unmount, Monaco view-state save/restore, Save success/failure,
serialized rename/delete path migration, rollback to the old registry identity, and final
model disposal.

```ts
const runtime = await registry.acquire("/repo/app.ts");
runtime.setValue("changed");
registry.saveViewState(runtime.id, { cursorState: [], viewState: null });
registry.releaseSurface(runtime.id);
expect(registry.get(runtime.id)?.dirty).toBe(true);
expect(registry.get(runtime.id)?.value).toBe("changed");
```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-editor-registry.test.ts frontend/app/workspace/file-top-tab.test.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/workspace/workspace-app.test.tsx frontend/app/righteditor/monaco-model-registry.test.ts
```

Expected: FAIL because no workspace editor owner exists.

- [ ] **Step 3: Implement the File runtime contract**

The registry owns these states outside React:

```ts
export interface WorkspaceFileRuntime {
    id: string;
    path: string;
    savedValue: string;
    value: string;
    dirty: boolean;
    modelUri: string;
    viewState?: editor.ICodeEditorViewState;
}
```

Use `FileRead`/`FileWrite` through `right-editor-rpc.ts`. Use workspace ID plus normalized
path for Monaco URI identity. React mount acquires the existing model and restores view
state; unmount saves view state and releases only the editor attachment. Closing/disposal
releases the registry ownership and disposes the Monaco model. File title and dirty marker
come from the registry, not persisted descriptor mutation on every keystroke. Each File
runtime implements the Task 4 `getSnapshot/subscribe` contract and emits after value,
dirty, title, loading, save, rename, or error changes.

Create one `WorkspaceEditorRegistry` and one `WorkspaceTopTabRuntimeRegistry` per
`WorkspaceAppInner`. Register the editor registry with
`model.registerPreReplacementTeardown`, inject the production File factory into
`TopTabRuntimeHost`, and pass the runtime registry to `TopTabStrip`. Add an integration test
that opens a File descriptor through the controller, renders Monaco, edits it, observes the
dirty dot, switches away/back without losing the buffer, and disposes the model on
workspace replacement.

- [ ] **Step 4: Run GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/workspace/workspace-editor-registry.ts frontend/app/workspace/workspace-editor-registry.test.ts frontend/app/workspace/file-top-tab.tsx frontend/app/workspace/file-top-tab.test.tsx frontend/app/righteditor/monaco-model-registry.ts frontend/app/righteditor/monaco-model-registry.test.ts frontend/app/workspace/top-tab-runtime-host.tsx frontend/app/workspace/workspace-main-content.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/workspace/workspace-app.tsx frontend/app/workspace/workspace-app.test.tsx
git commit -m "feat: add workspace file tab runtime"
```

### Task 6: Add one asynchronous close coordinator

**Files:**
- Create: `frontend/app/workspace/top-tab-close-coordinator.ts`
- Create: `frontend/app/workspace/top-tab-close-coordinator.test.ts`
- Create: `frontend/app/workspace/top-tab-close-dialog.tsx`
- Create: `frontend/app/workspace/top-tab-close-dialog.test.tsx`
- Modify: `frontend/app/workspace/top-tab-controller.ts`
- Modify: `frontend/app/workspace/workspace-command-router.ts`
- Modify: `frontend/app/workspace/workspace-command-router.test.ts`
- Modify: `frontend/app/workspace/workspace-app.tsx`
- Modify: `emain/emain-window.ts`
- Modify: `emain/emain-window-sender.test.ts`
- Create: `emain/emain-quit-coordinator.ts`
- Create: `emain/emain-quit-coordinator.test.ts`
- Modify: `emain/emain.ts`
- Modify: `emain/preload.ts`
- Modify: `frontend/types/custom.d.ts`

- [ ] **Step 1: Read the Electron API skill**

Read `.kilocode/skills/electron-api/SKILL.md` completely before changing preload or IPC.

- [ ] **Step 2: Write failing close tests**

Cover clean close, Save, Discard, Cancel, failed Save, repeated close coalescing, Cmd+W,
workspace replacement, app window close, and a renderer that disappears during the
handshake. Add quit tests for Cancel, all windows allow, one renderer timeout/destroy,
second `before-quit` during an in-flight request, and the final approved `app.quit()`
re-entry. Add a two-file test where the first decision is Discard and the second is Cancel;
both buffers must remain unchanged and no descriptor may close.

```ts
prompt.mockResolvedValue("save");
expect(await coordinator.close("file-1")).toBe(true);
expect(editorRegistry.save).toHaveBeenCalledWith("file-1");
expect(model.closeTopTab).toHaveBeenCalledWith("file-1");
```

- [ ] **Step 3: Run RED**

Run:

```bash
npx vitest run frontend/app/workspace/top-tab-close-coordinator.test.ts frontend/app/workspace/workspace-command-router.test.ts emain/emain-window-sender.test.ts emain/emain-quit-coordinator.test.ts
```

Expected: FAIL because Top Tab close is synchronous and the window has no async veto
handshake.

- [ ] **Step 4: Implement Save / Discard / Cancel**

The renderer owns the Save / Discard / Cancel prompt through
`TopTabCloseDialog`. `WorkspaceApp` renders one dialog host; the coordinator's injected
`requestDecision({ topTabId, title })` promise resolves from its Save, Discard, or Cancel
button. A second request is queued behind the first, and unmount resolves every pending
request as Cancel.
Use this result type consistently:

```ts
export type TopTabCloseDecision = "save" | "discard" | "cancel";

export interface TopTabCloseCoordinator {
    close(topTabId: string): Promise<boolean>;
    prepareWorkspaceClose(): Promise<boolean>;
    prepareFileMutation(topTabId: string): Promise<boolean>;
    prepareFileMutations(topTabIds: readonly string[]): Promise<boolean>;
}
```

`prepareFileMutations()` runs the same two-phase decision algorithm as
`prepareWorkspaceClose()` over only the specified File runtimes, without closing their Top
Tabs: collect every decision first; any Cancel changes nothing; then execute every Save;
only after all Saves succeed apply every Discard. `prepareFileMutation(id)` delegates to
`prepareFileMutations([id])`. File rename/delete in Task 9 calls only the batch method and
must not call the filesystem until it returns `true`.

Only File runtime can be dirty in Phase 4A. `prepareWorkspaceClose()` is a non-destructive,
two-phase operation:

1. Collect Save / Discard / Cancel decisions for every dirty File in strip order without
   changing any runtime.
2. If any decision is Cancel, return `false`; no buffer, runtime, or descriptor changes.
3. Execute every Save decision. If any Save fails, return `false`; do not execute any
   Discard and do not close the workspace.
4. Apply all Discard decisions in memory, then `await model.flush()`.
5. Return `true` without calling `model.closeTopTab`; window/workspace close must preserve
   descriptors for restart restoration.

`close(topTabId)` remains the destructive single-Tab operation and removes that descriptor
only after its decision succeeds.

Define a request/response IPC instead of treating `webContents.send()` as a promise:

```ts
type WorkspaceCloseRequest = { requestid: string; reason: "window" | "workspace" | "quit" };
type WorkspaceCloseResponse = { requestid: string; allow: boolean };
```

`WaveWindow.requestWorkspaceClose(reason)` creates a UUID, stores a pending resolver, sends
the request to the current Workspace renderer, and resolves only when a response with the
same request ID arrives from that renderer. A 30-second timeout, renderer destruction, or
sender mismatch resolves `false` and keeps the window open. Preload exposes
`onWorkspaceCloseRequest(handler)` and `respondWorkspaceClose(response)`.

Move app shutdown coordination into `emain-quit-coordinator.ts`. The first
`before-quit` calls `preventDefault()`, asks every Workspace window, and calls `app.quit()`
again only after all return `allow:true`; an `approvedQuit` flag lets that second event
continue. Cancel, timeout, or renderer loss clears the in-flight state and leaves the app
running. Relaunch/update shutdown goes through the same coordinator unless the process is
already in an unrecoverable crash exit. Do not rely on async `beforeunload`.

- [ ] **Step 5: Run GREEN**

Run the command from Step 3 and
`npx vitest run frontend/app/workspace/workspace-app.test.tsx`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/workspace/top-tab-close-coordinator.ts frontend/app/workspace/top-tab-close-coordinator.test.ts frontend/app/workspace/top-tab-close-dialog.tsx frontend/app/workspace/top-tab-close-dialog.test.tsx frontend/app/workspace/top-tab-controller.ts frontend/app/workspace/workspace-command-router.ts frontend/app/workspace/workspace-command-router.test.ts frontend/app/workspace/workspace-app.tsx emain/emain-window.ts emain/emain-window-sender.test.ts emain/emain-quit-coordinator.ts emain/emain-quit-coordinator.test.ts emain/emain.ts emain/preload.ts frontend/types/custom.d.ts
git commit -m "feat: guard dirty top tab close"
```

### Task 7: Replace Block Preview with a workspace Preview runtime

**Files:**
- Create: `frontend/app/workspace/preview-repository.ts`
- Create: `frontend/app/workspace/preview-repository.test.ts`
- Create: `frontend/app/workspace/preview-content.tsx`
- Create: `frontend/app/workspace/preview-content.test.tsx`
- Create: `frontend/app/workspace/preview-top-tab.tsx`
- Create: `frontend/app/workspace/preview-top-tab.test.tsx`
- Modify: `frontend/app/workspace/top-tab-runtime-host.tsx`
- Modify: `frontend/app/view/preview/preview-streaming.tsx`
- Modify: `frontend/app/view/preview/preview-model.tsx`
- Reuse: `frontend/app/view/preview/csvview.tsx`
- Reuse: `frontend/app/element/markdown.tsx`

- [ ] **Step 1: Write failing repository and surface tests**

Test text/Markdown/CSV/image/PDF/media/directory classification, a 2 MiB inline text
limit, `FileInfoCommand`/`FileListCommand`/`FileReadCommand` routing, streaming URL
encoding, stale load fencing, retry, missing file, active-only mount, and no
WOS/Block/TabModel imports.

```ts
const first = repository.load("/repo/readme.md");
const second = repository.load("/repo/image.png");
firstDeferred.resolve(markdownResult);
secondDeferred.resolve(imageResult);
expect(repository.currentPath).toBe("/repo/image.png");
```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run frontend/app/workspace/preview-repository.test.ts frontend/app/workspace/preview-top-tab.test.tsx frontend/app/workspace/top-tab-runtime-host.test.tsx
```

Expected: FAIL because Preview is still Block-scoped.

- [ ] **Step 3: Implement a read-only Preview surface**

The repository is local-workspace-only in Phase 4A and depends only on path-based File
APIs. Use a discriminated result that can represent every supported renderer:

```ts
export type WorkspacePreviewResult =
    | {
          path: string;
          kind: "markdown" | "text" | "csv";
          mimeType: string;
          content: string;
      }
    | {
          path: string;
          kind: "directory";
          mimeType: string;
          entries: FileInfo[];
      }
    | {
          path: string;
          kind: "stream";
          mediaKind: "image" | "pdf" | "video" | "audio";
          mimeType: string;
          url: string;
      }
    | {
          path: string;
          kind: "file-only";
          mimeType: string;
          reason: "too-large" | "unsupported";
      };
```

Call `FileInfoCommand` first. Directories use `FileListCommand`. Inline text-like content
uses `FileReadCommand` only when `FileInfo.size <= 2 * 1024 * 1024`; larger text shows an
explicit “Open as File” action. Image/PDF/video/audio never enter JS memory: build
`/wave/stream-file?path=<encoded absolute path>` with `getWebServerEndpoint()`.
`PreviewContent` renders the `file-only` branch as an explanation plus “Open as File”; it
never calls `FileReadCommand`.

Extract prop-driven renderers from `preview-streaming.tsx`:

```ts
export function StreamingPreviewContent({
    url,
    mimeType,
}: {
    url: string;
    mimeType: string;
}): ReactNode;
```

Keep the legacy `StreamingPreview({ model })` as a thin adapter to this component until
Task 10 deletes the legacy Preview registration. `preview-content.tsx` renders the result
union and owns no model/WOS atoms. Directory rendering receives `entries`; stream elements
release event listeners on unmount and need no object-URL cleanup because the URL is an
HTTP endpoint.

Do not construct `PreviewModel`, `BlockNodeModel`, or fake Block metadata. Editing actions
open the same path as a File Top Tab through the controller. Preview unmounts when inactive;
retry increments a surface-local request generation.

- [ ] **Step 4: Run GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/workspace/preview-repository.ts frontend/app/workspace/preview-repository.test.ts frontend/app/workspace/preview-content.tsx frontend/app/workspace/preview-content.test.tsx frontend/app/workspace/preview-top-tab.tsx frontend/app/workspace/preview-top-tab.test.tsx frontend/app/workspace/top-tab-runtime-host.tsx frontend/app/view/preview/preview-streaming.tsx frontend/app/view/preview/preview-model.tsx
git commit -m "feat: add workspace preview tabs"
```

### Task 8: Make Git Diff descriptor-driven

**Files:**
- Modify: `frontend/app/gitdiff/git-diff-pane.tsx`
- Modify: `frontend/app/gitdiff/git-diff-pane.test.tsx`
- Create: `frontend/app/workspace/git-diff-top-tab.tsx`
- Create: `frontend/app/workspace/git-diff-top-tab.test.tsx`
- Modify: `frontend/app/workspace/top-tab-runtime-host.tsx`

- [ ] **Step 1: Write failing prop-driven tests**

Render staged, unstaged, renamed, loading, empty, error, and retry cases from a Top Tab
descriptor without a `GitDiffViewModel` or Block atom.

```tsx
render(
    <GitDiffTopTab
        tab={{
            id: "diff-1",
            kind: "git-diff",
            repoRoot: "/repo",
            path: "src/app.ts",
            mode: "+",
            originalPath: "src/old.ts",
            title: "app.ts",
        }}
    />
);
expect(loadGitDiffContent).toHaveBeenCalledWith({
    repoRoot: "/repo",
    path: "src/app.ts",
    originalPath: "src/old.ts",
    mode: "+",
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run frontend/app/gitdiff/git-diff-pane.test.tsx frontend/app/workspace/git-diff-top-tab.test.tsx
```

Expected: FAIL because `GitDiffPane` reads Block metadata.

- [ ] **Step 3: Extract `GitDiffContent`**

Keep the object-argument `loadGitDiffContent(input: GitDiffMeta)` contract and
`GitDiffBody`, but make the new surface map the typed descriptor to that object directly.
Fence late RPC responses by request generation and unmount on switch.
The legacy ViewModel may temporarily wrap `GitDiffContent` until Task 10 deletes the legacy
registration.

- [ ] **Step 4: Run GREEN and commit**

Run the command from Step 2. Expected: PASS.

```bash
git add frontend/app/gitdiff/git-diff-pane.tsx frontend/app/gitdiff/git-diff-pane.test.tsx frontend/app/workspace/git-diff-top-tab.tsx frontend/app/workspace/git-diff-top-tab.test.tsx frontend/app/workspace/top-tab-runtime-host.tsx
git commit -m "feat: add workspace git diff tabs"
```

### Task 9: Route every product opener into the controller or right-side Browser

**Files:**
- Create: `frontend/app/rightbrowser/open-right-browser.ts`
- Create: `frontend/app/rightbrowser/open-right-browser.test.ts`
- Create: `frontend/app/fileexplorer/file-explorer-workspace-actions.ts`
- Create: `frontend/app/fileexplorer/file-explorer-workspace-actions.test.ts`
- Modify: `frontend/app/fileexplorer/open-editor-tab.ts`
- Modify: `frontend/app/fileexplorer/open-editor-tab.test.ts`
- Modify: `frontend/app/fileexplorer/file-explorer-model.ts`
- Modify: `frontend/app/fileexplorer/file-explorer-model.test.ts`
- Modify: `frontend/app/fileexplorer/file-explorer.tsx`
- Modify: `frontend/app/fileexplorer/file-explorer-tree.tsx`
- Modify: `frontend/app/sourcecontrol/open-git-diff-tab.ts`
- Modify: `frontend/app/sourcecontrol/open-git-diff-tab.test.ts`
- Create: `frontend/app/sourcecontrol/source-control-workspace-actions.ts`
- Create: `frontend/app/sourcecontrol/source-control-workspace-actions.test.ts`
- Modify: `frontend/app/sourcecontrol/source-control-model.ts`
- Modify: `frontend/app/sourcecontrol/source-control-panel.tsx`
- Modify: `frontend/app/codereview/git-panel.tsx`
- Modify: `frontend/app/modals/commandpalette.tsx`
- Modify: `frontend/util/previewutil.ts`
- Modify: `frontend/app/store/global.ts`
- Modify: `frontend/app/app.tsx`
- Modify: `frontend/app/workspace/widgets.tsx`
- Modify: `frontend/app/workspace/workspace-app.tsx`
- Modify: `frontend/app/workspace/workspace-left-panel.tsx`
- Modify: `frontend/app/workspace/workspace-command-router.ts`
- Modify: `frontend/app/workspace/workspace-command-router.test.ts`
- Create: `frontend/app/workspace/workspace-open-content-events.ts`
- Create: `frontend/app/workspace/workspace-open-content-events.test.ts`
- Modify: `frontend/app/view/webview/webview.tsx`
- Modify: `frontend/app/notifications/notifications-model.ts`
- Create: `frontend/app/store/workspace-command-client.ts`
- Create: `frontend/app/store/workspace-command-client.test.ts`
- Create: `frontend/app/terminal/terminal-workspace-command-boundary.test.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `emain/emain-ipc.ts`
- Modify: `emain/emain-window-sender.ts`
- Modify: `emain/emain-window-sender.test.ts`
- Modify: `pkg/wps/wpstypes.go`
- Modify: `pkg/tsgen/tsgenevent.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_test.go`
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Generate: `frontend/types/gotypes.d.ts`
- Generate: `frontend/types/waveevent.d.ts`

- [ ] **Step 1: Rewrite opener tests to prohibit legacy calls**

For Workspace-owned File/Preview/Diff launchers, assert the typed controller method.
For Terminal/global launchers, assert the typed `sendWorkspaceCommand`; separately assert
that `WorkspaceCommandRouter` routes `open-url` to `openUrlInRightBrowser`. Explicitly
assert that `CreateTabWithBlock`, `createBlock`, and Electron `setActiveTab` are not called.

```ts
await openFileInEditorTab("/repo/app.ts", controller);
expect(controller.openFile).toHaveBeenCalledWith("/repo/app.ts");
expect(mockServices.CreateTabWithBlock).not.toHaveBeenCalled();
expect(mockElectron.setActiveTab).not.toHaveBeenCalled();
```

```ts
openUrlInRightBrowser("https://example.com", layoutModel, rightBrowserModel);
expect(layoutModel.openRightTool).toHaveBeenCalledWith("browser");
expect(rightBrowserModel.newTab).toHaveBeenCalledWith("https://example.com", true);
```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run frontend/app/rightbrowser/open-right-browser.test.ts frontend/app/store/workspace-command-client.test.ts frontend/app/terminal/terminal-workspace-command-boundary.test.ts frontend/app/workspace/workspace-command-router.test.ts frontend/app/fileexplorer frontend/app/sourcecontrol frontend/app/codereview frontend/app/modals frontend/app/notifications emain/emain-window-sender.test.ts
```

Expected: FAIL because the old helpers scan Tabs/Blocks and create Wave Tabs.

- [ ] **Step 3: Route all known entry points**

Extend `WorkspaceCommand` with serializable commands:

```ts
type WorkspaceCommand =
    | { type: "open-url"; url: string }
    | { type: "open-file"; path: string }
    | { type: "open-preview"; path: string }
    | {
          type: "open-git-diff";
          repoRoot: string;
          path: string;
          mode: "+" | "-";
          originalPath?: string;
      }
    | ExistingWorkspaceCommand;
```

`workspace-command-client.ts` validates inputs and calls only
`getApi().sendWorkspaceCommand(command)`. Electron main validates the sender's window and
forwards the command to that window's unique WorkspaceView through
`emain-window-sender.ts`. The Workspace router invokes the Top Tab controller or
`openUrlInRightBrowser`. Terminal renderer code, `global.openLink`, widgets, notification
deep links, and any launcher that may execute outside Workspace use this client and never
import `rightbrowser`, `WorkspaceLayoutModel`, or Workspace React modules. The Terminal
boundary test statically proves that the client dependency graph contains no Browser,
Monaco, Preview, or Workspace UI module.

Use the controller for:

- File Explorer open, rename, delete, and reveal;
- Source Control and Code Review Git Diff;
- Command Palette and preview utilities;
- notification/deep-link targets that identify Top Tabs.

For Source Control, define `SourceControlWorkspaceActions { openGitDiff(input): void }`.
`SourceControlPanel` obtains the current Top Tab controller from context, binds the action
to the renderer-local `SourceControlModel` on mount, and unbinds it on workspace
replacement. `selectEntry()` calls the bound action and reports a visible error if none is
bound. Code Review is React-owned and calls the controller context directly. Tests cover
replacement from workspace A to B and prove no stale controller receives the open.

Define and inject the Workspace-local File Explorer boundary:

```ts
export interface FileExplorerWorkspaceActions {
    openFile(path: string): Promise<void>;
    renamePath(oldPath: string, newPath: string): Promise<boolean>;
    deletePath(path: string): Promise<boolean>;
    createTerminal(cwd: string): Promise<void>;
}
```

`WorkspaceAppInner` creates this adapter from its Top Tab controller, close coordinator,
editor/runtime registries, and Terminal navigation adapter. Pass it through
`WorkspaceLeftPanel` to `FileExplorer`; `FileExplorer` binds it to the renderer-local
`FileExplorerModel` for the mounted workspace and unbinds it on replacement. Context-menu
callbacks in `file-explorer-tree.tsx` call only these model methods. This prevents the
global File Explorer singleton from trying to discover Workspace-local services.

Create `openUrlInRightBrowser(url, layoutModel, rightBrowserModel)`. It validates an
`http(s)` URL, calls `layoutModel.openRightTool("browser")`, and opens/activates a tab
through `RightBrowserModel.newTab(url, true)`. Route clipboard URL, `openLink`, widgets,
and legacy WebView popup actions through this helper. This helper is the only Browser
change in the phase; it does not create a Browser Top Tab or add Browser persistence.
Only `WorkspaceCommandRouter` imports and calls this helper; Terminal/global launchers send
`{type:"open-url"}` across the existing preload → main → WorkspaceView route.

Change File Explorer “terminal at directory” to `TerminalNavigation.create({ cwd })`; it is
not a Top Tab.

Before changing `PathCommand(openInternal)`, read
`.kilocode/skills/wps-events/SKILL.md`. Define a typed `workspace:open-content` WPS event:

```go
type WorkspaceOpenContentEvent struct {
    WorkspaceId string `json:"workspaceid"`
    Kind        string `json:"kind"`
    Path        string `json:"path"`
    RequestId   string `json:"requestid"`
}
```

For `wsh wavepath --open`, resolve `PathCommandData.TabId` to its owning Workspace,
validate that it is a registered Terminal Tab, and publish the event to
`workspace:<workspaceId>`. Return after the event is accepted by WPS; UI activation is
asynchronous. `WorkspaceApp` subscribes for its exact workspace identity and generation,
deduplicates `requestid`, validates `kind == "preview"` and an absolute path, then calls
`controller.openPreview(path)`. Tests cover unknown/legacy Tab ID, cross-workspace event,
duplicate request ID, stale generation, and renderer disposal. Run `task generate` after
adding the Go payload type. Add the event constant to `pkg/wps/wpstypes.go` and
`AllEvents`, map its payload in `pkg/tsgen/tsgenevent.go`, and commit the generated
`frontend/types/waveevent.d.ts` so `waveEventSubscribeSingle` is typed.

For a file or directory rename/delete, normalize the target and collect every affected
File runtime plus every File/Preview descriptor whose path is the target or has the target
plus `/` as a prefix. Run a batch two-phase guard over every dirty affected File:

1. Collect all decisions without mutation. Any Cancel stops before filesystem mutation and
   leaves every buffer unchanged.
2. Execute every Save; any failure stops before Discard/filesystem mutation.
3. Apply all Discards only after every Save succeeds.
4. Rename calls the filesystem RPC once, then migrates every descendant File runtime and
   updates every descendant File/Preview descriptor by prefix substitution. If local
   migration fails after filesystem success, perform a best-effort reverse rename, restore
   all old runtime/descriptor identities, and surface an error.
5. Delete calls the filesystem RPC once, then disposes and closes every affected
   File/Preview Top Tab. A filesystem failure leaves every runtime/descriptor path and
   existence relationship unchanged; Save/Discard decisions that the user already
   confirmed remain applied.

Serialize path mutations through one File Explorer mutation tail so parent/child operations
cannot interleave. Tests cover multiple dirty descendants, Discard followed by Cancel,
Save failure, filesystem failure, successful prefix migration, and reverse-rename
compensation.

- [ ] **Step 4: Run GREEN and commit**

Run the command from Step 2 plus:

```bash
task generate
go test ./pkg/wshrpc/wshserver
rg -n 'CreateTabWithBlock|SetActiveTab|setActiveTab\\(|createBlock\\(' frontend pkg emain cmd
rg -n 'view: "(codeeditor|preview|web|gitdiff)"|MetaKey_View.*"(codeeditor|preview|web|gitdiff)"' frontend pkg emain cmd
```

Expected: tests PASS. Record every remaining match in the Task 10 deletion inventory;
allowed matches must be explicit builder fixtures or Terminal-compatible code. Do not use
a same-line `createBlock.*view` pattern because current calls span multiple lines.

```bash
git add frontend/app/rightbrowser/open-right-browser.ts frontend/app/rightbrowser/open-right-browser.test.ts frontend/app/fileexplorer frontend/app/sourcecontrol frontend/app/codereview/git-panel.tsx frontend/app/modals/commandpalette.tsx frontend/util/previewutil.ts frontend/app/store/global.ts frontend/app/store/workspace-command-client.ts frontend/app/store/workspace-command-client.test.ts frontend/app/app.tsx frontend/app/terminal/terminal-workspace-command-boundary.test.ts frontend/app/workspace/widgets.tsx frontend/app/workspace/workspace-app.tsx frontend/app/workspace/workspace-left-panel.tsx frontend/app/workspace/workspace-command-router.ts frontend/app/workspace/workspace-command-router.test.ts frontend/app/workspace/workspace-open-content-events.ts frontend/app/workspace/workspace-open-content-events.test.ts frontend/app/view/webview/webview.tsx frontend/app/notifications/notifications-model.ts frontend/types/custom.d.ts emain/emain-ipc.ts emain/emain-window-sender.ts emain/emain-window-sender.test.ts pkg/wps/wpstypes.go pkg/tsgen/tsgenevent.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshserver/wshserver_test.go pkg/wshrpc/wshrpctypes.go frontend/types/gotypes.d.ts frontend/types/waveevent.d.ts
git commit -m "refactor: route content into top tabs"
```

### Task 10: Delete the non-Terminal Wave Tab architecture

**Files:**
- Modify/Delete: `frontend/app/tab/tabbar.tsx`
- Modify/Delete: `frontend/app/tab/tabbarenv.ts`
- Modify/Delete: `frontend/app/tab/tabbar-model.ts`
- Modify/Delete: `frontend/app/tab/vtabbar.tsx`
- Modify/Delete: `frontend/app/tab/vtabbarenv.ts`
- Modify/Delete: `frontend/app/tab/vtab-detail-sidecar.tsx`
- Modify/Delete: `frontend/app/tab/vtab-settings-popover.tsx`
- Delete: `frontend/preview/previews/tabbar.preview.tsx`
- Delete: `frontend/preview/previews/vtabbar.preview.tsx`
- Modify: `frontend/app/tab/workspaceswitcher.tsx`
- Modify: `frontend/app/topbar/topbar.tsx`
- Modify: `frontend/app/store/keymodel.ts`
- Modify: `frontend/app/store/services.ts`
- Modify: `frontend/app/store/wshrpcutil.ts`
- Modify: `frontend/app/block/blockregistry.ts`
- Modify: `frontend/app/legacy/legacy-bootstrap.ts`
- Modify: `frontend/renderer-entry.ts`
- Modify: `emain/emain-renderer-identity.ts`
- Modify: `emain/emain-tabview.ts`
- Modify: `emain/emain-window.ts`
- Modify: `emain/emain.ts`
- Modify: `emain/emain-ipc.ts`
- Modify: `emain/preload.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `pkg/service/workspaceservice/workspaceservice.go`
- Modify: `pkg/service/workspaceservice/workspaceservice_test.go`
- Modify: `pkg/wcore/workspace.go`
- Modify: `pkg/wcore/workspace_test.go`
- Modify: `pkg/wcore/window.go`
- Modify: `pkg/wcore/window_test.go`
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `cmd/wsh/cmd/wshcmd-workspace.go`
- Generate: `frontend/app/store/wshclientapi.ts`
- Generate: `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Add hard-cut tests before deletion**

Test that:

- renderer identity fails closed for a non-Terminal Tab;
- no non-Terminal action creates a `WaveTabView`;
- legacy `set-active-tab/create-tab/close-tab` IPC is absent;
- Workspace switcher never lists or activates legacy Tabs;
- new-domain generic Tab create/activate/close APIs are removed;
- the old TabBar preview entries no longer participate in `import.meta.glob`;
- `CheckAndFixWindow` never creates a legacy starter Tab for a version-1 Workspace;
- Terminal Tab/Block/LayoutState behavior remains intact;
- unsaved Workspace detection considers Top Tabs, Terminal Tabs, and Agent state rather
  than `tabids.length`.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run frontend/renderer-entry.test.ts emain/emain-renderer-identity.test.ts emain/emain-window-sender.test.ts frontend/app/tab/workspaceswitcher.test.ts
go test ./pkg/wcore ./pkg/service/workspaceservice ./pkg/wshrpc/wshserver
```

Expected: FAIL while legacy renderer and generic APIs remain reachable.

- [ ] **Step 3: Remove legacy frontend and Electron paths**

Remove old horizontal/vertical Tab chrome and `TopBar.showTabs`. Keep
`TerminalTabList`. Keep Workspace switcher itself, but remove its child Tab listing and
`setActiveTab/closeTab` actions. Register Workspace shortcuts against
`WorkspaceCommandRouter`; do not call `getLayoutModelForStaticTab`.

Split Builder bootstrap away from legacy Wave bootstrap before deleting the legacy Wave
renderer route. Make renderer identity fail closed when a requested Tab is not in
`terminaltabids`. Remove legacy switch/create/close Electron actions and preload APIs.
Retain `WaveTabView` and child view management only for Terminal; rename generic cache
methods only when that makes their Terminal-only contract explicit. Delete the old
TabBar/VTab preview modules so preview glob compilation cannot retain deleted chrome.

Remove `codeeditor`, `preview`, `gitdiff`, and `web` registrations from the generic Block
registry after their callers move. Delete the corresponding Block-scoped ViewModel adapter
only when `rg` proves that no builder/right-tool/standalone consumer remains; the new
prop-driven leaf components stay.

- [ ] **Step 4: Remove generic backend mutation APIs**

Remove new-domain-obsolete `CreateTab`, `CreateTabWithBlock`, `SetActiveTab`, `CloseTab`,
and `UpdateWorkspaceTabIds` public RPC/command routes after confirming no non-builder
consumer. `WorkspaceService.CloseTab` is legacy-only because registered Terminal Tabs are
already required to close through the Terminal service.
Remove their `WorkspaceService` frontend methods and tests. Replace
`pkg/wcore/window.go` legacy starter creation with the version-1 invariant: a new Workspace
starts with zero Terminal Tabs and Agent active. Legacy version-0 data is adopted at
startup and never repaired by creating a generic Tab.
Keep `Tab`, `Block`, `LayoutState`, Terminal domain functions, object guards, and portable
Terminal layout support. Run `task generate`.

Before deletion, capture the complete caller inventory with:

```bash
rg -n 'WorkspaceService\\.(CreateTab|CreateTabWithBlock|SetActiveTab|CloseTab)' frontend emain
rg -n 'getApi\\(\\)\\.(setActiveTab|createTab|closeTab)|"(set-active-tab|create-tab|close-tab)"' frontend emain
rg -n 'UpdateWorkspaceTabIdsCommand|\\b(CreateTab|CreateTabWithBlock|SetActiveTab|CloseTab|UpdateWorkspaceTabIds)\\(' pkg cmd
rg -n 'registerBlockViewModel\\("(codeeditor|preview|web|gitdiff)"' frontend/app
```

After deletion and generation, the first three commands must return no matches. The fourth
must return no matches. Content fixtures that merely contain `view:"preview|web|gitdiff|
codeeditor"` are not a production creation/registration gate and may remain in isolated
tests until their owning component is deleted.

- [ ] **Step 5: Run GREEN and commit**

Run:

```bash
task generate
npx vitest run frontend/renderer-entry.test.ts emain/emain-renderer-identity.test.ts emain/emain-window-sender.test.ts frontend/app/tab/workspaceswitcher.test.ts frontend/app/workspace frontend/app/terminal
go test ./pkg/wcore ./pkg/service/workspaceservice ./pkg/service/objectservice ./pkg/wshrpc/wshserver
```

Expected: PASS.

```bash
git add -A
git commit -m "refactor: remove non-terminal wave tabs"
```

### Task 11: Add performance tracing, recovery coverage, and final documentation

**Files:**
- Create: `frontend/app/workspace/top-tab-performance.ts`
- Create: `frontend/app/workspace/top-tab-performance.test.ts`
- Modify: `frontend/app/workspace/workspace-app.test.tsx`
- Modify: `frontend/app/workspace/workspace-model.test.ts`
- Modify: `emain/emain-workspaceview.test.ts`
- Modify: `docs/superpowers/specs/2026-07-23-workspace-tab-architecture-design.md`
- Modify: `docs/agent-rendering-architecture.md`
- Modify: `docs/agent-runtime-architecture.md`

- [ ] **Step 1: Add final invariant and recovery tests**

Cover:

- File/Preview/Git Diff open, activate, reorder, close, and restore;
- only restored active Top Tab warms;
- File path/order/selection restore without dirty buffer/view state;
- Preview/Diff unmount and reload;
- malformed descriptor isolation;
- checkpoint failure retry and stale intent replay;
- Agent → Terminal → each Top Tab → Agent keeps one Workspace renderer;
- zero Terminal operation;
- workspace replacement disposes File runtime resources;
- no non-Terminal Top Tab has a backend Tab/Block/LayoutState.
- URL launchers open the existing right-side Browser and never create a Top Tab or Wave
  Tab.

- [ ] **Step 2: Add narrow tracing**

Record development-only marks for `top-tab-open`, `top-tab-activate`,
`top-tab-first-content`, and `workspace-checkpoint-error`. Do not emit file contents or
user data; use kind, opaque ID, and duration.

- [ ] **Step 3: Run the complete automated gate**

Run:

```bash
git diff --check
npx prettier --check frontend/app/workspace frontend/app/fileexplorer frontend/app/sourcecontrol frontend/app/gitdiff frontend/app/rightbrowser emain
gofmt -l pkg/waveobj pkg/service/workspaceservice pkg/wcore pkg/wshrpc/wshserver cmd/wsh/cmd | awk 'BEGIN { clean=1 } { print; clean=0 } END { exit clean ? 0 : 1 }'
npx vitest run frontend/app/workspace frontend/app/fileexplorer frontend/app/sourcecontrol frontend/app/gitdiff frontend/app/codereview frontend/app/notifications frontend/renderer-entry.test.ts emain/emain-workspaceview.test.ts emain/emain-workspace-surface.test.ts emain/emain-terminal-surface.test.ts emain/emain-renderer-identity.test.ts emain/emain-window-sender.test.ts
go test ./pkg/service/workspaceservice ./pkg/wcore ./pkg/service/objectservice ./pkg/wshrpc/wshserver
npm run build:dev
```

Expected: all tests and build pass. Existing optional image optimizer warnings may remain;
new runtime or chunk-order errors are not acceptable.

- [ ] **Step 4: Perform Electron runtime smoke**

Verify manually:

1. Open, switch, reorder, close, and restore File, Preview, and Git Diff Top Tabs.
2. Edit a File, then verify Save / Discard / Cancel from Tab close, Cmd+W, workspace
   switch, and window close.
3. Open URLs from clipboard, links, and widgets; verify the existing right-side Browser
   opens and no Browser Top Tab or Wave Tab is created.
4. Switch Agent → Terminal → File → Preview → Diff repeatedly; verify TopBar,
   left panel, right panel, and Agent DOM do not remount or flicker.
5. Close every Terminal; verify Agent and all Top Tabs remain usable.
6. Restart; verify File/Preview/Diff descriptors, order, paths, and last selection restore
   while runtime caches and dirty buffers do not.

- [ ] **Step 5: Update status and commit**

Mark Phase 2 complete after the accepted Terminal smoke. Mark File/Preview/Git Diff
production Top Tabs implemented after this smoke passes, and record Browser Top Tabs as a
deferred follow-up that currently remains in the right-side Browser tool. Do not mark the
long-term Browser Top Tab requirement complete.

```bash
git add frontend/app/workspace/top-tab-performance.ts frontend/app/workspace/top-tab-performance.test.ts frontend/app/workspace/workspace-app.test.tsx frontend/app/workspace/workspace-model.test.ts emain/emain-workspaceview.test.ts docs/superpowers/specs/2026-07-23-workspace-tab-architecture-design.md docs/agent-rendering-architecture.md docs/agent-runtime-architecture.md
git commit -m "test: verify workspace top tab cutover"
```

## Final review gate

After Task 11:

1. Dispatch a spec-compliance reviewer against Sections 8, 9, 12, 13, 15, 16, and 17 of
   `docs/superpowers/specs/2026-07-23-workspace-tab-architecture-design.md`.
2. Fix every must-fix finding in a dedicated commit.
3. Dispatch a fresh code-quality reviewer over the complete Phase 4A commit range.
4. Fix every actionable finding and rerun the complete automated gate.
5. Confirm `git status --short` is empty and provide the exact Phase 4A commit range for
   final integration.
