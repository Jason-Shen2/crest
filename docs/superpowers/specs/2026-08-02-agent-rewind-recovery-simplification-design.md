# Agent 回退事务与 Recovery 简化设计

**日期：** 2026-08-02

**状态：** 待评审

**范围：** 完整会话 Revert/Redo 与单 Turn Undo/Redo 共用的恢复事务

本文在实现后仅替代 `2026-07-28-agent-workspace-rewind-design.md` 中的 Recovery Journal、冻结状态传播和广播失败语义；checkpoint、preview、confirmation、drift、Force 与多 Session 产品行为继续沿用原设计。

## 目标

保留现有回退能力的三个安全边界：

- 回退前检查磁盘 drift，普通操作不覆盖用户或其他 Agent Session 的后续修改；
- 多文件恢复过程中崩溃后，可以判断操作是否提交，并安全完成或撤销；
- 任何无法精确判断的文件或 Session 状态都停止自动写入。

同时删除当前五阶段 journal、多层 `frozen` 缓存、重复扫描和 Recovery 状态广播之间的耦合。

## 非目标

- 不改变 checkpoint、Turn diff、Revert/Redo 和 Force conflict 的产品语义；
- 不改变多个 Agent Session 共享物理 Workspace 的模型；
- 不让 Recovery 覆盖 `before`、`target` 之外的未知磁盘内容；
- 不兼容当前开发版本遗留的五阶段 recovery journal；
- 不把 UI 广播失败视为工作区数据损坏。

本轮明确不加入五阶段之外的新 phase、第二套 operation status 数据库、全 Turn Workspace lock、持久化 busy/frozen 状态或额外 pending digest。也不把“marker 是当前 leaf”放宽为“marker 只是某个 ancestor”；pending 清理前 gate owning Session 的 leaf mutation，判定更直接。

## 核心原则

每个物理 Workspace 同时最多有一个未完成恢复事务，使用一份 `pending.json` 表示。

创建 pending 必须在 Workspace lock 内完成：先确认文件不存在，再使用拒绝覆盖的原子持久化写入；文件已存在时拒绝开始第二个恢复事务。

Session SQLite 中的隐藏 operation marker 是唯一提交点：

- marker 不存在：事务未提交；
- exact marker 是当前 leaf：事务已提交；
- 其他 leaf：状态无法自动判断。

`pending.json` 是崩溃恢复依据，但不是另一套业务状态机。它只有“存在”或“不存在”，不再包含 `prepared`、`applying_files`、`files_verified`、`committing_session`、`completed` 五个 phase。

## 简化后的组件

### 1. Checkpoint 与 Snapshot Store

保持现状。每个完整 User Turn 保存 `before`、`after` 和 `changedPaths`。预览使用这些数据生成精确 diff。

### 2. Restore Executor

负责一次完整恢复事务：写 pending、应用文件、验证文件、提交 Session marker、清理 pending。

它不维护 Recovery UI 状态，也不因为状态广播失败回滚已提交事务。

### 3. Pending Operation Store

每个 Workspace 只保存一份原子写入的 `pending.json`：

```ts
interface PendingWorkspaceRestoreV1 {
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
    paths: Array<{
        path: string;
        before: CapturedPathStateV1;
        target: CapturedPathStateV1;
        createdParentDirectories: string[];
    }>;
}
```

写入 pending 前必须完成安全快照并确保其对象和 anchor 已持久化。pending 本身也是 snapshot retention 的 owner；只要 pending 存在，GC 就不能回收 `safetySnapshot`。结果 snapshot 在提交 marker 前同样必须完成持久化和验证，marker 提交后由 Session entry 继续保活。

exact marker 不是只比较 entry ID。它必须同时满足：

