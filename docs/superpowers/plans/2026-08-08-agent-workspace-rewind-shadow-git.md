# Agent Workspace Rewind Shared Shadow Git Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-boundary custom incremental snapshots with one Workspace-level Shadow Git mutation log that provides exact turn ownership, monorepo-scale hot paths, and cross-Session-safe selective rewind.

**Architecture:** Preserve the existing checkpoint, preview, and selective file-apply API while changing physical authority. A private Git ref becomes the only durable Workspace history; a generic runtime writer lease attributes mutating turns; restore planning rejects later same-path commits from other Sessions. Migration is staged inside this branch, but the final cutover deletes the persistent cursor and custom path-state authority.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Git plumbing through `WorkspaceGitRunner`, pi `AgentHarness`, Vitest, Electron main IPC.

---

## File structure

- Create `workspace-mutation-log.ts` for append/read/CAS and ownership history queries.
- Create `workspace-writer-lease.ts` for the canonical Workspace FIFO writer lease.
- Create `workspace-candidates.ts` for non-authoritative Git/non-Git candidate discovery.
- Create `shadow-workspace-index.ts` for raw-byte candidate updates to a private Git index/tree.
- Keep `snapshot-store.ts` as the private object/read/restore facade while replacing its capture internals.
- Keep `checkpoint-manager.ts` as turn lifecycle owner and `workspace-restore-executor.ts` as mutation executor.
- Convert `workspace-tracker-registry.ts` into the shared Shadow Workspace resource registry.

### Task 1: Shadow Git mutation log

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/git-runner.ts`
- Test: `packages/coding-agent/workspace-rewind/git-runner.test.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-mutation-log.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-mutation-log.test.ts`

- [x] **Step 1: Write failing Git-runner tests**

Prove `commit-tree`, `write-tree`, `read-tree`, `update-index`, `ls-tree`, `status`, and `log` are accepted; arbitrary subcommands remain rejected; a private absolute `indexFile` is accepted without exposing arbitrary environment variables.

- [x] **Step 2: Run RED**

```bash
npx vitest run packages/coding-agent/workspace-rewind/git-runner.test.ts
```

Expected: FAIL on unsupported subcommands/options.

- [x] **Step 3: Add minimal secure plumbing**

Add `indexFile?: string` to `GitRunOptions`, validate it as absolute, and set only `GIT_INDEX_FILE` internally. Keep hooks, external fsmonitor hooks, prompts, global config, and caller-provided `GIT_*` variables disabled.

- [x] **Step 4: Write failing mutation-log tests**

```ts
it("appends one CAS-ordered commit with canonical owner metadata", async () => {});
it("rejects append when workspace head moved", async () => {});
it("finds foreign same-path ABA history", async () => {});
it("ignores later different-path commits", async () => {});
it("rejects malformed or foreign-workspace metadata", async () => {});
```

- [x] **Step 5: Run RED**

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-mutation-log.test.ts
```

Expected: FAIL because the module is absent.

- [x] **Step 6: Implement the log**

```ts
export type WorkspaceMutationKind =
    | "external"
    | "agent-turn"
    | "turn-undo"
    | "turn-redo"
    | "rewind"
    | "redo";

export interface WorkspaceMutationMetadataV1 {
    schemaversion: 1;
    workspaceidentity: string;
    workspaceincarnation: string;
    kind: WorkspaceMutationKind;
    sessionid?: string;
    turnid?: string;
    operationid?: string;
}

export interface ForeignOverlapInput {
    afterCommit: string;
    paths: readonly string[];
    includedCommits: ReadonlySet<string>;
    ownerSessionId: string;
}

export interface ForeignOverlap {
    commit: string;
    path: string;
    sessionId?: string;
}

export class WorkspaceMutationLog {
    constructor(input: {
        git: WorkspaceGitRunner;
        gitDir: string;
        workspaceIdentity: string;
        workspaceIncarnation: string;
    });
    readHead(): Promise<string | undefined>;
    append(input: { expectedHead?: string; tree: string; metadata: WorkspaceMutationMetadataV1 }): Promise<string>;
    read(commit: string): Promise<{ parent?: string; tree: string; metadata: WorkspaceMutationMetadataV1 }>;
    changedPaths(commit: string): Promise<string[]>;
    findForeignOverlap(input: ForeignOverlapInput): Promise<ForeignOverlap[]>;
}
```

