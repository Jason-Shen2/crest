# Agent Workspace Rewind Incremental Snapshot Design

**状态：** 设计方向已确认，尚未实现

**日期：** 2026-08-04

**上游设计：** `2026-07-28-agent-workspace-rewind-design.md`

## 背景

现有 Workspace Rewind 采用工具无关的 turn 边界快照：每个 durable user turn
开始前捕获 `before`，结束时捕获 `after`，再把两者的精确 diff 作为
`workspace_checkpoint` 写入 append-only session tree。这一语义能够覆盖
`write`、`edit`、shell、PTY、CLI Agent、人工编辑和后续新工具，不需要相信任何
工具层的变更报告。

这一语义应当保留。但当前实现把“每个 turn 都必须有逻辑 checkpoint”直接等同于
“每个边界都重新捕获完整 workspace”，导致稳态成本仍然随 workspace 总规模增长。
这对 monorepo 和同一 workspace 多 Agent Session 场景不合适。

本文记录问题的发现过程、根因、保留的安全约束、被否决的简化方式，以及目标增量
架构。本文只改变 snapshot 的生成方式，不改变 Rewind、Redo、checkpoint 或 session
tree 的产品语义。

## 当前实现与问题根因

### 当前 turn 热路径

```text
session_before_user_turn
  -> capture(pre-turn)
  -> user turn starts
  -> agent/tool loop
  -> session_user_turn_terminal
  -> capture(terminal)
  -> diff(before, after)
  -> append workspace_checkpoint
```

两个 capture 都是 awaited lifecycle hook：pre-turn capture 会延迟 Agent 开始，
terminal capture 会延迟 turn settled、checkpoint 和文件改动卡片出现。

### 一次完整 capture 的固定工作

当前 `WorkspaceSnapshotStore.capture()` 每次都会执行：

1. 遍历 shadow store refs 和对象计算 quota；
2. 重新识别 Git/non-Git workspace scope；
3. 执行 tracked/ignored Git 查询，并在扫描后再次执行查询验证稳定性；
4. 递归枚举 workspace，再次枚举目录验证名称和 identity 未变化；
5. 对每个 eligible entry 检查文件 identity/fingerprint；
6. 按父目录分组，顺序启动 anchored reader 子进程；
7. 根据所有 entry 重新构建完整 Git tree、scope manifest 和 descriptor；
8. 持久化、锚定并校验对象。

内容寻址和 fingerprint cache 能避免重复保存或重新 hash 大部分未变化文件，但无法
消除目录枚举、metadata 检查、tree/manifest 重建和 quota 遍历。当前 anchored reader
还会为每个包含 eligible entry 的父目录启动一个 Node 子进程，进程启动数量随目录数
增长。

### 多 Session 放大

每个 Agent runtime 当前会打开自己的 `WorkspaceSnapshotStore` 实例。fingerprint cache
属于 store 实例而不是 canonical workspace，因此：

- 不同 Session 不共享 warm cache；
- runtime/App 重建会丢失 cache；
- 同一 workspace 会被不同 Session 重复扫描；
- capture 最终又在 canonical workspace lock 上串行排队。

这与 Crest 的常见使用方式冲突：同一个物理 workspace 同时运行多个 Agent Session
并不是边缘场景。

### 根因判断

问题不在“每个 durable turn 都有 checkpoint”，而在以下概念被耦合：

```text
逻辑 checkpoint：证明 turn 边界完整，并保存 before/after/diff
物理 snapshot：重新扫描并构造完整 workspace 状态
```

逻辑 checkpoint 必须一对一存在；物理 snapshot 不需要每次从零构造。

原设计优先解决了工具无关、raw bytes、Git/non-Git、racy-clean、symlink/path 安全、
crash durability 和 drift detection，但没有引入 workspace 级增量状态层，也没有把
monorepo wall-clock latency、目录数、并发 Session 数和子进程数量设置为 rollout
门槛。`maxEntries`、timeout 和 quota 是故障上限，不是性能设计。

## 保持不变的产品与安全语义

优化后必须继续满足：

1. 每个已经持久化的 user turn 最终恰好有一个 `available` 或 `unavailable`
   checkpoint；无文件改动的 turn 也不能留下 checkpoint 缺口。
