# Agent 回退机制真实 Monorepo 验证与收益说明设计

## 目标

用本机 `Documents` 下的真实大型前端 monorepo 验证 Crest workspace rewind 在生产形态下的容量、
稳态效率和失败边界，并把结果做成一份中文单页 HTML。

页面必须回答三个不同的问题，不能混为一个“最高支持量级”：

1. **算法收益**：完成 baseline 后，一个 turn 需要处理多少 workspace entry；
2. **产品可用上限**：从空状态开始，能否在生产 budget/timeout 内建立 baseline 并完成 Undo/Redo；
3. **失败边界**：超过当前上限时，是否明确 fail closed，而不是产生空 checkpoint 或错误回退。

## 验证对象

选择四个互补的真实仓库：

| 仓库 | tracked files | tracked dirs | max depth | 用途 |
| --- | ---: | ---: | ---: | --- |
| `fe-poi-mono` | 11,650 | 4,520 | 13 | 贴近当前 10k 合成 benchmark 上限 |
| `fe_ls_tobias_goods_mono` | 15,513 | 6,696 | 13 | 验证 10k 与 50k 之间的真实边界 |
| `lina-mono` | 73,984 | 31,692 | 14 | 极端文件/目录数量与 capture budget |
| `fe-canal-mono` | 6,496 | 2,424 | 13 | 5.6 GB 工作目录，验证 ignored artifacts 边界 |

原仓库只允许读取。任何文件修改、Undo、Redo、rename、delete、binary、symlink 和 drift 注入都在
`/private/tmp` 下的本地隔离 clone 中执行。clone 禁止网络和 LFS smudge，不安装依赖。

## 验证层次

### A. 原仓库只读生产捕获

对四个原仓库运行真实 workspace scope discovery 和 cold capture，snapshot store/data root 放在临时目录。
记录：

- workspace entries、eligible/excluded/ignored/nested repository 数量；
- cold outcome：`completed`、`capture-timeout` 或 `capture-budget`；
- p50/p95 或失败耗时；
- enumerated entries、worker peak、new objects、newly hashed bytes；
- snapshot store 增量磁盘占用。

该层不修改 workspace，可覆盖真实 `node_modules`、build artifacts 和项目 ignore 规则。

### B. 隔离 clone 端到端工作流

只对 cold baseline 成功的代表仓库继续执行：

1. no-change capture：snapshot ref 不变，full/enumeration/worker 均为 0；
2. 修改 1 个 tracked text file：生成精确 v2 diff，Undo 恢复旧 bytes，Redo 恢复新 bytes；
3. rename、delete、binary、symlink：preview 与 apply 的 path/state 与最终 bytes 一致；
4. 修改 100 个不同目录下的文件：worker peak 不超过 8，不发生 full reconcile；
5. 1/2/4 Session：只创建一个 tracker/baseline，enumeration 不随 Session 数倍增；
6. 外部 drift：普通 apply 必须冲突，只有显式 force 才允许覆盖；
7. 最终 `git diff --exit-code` 与逐字节校验通过，临时 clone、snapshot store、watcher 和 session 全部释放。

如果某仓库 cold baseline 失败，端到端步骤标记为 `baseline-unavailable`，不得用测试专用 baseline、扩大
timeout、减少仓库文件或改变 ignore 规则绕过。

### C. 极端条件

在已成功建立 baseline 的隔离 clone 中追加可控 fixture，验证：

- 同大小 rewrite；
- 文件在 anchored read 中被替换；
- dirty directory rename/delete；
- ignored file 删除；
- nested repository boundary；
- watcher cursor gap、scope invalidation；
- 100 dirty paths 与四 Session 同时请求 capture；
- apply 前磁盘 drift 与 force confirmation。

所有 gap/race 只能得到与 full snapshot 等价的结果或显式 unavailable，不得产生 available empty 假成功。

## 量级与收益口径

“支持 N files”只在 cold baseline 和至少一个真实 Undo/Redo 工作流都成功时成立。只通过 path-local 算法测试，
或只得到 `baseline-unavailable`，不能算产品支持。

收益计算使用同一仓库、同一机器、同一 fixture：

- **no-change speedup** = cold/full boundary p95 ÷ warm no-change p95；
- **entry reduction** = 旧 full enumerated entries ÷ 新 incremental enumerated entries；
- **Session amplification** = 4 Session enumerated entries ÷ 1 Session enumerated entries；
- **rollback correctness** = preview path/state + apply bytes + final Git status 全部一致。

对于 warm no-change 的 0 entries，不展示“无限倍”，而展示“全仓 N 次访问 → 0 次访问”和实际延迟。

## HTML 信息结构

页面采用“工程测量台”视觉方向，面向产品和研发双层阅读：

1. **Hero**：一句结论，同时显示“已验证产品上限”和“算法稳态收益”；
2. **Before / After 扫描模型**：全仓扫描矩阵对比 dirty-path 高亮；
3. **10k、4 Session 示例**：旧机制的重复 entry visits 对比共享 baseline 后的 0/1/100 path 工作量；
4. **真实仓库验证表**：每个仓库显示 cold、warm、Undo/Redo、100 dirty、4 Session、drift 状态；
5. **容量阶梯**：明确区分 supported、baseline timeout、capture budget；
6. **极端条件证据**：用简洁 checklist 展示 fail-closed 行为；
7. **结论**：算法潜力、当前产品上限和下一项瓶颈分别陈述。

页面不使用“已经支持 200k”或未经真实端到端验证的倍数。50k/200k 的合成结果只作为失败边界，真实仓库
结果作为产品支持证据。

## 视觉系统

- 背景：`#0E1116` graphite；面板：`#151A21`；分隔线：`#29313C`；
- completed：`#4FD1A1`；incremental dirty：`#F2B84B`；timeout/budget：`#FF766B`；
- 标题使用紧凑 grotesk system stack，数据使用 `SFMono-Regular`/monospace；
- 唯一视觉签名是“workspace entry matrix”：优化前扫描光带穿过整个矩阵，优化后只点亮 dirty cells；
- 动画只在切换 `无改动 / 1 文件 / 100 文件 / 4 Sessions` 时发生，并尊重 reduced motion；
- 桌面双栏，移动端单栏；键盘可操作，颜色不是唯一状态提示。

## 输出物

1. 可重复执行的真实 workspace 验证脚本与测试；
2. 机器可读 JSON 结果；
3. 中文 HTML 收益说明；
4. 本设计文档和最终验证摘要。

## 停止与安全条件

- 不修改 `Documents` 下原仓库；
- 不访问网络、不安装依赖、不运行项目业务脚本；
- 不提高生产 capture timeout、entry budget 或 worker 上限；
- 单仓库临时数据超过 15 GB、单次阶段超过 15 分钟、可用磁盘不足 30 GB 时停止该仓库；
- 任何无法证明 cleanup 完成的场景视为失败；
- 所有临时 clone 使用明确路径并在验证后删除，原仓库 Git 状态必须与验证前一致。

