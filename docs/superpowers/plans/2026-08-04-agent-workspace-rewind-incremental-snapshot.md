# Agent Workspace Rewind Incremental Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Agent Workspace Rewind 的 turn 边界快照从每个 Session 两次全量扫描，替换为 canonical workspace 级共享的增量 immutable snapshot tracker，同时保持现有 checkpoint、Revert、Undo、Redo 和冲突检测语义不变。

**Architecture:** 保留 `WorkspaceSnapshotStore` 作为 content-addressed object store、完整 reconcile 和 restore reader；新增共享 `WorkspaceSnapshotTracker`，用可检测连续性的 filesystem change feed 找出候选变化，以 anchored read 验证 path state，并 copy-on-write 更新 workspace tree 与 manifest v2 state tree。任何 change-feed gap、scope invalidation、racy capture 或 tracker state 校验失败都退回现有 full reconcile；reconcile 仍失败时继续由 checkpoint manager 写 `unavailable`，绝不把不确定解释成空 diff。

**Tech Stack:** TypeScript, Node.js filesystem APIs, `@parcel/watcher`, Git plumbing in a private bare object store, Electron main process, Vitest

---

## 实施约束

- 设计依据是 `docs/superpowers/specs/2026-08-04-agent-workspace-rewind-incremental-snapshot-design.md`；上层产品语义继续以 `docs/superpowers/specs/2026-07-28-agent-workspace-rewind-design.md` 为准。
- 不增加环境开关。新路径只有在 correctness、failure 和 benchmark gates 全部通过后才替换 checkpoint manager 的默认 capture source。
- 不修改 `WorkspaceCheckpointV1`、`WorkspaceSnapshotRefV1`、`WorkspacePathChangeV1`、session entry、IPC 或 UI schema。
- `@parcel/watcher` 的 callback subscription 只用于降低延迟；持久化 snapshot cursor 和 `getEventsSince()` 才能构成可检测 continuity 的 change feed。调用失败、cursor 丢失或 backend 不支持历史连续性都返回 `gap`。
- change feed 只证明“哪些 path 需要重新验证”，不能直接生成 checkpoint。所有 file/symlink bytes、mode、identity 与 absence 仍由 anchored filesystem reader 确认。
- `.git/index`、ignore input、nested `.git`、workspace identity/incarnation 或 scope policy 变化属于 scope invalidation，进入 full reconcile，不在第一版解析增量 Git index。
- healthy warm、无改动 turn 不允许调用 `discoverWorkspaceScope()`、遍历全部 workspace、遍历全部 refs/objects，或启动 anchored reader 子进程。
- 同一 canonical workspace 的 Session 共享 tracker 和 store，但 session checkpoint、pending boundary、semantic leaf 和恢复权限继续独立。
- v1 flat manifest 只读兼容；新 tracker 只写 manifest v2。项目仍是 POC，不为更早的、缺失 checkpoint 的历史会话补数据。

## 目标文件结构

```text
packages/coding-agent/workspace-rewind/
  snapshot-store.ts                  # existing full reconcile/object store/reader
  stored-manifest.ts                 # v1/v2 manifest decode and path-state access
  incremental-tree.ts                # copy-on-write workspace/state Merkle updates
  workspace-change-feed.ts           # continuity contract and @parcel/watcher adapter
  incremental-path-capture.ts        # dirty-path scope classification and anchored capture
  workspace-tracker-state.ts         # durable trusted version/cursor binding
  workspace-snapshot-tracker.ts      # consistency barrier, reconcile fallback, current version
  workspace-tracker-registry.ts      # one ref-counted tracker per canonical workspace
  snapshot-quota-accounting.ts       # cached exact store usage and write reservation
  snapshot-equivalence.integration.test.ts
  snapshot-performance.test.ts

emain/
  agent-rewind-feature.ts            # acquire shared tracker lease for live runtimes
  agent-ipc.ts                       # pass tracker capture source to checkpoint manager

scripts/
  benchmark-agent-rewind-snapshots.ts
```

测试文件与模块同目录放置。实现过程中不拆分 restore engine、recovery、IPC 或 renderer；这些消费者只做回归验证。

### Task 1: 固化 full capture 基线与可替换 capture source 契约

**Files:**
- Create: `packages/coding-agent/workspace-rewind/snapshot-source.ts`
- Create: `packages/coding-agent/workspace-rewind/snapshot-source.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/checkpoint-manager.ts:47-63,130-220`
- Modify: `packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts`

- [ ] **Step 1: 写失败测试，锁定 checkpoint manager 只依赖 capture source**

在 `snapshot-source.test.ts` 和 `checkpoint-manager.test.ts` 增加：

```ts
const source: WorkspaceCheckpointSnapshotSource = {
    capture: vi
        .fn()
        .mockResolvedValueOnce({ ref: before, coverage })
        .mockResolvedValueOnce({ ref: after, coverage }),
    diff: vi.fn().mockResolvedValue([{ path: "README.md", before: beforeState, after: afterState }]),
};

expect(source.capture).toHaveBeenNthCalledWith(1, { profile: "pre-turn" });
expect(source.capture).toHaveBeenNthCalledWith(2, { profile: "terminal" });
expect(source.diff).toHaveBeenCalledWith(before, after);
expect(decodeWorkspaceCheckpointEntry(sessionEntries.at(-1))?.status).toBe("available");
```

同时保留一个断言证明 `PendingBoundaryStore`、identity 和 snapshot verification 仍使用真实 `WorkspaceSnapshotStore`，capture source 不获得 restore 写权限。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/snapshot-source.test.ts packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts
```

Expected: FAIL，因为 manager 目前直接调用 `input.store.capture()` 和 `input.store.diff()`。

- [ ] **Step 3: 添加最小 capture source 接口并保持 full-store adapter**

`snapshot-source.ts` 定义：

```ts
import type { CaptureWorkspaceOptions } from "./snapshot-store";
import type {
    WorkspacePathChangeV1,
    WorkspaceSnapshotCoverage,
    WorkspaceSnapshotRefV1,
} from "./types";