2. checkpoint 继续存储 immutable `before`/`after` snapshot ref、精确 changed paths、
   workspace/session identity 和 coverage。
3. snapshot 的权威性不依赖 `write`、`edit`、tool result 或 renderer 回传路径。
4. 支持 Git 与 non-Git workspace，且不修改用户的 HEAD、index、branch、stash、hook
   或 filter。
5. 保存 raw file/symlink bytes 和 executable bit；create/delete/rename 仍由显式 path
   state 表达。
6. Rewind 继续只恢复目标 active-branch suffix 的选择性路径；Redo、drift detection、
   Force Revert、confirmation token 和 workspace state marker 语义不变。
7. 不确定不能被解释为“无改动”。无法证明增量状态完整时必须 full reconcile；仍然
   无法证明时写 `unavailable` checkpoint。
8. workspace 级共享只共享物理版本和缓存。每个 Session 的 checkpoint、恢复权限、
   semantic leaf 和冲突判断仍然独立。

## 方案比较

### 方案 A：保留全量 capture，只调整 timeout/并发

优点是改动小，安全模型不变。缺点是核心复杂度仍为 O(workspace entries)，多 Session
仍重复工作；增加 timeout 只会让用户等待更久。否决。

### 方案 B：只依赖 filesystem watcher

正常路径最快，但 watcher 可能合并事件、overflow、在 App 退出期间失效，且事件本身
不能证明读取时的文件 identity。漏掉事件会伪造 `changes=[]`，风险高于显式
`unavailable`。否决作为权威实现；watcher 只可作为 dirty hint。

### 方案 C：workspace 级共享增量 tracker，检测到不确定时全量 reconcile

选定方案。一个 canonical workspace 只维护一个 tracker、一个 immutable version
graph 和一份 persistent/shared fingerprint state。正常边界只刷新 dirty paths 和受
影响的祖先 tree；startup、事件 gap、overflow、identity 异常或一致性校验失败时执行
现有 full capture/reconcile。

该方案把正常成本从 workspace 总规模转向实际变化规模，同时保留 fail-closed 行为。

### 方案 D：以 Agent 工具变更日志为权威

无法覆盖 shell、PTY、CLI Agent、人工编辑、后台进程和未来工具，也会重新引入本功能
最初要消除的工具耦合。否决。

## 目标架构

### WorkspaceIncrementalSnapshotTracker

Electron main 按 canonical workspace identity 维护共享 tracker：

```text
canonical workspace
  -> one tracker
  -> immutable version Vn
  -> persistent content-addressed objects
  -> dirty path/directory set
  -> watcher/journal generation and gap state
  -> shared fingerprint/index state
```

Session 和 Rewind engine 不直接读取 tracker 的可变内部状态，只接收 immutable
`WorkspaceSnapshotRefV1`。

### 正常数据流

```text
tracker current = V10

Turn A starts
  -> establish consistency barrier
  -> flush known dirty paths
  -> beforeRef = V10

filesystem events during turn
  -> mark paths/directories dirty

Turn A terminal
  -> establish consistency barrier
  -> capture and validate dirty paths
  -> copy-on-write affected Merkle ancestors
  -> afterRef = V12
  -> diff(V10, V12)
  -> append checkpoint(A, V10, V12, changes)
```

无改动 turn 的正常结果为：

```text
beforeRef = V10
afterRef = V10
changes = []
```

它仍然写入一个轻量 available checkpoint，但不重新构建整个 workspace。

### Reconcile continuity lifecycle

每次 cold start 或 gap fallback 的顺序固定为：

```text
prepare watcher subscription + pre-reconcile cursor
  -> full reconcile
  -> post-reconcile cursor + historical query from pre cursor
  -> publish trusted baseline
```

不能采用“full reconcile → initialize watcher cursor”。该顺序在 reconcile 返回与 cursor 初始化之间存在
uncovered interval；这段时间的修改可能既不在 full baseline 中，也不在后续 watcher history 中。prepare 必须
先建立 subscription 和 durable pre cursor；initialize 必须把 pre/post cursor 之间的历史结果与 callback hints
取并集。重复/乱序调用、subscription/query failure、callback overflow、unsafe path、dispose race 都保持 gap，
不得发布 baseline。Task 6 的所有 full reconcile fallback 都必须通过同一 lifecycle。

