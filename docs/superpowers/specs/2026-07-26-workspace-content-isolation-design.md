# Workspace 内容隔离与 File Tab 视觉设计

- 日期：2026-07-26
- 状态：绘制边界修正已实现，待真实会话桌面验收
- 适用范围：Workspace Agent、File Top Tab、Top Tab 导航条、内容切换生命周期
- 上位设计：`2026-07-23-workspace-tab-architecture-design.md`

## 1. 决策摘要

本设计修正 Phase 3/4A 实现中的一个渲染边界错误，以及第一次内容隔离实现中
暴露出的 activity 边界错误：

> `ActiveContent` 切换只能改变轻量内容容器的激活状态，不能迫使非目标内容树参与同一次 React 渲染。

Phase 3/4A 最初的 `WorkspaceMainContent` 同时负责：

- 读取 `ActiveContent`；
- 控制 Agent 可见性；
- 向 `AgentContent` 传递 `visible`；
- 创建当前 Top Tab 内容；
- 渲染 Terminal 占位区域。

因此 Agent → File 会在同一次 React 提交中执行 Agent 内容树更新和 File/Monaco
挂载。提交完成前，浏览器只能继续显示旧 Agent 画面。这是第一层问题：React
内容隔离边界缺失。

第一次内容隔离实现虽然用 `memo(AgentContent)` 保住了 Agent 根组件 identity，
但又把 `active` 作为 `AgentSurfaceActivityContext` 的 boolean value 传入 Agent
子树。Context value 变化会绕过 memo boundary，强制 `AgentChatHost`、所有
`AgentCommandCard` 等 consumer 参与切换渲染。React 仍需等这些 consumer 完成，
才能提交外层隐藏状态，所以桌面运行时依旧出现约一秒 Agent 残影。

activity 隔离完成后，逐帧运行时诊断确认 Agent slot 在点击后约 7ms、首个
`requestAnimationFrame` 前已经提交 `aria-hidden` 和 `visibility:hidden`，
但真实会话仍可能出现旧文字残影。这暴露出第二层问题：`visibility:hidden`
仍保留内容的布局盒和绘制/合成资源，而 Agent 消息节点大量使用
`content-visibility:auto`、入场动画和独立合成层。它不能作为复杂 renderer
之间的强绘制隔离边界。

最终 `WorkspaceContentSlot` 在 inactive 时使用 `hidden` + `display:none`，
把整棵视觉子树从布局和绘制树中摘除；React 子树、DOM identity、Agent runtime、
composer draft 和 File editor runtime 仍然保留。该规则修正的是内容容器契约，
不依赖点击时 DOM mutation、定时器、遮罩或延迟隐藏。

最终架构采用以下规则：

- Agent 是固定内容实例，首次激活后常驻。
- File 内容首次激活后保留到 Tab 关闭，不因 Agent/File 切换卸载。
- Workspace 路由只控制轻量内容容器的 `display`、`hidden`、`inert` 和
  `aria-hidden`。
- Agent 运行时活跃状态通过稳定 lifecycle controller 下发，不作为 React
  Context boolean、组件 state 或 `AgentContent` 根组件 prop。
- activity listener 只 acquire/release session subscription、ResizeObserver 等
  命令式资源，不更新 Agent UI state。
- 冷 File 先进入 File 占位层；runtime ready 前不得挂载 Monaco editor。不得在
  旧 Agent 画面上等待 Monaco。
- Preview 和 Git Diff 延续 active-only 生命周期，但同样先切换内容容器，再加载
  重内容。
- Browser Top Tab 仍不在本阶段范围内。
- 不使用点击时直接修改 DOM、延迟定时器、遮罩旧内容或 deferred visibility
  作为正确性机制。

File Top Tab 采用已确认的 Soft Pill 视觉方案，并复用 File Explorer 的真实文件
类型图标。

## 2. 产品概念与边界

