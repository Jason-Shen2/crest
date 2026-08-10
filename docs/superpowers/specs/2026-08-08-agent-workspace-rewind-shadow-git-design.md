# Agent Workspace Rewind Shared Shadow Git 设计

**日期：** 2026-08-08

**状态：** 功能实现完成，验证/closeout 中；200k 合成规模门禁已通过，repo-wide baseline gate 尚未闭合

**上游设计：**

- `2026-07-28-agent-workspace-rewind-design.md`
- `2026-08-02-agent-rewind-recovery-simplification-design.md`
- `2026-08-04-agent-workspace-rewind-incremental-snapshot-design.md`

本文是 2026-08-04 增量快照设计的后继方案。旧设计和 benchmark 保留为问题发现、
优化过程和历史证据；本文替代其下一阶段目标架构，最终完成状态以实施计划中的 correctness/tsc
与 closeout 门禁为准。

## 结论

Workspace Rewind 的物理状态层收敛为：

```text
一个 Workspace 级 Shared Shadow Git commit log
+ Agent Runtime Workspace Writer Lease
+ Turn 到 owned commit 的逻辑 checkpoint
+ 基于 commit 历史的路径级冲突检查和选择性恢复
+ 一条 pending restore intent
```

不再建设持久化 watcher event log、独立 Path MVCC 数据库、自定义 Merkle tree 和复杂
Recovery 状态机。Git object、tree、commit 和 ref 已经分别提供内容寻址、结构共享、版本
历史和原子 head 更新；重复实现这些能力只会增加状态同步和故障恢复成本。

## 为什么再次简化

2026-08-04 方案正确地把每个 Session、每个边界的全量扫描改成 Workspace 级共享增量
tracker，但目标架构仍同时维护 snapshot Git object store、自定义 path-state tree、
watcher cursor/continuity、tracker state、fingerprint cache 和 restore journal。

这些机制分别合理，但组合后出现了多个近似事实来源：Git tree 记录文件状态，自定义
state tree 也记录文件状态；Git commit 可以记录修改顺序，Path MVCC 又记录一遍修改顺序；
filesystem watcher 既是 hint，又逐渐承担持久连续性证明。任何一次 crash、cursor gap 或
publication failure 都需要回答“哪一份状态才是真的”。

新的判断标准是：只有直接满足以下硬约束的组件才进入核心架构。

## 必须满足的硬约束

1. **工具无关。** shell、PTY、CLI Agent 和未来工具的修改与 write/edit 一样可覆盖。
2. **Monorepo 热路径按变化量工作。** 正常 turn 成本不能随 Workspace 总文件数线性增长。
3. **Crest Session 互不覆盖。** Session A 回退不能静默覆盖 Session B 后续修改。
4. **精确 Turn diff。** Review、Undo、Redo 使用该 turn 实际产生的 before → after。
5. **选择性恢复。** 永不执行 `reset --hard`、`clean -fd` 或全树 checkout。
6. **崩溃后可判定。** 多文件恢复中途崩溃不能留下无法识别的静默半完成状态。

## 方案比较

### A. Shared Shadow Git commit log + Writer Lease

选定方案。一个 Workspace 只有一条物理版本历史，所有 Session checkpoint 只引用其中
属于自己的 commit。Git 同时承担 snapshot、结构共享和路径历史职责。

### B. Shadow Git + 持久 event log + 独立 Path MVCC

热路径理论上可以更快，但存在三套状态和三种恢复协议。只有 production profiling 证明
Git 候选发现或历史查询无法满足目标后，才允许增加可重建缓存；不提前建设第二事实源。

### C. 每个 Session 独立 worktree

能提供 Crest Session、用户编辑器和外部进程之间最强的并行隔离，但不再是“同一个物理
Workspace”。它保留为用户显式选择的隔离模式，不由 Rewind 自动创建或切换。

## 单一物理事实源

每个 canonical Workspace 使用一个私有 bare Git repository：

```text
<wave-data>/agent-checkpoints/workspaces/<identity>-<incarnation>/repo.git
```

