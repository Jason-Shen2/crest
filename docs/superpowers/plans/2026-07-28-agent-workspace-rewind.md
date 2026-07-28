# Agent Workspace Rewind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Crest/Pi Agent 增加与用户 turn 绑定、与具体工具无关、可预览且可 Redo 的“对话 + Workspace 文件”回退，并保证普通 Revert 不会覆盖检测到的其他 Session 或人工修改。

**Architecture:** 在应用数据目录中使用私有 shadow Git object store 保存 turn 边界的原始 workspace tree；在 append-only session tree 中保存隐藏 checkpoint/state entry；Electron main 的单一 coordinator 负责计划、漂移检查、选择性文件恢复、SQLite CAS、恢复日志和 live/cold 广播；renderer 的所有入口共享同一个 preview/apply 控制器。权威恢复数据只来自 turn 边界快照和服务端计划，不依赖 `write`、`edit`、tool result 或 renderer 回传的路径。

**Tech Stack:** TypeScript, Node.js filesystem/Git plumbing, Electron IPC/preload, SQLite session storage, React 19, assistant-ui, Tailwind CSS v4, Vitest, Testing Library

---

## 实施约束

- 设计依据是 `docs/superpowers/specs/2026-07-28-agent-workspace-rewind-design.md`；实现中若发现契约冲突，先更新设计并评审，再改代码。
- OpenCode Core v2 只作为 shadow tree、selective restore、preview 的参考；不得复制 legacy `read-tree + checkout-index`、`reset --hard` 或 `clean -fd`。
- pi-rewind 只作为 user-turn 生命周期和 `/rewind` 命名参考；不得把 tool 级 pre-image 变成权威数据。
- 用户 Git 的 HEAD、index、branch、stash、hooks、filters 和 object store 都不得写入或借用。
- 正常 Revert 遇到 live drift 必须拒绝；Force 只能覆盖 preview 中精确列出的 regular-file drift，且必须使用绑定冲突指纹的 opaque token。
- v1 不表达 directory state，因此 file↔directory collision、symlink ancestor 和非空目录一律是 hard blocker；Force 也不能越过。
- 新增 UI button 必须保留 `cursor-pointer`，禁用态不用 `cursor-not-allowed`，并保持 keyboard/ARIA 可达性。
- `semanticLeafId` 是唯一 session CAS token；`displayLeafId` 只用于展示。任何 renderer 代码都不得从可见树反推语义 leaf。
- 文件写入成功但 session CAS 未提交时，必须依靠 durable recovery journal 做 classifier-safe 回滚；未知第三方状态绝不自动覆盖。
- 第一版 Redo 只有一步，且没有 Force Redo。
- 功能先由 `CREST_AGENT_WORKSPACE_REWIND=1` 内部开关启用；默认开启必须等最后一项平台、配额和故障注入门禁通过。

## 目标文件结构

```text
packages/coding-agent/workspace-rewind/
  types.ts
  validation.ts
  session-state.ts
  api-types.ts
  git-runner.ts
  workspace-identity.ts
  workspace-scope.ts
  snapshot-store.ts
  durability.ts
  pending-boundary-store.ts
  snapshot-retention.ts
  process-owner.ts
  workspace-lock.ts
  checkpoint-manager.ts
  live-path-state.ts
  restore-plan.ts
  confirmation-token.ts
  filesystem-apply.ts
  recovery-journal.ts
  workspace-recovery.ts
  rewind-engine.ts

packages/coding-agent/
  session-mutation-barrier.ts

emain/
  agent-rewind-service.ts
  agent-rewind-feature.ts
  agent-workspace-recovery-gate.ts
  agent-session-state-broadcaster.ts
  checkpoint-purge-confirmation.ts

frontend/app/agent/rewind/
  use-agent-rewind.ts
  rewind-context.tsx
  rewind-selector.tsx
  rewind-preview-dialog.tsx
  redo-dock.tsx
  recovery-dialog.tsx
  checkpoint-quota-banner.tsx
  checkpoint-quota-dialog.tsx
```

测试文件与被测模块同目录放置；跨层场景放在
`packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts` 和
`emain/agent-rewind-service.test.ts`。

### Task 1: 固化序列化类型、校验器和隐藏 session entry 语义

**Files:**
- Create: `packages/coding-agent/workspace-rewind/types.ts`
- Create: `packages/coding-agent/workspace-rewind/validation.ts`
- Create: `packages/coding-agent/workspace-rewind/validation.test.ts`
- Create: `packages/coding-agent/workspace-rewind/session-state.ts`
- Create: `packages/coding-agent/workspace-rewind/session-state.test.ts`
- Modify: `packages/coding-agent/commands/session-views.ts`
- Modify: `packages/coding-agent/commands/session-views.test.ts`
- Modify: `packages/coding-agent/agent-session-runtime.ts`
- Modify: `packages/coding-agent/agent-session-runtime.test.ts`
- Create: `emain/agent-workspace-recovery-gate.ts`
- Create: `emain/agent-workspace-recovery-gate.test.ts`
- Create: `emain/checkpoint-purge-confirmation.ts`
- Create: `emain/checkpoint-purge-confirmation.test.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `emain/emain-ipc.ts`
- Modify: `emain/emain.ts`

- [ ] **Step 1: 写失败测试，锁定 schema 和隐藏 entry 行为**

覆盖：

- `available` / `unavailable` checkpoint、rewind / redo workspace state 的严格解码；
- unknown field、错误 schemaVersion、绝对路径、`..`、重复 path、错误 OID 被拒绝；
- `workspace_checkpoint` 和 `workspace_state` 被 `/tree` 隐藏；
- generic unknown custom entry 仍可见；
- raw leaf 指向隐藏 entry 时得到不同的 `semanticLeafId` 与 `displayLeafId`；
- visible child 跨隐藏 parent 正确重连；
- fold 只接受 active raw branch 上、与 `turnId` 对应的唯一 terminal checkpoint。

核心断言：

```ts
const filtered = filterTreeForDisplay([user, checkpoint, state], state.id);

expect(filtered.semanticLeafId).toBe(state.id);
expect(filtered.displayLeafId).toBe(user.id);
expect(filtered.entries.map((entry) => entry.id)).toEqual([user.id]);
expect(isWorkspaceControlEntry(unknownCustom)).toBe(false);
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/validation.test.ts packages/coding-agent/workspace-rewind/session-state.test.ts packages/coding-agent/commands/session-views.test.ts packages/coding-agent/agent-session-runtime.test.ts emain/agent-ipc.test.ts
```

Expected: FAIL，因为 workspace rewind 类型、fold 和双 leaf 结果尚不存在。

- [ ] **Step 3: 实现稳定的 v1 类型契约**

在 `types.ts` 定义并导出以下权威形状：

```ts
export const WorkspaceControlCustomTypes = {
    checkpoint: "workspace_checkpoint",
    state: "workspace_state",
} as const;

export type WorkspaceCoverageReason =
    | "ignored"
    | "nested-repository"
    | "oversized-untracked"
    | "non-utf8-path"
    | "hard-linked"
    | "special-entry"
    | "capture-budget";

export type CapturedPathStateV1 =
    | { state: "absent" }
    | { state: "file"; oid: string; executable: boolean }
    | { state: "symlink"; oid: string }
    | { state: "excluded"; reason: WorkspaceCoverageReason };

export interface WorkspaceSnapshotRefV1 {
    id: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    tree: string;
    scopeManifest: string;
}

export interface WorkspacePathChangeV1 {
    path: string;
    before: CapturedPathStateV1;
    after: CapturedPathStateV1;
}

export interface WorkspaceSnapshotCoverage {
    complete: boolean;
    eligibleEntryCount: number;
    newlyHashedBytes: number;
    exclusions: Array<{
        path?: string;
        pathBytesBase64?: string;
        reason: WorkspaceCoverageReason;
    }>;
}

export type WorkspaceCheckpointFailureCode =
    | "disabled"
    | "git_unavailable"
    | "capture_timeout"
    | "capture_budget"
    | "unstable_file"
    | "enospc"
    | "quota_exceeded"
    | "hosted_pty_running"
    | "process_crash_before_finalization"
    | "corrupt_snapshot";

export type WorkspaceCheckpointV1 =
    | {
          schemaVersion: 1;
          status: "available";
          originSessionId: string;
          turnId: string;
          workspaceIdentity: string;
          workspaceIncarnation: string;
          before: WorkspaceSnapshotRefV1;
          after: WorkspaceSnapshotRefV1;
          changes: WorkspacePathChangeV1[];
          coverage: WorkspaceSnapshotCoverage;
      }
    | {
          schemaVersion: 1;
          status: "unavailable";
          originSessionId: string;
          turnId: string;
          workspaceIdentity: string;
          workspaceIncarnation?: string;
          reasonCode: WorkspaceCheckpointFailureCode;
          message: string;
          coverage?: WorkspaceSnapshotCoverage;
      };

