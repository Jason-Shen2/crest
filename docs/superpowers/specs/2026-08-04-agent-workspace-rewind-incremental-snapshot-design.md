# Agent Workspace Rewind Incremental Snapshot Design

**状态：** 已实现；保留 cold/dirty 性能与未测平台限制

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

## 从原始实现到当前实现

优化过程保持了一个简单边界：先确认逻辑 checkpoint 不能减少，再把重复的物理全量扫描
从 checkpoint manager 中抽离。实现顺序是 manifest v2 结构共享、watcher continuity、增量
path capture、full fallback、quota 增量计费、canonical tracker registry、多 Session 接线，最后
用等价性、E2E 和 benchmark 收口。没有增加第二套恢复 journal、环境开关、IPC schema 或 UI
状态。

## 原始实现与问题根因

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
prepare 也必须经过同一 fence；dispose 竞争产生的 late pre-reconcile cursor 必须在返回失败前删除。

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
`WorkspaceSnapshotRefV1.scopeManifest` 仍然是一个 immutable manifest blob id；manifest
保存 scope policy、coverage 和 content-addressed path-state tree 的 OID。snapshot descriptor
用名为 `state` 的 tree entry 直接引用同一个 state-tree OID，确保 owner ref 可以让整棵 state
graph 在 Git GC 后继续存活。v1 descriptor 必须严格只有 `scope-manifest` 与 `workspace` 两项；
v2 descriptor 必须严格增加第三项 `state`，并与 manifest 的 `statetree` 完全一致。只有
变化 path 及其祖先会生成新 state-tree object；v1 reader 继续用于读取已有快照，新的
tracker 只写 v2。这个变化不修改 checkpoint、IPC 或 restore planner 的公开类型。

manifest v2 的 coverage 使用明确的 lowercase wire schema（例如 `eligibleentrycount`、
`pathbytesbase64`），reader 在 canonical 校验后才转换成现有 camelCase domain coverage。
完整 verification 按固定 512 个 state blob 一批使用 `git cat-file --batch`，避免为大型 workspace
的每个 leaf 启动一个 Git 进程；单个 state blob 和每批输出都有固定上限。

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
容量溢出转为 gap。tracker 必须由 anchored primitive 在 private store root 下建立，live lifecycle 固定 root
identity，并拒绝 store-root symlink 或 read/publication 间的 root exchange。rename 前失败要删除随机 journal temp；
prepare 只按名称回收保留格式的 candidate/temp，不打开或信任其内容。candidate commit 失败撤销 candidate 后，允许一次完整 reconcile 恢复，
不增加跨进程恢复协议。Windows 在 owner-only ACL 支持完成前不启用该 private storage。

### 增量捕获实现审查后的安全收敛

首轮实现证明 dirty-path 捕获可以把热路径从 workspace 全量扫描缩小到变化范围，但
代码审查同时发现了几个不能留到后续处理的正确性窗口。最终采用以下收敛方案，且不
增加 journal 或 recovery 状态机：

1. Git scope manifest 显式记录实际 index 的 canonical path、父目录 identity，以及
   index 的 present/absent 状态。present 状态通过 `O_NOFOLLOW` 文件句柄前后 identity
   和流式内容 hash 证明；absent 状态通过 anchored parent 和二次缺失确认来证明。
   linked worktree 的 index 即使位于 workspace 外部，也使用同一证据；旧 Git manifest
   没有该证据时直接 full reconcile。
2. dirty bytes 先写入 OS private `0700` 临时目录，capture 阶段只计算 Git OID，不向
   snapshot object database 写入未被 ref 引用的 blob。公开 capture result 保持不变，
   私有 opaque batch 通过对象 identity 与 result 单次绑定，可显式 consume 或 discard。
3. snapshot store 在既有 workspace lock 内重新验证临时目录、文件 identity、原始 bytes
   和 SHA-1 OID，然后完成 blob materialize、copy-on-write tree/manifest 和 owner ref
   publication。临时数据失败后直接删除，不需要崩溃恢复协议。
4. incremental capture 必须从 v2 base state tree 读取 dirty root 的节点类型。base leaf
   变成 current tree、或 base tree 变成 current leaf 时 fail closed；合法删除和新目录
   继续按增量 mutation 表达。v1 或不可读 base 直接 full reconcile。
5. batch reader 使用共享 abort signal。任一 worker 失败后立即中止 sibling，并等待所有
   child 完全退出后再返回原始错误，避免调用方清理 staging 后仍有后台写入。