- entry ID、custom type、`parentId == commitParentId`；
- operation、Session ID、经 sessions root 校验的 Session path、Workspace identity 完全匹配；
- `target`、`applyMode`、`forcedPaths` 与 pending 完全匹配；
- marker 的 current states 与 pending 中每条路径的 `target` 完全匹配；
- rewind marker 的 redo snapshot/state 与 pending 的 `safetySnapshot`/`before` 完全匹配；
- marker 引用的结果 snapshot 存在、可验证，且其中目标路径也等于 `target`。

写入 pending 并 `fsync` 后，才允许修改第一个工作区文件。

`paths` 和 `forcedPaths` 使用 canonical path byte order，所有 durable payload 使用同一 canonical encoding，避免仅因数组顺序不同而产生假冲突。

目标路径的安全应用仍复用现有文件类型、symlink ancestor、mode 和 expected-current 检查；本次简化不重写文件应用算法。

安全替换可能先把旧路径移动到由 `operationId + path` 唯一确定的临时隔离位置。Resolver 在判断 live path 之前，必须先复用现有 artifact reconciliation 清理或复原这些确定性的中间产物。创建缺失父目录时，Executor 立即把实际创建的目录追加到该路径的 `createdParentDirectories` 并持久化；回滚只删除这些目录中仍为空的目录。它们是文件执行进度，不是 Recovery phase。

### 4. Recovery Resolver

只负责读取 pending、Session marker 和实时文件，返回以下三种结果：

```ts
type RecoveryDecision =
    | { state: "committed" }
    | { state: "not-committed" }
    | { state: "needs-user"; reason: string };
```

`inspectPending()` 与 `resolvePending()` 使用同一个 classifier。公开调用统一按以下顺序执行：读取 pending 候选、获取 owning-session mutation lease、获取 Workspace lock、重新读取并确认仍是同一个 `operationId`，然后分类。`inspectPending()` 等待 Workspace lock 后只读分类；`resolvePending()` 在相同锁内执行清理或回滚。Restore Executor 已持有两把锁时，只调用同一 Resolver 的 locked helper，不重新获取锁。若 owning Session 已确认不存在，则不可能再发生该 Session 的 leaf mutation；Resolver 只获取 Workspace lock 并允许用户 Keep current，不尝试自动回滚或提交。

Resolver 不保存长期 `frozen` 字段，不发布 Session state，也不直接管理 Renderer UI。

### 5. Workspace Write Gate

新的工作区写入，以及可能追加或移动 owning Session leaf 的操作，开始前都检查统一的 authoritative recovery classifier：

- 没有 `pending.json`：允许写入；
- pending 能自动解决：调用 `resolvePending()` 后再允许写入；
- pending 返回 `needs-user`：阻止工作区写入并返回 Recovery diagnostic。

Gate 不缓存另一份永久 `frozen Map`。Renderer 通过只读 `inspectPending()` 获得临时投影，不因打开 UI 而修改 Workspace。

Gate 必须位于调用方获取 Session lease 之前，覆盖 send、compact、navigate、fork、clone 和所有写入入口。这样 marker 提交但 pending 尚未清理时，不会被下一条消息推进 leaf，导致已提交事务被误判为不确定。Recovery UI 请求携带它看到的 `operationId`；Resolver 持锁重读后若 ID 已变化，拒绝该过期请求。

Gate 只能阻止后续 Crest 操作，无法停止已经运行的 Agent tool、bash/PTY，也无法停止外部编辑器。系统不为此增加全 Turn Workspace lock，而是继续依靠 expected-current CAS、artifact reconciliation 和最终 target 验证；出现 overlap 或 unknown 时进入 `needs-user`，绝不自动覆盖。

## 正常执行流程

用户完成预览和确认后：

1. 获取 owning-session mutation lease；
2. 获取 canonical Workspace lock；
3. 重新验证 confirmation token、Session leaf 和目标路径 drift；
4. 捕获当前工作区安全快照；
5. 原子写入 `pending.json`，使其开始保活 safety snapshot；
6. 应用目标文件状态；
7. 验证所有目标路径；
8. 捕获并持久化结果 snapshot；
9. 使用 `commitParentId` CAS 原子追加 Session operation marker；
10. 验证 exact marker 是当前 leaf，并再次验证所有目标路径；
11. 删除并 `fsync` `pending.json`；
12. 释放锁并通知 Renderer 刷新。