Use canonical JSON as the full commit message, `commit-tree` for creation, and CAS `update-ref` as the only head publication.

- [x] **Step 7: Run GREEN and commit**

```bash
npx vitest run packages/coding-agent/workspace-rewind/git-runner.test.ts packages/coding-agent/workspace-rewind/workspace-mutation-log.test.ts
git add packages/coding-agent/workspace-rewind/git-runner.ts packages/coding-agent/workspace-rewind/git-runner.test.ts packages/coding-agent/workspace-rewind/workspace-mutation-log.ts packages/coding-agent/workspace-rewind/workspace-mutation-log.test.ts
git commit -m "feat(agent): add shadow workspace mutation log"
```

### Task 2: Canonical Workspace writer lease

**Files:**
- Create: `packages/coding-agent/workspace-rewind/workspace-writer-lease.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-writer-lease.test.ts`

- [x] **Step 1: Write failing tests**

Cover one holder per Workspace, FIFO waiters, same-turn idempotence, wrong-owner release rejection, aborted waiters, and independent Workspaces proceeding concurrently.

- [x] **Step 2: Run RED**

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-writer-lease.test.ts
```

- [x] **Step 3: Implement the process-local registry**

```ts
export interface WorkspaceWriterLease {
    workspaceKey: string;
    sessionId: string;
    boundaryToken: string;
    release(): void;
}

export class WorkspaceWriterLeaseRegistry {
    acquire(input: {
        workspaceKey: string;
        sessionId: string;
        boundaryToken: string;
        signal?: AbortSignal;
    }): Promise<WorkspaceWriterLease>;
}
```

The Electron main process is the sole Agent runtime owner. Continue using `WorkspaceMutationLock` only for short filesystem/ref transactions; do not hold it for an LLM turn.

- [x] **Step 4: Run GREEN and commit**

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-writer-lease.test.ts
git add packages/coding-agent/workspace-rewind/workspace-writer-lease.ts packages/coding-agent/workspace-rewind/workspace-writer-lease.test.ts
git commit -m "feat(agent): serialize workspace-writing turns"
```

### Task 3: Raw Shadow Git tree updates

**Files:**
- Create: `packages/coding-agent/workspace-rewind/shadow-workspace-index.ts`
- Create: `packages/coding-agent/workspace-rewind/shadow-workspace-index.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.ts`
- Test: `packages/coding-agent/workspace-rewind/snapshot-store.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/stored-manifest.ts`
- Test: `packages/coding-agent/workspace-rewind/stored-manifest.test.ts`

- [x] **Step 1: Write failing raw-state tests**

Cover regular/executable files, symlink target bytes, create/delete, binary data, whitespace paths, and a `.gitattributes` clean filter. Repository filters and hooks must not execute.

- [x] **Step 2: Run RED**

```bash
npx vitest run packages/coding-agent/workspace-rewind/shadow-workspace-index.test.ts
```

- [x] **Step 3: Implement candidate-only index updates**

```ts
export class ShadowWorkspaceIndex {
    load(tree?: string): Promise<void>;
    apply(states: readonly Array<{ path: string; state: CapturedPathStateV1 }>): Promise<void>;
    writeTree(): Promise<string>;
}
```

Hash raw bytes with `hash-object -w --stdin` without `--path`; update a private index using modes `100644`, `100755`, `120000`; encode exact removals as mode-0 entries in the same `update-index --index-info` transaction.

- [x] **Step 4: Make snapshot refs commit-backed**

