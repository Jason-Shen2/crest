# Agent Turn Undo Loading Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove redundant snapshot verification from warm Turn Undo/Redo previews and provide polished loading, applying, and success feedback.

**Architecture:** Keep the existing checkpoint and confirmation flow. Warm the snapshot store's existing trust cache while producing the turn summary, retain fresh live-disk inspection for every preview, and represent preview loading and mutation application as separate states in the shared `DiffReviewDialog`.

**Tech Stack:** TypeScript, React 19, Vitest, Testing Library, Tailwind CSS, Electron agent runtime.

---

## File Structure

- `packages/coding-agent/workspace-rewind/rewind-engine.ts`: use the existing trusted immutable-snapshot path for turn checkpoint operations.
- `packages/coding-agent/workspace-rewind/rewind-engine.test.ts`: prove Turn operations use the trust-aware verifier without weakening live-disk planning.
- `frontend/app/agent/rewind/diff-review-dialog.tsx`: render structured loading skeletons and an applying overlay while preserving the diff.
- `frontend/app/agent/rewind/diff-review-dialog.test.tsx`: verify loading and applying presentation and accessible status text.
- `frontend/app/agent/rewind/use-agent-turn-changes.ts`: carry a file-count hint and emit completion only after authoritative acknowledgement.
- `frontend/app/agent/rewind/use-agent-turn-changes.test.tsx`: verify acknowledgement-gated, exactly-once completion.
- `frontend/app/agent/agent-content.tsx`: wire applying labels/buttons and success toast.
- `frontend/app/agent/agent-content.test.tsx`: verify user-visible execution and completion feedback.

### Task 1: Use the trusted snapshot warm path

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.ts`
- Test: `packages/coding-agent/workspace-rewind/rewind-engine.test.ts`

- [ ] **Step 1: Write the failing verifier-routing test**

Add spies for `verify` and `verifyUntrustedSnapshot`, load a Turn checkpoint through summary/preview, and assert Turn operations call `verifyUntrustedSnapshot` for before/after while the legacy full verifier is not selected by this path.

- [ ] **Step 2: Run the focused test and confirm the assertion fails**

Run: `npx vitest run packages/coding-agent/workspace-rewind/rewind-engine.test.ts --reporter=dot`

Expected: FAIL because `loadTurnCheckpoint`, `computeTurnUndo`, and `computeTurnRedo` still call `store.verify()`.

- [ ] **Step 3: Route Turn checkpoint verification through the trust-aware API**

Replace only the Turn-specific calls with:

```ts
await this.store.verifyUntrustedSnapshot(checkpoint.before);
await this.store.verifyUntrustedSnapshot(checkpoint.after);
```

and pass the same method to Turn restore planning:

```ts
verifySnapshot: (snapshot) => this.store.verifyUntrustedSnapshot(snapshot),
```

Keep live-path inspection and conversation rewind verification unchanged.

- [ ] **Step 4: Run the focused engine test**

Run: `npx vitest run packages/coding-agent/workspace-rewind/rewind-engine.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Build quiet loading and applying states

**Files:**
- Modify: `frontend/app/agent/rewind/diff-review-dialog.tsx`
- Test: `frontend/app/agent/rewind/diff-review-dialog.test.tsx`

- [ ] **Step 1: Replace the old loading-copy test with skeleton semantics**

Assert that loading renders a `Loading changes…` status, file-row skeletons, and a diff skeleton; assert the empty-state copy and `Preparing safe undo…` are absent. Add an applying test that passes `processingLabel="Undoing 1 file…"` and asserts the existing selected diff remains mounted beneath a locked status overlay.

- [ ] **Step 2: Run the dialog test and confirm it fails**

Run: `npx vitest run frontend/app/agent/rewind/diff-review-dialog.test.tsx --reporter=dot`

Expected: FAIL because the component still renders `Loading files…`, `Loading diff…`, and has no processing overlay.

- [ ] **Step 3: Implement the skeleton and overlay**

Add optional `loadingFileCount?: number` and `processingLabel?: string` props. Render one to three file skeleton rows from `loadingFileCount`, code-shaped lines in the right pane, and an absolute translucent overlay only when `processingLabel` exists. Use `animate-pulse motion-reduce:animate-none` and keep loaded files/diff mounted during processing.

- [ ] **Step 4: Run the dialog test**

Run: `npx vitest run frontend/app/agent/rewind/diff-review-dialog.test.tsx --reporter=dot`

Expected: PASS.

### Task 3: Gate completion on authoritative acknowledgement

**Files:**
- Modify: `frontend/app/agent/rewind/use-agent-turn-changes.ts`
- Test: `frontend/app/agent/rewind/use-agent-turn-changes.test.tsx`

