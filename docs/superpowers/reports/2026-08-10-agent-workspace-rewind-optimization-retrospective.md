# Crest Agent Workspace Rewind 优化复盘

**日期：** 2026-08-10

**范围：** 从第一版 Workspace Rewind 到 Shared Shadow Git V3 的设计、实现、简化和规模验证

**当前状态：** 功能实现和专项 correctness 已完成；repo-wide TypeScript baseline gate 尚未闭合

## 1. 这份文档解决什么问题

此前的记录分别回答了不同问题：

- 初始设计说明 Revert/Redo、checkpoint、冲突检测和多 Session 的产品语义；
- Recovery 简化设计说明如何减少崩溃恢复状态机；
- 增量快照设计说明为什么每个 turn 全量扫描不适合 monorepo；
- Shared Shadow Git 设计说明最终架构；
- 规模报告保存 10k、50k、200k 和真实 Crest worktree 的测量证据。

这些材料能证明每一步，但不能单独解释为什么方案连续变化。本复盘把完整因果链放在一处：

```text
工具级变更记录不可靠
  → turn 边界工具无关 checkpoint
  → 每 turn 全量 Workspace capture，正确但 monorepo 太慢
  → Workspace 级共享增量 tracker，热路径变快但状态源过多
  → Shared Shadow Git，删除自定义 state tree、watcher WAL 和 Path MVCC
  → candidate-only warm capture，仍存在逐路径 Git 子进程放大
  → batch Git 查询，把热路径成本重新约束到候选变化量
  → 50k cold 仍超时
  → Git-native cold baseline，复用 clean tracked Git objects
  → 50k/200k 门禁通过
  → macOS watcher/root replacement 复审，补 O(path depth) identity 校验
```

## 2. 始终没有改变的产品约束

所有优化都必须保留以下语义；任何能提速但破坏这些约束的方案都没有采用。

1. **工具无关。** `write`、`edit`、shell、PTY、CLI Agent、人工编辑和未来工具都能被覆盖。
2. **每个 durable user turn 都有逻辑 checkpoint。** 没改文件的 turn 也不能留下会话回退断点。
3. **精确 Turn diff。** Review、Turn Undo/Redo 使用该 turn 的 `before → after`，不使用当前 Git diff 猜测。
4. **对话与代码语义分离。** Turn Undo 只恢复文件并保留对话；Conversation Revert 同时移动会话树。
5. **选择性恢复。** 只触碰计划中的路径，不执行 `reset --hard`、`clean -fd` 或整树 checkout。
6. **多 Session 不静默互相覆盖。** Session A 的恢复不能撤销 Session B 的同路径后续写入。
7. **磁盘漂移 fail closed。** 普通 Revert 不覆盖预览后变化；Force 只能授权预览中明确标红的可恢复路径。
8. **raw bytes 和文件类型精确。** 内容、可执行位、symlink、absent 和不安全类型都需要明确处理。
9. **不修改用户 Git 状态。** 不触碰用户 HEAD、index、branch、stash、hook 或 reflog。

## 3. 阶段一：先解决“能不能安全回退”

### 3.1 为什么没有依赖 write/edit 工具日志

第一轮讨论很快排除了“记录 `write`/`edit` 的 before image，再反向执行”作为系统 authority。它无法覆盖：

- bash、PTY 和子 Agent 直接修改文件；
- 人工编辑或外部进程写入；
- 新工具没有接入旧的变更协议；
- 一个工具调用内部产生 rename、delete、mode 或 symlink 变化。

因此 checkpoint 放在 **user turn 边界**，观察 Workspace 状态，而不是放在具体工具内部。工具报告可以用于 UI，
但不能决定恢复正确性。

### 3.2 初始恢复语义从哪里来

初始设计借鉴了两类成熟实践，但没有照搬实现：

- OpenCode：内部 Git-backed snapshot、按路径选择性恢复和 preview；
- pi-rewind：`/rewind` 命名、按 prompt/checkpoint 选择和生命周期 UX。

Crest 自己增加了 canonical Workspace identity、Session ownership、drift/ABA 检测、confirmation token、
workspace lock、quota、retention、raw-byte 文件状态和崩溃恢复。这些能力用来满足“同一物理 Workspace、多 Agent
Session”这一约束，不是上游实现的直接复制。

