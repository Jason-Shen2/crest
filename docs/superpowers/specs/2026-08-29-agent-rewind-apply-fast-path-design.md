# Agent Rewind Apply Fast Path 设计

**日期：** 2026-08-29

**状态：** 已实现并完成专项正确性回归；50k `< 1,000 ms` 的激进体验门禁未通过

**范围：** Turn Undo/Redo 与 Conversation Rewind/Redo 在用户确认后的 Apply 热路径

**上游设计：**

- `2026-08-02-agent-rewind-recovery-simplification-design.md`
- `2026-08-08-agent-workspace-rewind-shadow-git-design.md`
- `../reports/2026-08-10-agent-workspace-rewind-optimization-retrospective.md`

## 结论

当前 Undo/Redo 的数秒延迟不是文件写入本身造成的，而是一次正常成功操作仍会执行多轮重复证明：

```text
Preview 已计算完整 RestorePlan
  → Apply 再次计算 RestorePlan
  → 多次读取同一个 Shadow Git head
  → 创建结果 commit
  → 写 pending、应用文件、验证、发布 head、追加 Session marker
  → 正常成功后仍进入完整 Recovery classifier
  → Recovery 再次读取 commit、路径、marker 和 head
```

本设计不改变 Rewind 的产品语义和安全边界，只把正常成功路径缩短为：

```text
获取 Writer Lease
  → 增量同步外部变化
  → 验证已确认计划仍然有效
  → 创建结果 commit
  → 写 pending
  → 应用并验证目标路径
  → CAS 发布 Shadow Git head
  → CAS 追加 Session marker
  → 清除 pending
```

完整 Recovery 只在启动发现 pending、执行抛错或持久化结果不确定时运行。

目标是在 warm、无冲突、单文件的常见场景把 Apply P95 降到 1 秒以内。该数字是需要 benchmark 关闭的门禁，
不是在测量前宣称已经达到的结果。

## 现有瓶颈

### 1. Apply 重算 Preview 计划

`RewindConfirmationRegistry.issue()` 已经把完整 `RestorePlanV1` 深拷贝、冻结并保存在进程内，token 是一次性且有
TTL。Apply 取得 confirmation 后，当前实现仍调用 `computeTurnUndo`、`computeTurnRedo`、`computeRewind` 或
`computeRedo`，重新读取 Session entries、checkpoint、commit history、snapshot diff 和 live path，再把重算结果
与 confirmation binding 比较。

这不是必要的安全检查。真正需要防止的是 Preview 之后发生的变化，而不是重新证明 Preview 之前的全部历史。

### 2. 同一事务重复读取 Shadow Git head

一次 Apply 中，`synchronizeExternal`、executor、mutation `prepare`、`publishPrepared`、Recovery 和 pending cleanup
都可能读取 `refs/crest/workspace-head`。它们处于同一个 Writer Lease 和受控事务中，却没有共享一个
`expectedHead`。

最终的 `git update-ref <new> <expected>` 已经提供 CAS；发布前反复执行 `for-each-ref` 不能增加同等级的安全性。

### 3. 正常成功也运行完整 Recovery

正常路径已经完成：

1. target paths 应用成功；
2. target paths 验证成功；
3. Shadow Git head CAS 成功；
4. Session marker CAS 成功。

但 executor 随后调用 `resolvePendingUnderLease()`。Resolver 又读取 pending/head/commit facts，重新派生 source 和
planned states，多次分类 live paths，重新读取并比较 marker，最后才删除 pending。

Recovery 是异常路径的权威分类器，不应成为每次正常操作的完成回调。

### 4. Git 固定进程成本仍然偏高

Shared Shadow Git 已经消除了每 turn 全仓扫描，但一次恢复仍会启动多个短命 Git 进程，包括 `for-each-ref`、
`cat-file`、`read-tree`、`update-index`、`write-tree`、`commit-tree`、`diff-tree` 和 `update-ref`。单文件操作也要支付
这些固定成本。

## 目标与非目标

### 目标

1. warm、无冲突、单文件 Apply P95 `< 1s`；
2. Apply 成本主要随 affected paths、restored bytes 和 Preview 后新增的 commit suffix 增长；
3. 仓库总文件数不直接进入单文件 Apply 热路径；
4. 保留多 Session owner/ABA 检查、live drift、Force 约束、Writer Lease、Shadow Git CAS、pending 和 Recovery；
5. 删除重复流程，不增加第二套 durable 状态、后台 worker 或长期缓存。