Teach `snapshot-store.ts` to verify/read refs whose `id` is the mutation commit and `tree` is its tree. Preserve `readBlob`, `readPathState`, `diff`, and selective restore without a custom path-state tree.

- [x] **Step 5: Run GREEN and commit**

```bash
npx vitest run packages/coding-agent/workspace-rewind/shadow-workspace-index.test.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts
git add packages/coding-agent/workspace-rewind/shadow-workspace-index.ts packages/coding-agent/workspace-rewind/shadow-workspace-index.test.ts packages/coding-agent/workspace-rewind/snapshot-store.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts
git commit -m "feat(agent): build commit-backed workspace snapshots"
```

**Implementation note (2026-08-08):** V3 stores only Workspace identity, scope, and coverage beside the
mutation commit. Publication, association reads, and repeated trusted-owner checks do not traverse the
Workspace tree; explicit verification or the first cold-process owner check performs the complete audit and
then caches trust. The private index queries only candidate paths. Exact ancestor D/F removals and candidate
updates are sent through one atomic `update-index`, and any load or mutation failure invalidates the warm
index until it is reloaded from the authoritative tree. This keeps one-file warm work independent of an
ancestor subtree's size without adding another durable index or recovery state machine.

### Task 4: Candidate discovery without a durable event WAL

**Files:**
- Create: `packages/coding-agent/workspace-rewind/workspace-candidates.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-candidates.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-change-feed.ts`
- Test: `packages/coding-agent/workspace-rewind/workspace-change-feed.test.ts`
- Transition: `packages/coding-agent/workspace-rewind/workspace-snapshot-tracker.ts`
- Transition tests: `packages/coding-agent/workspace-rewind/workspace-snapshot-tracker.test.ts`
- Regression: `packages/coding-agent/workspace-rewind/git-runner.ts`
- Regression tests: `packages/coding-agent/workspace-rewind/git-runner.test.ts`
- Regression: `packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts`
- Regression: `packages/coding-agent/workspace-rewind/multi-session.integration.test.ts`
- Regression: `packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts`
- Regression: `packages/coding-agent/workspace-rewind/snapshot-equivalence.integration.test.ts`
- Regression: `packages/coding-agent/workspace-rewind/snapshot-performance.test.ts`
- Regression: `packages/coding-agent/workspace-rewind/workspace-change-feed.integration.test.ts`

- [x] **Step 1: Write failing Git tests**

Cover dirty tracked, staged, untracked, deleted, checkout/reset to clean, ignored, nested repository, and Shadow head differing from source HEAD. Output is canonical, unique, byte-order sorted.

- [x] **Step 2: Write failing non-Git tests**

Cover one cold full baseline, warm dirty hints, overflow reconciliation, and restart ignoring old cursor artifacts.

- [x] **Step 3: Run RED**

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-candidates.test.ts packages/coding-agent/workspace-rewind/workspace-change-feed.test.ts
```

- [x] **Step 4: Implement candidates**

Git candidates are the union of user Git status, Shadow-tree/source-HEAD differences, and warm in-memory hints. Non-Git uses one baseline then in-memory hints. Every hint is re-read and validated; gap/overflow reconciles or returns unavailable.

- [x] **Step 5: Remove cursor authority from the feed API**

Expose only `start()`, `drain()`, `isTrusted()`, and `dispose()`. Leave the old storage file until Task 9 proves no callers remain.

- [x] **Step 6: Run GREEN and commit**

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-candidates.test.ts packages/coding-agent/workspace-rewind/workspace-change-feed.test.ts
git add packages/coding-agent/workspace-rewind/workspace-candidates.ts packages/coding-agent/workspace-rewind/workspace-candidates.test.ts packages/coding-agent/workspace-rewind/workspace-change-feed.ts packages/coding-agent/workspace-rewind/workspace-change-feed.test.ts
git commit -m "feat(agent): discover workspace delta candidates"
```

