# Trace Panel Source Migration

## 状态

- 日期：2026-07-20
- 状态：已实施并通过自动化验证；真实 Electron 视觉验收受本机 sandbox 阻断
- 上游参考：`langfuse/langfuse@1cb1bbcf6b269fd887a6667796f1a15417cca336`
- 目标模块：Timeline、Trace Detail、Observation Detail、Desktop Layout
- 数据协议：`TraceDetail`

### 验证记录

- Trace Panel、Observability 与 Agent Runtime 集成测试：`287/287` 通过。
- Observability 类型契约、ESLint、Prettier、`git diff --check` 通过。
- `npm run build:dev` 通过。
- 真实 UI 启动被既有 Crest Dev 的 single-instance lock 和 TRAE sandbox 对
  `~/Library/Application Support/crest-dev/waveapp.log` 的访问限制阻断，因此未将旧 5173 实例视为本分支视觉验收结果。

## 背景

Crest 已将 Trace Tree 按 Langfuse 源码结构迁入正式 `trace-panel` 目录，但 Timeline、右侧 Detail 和整体 desktop layout 仍是简化实现。当前实现能够展示数据，却没有保留 Langfuse 的模块边界、时间轴计算、虚拟化、selection 定位和 Detail composition，后续维护时也无法稳定对照上游。

本阶段不继续重写这些模块，而是以 Langfuse 源码为基线迁移到 Crest 正式目录，再直接替换宿主依赖和删除 Crest 不支持的产品功能。

## 目标

- Timeline 保留 Langfuse waterfall 的计算、虚拟化、滚动同步和 selection 定位。
- 右侧内容区保留 `TracePanelDetail -> TraceDetailView / ObservationDetailView` composition。
- Trace 与 Observation Detail 复用统一 Header、Tabs、I/O Preview 和 JSON primitives。
- Desktop layout 保留 Navigation/Detail 横向 resize/collapse，以及 Navigation/Graph 纵向 split。
- Tree、Timeline、Search、Graph 和 Detail 共享同一 observation hierarchy 与 selection。
- 迁移后的文件和核心行为可逐项映射到 Langfuse 上游源码。

## 非目标

首轮不迁移以下能力：

- Playhead 播放、scrub、自动 follow 和 Graph active glow。
- Scores、Corrections 编辑和 score query invalidation。
- Comments、inline comment path、comment drawer。
- Dataset、Annotation 和 Add to dataset。
- Media fetch 与 Langfuse blob/media provider。
- PostHog analytics。
- URL query parameter persistence。
- Mobile accordion layout。
- Langfuse v4 events adapter、tRPC、RBAC 和 project context。

这些入口直接删除，不保留 disabled 占位或伪交互。

## 迁移原则

### 源码结构优先

保留上游文件边界、核心算法和组件 composition。只有以下原因允许修改：

- 类型替换为 Crest `TraceDetail`、`Trace`、`Observation` 和 `TraceNode`。
- UI primitive、图标、theme token 和 utility 替换为 Crest 现有实现。
- Provider、API 和产品能力在 Crest 没有对应数据源。
- Electron renderer、Vitest 和现有构建约束要求局部调整。

不得用新的简化实现替代可直接迁移的上游代码。

### Crest 正式目录

所有源码进入：

```text
frontend/app/observability/trace-panel/
```

不得创建：

- `/langfuse` 源码岛。
- `@/src` alias。
- ambient shim 用来伪造 Langfuse 依赖。
- `Langfuse*` 领域类型。
- adapter 层或第二套 trace payload。

### 单一数据投影

`TracePanel` 只接收 `TraceDetail`。`TraceDataProvider` 负责生成：

- `roots`
- `nodeMap`
- `observationMap`
- `searchItems`
- `traceStartTime`
- `traceDuration`

Tree、Timeline、Search 和 Detail 不得分别重建 observation hierarchy。

## 目标架构

```text
TracePanel
├── TraceDataProvider
├── TraceSelectionProvider
└── TraceLayoutDesktop
    ├── NavigationPanel
    │   └── TracePanelNavigationLayoutDesktop
    │       ├── TracePanelNavigation
    │       │   ├── TraceTree
    │       │   ├── TraceTimeline
    │       │   └── TraceSearchList
    │       └── TraceGraph
    ├── ResizeHandle
    └── DetailPanel
        └── TracePanelDetail
            ├── TraceDetailView
            └── ObservationDetailView
```

## Selection 语义