### 3.3 初始版本为什么复杂

恢复跨两个不能原子提交的系统：文件系统和 Session SQLite。初版使用多阶段 journal、冻结状态和广播修复，
希望覆盖每个崩溃位置。它虽然保守，但把执行进度、Recovery UI、runtime gate 和状态广播耦合在一起，实际暴露出：

- 正常操作尚未结束时，Recovery query 与 exclusive Session mutation 互相阻塞；
- completed journal 因广播失败仍触发 Recovery；
- Renderer、runtime registry 和 journal 各自维护近似的 frozen/busy 状态；
- 用户看到“Workspace recovery required”，却没有真正发生不可恢复的文件崩溃。

### 3.4 Recovery 如何收敛

Recovery 简化后只保留：

```text
一个 pending restore intent
+ Session 隐藏 operation marker（唯一提交点）
+ pending / marker / 实时文件三方分类
```

正常 Restore 自己负责 pending、文件应用、最终验证、marker CAS 和 cleanup。Recovery 不保存长期 UI 状态，
只在进程中断后根据 durable facts 做三类判断：完成 cleanup、回滚到 source，或 needs-user。删除了五阶段 phase、
重复 frozen cache、startup/runtime 两套 scanner，以及“广播失败等于事务失败”的语义。

这一阶段的结论是：**崩溃安全需要一个最小 durable intent，但不需要一套长期运行的恢复状态机。**

## 4. 阶段二：发现每个 turn 全量扫描不适合 monorepo

### 4.1 原始热路径

逻辑 checkpoint 最初直接绑定两次物理 capture：

```text
user turn 开始：完整扫描并构造 before snapshot
user turn 结束：完整扫描并构造 after snapshot，再比较 diff
```

即使 turn 没改文件，仍要发现 Workspace 范围、遍历目录、查询 Git ignore/nested repo、检查 fingerprint、构造 tree
和 manifest。单次成本近似 `O(N)`，其中 `N` 是 Workspace entry 数。

在同一 Workspace 有 `S` 个 Session、每个 Session 有 `T` 个 turn 时，重复工作接近 `O(S × T × N)`。
存储因为内容寻址和对象复用通常不是首要问题，真正的问题是每个边界的目录/元数据扫描延迟。

### 4.2 根因不是 checkpoint 太多

“每个 turn 都有 checkpoint”是会话语义；“每个 checkpoint 都从零扫描 Workspace”只是当时的物理实现。
两者被错误耦合了。

正确拆分是：

```text
逻辑 checkpoint = immutable before/after refs + exact changed paths + coverage
物理 snapshot   = Workspace 状态版本，可被多个 turn 和 Session 共享
```

无文件改动的 turn 仍写一个轻量 checkpoint，但 `before == after`，不应重新读取整个仓库。

## 5. 阶段三：第一次 Workspace 级增量方案

第一轮性能优化引入 canonical Workspace 级共享 tracker：

- 一个 Workspace 共享 fingerprint/index 和 dirty candidates；
- watcher 只提供变化 hint；
- 正常边界只捕获变化路径；
- watcher gap、overflow、scope invalidation 或证据不完整时 full reconcile；
- reconcile 失败则 checkpoint unavailable，不伪造空 diff。

它解决了最直接的问题：不同 Session 不再各自重复 warm scan，增量路径开始与 dirty path 数相关。

但目标设计逐渐包含 snapshot Git object store、自定义 path-state tree、tracker state、fingerprint cache、持久
watcher cursor/continuity 和 restore journal。每个组件单看合理，组合后却出现多个事实源：

- Git tree 和自定义 state tree 都描述文件状态；
- Git commit 和 Path MVCC 都描述修改顺序；
- watcher 从 hint 逐渐变成持久连续性证明；
- crash 后必须判断 Git ref、state tree、cursor 和 journal 哪一个可信。

这能继续做下去，但不是 Crest 需要的最简生产架构。

## 6. 阶段四：架构收敛为 Shared Shadow Git

### 6.1 最终物理模型

每个 canonical Workspace 只保留一个私有 bare Git repository 和一条权威 commit chain：