### 非目标

- 不通过提前关闭 Dialog 或后台静默执行伪造更快的完成时间；
- 不在 Preview 阶段预建结果 commit，以免增加 Dialog 首开延迟和 orphan object 生命周期；
- 不增加常驻 Git daemon、Path MVCC、数据库、WAL 或新的 Recovery phase；
- 不削弱 target path 的最终 fingerprint/state 验证；
- 不把真实的大文件写入或数千文件恢复承诺为常数时间；
- 不改变 cold baseline、checkpoint capture 或 Turn 文件卡片语义。

## 设计原则

### 1. Preview 证明过去，Apply 只证明 Preview 以后

Preview 负责生成精确计划并检查 checkpoint authority、历史 overlap、当前 live state 和 conflict class。Apply 不再
从头重做这些工作，只验证 confirmation 绑定的 authority point 以后有没有使计划失效的变化。

### 2. 正常路径相信成功返回的 durable operation

在 Writer Lease 和 owning Session mutation lease 仍然持有时，成功返回的文件验证、`update-ref` CAS 和
`appendEntries` CAS 就是正常路径的证据。只有调用抛错或结果不确定时，才需要从 durable facts 重新分类。

### 3. 一个事务只携带一个 authority context

Restore 事务显式携带 source head、planned head、affected paths、operation ID 和 confirmation，不让各组件自行重复
发现同一个状态。

## 组件设计

### 1. 复用现有 Confirmation Registry

不新增 `ExecutionPlanStore`。现有 `ConfirmedRestorePlanV1` 已保存冻结的 `plan`，只增加 Preview 的
`authorityHead`：

```ts
interface ConfirmedRestorePlanV1 {
    plan: RestorePlanV1;
    authorityHead: string;
    issuedAt: number;
    expiresAt: number;
    binding: ConfirmedRestoreBindingV1;
}
```

`authorityHead` 是本次 Preview 所依据的 Shadow Git head，也进入 confirmation binding。Token 仍保持：

- 只在内存中存在；
- 五分钟 TTL；
- 一次性 `take()`；
- Session 失效时删除；
- hard-blocked 计划不能签发。

### 2. Preview 使用稳定 authority head

Planner 不能在一次计划中让不同 overlap 查询各自读取不同 head。Preview 流程改为：

1. 读取 `authorityHead = H0`；
2. 所有 history/overlap 查询显式限制在 `H0`；
3. 生成计划并检查 live paths；
4. 再读取当前 head；
5. 仍为 `H0` 时签发 token；否则重试一次；再次变化则返回 workspace busy/stale，不签发 token。

这里不获取 Writer Lease，不让打开 Review 阻塞正在运行的 Agent。Git commit 是 immutable；并发 live path 变化由
fingerprint 和 Apply freshness validation 继续保护。

### 3. Apply Freshness Validation

Apply 获取 Writer Lease，并运行现有外部变化增量同步，得到当前 source head `H1`。随后验证：

1. confirmation 未过期且未使用；
2. Workspace identity/incarnation 相同；
3. owning Session semantic leaf/commit parent 仍匹配；
4. `authorityHead H0` 是 `H1` 的 ancestor；
5. `H0..H1` 新增 commit 没有修改计划中的路径；
6. 新增 Crest-owned commit 的 owner/history 不违反计划；
7. 每个 target path 的 live fingerprint 和 expected-current state 仍匹配；
8. Force 只接受 Preview 已标记为 `forceable-drift` 的路径，Redo 仍不允许 Force。

若 `H0 === H1`，第 4 至 6 项是 O(1) 快路径。若 head 前进但只修改不相交路径，计划仍可执行，结果 commit 以
`H1` 为 parent，因此保留其他 Session 和外部 actor 的不相交变化。任一新增 commit 触碰 target path 时，即使最终
bytes 相同也拒绝，继续防止 Session-owned ABA。

Apply 直接使用 `confirmation.plan`，不再调用 `compute*()`。Freshness validation 失败后不自动重算或偷偷使用新计划，
而是返回 stale，让 UI 重新 Preview，确保用户看到的 diff 与执行内容一致。

### 4. Restore Transaction Context

Executor 接收一个仅在本次调用中存在的上下文：

```ts
interface WorkspaceRestoreTransaction {
    sourceHead: string;
    operationId: string;
    plan: RestorePlanV1;
    confirmation: ConfirmedRestorePlanV1;
}
```