cursor publication 还必须使用 monotonic continuity generation fence：initialize 和 candidate commit 在开始时
捕获 generation，并在每个 awaited anchored mutation 后、发布 in-memory success 前复核 generation、gap 与
disposed。若 callback error/overflow 或 dispose 在磁盘 publication 期间改变 continuity，调用必须失败并把
lifecycle 标为 uninitialized；磁盘上的新 cursor 在下一次完整 prepare → reconcile → initialize 前不可信。

v1 不把 cursor trust 持久化。任何新构造或重启的 feed 都把已有 cursor bytes 当作不可信 storage artifact，
先返回 `cold-start`，再通过 prepare → full reconcile → initialize 在当前 instance 内建立 trust。我们明确否决
额外的 persistent trust marker/pending marker/recovery protocol：feed startup 是低频路径，固定支付一次 full
reconcile 可以避免第二套崩溃恢复状态机，同时保留同一 warm instance 内的增量收益。

### Immutable version 与结构共享

每个版本在逻辑上仍代表完整 workspace，物理上只创建变化路径及其祖先的新对象：

```text
V10 tree
  docs/README.md -> blob A
  src/...        -> shared trees

V11 tree
  docs/README.md -> blob B
  src/...        -> same shared trees
```

旧 checkpoint 永远引用 immutable version，不会因 tracker 前进而改变。现有 restore
planner、preview、Redo 和 snapshot retention 可以继续消费相同的 snapshot ref 契约。

当前 `scopeManifest` 内部使用单个 v1 JSON blob 保存全部 path state。即使 workspace
tree 改为 copy-on-write，如果每个边界仍然重写这份 flat manifest，正常路径仍然是
O(workspace entries)，因此该格式也必须一起增量化。目标实现增加内部 manifest v2：
`WorkspaceSnapshotRefV1.scopeManifest` 仍然是一个 immutable object id，但它指向的
descriptor 保存 scope policy、coverage 和一棵 content-addressed path-state tree。只有
变化 path 及其祖先会生成新 state-tree object；v1 reader 继续用于读取已有快照，新的
tracker 只写 v2。这个变化不修改 checkpoint、IPC 或 restore planner 的公开类型。

### Watcher 是 hint，不是 authority

tracker 必须记录 watcher/journal generation，并把以下状态视为 incremental gap：

- watcher overflow 或明确丢失事件；
- App/runtime 不在线期间的变化；
- tracker 初次启动或 persistent state 不可验证；
- canonical workspace identity/incarnation 变化；
- 目录 identity、名称集合或 path type 与增量证据不一致；
- 当前平台或文件系统不能提供可检测丢失的监听能力；
- capture 时路径发生不稳定变化。

存在 gap 时不能提交增量 available checkpoint。tracker 必须先执行 full reconcile；
reconcile 失败则由 checkpoint manager 写 unavailable 状态。

cursor/candidate storage 也是 consistency boundary：目录和 entry mutation 必须 cwd-inode anchored、no-follow，
candidate commit 必须验证生成时的 exact identity 与内容 hash，并拒绝 inode/content replacement、hardlink、
非 regular、非 private、stale/foreign candidate 和目录 exchange。callback dirty hints 使用有界去重集合；
容量溢出转为 gap。Windows 在 owner-only ACL 支持完成前不启用该 private storage。

### Full reconcile 的角色

现有 full capture 不删除，而是从每个 turn 的默认路径降级为：

- tracker startup/cold recovery；
- watcher gap/overflow 恢复；
- persistent tracker state 校验失败；
- 低频完整性审计；
- 增量边界无法稳定验证时的 fail-closed fallback。

full reconcile 成功后产生新的可信 baseline，并重新进入增量模式。

### 多 Session 行为

```text
Workspace tracker: V20 -> V21 -> V22

Session A checkpoint: before V20, after V22
Session B checkpoint: before V21, after V22
```

共享 tracker 消除重复扫描和重复 cache，但不声称解决现有设计明确列为 non-goal 的
完美写入归属。边界 diff 仍然描述“这个 turn 期间 workspace 观察到的变化”，可能包含
同一物理 workspace 中其他 actor 的写入。普通 Rewind 继续依靠 expected-current/live
drift 检查避免覆盖边界之后检测到的其他修改。