统一使用：

- `selectedNodeId == null`：选中 Trace。
- `selectedNodeId === observation.id`：选中 Observation。

Trace root 不再以 synthetic node ID 表达 selection。Tree、Timeline、Search 和 Graph 选择节点时都写入同一状态。选中的 observation 从最新 `observationMap` 消失时，Detail 自动回退到 Trace。

## Timeline

### 上游源码映射

迁移并保留以下模块职责：

| Langfuse 模块              | Crest 目标职责                                            |
| -------------------------- | --------------------------------------------------------- |
| `TraceTimeline/index.tsx`  | Timeline 主布局、virtualizer、滚动同步和 selection reveal |
| `timeline-calculations.ts` | origin、duration、offset、width、ticks、scroll target     |
| `timeline-flattening.ts`   | 从展开后的 `TraceNode[]` 生成稳定 timeline rows           |
| `TimelineRows.tsx`         | gutter/chart 虚拟行渲染边界                               |
| `TimelineGutterRow.tsx`    | 层级、connector、badge、name 和 collapse control          |
| `TimelineBar.tsx`          | duration bar、TTFT segment 和可用指标标签                 |
| `TimelineScale.tsx`        | 时间刻度、网格线和统一坐标                                |

### 数据流

```text
TraceDataContext.roots
    -> flattenTimelineRows(roots, collapsedNodes)
    -> calculateTimelineGeometry(rows, traceStartTime, traceDuration)
    -> virtualizer
    -> TimelineGutterRow + TimelineBar
```

Timeline 不直接扫描 `detail.observations`，不维护第二套 parent 修复或排序规则。

### 时间坐标

- origin 使用整个可见树最早的有效 `startTime`。
- duration 覆盖所有 observation 的 start/end 边界。
- Trace latency 可作为 root duration fallback。
- running observation 使用当前 trace 边界，不制造负数或 `NaN`。
- 缺失或非法时间的 observation 仍可出现在 gutter，但不参与时间范围计算。
- zero-duration 和 running observation 使用最小可见 bar 宽度。
- TTFT 只在 `timeToFirstToken` 有效且落在 observation duration 内时渲染。

### 滚动与虚拟化

- chart 是 vertical/horizontal scroll 的唯一来源。
- gutter 和 scale 通过 transform 与 chart 同步。
- gutter 与 chart rows 共用同一个 virtualizer 和 row measurement。
- collapse 改变后重新 flatten rows 并保持合法 selection。
- selection 来自任意导航视图时，Timeline 自动 reveal 对应 row 和 bar start。
- Timeline 不在 React state 中复制高频 scroll position。

### 首轮展示

Timeline bar 可以展示 Crest 已有数据支撑的：

- duration
- TTFT
- model
- tokens
- cost
- error state

首轮不展示 comment count、score badge 或 playhead active state。

## Detail

### 分发

`TracePanelDetail` 只负责 selection 分发：

```text
selectedNodeId == null
    -> TraceDetailView

selectedNodeId resolves to Observation
    -> ObservationDetailView

selectedNodeId cannot resolve
    -> TraceDetailView
```

### Trace Detail

`TraceDetailView` 包含：

- Header：name、status、duration、observation count、tokens、cost。
- Preview tab：Input、Output、Metadata。
- JSON tab：完整 Trace 对象。

不在 Trace 顶部默认展开 Final Output 摘要；Output 只作为 Preview 内的正常 section。

### Observation Detail

`ObservationDetailView` 包含：

- Header：type、name、level/status、latency、TTFT、model、tokens、cost。
- Preview tab：Input、Output、Metadata、Usage、Cost。
- JSON tab：完整 Observation 对象。

Section 只在有真实数据时显示，不复制 Trace input 补齐 Generation input。

### Detail Primitives

Trace 和 Observation 共用：

- `DetailHeader`
- `DetailTabs`
- `IOPreview`
- `JsonView`
- `DetailSection`
- copy feedback
- empty state
- bounded value rendering

`IOPreview` 负责 Formatted 与结构化 JSON 展示，但不引入 Langfuse worker、media provider 或 inline comments。

### 大 Payload

- Preview 对嵌套对象使用有界序列化和可展开 section。
- JSON tab 保留完整对象语义。
- copy 操作复制完整值，不复制截断后的屏幕文本。
- clipboard 不可用或写入失败时显示明确失败状态。

## Desktop Layout

### 横向分栏

Navigation 与 Detail 使用 resizable panels：

