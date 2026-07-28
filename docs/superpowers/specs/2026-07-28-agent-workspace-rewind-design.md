# Agent Workspace Rewind Design

**Status:** Draft for review

**Date:** 2026-07-28

**Primary reference:** OpenCode Core v2 selective restore

**Lifecycle reference:** Pi / pi-rewind checkpoint-to-user-entry mapping (clean-room design only)

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
- Drift checks fail closed instead of silently overwriting files changed after
  the latest checkpoint.
- Conversation movement happens only after file restore and verification
  succeed. A recovery journal bridges the unavoidable filesystem/SQLite
  transaction boundary.

The first product entry point is a dedicated `/rewind` command. Existing
`/tree` remains conversation-only.

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
- A force-overwrite path in the first release.
- Message-level checkpoint buttons in the first release.

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

### `/rewind`

1. Requires the selected session to be idle.
2. Lists checkpointed user turns on the current active branch only.
3. Defaults focus to the most recent rewindable turn.
4. Selecting a turn opens a preview containing:
   - the number and list of paths that will be restored;
   - creates, deletes, and writes;
   - snapshot coverage warnings;
   - drift conflicts, if any.
5. Confirmation re-runs planning and drift checks against the current leaf and
   current workspace. A stale preview can never authorize a stale restore.
6. On success:
   - affected files match the state immediately before the selected user turn;
   - the conversation leaf moves to the transaction-aware boundary immediately
     before that turn;
   - the selected prompt is restored to the composer for editing and resending;
   - a hidden rewind-state entry enables Redo.

If any checkpoint is missing between the selected turn and the current active
tip, combined code-and-conversation rewind is unavailable for that target.
`/tree` remains available for conversation-only navigation.

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

Capture does not re-read every unchanged file on every prompt. Each descriptor
manifest stores a per-path filesystem fingerprint (file identity, size,
nanosecond mtime/ctime where supported, kind, and executable state). A blob OID
may be reused only when the current fingerprint exactly matches the preceding
snapshot in the same workspace incarnation and the path remains in scope.
Changed candidates are stat-checked before and after raw hashing; an unstable
candidate is retried once and then makes the boundary unavailable. The first
capture, a missing cache, or a platform/filesystem without a reliable
fingerprint falls back to raw hashing within the capture budget. The cache is
only an optimization: tree/manifest OIDs remain the authority.

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
is the OID of a descriptor tree whose entries reference both the workspace tree
and its scope-manifest blob; the ref therefore keeps both reachable. Session
checkpoint/state entries are the logical owners of those snapshot IDs.
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
reconciliation before Git GC; reachable snapshots are never pruned merely
because they are old. The first release retains all checkpoints while any
session entry references them, and default enablement is gated on
storage-growth/quota testing.

Capture has hard resource bounds. Session attach performs a best-effort warm
capture that creates no turn checkpoint. The synchronous pre-turn path has a
5-second deadline; terminal/background capture has a 30-second deadline. Both
allow 200,000 eligible entries and at most 1 GiB of newly hashed input per
boundary, require at least the greater of 1 GiB or 5% free space, and share a
5 GiB soft quota per canonical workspace store. A boundary that exceeds a
capture limit or encounters `ENOSPC` becomes an unavailable checkpoint; the
agent response continues. The reconciler may remove only unreferenced objects.
If referenced snapshots alone exceed quota, new checkpoints remain unavailable
with a visible cleanup action until session/reference removal frees space.

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
covered-and-absent or excluded at that boundary.

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
7. Compare each affected live path with its explicit expected current state.
   Any mismatch is a drift conflict and blocks the operation.
8. Derive the effective apply set by removing paths whose expected current
   state already equals their target state. The broader union remains only for
   coverage/provenance; unchanged paths are not rewritten.

Preview performs this plan and hashes only affected paths needed for live-state
comparison. It does not capture a full safety snapshot, create durable refs, or
write a journal, and it releases its short-lived session lease before returning
to the UI.

Applying:

1. Reacquire and retain the session mutation lease, then acquire one
   continuously held canonical-workspace mutation lock. Recompute the plan and
   leaf, re-hash affected paths, and reject any drift since preview.
2. Capture the full safety snapshot, anchor it under
   `refs/crest/ops/<operation-id>`, durably write a `prepared` journal
   containing session ID, expected semantic leaf, target boundary, safety
   snapshot, and explicit live/target state for every effective path, then
   durably advance it to `applying_files`.
3. Restore only effective paths from their explicit target states:
   - target file/symlink: restore raw content, kind, and executable bit;
   - explicit target `absent`: unlink a regular file or symlink only;
   - target `excluded`: never enters the apply set.
   File/directory collisions, symlink ancestors, and non-empty directories are
   conflicts unless every descendant that must be removed is an explicitly
   covered member of the same plan.
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
Redo payload.

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

Any other leaf requires manual repair before Retry. There is no force-restore
action in the first release.

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
  overlapping affected paths and block restore;
- a writer racing after the final drift check remains an unavoidable limitation
  of a shared physical workspace.

The UI states this limitation in preview. The first release has no force mode.
Strict cross-session isolation requires separate worktrees or a filesystem
transaction layer and is outside this design.

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
`rewind-tree` recomputes the plan server-side; it does not trust renderer paths
or a prior preview.

The new APIs follow the existing agent IPC surface through:

- Electron main handler;
- preload bridge;
- renderer ambient types;
- preview Electron API mock;
- `AgentRuntimeClient`.

The renderer adds:

- `/rewind` to command discovery and routing;
- a dedicated rewind selector based on the existing selector frame;
- a preview/confirmation state with file and conflict rows;
- `/redo` as an immediate command when a valid rewind state exists.

The first release does not add per-message buttons. That can be layered on the
same preview/apply APIs later.

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
- reject path escape, symlink escape, missing snapshot objects, and drift;
- leave conversation unchanged on any pre-commit failure;
- perform only classifier-verified rollback on partial apply or
  conversation-commit failure;
- retain a recovery journal if automatic rollback cannot be verified.

## Testing Strategy

All production behavior is developed test-first.

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
- drift blocks with no mutation;
- an effective no-op performs no filesystem write;
- mid-apply failure uses classifier-safe rollback;
- an unknown third-party write before in-process rollback is never overwritten;
- apply verification catches corruption;
- repeated rewind/redo;
- a new prompt invalidates Redo;
- concurrent restore transactions cannot interleave;
- concurrent sessions share store safely without whole-workspace reset;
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
- `/tree` remains conversation-only;
- `/rewind` and `/redo` command discovery and routing.

## Rollout

1. Land the shadow-store, manifest, checkpoint journal, and restore engine
   behind an internal feature flag.
2. Integrate lifecycle capture and validate checkpoint generation without
   exposing restore.
3. Add backend preview/apply/redo APIs and failure-injection tests.
4. Add `/rewind` preview UI and `/redo`.
5. Enable by default after storage growth, cross-platform, crash recovery, and
   multi-session stress tests pass on Linux, macOS, and Windows. The platform
   matrix explicitly covers symlink support, case-only rename, atomic replace,
   and directory-fsync differences.

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
