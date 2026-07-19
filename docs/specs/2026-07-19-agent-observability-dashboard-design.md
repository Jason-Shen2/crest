# Agent Observability Single Trace Dashboard

## 状态

- 日期：2026-07-19
- 状态：Single Trace 已实现并完成 Task 9 验证；swimlane / race 未实施
- 参考实现：`disler/pi-agent-observability@cbb8cc30b9bb2ff1b93a20d4415f72877b019868`
- 数据模型：Langfuse-compatible `Trace / Observation / Score`

## 目标

把当前只显示 Trace 状态和 Observation 名称的骨架视图，升级为可用于复盘和诊断 Agent run 的 timeline + detail dashboard。

用户无需查看原始 JSON，就能回答：

- Agent 做了什么，最终结果是什么。
- 调用了哪些工具，各自输入、输出和耗时是什么。
- 哪些节点失败或异常。
- Generation 使用了多少 token 和 cost。
- Run 的总耗时、工具数、Generation 数和错误数。

本阶段只升级 Single Trace 体验，不实现 swimlane 或 race。

## 设计原则

- `AgentHarness.subscribe()` 是唯一 canonical 数据源。
- `TraceGraph` 是历史加载和实时更新的唯一 UI 协议。
- 不引入 Pi 的 `ObsEvent`，不建立第二套事实源。
- 不监听 hook 通道补数据；缺失字段只能由 harness 正向 `emitOwn` 广播。
- 历史与实时使用同一套 presentation、metrics 和 timeline 组件。
- 普通 right panel 优先保证窄宽度可读性，magnify 模式利用额外横向空间。

## 信息架构

```text
ObservabilityPanel
├── Header
│   ├── Recent Runs
│   └── Live / Success / Error / Aborted
├── RunReview
│   ├── duration / generations / tools / errors
│   ├── input / output / cache tokens / cost
│   └── final output summary
├── TimelineToolbar
│   ├── search
│   ├── type filters
│   └── expand / collapse
└── ObservationTimeline
    └── ObservationRow
        ├── semantic summary
        ├── badges / relative time / duration
        └── ObservationDetail
```

Recent Runs 使用紧凑选择器，不在 right panel 内增加完整 Session Sidebar。

## 响应式 Detail

普通 right panel 使用 Timeline 内联展开：

- 点击 Observation 后在原位置展开 Detail。
- 阅读顺序与执行上下文连续。
- 可同时展开多个节点，也可 Expand All / Collapse All。

magnify 模式使用 Timeline + 固定 Detail 双栏：

- Timeline 保持紧凑摘要。
- 右侧固定展示当前选中 Observation。
- 与内联模式共享 `selectedObservationId`、展开态和 presentation model。

Detail 分区：

- Overview：type、name、status、relative time、duration、model。
- Input：Tool args、Generation input 或 Event payload。
- Output：Tool result、assistant output、status message。
- Usage：token、cache、cost、latency、TTFT。
- Metadata：结构化 metadata。
- Raw：完整 Observation JSON，支持复制与自动换行。

## Timeline

Timeline 按 `startTime` 升序排列；相同时间维持 graph 原始顺序。

Observation 被投影为：

```ts
type ObservationPresentation = {
    category: "generation" | "tool" | "lifecycle" | "error";
    label: string;
    summary: string;
    tone: "neutral" | "info" | "success" | "warning" | "error";
    badges: Array<{ label: string; tone: string }>;
    searchableText: string;
};
```

展示规则：

- AGENT 根节点进入 Run Review，不在 Timeline 重复显示。
- GENERATION 显示输出摘要、model、tokens、cost、duration。
- TOOL 显示工具名、压缩参数、成功/失败和 duration。
- EVENT 显示 model change、compaction、branch navigation 等生命周期地标。
- `level=ERROR` 或存在 `statusMessage` 的节点进入 Errors 过滤类别。

交互：

- 搜索匹配预计算的 `searchableText`。
- 类型过滤支持 All、Generation、Tool、Lifecycle、Errors。
- 搜索与类型过滤是 AND 关系。
- `j/k` 或方向键移动焦点，Enter/Space 展开，Esc 折叠，`g/G` 跳到首尾，`/` 聚焦搜索。
- 使用 `@tanstack/react-virtual` 支撑长 Trace，并动态测量展开行高度。

## Live 行为