本设计不增加新的产品概念。用户仍只看到：

```text
Workspace
├── TopBar
│   ├── Agent 固定入口
│   └── TopTabBar
│       ├── File
│       ├── Preview
│       └── Git Diff
├── LeftPanel
│   ├── Files
│   ├── Agent Sessions
│   └── Terminal List
└── ContentArea
    ├── Agent
    ├── Top Tab 内容
    └── Terminal 占位区域
```

实现内部可以使用 `ContentSlot` 表示一个可激活内容容器，但不再引入 Frame、
View、Shell 或另一套 Tab 概念。

三类导航域保持独立：

- Agent 不是 Tab，没有 Tab ID、关闭和排序语义。
- Terminal Tab 只属于左侧 Terminal List 和 Terminal renderer。
- File、Preview、Git Diff 是轻量 Top Tab，不创建 Wave Tab、Block 或独立
  renderer。

## 3. 目标与非目标

### 3.1 目标

- 已加载 Agent → File 切换不显示旧 Agent 残影。
- `ActiveContent` 切换不重新执行 `AgentContent` 根组件。
- 返回已激活 File 时复用同一个 Monaco editor 实例和 model。
- 第一次打开冷 File 时立即离开 Agent，展示 File loading/error/content 状态。
- Agent 的后台运行、PTY 测量和订阅逻辑能收到 activity 变化，且 activity
  变化不触发任何 Agent UI consumer 重渲染。
- 关闭 File Tab 时可靠释放对应 editor slot 和 runtime。
- Top Tab 有明确的 selected、hover、focus、dirty 和 close 状态。
- File Tab 图标与 File Explorer 的扩展名/文件名映射一致。

### 3.2 非目标

- 不恢复重启前的 Monaco DOM、selection、undo stack 或未保存 buffer。
- 不让 Preview/Git Diff 永久保留重型 React DOM。
- 不实现 Browser Top Tab。
- 不重写 Agent runtime、Terminal renderer 或 Workspace checkpoint 协议。
- 不通过任意 LRU 上限提前淘汰 File editor；先记录 1/5/10 个 File Tab 的资源
  数据，再决定是否需要独立资源策略。

## 4. 目标架构

### 4.1 状态层

持久化导航状态不变：

```ts
interface WorkspaceContentState {
    activeContent:
        | { kind: "agent" }
        | { kind: "terminal"; terminalTabId: string }
        | { kind: "top-tab"; topTabId: string };
    topTabs: TopTab[];
    lastActiveTopTabId: string;
}
```

新增的内容实例状态完全是 renderer-local，不持久化：

```ts
interface WorkspaceContentInstances {
    agentMounted: boolean;
    activatedFileTabIds: Set<string>;
}
```

`activatedFileTabIds` 只记录当前 renderer 中已经创建过 File 内容实例的
descriptor ID。Workspace 恢复时仍只恢复 descriptor；只有最终选中 File 可以在
启动后首次激活。

### 4.2 内容区

`WorkspaceMainContent` 拆成轻量协调层和独立内容组件：

```text
WorkspaceContentArea
├── AgentContentSlot
│   └── StableAgentContent
├── FileContentSlot[file-id]*
│   └── StableFileContent
├── ActiveEphemeralTopTabSlot
│   └── PreviewContent | GitDiffContent
└── TerminalPlaceholder
```

职责：

- `WorkspaceContentArea`：读取 `ActiveContent`，决定哪个 slot 激活，并管理 File
  slot 集合；不包含 Agent 或 Monaco 业务逻辑。
- `AgentContentSlot`：始终保留稳定的 `StableAgentContent` 子树，只更新自己的
  DOM 激活属性。
- `FileContentSlot`：按 Top Tab ID 建立稳定内容实例；切换只更新 slot 激活
  属性，不重建 editor。
- `ActiveEphemeralTopTabSlot`：承载 Preview/Git Diff 的 active-only 内容。
- `TerminalPlaceholder`：继续报告中央 bounds 和 loading/error 状态。