export interface WorkspaceCheckpointSnapshotSource {
    capture(options: CaptureWorkspaceOptions): Promise<{
        ref: WorkspaceSnapshotRefV1;
        coverage: WorkspaceSnapshotCoverage;
    }>;
    diff(before: WorkspaceSnapshotRefV1, after: WorkspaceSnapshotRefV1): Promise<WorkspacePathChangeV1[]>;
}
```

给 `registerWorkspaceCheckpointManager` 增加 `snapshotSource?: WorkspaceCheckpointSnapshotSource`，函数开头使用：

```ts
const snapshotSource = input.snapshotSource ?? input.store;
```

只把两个 capture 和一个 diff 调用替换为 `snapshotSource`。pending store、identity、recovery 和 session 写入保持原样。

- [ ] **Step 4: 运行目标测试并确认通过**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/snapshot-source.test.ts packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts
```

Expected: PASS；现有 full capture 仍是默认路径。

- [ ] **Step 5: 提交**

```bash
git add packages/coding-agent/workspace-rewind/snapshot-source.ts packages/coding-agent/workspace-rewind/snapshot-source.test.ts packages/coding-agent/workspace-rewind/checkpoint-manager.ts packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts
git commit -m "refactor(agent): isolate checkpoint snapshot source"
```

### Task 2: 建立可检测 continuity 的 workspace change feed

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `packages/coding-agent/workspace-rewind/workspace-change-feed.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-change-feed-storage.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-change-feed.test.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-change-feed.integration.test.ts`

- [ ] **Step 1: 把已经存在于 lockfile 的 `@parcel/watcher` 声明为直接 dependency**

Run:

```bash
npm install @parcel/watcher@^2.5.1 --save
```

Expected: `package.json` 的 `dependencies` 出现 `@parcel/watcher`，lockfile root package dependency 同步更新；不得依赖 Monaco 的传递依赖。

- [ ] **Step 2: 写失败的 contract tests**

测试 fake backend 下四种结果：

```ts
expect(await feed.readChanges()).toEqual({
    status: "complete",
    changedPaths: ["README.md", "src/index.ts"],
    candidateCursor: expect.any(String),
});

await expect(feed.commitCursor(candidateCursor)).resolves.toBeUndefined();
expect(await feed.readChanges()).toMatchObject({ status: "complete", changedPaths: [] });
expect(await missingCursorFeed.readChanges()).toEqual({ status: "gap", reason: "cursor-missing" });
expect(await failedQueryFeed.readChanges()).toEqual({ status: "gap", reason: "query-failed" });
```

还要覆盖：absolute path 转为 UTF-8 relative path、workspace 外 path 触发 `gap`、重复/coalesced event 去重、`.git/index` 与任意 `.gitignore` 进入 `scopeInvalidated: true`、callback error 原子地把 feed 标为 gap。

reconcile 生命周期还要覆盖：必须先 `prepareForReconcile()`，再执行外部 full reconcile，最后调用
`initializeAfterReconcile()`；full reconcile 返回后、initialize 开始前发生的变更仍然必须出现在下一次
`readChanges()` 中。重复 prepare、未 prepare 的 initialize、任一阶段失败和 dispose race 都必须 fail closed。

- [ ] **Step 3: 运行 contract tests 并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-change-feed.test.ts
```

Expected: FAIL，因为 change-feed 类型和实现不存在。

- [ ] **Step 4: 实现 feed 接口与 Parcel adapter**

导出稳定契约：

```ts
export type WorkspaceChangeRead =
    | {
          status: "complete";
          changedPaths: string[];
          scopeInvalidated: boolean;
          candidateCursor: string;
      }
    | { status: "gap"; reason: "cold-start" | "cursor-missing" | "query-failed" | "unsafe-path" };

export interface WorkspaceChangeFeed {
    prepareForReconcile(): Promise<void>;
    initializeAfterReconcile(): Promise<void>;
    readChanges(): Promise<WorkspaceChangeRead>;
    commitCursor(candidateCursor: string): Promise<void>;
    markGap(): void;
    dispose(): Promise<void>;
}
```

安全的 baseline 顺序固定为 `prepareForReconcile()` → 外部 full reconcile →
`initializeAfterReconcile()`。prepare 在 reconcile 前建立 subscription 和 pre-reconcile cursor；initialize 写
post-reconcile cursor，并查询两者之间的历史事件。旧的“先 full reconcile，再初始化 cursor”顺序存在一个
无法观测的窗口：full reconcile 返回后、cursor 建立前的修改既不属于 baseline，也不一定进入后续历史查询，
因此明确禁止。

`ParcelWorkspaceChangeFeed` 把 cursor 写入 private staging，再通过 cwd-inode anchored、no-follow 的原子操作发布到
`<storeRoot>/tracker`。candidate 必须绑定生成时的 entry identity 和内容 hash；commit 拒绝 inode/content
替换、hardlink、非 regular、非 private、stale/foreign candidate 以及 tracker directory exchange。
tracker 目录由同一 anchored journal primitive 在 private `storeRoot` 下建立，live feed instance 固定其目录
identity，并在 committed read、candidate publication 和 commit 间拒绝 root exchange；不得经由 storeRoot symlink
建立 tracker。原子写在 rename 前失败必须删除随机 temporary entry；下一次 prepare 按名称清理保留格式的
candidate 和 journal temporary entry，不打开或信任其内容。candidate 校验/提交失败会撤销内存 candidate，使一次新的
prepare → full reconcile → initialize 可以恢复，而不引入额外 recovery protocol。
subscription callback 使用有上限的去重 set；溢出必须进入 gap。`readChanges()` 把历史 query 与 callback hints
取并集，只有 tracker 完成 path capture 和二次验证后才允许 `commitCursor()`。Windows 在 owner-only ACL
实现前硬禁用 private cursor storage，不允许把 mode bit 当作 ACL 等价物。

initialize 和 candidate commit 必须绑定开始时的 monotonic continuity generation，并在每个 awaited storage
mutation 后、发布任何内存成功状态前复核 generation、gap 和 disposed。publication 期间出现 callback error、
overflow 或 dispose 时，即使磁盘原子写已经完成也必须返回失败并把 lifecycle 标为 uninitialized；只有新的
prepare → full reconcile → initialize 可以重新信任磁盘 cursor。prepare 自身也使用同一 generation fence；若
dispose 与 pre-reconcile publication 竞争，late publication 必须由 prepare 清理且不得成为 prepared state。

v1 的 cursor trust 只存在于当前 feed instance。新建或重启 feed 不读取磁盘 `committed.cursor` 作为可信
continuity，必须返回 `cold-start` 并执行一次 prepare → full reconcile → initialize。明确否决为 watcher cursor
再建立一套 persistent trust marker/recovery protocol；跨进程 startup 的低频 full reconcile 换取更小且可证明的
崩溃状态面，warm instance 内的 turn capture 仍然走增量路径。

- [ ] **Step 5: 添加真实 filesystem integration tests**

用临时目录覆盖：create/update/delete/rename、App 停止监听期间修改后重建 feed、cursor 文件删除、回调报错、连续 1,000 次写入的去重。重建 feed 必须 fail closed：

```ts
await first.dispose();
await writeFile(join(workspace, "offline.txt"), "offline");
const restarted = await ParcelWorkspaceChangeFeed.open(input);
expect(await restarted.readChanges()).toEqual({ status: "gap", reason: "cold-start" });
await restarted.prepareForReconcile();
await fullReconcile();
await restarted.initializeAfterReconcile();
expect(await restarted.readChanges()).toMatchObject({ status: "complete" });
```

- [ ] **Step 6: 运行 change-feed tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-change-feed.test.ts packages/coding-agent/workspace-rewind/workspace-change-feed.integration.test.ts
```

