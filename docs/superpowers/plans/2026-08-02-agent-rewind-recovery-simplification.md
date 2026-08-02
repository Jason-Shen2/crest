# Agent Rewind Recovery Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有五阶段 Recovery Journal 改成单一 `pending.json` + SQLite operation marker 提交点，同时保留多 Session、磁盘冲突、文件中间产物和崩溃恢复安全边界。

**Architecture:** 每个物理 Workspace 只有一份 phase-free pending record。Restore Executor 在 Workspace lock 内发布 pending、应用并验证文件、追加 exact Session marker、删除 pending；任何 pending 发布后的错误都交给同一个 Resolver 根据 marker、实时路径和 snapshot 分类。Main process 不再缓存 frozen/busy 状态，只在统一锁顺序下查询或解决 pending。

**Tech Stack:** TypeScript、Node.js filesystem/SQLite、Vitest、Electron IPC、React（仅 API 类型和现有 Recovery UI 接线调整）

---

## 文件结构与职责

```text
packages/coding-agent/workspace-rewind/
  pending-restore-store.ts          # 单一 pending.json 的严格 schema、持久化、audit
  pending-restore-store.test.ts     # schema、拒绝覆盖、progress、corrupt/audit 测试
  workspace-recovery.ts             # 唯一 classifier 与 Resolver；无 frozen cache
  workspace-recovery.test.ts        # committed / not-committed / needs-user 与锁顺序
  workspace-restore-executor.ts     # 正常 restore 事务；marker 是唯一提交点
  workspace-restore-executor.test.ts
  snapshot-retention.ts             # pending 作为 safety snapshot owner
  snapshot-retention.test.ts
  restore-crash.test.ts             # phase-free crash matrix
  fixtures/restore-crash-worker.ts
  recovery-journal.ts               # 删除
  recovery-journal.test.ts          # 删除

emain/
  agent-workspace-recovery-gate.ts  # 无缓存的 startup/write/query/resolve gate
  agent-workspace-recovery-gate.test.ts
  agent-ipc.ts                       # production Resolver wiring 与所有 mutation 入口 gate
  agent-ipc.test.ts

frontend/types/custom.d.ts          # Recovery view 删除 phase
frontend/app/agent/rewind/
  recovery-dialog.tsx               # 保持现有 UI，仅适配 phase-free view
  recovery-dialog.test.tsx
```

## Task 1: 建立单一 Pending Restore Store 与 snapshot ownership

**Files:**

- Create: `packages/coding-agent/workspace-rewind/pending-restore-store.ts`
- Create: `packages/coding-agent/workspace-rewind/pending-restore-store.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-retention.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-retention.test.ts`

- [ ] **Step 1: 写 strict schema 与单 pending 失败测试**

在 `pending-restore-store.test.ts` 先写测试，定义期望 API：

```ts
const pending = makePending({ operationId: "op-a" });
await store.publishLocked(pending);
await expect(store.publishLocked(makePending({ operationId: "op-b" }))).rejects.toThrow(
    /pending workspace restore already exists/i
);
expect(await store.readCandidate()).toEqual(pending);
```

覆盖：

- record 没有 `phase`、`resultSnapshot`、fingerprint 或未知字段；
- `sessionPath` 必须为绝对路径，path/forcedPaths 使用 canonical byte order 且不重复；
- `before`/`target` 不能是 `excluded`，workspace/snapshot identity 必须一致；
- 固定位置只允许一份 `pending.json`，第二次 publish 拒绝覆盖；
- truncated/corrupt bytes 返回 corrupt candidate，不被静默删除；
- `updateCreatedParentDirectoriesLocked()` 只能更新同一个 operation/path，目录必须 canonical、有序、不重复；
- Keep current 与 Quarantine 原子移动到 resolved audit，不再阻塞 active pending。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/pending-restore-store.test.ts
```

Expected: FAIL，因为 `pending-restore-store.ts` 尚不存在。

- [ ] **Step 3: 实现 phase-free schema 与 durable store**

实现以下公开类型；不要增加任何状态枚举：

```ts
export interface PendingWorkspaceRestorePathV1 {
    path: string;
    before: CapturedPathStateV1;
    target: CapturedPathStateV1;
    createdParentDirectories: string[];
}

