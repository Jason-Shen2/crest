# Agent Turn 文件改动卡与独立 Undo/Redo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在每个具有有效 workspace checkpoint 的已完成 user turn 下方展示精确文件改动卡，并提供历史 Review、单文件历史 diff tab、只撤销该 turn 文件且保留对话的 Undo，以及与之配对的 Redo。

**Architecture:** checkpoint 的 `before`、`after` 和 `changes` 仍是唯一权威数据源。只读展示由新的 immutable diff projector 从 snapshot blob 派生；文件 mutation 由从 `WorkspaceRewindEngine` 提取的共享 `WorkspaceRestoreExecutor` 执行，conversation Revert/Redo 与 turn Undo/Redo 只保留各自 planner 和 session commit 语义。renderer 使用纯展示 `DiffReviewDialog`，卡片、Review、Undo/Redo 和历史 diff tab 通过语义分离的 IPC 接口接线。

**Tech Stack:** TypeScript, Node.js filesystem/Git object store, Electron IPC/preload, SQLite append-only Session tree, React 19, assistant-ui, Tailwind CSS v4, shadcn Dialog/Button, `diff`, `@pierre/diffs`, Monaco, Vitest, Testing Library

---

## 实施约束

- 设计依据：
  - `docs/superpowers/specs/2026-07-28-agent-workspace-rewind-design.md`
  - `docs/superpowers/specs/2026-08-01-agent-rewind-diff-preview-design.md`
  - `docs/superpowers/specs/2026-08-02-agent-turn-file-changes-design.md`
- 不读取 `write`、`edit`、`changeOutline`、`ChangeOperation` 或当前 Git diff 来决定 turn 修改内容。
- 不兼容缺失 checkpoint 的历史 Session：不补数据、不显示 disabled 卡片、不退化到 Git diff。
- Turn Undo/Redo 不调用 `moveTo()`，不修改、删除或移动任何可见 message，也不恢复 composer。
- 只恢复 checkpoint `changes` 中的 canonical path；禁止 workspace-wide checkout/reset/clean。
- 普通 Undo 遇到同路径 drift 必须拒绝；只有 preview 中精确标红的 regular-file path 可 Force。
- Turn Redo 遇到任何 drift 都是 hard blocker，不提供 Force。
- conversation Revert/Redo 与 turn Undo/Redo 复用 snapshot、live inspection、confirmation token、workspace lock、safety snapshot、journal、filesystem apply 和 post-apply verify。
- `DiffReviewDialog` 只渲染 props，不调用 IPC、不读取 Session、不签发 confirmation token。
- 卡片 UI 以已确认的 v5 mockup 为准：紧凑 header、`bg-muted/40` 图标底色、`text-success`/`text-destructive` 统计色、文件行 `hover:bg-muted/40`，不得使用蓝色 accent hover。
- 卡片同一时刻只显示一个状态动作：Undo 后只显示 Redo，Redo 后只显示 Undo。
- 所有新增交互元素保留 keyboard focus、ARIA label 和 `cursor-pointer`。

## 目标文件结构

```text
packages/coding-agent/workspace-rewind/
  diff-preview.ts                         # snapshot state -> immutable display diff/stat
  diff-preview.test.ts
  turn-restore-plan.ts                    # 单 turn Undo/Redo planner
  turn-restore-plan.test.ts
  workspace-restore-executor.ts           # 四种 restore 操作共享的安全 apply 协议
  workspace-restore-executor.test.ts
  api-types.ts                            # 只读 Review 与 turn mutation API
  types.ts                                # turn-undo/turn-redo durable marker
  validation.ts
  session-state.ts                        # active branch 上 per-turn action fold
  confirmation-token.ts
  recovery-journal.ts
  workspace-recovery.ts
  rewind-engine.ts                        # facade + preview enrichment

emain/
  agent-rewind-service.ts                 # Session/workspace mutation lease coordinator
  agent-ipc.ts                            # 七个新增 IPC handler 与 authorization
  preload.ts

frontend/app/agent/rewind/
  diff-review-dialog.tsx                  # 纯双栏展示组件
  diff-review-dialog.test.tsx
  turn-file-changes-card.tsx              # 已确认 v5 卡片
  turn-file-changes-card.test.tsx
  turn-changes-context.tsx                # assistant message footer 接入点
  use-agent-turn-changes.ts               # summary cache、review、undo/redo controller
  use-agent-turn-changes.test.tsx

frontend/app/workspace/
  agent-turn-diff-top-tab.tsx              # immutable checkpoint diff tab
  agent-turn-diff-top-tab.test.tsx
```

现有 `rewind-preview-dialog.tsx` 在 Task 6 完成迁移后删除；`RewindPreviewDialog` 不再作为第二套审阅 UI 保留。

### Task 1: 建立 immutable snapshot diff projector

**Files:**
- Create: `packages/coding-agent/workspace-rewind/diff-preview.ts`
- Create: `packages/coding-agent/workspace-rewind/diff-preview.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/api-types.ts`
- Test: `packages/coding-agent/workspace-rewind/rewind-engine.test.ts`

- [ ] **Step 1: 写失败测试，锁定正向/反向 diff 和展示预算**

覆盖：

- `file -> file`、`absent -> file`、`file -> absent` 的 operation、patch、additions、deletions；
- Review 使用 `before -> after`，Revert/Undo 使用 `after -> before`，Redo 使用 `before -> after`；
- UTF-8 文本按原始 blob 解码，不经过磁盘；
- binary、invalid UTF-8、symlink、excluded 返回 `previewUnavailableReason`；
- 单侧超过 1 MiB 或一次请求累计输入超过 8 MiB 时只省略展示，不改变 path 集合；
- 一个 blob 读取失败只影响对应 row。