**Implementation note (2026-08-08):** The feed is now an in-memory, generation-fenced hint source with
no persisted cursor or authority. Git discovery preserves provenance: user status and private-tree
differences are never removed by current ignore rules; ignore filtering applies only to watcher hints.
Candidate processing performs one bounded post-processing retry, merges events observed during async path
and ignore checks, and fails closed if changes continue. Tests use separate user and private object databases;
the lifecycle layer in Task 5 must make `sourceHeadTree` and `shadowTree` readable from the private database
before calling discovery, while discovery itself remains read-only. Built-in fsmonitor is attempted through a
fixed safe option and falls back to disabled fsmonitor. Non-Git restart deliberately performs a full reconcile;
the transitional tracker keeps no durable cursor state and will be deleted at the authority cutover.

### Task 5: Tool-independent turn lifecycle

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/snapshot-source.ts`
- Test: `packages/coding-agent/workspace-rewind/snapshot-source.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/checkpoint-manager.ts`
- Test: `packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts`
- Modify: `packages/coding-agent/agent-session-runtime.ts`
- Test: `packages/coding-agent/agent-session-runtime.test.ts`
- Modify: `emain/agent-ipc.ts`
- Test: `emain/agent-ipc.test.ts`
- Test: `emain/agent-rewind.e2e.test.ts`
- Regression: `packages/coding-agent/workspace-rewind/snapshot-store.ts`
- Regression: `packages/coding-agent/workspace-rewind/workspace-mutation-log.ts`
- Regression: `packages/coding-agent/workspace-rewind/workspace-snapshot-tracker.ts`
- Regression tests: `packages/coding-agent/workspace-rewind/multi-session.integration.test.ts`
- Regression tests: `packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts`
- Retention: `packages/coding-agent/workspace-rewind/snapshot-retention.ts`
- Retention tests: `packages/coding-agent/workspace-rewind/snapshot-retention.test.ts`

- [x] **Step 1: Write failing lifecycle tests**

Prove no-tool turns write one available `before == after` checkpoint without capture; the first allowed mutating tool acquires once; blocked tools do not acquire; unknown future tools default to write-capable; terminal capture releases on success/failure.

- [x] **Step 2: Run RED**

```bash
npx vitest run packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts packages/coding-agent/agent-session-runtime.test.ts
```

- [x] **Step 3: Add manager entry points**

```ts
export interface WorkspaceCheckpointManager {
    isBusy(): boolean;
    beforeWorkspaceTool(toolName: string, signal?: AbortSignal): Promise<void>;
    beforeHostedCommand(signal?: AbortSignal): Promise<void>;
    recover(): Promise<void>;
    dispose(): Promise<void>;
}
```

Use a safe read-only allowlist (`read`, `grep`, `find`, `ls`, `web_fetch`); unknown tools may write. Acquisition first synchronizes external drift, then stores the base ref and lease on the active boundary.

- [x] **Step 4: Wire runtime after permission approval**

Call permissions first. If allowed, call `beforeWorkspaceTool`; call `beforeHostedCommand` before hosted PTY start/write. Harness terminal remains the release point.

- [x] **Step 5: Replace pre-turn capture**

`session_before_user_turn` creates only boundary metadata. No-tool terminal reads the current head once for both refs. A writing terminal captures candidates and appends one owned `agent-turn` commit.

- [x] **Step 6: Run GREEN, E2E, and commit**

```bash
npx vitest run packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts packages/coding-agent/agent-session-runtime.test.ts emain/agent-rewind.e2e.test.ts
git add packages/coding-agent/workspace-rewind/snapshot-source.ts packages/coding-agent/workspace-rewind/checkpoint-manager.ts packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts packages/coding-agent/agent-session-runtime.ts packages/coding-agent/agent-session-runtime.test.ts emain/agent-ipc.ts emain/agent-rewind.e2e.test.ts
git commit -m "feat(agent): checkpoint only workspace-writing turns"
```

**Implementation note (2026-08-08):** User-turn start now records only in-memory boundary metadata.
Permission-denied tools never acquire the Workspace writer lease; the first allowed mutating or unknown tool
acquires it once, synchronizes external drift, and holds it until terminal finalization. Read-only turns reuse
the current commit-backed head for both checkpoint sides without a second capture or physical commit. Writing
turns publish the snapshot association before the CAS head update, append one owned `agent-turn` commit for a
net state or coverage change, and release pending state and leases on every success/failure/dispose path.
Initialization remains behind the `LegacyWorkspaceSnapshotCapture` seam until Task 8 replaces that transitional
bootstrap with the shared Workspace resource. Retention validates and keeps the current authority-head
association live even when no Session owns it; older unowned associations still expire normally.

### Task 6: Commit-history cross-Session conflicts

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/restore-plan.ts`
- Test: `packages/coding-agent/workspace-rewind/restore-plan.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/turn-restore-plan.ts`
- Test: `packages/coding-agent/workspace-rewind/turn-restore-plan.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.ts`
- Test: `packages/coding-agent/workspace-rewind/multi-session.integration.test.ts`

