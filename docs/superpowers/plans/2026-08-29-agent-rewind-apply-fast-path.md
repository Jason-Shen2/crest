# Agent Rewind Apply Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove redundant planning, Recovery classification, and Git head reads from successful Undo/Redo Apply operations while preserving multi-Session overlap, drift, CAS, and crash-recovery guarantees.

**Architecture:** Reuse the immutable `RestorePlanV1` already stored by `RewindConfirmationRegistry`, bind it to a stable Shadow Git authority head, and validate only the commit suffix and live target paths at Apply time. Successful restores clear their own matching pending intent directly; the existing Recovery Resolver remains authoritative only for startup and exceptional outcomes.

**Tech Stack:** TypeScript, Vitest, Node.js 22, private Shadow Git repositories, Electron agent IPC, SQLite-backed agent Sessions.

---

## File Structure

- Modify `packages/coding-agent/workspace-rewind/workspace-mutation-log.ts`: allow overlap traversal against an explicit head and remove redundant pre-CAS head reads.
- Modify `packages/coding-agent/workspace-rewind/workspace-mutation-log.test.ts`: cover fixed-head overlap traversal, ABA, CAS, and Git process count.
- Modify `packages/coding-agent/workspace-rewind/restore-plan.ts`: thread a fixed authority head through conversation history checks.
- Modify `packages/coding-agent/workspace-rewind/turn-restore-plan.ts`: thread a fixed authority head through Turn history checks.
- Modify `packages/coding-agent/workspace-rewind/confirmation-token.ts`: bind each immutable confirmed plan to its Preview authority head.
- Modify `packages/coding-agent/workspace-rewind/confirmation-token.test.ts`: cover authority-head validation, expiry, one-shot consumption, and binding.
- Create `packages/coding-agent/workspace-rewind/restore-freshness.ts`: validate only the confirmed head suffix and Force policy before Apply.
- Create `packages/coding-agent/workspace-rewind/restore-freshness.test.ts`: cover unchanged, unrelated, same-path, ABA, external Force, and invalid ancestry cases.
- Modify `packages/coding-agent/workspace-rewind/rewind-engine.ts`: produce plans against stable heads and execute the frozen confirmed plan.
- Modify `packages/coding-agent/workspace-rewind/rewind-engine.test.ts`: prove stable Preview retry and no Apply-time plan recomputation.
- Modify `packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts`: prove unrelated Session changes survive and same-path changes stale the confirmation.
- Modify `packages/coding-agent/workspace-rewind/workspace-restore-executor.ts`: add the normal completion fast path and phase timings.
- Modify `packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts`: prove successful execution skips Recovery and failures still use it.
- Modify `scripts/benchmark-agent-rewind-snapshots.ts`: report Apply-only latency, phase timings, and Git process counts.
- Modify `docs/superpowers/reports/2026-08-09-agent-rewind-v3-scale-gates.md`: append measured fast-path results without rewriting historical evidence.