若产品未来要求严格证明“Session A 的回退绝不撤销 Session B 在 A turn 内产生的
修改”，必须增加写入 ownership 或 worktree/filesystem isolation；增量 tracker 本身既
不会恶化，也不会解决这一归属问题。

## 热路径约束

目标实现必须满足以下算法约束：

1. healthy warm、无改动 turn 不执行完整 workspace directory enumeration；
2. healthy warm capture 的文件读取和 tree 更新与 dirty path 数量及其祖先深度相关，
   不与 workspace 总 entry 数线性相关；
3. 不允许按父目录顺序启动 O(directory count) 个 reader 进程；正常 capture 的 worker
   数量必须有固定上限；
4. 同一 canonical workspace 的多个 Session 必须共享 tracker、fingerprint/index state
   和 immutable version graph；
5. quota 不能在每个 turn 边界同步遍历全部 refs/objects；使用增量 accounting、缓存或
   低频维护任务，同时在真正写入前保留硬上限；
6. workspace lock 只保护版本提交、reconcile 和必须原子化的 capture 阶段，不允许把
   Agent 整个 turn 串行化；
7. pre-turn 和 terminal latency、不同 workspace 规模、目录数量、dirty path 数量以及
   1/2/4 个并发 Session 必须进入 benchmark matrix，benchmark 结果是 rollout gate，
   不能只依靠 5 秒/30 秒 timeout 判定可用。

## 故障行为

| 场景 | 行为 |
| --- | --- |
| 无 dirty event，tracker 完整 | before/after 引用当前 immutable version |
| 少量 dirty paths | 读取、验证并 copy-on-write 更新相关路径 |
| 文件在捕获中持续变化 | 重试受影响范围；仍不稳定则 unavailable |
| watcher overflow/gap | full reconcile，不提交猜测性的空 diff |
| App/feed 重启 | cursor trust 不跨 instance；始终 full reconcile 后再进入增量模式 |
| full reconcile 超时/失败 | 写 unavailable checkpoint，Agent 对话仍保留 |
| 多 Session 同时到达边界 | 共享 dirty/version state，短暂串行提交 immutable version |
| snapshot/version 对象损坏 | hard block，并进入既有 recovery/maintenance 路径 |

## 迁移边界

第一阶段只替换 snapshot 生成层。以下接口和消费者保持兼容：

- `WorkspaceCheckpointV1`
- `WorkspaceSnapshotRefV1`
- `WorkspacePathChangeV1`
- checkpoint manager 的 available/unavailable 语义
- session-state fold
- restore planner 和 executor
- drift/force/confirmation token
- Rewind/Redo IPC 和 UI

现有 full capture 保留为 reconcile backend。在增量 tracker 通过 correctness、crash、
watcher-gap、monorepo benchmark 和多 Session 测试前，不删除旧路径。

## 验证范围

实现计划必须覆盖：

- immutable version 和结构共享；
- create/write/delete/rename、binary、symlink、executable bit；
- empty diff checkpoint；
- watcher coalescing、overflow、restart gap 和 cold reconcile；
- racy-clean、同 size/timestamp 改写和目录 rename；
- Git/non-Git workspace；
- multiple Session 共用 tracker，但 checkpoint/session identity 不串线；
- reconcile 失败只能得到 unavailable，不能得到错误的 available empty checkpoint；
- full snapshot 与 incremental snapshot 对同一操作序列生成等价 tree/manifest/diff；
- 10k/50k/200k entry、深目录、宽目录、0/1/100 dirty paths 和 1/2/4 Session 的
  benchmark matrix；
- warm no-change capture 不发生全量枚举或与目录数成比例的进程启动。

## 决策结论

保留每个 durable turn 的逻辑 checkpoint 和现有 fail-closed Rewind 语义。把物理层从
per-session、per-boundary full capture 改为 canonical-workspace 级共享的 immutable
incremental snapshot tracker。watcher 只提供 dirty hints；任何 gap 或不确定状态必须
full reconcile，reconcile 失败必须显式 unavailable。

这项优化修正的是原设计缺失的 monorepo 和多 Session 性能维度，不以降低恢复正确性
换取速度，也不重新依赖 Agent 工具级变更记录。