- [x] **Step 1: Write failing ownership tests**

Cover different paths allowed; same path blocked; same path then same bytes still blocked; suffix-owned commits folded; external drift forceable only when previewed; Crest-owned overlap never forceable.

- [x] **Step 2: Run RED**

```bash
npx vitest run packages/coding-agent/workspace-rewind/restore-plan.test.ts packages/coding-agent/workspace-rewind/turn-restore-plan.test.ts packages/coding-agent/workspace-rewind/multi-session.integration.test.ts
```

- [x] **Step 3: Add history authority**

Validate each changed checkpoint's `after.id` as an `agent-turn` commit owned by its Session/turn and parented by `before.id`. Ask `findForeignOverlap()` before live-byte drift classification; foreign Crest overlap is a hard blocker.

- [x] **Step 4: Run GREEN and commit**

Run the same suites plus `rewind-engine.integration.test.ts`, then commit planner/engine changes.

**Implementation note (2026-08-09):** Restore planning now validates every checkpoint against its exact
`agent-turn` commit and parent, rejects later same-path Crest history including ABA changes, and permits Force
only for previewed external drift. Turn Undo/Redo and conversation Rewind/Redo retain separate public semantics;
linked result commits remain internal confirmation authority. Cross-Session, same-path, suffix-folding, and
create/delete Undo-to-Redo integration coverage passed.

### Task 7: Result commits and minimal pending restore

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/pending-restore-store.ts`
- Test: `packages/coding-agent/workspace-rewind/pending-restore-store.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-restore-executor.ts`
- Test: `packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-recovery.ts`
- Test: `packages/coding-agent/workspace-rewind/workspace-recovery.test.ts`
- Test: `packages/coding-agent/workspace-rewind/restore-crash.test.ts`

- [x] **Step 1: Write failing crash tests**

Cover pending absent, head at source with partial paths, head at planned with leaf pending, and unknown head/path state. Only the affected Workspace is gated.

- [x] **Step 2: Run RED**

```bash
npx vitest run packages/coding-agent/workspace-rewind/pending-restore-store.test.ts packages/coding-agent/workspace-rewind/workspace-recovery.test.ts packages/coding-agent/workspace-rewind/restore-crash.test.ts
```

- [x] **Step 3: Reduce pending to one intent**

Persist operation ID, source/planned commits, affected paths, Session ID, expected leaf, and target leaf. Persist no phases and no second frozen registry.

- [x] **Step 4: Append result commits**

After file verification, CAS the Shadow head to `turn-undo`, `turn-redo`, `rewind`, or `redo`; move conversation only after the file commit; clear pending last.

- [x] **Step 5: Implement three-way recovery**

Source head restores source paths; planned head completes leaf CAS; any other state emits one manual diagnostic without Force.

- [x] **Step 6: Run GREEN and commit**

Run pending/executor/recovery/crash suites and commit.

**Implementation note (2026-08-09):** Pending restore is now one durable V2 intent with no phase machine.
Execution writes and verifies files, publishes the exact result commit, moves the Session leaf, and clears the
intent last. Recovery derives only source, planned, or unknown from durable facts; inspection is read-only and
unknown state remains frozen for manual diagnosis. Result coverage is recomputed from exact target path states,
including create/delete changes. Public DTOs omit linked operation authority, and Workspace resource leases are
released even when Session open or close fails. Focused Task 6/7, crash-process, IPC, frontend, and real-Git
integration suites passed both specification and quality review.

### Task 8: Registry cutover

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/workspace-tracker-registry.ts`
- Test: `packages/coding-agent/workspace-rewind/workspace-tracker-registry.test.ts`
- Modify: `emain/agent-rewind-feature.ts`
- Test: `emain/agent-rewind-feature.test.ts`
- Modify: `emain/agent-rewind-service.ts`
- Test: `emain/agent-rewind-service.test.ts`