### Task 1: Bind history traversal to one explicit Shadow Git head

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/workspace-mutation-log.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-mutation-log.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/restore-plan.ts`
- Modify: `packages/coding-agent/workspace-rewind/turn-restore-plan.ts`

- [ ] **Step 1: Write failing fixed-head overlap tests**

Add tests that create `H0`, advance the live ref to `H1`, and explicitly inspect at `H0`:

```ts
test("inspects overlap against the explicit authority head", async () => {
    const fixture = await makeFixture(roots);
    const owner = await appendOwned(fixture, undefined, "session-a", { "shared.txt": "owner" });
    const foreign = await appendOwned(fixture, owner, "session-b", { "shared.txt": "foreign" });

    await expect(
        fixture.log.findForeignOverlap({
            afterCommit: owner,
            head: owner,
            paths: ["shared.txt"],
            includedCommits: new Set(),
            ownerSessionId: "session-a",
        })
    ).resolves.toEqual([]);
    await expect(
        fixture.log.findForeignOverlap({
            afterCommit: owner,
            head: foreign,
            paths: ["shared.txt"],
            includedCommits: new Set(),
            ownerSessionId: "session-a",
        })
    ).resolves.toEqual([{ commit: foreign, path: "shared.txt", sessionId: "session-b" }]);
});
```

Also assert an explicit head outside the `afterCommit` chain fails with `requested mutation boundary is not in the workspace commit chain`.

- [ ] **Step 2: Run the mutation-log test and verify RED**

Run:

```bash
npm test -- --run packages/coding-agent/workspace-rewind/workspace-mutation-log.test.ts
```

Expected: TypeScript/Vitest fails because `ForeignOverlapInput` has no `head` property.

- [ ] **Step 3: Implement explicit-head traversal**

Extend the input without changing callers that still require internal stability checks:

```ts
export interface ForeignOverlapInput {
    afterCommit: string;
    head?: string;
    paths: readonly string[];
    includedCommits: ReadonlySet<string>;
    ownerSessionId: string;
}
```

Inside `findForeignOverlap()` validate `input.head` as an OID, use it instead of `readHead()`, and only perform the final live-ref reread when no explicit head was supplied:

```ts
const explicitHead = input.head;
if (explicitHead != null) validateSha1(explicitHead);
const head = explicitHead ?? (await this.readHead());
if (!head) throw new Error("Workspace mutation head is missing");
// existing immutable traversal
if (explicitHead == null && (await this.readHead()) !== head) {
    throw new Error("Workspace mutation head moved during overlap inspection");
}
```

Add `authorityHead?: string` to the planner base inputs. Pass it through `findCrestHistoryBlockers()` to
`findForeignOverlap({ head: input.authorityHead, ... })`. Existing direct planner tests may omit it; production Preview will always provide it in Task 2.

- [ ] **Step 4: Run focused history tests and verify GREEN**

Run:

```bash
npm test -- --run packages/coding-agent/workspace-rewind/workspace-mutation-log.test.ts packages/coding-agent/workspace-rewind/restore-plan.test.ts packages/coding-agent/workspace-rewind/turn-restore-plan.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit explicit-head traversal**

```bash
git add packages/coding-agent/workspace-rewind/workspace-mutation-log.ts packages/coding-agent/workspace-rewind/workspace-mutation-log.test.ts packages/coding-agent/workspace-rewind/restore-plan.ts packages/coding-agent/workspace-rewind/turn-restore-plan.ts
git commit -m "refactor: bind rewind planning to one workspace head"
```

### Task 2: Bind confirmations to a stable Preview authority head

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/confirmation-token.ts`
- Modify: `packages/coding-agent/workspace-rewind/confirmation-token.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.test.ts`

- [ ] **Step 1: Write failing authority-binding and stable-Preview tests**

Add a valid OID fixture and require it at issue time:

```ts
const AuthorityHead = "9".repeat(40);

test("freezes the Preview authority head with the confirmed plan", () => {
    const registry = new RewindConfirmationRegistry();
    const token = registry.issue(plan(), AuthorityHead, 100);
    const confirmed = registry.take(token, 101);

    expect(confirmed.authorityHead).toBe(AuthorityHead);
    expect(Object.isFrozen(confirmed)).toBe(true);
    expect(() => ((confirmed as { authorityHead: string }).authorityHead = "8".repeat(40))).toThrow();
});

