# Workspace Agent Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent a fixed Workspace surface whose UI state, runtime identity, execution context, and command processes do not depend on any Wave Tab, Block, LayoutState, `staticTabId`, or `TerminalModel`.

**Architecture:** `WorkspaceModel` remains the only owner of `ActiveContent`, while a window/workspace-scoped `WorkspaceAgentModel` owns Agent session and model selection under a separate `agentrevision`. Electron main authenticates Agent requests against the sending Workspace renderer, and `AgentRuntimeRegistry` continues to own session runtimes. A main-process `AgentPtyHost` replaces `spawn_cli_agent`'s Terminal Block dependency, so zero-Terminal workspaces can run normal and long-lived commands.

**Tech Stack:** Go WaveObj/SQLite transactions/WshRPC/WPS, Electron main/preload IPC, `node-pty`, Crest's headless ANSI/Grid engine, React 19/Jotai, assistant-ui, Vitest, Go test.

---

## Scope Decisions

- Phase 3 implements Agent only. File, Browser, Preview, and Git Diff production Top Tab runtimes remain Phase 4.
- `WorkspaceModel.contentStateAtom` remains the only source of truth for whether Agent, Terminal, or a Top Tab is active.
- Agent session/model persistence uses an independent `agentrevision`; it does not consume or increment Terminal/navigation `navigationrevision`.
- Agent session identity remains the canonical session path. A live session is bound to one workspace identity at a time; a send from another workspace must fail instead of silently replacing its execution context.
- `connection` remains prompt/execution metadata in Phase 3. Remote filesystem and remote shell transports are not added; current local tools remain local.
- `preferredTerminalTabId` is optional presentation context only. Agent execution never requires it, and closing that Terminal clears the preference without stopping Agent work.
- `spawn_cli_agent` is retained, but its long-running command moves to a main-process PTY host built on `node-pty`. It no longer creates a Terminal Block or needs a Terminal renderer.
- The PTY host supports long-running/TUI commands, streamed output, stdin writes, resize, abort, bounded snapshots, and user takeover through a Workspace Agent command card.
- Agent content mounts on first activation and then stays mounted. When hidden, its DOM state stays alive but its live session subscription is released; returning pulls a snapshot before resubscribing.
- New-domain workspaces reject all generic Wave Tab creation. Only `CreateTerminalTab` may add to the authoritative Terminal inventory.
- Legacy Agent Tabs and Blocks are not migrated. Their explicit creation, registration, probing, and fixed-entry paths are deleted.
- No GUI automation is part of implementation verification. Runtime smoke remains user-operated.

## Phase 2 Invariants

- `WorkspaceModel` owns the atomic navigation tuple:
  `contentState + terminalTabIds + activeTerminalTabId + navigationRevision`.
- Agent state must not create a second mirror of `ActiveContent`.
- Workspace renderer identity is `(windowId, workspaceId, generation)`.
- Surface `revision` and navigation `navigationRevision` are independent sequences.
- `terminaltabids` remains the only Terminal inventory.
- Terminal renderers remain `term`/`termblocks` only and never import Agent.
- Agent activation hides all Terminal renderers and focuses the Workspace renderer.
- Workspace replacement tears down old subscriptions before any late callback can write the new Workspace.

## File Structure

### Backend state

- `pkg/waveobj/wtype.go`: persisted `WorkspaceAgentState`, `agentstate`, and `agentrevision`.
- `pkg/service/workspaceservice/agentstate.go`: transaction-safe CAS save and Terminal preference normalization.
- `pkg/service/workspaceservice/agentstate_test.go`: state validation, revision, WPS persistence, and Terminal-close preference tests.
- `pkg/service/workspaceservice/workspaceservice.go`: reject generic Tab creation in version 1 workspaces.
- `pkg/service/workspaceservice/workspaceservice_test.go`: atomic rejection tests.
- `pkg/wshrpc/wshrpctypes.go`: `WorkspaceSaveAgentStateCommand` contract.
- `pkg/wshrpc/wshserver/wshserver.go`: RPC delegation to `WorkspaceService`.
- Generated `frontend/types/gotypes.d.ts` and `frontend/app/store/wshclientapi.ts`: generated bindings only.

### Workspace renderer

- `frontend/app/workspace/workspace-agent-state.ts`: local state types, validation, serialization, equality, and reconciliation.
- `frontend/app/workspace/workspace-agent-model.ts`: per-window/workspace Agent state owner, save queue, retry, and teardown.
- `frontend/app/workspace/workspace-agent-sync.ts`: identity/revision-scoped WOS reconciliation.
- `frontend/app/workspace/workspace-agent-context.ts`: derive `AgentExecutionContext` from workspace state.
- `frontend/app/agent/agent-content.tsx`: block-free fixed Agent UI.
- `frontend/app/agent/agent-chat-host.tsx`: command/session bridge without `outerBlockId`.
- `frontend/app/agent/agent-runtime-client.ts`: typed renderer adapter over preload Agent IPC.
- `frontend/app/agent/agent-sessions-panel.tsx`: workspace Agent session list and selection.
- `frontend/app/agent/assistant-ui/**`: moved Agent-only assistant UI modules.
- `frontend/app/workspace/workspace-main-content.tsx`: first-activation mount and hidden/visible surface contract.
- `frontend/app/workspace/workspace-app.tsx`: construct Agent model/context and wire surface/panel.
- `frontend/app/workspace/workspace-left-panel.tsx`: inject workspace-owned session panel.
- `frontend/app/workspace/workspace-layout-model.ts`: remove hidden Agent Tab state and methods.
- `frontend/app/workspace/workspace-right-panel-host.tsx`: read active Agent session from Agent model.

### Electron main and runtime

- `emain/agent/agent-execution-context.ts`: strict context parsing and sender-bound workspace identity.
- `emain/agent/agent-pty-host.ts`: process lifecycle, bounded output/screen state, stdin, resize, abort, and cleanup.
- `emain/agent/agent-pty-screen.ts`: headless ANSI/Grid projection for current primary/alternate screen and cursor.
- `emain/agent/agent-pty-host.test.ts`: zero-Terminal command behavior, terminal emulation, and failure cleanup.
- `emain/agent/tools/spawn-cli-agent.ts`: use command host instead of `_pty-rpc`.
- `emain/agent/cli-subagent-factory.ts`: use command-host read/write/transfer tools.
- `emain/agent/tools/pty-read.ts`, `pty-write.ts`, `pty-transfer.ts`: accept a command handle, not a Block ID.
- `emain/agent-ipc.ts`: authenticated Workspace sender, block-free sends, workspace ownership, and shutdown cleanup.
- `emain/agent/agent-session-runtime.ts`: workspace binding and command-host running/dispose state.
- `emain/preload.ts`, `frontend/types/custom.d.ts`: block-free typed Agent IPC.
- `emain/emain-ipc.ts`: inject sender identity resolver into Agent IPC registration.
- `emain/emain.ts`: dispose Agent runtime registry during app shutdown.

### Hard-cut cleanup