它不修改用户仓库的 HEAD、index、branch、stash、hook 或 reflog。内部只有一条权威 ref：

```text
refs/crest/workspace-head
```

每个 commit tree 表示一次已确认的 eligible Workspace 状态。commit metadata 至少包含
schema、Workspace identity/incarnation、kind、Session、turn 和 operation identity。
`kind` 只允许 `external`、`agent-turn`、`turn-undo`、`turn-redo`、`rewind` 和 `redo`。

修改顺序、owner 和 ABA 历史都来自这条 commit chain。第一版不增加独立 `path_head` 或
version table；若 profiling 证明 `git log -- <paths>` 成为瓶颈，可以增加完全可从 commit
chain 重建的索引缓存，但缓存永远不参与正确性判定。

## Workspace Writer Lease

Git history 能记录修改顺序，但不能判断两个同时运行的进程各自写了哪些字节。因此严格
的 Crest Session 归属需要一个 canonical Workspace Writer Lease。

Lease 位于 Agent Runtime 的通用工具执行边界，不位于 write/edit 工具内部：

1. 第一个可能写 Workspace 的工具执行前获取 lease；
2. shell、PTY、CLI Agent 和未来工具自动经过同一入口；
3. lease 保持到该 user turn terminal；
4. 其他 Session 可以继续对话和推理，但 Workspace 写工具等待；
5. 没有调用 Workspace-capable tool 的 turn 不获取 lease。

无法可靠证明只读的 shell 命令按“可能写入”处理。脱离父进程继续写文件的后台任务，在
退出或完成前不得生成 available terminal checkpoint；第一版不为 detached writer 建设
进程归属系统。

Lease 解决的是 Crest Session 之间的归属。用户编辑器或外部进程仍可绕过 lease；如果它
们在 Agent 持有 lease 时写同一路径，系统无法从普通文件系统事件中可靠区分 owner。
严格隔离这类 actor 必须使用独立 worktree，不在核心算法里伪造保证。

## 候选路径发现

Shadow Git 是状态 authority；候选发现只决定“需要检查哪些路径”，不能直接宣告状态。

### Git Workspace

使用 Git 自身的 index、built-in fsmonitor、untracked cache 和 status/diff plumbing 发现
tracked、deleted 和 untracked candidate。正常热路径只读取候选路径并构造新 tree。

首次初始化优先复用用户仓库的 clean tracked tree/object database，只物化 dirty 和
untracked 内容。具有非确定性 clean/smudge filter、特殊 attributes 或无法证明 round-trip
的路径不能宣称 raw-byte 精确；这些路径必须额外捕获，或明确标为 unavailable。

#### Git-native cold baseline

首次没有 Shadow head 时，Git Workspace 不再默认把每个 clean tracked 文件从工作树复制、
重新 hash 一遍。初始化固定执行以下最小流程：

1. 解析 canonical repository root、Workspace prefix 和 `HEAD:<prefix>` tree；只接受当前
   Shadow store 已支持的 SHA-1 object format。unborn HEAD、对象缺失、SHA-256 或边界无法
   证明时回到现有 full reconcile；full reconcile 超过生产预算则明确 unavailable。
2. 在读取 Workspace 状态前启动现有内存 change feed。继续使用 metadata scope discovery
   建立 ignored、nested repository、hard-link、special entry、非 UTF-8、oversized、实际
   sparse/缺失路径和 coverage 证据；它不读取 clean tracked 文件内容。
3. safe clean tracked path 直接复用 source tree 的 mode 与 blob OID。Git status 中的 dirty、
   staged、deleted、untracked path，以及 filter、ident、working-tree-encoding、index/worktree
   EOL、mode 或 type 无法证明 raw-byte round-trip 的 path，继续走现有 stable path capture。
4. source Workspace subtree 的 object closure 使用受限的本地
   `pack-objects --stdout --revs` → private `index-pack --stdin` 流式导入。流量受剩余 quota 和
   free-space 预算限制，禁止 replace object、lazy partial-clone fetch、hook 和网络；导入后由
   private object database 重新验证 tree closure，checkpoint 不依赖用户仓库继续保留对象。