```text
<data>/agent-checkpoints/workspaces/<identity>-<incarnation>/repo.git
refs/crest/workspace-head
```

Git object、tree、commit 和 ref 分别承担内容寻址、结构共享、修改历史和原子 head CAS。Checkpoint 只引用
immutable commit，不再维护第二套 durable path-state authority。

最终核心组件是：

```text
Shared Shadow Git commit log
+ process-local WorkspaceTrackerRegistry
+ Workspace Writer Lease
+ candidate discovery / stable path capture
+ checkpoint ownership metadata
+ selective restore planner and executor
+ one pending restore intent
```

### 6.2 为什么需要 Writer Lease

同一物理 Workspace 中，纯文件系统 diff 无法判断两个 Crest Session 同时写入的字节分别属于谁。Writer Lease
因此放在 Agent Runtime 的“可能写 Workspace”通用边界，而不是 `write`/`edit` 工具内：

- 只有可能写入的 turn 获取 lease；
- shell、PTY、CLI Agent 和未来工具自动经过同一入口；
- lease 持续到 turn terminal；
- 其他 Session 仍可推理和对话，但 Workspace writer 按 canonical Workspace 串行；
- commit metadata 记录 Session/turn owner，恢复前沿 commit history 检查同路径外来写入和 ABA。

这让 Session A 可以只恢复自己的不相交路径；如果 Session B 后来写了同一路径，Undo/Revert 硬阻止，而不是
依赖当前字节“看起来一样”。外部编辑器不经过 lease，因此仍由 live drift + confirmation token 保护；若要对所有
外部 actor 提供强隔离，只能显式使用独立 worktree，不在 Rewind 中伪造保证。

### 6.3 删除了什么

V3 authority cutover 一次性删除了：

- durable watcher WAL/cursor；
- custom state tree 和其 writer；
- tracker durable state；
- 独立 Path MVCC/version table；
- 多套恢复 phase/frozen 状态。

Watcher 回到 hint，Shadow Git commit chain 成为唯一持久事实源；任何未来索引只能是可重建 cache，不能参与
正确性判定。

## 7. 阶段五：热路径算法优化

### 7.1 第二个性能瓶颈

切到 candidate-only 后，复杂度方向正确，但实现仍按候选路径逐个调用 Git：逐级读取 node kind、逐路径重建
coverage、逐路径读取 before/after state。100 个分散路径可能放大到约 6,000 个 Git 子进程，10k fixture 的
dirty100 单轮达到 60–90 秒。

问题不再是全仓扫描，而是 `候选路径数 × 目录深度 × 多阶段 Git process`。

### 7.2 最小算法修正

本轮没有引入数据库或常驻索引，只把同类 Git 查询批处理：

1. node kind 按路径深度分组，用精确 literal pathspec 分批 `ls-tree`；
2. object type/OID 统一用 batch-check；
3. coverage 直接更新基准 exclusion map，不再逐路径读取 before state；
4. diff 用一次 `diff-tree --raw -r -z --no-renames --no-abbrev` 获取 mode + OID；
5. manifest-only exclusion 在内存合并。

复杂度收敛为：

```text
固定元数据调用
+ 路径深度批次数
+ OID batch
+ 实际候选文件读取
```

10k dirty100 p95 降到 2.84–3.30 秒，相比旧实现约改善 18–32 倍。

## 8. 阶段六：解决 cold baseline 的 50k blocker

热路径通过后，50k deep/wide 仍在 30 秒 terminal budget 内超时。Profile 显示时间主要花在第一次 full reconcile：
scope discovery 后还要 stable-read/hash 所有 clean tracked 文件；200k 因 50k blocker 没有提前伪跑或放宽门槛。

### 8.1 Git-native cold baseline

Git Workspace 已经有一个可验证的 source tree 和 object database，因此 clean tracked 文件不需要从工作树重新读取、
重新 hash。新的 cold 流程是：

1. 解析 canonical repo root、Workspace prefix 和 `HEAD:<prefix>` tree；
2. 用 Git metadata discovery 建立 ignored、nested repo、hard-link、special、sparse/absent 和 coverage 证据；
3. safe clean tracked path 复用 source mode/blob OID；
4. dirty、staged、deleted、untracked 和 transform/attribute 不确定路径仍 stable-read live bytes；
5. 用受 quota、free-space、timeout 和 no-network 约束的 pack stream 把 source subtree closure 导入私有 store；
6. 在 private index 上叠加 live overlay，发布前重新验证 HEAD/index/status/feed/directory evidence；
7. 一次合并重试后仍有变化则 fail closed。