- Delete `frontend/app/view/agentblock/agent-model.tsx` and its test.
- Remove Agent registration from `frontend/app/legacy/legacy-bootstrap.ts`.
- Remove Agent probe/fixed hidden Tab logic from `frontend/app/tab/tabbar.tsx`, `tab-name.ts`, `vtabbar.tsx`, and related tests.
- Remove `pendingResumeSessionAtom` and old files under `frontend/app/term/render/` after their Agent-only contents move.
- Change legacy starter/default widget paths so they cannot create `view:"agent"`.

---

### Task 0: Awaitable Runtime and Workspace Teardown

**Files:**
- Modify: `emain/agent/agent-runtime-registry.ts`
- Modify: `emain/agent/agent-runtime-registry.test.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `frontend/app/workspace/workspace-model.ts`
- Modify: `frontend/app/workspace/workspace-model.test.ts`

- [x] **Step 1: Write failing async teardown tests**

For `AgentRuntimeRegistry`, assert:

- `disposeAll()` waits for every async runtime disposal;
- a runtime that finishes creating after disposal begins is awaited and disposed;
- `evictIdle()` removes the entry before awaiting disposal, awaits all selected disposals, and continues after one rejection;
- no new `getOrCreate()` succeeds while disposal is in progress.

For Agent IPC, assert `_resetAgentIpcForTests()` awaits registry disposal and
pending runtime creation, and that the idle sweep awaits `evictIdle()` without
allowing an unhandled rejection or overlapping sweep.

For `WorkspaceModel`, register an async pre-replacement teardown and assert
`replaceInstance()` does not create the replacement until it settles. Also
assert a rejected teardown is contained after invalidating the old generation.

- [x] **Step 2: Verify RED**

Run:

```bash
npx vitest run emain/agent/agent-runtime-registry.test.ts emain/agent-ipc.test.ts frontend/app/workspace/workspace-model.test.ts
```

Expected: FAIL because both teardown contracts are synchronous.

- [x] **Step 3: Make runtime disposal awaitable**

Use:

```ts
export interface ManagedAgentRuntime {
    isRunning(): boolean;
    dispose(): void | Promise<void>;
}

async evictIdle(now = this.now()): Promise<string[]>;
async disposeAll(): Promise<void>;
```

Increment the registry generation and mark it disposing before awaiting
anything. Remove selected entries before disposal so reentrant callbacks
cannot reacquire them. Use `Promise.allSettled` and surface an aggregate log
without skipping remaining cleanup.

- [x] **Step 4: Make Workspace pre-replacement teardown awaitable**

Change the hook type to:

```ts
type WorkspacePreReplacementTeardown = () => void | Promise<void>;
```

Make `prepareForReplacement()` async, invalidate checkpoint/model generation
before invoking hooks, await all hooks with `Promise.allSettled`, and await it
from `replaceInstance()`, `resetInstances()`, and `dispose()`.

- [x] **Step 5: Update Agent IPC disposal call sites**

Make `_resetAgentIpcForTests()` async and update every test caller to await it.
Serialize the runtime sweep callback and await `evictIdle()`; a failed sweep is
logged only after its complete cleanup settles. No timer or test reset may
fire-and-forget runtime disposal.

- [x] **Step 6: Verify GREEN**

Run:

```bash
npx vitest run emain/agent/agent-runtime-registry.test.ts emain/agent-ipc.test.ts frontend/app/workspace/workspace-model.test.ts
```

- [x] **Step 7: Commit**

```bash
git add emain/agent/agent-runtime-registry.ts emain/agent/agent-runtime-registry.test.ts emain/agent-ipc.ts emain/agent-ipc.test.ts frontend/app/workspace/workspace-model.ts frontend/app/workspace/workspace-model.test.ts
git commit -m "refactor: await runtime and workspace teardown"
```

---

### Task 1: Persisted Workspace Agent State

**Files:**
- Modify: `pkg/waveobj/wtype.go`
- Create: `pkg/service/workspaceservice/agentstate.go`
- Create: `pkg/service/workspaceservice/agentstate_test.go`
- Modify: `pkg/service/workspaceservice/terminaltabs.go`

- [x] **Step 1: Write failing state tests**

Cover:

- empty Agent state on a new Workspace;
- session/selection save;
- exact `expectedrevision`;
- stale revision rejection with no partial write;
- returned checkpoints are deep copies;
- invalid selection/session descriptors are rejected;
- preferred Terminal must be empty or a member of `terminaltabids`;
- closing the preferred Terminal clears only the preference and increments
  `agentrevision` in the same transaction as `navigationrevision`;
- Agent state mutation does not change `navigationrevision`;
- Terminal create/reorder and closes unrelated to the preference do not change
  `agentrevision`.

- [x] **Step 2: Verify RED**

Run:

```bash
go test ./pkg/service/workspaceservice -run 'TestWorkspaceAgentState|TestTerminalTab'
```

Expected: FAIL because Agent state fields and service methods do not exist.

- [x] **Step 3: Add persisted types**

Add:

```go
type WorkspaceAgentState struct {
    ActiveSession         *AgentSessionMeta   `json:"activesession,omitempty"`
    Selection             *AgentSelectionMeta `json:"selection,omitempty"`
    PreferredTerminalTabId string             `json:"preferredterminaltabid,omitempty"`
}

type WorkspaceAgentCheckpoint struct {
    WorkspaceId string              `json:"workspaceid"`
    Revision    int64               `json:"revision"`
    State       WorkspaceAgentState `json:"state"`
}
```

`WorkspaceAgentCheckpoint` belongs to `workspaceservice`; only
`WorkspaceAgentState` is a persisted `waveobj` type. Add to `Workspace`:

```go
AgentState    WorkspaceAgentState `json:"agentstate"`
AgentRevision int64               `json:"agentrevision,omitempty"`
```

- [x] **Step 4: Implement CAS save**

Implement:

```go
type SaveWorkspaceAgentStateData struct {
    WorkspaceId      string                      `json:"workspaceid"`
    ExpectedRevision int64                       `json:"expectedrevision"`
    State            waveobj.WorkspaceAgentState `json:"state"`
}

func (svc *WorkspaceService) SaveWorkspaceAgentState(
    ctx context.Context,
    data SaveWorkspaceAgentStateData,
) (*WorkspaceAgentCheckpoint, error)
```

Within one `wstore.TxWrap`:

1. load the exact Workspace;
2. reject identity/revision mismatch;
3. normalize a deep copy;
4. validate preferred Terminal membership;
5. increment only `agentrevision`;
6. update the Workspace;
7. publish the normal WaveObj update after commit;
8. return a deep-copy checkpoint.

- [x] **Step 5: Normalize Terminal close**

When `CloseTerminalTab` removes the preferred Terminal, clear
`workspace.AgentState.PreferredTerminalTabId` and increment `agentrevision`
within the same transaction that increments `navigationrevision`. The one
committed Workspace WaveObj is authoritative for both state domains; no
consumer may observe an equal Agent revision with different Agent state.

- [x] **Step 6: Verify GREEN**

Run:

```bash
go test ./pkg/service/workspaceservice -run 'TestWorkspaceAgentState|TestTerminalTab'
```

- [x] **Step 7: Commit**

```bash
git add pkg/waveobj/wtype.go pkg/service/workspaceservice/agentstate.go pkg/service/workspaceservice/agentstate_test.go pkg/service/workspaceservice/terminaltabs.go
git commit -m "feat: persist workspace agent state"
```

---

### Task 2: Agent State RPC, Model, and WOS Reconciliation

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Regenerate: `frontend/types/gotypes.d.ts`
- Regenerate: `frontend/app/store/wshclientapi.ts`
- Create: `frontend/app/workspace/workspace-agent-state.ts`
- Create: `frontend/app/workspace/workspace-agent-model.ts`
- Create: `frontend/app/workspace/workspace-agent-model.test.ts`
- Create: `frontend/app/workspace/workspace-agent-sync.ts`
- Create: `frontend/app/workspace/workspace-agent-sync.test.ts`

- [x] **Step 1: Write failing model tests**

Assert:

- hydrate deep-copies state;
- session and selection updates are local-first;
- save payload carries exact workspace identity and `expectedrevision`;
- saves serialize through one queue;
- stale save reloads authoritative WOS state and retries the still-current local intent once;
- older WOS updates are rejected;
- equal revision is accepted only when deep-equal;
- wrong workspace/generation is rejected;
- replacement invalidates late save responses;
- Agent saves do not mutate `WorkspaceModel.revision`;
- preferred Terminal is cleared when the authoritative inventory removes it.

- [x] **Step 2: Verify RED**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-agent-model.test.ts frontend/app/workspace/workspace-agent-sync.test.ts
```