6. 错误分类保持窄语义：只有已观测到的 path identity/content race 才是
   `unstable-path`；Git runner、权限、I/O 或未知证据失败都是 `unsafe-evidence`。只有
   `rev-parse` exit 128 且 stderr 精确表示 `not a git repository` 时才能判定为 non-Git；
   dubious ownership、损坏 gitfile、权限问题和 malformed output 都必须 fail closed。

这些修改保留了原方案的简单性：没有新增 ref、pending marker、journal 或 recovery UI，
只把“准备 bytes”和“在锁内发布 immutable snapshot”之间的所有权与校验边界定义清楚。

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

现有 full capture 保留为 reconcile backend。增量 tracker 已通过 correctness、crash、
watcher-gap、等价性和多 Session 测试；未完成的 benchmark 平台/规模明确保留为限制，
不通过提高 timeout 或隐藏结构化 timeout row 来宣称完成。

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

## 增量捕获安全审查收口

实现阶段的安全审查补充以下约束。这些约束收敛在进程内的 capture 生命周期中，不引入
journal、持久化 recovery 或新的用户可见状态：

- Windows 暂不依赖 `chmod(0700)` 证明 staging 目录仅当前用户可访问。需要 staging 的
  增量捕获直接 fail closed 到 full reconcile，直到实现并验证 owner-only ACL；
- capture 实例使用 `active -> disposing -> disposed` 状态机。`dispose()` 先拒绝新捕获，
  abort 并等待在途捕获，再清理仍归实例所有的 batch/staging root；清理失败保留 ownership，
  后续 `dispose()` 或 `discardCaptured()` 可以重试；
- 每个 pending batch 同时只允许一个 terminal operation reservation。consume、discard 和 dispose
  不得并发清理同一个 staging root；dispose 必须等待已获得 reservation 的操作结束。consumer
  已执行但 cleanup 失败时，只允许重试 cleanup，不能再次执行 consumer；
- dispose cleanup 失败后，实例保持关闭，但允许对仍由实例持有的 batch 显式执行 discard-only
  cleanup 重试；该入口不能恢复 capture 或 consumer；
- consumer 失败与 staging cleanup 失败必须同时保留在 `AggregateError` 中，不能用清理错误
  覆盖原始业务错误；
- 一次 capture 只有一个总 deadline。scope/index 验证、base-kind 读取、anchored reader、
  hash-object 和最终注册都消费同一预算；reader batch 也使用总 deadline，而不是给每个 worker
  重新分配完整 timeout；
- 内部 deadline 引发的 Git abort 必须重新映射为 capture timeout；调用者主动 abort 保留原语义。
  base-kind reader 接收同一个 `AbortSignal`，并把它传到 snapshot manifest 的 Git 读取；capture
  结束时不能遗留仍在执行的 base read；
- 空 dirty-path capture 在注册 empty batch 前同样检查 abort/deadline。base node-kind 只按已拥有的
  immutable snapshot OID 读取 descriptor、manifest 和 state tree，不进入 workspace mutation lock，
  避免并发 Session 的 commit/maintenance 阻塞 capture deadline；
- Git index 在 warm stable 路径先验证 canonical path、parent identity 和完整 entry metadata。
  只有 identity 不可靠或仍处于 anchored-reader 的 racy window 时才重新读取并 hash 内容；
  split-index 和 sparse-index 必须通过 capability-gated 集成测试；
- persisted manifest 的 Git index `parentPath` 必须严格等于 `dirname(path)`，避免把路径和父目录
  identity 拼接成互不相关的证据。

这些规则只强化现有 fail-closed 模型，不改变 logical checkpoint、snapshot ref、Rewind/Redo
或 turn Undo 的 API 与语义。

## Benchmark 结果

### Gate 设计与实现过程

Task 10 把性能验证分成两个层次：

1. 默认 CI 运行不依赖 wall-clock 的 algorithmic contract。warm 和单 dirty path 使用最小的真实
   `WorkspaceSnapshotStore`、`WorkspaceSnapshotTracker` 与 `IncrementalPathCapture`；100 parent
   并发上限直接运行生产 `runAnchoredReaderBatch`，但注入无磁盘 I/O 的可控 group reader；
   1/2/4 Session 则通过真实 `WorkspaceTrackerRegistry` 取得同一个真实 store/tracker，并发调用
   `capture()`，验证只产生一个 cold full baseline 且返回同一个 snapshot ref。这样保留真实决策点，
   又不会在默认 CI 中重复执行 100 次 Git COW 和 child process。
   该 gate 同时断言 `openStore=1`、`makeTracker=1`、`captureFullReconcile=1`，以及 cold capture 的
   incremental enumeration 和 anchored worker 均为 0；不是仅凭对象 identity 推断 baseline 共享。