每个 inactive slot 必须同时满足：

- `hidden`；
- `display: none`，从布局和绘制树中移除；
- `aria-hidden="true"`；
- `inert`；
- 绝对定位，不参与其他 slot 布局。

不得只设置透明度或 `visibility:hidden`，也不得让 inactive Monaco 或 Agent
接收键盘焦点。

### 4.3 稳定渲染边界

`StableAgentContent` 和 `StableFileContent` 是显式 memo boundary。它们只接收
稳定业务依赖：

- Agent：`agentModel`、`agentClient`、`executionContext`。
- File：`topTabId`、稳定 runtime/editor registry 引用。

它们不接收 `active`、`visible` 或 Workspace 路由对象。

slot 组件读取激活状态并只更新外层 DOM。测试必须证明：

- Agent → File 不增加 `StableAgentContent` render count；
- Agent → File 不增加 `AgentChatHost`、`AgentCommandCard` 或 activity probe
  render count；
- File A → File B 不重建 A 或 B 的 editor；
- File → Agent 不卸载 File editor；
- 关闭 File 才触发一次 editor/runtime dispose。

React `memo` 在这里是架构边界，不是事后性能补丁；它表达内容实例不依赖
Workspace 导航状态这一事实。

### 4.4 Agent activity

当前 `AgentContent.visible` 同时承担视觉隐藏和运行逻辑暂停，必须拆分：

- 视觉激活由 `AgentContentSlot` 独立处理。
- activity 由 workspace-scoped `AgentSurfaceActivityController` 提供。
- React Context 只提供 controller 的稳定 object identity，不提供会变化的
  boolean value。
- 只有真正依赖 activity 的资源所有者注册 listener，例如：
  - Agent session stream acquire/release；
  - running command screen size reporting；
  - PTY input/stop command 的执行时检查；
  - Agent focus restoration。

controller 使用以下窄接口：

```ts
interface AgentSurfaceActivityController {
    getActive(): boolean;
    setActive(active: boolean): void;
    subscribe(listener: (active: boolean) => void): () => void;
}
```

`AgentContentSlot` 在外层 DOM activation 已提交后向 controller 写入 activity。
listener 不得调用 React state setter，也不得通过 `useSyncExternalStore`、
Jotai atom 或 boolean Context 把 activity 重新变成渲染状态。

`AgentChatHost` 在挂载时注册一次 activity listener。listener 直接
acquire/release 当前 session event subscription；session identity 改变时更新
controller 所管理的资源绑定，但 navigation activity 改变不重新执行
`AgentChatHost`。

`AgentCommandCard` 在挂载时注册一次 listener。listener 负责连接或断开
`ResizeObserver`；按钮和输入事件在执行时读取 `controller.getActive()`。
inactive slot 已由 `display:none` 和 `inert` 阻止用户交互，因此 activity 无需
改变 JSX 的 `disabled` 或其他渲染属性。

activity 是 renderer-local 生命周期信号，不参与 workspace checkpoint，也不
影响 main 中的 Agent session 是否继续执行。它与视觉正确性解耦：即使资源释放
失败或较慢，Agent slot 仍已经隐藏。

### 4.5 File 内容生命周期

File descriptor 和内容实例分离：

```text
TopTabDescriptor
  path/title/order/selection

WorkspaceFileRuntime
  Monaco model/dirty/save/view state

FileContentSlot
  mounted editor DOM for this renderer session
```

生命周期：

1. 打开 File descriptor 并将其设为 `ActiveContent`。
2. 内容区立即激活目标 File slot。
3. 如果 slot 尚未创建，先显示轻量 File loading surface。
4. 在 slot 提交后创建 File runtime，并保持 File loading surface。
5. runtime 进入 ready 后才挂载 editor；error 时直接显示目标 File error surface。
6. 切到 Agent 或其他 File 时 slot 保持挂载，只变为 inactive。
7. 关闭 Tab 后卸载 slot，并通过现有 close coordinator 释放 runtime。
8. Workspace replacement/window close 统一释放全部 File slot 和 runtime。