核心测试 API：

```ts
const budget = new WorkspaceDiffPreviewBudget();
const row = await projectWorkspacePathDiff({
    path: "src/value.ts",
    before: stateFor("const value = 2;\n"),
    after: stateFor("const value = 1;\n"),
    readBlob,
    budget,
});

expect(row).toMatchObject({
    path: "src/value.ts",
    operation: "write",
    additions: 1,
    deletions: 1,
});
expect(row.diff).toContain("-const value = 2;");
expect(row.diff).toContain("+const value = 1;");
```

- [ ] **Step 2: 运行测试并确认因 projector 不存在而失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/diff-preview.test.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts
```

Expected: FAIL，报 `diff-preview` module 或导出不存在。

- [ ] **Step 3: 定义展示类型与预算 API**

在 `api-types.ts` 将 `AgentRewindFileRowView` 扩展为：

```ts
export interface AgentRewindFileRowView {
    path: string;
    operation: "create" | "write" | "delete";
    additions?: number;
    deletions?: number;
    diff?: string;
    previewUnavailableReason?: string;
    coverage: "covered" | "excluded" | "unavailable";
    conflict: AgentRewindConflictClass;
    reason?: string;
}

export interface AgentTurnFileDiffView {
    turnId: string;
    path: string;
    operation: "create" | "write" | "delete";
    additions: number;
    deletions: number;
    originalContent: string;
    modifiedContent: string;
    isBinary: boolean;
    fallbackPatch: string;
    truncated: boolean;
    previewUnavailableReason?: string;
}
```

在 `diff-preview.ts` 导出：

```ts
export const WorkspaceDiffPreviewLimits = {
    maxSideBytes: 1 * 1024 * 1024,
    maxRequestInputBytes: 8 * 1024 * 1024,
} as const;

export class WorkspaceDiffPreviewBudget {
    usedInputBytes = 0;

    reserve(beforeBytes: number, afterBytes: number): boolean;
}

export function projectWorkspacePathDiff(input: {
    path: string;
    before: CapturedPathStateV1;
    after: CapturedPathStateV1;
    readBlob(oid: string): Promise<Buffer>;
    budget: WorkspaceDiffPreviewBudget;
}): Promise<AgentRewindFileRowView & { originalContent?: string; modifiedContent?: string }>;
```

严格 UTF-8 使用 `new TextDecoder("utf-8", { fatal: true })`；包含 NUL 时按 binary 处理。patch 使用现有 `diff.createTwoFilesPatch()`，统计使用 `diffLines()`，不得通过解析最终 patch 猜测行数。

- [ ] **Step 4: 实现最小 projector 并让 focused tests 通过**

`absent` 映射为空字符串；只有 `absent`/普通 `file` 两侧可生成文本 diff。symlink 和 excluded 不读取为文本。单文件异常转为稳定 reason，不向上抛出阻断 mutation。

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/diff-preview.test.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/workspace-rewind/diff-preview.ts packages/coding-agent/workspace-rewind/diff-preview.test.ts packages/coding-agent/workspace-rewind/api-types.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts
git commit -m "feat(agent): project workspace checkpoint diffs"
```

### Task 2: 扩展 durable turn mutation marker 与 active-branch fold

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/types.ts`
- Modify: `packages/coding-agent/workspace-rewind/validation.ts`
- Modify: `packages/coding-agent/workspace-rewind/validation.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/session-state.ts`
- Modify: `packages/coding-agent/workspace-rewind/session-state.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/api-types.ts`

- [ ] **Step 1: 写失败测试，锁定 marker schema 和每个 turn 的独立状态**

覆盖：

- `turn-undo` 必须有 `sourceTurnId`；
- `turn-redo` 必须同时有 `sourceTurnId` 和 `undoOperationId`；
- conversation `rewind`/`redo` 不接受 turn-only 字段；
- unknown key、跨 Session marker、错误 operation reference 被拒绝；
- active branch 上每个 source turn 的最后一个 marker 决定 `undo`/`redo` action；
- 分支切换后不折叠 abandoned branch marker；
- 多个 turn 可同时处于 undone；
- 缺失/unavailable/零变化 checkpoint 不进入 renderer availability。

- [ ] **Step 2: 运行测试并确认因新 kind 不被 decoder 接受而失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/validation.test.ts packages/coding-agent/workspace-rewind/session-state.test.ts
```

Expected: FAIL，decoder 拒绝 `turn-undo`/`turn-redo`。

- [ ] **Step 3: 把 `WorkspaceStateV1` 改为严格 discriminated union**

保留公共 base 字段，并使用以下 union，避免可选字段组合产生无效状态：

```ts
interface WorkspaceStateBaseV1 {
    schemaVersion: 1;
    sessionId: string;
    operationId: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    applyMode: "normal" | "force-drift";
    forcedPaths: string[];
    currentSnapshot: WorkspaceSnapshotRefV1;
    currentStates: Array<{ path: string; state: CapturedPathStateV1 }>;
}

export type WorkspaceStateV1 = WorkspaceStateBaseV1 &
    (
        | { kind: "rewind"; rewind: WorkspaceRewindStateV1 }
        | { kind: "redo" }
        | { kind: "turn-undo"; sourceTurnId: string }
        | { kind: "turn-redo"; sourceTurnId: string; undoOperationId: string }
    );
```

`FoldedWorkspaceSessionState` 新增：

```ts
turnMutationsByTurnId: ReadonlyMap<
    string,
    { action: "undo" } | { action: "redo"; undoOperationId: string }
>;
```

