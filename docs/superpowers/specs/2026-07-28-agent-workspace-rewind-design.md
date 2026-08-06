# Agent Workspace Rewind Design

**Status:** Implemented on supported platforms

**Date:** 2026-07-28

**Storage and restore reference:** OpenCode Core v2 selective restore

**Lifecycle and command reference:** Pi / pi-rewind per-turn checkpoint mapping and `/rewind` UX (clean-room design only)

**Crest-owned hardening:** multi-session ownership checks, drift detection, durable refs, crash journal, and workspace locking

**Performance addendum:** Logical per-turn checkpoints now consume physical
snapshots from a canonical-workspace incremental tracker. Full capture remains
the correctness fallback for cold start and continuity gaps. The root-cause
analysis, implementation, preserved invariants, benchmark, and remaining
limits are recorded in
[`2026-08-04-agent-workspace-rewind-incremental-snapshot-design.md`](./2026-08-04-agent-workspace-rewind-incremental-snapshot-design.md).

## Purpose

Crest can already move an agent session's append-only conversation tree to an
earlier entry, but doing so does not restore workspace files. This design adds
an explicit, reversible operation that restores both:

1. the conversation to immediately before a selected user turn; and
2. the files changed by that turn and all later turns on the active branch.

The mechanism must not depend on `write`, `edit`, or any other particular tool.
Its authoritative input is the workspace state observed at user-turn
boundaries.

## Decision Summary

Crest will implement a clean-room hybrid of the strongest parts of existing
products:

- A private shadow Git object store records workspace trees without changing
  the user's Git HEAD, index, branches, commits, or stash.
- Every completed user turn stores its before tree, after tree, and exact
  changed-path manifest in the session's append-only entry tree.
- Rewind restores only the union of paths attributed to the selected active
  branch suffix. It never runs whole-workspace `reset --hard` or `clean -fd`.
- A safety/tip snapshot is persisted before restore and becomes the source for
  Redo.
- Drift checks fail closed by default. A conflicting preview may offer an
  explicit, narrowly scoped Force Revert that overwrites only the displayed
  drift-conflict paths after capturing their current state for Redo.
- Conversation movement happens only after file restore and verification
  succeed. A recovery journal bridges the unavoidable filesystem/SQLite
  transaction boundary.

The first product release has two equivalent entry points:

- an OpenCode-style Revert action beside every eligible user message; and
- a dedicated `/rewind` command for keyboard-first historical selection.

Both open the same server-planned file preview. Existing `/tree` remains
conversation-only.

## Reference Provenance and Crest-Owned Decisions

This design is a clean-room synthesis, not a port of either project. The table
below records the source of inspiration for every major decision.