第 9 步是唯一提交点。第 9 步成功后，即使第 12 步广播失败，回退仍然成功。UI 可以通过下一次 Session state query 重新构建，不触发 Recovery。

pending 发布前发生错误可以直接返回失败；pending 发布后发生任何错误——包括调用抛错但持久化结果不确定——都不按错误类型猜测结果，而是在当前锁内交给同一个 Resolver 重新分类。marker 和实时磁盘状态是唯一判断依据。

## 崩溃恢复流程

发现 `pending.json` 后，Resolver 按统一锁顺序进入 owning-session mutation lease 和 Workspace lock，重新读取 pending，并先完成所有路径的 artifact reconciliation，再读取所有权威状态。回滚前必须先分类完全部路径，不能边分类边修改。

### exact marker 是当前 leaf

事务已经提交：

1. 每个目标路径必须精确等于 `target`；
2. marker 引用的结果 snapshot 必须存在且可验证；
3. 验证成功后删除 pending；
4. 任一路径不是 target，返回 `needs-user`，不自动覆盖。

### marker 不存在，当前 leaf 等于 `expectedSemanticLeafId`

事务没有提交：

1. 每个路径只能精确等于 `before` 或 `target`；
2. 只把仍为 `target` 的路径恢复成 `before`；
3. 验证所有路径都等于 `before`；
4. 删除 pending；
5. 任一路径既不是 before 也不是 target，返回 `needs-user`。

### 其他 Session leaf

返回 `needs-user`。Recovery 不移动会话树，也不猜测哪个 leaf 应该生效。

## 多 Session 行为

- 每个 Session 继续使用自己的 SQLite 会话树；
- 所有 Session 共享同一个 Workspace lock 和 `pending.json`；
- 普通 Agent Turn 不持有 Workspace lock，因此不同 Session 仍可并行工作；
- Restore Executor 持有 Workspace lock，因此两个恢复事务不会交错；
- unresolved pending 存在时，不允许任何 Session 开始新的工作区写入；
- pending 所属 Session 不允许追加或移动 leaf；
- 已在运行的 Agent tool、bash/PTY、外部编辑器和 shell 不受 pending 控制，所以 Recovery 始终使用实时 CAS 和最终验证，不承诺全局静默期。

## UI 与 Diagnostic

UI 只展示 authoritative query 的当前结果：

- 无 pending：不显示 Recovery；
- `needs-user`：显示 Recovery UI，并提供 Retry、Keep current、Quarantine 等明确操作。

普通 Restore 自己显示普通 loading 状态。启动时先运行自动 Resolver；Recovery query 与它及正常 Restore 使用同一把 Workspace lock，等待后重新读取 pending。可自动解决的 pending 此时通常已经消失，只有 `needs-user` 会交给 Renderer，因此 UI 不需要额外的“Recovery busy”状态。

coverage warning、ignored path 和 checkpoint unavailable 不属于 Recovery，不进入同一错误区域。

Renderer 不持久化 `frozen`。关闭并重新打开窗口后，状态完全由 pending、Session leaf 和磁盘内容重新计算。

## Keep Current 与 Quarantine

为避免增加新的状态机，人工操作只改变 pending 文件：

- **Retry**：重新运行同一个 Resolver；
- **Keep current**：确认 Session leaf 仍是 exact old leaf 或 exact marker leaf 后，将 pending 原子移动到 resolved audit；若 pending 可解析但 owning Session 已确认不存在，也允许显式 Keep current；两种情况都不修改文件和会话；
- **Quarantine**：只用于无法解析的 pending，将原始 bytes 移到 resolved audit；不修改文件和会话。

resolved audit 不阻止 Workspace 写入，由普通保留策略清理。

## 删除的机制

