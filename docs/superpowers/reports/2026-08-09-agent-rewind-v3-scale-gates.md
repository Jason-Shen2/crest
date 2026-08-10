# Agent Rewind V3 生产规模门禁

日期：2026-08-10

平台：macOS arm64，Node.js v22.22.3

正式门禁命令：

- `npm run benchmark:agent-rewind-snapshots -- --entries=50000 --iterations=10`
- `npm run benchmark:agent-rewind-snapshots -- --entries=200000 --iterations=10`

两档均使用原样 production limits：terminal capture 30 秒、最多 200,000 个 scanned entries、每个非 cold
场景 10 iterations。没有提高 timeout、减少 iterations 或预构建 authority。

## 本轮优化

旧实现虽然已经使用 workspace 级共享 tracker，但候选边界内部仍有三处随路径数量和目录深度放大的
Git 子进程调用：逐级读取候选 node kind、逐路径重建 coverage、逐路径读取 before/after diff state。100 个
分散路径一次边界最多会产生约 6,000 个 Git 进程，10k fixture 的 dirty100 单轮约 60–90 秒。

本轮保留 V3 authority、workspace lock、snapshot ref 和 fail-closed 语义，只替换三个查询算法：

1. node kind 按路径深度分组，并用精确 literal pathspec 分批 `ls-tree`；OID 类型统一 batch-check；
2. coverage 直接更新基准 exclusion map，不再逐路径读取 before state；
3. diff 使用一次 `diff-tree --raw -r -z --no-renames --no-abbrev` 得到 mode + OID，再统一
   batch-check blob 类型；manifest-only exclusion 在内存合并。

复杂度从“路径数 × 深度 × 多阶段 Git 进程”降为“固定元数据调用 + 路径深度批次数 + OID batch”。没有
增加常驻数据库、第二套 journal 或新的全仓扫描器。

## 历史基线：10k × 10

本节是 Git-native cold baseline 落地前的历史数据，用于说明 candidate/diff 查询优化收益；其中 cold
`bytesRead > 0` 不再代表当前算法。当前 Git-native clean cold 的 Workspace overlay bytes 为 0。

22 个场景全部 `pass`，`fallbackCount` 全部为 0。

| shape | cold | warm | dirty1 | dirty10 | dirty100 | 4 sessions | overlap | restore |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| deep p95 | 7481.97 ms | 645.26 ms | 1411.34 ms | 1686.57 ms | 3301.11 ms | 10389.43 ms | 5636.03 ms | 6918.49 ms |
| wide p95 | 7184.44 ms | 562.40 ms | 1295.01 ms | 1538.27 ms | 2840.41 ms | 8163.36 ms | 5125.79 ms | 5513.35 ms |

dirty100 相比旧实现的 60–90 秒/轮降至 2.84–3.30 秒 p95，约改善 18–32 倍。候选和读取字节仍严格
与 dirty path 数量相关：dirty1/10/100 的十轮累计 candidateCount 分别为 10/100/1000，bytesRead 分别为
110/1200/13900；仓库总 entry 数没有进入增量读取量。

### 精确 JSON rows

下列 JSON 是本轮控制台原始 rows 的稳定字段摘录；`iterations` 除 cold 为 1 外均为 10。