- [x] **Step 1: Write failing sharing tests**

All Sessions in one canonical Workspace share store, mutation log, candidates, and writer leases; different incarnations remain isolated; last release disposes only in-memory hints.

- [x] **Step 2: Run RED**

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-tracker-registry.test.ts emain/agent-rewind-feature.test.ts emain/agent-rewind-service.test.ts
```

- [x] **Step 3: Replace tracker resources**

Return `store`, `mutationLog`, `candidates`, and `writerLeases` from the shared resource. Wire checkpoint and rewind services to those exact objects.

- [x] **Step 4: Run GREEN and commit**

Run the same suites and commit.

**Implementation note (2026-08-09):** One canonical Workspace resource now owns the exact store, mutation log,
candidate feed, writer leases, and checkpoint snapshot source shared by every Session in the same incarnation.
Read, checkpoint, rewind, and recovery paths use those exact objects and release short-lived leases in `finally`;
last release disposes only in-memory capture and hint resources. Git and non-Git warm captures inspect candidate
paths only, validate watcher generation and HEAD boundaries after staging, retry a union once, and fail closed on
continued mutation. Scope invalidation uses an explicit full reconcile instead of the drained legacy tracker.
Nested Git Workspaces use their repository prefix and `HEAD:<prefix>` subtree, exclude siblings, and keep paths
Workspace-relative. Source-tree import batches private object probes and prunes existing subtrees, so warm cost
tracks changed tree depth rather than monorepo width. The legacy path-capture dependency remains isolated behind
one snapshot-source adapter for Task 9 removal. Specification and quality review passed after real Git,
same-path race, cross-Session, recovery, performance, and E2E regressions.

### Task 9: Delete the superseded durable authority

**Files:**
- Delete: `packages/coding-agent/workspace-rewind/workspace-snapshot-tracker.ts`
- Delete: `packages/coding-agent/workspace-rewind/workspace-snapshot-tracker.test.ts`
- Delete: `packages/coding-agent/workspace-rewind/workspace-tracker-state.ts`
- Delete: `packages/coding-agent/workspace-rewind/workspace-tracker-state.test.ts`
- Delete: `packages/coding-agent/workspace-rewind/workspace-change-feed-storage.ts`
- Delete: `packages/coding-agent/workspace-rewind/incremental-path-capture.ts`
- Delete: `packages/coding-agent/workspace-rewind/incremental-path-capture.test.ts`
- Delete: `packages/coding-agent/workspace-rewind/incremental-tree.ts`
- Delete: `packages/coding-agent/workspace-rewind/incremental-tree.test.ts`
- Delete: `packages/coding-agent/workspace-rewind/anchored-reader.ts`
- Delete: `packages/coding-agent/workspace-rewind/anchored-reader.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/stored-manifest.ts`
- Test: `packages/coding-agent/workspace-rewind/stored-manifest.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.ts`
- Test: `packages/coding-agent/workspace-rewind/snapshot-store.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-retention.ts`
- Test: `packages/coding-agent/workspace-rewind/snapshot-retention.test.ts`

- [x] **Step 1: Find stale production imports**

```bash
rg -n "WorkspaceSnapshotTracker|workspace-tracker-state|workspace-change-feed-storage|statetree" packages/coding-agent emain frontend
```

- [x] **Step 2: Delete tracker/cursor/custom-state authority**

Keep compact coverage metadata, Git tree/blob readers, candidate hints, one mutation ref, and pending/session-owned reachability only.

- [x] **Step 3: Run cutover verification**

```bash
rg -n "WorkspaceSnapshotTracker|workspace-tracker-state|workspace-change-feed-storage|statetree" packages/coding-agent emain frontend
npx vitest run packages/coding-agent/workspace-rewind emain/agent-rewind-feature.test.ts emain/agent-rewind-service.test.ts emain/agent-rewind.e2e.test.ts
```

Expected: no production matches and all selected tests PASS.

- [x] **Step 4: Commit the atomic authority cutover**

Commit deletions and retention/store simplification together so no shipped revision has two durable authorities.

**Implementation note (2026-08-09):** Task 9 completed the authority cutover and its follow-up quality fixes.
Fresh non-Git initialization now starts observation before the initial full capture, retains events observed during
that capture for the first warm candidate pass, and adopts the baseline only while the feed remains trusted and a
concurrent CAS winner has equivalent tree, scope, and coverage semantics. Snapshot object anchors and manifest
associations publish in one `update-ref --no-deref --stdin` transaction with two compare-and-swap updates; exact
quota traversal includes and deduplicates both `refs/crest` and `refs/crest-objects`, including historical orphan
anchors. Candidate coverage derives eligible-entry deltas from one native
`diff-tree --name-status -r -z --no-renames` result, so directory renames and file/directory replacements remain
exact without scanning the live Workspace or spawning per-path tree readers.

The equivalence regression is now an eleven-operation real Git/non-Git matrix covering create, same-size rewrite,
executable mode, symlink, delete, file-to-directory, directory rename, directory-to-file, `.gitignore` invalidation,
and nested repository boundaries. Every step compares the candidate head with an independent native full reconcile
for tree, scope, semantic coverage, and exact changed paths. The self-referential 50×100 in-memory projection and
the legacy `writeStateTree` path were deleted together with the tracker, durable watcher WAL/cursor, and custom
state-tree authority. The shipped design therefore retains candidate hints and compact coverage metadata only;
there is no tracker, WAL, custom tree, or other second durable authority beside the Shadow Git commit chain.

Specification and quality review both passed. Post-fix evidence was 122/122 combined focused tests across nine
files; 126/126 IPC and production E2E tests across two files; 75/75 feature, service, checkpoint-manager, engine,
multi-Session, and tool-independent tests across seven files; and 2/2 performance contracts, including the
100-dirty-parent-group bound. The forbidden-authority scan had no matches, the full three-commit diff passed
`git diff --check`, and the worktree was clean. The known pre-closeout concurrent full-suite baseline was 42/45
files passing, 731 tests passing, six timing out, and two skipped; the only failures were existing five-second
concurrency timeouts in `pending-restore` (four), `snapshot-retention` (one), and `snapshot-source` (one), while
those three files passed 45/45 when focused. A full correctness-gate rerun remains explicitly assigned to Task 10;
Task 9 did not raise timeouts, report zero latency, or claim that pre-closeout baseline as a latest-HEAD full run.

### Task 10: Production-scale gates and documentation

#### Task 10A: Git-native cold baseline before scale certification

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/git-runner.ts`
- Test: `packages/coding-agent/workspace-rewind/git-runner.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-source.ts`
- Test: `packages/coding-agent/workspace-rewind/snapshot-source.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.ts`
- Test: `packages/coding-agent/workspace-rewind/snapshot-store.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/shadow-workspace-index.ts`
- Test: `packages/coding-agent/workspace-rewind/shadow-workspace-index.test.ts`
- Regression: `packages/coding-agent/workspace-rewind/snapshot-equivalence.integration.test.ts`