clean Git cold 的 Workspace `bytesRead=0` 表示 clean tracked 内容没有作为 live overlay 重新读取，不表示 Git pack
没有 I/O。Non-Git、unborn HEAD、非 SHA-1、missing object、gitlink 或证据歧义仍走 full reconcile；超预算则
unavailable，不降低 raw-byte 正确性。

### 8.2 为什么没有再加缓存

这个 fast path 复用现有 source boundary、scope discovery、ShadowWorkspaceIndex、publication CAS 和 quota，
没有新增 durable cursor、pack cache、WAL、数据库或 Recovery phase。首次 cold 仍有 metadata traversal 和 pack
导入成本，但它避免了 `O(total tracked raw bytes)` 的工作树读取。

## 9. 阶段七：真实平台复审发现的正确性问题

### 9.1 macOS root watcher noise

macOS Parcel/FSEvents 会在子路径变化时额外上报 Workspace root 自身的非-delete 事件。旧代码把空 relative path
当成 unsafe，导致 watcher 失去 trust，并让本可增量处理的 turn 进入 full fallback。

第一步修复忽略 root 的非-delete 元数据事件，同时保留 root delete 的 fail-closed 行为。

### 9.2 root replacement 不能只看 event type

独立复审指出：root rename + recreate 可能只出现 root `update`，未必有 `delete`。如果单纯忽略 update，就可能在
空 candidate 快路径漏掉旧文件全部消失。

最终修复没有重新引入全仓扫描，而是在 candidate publish 的三条成功路径复用 canonical Workspace identity：

- empty candidates；
- direct-only candidates；
- stable-read/hash candidates。

每次用 `O(path depth)` 的 no-follow `lstat` chain 验证 root/ancestor identity。root 被替换时即使 watcher 只有
update，也会拒绝发布 available snapshot。这是必要的局部安全校验，不是新的状态系统。

## 10. 验证器本身也必须可信

性能脚本经历了两次证据修正：

- benchmark row 从硬编码/错误字段改为真实 `fullReconcileCount`，fallback 不能显示为 pass；
- production validator 的 cold outcome/fallbackcount 同样读取实际计数；clean Git cold 的测试期望改为
  `bytesRead=0`，与 source-object reuse 的定义一致。

所有 timeout、budget、fallback 和 unavailable 都是结构化结果。未执行的场景使用 `null`/unavailable，不把失败
伪装成 0 ms，也不通过提高 timeout、减少 iterations 或提高 entry limit 获得“通过”。

## 11. 优化前后对比

| 维度 | 第一版 | 共享增量 tracker | 最终 Shared Shadow Git V3 |
| --- | --- | --- | --- |
| 逻辑 checkpoint | 每 turn | 每 turn | 每 turn |
| 物理边界成本 | 每 Session、每 turn 全量扫描 | Workspace 共享 dirty capture | Workspace 共享 candidate capture |
| durable 文件事实源 | snapshot store | snapshot + state tree + tracker/cursor | 一条 Shadow Git commit chain |
| watcher | 逐渐承担 continuity | hint + durable cursor | 仅内存 hint；gap 时 reconcile |
| Session 归属 | 恢复时推断/冲突检查 | 仍难证明并发 owner | Writer Lease + commit owner/history |
| warm 复杂度 | `O(total entries)` | 接近 `O(candidates)` | `O(candidates + depth batches + history)` |
| clean Git cold | 扫描并 hash 全部内容 | 扫描并 hash 全部内容 | metadata projection + source object pack |
| Recovery | 多阶段 journal/frozen 状态 | 沿用恢复机制 | 一个 pending intent + marker classifier |
| 失败语义 | fail closed | fail closed | fail closed |

## 12. 最终测量结果

### 12.1 正式合成规模门禁

使用原 production limits：terminal 30 秒、最多 200,000 scanned entries、每个非-cold 场景 10 iterations。

