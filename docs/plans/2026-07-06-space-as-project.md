# Space = Project (Working Directory) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote "working directory" to a first-class, immutable property of a Space, so that file explorer, editor, git, and agent all anchor to one project directory (SSoT), and a new Space is created by picking a folder.

**Architecture:** Store the directory on `Workspace.Meta["workspace:dir"]` (Plan B — no core struct change). `CreateWorkspace` takes a `dir` param and writes it into meta. The frontend adds a `workspaceDirAtom` derived from the current workspace's `workspace:dir`; file explorer / git / command palette / agent session cwd repoint to it and stop following the focused terminal block's `cmd:cwd`. A new Electron `select-directory` IPC drives the "New Space" folder picker.

**Tech Stack:** Go (wcore / waveobj / workspaceservice / wsh cobra), Electron main + preload (TypeScript), React + Jotai, generated code via `task generate` (`cmd/generatego`, `cmd/generatets`).

**Reference spec:** `docs/specs/2026-07-06-space-as-project-design.md`

**Conventions (repo house style):** no semicolons in TS, 4-space indent, double quotes, ASCII source. Go uses tabs (gofmt). Delete dead code rather than leaving shims.

---

## Important preface: generated files

Three files are generated from Go sources — **never hand-edit them**:
- `pkg/waveobj/metaconsts.go` (generated from `MetaTSType` struct field tags)
- `frontend/types/gotypes.d.ts` (generated from Go types)
- `frontend/app/store/services.ts` (generated from service method signatures)

Regenerate with:

```bash
task generate
```

If `task` is unavailable, run the two generators directly (from `Taskfile.yml` `generate` task):

```bash
go run cmd/generatets/main-generatets.go
go run cmd/generatego/main-generatego.go
```

There is **no** `MetaDataDecl` registry in this codebase — meta keys are generated purely from the `MetaTSType` struct tags. Adding the struct field and regenerating is the complete "declare the key" step.

---

## Task 1: Add the `workspace:dir` meta field (Go model + codegen)

**Files:**
- Modify: `pkg/waveobj/wtypemeta.go` (add field near line 105, the "for workspace" group)
- Regenerate: `pkg/waveobj/metaconsts.go`, `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Add the struct field**

In `pkg/waveobj/wtypemeta.go`, inside `MetaTSType`, in the `// for workspace` group (currently starting at the `LayoutVTabBarWidth` line), add:

```go
	// for workspace
	WorkspaceDir              string `json:"workspace:dir,omitempty"` // project dir; set at Space creation, immutable
	LayoutVTabBarWidth        int   `json:"layout:vtabbarwidth,omitempty"`
```

(Insert the `WorkspaceDir` line immediately above `LayoutVTabBarWidth`.)

- [ ] **Step 2: Regenerate**

Run:

```bash
task generate
```

Expected: `pkg/waveobj/metaconsts.go` now contains `MetaKey_WorkspaceDir = "workspace:dir"`, and `frontend/types/gotypes.d.ts` `MetaTSType` now contains `"workspace:dir"?: string;`.

- [ ] **Step 3: Verify generation**

Run:

```bash
grep -n 'MetaKey_WorkspaceDir' pkg/waveobj/metaconsts.go
grep -n 'workspace:dir' frontend/types/gotypes.d.ts
```

Expected: one hit in each file.

- [ ] **Step 4: Build to confirm no breakage**

Run:

```bash
go build ./pkg/waveobj/...
```

Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add pkg/waveobj/wtypemeta.go pkg/waveobj/metaconsts.go frontend/types/gotypes.d.ts
git commit -m "feat(workspace): add workspace:dir meta field"
```

---

## Task 2: `CreateWorkspace(dir)` writes the directory into meta (Go core, TDD)

`CreateWorkspace` gains a `dir` parameter. When `dir != ""`, write it into `Workspace.Meta["workspace:dir"]` and, when no explicit name was given, default the workspace `Name` to the directory basename.

**Files:**
- Modify: `pkg/wcore/workspace.go:51-74` (`CreateWorkspace`)
- Test: `pkg/wcore/workspace_test.go`

- [ ] **Step 1: Write the failing test**

Add to `pkg/wcore/workspace_test.go`:

```go
func TestCreateWorkspaceWritesDir(t *testing.T) {
	ctx := setupWorkspaceTestWStore(t)
	ws, err := CreateWorkspace(ctx, "", "", "", true, false, "/tmp/my-project")
	if err != nil {
		t.Fatalf("CreateWorkspace returned error: %v", err)
	}
	if got := ws.Meta.GetString(waveobj.MetaKey_WorkspaceDir, ""); got != "/tmp/my-project" {
		t.Fatalf("workspace:dir = %q, want %q", got, "/tmp/my-project")
	}
	if ws.Name != "my-project" {
		t.Fatalf("Name = %q, want basename %q", ws.Name, "my-project")
	}
}