Expected: 支持原生 FSEvents/backend 的平台严格 PASS，并断言完整 path 集合；明确检测为不支持的平台只接受显式
`gap`/error，不接受错误的空数组。Windows 在 owner-only ACL 实现前必须显式 hard block。

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json packages/coding-agent/workspace-rewind/workspace-change-feed.ts packages/coding-agent/workspace-rewind/workspace-change-feed-storage.ts packages/coding-agent/workspace-rewind/workspace-change-feed.test.ts packages/coding-agent/workspace-rewind/workspace-change-feed.integration.test.ts
git commit -m "feat(agent): add durable workspace change feed"
```

### Task 3: 增加 manifest v2 的增量 path-state tree，同时只读兼容 v1

**Files:**
- Create: `packages/coding-agent/workspace-rewind/stored-manifest.ts`
- Create: `packages/coding-agent/workspace-rewind/stored-manifest.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.ts:100-120,395-430,1100-1190,1800-1835`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.test.ts`

- [ ] **Step 1: 写失败测试，锁定 v1/v2 decode 与 lookup 等价性**

定义同一组 states，分别构造 v1 flat manifest 和 v2 state tree，断言：

```ts
for (const path of ["README.md", "bin/run", "link", "ignored.log", "missing.txt"]) {
    expect(await v2Reader.readPathState(path)).toEqual(await v1Reader.readPathState(path));
}
expect(await v2Reader.diff(v2Before, v2After)).toEqual(await v1Reader.diff(v1Before, v1After));
expect(() => decodeStoredManifest(nonCanonicalBytes)).toThrow("Snapshot scope manifest is not canonical");
```

覆盖 file、executable file、symlink、excluded 与 absent；v2 descriptor identity、OID、state blob schema 不合法时 fail closed。

- [ ] **Step 2: 运行 manifest tests 并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/stored-manifest.test.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts
```

Expected: FAIL，因为 stored manifest 仍是 `snapshot-store.ts` 内的私有 flat v1 interface。

- [ ] **Step 3: 提取 reader 并定义 manifest v2**

`stored-manifest.ts` 导出：

```ts
export interface StoredScopeManifestV1 {
    schemaversion: 1;
    workspaceidentity: string;
    workspaceincarnation: string;
    scope: WorkspaceScopeManifest;
    entries: Array<{ path: string; state: CapturedPathStateV1 }>;
}

export interface StoredScopeManifestV2 {
    schemaversion: 2;
    workspaceidentity: string;
    workspaceincarnation: string;
    scope: WorkspaceScopeManifest;
    coverage: StoredSnapshotCoverage;
    statetree: string;
}

export interface StoredSnapshotCoverage {
    complete: boolean;
    eligibleentrycount: number;
    exclusions: StoredSnapshotCoverageExclusion[];
}
```

每个 state-tree leaf 的 blob 必须是 canonical JSON：

```ts
export interface StoredPathStateV1 {
    schemaversion: 1;
    state: CapturedPathStateV1;
}
```

state tree path 与 workspace relative path 一一对应。absence 不写 leaf；lookup 缺失返回 `{ state: "absent" }`。excluded path 写 state leaf，但不写 workspace tree leaf。

wire manifest 保持全 lowercase；reader 完成 canonical validation 后通过 domain accessor 把
`eligibleentrycount`、`pathbytesbase64` 等字段转换为现有 camelCase coverage。snapshot descriptor
的格式按版本严格区分：v1 只有 `scope-manifest` 与 `workspace`；v2 还必须有名为 `state` 的 tree
entry，且 OID 与 manifest 的 `statetree` 一致。这个直接引用是 state graph 被 owner ref 和 Git GC
识别为 reachable 的依据，不能只把 state-tree OID 放在 JSON 字符串里。

- [ ] **Step 4: 让 snapshot store 的 readers 同时消费 v1/v2**

把 `readPathState()`、`diff()`、`verifyWorkspaceTree()` 和 snapshot verification 改为调用 `StoredManifestReader`。v2 diff 使用 state-tree Merkle OID 跳过相同 subtree；不得把 v2 展平成全量 Map。v1 继续沿用 flat Map 逻辑。完整 verification 以固定 512 leaf 的 bounded `git cat-file --batch` 读取 state blobs，不允许 per-leaf Git process。

- [ ] **Step 5: 运行 snapshot reader 回归测试**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/stored-manifest.test.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts packages/coding-agent/workspace-rewind/restore-plan.test.ts packages/coding-agent/workspace-rewind/diff-preview.test.ts
```