- [x] **Step 3: Define wire DTOs and the RPC**

Define wire types in `pkg/wshrpc/wshrpctypes.go`:

```go
type WorkspaceSaveAgentStateData struct {
    WorkspaceId      string                      `json:"workspaceid"`
    ExpectedRevision int64                       `json:"expectedrevision"`
    State            waveobj.WorkspaceAgentState `json:"state"`
}

type WorkspaceAgentCheckpoint struct {
    WorkspaceId string                      `json:"workspaceid"`
    Revision    int64                       `json:"revision"`
    State       waveobj.WorkspaceAgentState `json:"state"`
}
```

In `WshRpcInterface` add:

```go
WorkspaceSaveAgentStateCommand(
    ctx context.Context,
    data WorkspaceSaveAgentStateData,
) (*WorkspaceAgentCheckpoint, error)
```

Implement it in `wshserver` by explicitly converting the wire request to
`workspaceservice.SaveWorkspaceAgentStateData`, delegating, then converting the
service checkpoint back to the wire checkpoint. Do not import `workspaceservice`
from `wshrpctypes.go`; that would create the wrong package dependency. JSON
fields remain lowercase.

- [x] **Step 4: Generate bindings**

Run:

```bash
task generate
```

Do not manually edit generated files.

- [x] **Step 5: Implement local state helpers**

Use:

```ts
export interface LocalWorkspaceAgentState {
    activeSession?: AgentSessionMeta;
    selection?: AgentSelectionMeta;
    preferredTerminalTabId: string;
}
```

Provide explicit hydrate/serialize/clone/equality functions. Do not serialize React state, transcript, draft, scroll, picker state, runtime handles, or errors.

- [x] **Step 6: Implement `WorkspaceAgentModel`**

The model is keyed by `(windowId, workspaceId, generation)` and exposes:

```ts
stateAtom: jotai.PrimitiveAtom<LocalWorkspaceAgentState>;
statusAtom: jotai.PrimitiveAtom<"clean" | "dirty" | "saving" | "error">;
errorAtom: jotai.PrimitiveAtom<string>;

selectSession(session?: AgentSessionMeta): void;
selectModel(selection?: AgentSelectionMeta): void;
setPreferredTerminal(tabId: string): void;
flush(): Promise<void>;
reconcile(checkpoint: WorkspaceAgentCheckpoint): boolean;
dispose(): Promise<void>;
```

Use a 300 ms debounce, a serialized save loop, generation invalidation, blur/hidden/beforeunload flush, and strict identity/revision reconciliation.

- [x] **Step 7: Implement WOS sync**

Subscribe to the current Workspace WaveObject, project only `agentstate`, `agentrevision`, and `terminaltabids`, and reconcile through `WorkspaceAgentModel`. Teardown must run before workspace replacement.

