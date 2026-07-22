# Observability Host-Aware Trace Panel

## 状态

- 日期：2026-07-22
- 状态：设计已确认，待实施
- 依赖：现有 Langfuse 源码级迁移后的 `TracePanel`
- 目标宿主：普通右侧 Observability panel 与 magnified Observability panel

## 背景

Observability 当前按 `magnified` 分成两套 UI：

- Magnified 模式使用迁移后的 `TracePanel`，包含共享 Tree、Timeline、Search、Graph 和 Detail。
- 普通模式仍使用 legacy `RunReview + TimelineToolbar + ObservationTimeline + ObservationDetail` composition。

两套实现分别维护 selection、展开状态、Timeline 行为和 Detail 展示，已经产生交互与视觉偏差。普通模式应以 magnified 后的 Trace Panel 为唯一业务实现，但不能直接复用现有 desktop 布局，因为 `TraceLayoutDesktop` 强制 Navigation 与 Detail 的组合最小宽度为 621px，在普通窄 panel 中会产生横向滚动。

## 目标

- 普通与 magnified 模式复用同一套 Trace 数据、selection 和业务组件。
- 普通模式展示与 magnified 模式一致的 Tree、Timeline、Search 和 Detail 内容。
- Magnified 模式保留现有 resizable Navigation/Detail desktop layout。
- 普通模式使用适配窄宿主的 compact layout，不引入横向滚动。
- 普通模式通过底部 Detail drawer 展示 Trace 或 Observation Detail。
- 删除普通模式的 legacy Timeline composition 和重复状态。

## 非目标

- 不改变 `TraceDetail` 数据协议或 Agent Observability IPC。
- 不修改 Tree、Timeline、Search、Graph 和 Detail 的领域行为。
- 不新增 mobile accordion 或根据 viewport 自动切换布局。
- 不把 desktop panel solver、collapse rail 或横向 resize 移植到 compact layout。
- 不保留两套业务组件作为兼容路径。
- 不新增 adapter、shim 或第二套 selection model。

## 设计原则

### 单一业务实现

Tree、Timeline、Search、Graph 和 Detail 只保留 Trace Panel 目录下的实现。Host layout 只决定空间组织，不重建数据、selection 或 navigation 行为。

### 显式宿主模式

`ObservabilityPanel` 根据现有 `magnified` 状态向 `TracePanel` 显式传递：

```ts
type TracePanelLayout = "compact" | "desktop";
```

不使用 viewport media query、`ResizeObserver` 或容器宽度猜测业务模式。这样普通与 magnified 的行为由宿主明确控制，测试和状态切换也具有确定性。

### 保持共享内容挂载边界清晰

`TracePanel` 继续拥有 `TraceDataProvider` 和 `TraceSelectionProvider`。Provider 内部只渲染一个 host-aware content boundary，由 layout mode 选择空间 composition。

## 目标架构

```text
ObservabilityPanel
└── TracePanel(detail, layout)
    ├── TraceDataProvider
    ├── TraceSelectionProvider
    └── TracePanelContent
        ├── Shared TraceNavigation
        │   ├── TraceTree
        │   ├── TraceTimeline
        │   └── TraceSearchList
        ├── Shared TraceGraph
        ├── Shared TracePanelDetail
        │   ├── TraceDetailView
        │   └── ObservationDetailView
        └── Host Layout
            ├── desktop
            │   └── TraceLayoutDesktop
            │       ├── Navigation + Graph
            │       └── resizable Detail
            └── compact
                └── TraceLayoutCompact
                    ├── full-width Navigation
                    └── bottom Detail drawer
```

## 组件边界

### `TracePanel`

`TracePanel` 接收 `detail` 和 `layout`：

```ts
interface TracePanelProps {
    detail: TraceDetail;
    layout: "compact" | "desktop";
}
```

职责：

- 建立共享 data provider。
- 建立共享 selection provider。
- 根据显式 layout mode 选择 desktop 或 compact composition。

`TracePanel` 不复制 navigation、graph 或 detail 的数据流。

### 共享 Navigation Workspace

当前 `TracePanelNavigationLayoutDesktop` 同时承担共享内容和 desktop collapse control。实施时拆出不依赖 `useDesktopTraceLayout()` 的共享 Navigation workspace，包含：

- `TraceNavigationHeader`
- Tree、Timeline 或 Search 主内容
- 可选 Graph 区域

Desktop wrapper 继续添加：

- Collapse navigation 按钮。
- Navigation/Graph vertical resizable split。
- Graph collapse rail。

Compact wrapper 只组合共享 header 与主 navigation 内容，不消费 desktop layout context。

### `TraceLayoutDesktop`

保持现有 magnified 行为：

- Navigation 与 Detail 横向 resize。
- Navigation 与 Detail collapse/restore。
- Navigation 与 Graph 纵向 resize。
- Graph collapse/restore。
- 621px 组合最小宽度和现有窄宽 overflow 语义不变。

本需求不修改 desktop solver。

### `TraceLayoutCompact`

Compact layout 使用单列结构：