func TestCreateWorkspaceExplicitNameOverridesBasename(t *testing.T) {
	ctx := setupWorkspaceTestWStore(t)
	ws, err := CreateWorkspace(ctx, "Custom", "", "", true, false, "/tmp/my-project")
	if err != nil {
		t.Fatalf("CreateWorkspace returned error: %v", err)
	}
	if ws.Name != "Custom" {
		t.Fatalf("Name = %q, want %q", ws.Name, "Custom")
	}
}
```

Note: `setupWorkspaceTestWStore(t)` already exists in the test file (line ~163) and returns a `context.Context`. Confirm its return type before running; if it returns `(context.Context, ...)`, adjust the call to match existing tests in the file.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
go test ./pkg/wcore/ -run TestCreateWorkspaceWritesDir -v
```

Expected: FAIL — compile error "too many arguments in call to CreateWorkspace".

- [ ] **Step 3: Add the `dir` parameter and meta write**

In `pkg/wcore/workspace.go`, change `CreateWorkspace` (line 51) to:

```go
func CreateWorkspace(ctx context.Context, name string, icon string, color string, applyDefaults bool, isInitialLaunch bool, dir string) (*waveobj.Workspace, error) {
	ws := &waveobj.Workspace{
		OID:    uuid.NewString(),
		TabIds: []string{},
		Name:   "",
		Icon:   "",
		Color:  "",
	}
	if dir != "" {
		ws.Meta = waveobj.MetaMapType{waveobj.MetaKey_WorkspaceDir: dir}
	}
	err := wstore.DBInsert(ctx, ws)
	if err != nil {
		return nil, fmt.Errorf("error inserting workspace: %w", err)
	}
	_, err = CreateTab(ctx, ws.OID, "", true, isInitialLaunch)
	if err != nil {
		return nil, fmt.Errorf("error creating tab: %w", err)
	}

	wps.Broker.Publish(wps.WaveEvent{
		Event: wps.Event_WorkspaceUpdate,
	})

	if name == "" && dir != "" {
		name = filepath.Base(dir)
	}

	ws, _, err = UpdateWorkspace(ctx, ws.OID, name, icon, color, applyDefaults)
	return ws, err
}
```

Add `"path/filepath"` to the import block of `pkg/wcore/workspace.go` if not present.

Note on `ws.Meta`: confirm `waveobj.Workspace` has a `Meta MetaMapType` field (spec §Data Model / wtype.go:174). If `DBInsert` persists `Meta`, this is sufficient; otherwise write via `wstore.UpdateObjectMeta` after insert, mirroring `applyTabBackground` (workspace.go:218-225). Verify by checking whether `TestCreateWorkspaceWritesDir` reads the value back correctly after Step 4.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
go test ./pkg/wcore/ -run 'TestCreateWorkspace' -v
```

Expected: PASS for both new tests.

- [ ] **Step 5: Fix the existing caller**

`CreateWorkspace` is called in `pkg/service/workspaceservice/workspaceservice.go:32`. Update it (this is finalized in Task 3, but the build must pass now). Temporarily pass `""`:

```go
	newWS, err := wcore.CreateWorkspace(ctx, name, icon, color, applyDefaults, false, "")
```

Run:

```bash
go build ./pkg/...
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add pkg/wcore/workspace.go pkg/wcore/workspace_test.go pkg/service/workspaceservice/workspaceservice.go
git commit -m "feat(workspace): CreateWorkspace accepts and stores project dir"
```

---

## Task 3: Thread `dir` through the WorkspaceService RPC + regen frontend service

**Files:**
- Modify: `pkg/service/workspaceservice/workspaceservice.go:24-37`
- Regenerate: `frontend/app/store/services.ts`

- [ ] **Step 1: Add `dir` to the service method + meta**

In `pkg/service/workspaceservice/workspaceservice.go`, update `CreateWorkspace_Meta` and `CreateWorkspace`:

```go
func (svc *WorkspaceService) CreateWorkspace_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{
		ArgNames:   []string{"ctx", "name", "icon", "color", "applyDefaults", "dir"},
		ReturnDesc: "workspaceId",
	}
}

