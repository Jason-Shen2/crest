# Workspace Terminal Renderer Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 1 Terminal placeholders with an authoritative Terminal-only tab domain, a real left-side TerminalTabList, and Terminal-only renderers hosted exclusively inside the Workspace central content bounds.

**Architecture:** Workspace owns navigation and chrome. The backend publishes `terminaltabids` and `activeterminaltabid` as the only trusted Terminal navigation state; legacy `tabids/activetabid` remain isolated until later migration phases. Each Terminal keeps its existing WaveTabView process, layout, panes, and PTY state, but boots through a narrow `TerminalApp` and is activated by a dedicated surface controller that never renders outside the Workspace central content rectangle.

**Tech Stack:** Go WaveObj/SQLite transactions/WshRPC/WPS, Electron WebContentsView/IPC, React 19/Jotai, Vitest, Go test.

---

## Scope Decisions

- `TerminalTabList` is a Tabs-only projection. It reuses the current vertical row visuals, search, rename, close, context menu, drag reorder, and auto-scroll behavior.
- Pane detail sidecar and Tabs/Panes list modes do not move into Workspace. Pane split/focus/magnify remain inside the active Terminal renderer.
- A new Terminal Tab may contain only `term` and `termblocks` compatible blocks. Historical mixed Tabs remain legacy and never enter `terminaltabids`.
- Closing the final Terminal leaves the Workspace window open and falls back to the last Top Tab or Agent.
- A newly created Workspace starts with zero Terminal Tabs and Agent active. Terminal creation is explicit; the legacy starter Tab is not created.
- Phase 2 does not migrate Agent, File, Browser, Preview, or Diff runtimes.

## File Structure

- `pkg/service/workspaceservice/terminaltabs.go`: authoritative Terminal create/rename/close/reorder operations and membership validation.
- `pkg/service/workspaceservice/terminaltabs_test.go`: transaction, ordering, zero-Terminal, and mixed-legacy tests.
- `pkg/wcore/terminaldomain.go`: dependency-safe Terminal membership and compatible-view checks used by existing write transactions.
- `pkg/wcore/workspace.go`: zero-Terminal Workspace bootstrap.
- `pkg/wcore/window.go`, `pkg/wcore/layout.go`: prevent window repair and starter-layout onboarding from recreating a legacy Tab for new-domain Workspaces.
- `pkg/wshrpc/wshrpctypes.go`, `pkg/wshrpc/wshserver/wshserver.go`: generated RPC surface for Terminal mutations.
- `pkg/waveobj/wtype.go`: persisted `terminaltabids` Workspace field.
- `frontend/app/workspace/terminal-navigation.ts`: narrow adapter over generated RPC calls and WorkspaceModel.
- `frontend/app/workspace/workspace-terminal-sync.ts`: identity-scoped WOS reconciliation for remote Terminal inventory updates.
- `frontend/app/workspace/terminal-tab-list.tsx`: Terminal list controller, search, empty state, and DnD.
- `frontend/app/workspace/terminal-tab-row.tsx`: Terminal-only row projection using reusable VTab presentation.
- `frontend/app/workspace/terminal-tab-listenv.ts`: exact WaveEnv dependency narrowing.
- `frontend/app/workspace/terminal-tab-list.test.tsx`: list behavior tests.
- `frontend/app/workspace/workspace-model.ts`: `terminalTabIdsAtom` and atomic navigation hydration/checkpoint behavior.
- `frontend/app/terminal/terminal-app.tsx`: renderer root containing only Terminal layout dependencies.
- `frontend/app/terminal/terminal-bootstrap.ts`: Terminal-only renderer initialization.
- `frontend/app/terminal/terminal-import-boundary.test.ts`: prevents Workspace/Agent/Web/Monaco imports from entering Terminal bootstrap.
- `emain/emain-terminal-surface.ts`: latest-desired Terminal renderer activation, cold init, visibility, and focus state machine.
- `emain/emain-terminal-surface.test.ts`: fake-view state-machine tests.
- `emain/emain-window.ts`, `emain/emain-workspace-surface.ts`: connect the controller to authenticated Workspace surface messages.
- `frontend/types/custom.d.ts`, `emain/preload.ts`, `frontend/preview/preview-electron-api.ts`: typed main-to-Workspace Terminal surface status subscription.