- Navigation 占据可用主区域。
- Detail 以底部 drawer 覆盖在主区域之上。
- 不渲染 desktop 横向 PanelGroup。
- 不设置 desktop 的 621px 最小宽度。
- 不显示 Navigation collapse control。
- Graph 默认不渲染，避免在普通窄 panel 中挤压 Timeline 核心区域。

Graph 数据与组件仍是共享实现；仅 compact host 的空间策略不展示 Graph。本阶段不增加 compact Graph toggle。

## Compact Detail Drawer

### 状态

Drawer open/closed 是 compact host 独有的瞬时 UI 状态，不进入 `TraceSelectionProvider`：

```ts
const [detailOpen, setDetailOpen] = useState(false);
```

Selection 与 drawer visibility 分离：

- `selectedNodeId == null` 仍表示 Trace root。
- `selectedNodeId === observation.id` 仍表示 Observation。
- 关闭 drawer 不清除 selection。

### 初始状态

- 首次进入普通 Observability panel 时 drawer 收起。
- Trace root 仍是 selection 的默认语义，但不会因此自动打开 drawer。
- 实时 trace 更新不会自动打开 drawer。

### 打开行为

以下显式用户操作打开 drawer：

- 点击 Trace root。
- 点击 Tree、Timeline 或 Search 中的 Observation。

点击已选中的节点保持 drawer 打开，不作为 toggle。Drawer 已关闭时再次点击当前 selection 会重新打开。

### 关闭行为

- Drawer header 提供明确的关闭按钮。
- 关闭只修改 `detailOpen`。
- 关闭后 Tree、Timeline 和 Search 的 selected state 保留。
- 不通过点击 backdrop 关闭，因为 drawer 位于工作区内部且用户仍需操作 navigation。

### 内容

Drawer 直接渲染 `TracePanelDetail`：

- Trace root selection 显示 `TraceDetailView`。
- Observation selection 显示 `ObservationDetailView`。
- Preview/JSON、copy、bounded serialization 和 empty state 与 desktop 完全一致。

Drawer 需要设置稳定的最大高度和最小可用高度，使 Timeline 始终保留可交互区域；具体 Tailwind 尺寸在实施阶段以现有右侧 panel 高度测试为准，但不得占满整个 compact host。

## Selection 数据流

```text
Tree / Timeline / Search user selection
    -> TraceSelectionProvider.selectNode()
    -> shared Detail resolves current node
    -> desktop: Detail panel updates in place
    -> compact: selection callback also opens Detail drawer
```

为了避免每个导航组件感知 host mode，`TraceSelectionProvider` 将当前公开的 `setSelectedNodeId` 收敛为表达用户意图的 `selectNode`。`selectNode` 同时更新共享 selection，并调用 provider 的可选 `onSelectionIntent` callback。Compact host 用该 callback 打开 drawer；desktop host 不传 callback。

Observation 消失后的 Trace fallback 继续由 provider 根据最新 `observationMap` 派生，不调用 `selectNode`，因此不会把已关闭的 drawer 自动打开。实现不得通过监听 `selectedNodeId`、轮询、`setTimeout` 或 ref 比较来推断用户点击。

## `ObservabilityPanel` 收敛

当 trace detail 可用时，两种模式都渲染 `TracePanel`：

```tsx
<TracePanel detail={selectedTraceDetail} layout={magnified ? "desktop" : "compact"} />
```

`ObservabilityPanel` 继续负责：

- session 与 trace list loading。
- selected trace identity。
- trace selector。
- loading、empty 和 error states。
- magnified host mode。

`ObservabilityPanel` 不再负责：

- legacy Timeline query/category filter。
- legacy row expansion。
- legacy inline Observation Detail。
- legacy follow-live state。
- Trace Panel 内部 selection。

## Legacy 清理

普通模式停止使用并删除对应 imports/composition：

- `RunReview`
- `TimelineToolbar`
- `ObservationTimeline`
- legacy `ObservationDetail`
- `ObservabilityViewState`

实施前必须搜索全仓使用方。只有确认无其他调用方时才删除文件；仍有独立使用方的文件可保留，但不得继续参与普通 Observability panel 渲染。

此前 legacy `ObservationTimeline` 的 row remeasurement 和 follow-live 修复不会迁移到新路径，因为共享 `TraceTimeline` 已有独立的 virtualizer、measurement 和 selection reveal 机制。相应测试应迁移为共享 Timeline 行为测试，而不是保留 legacy composition。

## Trace 切换与 Layout 切换

### Trace 切换

`TraceSelectionProvider` 继续以 `traceId` 确定状态生命周期：

- 首次选择一条 trace 时 selection 为 Trace root。
- 返回先前浏览过的 trace 时沿用现有 per-trace selection 语义。
- Compact drawer 回到收起状态。
- 不把一条 trace 的 Observation selection 带入另一条 trace。

### Magnify 切换

普通与 magnified 通过同一个、无 `key` 分叉的 `TracePanel` 实例切换 layout prop，外层 data/selection providers 不因 layout 切换重建：