`AgentRewindSessionStateView` 新增轻量 availability：

```ts
turnChanges: Array<{
    turnId: string;
    action: "undo" | "redo";
    undoOperationId?: string;
}>;
```

其中 action 表示当前可执行动作：尚未撤销或已 redo 的 turn 为 `undo`；最后 marker 为 `turn-undo` 的 turn 为 `redo`。

- [ ] **Step 4: 实现严格 decode/fold 与 snapshot 可读性过滤**

`buildAgentRewindSessionStateView()` 只发布：terminal available checkpoint、`changes.length > 0`、before/after snapshot 均通过 `verifySnapshot()` 的 turn。原有 `eligibleTurnIds` 和 conversation `redo` 行为保持不变。

- [ ] **Step 5: 运行 focused tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/validation.test.ts packages/coding-agent/workspace-rewind/session-state.test.ts emain/agent-session-state-broadcaster.test.ts
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/workspace-rewind/types.ts packages/coding-agent/workspace-rewind/validation.ts packages/coding-agent/workspace-rewind/validation.test.ts packages/coding-agent/workspace-rewind/session-state.ts packages/coding-agent/workspace-rewind/session-state.test.ts packages/coding-agent/workspace-rewind/api-types.ts
git commit -m "feat(agent): persist per-turn restore state"
```

### Task 3: 实现单 turn Undo/Redo planner 与 confirmation binding

**Files:**
- Create: `packages/coding-agent/workspace-rewind/turn-restore-plan.ts`
- Create: `packages/coding-agent/workspace-rewind/turn-restore-plan.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/restore-plan.ts`
- Modify: `packages/coding-agent/workspace-rewind/restore-plan.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/confirmation-token.ts`
- Modify: `packages/coding-agent/workspace-rewind/confirmation-token.test.ts`

- [ ] **Step 1: 写失败 planner tests**

覆盖：

- Undo 对一个 terminal available checkpoint 生成 `after -> before`；
- Redo 生成 `before -> after`；
- live 等于 expected 为 clean，live 等于 target 为 no-op，其余 regular file 为 forceable drift；
- forceable drift 的 reason 必须精确为 `files changed on disk since the agent last wrote them`；
- Undo Force 只允许 forceable drift；Redo 把任何 drift 升级为 hard blocker；
- origin Session、workspace identity/incarnation、active branch、terminal/unique checkpoint、snapshot readability、canonical path、coverage 全部验证；
- Redo 只接受该 source turn 最后 marker 指向的 `undoOperationId`；
- 两个 Session 不同 path 不进入彼此 plan，同 path 变化进入 drift。

核心断言：

```ts
const plan = await planTurnUndo(input);
expect(plan).toMatchObject({
    target: { kind: "turn-undo", sourceTurnId: "turn-a" },
    commitParentId: "semantic-leaf",
});
expect(plan.paths[0]).toMatchObject({
    path: "src/a.ts",
    expectedCurrent: checkpoint.changes[0].after,
    target: checkpoint.changes[0].before,
});
```

- [ ] **Step 2: 运行测试并确认 planner 不存在**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/turn-restore-plan.test.ts packages/coding-agent/workspace-rewind/confirmation-token.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 扩展 restore plan union 并复用分类函数**

`RestorePlanV1` 的 target 使用明确 union：

```ts
export type RestoreTargetV1 =
    | { kind: "rewind"; targetTurnId: string }
    | { kind: "redo" }
    | { kind: "turn-undo"; sourceTurnId: string }
    | { kind: "turn-redo"; sourceTurnId: string; undoOperationId: string };

export interface RestorePlanV1 {
    target: RestoreTargetV1;
    sessionId: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    semanticLeafId: string | null;
    commitParentId: string | null;
    paths: RestorePathPlanV1[];
    coverageWarnings: Array<{ path: string; reason: string }>;
    forceRequired: boolean;
    hardBlocked: boolean;
}
```

将现有 transition 分类提取为命名导出供两个 planner 复用；conversation planner 不改变路径语义。Turn planner API：

```ts
export function planTurnUndo(input: PlanTurnUndoInput): Promise<RestorePlanV1>;
export function planTurnRedo(input: PlanTurnRedoInput): Promise<RestorePlanV1>;
```

Turn mutation 的 `commitParentId` 始终等于当前 `semanticLeafId`；conversation Revert 仍使用 transaction fork boundary。

- [ ] **Step 4: 扩展 confirmation token 的 target binding**

binding 精确保存 `RestoreTargetV1`、semantic leaf、workspace identity/incarnation、排序后的 path、fingerprint 和 conflict。规则：

```ts
const forceAllowed = plan.target.kind === "rewind" || plan.target.kind === "turn-undo";
const redoLike = plan.target.kind === "redo" || plan.target.kind === "turn-redo";
```

`turn-redo` token 必须绑定 source turn 和原 `undoOperationId`；token 仍一次性、短时有效，diff 文本不进入 binding。

- [ ] **Step 5: 运行 planner、confirmation 和 conversation 回归**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/turn-restore-plan.test.ts packages/coding-agent/workspace-rewind/restore-plan.test.ts packages/coding-agent/workspace-rewind/confirmation-token.test.ts
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/workspace-rewind/turn-restore-plan.ts packages/coding-agent/workspace-rewind/turn-restore-plan.test.ts packages/coding-agent/workspace-rewind/restore-plan.ts packages/coding-agent/workspace-rewind/restore-plan.test.ts packages/coding-agent/workspace-rewind/confirmation-token.ts packages/coding-agent/workspace-rewind/confirmation-token.test.ts
git commit -m "feat(agent): plan per-turn workspace restores"
```