- [ ] **Step 1: Write acknowledgement and file-hint tests**

Extend test options with an `onMutationComplete` spy. Assert opening from a card copies `summary.fileCount` to `dialog.fileCountHint`. After apply RPC resolves, assert completion has not fired until `rewindState.turnChanges` changes to the expected action; after rerender assert it fires once with `{ action: "undo", fileCount: 1 }`.

- [ ] **Step 2: Run the hook test and confirm it fails**

Run: `npx vitest run frontend/app/agent/rewind/use-agent-turn-changes.test.tsx --reporter=dot`

Expected: FAIL because the hook exposes neither the hint nor a completion callback.

- [ ] **Step 3: Implement the acknowledgement payload**

Add `onMutationComplete(result: { action: "undo" | "redo"; fileCount: number }): void` to the options. Store the original action and preview file count in `PendingAck`. Centralize successful closure so both event orderings—authority first or RPC first—clear the pending ref, close the dialog, and invoke the callback exactly once. Do not invoke it from error or stale-session paths.

- [ ] **Step 4: Run the hook test**

Run: `npx vitest run frontend/app/agent/rewind/use-agent-turn-changes.test.tsx --reporter=dot`

Expected: PASS.

### Task 4: Wire applying feedback and toast

**Files:**
- Modify: `frontend/app/agent/agent-content.tsx`
- Test: `frontend/app/agent/agent-content.test.tsx`

- [ ] **Step 1: Write UI integration tests**

Assert a pending undo renders a disabled spinner button named `Undoing…` and passes `Undoing 1 file…` to the dialog while retaining its file rows. After the authoritative state changes, assert the dialog closes and `ToastModel` contains one completed notification titled `Changes undone` with body `1 file restored.`

- [ ] **Step 2: Run the component test and confirm it fails**

Run: `npx vitest run frontend/app/agent/agent-content.test.tsx --reporter=dot`

Expected: FAIL because applying removes the primary action and no success toast is emitted.

- [ ] **Step 3: Implement the integration**

Pass `loadingFileCount` and `processingLabel` into `DiffReviewDialog`. During `phase === "applying"`, render a disabled primary button with `LoaderCircleIcon` and `Undoing…` or `Redoing…`. Wire `onMutationComplete` to `ToastModel.getInstance().push()` using singular/plural restored or reapplied copy.

- [ ] **Step 4: Run the component test**

Run: `npx vitest run frontend/app/agent/agent-content.test.tsx --reporter=dot`

Expected: PASS.

### Task 5: Verify the complete change

**Files:**
- Verify all files above.

- [ ] **Step 1: Format modified files**

Run: `npx prettier --write packages/coding-agent/workspace-rewind/rewind-engine.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts frontend/app/agent/rewind/diff-review-dialog.tsx frontend/app/agent/rewind/diff-review-dialog.test.tsx frontend/app/agent/rewind/use-agent-turn-changes.ts frontend/app/agent/rewind/use-agent-turn-changes.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx docs/superpowers/specs/2026-08-04-agent-turn-undo-loading-performance-design.md docs/superpowers/plans/2026-08-04-agent-turn-undo-loading-performance.md`

Expected: command exits successfully.

- [ ] **Step 2: Run the focused regression suite**

Run: `npx vitest run packages/coding-agent/workspace-rewind/rewind-engine.test.ts frontend/app/agent/rewind/diff-review-dialog.test.tsx frontend/app/agent/rewind/use-agent-turn-changes.test.tsx frontend/app/agent/agent-content.test.tsx --reporter=dot`

Expected: all tests PASS.

- [ ] **Step 3: Run integration and build verification**

Run: `npx vitest run emain/agent-rewind.e2e.test.ts --reporter=dot`

Run: `npm run build:dev`

Run: `git diff --check`

Expected: tests and build succeed; diff check prints no errors.

- [ ] **Step 4: Commit the implementation**

```bash
git add docs/superpowers/specs/2026-08-04-agent-turn-undo-loading-performance-design.md docs/superpowers/plans/2026-08-04-agent-turn-undo-loading-performance.md packages/coding-agent/workspace-rewind/rewind-engine.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts frontend/app/agent/rewind/diff-review-dialog.tsx frontend/app/agent/rewind/diff-review-dialog.test.tsx frontend/app/agent/rewind/use-agent-turn-changes.ts frontend/app/agent/rewind/use-agent-turn-changes.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx
git commit -m "fix(agent): accelerate turn undo feedback"
```

Expected: a new commit is created on `codex/agent-workspace-rewind`.