- 从 compact 切到 desktop 时 desktop Detail 显示当前共享 selection。
- 从 desktop 切回 compact 时 drawer 默认收起，避免 magnify 状态隐式决定 compact overlay。
- Tree/Timeline navigation mode、search、selection 和 collapsed nodes 在 layout 切换时保留。
- Drawer visibility 与 desktop collapse/resize 状态属于各自 host，不跨 layout 传播。
- 本阶段不新增 URL、workspace meta 或 SQLite 持久化。

## 错误与降级

- 无 selected trace：沿用 `ObservabilityPanel` empty state，不挂载 layout。
- Trace 无 observations：共享 Tree/Timeline empty state 正常显示，Trace root 仍可打开 Detail。
- Selected observation 在 streaming 更新中消失：共享 selection 回退 Trace；compact drawer 若已打开则显示 Trace Detail。
- Drawer 内容异常大：内部滚动，不扩张 host 高度。
- Compact host 极窄：Navigation 和 drawer 使用 `min-w-0`，不继承 desktop 最小宽度。
- Clipboard、JSON serialization 和非法 observation 时间继续由共享 Detail/Timeline 处理。

## 可访问性

- Drawer 使用具名 region 或 dialog 语义，但不设为 modal。
- 关闭按钮有明确 `aria-label`。
- Drawer open state 可通过稳定的 test id 或 ARIA 属性观察。
- Tree/Timeline/Search 现有 keyboard 和 selection 语义保持不变。
- 打开 drawer 不强制抢走 navigation 焦点。
- 关闭 drawer 后焦点返回触发关闭按钮前的合理位置，优先返回最近一次 selection trigger。

## 测试策略

实施遵循 Red-Green-Refactor。

### `TracePanel` host tests

- `layout="desktop"` 渲染现有 desktop resizable composition。
- `layout="compact"` 不渲染 desktop panel group 或 621px 最小宽度容器。
- 两种 layout 使用同一 Tree、Timeline、Search 和 Detail 组件。
- Compact 不渲染 Graph。

### Compact drawer tests

- 初始收起。
- 点击 Trace root 后打开并显示 Trace Detail。
- 点击 Observation 后打开并显示 Observation Detail。
- 点击已选节点不关闭 drawer。
- 关闭按钮收起 drawer但保留 selection。
- Drawer 关闭后再次点击当前 selection 可重新打开。
- 切换 trace 后 drawer 收起，且不会继承另一条 trace 的 Observation selection。
- 返回已浏览 trace 时沿用其 per-trace selection，但 drawer仍保持收起。
- Streaming 中 selected observation 消失时，已打开 drawer 回退 Trace Detail。

### `ObservabilityPanel` regression tests

- 普通和 magnified 都渲染共享 `TracePanel`。
- 普通模式不再渲染 legacy `ObservationTimeline`、`RunReview` 或 inline `ObservationDetail`。
- Magnified desktop resize、collapse 和 Graph 行为不变。
- Trace selector、loading、empty、error 和 historical trace loading 行为不变。

### Existing suite

- Trace Tree keyboard/ARIA tests。
- Trace Timeline virtualizer、scroll sync 和 reveal tests。
- Detail Preview/JSON/copy tests。
- Desktop layout solver、collapse 和 narrow host tests。
- Observability IPC 与 streaming integration tests。
- Frontend typecheck、ESLint、Prettier 和 `git diff --check`。

## 实施阶段

### Phase 1：共享内容边界

- 为 `TracePanel` 增加显式 layout prop。
- 从 desktop-specific navigation wrapper 中拆出共享 Navigation workspace。
- 保持 providers、selection 和业务组件单一。

### Phase 2：Compact Layout

- 新增 compact 单列 layout。
- 增加非 modal bottom Detail drawer。
- 通过明确的 user selection intent 打开 drawer。
- 保持关闭与 selection 状态解耦。

### Phase 3：Panel 收敛

- 普通与 magnified 都渲染共享 `TracePanel`。
- 删除普通模式 legacy composition 和重复 state。
- 搜索并清理无使用方的 legacy 文件。

### Phase 4：验证

- 更新普通与 magnified 的组件和交互测试。
- 运行完整 Observability frontend suite。
- 验证 desktop solver 无回归。
- 运行 typecheck、ESLint、Prettier 和 diff check。

## 验收标准

- 普通与 magnified 模式只有一套 Trace Panel 业务实现。
- 普通模式使用共享 Tree、Timeline、Search 和 Detail。
- 普通模式不产生 desktop 621px 最小宽度导致的横向滚动。
- Compact drawer 初始收起，仅由显式节点选择打开。
- Drawer 关闭不清除 selection，再次点击当前节点可重新打开。
- Compact 不展示 Graph；magnified Graph 行为保持不变。
- 普通模式不再渲染 legacy `RunReview + TimelineToolbar + ObservationTimeline + ObservationDetail`。
- 不新增 adapter、shim、重复 Trace model 或 selection state。
- 现有 magnified desktop resize/collapse、Timeline、Detail 和 IPC 测试无回归。