File 首次激活采用明确的分阶段状态机：

- `cold`：第一次提交确认“当前已经不是 Agent”，只显示 File loading；
- `loading`：创建 runtime、读取文件，继续显示 File loading；
- `ready`：挂载 Monaco editor；
- `error`：显示 File error surface，不挂载 Monaco editor。

不得把旧 Agent 当作 File 的 loading fallback。

### 4.6 Preview 与 Git Diff

Preview/Git Diff 继续 active-only：

- 激活请求先让内容区进入对应类型的 loading/error/content 容器；
- 重内容随后挂载；
- 切走后允许卸载；
- repository/runtime 缓存规则维持现状。

它们不能阻塞 Agent slot 的隐藏提交。

## 5. 激活时序

### 5.1 已加载 File

```text
TopTabBar.activate(file-a)
  -> WorkspaceModel 同步更新 ActiveContent
  -> TopBar 更新 selected 状态
  -> AgentContentSlot 变为 inactive
  -> 已存在的 FileContentSlot[file-a] 变为 active
  -> 提交后 activity controller 释放 Agent renderer 资源
  -> 恢复 File focus
  -> checkpoint 后台保存
```

这条路径不创建 editor、不读取文件，也不重渲染任何 Agent UI consumer。

### 5.2 冷 File

```text
open/activate(file-new)
  -> WorkspaceModel 同步更新 ActiveContent
  -> AgentContentSlot 立即 inactive
  -> File loading slot 立即 active
  -> 提交后创建 File runtime
  -> runtime loading 期间保持 File loading
  -> runtime ready 后挂载 editor
  -> 恢复 File focus
```

如果读取或 Monaco 创建失败，错误显示在目标 File slot 内，Agent 保持 inactive。

### 5.3 返回 Agent

```text
FixedAgentEntry.activate()
  -> WorkspaceModel 同步更新 ActiveContent
  -> 所有 Top Tab slot inactive
  -> AgentContentSlot active
  -> 提交后 activity controller 恢复 Agent renderer 资源
  -> 恢复 Agent focus/scroll
```

## 6. File Tab 视觉

采用 Soft Pill：

- 高度：28px；
- 圆角：6px；
- 横向内边距：8px；
- 图标、标题、dirty marker、close 之间保持紧凑间距；
- selected：`bg-fg-overlay-2 text-primary`；
- inactive：`text-secondary`；
- hover：`bg-fg-overlay-1 text-primary`；
- focus-visible：使用现有 focus ring token；
- close：默认弱化，hover/focus 时增强；
- 不增加独立第二行、底部 underline 或与内容区连接的边框。

图标规则：

- 复用 `getFileIcon(name, false, false)`；
- File 使用 descriptor path 的 basename，不能依赖可能变化的 runtime title；
- Preview 和 Git Diff 可使用其目标 path 的文件图标；
- 图标尺寸 14px，`shrink-0`；
- 未识别扩展名使用通用 File icon；
- 图标只作为视觉信息，Tab 的 accessible name 仍由 title/dirty 状态提供。

Tab 宽度需要上限和文本截断。横向空间不足时由现有 TopTabBar 横向滚动，不得挤压
Search 和右侧 TopBar chrome。

## 7. 错误与焦点

- 冷 File 加载失败：保留 Tab，显示 Retry、Locate、Close。
- hidden slot 内的焦点必须在切换时释放。
- Agent 激活后恢复 composer 或最后合理焦点。
- File 激活后恢复 Monaco focus/view state。
- close 当前 File 后，先由 reducer 决定 fallback，再恢复 fallback 内容焦点。
- Terminal 激活继续由 Electron main 接管中央内容和 focus，不改变本设计的 slot
  生命周期。