```json
[
  {"shape":"deep","scenario":"cold","outcome":"pass","dirty":0,"sessions":1,"candidates":0,"bytesRead":98298,"commits":1,"fallbacks":0,"p50Ms":7481.97,"p95Ms":7481.97},
  {"shape":"deep","scenario":"no-tool-fresh","outcome":"pass","dirty":0,"sessions":1,"candidates":0,"bytesRead":0,"commits":70,"fallbacks":0,"p50Ms":733.64,"p95Ms":778.07},
  {"shape":"deep","scenario":"warm-no-change","outcome":"pass","dirty":0,"sessions":1,"candidates":0,"bytesRead":0,"commits":50,"fallbacks":0,"p50Ms":625.67,"p95Ms":645.26},
  {"shape":"deep","scenario":"dirty-paths","outcome":"pass","dirty":1,"sessions":1,"candidates":10,"bytesRead":110,"commits":100,"fallbacks":0,"p50Ms":1352.86,"p95Ms":1411.34},
  {"shape":"deep","scenario":"dirty-paths","outcome":"pass","dirty":10,"sessions":1,"candidates":100,"bytesRead":1200,"commits":100,"fallbacks":0,"p50Ms":1496.57,"p95Ms":1686.57},
  {"shape":"deep","scenario":"dirty-paths","outcome":"pass","dirty":100,"sessions":1,"candidates":1000,"bytesRead":13900,"commits":100,"fallbacks":0,"p50Ms":2908.84,"p95Ms":3301.11},
  {"shape":"deep","scenario":"session-contention","outcome":"pass","dirty":0,"sessions":1,"candidates":1000,"bytesRead":13900,"commits":60,"fallbacks":0,"p50Ms":2490.52,"p95Ms":2623.88},
  {"shape":"deep","scenario":"session-contention","outcome":"pass","dirty":0,"sessions":2,"candidates":2000,"bytesRead":27800,"commits":120,"fallbacks":0,"p50Ms":4569.52,"p95Ms":5333.48},
  {"shape":"deep","scenario":"session-contention","outcome":"pass","dirty":0,"sessions":4,"candidates":4000,"bytesRead":55600,"commits":240,"fallbacks":0,"p50Ms":9362.34,"p95Ms":10389.43},
  {"shape":"deep","scenario":"overlap","outcome":"pass","dirty":1,"sessions":2,"candidates":2000,"bytesRead":27800,"commits":220,"fallbacks":0,"p50Ms":5478.44,"p95Ms":5636.03},
  {"shape":"deep","scenario":"restore","outcome":"pass","dirty":1,"sessions":1,"candidates":1000,"bytesRead":13950,"commits":350,"fallbacks":0,"p50Ms":6594.89,"p95Ms":6918.49},
  {"shape":"wide","scenario":"cold","outcome":"pass","dirty":0,"sessions":1,"candidates":0,"bytesRead":98430,"commits":1,"fallbacks":0,"p50Ms":7184.44,"p95Ms":7184.44},
  {"shape":"wide","scenario":"no-tool-fresh","outcome":"pass","dirty":0,"sessions":1,"candidates":0,"bytesRead":0,"commits":70,"fallbacks":0,"p50Ms":623.12,"p95Ms":668.95},
  {"shape":"wide","scenario":"warm-no-change","outcome":"pass","dirty":0,"sessions":1,"candidates":0,"bytesRead":0,"commits":50,"fallbacks":0,"p50Ms":508.62,"p95Ms":562.40},
  {"shape":"wide","scenario":"dirty-paths","outcome":"pass","dirty":1,"sessions":1,"candidates":10,"bytesRead":110,"commits":100,"fallbacks":0,"p50Ms":1214.05,"p95Ms":1295.01},
  {"shape":"wide","scenario":"dirty-paths","outcome":"pass","dirty":10,"sessions":1,"candidates":100,"bytesRead":1200,"commits":100,"fallbacks":0,"p50Ms":1373.43,"p95Ms":1538.27},
  {"shape":"wide","scenario":"dirty-paths","outcome":"pass","dirty":100,"sessions":1,"candidates":1000,"bytesRead":13900,"commits":100,"fallbacks":0,"p50Ms":2470.84,"p95Ms":2840.41},
  {"shape":"wide","scenario":"session-contention","outcome":"pass","dirty":0,"sessions":1,"candidates":1000,"bytesRead":13900,"commits":60,"fallbacks":0,"p50Ms":1971.47,"p95Ms":2111.38},
  {"shape":"wide","scenario":"session-contention","outcome":"pass","dirty":0,"sessions":2,"candidates":2000,"bytesRead":27800,"commits":120,"fallbacks":0,"p50Ms":3954.64,"p95Ms":4094.47},
  {"shape":"wide","scenario":"session-contention","outcome":"pass","dirty":0,"sessions":4,"candidates":4000,"bytesRead":55600,"commits":240,"fallbacks":0,"p50Ms":7967.64,"p95Ms":8163.36},
  {"shape":"wide","scenario":"overlap","outcome":"pass","dirty":1,"sessions":2,"candidates":2000,"bytesRead":27800,"commits":220,"fallbacks":0,"p50Ms":4813.50,"p95Ms":5125.79},
  {"shape":"wide","scenario":"restore","outcome":"pass","dirty":1,"sessions":1,"candidates":1000,"bytesRead":13950,"commits":350,"fallbacks":0,"p50Ms":5124.01,"p95Ms":5513.35}
]
```