- [x] **Step 8: Verify GREEN**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-agent-model.test.ts frontend/app/workspace/workspace-agent-sync.test.ts frontend/app/workspace/workspace-model.test.ts
go test ./pkg/wshrpc/wshserver ./pkg/service/workspaceservice
```

- [x] **Step 9: Commit**

```bash
git add pkg/wshrpc pkg/waveobj frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts frontend/app/workspace/workspace-agent-*
git commit -m "feat: add workspace agent state owner"
```

---

### Task 3: Authenticated Agent Execution Context

**Files:**
- Create: `emain/agent/agent-execution-context.ts`
- Create: `emain/agent/agent-execution-context.test.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `emain/emain-ipc.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `emain/preload.ts`
- Create: `frontend/app/agent/agent-runtime-client.ts`
- Create: `frontend/app/agent/agent-runtime-client.test.ts`
- Create: `frontend/app/workspace/workspace-agent-context.ts`
- Create: `frontend/app/workspace/workspace-agent-context.test.ts`

- [x] **Step 1: Write failing context tests**

Test strict parsing of:

```ts
interface AgentExecutionContext {
    workspaceId: string;
    workspaceDir: string;
    sessionPath?: string;
    connection: string;
    environment: Record<string, string>;
    preferredTerminalTabId?: string;
    gitBranch?: string;
    recentCmds?: string[];
}
```

Reject extra keys, empty identities, non-absolute workspace directories, invalid environment values, and a preferred Terminal not in the authoritative inventory.
Normalize missing `recentCmds` to `[]` at the runtime boundary.

Test sender authentication:

- Workspace renderer sender resolves to the current `WaveBrowserWindow`;
- payload `workspaceId` matches the window;
- Workspace generation is current;
- legacy/Terminal/unknown senders are rejected;
- switching workspaces invalidates an old sender request before runtime mutation.

Apply those assertions to every Agent entry point that exists by the end of
this task, not only send:

```text
createSession
listSessions / listSessionDetails
listCommands
getSessionState
send / abort / subscribe / unsubscribe
listTree / listForkPoints / navigateTree / forkSession / cloneSession
runCommand
```

For session-addressed calls, also assert canonical session metadata belongs to
the authenticated workspace directory and any live runtime is bound to the
same Workspace ID. Task 4 adds and tests command endpoint authentication;
Task 7 does the same for Rename, Archive, and Delete.

Replace the global `listAllSessionDetails` renderer API. Workspace Agent
renderers may list only sessions whose stored canonical cwd equals their
main-resolved Workspace directory.

- [x] **Step 2: Verify RED**

Run:

```bash
npx vitest run emain/agent/agent-execution-context.test.ts emain/agent-ipc.test.ts frontend/app/agent/agent-runtime-client.test.ts frontend/app/workspace/workspace-agent-context.test.ts
```

- [x] **Step 3: Inject the sender resolver**

Change registration to:

```ts
registerAgentIpcHandlers({
    async resolveWorkspaceSender(senderId) {
        const view = getWorkspaceViewByWebContentsId(senderId);
        if (!view) return undefined;
        const window = getWaveWindowById(view.waveWindowId);
        if (!window || window.workspaceView !== view) return undefined;
        const identity = {
            windowId: window.waveWindowId,
            workspaceId: view.initOpts.workspaceId,
            generation: view.initOpts.generation,
        };
        const workspace = await loadWorkspaceObject(identity.workspaceId);
        if (
            window.workspaceView !== view ||
            view.initOpts.workspaceId !== identity.workspaceId ||
            view.initOpts.generation !== identity.generation
        ) {
            return undefined;
        }
        const workspaceDir = canonicalizeExistingDirectory(
            workspace.meta["workspace:dir"]
        );
        return {
            ...identity,
            workspaceDir,
            validatePreferredTerminal: (terminalTabId: string) =>
                window.terminalMembership.validate(identity, terminalTabId),
        };
    },
});
```

Do not import window registries into `agent-ipc.ts`; inject the narrow resolver from `emain-ipc.ts` to avoid a circular owner dependency.
Test a Workspace switch that occurs while `loadWorkspaceObject()` is pending;
the resolver must reject the torn identity instead of returning the old
directory paired with the new generation.

- [x] **Step 4: Authenticate the complete Agent IPC surface**

Remove `blockId` from `AgentSendOptions` and subscribe options. Add a common
identity envelope:

```ts
interface WorkspaceAgentRequestContext {
    workspaceId: string;
    generation: number;
}
```

Every preload Agent method above accepts this envelope, and the injected
`AgentRuntimeClient` supplies it automatically. Main derives the accepted
identity from the sender and treats the payload identity only as a cross-check.
The resolver obtains `workspaceDir` from the main/backend Workspace WaveObject;
renderer-provided cwd is never authoritative. `createSession` uses that
directory directly, list calls are workspace-scoped, and global list is not
exposed to the renderer. Session-addressed calls canonicalize the database
path under the configured sessions root, open its metadata, and require
`realpath(metadata.cwd) === workspaceDir`. Each async handler captures the
authenticated identity and validates it again after file/session/runtime
awaits but before returning data or mutating runtime state. Abort and
unsubscribe must also be authenticated payloads rather than bare session-path
fire-and-forget messages.

- [x] **Step 5: Add the renderer client**

`AgentRuntimeClient` wraps `window.api.agent` and exposes the authenticated
create/list/send/abort/run-command/tree/fork/clone/snapshot/subscription methods
that exist by the end of this task. Task 4 extends the same client with hosted
PTY methods; Task 7 extends it with Rename/Archive/Delete. It is constructed
with immutable Workspace ID/generation, so no Agent component can omit or
replace sender identity. No Agent component reads `window.api.agent` directly
after this task.

- [x] **Step 6: Derive Workspace context**

Build context from:

- authenticated Workspace ID/generation;
- `workspace:dir`;
- active Agent session path;
- configured connection/environment;
- authoritative preferred Terminal membership;
- optional workspace git/recent-command providers.

Use empty environment and connection when no configured provider exists. Do not read `TerminalModel`, Block meta, or `staticTabId`.
`gitBranch` and `recentCmds` are intentional extensions to the six-field
architecture sketch: they preserve the existing system-prompt context while
remaining optional, block-free Workspace inputs; context normalization converts
missing `recentCmds` to `[]`. Record that extension in the architecture
document during Task 9.

- [x] **Step 7: Verify GREEN**

Run the tests from Step 2.

- [ ] **Step 8: Commit**

```bash
git add emain/agent/agent-execution-context.ts emain/agent/agent-execution-context.test.ts emain/agent-ipc.ts emain/agent-ipc.test.ts emain/emain-ipc.ts emain/preload.ts frontend/types/custom.d.ts frontend/app/agent/agent-runtime-client.ts frontend/app/agent/agent-runtime-client.test.ts frontend/app/workspace/workspace-agent-context.ts frontend/app/workspace/workspace-agent-context.test.ts
git commit -m "refactor: authenticate workspace agent context"
```

---

### Task 4: Main-owned Agent PTY Host

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `postinstall.cjs`
- Modify: `electron.vite.config.ts`
- Modify: `electron-builder.config.cjs`
- Modify: `electron-builder.config.test.ts`
- Create: `scripts/smoke-agent-pty-package.mjs`
- Create: `scripts/patch-node-pty-macos-helper.cjs`
- Create: `build/entitlements.mac.plist`
- Modify: `emain/emain.ts`
- Create: `emain/agent/agent-pty-host.ts`
- Create: `emain/agent/agent-pty-host.test.ts`
- Create: `emain/agent/agent-pty-screen.ts`
- Create: `emain/agent/agent-pty-screen.test.ts`
- Create: `emain/agent/agent-pty-ring-buffer.ts`
- Create: `emain/agent/agent-pty-ring-buffer.test.ts`
- Modify: `emain/agent/tools/spawn-cli-agent.ts`
- Modify: `emain/agent/tools/spawn-cli-agent.test.ts`
- Modify: `emain/agent/cli-subagent-factory.ts`
- Modify: `emain/agent/cli-subagent-factory.test.ts`
- Modify: `emain/agent/tools/pty-read.ts`
- Modify: `emain/agent/tools/pty-read.test.ts`
- Modify: `emain/agent/tools/pty-write.ts`
- Modify: `emain/agent/tools/pty-write.test.ts`
- Modify: `emain/agent/tools/pty-transfer.ts`
- Modify: `emain/agent/tools/pty-transfer.test.ts`
- Modify: `emain/agent/agent-session-runtime.ts`
- Modify: `emain/agent/agent-session-runtime.test.ts`
- Modify: `emain/agent/agent-runtime-registry.test.ts`
- Modify: `emain/agent-ipc.ts`

- [x] **Step 1: Write failing host lifecycle tests**

Cover:

- starts a command with no Terminal and no Block;
- reports a real TTY to the child process;
- uses the current workspace directory and environment;
- streams stdout/stderr into a bounded snapshot;
- never spills an unbounded transcript to disk;
- keeps both transcript-ring storage and the terminal screen's backing row
  count bounded after arbitrarily large ordinary output;
- writes stdin;
- resizes columns/rows;
- feeds PTY bytes through the pure headless `AnsiParser`/`BlockHandler`/Grid
  engine and exposes primary/alternate screen rows, cursor position/style,
  and active-screen identity;
- handles cursor motion, erase, resize, and alternate-screen entry/exit as
  current-screen state rather than showing raw escape sequences;
- rejects writes after exit;
- abort kills the process tree;
- launch failure leaves no registry entry;
- session runtime is running while any hosted command is alive;
- runtime dispose kills all owned commands;
- output is capped by both bytes and lines;
- stale command IDs from another session are rejected.
- `pty_transfer_to_user` marks the command as requiring takeover while leaving
  the PTY alive;
- command update events appear in the session snapshot/subscriber stream;
- an idle Harness with a live PTY is protected from registry eviction;
- every newly added command IPC rejects a legacy/Terminal/unknown sender,
  mismatched Workspace identity, foreign session, and stale generation before
  and after async work;
- packaged Electron can load the external native module with the Electron ABI
  and start a PTY without opening a window.

- [x] **Step 2: Verify RED**

Run:

```bash
npx vitest run emain/agent/agent-pty-host.test.ts emain/agent/agent-pty-screen.test.ts emain/agent/agent-pty-ring-buffer.test.ts emain/agent/agent-session-runtime.test.ts emain/agent/agent-runtime-registry.test.ts emain/agent-ipc.test.ts electron-builder.config.test.ts
```

- [x] **Step 3: Add the PTY dependency**

Run:

```bash
npm install node-pty --save
npm install @electron/rebuild --save-dev
```

Externalize `node-pty` from the Electron main Vite bundle, rebuild it for the
project's Electron ABI from `postinstall.cjs`, explicitly include its runtime
files in the builder config, and unpack the `.node` binary from ASAR. Add a
builder-config test that proves those four conditions.

Add a directory-package smoke path that launches the packaged executable in a
no-window Electron Node mode, requires the packaged `node-pty`, starts a PTY
that prints a sentinel, and exits non-zero on load/ABI/spawn failure. The smoke
script locates the current platform/architecture output and is invoked by a
package script. Commit manifest, lockfile, build config, and smoke runner
together.

- [x] **Step 4: Implement `AgentPtyHost`**

Expose:

```ts
interface AgentPtySnapshot {
    commandId: string;
    command: string;
    cwd: string;
    tail: string;
    screen: {
        rows: AgentPtyScreenRow[];
        cursor: AgentPtyCursor;
        isAltScreenActive: boolean;
    };
    running: boolean;
    exitCode?: number;
    cols: number;
    rows: number;
    needsUserInput: boolean;
}