### Task 0: Transaction-safe Terminal Domain Primitives

**Files:**
- Create: `pkg/wcore/terminaldomain.go`
- Create: `pkg/wcore/terminaldomain_test.go`
- Modify: `pkg/wcore/block.go`
- Modify: `pkg/wcore/layout.go`

- [ ] **Step 1: Write failing primitive tests**

Within an existing `wstore.TxWrap`, test membership lookup, compatible-view validation, pure Terminal Tab creation, full-subtree validation before portable restore, and rollback without partial Block/Layout writes.

- [ ] **Step 2: Verify RED**

Run:

```bash
go test ./pkg/wcore -run TestTerminalDomainPrimitive
```

- [ ] **Step 3: Extract transaction-aware helpers**

Implement helpers that accept the caller’s transaction instead of opening nested transactions:

```go
func IsTerminalCompatibleView(view string) bool
func ValidateTerminalTabMutation(tx *wstore.TxWrap, workspaceId string, tabId string, views []string) error
func CreateTerminalTabInTx(tx *wstore.TxWrap, workspaceId string, opts TerminalTabCreateOpts) (string, error)
func DeleteTerminalTabInTx(tx *wstore.TxWrap, workspaceId string, tabId string) error
```

`TerminalTabCreateOpts` belongs to `wcore` and contains only the initial name, connection, and cwd needed to create the first Terminal-compatible Block. Portable restore parses and validates its complete subtree before its first write. Existing legacy mutations keep their current behavior.

- [ ] **Step 4: Verify GREEN and commit**

```bash
go test ./pkg/wcore -run TestTerminalDomainPrimitive
git add pkg/wcore
git commit -m "refactor: add terminal domain transaction primitives"
```

### Task 1: Authoritative Terminal Tab Inventory

**Files:**
- Modify: `pkg/waveobj/wtype.go`
- Modify: `pkg/wcore/workspace.go`
- Modify: `pkg/wcore/window.go`
- Modify: `pkg/wcore/layout.go`
- Modify: `pkg/service/workspaceservice/checkpoint.go`
- Create: `pkg/service/workspaceservice/terminaltabs.go`
- Create: `pkg/service/workspaceservice/terminaltabs_test.go`

- [ ] **Step 1: Write failing backend tests**

Add tests that create a Workspace containing pure Terminal Tabs and a legacy mixed Tab, then assert:

```go
require.Equal(t, []string{termA, termB}, ws.TerminalTabIds)
require.NotContains(t, ws.TerminalTabIds, mixedTab)
```