## 历史基线：Git-native cold 前的 50k blocker

Git-native cold baseline 落地前，50k deep 与 wide 的 cold authority 都在原 terminal 30 秒预算下
`timeout`。每个 shape 后续 10 行均因 cold authority 未建立而明确返回 `unavailable`，p50/p95 为
`null`，没有把未执行的 warm、dirty、contention、overlap 或 restore 伪装成零延迟。按分级门禁顺序，
当时的 200k 被标记为 `gate-dependent paused`，没有通过提高 timeout 或减少 iterations 绕过 50k blocker。

分阶段 profile 将 blocker 定位在 cold full reconcile：deep 约 13.04 秒用于 scope discovery，随后
stable reader/hash 运行约 19.39 秒后超时；wide 约 10.76 秒完成 discovery，随后 reader/hash 运行约
22.16 秒后超时。两种 shape 都尚未进入 tree materialization。当前正式门禁的 50k/200k 结果因此是
Git-native clean baseline 替换该 cold 全量内容读取后的前后对照，不覆盖或删除这段失败历史。

## 正式门禁结果

50k 和 200k 均先完成 deep，再完成 wide；只有 50k 的 22 行全部通过后才启动 200k。合计 44 行全部
`outcome=pass`、`fallbackCount=0`，没有 `timeout`、`budget` 或 `unavailable`。fixture 已按 production
scanned-entry budget 计数：50k deep/wide 分别包含 49,983/49,999 个 eligible files；200k deep/wide 分别包含
199,981/199,999 个 eligible files，剩余预算是目录与根 `.git` repository boundary。

### 50k × 10 p95

| shape | cold | no-tool | warm | dirty1 | dirty10 | dirty100 | session1 | session2 | session4 | overlap | restore |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| deep | 2902.01 | 780.73 | 693.91 | 1561.17 | 1636.13 | 3293.15 | 2647.98 | 6080.19 | 11405.18 | 6738.62 | 8443.55 |
| wide | 3044.93 | 973.21 | 741.80 | 1618.26 | 1537.31 | 2928.22 | 2201.68 | 4490.52 | 8867.56 | 5436.70 | 5655.49 |

### 200k × 10 p95

| shape | cold | no-tool | warm | dirty1 | dirty10 | dirty100 | session1 | session2 | session4 | overlap | restore |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| deep | 8296.67 | 1279.02 | 1164.42 | 2158.33 | 2382.25 | 4253.76 | 3353.12 | 6575.87 | 19628.61 | 8357.02 | 9798.50 |
| wide | 7730.49 | 1263.36 | 1176.66 | 2123.48 | 2274.87 | 3930.94 | 3007.74 | 6029.03 | 11933.03 | 6944.59 | 7523.95 |

单位均为毫秒。cold 只有一次 iteration，因此 p50=p95；其余值来自 10 iterations。fixture 文件生成与初始
`git add/commit` 不包含在 row latency 内，不能把整条 CLI 的 wall time 当成产品 cold latency。

## 增量边界与 Git traversal 指标

下表在 50k/200k、deep/wide 四组结果中完全一致，说明增量读取量由实际候选变化决定，没有随仓库总 entry
数放大。数值是每个场景 10 iterations 的累计值；cold 除外。

| scenario | candidateCount | bytesRead | commitsTraversed |
| --- | ---: | ---: | ---: |
| cold | 0 | 0 | 1 |
| no-tool-fresh | 0 | 0 | 70 |
| warm-no-change | 0 | 0 | 50 |
| dirty1 | 10 | 110 | 100 |
| dirty10 | 100 | 1200 | 100 |
| dirty100 | 1000 | 13900 | 100 |
| session1 | 1000 | 13900 | 60 |
| session2 | 2000 | 27800 | 120 |
| session4 | 4000 | 55600 | 240 |
| overlap | 2000 | 27800 | 220 |
| restore | 1000 | 13950 | 350 |