class AgentPtyHost {
    start(command: string, context: AgentExecutionContext): Promise<AgentPtySnapshot>;
    read(commandId: string): AgentPtySnapshot;
    write(commandId: string, input: string): Promise<void>;
    resize(commandId: string, cols: number, rows: number): void;
    requestUserInput(commandId: string, reason: string): void;
    stop(commandId: string): Promise<void>;
    hasRunningCommands(): boolean;
    dispose(): Promise<void>;
}
```

Use `node-pty` with the existing shell resolution and environment helpers.
Keep a PTY-specific in-memory ring capped by both bytes and lines; it never
uses `OutputAccumulator` and never creates a full-output spool file. Feed the
same bytes into a headless `AgentPtyScreen` built from Crest's pure terminal
`AnsiParser`, `BlockHandler`, `Block`, and Grid primitives. The screen context
writes terminal capability replies back to the PTY and updates its dimensions
on resize. It must not import `TerminalModel`, renderer state, a Block
WaveObject, or Electron web contents.

Unlike a normal Terminal command block, the screen is always a fixed viewport:
call `outputGrid.raw().resizeViewport(cols, rows)` at construction and on every
resize, and keep alternate screen at the same bound. Test that primary and
alternate backing row counts never exceed `rows` after output far beyond both
ring and viewport limits.

All entries are owned by one `AgentSessionRuntime`; IDs are unguessable and
are still validated against the authenticated session/workspace owner.

- [x] **Step 5: Rewire the CLI subagent**

`createSpawnCliAgentTool` starts a command through the session runtime's host
and passes a `commandId`-scoped interface to the subagent factory. `pty_read`,
`pty_write`, and `pty_transfer_to_user` operate only through that interface.
Transfer marks `needsUserInput`; it no longer assumes a visible Terminal Block.

Delete production imports from:

```text
spawn-cli-agent.ts -> _pty-rpc.ts
pty-read.ts        -> _pty-screen.ts
```

The old Terminal-specific helpers may remain for Terminal features, but Agent imports must not reach them.

Add authenticated `commandRead`, `commandWrite`, `commandResize`, and
`commandStop` IPC methods. Apply the Task 3 sender/workspace/session validation
before and after awaits, and cover every command endpoint in `agent-ipc.test.ts`.

- [x] **Step 6: Extend runtime state and lifecycle**

`AgentSessionRuntime.getSessionState()` and subscription events include owned
PTY snapshots. `isRunning()` returns true when either the Harness is running
or an owned PTY is alive. `dispose()` aborts Harness work, rejects pending
operations, and awaits PTY-host disposal.

- [x] **Step 7: Verify GREEN**

Run:

```bash
npx vitest run emain/agent/agent-pty-host.test.ts emain/agent/agent-pty-screen.test.ts emain/agent/agent-pty-ring-buffer.test.ts emain/agent/tools/spawn-cli-agent.test.ts emain/agent/cli-subagent-factory.test.ts emain/agent/tools/pty-read.test.ts emain/agent/tools/pty-write.test.ts emain/agent/tools/pty-transfer.test.ts emain/agent/agent-session-runtime.test.ts emain/agent/agent-runtime-registry.test.ts emain/agent-ipc.test.ts electron-builder.config.test.ts
npm run build:dev
npx electron-builder --dir --config electron-builder.config.cjs
npm run smoke:agent-pty-package
```

- [x] **Step 8: Commit**

```bash
git add package.json package-lock.json postinstall.cjs electron.vite.config.ts electron-builder.config.cjs electron-builder.config.test.ts build/entitlements.mac.plist scripts/smoke-agent-pty-package.mjs scripts/patch-node-pty-macos-helper.cjs emain/emain.ts emain/agent/agent-pty-host.ts emain/agent/agent-pty-host.test.ts emain/agent/agent-pty-screen.ts emain/agent/agent-pty-screen.test.ts emain/agent/agent-pty-ring-buffer.ts emain/agent/agent-pty-ring-buffer.test.ts emain/agent/tools emain/agent/cli-subagent-factory.ts emain/agent/cli-subagent-factory.test.ts emain/agent/agent-session-runtime.ts emain/agent/agent-session-runtime.test.ts emain/agent/agent-runtime-registry.test.ts emain/agent-ipc.ts emain/agent-ipc.test.ts
git commit -m "feat: host agent ptys without terminal blocks"
```

---

### Task 5: Block-free Runtime Client and Chat Host

**Files:**
- Modify: `frontend/app/store/use-pi-chat.ts`
- Create: `frontend/app/store/use-pi-chat.test.ts`
- Move: `frontend/app/term/render/agent-chat-host.tsx` to `frontend/app/agent/agent-chat-host.tsx`
- Move related Agent chat tests to `frontend/app/agent/`
- Move Agent slash command routing and command result modules to `frontend/app/agent/`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent/agent-session-runtime.ts`

- [x] **Step 1: Write failing hook/client tests**

Assert:

- send contains authenticated workspace context and no `blockId`;
- subscription has no block option;
- switching sessions unsubscribes A, pulls B snapshot, then subscribes B;
- hiding releases the subscription but keeps local UI state;
- showing pulls a fresh snapshot and resubscribes;
- a running hidden session continues in main;
- late events from the previous session/workspace generation are ignored;
- the same canonical session cannot be rebound to a different workspace;
- commands/tree/fork/clone use session + execution context only.

- [x] **Step 2: Verify RED**

Run:

```bash
npx vitest run frontend/app/store/use-pi-chat.test.ts frontend/app/agent/agent-chat-host-api.test.ts
```

- [x] **Step 3: Make `usePiChat` client-injected**

Replace direct global API reads with:

```ts
interface UsePiChatOptions {
    client: AgentRuntimeClient;
    initialSession?: AgentSessionMeta;
    executionContext: AgentExecutionContext;
    modelSelection: UsePiChatModel;
    visible: boolean;
    onSessionMinted?: (meta: AgentSessionMeta) => void;
    allowedTools?: string[];
}
```