5. private index 从 source tree 开始，删除物理缺失或 scope-excluded path，再叠加精确捕获的
   path，生成最终 tree。发布前重新验证 HEAD、Git index、status/change-feed generation 与
   directory evidence；变化时只合并重试一次，仍变化则 fail closed。

这条 fast path 不增加 durable cursor、数据库、WAL、cache 或新的恢复协议。现有 Shadow Git
commit/ref 仍是唯一持久事实源。`git fetch --depth=1` 不作为实现基础：它不能精确导入任意
Workspace subtree，nested Workspace 会额外导入 sibling objects，并引入 shallow/local transport
状态；显式 pack closure 的边界更小且可验证。

首次 cold 的 raw-byte 保证存在一个不可消除的信任边界：没有此前可信 journal 时，若要求识别
刻意保持 inode/size/timestamps 的对抗性篡改，就必须读取并 hash 全部文件。Git-native fast path
明确接受 Git index/stat cache 对 safe clean tracked path 的判断；任何 checkout transform 或证据
歧义都读取实际工作树 bytes。Non-Git cold 不具备 source object authority，仍使用现有全量稳定
捕获。仅把全量 reader 并行化可以改善 fallback，但不会替代该算法，也不能消除
`O(total raw bytes)` 的最坏成本。

### Non-Git Workspace

首次使用必须建立一次完整 baseline，这是没有现有 index 时不可消除的成本。warm runtime
使用内存 dirty set；watcher 只提供 hint，不保存 cursor WAL，也不成为 durable authority。
overflow、runtime 重启或 watcher trust 丢失后执行 full reconcile；无法在预算内完成时
checkpoint unavailable。

### 稳定性

候选读取必须验证 path identity、type 和内容稳定性。捕获完成后再查询一次候选；若出现
新变化，合并后重试一次。仍持续变化的 turn 标为 unavailable，不引入无限重试或新状态机。

## Turn checkpoint

逻辑 checkpoint 与物理 commit 分离，但不增加新的 checkpoint wire schema。继续复用现有
`before`、`after`、`changes` 和 `coverage`：`before.id` 是本 turn 获取 writer lease 后的
base commit，`after.id` 是该 Session、该 turn 拥有的 result commit。owner 直接从 after
commit metadata 验证，不在 checkpoint 中重复保存 `mutationcommit`。其他 Session 在同一段
墙钟时间内产生的 commit 不会被算进本 turn 的 `changes`。

### 没有 Workspace 工具

```text
changes = []
basecommit = resultcommit = 当前可见 workspace head
```

不扫描 Workspace，不创建物理 commit。即使另一 Session 同时推进全局 head，也不会把
对方的变化归入本 turn。

### 有工具但没有净变化

获取 lease 后验证候选；如果最终 tree 与 base 相同，`before == after`。仍写一个轻量
available checkpoint，但不创建空 Git commit。

### 有净变化

1. 获取 lease 后先把 lease 之前的 live drift 写成 `external` commit；
2. 该 commit 之后的 head 成为 turn `basecommit`；
3. terminal 只捕获候选路径；
4. 创建 `agent-turn` commit，metadata 记录 Session 和 turn；
5. checkpoint 的 `after.id` 指向该 commit，`before.id` 指向它的 parent；
6. 释放 lease。

## Turn Undo/Redo

Turn Undo 使用 `after commit parent → after commit` 得到精确 before → after，然后：

1. 获取 Workspace Writer Lease；
2. 将当前 live drift 同步成 `external` commit；
3. 得到 target turn 的 changed paths；
4. 检查 target commit 之后是否有不属于本次 Undo 集合的 commit 修改同一路径；
5. 有 overlap 时 fail closed，即使最终 bytes 又相同；
6. 只把目标路径恢复到 target parent 的状态；
7. 追加 `turn-undo` commit，不移动任何对话节点。

Redo 只允许紧接对应 Undo 的精确逆操作，追加 `turn-redo` commit。任何 overlap 或 live
drift 都使 Redo 失效，不提供 Force。

## 会话 Rewind/Redo