它不是新状态机，不持久化，也不跨请求缓存。`sourceHead` 来自 `synchronizeExternal()`，并作为：

- 结果 commit parent；
- pending 的 `sourceCommit`；
- `update-ref` 的 expected old value；
- 异常 Recovery 的 source authority。

### 5. Mutation Log 单次 CAS

在同一个 Writer Lease 内：

- `prepare()` 不再为了“确认存在”额外调用 `readHead()`；
- executor 不再重复读取刚由 `synchronizeExternal()` 返回的 head；
- `publishPrepared()` 不再预读 head；
- 最终只使用 `git update-ref --no-deref <ref> <planned> <source>` 完成原子 CAS。

如果 head 不匹配，Git CAS 失败且工作区操作进入异常 Resolver；不把失败掩盖为 stale success。

对象读取继续优先复用已有 batch-check、raw diff 和批量 index 更新。第一阶段只合并同一次 restore 中已经可批处理的
调用，不引入常驻 `cat-file --batch` 进程；只有 phase timing 证明对象启动仍是主要瓶颈时才重新评估。

### 6. Normal Completion Fast Path

pending 发布以后仍执行原有安全顺序：

1. 对每个 path 使用 expected-current 安全替换；
2. 批量/逐路径验证 live target state；
3. `update-ref` CAS 发布 planned commit；
4. `appendEntries` CAS 追加 Session marker；
5. 在 Workspace lock 内确认 pending operation ID 未变化并删除 pending；
6. 发布权威 Session state。

第 5 步不再调用完整 `resolvePendingUnderLease()`。此时 Writer Lease 与 Session mutation lease 尚未释放，且第 3、4 步
已经成功返回，没有另一个 Crest restore 可以推进 head 或 leaf。pending cleanup 只验证自身 operation ID，防止删除
其他事务。

任何 pending 发布后的异常继续进入现有 Resolver，包括：

- 文件应用或验证失败；
- `update-ref` 返回错误或结果不确定；
- Session marker append 失败或结果不确定；
- pending 删除失败或结果不确定。

Resolver 仍以 pending、head、Session marker 和 live paths 为 authority，决定 committed、not-committed 或
needs-user。启动恢复行为不变。

## 数据流

### Warm、无变化、正常成功

```text
Preview
  read H0 → plan against H0 → validate H0 unchanged → issue(plan, H0)

Apply
  take confirmation
  → acquire leases
  → synchronizeExternal = H0
  → suffix empty + validate target paths
  → prepare planned commit(parent=H0)
  → publish pending
  → apply + verify files
  → update-ref planned H0
  → append marker CAS
  → remove matching pending
  → publish UI state
```

### Preview 后有不相交变化

```text
H0 → Session B modifies package.json → H1
Apply Session A plan for README.md
  → validate H0..H1 has no README.md overlap
  → result parent = H1
  → only README.md restored
  → package.json preserved
```

### Preview 后同路径变化

```text
H0 → Session B modifies README.md → H1
Apply Session A plan for README.md
  → suffix overlap detected
  → reject stale confirmation
  → no pending, no file write
  → UI reloads Preview
```

### 正常流程中途失败

```text
pending exists
  → executor catches error
  → full Resolver reads pending/head/marker/live paths
  → complete, roll back, or needs-user
```

## 性能门禁与测量

### Phase Timing

先增加只记录 duration/counter 的结构化 timing，不增加业务状态：

- `externalSyncMs`
- `freshnessValidationMs`
- `prepareCommitMs`
- `pendingPublishMs`
- `applyFilesMs`
- `verifyFilesMs`
- `publishHeadMs`
- `appendMarkerMs`
- `pendingCleanupMs`
- `statePublishMs`
- `gitProcessCount`

测试与 benchmark 读取这些指标；产品日志只在慢操作或开发模式输出，避免长期噪声。

### 正式门禁

在 Node 22、release-like 构建和同一台基准机器上，每个 warm 场景至少 30 次，报告 p50/p95/max：

| 场景 | P95 目标 |
| --- | ---: |
| 单文件、1 KiB、无外部变化 | `< 1,000 ms` |
| 10 个小文件、无外部变化 | `< 1,500 ms` |
| 100 个小文件、无外部变化 | `< 3,000 ms` |
| 50k deep/wide 仓库回退单文件 | `< 1,000 ms` |
| 200k deep/wide 仓库回退单文件 | `< 1,500 ms` |