### Task 4: 提取共享 restore executor 并扩展 crash recovery

**Files:**
- Create: `packages/coding-agent/workspace-rewind/workspace-restore-executor.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/recovery-journal.ts`
- Modify: `packages/coding-agent/workspace-rewind/recovery-journal.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-recovery.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-recovery.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/fixtures/restore-crash-worker.ts`
- Modify: `packages/coding-agent/workspace-rewind/restore-crash.test.ts`

- [ ] **Step 1: 写失败 executor/recovery tests**

覆盖：

- 四种 target 共用 safety capture、workspace lock 内重算、journal phase、filesystem apply、post-apply verify；
- Turn Undo/Redo 的 state entry parent 是当前 semantic leaf，`displayLeafId` 不变；
- conversation Revert 仍提交到 fork boundary 并恢复 composer；
- zero-effective-path turn 操作不写文件，但仍以 CAS 追加 marker，使卡片状态切换；
- `turn-undo`/`turn-redo` 在 `prepared`、`applying_files`、`files_verified`、`committing_session` crash 后分别回滚、完成或 freeze；
- unknown third-party bytes 永不自动覆盖；
- recovery 完成的 marker kind/source/undo operation 精确一致。

- [ ] **Step 2: 运行测试并确认现有 engine 私有 apply 无法满足 turn commit**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts packages/coding-agent/workspace-rewind/workspace-recovery.test.ts packages/coding-agent/workspace-rewind/restore-crash.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 将 journal target 改为语义明确的 durable union**

`WorkspaceOperationJournalV1` 使用：

```ts
target: RestoreTargetV1;
commitParentId: string | null;
```

删除含义重叠的 `kind`、`targetTurnId`、`targetBoundaryId` 字段。decoder 使用 exact-key 校验；`applyMode: "force-drift"` 只允许 `rewind`/`turn-undo`，`turn-redo` 必须携带已绑定的 `undoOperationId`。

- [ ] **Step 4: 提取 `WorkspaceRestoreExecutor`**

公开边界固定为：

```ts
export interface WorkspaceRestoreCommitStrategy {
    makeWorkspaceState(record: WorkspaceOperationJournalV1): WorkspaceStateV1;
    makeResult(input: {
        entries: SessionTreeEntry[];
        folded: FoldedWorkspaceSessionState;
        sessionMetadata: JsonlSessionMetadata;
    }): WorkspaceRewindCommitResult;
}

export class WorkspaceRestoreExecutor {
    constructor(options: WorkspaceRestoreExecutorOptions);

    execute(input: {
        session: Session<JsonlSessionMetadata>;
        workspace: CanonicalWorkspaceIdentity;
        plan: RestorePlanV1;
        confirmation: ConfirmedRestorePlanV1;
        mode: "normal" | "force-drift";
        assertCurrent?: () => Promise<void>;
        commit: WorkspaceRestoreCommitStrategy;
    }): Promise<WorkspaceRewindCommitResult>;
}
```

Executor 不决定 conversation/turn 产品语义；它只按 `plan.commitParentId` append hidden state entry。`WorkspaceRewindEngine` 变成 planner + preview + commit strategy facade。

- [ ] **Step 5: 让 recovery 与 executor 共用 marker 构造函数**

新增纯函数 `workspaceStateFromJournal(record)`，executor 正常提交和 `WorkspaceRecovery.finishCommitted()` 必须调用同一函数。Turn marker：

```ts
if (record.target.kind === "turn-undo") {
    return { ...base, kind: "turn-undo", sourceTurnId: record.target.sourceTurnId };
}
if (record.target.kind === "turn-redo") {
    return {
        ...base,
        kind: "turn-redo",
        sourceTurnId: record.target.sourceTurnId,
        undoOperationId: record.target.undoOperationId,
    };
}
```

- [ ] **Step 6: 运行 executor、engine、journal、recovery、crash tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts packages/coding-agent/workspace-rewind/recovery-journal.test.ts packages/coding-agent/workspace-rewind/workspace-recovery.test.ts packages/coding-agent/workspace-rewind/restore-crash.test.ts
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/coding-agent/workspace-rewind/workspace-restore-executor.ts packages/coding-agent/workspace-rewind/workspace-restore-executor.test.ts packages/coding-agent/workspace-rewind/rewind-engine.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts packages/coding-agent/workspace-rewind/recovery-journal.ts packages/coding-agent/workspace-rewind/recovery-journal.test.ts packages/coding-agent/workspace-rewind/workspace-recovery.ts packages/coding-agent/workspace-rewind/workspace-recovery.test.ts packages/coding-agent/workspace-rewind/fixtures/restore-crash-worker.ts packages/coding-agent/workspace-rewind/restore-crash.test.ts
git commit -m "refactor(agent): share workspace restore executor"
```

### Task 5: 增加 turn summary/review/diff/undo/redo API 与 service

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/api-types.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.test.ts`
- Modify: `emain/agent-rewind-service.ts`
- Modify: `emain/agent-rewind-service.test.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `emain/preload.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `frontend/preview/mock/preview-electron-api.ts`
- Modify: `frontend/app/agent/agent-runtime-client.ts`
- Modify: `frontend/app/agent/agent-runtime-client.test.ts`

- [ ] **Step 1: 写失败 API/service/IPC tests**

覆盖七个 endpoint：

```text
agent:get-turn-change-summary
agent:get-turn-file-diff
agent:review-turn-changes
agent:preview-turn-undo
agent:apply-turn-undo
agent:preview-turn-redo
agent:apply-turn-redo
```