Expected: PASS；现有 full capture 仍写 v1，新 reader 可读取两种格式。

- [ ] **Step 6: 提交**

```bash
git add packages/coding-agent/workspace-rewind/stored-manifest.ts packages/coding-agent/workspace-rewind/stored-manifest.test.ts packages/coding-agent/workspace-rewind/snapshot-store.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts
git commit -m "feat(agent): read incremental snapshot manifests"
```

### Task 4: 实现 copy-on-write workspace tree 与 state tree 更新

**Files:**
- Create: `packages/coding-agent/workspace-rewind/incremental-tree.ts`
- Create: `packages/coding-agent/workspace-rewind/incremental-tree.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.test.ts`

- [ ] **Step 1: 写失败测试，锁定结构共享和精确变更**

以含 `docs/`、`src/`、`assets/` 的 base tree 为 fixture，只更新 `docs/README.md`，断言：

```ts
expect(result.workspaceTree).not.toBe(base.tree);
expect(result.stateTree).not.toBe(base.stateTree);
expect(await childTreeOid(result.workspaceTree, "src")).toBe(await childTreeOid(base.tree, "src"));
expect(await childTreeOid(result.workspaceTree, "assets")).toBe(await childTreeOid(base.tree, "assets"));
expect(result.writtenTreePaths).toEqual(["docs", ""]);
```

覆盖 create、write、delete、rename（delete old + create new）、executable bit、symlink、excluded、file↔directory hard block，以及不同输入顺序产生相同 OID。

- [ ] **Step 2: 运行 incremental-tree tests 并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/incremental-tree.test.ts
```

Expected: FAIL，因为 copy-on-write tree writer 不存在。

- [ ] **Step 3: 实现纯粹的 path mutation 归一化**

导出：

```ts
export interface IncrementalPathMutation {
    path: string;
    state: CapturedPathStateV1;
}

export function normalizeIncrementalMutations(
    mutations: IncrementalPathMutation[]
): IncrementalPathMutation[];
```

该函数执行 UTF-8 relative path 校验、按 raw bytes 排序、拒绝重复 path，并在同一 batch 同时出现 ancestor leaf 与 descendant 时 hard block。

- [ ] **Step 4: 实现 Merkle copy-on-write writer**

导出：

```ts
export async function applyIncrementalTrees(input: {
    baseWorkspaceTree: string;
    baseStateTree: string;
    mutations: IncrementalPathMutation[];
    objects: IncrementalTreeObjectAccess;
}): Promise<{ workspaceTree: string; stateTree: string; objectIds: string[] }>;
```

算法只读取 mutation path 的祖先 tree。`file`/`symlink` 写 workspace leaf 与 state leaf；`excluded` 只写 state leaf；`absent` 删除两棵树对应 leaf；从叶到根重写受影响 tree，未涉及 subtree 直接复用原 OID。

- [ ] **Step 5: 在 snapshot store 中增加 v2 version commit primitive**

新增 package-internal 方法：

```ts
commitIncrementalSnapshot(input: {
    base: WorkspaceSnapshotRefV1;
    mutations: IncrementalPathMutation[];
    scope: WorkspaceScopeManifest;
    coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
    newlyHashedBytes: number;
    profile: CaptureWorkspaceOptions["profile"];
}): Promise<{ ref: WorkspaceSnapshotRefV1; coverage: WorkspaceSnapshotCoverage }>;
```

方法在 workspace lock 内写 v2 manifest blob、带 `state` direct tree entry 的三项 snapshot descriptor、durable objects 和 owner ref；`state` OID 必须等于 manifest `statetree`。identity、free-space、quota reservation 与 canonical workspace 校验保持 fail closed。

- [ ] **Step 6: 运行 tree 与 store tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/incremental-tree.test.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts
```

Expected: PASS；single-path update 的新 tree object 数只与路径深度相关。

- [ ] **Step 7: 提交**

```bash
git add packages/coding-agent/workspace-rewind/incremental-tree.ts packages/coding-agent/workspace-rewind/incremental-tree.test.ts packages/coding-agent/workspace-rewind/snapshot-store.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts
git commit -m "feat(agent): write copy-on-write workspace snapshots"
```

### Task 5: 增量捕获 dirty path，scope 变化明确降级 reconcile

**Files:**
- Create: `packages/coding-agent/workspace-rewind/incremental-path-capture.ts`
- Create: `packages/coding-agent/workspace-rewind/incremental-path-capture.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/anchored-reader.ts`
- Modify: `packages/coding-agent/workspace-rewind/anchored-reader.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-scope.ts`
- Modify: `packages/coding-agent/workspace-rewind/workspace-scope.test.ts`

- [ ] **Step 1: 写失败测试，锁定 dirty-path capture 结果**

核心断言：

```ts
expect(await capture.capture(["README.md", "deleted.txt"])).toMatchObject({
    status: "captured",
    mutations: [
        { path: "README.md", state: { state: "file", executable: false, oid: expect.any(String) } },
        { path: "deleted.txt", state: { state: "absent" } },
    ],
});
expect(await capture.capture([".gitignore"])).toEqual({ status: "reconcile", reason: "scope-invalidated" });
expect(await capture.capture(["nested/.git/config"])).toEqual({
    status: "reconcile",
    reason: "scope-invalidated",
});
```

覆盖 binary、symlink、mode-only change、new directory subtree、ignored file、oversized untracked、hard link、non-UTF-8 path、same-size restored-mtime rewrite 和 path 在读取中变化。