export interface PendingWorkspaceRestoreV1 {
    schemaVersion: 1;
    operationId: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    sessionId: string;
    sessionPath: string;
    target: RestoreTargetV1;
    commitParentId: string | null;
    applyMode: "normal" | "force-drift";
    forcedPaths: string[];
    expectedSemanticLeafId: string | null;
    workspaceStateEntryId: string;
    safetySnapshot: WorkspaceSnapshotRefV1;
    paths: PendingWorkspaceRestorePathV1[];
}

export type ScannedPendingWorkspaceRestore =
    | { kind: "none" }
    | { kind: "valid"; record: PendingWorkspaceRestoreV1 }
    | { kind: "corrupt"; operationId: string; message: string; bytes: Buffer };
```

Store 固定使用 `repo.git/journal/restore/pending.json`，提供：

```ts
export class PendingWorkspaceRestoreStore {
    readCandidate(): Promise<ScannedPendingWorkspaceRestore>;
    readLocked(): Promise<ScannedPendingWorkspaceRestore>;
    publishLocked(record: PendingWorkspaceRestoreV1): Promise<void>;
    updateCreatedParentDirectoriesLocked(
        operationId: string,
        path: string,
        directories: readonly string[]
    ): Promise<PendingWorkspaceRestoreV1>;
    removeLocked(operationId: string): Promise<void>;
    resolveToAuditLocked(operationId: string, disposition: "keep-current" | "quarantine"): Promise<void>;
}
```

`publishLocked()` 必须先 verify/anchor `safetySnapshot`，再用拒绝覆盖的 durable atomic publication；更新 progress 仍只重写同一份 pending，不写 phase 文件。Audit 只用于诊断和保留原始 bytes，不参与恢复判定。

- [ ] **Step 4: 运行 pending store tests 并确认 GREEN**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/pending-restore-store.test.ts
```

Expected: PASS。

- [ ] **Step 5: 写 pending retention owner 失败测试**

在 `snapshot-retention.test.ts` 新增真实 store 测试：发布 pending 后移除普通 snapshot owner ref，执行 aggressive reconciliation/GC，断言 `safetySnapshot` 仍可 verify；将 pending 移到 audit 后推进七天 grace，断言它可被普通 orphan cleanup 回收。

- [ ] **Step 6: 运行 retention 测试并确认 RED**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/snapshot-retention.test.ts -t "retains the active restore pending safety snapshot"
```

Expected: FAIL，因为 retention 尚未扫描 active restore pending。

- [ ] **Step 7: 将 active pending 加入 owner scan**

`snapshot-retention.ts` 只读取 active `pending.json`：valid record 将 `safetySnapshot` 加入 owners；corrupt/无法读取时 fail closed，不执行删除或 GC；resolved audit 不作为 owner。保留现有 checkpoint、turn boundary 与 Session marker owner 行为。

- [ ] **Step 8: 运行 Task 1 tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/pending-restore-store.test.ts packages/coding-agent/workspace-rewind/snapshot-retention.test.ts
```

Expected: PASS。

- [ ] **Step 9: 提交 Task 1**

```bash
git add packages/coding-agent/workspace-rewind/pending-restore-store.ts packages/coding-agent/workspace-rewind/pending-restore-store.test.ts packages/coding-agent/workspace-rewind/snapshot-retention.ts packages/coding-agent/workspace-rewind/snapshot-retention.test.ts
git commit -m "feat(agent): add phase-free restore pending store"
```

## Task 2: 原子切换 Executor 与 Resolver 到两态 pending 协议

**Files:**

- Modify: `packages/coding-agent/workspace-rewind/workspace-restore-executor.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts`
- Rewrite: `packages/coding-agent/workspace-rewind/workspace-recovery.ts`
- Rewrite: `packages/coding-agent/workspace-rewind/workspace-recovery.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.test.ts`

- [ ] **Step 1: 写 Resolver 三态与 exact marker 失败测试**

在 `workspace-recovery.test.ts` 用 phase-free pending fixture 覆盖：

```ts
expect(await resolver.inspectPending()).toMatchObject({ state: "committed" });
expect(await resolver.inspectPending()).toMatchObject({ state: "not-committed" });
expect(await resolver.inspectPending()).toMatchObject({ state: "needs-user" });
```