实现完成后删除：

- 五个 recovery phase；
- phase transition 和 phase-specific recovery 分支；
- `ignoreCompletedOperationId`；
- `WorkspaceRecovery.frozen`；
- production recovery gate 的长期 `frozen Map`；
- startup raw journal scanner 与 runtime journal scanner 的重复实现；
- Recovery 成功路径中的 Session state publish/repair callback；
- 因广播失败而保留 completed journal 的行为。

保留一个 pending decoder、一个 Resolver 和一个 Recovery query。

## 失败语义

- pending 写入失败：尚未修改 Workspace，直接返回失败；
- pending 发布后的文件、snapshot、SQLite 或 cleanup 错误：一律交给同一个 Resolver，以 marker 和实时文件重新分类；
- 分类为未提交且路径均为 before/target：恢复 before 并删除 pending；
- 任一路径出现 unknown，或 Session/marker 无法精确匹配：保留 pending，返回 `needs-user`；
- marker 提交后 cleanup 失败：事务成功，pending 留给下一次 Resolver 清理；
- Renderer 广播失败：事务成功，只记录并安排普通状态刷新。

## 测试要求

保留现有 drift、Force、多 Session 和文件安全测试，并用更小的 crash matrix 替代五阶段测试：

1. pending 落盘前崩溃：没有文件变化；
2. 每个文件替换前后崩溃：marker 不存在，恢复到 before；
3. 结果 snapshot 前后崩溃：marker 不存在，恢复到 before；
4. SQLite marker 前崩溃：恢复到 before；
5. SQLite marker 后崩溃：保留 target 并清理 pending；
6. pending 删除后崩溃：不进入 Recovery；
7. marker 前后发生外部 unknown 写入：不覆盖并返回 `needs-user`；
8. UI 广播失败：操作仍成功，下一次 query 显示非 frozen；
9. Session A 恢复时 Session B 的非目标路径保持不变；
10. 两个 Session 不能同时创建 pending；
11. safety snapshot 在 pending 存在期间不会被 GC；
12. 隔离 rename/install 边界崩溃后，Resolver 先修复确定性 artifact 再分类；
13. 回滚只清理本操作实际创建且仍为空的父目录；
14. marker 的 parent 或任一 durable payload 不匹配时，不视为 exact marker；
15. 正常 Restore 持锁时，UI inspection 等待完成且不显示 Recovery；
16. marker 已提交但 pending 清理失败时，下一次 leaf mutation 先触发清理；
17. 携带旧 `operationId` 的 Recovery UI 请求不能操作新的 pending；
18. pending 发布后的模糊错误统一由 classifier 判断；
19. owning Session 确认缺失时，可显式 Keep current；
20. Session B 写入目标路径或已有 PTY 同时写入时，CAS/最终验证阻止静默覆盖；
21. startup、write gate、UI inspection 与 Restore failure path 遵守同一锁顺序。

## 开发版本迁移

当前功能尚未发布，不为旧五阶段 journal 增加长期兼容分支。开发升级前只隔离或清理旧 recovery journal，不删除仍有效的 checkpoint/snapshot store；新版 decoder 遇到旧 journal 时只给出明确的不兼容 diagnostic，不尝试按新协议恢复，也不静默忽略。

## 验收标准

- 正常回退代码路径中不存在 recovery phase transition；
- 一个 Workspace 最多存在一个 `pending.json`；
- Session marker 是唯一提交判据；
- 广播失败不会出现 Recovery；
- frozen UI 没有独立持久缓存；
- startup、write gate 和 Recovery UI 使用同一个 classifier；
- pending 是 safety snapshot 的明确 retention owner；
- exact marker 校验完整 durable intent，而不只比较 entry ID；
- 所有 leaf mutation 在 pending 清理前被 gate；
- 文件替换中间产物可以确定性 reconciliation；
- unknown 文件状态永远不会被自动覆盖；
- 多 Session restore 仍由 Workspace lock 串行化。