- [ ] **Step 2: 运行 path capture tests 并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/incremental-path-capture.test.ts
```

Expected: FAIL，因为增量 scope classifier 不存在。

- [ ] **Step 3: 提取可复用的 batch anchored reader**

让 `anchored-reader.ts` 接收一组已校验 relative path，按 parent 分组后使用固定上限 worker pool：

```ts
export const IncrementalReaderConcurrency = 8;
```

同一 capture 最多同时运行 8 个 worker；无 dirty path 不启动 worker。复用现有 identity、racy window、blob integrity 与 symlink 安全检查，不另写一套读取逻辑。

- [ ] **Step 4: 实现增量 scope classifier**

`IncrementalPathCapture.capture(paths)` 的结果类型：

```ts
export type IncrementalPathCaptureResult =
    | {
          status: "captured";
          mutations: IncrementalPathMutation[];
          newlyHashedBytes: number;
      }
    | { status: "reconcile"; reason: "scope-invalidated" | "unstable-path" | "unsafe-evidence" };
```

Git workspace 对候选 paths 执行 batch `git ls-files -z --cached -- <paths>` 和 `git check-ignore -z --stdin`；non-Git workspace 使用当前 ignore policy。目录 create/rename 只枚举该 dirty subtree，并遵守 `maxEntries` 与 byte budget。`.git/index`、ignore input、nested `.git`、root identity 变化直接返回 reconcile。

- [ ] **Step 5: 运行安全与回归测试**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/incremental-path-capture.test.ts packages/coding-agent/workspace-rewind/anchored-reader.test.ts packages/coding-agent/workspace-rewind/workspace-scope.test.ts
```

Expected: PASS；worker concurrency 峰值不超过 8，0 dirty path 为 0 worker。

- [ ] **Step 6: 提交**

```bash
git add packages/coding-agent/workspace-rewind/incremental-path-capture.ts packages/coding-agent/workspace-rewind/incremental-path-capture.test.ts packages/coding-agent/workspace-rewind/anchored-reader.ts packages/coding-agent/workspace-rewind/anchored-reader.test.ts packages/coding-agent/workspace-rewind/workspace-scope.ts packages/coding-agent/workspace-rewind/workspace-scope.test.ts
git commit -m "feat(agent): capture workspace dirty paths incrementally"
```

### Task 6: 实现 tracker consistency barrier 与 full reconcile fallback

**Files:**
- Create: `packages/coding-agent/workspace-rewind/workspace-tracker-state.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-tracker-state.test.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-snapshot-tracker.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-snapshot-tracker.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.test.ts`

- [ ] **Step 1: 写失败测试，锁定 tracker 状态机**

覆盖：无可信 state 的 cold start 做一次 full reconcile；App/runtime 重建能验证并恢复 durable current ref；warm empty capture 直接复用 current ref；dirty capture 写新 v2 ref；feed gap、scope invalidation、path unstable 触发 full reconcile；reconcile 失败向上抛 `WorkspaceSnapshotStoreError`。

```ts
await expect(tracker.capture({ profile: "pre-turn" })).resolves.toEqual({ ref: v1, coverage });
await expect(tracker.capture({ profile: "terminal" })).resolves.toEqual({ ref: v1, coverage });
expect(fullReconcile).toHaveBeenCalledTimes(1);
expect(pathCapture.capture).not.toHaveBeenCalled();
```

还要模拟“同一 path 在 candidate cursor 后再次修改”，断言 tracker 二次捕获后才 commit；连续两次不稳定后 full reconcile，而不是提交旧 blob。

- [ ] **Step 2: 运行 tracker tests 并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-snapshot-tracker.test.ts
```

Expected: FAIL，因为 tracker 不存在。

- [ ] **Step 3: 把现有完整 capture 显式命名为 reconcile primitive**

在 store 内保留公开兼容的 `capture()`，同时增加：

```ts
captureFullReconcile(options: CaptureWorkspaceOptions): Promise<{
    ref: WorkspaceSnapshotRefV1;
    coverage: WorkspaceSnapshotCoverage;
}>;
```

两者此时仍调用同一个现有 full implementation。tracker 只调用 `captureFullReconcile()`；后续 checkpoint manager 改用 tracker 后，`capture()` 不再位于 turn 热路径。

- [ ] **Step 4: 实现 durable tracker state**

`workspace-tracker-state.ts` 把以下 canonical JSON 原子写入 `<storeRoot>/tracker/state-v1.json`：

```ts
export interface StoredWorkspaceTrackerStateV1 {
    schemaversion: 1;
    workspaceidentity: string;
    workspaceincarnation: string;
    current: WorkspaceSnapshotRefV1;
    coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
    cursorhash: string;
}
```

加载时必须验证 identity/incarnation、owned snapshot、manifest/tree durability，以及 cursor 文件 SHA-256。任何字段、object 或 cursor 不匹配都返回 `untrusted` 并触发 full reconcile，不修补或猜测 state。incremental commit 的 durable 顺序固定为：snapshot objects/ref → candidate cursor → tracker state；只有三者都完成后才更新内存 current。

- [ ] **Step 5: 实现串行、可重试的 consistency barrier**

tracker 实现 `WorkspaceCheckpointSnapshotSource`，内部 capture 流程固定为：

```text
no trusted current -> prepare feed -> full reconcile -> initialize feed cursor -> current
read changes -> gap/scope invalidated -> prepare feed -> full reconcile -> initialize feed cursor
read changes -> empty -> reuse current
capture dirty paths -> write candidate cursor -> read/validate changes since previous cursor
new evidence -> merge dirty set and retry once
stable -> commitIncrementalSnapshot -> commit cursor -> current = new ref
still unstable -> full reconcile
```

所有 fallback reconcile 都必须复用同一生命周期；禁止先 reconcile 后 prepare。prepare 或 initialize
失败时保持 gap，不能发布可信 current。reconcile 本身失败时也不得调用 initialize；tracker 只向 checkpoint
manager 传播 unavailable 错误。

同一 tracker 的 capture 使用一个 promise queue 串行化，Agent 整个 turn 不持锁。启动时可以加载 durable
snapshot state 供校验，但 v1 feed instance 的 cursor trust 不跨进程，因此每次 feed startup 仍执行一次 full
reconcile 建立新 baseline；之后的 warm capture 才复用 current。`diff()` 直接委托 store。

- [ ] **Step 6: 测试 fail-closed 行为与 checkpoint unavailable 映射**

在 checkpoint manager test 中注入最终 reconcile 失败：

```ts
source.capture = vi.fn().mockRejectedValue(
    new WorkspaceSnapshotStoreError("unstable_file", "Workspace did not settle")
);
expect(decodeWorkspaceCheckpointEntry(sessionEntries.at(-1))).toMatchObject({
    status: "unavailable",
    reasonCode: "unstable_file",
});
```

- [ ] **Step 7: 运行 tracker/store/manager tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-tracker-state.test.ts packages/coding-agent/workspace-rewind/workspace-snapshot-tracker.test.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts
```