export interface WorkspaceStateV1 {
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

export interface FoldedWorkspaceSessionState {
    checkpointsByTurnId: ReadonlyMap<string, WorkspaceCheckpointV1>;
    activeWorkspaceState?: WorkspaceStateV1;
    semanticLeafId: string | null;
    displayLeafId: string | null;
    eligibleTurnIds: string[];
    checkpointGaps: Array<{ turnId: string; reason: string }>;
}
```

新增失败原因时必须先扩展这个显式 union、decoder、UI 文案和 round-trip tests，不能
把未知字符串默认为可回退。

- [ ] **Step 4: 实现严格 decoder、fold 和唯一隐藏谓词**

`validation.ts` 不使用类型断言跳过输入校验；对所有数组、OID、相对路径和枚举做边界检查。
`session-state.ts` 导出：

```ts
export function isWorkspaceControlEntry(entry: SessionTreeEntry): boolean;
export function decodeWorkspaceCheckpointEntry(entry: SessionTreeEntry): WorkspaceCheckpointV1 | undefined;
export function decodeWorkspaceStateEntry(entry: SessionTreeEntry): WorkspaceStateV1 | undefined;
export function foldWorkspaceSessionState(entries: SessionTreeEntry[], sessionId: string): FoldedWorkspaceSessionState;
```

把 `session-views.ts` 的结果改成：

```ts
export interface FilteredSessionTree {
    entries: SessionTreeEntry[];
    semanticLeafId: string | null;
    displayLeafId: string | null;
}
```

`isHiddenTreeEntry()` 只额外调用 `isWorkspaceControlEntry()`；不得隐藏所有 custom entry。
同一提交更新 runtime 与 cold IPC 的现有 caller：内部改读 `displayLeafId`，但在 Task 13
正式迁移 public IPC shape 前仍映射到旧 `leafId` 字段，避免中间 commit 编译失败。

- [ ] **Step 5: 运行 focused tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/validation.test.ts packages/coding-agent/workspace-rewind/session-state.test.ts packages/coding-agent/commands/session-views.test.ts packages/coding-agent/agent-session-runtime.test.ts emain/agent-ipc.test.ts
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/workspace-rewind/types.ts packages/coding-agent/workspace-rewind/validation.ts packages/coding-agent/workspace-rewind/validation.test.ts packages/coding-agent/workspace-rewind/session-state.ts packages/coding-agent/workspace-rewind/session-state.test.ts packages/coding-agent/commands/session-views.ts packages/coding-agent/commands/session-views.test.ts packages/coding-agent/agent-session-runtime.ts packages/coding-agent/agent-session-runtime.test.ts emain/agent-ipc.ts emain/agent-ipc.test.ts
git commit -m "feat(agent): define workspace rewind journal types"
```

### Task 2: 建立隔离、可取消、无 shell 的 Git plumbing runner

**Files:**
- Create: `packages/coding-agent/workspace-rewind/git-runner.ts`
- Create: `packages/coding-agent/workspace-rewind/git-runner.test.ts`
- Reuse: `packages/coding-agent/tools/_child-process.ts`

- [ ] **Step 1: 写 runner 安全测试**

用 fake executable 和临时目录验证：

- 始终 `shell: false`，参数按 argv 传递；
- 删除继承的 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_OBJECT_DIRECTORY`、
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`、`GIT_CONFIG_*` 和 pathspec 环境；
- 固定 `GIT_TERMINAL_PROMPT=0`、`GIT_LITERAL_PATHSPECS=1`、`LC_ALL=C`；
- 超时、AbortSignal、stdout/stderr 上限、ENOENT、非零 exit 均返回 typed error；
- caller 省略输出上限时仍使用内部 hard cap，且 caller 只能调低、不能调高；
- `-leading`、tab、newline、pathspec magic 字符保持原始 argv，不发生 shell interpolation。

```ts
await expect(
    runner.run(["hash-object", "--stdin"], { stdin: Buffer.from("bytes"), timeoutMs: 10 })
).resolves.toMatchObject({ stdout: expect.any(Buffer), stderr: expect.any(Buffer) });
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/git-runner.test.ts
```

Expected: FAIL，因为 `WorkspaceGitRunner` 尚不存在。

- [ ] **Step 3: 实现 runner**

公开 API 固定为：

```ts
export const WorkspaceGitRunnerLimits = {
    maxStdoutBytes: 64 * 1024 ** 2,
    maxStderrBytes: 4 * 1024 ** 2,
} as const;

export interface GitRunOptions {
    cwd?: string;
    gitDir?: string;
    workTree?: string;
    stdin?: Buffer;
    timeoutMs: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    signal?: AbortSignal;
}

export interface GitRunResult {
    stdout: Buffer;
    stderr: Buffer;
}

export class WorkspaceGitRunner {
    constructor(readonly executable = "git") {}
    run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult>;
}
```

在 shadow-object 命令中显式传 `--git-dir=<absolute store path>`；禁止从用户 repo
读取 alternates。为 scope discovery 单独构造 read-only environment，并设置
`GIT_OPTIONAL_LOCKS=0`、`core.fsmonitor=false`、`core.hooksPath` 到空目录。
runner 无论 options 是否省略都先应用 `WorkspaceGitRunnerLimits`；显式 limit 大于
hard cap 时立即拒绝，不能在 `ls-files` / `mktree` / `diff` 的 entry-budget parser
运行前把无界输出缓存在内存。fake executable 分别覆盖 stdout/stderr 超限时 child 被
终止且返回 typed overflow error。实现按 stream chunk 先累计 byte count、达到 cap
立即 kill；不得先 `Buffer.concat()` 全量输出后再检查。

- [ ] **Step 4: 运行 focused test 和现有 child-process 回归**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/git-runner.test.ts packages/coding-agent/tools/tools.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/workspace-rewind/git-runner.ts packages/coding-agent/workspace-rewind/git-runner.test.ts
git commit -m "feat(agent): add isolated shadow git runner"
```

### Task 3: 解析 canonical workspace、incarnation 和捕获 scope

**Files:**
- Create: `packages/coding-agent/workspace-rewind/workspace-identity.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-identity.test.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-scope.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-scope.test.ts`

- [ ] **Step 1: 写 identity/scope 失败测试**

覆盖 Git root、repo 子目录、`.git` file worktree、non-Git workspace、symlink root、
删除后重建的同路径 workspace，以及：

- tracked 文件；
- non-ignored untracked 文件；
- 2 MiB 边界；
- ignored / nested repo / `.git` / hard-link / FIFO / invalid UTF-8 排除；
- symlink 作为 leaf 被捕获但 symlink ancestor 不被遍历；
- read-only discovery 前后用户 index bytes 和 mtime 完全相同；
- NUL-delimited pathname parsing 保留 tab、newline 和首尾空格。

```ts
expect(recreated.workspaceIdentity).toBe(original.workspaceIdentity);
expect(recreated.workspaceIncarnation).not.toBe(original.workspaceIncarnation);
expect(scope.exclusions).toContainEqual({
    path: "vendor/child-repo",
    reason: "nested-repository",
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-identity.test.ts packages/coding-agent/workspace-rewind/workspace-scope.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 identity**

`workspace-identity.ts` 导出：

```ts
export interface CanonicalWorkspaceIdentity {
    canonicalRoot: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    storeKey: string;
}

export function resolveCanonicalWorkspaceIdentity(root: string): Promise<CanonicalWorkspaceIdentity>;
```

`workspaceIdentity` 由 canonical root 的稳定 hash 得出；`workspaceIncarnation`
结合根目录的设备/文件 identity 和首次登记的随机 nonce。nonce 原子写入 Crest
应用数据目录，不能写入 workspace。根目录丢失或被替换后必须得到新 incarnation。

- [ ] **Step 4: 实现统一 filesystem enumerator 和 Git 只读分类**

`workspace-scope.ts` 导出：

```ts
export interface WorkspaceScopeEntry {
    pathBytes: Buffer;
    path?: string;
    kind: "file" | "symlink" | "excluded";
    tracked: boolean;
    executable?: boolean;
    size?: number;
    exclusionReason?: WorkspaceCoverageReason;
}

export interface WorkspaceScope {
    root: string;
    entries: WorkspaceScopeEntry[];
    coverage: WorkspaceSnapshotCoverage;
}

export function discoverWorkspaceScope(input: {
    identity: CanonicalWorkspaceIdentity;
    git: WorkspaceGitRunner;
    maxEntries: number;
    maxUntrackedBytes: number;
}): Promise<WorkspaceScope>;
```

Git workspace 用 `rev-parse`、`ls-files -z` 和 ignore query 只读分类；non-Git
workspace 使用同一 enumerator，并用已安装的 `ignore@7` 逐目录累积 ignore rules。
scope manifest 持久化影响每个决策的 ignore inputs、nested-repository boundaries 和
size policy，不能只保存最终 file list。目录遍历全程使用 `lstat`，不跟随 symlink。

- [ ] **Step 5: 运行 focused tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-identity.test.ts packages/coding-agent/workspace-rewind/workspace-scope.test.ts
```

Expected: PASS，并且 index bytes/mtime 断言通过。

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/workspace-rewind/workspace-identity.ts packages/coding-agent/workspace-rewind/workspace-identity.test.ts packages/coding-agent/workspace-rewind/workspace-scope.ts packages/coding-agent/workspace-rewind/workspace-scope.test.ts
git commit -m "feat(agent): discover rewind workspace scope"
```

### Task 4: 实现 raw blob shadow snapshot、descriptor 和显式 path state

**Files:**
- Create: `packages/coding-agent/workspace-rewind/process-owner.ts`
- Create: `packages/coding-agent/workspace-rewind/process-owner.test.ts`
- Create: `packages/coding-agent/workspace-rewind/snapshot-store.ts`
- Create: `packages/coding-agent/workspace-rewind/snapshot-store.test.ts`

- [ ] **Step 1: 写 snapshot store 失败测试**

覆盖 Git 与 non-Git workspace 的：

- regular text/binary、create/delete、symlink、executable bit；
- raw bytes 不受 `.gitattributes`、CRLF、clean/smudge、working-tree-encoding 影响；
- scope manifest 能区分 covered-and-absent 与 excluded；
- file fingerprint 完全相同时复用 blob OID；
- mtime/ctime/file identity 不可靠时回退 raw hash；
- hash 前后 stat 变化重试一次，仍不稳定则失败；
- capture deadline、200,000 entries、1 GiB 新 hash、free-space gate；
- descriptor `id` 同时引用 workspace tree 和 scope manifest；
- 不创建或读取 mutable shadow index。
- 第一次初始化、重复打开和“目录已创建但 config/ref 尚未完成”的半初始化恢复；
- bootstrap owner 存活时并发 open 等待，owner 已退出时按 PID + process-start token
  安全接管，PID reuse 不会误判；
- `makeProcessOwnerIdentity()` 读取平台 process-start token 并生成 nonce；同一 main
  process 将一次创建的 identity 注入 store/pending/workspace lock，不在各模块重建；
- store root、objects、refs、journal、lock 的 owner-only 权限，且重开会修复过宽权限；
- bare repo 没有 index/alternates，hooks 指向私有空目录，`core.autocrlf=false`；
- referenced bytes 超过 soft quota 时 capture 返回可展示的 quota 状态，而不删除 owner ref。

```ts
const state = await store.readPathState(snapshot, "created.bin");
expect(state).toEqual({ state: "file", oid: expect.stringMatching(/^[a-f0-9]{40,64}$/), executable: false });
expect(await store.readPathState(snapshot, "ignored.secret")).toEqual({
    state: "excluded",
    reason: "ignored",
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/process-owner.test.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现无 index 的 raw capture**

store 固定在
`<dataRoot>/agent-checkpoints/workspaces/<storeKey>/repo.git`，父目录 mode
`0700`。首次使用 `initializePrivateStore()` 原子初始化；关闭 auto-GC，隔离 hooks，
设置 `core.autocrlf=false`；不配置 alternates，也不创建可变 shadow index。初始化先
在同父目录创建 `0700` staging directory，完成 bare repo、config probe、空 hooks
directory 和 owner-only permission 后 durable rename；发现半初始化目录时先通过
本模块的 `open("wx")` bootstrap owner record 取得初始化独占权，再校验并补全，不能
直接把它当成可用 store。Task 6 会把 open/capture/ref 全部再包入长期 canonical
workspace lock。所有目录固定
`0700`，owner files 固定 `0600`；重开时发现 group/other bits 必须收紧并复验。

公开 API：

```ts
export interface ProcessOwnerIdentity {
    pid: number;
    processStartToken: string;
    nonce: string;
}

export function makeProcessOwnerIdentity(): Promise<ProcessOwnerIdentity>;

export async function initializePrivateStore(input: {
    storeRoot: string;
    git: WorkspaceGitRunner;
    processOwner: ProcessOwnerIdentity;
}): Promise<void>;

export interface CaptureWorkspaceOptions {
    profile: "pre-turn" | "terminal" | "safety";
    requiredPaths?: readonly string[];
    signal?: AbortSignal;
}

export interface WorkspaceSnapshotQuotaStatus {
    status: "ok" | "soft-quota-exceeded" | "referenced-over-quota";
    usedBytes: number;
    referencedBytes: number;
    softQuotaBytes: number;
}

export class WorkspaceSnapshotStore {
    static open(input: {
        dataRoot: string;
        identity: CanonicalWorkspaceIdentity;
        git: WorkspaceGitRunner;
        processOwner: ProcessOwnerIdentity;
    }): Promise<WorkspaceSnapshotStore>;

    capture(options: CaptureWorkspaceOptions): Promise<{
        ref: WorkspaceSnapshotRefV1;
        coverage: WorkspaceSnapshotCoverage;
    }>;
    diff(before: WorkspaceSnapshotRefV1, after: WorkspaceSnapshotRefV1): Promise<WorkspacePathChangeV1[]>;
    readPathState(snapshot: WorkspaceSnapshotRefV1, path: string): Promise<CapturedPathStateV1>;
    readBlob(oid: string): Promise<Buffer>;
    verify(snapshot: WorkspaceSnapshotRefV1): Promise<void>;
    getQuotaStatus(): Promise<WorkspaceSnapshotQuotaStatus>;
}
```

定义并测试默认限制：

```ts
export const WorkspaceCheckpointLimits = {
    preTurnTimeoutMs: 5_000,
    terminalTimeoutMs: 30_000,
    maxEntries: 200_000,
    maxNewlyHashedBytes: 1024 ** 3,
    maxUntrackedFileBytes: 2 * 1024 ** 2,
    softQuotaBytes: 5 * 1024 ** 3,
    minimumFreeBytes: 1024 ** 3,
    minimumFreeRatio: 0.05,
} as const;
```

free-space gate 使用 `max(minimumFreeBytes, volumeBytes * minimumFreeRatio)`。
`CaptureWorkspaceOptions` 不允许 caller 自行拼默认限制；store 从
`WorkspaceCheckpointLimits` 按 profile 派生 deadline/budget。`safety` 使用
terminal deadline 和同一 entry/byte/free-space/quota 上限。

regular file 和 symlink bytes 使用 `hash-object --stdin --no-filters`；tree 使用
`mktree -z` 自底向上构造；scope manifest 使用 canonical JSON blob；descriptor
tree 固定包含 `workspace` 与 `scope-manifest` 两项。所有 Git 输出以 Buffer 和
NUL delimiter 解析，不调用 `.trim()` 解析路径。`requiredPaths` 供 Force safety
capture 使用：即使某个确认路径在普通 scope 中跨越 untracked size policy，也必须
原样捕获或让 operation 失败，绝不能在未保存 force-time bytes 时覆盖。

- [ ] **Step 4: 加入 racy-clean 防护**

只有当前 fingerprint 与同一 incarnation 的前一 snapshot 完全一致、且距离最近
filesystem timestamp tick 已越过 racy window 时才复用 OID。否则重新 raw hash。
这条规则必须有 fake-clock 测试，证明“相同 size 和 timestamp tick 内改写”不会漏记。

- [ ] **Step 5: 运行 focused tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/process-owner.test.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/workspace-rewind/process-owner.ts packages/coding-agent/workspace-rewind/process-owner.test.ts packages/coding-agent/workspace-rewind/snapshot-store.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts
git commit -m "feat(agent): capture raw workspace shadow snapshots"
```

### Task 5: 锚定 durable refs、pending boundary 和 reference-aware retention

**Files:**
- Create: `packages/coding-agent/workspace-rewind/durability.ts`
- Create: `packages/coding-agent/workspace-rewind/durability.test.ts`
- Create: `packages/coding-agent/workspace-rewind/snapshot-retention.ts`
- Create: `packages/coding-agent/workspace-rewind/snapshot-retention.test.ts`
- Create: `packages/coding-agent/workspace-rewind/pending-boundary-store.ts`
- Create: `packages/coding-agent/workspace-rewind/pending-boundary-store.test.ts`
- Modify: `packages/agent/harness/session/sqlite-repo.ts`
- Create: `packages/agent/harness/session/sqlite-repo.test.ts`
- Modify: `packages/coding-agent/sessions.ts`
- Modify: `packages/coding-agent/sessions.test.ts`

- [ ] **Step 1: 写 refs、owner scan 和 GC 失败测试**

测试以下所有权来源：

- active、`.archive`、`.trash` session DB 中的 checkpoint/state entry；
- fork 后复制的 checkpoint entry；
- bound/unbound pending boundary；
- in-progress operation journal；
- orphan ref 的首次 grace 标记和第二次过期删除；
- production API 不接受 caller-supplied grace；首次/第二次 scan 即使紧邻执行也零删除，
  只有 module 固定 7-day grace 过期后才可删除；
- 任一 DB、pending 或 journal 无法扫描/解码时 fail closed，删除数量为 0；
- `reflog expire` 和 `git gc --prune=now` 后所有 referenced descriptor/blob 仍可读；
- source session 删除后 fork 仍保持 snapshot；
- soft quota 只阻止新 capture，不删除 referenced ref。
- archive 或移入 `.trash` 后仍保留 owner ref；只有永久 purge session DB、owner scan
  确认无引用并经过 grace 后才允许 cleanup 释放 quota。

```ts
const report = await reconcileSnapshotRefs({ store, sessionsRoot });
expect(report.removedRefs).toEqual([]);
expect(report.failClosedReason).toMatch(/owner source/i);
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/durability.test.ts packages/coding-agent/workspace-rewind/pending-boundary-store.test.ts packages/coding-agent/workspace-rewind/snapshot-retention.test.ts packages/agent/harness/session/sqlite-repo.test.ts packages/coding-agent/sessions.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 durability 和 ref API**

`durability.ts` 负责 atomic replace、file fsync 和 parent-directory fsync，并导出：

```ts
export async function writeDurableJson(path: string, value: unknown): Promise<void>;
export async function removeDurableFile(path: string): Promise<void>;
export async function ensureDurableGitObjects(storePath: string, objectIds: readonly string[]): Promise<void>;
```

`WorkspaceSnapshotStore` 增加：

```ts
anchorSnapshot(ref: WorkspaceSnapshotRefV1): Promise<void>;
anchorPending(record: PendingWorkspaceBoundaryV1): Promise<void>;
anchorOperation(record: WorkspaceOperationOwnerV1): Promise<void>;
deleteCrestRef(refName: string): Promise<void>;
listCrestRefs(): Promise<Array<{ name: string; oid: string }>>;
```

ref namespace 固定为：

```text
refs/crest/snapshots/<snapshot-id>
refs/crest/pending/<session-hash>/<boundary-token>
refs/crest/ops/<operation-id>
```

先保证完整 object graph durable，再 `update-ref`。Git 支持时 probe 并启用
`core.fsync=loose-object,reference`；否则 fsync 新 loose object 和 fanout directory。

- [ ] **Step 4: 实现 pending boundary 持久化**

`PendingWorkspaceBoundaryV1` 必须包含 process PID、process-start token、nonce、
boundary token、session ID、workspace identity/incarnation、before ref、
可选 durable userEntryId 和可选 after ref。公开状态迁移：

```ts
export interface WorkspaceOperationOwnerV1 {
    operationId: string;
    sessionId: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    snapshot: WorkspaceSnapshotRefV1;
}

export interface UnboundPendingBoundaryV1 {
    boundaryToken: string;
    sessionId: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    processOwner: ProcessOwnerIdentity;
    nonce: string;
    before: WorkspaceSnapshotRefV1;
}

export interface PendingWorkspaceBoundaryV1 extends UnboundPendingBoundaryV1 {
    userEntryId?: string;
    after?: WorkspaceSnapshotRefV1;
}

export interface RecoveredPendingBoundary {
    record: PendingWorkspaceBoundaryV1;
    disposition: "resume-finalization" | "retire-unbound" | "owner-still-live";
}

begin(record: UnboundPendingBoundaryV1): Promise<void>;
bind(boundaryToken: string, userEntryId: string): Promise<void>;
recordAfter(boundaryToken: string, after: WorkspaceSnapshotRefV1): Promise<void>;
complete(boundaryToken: string): Promise<void>;
recover(sessionEntries: SessionTreeEntry[]): Promise<RecoveredPendingBoundary[]>;
```

每次迁移先更新 pending ref descriptor，再 durable JSON；terminal checkpoint append
成功后才删除 pending record/ref。

- [ ] **Step 5: 实现按 session ID 的递归 owner scan**

给 `SqliteSessionRepo` 增加 `findById(sessionId)` 和递归 metadata scan，包含 active、
`.archive`、`.trash`。`sessions.ts` 暴露 `findPaneSessionById()`。retention 不复用
当前只扫 cwd 直属 `.db` 的 `list()`。

`snapshot-retention.ts` 本 Task 只实现不带并发 wrapper 的 reference-aware
reconcile/GC 内核：

```ts
export const SnapshotRetentionLimits = {
    orphanGraceMs: 7 * 24 * 60 * 60 * 1000,
} as const;
```

1. 扫描所有 owner sources；
2. 任一失败立即 fail closed；
3. 对首次 unowned ref 写 grace ledger；
4. 第二次且过 grace 才删 ref；
5. 最后请求 Git GC。

Task 6 再把这个内核与 capture/ref 操作接入同一个 canonical workspace lock；在
Task 6 完成前不得从生产入口调用 reconcile/GC。
production `reconcileSnapshotRefs()` 不暴露 `graceMs`/`now` 参数，只读取
`SnapshotRetentionLimits` 与 system clock。测试用 Vitest fake timers 前移时间，不给
renderer、IPC 或 handler 任意缩短 grace 的入口。

- [ ] **Step 6: 运行 focused tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/durability.test.ts packages/coding-agent/workspace-rewind/pending-boundary-store.test.ts packages/coding-agent/workspace-rewind/snapshot-retention.test.ts packages/agent/harness/session/sqlite-repo.test.ts packages/coding-agent/sessions.test.ts
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/coding-agent/workspace-rewind/durability.ts packages/coding-agent/workspace-rewind/durability.test.ts packages/coding-agent/workspace-rewind/snapshot-retention.ts packages/coding-agent/workspace-rewind/snapshot-retention.test.ts packages/coding-agent/workspace-rewind/pending-boundary-store.ts packages/coding-agent/workspace-rewind/pending-boundary-store.test.ts packages/agent/harness/session/sqlite-repo.ts packages/agent/harness/session/sqlite-repo.test.ts packages/coding-agent/sessions.ts packages/coding-agent/sessions.test.ts
git commit -m "feat(agent): retain durable workspace snapshots"
```

### Task 6: 增加 canonical workspace lock 和 retained session mutation lease

**Files:**
- Reuse: `packages/coding-agent/workspace-rewind/process-owner.ts`
- Reuse: `packages/coding-agent/workspace-rewind/process-owner.test.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-lock.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-lock.test.ts`
- Create: `packages/coding-agent/session-mutation-barrier.ts`
- Create: `packages/coding-agent/session-mutation-barrier.test.ts`
- Modify: `packages/coding-agent/agent-runtime-registry.ts`
- Modify: `packages/coding-agent/agent-runtime-registry.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-retention.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-retention.test.ts`

- [ ] **Step 1: 写并发与锁顺序失败测试**

覆盖：

- retained lease 同步设置 tombstone、等待已开始的 `withSessionAccess` drain；
- lease 期间新的 get/create/send/access 被拒；
- idle live runtime 与 subscriber 不被 dispose；
- 同 session FIFO，不同 session 可并行直到 workspace lock；
- in-process 与 child process 都不能同时持有相同 workspace lock；
- dead PID 可回收，PID reuse 通过 process-start token 拒绝误回收；
- owner 存活状态未知时 fail closed；
- 测试模式下 workspace lock→session lease 的逆序获取立即报错。
- synthetic destructive consumer 在 session lease 内解析 canonical workspace，再
  取得 workspace lock；与 ref reconcile/GC 并发时既不丢 owner ref 也不死锁。真实
  archive/delete 接线留到 Task 13。

```ts
await registry.withRetainedSessionMutation(path, { rejectIfRunning: true }, async (lease) => {
    expect(registry.get(path)).toBeUndefined();
    expect(registry.getRuntimeForLease(lease)).toBe(runtime);
});
expect(runtime.dispose).not.toHaveBeenCalled();
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/session-mutation-barrier.test.ts packages/coding-agent/agent-runtime-registry.test.ts packages/coding-agent/workspace-rewind/process-owner.test.ts packages/coding-agent/workspace-rewind/workspace-lock.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 保留旧 destructive lease，新增 retained lease**

保留 `withExclusiveSessionMutation()` 给 archive/delete；新增：

```ts
export interface RetainedSessionMutationLease<TRuntime> {
    readonly path: string;
    readonly runtime?: TRuntime;
    readonly token: symbol;
}

withRetainedSessionMutation<T>(
    path: string,
    options: { rejectIfRunning?: boolean },
    fn: (lease: RetainedSessionMutationLease<TRuntime>) => Promise<T>
): Promise<T>;

withMutationLeaseAccess<T>(
    lease: RetainedSessionMutationLease<TRuntime>,
    fn: (runtime: TRuntime | undefined) => Promise<T>
): Promise<T>;
```

lease token 不可由调用方构造。它共用现有 per-path exclusive turn 队列，但不走
`startEntryCleanup()`。checkpoint finalizer、preview、apply、redo、recovery 都使用
同一 retained queue。

- [ ] **Step 4: 实现共享 session mutation barrier**

`SessionMutationBarrier` 为 harness checkpoint finalizer、runtime send gate 和 registry
lease 提供同一 FIFO：

```ts
export class SessionMutationBarrier {
    isBusy(): boolean;
    run<T>(operation: () => Promise<T>): Promise<T>;
    waitForIdle(): Promise<void>;
}
```

retained lease 在判断 runtime idle 前必须 await barrier；manager finalizer 在 barrier
内完成 terminal entry 和 state publish。这样不能依赖 subscriber registration 顺序
提供互斥。

- [ ] **Step 5: 实现 workspace lock**

锁目录位于 `<dataRoot>/agent-checkpoints/workspaces/<storeKey>/lock/`，权限
`0700`；owner record 由 `open("wx", 0o600)` 创建并包含：

```ts
interface WorkspaceLockOwnerV1 {
    schemaVersion: 1;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    pid: number;
    processStartToken: string;
    nonce: string;
    acquiredAt: string;
}
```

全局顺序固定为 session lease → workspace lock。多 session 操作先按 session ID
排序获取所有 lease，再取 workspace lock；持有 workspace lock 时禁止再获取 session
lease。destructive consumer 也必须遵守该顺序：先冻结并 drain session，随后从
durable session metadata 解析 canonical workspace identity，持有 workspace lock 完成
mutation 与 owner-ref reconcile，最后按相反顺序释放。Task 13 将现有 archive/delete
接入该 helper。

- [ ] **Step 6: 把 capture、refs、reconcile 和 GC 接到同一 store lock**

Task 4/5 的 public store operation 都必须经 workspace lock；GC 不得与 object
capture/ref durability 并行。测试在 capture 中间阻塞，再启动 reconcile，断言 GC
直到 capture ref durable 后才运行。

- [ ] **Step 7: 运行 focused tests**

Run:

```bash
npx vitest run packages/coding-agent/session-mutation-barrier.test.ts packages/coding-agent/agent-runtime-registry.test.ts packages/coding-agent/workspace-rewind/process-owner.test.ts packages/coding-agent/workspace-rewind/workspace-lock.test.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts packages/coding-agent/workspace-rewind/snapshot-retention.test.ts
```

Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add packages/coding-agent/session-mutation-barrier.ts packages/coding-agent/session-mutation-barrier.test.ts packages/coding-agent/workspace-rewind/workspace-lock.ts packages/coding-agent/workspace-rewind/workspace-lock.test.ts packages/coding-agent/agent-runtime-registry.ts packages/coding-agent/agent-runtime-registry.test.ts packages/coding-agent/workspace-rewind/snapshot-store.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts packages/coding-agent/workspace-rewind/snapshot-retention.ts packages/coding-agent/workspace-rewind/snapshot-retention.test.ts
git commit -m "feat(agent): serialize workspace rewind mutations"
```

### Task 7: 在 AgentHarness 中建立真正的 user-turn 生命周期

**Files:**
- Modify: `packages/agent/types.ts`
- Modify: `packages/agent/agent-loop.ts`
- Create: `packages/agent/agent-loop.test.ts`
- Modify: `packages/agent/harness/types.ts`
- Modify: `packages/agent/harness/agent-harness.ts`
- Modify: `packages/agent/harness/agent-harness.test.ts`

- [ ] **Step 1: 写 awaited lifecycle 失败测试**

测试 initial、next-turn batch、steering、ordinary follow-up、prepared initial、
prepared follow-up、preparation failure、post-commit abort、provider failure 和 normal
agent_end。每个 started boundary 必须严格产生以下二选一序列：

```text
before(token) → committed(token, durable userEntryId) → terminal(token, reason)
before(token) → terminal(token, preparation_failed)
```

prepared transaction 的 committed 必须发生在 durable transaction 返回后、后续
`message_end` 之前。新 boundary 开始前先 terminalize 旧 boundary。所有 listener
必须被 await。

```ts
expect(events).toEqual([
    ["before", "boundary-1"],
    ["committed", "boundary-1", "user-entry-1"],
    ["terminal", "boundary-1", "agent_end"],
]);
expect(harness.isIdle()).toBe(false);
await prompt;
expect(harness.isIdle()).toBe(true);
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run packages/agent/agent-loop.test.ts packages/agent/harness/agent-harness.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 增加 low-level beforeUserMessage seam**

在 `AgentLoopConfig` 增加：

```ts
beforeUserMessage?: (message: UserMessage) => Promise<void>;
```

agent loop 在 initial/next-turn user、steering 和 follow-up 被加入模型上下文前 await
该 callback。prepared message 已在 harness 提前 begin 时，callback 根据 message
identity 只做 no-op，不重复创建 boundary。

- [ ] **Step 4: 增加三个 harness own event**

```ts
export interface SessionBeforeUserTurnEvent {
    type: "session_before_user_turn";
    boundaryToken: string;
    userMessage: UserMessage;
}

export interface SessionUserTurnCommittedEvent {
    type: "session_user_turn_committed";
    boundaryToken: string;
    userEntryId: string;
}

export interface SessionUserTurnTerminalEvent {
    type: "session_user_turn_terminal";
    boundaryToken: string;
    reason: "superseded" | "agent_end" | "aborted" | "preparation_failed" | "provider_failed";
}
```

三者加入 `AgentHarnessOwnEvent` 和 `AgentHarnessEventResultMap`，result 都是
`undefined`，通过 `emitOwn` 顺序 await。

- [ ] **Step 5: 修正 durable commit 和 idle ordering**

- prepared initial/follow-up 在 atomic preparation 返回 `userEntryId` 后立即 emit committed；
- ordinary/steering/unprepared follow-up 在 `handleAgentEvent(message_end)` 完成
  `session.appendMessage()` 后 emit committed；
- abort/error/finally 都 terminalize 已开始 boundary；
- `agent_end` 不得在 awaited terminal/finalizer 完成前把 phase 设为 idle；
- `settled` 也必须在 phase 变 idle 前完成。

- [ ] **Step 6: 运行 lifecycle tests**

Run:

```bash
npx vitest run packages/agent/agent-loop.test.ts packages/agent/harness/agent-harness.test.ts
```

Expected: PASS，且每种路径都只有一个 terminal event。

- [ ] **Step 7: Commit**

```bash
git add packages/agent/types.ts packages/agent/agent-loop.ts packages/agent/agent-loop.test.ts packages/agent/harness/types.ts packages/agent/harness/agent-harness.ts packages/agent/harness/agent-harness.test.ts
git commit -m "feat(agent): expose awaited user turn lifecycle"
```

### Task 8: 绑定 checkpoint manager、pending recovery 和 turn terminal entry

**Files:**
- Create: `packages/coding-agent/workspace-rewind/checkpoint-manager.ts`
- Create: `packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts`
- Create: `emain/agent-rewind-feature.ts`
- Create: `emain/agent-rewind-feature.test.ts`
- Modify: `packages/coding-agent/agent-session-runtime.ts`
- Modify: `packages/coding-agent/agent-session-runtime.test.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `emain/emain-platform.ts`

- [ ] **Step 1: 写 checkpoint state machine 失败测试**

覆盖：

- before capture → pending ref → durable userEntryId bind → after capture/diff →
  terminal checkpoint append → pending remove 的精确顺序；
- checkpoint `turnId` 等于 durable user entry ID；
- first turn 的 conversation `targetBoundaryId` 为 `null`，但 checkpoint `before` 仍是
  实际捕获并锚定的初始 workspace snapshot；
- prepared/context transaction、steering、follow-up、abort、provider error 都得到一个 terminal status；
- expected capture failure 不使 agent response 失败，而是 append unavailable；
- `preparation_failed` 等 committed 之前的 terminal 只删除 pending/ref，不追加
  checkpoint；只有已经绑定 durable `userEntryId` 的 boundary 才能追加 available 或
  unavailable terminal checkpoint；
- bound pending 在 crash 后补 `process_crash_before_finalization` unavailable；
- unbound pending 仅在证明原 process owner 消失后退休；
- active hosted PTY 使 terminal checkpoint unavailable；
- finalizer busy 时 send/tree/archive/delete 都仍视 session busy。
- 同一 main process 创建多个 runtime 时 store、pending、workspace lock 和 manager
  接收同一个 `ProcessOwnerIdentity` object；模拟 PID reuse 仍靠 process-start token
  区分。

```ts
expect(await session.getLeafId()).toBe(checkpointEntry.id);
expect(decodeWorkspaceCheckpointEntry(checkpointEntry)).toMatchObject({
    status: "available",
    turnId: userEntry.id,
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts emain/agent-rewind-feature.test.ts packages/coding-agent/agent-session-runtime.test.ts emain/agent-ipc.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 checkpoint manager**

公开 API：

```ts
export interface WorkspaceCheckpointManager {
    isBusy(): boolean;
    recover(): Promise<void>;
    dispose(): Promise<void>;
}

export function registerWorkspaceCheckpointManager(input: {
    harness: AgentHarness;
    session: Session;
    sessionId: string;
    workspaceRoot: string;
    store: WorkspaceSnapshotStore;
    mutationBarrier: SessionMutationBarrier;
    hasRunningHostedCommands: () => boolean;
    processOwner: ProcessOwnerIdentity;
    onCheckpointCommitted: () => Promise<void>;
}): WorkspaceCheckpointManager;
```

manager 在每个 harness lifecycle event 内捕获自己的预期错误并写 unavailable；不得把
snapshot failure 抛回 harness，导致有效 agent response 变 hook failure。terminal
事件先检查 pending 是否已有 durable `userEntryId`：没有则 durable remove
pending/ref 并结束，不得伪造 `turnId` 或 checkpoint entry；已经 bind 的 terminal 才
使用显式 entry ID/parent 和：

```ts
await session.appendEntries([checkpointEntry], { expectedLeafId: expectedSemanticLeafId });
```

不得使用无 CAS 的 `appendCustomEntry()`。
pre-turn capture 固定使用 `{ profile: "pre-turn" }`，terminal capture 固定使用
`{ profile: "terminal" }`；两者的 5 秒/30 秒 deadline 和其余预算只能来自 Task 4
的 `WorkspaceCheckpointLimits`。

- [ ] **Step 4: 在 runtime 构建时按正确顺序注册**

`emain/agent-ipc.ts` 的 `createAgentRuntimeFromSession()` 中：

1. build harness host；
2. `agent-rewind-feature.ts` 用 module-level promise 实现
   `getAgentRewindProcessOwner()`；main process 只调用一次
   `makeProcessOwnerIdentity()`，runtime factory 读取该 singleton；
3. 在 runtime 之前创建唯一 `AgentPtyHost`；
4. 用同一个 process owner 和 `getWaveDataDir()` 下的 `agent-checkpoints` 打开 canonical
   store/workspace lock；
5. 创建 shared `SessionMutationBarrier`；
6. 注册 checkpoint manager，并把同一个 process owner 与
   `AgentPtyHost.hasRunningCommands()` closure 传入；
7. manager `recover()`；
8. 最后把同一个 `AgentPtyHost` 传给 `new AgentSessionRuntime()` 并订阅 harness。

session attach 可做 best-effort warm capture，但不能创建 turn checkpoint。功能关闭时
注册 no-op manager，并向 session state 暴露 disabled 状态。
`agent-rewind-feature.ts` 只在 `CREST_AGENT_WORKSPACE_REWIND=1` 时启用，防止
checkpoint storage 在 rollout 门禁完成前默认运行。

用 `let owner: AgentSessionRuntime | undefined` closure 实现
`onCheckpointCommitted`；runtime 构造完成后每次 terminal append 都 await
`owner.refreshFromPersistedBranch()` 并 emit 最新 state，再释放 barrier。这样 renderer
不会在 hidden checkpoint 已成为 raw leaf 后仍停留在旧 branch cache。

- [ ] **Step 5: 让 runtime busy 覆盖 finalizer**

`AgentSessionRuntime.isRunning()` 同时检查 harness、hosted PTY 和
`mutationBarrier.isBusy()`。dispose/shutdown 必须 await manager dispose，不能遗留
仍在写 refs/entry 的 finalizer。

- [ ] **Step 6: 运行 focused tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts emain/agent-rewind-feature.test.ts packages/coding-agent/agent-session-runtime.test.ts emain/agent-ipc.test.ts
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/coding-agent/workspace-rewind/checkpoint-manager.ts packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts emain/agent-rewind-feature.ts emain/agent-rewind-feature.test.ts packages/coding-agent/agent-session-runtime.ts packages/coding-agent/agent-session-runtime.test.ts emain/agent-ipc.ts emain/agent-ipc.test.ts emain/emain-platform.ts
git commit -m "feat(agent): persist per-turn workspace checkpoints"
```

### Task 9: 实现纯 restore planning、漂移分类和 opaque confirmation token

**Files:**
- Create: `packages/coding-agent/workspace-rewind/live-path-state.ts`
- Create: `packages/coding-agent/workspace-rewind/live-path-state.test.ts`
- Create: `packages/coding-agent/workspace-rewind/restore-plan.ts`
- Create: `packages/coding-agent/workspace-rewind/restore-plan.test.ts`
- Create: `packages/coding-agent/workspace-rewind/confirmation-token.ts`
- Create: `packages/coding-agent/workspace-rewind/confirmation-token.test.ts`
- Create: `packages/coding-agent/workspace-rewind/api-types.ts`

- [ ] **Step 1: 写 planner 失败测试**

覆盖：

- 使用 `getTransactionForkBoundary(entries, targetTurnId, "before")`；
- 只沿 active raw branch 从目标 turn 到 tip；
- 每个 durable user entry 恰好一个 terminal checkpoint；
- missing、duplicate、unavailable checkpoint 都是 hard blocker；
- 同一路径取 suffix 中最早 `before` 为 target、最新 `after` 为 expected current；
- 当前 hidden workspace state 覆盖 expected current；
- excluded transition 只产生 coverage warning，不进入 apply set；
- expected==target 的路径是 no-op，不写文件；
- regular-file content/executable/presence drift 是 forceable；
- identity/incarnation、path escape、symlink ancestor、unsafe kind、file↔directory
  collision、snapshot 缺失是 hard blocker；
- Redo 只认当前 raw leaf 上、同 session 的 `kind:"rewind"` marker。

```ts
expect(plan.paths.map((item) => item.path)).toEqual(["a.ts", "b.ts"]);
expect(plan.paths.find((item) => item.path === "a.ts")).toMatchObject({
    target: firstCheckpoint.changes[0].before,
    expectedCurrent: lastCheckpoint.changes[0].after,
    conflict: "none",
});
```

- [ ] **Step 2: 写 confirmation registry 失败测试**

测试 token：

- 32-byte random、5 分钟 TTL、单次消费；
- 绑定 workspace identity/incarnation、session ID、semantic leaf、target、
  effective path 排序、live fingerprints 和 conflict classes；
- 随机 token、过期、重复、跨 session/workspace/leaf 都拒绝；
- preview 后 conflict 新增、删除或 fingerprint 改变都判 stale；
- hard-blocked preview 不签发 token；
- Redo 只在完全 clean 时签发 token；Redo drift 即使属于 regular-file mismatch 也只
  返回 blocked preview；
- Force 不能增加 token 未列出的 path，也不能越过 hard blocker。

- [ ] **Step 3: 运行测试并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/live-path-state.test.ts packages/coding-agent/workspace-rewind/restore-plan.test.ts packages/coding-agent/workspace-rewind/confirmation-token.test.ts
```

Expected: FAIL。

- [ ] **Step 4: 实现 planner**

公开接口固定为：

```ts
export type RewindConflictClass = "none" | "forceable-drift" | "hard-blocker";

export type LiveCapturedPathState =
    | { state: "absent"; fingerprint: string }
    | { state: "file"; oid: string; executable: boolean; fingerprint: string }
    | { state: "symlink"; oid: string; fingerprint: string }
    | { state: "directory"; empty: boolean; fingerprint: string }
    | { state: "unsafe"; kind: string; fingerprint: string }
    | { state: "blocked"; reason: string; fingerprint: string };

export interface LivePathClassification {
    conflict: RewindConflictClass;
    liveFingerprint: string;
    reason?: string;
}

export interface RestorePathPlanV1 {
    path: string;
    operation: "create" | "write" | "delete";
    target: CapturedPathStateV1;
    expectedCurrent: CapturedPathStateV1;
    liveFingerprint: string;
    conflict: RewindConflictClass;
    reason?: string;
}

export interface RestorePlanV1 {
    kind: "rewind" | "redo";
    sessionId: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    semanticLeafId: string | null;
    targetTurnId?: string;
    targetBoundaryId: string | null;
    paths: RestorePathPlanV1[];
    coverageWarnings: Array<{ path: string; reason: string }>;
    forceRequired: boolean;
    hardBlocked: boolean;
}

export interface PlanRewindInput {
    sessionId: string;
    workspace: CanonicalWorkspaceIdentity;
    rawEntries: SessionTreeEntry[];
    semanticLeafId: string | null;
    targetTurnId: string;
    currentWorkspaceState?: WorkspaceStateV1;
    inspectLivePath: (path: string) => Promise<LiveCapturedPathState>;
    verifySnapshot: (snapshot: WorkspaceSnapshotRefV1) => Promise<void>;
}

export interface PlanRedoInput {
    sessionId: string;
    workspace: CanonicalWorkspaceIdentity;
    rawEntries: SessionTreeEntry[];
    semanticLeafId: string | null;
    rewindState: WorkspaceStateV1;
    inspectLivePath: (path: string) => Promise<LiveCapturedPathState>;
    verifySnapshot: (snapshot: WorkspaceSnapshotRefV1) => Promise<void>;
}

export function inspectLivePath(root: string, path: string): Promise<LiveCapturedPathState>;
export function classifyLivePath(input: {
    live: LiveCapturedPathState;
    expected: CapturedPathStateV1;
    target: CapturedPathStateV1;
}): LivePathClassification;
export function planRewind(input: PlanRewindInput): Promise<RestorePlanV1>;
export function planRedo(input: PlanRedoInput): Promise<RestorePlanV1>;
```

`inspectLivePath()` 与 `classifyLivePath()` 实现在本 Task 的 `live-path-state.ts`，供
planner、apply 前复验和 crash recovery 共用；不得等 Task 10 writer 才定义。
rename 只作为 display grouping，由同一 plan 中一个 delete 和一个 create 表达；执行层
不接受带隐含第二路径的 rename 指令。

- [ ] **Step 5: 实现 confirmation registry**

```ts
export interface ConfirmedRestorePlanV1 {
    plan: RestorePlanV1;
    issuedAt: number;
    expiresAt: number;
    binding: {
        workspaceIdentity: string;
        workspaceIncarnation: string;
        sessionId: string;
        semanticLeafId: string | null;
        target: { kind: "rewind"; targetTurnId: string } | { kind: "redo" };
        effectivePaths: string[];
        liveFingerprints: Array<{ path: string; fingerprint: string; conflict: RewindConflictClass }>;
    };
}

export class RewindConfirmationRegistry {
    issue(plan: RestorePlanV1, now?: number): string;
    take(token: string, now?: number): ConfirmedRestorePlanV1;
    invalidateSession(sessionId: string): void;
}
```

同一 Task 在 `api-types.ts` 定义完整 renderer-facing contract，避免 main service
依赖 Task 13 才出现的类型。至少包含：

```ts
export type AgentRewindConflictClass = "none" | "forceable-drift" | "hard-blocker";
export type AgentRewindFileOperation = "create" | "write" | "delete" | "rename";

export interface AgentRewindPointView {
    turnId: string;
    preview: string;
    timestamp?: string;
    eligible: boolean;
    reason?: string;
}

export interface AgentListRewindPointsInput {
    sessionMetadata: JsonlSessionMetadata;
}

export interface AgentListRewindPointsResult {
    points: AgentRewindPointView[];
    semanticLeafId: string | null;
    displayLeafId: string | null;
}

export interface AgentRewindFileRowView {
    path: string;
    oldPath?: string;
    operation: AgentRewindFileOperation;
    additions?: number;
    deletions?: number;
    diff?: string;
    coverage: "covered" | "excluded" | "unavailable";
    conflict: AgentRewindConflictClass;
    reason?: string;
}

export interface AgentRewindPreviewResult {
    confirmationToken?: string;
    target: { kind: "rewind"; targetTurnId: string } | { kind: "redo" };
    targetPrompt?: string;
    semanticLeafId: string | null;
    displayLeafId: string | null;
    expectedSemanticLeafId: string | null;
    messageCount: number;
    fileCount: number;
    files: AgentRewindFileRowView[];
    coverageWarnings: string[];
    forceRequired: boolean;
    hardBlocked: boolean;
}

export interface AgentPreviewRewindInput {
    sessionMetadata: JsonlSessionMetadata;
    expectedSemanticLeafId: string | null;
    target: { kind: "rewind"; targetTurnId: string } | { kind: "redo" };
}

export interface AgentRewindTreeInput {
    sessionMetadata: JsonlSessionMetadata;
    expectedSemanticLeafId: string | null;
    targetTurnId: string;
    mode: "normal" | "force-drift";
    confirmationToken: string;
}

export interface AgentRedoRewindInput {
    sessionMetadata: JsonlSessionMetadata;
    expectedSemanticLeafId: string | null;
    confirmationToken: string;
}

export interface AgentRewindMutationResult {
    sessionMetadata: JsonlSessionMetadata;
    semanticLeafId: string | null;
    displayLeafId: string | null;
    editorText?: string;
}

export interface AgentWorkspaceRecoveryView {
    operationId: string;
    phase?: "prepared" | "applying_files" | "files_verified" | "committing_session" | "completed";
    corrupt: boolean;
    message: string;
    paths: Array<{ path: string; classification?: "pre" | "target" | "unknown" }>;
    allowedActions: Array<"retry" | "abandon-current" | "quarantine-corrupt">;
}

export interface AgentGetWorkspaceRecoveryInput {
    sessionMetadata: JsonlSessionMetadata;
}

export interface AgentResolveWorkspaceRecoveryInput {
    sessionMetadata: JsonlSessionMetadata;
    operationId: string;
    action: "retry" | "abandon-current" | "quarantine-corrupt";
}

export interface AgentCheckpointQuotaView {
    status: "ok" | "soft-quota-exceeded" | "referenced-over-quota";
    usedBytes: number;
    softQuotaBytes: number;
    cleanupAvailable: boolean;
    message?: string;
}

export interface AgentCleanupWorkspaceCheckpointsInput {
    sessionMetadata: JsonlSessionMetadata;
}

export interface AgentCleanupWorkspaceCheckpointsResult {
    removedUnownedBytes: number;
    quota: AgentCheckpointQuotaView;
}

export interface AgentListCheckpointStorageOwnersInput {
    sessionMetadata: JsonlSessionMetadata;
}

export interface AgentCheckpointTrashOwnerView {
    sessionId: string;
    title?: string;
    referencedBytes: number;
    confirmationToken: string;
}

export interface AgentListCheckpointStorageOwnersResult {
    trashOwners: AgentCheckpointTrashOwnerView[];
}

export interface AgentPurgeTrashedSessionInput {
    sessionMetadata: JsonlSessionMetadata;
    trashedSessionId: string;
    confirmationToken: string;
}

export interface AgentPurgeTrashedSessionResult {
    purgedSessionId: string;
    quota: AgentCheckpointQuotaView;
}

export interface AgentRedoView {
    operationId: string;
    targetPrompt: string;
    messageCount: number;
    fileCount: number;
    files: AgentRewindFileRowView[];
}

export interface AgentRewindSessionStateView {
    enabled: boolean;
    semanticLeafId: string | null;
    displayLeafId: string | null;
    eligibleTurnIds: string[];
    busy: boolean;
    frozen: boolean;
    quota: AgentCheckpointQuotaView;
    redo?: AgentRedoView;
}
```

registry 仅在 main process 内保存确认材料，renderer 得到的 token 不包含可解析路径或
hash。apply 获取两级锁后先 `take()`，再全量重算并比较 canonical confirmation
projection。

- [ ] **Step 6: 运行 focused tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/live-path-state.test.ts packages/coding-agent/workspace-rewind/restore-plan.test.ts packages/coding-agent/workspace-rewind/confirmation-token.test.ts
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/coding-agent/workspace-rewind/live-path-state.ts packages/coding-agent/workspace-rewind/live-path-state.test.ts packages/coding-agent/workspace-rewind/restore-plan.ts packages/coding-agent/workspace-rewind/restore-plan.test.ts packages/coding-agent/workspace-rewind/confirmation-token.ts packages/coding-agent/workspace-rewind/confirmation-token.test.ts packages/coding-agent/workspace-rewind/api-types.ts
git commit -m "feat(agent): plan safe workspace rewinds"
```

### Task 10: 实现 containment-checked 的选择性文件 writer

**Files:**
- Create: `packages/coding-agent/workspace-rewind/filesystem-apply.ts`
- Create: `packages/coding-agent/workspace-rewind/filesystem-apply.test.ts`

- [ ] **Step 1: 写 path writer 失败测试**

覆盖：

- regular text/binary、symlink、executable bit、target absent；
- same-parent exclusive temp、write、chmod、file fsync、atomic rename、
  parent-directory fsync 的顺序；
- 删除只允许 regular file 或 symlink；
- lexical escape、symlink ancestor、reparse point、FIFO/socket/device 拒绝；
- parent 一层层 no-follow 创建并记录；
- rollback 只删除本 operation 创建且仍为空的目录；
- case-only rename；
- file↔directory、非空 directory、unmanaged descendant 第一版全部 hard block；
- ancestor 在 check 后被替换为 symlink 时 verification 失败，不扩大写入范围。

```ts
await applyCapturedPath({
    root,
    path: "src/run.sh",
    target: { state: "file", oid, executable: true },
    readBlob,
    progress,
});
expect(await fs.readFile(path.join(root, "src/run.sh"))).toEqual(bytes);
expect((await fs.stat(path.join(root, "src/run.sh"))).mode & 0o111).not.toBe(0);
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/filesystem-apply.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 writer 和 post-write verification**

公开 API：

```ts
export interface WorkspacePathApplyProgress {
    operationId: string;
    createdParentDirectories: Set<string>;
    onPathReplaced(path: string): Promise<void>;
}

export function applyCapturedPath(input: {
    root: string;
    path: string;
    target: CapturedPathStateV1;
    readBlob: (oid: string) => Promise<Buffer>;
    progress: WorkspacePathApplyProgress;
}): Promise<void>;
export function verifyCapturedPath(input: {
    root: string;
    path: string;
    expected: CapturedPathStateV1;
}): Promise<void>;
```

regular file 使用 `lstat`、exclusive temp、raw bytes、mode、fsync、rename、parent
fsync；symlink 使用 same-parent temporary symlink + rename；禁止打开 unsupported
entry。`excluded` 传入 apply 是 programming error。所有 preflight 与 post-write
分类复用 Task 9 的 `inspectLivePath()` / `classifyLivePath()`，writer 不再另造一套
live-state 语义。

- [ ] **Step 4: 运行 focused tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/filesystem-apply.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/workspace-rewind/filesystem-apply.ts packages/coding-agent/workspace-rewind/filesystem-apply.test.ts
git commit -m "feat(agent): apply exact workspace path states"
```

### Task 11: 建立 durable operation journal、crash recovery 和 workspace freeze gate

**Files:**
- Create: `packages/coding-agent/workspace-rewind/recovery-journal.ts`
- Create: `packages/coding-agent/workspace-rewind/recovery-journal.test.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-recovery.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-recovery.test.ts`
- Create: `packages/coding-agent/workspace-rewind/fixtures/restore-crash-worker.ts`
- Create: `packages/coding-agent/workspace-rewind/restore-crash.test.ts`

- [ ] **Step 1: 写 phase oracle 和 fault-injection 失败测试**

对以下每一个位置启动 child worker 并 `SIGKILL`：

- operation ref 前后；
- `prepared`、`applying_files`、`files_verified`、`committing_session`、
  `completed` durable write 前后；
- 每个 path rename 后；
- SQLite CAS 前后；
- journal remove 与 operation ref remove 之间。

同时覆盖：

- `prepared` 只在全 pre-state 时丢弃；
- `applying_files` / `files_verified` 只在每 path 属于 `{pre,target}` 时回滚；
- `committing_session` 按 exact operation leaf finish 或 rollback；
- `completed` 补 refs、重发 state、cleanup；
- unknown live state、corrupt/truncated journal、missing object、incarnation mismatch、
  unexpected leaf 一律 freeze；
- post-crash 人工修改不会被自动覆盖；
- recovery 重复执行幂等。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/recovery-journal.test.ts packages/coding-agent/workspace-rewind/workspace-recovery.test.ts packages/coding-agent/workspace-rewind/restore-crash.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 journal schema 和 durable phase API**

```ts
export type WorkspaceOperationPhase =
    | "prepared"
    | "applying_files"
    | "files_verified"
    | "committing_session"
    | "completed";

export interface WorkspaceOperationPathV1 {
    path: string;
    target: CapturedPathStateV1;
    preState: CapturedPathStateV1;
    expectedCurrent: CapturedPathStateV1;
    confirmedLiveFingerprint: string;
    createdParentDirectories: string[];
}

export interface WorkspaceOperationJournalV1 {
    schemaVersion: 1;
    phase: WorkspaceOperationPhase;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    sessionId: string;
    sessionPath: string;
    operationId: string;
    kind: "rewind" | "redo";
    applyMode: "normal" | "force-drift";
    expectedSemanticLeafId: string | null;
    targetBoundaryId: string | null;
    safetySnapshot: WorkspaceSnapshotRefV1;
    confirmedConflictFingerprints: Array<{ path: string; fingerprint: string }>;
    paths: WorkspaceOperationPathV1[];
    workspaceStateEntryId: string;
    resultSnapshot?: WorkspaceSnapshotRefV1;
}
```

每次 phase transition 使用 Task 5 的 atomic replace + file/parent fsync，先 durable
记录授权，再执行对应 side effect。

- [ ] **Step 4: 实现三态 recovery classifier**

每个 live path 只能分类为 exact pre、exact target 或 unknown。自动 rollback 只在所有
path 都属于前两者时执行；unknown 时保留 journal/operation ref 并冻结整个 canonical
workspace。

提供：

```ts
export interface WorkspaceRecoveryView {
    operationId: string;
    phase?: WorkspaceOperationPhase;
    corrupt: boolean;
    message: string;
    paths: Array<{ path: string; classification?: "pre" | "target" | "unknown" }>;
    allowedActions: Array<"retry" | "abandon-current" | "quarantine-corrupt">;
}

export interface WorkspaceRecoveryCoordinator {
    scanKnownJournals(): Promise<void>;
    ensureRecovered(workspace: CanonicalWorkspaceIdentity): Promise<void>;
    getRecoveryState(workspace: CanonicalWorkspaceIdentity): Promise<WorkspaceRecoveryView | undefined>;
    retry(operationId: string): Promise<void>;
    abandonKeepingCurrent(operationId: string): Promise<void>;
    quarantineCorrupt(operationId: string): Promise<void>;
    assertWorkspaceWritable(workspace: CanonicalWorkspaceIdentity): Promise<void>;
}
```

`abandonKeepingCurrent` 仅允许 session leaf 是 exact old leaf 或 committed operation
leaf；`quarantineCorrupt` 不写 workspace/session。两者把记录移入 30-day
resolved-audit 目录。Recovery 永远没有 Force。

- [ ] **Step 5: 运行 focused tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/recovery-journal.test.ts packages/coding-agent/workspace-rewind/workspace-recovery.test.ts packages/coding-agent/workspace-rewind/restore-crash.test.ts
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/workspace-rewind/recovery-journal.ts packages/coding-agent/workspace-rewind/recovery-journal.test.ts packages/coding-agent/workspace-rewind/workspace-recovery.ts packages/coding-agent/workspace-rewind/workspace-recovery.test.ts packages/coding-agent/workspace-rewind/fixtures/restore-crash-worker.ts packages/coding-agent/workspace-rewind/restore-crash.test.ts
git commit -m "feat(agent): recover interrupted workspace rewinds"
```

### Task 12: 实现 restore transaction 和 live/cold 共用 coordinator

**Files:**
- Create: `packages/coding-agent/workspace-rewind/rewind-engine.ts`
- Create: `packages/coding-agent/workspace-rewind/rewind-engine.test.ts`
- Create: `packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts`
- Create: `emain/agent-rewind-service.ts`
- Create: `emain/agent-rewind-service.test.ts`
- Create: `emain/agent-session-state-broadcaster.ts`
- Create: `emain/agent-session-state-broadcaster.test.ts`
- Modify: `packages/coding-agent/agent-session-runtime.ts`
- Modify: `packages/coding-agent/agent-session-runtime.test.ts`

- [ ] **Step 1: 写 transaction ordering 失败测试**

断言严格顺序：

```text
session retained lease
workspace lock
recompute plan + consume/verify token
full safety capture + operation ref
prepared
applying_files
selective path writes
full post-apply capture + path verification
files_verified
anchor pending session refs
committing_session
SQLite appendEntries CAS
verify exact operation leaf
completed
rebuild + broadcast
remove journal
remove operation ref
release locks
```

覆盖 normal drift no-op、Force safety snapshot 保存确认时 bytes、target absent、rename
双边、binary/symlink/exec、mid-apply failure、CAS failure classifier-safe rollback、
unknown third-party write 不回滚、CAS 成功后 broadcast/cleanup failure 不反向回滚。

- [ ] **Step 2: 写 Redo 和 live/cold 失败测试**

覆盖：

- successful rewind 的 hidden state parent 是 transaction-aware target boundary；
- mutation result 的 `editorText` 来自被选 user entry 的原始 text content；
- marker 保存 `fromLeafId`、redo snapshot/states、applyMode、forcedPaths；
- Redo 恢复 exact safety bytes，并 append `kind:"redo"` 到 `fromLeafId`；
- Redo marker 不含进一步 redo payload；
- new prompt/branch navigation 使旧 marker 不再是 raw leaf，因此 Redo 消失；
- Redo drift 返回 blocked preview，绝无 Force；
- live runtime instance/subscription 不变；
- cold/live 对相同 persisted branch 构造完全相同 session_state；
- broadcast 完成前新 send 不能越过 lease。

- [ ] **Step 3: 运行测试并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/rewind-engine.test.ts packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts emain/agent-rewind-service.test.ts emain/agent-session-state-broadcaster.test.ts packages/coding-agent/agent-session-runtime.test.ts
```

Expected: FAIL。

- [ ] **Step 4: 实现 engine**

engine 只接受服务端 `RestorePlanV1` 和 consumed confirmation，不接受 renderer path：

```ts
export interface PreviewRewindInput {
    session: Session;
    sessionId: string;
    workspace: CanonicalWorkspaceIdentity;
    semanticLeafId: string | null;
    targetTurnId: string;
}

export interface PreviewRedoInput {
    session: Session;
    sessionId: string;
    workspace: CanonicalWorkspaceIdentity;
    semanticLeafId: string | null;
}

export interface ApplyRewindInput extends PreviewRewindInput {
    mode: "normal" | "force-drift";
    confirmation: ConfirmedRestorePlanV1;
}

export interface ApplyRedoInput extends PreviewRedoInput {
    confirmation: ConfirmedRestorePlanV1;
}

export interface WorkspaceRewindCommitResult {
    sessionMetadata: JsonlSessionMetadata;
    semanticLeafId: string | null;
    displayLeafId: string | null;
    editorText?: string;
}

export class WorkspaceRewindEngine {
    previewRewind(input: PreviewRewindInput): Promise<AgentRewindPreviewResult>;
    previewRedo(input: PreviewRedoInput): Promise<AgentRewindPreviewResult>;
    applyRewind(input: ApplyRewindInput): Promise<WorkspaceRewindCommitResult>;
    applyRedo(input: ApplyRedoInput): Promise<WorkspaceRewindCommitResult>;
}
```

Force 只允许 `applyRewind(mode:"force-drift")`，且冲突集合/指纹必须与 token 完全一致。
apply 前重新 capture 完整 safety snapshot；Force 时将所有 confirmed conflict path
作为 `requiredPaths`，任何一个 force-time state 无法 capture 都在首次文件写前失败。
apply 后 capture 完整 result snapshot，再
把 hidden workspace state 作为唯一 entry 通过：

```ts
await session.appendEntries([workspaceStateEntry], {
    expectedLeafId: expectedSemanticLeafId,
});
```

SQLite CAS 成功是 commit point；之后任何失败都由 recovery finish，不反向改文件或
conversation。

- [ ] **Step 5: 实现共用 service 和 broadcaster**

`AgentRewindService` 只暴露：

```ts
listPoints(input: AgentListRewindPointsInput): Promise<AgentListRewindPointsResult>;
preview(input: AgentPreviewRewindInput): Promise<AgentRewindPreviewResult>;
rewind(input: AgentRewindTreeInput): Promise<AgentRewindMutationResult>;
redo(input: AgentRedoRewindInput): Promise<AgentRewindMutationResult>;
```

preview 短持有 session lease → workspace lock，不写 safety/ref/journal。apply 长持有
两个锁。把 Task 8 的 `refreshFromPersistedBranch()` 扩展为返回完整 authoritative
state；broadcaster
为 lease holder 提供专用 publish path，不走会被 tombstone 拒绝的普通
`withSessionAccess`。完成广播后才释放 lease。
Rewind 成功结果使用共享 `textFromContent()` 从 selected user entry 恢复 composer
文本；不得从 preview label 或 renderer row 反推 prompt。

- [ ] **Step 6: 运行 focused tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/rewind-engine.test.ts packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts emain/agent-rewind-service.test.ts emain/agent-session-state-broadcaster.test.ts packages/coding-agent/agent-session-runtime.test.ts
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/coding-agent/workspace-rewind/rewind-engine.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts emain/agent-rewind-service.ts emain/agent-rewind-service.test.ts emain/agent-session-state-broadcaster.ts emain/agent-session-state-broadcaster.test.ts packages/coding-agent/agent-session-runtime.ts packages/coding-agent/agent-session-runtime.test.ts
git commit -m "feat(agent): coordinate workspace rewind and redo"
```

### Task 13: 接通 authoritative session/tree state、feature gate 和 Electron API

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/api-types.ts`
- Modify: `packages/coding-agent/workspace-rewind/session-state.ts`
- Modify: `packages/coding-agent/workspace-rewind/session-state.test.ts`
- Reuse: `emain/agent-rewind-feature.ts`
- Reuse: `emain/agent-rewind-feature.test.ts`
- Modify: `packages/coding-agent/commands/types.ts`
- Modify: `packages/coding-agent/commands/session-views.ts`
- Modify: `packages/coding-agent/commands/session-views.test.ts`
- Modify: `packages/coding-agent/agent-session-runtime.ts`
- Modify: `packages/coding-agent/agent-session-runtime.test.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `emain/preload.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `frontend/preview/mock/preview-electron-api.ts`
- Modify: `frontend/preview/mock/mockwaveenv.test.ts`
- Modify: `frontend/app/agent/agent-runtime-client.ts`
- Modify: `frontend/app/agent/agent-runtime-client.test.ts`

- [ ] **Step 1: 写 API contract 和 authorization 失败测试**

四个设计内 channel：

```text
agent:list-rewind-points
agent:preview-rewind
agent:rewind-tree
agent:redo-rewind
```

另为 recovery UI 增加只读/显式解决 channel：

```text
agent:get-workspace-recovery
agent:resolve-workspace-recovery
agent:cleanup-workspace-checkpoints
agent:list-checkpoint-storage-owners
agent:purge-trashed-session
```

测试 workspace identity、generation、session ownership、canonical cwd、stale sender、
stale semantic leaf、busy/frozen 状态。所有 renderer client 方法必须自动注入 immutable
`WorkspaceAgentIdentity`。cleanup 只运行 owner scan、删除已经 unowned 且超过 grace
的 ref 并 GC；绝不能删除任何仍被 active/archive/trash/pending/journal 引用的 snapshot。
storage-owner list 只返回当前 canonical workspace 下已经位于 `.trash` 的 session；
每个 row 带 5 分钟、单次使用、绑定 workspace/session DB identity 的 opaque purge
token。purge handler 必须重新确认 target 仍在 `.trash`、不再有 live runtime/access，
且 token/authorization 当前有效；renderer 不能提供 DB path 或 ref 名称。

purge token 使用独立 registry，不复用 `RewindConfirmationRegistry`：

```ts
export interface CheckpointPurgeBinding {
    workspaceIdentity: string;
    workspaceIncarnation: string;
    trashedSessionId: string;
    canonicalDatabaseIdentity: string;
}

export class CheckpointPurgeConfirmationRegistry {
    issue(binding: CheckpointPurgeBinding, now?: number): string;
    take(token: string, now?: number): CheckpointPurgeBinding;
}
```

测试 32-byte random、5 分钟 TTL、single-use、跨 workspace/session/DB identity 拒绝，
以及 restore token 与 purge token 互不接受。
`list-rewind-points` 的 result 和每次 preview 都必须回传同一时刻的
`semanticLeafId` / `displayLeafId`；selector 打开后 hidden checkpoint 前进或
conversation navigation 变化时，旧 list/preview 必须按 semantic leaf 判 stale，不能
靠 display leaf 误判为仍可 apply。

另写 main recovery gate 测试：

- `appMain()` await 启动 journal scan 后才注册 agent IPC；
- 对启动时未知、之后首次打开的 canonical workspace，create/send/runtime creation、
  PTY start、navigate 与 archive/delete 都先 await 同一 `ensureRecoveredOnce()`；
- restart 后 recovery 未完成前这些入口不可越过，read diagnostics 仍可用；
- owning-session lease → workspace lock 的顺序同时适用于 cold session；
- archive/delete 与 recovery/GC 竞争时 DB owner scan 看到的状态始终完整。

- [ ] **Step 2: 写 `/tree` 双 leaf 和 navigation anchor 失败测试**

覆盖：

- `AgentTreeResult` 同时返回 semantic/display leaf；
- 每个 visible row 有 server-derived `semanticAnchorId`；
- 选择当前 display tip 是 physical no-op，保留当前 hidden semantic leaf/Redo；
- 选择其他 user row 使用 transaction-aware before boundary；
- 离开后再选同一 visible row 不会重新激活历史 workspace state；
- request 携带 `expectedSemanticLeafId`，stale 时无 mutation；
- `/tree` 从不读取、捕获或恢复 workspace snapshot bytes。

- [ ] **Step 3: 运行测试并确认失败**

Run:

```bash
npx vitest run emain/agent-rewind-feature.test.ts emain/agent-workspace-recovery-gate.test.ts emain/checkpoint-purge-confirmation.test.ts emain/agent-ipc.test.ts packages/coding-agent/workspace-rewind/session-state.test.ts packages/coding-agent/commands/session-views.test.ts packages/coding-agent/agent-session-runtime.test.ts frontend/app/agent/agent-runtime-client.test.ts frontend/preview/mock/mockwaveenv.test.ts
```

Expected: FAIL。

- [ ] **Step 4: 镜像并验证 Task 9 的 renderer-facing API 类型**

本 Task 不再发明 API shape：`api-types.ts` 的完整 contract 已在 Task 9 建立。
`custom.d.ts` 原样镜像，其中 package 的 `JsonlSessionMetadata` 替换为 renderer 已有的
`AgentSessionMeta`。增加 type-level tests，保证 list result 和 preview 都携带
`semanticLeafId` / `displayLeafId`，Redo 包含 `targetPrompt`，session state 包含
quota；hard-blocked preview 没有 confirmation token。mutation input 仍只能含
session metadata、expected semantic leaf、target/mode/token，绝不包含 renderer
paths、hash 或 conflict flags。

- [ ] **Step 5: 更新 tree contract**

```ts
export interface AgentTreeEntryView {
    id: string;
    parentId?: string;
    type: string;
    role?: string;
    label?: string;
    stopReason?: string;
    preview: string;
    timestamp?: string;
    isLeaf: boolean;
    isCurrent: boolean;
    referenceable?: boolean;
    semanticAnchorId: string | null;
}

export interface AgentTreeResult {
    entries: AgentTreeEntryView[];
    semanticLeafId: string | null;
    displayLeafId: string | null;
}

export interface AgentNavigateTreeInput {
    sessionMetadata: JsonlSessionMetadata;
    targetId: string;
    semanticAnchorId: string | null;
    expectedSemanticLeafId: string | null;
}
```

这是对现有 `AgentTreeEntryView` 的增量修改：保留全部既有字段，只新增
`semanticAnchorId`，不得用精简 snippet 替换而丢字段。backend 必须在当前 raw tree
上重算并验证 anchor，不能盲信 renderer。所有 live/cold
`session_state` 都带 `rewindState`。

`buildAgentRewindSessionStateView()` 是 async：它从 active raw branch 的 tip 向前一次
扫描 checkpoint gap，并向 store 验证 descriptor/ref availability。live runtime 在
attach 和每次 checkpoint/rewind/redo/navigation 后 await 该 builder，再通过
`setRewindState()` 更新同步的 `getSessionState()` cache；cold state 直接 await 同一
builder。不得让同步 renderer state 根据“SQLite entry 存在”猜 snapshot object 一定
可用。builder 同时从 store 的 owner-aware usage probe 构造 quota view；referenced
bytes 超过 5 GiB 时 `status:"referenced-over-quota"`，新 capture 继续 unavailable，
但绝不能让 state builder 或 cleanup 删除 referenced snapshot。

- [ ] **Step 6: 实现 feature gate 和统一 frozen write gate**

`agent-rewind-feature.ts` 只认精确 `CREST_AGENT_WORKSPACE_REWIND=1`。关闭时 capture
manager 是 no-op、session state `enabled:false`、四个 rewind API 返回明确 unavailable。

创建 process-wide `AgentWorkspaceRecoveryGate`：

```ts
export interface AgentWorkspaceRecoveryGate {
    scanBeforeIpcRegistration(): Promise<void>;
    ensureRecoveredOnce(workspace: CanonicalWorkspaceIdentity): Promise<void>;
    assertWorkspaceWritable(workspace: CanonicalWorkspaceIdentity): Promise<void>;
}
```

`emain/emain-ipc.ts` 的 `initIpcHandlers()` 改为 async，先 await
`scanBeforeIpcRegistration()` 再调用 `registerAgentIpcHandlers()`；
`emain/emain.ts` 的 `appMain()` 必须 await `initIpcHandlers()`。scan 只负责所有已知
journal；每个 canonical workspace 第一次访问仍必须调用带 promise memoization 的
`ensureRecoveredOnce()`，成功后缓存，失败/frozen 不缓存为成功。
recovery gate 与 runtime factory 都从 Task 8 的
`getAgentRewindProcessOwner()` 取得同一个 singleton，不能在 startup recovery 路径
重新生成 nonce。
startup scan 按 journal 中的 session ID 定位 active/archive/trash DB，按 session ID
排序获取 owning retained/destructive lease，再取 canonical workspace lock；找不到
owner、无法解码或 classifier unknown 时写 frozen diagnostic 并继续注册只读/recovery
IPC，绝不能把它当成“无需恢复”。

在 main authorization 层加入统一 `assertWorkspaceWritable()`：它先
`ensureRecoveredOnce()`，再检查 frozen 状态，供所有 write-capable 入口调用，包括：

- create/send/runtime creation；
- hosted-command start；
- navigate/fork/clone/compact/import；
- rename/archive/delete；
- rewind/redo/recovery retry/resolve。

read/list/inspect/export/recovery diagnostics 保持可用。不得只在 rewind handler
零散加 frozen check。gate 获取 owning-session lease 后才允许 recovery 取得 workspace
lock；任何 workspace-lock holder 都不能反向请求 session lease。

archive/delete 的现有 destructive lease 内，先从 session metadata 解析 canonical
workspace，再取 workspace lock，完成 DB move/delete 和 owner ref reconcile 后才
释放。新增 permanent purge 只允许 `.trash` target，并走相同顺序：
destructive session lease → workspace lock → durable remove DB → owner scan/reconcile →
quota rebuild；为 archive/delete/purge 补与 recovery/GC 并发的无死锁测试。普通
delete-to-trash 仍可恢复且不释放 snapshot owner，只有用户在 quota UI 二次确认的
permanent purge 才移除 owner。

- [ ] **Step 7: 接通 handler、preload、preview mock 和 client**

四个 rewind handler 都先 `authorizeSession()` 和验证 current sender；list/preview
只做 coordinator read/plan，mutation 在完成前再次验证 current authorization。
preview mock 的 list 返回带双 leaf 的空 result，其他 preview/apply 默认 reject
unavailable。cleanup handler 返回重新计算后的 quota view；renderer 只提交 session
identity，不提交 ref/path。purge handler 只接受本 Task 独立 registry 签发的 opaque
token + trashed session ID，并在 destructive lease 内 consume token、重新解析 target。

- [ ] **Step 8: 运行 focused tests**

Run:

```bash
npx vitest run emain/agent-rewind-feature.test.ts emain/agent-workspace-recovery-gate.test.ts emain/checkpoint-purge-confirmation.test.ts emain/agent-ipc.test.ts packages/coding-agent/workspace-rewind/session-state.test.ts packages/coding-agent/commands/session-views.test.ts packages/coding-agent/agent-session-runtime.test.ts frontend/app/agent/agent-runtime-client.test.ts frontend/preview/mock/mockwaveenv.test.ts
```

Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add packages/coding-agent/workspace-rewind/api-types.ts packages/coding-agent/workspace-rewind/session-state.ts packages/coding-agent/workspace-rewind/session-state.test.ts emain/agent-rewind-feature.ts emain/agent-rewind-feature.test.ts emain/agent-workspace-recovery-gate.ts emain/agent-workspace-recovery-gate.test.ts emain/checkpoint-purge-confirmation.ts emain/checkpoint-purge-confirmation.test.ts packages/coding-agent/commands/types.ts packages/coding-agent/commands/session-views.ts packages/coding-agent/commands/session-views.test.ts packages/coding-agent/agent-session-runtime.ts packages/coding-agent/agent-session-runtime.test.ts emain/agent-ipc.ts emain/agent-ipc.test.ts emain/emain-ipc.ts emain/emain.ts emain/preload.ts frontend/types/custom.d.ts frontend/preview/mock/preview-electron-api.ts frontend/preview/mock/mockwaveenv.test.ts frontend/app/agent/agent-runtime-client.ts frontend/app/agent/agent-runtime-client.test.ts
git commit -m "feat(agent): expose workspace rewind APIs"
```

### Task 14: Hydrate authoritative rewind state，并接通 `/rewind`、`/redo` 与独立 selector

**Files:**
- Modify: `frontend/app/store/use-pi-chat.ts`
- Modify: `frontend/app/store/use-pi-chat.test.tsx`
- Modify: `frontend/app/agent/agent-chat-host.tsx`
- Modify: `frontend/app/agent/agent-chat-host.test.tsx`
- Modify: `frontend/app/agent/agent-chat-host-api.test.ts`
- Modify: `packages/coding-agent/commands/types.ts`
- Modify: `packages/coding-agent/commands/registry.ts`
- Modify: `packages/coding-agent/commands/registry.test.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `frontend/app/agent/agent-slash-command-routing.ts`
- Modify: `frontend/app/agent/agent-slash-command-routing.test.ts`
- Modify: `frontend/app/agent/assistant-ui/registry-thread.tsx`
- Modify: `frontend/app/agent/assistant-ui/thread.integration.test.tsx`
- Modify: `frontend/app/view/cmdblock/cmdblock-input.tsx`
- Modify: `frontend/app/view/cmdblock/cmdblock-input.test.tsx`
- Modify: `frontend/app/view/cmdblock/cmdblock-input-focus.test.ts`
- Create: `frontend/app/agent/rewind/rewind-selector.tsx`
- Create: `frontend/app/agent/rewind/rewind-selector.test.tsx`

- [ ] **Step 1: 写 session-state hydration 失败测试**

覆盖：

- live subscription 和 cold `getSessionState()` 都 hydrate `rewindState`；
- 新 session_state wholesale replace semantic/display leaf、eligible IDs、busy/frozen、redo；
- A→B switch 立即清空 A 的 redo，不沿用上一 host state；
- 旧 subscription 的晚到 event 不能复活 A 的 Redo；
- 缺失 `rewindState` 时使用 explicit empty state，不保留 previous；
- reload/cold resume 可恢复 persisted Redo。

```ts
expect(result.current.rewindState).toEqual({
    enabled: true,
    semanticLeafId: "state-1",
    displayLeafId: "user-1",
    eligibleTurnIds: ["user-1"],
    busy: false,
    frozen: false,
    quota: expect.objectContaining({ status: "ok" }),
    redo: expect.objectContaining({ operationId: "op-1" }),
});
```

- [ ] **Step 2: 写 slash routing 失败测试**

断言：

- `/rewind` 与 `/redo` 可发现和路由；
- 两者不发送 prompt；
- 两者不进入 `agent:run-command`；
- `/rewind` 无 session 时显示现有 missing-session 错误；
- `/redo` 只在 authoritative `rewindState.redo` 存在时打开；
- captured session revision 变 stale 后 callback 不执行。

- [ ] **Step 3: 写 selector 失败测试**

独立 selector 覆盖 loading/error/empty、search、keyboard、most recent eligible
初始 focus、session switch 丢弃 stale load/pick。Enter 只请求打开 preview，不直接
mutation；选择后先在当前 thread surface 滚动并聚焦对应 user message，再打开同一
preview。若 message 因 virtualization 尚未挂载，先调用 thread 的 reveal seam，挂载后
再 `scrollIntoView({ block: "center" })`。

- [ ] **Step 4: 运行测试并确认失败**

Run:

```bash
npx vitest run frontend/app/store/use-pi-chat.test.tsx frontend/app/agent/agent-chat-host.test.tsx frontend/app/agent/agent-chat-host-api.test.ts packages/coding-agent/commands/registry.test.ts frontend/app/agent/agent-slash-command-routing.test.ts frontend/app/agent/rewind/rewind-selector.test.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx frontend/app/view/cmdblock/cmdblock-input.test.tsx frontend/app/view/cmdblock/cmdblock-input-focus.test.ts
```

Expected: FAIL。

- [ ] **Step 5: Hydrate rewind state**

`PiAgentEvent`、`UsePiChatReturn` 和 `AgentHostState` 增加
`rewindState: AgentRewindSessionStateView`。controlled session clear/switch 立即
reset：

```ts
const EmptyRewindState: AgentRewindSessionStateView = {
    enabled: false,
    semanticLeafId: null,
    displayLeafId: null,
    eligibleTurnIds: [],
    busy: false,
    frozen: false,
    quota: {
        status: "ok",
        usedBytes: 0,
        softQuotaBytes: 5 * 1024 ** 3,
        cleanupAvailable: false,
    },
};
```

`agent-chat-host.tsx` 当前可沿用 previous commands/context，但 rewindState 必须总是
使用当前 event 值或 empty state，绝不能跨 session 沿用。

`EmptyRewindState.quota` 使用明确的 `status:"ok"` 零值；list hydration 必须保存
server 返回的双 leaf，并在它与当前 `rewindState.semanticLeafId` 不一致时丢弃结果。

- [ ] **Step 6: 注册和路由 slash commands**

`AgentBackendCommandName` 加 `rewind | redo`，registry 文案固定：

```ts
{
    name: "rewind",
    description: "Revert conversation and workspace to an earlier turn",
    source: "builtin",
    action: { type: "backend", command: "rewind" },
}
{
    name: "redo",
    description: "Restore the most recently reverted conversation and files",
    source: "builtin",
    action: { type: "backend", command: "redo" },
}
```

同步 `custom.d.ts` 的 ambient command union、assistant-ui `SLASH_COMMANDS` 和 legacy
CmdBlock fallback menu；为 `/rewind` 使用 `RotateCcw`，为 `/redo` 使用 `RotateCw`，
并同步两个 menu 的 icon map。
`AgentImmediateCommandName` 必须排除 `rewind | redo`。给 host 增加
`onRewindRequest` / `onRedoRequest` callback；它们由 AgentContent 中的统一 rewind
controller 提供。

- [ ] **Step 7: 实现独立 rewind selector**

不要把新 discriminant 塞进当前 `SessionSelector` 的 fork fallback。新组件复用
`CommandInlineFrame`、`CommandSelectorPanel`、search bar 和 hint footer：

```ts
export interface RewindSelectorProps {
    open: boolean;
    points: AgentRewindPointView[];
    loading: boolean;
    errorMessage?: string;
    onSelect: (turnId: string) => void;
    onClose: () => void;
}
```

不可用 row 显示 reason 且不可提交；选择 eligible row 只调用 `onSelect(turnId)`。

`Thread` 增加一个受当前 conversation root ref 约束的
`revealTurnRequest?: { turnId: string; requestId: number }`。`UserMessage` 从
`metadata.custom.turnId` 写入 `data-agent-turn-id`；effect 只在该 Thread root 内查找，
必要时先驱动 assistant-ui 将目标 message 挂载，再 scroll/focus。不得用全局
`document.querySelector()`，避免同一 workspace 多个 Agent surface 串台。

- [ ] **Step 8: 运行 focused tests**

Run:

```bash
npx vitest run frontend/app/store/use-pi-chat.test.tsx frontend/app/agent/agent-chat-host.test.tsx frontend/app/agent/agent-chat-host-api.test.ts packages/coding-agent/commands/registry.test.ts frontend/app/agent/agent-slash-command-routing.test.ts frontend/app/agent/rewind/rewind-selector.test.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx frontend/app/view/cmdblock/cmdblock-input.test.tsx frontend/app/view/cmdblock/cmdblock-input-focus.test.ts
```

Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add frontend/app/store/use-pi-chat.ts frontend/app/store/use-pi-chat.test.tsx frontend/app/agent/agent-chat-host.tsx frontend/app/agent/agent-chat-host.test.tsx frontend/app/agent/agent-chat-host-api.test.ts packages/coding-agent/commands/types.ts packages/coding-agent/commands/registry.ts packages/coding-agent/commands/registry.test.ts frontend/types/custom.d.ts frontend/app/agent/agent-slash-command-routing.ts frontend/app/agent/agent-slash-command-routing.test.ts frontend/app/agent/assistant-ui/registry-thread.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx frontend/app/view/cmdblock/cmdblock-input.tsx frontend/app/view/cmdblock/cmdblock-input.test.tsx frontend/app/view/cmdblock/cmdblock-input-focus.test.ts frontend/app/agent/rewind/rewind-selector.tsx frontend/app/agent/rewind/rewind-selector.test.tsx
git commit -m "feat(agent): route workspace rewind commands"
```

### Task 15: 建立统一 renderer coordinator、消息 Revert 和共享 preview dialog

**Files:**
- Create: `frontend/app/agent/rewind/use-agent-rewind.ts`
- Create: `frontend/app/agent/rewind/use-agent-rewind.test.tsx`
- Create: `frontend/app/agent/rewind/rewind-context.tsx`
- Create: `frontend/app/agent/rewind/rewind-preview-dialog.tsx`
- Create: `frontend/app/agent/rewind/rewind-preview-dialog.test.tsx`
- Modify: `frontend/app/agent/assistant-ui/registry-thread.tsx`
- Modify: `frontend/app/agent/assistant-ui/thread.integration.test.tsx`
- Reuse: `frontend/app/agent/assistant-ui/diff-viewer.tsx`
- Reuse: `frontend/app/shadcn/ui/dialog.tsx`

- [ ] **Step 1: 写 coordinator 失败测试**

验证四个入口最终只有两种统一操作：

- message Revert 和 selector `/rewind` 对相同 turn 生成完全相同 preview input；
- Redo Dock 和 `/redo` 生成完全相同 redo preview/apply；
- 每个 async request 捕获 `{sessionPath, sessionRevision, semanticLeafId}`；
- A 的 preview 晚到时，切到 B 后不得显示或 apply；
- token 原样回传，不解析、不重写 file rows；
- confirm clean 使用 `mode:"normal"`；
- confirm drift 使用 `mode:"force-drift"`；
- apply success 的 `editorText` 交给现有 composer restore callback；
- apply response 不在本地猜测 Redo，Dock 只等 authoritative session_state。

- [ ] **Step 2: 写 message action 失败测试**

覆盖：

- 只对 `rewindState.eligibleTurnIds` 中、持久化
  `metadata.custom.turnId` 匹配的 user message 显示 `Revert`；
- click 传 exact turnId；
- 无 metadata、unavailable turn、running/frozen/busy 时隐藏或 disabled；
- latest eligible 始终可见，older row 沿用 hover/focus action bar；
- keyboard focus 可达，aria-label 和 tooltip 都是 `Revert`。

- [ ] **Step 3: 写 dialog footer 真值表测试**

```text
loading/applying                  -> Cancel disabled or operation locked
rewind clean                     -> Cancel + Revert
rewind forceable, no hard block  -> Cancel + Force revert
rewind hard blocker              -> Cancel only
redo clean                       -> Cancel + Redo
redo any drift/hard blocker      -> Cancel only
```

forceable row 必须红色，并逐行或在冲突组中显示精确字符串：

```text
files changed on disk since the agent last wrote them
```

普通 `Revert` 不得与 `Force revert` 同时出现。Redo 永远不显示 Force。

- [ ] **Step 4: 运行测试并确认失败**

Run:

```bash
npx vitest run frontend/app/agent/rewind/use-agent-rewind.test.tsx frontend/app/agent/rewind/rewind-preview-dialog.test.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx
```

Expected: FAIL。

- [ ] **Step 5: 实现统一 hook**

```ts
export interface UseAgentRewindOptions {
    client: AgentRuntimeClient;
    sessionMetadata?: AgentSessionMeta;
    sessionRevision: number;
    rewindState: AgentRewindSessionStateView;
    onRevealTurn: (turnId: string) => Promise<void>;
    onEditorText: (text: string) => void;
    onError: (message: string) => void;
}

export interface AgentRewindSelectorState {
    open: boolean;
    phase: "idle" | "loading" | "ready" | "error";
    points: AgentRewindPointView[];
    errorMessage?: string;
}

export interface AgentRewindPreviewState {
    open: boolean;
    operation: "rewind" | "redo";
    phase: "loading" | "ready" | "applying" | "error";
    result?: AgentRewindPreviewResult;
    errorMessage?: string;
}

export interface AgentRewindController {
    selector: AgentRewindSelectorState;
    preview: AgentRewindPreviewState;
    busy: boolean;
    rewindableTurnIds: ReadonlySet<string>;
    openSelector(): Promise<void>;
    openRewind(turnId: string): Promise<void>;
    openRedo(): Promise<void>;
    closeSelector(): void;
    cancelPreview(): void;
    confirmPreview(mode: "normal" | "force-drift"): Promise<void>;
}
```

hook 是唯一调用 `listRewindPoints`、`previewRewind`、`rewindTree`、
`redoRewind` 的 renderer 模块。preview token 只存在内存；session switch、leaf
change、cancel、apply 后立即丢弃。selector 的 `onSelect` 必须先 await
`onRevealTurn(turnId)` 再调用 `openRewind(turnId)`；message action 已在目标 row，
可直接调用同一个 `openRewind()`。

- [ ] **Step 6: 在 Thread 下传精确 turn action**

`Thread` props 增加：

```ts
rewindableTurnIds?: ReadonlySet<string>;
rewindBusy?: boolean;
onRevertTurn?: (turnId: string) => void;
```

通过 `ThreadRewindContext` 下传。`UserActionBar` 从 assistant-ui state 读取：

```ts
const turnId = useAuiState(
    (state) => (state.message.metadata.custom as { turnId?: string } | undefined)?.turnId
);
```

符合 eligibility 时在 Copy/Edit 旁加入 `RotateCcwIcon` button；button 只调用
`onRevertTurn(turnId)`，不直接碰 IPC。

- [ ] **Step 7: 实现 preview dialog**

```ts
export interface RewindPreviewDialogProps {
    open: boolean;
    operation: "rewind" | "redo";
    phase: "loading" | "ready" | "applying" | "error";
    preview?: AgentRewindPreviewResult;
    errorMessage?: string;
    onCancel: () => void;
    onConfirm: (mode: "normal" | "force-drift") => void;
}
```

文件 row 展示 create/write/delete/rename、additions/deletions、coverage 和 reason；
有 `diff` 时用现有 `<DiffViewer patch={row.diff} />` 展开。hard blocker 与 coverage
warning 都只展示 backend 文案，不由 renderer 重算。

- [ ] **Step 8: 运行 focused tests**

Run:

```bash
npx vitest run frontend/app/agent/rewind/use-agent-rewind.test.tsx frontend/app/agent/rewind/rewind-preview-dialog.test.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx
```

Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add frontend/app/agent/rewind/use-agent-rewind.ts frontend/app/agent/rewind/use-agent-rewind.test.tsx frontend/app/agent/rewind/rewind-context.tsx frontend/app/agent/rewind/rewind-preview-dialog.tsx frontend/app/agent/rewind/rewind-preview-dialog.test.tsx frontend/app/agent/assistant-ui/registry-thread.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx
git commit -m "feat(agent): preview and confirm message rewinds"
```

### Task 16: 集成 AgentContent、OpenCode 风格 Redo Dock 和 composer restore

**Files:**
- Create: `frontend/app/agent/rewind/redo-dock.tsx`
- Create: `frontend/app/agent/rewind/redo-dock.test.tsx`
- Modify: `frontend/app/agent/agent-content.tsx`
- Modify: `frontend/app/agent/agent-content.test.tsx`
- Modify: `frontend/app/agent/agent-chat-host.tsx`
- Modify: `frontend/app/agent/agent-chat-host-api.test.ts`

- [ ] **Step 1: 写 Redo Dock 失败测试**

覆盖：

- authoritative `rewindState.redo` 存在才显示；
- collapsed 文案 `Reverted N messages · M files`；
- `Redo` 始终可见，expand 后展示 operation/file summary 和被回退目标的原始 prompt；
- busy/frozen/applying 时不可重复点击；
- reload/cold resume 恢复 Dock；
- new prompt、conversation-only navigation、Redo success 的下一份 session_state
  移除 Dock；
- Dock 与 `/redo` 调用同一个 `controller.openRedo()`；
- Redo drift 打开 blocked preview，不能 apply、不能 Force。

- [ ] **Step 2: 写 AgentContent 端到端 renderer 失败测试**

覆盖：

- message Revert 打开 preview；
- `/rewind` 打开 selector，选择后进入同一 preview；
- clean Revert、Force Revert、Cancel；
- successful rewind response 的 `editorText` 通过现有 `ComposerTextRestore` 恢复；
- session A preview 请求期间切 B，A 的结果不显示；
- Redo Dock 位于 composer 上方，且不是 transient toast；
- mutation 完成后 UI 等 authoritative session_state，不设置本地 redo boolean。

- [ ] **Step 3: 运行测试并确认失败**

Run:

```bash
npx vitest run frontend/app/agent/rewind/redo-dock.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/agent-chat-host-api.test.ts
```

Expected: FAIL。

- [ ] **Step 4: 实现 Redo Dock**

```ts
export interface RedoDockProps {
    redo: AgentRedoView;
    busy: boolean;
    onRedo: () => void;
}
```

使用现有 composer 前置 stack 的视觉语言；按钮保持 `cursor-pointer`，不使用
`cursor-not-allowed`。Dock 的 placement 直接参考 OpenCode：始终在 composer 上方，
并可展开显示 `redo.targetPrompt` 与被回退文件。prompt 由 backend 从 durable selected
user entry 投影并持久化在 `AgentRedoView`，renderer 不从当前 composer/preview cache
重建。

- [ ] **Step 5: 在 AgentContent 挂唯一 coordinator**

`AgentContent`：

1. 用 `useAgentRewind()` 创建 controller；
2. 把 `rewindableTurnIds`、`openRewind`、busy 传给 `Thread`；
3. 把 `/rewind` callback 接到 `openSelector()`；
4. 把 `/redo` callback 和 Dock 都接到 `openRedo()`；
5. 把 `RewindSelector`、`RewindPreviewDialog` 放在同一 conversation surface；
6. 把 `RedoDock` 放在 `Thread.beforeComposer` stack 最前；
7. apply result 的 editorText 复用现有 `setAgentRestoredTextRequest()`。

rewind selector state 不混入当前 `AgentAttachedPanelState.selectorRequest`，避免
`SessionSelector` 的 non-tree/session fallback 被当作 fork。

- [ ] **Step 6: 运行 focused tests**

Run:

```bash
npx vitest run frontend/app/agent/rewind/redo-dock.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/agent-chat-host-api.test.ts
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add frontend/app/agent/rewind/redo-dock.tsx frontend/app/agent/rewind/redo-dock.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/agent-chat-host.tsx frontend/app/agent/agent-chat-host-api.test.ts
git commit -m "feat(agent): show persistent rewind redo dock"
```

### Task 17: 提供 frozen recovery 与 quota cleanup UI，且不引入 Force Recovery

**Files:**
- Create: `frontend/app/agent/rewind/recovery-dialog.tsx`
- Create: `frontend/app/agent/rewind/recovery-dialog.test.tsx`
- Create: `frontend/app/agent/rewind/checkpoint-quota-banner.tsx`
- Create: `frontend/app/agent/rewind/checkpoint-quota-banner.test.tsx`
- Create: `frontend/app/agent/rewind/checkpoint-quota-dialog.tsx`
- Create: `frontend/app/agent/rewind/checkpoint-quota-dialog.test.tsx`
- Modify: `frontend/app/agent/agent-content.tsx`
- Modify: `frontend/app/agent/agent-content.test.tsx`
- Modify: `frontend/app/agent/agent-runtime-client.ts`
- Modify: `frontend/app/agent/agent-runtime-client.test.ts`

- [ ] **Step 1: 写 recovery UI 失败测试**

覆盖：

- frozen session state 显示 operation ID、phase、affected paths 和 diagnostic；
- `Retry` 调 recovery retry；
- leaf 满足允许条件时显示 `Keep current and abandon operation`；
- corrupt record 才显示 `Quarantine corrupt record and keep current`；
- 不存在 Force Retry、Force Restore 或任何普通 Revert/Redo action；
- recovery 成功后的 authoritative session_state 解冻 UI；
- session switch/stale generation 丢弃旧 recovery response。
- soft quota exceeded 时显示 checkpoint storage banner 和 `Clean up unreferenced
  snapshots`；
- cleanup 只调用 backend owner-aware reconcile；若 referenced snapshots 仍超过
  quota，banner 保留并提示用户永久删除对应 session/清空 Agent session trash；
  archive 和普通移入 trash 都明确不会释放 quota，renderer 不提交 ref 名称。
- `Manage checkpoint storage` 只列 backend 返回的 `.trash` session；点击
  `Permanently delete` 必须经过二次确认，purge 成功前不乐观移除 row；
- active/archive session 不出现在 purge list；token stale、target 已恢复出 trash、
  recovery/GC busy 时零删除并刷新 diagnostics。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run frontend/app/agent/rewind/recovery-dialog.test.tsx frontend/app/agent/rewind/checkpoint-quota-banner.test.tsx frontend/app/agent/rewind/checkpoint-quota-dialog.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/agent-runtime-client.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 recovery client 和 dialog**

client 只调用 Task 13 的 diagnostics/resolve channel。resolve input 是：

```ts
interface AgentResolveWorkspaceRecoveryInput {
    sessionMetadata: AgentSessionMeta;
    operationId: string;
    action: "retry" | "abandon-current" | "quarantine-corrupt";
}
```

renderer 不提供 paths、phase 或 classifier 结果。dialog 按 backend 返回的
`allowedActions` 渲染按钮；任何 mutation 结果都等待 authoritative state。

client 另镜像 `cleanupWorkspaceCheckpoints()`；quota banner 只在
`rewindState.quota.status != "ok"` 时显示。cleanup 成功也不在本地隐藏 banner，而是
等待 authoritative quota state。`referenced-over-quota` 文案必须说明 cleanup 不会
删除仍被 session 引用的 snapshot，并提供跳转现有 session 管理/清空 trash 入口。
测试先 archive、再普通 delete，断言 quota 不变；只有显式 permanent purge 后再次
owner-aware cleanup 才能在 grace 规则允许时释放。

client 同时镜像 `listCheckpointStorageOwners()` 与 `purgeTrashedSession()`。
`CheckpointQuotaDialog` 只渲染 backend 返回的 trash owners；第一次点击打开
confirm surface，第二次显式确认才原样回传 session ID + opaque token。dialog 不接受
文件路径/ref，也不能永久删除 active/archive session。purge 完成后仍等待
authoritative quota/session state，不在本地推断已释放字节。

- [ ] **Step 4: 在 AgentContent 集成**

`rewindState.frozen` 时：

- 打开 recovery dialog；
- composer/send 和所有 Revert/Redo action disabled；
- tree/session inspect、export 等 read-only UI 保持可用；
- dialog 关闭后仍显示明显 frozen banner，直到 backend state 真正解冻。

- [ ] **Step 5: 运行 focused tests**

Run:

```bash
npx vitest run frontend/app/agent/rewind/recovery-dialog.test.tsx frontend/app/agent/rewind/checkpoint-quota-banner.test.tsx frontend/app/agent/rewind/checkpoint-quota-dialog.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/agent-runtime-client.test.ts
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add frontend/app/agent/rewind/recovery-dialog.tsx frontend/app/agent/rewind/recovery-dialog.test.tsx frontend/app/agent/rewind/checkpoint-quota-banner.tsx frontend/app/agent/rewind/checkpoint-quota-banner.test.tsx frontend/app/agent/rewind/checkpoint-quota-dialog.tsx frontend/app/agent/rewind/checkpoint-quota-dialog.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/agent-runtime-client.ts frontend/app/agent/agent-runtime-client.test.ts
git commit -m "feat(agent): surface workspace rewind recovery"
```

### Task 18: 增加多 Session、工具无关、跨平台门禁并完成 rollout 文档

**Files:**
- Create: `packages/coding-agent/workspace-rewind/multi-session.integration.test.ts`
- Create: `packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts`
- Create: `emain/agent-rewind.e2e.test.ts`
- Modify: `.github/workflows/agent-tests.yml`
- Modify: `docs/agent-runtime-architecture.md`
- Modify: `docs/agent-architecture.md`
- Modify: `docs/superpowers/specs/2026-07-28-agent-workspace-rewind-design.md`

- [ ] **Step 1: 写最终 multi-session 与工具无关测试**

必须包含：

- Session A/B 同一物理 workspace、不同文件：A Revert 不触碰 B 文件；
- A/B 重叠文件且 B 后写：A normal Revert 返回 forceable drift，零 mutation；
- explicit Force A 只触碰 preview 红名单，B 的其他路径和未列路径字节不变；
- preview 后 B 再写导致 token stale，Force 不执行；
- final drift check 后模拟未知第三方写，verification/recovery freeze，不做 whole-workspace reset；
- 两个 concurrent restore transaction 不能交错 safety/apply；
- bash、hosted PTY、CLI subagent 和一个未来名字的 fake tool 所造成的 workspace
  变化都只通过 turn boundary snapshot 被捕获；
- 修改/移除 `write`、`edit` tool result metadata 不影响 rewind manifest；
- active transferred PTY 使 checkpoint unavailable；
- Git 与 non-Git workspace 行为一致；
- user Git HEAD/index/stash bytes 与 mtime 不变。

- [ ] **Step 2: 写完整 Electron/UI E2E**

从真实 IPC client 模拟：

1. send 产生 checkpoint；
2. message Revert preview；
3. clean apply；
4. prompt 回 composer；
5. persisted Dock；
6. app/runtime reload；
7. Redo；
8. drift/Force/hard blocker；
9. cold session；
10. crash recovery；
11. quota exceeded → cleanup 不删 archive/trash owner → 二次确认 permanent purge →
    quota 释放。

同时断言 `/tree` 仍然只移动 conversation，不调用 snapshot restore。

- [ ] **Step 3: 运行新增门禁，失败时回到责任 Task**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/multi-session.integration.test.ts packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts emain/agent-rewind.e2e.test.ts
```

Expected: PASS，因为 Task 1–17 已完成。若失败，立即停止 Task 18，不在本 Task
开放式修改 production：

- capture/scope/quota → 回到 Task 3/4/5/8 增加 focused regression 后修复并提交；
- lease/lock/recovery/transaction → 回到 Task 6/11/12；
- IPC/state/startup gate → 回到 Task 13；
- renderer flow → 回到 Task 14–17。

修复后先重跑责任 Task 的 focused suite，再重跑本门禁。禁止放宽断言、silent skip，
也禁止把临时 production 修复混进 Task 18 的 test/docs commit。

- [ ] **Step 4: 加入 Linux/macOS/Windows CI matrix**

保留 Linux full suite；另加 workspace-rewind focused matrix：

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
```

matrix 执行整个 `packages/coding-agent/workspace-rewind`、main coordinator 和 UI
rewind suite。覆盖 symlink capability、case-only rename、atomic replace 和 directory
fsync；平台不支持的能力必须形成 explicit hard-blocker/capability test，不能静默声称
已恢复。

- [ ] **Step 5: 更新架构和 rollout 文档**

文档明确：

- OpenCode / pi-rewind 的参考边界；
- snapshot coverage 和非目标副作用；
- shared workspace 下普通 Revert 与 Force 的不同保证；
- exact warning `files changed on disk since the agent last wrote them`；
- snapshot store 路径、5 GiB soft quota、owner-aware cleanup；
- recovery 操作和没有 Force Recovery/Force Redo；
- internal flag 与默认启用条件。

把旧文档中任何“`:rewind` 由遗留 filebackup 恢复”或“tool patch 是权威数据”的描述
标记为 superseded。

- [ ] **Step 6: 运行全量验证**

Run:

```bash
npx prettier --check packages/coding-agent/workspace-rewind emain/agent-rewind-service.ts emain/agent-session-state-broadcaster.ts frontend/app/agent/rewind frontend/app/agent/agent-content.tsx frontend/app/agent/agent-chat-host.tsx frontend/app/agent/assistant-ui/registry-thread.tsx
npx vitest run
npm run build:dev
```

Expected: PASS；Prettier、完整 Vitest 和 development build 全部 exit 0。

- [ ] **Step 7: 检查安全不变量和禁止依赖**

Run:

```bash
rg -n "reset --hard|clean -fd|checkout-index|ChangeOperation|beforeContentHash|write.*edit" packages/coding-agent/workspace-rewind emain/agent-rewind-service.ts frontend/app/agent/rewind
```

Expected:

- 没有 workspace-wide destructive Git command；
- `ChangeOperation`、`write`、`edit` 不出现在权威 capture/plan/apply 依赖中；
- 每个搜索结果都经过人工核对，没有绕过 turn-boundary snapshot authority。

- [ ] **Step 8: Commit**

```bash
git add packages/coding-agent/workspace-rewind/multi-session.integration.test.ts packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts emain/agent-rewind.e2e.test.ts .github/workflows/agent-tests.yml docs/agent-runtime-architecture.md docs/agent-architecture.md docs/superpowers/specs/2026-07-28-agent-workspace-rewind-design.md
git commit -m "test(agent): gate workspace rewind rollout"
```

## 依赖与并行执行建议

```text
Task 1
  ├─ Task 2 ─ Task 3 ─ Task 4 ─ Task 5
  └─ Task 7

Task 5
  ├─ Task 6
  └─ Task 9 ─ Task 10 ─ Task 11

Task 6 + Task 7
  └─ Task 8

Task 6 + Task 8 + Task 9 + Task 10 + Task 11
  └─ Task 12 ─ Task 13

Task 13
  └─ Task 14 ─ Task 15 ─ Task 16 ─ Task 17

全部完成
  └─ Task 18
```

可并行：

- Task 2 与 Task 7；
- Task 5 完成后，Task 6 与 Task 9 的纯单元部分；
- Task 14 的纯 renderer hydration/selector 与 Task 13 后半 IPC 接线；
- Task 15 的静态 dialog/message UI 与 Task 12 backend transaction。

不可越过：

- UI 不得在 Task 12/13 之前直接调用未经过 token/transaction 的 mutation；
- checkpoint manager 不得在 Task 7 user-turn lifecycle 完成前改用 `turn_end` 猜边界；
- restore/recovery 不得在 durable refs、workspace lock 和 path writer 之前接入真实文件；
- 默认启用不得早于 Task 18 全平台、多 Session、crash recovery 门禁。

## 完成定义

- 每个 durable user turn 都有一个 available 或 unavailable terminal checkpoint；
- `/tree` conversation-only，`/rewind` 与消息 Revert code+conversation；
- preview 是 server-authored，apply 不信任 renderer paths；
- ordinary Revert 不覆盖检测到的其他 Session/人工 drift；
- Force 只覆盖 exact red-listed paths，并可用一步 Redo 恢复 force-time bytes；
- hard blocker、Redo drift、Recovery 都没有 Force；
- crash 后不会留下“文件已变但 session 看起来未变”且无法诊断的静默状态；
- live/cold/reload 行为一致；
- user Git state 完全不被修改；
- bash、PTY、subagent 和未来工具的文件变化由 turn boundary 捕获；
- focused matrix、full Vitest 和 `npm run build:dev` 全部通过。