Cover complete-permutation reorder, duplicate/foreign/mixed IDs, rename, closing the active Terminal, and closing the final Terminal without deleting the Workspace or Window. Assert that new Workspace/onboarding flows create zero Terminals, Agent-active content, and no orphan legacy starter Tab. Run `CheckAndFixWindow`, starter-layout onboarding, close/reopen, and repeat the assertion. Reload the committed state and verify that no checkpoint references a removed Terminal.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
go test ./pkg/service/workspaceservice -run 'TestTerminalTab'
```

Expected: FAIL because `Workspace.TerminalTabIds` and Terminal operations do not exist.

- [ ] **Step 3: Add the persisted inventory**

Add to `waveobj.Workspace`:

```go
TabDomainVersion int      `json:"tabdomainversion,omitempty"`
TerminalTabIds  []string `json:"terminaltabids,omitempty"`
```

Define `CurrentTabDomainVersion = 1`. Every new Workspace writes version 1 before window repair/onboarding. Version 0 means legacy and retains legacy starter-Tab repair; version 1 permits an intentionally empty Terminal inventory and never synthesizes a legacy Tab. Keep `TabIds` and `ActiveTabId` unchanged for legacy data. Extend checkpoint normalization so `ActiveTerminalTabId` must be empty or a member of normalized `TerminalTabIds`. Test JSON/database roundtrip for version 1 plus an empty inventory.

Define the authoritative DTO in `workspaceservice`:

```go
type WorkspaceCheckpoint struct {
    WorkspaceId         string                        `json:"workspaceid"`
    NavigationRevision  int64                         `json:"navigationrevision"`
    TerminalTabIds      []string                      `json:"terminaltabids"`
    ContentState        waveobj.WorkspaceContentState `json:"contentstate"`
    ActiveTerminalTabId string                        `json:"activeterminaltabid,omitempty"`
}
```

Return fresh slices/objects and validate exact workspace identity on every consumer.

- [ ] **Step 4: Implement transaction-safe operations**

Implement `WorkspaceService` methods with these contracts:

```go
func (svc *WorkspaceService) CreateTerminalTab(ctx context.Context, data TerminalTabCreateData) (*WorkspaceCheckpoint, error)
func (svc *WorkspaceService) RenameTerminalTab(ctx context.Context, data TerminalTabRenameData) error
func (svc *WorkspaceService) CloseTerminalTab(ctx context.Context, data TerminalTabMutationData) (*WorkspaceCheckpoint, error)
func (svc *WorkspaceService) ReorderTerminalTabs(ctx context.Context, data TerminalTabReorderData) (*WorkspaceCheckpoint, error)
```

Each navigation mutation takes `expectedrevision`. Inside one `wstore.TxWrap` transaction it validates membership, mutates `terminaltabids`, normalizes `contentstate + activeterminaltabid`, increments `navigationrevision`, and returns the authoritative checkpoint. `ReorderTerminalTabs` accepts only an exact permutation. `CloseTerminalTab` chooses neighbor Terminal, then last Top Tab, then Agent and never invokes the legacy “last Tab closes window” path. A failed transaction leaves Tab, Layout, Blocks, inventory, and navigation tuple unchanged.

Use Task 0’s transaction-aware create/delete/validation primitives; do not duplicate lower-level Tab/Layout/Block writes. `CheckAndFixWindow` and starter-layout bootstrap distinguish new-domain Workspaces from legacy Workspaces and never synthesize a legacy Tab when the new-domain inventory is intentionally empty.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
go test ./pkg/service/workspaceservice -run 'TestTerminalTab|TestSaveWorkspaceCheckpoint'
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pkg/waveobj/wtype.go pkg/wcore/workspace.go pkg/wcore/window.go pkg/wcore/layout.go pkg/service/workspaceservice/checkpoint.go pkg/service/workspaceservice/terminaltabs.go pkg/service/workspaceservice/terminaltabs_test.go
git commit -m "feat: add authoritative terminal tab inventory"
```

### Task 2: Terminal RPC and Workspace Model

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Regenerate: `frontend/types/gotypes.d.ts`
- Regenerate: `frontend/app/store/wshclientapi.ts`
- Modify: `frontend/app/workspace/workspace-model.ts`
- Modify: `frontend/app/workspace/workspace-model.test.ts`
- Create: `frontend/app/workspace/terminal-navigation.ts`
- Create: `frontend/app/workspace/terminal-navigation.test.ts`
- Create: `frontend/app/workspace/workspace-terminal-sync.ts`
- Create: `frontend/app/workspace/workspace-terminal-sync.test.ts`

- [ ] **Step 1: Write failing model and adapter tests**