func (svc *WorkspaceService) CreateWorkspace(ctx context.Context, name string, icon string, color string, applyDefaults bool, dir string) (string, error) {
	newWS, err := wcore.CreateWorkspace(ctx, name, icon, color, applyDefaults, false, dir)
	if err != nil {
		return "", fmt.Errorf("error creating workspace: %w", err)
	}
	return newWS.OID, nil
}
```

- [ ] **Step 2: Regenerate the TS service client**

Run:

```bash
task generate
```

Expected: `frontend/app/store/services.ts` `CreateWorkspace` signature becomes:

```ts
    CreateWorkspace(name: string, icon: string, color: string, applyDefaults: boolean, dir: string): Promise<string> {
```

- [ ] **Step 3: Verify**

Run:

```bash
grep -n 'CreateWorkspace(name: string' frontend/app/store/services.ts
go build ./pkg/...
```

Expected: signature includes `dir: string`; Go build exit 0.

- [ ] **Step 4: Commit**

```bash
git add pkg/service/workspaceservice/workspaceservice.go frontend/app/store/services.ts
git commit -m "feat(workspace): thread project dir through CreateWorkspace RPC"
```

---

## Task 4: Electron `select-directory` IPC + preload API

**Files:**
- Modify: `emain/emain-ipc.ts` (add a handler near the existing `save-text-file` handler, ~line 586)
- Modify: `emain/preload.ts:85` area (add `selectDirectory`)
- Modify: `frontend/types/custom.d.ts:124` area (add to `ElectronApi` type)

- [ ] **Step 1: Add the IPC handler in emain-ipc.ts**

In `emain/emain-ipc.ts`, in the same function that registers `save-text-file` (it uses `electron.dialog` and `electron.ipcMain.handle`), add:

```ts
    electron.ipcMain.handle("select-directory", async (event) => {
        const ww = electron.BrowserWindow.fromWebContents(event.sender)
        const result = await electron.dialog.showOpenDialog(ww, {
            title: "Open Project Folder",
            properties: ["openDirectory", "createDirectory"],
        })
        if (result.canceled || result.filePaths.length === 0) {
            return null
        }
        return result.filePaths[0]
    })
```

- [ ] **Step 2: Expose it in preload.ts**

In `emain/preload.ts`, in the `contextBridge.exposeInMainWorld("api", { ... })` object, next to `createWorkspace` (line 85), add:

```ts
    selectDirectory: () => ipcRenderer.invoke("select-directory"),
```

- [ ] **Step 3: Declare it in the ElectronApi type**

In `frontend/types/custom.d.ts`, in the `ElectronApi` type (near `createWorkspace` at line 124), add:

```ts
        selectDirectory: () => Promise<string | null>; // select-directory
```

- [ ] **Step 4: Typecheck**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no new errors referencing `selectDirectory` (pre-existing unrelated errors, if any, are acceptable — compare against a baseline run on the parent branch if unsure).

- [ ] **Step 5: Commit**

```bash
git add emain/emain-ipc.ts emain/preload.ts frontend/types/custom.d.ts
git commit -m "feat(emain): add select-directory IPC + selectDirectory preload API"
```

---

## Task 5: New Space flow — pick folder, then create with dir

The renderer path is: `WorkspaceSwitcher.onNewSpace` → `env.electron.createWorkspace()` → preload `send("create-workspace")` → emain `ipcMain.on("create-workspace")` → `createWorkspace(ww)` → `WorkspaceService.CreateWorkspace(...)`.

We move directory selection to the **renderer** (so cancel is clean and no Space is created), and pass the chosen dir down to `createWorkspace`.

**Files:**
- Modify: `frontend/app/tab/workspaceswitcher.tsx:241-246` (`onNewSpace`)
- Modify: `emain/preload.ts:85` (`createWorkspace` now takes a dir arg)
- Modify: `frontend/types/custom.d.ts:124` (`createWorkspace` signature)
- Modify: `emain/emain-window.ts:812-829` (`createWorkspace` + `create-workspace` handler take dir)

- [ ] **Step 1: renderer — select dir before creating**

In `frontend/app/tab/workspaceswitcher.tsx`, replace `onNewSpace` (lines 241-246):

```tsx
    const onNewSpace = useCallback(() => {
        fireAndForget(async () => {
            const dir = await env.electron.selectDirectory()
            if (!dir) return
            env.electron.createWorkspace(dir)
        })
        setIsOpen(false)
    }, [env.electron])
```

- [ ] **Step 2: preload — createWorkspace carries the dir**

In `emain/preload.ts` line 85, change:

```ts
    createWorkspace: (dir: string) => ipcRenderer.send("create-workspace", dir),
```

- [ ] **Step 3: type — createWorkspace signature**

In `frontend/types/custom.d.ts` line 124, change:

```ts
        createWorkspace: (dir: string) => void; // create-workspace
```

- [ ] **Step 4: emain — thread dir into createWorkspace + handler**

In `emain/emain-window.ts`, update `createWorkspace` (line 812) and the IPC handler (line 823):

```ts
export async function createWorkspace(window: WaveBrowserWindow, dir: string = "") {
    const newWsId = await WorkspaceService.CreateWorkspace("", "", "", true, dir);
    if (newWsId) {
        if (window) {
            await window.switchWorkspace(newWsId);
        } else {
            await createWindowForWorkspace(newWsId);
        }
    }
}

ipcMain.on("create-workspace", (event, dir: string) => {
    fireAndForget(async () => {
        const ww = getWaveWindowByWebContentsId(event.sender.id);
        console.log("create-workspace", ww?.waveWindowId, dir);
        await createWorkspace(ww, dir);
    });
});
```

Note: `WorkspaceService.CreateWorkspace` here is the TS binding in `@/app/store/services` (regenerated in Task 3) — it now takes `(name, icon, color, applyDefaults, dir)`. Confirm the call matches the regenerated signature.

- [ ] **Step 5: Find any other callers of createWorkspace**

Run:

```bash
grep -rn 'createWorkspace(' emain/ frontend/ --include=*.ts --include=*.tsx
```

Expected: identify every call to `env.electron.createWorkspace(` and emain `createWorkspace(`. Update each to pass a dir (or `""` for internal non-user-initiated creation such as initial launch). Do not leave any call using the old arity.

- [ ] **Step 6: Typecheck + build**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
go build ./...
```

Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/tab/workspaceswitcher.tsx emain/preload.ts frontend/types/custom.d.ts emain/emain-window.ts
git commit -m "feat(workspace): New Space picks a folder before creating"
```

---

## Task 6: `workspaceDirAtom` — the cwd single source of truth (frontend)

Add an atom that reads the current workspace's `workspace:dir`, falling back to home. This becomes the SSoT that file explorer / git / command palette / agent consume.

**Files:**
- Modify: `frontend/app/fileexplorer/file-explorer-atoms.ts`

- [ ] **Step 1: Add `workspaceDirAtom`**

In `frontend/app/fileexplorer/file-explorer-atoms.ts`, add imports and the atom. The workspace ORef pattern is `WOS.makeORef("workspace", wsId)` read via `getOrefMetaKeyAtom` (see `frontend/app/workspace/workspace-layout-model.ts:160`). The current workspace id is `atoms.workspace`.

Add at the top (merge with existing imports):

```ts
import { atoms, getApi, getBlockMetaKeyAtom, getOrefMetaKeyAtom } from "@/store/global"
import * as WOS from "@/store/wos"
```

Confirm `getOrefMetaKeyAtom` is exported from `@/store/global` (it is used in workspace-layout-model.ts). If it lives elsewhere, import from that module.

Add the atom (below `getCachedHome`):

```ts
// SSoT for the project directory. Every Space is bound to one directory at
// creation (workspace:dir, immutable). File explorer / git / command palette /
// agent all anchor here rather than following the focused terminal's cwd.
export const workspaceDirAtom: jotai.Atom<string> = jotai.atom((get) => {
    const wsId = get(atoms.workspace)?.oid
    if (!wsId) return CachedHome
    const dir = get(getOrefMetaKeyAtom(WOS.makeORef("workspace", wsId), "workspace:dir")) as
        | string
        | undefined
    return dir || CachedHome
})
```

- [ ] **Step 2: Typecheck**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no new errors; `workspaceDirAtom` resolves.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/fileexplorer/file-explorer-atoms.ts
git commit -m "feat(workspace): add workspaceDirAtom as cwd SSoT"
```

---

## Task 7: Repoint git model + source-control panel to `workspaceDirAtom`

**Files:**
- Modify: `frontend/app/codereview/git-model.ts:4,223`
- Modify: `frontend/app/sourcecontrol/source-control-model.ts:4,214`
- Modify: `frontend/app/sourcecontrol/source-control-panel.tsx:4,593`
- Modify: `frontend/app/sourcecontrol/source-control-model.test.ts:10`

- [ ] **Step 1: git-model.ts**

Change the import (line 4) from:

```ts
import { focusedCwdAtom } from "@/app/fileexplorer/file-explorer-atoms";
```

to:

```ts
import { workspaceDirAtom } from "@/app/fileexplorer/file-explorer-atoms";
```

Change `syncCwd` (line 223):

```ts
        const cwd = globalStore.get(workspaceDirAtom);
```

- [ ] **Step 2: source-control-model.ts**

Change import (line 4) to `workspaceDirAtom` and line 214:

```ts
        const cwd = globalStore.get(workspaceDirAtom);
```

- [ ] **Step 3: source-control-panel.tsx**

Change import (line 4) to `workspaceDirAtom` and line 593:

```ts
    const focusedCwd = useAtomValue(workspaceDirAtom);
```

(Rename the local variable if desired, but keeping `focusedCwd` avoids touching downstream usages. If renamed, update all references in the component.)

- [ ] **Step 4: source-control-model.test.ts mock**

Line 10 mocks `focusedCwdAtom`. Change the mock key to `workspaceDirAtom`:

```ts
        workspaceDirAtom: jotaiActual.atom(""),
```

- [ ] **Step 5: Run source-control tests**

Run:

```bash
npx vitest run frontend/app/sourcecontrol/source-control-model.test.ts
```

Expected: PASS (or same pass/fail baseline as before the change — no new failures from the rename).

- [ ] **Step 6: Commit**

```bash
git add frontend/app/codereview/git-model.ts frontend/app/sourcecontrol/source-control-model.ts frontend/app/sourcecontrol/source-control-panel.tsx frontend/app/sourcecontrol/source-control-model.test.ts
git commit -m "refactor(git): anchor git/source-control cwd to workspaceDirAtom"
```

---

## Task 8: Repoint file explorer + command palette to `workspaceDirAtom`

`focusedBlockCwdAtom` tracked `{tabId, blockId, cwd}` so the file explorer could decide when to change root. With a Space-bound directory, the root no longer changes on tab/block focus or `cd` — it is always the Space dir.

**Files:**
- Modify: `frontend/app/fileexplorer/file-explorer.tsx:32,55`
- Modify: `frontend/app/modals/commandpalette.tsx:4,340`

- [ ] **Step 1: file-explorer.tsx**

Read `frontend/app/fileexplorer/file-explorer.tsx` around lines 32 and 55 to see how `{ tabId, blockId, cwd }` from `focusedBlockCwdAtom` is used (there is likely an effect keyed on `tabId`/`blockId` that resets the explorer root). Replace the consumption with `workspaceDirAtom`:

Change import (line 32):

```ts
import { getCachedHome, workspaceDirAtom } from "./file-explorer-atoms";
```

Change line 55 and its dependent logic. The root is now simply the workspace dir:

```ts
    const cwd = useAtomValue(workspaceDirAtom);
```

Then update the effect that previously depended on `tabId`/`blockId`/`cwd`: it should now depend only on `cwd` (the workspace dir) and set the explorer root when `cwd` changes. Remove `tabId`/`blockId` bookkeeping that is no longer needed. Show the exact effect edit based on what you read; keep the "set root to cwd on change" behavior, drop the "distinguish tab vs block vs cd" branching.

- [ ] **Step 2: commandpalette.tsx**

Change import (line 4):

```ts
import { getCachedHome, workspaceDirAtom } from "@/app/fileexplorer/file-explorer-atoms";
```

Change line 340:

```ts
    const cwd = useAtomValue(workspaceDirAtom);
```

(`focusedBlockCwdAtom` returned `{ cwd }`; `workspaceDirAtom` returns a string directly, so drop the destructuring.)

- [ ] **Step 3: Typecheck**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no references to `focusedBlockCwdAtom` remain except its definition; no new errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/fileexplorer/file-explorer.tsx frontend/app/modals/commandpalette.tsx
git commit -m "refactor(fileexplorer): anchor explorer + command palette to workspaceDirAtom"
```

---

## Task 9: Delete the dead focused-cwd derivations

Now that all consumers use `workspaceDirAtom`, `focusedBlockCwdAtom`, `focusedCwdAtom`, and the `FocusedBlockCwd` type are unused.

**Files:**
- Modify: `frontend/app/fileexplorer/file-explorer-atoms.ts`

- [ ] **Step 1: Confirm no remaining consumers**

Run:

```bash
grep -rn 'focusedBlockCwdAtom\|focusedCwdAtom\|FocusedBlockCwd' frontend/ --include=*.ts --include=*.tsx
```

Expected: hits only inside `file-explorer-atoms.ts` (the definitions). If any other file still references them, stop and fix that consumer first.

- [ ] **Step 2: Delete the dead code**

In `frontend/app/fileexplorer/file-explorer-atoms.ts`, delete the `FocusedBlockCwd` type (lines ~24-28), `focusedBlockCwdAtom` (lines ~30-39), and `focusedCwdAtom` (lines ~41-45). Remove now-unused imports (`getLayoutModelForStaticTab`, `getBlockMetaKeyAtom`) if nothing else in the file uses them — verify with a quick read before deleting imports.

- [ ] **Step 3: Typecheck**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no unused-import or unresolved-symbol errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/fileexplorer/file-explorer-atoms.ts
git commit -m "refactor(fileexplorer): remove dead focused-cwd derivations"
```

---

## Task 10: Anchor terminal initial cwd + agent session cwd to the Space dir

Terminals should spawn in the Space directory (an in-terminal `cd` still only affects that terminal). The agent session's cwd should come from the Space dir so all conversations group under the same `sessions/{encodedCwd}/`.

**Files:**
- Modify: `frontend/app/term/render/terminal-view.tsx:161,314,409`

- [ ] **Step 1: Read the current cwd wiring**

Read `frontend/app/term/render/terminal-view.tsx` lines 148-320 to confirm:
- `initialCwd` (line 161) = block `cmd:cwd`
- `liveCwd` (line 314) = `liveBlock?.pwd || initialCwd || home`
- `liveCwd` feeds the agent session (`cwd: liveCwd`, line 409) and the chip model (line 317).

- [ ] **Step 2: Introduce the workspace dir as the anchor**

Add near the other atom reads (top of component body, after `home`):

```tsx
        const workspaceDir = useAtomValue(workspaceDirAtom)
```

Add the import at the top of the file:

```tsx
import { workspaceDirAtom } from "@/app/fileexplorer/file-explorer-atoms"
```

Confirm `useAtomValue` is already imported in this file (it is used elsewhere in the component). 

- [ ] **Step 3: Anchor the agent session cwd to the Space dir**

The agent session cwd must be the project dir, not the terminal's live pwd. Change line 409 (inside the `agentSession` `useMemo`) from `cwd: liveCwd` to `cwd: workspaceDir`, and add `workspaceDir` to that `useMemo`'s dependency array (currently `[persistedAgentSession, timelineAgentSessionPath, liveCwd]`):

```tsx
        const agentSession = useMemo<AgentSessionMeta | undefined>(() => {
            if (persistedAgentSession?.path) return persistedAgentSession;
            if (!timelineAgentSessionPath) return undefined;
            return {
                id: "",
                createdAt: "",
                cwd: workspaceDir,
                path: timelineAgentSessionPath,
            };
        }, [persistedAgentSession, timelineAgentSessionPath, workspaceDir]);
```

Then find where the agent session is actually minted / where `getPaneCwd` is fed (search for `cwd: liveCwd` at line ~836 and the `AgentChatHost`/`useContextChipModel` wiring near lines 830-900). The agent's pane cwd (the value passed to `createSession` / `getPaneCwd`, `agent-chat-host.tsx:185,198,381,395`) must be `workspaceDir`. Update the prop passed at line ~836 (`cwd: liveCwd`) and line ~898 (`cwd={liveCwd}`) — determine from reading which of these feed the terminal display (keep `liveCwd`) versus the agent context (switch to `workspaceDir`). Concretely:
  - Terminal prompt / chip display of the shell's live pwd → keep `liveCwd`.
  - Agent session context (`getPaneCwd`, session mint) → use `workspaceDir`.

- [ ] **Step 4: Anchor terminal spawn cwd (Go side)**

Terminals read spawn cwd from block `cmd:cwd` (`shellcontroller.go:436`). To make new terminals spawn in the Space dir, the default tab's terminal block must carry `cmd:cwd = workspace:dir`. Read `pkg/wcore/layout.go` `GetNewTabLayout` / `ApplyPortableLayout` (referenced at workspace.go:254) to find where the default terminal block def is built, and set its `cmd:cwd` meta to the workspace dir.

Implementation approach: in `CreateTab` (workspace.go:235) the workspace id is known; fetch `workspace:dir` from the workspace meta and, when applying the portable layout, inject `cmd:cwd` into the terminal block's meta. If the portable-layout block defs are static templates, the cleanest hook is to set the block meta right after layout application. Read the layout code first, then implement the minimal injection. If this proves to require larger layout-template surgery, scope it down to: **new terminals created via wsh/`term` already accept `--cwd`; the default block's cwd anchoring can be a follow-up** — but attempt the injection first.

- [ ] **Step 5: Typecheck + build**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
go build ./...
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/term/render/terminal-view.tsx pkg/wcore/workspace.go pkg/wcore/layout.go
git commit -m "feat(term): anchor terminal spawn + agent session cwd to Space dir"
```

---

## Task 11: wsh `workspace create --dir` command

Give the CLI a way to create a Space bound to a directory, mirroring the RPC. There is currently no `create` subcommand and no `CreateWorkspace` wsh RPC — a `WorkspaceListCommand` exists as the pattern to follow.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-workspace.go`
- Modify: `pkg/wshrpc/wshrpctypes.go` (add `CreateWorkspaceCommand` to the interface, near line 178)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (implement it, near `WorkspaceListCommand` line 953)
- Regenerate: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`

- [ ] **Step 1: Define the RPC request type + interface method**

In `pkg/wshrpc/wshrpctypes.go`, add a request struct (near other command data types) and the interface method (near line 178, next to `WorkspaceListCommand`):

```go
type CreateWorkspaceData struct {
	Name string `json:"name,omitempty"`
	Dir  string `json:"dir,omitempty"`
}
```

```go
	CreateWorkspaceCommand(ctx context.Context, data CreateWorkspaceData) (string, error)
```

Add the command string constant alongside the other `Command_*` constants (search the file for `Command_WorkspaceList` or the equivalent registration and mirror it as `Command_CreateWorkspace = "createworkspace"`). Follow the exact registration pattern the file already uses for `WorkspaceListCommand`.

- [ ] **Step 2: Implement the server method**

In `pkg/wshrpc/wshserver/wshserver.go`, after `WorkspaceListCommand` (line 953):

```go
func (ws *WshServer) CreateWorkspaceCommand(ctx context.Context, data wshrpc.CreateWorkspaceData) (string, error) {
	newWS, err := wcore.CreateWorkspace(ctx, data.Name, "", "", true, false, data.Dir)
	if err != nil {
		return "", fmt.Errorf("error creating workspace: %w", err)
	}
	return newWS.OID, nil
}
```

Confirm `wcore` and `fmt` are imported in wshserver.go (they are used elsewhere in the file).

- [ ] **Step 3: Regenerate wsh clients**

Run:

```bash
task generate
```

Expected: `wshclient.go` gains `CreateWorkspaceCommand(...)` and `frontend/app/store/wshclientapi.ts` gains the TS binding.

- [ ] **Step 4: Add the cobra subcommand**

In `cmd/wsh/cmd/wshcmd-workspace.go`, register a `create` subcommand:

```go
func init() {
	workspaceCommand.AddCommand(workspaceListCommand)
	workspaceCreateCommand.Flags().StringVar(&workspaceCreateDir, "dir", "", "project directory to bind the workspace to (required)")
	workspaceCreateCommand.Flags().StringVar(&workspaceCreateName, "name", "", "workspace name (defaults to dir basename)")
	workspaceCommand.AddCommand(workspaceCreateCommand)
	rootCmd.AddCommand(workspaceCommand)
}

var workspaceCreateDir string
var workspaceCreateName string

var workspaceCreateCommand = &cobra.Command{
	Use:     "create --dir <path> [--name <name>]",
	Short:   "Create a workspace bound to a project directory",
	Run:     workspaceCreateRun,
	PreRunE: preRunSetupRpcClient,
}

func workspaceCreateRun(cmd *cobra.Command, args []string) {
	if workspaceCreateDir == "" {
		WriteStderr("--dir is required\n")
		return
	}
	wsId, err := wshclient.CreateWorkspaceCommand(RpcClient, wshrpc.CreateWorkspaceData{
		Name: workspaceCreateName,
		Dir:  workspaceCreateDir,
	}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		WriteStderr("Unable to create workspace: %v\n", err)
		return
	}
	WriteStdout("%s\n", wsId)
}
```

Confirm the generated `wshclient.CreateWorkspaceCommand` signature matches (arg order `(client, data, opts)`); adjust the call to match what codegen produced (check `wshclient.go`).

- [ ] **Step 5: Build**

Run:

```bash
go build ./...
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add cmd/wsh/cmd/wshcmd-workspace.go pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts
git commit -m "feat(wsh): add 'workspace create --dir' command"
```

---

## Task 12: Migration — discard directory-less legacy workspaces on startup

Per spec §7: no backward compat. On startup, workspaces without `workspace:dir` are discarded/reset (dev-era data only).

**Files:**
- Modify: startup path that lists/loads workspaces. Read `pkg/wcore/workspace.go` `ListWorkspaces` and its startup callers, and `emain/emain-tabview.ts:76` (`WorkspaceListCommand`) to find the earliest reliable startup hook.

- [ ] **Step 1: Locate the startup workspace-load hook**

Run:

```bash
grep -rn 'ListWorkspaces\|EnsureInitialData\|bootstrap' pkg/wcore/ pkg/service/ emain/ --include=*.go --include=*.ts
```

Read the results and pick the single earliest server-side hook that runs once at startup before windows are created (prefer a Go-side hook so migration is authoritative).

- [ ] **Step 2: Write a failing test for the discard logic**

Add to `pkg/wcore/workspace_test.go`:

```go
func TestDiscardDirlessWorkspaces(t *testing.T) {
	ctx := setupWorkspaceTestWStore(t)
	withDir, err := CreateWorkspace(ctx, "", "", "", true, false, "/tmp/proj")
	if err != nil {
		t.Fatalf("create with dir: %v", err)
	}
	dirless, err := CreateWorkspace(ctx, "", "", "", true, false, "")
	if err != nil {
		t.Fatalf("create dirless: %v", err)
	}
	if err := DiscardDirlessWorkspaces(ctx); err != nil {
		t.Fatalf("discard: %v", err)
	}
	list, err := ListWorkspaces(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	ids := map[string]bool{}
	for _, w := range list {
		ids[w.WorkspaceData.OID] = true
	}
	if !ids[withDir.OID] {
		t.Fatalf("dir-backed workspace was wrongly discarded")
	}
	if ids[dirless.OID] {
		t.Fatalf("dirless workspace was not discarded")
	}
}
```

Note: confirm the element shape of `ListWorkspaces` return (`WorkspaceList`) — adapt `w.WorkspaceData.OID` to the actual field (it may be `w.OID` directly). Read `ListWorkspaces` before finalizing.

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
go test ./pkg/wcore/ -run TestDiscardDirlessWorkspaces -v
```

Expected: FAIL — `DiscardDirlessWorkspaces` undefined.

- [ ] **Step 4: Implement `DiscardDirlessWorkspaces`**

In `pkg/wcore/workspace.go`, add:

```go
// DiscardDirlessWorkspaces removes any workspace that has no workspace:dir
// meta. Space = Project requires every Space to be bound to a directory; this
// clears dev-era data from before that model. No backward compatibility.
func DiscardDirlessWorkspaces(ctx context.Context) error {
	list, err := ListWorkspaces(ctx)
	if err != nil {
		return fmt.Errorf("error listing workspaces: %w", err)
	}
	for _, entry := range list {
		wsId := entry.WorkspaceData.OID // adapt to actual field
		ws, err := GetWorkspace(ctx, wsId)
		if err != nil {
			continue
		}
		if ws.Meta.GetString(waveobj.MetaKey_WorkspaceDir, "") == "" {
			if _, _, err := DeleteWorkspace(ctx, wsId, true); err != nil {
				log.Printf("error discarding dirless workspace %s: %v", wsId, err)
			}
		}
	}
	return nil
}
```

Adapt the `entry` field access to the actual `WorkspaceList` element type.

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
go test ./pkg/wcore/ -run TestDiscardDirlessWorkspaces -v
```

Expected: PASS.

- [ ] **Step 6: Call it at startup**

Wire `DiscardDirlessWorkspaces(ctx)` into the startup hook found in Step 1 (log and continue on error; do not block boot). Show the exact edit at the chosen call site.

- [ ] **Step 7: Build + full wcore test run**

Run:

```bash
go build ./...
go test ./pkg/wcore/ -v
```

Expected: build exit 0; all wcore tests pass.

- [ ] **Step 8: Commit**

```bash
git add pkg/wcore/workspace.go pkg/wcore/workspace_test.go <startup-hook-file>
git commit -m "feat(workspace): discard directory-less legacy workspaces on startup"
```

---

## Task 13: Full-stack verification

**Files:** none (verification only)

- [ ] **Step 1: Regenerate everything and confirm clean tree**

Run:

```bash
task generate
git status --short
```

Expected: no unexpected diffs (all generated files already committed).

- [ ] **Step 2: Backend build + tests**

Run:

```bash
go build ./...
go test ./pkg/wcore/... ./pkg/service/... ./pkg/waveobj/...
```

Expected: all pass.

- [ ] **Step 3: Frontend typecheck + targeted tests**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run frontend/app/sourcecontrol/
```

Expected: no new type errors; source-control tests at baseline.

- [ ] **Step 4: Manual smoke (document result, do not automate)**

Launch the app (`task dev` or the repo's dev command). Verify:
  - "New Space" in the WorkspaceSwitcher opens a native folder picker.
  - Cancelling the picker creates no Space.
  - Selecting a folder creates a Space named after the folder and switches to it in the same window.
  - The file explorer roots at the selected folder.
  - Running `cd` in a terminal does NOT move the file explorer / git panel root.
  - Agent conversations for the Space group under one project (session banner lists that project's sessions).

- [ ] **Step 5: Final confirmation**

No commit — this task gates the branch as ready for review/merge.

---

## Self-Review Notes (author checklist, verify during execution)

- **Spec §3 (data model):** Task 1. No `MetaDataDecl` registry exists — declaration = struct tag + regen. Documented in preface.
- **Spec §4 (cwd SSoT):** Tasks 6-9 (`workspaceDirAtom` + repoint all consumers + delete dead atoms).
- **Spec §5 (creation flow):** Tasks 2-5 (Go core → RPC → Electron IPC → New Space picker).
- **Spec §6 (agent grouping):** Task 10 (agent session cwd = workspace dir).
- **Spec §7 (migration):** Task 12.
- **Spec §8 (affected files):** all rows covered across Tasks 1-12.
- **Type consistency:** `CreateWorkspace` Go arity is `(ctx, name, icon, color, applyDefaults, isInitialLaunch, dir)` everywhere; TS `WorkspaceService.CreateWorkspace(name, icon, color, applyDefaults, dir)`; `env.electron.createWorkspace(dir)`; `selectDirectory(): Promise<string|null>`; atom name `workspaceDirAtom` used identically in Tasks 6-10.
- **Open verification points flagged inline** (must be resolved by reading during execution, not left as guesses): `Workspace.Meta` persistence via `DBInsert` (Task 2 Step 3), `WorkspaceList` element field shape (Tasks 12), portable-layout terminal block cwd injection hook (Task 10 Step 4), wsh command registration pattern (Task 11).