50k/200k 门禁中的 target path、restored bytes 和 Preview 后 commit suffix 必须相同，用于证明仓库总 entry 数没有重新
进入 Apply 热路径。cold baseline、首次 store 创建和 fixture 生成不计入 warm Apply。

如果第一阶段仍未达到目标，必须根据 phase timing 选择下一步；不能直接引入常驻 worker 或新 durable cache。

## 正确性测试

### Confirmation 与 freshness

1. Apply 使用 confirmation 中冻结的 plan，不调用原 `compute*()`；
2. token 一次性、过期、Session invalidation 和 capacity 行为不变；
3. Preview 期间 head 前进会重试一次，再次变化不签发 token；
4. Preview 后不相交 commit 保留且允许 Apply；
5. Preview 后同路径 Session commit 即使 bytes 恢复相同也拒绝；
6. live fingerprint 变化拒绝；
7. semantic leaf 或 commit parent 变化拒绝；
8. Force/Redo 规则不变。

### 正常完成与 Recovery

1. 正常成功不调用 full Resolver；
2. pending cleanup 前仍持有 Writer Lease 和 Session mutation lease；
3. operation ID 不匹配时不能删除 pending；
4. 文件应用、验证、head CAS、marker CAS、cleanup 每个故障点都进入 Resolver；
5. planned head + exact marker 的异常路径仍完成 cleanup；
6. source head + partial files 的异常路径仍安全恢复 source；
7. unknown live state 仍返回 needs-user；
8. 进程在 pending 后每个边界强制退出，重启结果与现有 crash matrix 一致。

### 多 Session

1. 两个 restore 不能同时持有 Writer Lease；
2. Session A Apply 不覆盖 Session B 的不相交路径；
3. Session B 的同路径 commit 使 A confirmation stale；
4. Session B 只推理或修改对话不影响 A；
5. external drift、Crest-owned overlap 和 Force 继续使用不同策略。

## 实施顺序

### Phase 0：建立 Apply 基线

增加 phase timing 与单文件/10 文件/100 文件 benchmark，保存优化前的 Git process count 和 wall time。

### Phase 1：删除正常路径重复工作

1. confirmation 绑定稳定 `authorityHead`；
2. Apply 复用 frozen plan，改为 suffix freshness validation；
3. 正常成功直接清理 pending，不调用 full Resolver；
4. 保留所有异常 Resolver 分支。

完成后先运行 correctness/crash/multi-session tests 和性能门禁。预计这是最大收益且同时降低架构复杂度的一阶段。

### Phase 2：减少 Git 固定进程

1. 删除 lease 内重复 `readHead()`；
2. 让一次 `update-ref` CAS 成为唯一 publication check；
3. 批处理本次 restore 的对象和 index 查询；
4. 用 phase timing 验证收益。

### Phase 3：仅在数据证明需要时继续

若 P95 仍未达标，才根据最大的 phase 选择局部优化。默认不做常驻 Git worker、持久缓存、后台预建 commit 或新的
Recovery 状态。

## 生产判断

只有同时满足以下条件，才能把 Apply fast path 标为 production-ready：

1. 上述性能门禁通过；
2. 现有 workspace-rewind correctness、crash、multi-session、drift 和 Force 测试全部通过；
3. phase timing 证明没有通过跳过 authority 验证获得假加速；
4. 真实 Crest worktree 和至少一个大型 monorepo 验证通过；
5. pending/marker 故障注入没有新增 needs-user 或 frozen 回归；
6. 本功能相关 TypeScript diagnostics 为 0。

在门禁关闭前，只能描述为“设计和实现优化中”，不能仅凭单文件本地体感宣称生产可用。

## 明确保留与明确删除

| 保留 | 原因 |
| --- | --- |
| Shared Shadow Git | immutable state、history ownership、CAS |
| Writer Lease | Crest Session 写入归属与串行 publication |
| target path fingerprint/state validation | 防 Preview 后磁盘覆盖 |
| commit suffix overlap validation | 防多 Session 同路径与 ABA |
| one pending intent | 跨文件系统与 Session SQLite 的最小 crash evidence |
| abnormal/startup Recovery | 处理中断和不确定持久化结果 |