Keep reducer behavior unchanged. Visibility affects only snapshot/subscription lifecycle, never send/runtime ownership.

- [x] **Step 4: Remove block identity from `AgentChatHost`**

Remove:

- `outerBlockId`;
- `getBlockId`;
- pane wording;
- block-scoped command payloads.

Use the injected client and Workspace execution context for send and commands.

- [x] **Step 5: Enforce runtime workspace binding**

On first creation, bind a runtime entry to the authenticated Workspace ID. Later sends/acquires for the same session path must match that ID. Workspace UI switching does not dispose a running runtime; it only releases the renderer subscriber.

- [x] **Step 6: Verify GREEN**

Run:

```bash
npx vitest run frontend/app/store/use-pi-chat.test.ts frontend/app/agent emain/agent-ipc.test.ts emain/agent/agent-session-runtime.test.ts emain/agent/agent-runtime-registry.test.ts
```

- [x] **Step 7: Commit**

```bash
git add frontend/app/store/use-pi-chat.ts frontend/app/store/use-pi-chat.test.ts frontend/app/agent emain/agent-ipc.ts emain/agent/agent-session-runtime.ts
git add -u frontend/app/term/render
git commit -m "refactor: remove block identity from agent client"
```

---

### Task 6: Fixed Workspace Agent Content

**Files:**
- Create: `frontend/app/agent/agent-content.tsx`
- Create: `frontend/app/agent/agent-content.test.tsx`
- Create: `frontend/app/agent/agent-command-card.tsx`
- Create: `frontend/app/agent/agent-command-card.test.tsx`
- Create: `frontend/app/agent/agent-pty-screen-view.tsx`
- Create: `frontend/app/agent/agent-pty-screen-view.test.tsx`
- Move: `frontend/app/term/render/agent-surface.tsx` behavior into `frontend/app/agent/agent-content.tsx`
- Move: `frontend/app/term/render/assistant-ui/**` to `frontend/app/agent/assistant-ui/**`
- Modify: `frontend/app/workspace/workspace-main-content.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.test.tsx`
- Modify: `frontend/app/workspace/workspace-app.tsx`
- Modify: `frontend/app/workspace/workspace-app.test.tsx`

- [ ] **Step 1: Write failing content tests**

Assert:

- Agent content is absent before first activation when another content is restored;
- first Agent activation mounts exactly one instance;
- switching Agent → Terminal → Top Tab → Agent preserves the same DOM instance, composer draft, and scroll container;
- hidden Agent content has `visibility:hidden`, `pointer-events:none`, and `aria-hidden=true`;
- hidden content releases the live subscription;
- returning requests snapshot then resubscribes;
- zero Terminal Workspace can select a model, create a session, and submit;
- selection/session writes target `WorkspaceAgentModel`, never Block meta;
- user-facing errors use Agent model error state, not `TerminalModel.notificationAtom`;
- hosted PTYs render current primary/alternate screen rows without displaying
  ANSI escape text, place the cursor from the snapshot, accept user
  input/resize/stop through `AgentRuntimeClient`, and highlight
  `needsUserInput`;
- resizing the card reports its rows/columns and a hidden card neither steals
  focus nor sends stale dimensions;
- the command card remains usable with zero Terminal Tabs.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run frontend/app/agent/agent-content.test.tsx frontend/app/agent/agent-command-card.test.tsx frontend/app/agent/agent-pty-screen-view.test.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/workspace/workspace-app.test.tsx
```

- [ ] **Step 3: Build block-free `AgentContent`**

Props:

```ts
interface AgentContentProps {
    model: WorkspaceAgentModel;
    client: AgentRuntimeClient;
    executionContext: AgentExecutionContext;
    visible: boolean;
}
```

Reuse assistant-ui, composer, model picker, session selector, queue, command results, tree/fork/clone, and context usage. Delete `TerminalModel`, `outerBlockId`, `inAltScreen`, and Block meta reads/writes.

Render `AgentCommandCard` for the active session's hosted PTY snapshots. The
card owns only display/focus/input state; Electron main owns the PTY process,
raw tail, and terminal-emulated screen. `AgentPtyScreenView` renders the
snapshot's cell rows and cursor directly, including alternate-screen state;
it does not instantiate xterm, `TerminalModel`, or a renderer Block. The card
sends input, resize, and stop through the authenticated client and does not
create or reveal a Wave Tab/Block.

- [ ] **Step 4: Add first-activation keep-alive**

`WorkspaceMainContent` tracks whether Agent has ever been active. Once true, it keeps `<AgentContent>` mounted and changes only visibility/pointer/focus semantics. Terminal surface measurement remains on the shared central content container.

- [ ] **Step 5: Wire the Workspace app**

Construct `WorkspaceAgentModel` with window/workspace/generation identity, start Agent WOS sync, derive execution context, and inject the model/client/content. Register model teardown before `WorkspaceModel` replacement.

- [ ] **Step 6: Verify GREEN**

Run the tests from Step 2 plus:

```bash
npx vitest run frontend/app/workspace/workspace-renderer-lifecycle.test.ts frontend/app/workspace/workspace-init-coordinator.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add frontend/app/agent frontend/app/workspace/workspace-main-content.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/workspace/workspace-app.tsx frontend/app/workspace/workspace-app.test.tsx
git add -u frontend/app/term/render
git commit -m "feat: mount agent as a workspace surface"
```

---

### Task 7: Workspace Session Panel, Fixed Entry, and Right Panel

**Files:**
- Move: `frontend/app/term/render/assistant-ui/agent-sessions-panel.tsx` to `frontend/app/agent/agent-sessions-panel.tsx`
- Create: `frontend/app/agent/agent-sessions-panel.test.tsx`
- Delete: `frontend/app/term/render/assistant-ui/agent-sessions-atoms.ts`
- Modify: `emain/agent/sessions.ts`
- Modify: `emain/agent/harness/session/sqlite-repo.ts`
- Modify: `emain/agent/harness/session/sqlite-storage.test.ts`
- Modify: `emain/agent/agent-runtime-registry.ts`
- Modify: `emain/agent/agent-runtime-registry.test.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `emain/preload.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `frontend/app/workspace/workspace-left-panel.tsx`
- Modify: `frontend/app/workspace/workspace-layout-model.ts`
- Modify: `frontend/app/workspace/workspace-layout-model.test.ts`
- Modify: `frontend/app/workspace/workspace-main-content.tsx`
- Modify: `frontend/app/workspace/workspace-right-panel-host.tsx`
- Modify related tests.

- [ ] **Step 1: Write failing session/navigation tests**

Assert:

- New Session calls Agent IPC, stores it in `WorkspaceAgentModel`, activates Agent, and opens the sessions panel;
- selecting an existing session performs the same local navigation without creating or activating a Wave Tab;
- the active row reads the Agent model, not `pendingResumeSessionAtom`;
- fixed Agent entry is not closable or reorderable;
- `Close Active` while Agent is active is a no-op;
- Agent entry activation opens the left panel in `sessions` mode;
- TopBar Files/Agent/Terminal buttons still only control the mutually exclusive left panel;
- right panel receives the active session path from Agent state;
- workspace switch cannot leak an old session selection into the new Workspace;
- Rename persists the new session name;
- Archive disposes the idle runtime, moves its database under the session directory's `.archive/` sibling, excludes it from the normal session list, and clears the active Workspace session when necessary;
- Delete disposes the idle runtime, removes its database, and clears the active Workspace session when necessary;
- Archive and Delete reject a running session and never orphan a Harness or PTY;
- concurrent Send cannot reacquire a session between disposal and its archive
  or delete file mutation;
- concurrent state/tree/fork/clone/subscribe/rename access cannot open or
  mutate a session while archive/delete holds its tombstone;
- a failed archive/delete releases its registry tombstone and leaves the
  session usable;
- successful archive/delete clears only a matching `ActiveSession`, preserves
  model `Selection`, and retries or reconciles an Agent-state CAS conflict;
- every Rename/Archive/Delete endpoint rejects a foreign sender/workspace,
  foreign session, and stale generation before and after async work;
- Stop Run aborts the active runtime.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run frontend/app/agent/agent-sessions-panel.test.tsx frontend/app/workspace/workspace-layout-model.test.ts frontend/app/workspace/workspace-command-router.test.ts frontend/app/workspace/right-tool-panel.test.tsx
npx vitest run emain/agent-ipc.test.ts emain/agent/agent-runtime-registry.test.ts emain/agent/harness/session/sqlite-storage.test.ts
```