## 8. 测试与验收

### 8.1 自动化测试

必须先写失败测试，再实现：

- Agent → 已加载 File 时 `StableAgentContent`、`AgentChatHost`、
  `AgentCommandCard` 和 activity probe render count 全部不变。
- Agent → 已加载 File 时目标 File editor instance identity 不变。
- Agent → 冷 File 的第一次提交已经隐藏 Agent，并显示 File loading。
- activity 切换能 acquire/release subscription 和 ResizeObserver，但不触发
  Agent React consumer render。
- 冷 File runtime ready 前不调用 Monaco editor factory。
- File → Agent → File 保留 model、dirty buffer、view state 和 editor slot。
- close File 后 slot/runtime 各 dispose 一次。
- Workspace replacement 释放全部 slot/runtime。
- selected Soft Pill、inactive、hover/focus 类和 `aria-selected` 正确。
- `.ts`、`.tsx`、`.json`、`.md` 和未知扩展名显示与 File Explorer 一致的图标。
- dirty title、dirty marker、close 和 reorder 行为不回归。

### 8.2 禁止项测试

静态或行为测试应阻止：

- `AgentContent` 重新接收 `visible` prop；
- 用变化的 boolean React Context、Jotai atom 或 `useSyncExternalStore` 向 Agent
  UI 传播 activity；
- activity listener 调用 React state setter；
- Top Tab click handler 直接查询或修改 DOM；
- 通过 `setTimeout`、`requestAnimationFrame` 或 deferred visibility 隐藏 Agent；
- 仅用 `useEffect(setMounted)` 假设浏览器一定已绘制 File loading；
- File/Agent 创建 Wave Tab、Block、LayoutState 或额外 renderer；
- TopTabBar 重新进入 `WorkspaceMainContent` 形成第二行。

### 8.3 手工验收

1. 打开三个不同类型文件，确认图标和 Soft Pill selected 状态。
2. Agent → 已加载 File 连续切换十次，无 Agent 残影、空白帧或 Monaco 重置。
3. Agent → 新 File 时立即看到 File loading/content，不停留 Agent。
4. File A 编辑未保存内容，切到 Agent、File B，再返回 A，内容和光标状态保留。
5. Agent 后台运行时切换 File，任务继续；返回 Agent 后输出恢复。
6. 使用键盘切换、快捷命令和 restore 路径重复以上场景。
7. 记录 1/5/10 个已激活 File slot 下的 renderer RSS，作为后续资源策略依据。

## 9. 对现有设计的修订

本设计修订上位文档中的以下内容：

- `9.3 File Tab` 的“React editor component 可卸载”改为：当前 renderer session
  中首次激活后保留到 Tab close；重启仍不恢复 editor DOM。
- `10.2 Agent UI 生命周期` 的“切走时隐藏”明确为 slot 外层隐藏，不向
  `AgentContent` 根组件传播导航可见性。
- `9.5 Preview 与 Diff` 保留 active-only，但其挂载不得与旧内容隐藏绑定为同一
  重型提交。

Phase 4A 已完成的 descriptor、runtime registry、close coordinator、checkpoint 和
Terminal renderer 边界继续保留。本设计只重构 Workspace renderer 内的内容实例
隔离与 TopTabBar 视觉。

## 10. 完成条件

只有同时满足以下条件才能认为本重构完成：

- 自动化测试证明导航切换不重渲染 Agent 根组件及 activity consumers；
- 自动化测试证明已加载 File editor 不因普通切换卸载；
- 冷 File 不以旧 Agent 画面作为 pending UI，runtime ready 前不挂载 Monaco；
- File Tab 使用 Soft Pill 和 File Explorer 图标；
- Workspace/TopBar/Agent/File 相关测试通过；
- Electron 开发构建通过；
- 用户完成桌面运行时验收。
