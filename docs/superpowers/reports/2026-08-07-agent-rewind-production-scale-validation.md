# Agent Rewind 生产规模实测报告

日期：2026-08-07

平台：macOS arm64，Node.js v22.22.3

生产参数：pre-turn 5 秒、terminal 30 秒、最多 200,000 entries、snapshot store 软上限 5 GiB

## 结论

当前实现的回退正确性与多 Session 安全语义已经有较强测试证据，但 **cold baseline 尚不能用于常见大型
monorepo 的生产环境**。

实际产品能否创建可回退 checkpoint，取决于 user turn 开始前的 pre-turn capture。实测中：

- 27 个 tracked files、7 个父目录组：3.04 秒完成；
- 265 个 tracked files、31 个父目录组：6.23 秒完成，已经超过名义上的 5 秒预算；
- 551 个 tracked files、91 个父目录组：5.54 秒后明确 `capture-timeout`；
- 6,496、11,650、15,513 个 tracked files 的真实 monorepo，terminal 的 30 秒 cold baseline 全部超时。

因此不能把当前机制宣传为“支持 10k、50k 或 200k 文件”。`200,000 entries` 是拒绝服务前的安全预算，
不是经过验证的产品容量。

## 实测结果

### User turn 开始前的 pre-turn baseline

| 仓库 | tracked files | entries | 父目录组 | 结果 | 总耗时 | anchored reader |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| `mira-local-proxy` | 3 | 7 | 1 | completed | 2.30 s | 0.07 s |
| `dito-cli` | 27 | 34 | 7 | completed | 3.04 s | 0.48 s |
| `edgeFlow.js` | 265 | 298 | 31 | completed，但超过 5 秒 | 6.23 s | 2.39 s |
| `terax-ai` | 551 | 644 | 61/91 | capture-timeout | 5.54 s | 4.61 s |

这里不存在稳定的“文件数阈值”。目录拓扑比文件总数更重要：每个不同父目录都会形成一个 anchored
reader group。

### 30 秒 terminal cold baseline

| 仓库 | tracked files | entries | 父目录组 | 结果 | 总耗时 |
| --- | ---: | ---: | ---: | --- | ---: |
| `edgeFlow.js` | 265 | 298 | 31 | completed | 6.60 s |
| `terax-ai` | 551 | 644 | 91 | completed | 13.37 s |
| `pi-reference` | 1,147 | 1,280 | 120 | completed | 19.03 s |
| `poi-star-mono` | 1,604 | 2,305 | 430/604 | capture-timeout | 30.53 s |
| `fe-canal-mono` | 6,496 | 8,967 | 393/1,988 | capture-timeout | 30.60 s |
| `fe-poi-mono` | 11,650 | 16,178 | 386/4,061 | capture-timeout | 30.54 s |
| `fe_ls_tobias_goods_mono` | 15,513 | 22,227 | 370/6,014 | capture-timeout | 30.57 s |

超时行的父目录组写成“完成组数/总组数”。这说明进程在 30 秒内只处理了约 370–430 个目录组，距离真实
monorepo 的数千目录组很远。

`lina-mono` 的 Git index 有 73,984 个 tracked paths，但当前 sparse checkout 只物化了 125 个文件；其
6.37 秒结果不能作为 74k 仓库成功证据。

### Warm baseline 和多 Session

在 cold baseline 成功后，无改动 capture 不再枚举 workspace entry，但仍需约 1.19–1.37 秒。四个 Session
同时请求同一个共享 tracker 时，总耗时约 4.83–5.86 秒。

共享 tracker 已避免四次全仓扫描，这是正确方向；但相同的 no-change 请求只是进入同一条串行队列，没有
single-flight 合并，因此四个 Session 的等待时间仍近似线性累加。

## 正确性证据

运行以下生产代码路径的 4 个测试文件，共 36 个用例全部通过：

- `rewind-engine.integration.test.ts`
- `multi-session.integration.test.ts`
- `snapshot-equivalence.integration.test.ts`
- `snapshot-performance.test.ts`

覆盖范围包括：

- text、binary、symlink、executable、create/delete/rename 的精确 Undo/Redo；
- 增量 snapshot 与独立 full projection 等价；
- 50 个确定性模型，每个模型 100 次文件系统操作；
- 100 个 dirty parent groups 的 worker 上限；
- Session A 的回退不覆盖 Session B 的不相关修改；
- 同路径被其他 Session 或外部程序修改时，normal apply 拒绝，必须重新取得 Force authority；
- apply 最终校验期间发生竞争写入时 fail closed。

这证明当前主要短板是 baseline 建立和并发 capture 的规模性能，而不是已经发现的数据恢复错误。

## 根因

### 1. Full baseline 按父目录串行启动 Node 子进程

`WorkspaceSnapshotStore.captureEntries()` 先按父目录分组，然后用串行 `for ... await` 逐组调用
`captureAnchoredGroup()`。每组最终都会通过 `spawn(process.execPath, ["-e", ...])` 启动一个新的 Node
进程。

实测每组固定成本约 66–85 ms。一个有 4,000–6,000 个父目录组的 monorepo，即使文件内容完全不需要重新
hash，也不可能在 30 秒内完成。

增量 dirty-path 路径已经有 `runAnchoredReaderBatch()`，支持最多 8 个并发 worker；但 cold full capture
没有复用这条批处理路径。实测 full capture 的 worker peak 始终是 1。