Assert that hydration loads the full Terminal inventory, activation rejects IDs outside it, and create/close/reorder apply the authoritative checkpoint returned by RPC. Add remote WOS update tests for add/remove/reorder, stale revision rejection, old-workspace identity rejection, and teardown. Cover pending debounced selection followed by create, RPC-response/WOS event reordering, two concurrent mutations, and equal-revision/non-equal-content rejection.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-model.test.ts frontend/app/workspace/terminal-navigation.test.ts frontend/app/workspace/workspace-terminal-sync.test.ts
```

Expected: FAIL because `terminalTabIdsAtom` and Terminal RPC adapter are absent.

- [ ] **Step 3: Define RPC commands**

Add generated RPC methods and lowercase JSON payloads:

```go
WorkspaceCreateTerminalCommand(ctx context.Context, data WorkspaceCreateTerminalData) (*WorkspaceCheckpoint, error)
WorkspaceRenameTerminalCommand(ctx context.Context, data WorkspaceRenameTerminalData) error
WorkspaceCloseTerminalCommand(ctx context.Context, data WorkspaceTerminalData) (*WorkspaceCheckpoint, error)
WorkspaceReorderTerminalsCommand(ctx context.Context, data WorkspaceReorderTerminalsData) (*WorkspaceCheckpoint, error)
```

Make create/close/reorder return `WorkspaceCheckpoint`, include `expectedrevision` in their payloads, and implement them in `wshserver` by delegating to the `WorkspaceService` methods. Register the service methods through the project’s existing generated service metadata rather than inventing package-level bridge functions.

- [ ] **Step 4: Generate bindings**

Run:

```bash
task generate
```

Do not manually edit generated files.

- [ ] **Step 5: Add the Workspace owner state**

Add:

```ts
terminalTabIdsAtom: jotai.PrimitiveAtom<string[]>;
```

Hydrate it from `workspace.terminaltabids`. `WorkspaceTerminalSync` subscribes to the current Workspace WaveObj atom, applies only matching workspace identity with a strictly newer authoritative navigation revision, reconciles `terminalTabIdsAtom`, `activeTerminalTabIdAtom`, and `contentStateAtom` together, and unsubscribes before workspace replacement or teardown. Equal revision is accepted only as an idempotent deep-equal snapshot; equal-but-different and older snapshots are rejected. Make `makeTerminalNavigationAdapter` return this full list instead of inferring membership from legacy `tabids`.

- [ ] **Step 6: Implement the narrow adapter**

Expose typed `select`, `create`, `rename`, `close`, and `reorder` operations through one per-Workspace navigation queue. Before a structural mutation, await/flush any pending selection checkpoint so the server and client revisions agree. Create/close/reorder then send that committed revision and apply the returned checkpoint only if its identity matches and its revision is newer than current, or equal and deep-equal; they do not perform a second checkpoint write. Rename updates only Tab metadata. Serialize concurrent structural mutations. On stale revision, reload the Workspace WaveObj and reconcile before allowing a retry.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-model.test.ts frontend/app/workspace/workspace-command-router.test.ts frontend/app/workspace/terminal-navigation.test.ts frontend/app/workspace/workspace-terminal-sync.test.ts
go test ./pkg/wshrpc/wshserver ./pkg/service/workspaceservice
```

Then:

```bash
git add pkg/wshrpc pkg/waveobj frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts frontend/app/workspace
git commit -m "feat: expose terminal workspace navigation"
```

### Task 3: TerminalTabList

**Files:**
- Create: `frontend/app/workspace/terminal-tab-listenv.ts`
- Create: `frontend/app/workspace/terminal-tab-row.tsx`
- Create: `frontend/app/workspace/terminal-tab-list.tsx`
- Create: `frontend/app/workspace/terminal-tab-list.test.tsx`
- Modify: `frontend/app/workspace/workspace-left-panel.tsx`
- Modify: `frontend/app/workspace/workspace.tsx`
- Modify: `frontend/app/workspace/workspace.test.tsx`
- Reuse: `frontend/app/tab/vtab.tsx`

- [ ] **Step 1: Write failing component tests**

Cover:

```text
renders only terminalTabIds
selects without calling electron.setActiveTab
supports new, rename, close, and exact same-group reorder
disables reorder while search filters the list
shows New Terminal empty state after the final close
does not render pane sidecar or non-Terminal type probes
preserves Files/Sessions/Terminals mutual exclusion, second-click collapse, shared width, and persisted mode
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run frontend/app/workspace/terminal-tab-list.test.tsx frontend/app/workspace/workspace.test.tsx
```

