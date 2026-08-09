# Agent Rewind V3 生产规模门禁（草稿）

日期：2026-08-09

平台：macOS arm64，Node.js v22.22.3

命令：`npm run benchmark:agent-rewind-snapshots -- --entries=10000 --iterations=10`

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

## 10k × 10 结果

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

## 当前判断

10k 门禁已经证明 dirty100 不再发生进程数爆炸，但还不能单凭这一档宣布 200k 生产可用。下一步必须用相同
10 iterations 与生产 limits 运行 50k、200k；同时观察 cold 是否落在 terminal 30 秒预算内、4-session 是否
只是安全串行带来的线性等待，以及 candidateCount/bytesRead/fallback 是否保持与本次相同的边界关系。

## 50k × 10 结果

命令：`npm run benchmark:agent-rewind-snapshots -- --entries=50000 --iterations=10`

deep 与 wide 的 cold authority 都在原样生产 terminal 30 秒预算下返回：

```json
[
  {"shape":"deep","scenario":"cold","outcome":"timeout","entryCount":50000,"iterations":1,"candidateCount":0,"bytesRead":0,"commitsTraversed":0,"fallbackCount":0,"p50Ms":null,"p95Ms":null,"reason":"WorkspaceSnapshotStoreError: Workspace snapshot capture timed out"},
  {"shape":"wide","scenario":"cold","outcome":"timeout","entryCount":50000,"iterations":1,"candidateCount":0,"bytesRead":0,"commitsTraversed":0,"fallbackCount":0,"p50Ms":null,"p95Ms":null,"reason":"WorkspaceSnapshotStoreError: Workspace snapshot capture timed out"}
]
```

每个 shape 的其余 10 个场景均按门禁契约返回 `unavailable`，`p50Ms/p95Ms` 为 `null`，原因统一为
`cold authority unavailable: WorkspaceSnapshotStoreError: Workspace snapshot capture timed out`。这不是增量算法回归；
它证明在 50k 下，产品尚未建立可供 warm/dirty/restore 使用的初始 authority，benchmark 因而没有伪造后续
成功数据。

因此当前生产容量结论是：**10k 合成 deep/wide 已通过完整矩阵；50k cold 未通过 30 秒生产门禁。** 在 50k
已经无法建立 authority 的前提下，直接运行 200k 只能再次验证同一个已知 cold timeout，不会提供有效的
增量容量数据。后续若要验证 50k/200k warm 算法，应先单独解决或预构建 cold authority，并把“后台 baseline
容量”和“authority ready 后的增量边界容量”拆成两个不互相掩盖的门禁。

200k 本轮状态明确记为 **gate-dependent paused**，不是“未执行所以未知”：50k 是 200k 的前置生产门禁，且
两种 shape 都以同一 `capture_timeout` 失败。先运行 200k 会额外创建约 200k 文件并等待同一个 30 秒 deadline，
却无法进入任何 warm/dirty/restore 场景。待 cold fast path 使 50k deep/wide 都能建立 authority 后，再按
50k×10 → 200k×10 的顺序恢复验证，不能通过提高 timeout 或减少 iterations 绕过门禁。

### 50k cold 分阶段 profile

profiling 复用相同生产 `WorkspaceSnapshotStore.captureFullReconcile({ profile: "terminal" })`，没有放宽 30 秒
deadline。fixture 构造单独计时，不混入产品 authority 初始化。

deep 50k：

```json
{
  "outcome": "timeout",
  "fixture": {"createEntriesMs":28039.80,"initializeGitMs":36725.29,"identityMs":0.31,"totalMs":64766.62},
  "authority": {"storeOpenMs":2693.12,"registryInitializeMs":35219.20,"captureTotalMs":32459.05,"scopeEnumeratedMs":12200.20,"discoverScopeMs":13044.95,"stableReaderAndHashMs":19390.19,"treeMaterializeMs":null,"postCaptureInitializeMs":0.54},
  "scopeEntryCount": 50001
}
```

Git command tracing在 capture 超时前只看到初始化/发现命令，没有 `hash-object`。也就是说 13.04 秒 scope
discovery 后，剩余约 19.39 秒耗在单个大 parent group 的 anchored stable reader，reader 尚未返回就触发
deadline；tree/materialize、对象 durability 和 snapshot publish 根本没有执行。50k blocker 因此不是本轮已修复
的 candidate lookup/coverage/raw diff，而是 cold full reconcile 的文件发现与大组 stable read 路径。

wide 50k 得到相同结论：fixture 构造 54.80 秒（不计入产品 capture）；registry initialize 35.73 秒，其中
store open 2.72 秒、capture 32.94 秒。scope enumeration 9.55 秒，discover 总计 10.76 秒，随后
stable reader/hash 运行 22.16 秒后 abort，仍未到达 `hash-object` 或 tree/materialize。两种拓扑的差异只改变
discovery 与 reader 的时间分配，没有改变 blocker 所在阶段。