| Design decision | OpenCode reference | pi-rewind reference | Crest decision and differences |
| --- | --- | --- | --- |
| Internal Git-backed snapshot store | Primary reference. OpenCode captures internal Git trees and restores them without user commits. See [`snapshot.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/snapshot.ts). | pi-rewind also maintains private per-session checkpoints. | Crest uses a canonical-workspace store shared by sessions and namespaced by workspace/session identity. It also supports non-Git workspaces. |
| Bind file state to a completed user turn | OpenCode records step snapshots around assistant work, while its public undo boundary is a user message. | Primary lifecycle reference. pi-rewind records `beforeCommit` and `afterCommit` against `userEntryId`/`turnId`. See [`index.ts`](https://github.com/ayu-exorcist/oh-my-pi/blob/main/extensions/pi-rewind/src/index.ts). | Crest binds `beforeTree` and `afterTree` directly to the existing user-message entry ID. Crest adds explicit harness lifecycle events because Pi's low-level `turn_end` is not a reliable user-turn transaction boundary in Crest. |
| Selectively restore files affected after the boundary | Primary reference. OpenCode builds a per-path restore plan from later snapshots, keeps the earliest source state for each path, and touches only those paths. See [`revert.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/revert.ts) and [`snapshot.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/snapshot.ts). | Not adopted: pi-rewind's checkpoint restore is closer to restoring a complete repository state. | Crest adopts OpenCode's selective-path semantics, then adds explicit absent, excluded, symlink, directory, and unsafe-type states. |
| Suffix union plus earliest pre-change state per path | Primary reference. OpenCode's revert plan walks later snapshots and keeps the first `snapshot.start` seen for each file. | No direct reference. | Crest applies the rule to completed user turns: union all `changedPaths` after the target, then restore each path from the earliest relevant `beforeTree`. |
| Preview before restore | OpenCode exposes snapshot `preview()` and a selective file plan. | pi-rewind exposes checkpoint selection and code-plus-conversation, conversation-only, and code-only restore modes. See the [pi-rewind README](https://github.com/ayu-exorcist/oh-my-pi/blob/main/extensions/pi-rewind/README.md). | Crest previews paths, conflicts, and ownership warnings, then recomputes the plan on confirmation so a stale preview cannot authorize a changed restore. |
| Preserve the current tip for reversal | Primary reference. OpenCode stages the current snapshot before revert and uses it to clear the revert. | pi-rewind does not currently expose a product-level `/redo`. | Crest persists a safety tree and records a one-step redo marker in hidden workspace state. New user work invalidates it. |
| `/rewind` command name and checkpoint picker | OpenCode uses `/undo`, not `/rewind`. See the [OpenCode TUI commands](https://opencode.ai/docs/tui/). | Primary command reference. pi-rewind registers `/rewind`, selects an earlier checkpoint, and can restore code and conversation to before that prompt. | Crest keeps `/rewind` because it can select any eligible earlier user turn and because `/tree` already means conversation navigation. Crest does not reuse pi-rewind's restore engine. |
| `/redo` command name and user model | Primary command reference. OpenCode exposes `/redo` after `/undo` and restores the undone message and file changes. See the [OpenCode TUI commands](https://opencode.ai/docs/tui/) and [`use-session-commands.tsx`](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/pages/session/use-session-commands.tsx). | No `/redo` command is registered by the current pi-rewind extension. | Crest adopts the familiar name but deliberately limits the first release to one-step redo. Its redo record, safety checks, and recovery are Crest-specific. |
| Message-side Revert action | Primary UI reference. OpenCode renders a reset action beside each user message. See [`message-part.tsx`](https://github.com/anomalyco/opencode/blob/017a5977d2107092007623e507fc5c6eb337d3b2/packages/session-ui/src/components/message-part.tsx#L1382-L1394). | No direct reference. | Crest adds the action to its existing user-message action bar and routes it through preview before mutation. OpenCode currently stages the revert directly; Crest deliberately adds confirmation because its shared-workspace safety model is stricter. |
| Post-revert recovery/Redo surface | Primary UI reference. OpenCode renders rolled-back messages in a collapsible dock above the composer with restore actions. See [`session-revert-dock.tsx`](https://github.com/anomalyco/opencode/blob/017a5977d2107092007623e507fc5c6eb337d3b2/packages/app/src/pages/session/composer/session-revert-dock.tsx#L161-L180). | No direct reference. | Crest uses the same placement and persistent-dock pattern, but the first release shows one operation summary and a single `Redo` action rather than per-message forward stepping. |
| Red drift warning and `Force revert` | Not present in the current OpenCode `dev` implementation. OpenCode's current core restore path does not expose this conflict UX. | Not present. | Crest-owned product requirement. Only live-state drift/ownership mismatches are forceable. Missing snapshots, unsafe paths/types, stale leaves, busy sessions, and recovery-journal unknown states remain hard blockers. |
| Keep `/tree` conversation-only | OpenCode has no equivalent conversation-tree command in this flow. | pi-rewind can optionally synchronize code while navigating Pi's tree. | Crest deliberately does not overload the existing `/tree`; combined conversation-and-code restoration remains explicit through `/rewind`. |
| Multi-session isolation and conflict handling | No equivalent guarantee in the referenced rewind flow. | No equivalent guarantee. | Crest-owned requirement. Normal Revert never overwrites a path whose live state no longer matches the session's expected state. The user may explicitly Force Revert the exact red-listed drift paths after being warned that they may contain manual or other-session edits. |
| Durable refs, workspace lock, crash journal, scope identity, quotas, and garbage collection | OpenCode supplies the snapshot/restore basis and a useful precedent for limiting untracked-file capture. | pi-rewind supplies lifecycle and checkpoint-retention precedents. | The concrete durability protocol, recovery journal, lock ordering, canonical workspace identity, scope/incarnation identity, descriptor schema, and quotas are Crest-owned production hardening. |

### Command Naming Decision

- **`/rewind` is primarily referenced from pi-rewind.** The name and the
  interaction of choosing an earlier prompt/checkpoint come from that
  extension. Crest does not adopt its whole-state restore behavior or failure
  policy.
- **`/redo` is primarily referenced from OpenCode.** OpenCode exposes `/undo`
  and `/redo`; pi-rewind currently exposes `/rewind` but not `/redo`. Crest's
  exact one-step redo representation is newly designed for Crest's append-only
  session tree.
- **The `/rewind` plus `/redo` combination is a Crest product synthesis.** It
  combines pi-rewind's arbitrary historical selection, OpenCode's reversible
  restore model, and Crest's existing `/tree` semantics.
- **Crest does not rename `/rewind` to `/undo`.** OpenCode's `/undo` targets the
  latest user message, while Crest's `/rewind` can target any eligible earlier
  user turn. Calling both behaviors `/undo` would hide that distinction.

### UI Reference Decision

- **Directly from OpenCode:** put a Revert action in the user-message action
  row, hide it while the session is running, and show a persistent recovery
  dock above the composer after a successful revert.
- **Adapted for Crest:** clicking Revert opens a file preview instead of
  mutating immediately. The same preview is used by `/rewind`.
- **Crest-owned:** red conflict rows, the exact warning
  `files changed on disk since the agent last wrote them`, and the
  `Force revert` action. These do not exist in the current OpenCode `dev`
  implementation and must not be described as copied OpenCode behavior.
- **Terminology:** UI labels use `Revert`/`Redo`, matching OpenCode's
  message-action vocabulary. `/rewind` remains the keyboard command because it
  includes a historical target picker.

### Explicitly Not Reused

- No pi-rewind source code is copied; the lifecycle and UX concepts are
  reimplemented clean-room.
- Crest does not depend on OpenCode or pi-rewind at runtime.
- Crest does not use `git reset --hard`, `git clean -fd`, or a workspace-wide
  checkout.
- Crest does not move the conversation pointer after a failed code restore.
- Crest does not assume that the user's workspace is a Git repository.
- Crest does not copy OpenCode's direct-click mutation; all UI and command
  entry points preview the exact server-side plan before applying it.

## Goals

- Capture changes made through `write`, `edit`, shell commands, hosted PTYs,
  CLI subagents, and future tools without naming those tools.
- Bind each checkpoint directly to the user message entry ID already used as
  Crest's `turnId`.
- Restore creates, writes, deletes, renames, binary files, symlinks, and the
  executable bit within the supported snapshot scope.
- Support both Git and non-Git workspaces.
- Keep user Git state untouched.
- Provide preview, conflict detection, rollback-on-failure, and Redo.
- Provide both a message-side Revert action and keyboard-first slash commands.
- Show every planned file operation before mutation, and require an explicit
  destructive Force Revert when displayed live-state drift would otherwise
  block the operation.
- Preserve abandoned conversation branches.
- Keep live and reopened/cold sessions behaviorally identical.

## Non-Goals

- Perfect attribution when a user, background process, or another agent
  session modifies the same physical workspace during a turn.
- Reverting process state, package-manager side effects outside the workspace,
  databases, network calls, services, or files outside the canonical workspace
  root.
- Capturing ignored files, nested repository contents, empty directories,
  ownership, timestamps, ACLs, xattrs, hard-link topology, or full POSIX mode
  metadata.
- Replacing Git as durable project history.
- Adding worktree isolation.
- Force-overriding missing snapshots, unsafe path/type conflicts, stale session
  state, busy sessions, or unknown crash-recovery states.
- Multi-step forward history in the first release; Redo restores only the most
  recent successful Revert/Rewind.

## Existing Crest Foundations

Crest already has most of the conversation-side primitives:

- `turnId` is exactly the `SessionTreeEntry.id` of the user message that starts
  the UI turn. No mapping table is needed.
- Session entries form an append-only parent tree in one SQLite file per
  session.
- Moving the active leaf preserves the abandoned suffix as another branch.
- `SessionStorage.appendEntries(..., { expectedLeafId })` provides a
  compare-and-swap boundary and is transactional in the production SQLite
  carrier.
- `getTransactionForkBoundary(entries, userEntryId, "before")` resolves the
  true boundary before ordinary and context-transactional user messages.

The implementation must not treat `targetUser.parentId` as the general
"before turn" boundary. A context-prepared user message may point to a
transaction manifest, and the first user message may correctly resolve to a
`null` boundary.

Workspace-control entries introduce two distinct leaf identifiers:

- `semanticLeafId` is the opaque raw storage leaf, including hidden checkpoint
  or workspace-state entries. It is the only valid SQLite compare-and-swap
  token and the only token used to decide Redo validity.
- `displayLeafId` is the visible effective leaf after hidden-entry filtering.
  It is used only to render `/tree` and must never be converted back into a
  mutation token.

Live/cold session state, rewind-point listing, preview responses, Redo
availability, and every mutation result carry both values. The renderer passes
the latest `semanticLeafId` back as `expectedSemanticLeafId`; it never infers a
raw leaf from the displayed tree. Each displayed tree row also carries its
server-derived semantic navigation anchor. The server revalidates that anchor
from the current raw tree before navigation.

Anchor selection is deterministic:

- selecting the current `displayLeafId` retains the current
  `semanticLeafId`, making it a physical no-op;
- selecting any other row starts from that visible entry (or its
  transaction-aware before-turn boundary for a user row) and follows only the
  canonical terminal `workspace_checkpoint` anchor for that conversation
  boundary;
- historical `workspace_state` markers are never navigation anchors, so
  leaving a rewound state and later selecting the same visible row cannot
  reactivate an old Redo.

The existing live `/tree` path goes through the harness while the cold path
moves the session directly. Rewind therefore needs one shared coordinator
rather than a file-restore hook attached only to live harness navigation.

## Product Semantics

### `/tree`

Unchanged:

- navigates conversation history only;
- does not capture/read workspace snapshot bytes or restore files;
- may be used to inspect or switch branches independently of workspace state.

Internally, `/tree` sends the selected visible entry plus the current
`expectedSemanticLeafId`; the backend moves to the selected row's semantic
navigation anchor, not blindly to the visible entry ID. User-message targets
still resolve through the transaction-aware before-turn boundary. Thus
conversation-only navigation preserves hidden checkpoint coverage and selecting
the current visible tip is a physical no-op without reviving historical
workspace state.

### Message-side Revert

Every eligible user message exposes a reset/Revert action in the existing
message action row beside Copy and Edit:

- the latest eligible message keeps the action visible;
- older eligible messages reveal it on hover or keyboard focus;
- the action is hidden or disabled while that session is running, when its
  checkpoint is unavailable, or when recovery has frozen the workspace; and
- the action carries the message's persisted `turnId`; the renderer never
  infers a checkpoint from array position or visible text.

This placement and action vocabulary directly reference OpenCode's user-message
Revert control. Unlike OpenCode's current direct-stage behavior, clicking it
does not mutate files immediately. It opens the shared Revert preview dialog
for that exact turn.

### `/rewind`

1. Requires the selected session to be idle.
2. Lists checkpointed user turns on the current active branch only.
3. Defaults focus to the most recent rewindable turn.
4. Selecting a turn scrolls/reveals that message when possible and opens the
   same Revert preview dialog as the message-side action.
5. On success:
   - affected files match the state immediately before the selected user turn;
   - the conversation leaf moves to the transaction-aware boundary immediately
     before that turn;
   - the selected prompt is restored to the composer for editing and resending;
   - a hidden rewind-state entry enables Redo.

If any checkpoint is missing between the selected turn and the current active
tip, combined code-and-conversation rewind is unavailable for that target.
`/tree` remains available for conversation-only navigation.

### Shared Revert Preview and Force Revert

> 2026-08-01 UI/content amendment: the approved two-pane preview, reverse-diff
> semantics, Git Diff-style file list, and component reuse boundaries are
> specified in
> [`2026-08-01-agent-rewind-diff-preview-design.md`](./2026-08-01-agent-rewind-diff-preview-design.md).

The message action and `/rewind` share one server-authored preview. The dialog
shows:

- a file-focused review surface; the selected message/selector already provides
  target context, so the dialog does not repeat the prompt or message count;
- every effective file operation grouped as create, write, delete, or rename;
- an expandable diff for supported file kinds;
- coverage warnings for paths that cannot be restored; and
- one status per path: clean, forceable drift conflict, or hard blocker.

The renderer receives display rows but never supplies the restore path set.
Confirmation always recomputes the plan under the mutation lease and workspace
lock.

When there is no conflict, the footer shows `Cancel` and `Revert`. When at least
one forceable drift conflict exists and there is no hard blocker:

- each conflicting path is rendered in the destructive/red state;
- the canonical warning is shown exactly as
  **`files changed on disk since the agent last wrote them`**;
- ordinary `Revert` is unavailable; and
- the only mutation action is the destructive `Force revert` button. `Cancel`
  always remains available.

If any hard blocker exists, the dialog shows its reason and only `Cancel`;
neither Revert nor Force Revert is available.

Force Revert is intentionally narrow:

- it may bypass only a live-state drift/ownership mismatch for the exact paths
  shown in red;
- it warns that those bytes may be manual edits or work from another Agent
  Session;
- confirmation is rejected as stale if the semantic leaf, workspace
  incarnation, plan, or conflict set has changed since the displayed preview;
- after revalidation, Crest captures the current live states in the durable
  safety snapshot before overwriting them, so Redo can restore the force-time
  state; and
- it can never bypass a missing/unavailable checkpoint, path or symlink escape,
  excluded/unsafe entry kind, file/directory collision, busy session, corrupt
  metadata, or frozen recovery journal.

Normal Revert therefore never overwrites another actor's detected changes.
Force Revert is the explicit user-authorized exception, limited to the
displayed affected paths rather than the whole workspace.

### `/redo`

- Redo is available only when the current semantic leaf is a valid hidden
  rewind-state entry for the same session.
- It restores the affected paths from the safety/tip tree captured by that
  rewind and restores the prior model-visible conversation branch. A new
  hidden redo marker becomes the semantic leaf, with the prior leaf as its
  conversation parent.
- Redo performs the same drift checks, verification, journal, and rollback
  protocol as rewind.
- The first release provides one-step Redo for the most recent rewind. A later
  rewind replaces the currently offered Redo.
- Sending a new user prompt from a rewound state naturally invalidates that
  Redo: the rewind-state entry is no longer the current leaf.
- After a successful Revert/Rewind, Crest shows an OpenCode-style persistent
  dock immediately above the composer. Its collapsed state displays
  `Reverted <message-count> messages · <file-count> files` and a visible
  `Redo` action. Expanding it shows the restored file list and target prompt.
- `/redo` and the dock's `Redo` button invoke the same dedicated backend
  operation. Redo availability is derived from persisted session state, so the
  dock survives reload and cold-session resume.

## Architecture

The implementation is split into four layers.

### 1. Git Process and Shadow Store

New modules under `packages/coding-agent/checkpoints/` own:

- a shell-free `node:child_process.spawn` Git runner;
- private repository initialization;
- tree capture and durable refs;
- NUL-safe tree diff parsing;
- exact selective restore;
- path containment and workspace coverage;
- typed errors and verification.

No third-party Git dependency is required.

The Electron main process injects Crest's data root into this package. Snapshot
objects live outside both the workspace and session database:

```text
<wave-data>/agent-checkpoints/workspaces/<sha256(canonical-realpath)>/
  repo.git/
  journal/
  lock/
```

The directory is created with user-only permissions. The workspace identity is
the SHA-256 of its canonical real path, not a lossy path encoding. Every
journal also records a workspace incarnation (POSIX device/inode or the
platform-equivalent file identity). If a path is deleted and recreated, an old
journal cannot be applied to the new directory merely because its text path is
the same. Snapshot descriptors, checkpoint entries, and workspace-state
entries carry that same incarnation. A capture whose before/after incarnations
differ is unavailable; planning requires every suffix boundary to match the
current incarnation exactly.

All Git commands use argv execution with:

- `shell: false`;
- explicit shadow `GIT_DIR` for object-store commands, with no user object
  alternates or mutable shadow index;
- inherited `GIT_CONFIG_*`, object-directory, alternates, and pathspec
  environment variables removed;
- literal pathspec mode for every path-bearing command;
- `GIT_TERMINAL_PROMPT=0`;
- deterministic locale;
- bounded stdout/stderr;
- timeout and abort support;
- hooks disabled and `core.autocrlf=false`.

Snapshot bytes do not pass through `git add` or checkout filters. Capture
enumerates eligible filesystem entries, writes regular-file and symlink bytes
with raw `hash-object --no-filters`, and constructs trees with Git plumbing.
Restore reads raw blobs with `cat-file` and applies them through containment-
checked filesystem operations. This avoids `.gitattributes` clean/smudge,
`text`, `eol`, and `working-tree-encoding` transformations.

Logical checkpoint creation and physical snapshot construction are decoupled.
Every durable user turn still receives exactly one available or unavailable
checkpoint. One process-wide tracker is shared only by Sessions with the same
canonical workspace identity and incarnation. A healthy warm no-change boundary
reuses the current immutable ref; a dirty boundary validates and hashes only
dirty paths, then copy-on-write updates their path-state ancestors. The tracker
and its caches are physical shared state. Checkpoint ownership, semantic leaf,
restore authority, and conflict decisions remain Session-local.

The watcher callback is a bounded dirty hint, not evidence that the snapshot is
complete. A persistent cursor detects a history gap. Anchored readers validate
the exact filesystem identity, bytes, symlink/type, executable bit, and Git
index evidence used by the candidate. Full reconcile establishes the initial
baseline and recovers from restart, overflow, cursor gap, invalid tracker state,
scope change, or unsafe evidence. If it cannot restore trust, checkpoint
finalization fails closed as unavailable; it never publishes an available
empty diff from uncertain evidence.

When the workspace is inside a user Git repository, scope discovery is
read-only. An environment-isolated `rev-parse` locates the repository and
worktree, and `ls-files -z` plus ignore queries classify paths. A workspace
that is a repository subdirectory maps only the repository paths beneath that
subtree. Discovery sets `GIT_OPTIONAL_LOCKS=0`, disables fsmonitor and hooks,
does not refresh the index, and never invokes `status`, `add`, filters, or
commands that write Git metadata. Tests require the user's index bytes and
mtime to remain unchanged, including `.git`-file worktrees. A non-Git
workspace uses the same filesystem enumerator and ignore-rule parser without
requiring a repository.

The private store never writes the user's `.git` directory. Captured tree
objects are anchored under `refs/crest/snapshots/<snapshot-id>`. A snapshot ID
is the OID of a descriptor tree. Manifest v1 descriptors contain the workspace
tree and flat scope-manifest blob. New captures write manifest v2, whose
descriptor also owns the content-addressed `state` tree referenced by the
manifest. Readers support both formats, while writers emit only v2. The public
`WorkspaceSnapshotRefV1`, checkpoint, IPC, preview, and restore contracts are
unchanged. The ref therefore keeps the complete selected format reachable.
Session checkpoint/state entries are the logical owners of those snapshot IDs.
In-progress restore objects are separately anchored by an operation descriptor
under `refs/crest/ops/<operation-id>` before any workspace write. That
descriptor references the safety snapshot and any pending result snapshot.
Normal Git garbage collection therefore cannot prune a checkpoint, rollback
source, or Redo source while it is usable.

Object durability precedes reference durability. The store enables Git's
supported loose-object/reference fsync components and probes them during
initialization; on versions without that support it explicitly fsyncs each new
loose object and fanout directory. A descriptor ref is updated only after its
complete blob/tree graph is durable. Git GC and capture share the workspace
store lock, so packing cannot race this protocol.

Retention is reference-aware. A reconciler scans checkpoint/state entries for
all sessions in the canonical workspace, active-boundary pending records, and
recovery journals before retiring snapshot refs. Any owner-source scan failure
fails closed and removes nothing. Fork needs no object copy: its copied entry
becomes another logical owner, so deleting the source session cannot invalidate
the fork. Archive/trash lookup is by session ID rather than the session's
mutable path. Unreferenced refs receive a grace period and a second
reconciliation before Git GC; the production grace is fixed at seven days and
cannot be shortened by renderer or IPC input. Reachable snapshots are never
pruned merely because they are old. The first release retains all checkpoints
while any session entry references them.

Capture has hard resource bounds. The first live boundary establishes a cold
baseline through full reconcile; later trusted boundaries use the shared
tracker. The synchronous pre-turn path has a 5-second deadline;
terminal/background capture has a 30-second deadline. Both
allow 200,000 eligible entries and at most 1 GiB of newly hashed input per
boundary, require at least the greater of 1 GiB or 5% free space, and share a
5 GiB soft quota per canonical workspace store. A boundary that exceeds a
capture limit or encounters `ENOSPC` becomes an unavailable checkpoint; the
agent response continues. The reconciler may remove only unreferenced objects.
If referenced snapshots alone exceed quota, new checkpoints remain unavailable
with a visible cleanup action until session/reference removal frees space.
Archive and recoverable delete-to-trash remain owner sources and therefore do
not release quota. The storage UI may clean only already-unreferenced objects,
or list trashed sessions for an explicit second-confirmation permanent purge.
That purge accepts an opaque, short-lived token rather than a database path or
snapshot ref, follows session-lease then workspace-lock ordering, removes the
trashed session DB, and reruns owner reconciliation. Active or archived
sessions are never directly purgeable from this quota surface.

### 2. Checkpoint Journal in the Session Tree

Each finalized user turn appends one of two hidden custom-entry variants:

```ts
interface AvailableWorkspaceCheckpointV1 {
  schemaVersion: 1;
  status: "available";
  originSessionId: string;
  turnId: string;               // user SessionTreeEntry.id
  workspaceIdentity: string;
  workspaceIncarnation: string;
  before: WorkspaceSnapshotRefV1;
  after: WorkspaceSnapshotRefV1;
  changes: WorkspacePathChangeV1[];
  coverage: WorkspaceSnapshotCoverage;
}

interface UnavailableWorkspaceCheckpointV1 {
  schemaVersion: 1;
  status: "unavailable";
  originSessionId: string;
  turnId: string;
  workspaceIdentity: string;
  workspaceIncarnation?: string;
  reasonCode: WorkspaceCheckpointFailureCode;
  message: string;
  coverage?: WorkspaceSnapshotCoverage;
}
```

```ts
interface WorkspaceSnapshotRefV1 {
  id: string;                    // descriptor-tree OID
  workspaceIdentity: string;
  workspaceIncarnation: string;
  tree: string;
  scopeManifest: string;
}
```

The snapshot ref names both the raw Git tree and an immutable scope manifest;
loading it verifies that both match the descriptor identified by `id`.
The scope manifest is required to query whether an arbitrary missing path was
covered-and-absent or excluded at that boundary. Manifest v2 stores coverage
and scope metadata plus the root OID of a content-addressed path-state tree;
unchanged subtrees are shared between immutable versions. Existing v1 flat
manifests remain readable for old checkpoints but are reconciled to v2 before
incremental mutation.

Each `WorkspacePathChangeV1` contains a UTF-8 project-relative path and
explicit before/after states:

```ts
type CapturedPathStateV1 =
  | { state: "absent" }
  | { state: "file"; oid: string; executable: boolean }
  | { state: "symlink"; oid: string }
  | { state: "excluded"; reason: WorkspaceCoverageReason };

interface WorkspacePathChangeV1 {
  path: string;
  before: CapturedPathStateV1;
  after: CapturedPathStateV1;
}
```

`absent` is an affirmative scope result, not an inference from "tree lookup
failed." If a path is excluded at either boundary, the coordinator never
automatically writes or deletes it. The coverage record carries the gap into
preview.

The manifest is derived from the two shadow snapshots, never from
`ChangeOperation`. Git output is parsed as raw NUL-delimited buffers without
trimming or whitespace splitting. POSIX filenames that are not valid UTF-8 are
outside the first-release restore scope: they are preserved, reported as a
coverage warning, and never sent through a lossy JavaScript string.

Checkpoint and rewind custom entries are hidden from `/tree` and ignored by
model context construction. They still participate in the physical parent
chain so checkpoints travel with branches, forks, and ordinary session
export. Snapshot objects themselves are not embedded in SQLite or JSONL.
Imported sessions whose referenced objects are unavailable report that
checkpoint state explicitly.

Stable constants define `workspace_checkpoint` and `workspace_state`, and
`isWorkspaceControlEntry()` is the single predicate used by tree filtering.
`filterTreeForDisplay` walks through these hidden parents when computing the
`displayLeafId` and rewiring visible children. It preserves the raw
`semanticLeafId` separately. Generic unknown custom entries do not become
implicitly hidden.

Forked sessions may use inherited checkpoints whose `originSessionId` belongs
to the source session as long as the workspace identity and snapshot objects
still match. New checkpoints use the fork's own ID. Rewind/Redo state, by
contrast, is session-local and requires an exact current `sessionId`, so a
copied rewind marker cannot accidentally offer Redo in a fork.

### 3. User-Turn Checkpoint State Machine

Pi's low-level `turn_end` is not a user-turn boundary: one user request may
contain several assistant/tool cycles, and queued follow-ups may introduce
another user message before the enclosing `agent_end`.

Crest will add an explicit awaited user-turn lifecycle contract to
`AgentHarness` instead of inferring all boundaries from message events:

```text
session_before_user_turn(boundaryToken, userMessage)
  finalize the previous active user checkpoint, if one exists
  capture this user's before tree

session_user_turn_committed(boundaryToken, userEntryId)
  bind the pending before snapshot to userEntryId (= turnId)

next session_before_user_turn OR session_user_turn_terminal
  capture after tree
  diff before snapshot -> after snapshot
  durably anchor snapshot refs
  append the hidden workspace_checkpoint entry
```

A successful before-tree capture creates a durable pending-boundary record and
`refs/crest/pending/<session-id>/<boundary-token>` owner before the user entry
can start a long run; the record includes the process owner/start token. A
failed capture records the unavailable cause without a snapshot ref.
`session_user_turn_committed` durably binds that record to the user entry ID.
Finalization appends the terminal checkpoint status before removing the pending
record/ref. On restart, an unbound record is retired only after proving its
exact owner is gone; a bound durable user entry without terminal status is
completed with an unavailable `process_crash_before_finalization` status. A
reconciler cannot prune pending refs merely because a turn exceeds the normal
grace period.

The harness guarantees:

- `session_before_user_turn` runs before an ordinary user append and before any
  prepared context transaction is committed;
- prepared initial/follow-up turns emit `session_user_turn_committed`
  immediately after their atomic transaction returns its durable
  `userEntryId`, even if an abort wins before later message events;
- ordinary, steering, and unprepared follow-up users emit the same committed
  event after their durable message append;
- every started boundary eventually emits `session_user_turn_terminal`,
  including preparation failure, post-commit abort, provider failure, and
  normal `agent_end`.

Each boundary has a stable token, so later message events cannot double-capture
a prepared turn. A boundary that never commits is discarded. A committed turn
that cannot obtain a reliable after snapshot persists an unavailable
checkpoint, preserving the required one-to-one correspondence between durable
user entries and checkpoint status entries.

The checkpoint manager registers before `AgentSessionRuntime`, but subscriber
ordering is not the mutation guard: the harness currently sets its raw phase to
idle before awaited `agent_end` subscribers finish. Checkpoint finalization and
rewind/redo therefore use the same per-session mutation queue/barrier.
`AgentSessionRuntime.isRunning()`, runtime creation, send, archive/delete, and
all session-tree mutation APIs treat an active boundary/finalizer as busy until
its durable writes settle. After appending a checkpoint status, the finalizer
publishes the new semantic/display leaf pair through the same lease-holder
sequencer before releasing the barrier, so the renderer's next mutation token
cannot remain one hidden entry behind.

If any hosted PTY remains running at the terminal boundary, that turn is
finalized as unavailable for combined file rewind. A hosted command, including
a CLI subagent, can continue writing after the model lifecycle boundary even
when it was not explicitly transferred to the user. Detached background
processes outside the hosted-PTY registry are treated as external post-turn
writers and remain subject to the documented drift limitation.

Expected snapshot failures are non-fatal to the agent run. The turn remains
usable, but its checkpoint is marked unavailable and targets that cross the
gap cannot perform file rewind. Failures are never silently presented as a
successful checkpoint. The checkpoint subscriber catches and records its own
capture/finalization failures instead of rejecting the awaited harness event
and converting an otherwise valid agent response into a hook failure.

A process crash before finalization may leave unreferenced Git objects but
cannot create a false session checkpoint. Maintenance can clean those objects
later.

### 4. Rewind Coordinator

Both live and cold sessions call the same Electron-main coordinator.

The runtime registry gains a retained-runtime exclusive mutation lease. It
blocks new sends/session access and waits for the shared checkpoint mutation
barrier, but does not dispose an idle live runtime or its renderer
subscriptions. After the atomic session commit, the coordinator rebuilds state
and uses a lease-holder-only broadcast path carrying the lease token. That path
bypasses ordinary `withSessionAccess` rejection only for the owning mutation,
increments the normal event sequence, and publishes before releasing the lease;
a new send therefore cannot overtake the rewind event. A cold session uses the
same sequencer and state-transition oracle through the persisted-state
broadcaster.

Planning:

1. Canonicalize and authorize the workspace and session.
2. Require an idle session and acquire a per-session mutation turn.
3. Verify `expectedSemanticLeafId` from the renderer against the raw storage
   leaf.
4. Read the current branch and resolve the selected user turn with
   `getTransactionForkBoundary(..., "before")`.
5. Enumerate every durable user entry from the selected turn through the active
   tip and require exactly one terminal checkpoint status entry for each. A
   missing, duplicate, or unavailable status makes the target unavailable.
6. Build a per-path restore plan:
   - target state is the explicit `before` state from the earliest checkpoint
     in the suffix that changed that path;
   - expected current state is the latest explicit `after` state for that path,
     overlaid by the current hidden workspace-state entry when present;
   - any `excluded` state remains unmanaged and is never added to the apply
     set.
7. Compare each affected live path with its explicit expected current state
   and classify the result:
   - an exact match is clean;
   - a content, executable-bit, or presence mismatch on an otherwise covered
     regular-file path is a forceable drift conflict; and
   - missing snapshot coverage, unsafe structure, path escape, workspace
     identity/incarnation mismatch, or invalid metadata is a hard blocker.
   Normal mode is blocked by either conflict class. Force mode may bypass only
   the forceable drift class and only after the UI displayed that exact
   live-state fingerprint.
8. Derive the effective apply set by removing paths whose expected current
   state already equals their target state. The broader union remains only for
   coverage/provenance; unchanged paths are not rewritten.

Preview performs this plan and hashes only affected paths needed for live-state
comparison. It returns an opaque confirmation token bound to the workspace
incarnation, session, semantic leaf, target turn, effective path set, live-state
fingerprints, and conflict classifications. It does not capture a full safety
snapshot, create durable refs, or write a journal, and it releases its
short-lived session lease before returning to the UI.

Applying:

1. Reacquire and retain the session mutation lease, then acquire one
   continuously held canonical-workspace mutation lock. Recompute the plan and
   leaf and re-hash affected paths. Normal mode rejects any drift. Force mode
   proceeds only when every forceable conflict and fingerprint exactly matches
   the confirmation token; a new, removed, or changed conflict returns a stale
   preview and requires the user to review it again.
2. Capture the full safety snapshot, including the current bytes of every
   force-confirmed path, anchor it under
   `refs/crest/ops/<operation-id>`, durably write a `prepared` journal
   containing session ID, expected semantic leaf, target boundary, safety
   snapshot, apply mode, confirmed conflict fingerprints, and explicit
   live/target state for every effective path, then durably advance it to
   `applying_files`.
3. Restore only effective paths from their explicit target states:
   - target file/symlink: restore raw content, kind, and executable bit;
   - explicit target `absent`: unlink a regular file or symlink only;
   - target `excluded`: never enters the apply set.
   File/directory collisions, symlink ancestors, and non-empty directories are
   hard blockers in the first release. The v1 path-state and recovery
   classifier do not represent directory state, so even an apparently covered
   descendant set cannot safely authorize a structural conversion.
4. Capture the complete post-apply workspace tree, durably anchor every
   snapshot referenced by the pending session entry, and verify the effective
   paths against their target states.
5. Commit one hidden workspace-state entry whose `parentId` is the target
   conversation boundary. `appendEntries` receives
   `{ expectedLeafId: expectedSemanticLeafId }`, so this single SQLite
   transaction both moves the semantic branch and persists the exact post-apply
   code state.
6. Verify the exact operation marker and target states, then mark the journal
   complete.
7. Rebuild/broadcast runtime state or cold-session state while retaining the
   mutation lease.
8. Remove the blocking journal, then remove the operation ref; keep the
   session-owned checkpoint/state refs.

The step-7 state rebuild receives the exact operation ID and ignores only that
operation's `completed` journal while calculating the published `frozen`
flag. This is a publication-scoped view, not a journal deletion or a general
recovery exemption: unfinished, corrupt, frozen, and unrelated journals still
freeze the workspace. Ordinary recovery queries also continue to see the
completed journal. If broadcast fails, the journal remains authoritative and
the next normal probe exposes it for recovery; cleanup still happens only
after a successful broadcast.

If file application, verification, or conversation commit fails, the
coordinator runs the same per-path classifier used for crash recovery. It
automatically restores a path only when its live state still equals that
operation's exact target/intermediate state; a path equal to its pre-state is
already safe. If any path matches neither recorded state, automatic writes
stop, the conversation remains unchanged, and the durable journal is retained
as a critical recovery error. A late external write is never overwritten by an
unconditional in-process rollback.

Once the SQLite compare-and-swap succeeds, the operation is committed and no
failure path rolls files or conversation back. A rebuild/broadcast or cleanup
failure leaves the journal in `committing_session`/`completed`; recovery
verifies the exact operation marker, republishes state if needed, and finishes
cleanup.

Every successful rewind or redo leaves a hidden workspace-state entry as the
current physical leaf. Its parent is the conversation leaf whose context
should be active, while `currentSnapshot` records the complete physical
workspace and capture scope observed after the selective restore:

```ts
interface WorkspaceStateV1 {
  schemaVersion: 1;
  sessionId: string;
  operationId: string;
  workspaceIdentity: string;
  workspaceIncarnation: string;
  kind: "rewind" | "redo";
  applyMode: "normal" | "force-drift";
  forcedPaths: string[];
  currentSnapshot: WorkspaceSnapshotRefV1;
  currentStates: Array<{ path: string; state: CapturedPathStateV1 }>;
  rewind?: {
    fromLeafId: string | null;
    targetTurnId: string;
    targetBoundaryId: string | null;
    redoSnapshot: WorkspaceSnapshotRefV1;
    redoStates: Array<{ path: string; state: CapturedPathStateV1 }>;
  };
}
```

`kind: "rewind"` enables one-step Redo through `rewind.redoStates`,
`rewind.redoSnapshot`, and `rewind.fromLeafId`. Redo restores those explicit
path states, captures the complete resulting snapshot, and appends
`kind: "redo"` with `parentId = fromLeafId`. The redo marker has no further
Redo payload. `applyMode` and `forcedPaths` are durable audit facts; the
renderer does not use them to infer authority for a later operation.

## Recovery Journal

Git objects, workspace files, and SQLite cannot participate in one atomic
transaction. Each operation therefore records state before crossing a durable
boundary:

```text
prepared
applying_files
files_verified
committing_session
completed
```

Every phase is durably written before the side effect it authorizes.
The durable identity is `(workspace identity, workspace incarnation,
sessionId, operationId)`. Session path is diagnostic only because archive and
trash operations may move the SQLite file; recovery locates the current
session by ID.

The journal records per-path pre-state, target state, and apply progress. On
startup or next access, recovery acquires the owning-session mutation lease and
then the workspace lock, validates the journal, and classifies every live
affected path as exact pre-state, exact target-state, or unknown:

- `prepared`: discard only when every path is still exact pre-state; otherwise
  freeze.
- `applying_files` or `files_verified`: roll target-state paths back to
  pre-state only when every path is pre-state or target-state. Verify the
  complete pre-state before discarding the operation.
- `committing_session`: if the exact `operationId` workspace-state entry is the
  physical leaf, verify target-state and finish the commit. If the physical
  leaf is still the journal's exact expected old leaf, perform the same
  classifier-safe rollback and leave conversation state unchanged. Any other
  leaf freezes recovery.
- `completed`: verify that the exact operation workspace-state is the leaf and
  all effective paths are target-state, repair missing session-owned refs if
  needed, rebuild/broadcast state, then remove the journal followed by the
  operation ref.
- any unknown path, corrupt/truncated journal, missing required object,
  workspace-incarnation mismatch, or unexpected leaf freezes automatically;
  recovery never overwrites an unknown post-crash edit.

All transitions and recovery actions are idempotent. A journal is deleted only
after the corresponding filesystem and session state have been verified.

Recovery holds the canonical-workspace mutation lock for the whole
classification and finish/rollback operation.

A frozen journal blocks runtime creation, sends, hosted-command starts,
session-tree navigation, fork/clone, archive/delete, rewind/redo, and every
other write-capable action for every session bound to that canonical workspace.
Read-only inspect, export, and recovery diagnostics remain available. Recovery
UI provides:

- **Retry**, after the user manually makes all affected paths match either the
  recorded pre-state or target-state;
- **Keep current and abandon operation**, an explicit acknowledgement that
  performs no workspace write. It is allowed only when the session leaf is
  still the exact expected old leaf or the exact committed operation leaf;
  conversation remains on whichever of those durable states already exists.
  Crest atomically moves the journal to a 30-day resolved-audit area, then lets
  the reconciler retire the operation ref.
- **Quarantine corrupt record and keep current**, available only when the
  journal cannot be decoded enough to perform classification. It writes neither
  workspace nor session state, moves the corrupt bytes to the same audit area,
  clears the workspace gate, and lets unreachable operation refs age through
  normal grace-period reconciliation.

Any other leaf requires manual repair before Retry. Recovery UI never offers
Force Retry/Restore: product-level Force Revert is available only before an
operation starts, while the preview still proves the exact live states the user
is authorizing Crest to overwrite.

Durability order is strict:

1. write snapshot objects;
2. atomically update and flush the operation ref;
3. atomically write and fsync the `prepared` journal and its parent directory;
4. atomically advance and fsync `applying_files`;
5. perform workspace writes and per-path durability steps;
6. verify target states, then atomically advance and fsync `files_verified`;
7. anchor snapshots needed by the pending session entry;
8. atomically advance and fsync `committing_session`;
9. perform the SQLite compare-and-swap append;
10. verify the exact operation leaf and target states, then atomically advance
    and fsync `completed`;
11. remove and fsync the journal, then remove the operation ref. A crash between
    those steps leaves only a harmless orphan ref for reconciliation.

Every phase transition uses atomic replace plus file and parent-directory fsync
before entering the next phase.

Each regular-file write uses a same-parent temporary file opened exclusively
without following the leaf, writes raw bytes, applies the executable mode,
fsyncs after that mode change, atomically renames/replaces the destination, and
fsyncs the parent directory. Missing parent directories are created one level
at a time with no-follow checks; each new directory and its parent are fsynced
and recorded in apply progress. Classifier rollback removes only empty
directories created by that operation and fsyncs their parents. Successful
selective restore never removes an unrelated empty directory.

Symlinks are read as raw target bytes and replaced through a same-parent
temporary symlink plus rename. Deletion uses no-follow `lstat`, unlinks only a
regular file or symlink, and fsyncs the parent. FIFOs, sockets, devices, reparse
points, and other special entries are unsupported exclusions and are never
opened as files.

Every ancestor is checked for containment and symlinks immediately before
mutation. Portable Node filesystem APIs cannot provide an attack-grade
guarantee against a hostile concurrent ancestor-symlink swap; Crest therefore
does not claim such a security boundary. Unexpected post-check state causes
verification/recovery to freeze rather than broadening the restore.

## Concurrency and Drift

The store uses a canonical-workspace lock for capture and restore plumbing.
It combines a keyed in-process mutex with an atomic cross-process lock record
containing workspace incarnation, owner PID, and process-start token; stale
reclamation requires proving that exact owner is gone. The global acquisition
order is owning-session mutation lease, then canonical-workspace lock, and no
operation acquires another session lease while holding the workspace lock. A
rare operation needing multiple session leases acquires them in stable
session-ID order before the workspace lock. Checkpoint finalization,
rewind/redo, recovery, archive/delete, retention, and ref reconciliation all
obey this hierarchy. Capture-only operations hold the workspace lock briefly.
A confirmed rewind/redo or recovery holds it continuously from safety capture
through drift check, file apply, verification, SQLite compare-and-swap, journal
completion, or verified rollback. Two Crest restore transactions in the same
physical workspace therefore cannot interleave their safety and apply phases.

That lock does not freeze the physical workspace for the duration of every
agent turn. Doing so would serialize otherwise independent agent sessions.
Consequently:

- changes made by another actor during a turn can be included in that turn's
  before/after diff;
- changes made after the expected current workspace state are detected on
  overlapping affected paths and block normal restore;
- Force Revert is an explicit user decision to waive that protection only for
  the red-listed drift paths in the current preview. It may overwrite manual
  work or another Agent Session's writes on those paths. Paths outside the
  effective apply set remain untouched;
- a writer racing after the final drift check remains an unavoidable limitation
  of a shared physical workspace.

The UI states these limitations in preview. Crest guarantees that automatic and
ordinary Revert never knowingly overwrite another actor's detected changes; it
does not make that guarantee after the user explicitly confirms Force Revert.
Strict cross-session isolation even against explicit force or final-check races
requires separate worktrees or a filesystem transaction layer and is outside
this design.

## Snapshot Coverage and Security

Default coverage follows conservative coding-product behavior:

- all files tracked by the user's Git repository are eligible, subject to the
  aggregate capture budget;
- non-ignored untracked files are eligible up to 2 MiB each;
- ignored paths, `.git`, nested repository contents, non-UTF-8 paths, and
  oversized untracked, multiply-linked regular files, or special filesystem
  entries are excluded;
- exclusions are persisted as structured coverage warnings and displayed in
  rewind preview;
- no excluded path is deleted during selective restore.

Eligibility is re-evaluated independently at every boundary. If a path crosses
an ignore, size, nested-repository, encoding, or entry-kind boundary, the
manifest records an explicit `excluded` transition. Once either side of a
change is excluded, that path is warning-only and never enters a restore plan.
Forked sessions inherit the captured boundary manifests; new boundaries use
current scope policy.

The 2 MiB untracked limit is an initial OpenCode-compatible safety limit, not a
silent drop. A later setting may make it configurable after storage and secret
handling are designed.

Each snapshot persists enough scope metadata to distinguish "covered and
absent" from "not captured": applicable ignore-rule inputs, nested repository
boundaries, non-UTF-8 exclusions, and per-file size decisions. Diff planning
evaluates both boundary scopes. A missing Git-tree entry alone is never treated
as proof that a path should be deleted.

Git trees cover regular file bytes, binary content, symlinks, and the
executable bit. They do not cover empty directories, mtime, ownership,
ACL/xattr, submodule internals, or external side effects.

Capture and restore use raw blob plumbing, so Git clean/smudge filters,
line-ending normalization, and `working-tree-encoding` are not executed.
Scope discovery may read ignore metadata, but repository hooks and filter
drivers are never invoked.

## IPC and Frontend

Rewind uses dedicated agent APIs rather than changing `navigateTree` semantics:

- `agent:list-rewind-points`
- `agent:preview-rewind`
- `agent:rewind-tree`
- `agent:redo-rewind`

Every mutation request carries session metadata and
`expectedSemanticLeafId`.
`rewind-tree` additionally carries:

- `targetTurnId`;
- `mode: "normal" | "force-drift"`; and
- the opaque confirmation token returned by the latest preview.

The preview response contains display-only file rows with operation, diff
summary, coverage status, conflict classification/reason, and
`forceRequired`/`hardBlocked`. `rewind-tree` recomputes the plan server-side and
verifies the token; it never trusts renderer-supplied paths, hashes, or
conflict flags.

The new APIs follow the existing agent IPC surface through:

- Electron main handler;
- preload bridge;
- renderer ambient types;
- preview Electron API mock;
- `AgentRuntimeClient`.

The renderer adds:

- `/rewind` to command discovery and routing;
- a dedicated rewind selector based on the existing selector frame;
- a reset/Revert action in the existing user-message action bar, using the
  persisted `turnId` already carried in message metadata;
- one shared preview dialog owned by the Agent conversation surface, populated
  only by `agent:preview-rewind`;
- expandable create/write/delete/rename file rows and supported diffs;
- destructive red styling and the exact drift warning for each forceable
  conflict;
- `Cancel` plus ordinary `Revert` when clean, or `Cancel` plus destructive
  `Force revert` when forceable drift exists;
- a dedicated persistent post-revert dock above the composer with a visible
  `Redo` action and an expandable operation/file summary; and
- `/redo` as an immediate command when persisted session state reports a valid
  rewind marker.

The OpenCode reference is limited to the message action and post-revert dock
placement. The preview dialog, conflict display, and Force Revert state are
Crest-specific. Direct UI, `/rewind`, dock Redo, and `/redo` share the same
preview/apply coordinators and cannot diverge semantically.

## Error Semantics

Checkpoint capture:

- does not fail the agent response;
- records or reports checkpoint unavailability;
- never claims recoverability without durable snapshot refs and session
  metadata.

Preview:

- performs no workspace restore;
- reports missing objects, manifest gaps, coverage warnings, and drift.

Rewind/Redo:

- reject a running target session;
- reject stale leaf or stale plan state;
- always reject path escape, symlink escape, unsafe structure/kind, missing
  snapshot objects, workspace-incarnation mismatch, and frozen recovery state;
- reject live-state drift in normal Revert;
- allow Force Revert to bypass only the exact forceable drift fingerprints
  displayed in the confirmation preview; any changed conflict invalidates the
  confirmation;
- leave conversation unchanged on any pre-commit failure;
- perform only classifier-verified rollback on partial apply or
  conversation-commit failure;
- retain a recovery journal if automatic rollback cannot be verified.

Redo uses the same preview and hard-blocker checks. The first release does not
offer Force Redo: if files changed after Revert, Redo remains available but
opens a red conflict preview and cannot apply until those paths again match the
expected rewound state. This avoids silently overwriting new work created after
the Revert and avoids creating a second forward-history stack.

## Testing Strategy

All production behavior is developed test-first.

The final integration gate is split across
`multi-session.integration.test.ts`,
`tool-independent.integration.test.ts`, and `emain/agent-rewind.e2e.test.ts`.
Together they exercise same-workspace multi-session isolation and locking,
normal/Force/stale-preview behavior, unknown-write recovery freeze, tool-
independent turn boundaries, active PTY gaps, Git/non-Git parity and untouched
user Git metadata, renderer-to-main preview/apply/Redo/reload behavior, crash
gaps, quota owners and purge, and conversation-only `/tree`. The CI matrix runs
the full rewind package plus coordinator and UI suites on Linux and macOS.
Windows runs the platform-neutral contracts and explicit feature-unavailable
and `windows-reparse-unsupported` assertions. Windows is not a supported
first-release platform: owner-only store ACLs, reparse-safe inspection/apply,
case-only replacement, and durable directory fsync must all gain production
support before its full gate can be enabled. An unknown capability fails closed
rather than weakening a restore assertion.

The incremental gate additionally proves full/incremental state and diff
equivalence, restart cursor continuity, watcher gaps, scope invalidation,
same-size rewrites, and capture races. Real 1/2/4-Session tests share one tracker
without sharing checkpoint identity. The 2026-08-06 macOS/APFS 10k-entry run
measured healthy warm no-change capture at 0.00-0.07 ms with zero enumeration;
unique-content cold 10k full reconcile exceeded its 30-second deadline and
dirty-path latency remains material. The 50k/200k matrix and Linux measurements
remain outstanding. Windows stays unsupported pending owner-only ACL and
reparse-safe storage/apply support. No larger timeout is treated as a pass.

### Git runner

- argv and environment isolation;
- Git missing, non-zero exit, timeout, abort, and output limits;
- no shell interpolation;
- literal paths with pathspec magic, a leading dash, tabs, and newlines;
- read-only Git discovery in a repository subdirectory and `.git`-file
  worktree, with user index bytes and mtime unchanged.

### Manifest and path safety

- NUL-delimited parsing with tab, newline, leading/trailing whitespace, and
  Unicode filenames;
- non-UTF-8 path exclusion without lossy round-trip;
- create, delete, rename, binary, symlink, and executable files;
- read-only permissions, special-file exclusion, symlink leaf/ancestor cases,
  and case-only rename behavior;
- nested parent creation/removal and executable-mode durability ordering;
- lexical containment, symlink traversal, and ancestor-symlink race failure;
- file/directory collisions and unmanaged directory descendants;
- nested repository and `.git` exclusion.

### Shadow store integration

- Git and non-Git workspaces;
- user HEAD/index/stash remain unchanged;
- `.gitignore` add/remove, untracked 2 MiB boundary crossing, nested-repository
  transitions, and inherited fork scope;
- cold full capture, warm fingerprint reuse, unstable-file retry, and
  unreliable-fingerprint fallback;
- capture deadline, entry/byte budget, low-space/`ENOSPC`, quota exhaustion,
  and orphan cleanup;
- durable refs survive GC;
- object-graph fsync occurs before ref/journal durability under injected faults;
- `reflog expire` plus `git gc --prune=now` cannot remove referenced objects;
- fork remains rewindable after source-session deletion;
- replaced Redo/session deletion release only truly unreferenced objects;
- raw-blob Git filters, CRLF, and working-tree-encoding byte-identity cases;
- canonical workspace lock and stale-lock recovery.

### Selective restore and Redo

- multi-turn path union uses the earliest selected before tree;
- unchanged paths remain untouched;
- target-absent files are deleted exactly;
- rename restores both sides;
- drift blocks normal Revert with no mutation;
- Force Revert bypasses only preview-confirmed drift paths and never hard
  blockers;
- adding, removing, or changing a conflict after preview invalidates Force
  confirmation without mutation;
- forced safety capture plus Redo restores the exact bytes that existed at
  Force Revert confirmation;
- an effective no-op performs no filesystem write;
- mid-apply failure uses classifier-safe rollback;
- an unknown third-party write before in-process rollback is never overwritten;
- apply verification catches corruption;
- repeated rewind/redo;
- a new prompt invalidates Redo;
- concurrent restore transactions cannot interleave;
- concurrent sessions share store safely without whole-workspace reset;
- two-session tests prove normal Revert never overwrites detected overlapping
  writes, while explicit Force Revert touches only the displayed effective path
  set;
- workspace deletion/recreation without a pending journal invalidates every old
  snapshot at preview and confirmation.

### Session lifecycle

- initial user message, prepared/context-transactional user message, steering,
  queued follow-up, abort, provider failure, active transferred PTY, and
  hard-finalization gaps;
- prepared follow-up commit ordering and post-commit abort still produce one
  terminal checkpoint status;
- a long-running turn's pending before ref survives concurrent reconciliation
  and GC, while crash recovery appends an unavailable terminal status;
- blocked checkpoint finalization keeps runtime/session mutation busy;
- checkpoint `turnId` equals durable user entry ID;
- first-turn rewind reaches a `null` boundary;
- transaction-aware rewind does not stop on a transaction manifest;
- workspace markers remain hidden, visible-child rewiring preserves the
  effective leaf, and unknown custom entries remain visible;
- live/cold state exposes distinct semantic/display leaf IDs;
- rewind and redo markers use exact `expectedSemanticLeafId` and survive
  fork/export;
- `/tree` current-tip selection preserves the raw leaf, while navigating away
  and back never revives a historical workspace-state Redo;
- missing external snapshot objects are reported.

### IPC and UI

- live/cold parity;
- authorization and canonical workspace checks;
- busy, stale leaf, preview/apply race, and recovery errors;
- independent child-process `SIGKILL` injection after every durable phase,
  each per-path rename, SQLite commit before/after, and completed cleanup;
- deterministic two-session plus recovery barriers prove the global lock order
  cannot deadlock;
- restart recovery for post-crash manual edits, corrupt journals, workspace
  incarnation replacement, session archive/delete, and safe abandon/retry;
- frozen recovery blocks all write-capable entry points but permits read-only
  inspect/export;
- preview confirmation and composer prompt restoration;
- eligible message action visibility, hover/focus access, busy/coverage
  disabling, and persisted `turnId` targeting;
- clean file preview renders `Revert`; forceable conflicts render red path rows,
  the exact `files changed on disk since the agent last wrote them` warning,
  and `Force revert` instead of ordinary `Revert`;
- hard blockers never render a Force action;
- successful Revert shows the persistent Redo dock; Redo, a new prompt, or
  navigation to another branch removes it according to persisted semantic
  state; reload/cold resume restores it;
- message action and `/rewind` produce equivalent preview/apply requests, and
  dock Redo and `/redo` are equivalent;
- Redo drift opens a blocked conflict preview and never offers Force Redo;
- `/tree` remains conversation-only;
- `/rewind` and `/redo` command discovery and routing.

## Rollout

The implementation is gated by the exact internal environment value
`CREST_AGENT_WORKSPACE_REWIND=1`; every other value is disabled. The default
remains off until the Linux and macOS supported-platform matrix is consistently
green. Windows remains explicitly unavailable for the first release; setting
the flag does not bypass its store or filesystem capability hard-blocks. The store
path is
`<wave-data>/agent-checkpoints/workspaces/<workspace-identity>-<incarnation>/repo.git`
and its 5 GiB soft quota, owner cleanup, confirmed trashed-session purge,
recovery freeze, no-Force recovery, and one-step Redo behavior are part of the
rollout contract—not operational suggestions.

1. Land the shadow-store, manifest, checkpoint journal, and restore engine
   behind the internal feature flag.
2. Integrate lifecycle capture and validate checkpoint generation without
   exposing restore.
3. Add backend preview/apply/redo APIs and failure-injection tests.
4. Add the message-side Revert action, shared file preview, conflict/Force
   Revert states, persistent Redo dock, `/rewind`, and `/redo` together so every
   entry point ships with identical safety behavior.
5. Enable by default on Linux and macOS after storage growth, crash recovery,
   and multi-session stress tests pass. Keep Windows unavailable until
   owner-only store ACLs, reparse-safe inspection/apply, case-only rename,
   atomic replace, and directory-fsync durability have production
   implementations and a complete supported-platform gate.

## Alternatives Rejected

### Tool-level pre-images or inverse patches

Rejected as the authority because they miss shell, PTY, subagent, MCP, and
future-tool changes and couple rewind correctness to current tool names.

### Whole-workspace shadow Git checkout

Rejected because `reset --hard` plus `clean -fd` can overwrite unrelated user
or concurrent-session changes. A safety commit does not make that ownership
problem disappear.

### User Git commits, stash, or branch resets

Rejected because they mutate the user's repository state, do not work
consistently in non-Git workspaces, and conflate temporary chat undo with
durable version-control history. Crest may read tracked/ignore metadata, but it
does not use the user's Git history as checkpoint storage.

### Worktree-per-session

Useful for strict isolation, but rejected as the default rewind mechanism
because Crest operates directly in the user's chosen workspace and the product
does not require worktree isolation for this feature.