Expected: PASS；warm empty capture 的 full reconcile、scope discovery、path capture 调用数都为 0。

- [ ] **Step 8: 提交**

```bash
git add packages/coding-agent/workspace-rewind/workspace-tracker-state.ts packages/coding-agent/workspace-rewind/workspace-tracker-state.test.ts packages/coding-agent/workspace-rewind/workspace-snapshot-tracker.ts packages/coding-agent/workspace-rewind/workspace-snapshot-tracker.test.ts packages/coding-agent/workspace-rewind/snapshot-store.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts packages/coding-agent/workspace-rewind/checkpoint-manager.test.ts
git commit -m "feat(agent): add fail-closed incremental snapshot tracker"
```

### Task 7: 为 snapshot store 增加增量 quota accounting

**Files:**
- Create: `packages/coding-agent/workspace-rewind/snapshot-quota-accounting.ts`
- Create: `packages/coding-agent/workspace-rewind/snapshot-quota-accounting.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-store.ts:680-770`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-retention.ts`
- Modify: `packages/coding-agent/workspace-rewind/snapshot-retention.test.ts`

- [ ] **Step 1: 写失败测试，锁定 cached accounting 与 hard reservation**

```ts
const quota = await SnapshotQuotaAccounting.open({ storeRoot, maxBytes: 5_000 });
await quota.reconcileExactUsage();
await expect(quota.reserve({ contentBytes: 4_000, metadataBytes: 512 })).resolves.toBeDefined();
await expect(quota.reserve({ contentBytes: 1_000, metadataBytes: 512 })).rejects.toMatchObject({
    code: "quota_exceeded",
});
```

覆盖 crash 后残留 reservation、object 已存在不重复计费、retention/gc 后 exact reconcile、accounting 文件损坏时重新 exact scan，以及多个 Session 共用同一个 accounting instance。

- [ ] **Step 2: 运行 quota tests 并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/snapshot-quota-accounting.test.ts packages/coding-agent/workspace-rewind/snapshot-retention.test.ts
```

Expected: FAIL，因为每次 capture 仍调用全量 `getQuotaStatus()`。

- [ ] **Step 3: 实现 durable cached usage 和 write reservation**

accounting state 存在 `<storeRoot>/tracker/quota-v1.json`，内容只包含 lowercase JSON fields：

```ts
interface StoredQuotaStateV1 {
    schemaversion: 1;
    measuredbytes: number;
    measuredat: string;
    generation: string;
}
```

首次启动、state 损坏、retention/gc 完成后执行 existing exact scan。正常增量 commit 在写入前按 content bytes + bounded tree/manifest overhead 预留，写完按新 loose object 实际 bytes 提交；超限在任何 object write 前拒绝。

- [ ] **Step 4: 从 hot path 移除全量 refs/objects quota traversal**

`captureFullReconcile()` 允许顺便刷新 exact usage；`commitIncrementalSnapshot()` 只能使用 reservation API，不调用 `rev-list --objects --all`、`count-objects` 或遍历 refs。maintenance IPC 的 quota view 仍可请求 authoritative refresh。

- [ ] **Step 5: 运行 quota、retention 与 store tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/snapshot-quota-accounting.test.ts packages/coding-agent/workspace-rewind/snapshot-retention.test.ts packages/coding-agent/workspace-rewind/snapshot-store.test.ts
```

Expected: PASS；测试 spy 证明 warm incremental commit 没有执行 exact quota scan。

- [ ] **Step 6: 提交**

```bash
git add packages/coding-agent/workspace-rewind/snapshot-quota-accounting.ts packages/coding-agent/workspace-rewind/snapshot-quota-accounting.test.ts packages/coding-agent/workspace-rewind/snapshot-store.ts packages/coding-agent/workspace-rewind/snapshot-retention.ts packages/coding-agent/workspace-rewind/snapshot-retention.test.ts
git commit -m "perf(agent): account snapshot quota incrementally"
```

### Task 8: 同一 canonical workspace 共享 tracker，并接入 live Agent runtime

**Files:**
- Create: `packages/coding-agent/workspace-rewind/workspace-tracker-registry.ts`
- Create: `packages/coding-agent/workspace-rewind/workspace-tracker-registry.test.ts`
- Modify: `emain/agent-rewind-feature.ts`
- Modify: `emain/agent-rewind-feature.test.ts`
- Modify: `emain/agent-ipc.ts:1080-1205`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/multi-session.integration.test.ts`

- [ ] **Step 1: 写失败测试，锁定 registry key 和 lease 生命周期**

```ts
const a = await registry.acquire(input);
const b = await registry.acquire(input);
expect(a.tracker).toBe(b.tracker);
expect(openStore).toHaveBeenCalledTimes(1);
await a.release();
expect(disposeTracker).not.toHaveBeenCalled();
await b.release();
expect(disposeTracker).toHaveBeenCalledTimes(1);
```

不同 `workspaceIdentity` 或 `workspaceIncarnation` 必须得到不同 tracker；初始化 Promise 必须共享；初始化失败必须从 registry 移除，下一次 acquire 可以重试。