会话 Rewind 收集被移除 conversation suffix 中由该 Session 拥有的所有 mutation commit。
它不把整个 Workspace 重置到旧 head：

1. 合并这些 commit 的 changed paths；
2. 同一 target path 恢复到集合中最早 commit 的 parent 状态；
3. 集合内部的后续覆盖属于本次 Rewind，可以一起折叠；
4. 集合之外任一 commit 修改相同路径都视为冲突；
5. 非重叠路径永远保留；
6. 文件 commit 成功后才移动 conversation leaf。

Redo 保存被 Rewind 撤销的 exact commit set，并按相同 overlap 规则应用逆变化。它追加新的
`redo` commit，不移动 Shadow Git head 回到历史位置。

## 多 Session 安全

```text
C10 external
C11 Session A / Turn A1 / README.md
C12 Session B / Turn B1 / package.json
C13 Session B / Turn B2 / README.md
```

- A 回退 A1 时，C12 不重叠，`package.json` 保留；
- C13 修改了同一路径，A1 回退被阻止；
- 即使 C13 最后把 README 改回 C11 的 bytes，历史仍证明 B 写过该路径，避免 ABA；
- 不需要第二套 Path MVCC 数据库。

Force 只可用于明确归类为 external drift 的精确预览路径；任何 Crest Session-owned overlap
都不可 Force。

## 最小崩溃保护

多文件 Workspace 写入和 Session SQLite leaf 更新无法成为同一个原子事务，因此不能完全
删除 crash intent。但只保留一条存在/不存在的 pending record。它记录 operation、source
commit、planned commit、affected paths、Session 和可选 conversation leaf CAS。

正常流程是：计算 planned tree/commit、持久化 pending、原子替换目标文件、验证、CAS 推进
Shadow Git ref、需要时 CAS 移动 conversation leaf、删除 pending。

重启后只比较 pending、Shadow Git head、Session leaf 和目标路径：

- head 仍是 source：恢复 source paths，删除 pending；
- head 已是 planned 且文件匹配：补完 conversation leaf，删除 pending；
- 其他状态：只阻止该 Workspace 的新写入并要求人工处理。

它不是长期 Recovery registry，不缓存 `frozen` 状态，不广播多层 recovery phase，也不影响
其他 Workspace。

## 性能模型

| 场景 | 目标复杂度 |
| --- | --- |
| 没有 Workspace 工具的 turn | O(1) |
| warm、无净变化 | 接近 O(candidate paths)，Git fallback 可能扫描 metadata |
| 修改 k 个文件 | O(k + changed bytes + affected tree depth) |
| Turn Undo | O(changed paths + restored bytes + checkpoint 后 overlap history) |
| 会话 Rewind | O(unique affected paths + restored bytes + suffix 后 overlap history) |
| 存储 | O(unique changed content + small commits/trees) |

大规模生成、依赖安装或 branch checkout 本身修改大量路径时，成本必然随变化量增长；算法
不能把真实的 100k 文件变化伪装成 O(1)。首次 non-Git baseline、Git fsmonitor 无效后的
fallback 和故障 reconcile 也可能扫描目录 metadata，但不再是每 turn 默认路径。

## 明确删除和延期

### 从目标架构删除

- persistent watcher event WAL/cursor publication；
- 独立 Path MVCC/version database；
- 自定义 path-state Merkle tree；
- per-Session physical snapshot store；
- 每个 turn 的 full Workspace capture；
- 多阶段 Recovery journal 和长期 frozen registry。

### 只有测量后才能增加

- 可从 commit chain 重建的 `path_head` 查询缓存；
- live UI 使用的非权威 watcher；
- Git maintenance/pack 调优；
- background integrity audit；
- 自动 retention tuning。

### 保留为显式产品模式

- 每 Session 独立 worktree；
- 外部进程与 Agent 的严格并行隔离。

## 验收条件