- [ ] **Step 3: Rewire the sessions panel**

The panel accepts `WorkspaceAgentModel`, `WorkspaceModel`, and a narrow session client. New/select calls:

```ts
agentModel.selectSession(session);
workspaceModel.activateAgent();
layoutModel.showLeftPanel("sessions");
```

Add `showLeftPanel(mode)` if needed; unlike `toggleLeftPanel`, activating Agent must never accidentally collapse the sessions panel.

- [ ] **Step 4: Add session management APIs**

Expose authenticated Workspace Agent operations for:

```ts
renameSession(sessionPath, name)
archiveSession(sessionPath)
deleteSession(sessionPath)
```

Rename opens the session repository and appends a session-name event. Archive moves the SQLite database into a sibling `.archive/` directory; normal listing ignores nested archive files. Delete uses the repository's permanent-delete operation.

Implement a registry-owned exclusive session mutation:

```ts
AgentRuntimeRegistry.withExclusiveSessionMutation(
    sessionPath,
    { rejectIfRunning: true },
    async () => {
        // archive or delete the database while the registry tombstone is held
    }
)
```

All session-addressed operations—including state, tree, fork, clone,
subscription setup, Rename, runtime acquire, and Send—must first enter a
registry-owned `withSessionAccess(path, fn)` lease. The exclusive mutation
atomically installs a tombstone, rejects new access, waits for already-entered
leases to drain, rejects while either a Harness turn or Agent PTY is live,
awaits complete runtime/PTY teardown, performs the file operation while still
exclusive, and removes the tombstone in `finally`.

Add deterministic races in which archive/delete pauses after installing the
tombstone while Send, Rename, state read, fork, and subscribe attempt access;
every late operation must reject without opening the database. A pre-existing
short read lease must drain before the file moves.

On success, clear a matching persisted/local
`WorkspaceAgentState.ActiveSession`—not model `Selection`—using the Agent
compare-and-swap revision contract. If the checkpoint is stale, fetch and
retry only while the still-current active session matches the archived/deleted
path; never overwrite a newer user selection.

Apply the Task 3 sender/workspace/session authorization to Rename, Archive, and
Delete before and after awaits.

Add Rename, Archive, Delete, and Stop Run actions to the session panel/context menu. Before implementing the menu, read `.kilocode/skills/context-menu/SKILL.md` and follow its context-menu construction and cleanup rules.

- [ ] **Step 5: Remove hidden Agent Tab state**

Delete from `WorkspaceLayoutModel`:

- `agentTabIdAtom`;
- `layout:agenttabid`;
- `getAgentTabId`;
- `isAgentTab`;
- `findAgentTabId`;
- `setAgentTabId`;
- `openAgentTab`;
- `resolveAgentTabId`;
- `getAgentBackingTab`;
- related WOS/Tab/Block/ObjectService imports.

- [ ] **Step 6: Wire fixed entry and right panel**

Agent entry only changes Workspace ActiveContent and left-panel mode. Right panel reads the session from `WorkspaceAgentModel` and remains outside Agent content's visibility boundary.

- [ ] **Step 7: Verify GREEN**

Run the tests from Step 2 and:

```bash
npx vitest run frontend/app/workspace/workspace-app.test.tsx frontend/app/workspace/workspace-main-content.test.tsx
```

- [ ] **Step 8: Commit**

```bash
git add emain/agent emain/agent-ipc.ts emain/agent-ipc.test.ts emain/preload.ts frontend/types/custom.d.ts frontend/app/agent/agent-sessions-panel.tsx frontend/app/agent/agent-sessions-panel.test.tsx frontend/app/workspace
git add -u frontend/app/term/render/assistant-ui
git commit -m "feat: manage agent sessions from workspace"
```

---

### Task 8: Hard Cut Legacy Agent Tabs and Seal Version 1

**Files:**
- Modify: `pkg/service/workspaceservice/workspaceservice.go`
- Modify: `pkg/wcore/workspace.go`
- Modify: `pkg/wcore/layout.go`
- Modify: `pkg/wcore/workspace_test.go`
- Modify: `pkg/service/workspaceservice/newdomain_tab_boundary_test.go`
- Create: `frontend/app/workspace/workspace-agent-boundary.test.ts`
- Modify: `frontend/app/terminal/terminal-import-boundary.test.ts`
- Delete: `frontend/app/view/agentblock/agent-model.tsx`
- Delete: `frontend/app/view/agentblock/agent-model.test.ts`
- Modify: `frontend/app/legacy/legacy-bootstrap.ts`
- Modify: `frontend/app/tab/tabbar.tsx`
- Modify: `frontend/app/tab/tab-name.ts`
- Modify: `frontend/app/tab/vtabbar.tsx`
- Modify: `frontend/app/tab/vtab-detail-sidecar.tsx`
- Modify related tests.
- Modify: `pkg/wconfig/defaultconfig/widgets.json`

- [ ] **Step 1: Write failing core and static boundary tests**

Directly call the core `wcore` generic creation functions against a version 1 Workspace and assert that they reject without creating any Tab, Layout, or Block. Keep the service-layer boundary test as a second defense.

Add a static Agent boundary test rooted at the final `frontend/app/agent/agent-content.tsx`; it must reject production imports or references to `TerminalModel`, Agent Block models, hidden Agent Tabs, or legacy tab helpers. Extend the Terminal import-boundary test to cover `/app/agent/`.

- [ ] **Step 2: Verify RED**

Run:

```bash
go test ./pkg/wcore -run 'TestNewDomainRejectsGenericTabCreation'
go test ./pkg/service/workspaceservice -run 'TestNewDomainRejectsGenericTabCreation'
npx vitest run frontend/app/workspace/workspace-agent-boundary.test.ts frontend/app/terminal/terminal-import-boundary.test.ts
```

- [ ] **Step 3: Implement the backend version gate**