Expected: FAIL because the left panel still renders the Phase 2 placeholder.

- [ ] **Step 3: Extract only reusable presentation**

Use `VTab`/`VTabItem` for row visuals. Do not import `VTabBar`, `VTabBarEnv`, file-label probing, pane sidecar, or `UpdateWorkspaceTabIdsCommand`.

- [ ] **Step 4: Implement TerminalTabList**

The component receives `terminalTabIds`, `activeTerminalTabId`, row projections, and a Terminal navigation adapter. Keep local query and drag-preview state; the model remains authoritative after each mutation.

- [ ] **Step 5: Replace the placeholder**

Change `WorkspaceLeftPanel` so the `terminals` branch renders the injected `TerminalTabList`. Files and Sessions behavior and the shared left-panel width remain unchanged.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npx vitest run frontend/app/workspace/terminal-tab-list.test.tsx frontend/app/workspace/workspace.test.tsx frontend/app/topbar/topbar.test.tsx
```

Then:

```bash
git add frontend/app/workspace frontend/app/tab/vtab.tsx
git commit -m "feat: add workspace terminal tab list"
```

### Task 4: Enforce the Terminal-only Block Boundary

**Files:**
- Modify: `pkg/wcore/terminaldomain.go`
- Modify: `pkg/wcore/block.go`
- Modify: `pkg/wcore/layout.go`
- Modify: `pkg/service/workspaceservice/terminaltabs.go`
- Modify: `pkg/wcore/terminaldomain_test.go`

- [ ] **Step 1: Write failing domain tests**

For a Tab registered in `terminaltabids`, assert that `CreateBlock`, `CreateSubBlock`, and portable layout restore accept `term`/`termblocks` but reject `web`, `preview`, `codeeditor`, `agent`, and unknown view types. Assert that the same legacy calls remain unchanged for a legacy Tab. For every rejected mutation, assert that no partial Block, LayoutAction, or restored subtree remains.

- [ ] **Step 2: Verify RED**

Run:

```bash
go test ./pkg/wcore -run TestTerminalDomain
```

- [ ] **Step 3: Centralize compatibility validation**

Extend Task 0's dependency-safe helper in `wcore`, below `workspaceservice`, so `wcore` never imports the service package. Use the repository transaction abstraction:

```go
func IsTerminalCompatibleView(view string) bool
func ValidateTerminalTabMutation(tx *wstore.TxWrap, workspaceId string, tabId string, views []string) error
```

For `CreateBlock` and `CreateSubBlock`, validate membership and write inside the same existing transaction. For portable restore, parse and validate the entire subtree before the first write, then commit all Block/Layout changes in one transaction. Closing/removing membership uses the same transaction boundary, preventing a check/write race.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
go test ./pkg/wcore ./pkg/service/workspaceservice
```

Then:

```bash
git add pkg/wcore pkg/service/workspaceservice
git commit -m "feat: enforce terminal-only layouts"
```

### Task 5: Terminal-only Renderer Root

**Files:**
- Create: `frontend/app/terminal/terminal-app.tsx`
- Create: `frontend/app/terminal/terminal-bootstrap.ts`
- Create: `frontend/app/terminal/terminal-app.test.tsx`
- Create: `frontend/app/terminal/terminal-import-boundary.test.ts`
- Modify: `index.html`
- Modify: `frontend/wave.ts`
- Create: `frontend/renderer-entry.ts`
- Create: `frontend/app/legacy/legacy-bootstrap.ts`
- Modify: `frontend/app/block/blockregistry.ts`
- Create: `frontend/app/block/terminal-blockregistry.ts`

- [ ] **Step 1: Write failing root and import-boundary tests**