2. opt-in benchmark 才记录本机 p50/p95。脚本默认覆盖 10k/50k/200k entries、deep/wide、
   dirty 0/1/100 和 Session 1/2/4，也允许用 `--entries`、`--iterations` 跑小矩阵。

审查后收紧了 benchmark 的两项计量语义。`enumerated entries` 现在只在 scope enumeration
边界计数：full capture 统计实际扫描的目录、eligible entry 与 excluded entry，并按真实 retry
attempt 累加；incremental capture 统计 dirty subtree 中实际访问和分类的目录、leaf 与 absent
entry。它不再借用 anchored reader 的 leaf 读取次数，因此不会遗漏目录，也不会因读取重试而
虚增。这个观察回调与 worker start/settle 回调均为 fail-open；回调异常不能改变 capture 的
成功、原始错误或 abort 结果。

Session 维度也不再用同一 tracker 上的普通并发 caller 模拟。每个 measured row 通过真实
`WorkspaceTrackerRegistry` 获取 1/2/4 个 lease，每个 lease 调用一次共享 tracker capture，
并在 `finally` 中逐个 release。fixture 只保留一个 keeper lease 维持 warm baseline，不参与
计时或 Session 计数。脚本把 cold、representative baseline 和 warm 的 capture timeout 都写成
结构化 row 并继续后续矩阵；representative baseline 不可用时，九条 dependent warm row 仍以
`baseline-unavailable` 和完整字段输出。非 timeout 错误继续让进程非零退出。

首轮 100-dirty 测试发现每个 path 都重新打开一次 immutable manifest reader。虽然这不重新
枚举 workspace，但会丢失 state-tree ancestor cache，并把 deep path 的 Git 读取显著放大。
最终只增加了一个 batch `readNodeKinds` 入口：一次 capture 使用一个局部
`StoredManifestReader`，共享该 reader 已有的 tree cache；reader 不跨 capture 保存，不增加持久化
状态、journal 或 recovery。单-path fallback 仍保持顺序 await，错误和 abort 继续走原有
fail-closed 路径。

worker instrumentation 紧贴生产 batch scheduler 的 group start/settle，默认未注入时无额外运行路径。
实际向生产 scheduler 输入 100 个不同 parent，contract 观测到 100 次 group reader 调用、peak 8；
不是根据常量推导结果。首版 contract 让 100 个 group 真实执行 Git COW/child process，单独运行约
24 秒，并在 full suite 的并发 I/O 下超过 30 秒。该版本不适合作为默认 CI gate，因此改成上述
轻量 reader；真实 filesystem 成本只留给 opt-in benchmark。

### Algorithmic contract

2026-08-06 本机结果：`snapshot-performance.test.ts` 6/6 PASS。

| 场景 | full reconcile | enumerated entries | worker peak | exact quota scan | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| warm、无改动 | 0 | 0 | 0 | 0 | `after.ref === before.ref` |
| 1 dirty path | 0 | 1 | 1 | 仅与增量提交相关，不进入 no-change gate | path-local |
| 100 dirty paths / 100 parents | 不适用 | 100 个调度 group | 8 | 不适用 | 生产 scheduler bounded |
| 1/2/4 Session 并发 cold capture | 1 | 0 | 0 | 仅 cold baseline 正常计费 | 同一个真实 tracker、同一个 ref |

计数测试不设置毫秒阈值，因此机器负载变化不会让默认 CI 变成 flaky performance test。

### 本机环境

| 项目 | 值 |
| --- | --- |
| 日期 | 2026-08-06（Asia/Shanghai） |
| CPU | Apple M5 Pro |
| OS | macOS 26.4.1 (25E253) |
| filesystem | APFS，4 KiB allocation/device block，内部 SSD |
| Node | v22.22.3 |
| Electron | 41.1.0 |

命令：

```bash
npm run benchmark:agent-rewind-snapshots -- --entries=10000 --iterations=10
```

fixture 的 entry count 包含文件和显式目录。deep 使用 `ceil(log2(entries))` 层目录，10k 时为
14 层；wide 使用 8 个同级目录，让 100-dirty row 实际覆盖 8-worker 上限。每个 shape 先跑
deterministic unique-content cold probe，再用固定 64-bucket content pool 建立可复现 baseline 并
执行完整 warm matrix。这里明确记录 content cardinality，避免用全部同内容文件掩盖 full capture
对象成本。以下 `enumerated`、`new objects` 和 `hashed bytes` 是 10 iterations 的 row 总量；
p50/p95 是每次 1/2/4 个真实 registry lease 全部完成共享 capture 的边界延迟。