具体断言：

- exact marker 必须是当前 leaf，且 entry ID/custom type/parent、operation、Session、Workspace、target、applyMode、forcedPaths、current states 全匹配；
- rewind marker 的 redo snapshot/states 必须等于 pending safety/before；
- marker current snapshot 必须存在、可 verify，且读取出的 path state 全部等于 target；
- marker entry 缺失且 leaf 等于 `expectedSemanticLeafId` 才允许 not-committed；
- marker entry 存在但 payload 错、leaf 改变或任一 live path 为 unknown 时只能 needs-user；
- 所有路径先完整分类，再执行任何 rollback write。

- [ ] **Step 2: 写 artifact、parent progress 与 missing Session 失败测试**

覆盖：

- classify 前调用 `reconcileInterruptedCapturedPathArtifacts()`；
- rollback 只对 live target 执行 `target -> before`；
- rollback 使用并持久化 `createdParentDirectories`，最后只清理仍为空的记录目录；
- owning Session 缺失时不自动写 Workspace，仅允许显式 Keep current；
- corrupt pending 只允许 Quarantine；
- public Resolver 顺序为 candidate read → Session lease → Workspace lock → authoritative reread；locked helper 不重复拿锁；
- request 的 operationId 在 Workspace lock 内重读不一致时拒绝。

- [ ] **Step 3: 运行 Resolver tests 并确认 RED**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-recovery.test.ts
```

Expected: FAIL，现有实现仍依赖 phase 和 frozen cache。

- [ ] **Step 4: 实现唯一 classifier 与无状态 Resolver**

保留文件名 `workspace-recovery.ts`，但删除 `frozen`、`operationTails`、phase branching、publish/repair callback。公开决策：

```ts
export type WorkspaceRecoveryDecision =
    | { state: "none" }
    | { state: "committed"; operationId: string }
    | { state: "not-committed"; operationId: string }
    | { state: "needs-user"; view: WorkspaceRecoveryView };
```

实现：

```ts
inspectPending(): Promise<WorkspaceRecoveryDecision>;
resolvePending(expectedOperationId?: string): Promise<WorkspaceRecoveryDecision>;
resolvePendingLocked(record: PendingWorkspaceRestoreV1): Promise<WorkspaceRecoveryDecision>;
keepCurrent(operationId: string, assertCurrent?: () => Promise<void>): Promise<void>;
quarantine(operationId: string, assertCurrent?: () => Promise<void>): Promise<void>;
assertWorkspaceWritable(): Promise<void>;
```

`resolvePendingLocked()` 的唯一规则：exact marker + all target → verify/cleanup committed；marker absent + old leaf + all before/target → rollback/verify/cleanup not-committed；其他任何情况 → needs-user。它不移动 Session leaf，不存在 Recovery Force。

- [ ] **Step 5: 写 Executor phase-free transaction 失败测试**

在 `workspace-restore-executor.test.ts` 对四种 target 断言顺序：

```text
assert current
capture safety
publish pending
apply paths + durable parent progress
capture/verify result
append SQLite marker CAS
verify exact marker + live targets
remove pending
release Workspace lock
best-effort renderer refresh
```

再覆盖 pending 发布后分别在 apply、result capture、SQLite CAS 抛错：Executor 必须调用同一个 locked Resolver；Resolver 判为 committed 时返回成功，判为 not-committed 时抛原错误，needs-user 时抛 Recovery required。pending 发布前失败不得调用 Resolver。

- [ ] **Step 6: 运行 Executor tests 并确认 RED**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts
```

Expected: FAIL，现有 Executor 仍写五个 phase。

- [ ] **Step 7: 实现 phase-free Executor 与 marker builder**

将 marker builder 改为显式输入：

```ts
export function workspaceStateFromPending(
    pending: PendingWorkspaceRestoreV1,
    resultSnapshot: WorkspaceSnapshotRefV1
): WorkspaceStateV1;
```

`WorkspaceRestoreExecutor` 依赖 `PendingWorkspaceRestoreStore` 和新的 Resolver，不再依赖 `WorkspaceRecoveryJournal`。在 `executeLocked()` 中只发布/更新/删除一份 pending；结果 snapshot 不写回 pending，marker 自身持久化它。`execute()` 在 Workspace lock 释放后执行 best-effort `onCommitted`，callback 失败只记录，不改变事务结果。