- 首次加载从 SQLite 获取历史 TraceGraph。
- IPC 实时更新继续推送完整 TraceGraph，本阶段不改 patch 协议。
- 正在查看最新 run 时，实时 graph 原位更新。
- 用户切换到历史 run 后，新 run 不抢占当前视图，只更新 Recent Runs 状态。
- 用户处于 Timeline 底部时自动跟随。
- 用户向上滚动后暂停自动跟随，并显示“回到实时”操作。
- 切换 Trace 时保存并恢复该 Trace 的 selected observation、展开态和滚动位置。
- 异步 `getTrace()` 返回前再次核对 selected trace id，避免快速切换串线。

## Run Review

从 TraceGraph 纯计算：

- status、开始/结束时间、duration。
- Generation、Tool、Lifecycle、Error 数量。
- input、output、cache read、cache write、total tokens。
- costDetails 合计。
- Trace output 或最后一个 Generation output 的摘要。

运行中未结束的 Observation 不显示完成耗时；完成后使用 `endTime - startTime`。

## 状态边界

持久化事实：

- Trace、Observation、Score 继续保存在 SQLite。

临时 UI 状态：

- selectedTraceId。
- selectedObservationId。
- search query 和 type filters。
- expanded observation ids。
- follow-live 状态。
- 每个 Trace 的滚动位置。

这些状态本阶段保持 renderer 内存态，不写 workspace meta。

## 数据补强

第一步先审计现有真实 TraceGraph，不预先扩展事件。

### Task 8 匿名真实数据审计

2026-07-19 对隔离开发环境中的代表性 run 做只读审计。以下仅保留聚合计数和字段完整度，不记录数据库路径、Trace/Session ID、用户输入、工具参数、工具输出、状态消息或模型名称。

该 run 以 `success` 完成，包含 3 个 GENERATION、2 个 TOOL，其中 1 个 TOOL 为受控失败并以 Error 交叉计数。Trace 的 input、output 和起止时间均完整，数据库完整性检查返回 `ok`。

| 对象 | 样本量 | level | status | input | output | timing | model |
|---|---:|---:|---:|---:|---:|---:|---:|
| GENERATION | 3 | 3/3 | 0/3 | 0/3 | 3/3 | 3/3 | 3/3 |
| TOOL | 2 | 2/2 | 1/2 | 2/2 | 2/2 | 2/2 | 0/2 |
| Error | 1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 0/1 |

其中 `status` 表示非空 `statusMessage`，只在失败 TOOL 上出现；Tool/Error 的 model 不适用。3/3 GENERATION 还具有 latency、TTFT、usage 和 cost。

GENERATION input 为 0/3 会使 Detail 隐藏逐次 Generation 的 Input 区，并使 Timeline 搜索无法匹配该轮请求上下文；它不影响当前主路径，因为 Timeline 摘要优先使用 3/3 完整的 Generation output，Run Review 的用户输入来自 Trace/AGENT input，model、timing、usage 和 cost 也均完整。逐 Generation prompt/context 检查属于后续增强，不应通过 UI 推断或复制 Trace input 补齐。现有 canonical 数据足以支撑 Run Review、Generation 输出与性能诊断、工具详情、错误详情和成功轨迹回放，无需新增 harness own event 或持久化字段。

### Gap 表

| 期望字段 | 现有 canonical 来源 | Langfuse 落点 | 是否必需 | 处理结论 |
|---|---|---|---|---|
| Tool args | `tool_execution_start.args` | `Observation.input` | 是 | 已完整，无需补强 |
| Tool result | `tool_execution_end.result` | `Observation.output` | 是 | 已完整，无需补强 |
| Tool status/duration | tool start/end 事件 | `level`、`statusMessage`、`startTime/endTime` | 是 | 已映射；代表样本已验证 1 个失败 TOOL 的 level、status、input、output 和 timing |
| Generation input | subscriber-visible assistant 事件未携带请求上下文 | `Observation.input` | 否 | 当前 UI 条件隐藏 Input，不影响摘要、Run Review 或 usage 诊断；后续需要真实 canonical 来源时再补强 |
| Generation output | assistant `message_update/end` | `Observation.output` | 是 | 已完整，无需补强 |
| Usage/cost | assistant `message_end.usage` | `usageDetails/costDetails` | 是 | 已完整，无需补强 |
| Model/provider | assistant message 的 `model`、`responseModel`、`provider` | `model`、`metadata` | 是 | Builder 消费现有 canonical 字段，不新增事件 |
| Generation start | assistant message 的毫秒级 `timestamp` | `startTime` | 是 | 使用请求发起时间，覆盖 provider 请求等待 |
| TTFT | 首个 text/thinking/tool-call delta 相对 canonical `startTime` | `timeToFirstToken` | 是 | Builder 计算并持久化 |
| Generation latency | `message_end` 相对 canonical `startTime` | `latency` | 是 | Builder 计算并持久化 |

