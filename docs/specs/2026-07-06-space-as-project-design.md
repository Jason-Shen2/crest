# Space = Project (Working Directory) — Design

Date: 2026-07-06
Status: Approved (design), pending implementation plan

## 1. Motivation

crest currently models a Workspace as a pure container of Tabs (Name / Icon /
Color / TabIds) with no directory binding. The working directory (cwd) is
derived from whichever terminal block is focused: file explorer, editor, and
git panel all follow that block's `cmd:cwd`, updating whenever the user runs
`cd`.

This does not match the mainstream CLI / IDE ecosystem (Pi, Aider, Claude Code,
VS Code) where **one project = one working directory = one conversation
context**. Mixing multiple projects' agent conversations in one space produces a
poor experience: no project-level isolation, no focus.

The target product shape: open/create a project as a Space bound to a working
directory. Inside it, the user chats / vibe-codes with the agent, reviews code
in an editor, and browses local previews / docs. Everything is scoped to one
project, so the workspace stays simple and focused.

Notably, the agent session store is **already** directory-centric: sessions live
under `sessions/{encodedCwd}/...` (see `emain/agent/sessions.ts`). The gap is
that the Workspace layer has no directory concept — cwd is scattered and follows
the focused block. This redesign promotes "working directory" to a first-class,
immutable property of a Space, making it the single source of truth (SSoT) that
all sub-views derive from.

## 2. Decisions (confirmed)

- **Binding**: directory is chosen at Space creation time and is **immutable**
  thereafter. Changing directory = create a new Space.
- **Internal organization**: keep Tabs / TileLayout. Tabs are demoted from
  "independent workspaces" to "different views/conversations of the same
  project"; all Tabs in a Space share the Space directory.
- **cwd SSoT**: file explorer / editor / git / agent all anchor to the Space
  root directory. A terminal `cd` affects only that terminal, not other views.
- **Storage of the directory**: on `Workspace.Meta["workspace:dir"]` (Plan B —
  no change to the core `Workspace` struct).
- **Migration**: no backward compatibility. Legacy workspaces without a
  directory are discarded/reset on startup (dev-era data only).
- **New Space flow**: pick a directory via a native dialog, then create and
  switch to the Space in the current window (no new OS window).
- **Scope of this round**: core refactor only (data model + cwd SSoT + creation
  flow). This is almost entirely a backend / state-model change — the only UI
  touch is the "New Space" directory picker (§5). No layout rework.

## 3. Data Model

Add a meta field carrying the directory. Source of truth is the meta declaration
struct; `metaconsts.go` and the TS types are generated from it.

- In `pkg/waveobj/wtypemeta.go` `MetaTSType`, add:
  ```go
  WorkspaceDir string `json:"workspace:dir,omitempty"`
  ```
- Register the meta key declaration with `Entity: ["workspace"]`, `Type:
  "string"`, description noting it is set at creation and immutable.
- Regenerate `metaconsts.go` (adds `MetaKey_WorkspaceDir = "workspace:dir"`) and
  `frontend/types/gotypes.d.ts` via tsgen.

Directory value semantics:
- Written once into `Workspace.Meta["workspace:dir"]` at creation.
- Treated as immutable: no setter RPC, no UI edit affordance.
- SSoT for all cwd needs.

## 4. cwd Single Source of Truth

Today `focusedBlockCwdAtom` (`frontend/app/fileexplorer/file-explorer-atoms.ts`)
derives cwd from the focused terminal block's `cmd:cwd`. Consumers: file
explorer, command palette, `GitModel.syncCwd()`.

Changes:
- Add `workspaceDirAtom`: reads the current workspace's `workspace:dir`.
- Repoint file explorer / editor / git / agent session cwd to `workspaceDirAtom`.
  These no longer follow terminal `cd`.
- Terminal blocks still initialize their cwd from `workspace:dir`, but an
  in-terminal `cd` affects only that terminal.
- Rewrite `focusedBlockCwdAtom` consumers to use `workspaceDirAtom`; delete the
  now-unused focused-block-cwd derivation and `focusedCwdAtom` back-compat shim.

## 5. Space Creation Flow (Open Folder)

There is currently no directory picker (only a save dialog).

- Electron main: add IPC `select-directory` calling
  `dialog.showOpenDialog({ properties: ["openDirectory"] })`; expose
  `selectDirectory()` in `emain/preload.ts`.
- WorkspaceSwitcher "New Space" entry: first open the directory picker; on
  selection, create a workspace with that directory. Cancelling the picker
  cancels creation (never produces a directory-less Space).
- `pkg/wcore/workspace.go` `CreateWorkspace` gains a `dir` parameter written into
  `Meta["workspace:dir"]`. Default `Name` = directory basename.
- Propagate the `dir` parameter through: wsh `workspace` command
  (`cmd/wsh/cmd/wshcmd-workspace.go`), the workspace service, and preload
  `createWorkspace`.
- New Space is created and switched to in the current window.

Tabs / TileLayout are retained; all Tabs in the Space share the Space directory.

## 6. Agent Session Grouping (already aligned)

Sessions already store under `sessions/{encodedCwd}/`. After the refactor the
pane agent session's cwd comes from `workspace:dir` instead of the focused
block, so:
- All conversations in a Space fall under the same `encodedCwd` group — natural
  project-level isolation.
- The "past conversations in this project" banner lists sessions by
  `workspace:dir`.
- Immutable directory means the storage path is permanently stable — no session
  migration needed.

## 7. Migration

- No backward compatibility. On startup, if a workspace lacks `workspace:dir`,
  discard/reset it (dev-era data only).
- Update `pkg/wcore/workspace_test.go` to cover the new creation signature and
  directory write.

## 8. Affected Files

| Layer     | File                                              | Change                                   |
| --------- | ------------------------------------------------- | ---------------------------------------- |
| Go model  | `pkg/waveobj/wtypemeta.go`                         | add `WorkspaceDir` meta field + decl     |
| Go gen    | `pkg/waveobj/metaconsts.go`, `frontend/types/gotypes.d.ts` | regenerate via tsgen            |
| Go core   | `pkg/wcore/workspace.go`                           | `CreateWorkspace` takes `dir`, writes meta|
| Go wsh    | `cmd/wsh/cmd/wshcmd-workspace.go`                  | command gains `dir`                      |
| Electron  | `emain/emain-ipc.ts`, `emain/preload.ts`          | `select-directory` IPC + `selectDirectory`|
| Frontend  | `frontend/app/fileexplorer/file-explorer-atoms.ts`| add `workspaceDirAtom`, rewrite derivation|
| Frontend  | `frontend/app/tab/workspaceswitcher.tsx`          | New Space uses directory picker          |
| Frontend  | file-explorer, command palette, GitModel          | consume `workspaceDirAtom`               |
| Agent     | `emain/agent-ipc.ts`, pane session                | cwd from workspace dir                    |
| Tests     | `pkg/wcore/workspace_test.go`                      | new creation signature + dir             |

## 9. Out of Scope (this round)

- Fixed UI layout with dedicated agent / editor / browser regions.
- One-project-per-OS-window model.
- Session-list-switcher replacing Tabs.

This round is almost entirely a backend / state-model change; the only UI touch
is the "New Space" directory picker. Any broader UI/layout rework is explicitly
not part of this effort.
