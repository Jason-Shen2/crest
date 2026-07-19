# Agent Observability Single Trace Dashboard

## 状态

- 日期：2026-07-19
- 状态：已确认，待实施
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

完成标准：

- 普通 right panel 和 magnify 模式均可完成 run 复盘。
- 默认摘要足以理解执行轨迹，Detail 可查看完整数据。
- 历史和实时行为一致。
- canonical 数据链路保持单一。
- Single Trace 完成后再进入 swimlane / race 设计。