| shape | mode | cardinality | dirty | sessions | p50 ms | p95 ms | full | enumerated | worker peak | new objects | hashed bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| deep | full, unique | 9,986 | 0 | 1 | timeout | timeout | 1 | 10,000 | 1 | 20,004 | 0 |
| deep | full, representative | 64 | 0 | 1 | 10,180.33 | 10,180.33 | 1 | 10,000 | 1 | 160 | 98,298 |
| deep | warm | 64 | 0 | 1 | 0.01 | 0.07 | 0 | 0 | 0 | 0 | 0 |
| deep | warm | 64 | 0 | 2 | 0.01 | 0.04 | 0 | 0 | 0 | 0 | 0 |
| deep | warm | 64 | 0 | 4 | 0.02 | 0.03 | 0 | 0 | 0 | 0 | 0 |
| deep | warm | 64 | 1 | 1 | 3,150.33 | 3,432.64 | 0 | 10 | 1 | 340 | 70 |
| deep | warm | 64 | 1 | 2 | 3,105.72 | 3,266.15 | 0 | 10 | 1 | 340 | 70 |
| deep | warm | 64 | 1 | 4 | 3,205.26 | 3,548.44 | 0 | 10 | 1 | 340 | 70 |
| deep | warm | 64 | 100 | 1 | 14,822.36 | 15,397.52 | 0 | 1,000 | 1 | 2,320 | 9,900 |
| deep | warm | 64 | 100 | 2 | 19,212.79 | 21,625.37 | 0 | 1,000 | 1 | 2,320 | 9,900 |
| deep | warm | 64 | 100 | 4 | 18,413.55 | 21,272.26 | 0 | 1,000 | 1 | 2,320 | 9,900 |
| wide | full, unique | 9,992 | 0 | 1 | timeout | timeout | 1 | 10,000 | 1 | 20,004 | 0 |
| wide | full, representative | 64 | 0 | 1 | 12,209.81 | 12,209.81 | 1 | 10,000 | 1 | 148 | 98,352 |
| wide | warm | 64 | 0 | 1 | 0.00 | 0.02 | 0 | 0 | 0 | 0 | 0 |
| wide | warm | 64 | 0 | 2 | 0.00 | 0.02 | 0 | 0 | 0 | 0 | 0 |
| wide | warm | 64 | 0 | 4 | 0.01 | 0.02 | 0 | 0 | 0 | 0 | 0 |
| wide | warm | 64 | 1 | 1 | 1,160.12 | 1,463.86 | 0 | 10 | 1 | 80 | 70 |
| wide | warm | 64 | 1 | 2 | 1,130.69 | 1,702.45 | 0 | 10 | 1 | 80 | 70 |
| wide | warm | 64 | 1 | 4 | 1,197.43 | 1,372.72 | 0 | 10 | 1 | 80 | 70 |
| wide | warm | 64 | 100 | 1 | 16,978.32 | 18,752.24 | 0 | 1,000 | 8 | 2,200 | 9,900 |
| wide | warm | 64 | 100 | 2 | 17,683.89 | 19,054.51 | 0 | 1,000 | 8 | 2,200 | 9,900 |
| wide | warm | 64 | 100 | 4 | 17,322.51 | 19,088.67 | 0 | 1,000 | 8 | 2,200 | 9,900 |

unique-content cold probe 在生产 30 秒 capture deadline 内没有完成（本次 deep/wide 结构化
timeout row 分别在 38,284.07 ms 和 32,287.12 ms 返回，包括 timeout 后的资源清理）。表中的 timeout 是结构化
结果，不是提高 timeout 后得到的数字；失败后的 object inventory 证明该路径创建约 20k loose
objects，full capture/object durability 仍是 rollout limitation。64-bucket baseline 仅用于建立
真实 tracker 以测 warm matrix，不能替代或粉饰 unique-content cold latency。

50k/200k 和 Linux/Windows 尚未在本机实测。macOS/APFS 的 10k healthy warm/no-change 已满足
“成本不随 workspace 总 entries 线性增长”的算法证据；不能据此宣称其他平台或 cold full capture
已经优化完成。Linux/Windows 尤其需要分别验证 Parcel 历史查询、filesystem watcher continuity、
owner-only staging 和 warm latency 后才能解除平台限制。

## 决策结论

保留每个 durable turn 的逻辑 checkpoint 和现有 fail-closed Rewind 语义。把物理层从
per-session、per-boundary full capture 改为 canonical-workspace 级共享的 immutable
incremental snapshot tracker。watcher 只提供 dirty hints；任何 gap 或不确定状态必须
full reconcile，reconcile 失败必须显式 unavailable。

这项优化修正的是原设计缺失的 monorepo 和多 Session 性能维度，不以降低恢复正确性
换取速度，也不重新依赖 Agent 工具级变更记录。