- [ ] **Step 1: RED for a bounded private Git object closure import**

Require a SHA-1 source subtree pack to become independently readable from the private store. Prove abort,
quota, missing partial-clone object, replace-object and nested-prefix boundaries fail closed without publishing
a head or leaving a trusted temporary object source. A generic fetch, remote, durable cache or second state file
is forbidden.

- [ ] **Step 2: RED for Git-native cold projection**

Require initialization with a clean Git Workspace to reuse source OIDs without stable-reading clean contents.
Dirty/staged/deleted/untracked, CRLF/EOL, filter/ident/working-tree-encoding, executable, symlink and type ambiguity
must capture the exact live bytes. Ignored, nested repository, hard-linked, special, sparse/absent and non-UTF-8
coverage remains equivalent to an independent full reconcile.

- [ ] **Step 3: Implement the minimum fast path**

Reuse source-boundary resolution, metadata scope discovery, candidate capture, `ShadowWorkspaceIndex` and the
existing publication CAS. Stream one bounded source subtree pack into the private store, overlay only unsafe or
changed paths, and validate HEAD/index/status/feed/directory evidence before publication. Retry one merged race;
continued mutation is unavailable. Non-Git, unborn HEAD, non-SHA-1 and ambiguous source authority retain the full
reconcile fallback. Do not add a database, watcher WAL, persistent cursor, pack cache or recovery phase.