`AssistantMessage.timestamp` 由 provider 在异步请求开始前创建，早于收到 stream `start` 后广播的 `message_start`。因此 Generation 的 `startTime` 必须使用该 canonical 时间戳；若使用 Builder 收到 `message_start` 的墙钟时间，会系统性漏掉 provider 请求等待，并同时低估 TTFT 和总 latency。

前端类型需要补齐当前 main model 已有字段：

- `version`
- `latency`
- `timeToFirstToken`
- `toolCalls`
- `toolCallNames`

如果真实数据无法支持关键诊断信息，再扩展 harness own event。所有补强必须满足：

- 字段有明确 Langfuse Observation 落点。
- 通过 `emitOwn` 进入 canonical subscriber 总线。
- Builder、SQLite row、ambient type 和 UI 同步更新。
- 不通过 hook listener、Adapter 或 UI 推断旁路补齐。

## 组件边界

- `observability-panel.tsx`：加载、订阅和响应式整体布局。
- `trace-selector.tsx`：Recent Runs 选择。
- `run-review.tsx`：run 聚合指标和最终结果。
- `timeline-toolbar.tsx`：搜索、过滤和展开控制。
- `observation-timeline.tsx`：排序、虚拟列表、焦点和 live-tail。
- `observation-row.tsx`：摘要行和内联 Detail。
- `observation-detail.tsx`：结构化详情。
- `observation-presentation.ts`：Observation 语义投影纯函数。
- `trace-metrics.ts`：TraceGraph 指标聚合纯函数。
- `observability-view-state.ts`：选择、过滤、展开和 follow-live reducer。

## 测试与验收

纯函数测试：

- Generation、Tool、Lifecycle、Error presentation。
- duration、token、cost、tool/error 数量聚合。
- 搜索文本和类型过滤。

组件测试：

- Recent Runs 切换与异步防串线。
- Timeline 搜索、过滤、展开和键盘操作。
- 普通模式内联 Detail。
- magnify 模式双栏 Detail。
- 实时更新不抢占历史 Trace。
- follow-live 暂停和恢复。

集成测试：

- SQLite 历史加载与 IPC 实时 graph 使用相同渲染路径。
- 运行含多个 Generation、Tool 和 Error 的真实 Agent run。
- 1,000 个 Observation 下滚动、搜索和实时追加保持可用。

### Task 9 验证结果

2026-07-19 使用 Node `v22.23.1` 完成最终验证：

- Targeted Vitest：`12/12` 个测试文件、`137/137` 个测试通过。
- Observability 类型契约：`1/1` 个 typecheck 文件通过，`0` 个 type error。
- Filtered `tsc`：`frontend/app/observability`、`frontend/app/workspace/right-tool-panel`、`emain/agent/observability`、`emain/agent-ipc` 无匹配错误；全仓仍有 75 条与本功能路径无关的存量 TypeScript 错误。
- 1,000 Observation fixture：使用真实 `@tanstack/react-virtual`，DOM 挂载窗口保持少于 100 行，搜索完整数据后唯一命中第 998 条 Observation；ResizeObserver 将首行从 44px 重测为 180px 后，第二行实际移动到 180px 且不重叠。Focused 文件 `2/2` 个测试通过。
- 桌面 UI：在隔离配置和匿名合成 SQLite 数据下验证 Recent Runs 切换、Run Review 数值、搜索、类别过滤、普通模式内联 Detail、magnified 模式 Timeline + 固定 Detail 双栏，以及 live-tail 暂停和 “Back to live” 恢复。
- 完成态：targeted builder 测试验证 `agent_start` 的 `running` 状态在 `agent_end` 后变为 `success` 并写入 `endedAt`；桌面验收未调用真实模型。

Run Review 的匿名 success fixture 与 SQLite 值一致：duration `5.0s`、Generation `1`、Tool `2`、Error `1`、input/output/cache read/cache write/total tokens 分别为 `120/30/10/5/165`，cost 为 `$0.0125`，final output 为 `Review complete`。

完成标准：

- 普通 right panel 和 magnify 模式均可完成 run 复盘。
- 默认摘要足以理解执行轨迹，Detail 可查看完整数据。
- 历史和实时行为一致。
- canonical 数据链路保持单一。
- Single Trace 完成后再进入 swimlane / race 设计。