Assert that a Terminal renderer mounts `TabModelContext` and `TabContent` without TopBar, Workspace left/right panels, Agent, StatusBar, Monaco, WebView, Preview, or Diff modules. Add a production bundle assertion that the Terminal entry chunk and its static dependency closure do not contain those modules.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run frontend/app/terminal/terminal-app.test.tsx frontend/app/terminal/terminal-import-boundary.test.ts
```

- [ ] **Step 3: Split bootstrap and registry**

Change the `index.html` module script from `frontend/wave.ts` to `frontend/renderer-entry.ts`. Make that entry a bare identity dispatcher with no static imports of the heavy application roots. It dynamically imports exactly one of Workspace, Terminal, or legacy bootstrap after reading renderer identity. Create a shared primitive bootstrap for WSH/WOS/config/theme and a Terminal bootstrap containing only Tab/Layout/Terminal dependencies. Register only `term` and `termblocks` in `terminal-blockregistry.ts`.

- [ ] **Step 4: Select TerminalApp by renderer identity**

Keep legacy renderer selection available only for legacy Tabs. New Terminal tabs must initialize the narrow `TerminalApp`.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npx vitest run frontend/app/terminal frontend/app/store/global-atoms.test.ts frontend/app/store/wshrpcutil.test.ts
npm run build
npx vitest run frontend/app/terminal/terminal-import-boundary.test.ts
```

Then:

```bash
git add index.html frontend/renderer-entry.ts frontend/wave.ts frontend/app/legacy frontend/app/terminal frontend/app/block
git commit -m "feat: add terminal-only renderer root"
```

### Task 6: Terminal Surface Controller

**Files:**
- Create: `emain/emain-terminal-surface.ts`
- Create: `emain/emain-terminal-surface.test.ts`
- Modify: `emain/emain-window.ts`
- Modify: `emain/emain-workspace-surface.ts`
- Modify: `emain/emain-workspace-surface.test.ts`
- Modify: `emain/emain-tabview.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `emain/preload.ts`
- Modify: `frontend/preview/preview-electron-api.ts`
- Modify: `frontend/app/workspace/workspace-model.ts`
- Modify: `frontend/app/workspace/workspace-main-content.tsx`

- [ ] **Step 1: Write failing controller tests**

Use fake views and deferred readiness promises to cover:

```text
cold init stays offscreen until ready
ready applies bounds, raises target, hides old view, then focuses
cold failure never covers Workspace content
A→B race makes only B visible
stale workspace/generation/revision is ignored
hiding Terminal focuses WorkspaceView
warm reactivation explicitly focuses the Terminal
destroy during init is contained
status events are identity/revision checked and stale events are ignored
failed status exposes retry; retry emits a newer surface revision
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run emain/emain-terminal-surface.test.ts emain/emain-workspace-surface.test.ts
```

- [ ] **Step 3: Implement latest-desired activation**

Create a controller with injected view lookup/create, readiness, bounds, z-order, and focus operations. Track the desired `{workspaceId, generation, revision, tabId}` token; after every await, re-check the token before exposing a renderer.

- [ ] **Step 4: Connect authenticated surface messages**

Reuse the existing exact Workspace renderer identity checks. Cache membership validation per target identity so resize-only revisions do not repeat backend validation. Agent/Top Tab/hide paths move every Terminal offscreen and focus WorkspaceView.

- [ ] **Step 5: Add typed status and retry flow**

Define:

```ts
type TerminalSurfaceStatus =
    | { state: "idle"; workspaceid: string; generation: number; revision: number }
    | { state: "loading" | "ready"; workspaceid: string; generation: number; revision: number; terminaltabid: string }
    | { state: "error"; workspaceid: string; generation: number; revision: number; terminaltabid: string; message: string };
```

Main sends status only to the authenticated owning WorkspaceView. Expose an `onTerminalSurfaceStatus` preload listener and preview stub. WorkspaceModel accepts only matching identity and non-stale revision. The error surface shows Retry and Close; Retry re-sends the desired Terminal with a strictly newer surface revision through the existing authenticated `workspace-surface` channel.

- [ ] **Step 6: Stop startup from warming legacy active Tabs**

On create/switch Workspace, warm a renderer only when checkpoint `ActiveContent` is Terminal and the ID belongs to `terminaltabids`. Agent and Top Tab startup create no WaveTabView. Legacy mixed Tabs remain reachable only through legacy paths.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
npx vitest run emain/emain-terminal-surface.test.ts emain/emain-workspace-surface.test.ts emain/emain-workspaceview.test.ts emain/emain-window-sender.test.ts frontend/app/workspace/workspace-main-content.test.tsx
```