- Navigation 最小宽度：260px。
- Detail 最小宽度：360px。
- 两侧均可 collapse 到紧凑 rail。
- Crest 窄宽容器中允许整体最小宽度和横向 overflow，不让 panel solver 随机折叠内容。

### Navigation/Graph 纵向分栏

- Tree、Timeline、Search 共享主 navigation 区。
- Graph 位于 secondary panel。
- Graph 支持 resize 和 collapse。
- Graph collapse 时保留可恢复的 rail，不使用不稳定的 imperative panel handle。

### 首轮响应式范围

首轮保证 desktop 和 Crest magnified panel 的窄宽行为，不迁移 Langfuse mobile accordion。

## 状态边界

`TraceSelectionProvider` 持有：

- `selectedNodeId`
- `collapsedNodes`
- `navigationMode`
- `searchQuery`
- Graph collapse state
- Navigation/Detail collapse state

这些状态保持 renderer 内存态，不写 URL query、workspace meta 或 SQLite。

## 错误与降级

- 空 trace：显示 Trace Detail empty state，Tree/Timeline/Graph 显示各自空状态。
- observation 消失：selection 回退到 Trace。
- 非法时间：gutter 保留节点，chart 跳过非法 geometry。
- `ResizeObserver` 不存在：使用容器当前尺寸，不让测试或预览崩溃。
- virtualizer 尚未测量：使用稳定 estimate size。
- clipboard 失败：显示失败反馈，不吞掉 rejected promise。
- Graph 过大：显示明确的 too-large 状态，不混同空图。

## 测试策略

实施遵循 Red-Green-Refactor。每个迁移模块先移植上游测试或写等价失败用例，再迁入实现。

### 纯函数测试

- timeline origin 与 duration。
- offset 与 width。
- tick step。
- zero-duration、running 和非法日期。
- collapse 后 flatten 顺序。
- selected row/bar reveal target。
- Detail metrics 与 section visibility。

### 组件测试

- Timeline gutter 与 chart 行对齐。
- chart scroll 同步 gutter 与 scale。
- Tree/Timeline/Search selection 切换同一个 Detail。
- selection 消失后回退 Trace。
- Preview/JSON tab 切换。
- copy success/failure。
- Navigation、Detail 和 Graph collapse/restore。
- 窄宽 layout 不丢失 panel。

### 回归测试

- Tree 的 connector、collapse、selection 和 search 行为不变。
- 普通 Observability compact mode 不受 magnified Trace Panel 迁移影响。
- `TraceDetail` 历史加载和实时更新继续使用同一 UI。

## 实施阶段

### Phase 1：共享模型

- 收敛 selection 语义。
- 补齐 `TraceNode`、node maps 和时间范围。
- 为 Tree、Timeline、Detail 建立统一测试 fixture。

### Phase 2：Timeline

- 迁移 calculation 和 flattening。
- 迁移 Scale、Bar、Rows、Gutter 和主容器。
- 替换当前固定宽度简化 Timeline。

### Phase 3：Detail

- 迁移 Detail primitives 和 I/O Preview。
- 迁移 Trace/Observation Headers 和 Views。
- 替换当前简化 `TraceDetailPanel` 与 Trace Panel 内旧 `ObservationDetail` 复用。

### Phase 4：Desktop Layout

- 迁移横向 resize/collapse。
- 迁移 Navigation/Graph 纵向 split。
- 完成窄宽和恢复行为测试。

### Phase 5：清理与验证

- 删除被替代的简化组件。
- 检查无 Langfuse provider、API、shim、adapter 和源码岛残留。
- 更新 license/notice 中的实际迁移范围。
- 运行 observability tests、typecheck、format、diff check 和 `build:dev`。

## 验收标准

- Timeline 文件边界和核心算法可映射到 Langfuse 上游。
- Detail composition 可映射到 `TracePanelDetail`、`TraceDetailView` 和 `ObservationDetailView`。
- Desktop layout 保留两级 split、resize 和 collapse。
- Tree、Timeline、Search、Graph 和 Detail 使用统一 selection。
- Timeline 严格消费 Tree hierarchy。
- 无数据来源的 Langfuse 产品功能已删除。
- 不存在 `/langfuse` 目录、shim、adapter 或 `Langfuse*` domain types。
- 新增纯函数和组件行为均有先失败后通过的自动化测试。
- observability tests、typecheck、format、diff check 和 `build:dev` 通过。