1. 一个 canonical Workspace 只有一个 Shadow Git head 和一条 mutation chain。
2. checkpoint 的变化只能来自其 owned after commit，不能来自墙钟边界的全局 tree diff。
3. 两个 Crest Session 的 Workspace-capable tools 不能并行持有 writer lease。
4. 无 Workspace 工具 turn 不枚举 Workspace、不创建 commit。
5. 1/10/100 个文件的 warm 成本与 Workspace 总规模近似无关。
6. Session A 的 Undo/Rewind 永不覆盖 Session B 的同路径 commit，包括 ABA。
7. 非重叠 Session 修改在 Undo/Rewind 后逐字节保留。
8. shell、PTY 和 CLI Agent 的净修改与 write/edit 一样进入 owned commit。
9. crash matrix 只围绕 pending absent/source/planned/unknown 四种事实状态，不出现 phase
   transition 测试。
10. 10k、50k、200k Git monorepo 分别验证 cold、warm no-op、1/10/100 dirty paths 和
    1/2/4 Session contention。
11. Git attributes/filter、symlink、executable、binary、rename、nested repository 和 ignored
    scope 都有明确覆盖或 unavailable 结果。

## 决策摘要

2026-08-04 设计证明了“逻辑 checkpoint 不等于物理全量扫描”，但实现复杂度继续增长的
根因是尝试在 Git 之外维护另一套 durable 增量状态系统。本设计进一步把 Git commit chain
提升为唯一物理事实源，并通过 Runtime Writer Lease 解决 Git 无法判断 Session ownership 的
问题。

最终保留的复杂度都直接对应一个不可删除的硬约束；任何新缓存或索引都必须先有 production
profiling 证据，并保持可从 Shadow Git 完全重建。

## 实现记录：Task 9 authority cutover（2026-08-09）

Task 9 已完成规格与质量双重审查。最终实现删除了旧 `writeStateTree`、durable tracker、watcher
WAL/cursor 和自定义 state tree；候选路径与 compact coverage 只是可验证输入，不构成第二权威。
持久事实仍只有 private Shadow Git 的 object/tree/commit/ref 与 Session/pending owner reachability。

本轮 closeout 前的必要优化如下：

- fresh non-Git authority 在首次 full capture 前启动 feed，保留 capture 期间事件，并只在 feed
  仍可信且并发 CAS winner 的 tree/scope/coverage 语义等价时采用 warm baseline；
- snapshot object anchor 与 manifest association 使用一次带双 CAS 的
  `update-ref --no-deref --stdin` transaction 原子发布，quota roots 同时遍历并去重 `refs/crest`
  与 `refs/crest-objects`，不会漏算只由历史 orphan anchor 保活的对象；
- candidate eligible-entry coverage 从一次 native
  `diff-tree --name-status -r -z --no-renames` 的 A/D/M/T leaf delta 派生，directory rename 与
  file/directory replacement 不再造成计数漂移，也不回退到 live Workspace full scan；
- 删除自证的 50×100 `Map` projection oracle，改为十一项真实 Git/non-Git V3 操作矩阵；每一步
  都对 candidate head 与独立 native full reconcile 的 tree、scope、semantic coverage 和 exact
  changed paths 做比较，覆盖 same-size rewrite、chmod、symlink、delete、file↔directory、directory
  rename、`.gitignore` invalidation 与 nested repository boundary。

验证证据：联合 focused 九文件 122/122；IPC 与 production E2E 两文件 126/126；feature/service、
checkpoint-manager、engine、multi-Session 与 tool-independent 七文件 75/75；performance contracts
2/2（包含 100 dirty parent groups bound）。forbidden authority scan 无匹配，三次实现提交的 diff
通过 `git diff --check`，closeout 前 worktree clean。已知的 pre-closeout full-suite 并发基线为
42/45 files、731 pass、6 timeout、2 skip；仅 `pending-restore` 四项、`snapshot-retention` 一项和
`snapshot-source` 一项触发既有 5 秒并发 timeout，三文件 focused 为 45/45 PASS。A/B/C 后没有
把该旧基线表述成 latest-HEAD full run，也没有提高 timeout 或伪报零延迟；Task 10 的 correctness
gate 将负责重新执行完整门禁。

## 实现记录：Task 10A Git-native cold 与规模门禁（2026-08-10）