test.each(["", "not-an-oid", "a".repeat(39)])("rejects invalid authority head %s", (head) => {
    expect(() => new RewindConfirmationRegistry().issue(plan(), head, 0)).toThrow(/authority head/i);
});
```

Update the existing registry tests to pass `AuthorityHead` while keeping their explicit clock values.

Inject or spy on `store.mutationLog.readHead()` and the planner. Cover:

```ts
test("retries Preview once when the workspace head moves while planning", async () => {
    vi.spyOn(value.store.mutationLog, "readHead")
        .mockResolvedValueOnce(HeadA)
        .mockResolvedValueOnce(HeadB)
        .mockResolvedValueOnce(HeadB)
        .mockResolvedValueOnce(HeadB);

    const preview = await value.engine.previewTurnUndo(turnInput(value));

    expect(value.planTurnUndo).toHaveBeenCalledTimes(2);
    expect(value.planTurnUndo).toHaveBeenLastCalledWith(expect.objectContaining({ authorityHead: HeadB }));
    expect(value.confirmations.take(preview.confirmationToken!).authorityHead).toBe(HeadB);
});
```

Add a second test where both attempts move and expect `/workspace.*changed.*preview/i`, with no issued token.

- [ ] **Step 2: Run confirmation and engine tests and verify RED**

Run:

```bash
npm test -- --run packages/coding-agent/workspace-rewind/confirmation-token.test.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts
```

Expected: `issue()` does not accept/store an authority head, planner lacks `authorityHead`, and Preview does not retry.

- [ ] **Step 3: Implement the required authority binding and stable planning**

Change the registry API to:

```ts
issue(plan: RestorePlanV1, authorityHead: string, now = Date.now()): string
```

Validate `authorityHead` with the existing SHA-1 format, store it on `ConfirmedRestorePlanV1`, include it in the frozen value,
and retain the existing plan binding, capacity, TTL, one-shot, and Session invalidation behavior.

Add `authorityHead` to `PlannedRestore` and one internal engine helper:

```ts
private async computeAtStableHead(
    compute: (authorityHead: string) => Promise<Omit<PlannedRestore, "authorityHead">>
): Promise<PlannedRestore> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const authorityHead = await this.store.mutationLog.readHead();
        if (!authorityHead) throw new Error("Workspace mutation head is not initialized");
        const planned = await compute(authorityHead);
        if ((await this.store.mutationLog.readHead()) === authorityHead) {
            return { ...planned, authorityHead };
        }
    }
    throw new Error("Workspace changed while preparing the rewind preview");
}
```

Route all four Preview methods through this helper. Pass `authorityHead` to `planRewind`, `planRedo`, `planTurnUndo`, and
`planTurnRedo`. Change `preview()` to issue `this.confirmations.issue(plan, planned.authorityHead)` only for non-blocked plans.

Update direct registry callers in executor tests and the benchmark to pass the actual fixture mutation head.

- [ ] **Step 4: Run confirmation, engine, planning, and executor tests and verify GREEN**

Run:

```bash
npm test -- --run packages/coding-agent/workspace-rewind/confirmation-token.test.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts packages/coding-agent/workspace-rewind/restore-plan.test.ts packages/coding-agent/workspace-rewind/turn-restore-plan.test.ts packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit stable confirmation authority**

```bash
git add packages/coding-agent/workspace-rewind/confirmation-token.ts packages/coding-agent/workspace-rewind/confirmation-token.test.ts packages/coding-agent/workspace-rewind/rewind-engine.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts scripts/benchmark-agent-rewind-snapshots.ts
git commit -m "feat: bind rewind previews to stable workspace authority"
```

### Task 3: Validate only the confirmed commit suffix at Apply time

**Files:**
- Create: `packages/coding-agent/workspace-rewind/restore-freshness.ts`
- Create: `packages/coding-agent/workspace-rewind/restore-freshness.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts`

- [ ] **Step 1: Write failing freshness tests**

Define the wished-for API and cover exact semantics:

```ts
await expect(
    assertConfirmedRestoreFresh({
        confirmation,
        currentHead: HeadA,
        mode: "normal",
        mutationLog,
    })
).resolves.toBeUndefined();

await expect(
    assertConfirmedRestoreFresh({
        confirmation,
        currentHead: ForeignDifferentPathHead,
        mode: "normal",
        mutationLog,
    })
).resolves.toBeUndefined();

await expect(
    assertConfirmedRestoreFresh({
        confirmation,
        currentHead: ForeignSamePathHead,
        mode: "normal",
        mutationLog,
    })
).rejects.toThrow(/stale.*path/i);
```

Also cover Session-owned ABA, non-ancestor current head, external same-path drift rejected in normal mode, and external same-path
drift allowed only when the frozen path was already `forceable-drift` and mode is `force-drift`.

- [ ] **Step 2: Run freshness tests and verify RED**

Run:

```bash
npm test -- --run packages/coding-agent/workspace-rewind/restore-freshness.test.ts
```

Expected: module/function is missing.

- [ ] **Step 3: Implement minimal suffix validation**

Implement:

```ts
export async function assertConfirmedRestoreFresh(input: {
    confirmation: ConfirmedRestorePlanV1;
    currentHead: string;
    mode: "normal" | "force-drift";
    mutationLog: Pick<WorkspaceMutationLog, "findForeignOverlap">;
}): Promise<void> {
    assertRestorePlanMatchesConfirmation({
        confirmation: input.confirmation,
        plan: input.confirmation.plan,
        mode: input.mode,
    });
    if (input.currentHead === input.confirmation.authorityHead) return;
    const overlaps = await input.mutationLog.findForeignOverlap({
        afterCommit: input.confirmation.authorityHead,
        head: input.currentHead,
        paths: input.confirmation.plan.paths.map((path) => path.path),
        includedCommits: new Set(),
        ownerSessionId: input.confirmation.plan.sessionId,
    });
    for (const overlap of overlaps) {
        const path = input.confirmation.plan.paths.find((candidate) => candidate.path === overlap.path)!;
        const confirmedExternalForce =
            overlap.sessionId == null && input.mode === "force-drift" && path.conflict === "forceable-drift";
        if (!confirmedExternalForce) throw new Error(`Rewind confirmation is stale for path: ${overlap.path}`);
    }
}
```

Do not inspect live files here; `WorkspaceRestoreExecutor.verifySourceStates()` remains the single final target-path live validation.

- [ ] **Step 4: Make Apply execute the frozen plan**

Change `applyTurn()` and `apply()` so they no longer call any `compute*()` method. Under `withRestoreLease`, call
`assertConfirmedRestoreFresh()` with the synchronized source head, then pass `confirmation.plan` to the executor.

Before the first file write, fold `await input.session.getEntries()` and require its `semanticLeafId` to equal
`confirmation.plan.semanticLeafId`. The retained Session mutation lease keeps that leaf stable through marker append. This is the
lightweight replacement for the leaf validation previously obtained as a side effect of full plan recomputation.

For Conversation Rewind result text, derive `targetEntry` from the entries passed to `commit.makeResult()` using
`confirmation.plan.target.targetTurnId`; do not retain a second planned object solely for UI output.

Add a test that spies on all four planner implementations, resets their Preview calls, performs Apply, and asserts none were called.

- [ ] **Step 5: Run RED/GREEN integration scenarios**

Run:

```bash
npm test -- --run packages/coding-agent/workspace-rewind/restore-freshness.test.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts packages/coding-agent/workspace-rewind/multi-session.integration.test.ts
```

Expected: unchanged and unrelated-path Apply pass; same-path and ABA confirmations fail before pending publication.

- [ ] **Step 6: Commit frozen-plan Apply**

```bash
git add packages/coding-agent/workspace-rewind/restore-freshness.ts packages/coding-agent/workspace-rewind/restore-freshness.test.ts packages/coding-agent/workspace-rewind/rewind-engine.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts
git commit -m "perf: reuse confirmed rewind plans during apply"
```

### Task 4: Remove full Recovery from the normal success path

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/workspace-restore-executor.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts`

- [ ] **Step 1: Write a failing normal-path Recovery test**

Inject a recovery spy through `makeExecutor()`:

```ts
test("clears its matching pending intent without classifying Recovery after normal commit", async () => {
    const fixture = await makeFixture();
    const resolvePendingUnderLease = vi.fn(async () => {
        throw new Error("normal success must not enter Recovery");
    });
    const executor = makeExecutor(fixture, { recovery: { resolvePendingUnderLease } });

    await expect(execute(executor, fixture, fixture.plan)).resolves.toBeDefined();
    expect(resolvePendingUnderLease).not.toHaveBeenCalled();
    await expect(new PendingWorkspaceRestoreStore(fixture.store).readCandidate()).resolves.toEqual({ kind: "none" });
});
```

- [ ] **Step 2: Run executor tests and verify RED**

Run:

```bash
npm test -- --run packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts -t "without classifying Recovery"
```

Expected: test fails because successful execution calls the injected Resolver.

- [ ] **Step 3: Implement matching-pending cleanup**

Add a focused executor helper:

```ts
async clearCommittedPending(pending: PendingWorkspaceRestoreV2): Promise<void> {
    await this.store.withWorkspaceLock(async () => {
        await this.pending.removeLocked(pending.operationId);
    });
}
```

After successful `appendEntries`, call this helper and return. Keep the existing `catch` path unchanged: every exception after pending
publication calls `resolvePendingUnderLease()` and handles committed/not-committed/needs-user exactly as before.

- [ ] **Step 4: Add cleanup-failure Recovery coverage**

Spy on `pending.removeLocked()` to throw once, then delegate normally. Assert executor enters Recovery, returns the committed result,
and leaves no pending intent. Retain the existing marker-CAS failure test to prove abnormal completion still works.

- [ ] **Step 5: Run executor, Recovery, and crash tests and verify GREEN**

Run:

```bash
npm test -- --run packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts packages/coding-agent/workspace-rewind/workspace-recovery.test.ts packages/coding-agent/workspace-rewind/restore-crash.test.ts
```

Expected: all tests pass, including real child-process crash coverage.

- [ ] **Step 6: Commit normal completion fast path**

```bash
git add packages/coding-agent/workspace-rewind/workspace-restore-executor.ts packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts
git commit -m "perf: reserve rewind recovery for exceptional outcomes"
```

### Task 5: Remove redundant Git head reads under the Writer Lease

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/workspace-mutation-log.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-mutation-log.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-restore-executor.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts`