Before any write, generic `CreateTab` and `CreateTabWithBlock` load the Workspace and reject `tabdomainversion == 1`. Only `CreateTerminalTabInTx` may create a Tab for a version 1 Workspace.

The failure must occur before Tab/Layout/Block creation and before any controller after-commit callback is registered.

- [ ] **Step 4: Remove legacy Agent creation/render paths**

Delete Agent ViewModel registration and source. Remove:

- first-block `view === "agent"` probes;
- hidden Agent Tab filtering/entry behavior;
- Agent-specific tab display names;
- Agent as a VTab/sidecar Terminal-like type;
- default widget/starter creation of `view:"agent"`.

Legacy version 0 starter layout may create a Terminal, not Agent. Existing legacy Agent data is unsupported and not migrated.

- [ ] **Step 5: Verify boundary tests GREEN**

Run:

```bash
go test ./pkg/service/workspaceservice -run 'TestNewDomainRejectsGenericTabCreation|TestWorkspaceAgentState|TestTerminalTab'
go test ./pkg/wcore -run 'TestTerminalDomain|TestWorkspace'
npx vitest run frontend/app/workspace/workspace-agent-boundary.test.ts frontend/app/terminal/terminal-import-boundary.test.ts frontend/app/tab
```

- [ ] **Step 6: Verify production source closure**

Run:

```bash
rg -n -g '!*.test.*' 'openAgentTab|layout:agenttabid|view ===? "agent"|view: "agent"|CreateTabWithBlock\\(.*Agent|staticTabId|TerminalModel' frontend/app/agent frontend/app/workspace
```

Expected: no forbidden production Agent dependency. Test fixtures may use strings only inside explicit boundary tests.

- [ ] **Step 7: Commit**

```bash
git add pkg/service/workspaceservice pkg/wcore pkg/wconfig/defaultconfig/widgets.json frontend/app/legacy frontend/app/tab frontend/app/workspace/workspace-agent-boundary.test.ts frontend/app/terminal/terminal-import-boundary.test.ts
git add -u frontend/app/view/agentblock
git commit -m "refactor: remove legacy agent tabs"
```

---

### Task 9: Shutdown, Workspace-switch Races, and End-to-end Integration

**Files:**
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `emain/emain.ts`
- Modify: `frontend/app/workspace/workspace-app.test.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.test.tsx`
- Modify: `frontend/app/workspace/workspace-renderer-lifecycle.test.ts`
- Modify: `frontend/app/workspace/workspace-command-router.test.ts`
- Modify: `docs/agent-rendering-architecture.md`
- Modify: `docs/agent-runtime-architecture.md`
- Modify: `docs/superpowers/specs/2026-07-23-workspace-tab-architecture-design.md`

- [ ] **Step 1: Write failing race and shutdown tests**

Cover:

- Workspace A Agent running while window switches to Workspace B;
- late A state save, WOS update, session snapshot, subscription event, and send result are rejected by B;
- A runtime continues in main while its renderer subscriber is released;
- returning to A restores snapshot and subscription;
- app shutdown awaits `runtimeRegistry.disposeAll()` and command-host cleanup;
- a failed runtime create/config sync leaves no registry entry and sends no prompt;
- Agent active `Close Active` is a no-op;
- Terminal close fallback to Agent does not remount Agent;
- Agent activation hides all Terminal views and focuses Workspace;
- zero Terminal + Agent send + long-running command succeeds;
- preferred Terminal close does not stop Agent;
- no Agent operation changes navigation revision;
- Terminal operations do not change Agent revision except the atomic close that
  clears a matching preferred Terminal.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run emain/agent-ipc.test.ts frontend/app/workspace/workspace-app.test.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/workspace/workspace-renderer-lifecycle.test.ts frontend/app/workspace/workspace-command-router.test.ts
```

- [ ] **Step 3: Add explicit shutdown**

Export an idempotent `disposeAgentRuntime()` from `agent-ipc.ts`. App shutdown awaits it before Electron exits. It clears the sweep timer, releases subscriptions, awaits all runtime/command-host disposal, and rejects new sends after disposal begins.

- [ ] **Step 4: Close race gaps**

Every asynchronous renderer callback checks the exact model generation before state writes. Every main Agent request checks the current Workspace sender identity both before and after asynchronous session/runtime creation.

- [ ] **Step 5: Update architecture docs**

Document the final Phase 3 topology:

```text
Workspace AgentContent
  -> AgentRuntimeClient
  -> authenticated Agent IPC
  -> AgentRuntimeRegistry
  -> AgentSessionRuntime
       -> AgentHarness
       -> AgentPtyHost
            -> AgentPtyScreen
```

Remove claims that Agent is pane/block scoped. Mark Phase 3 implemented and Phase 4 Top Tabs pending.

- [ ] **Step 6: Verify GREEN**

Run the tests from Step 2 plus:

```bash
npx vitest run emain/agent frontend/app/agent frontend/app/workspace frontend/app/terminal/terminal-import-boundary.test.ts
go test ./pkg/service/workspaceservice ./pkg/wcore ./pkg/wshrpc/wshserver
```

- [ ] **Step 7: Commit**

```bash
git add emain frontend/app/agent frontend/app/workspace docs
git commit -m "test: verify workspace agent integration"
```

---

### Task 10: Final Verification and Review

**Files:**
- No intended production changes.

- [ ] **Step 1: Run focused Phase 3 verification**

```bash
npx vitest run emain/agent frontend/app/agent frontend/app/workspace frontend/app/store/use-pi-chat.test.ts frontend/app/terminal/terminal-import-boundary.test.ts
go test ./pkg/service/workspaceservice ./pkg/wcore ./pkg/wshrpc/wshserver
```

- [ ] **Step 2: Run the full frontend suite**

```bash
npx vitest run
```

- [ ] **Step 3: Run the supported development build**

```bash
npm run build:dev
```

Do not run `go build`.

- [ ] **Step 4: Run static closure and diff checks**

```bash
git diff --check
rg -n -g '!*.test.*' 'openAgentTab|layout:agenttabid|CreateTabWithBlock|setActiveTab\\(|staticTabId|TerminalModel|WOS\\.makeORef\\("block"' frontend/app/agent frontend/app/workspace
```

The second command must have no forbidden production matches.

- [ ] **Step 5: Request final reviews**

Dispatch:

1. a spec-compliance reviewer against Phase 3 of
   `docs/superpowers/specs/2026-07-23-workspace-tab-architecture-design.md`;
2. a code-quality reviewer for the complete Phase 3 diff;
3. a focused lifecycle/security reviewer for Workspace identity, Agent state revision, process cleanup, and workspace-switch races.

Fix every Critical/Important issue and re-run the affected verification before approval.

- [ ] **Step 6: User-operated smoke checklist**

Hand off, but do not automate, these checks:

1. zero Terminal Workspace can run Agent shell and long commands;
2. Agent → Terminal → Agent preserves draft and scroll;
3. Agent task continues while File/Terminal is active;
4. switching sessions restores transcript without duplicate events;
5. model/session survives restart;
6. preferred Terminal may close without stopping Agent;
7. Agent activation has no renderer flash and focuses composer;
8. Cmd+W on Agent does not close Agent or window;
9. workspace switch does not show the previous Workspace's session;
10. database has no Agent Tab, Block, or Layout.