Git-native cold baseline 已按本文最小方案落地：clean tracked path 复用 source tree OID，受限 pack closure 导入
private store，只对 dirty、untracked 或证据不安全的路径读取 live Workspace bytes。没有新增 durable cache、数据库、
watcher WAL 或 recovery phase；full reconcile 仍是无法证明 source authority 时的 fail-closed fallback。

正式规模门禁严格使用原 production limits（terminal 30 秒、最多 200,000 scanned entries）和 10 iterations，按
50k 通过后再运行 200k 的顺序执行。50k 与 200k 的 deep/wide 共 44 rows 全部 `pass`，`fallbackCount=0`，没有
timeout、budget 或 unavailable。200k cold p95 为 8.30 秒（deep）/7.73 秒（wide），warm no-change 为
1.16/1.18 秒，dirty100 为 4.25/3.93 秒，restore 为 9.80/7.52 秒。

增量边界符合设计：50k/200k 四组的 dirty1/10/100 十轮累计 candidateCount 均为 10/100/1000，Workspace
bytesRead 均为 110/1200/13900；clean cold 和 warm no-change 的 Workspace bytesRead 为 0。仓库规模没有进入
增量内容读取量。完整命令、逐场景 p95 和 traversal 指标见
`docs/superpowers/reports/2026-08-09-agent-rewind-v3-scale-gates.md`。

门禁也暴露了没有必要用新架构掩盖的体验成本：200k 4-Session p95 为 19.63 秒（deep）/11.93 秒（wide）。
这来自 writer lease 下的安全串行和每次 commit/candidate 操作；它不构成正确性失败，但需要排队反馈或后续基于
profiling 的小步优化。除非新的测量证明必要，不因此增加 path MVCC、持久 cursor 或第二 authority。

该结果只证明合成 Git fixture 在 200k scanned-entry 硬上限内通过。真实 monorepo 的 attributes、partial clone、
nested repository、超大 blob、磁盘压力和持续外部写入仍由专项 correctness/环境验证覆盖，不能从本次容量门禁
外推为无条件支持。

### macOS watcher 与 Workspace identity 补强（2026-08-10）

真实 Parcel/FSEvents 验证表明，macOS 会随子路径变化上报 Workspace root 的非 `delete` 元数据事件。旧逻辑
将其当成 unsafe path 并触发全量 fallback；`8dcae962` 改为忽略该元数据事件，同时保留 root `delete` 的
fail-closed 语义。

由于 root replacement 也可能只上报 `update`，watcher 类型本身不足以证明 Workspace 未被替换。
`609dd36a` 在每次 candidate publish 前复用 canonical Workspace identity，以 O(path depth) 的 `lstat` 链
重新验证 root identity；因此正常子变化保持增量，replacement 仍 fail closed，而不需要新增 watcher 状态或
全仓扫描。相关 51 项专项 tests 与 warm non-Git root replacement E2E 已通过。总体 correctness/tsc 与
closeout 仍按实施计划保持未完成状态。

### Latest-HEAD 验证边界（2026-08-10）

`0b013b07` 修复了本分支引入的两个 TypeScript 诊断；production validator 集成测试 1/1 通过。随后在真实
Crest worktree（测试时 HEAD `0b013b07`，1,975 个 tracked files）执行生产 validator：cold 18,769.79 ms，
warm 861.93 ms，4-Session 3,383.67 ms，fallback 为 0；Shadow refs 一致，source Workspace 未被改动，
private store 为 14,524,416 bytes，cleanup 成功。

最终 HEAD 的 full correctness 在 603.62 秒内完成 57 个 files：914 pass、2 skip、0 failed。全仓 `tsc`
最终仍以 exit 2 结束，但所有包含 `workspace-rewind`、`agent-rewind`、`frontend/app/agent/rewind` 以及
validator/benchmark 路径的 diagnostics 均为 0；剩余均为无关的 repo-wide baseline diagnostics。由此可确认
本功能实现完成并通过专项与真实 worktree 验证，但不能把 repo-wide exact gate 或全项目 production-ready
标为完成。