| 删除或不新增 | 原因 |
| --- | --- |
| Apply 全量重算 RestorePlan | confirmation 已保存 immutable plan |
| 正常成功 full Recovery classification | 成功返回的 CAS 和验证已经提供证据 |
| lease 内重复 readHead | 最终 update-ref CAS 已覆盖 publication race |
| 第二套 plan cache | confirmation registry 已承担该职责 |
| 常驻 Git worker/新数据库/WAL | 当前没有测量证明必要，增加生命周期和恢复复杂度 |

本设计的核心不是“少做安全检查”，而是让每项安全事实只被证明一次：Preview 证明历史计划，Apply 证明增量新变化，
CAS 证明提交，Recovery 只证明异常结果。

## 最终实现校正（2026-08-29）

实施保持了设计的安全边界，并根据测试结果做了几处必要校正：

1. confirmation 冻结完整 `RestorePlanV1` 和 Preview 的 `authorityHead`。Apply 不再调用任何 planner，只检查
   `authorityHead → currentHead` 的 commit suffix、当前 semantic leaf 和目标路径实时状态。
2. Preview 在同一 head 上完成计划；期间 head 变化时只重试一次。这样 token 表示一个明确、不可变的授权事实。
3. 正常成功直接删除与本次 operation ID 匹配的 pending；只有异常、启动残留或持久化结果不确定时进入 Recovery。
4. 正常路径使用 executor 已经证明的 source/target 状态构造 marker，不再让 Recovery 风格的 commit/path 重读
   重新证明相同事实；Recovery 对不可信 durable state 的完整校验保持不变。
5. 多路径 source state 改为 batched `ls-tree`/object 查询，成本按目标路径和深度批次增长，不按 workspace 总 entry
   数增长。
6. mutation `prepare()` 的重复 head 读取已删除；publish 前仍保留一次 exact-ref 读取，因为 symbolic-ref 测试证明
   单靠后续命令不足以保持现有拒绝语义。executor 写文件前的 source-head 检查也保留，避免用性能换取覆盖风险。
7. phase timing 仅通过非权威 observer 暴露，不写入 durable state，也不增加新的 cache、worker、WAL 或恢复状态。
8. 最终回归发现，旧 Recovery 同时承担了正常成功后的 live-target 与 exact marker 复核。删除 classifier 时不能删除
   这两个安全事实；最终实现改为轻量 finalizer，复用已知 planned states 和当前已持有 mutation lease 的 Session，
   再检查 planned head/pending 后清理。它不调用 Recovery locator，避免重现 exclusive Session mutation 冲突。

因此最终正常路径是：

```text
稳定 Preview + 冻结 plan
  → Writer Lease 下同步外部变化
  → suffix / leaf / live path freshness
  → 准备结果 commit 与最小 pending
  → 应用、验证并 CAS 发布 head
  → CAS 追加 marker
  → 精确清理 pending
```

## 最终性能边界

Node.js 22.22.3、30 次 warm Apply、单目标文件、无 fallback 的最终结果：

| Workspace 规模 | 目录形态 | p50 | p95 | max | Apply 内 Git 进程 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 50k entries | deep | 1,188.28 ms | 1,303.33 ms | 1,304.00 ms | 36 |
| 50k entries | wide | 1,166.95 ms | 1,254.96 ms | 1,259.05 ms | 36 |
| 200k entries | deep | 1,399.90 ms | 1,499.51 ms | 1,531.04 ms | 36 |
| 200k entries | wide | 1,308.11 ms | 1,389.94 ms | 1,398.08 ms | 36 |

所有组均为 `fallbackCount=0`。候选数、读取字节和 Git 进程数没有随 50k → 200k 放大；新增耗时主要在结果
commit 准备阶段，而不是重新扫描 workspace。

设计中的 200k `< 1,500 ms` p95 门禁通过，但 deep 只有 0.49 ms 余量；50k `< 1,000 ms` 门禁未通过，实际超出
约 25%–30%。这意味着算法层面的
全 workspace 放大已消除，但 durable commit、pending publish/cleanup、文件安全写入和验证仍形成约 1 秒固定成本。
继续删除这些步骤会削弱 crash safety 或文件覆盖保护，因此本轮不引入常驻 worker、后台预建 commit 或新 cache。

最终结论是：快路径已经适合在 200k entry 边界内进行生产候选验证，常见点击延迟从历史 restore 的约 5.6–9.8 秒
降到约 1.25–1.50 秒；它不是“瞬时完成”，200k 门禁没有宽裕余量，50k 的激进体验门禁也仍需如实保留为未通过。