验证：三个只读 endpoint 不签发 confirmation、不 inspect live disk；四个 mutation endpoint 经过 session mutation lease、workspace lock、workspace authorization、expected semantic leaf 与一次性 token；apply 后 broadcaster 发布权威 state。

- [ ] **Step 2: 运行 focused tests 并确认新 client methods 不存在**

Run:

```bash
npx vitest run emain/agent-rewind-service.test.ts emain/agent-ipc.test.ts frontend/app/agent/agent-runtime-client.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 定义精确 API contracts**

```ts
export interface AgentTurnTargetInput {
    sessionMetadata: JsonlSessionMetadata;
    expectedSemanticLeafId: string | null;
    turnId: string;
}

export interface AgentTurnChangeSummaryView {
    turnId: string;
    semanticLeafId: string | null;
    fileCount: number;
    additions: number;
    deletions: number;
    files: Array<{
        path: string;
        operation: "create" | "write" | "delete";
        additions: number;
        deletions: number;
    }>;
}

export interface AgentReviewTurnChangesResult {
    turnId: string;
    semanticLeafId: string | null;
    files: AgentRewindFileRowView[];
}

export interface AgentGetTurnFileDiffInput extends AgentTurnTargetInput {
    path: string;
}

export interface AgentPreviewTurnMutationInput extends AgentTurnTargetInput {
    undoOperationId?: string;
}

export interface AgentApplyTurnMutationInput extends AgentPreviewTurnMutationInput {
    mode: "normal" | "force-drift";
    confirmationToken: string;
}
```

`turn-redo` preview/apply 要求 `undoOperationId`；redo apply 拒绝 `force-drift`。只读 endpoint 的 `expectedSemanticLeafId` 用于 active-branch fencing，但不会签发 token。

- [ ] **Step 4: 为 conversation preview 和 turn review 连接 diff projector**

`WorkspaceRewindEngine.preview()` 的普通 restore plan 使用 `expectedCurrent -> target` enrichment；若存在
`forceable-drift`，则在 Workspace lease 内同步 live snapshot、重新规划，并展示实际会被覆盖的 `live -> target`。
Turn Review 使用 checkpoint `before -> after`；Turn Undo 使用 `after -> before`；Turn Redo 使用
`before -> after`。summary 只返回路径与统计，不返回 patch/blob 内容。

- [ ] **Step 5: 实现 service、authorization、IPC、preload 和 runtime client**

只读 operation 仍需 canonical Session/workspace 校验，但不进入 mutation confirmation registry。apply 继续从 registry `take()` token，并在 lock 内重算 planner。

- [ ] **Step 6: 运行 focused tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/diff-preview.test.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts emain/agent-rewind-service.test.ts emain/agent-ipc.test.ts frontend/app/agent/agent-runtime-client.test.ts
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/coding-agent/workspace-rewind/api-types.ts packages/coding-agent/workspace-rewind/rewind-engine.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts emain/agent-rewind-service.ts emain/agent-rewind-service.test.ts emain/agent-ipc.ts emain/agent-ipc.test.ts emain/preload.ts frontend/types/custom.d.ts frontend/preview/mock/preview-electron-api.ts frontend/app/agent/agent-runtime-client.ts frontend/app/agent/agent-runtime-client.test.ts
git commit -m "feat(agent): expose per-turn change APIs"
```

### Task 6: 用纯 `DiffReviewDialog` 替换现有 Rewind 预览 UI

**Files:**
- Create: `frontend/app/agent/rewind/diff-review-dialog.tsx`
- Create: `frontend/app/agent/rewind/diff-review-dialog.test.tsx`
- Delete: `frontend/app/agent/rewind/rewind-preview-dialog.tsx`
- Delete: `frontend/app/agent/rewind/rewind-preview-dialog.test.tsx`
- Modify: `frontend/app/agent/agent-content.tsx`
- Modify: `frontend/app/agent/agent-content.test.tsx`
- Reuse: `frontend/app/agent/assistant-ui/diff-viewer.tsx`
- Reuse: `frontend/app/fileexplorer/file-icon.ts`
- Reference: `frontend/app/codereview/git-panel.tsx`

- [ ] **Step 1: 写失败 renderer tests，锁定纯组件与双栏行为**

覆盖：

- 默认选择第一项；点击左侧文件只切换右侧，不发 IPC；
- 使用 `getFileIcon()`、basename、muted directory、A/M/D、`+A -D`；
- 右侧直接收到所选 row 的 backend patch；
- normal row 不显示 `covered`；
- conflict row 与 canonical warning 使用 destructive/red；
- forceable conflict 必须原样显示 `files changed on disk since the agent last wrote them`；
- unavailable preview 显示 reason，不伪造空 diff；
- empty files 显示 `No workspace files will change.`；
- footer 完全由 caller 提供；
- 不显示 target prompt、message count 或 Conversation 卡片。

- [ ] **Step 2: 运行测试并确认组件不存在**

Run:

```bash
npx vitest run frontend/app/agent/rewind/diff-review-dialog.test.tsx frontend/app/agent/rewind/rewind-preview-dialog.test.tsx frontend/app/agent/agent-content.test.tsx
```

Expected: FAIL。

- [ ] **Step 3: 实现纯展示 props**

```ts
export interface DiffReviewDialogProps {
    open: boolean;
    title: string;
    description: string;
    files: AgentRewindFileRowView[];
    selectedPath?: string;
    loading?: boolean;
    errorMessage?: string;
    warning?: string;
    locked?: boolean;
    emptyMessage?: string;
    footer: ReactNode;
    onSelectedPathChange(path: string): void;
    onOpenChange(open: boolean): void;
}
```