- 50k 与 200k、deep 与 wide 共 44 rows 全部 `pass`；
- `fallbackCount=0`；
- 200k cold 为 7.73–8.30 秒；
- 200k warm no-change p95 为 1.16–1.18 秒；
- dirty1/10/100 的 candidateCount 和 bytesRead 只随实际候选数增长；
- 200k 4-Session p95 为 11.93 秒（wide）和 19.63 秒（deep），体现 writer lease 的安全串行成本。

### 12.2 真实 Crest worktree

在 1,975 tracked files 的 Crest worktree 上：

| cold | warm | 4 sessions | fallback | private store |
| ---: | ---: | ---: | ---: | ---: |
| 18,769.79 ms | 861.93 ms | 3,383.67 ms | 0 | 14,524,416 bytes |

同时验证 Shadow refs 一致、source Workspace 前后指纹一致、临时 store cleanup 成功。

### 12.3 正确性门禁

- 最终 full correctness：57 files，914 pass、2 skip、0 failed，603.62 秒；
- production validator 集成测试：1/1 pass；
- macOS watcher、root replacement 和 candidate publish 相关专项测试通过；
- 独立最终代码审查：APPROVE，无 blocker/major；
- 本功能相关 TypeScript diagnostics：0。

全仓 `tsc --noEmit` 仍因与 Rewind 无关的 repo-wide baseline diagnostics 以 exit 2 结束，因此总体 plan 的 exact
correctness/tsc closeout gate 没有勾选，也没有宣称整个 Crest 已 production-ready。

## 13. 哪些复杂度是必要的

| 保留机制 | 不能删除的原因 |
| --- | --- |
| Shadow Git object/tree/commit/ref | immutable snapshot、结构共享、owner history、CAS publication |
| Writer Lease | 同一 Workspace 中为 Crest Session 写入建立可证明归属 |
| candidate discovery + stable reader | 工具无关地捕获真实 live bytes |
| canonical identity/incarnation | 防止同路径目录被删除重建后误用旧 checkpoint |
| confirmation token + final drift validation | preview 不能授权后来发生的磁盘变化 |
| selective restore + path safety | 不覆盖非目标文件，不跟随 symlink escape，不写 unsafe type |
| one pending restore intent | 文件系统与 Session marker 无法原子提交时的最小 crash evidence |
| quota/retention | 私有 snapshot store 不能无限增长或在有 owner 时被 GC |

## 14. 明确没有采用的设计

- 不依赖 `write`/`edit` 工具日志作为 authority；
- 不为每个 Session 建独立 snapshot store 或重复扫描器；
- 不使用用户仓库的 commit、stash、reset、clean 或 checkout；
- 不建设 durable watcher event log/WAL；
- 不维护自定义 Merkle/state tree 或 Path MVCC 作为第二事实源；
- 不缓存长期 Renderer/runtime frozen 状态；
- 不为性能测试提高生产 timeout/entry/quota 限制；
- 不自动创建 worktree 来伪装“同一物理 Workspace”的并行隔离；
- 不承诺识别绕过 Writer Lease 的所有外部 actor owner，只做 live drift 防覆盖。

## 15. 当前边界与下一步判断标准

已经证明的边界是：合成 Git Workspace 在 200k scanned entries 内完成 cold、warm、dirty、1/2/4 Session、
overlap 和 exact restore 矩阵，且没有 full-reconcile fallback；真实 Crest worktree 验证也通过。

尚不能从这些证据推导：

- 所有真实 monorepo 的 attributes、partial clone、submodule、超大 blob 和磁盘压力都已覆盖；
- Non-Git cold 能避免首次 `O(total entries + total bytes)` baseline；
- 4 Session 高争用延迟已经达到理想交互体验；
- 外部编辑器和后台进程具备与 Crest Session 相同的 owner 证明；
- 全仓 TypeScript baseline 已闭合。

未来只有在 production profiling 证明现有 commit-history 查询、Git metadata 或 writer serialization 是实际瓶颈时，
才考虑增加可从 commit chain 重建的 cache。任何新状态都必须回答两个问题：它是否真的必要，以及它损坏时能否
完全从唯一 authority 重建。否则不进入核心架构。

## 18. 真实 Electron Apply 延迟收口（2026-08-30）