### 2. 第一个 user turn 同步承担 cold baseline

workspace/session 初始化只 acquire tracker，没有后台 prewarm。第一个 `session_before_user_turn` 事件直接
执行 `capture({ profile: "pre-turn" })`，因此用户点击发送后会同步承担整个 cold baseline。

baseline 超时后，该 turn 只能写入 unavailable checkpoint，之后无法回退该 turn。

### 3. Durable tracker state 读取后没有恢复内存 current/path capture

tracker 会读取磁盘上的 durable state，但 `loadDurableState()` 当前只 await 读取结果，没有把 trusted
snapshot 恢复为 `current` 和 `pathCapture`。新 tracker 的 `needsReconcile` 初始值仍是 true，所以应用重启或
tracker 重建后仍会重新跑 full baseline。

### 4. Snapshot 元数据对象放大

成功样本每个文件大约产生两个 loose Git objects，另外还要构造 state tree、workspace tree 和 scope
manifest。比如 1,147 个文件产生 2,547 个 loose objects。anchored reader 是最大瓶颈，但对象创建和树构造
也占 `pi-reference` cold capture 约一半时间，不能只优化文件读取。

### 5. Capture queue 只串行，不合并等价请求

共享 tracker 的 `captureQueue` 保证了安全顺序，却会把四个同时到达的无改动边界依次执行。结果是一次约
1.3 秒，四次约 5 秒。常见的多 Agent Session workspace 会直接放大用户等待时间。

### 6. 5 秒 deadline 不是严格的端到端墙钟上限

`edgeFlow.js` 的 pre-turn capture 在 6.23 秒后仍返回 completed。说明部分后处理/清理阶段没有持续观察
deadline，或者 abort 后仍需等待清理。当前 timeout 更像阶段预算，而不是产品可以依赖的响应时间上限。

## 为什么之前的 benchmark 会高估

旧合成 benchmark 主要验证了“baseline 已存在后，增量路径不再扫描全仓”，这个算法结论成立；但它不能
证明 cold baseline 的产品容量：

- 合成文件集中在很少的目录 bucket 中，而真实 monorepo 有数千父目录；
- 内容复用降低了 blob 创建成本；
- 主要看 entry visits，没有把逐目录进程启动、state tree 和 loose object 成本作为容量门槛；
- warm 算法测试与“第一个 turn 能否在 5 秒内拿到 before snapshot”是两个不同问题。

## 生产化前的最小改进顺序

### P0：必须完成

1. **Full baseline 使用 bounded worker pool**

   复用或扩展 `runAnchoredReaderBatch()`，让父目录组在安全上限内并行；更理想的是长驻 worker，避免每组
   启动一个 Node 进程。安全锚定、目录 identity 校验和两次不稳定重试必须保留。

2. **workspace 打开后异步 prewarm**

   baseline 不应阻塞第一个 user turn。UI 应区分 `baseline-building` 与可回退状态；未就绪时明确该 turn
   没有 checkpoint，不得伪造空 checkpoint。

3. **真正恢复 durable tracker state**

   新 tracker 启动时，在校验 snapshot 和 watcher cursor 后恢复 `current`/`pathCapture`；无法证明 cursor
   连续性才 full reconcile。否则每次应用重启都重新付 cold baseline 成本。

4. **合并同时到达的等价 capture**

   对同一 tracker、同一 feed cursor 的 no-change capture 做 single-flight，四个 Session 等待一个结果，而
   不是串行跑四次。

### P1：规模放大后需要

5. **降低 snapshot 元数据对象数**

   将 path states/manifest 批量编码，避免每个 path 多个 loose object；必要时定期 pack，不要让大仓库产生
   数十万个 loose objects。

6. **把 deadline 变成真正端到端 SLA**

   包含 scope discovery、reader、hash、tree、publish 和 cleanup；后台 baseline 可使用更长预算，但绝不能
   阻塞发送操作同样长时间。

7. **建立真实 topology 的 CI/性能门禁**

   至少包含 1k、10k、50k、100k present files，并分别覆盖 100、1k、10k parent groups、独特内容和四
   Session。容量必须由 cold + real Undo/Redo 共同判定。

## 建议验收目标

生产上线前至少达到：

- 100k present files / 10k parent groups 的后台 cold baseline 能稳定完成，且不阻塞 user turn；
- baseline ready 后 no-change pre-turn p95 < 150 ms；
- 单文件 dirty pre-turn p95 < 500 ms，100 dirty paths p95 < 2 s；
- 四 Session 同 cursor 的 no-change capture 接近单次延迟，而不是 4 倍；
- 应用重启后，在 watcher cursor 可验证连续时不做 full reconcile；
- Linux 与 macOS 都跑真实 monorepo；Windows 若仍会退化为 full reconcile，必须明确不支持或单独实现。

在这些条件达成并重新实测前，建议把当前功能定位为“小型仓库可用、常见 monorepo 实验性”，而不是生产
级通用回退。

## 安全与清理

本次只读 capture 的 snapshot store 均位于 `/private/tmp`，原仓库 fingerprint（HEAD + 完整 Git status）
在前后保持一致，临时目录均已删除。没有安装依赖、没有访问网络、没有运行目标仓库业务脚本。