Dialog 使用大尺寸稳定布局：header/footer 固定，主体 `grid-cols-[minmax(220px,30%)_1fr]`，左栏和右栏分别滚动；窄屏改为纵向。不得在组件内读取 session、client 或 mutation state。

- [ ] **Step 4: 将 conversation Revert/Redo 映射为 `DiffReviewDialog` props**

标题：`Revert changes?` / `Redo changes?`。footer：

- clean Revert：Cancel + `Revert N files`；
- forceable：Cancel + destructive `Force revert`；
- hard blocker：仅 Cancel；
- Redo：Cancel + `Redo N files`，任何 drift 不显示 Force。

底部说明 `Red will be removed · Green will be restored`。删除旧组件和旧测试，迁移有效断言到新组件/AgentContent tests。

- [ ] **Step 5: 运行 renderer tests**

Run:

```bash
npx vitest run frontend/app/agent/rewind/diff-review-dialog.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/rewind/use-agent-rewind.test.tsx
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add frontend/app/agent/rewind/diff-review-dialog.tsx frontend/app/agent/rewind/diff-review-dialog.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/rewind/rewind-preview-dialog.tsx frontend/app/agent/rewind/rewind-preview-dialog.test.tsx
git commit -m "feat(agent): add shared diff review dialog"
```

### Task 7: 实现 v5 Turn 文件改动卡与 Review/Undo/Redo controller

**Files:**
- Create: `frontend/app/agent/rewind/turn-file-changes-card.tsx`
- Create: `frontend/app/agent/rewind/turn-file-changes-card.test.tsx`
- Create: `frontend/app/agent/rewind/turn-changes-context.tsx`
- Create: `frontend/app/agent/rewind/use-agent-turn-changes.ts`
- Create: `frontend/app/agent/rewind/use-agent-turn-changes.test.tsx`
- Modify: `frontend/app/agent/assistant-ui/registry-thread.tsx`
- Modify: `frontend/app/agent/assistant-ui/thread.integration.test.tsx`
- Modify: `frontend/app/agent/agent-content.tsx`
- Modify: `frontend/app/agent/agent-content.test.tsx`
- Modify: `frontend/app/store/use-pi-chat.ts`
- Modify: `frontend/app/store/use-pi-chat.test.tsx`

- [ ] **Step 1: 写失败卡片与 controller tests**

覆盖：

- 仅 done turn、available checkpoint、`changes.length > 0` 显示；
- missing/unavailable/零变化/streaming turn 不显示；
- summary 按 `sessionPath + semanticLeafId + turnId` cache，stale response 被丢弃；
- 卡片展示总文件数、总统计、逐文件路径与统计；
- Review 打开 forward `before -> after` dialog，footer 只有 Close；
- Undo/Redo 打开同一个 `DiffReviewDialog`，方向和 footer 正确；
- Undo authoritative ack 后仅该卡片切成 Redo；Redo 后切回 Undo；
- 多个 turn 卡片状态互不覆盖；
- running、session mutation busy、recovery frozen、apply awaiting ack 时操作 disabled；
- apply 失败保留 dialog 和错误。

- [ ] **Step 2: 运行测试并确认卡片/controller 不存在**

Run:

```bash
npx vitest run frontend/app/agent/rewind/turn-file-changes-card.test.tsx frontend/app/agent/rewind/use-agent-turn-changes.test.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx frontend/app/agent/agent-content.test.tsx
```

Expected: FAIL。

- [ ] **Step 3: 实现已确认 v5 卡片视觉**

结构和关键 Tailwind classes 固定为：

```tsx
<section className="overflow-hidden rounded-2xl border border-border bg-card">
    <header className="flex items-center justify-between gap-4 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted/40 text-muted-foreground">
                <FileDiffIcon className="size-5" />
            </div>
            <div className="min-w-0">
                <p className="font-medium">已编辑 {summary.fileCount} 个文件</p>
                <div className="flex gap-1.5 text-sm tabular-nums">
                    <span className="text-success">+{summary.additions}</span>
                    <span className="text-destructive">-{summary.deletions}</span>
                </div>
            </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
            {action === "undo" ? (
                <Button variant="ghost" size="sm" className="cursor-pointer" onClick={onUndo}>
                    撤销 <Undo2Icon />
                </Button>
            ) : (
                <Button variant="ghost" size="sm" className="cursor-pointer" onClick={onRedo}>
                    重做 <Redo2Icon />
                </Button>
            )}
            <Button variant="outline" size="sm" className="cursor-pointer" onClick={onReview}>
                审核
            </Button>
        </div>
    </header>
    <div className="border-t border-border py-0.5">
        {summary.files.map((file) => (
            <button
                key={file.path}
                className="flex w-full cursor-pointer items-center justify-between gap-4 px-4 py-3 text-left hover:bg-muted/40 focus-visible:bg-muted/40"
                onClick={() => onOpenFile(file.path)}
            >
                <span className="min-w-0 break-all">{file.path}</span>
                <span className="flex shrink-0 gap-1.5 tabular-nums">
                    <span className="text-success">+{file.additions}</span>
                    <span className="text-destructive">-{file.deletions}</span>
                </span>
            </button>
        ))}
    </div>
</section>
```

逐文件 additions 使用 `text-success`，deletions 使用 `text-destructive`；directory 使用 `text-muted-foreground`。不得使用 `bg-accent`、蓝色 hover、大号 header、同时出现 Undo/Redo，或重新加入 Conversation 区块。

- [ ] **Step 4: 用 context 把 turn metadata 接到 assistant message footer**