用户实测最初约 4 秒，明显高于 executor 和 renderer→IPC E2E。production main-process profile 显示根因不是算法重新
扫描 monorepo，而是同一次交互把 shared workspace tracker 在 Preview、Apply、Recovery gate 和状态刷新之间立即销毁并
重复初始化。一次 store/tracker cold open 约 0.5 秒。

最终实现没有增加新的持久化层：mutation 在 engine 内复用同一 feature 完成 pending-recovery 检查；commit 后从当前 store
构建 rewind view；shared tracker 的零引用资源保留 5 秒后再释放。canonical workspace identity、binding、writer lease、
confirmation、live drift、pending、CAS 与异常 Recovery 均保持原语义。

真实单文件操作最终记录：Turn Undo IPC 1,597.80ms，Turn Redo IPC 1,593.71ms；对应 tracker acquire 为 15.55ms 和
17.63ms，紧随其后的状态刷新为 16–19ms。用户体感最终约 2 秒。restore transaction 本身仍为 1.31–1.32 秒，说明剩余
成本已主要来自必要的 durable commit、pending、文件安全写入/验证、ref CAS 和 cleanup，而不是 workspace 总规模扫描或
重复初始化。

## 16. 关联文档

- [初始 Workspace Rewind 设计](../specs/2026-07-28-agent-workspace-rewind-design.md)
- [Recovery 简化设计](../specs/2026-08-02-agent-rewind-recovery-simplification-design.md)
- [Workspace 增量快照设计与历史 benchmark](../specs/2026-08-04-agent-workspace-rewind-incremental-snapshot-design.md)
- [Shared Shadow Git 最终设计](../specs/2026-08-08-agent-workspace-rewind-shadow-git-design.md)
- [Shared Shadow Git 实施计划](../plans/2026-08-08-agent-workspace-rewind-shadow-git.md)
- [V3 生产规模门禁](./2026-08-09-agent-rewind-v3-scale-gates.md)
- [Apply 快路径设计](../specs/2026-08-29-agent-rewind-apply-fast-path-design.md)
- [Apply 快路径实施计划](../plans/2026-08-29-agent-rewind-apply-fast-path.md)

## 17. 后续优化：Apply 从数秒收敛到约 1 秒

V3 解决了 turn capture 随 monorepo 总量放大的问题，但用户确认 Undo/Redo 后仍需等待数秒。profile 证明瓶颈不是
恢复一个文件，而是 Apply 重算 Preview 计划、重复读取 Shadow Git head，并在正常成功后再次运行完整 Recovery
classifier。

2026-08-29 的快路径保持同一安全底座，只让每项事实证明一次：Preview 冻结 plan 和 authority head；Apply 只验证
新增 commit suffix、semantic leaf 与 live target paths；CAS 证明 durable publication；Recovery 只处理异常和启动
残留。正常成功还复用 executor 已知的 source/target facts，批处理 path state 查询，没有新增 durable cache 或状态机。

最终安全回归发现旧 Recovery 还隐含提供了成功后的 live-target 与 exact marker 复核。最终实现没有把整个 classifier
放回正常路径，而是加入复用可信 planned states 和当前已加锁 Session 的轻量 finalizer；它不重读 commit，也不调用
可能与 exclusive Session mutation 冲突的 Recovery locator。

修复后 30 轮 Apply-only 门禁中，50k deep/wide p95 为 1,303.33/1,254.96 ms，200k 为
1,499.51/1,389.94 ms；四组均为 36 个 Git processes/Apply、fallback 0。相较历史包含重复计划和 Recovery 的
5.6–9.8 秒 restore row，交互等待显著收敛，且 50k → 200k 没有恢复为全量扫描增长。

这次优化也保留了一个明确未完成项：50k `<1,000 ms` 的激进门禁仍差约 25%–30%；200k deep 的 p95 虽低于
1,500 ms，但只有 0.49 ms 余量。剩余成本主要来自结果 commit、
pending durability、文件安全应用/验证和 cleanup；它们承担实际安全语义，现阶段没有必要为了几十到一百毫秒引入
常驻 worker、后台预建 commit 或第二套 cache。完整数据和 phase breakdown 见 V3 规模门禁的 2026-08-29 章节。