- [ ] **Step 1: Write failing Git process-count tests**

Spy on `fixture.git.run` after fixture setup. Preparing and publishing a mutation with a known expected head must execute
`commit-tree` and `update-ref`, but no `for-each-ref`:

```ts
const run = vi.spyOn(fixture.git, "run");
const prepared = await fixture.log.prepare({ expectedHead: base, tree, metadata });
await fixture.log.publishPrepared(prepared);
const subcommands = run.mock.calls.map(([args]) => args.find((arg) => !arg.startsWith("-")));
expect(run.mock.calls.filter(([args]) => args.includes("for-each-ref"))).toHaveLength(0);
expect(run.mock.calls.filter(([args]) => args.includes("commit-tree"))).toHaveLength(1);
expect(run.mock.calls.filter(([args]) => args.includes("update-ref"))).toHaveLength(1);
```

Keep the moved-head and symbolic-ref tests as required safety coverage.

- [ ] **Step 2: Run mutation-log tests and verify RED**

Run:

```bash
npm test -- --run packages/coding-agent/workspace-rewind/workspace-mutation-log.test.ts
```

Expected: process-count test reports two or more `for-each-ref` calls.

- [ ] **Step 3: Remove pre-CAS reads**

Delete `await this.readHead()` from `prepare()` and `publishPrepared()`. Keep the prepared-token capability check and exact
`update-ref --no-deref <ref> <new> <expected>` CAS. The existing symbolic-ref test is a mandatory gate: Git must reject the CAS
because the direct symbolic-ref value cannot equal the expected commit OID. If that test fails, restore the publish-time exact-ref
read and leave the process-count gate at one `for-each-ref`; do not change symbolic-ref semantics.

Remove the initial executor `readHead()` equality check only after its callers pass a source returned while holding the Writer Lease.
The final `update-ref` CAS remains authoritative, and target live-state validation still runs before the first write.

- [ ] **Step 4: Run mutation/executor correctness tests and verify GREEN**

Run:

```bash
npm test -- --run packages/coding-agent/workspace-rewind/workspace-mutation-log.test.ts packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts packages/coding-agent/workspace-rewind/multi-session.integration.test.ts
```

Expected: all tests pass; stale and symbolic heads remain rejected.

- [ ] **Step 5: Commit reduced Git fixed cost**

```bash
git add packages/coding-agent/workspace-rewind/workspace-mutation-log.ts packages/coding-agent/workspace-rewind/workspace-mutation-log.test.ts packages/coding-agent/workspace-rewind/workspace-restore-executor.ts packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts
git commit -m "perf: reduce rewind shadow git head reads"
```