`TurnChangesContext` 提供 availability、summary、busy 和四个 callback。`AssistantMessage` 从现有 `metadata.custom.turnId` 读取 turnId，在 message content 后、action bar 前渲染卡片。不要从 tool parts 或 `changeOutline` 推导卡片。

- [ ] **Step 5: 实现 controller 的 request fencing 与 authoritative ack**

复用 `useAgentRewind` 的 session identity/epoch 模式，但状态保持独立：review 不占 mutation token；Undo/Redo 保存一次性 confirmation；apply 后等待 session-state 中对应 turn action 改变再释放 busy。切换 Session、revision 或 semantic leaf 时取消 stale request 并清空 cache/dialog。

- [ ] **Step 6: 运行卡片、hook、Thread 和 AgentContent tests**

Run:

```bash
npx vitest run frontend/app/agent/rewind/turn-file-changes-card.test.tsx frontend/app/agent/rewind/use-agent-turn-changes.test.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/store/use-pi-chat.test.tsx
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add frontend/app/agent/rewind/turn-file-changes-card.tsx frontend/app/agent/rewind/turn-file-changes-card.test.tsx frontend/app/agent/rewind/turn-changes-context.tsx frontend/app/agent/rewind/use-agent-turn-changes.ts frontend/app/agent/rewind/use-agent-turn-changes.test.tsx frontend/app/agent/assistant-ui/registry-thread.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx frontend/app/store/use-pi-chat.ts frontend/app/store/use-pi-chat.test.tsx
git commit -m "feat(agent): show per-turn file change cards"
```

### Task 8: 增加 immutable `agent-turn-diff` Top Tab

**Files:**
- Create: `frontend/app/workspace/agent-turn-diff-top-tab.tsx`
- Create: `frontend/app/workspace/agent-turn-diff-top-tab.test.tsx`
- Modify: `frontend/app/workspace/workspace-content-state.ts`
- Modify: `frontend/app/workspace/workspace-content-state.test.ts`
- Modify: `frontend/app/workspace/top-tab-controller.ts`
- Modify: `frontend/app/workspace/top-tab-controller.test.ts`
- Modify: `frontend/app/workspace/top-tab-runtime-host.tsx`
- Modify: `frontend/app/workspace/top-tab-runtime-host.test.tsx`
- Modify: `frontend/app/workspace/top-tab-content-deck.tsx`
- Modify: `frontend/app/workspace/top-tab-content-deck.test.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.test.tsx`
- Modify: `frontend/app/agent/agent-content.tsx`
- Modify: `frontend/app/agent/assistant-ui/registry-thread.tsx`

- [ ] **Step 1: 写失败 Top Tab tests**

覆盖：

- 点击卡片文件打开 `agent-turn-diff`，Dialog 内选文件不打开 tab；
- identity 由 canonical session path + turnId + checkpoint path 组成，同一项复用 tab；
- descriptor 可 round-trip workspace persistence；所有 persisted JSON field 使用 lowercase；
- reload 只调用 `getTurnFileDiff()`，不调用 Git API；
- snapshot missing/corrupt 显示明确错误和 Retry；
- binary/truncated 使用 fallback，不退化为当前 Git diff；
-文本使用现有 Monaco diff body。

- [ ] **Step 2: 运行测试并确认 `agent-turn-diff` kind 不存在**

Run:

```bash
npx vitest run frontend/app/workspace/agent-turn-diff-top-tab.test.tsx frontend/app/workspace/workspace-content-state.test.ts frontend/app/workspace/top-tab-controller.test.ts frontend/app/workspace/top-tab-runtime-host.test.tsx frontend/app/workspace/top-tab-content-deck.test.tsx
```

Expected: FAIL。

- [ ] **Step 3: 扩展 Top Tab descriptor 与 persistence**

运行时 descriptor：

```ts
type AgentTurnDiffTopTab = {
    id: string;
    kind: "agent-turn-diff";
    sessionId: string;
    sessionCreatedAt: string;
    sessionCwd: string;
    sessionPath: string;
    turnId: string;
    path: string;
    title: string;
};
```

persisted fields 固定为 `sessionid`、`sessioncreatedat`、`sessioncwd`、`sessionpath`、`turnid`、`path`。所有路径/session metadata 在 hydrate 时严格校验；不接受缺字段 descriptor。

- [ ] **Step 4: 接入 controller、runtime host 与 Agent card callback**

`WorkspaceTopTabController` 增加：

```ts
openAgentTurnDiff(input: {
    sessionMetadata: AgentSessionMeta;
    turnId: string;
    path: string;
}): string;
```

`WorkspaceMainContent` 将当前 workspace 的 `AgentRuntimeClient` 传给 `AgentTurnDiffTopTab`。`AgentContent` 新增 `onOpenTurnDiff(turnId, path)`，最终调用 top-tab controller；普通 `onOpenFile` 保持原语义。

- [ ] **Step 5: 实现历史 diff surface**

组件用 descriptor 重建 `AgentSessionMeta`，调用 `client.getTurnFileDiff()`；文本结果复用 `GitDiffBody` 或提取无 Git 语义的通用 Monaco body。错误文案使用 ``Failed to load turn diff: ${message}``，禁止调用 `GitGetDiffContentCommand`。

- [ ] **Step 6: 运行 Top Tab 与 Agent integration tests**

Run:

```bash
npx vitest run frontend/app/workspace/agent-turn-diff-top-tab.test.tsx frontend/app/workspace/workspace-content-state.test.ts frontend/app/workspace/top-tab-controller.test.ts frontend/app/workspace/top-tab-runtime-host.test.tsx frontend/app/workspace/top-tab-content-deck.test.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add frontend/app/workspace/agent-turn-diff-top-tab.tsx frontend/app/workspace/agent-turn-diff-top-tab.test.tsx frontend/app/workspace/workspace-content-state.ts frontend/app/workspace/workspace-content-state.test.ts frontend/app/workspace/top-tab-controller.ts frontend/app/workspace/top-tab-controller.test.ts frontend/app/workspace/top-tab-runtime-host.tsx frontend/app/workspace/top-tab-runtime-host.test.tsx frontend/app/workspace/top-tab-content-deck.tsx frontend/app/workspace/top-tab-content-deck.test.tsx frontend/app/workspace/workspace-main-content.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/assistant-ui/registry-thread.tsx
git commit -m "feat(agent): open immutable turn diff tabs"
```

### Task 9: 关闭组合语义、多 Session 与 E2E 门禁

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/multi-session.integration.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts`
- Modify: `emain/agent-rewind.e2e.test.ts`
- Modify: `.github/workflows/agent-tests.yml`
- Modify: `docs/agent-architecture.md`
- Modify: `docs/agent-runtime-architecture.md`

- [ ] **Step 1: 写跨层失败测试**

场景必须使用真实 snapshot store、Session SQLite、service/IPC 和 renderer 交互：

1. bash 或未来非 write/edit 路径修改文件后，turn 完成出现卡片；
2. Review 与历史 tab 均展示 checkpoint 的精确 forward diff；
3. Undo 恢复文件但 user/assistant messages、display leaf、composer 全部保持；
4. Undo 后卡片切 Redo，Redo 恢复文件并切回 Undo；
5. preview 后外部修改使普通确认 stale，不覆盖新内容；
6. Force 只覆盖 preview 精确标红 path；
7. 两 Session 修改不同 path，A Undo 不影响 B；
8. 两 Session 修改同 path，A 普通 Undo 被 drift 阻断；
9. `0 -> turn1 -> turn2 -> Undo turn2 -> conversation Revert` 得到正确字节；
10. crash recovery 对 turn marker 结果与正常路径一致；
11. 历史 missing checkpoint Session 不显示卡片。

- [ ] **Step 2: 运行集成测试并确认组合缺口会失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts packages/coding-agent/workspace-rewind/multi-session.integration.test.ts packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts emain/agent-rewind.e2e.test.ts
```

Expected: 新增用例至少一项 FAIL，证明测试覆盖真实缺口。

- [ ] **Step 3: 修复仅由跨层测试暴露的接线问题**

只修改与上述 11 个场景直接相关的 production code；每个 bug 保留最小回归测试。不得用放宽断言、mock checkpoint、mock filesystem apply 或改写测试语义使其通过。

- [ ] **Step 4: 更新架构文档与 CI focused gate**

文档明确区分：

- `/rewind`、`/redo`、消息 Revert：conversation + workspace；
- 卡片 Undo/Redo：single turn workspace only；
- `git-diff`：当前 Git 状态；
- `agent-turn-diff`：immutable checkpoint 历史状态。

CI 将新增 backend、renderer 和 E2E 文件加入现有 Agent gate，不创建依赖环境开关的测试分支。

- [ ] **Step 5: 运行完整验证**

Run:

```bash
npx prettier --check packages/coding-agent/workspace-rewind emain/agent-rewind-service.ts emain/agent-ipc.ts emain/preload.ts frontend/app/agent/rewind frontend/app/agent/agent-content.tsx frontend/app/agent/assistant-ui/registry-thread.tsx frontend/app/workspace docs/agent-architecture.md docs/agent-runtime-architecture.md
npx vitest run packages/coding-agent/workspace-rewind emain/agent-rewind-service.test.ts emain/agent-ipc.test.ts emain/agent-rewind.e2e.test.ts frontend/app/agent/agent-runtime-client.test.ts frontend/app/agent/rewind frontend/app/agent/agent-content.test.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx frontend/app/store/use-pi-chat.test.tsx frontend/app/workspace
git diff --check
```

Expected: 全部 exit 0，Vitest 0 failed，Prettier 与 `git diff --check` 无输出错误。

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts packages/coding-agent/workspace-rewind/multi-session.integration.test.ts packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts emain/agent-rewind.e2e.test.ts .github/workflows/agent-tests.yml docs/agent-architecture.md docs/agent-runtime-architecture.md
git commit -m "test(agent): close per-turn restore rollout gates"
```

## 最终验收清单

- [ ] Turn 卡片只来自 terminal available checkpoint，历史缺失 checkpoint 不显示。
- [ ] 卡片视觉与 v5 一致：顶部紧凑、图标淡灰、diff 数字绿/红、文件 hover 淡灰、Undo/Redo 单状态显示。
- [ ] Review、历史 tab 和卡片统计使用 immutable `before -> after`。
- [ ] Turn Undo 使用 `after -> before`，Turn Redo 使用 `before -> after`。
- [ ] Turn Undo/Redo 不调用 `moveTo()`，可见对话、display leaf 和 composer 保持不变。
- [ ] 普通 Undo 不覆盖 drift；Force 只覆盖精确红名单；Redo 没有 Force。
- [ ] `DiffReviewDialog` 被 conversation Revert/Redo 和 Turn Review/Undo/Redo 共用。
- [ ] `agent-turn-diff` 不调用 Git diff，不在 snapshot 失败时退化。
- [ ] 两 Session 不同 path 互不影响，同 path 变化显式冲突。
- [ ] conversation Revert 能正确组合此前的 turn mutation marker。
- [ ] recovery journal 可恢复或安全 freeze 四种 restore kind。
- [ ] 完整 focused test、Prettier 和 `git diff --check` 通过。