- [ ] **Step 4: Focused correctness and performance GREEN**

```bash
npx vitest run packages/coding-agent/workspace-rewind/git-runner.test.ts packages/coding-agent/workspace-rewind/shadow-workspace-index.test.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts packages/coding-agent/workspace-rewind/snapshot-source.test.ts packages/coding-agent/workspace-rewind/snapshot-equivalence.integration.test.ts
```

Assert cold working-tree content reads are `O(uncertain + dirty + untracked)`, Git child count is bounded by fixed
chunks rather than path count, the private baseline restores after the user object database is unavailable, and
all failure paths preserve the existing fail-closed result.

**Files:**
- Modify: `scripts/benchmark-agent-rewind-snapshots.ts`
- Modify: `scripts/benchmark-agent-rewind-snapshots.test.ts`
- Modify: `scripts/validate-agent-rewind-production-scale.ts`
- Modify: `docs/agent-architecture.md`
- Modify: `docs/agent-runtime-architecture.md`
- Modify: `docs/superpowers/specs/2026-08-08-agent-workspace-rewind-shadow-git-design.md`
- Create: `docs/superpowers/reports/2026-08-08-agent-rewind-shadow-git-validation.md`

- [ ] **Step 1: Write failing benchmark contract tests**

Require cold, no-tool, warm no-change, 1/10/100 dirty paths, 1/2/4 Session contention, overlap, and restore rows with candidate count, bytes read, commits traversed, p50/p95, and pass/fallback/unavailable.

- [ ] **Step 2: Run RED then update scripts**

```bash
npx vitest run scripts/benchmark-agent-rewind-snapshots.test.ts
```

- [ ] **Step 3: Run correctness gates**

```bash
npx vitest run packages/coding-agent/workspace-rewind emain/agent-rewind-feature.test.ts emain/agent-rewind-service.test.ts emain/agent-rewind.e2e.test.ts frontend/app/agent/rewind
npx tsc --noEmit
git diff --check
```

- [ ] **Step 4: Run scale gates without raising limits**

```bash
npm run benchmark:agent-rewind-snapshots -- --entries=10000 --iterations=10
npm run benchmark:agent-rewind-snapshots -- --entries=50000 --iterations=10
npm run benchmark:agent-rewind-snapshots -- --entries=200000 --iterations=10
```

Record timeout/fallback as a failure or explicit limitation; never replace it with zero latency.

- [ ] **Step 5: Close docs and commit evidence**

Mark the design implemented only if correctness gates pass and old authority modules are gone. Force-add the ignored design, plan, and report files, then commit measured results.