### Task 6: Add phase timings and close performance gates

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/workspace-restore-executor.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts`
- Modify: `scripts/benchmark-agent-rewind-snapshots.ts`
- Modify: `docs/superpowers/reports/2026-08-09-agent-rewind-v3-scale-gates.md`

- [ ] **Step 1: Write a failing timing observer test**

Add an optional executor callback and assert one complete record is emitted:

```ts
const onTiming = vi.fn();
const executor = makeExecutor(fixture, { onTiming });
await execute(executor, fixture, fixture.plan);
expect(onTiming).toHaveBeenCalledWith(
    expect.objectContaining({
        pathCount: 1,
        totalMs: expect.any(Number),
        prepareCommitMs: expect.any(Number),
        applyFilesMs: expect.any(Number),
        pendingCleanupMs: expect.any(Number),
    })
);
```

- [ ] **Step 2: Run the timing test and verify RED**

Run:

```bash
npm test -- --run packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts -t "timing"
```

Expected: constructor option/type is missing.

- [ ] **Step 3: Implement non-authoritative phase timing**

Add `WorkspaceRestoreTiming` and `onTiming?: (timing) => void`. Measure with `performance.now()` around existing awaits; do not add
new awaits, files, locks, or durable state. Emit the record in `finally`, including failures, with `outcome: "committed" | "failed"`.

The minimum fields are `totalMs`, `prepareCommitMs`, `pendingPublishMs`, `applyFilesMs`, `verifyFilesMs`, `publishHeadMs`,
`appendMarkerMs`, `pendingCleanupMs`, `pathCount`, and `outcome`.

- [ ] **Step 4: Extend the benchmark with Apply-only rows**

Use the existing restore fixture but start the timer after Preview/confirmation and before executor Apply. Run at least 30 warm
iterations for 1/10/100 paths and record `p50Ms`, `p95Ms`, `maxMs`, phase p95 values, and Git process count. Preserve existing JSON
fields and historical rows.

- [ ] **Step 5: Run focused performance gates**

Run:

```bash
npm run benchmark:agent-rewind-snapshots -- --entries=50000 --iterations=30
npm run benchmark:agent-rewind-snapshots -- --entries=200000 --iterations=30
```

Expected gates:

- 50k single-file Apply P95 `< 1,000 ms`;
- 200k single-file Apply P95 `< 1,500 ms`;
- no fallback, timeout, unavailable, pending leak, or source Workspace mutation;
- path count and restored bytes remain fixed between repository sizes.

If a gate fails, record the actual phase evidence and optimize only the dominant phase before rerunning. Do not loosen the thresholds.

- [ ] **Step 6: Run full feature correctness**

Run:

```bash
npm test -- --run packages/coding-agent/workspace-rewind emain/agent-rewind.e2e.test.ts frontend/app/agent/rewind
npx tsc --noEmit --pretty false
git diff --check
```

Expected: all Rewind-focused tests pass; Rewind-related TypeScript diagnostics are zero. If repo-wide unrelated baseline diagnostics
remain, record them separately and do not claim a clean repo-wide TypeScript gate.

- [ ] **Step 7: Record measured results and commit**

Append the exact commands, platform, Node version, p50/p95/max, phase breakdown, fallback count, test totals, and remaining boundary to
the existing scale report.

```bash
git add packages/coding-agent/workspace-rewind/workspace-restore-executor.ts packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts scripts/benchmark-agent-rewind-snapshots.ts docs/superpowers/reports/2026-08-09-agent-rewind-v3-scale-gates.md
git commit -m "perf: close rewind apply latency gates"
```

### Task 7: Final specification audit

**Files:**
- Modify: `docs/superpowers/specs/2026-08-29-agent-rewind-apply-fast-path-design.md`
- Modify: `docs/superpowers/plans/2026-08-29-agent-rewind-apply-fast-path.md`

- [ ] **Step 1: Compare implementation with every design invariant**

Confirm from code and tests that frozen-plan Apply, stable Preview head, suffix overlap, external Force distinction, live fingerprint,
Writer Lease, pending, CAS, abnormal Recovery, crash tests, multi-Session preservation, and performance gates are all represented.

- [ ] **Step 2: Update status using measured evidence**

Change the design status from `待实施` only if its correctness and performance gates actually pass. Mark completed plan checkboxes and
leave any failed production gate visibly unchecked with its measured result.

- [ ] **Step 3: Verify the final diff**

Run:

```bash
git status --short
git diff --check
git log --oneline -10
```

Expected: only known pre-existing unrelated worktree changes remain; all fast-path work is committed in focused commits.

- [ ] **Step 4: Commit final documentation state**

```bash
git add -f docs/superpowers/specs/2026-08-29-agent-rewind-apply-fast-path-design.md docs/superpowers/plans/2026-08-29-agent-rewind-apply-fast-path.md
git commit -m "docs: record rewind apply fast path results"
```