- [ ] **Step 8: 让 Rewind Engine 复用同一 Store/Resolver 实例**

`rewind-engine.ts` 构造一个 pending store 与一个 Resolver，conversation Revert/Redo 和 turn Undo/Redo 的所有 Executor 都使用它们；planner、confirmation、drift 与 Session result 语义保持不变。

- [ ] **Step 9: 运行 Task 2 tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/pending-restore-store.test.ts packages/coding-agent/workspace-rewind/workspace-recovery.test.ts packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts
```

Expected: PASS。

- [ ] **Step 10: 提交 Task 2**

```bash
git add packages/coding-agent/workspace-rewind/pending-restore-store.ts packages/coding-agent/workspace-rewind/workspace-recovery.ts packages/coding-agent/workspace-rewind/workspace-recovery.test.ts packages/coding-agent/workspace-rewind/workspace-restore-executor.ts packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts packages/coding-agent/workspace-rewind/rewind-engine.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts
git commit -m "refactor(agent): use one restore pending and commit marker"
```

## Task 3: 删除 frozen gate，统一 startup、write 与 UI Recovery 查询

**Files:**

- Modify: `emain/agent-workspace-recovery-gate.ts`
- Modify: `emain/agent-workspace-recovery-gate.test.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/api-types.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `frontend/app/agent/rewind/recovery-dialog.tsx`
- Modify: `frontend/app/agent/rewind/recovery-dialog.test.tsx`

- [ ] **Step 1: 写无缓存 Gate 与锁等待失败测试**

在 `agent-workspace-recovery-gate.test.ts` 断言：

- Gate 不暴露 `getFrozenDiagnostic`、`clearFrozenDiagnostic`、`ignoreCompletedOperationId`；
- startup、write gate、Recovery query、resolve action 都委托同一 Resolver；
- 普通 Restore 持有 Workspace lock 时，Recovery query 等待，释放后重读为 no pending，不抛 `AgentSessionMutationActiveError`；
- auto-resolvable pending 被 backend 解决，Renderer 只收到 none 或 needs-user；
- `operationId` 过期请求不能影响后来发布的新 pending。

- [ ] **Step 2: 写 owning Session leaf gate 失败测试**

在 `agent-ipc.test.ts` 覆盖 pending 存在时：

```text
send / regenerate
compact
navigate-tree
fork-session
clone-session
所有 writable tool/runtime entrypoints
```

断言 gate 在调用方 Session lease 之前执行。Marker 已提交但 pending 删除失败时，下一次 leaf mutation 先完成 pending cleanup；其他 Session 的纯会话读取不被阻止。

- [ ] **Step 3: 运行 Gate/IPC tests 并确认 RED**

Run:

```bash
npx vitest run emain/agent-workspace-recovery-gate.test.ts emain/agent-ipc.test.ts
```

Expected: FAIL，现有 main process 仍有 frozen Map 与 mutation-active 快速失败。

- [ ] **Step 4: 简化 Gate interface 与 production wiring**

Gate 只保留：

```ts
export interface AgentWorkspaceRecoveryGate {
    scanBeforeIpcRegistration(): Promise<void>;
    assertWorkspaceWritable(workspace: CanonicalWorkspaceIdentity): Promise<void>;
    getRecovery(workspace: CanonicalWorkspaceIdentity): Promise<AgentWorkspaceRecoveryView | undefined>;
    resolveRecovery(
        workspace: CanonicalWorkspaceIdentity,
        operationId: string,
        action: AgentWorkspaceRecoveryAction,
        assertCurrent: () => Promise<void>
    ): Promise<void>;
}
```

删除 `recovered Set`、`recovering Map`、`frozen Map`、process-scan mirror、completed ignore 与 clear callback。允许缓存无状态 Resolver 实例，但不得缓存 Recovery decision。Startup 扫描每个 workspace 的固定 pending；query 等待统一 Workspace lock 后 authoritative reread。

- [ ] **Step 5: 接好 IPC 和所有 mutation gate**