- [ ] **Step 2: 运行 registry tests 并确认失败**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-tracker-registry.test.ts emain/agent-rewind-feature.test.ts
```

Expected: FAIL，因为 `openAgentRewindFeature()` 每次创建新的 store，且没有 tracker lease。

- [ ] **Step 3: 实现 process-global ref-counted registry**

registry key 使用：

```ts
const key = `${identity.workspaceIdentity}:${identity.workspaceIncarnation}`;
```

`acquire()` 返回：

```ts
export interface WorkspaceTrackerLease {
    store: WorkspaceSnapshotStore;
    tracker: WorkspaceSnapshotTracker;
    release(): Promise<void>;
}
```

最后一个 lease release 时 unsubscribe feed、flush 已提交 cursor 并 dispose tracker；release 幂等。只读 preview/restore 的 cold feature open 继续只需要 store，不启动 watcher。

- [ ] **Step 4: 接入 Agent runtime checkpoint manager**

在 live runtime 创建时 acquire lease，把 `lease.tracker` 作为 `snapshotSource` 传给 checkpoint manager；runtime cleanup 先 `checkpointManager.dispose()`，再 `lease.release()`。其他 rewind engine、quota、preview 和 recovery 调用继续使用 `lease.store`。

- [ ] **Step 5: 添加多 Session integration test**

两个 Session 在同一 workspace 交错边界：A before、B before、写文件、B terminal、A terminal。断言：

```ts
expect(registryStats.openStoreCount).toBe(1);
expect(registryStats.fullReconcileCount).toBe(1);
expect(checkpointA.originSessionId).toBe("session-a");
expect(checkpointB.originSessionId).toBe("session-b");
expect(checkpointA.after).toEqual(checkpointB.after);
```

再验证 A 的 Revert 仍以 live drift 为准，不因共享 tracker 获得覆盖 B 的额外权限。

- [ ] **Step 6: 运行 feature/IPC/multi-session tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/workspace-tracker-registry.test.ts packages/coding-agent/workspace-rewind/multi-session.integration.test.ts emain/agent-rewind-feature.test.ts emain/agent-ipc.test.ts
```

Expected: PASS；同一 workspace 只启动一个 tracker。

- [ ] **Step 7: 提交**

```bash
git add packages/coding-agent/workspace-rewind/workspace-tracker-registry.ts packages/coding-agent/workspace-rewind/workspace-tracker-registry.test.ts packages/coding-agent/workspace-rewind/multi-session.integration.test.ts emain/agent-rewind-feature.ts emain/agent-rewind-feature.test.ts emain/agent-ipc.ts emain/agent-ipc.test.ts
git commit -m "perf(agent): share rewind tracker across sessions"
```

### Task 9: 建立 full 与 incremental snapshot 等价性测试

**Files:**
- Create: `packages/coding-agent/workspace-rewind/snapshot-equivalence.integration.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts`
- Modify: `packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts`

- [ ] **Step 1: 写操作序列 fixture runner**

runner 对每个 filesystem 操作后分别用 full reconcile 和 incremental tracker 产生 snapshot，并比较：

```ts
expect(await materializeStates(incremental.ref)).toEqual(await materializeStates(full.ref));
expect(await store.diff(previousIncremental, incremental.ref)).toEqual(
    await store.diff(previousFull, full.ref)
);
```

固定序列包含：create、text write、binary write、same-size rewrite、chmod、symlink、delete、rename、directory rename、ignored file、nested repo、Git/non-Git 和 empty boundary。

- [ ] **Step 2: 加入 deterministic randomized model test**

使用固定 seeds `1..50`，每个 seed 运行 100 个 create/write/delete/rename/chmod 操作。每一步都比较 full 与 incremental 的 path-state projection；失败输出 seed 和 operation index，保证可复现。

- [ ] **Step 3: 加入 gap 与 race failure matrix**

注入 cursor missing、query error、callback error、scope invalidation、workspace incarnation change、dirty file 在 read 中替换、连续变化超过 retry budget。每项必须满足二选一：与 full snapshot 等价，或 checkpoint 明确 `unavailable`；不得产生 available empty checkpoint。

- [ ] **Step 4: 运行 correctness suite**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/snapshot-equivalence.integration.test.ts packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts
```

Expected: PASS for all fixed and randomized sequences。

- [ ] **Step 5: 提交**

```bash
git add packages/coding-agent/workspace-rewind/snapshot-equivalence.integration.test.ts packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts packages/coding-agent/workspace-rewind/tool-independent.integration.test.ts
git commit -m "test(agent): prove incremental snapshot equivalence"
```

### Task 10: 建立 monorepo benchmark gate 并记录结果

**Files:**
- Create: `packages/coding-agent/workspace-rewind/snapshot-performance.test.ts`
- Create: `scripts/benchmark-agent-rewind-snapshots.ts`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-08-04-agent-workspace-rewind-incremental-snapshot-design.md`

- [ ] **Step 1: 写 algorithmic performance tests**

用 injected spies 锁定不会被机器速度影响的约束：

```ts
expect(metrics.fullReconcileCount).toBe(0);
expect(metrics.enumeratedEntryCount).toBe(0);
expect(metrics.anchoredWorkerCount).toBe(0);
expect(metrics.exactQuotaScanCount).toBe(0);
expect(after.ref).toEqual(before.ref);
```

1 dirty path 的 captured path 数不得超过该 path、必要 scope evidence 和祖先数；100 dirty paths 的 worker concurrency 不得超过 8；1/2/4 Session 仍只有一个 tracker/full baseline。