Then:

```bash
git add emain frontend/types/custom.d.ts frontend/preview/preview-electron-api.ts frontend/app/workspace
git commit -m "feat: control terminal renderer surfaces"
```

### Task 7: End-to-end Workspace Integration

**Files:**
- Modify: `frontend/app/workspace/workspace-app.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.test.tsx`
- Modify: `frontend/app/workspace/workspace-app.test.tsx`
- Modify: `frontend/app/workspace/workspace-command-router.test.ts`
- Modify: `docs/superpowers/specs/2026-07-23-workspace-tab-architecture-design.md`

- [ ] **Step 1: Write failing integration tests**

Assert that:

```text
TerminalTabList and command router use the same live Terminal membership
selecting a Terminal changes ActiveContent and requests its renderer
switching Agent/File hides Terminal without changing left-panel mode
closing active Terminal falls back to neighbor, last Top Tab, then Agent
zero Terminal state keeps the Workspace usable
Terminal mock and Phase 2 placeholder text are absent
workspace switch tears down old list subscriptions and renderer desire
Files/Sessions/Terminals remain mutually exclusive, preserve shared width/mode, and second-click collapses the panel
remote Terminal add/remove/reorder updates list and command membership without reopening Workspace
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run frontend/app/workspace
```

- [ ] **Step 3: Wire the production flow**

Build one Terminal navigation adapter per WorkspaceModel and pass it to both `WorkspaceCommandRouter` and `TerminalTabList`. Remove the `Terminal mock` button; loading/failure UI reflects controller status without replacing Workspace chrome.

- [ ] **Step 4: Run focused verification**

Run:

```bash
npx vitest run frontend/app/workspace frontend/app/terminal emain/emain-terminal-surface.test.ts emain/emain-workspace-surface.test.ts emain/emain-workspaceview.test.ts
go test ./pkg/service/workspaceservice ./pkg/wcore ./pkg/wshrpc/wshserver
git diff --check
```

- [ ] **Step 5: Update design status and commit**

Mark Phase 2 complete only after focused verification and runtime smoke confirm that Agent/Top Tab startup creates no Terminal renderer, Terminal switching preserves Workspace chrome, and closing the final Terminal leaves the window open.

```bash
git add frontend/app/workspace docs/superpowers/specs/2026-07-23-workspace-tab-architecture-design.md
git commit -m "test: verify workspace terminal integration"
```

## Runtime Smoke Checklist

1. Restart `npm run dev` so Electron loads the new main-process code.
2. Open a Workspace with zero Terminals; confirm Agent and all chrome remain usable.
3. Create two Terminals from the left list; verify only the selected renderer occupies the central rectangle.
4. Split the active Terminal into multiple panes; verify left list still shows one Terminal Tab.
5. Switch Files/Sessions/Terminals panel modes without changing active content.
6. Switch Agent ↔ Terminal repeatedly; verify no chrome remount, blank frame, stale focus, or incorrect IME target.
7. Rename and reorder Terminals; restart and confirm order/title/active Terminal restore.
8. Close both Terminals; confirm the Workspace window remains open and falls back to the last Top Tab or Agent.
9. Open a legacy mixed Tab through the legacy path; confirm it is absent from TerminalTabList and rejected by new Terminal activation.
10. Restore a portable layout containing one forbidden block; confirm the operation fails without partial Blocks or LayoutActions.
11. Verify the production Terminal entry chunk does not load Workspace, Agent, WebView, Preview, Diff, or Monaco modules.
12. Mutate Terminal inventory through a second client/WPS update; confirm the open Workspace list and command router reconcile without leaking the previous Workspace subscription.