`agent:get-workspace-recovery` 调 `getRecovery()`；`agent:resolve-workspace-recovery` 携带 `operationId` 调 `resolveRecovery()`。所有 leaf mutation 和 Workspace write 在获取 caller Session lease 之前调用 gate。Read/list/inspect/export 保持可用。

- [ ] **Step 6: 删除 API 的 phase 字段并适配现有 UI**

从 `AgentWorkspaceRecoveryView`、`WorkspaceRecoveryView` 和 renderer 类型中删除 `phase`。Recovery dialog 保留 Retry、Keep current、Quarantine 语义，不增加 busy/frozen UI；coverage/ignored/checkpoint warnings 仍不显示在 Recovery header。

- [ ] **Step 7: 运行 Task 3 tests**

Run:

```bash
npx vitest run emain/agent-workspace-recovery-gate.test.ts emain/agent-ipc.test.ts packages/coding-agent/agent-session-runtime.test.ts frontend/app/agent/rewind/recovery-dialog.test.tsx frontend/app/agent/agent-runtime-client.test.ts
```

Expected: PASS。

- [ ] **Step 8: 提交 Task 3**

```bash
git add emain/agent-workspace-recovery-gate.ts emain/agent-workspace-recovery-gate.test.ts emain/agent-ipc.ts emain/agent-ipc.test.ts packages/coding-agent/workspace-rewind/api-types.ts frontend/types/custom.d.ts frontend/app/agent/rewind/recovery-dialog.tsx frontend/app/agent/rewind/recovery-dialog.test.tsx
git commit -m "refactor(agent): derive recovery state from pending"
```

## Task 4: 用 phase-free crash matrix 替换旧 Journal 与兼容代码

**Files:**

- Modify: `packages/coding-agent/workspace-rewind/fixtures/restore-crash-worker.ts`
- Rewrite: `packages/coding-agent/workspace-rewind/restore-crash.test.ts`
- Delete: `packages/coding-agent/workspace-rewind/recovery-journal.ts`
- Delete: `packages/coding-agent/workspace-rewind/recovery-journal.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/pending-boundary-store.ts`
- Modify: `packages/coding-agent/workspace-rewind/pending-boundary-store.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-retention.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-retention.test.ts`

- [ ] **Step 1: 将 crash fixture 改成真实 pending 边界**

边界只保留：

```ts
type RestoreCrashBoundary =
    | "before-pending-publish"
    | "after-pending-publish"
    | `path-replace-before-${number}`
    | `path-replace-after-${number}`
    | "before-result-snapshot"
    | "after-result-snapshot"
    | "sqlite-marker-before"
    | "sqlite-marker-after"
    | "pending-remove-before"
    | "pending-remove-after";
```

Worker 使用 production pending store、Resolver、Executor 和 SQLite marker，不自行模拟 phase。

- [ ] **Step 2: 写 crash matrix 失败测试**

逐边界 SIGKILL 后重启并断言：pending 发布前无变化；marker 前恢复 before；marker 后保留 target 并清理 pending；unknown 外部写不覆盖；rename/install artifact 被 reconciliation；created parent progress 可重复恢复；turn undo/redo 与 conversation rewind/redo 结果一致。

- [ ] **Step 3: 运行 crash tests 并确认 RED**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/restore-crash.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL，fixture 尚未切到新边界。

- [ ] **Step 4: 删除五阶段 journal 与 operation owner plumbing**

删除 `recovery-journal.ts` 及其测试、phase migration、operation journal owners、`refs/crest/ops/*` 和与它们专用的 snapshot-store API。保留 turn-boundary pending store；不要误删 checkpoint/snapshot 数据。Startup 遇到旧 `journal/restores/*.json` 时，将原始 bytes 移入 `journal/restore/resolved/legacy-<sha256>.json` 并记录一次明确的 incompatible warning；不按新协议解码，也不让旧开发数据阻塞 Workspace。

- [ ] **Step 5: 运行 Task 4 tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/restore-crash.test.ts packages/coding-agent/workspace-rewind/pending-restore-store.test.ts packages/coding-agent/workspace-rewind/pending-boundary-store.test.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts packages/coding-agent/workspace-rewind/snapshot-retention.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: PASS。

- [ ] **Step 6: 检查旧机制引用为零**