- [ ] **Step 2: 运行 performance contract tests**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/snapshot-performance.test.ts
```

Expected: PASS；这些测试是默认 CI gate，不使用 wall-clock 阈值。

- [ ] **Step 3: 实现 opt-in benchmark matrix**

新增 npm script：

```json
"benchmark:agent-rewind-snapshots": "tsx scripts/benchmark-agent-rewind-snapshots.ts"
```

脚本生成 10k/50k/200k entries 的 deep 与 wide fixtures，分别测 full baseline 和 warm incremental 的 pre-turn/terminal latency，dirty paths 为 0/1/100，并测 1/2/4 Session。输出 JSON 与人类可读 table，字段固定为：entry count、directory count、dirty count、session count、p50、p95、full reconcile count、enumerated entries、worker peak、new objects 和 newly hashed bytes。

- [ ] **Step 4: 运行本地小矩阵和完整 correctness suite**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind
npm run benchmark:agent-rewind-snapshots -- --entries=10000 --iterations=10
```

Expected: 全部 tests PASS；10k warm/no-change 的 `enumerated entries=0`、`worker peak=0`、`full reconcile count=0`。wall-clock 数值记录而不写脆弱的本机绝对阈值。

- [ ] **Step 5: 记录 benchmark 结果和平台限制**

把测试日期、CPU、OS、filesystem、Node/Electron 版本、矩阵结果写入设计文档“Benchmark 结果”小节。Linux/Windows 如果 Parcel 历史查询退化为 brute-force，明确记录该平台 warm latency；未达到“成本不随 workspace 总 entries 线性增长”的平台不得宣称优化完成。

- [ ] **Step 6: 提交**

```bash
git add packages/coding-agent/workspace-rewind/snapshot-performance.test.ts scripts/benchmark-agent-rewind-snapshots.ts package.json docs/superpowers/specs/2026-08-04-agent-workspace-rewind-incremental-snapshot-design.md
git commit -m "test(agent): gate incremental snapshot performance"
```

### Task 11: 最终端到端回归与文档收口

**Files:**
- Modify: `docs/agent-architecture.md`
- Modify: `docs/superpowers/specs/2026-07-28-agent-workspace-rewind-design.md`
- Modify: `docs/superpowers/specs/2026-08-04-agent-workspace-rewind-incremental-snapshot-design.md`
- Modify: `emain/agent-rewind.e2e.test.ts`

- [ ] **Step 1: 添加 E2E turn boundary 场景**

覆盖：第一个 turn cold reconcile；第二个无文件改动 turn 复用同一 ref 且写 available empty checkpoint；第三个 shell 修改文件产生 v2 snapshot；Revert、Redo、turn Undo 继续得到相同 preview/apply 结果。

- [ ] **Step 2: 运行 Electron main E2E 与完整 rewind suite**

Run:

```bash
npx vitest run emain/agent-rewind.e2e.test.ts emain/agent-ipc.test.ts packages/coding-agent/workspace-rewind
```

Expected: PASS；没有历史 checkpoint 的旧会话仍按既有“不兼容历史”行为处理。

- [ ] **Step 3: 运行 TypeScript build**

Run:

```bash
npm run build:dev
```

Expected: exit code 0；Electron main 能打包 `@parcel/watcher` native dependency。

- [ ] **Step 4: 更新架构文档**

文档必须明确写出：

- logical checkpoint 与 physical snapshot 已解耦；
- manifest v2 state tree 与 v1 read compatibility；
- canonical workspace tracker 的共享边界；
- watcher callback、persistent cursor、anchored validation、full reconcile 各自的职责；
- gap/unavailable 的 fail-closed 行为；
- 多 Session 共享 tracker 不等于拥有严格写入归属；
- benchmark 的实际结果与仍存在的平台限制。

- [ ] **Step 5: 检查没有引入环境开关或 UI/API schema 变化**

Run:

```bash
rg -n "CREST_.*REWIND|incremental.*flag|feature.*incremental" packages/coding-agent/workspace-rewind emain frontend
git diff --check
git status --short
```

Expected: 搜索不出现新的 incremental rollout 环境开关；`git diff --check` 无输出；只有本计划内文件有预期修改。

- [ ] **Step 6: 提交**

```bash
git add docs/agent-architecture.md docs/superpowers/specs/2026-07-28-agent-workspace-rewind-design.md docs/superpowers/specs/2026-08-04-agent-workspace-rewind-incremental-snapshot-design.md emain/agent-rewind.e2e.test.ts
git commit -m "docs(agent): finalize incremental rewind snapshots"
```

## 完成门槛

以下条件必须同时满足，才能认为物理 snapshot 优化完成：

- full 与 incremental equivalence suite 全部通过；
- watcher cursor restart、gap、scope invalidation 和 race tests 全部 fail closed；
- warm/no-change algorithmic test 证明无 full enumeration、无 reader worker、无 exact quota scan；
- 同一 workspace 的 1/2/4 Session 共用一个 tracker 且 session checkpoint 不串线；
- Revert、Redo、turn Undo、preview、drift/force、retention 和 recovery 回归通过；
- `npm run build:dev` 能打包 native watcher；
- 10k/50k/200k benchmark 结果已写入设计文档；
- 未达到非线性 warm cost 的平台被明确标记为未完成，而不是通过增加 timeout 掩盖。

## 安全审查补充实施项

- [x] Windows staging 在没有 owner-only ACL 证明前 fail closed；
- [x] capture/dispose 使用进程内可重试状态机，保留 cleanup ownership，不增加 journal/recovery；
- [x] pending batch 使用单一 terminal-operation reservation，dispose 等待 active consumer/discard；
- [x] dispose cleanup 失败后仅允许 retained batch 的 discard-only cleanup 重试；
- [x] consumer 与 cleanup 同时失败时保留两个错误；
- [x] scope/index、base reader、anchored reader 和 hash 共用单次 capture deadline；
- [x] 内部 Git abort 映射为 timeout，调用者 abort 保持原语义，base/store Git read 可取消且会 drain；
- [x] empty capture 先校验 deadline；immutable base node read 不依赖 workspace mutation lock；
- [x] direct reader batch 使用总 deadline，不按 worker 重置 timeout；
- [x] stable Git index warm path 只验证 metadata，racy/unreliable evidence 才读取和 hash；
- [x] split-index 与 sparse-index 使用 capability-gated integration tests；
- [x] stored manifest 校验 Git index path 与 parentPath 的 dirname 关系。