`session1/2/4` 按同一 fixture 的固定场景顺序运行在 `dirty100` 之后，因此继承当时 100 个 dirty
candidates。表中的 `dirtyPathCount=0` 只表示 contention 场景本身没有再写新路径，不表示它是 clean/no-op
contention；candidateCount 与 bytesRead 是每个 Session、每轮处理这 100 个候选后的累计值。

clean Git cold 通过 source-object pack + metadata projection 建立 private authority，`bytesRead=0` 表示没有读取
clean tracked Workspace 内容作为 overlay；它不表示 Git pack 为 0 bytes。benchmark row 记录的是 Workspace
新读取字节与 commit traversal，不记录所有 Git child process 总数，因此本轮不从这些 rows 推导未观测的进程数。

## macOS 增量正确性补充

规模门禁后的真实 watcher 验证发现，macOS 上 Parcel/FSEvents 会在子路径变化时额外上报 Workspace root
的非 `delete` 元数据事件。旧 feed 把该事件误判为 unsafe path，导致本可增量处理的 turn 进入全量 fallback；
`8dcae962` 忽略这类 root 元数据事件，同时继续把 root `delete` 视为不可信。

独立复审随后发现 Workspace root replacement 也可能只表现为 `update`，不能只依赖 watcher event type。
`609dd36a` 因此在每次 candidate publish 前复用 canonical Workspace identity 校验，以 O(path depth) 的
`lstat` 链验证 root 未被替换，replacement 继续 fail closed。相关 51 项专项 tests 与 warm non-Git root
replacement E2E 均通过；这些是增量边界的后续正确性证据，不代表总体 correctness/tsc 或 closeout 已完成。

## 真实 Crest worktree 验证

`0b013b07` 先修复本分支引入的 TypeScript 诊断，production validator 集成测试 1/1 通过。真实 Crest
worktree 验证在测试时 HEAD `0b013b07`、1,975 个 tracked files 上运行，结果如下：

| cold | warm | 4 sessions | fallback | store |
| ---: | ---: | ---: | ---: | ---: |
| 18,769.79 ms | 861.93 ms | 3,383.67 ms | 0 | 14,524,416 bytes |

验证同时确认 Shadow refs 一致、source Workspace 未被修改、cleanup 成功。full correctness 汇总为 913 pass、
2 skip、1 个 aggregate suite timing failure，且该 E2E isolated 运行通过。全仓 `tsc` 仍有 40 个文件、
131 条既有 baseline diagnostics；本分支目标两个 rewind 文件为 0。因此这些数据补足真实仓库专项证据，
但不关闭 repo-wide exact gate，也不构成全项目 production-ready 声明。

## 生产判断

本轮证明：在当前合成 Git fixture 和原 production limits 下，Shared Shadow Git 可以在 200,000 scanned-entry
硬上限建立 cold authority，并完成 warm/no-op、1/10/100 dirty、1/2/4 Session contention、overlap 和 exact
restore；没有依赖 full-reconcile fallback，也没有把失败行伪装成零延迟。

这是一项容量与正确性门禁通过，不是“所有延迟都理想”的结论：

- 200k cold p95 为 7.73–8.30 秒，低于 30 秒安全预算，但仍是明显的首次初始化等待；
- 200k warm no-change p95 为 1.16–1.18 秒，读取字节为 0，但固定 Git metadata/commit 操作仍有成本；
- 200k 4-Session p95 为 11.93 秒（wide）和 19.63 秒（deep），符合 writer lease 安全串行语义，但交互体验需要
  后续独立优化或明确排队反馈；
- 合成 fixture 不能替代真实 monorepo 的 attributes、partial clone、submodule/nested repo、超大 blob、磁盘压力和
  持续外部写入验证；这些路径仍依赖现有 fail-closed coverage 与专项 correctness tests。

因此当前可陈述的生产边界是：**合成 Git Workspace 在 200k scanned entries 内通过完整 Rewind V3 规模矩阵；
多 Session 高并发延迟和真实仓库异质性仍是上线前需要单独评估的体验/环境风险。**