Run:

```bash
rg -n "WorkspaceOperationPhase|prepared|applying_files|files_verified|committing_session|ignoreCompletedOperationId|WorkspaceRecovery\.frozen|refs/crest/ops" packages/coding-agent/workspace-rewind emain frontend/app/agent/rewind
```

Expected: 不再命中 Recovery phase/frozen/operation refs；业务文案或历史设计文档不在本命令范围。

- [ ] **Step 7: 提交 Task 4**

```bash
git add -A packages/coding-agent/workspace-rewind
git commit -m "test(agent): replace phase recovery crash matrix"
```

## Task 5: 多 Session、并发 writer 与全链路验证

**Files:**

- Modify: `packages/coding-agent/workspace-rewind/multi-session.integration.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `docs/superpowers/specs/2026-08-02-agent-rewind-recovery-simplification-design.md`

- [ ] **Step 1: 写并发安全失败测试**

新增：

- Session A pending 时，Session B 在 A 的目标路径写入 unknown bytes，A 不覆盖并进入 needs-user；
- Session B 只修改非目标路径时，A 的 Restore 不影响该路径；
- 已运行 PTY/external writer 在最终 verify 前写入，Executor 不声称全局冻结，CAS/verify 阻止静默成功；
- marker commit + pending cleanup failure 后，下一次 owning Session leaf mutation 先清理 pending；
- owning Session 缺失时显式 Keep current 只移走 pending，不改文件或 Session；
- startup、write gate、UI query、Restore failure path 都遵守 Session lease → Workspace lock。

- [ ] **Step 2: 运行新增 tests 并确认 RED**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/multi-session.integration.test.ts packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts emain/agent-ipc.test.ts
```

Expected: 至少新增的并发用例在实现补齐前 FAIL。

- [ ] **Step 3: 只补齐测试暴露的 gate/CAS 缺口**

不得增加全 Turn Workspace lock、pending digest、新 phase、第二套 status DB 或 marker ancestor 判定。需要修复时只允许调整统一 gate、operationId guard、expected-current CAS、final target verify 或现有 artifact reconciliation。

- [ ] **Step 4: 更新设计稿实施状态**

将设计稿状态改为“已实施”，记录最终文件名和测试命令；若实现与设计存在差异，只记录已评审的必要差异，不追加新机制。

- [ ] **Step 5: 运行定向完整验证**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind emain/agent-workspace-recovery-gate.test.ts emain/agent-ipc.test.ts packages/coding-agent/agent-session-runtime.test.ts frontend/app/agent/rewind/recovery-dialog.test.tsx --maxWorkers=1 --no-file-parallelism
```

Expected: PASS；若 `anchored-reader` 的既有 64 MiB 竞态用例单次 flaky，必须单独重跑并在交付说明中如实记录，不能修改其断言掩盖失败。

- [ ] **Step 6: 运行 build/type verification**

Run:

```bash
npm run build:dev
git diff --check
```

Expected: build 成功，diff check 无输出。

- [ ] **Step 7: 提交 Task 5**

```bash
git add packages/coding-agent/workspace-rewind/multi-session.integration.test.ts packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts emain/agent-ipc.test.ts docs/superpowers/specs/2026-08-02-agent-rewind-recovery-simplification-design.md
git commit -m "test(agent): verify simplified recovery concurrency"
```

## 最终验收

- [ ] 一个物理 Workspace 只有一个 active `pending.json`；
- [ ] 正常路径与 Recovery 不再出现 phase transition；
- [ ] exact Session marker 是唯一提交点；
- [ ] pending 发布后的所有错误使用同一 classifier；
- [ ] pending 保活 safety snapshot，marker 保活 committed snapshots；
- [ ] unknown live path 永不被自动覆盖；
- [ ] owning Session leaf mutation 在 pending 清理前被 gate；
- [ ] 其他 Session 非目标路径与对话树不被 A 的回退修改；
- [ ] main process 不缓存 frozen/busy Recovery state；
- [ ] UI 只显示 authoritative needs-user，不显示普通 Restore 进行中；
- [ ] 旧五阶段 journal、phase tests 与 operation refs 已删除；
- [ ] 定向测试、build 与 diff check 通过。
