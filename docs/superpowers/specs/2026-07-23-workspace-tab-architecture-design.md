# Workspace 与 Tab 架构重构设计

- 状态：Phase 1 complete；Phase 2 automated implementation complete、runtime smoke pending；Phase 3 implemented；Phase 4A File/Preview/Git Diff automated implementation complete、runtime smoke pending，Browser Top Tab deferred
- 日期：2026-07-23
- 适用范围：Workspace、Agent、Terminal Tab、Top Tab、持久化与 renderer 生命周期

## 1. 决策摘要

Crest 不再把所有主内容都建模为 Wave Tab。

本文只使用四个产品概念：

1. **Workspace**：整个窗口工作区，包含顶部栏、左右面板和主内容区。
2. **Agent**：固定入口，不是 Tab。
3. **Terminal Tab**：位于左侧，一个 Tab 可以包含多个 Terminal Pane。
4. **Top Tab**：位于顶部，包括 File、Browser、Preview、Diff。

实现层只使用两个 renderer 名称：

1. **Workspace Renderer**：每个窗口一个，始终存在，渲染 Workspace 和所有非 Terminal 内容。
2. **Terminal Renderer**：每个 Terminal Tab 一个，只渲染中央 Terminal 内容。

Terminal Tab 继续使用 Wave Tab、LayoutState、Block、controller、WPS/RPC 和独立 `WebContentsView`，但禁止 File、Web、Preview、Diff、Agent 等非 Terminal Block。Top Tab 不创建 Wave Tab、LayoutState、Block、controller 或独立顶层 `WebContentsView`。

`shell` 只用于描述 Agent/Terminal 的命令执行环境，不作为 UI 架构名。`View` 只在引用 Electron `WebContentsView` 或现有 `ViewModel` 类型时出现。

本次采用 hard cut：

- 不迁移旧的混合 Tab。
- 不保留 hidden Agent Tab 或 backing Agent Block。
- 不保留新旧激活模型的兼容镜像。
- 开发环境使用新 schema；旧本地 workspace 数据可重建。

Workspace 使用持久化的 `tabdomainversion` 区分新旧数据域。版本 0 表示 legacy，可继续执行旧 starter Tab 自愈；版本 1 表示新架构，即使 `terminaltabids` 为空也不得创建 legacy Tab。所有新 Workspace 在窗口自愈和 onboarding 前写入版本 1。

## 2. 被取代的设计

本设计取代以下文档中“所有主内容继续复用 Wave Tab”的决策：

- `2026-07-02-top-tab-refactor-design.md`
- `2026-07-04-file-tree-editor-tab-design.md`
- `2026-07-05-git-diff-tab-design.md`

本设计同时推进 `2026-07-19-agent-architecture-refactor-design.md` 的最终目标：

- 保留 `AgentContent -> AgentRuntimeRegistry -> AgentSessionRuntime`；
- 取消该文档中的 backing block 兼容阶段；
- Agent 在没有任何 Terminal Tab 时仍能独立运行 shell/tool 任务。

## 3. 背景与问题

当前一个顶层 Wave Tab 同时表示：

- backend `Tab`；
- `LayoutState` 和 Block 树；
- controller/PTY 生命周期；
- 固定 `tab:<id>` RPC route；
- 独立 Electron `WebContentsView`；
- 完整 React/Jotai/WOS/WSH renderer；
- TopBar、左右面板、状态栏、通知和中央内容。

主进程切 Tab 时会获取或创建目标 `WaveTabView`，将目标 View 移到窗口内，并将其他 View 移到 `(-15000, -15000)`。即使用户视觉上只切换中央内容，实际发生的是完整 renderer 切换。

这对 Terminal 有价值，因为 Terminal 需要：

- PTY/controller 生命周期；
- 多 Pane 布局、resize、focus 和 magnify；
- TUI/终端状态保活；
- Block-scoped WPS/RPC；
- 独立 renderer 缓存。

但 Agent、File、Browser、Preview、Diff 不需要这套成本。继续复用 Wave Tab 会导致：

- 每个非 Terminal Tab 重复初始化完整 Workspace chrome；
- File/Browser 切换仍触发 Electron renderer 交换；
- Agent 固定入口背后仍需隐藏 Wave Tab；
- 顶部栏通过异步 Block 探测判断 Tab 类型；
- 快捷键、关闭、排序和持久化被迫共享一份 `workspace.tabids`；
- 新的非 Terminal 类型继续放大 `staticTabId`、LayoutModel 和 RPC route 的耦合。

## 4. 目标与非目标

### 4.1 目标

- 非 Terminal 内容间切换只更新 Workspace 内的本地状态，不交换顶层 Electron renderer。
- TopBar、左右面板和全局 UI 在任何内容切换期间保持挂载。
- Terminal 保留成熟的 Wave Tab runtime 和多 Terminal Pane 能力。
- Agent UI 与 Agent 执行生命周期完全脱离 Tab、Block 和 Terminal。
- File 路径、Browser URL、Top Tab 顺序和最后选中项可随 workspace 恢复。
- 恢复时只预热最后选中项，其余重资源首次激活时创建。
- Workspace 允许零个 Terminal Tab。
- 为以后新增 Markdown、Settings、Database 等 Top Tab 提供显式扩展点。

### 4.2 非目标

- 本次不把 Terminal 全部迁入单 renderer。
- 本次不重写 Terminal Layout、PTY、controller 或 WPS 协议。
- 本次不迁移旧混合 Tab 或旧 workspace 数据。
- 本次不恢复 Browser DOM、history、媒体、登录页临时状态等页面运行时。
- 本次不持久化未保存 File buffer。
- 本次不重新设计全部键位，只重定向现有 workspace 命令的作用对象。
- 本次不删除右侧工具面板中的 Editor、Browser、Terminal 等独立工具。

## 5. 总体架构

```text
Electron BrowserWindow
|
+-- WorkspaceRenderer (始终在窗口内，完整窗口 bounds)
|   |
|   +-- TopBar
|   |   +-- Files / Agent / Terminal Panel Buttons
|   |   +-- Fixed Agent Entry
|   |   +-- TopTabBar
|   |
|   +-- LeftPanel (single active mode)
|   |   +-- FileExplorer
|   |   +-- AgentSessionsPanel
|   |   +-- TerminalTabList
|   |
|   +-- MainContent
|   |   +-- AgentContent
|   |   +-- FileContent
|   |   +-- BrowserContent
|   |   +-- PreviewContent / DiffContent
|   |   +-- TerminalContentPlaceholder
|   |
|   +-- RightToolPanel
|   +-- StatusBar / Modals / Notifications
|
+-- Active TerminalRenderer (仅 Terminal 激活时覆盖中央内容矩形)
    |
    +-- TerminalApp
        +-- staticTabId
        +-- TabRpcClient
        +-- LayoutModel
        +-- TabContent / TileLayout
        +-- Terminal Blocks
```

`WorkspaceRenderer` 和 `TerminalRenderer` 是同一个 Electron Window 下的同级 `WebContentsView`。

Workspace Renderer 先加入 window content view；活动 Terminal Renderer 后加入并位于它的上方，但其 bounds 只覆盖中央内容区。因此：

- 顶部栏、左侧栏、右侧栏始终由 Workspace Renderer 显示；
- Terminal 激活时只覆盖主内容区的 `TerminalContentPlaceholder`；
- 非 Terminal 内容激活时，所有 Terminal Renderer 都移出可见区域；
- Workspace Renderer 从窗口创建到窗口关闭始终不切换。

## 6. Workspace Renderer

### 6.1 身份与初始化

每个 `WaveWindow` 创建一个 `WorkspaceRenderer`。

Workspace Renderer 初始化参数只包含 workspace/window 身份：

```ts
interface WorkspaceInitOpts {
    clientId: string;
    windowId: string;
    workspaceId: string;
    generation: number;
}
```

Workspace Renderer 不接收 `tabId`，也不创建 `staticTabId`。

Workspace Renderer 使用 workspace-scoped route：

```text
workspace:<workspaceId>
```

Terminal renderer 继续使用：

```text
tab:<terminalTabId>
```

### 6.2 职责

Workspace Renderer 是以下状态和 UI 的唯一 owner：

- `ActiveContent`；
- 左侧 Panel 的 `LeftPanelState`；
- Top Tab 列表、顺序和临时 UI 状态；
- 固定 Agent 入口；
- File Explorer、Agent Session Panel、Terminal 列表；
- TopBar、RightToolPanel、StatusBar；
- workspace-level 快捷命令；
- 全局 modal、toast、搜索和 context menu；
- 中央内容矩形测量。

Workspace Renderer 不负责：

- Terminal PTY/controller；
- Terminal Tab 的 LayoutModel；
- Agent Session Runtime；
- Browser 页面进程本身；
- File 文本的持久化写入。

### 6.3 中央内容 bounds

Workspace Renderer 使用 `ResizeObserver` 测量 `MainContent` 中 Terminal 占位区域的矩形，并通过 typed IPC 发送给 Electron main：

```ts
interface TerminalContentBoundsUpdate {
    windowId: string;
    revision: number;
    bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}
```

更新发生在：

- window resize；
- TopBar/StatusBar 高度变化；
- 左侧面板显示、隐藏或调整宽度；
- 右侧面板显示、隐藏、magnify 或调整宽度；
- fullscreen 变化；
- device scale/zoom 变化。

main 只接受比当前 revision 更新的 bounds，并将矩形限制在 window content bounds 内。空矩形不会显示 Terminal Renderer。

切换到 Terminal 时，main 按以下顺序执行：

1. 获取或初始化目标 `TerminalRenderer`；
2. 将目标 View 设置为最新中央 bounds；
3. 将目标 View 加入正确 z-order；
4. 将旧 Terminal Renderer 移出屏幕；
5. 标记目标可见；
6. 聚焦目标 WebContents。

初始化失败时不允许一个空白 View 覆盖 Workspace Renderer。主内容区的占位区域展示错误与重试操作。

### 6.4 全局 overlay 与 Terminal Renderer 的遮挡

Terminal Renderer 位于 Workspace Renderer 之上时，Workspace DOM 不能直接覆盖 Terminal 矩形。所有会进入中央区域的全局 UI 必须经过统一 `ContentOcclusionController`：

- 普通 TopBar popover、左侧菜单、右侧 panel 和 toast 不与 Terminal bounds 相交，继续由 Workspace Renderer 直接渲染；
- Terminal 内右键菜单使用 Electron native menu，不跨 renderer 绘制；
- command palette、全局 modal、全屏搜索、RightToolPanel magnified overlay 等需要覆盖中央区域时：
  1. 保留 `ActiveContent` 为当前 Terminal；
  2. 设置 `terminalOccluded = true`；
  3. main 将活动 Terminal Renderer 移出可见区域；
  4. Workspace Renderer 在中央占位区域绘制稳定背景并展示 overlay；
  5. overlay 关闭后先恢复 Terminal bounds，再恢复焦点。

首个实现不截取 Terminal 画面作为 modal 背景，以免把 `capturePage` 延迟引入所有 overlay。遮挡期间使用主题背景；后续只有在真实体验证明必要时才增加快照。

`terminalOccluded` 不改变当前选中项，也不参与持久化。它只是两个 renderer 之间的瞬时遮挡状态。

## 7. Terminal Tab

### 7.1 领域约束

由新 Terminal domain/API 创建并管理的 Wave Tab 只表示 Terminal 容器；历史混合 Wave Tab 保留为 legacy，等待后续阶段删除。

允许：

- 一个 Terminal Tab；
- Tab 内一个或多个 Terminal Pane；
- Terminal Pane split、resize、focus、magnify；
- Terminal/TUI/termblocks 等明确属于 Terminal runtime 的 view。

禁止：

- `codeeditor`；
- `web`；
- `preview`；
- `gitdiff`；
- Agent；
- 其他 Top Tab。

所有创建 Block、恢复 Layout 和拖拽入口都必须在数据边界验证该约束，不能只依赖 UI 隐藏。

### 7.2 Workspace 字段语义

实现时将 Workspace 的 Terminal 字段改为显式命名：

```ts
interface WorkspaceTerminalState {
    terminalTabIds: string[];
    activeTerminalTabId: string | null;
}
```

旧的 `workspace.tabids` 和 `workspace.activetabid` 不再承担通用顶层导航语义。开发阶段不提供旧字段 fallback。

backend `waveobj.Tab` 可以继续保留类型名以避免无收益的 Wave core 全量重命名，但它的公开服务和前端模型应使用 `TerminalTab` 语义，例如：

- `CreateTerminalTab`
- `CloseTerminalTab`
- `SetActiveTerminalTab`
- `TerminalTabList`

### 7.3 Terminal renderer

现有 full-app renderer 拆成两个入口：

```text
WorkspaceApp
TerminalApp
```

`TerminalApp` 保留：

- tab-scoped WOS/WPS；
- `staticTabId`；
- Tab RPC client；
- LayoutModel；
- `TabContent` / TileLayout；
- Terminal Block registry；
- Terminal focus、resize 和 controller 逻辑；
- Terminal 内部的 error boundary。

它移除：

- Workspace chrome；
- TopBar/TabBar/VTabBar；
- File Explorer、Session Panel；
- Agent UI；
- RightToolPanel；
- StatusBar、全局通知；
- 非 Terminal ViewModel 注册和初始化。

`wave.ts` 中 Monaco、Top Tab Browser、Agent/NLD UI 等非 Terminal 全局初始化不得在 `TerminalApp` 启动路径执行。

### 7.4 零 Terminal 状态

Workspace 可以没有 Terminal Tab。

关闭最后一个 Terminal Tab 时：

- 不关闭窗口；
- 如果存在 `lastActiveTopTabId`，激活该 Top Tab；
- 否则激活 Agent；
- Terminal Tab 列表展示空态和“New Terminal”入口。

### 7.5 左侧 Panel 与 Terminal List

左侧只有一个 Panel，存在三种互斥模式：

```ts
type LeftPanelMode = "files" | "sessions" | "terminals";

interface LeftPanelState {
    visible: boolean;
    mode: LeftPanelMode;
    width: number;
}
```

切换入口继续放在当前 TopBar：

- 保留现有 Files 和 Agent 按钮；
- 新增 Terminal 按钮；
- 点击非当前模式时，打开 Panel 并切换到对应模式；
- 再次点击当前模式按钮时，收起整个 Panel；
- 三种模式共享同一宽度、resize handle 和持久化状态；
- 收起时保留 `mode`，再次打开回到上次模式；
- TopBar 按钮只控制左侧 Panel，不直接切换主内容；
- 固定 Agent 入口激活 Agent 时，沿用当前行为，将左侧模式切到 `sessions`。

不再保留当前独立的 `vtabVisible`、`fileExplorerVisible` 和 `sessionsPanelVisible` 三组 boolean，也不再把 Vertical Tab 与 File/Session 渲染成两列。

`LeftPanelState` 写入 workspace layout metadata。启动时一次性恢复 `visible`、`mode` 和 `width`，三种模式不分别保存宽度。

Terminal 模式直接复用并专门化现有 `VTabBar` 实现，而不是另写一套纵向列表。实现时将其重命名为 `TerminalTabList`：

保留：

- 现有纵向 Tab 行、搜索和 ControlBar；
- new、select、rename、close；
- 拖拽排序和自动滚动；
- context menu；

替换：

- 数据源从 `workspace.tabids` 改为 `terminalTabIds`；
- active ID 从 renderer `staticTabId` 改为 `activeTerminalTabId`；
- select/close/reorder 改为 Terminal 专属命令；
- 删除 File、Browser、Diff、Agent 类型探测和跨类型逻辑；
- 解除对旧 renderer `WaveEnv` 和 `env.electron.setActiveTab` 的依赖。

Phase 2 首版仅提供 Terminal Tab 薄投影，不提供 Tabs/Panes 显示模式或 Pane detail sidecar。多 Pane、split、focus 和 magnify 能力继续由中央 Terminal Renderer 的 Layout 持有，不在左侧列表重复建模。

点击 Terminal 行时：

```text
TerminalTabList.select(tabId)
  -> set ActiveContent(terminal, tabId)
  -> set activeTerminalTabId = tabId
  -> main 显示对应 Terminal Renderer
```

左侧 Panel 模式和主内容选择是两份状态。用户可以在查看 File/Agent 时保留 Terminal List，也可以在使用 Terminal 时保留 File Explorer。

## 8. 当前内容模型

Workspace 使用一份全局激活状态：

```ts
type ActiveContent =
    | { kind: "agent" }
    | { kind: "terminal"; terminalTabId: string }
    | { kind: "top-tab"; topTabId: string };
```

Top Tab 自身再使用 discriminated union：

```ts
type TopTab =
    | {
          id: string;
          kind: "file";
          path: string;
          title: string;
      }
    | {
          id: string;
          kind: "browser";
          url: string;
          title: string;
      }
    | {
          id: string;
          kind: "preview";
          path: string;
          title: string;
      }
    | {
          id: string;
          kind: "git-diff";
          repoRoot: string;
          oldPath: string;
          newPath: string;
          title: string;
      };
```

Agent 不进入 `TopTab[]`。Terminal 不进入 `TopTab[]`。

Workspace 还保存：

```ts
interface WorkspaceContentState {
    activeContent: ActiveContent;
    topTabs: TopTab[];
    lastActiveTopTabId: string | null;
}
```

Terminal 最后选中项由 `activeTerminalTabId` 保存，不在 Top Tab state 中重复。

### 8.1 激活视觉

Workspace 当前只能选中一项：

- Agent 激活：固定 Agent 入口高亮；Terminal 列表和 Top Tab 没有 active 高亮。
- Terminal 激活：对应 Terminal 列表项高亮；Agent 和 Top Tab 不高亮。
- Top Tab 激活：对应顶部 Tab 高亮；Agent 和 Terminal 列表不高亮。

每组可以记住 last active ID，但 last active 不等于当前 active。

## 9. Top Tab 与生命周期

### 9.1 Runtime owner

Workspace 内的 `TopTabModel` 是当前运行期间的唯一 owner：

- 打开、去重、关闭、排序和激活；
- dirty/process close guard；
- 每类内容的 warm/cold 状态；
- 持久化调度。

backend 只保存可恢复 snapshot，不参与每次视觉切换的同步 round trip。

### 9.2 持久化

Workspace backend 增加 typed `contentState` 字段，保存：

- `TopTab[]` 描述；
- Tab 顺序；
- `ActiveContent`；
- `lastActiveTopTabId`。

Terminal 列表和 `activeTerminalTabId` 继续由 Terminal backend state 保存。

`contentState` 与 Terminal state 都属于同一个 Workspace 持久化对象。选择 Terminal 时，Workspace 在本地同时更新：

```text
activeContent = terminal(tabId)
activeTerminalTabId = tabId
```

两者使用同一个 navigation revision 写入一次 workspace checkpoint，不能通过两个互不关联的 RPC 分别提交。视觉切换不等待 checkpoint 完成。

持久化策略：

- Workspace 启动时读取一次 snapshot；
- 打开、关闭、排序、URL 变化和激活使用本地同步更新；
- 结构变化和 URL 变化通过 debounce 保存完整 snapshot；
- window blur、document hidden 和 app shutdown 时 flush；
- 保存使用单调 revision，旧 revision 不能覆盖新状态；
- 保存失败显示 toast，并保留本地状态供下一次 flush 重试。

恢复策略：

1. 验证所有 descriptor；
2. 无效 descriptor 单独丢弃并记录日志，不阻断 Workspace；
3. `activeContent` 指向不存在对象时，依次 fallback：
   - `lastActiveTopTabId`；
   - `activeTerminalTabId`；
   - Agent；
4. 只 warm 最终选中项；
5. 其他 Top Tab 保持 cold。

恢复内容：

- File 路径；
- Browser 最后 URL；
- Preview/Diff 的可重建资源描述；
- Top Tab 顺序；
- 最后选中项。

不恢复：

- Browser DOM/history/媒体/登录临时状态；
- Monaco DOM、selection、undo stack；
- 未保存 File buffer；
- Diff 计算缓存；
- React 组件实例。

### 9.3 File Tab

File Tab 以 normalized absolute path 去重。

生命周期：

- 首次激活时读取文件并创建 Monaco model；
- 切走时保存 Monaco view state；
- Monaco model 和 dirty buffer 由 workspace-level editor registry 持有；
- File editor 在当前 Workspace renderer session 首次激活后保留到 Tab close；重启只恢复 descriptor 和最后选择，不恢复 editor DOM。
- 再次激活时恢复 model 和 view state；
- 关闭 dirty 文件必须经过 Save / Discard / Cancel guard；
- app close 同样检查 dirty 文件。

虽然未保存 buffer 不跨 app restart 持久化，但正常关闭流程不能静默丢失。

### 9.4 Browser Tab

Browser Tab 以自己的 Top Tab ID 为身份，不按 URL 去重。

生命周期：

- 恢复后的 Browser Tab 为 cold；
- 首次激活时创建 `<webview>`；
- active Browser 永不淘汰；
- 最多保留 5 个 live Browser webview；
- 超过上限时按 LRU 销毁最久未使用的 inactive webview；
- 被淘汰 Tab 保留最后 URL，再次激活时以该 URL 新建页面；
- 切换时使用 CSS visibility/pointer-events 控制，不能因普通切换立即卸载；
- 页面 URL/title 变化更新本地 descriptor，并 debounce 持久化。

### 9.5 Preview 与 Diff

Preview、Git Diff 等可重建 Tab 默认只挂载 active 项：

- 切走后允许卸载；
- descriptor 保存重建所需资源；
- 数据缓存可以放在独立 repository，但不作为 Tab 身份；
- 加载失败只影响当前 Tab，不影响 Workspace。

## 10. Agent

### 10.1 身份

Agent 是 Workspace 中固定导航项：

- 永远可见；
- 不可关闭；
- 不参与排序；
- 不进入 Top Tab；
- 不进入 Terminal Tab；
- 不拥有 Tab ID、Block ID 或 LayoutState。

点击固定入口只执行：

```ts
activeContent = { kind: "agent" };
```

### 10.2 UI 生命周期

`AgentContent` 首次激活后保持挂载，切走时由 `AgentContentSlot` 外层容器切换激活状态；`AgentContent` 根组件不接收 `visible` prop。

保持挂载用于保留：

- composer draft；
- 对话滚动位置；
- picker、展开项等临时 UI；
- assistant-ui 的可见状态。

Agent 的执行连续性不依赖该组件保持挂载。即使 renderer reload，main 中的运行任务仍应继续。

### 10.3 Runtime 生命周期

目标调用链：

```text
AgentContent
  -> AgentRuntimeClient
  -> AgentRuntimeRegistry
  -> AgentSessionRuntime
  -> AgentHarness / tools / session repository
```

`AgentRuntimeRegistry` 按稳定 session identity 管理：

- runtime 创建和复用；
- subscriber acquire/release；
- execution config 同步；
- 后台运行；
- idle eviction；
- app shutdown dispose。

切换到 File、Browser 或 Terminal：

- `AgentContentSlot` wrapper 负责隐藏和取消交互；
- running session 继续执行；
- canonical session event 继续写入 runtime/repository；
- 返回 Agent 后通过 snapshot + subscription 恢复 UI。

### 10.4 Agent Execution Context

Agent 必须在零 Terminal Tab 时也能执行 shell/tool。

执行上下文由 workspace-level provider 显式提供：

```ts
interface AgentExecutionContext {
    workspaceId: string;
    workspaceDir: string;
    sessionPath?: string;
    environment: Record<string, string>;
    gitBranch?: string;
}
```

规则：

- `workspaceDir` 由 workspace 配置决定，`gitBranch` 由 workspace-level provider 提供；
- Agent 自己的 shell/PTY host 归 `AgentSessionRuntime`；
- Terminal connection、命令历史和选中状态不属于 Agent 执行上下文；
- Terminal 创建、切换或关闭不得修改 Agent 状态或 revision；
- Agent 工具不得通过 `staticTabId`、Block meta 或 backing TerminalModel 获取必需上下文。

### 10.5 移除旧 Agent Tab

删除：

- `ensureAgentTab` 和 workspace `agent:tabid`；
- Agent Tab probe/filter；
- hidden Agent backend Tab；
- Agent backing Block；
- Agent 对 `TerminalModel`、TabContext 和 block-scoped tool context 的依赖；
- Agent Tab 的 close/reorder/duplicate/split 语义。

Agent 自己提供：

- New Session；
- Switch Session；
- Rename/Archive/Delete Session；
- Stop Run；
- Session-level model/context 配置。

## 11. 数据流

### 11.1 打开 File

```text
FileExplorer.open(path)
  -> TopTabModel.openFile(path)
  -> normalize + find existing file descriptor
  -> existing: set ActiveContent(top-tab, id)
  -> missing: append cold file descriptor
  -> set ActiveContent(top-tab, id)
  -> FileContent warm/read/model
  -> debounce persist snapshot
```

全程不创建 backend Wave Tab，不调用 Electron `setActiveTab`。

### 11.2 打开 Browser

```text
OpenBrowser(url)
  -> append browser descriptor
  -> activate Top Tab
  -> create or reuse live webview slot
  -> navigation updates descriptor url/title
  -> enforce Browser LRU cap
  -> debounce persist snapshot
```

### 11.3 激活 Terminal

```text
TerminalTabList.select(tabId)
  -> Workspace validates terminalTabId
  -> locally set ActiveContent(terminal, tabId)
  -> locally set activeTerminalTabId = tabId
  -> enqueue one workspace navigation checkpoint
  -> IPC showTerminal(tabId, currentBounds)
  -> main get/create TerminalRenderer
  -> initialize/wave-ready if cold
  -> position target before hiding old view
  -> focus target
```

### 11.4 激活 Agent

```text
FixedAgentEntry.select()
  -> set ActiveContent(agent)
  -> IPC hideActiveTerminal()
  -> show existing AgentContent
  -> acquire/subscribe active Agent session
  -> persist active content
```

### 11.5 Agent 后台运行

```text
Agent session A running
  -> user selects File
  -> AgentContent hidden
  -> AgentRuntimeRegistry keeps A
  -> events continue to runtime/repository
  -> user returns Agent
  -> snapshot A + subscribe
```

## 12. 命令、焦点与关闭语义

### 12.1 Workspace command router

当前 workspace 导航快捷键分散在每个 tab renderer。新架构增加 window-level `WorkspaceCommandRouter`：

- Workspace 是 workspace navigation command 的 owner；
- Terminal renderer 只处理 Terminal-local 命令；
- 从 Terminal renderer 触发的 workspace 命令通过 preload IPC 转发给 Workspace；
- main 根据 windowId 将命令发送给唯一 Workspace；
- Workspace 根据 `ActiveContent` 决定作用对象。

### 12.2 `Close Active`

- Agent active：不关闭 Agent，不删除 Session；命令无操作并保留窗口。
- Top Tab active：执行对应 Top Tab close guard，然后关闭该 Tab。
- Terminal active：执行 Terminal process/close guard，然后关闭 Terminal Tab。
- 关闭 window 使用独立 window close 命令。

### 12.3 Focus

- 点击 TopBar、左侧栏或右侧栏：焦点回 Workspace。
- 点击 Terminal 中央区域：焦点进入活动 Terminal WebContents。
- Top Tab/Agent 激活后：main 隐藏 Terminal Renderer，Workspace Renderer 恢复焦点。
- Browser Tab 激活后：Workspace Renderer 将焦点交给 active guest webview。
- 任何隐藏内容必须禁用 pointer events。
- 全局 overlay 打开时暂时遮挡 Terminal；关闭后按打开 overlay 前的焦点 owner 恢复焦点。

Terminal Renderer 的 10ms/30ms focus retry 不再承担 workspace chrome 的焦点恢复；仅用于 Terminal 自身。

## 13. 错误处理

### 13.1 Workspace Renderer 初始化失败

- BrowserWindow 保持背景色；
- 展示独立的 Workspace fatal-error fallback；
- 提供 reload window；
- 不自动销毁 Terminal runtime 或 Agent runtime。

### 13.2 Terminal cold init 失败

- 失败 View 不覆盖中央区域；
- Workspace 展示 Terminal 错误占位区域；
- 用户可 Retry 或 Close Terminal；
- 其他 Top Tab 和 Agent 仍可使用。

### 13.3 Top Tab snapshot 损坏

- 每个 descriptor 独立校验；
- 丢弃非法项并记录结构化日志；
- 使用 fallback 规则选择当前内容；
- 不因单个坏 URL/path 阻断 Workspace。

### 13.4 File 不存在或读取失败

- 保留 Tab 和 path；
- File Tab 展示 missing/read error；
- 允许 Retry、Close、Locate；
- 不静默移除，以免恢复后 Tab 顺序发生不可解释变化。

### 13.5 Agent context 或 runtime 失败

- 错误归属当前 Session；
- Agent 可切换到其他 Session；
- Workspace 和 Terminal 不受影响；
- preferred Terminal 不存在时自动清除可选关联，不影响执行。

## 14. 性能与资源约束

### 14.1 必须满足

- 每个 window 恰好一个 `WorkspaceRenderer`。
- Agent/File/Browser/Preview/Diff 激活不创建或 reposition 顶层 Terminal Renderer。
- 非 Terminal 切换不发送 `wave-init`。
- 没有 hidden Agent WaveTabView。
- Terminal renderer 不加载 Monaco、Browser UI 和 Agent UI。
- 恢复时只有当前内容 warm。
- live Browser webview 不超过 5 个。

### 14.2 观测指标

实现前后记录：

- warm/cold 内容切换 p50/p95；
- Workspace 首次可交互时间；
- Terminal cold `wave-ready` 时间；
- renderer/WebContentsView 数量；
- 1/5/10 个 File 或 Browser Tab 下的 RSS；

以上长期 p50/p95、RSS 指标和 Electron manual smoke 均为 pending；当前自动化 tracing 与单元测试不构成这些验收项已完成的声明。
- nested webview 创建和 LRU eviction 次数；
- Terminal bounds update 到首个合成帧的时间；
- focus retry、空白帧和 guest reload 事件。

## 15. 测试策略

### 15.1 Backend

- Workspace content snapshot 序列化、校验和 revision。
- Terminal tab 列表只接受 Terminal Tab。
- 向 Terminal Tab 创建非 Terminal Block 时拒绝。
- 关闭最后一个 Terminal Tab 不关闭 Workspace/window。
- 当前内容 fallback 顺序。
- Agent execution context 在零 Terminal Tab 时可创建。

### 15.2 Electron main

- 一个 window 只创建一个 Workspace Renderer。
- Workspace Renderer ID 在 Agent/File/Browser/Terminal 切换期间不变。
- Terminal Renderer bounds 只覆盖 Workspace 报告的中央矩形。
- stale bounds revision 被忽略。
- 非 Terminal 激活时所有 Terminal Renderer offscreen。
- Terminal cold init 失败不会覆盖 Workspace。
- Terminal Renderer z-order、切换顺序和 focus 正确。
- 打开中央全局 overlay 时 Terminal 暂时隐藏，关闭后恢复同一 View 和焦点。

### 15.3 Workspace Renderer

- `ActiveContent` 三分支只有一个 active。
- `LeftPanelState.mode` 只有 `files`、`sessions`、`terminals` 之一。
- TopBar 的 Files、Agent、Terminal 按钮能打开、切换和收起同一个左侧 Panel。
- 三种左侧模式共享宽度，并从 workspace layout metadata 恢复。
- `TerminalTabList` 保留搜索、拖拽排序和 Terminal Tab 操作，不渲染 Pane detail sidecar。
- `TerminalTabList` 不读取非 Terminal Tab，也不调用旧 `setActiveTab`。
- Agent 固定入口不进入 Top Tab 排序/关闭。
- File path 去重。
- Top Tab reorder 与 snapshot restore。
- invalid persisted active ID fallback。
- cold restore 只 warm 当前内容。
- `Close Active` 按当前内容类型分发。
- 从 Terminal IPC 转发的 workspace command 正确执行。

### 15.4 File

- Monaco model/view state 在普通切换后恢复。
- dirty close 提供 Save/Discard/Cancel。
- app close 检查 dirty file。
- 文件缺失显示错误但保留 Tab。

### 15.5 Browser

- 普通切换不重建 live webview。
- live webview 上限为 5。
- LRU 只淘汰 inactive Browser。
- 淘汰后重新激活使用最后 URL 创建新页面。
- 重启只恢复 URL，不恢复页面运行时。

### 15.6 Agent

- 没有创建 Agent backend Tab 或 Block。
- 零 Terminal Tab 时 Agent send/tool 正常。
- Agent 切走后 running session 继续。
- 返回 Agent 后 snapshot/subscription 恢复。
- preferred Terminal 被关闭后 Agent 继续执行。
- Agent entry 不响应 Tab close/reorder。

### 15.7 手工验证

- TopBar 的 Files、Agent、Terminal 按钮切换同一个左侧 Panel，不会同时渲染两种 Panel 内容。
- 连续切换 Agent、多个 File 和 Browser，TopBar/LeftPanel 不闪烁、不重置。
- Terminal 激活时 chrome 保持稳定，只有中央内容变化。
- resize 左右面板时 Terminal Renderer 紧贴中央区域，无缝隙和覆盖。
- Terminal 与 Browser guest 来回切换后焦点、输入法和快捷键正常。
- 重启 workspace 后恢复 File、Browser URL、顺序和最后选中项。
- 关闭全部 Terminal 后仍可使用 Agent/File/Browser。

## 16. 实施分解

本设计作为一份总架构，实施拆成四个可独立验收的子项目。

### Phase 1：Workspace Renderer 与当前内容模型

状态：complete。

- 新增 `WorkspaceRenderer` 和 `WorkspaceApp`；
- 新增 `ActiveContent`、Top Tab model 和 snapshot 持久化；
- Workspace 接管 TopBar、左右面板、全局 UI；
- 暂时用 Terminal 占位区域验证 Workspace 生命周期；
- 建立 window-level WorkspaceCommandRouter。

实际实现名称：

- checkpoint RPC：`WorkspaceService.SaveWorkspaceCheckpoint(SaveWorkspaceCheckpointData)`；
- Workspace route：`makeWorkspaceRouteId(workspaceId)`，生成 `workspace:<workspaceId>`；
- renderer 初始化：preload `onWorkspaceInit` 接收 `workspace-init`，前端入口为 `initWorkspace`；
- renderer 初始化参数：`WorkspaceInitOpts`，使用 `generation` 隔离过期 ready/init 状态。

验收：Agent/File/Browser 的轻量 mock 可在同一 Workspace 内切换，Workspace Renderer ID 不变。

### Phase 2：Terminal Renderer

自动化实现与边界验证已完成；需按本文验收项完成 Electron runtime smoke 后再标记 Phase 2 complete。

- 拆出 `TerminalApp`；
- `WaveTabView` 收敛为 Terminal-only；
- 实现中央 bounds IPC、z-order、focus 和 cold-init fallback；
- Workspace Tab 数据收敛为 Terminal-only；
- 将左侧 Panel 收敛为 Files/Sessions/Terminals 三种互斥模式；
- 将现有 `VTabBar` 专门化为 `TerminalTabList`，并接入 TopBar Terminal 按钮；
- 禁止非 Terminal Block 进入 Terminal Layout。

验收：多 Terminal Pane 能力保持；Terminal 与 Workspace 内非 Terminal 内容可稳定互切。

### Phase 3：Agent 完全去 Tab/Block 化

- 当前状态：已实现。Agent 由 Workspace renderer 固定承载，session/model 状态归 `WorkspaceAgentModel` 与 Workspace `agentstate/agentrevision` 管理；legacy `view:"agent"` Tab/Block 创建、注册、探测和默认入口已 hard cut。
- 将固定 Agent UI 移入 Workspace；
- 完成 AgentContent 与 RuntimeRegistry 接线；
- 新增 workspace-level AgentExecutionContext；
- 移除 hidden Agent Tab、backing Block 和 TerminalModel 依赖；
- 验证零 Terminal Agent 执行。

验收：Agent 后台任务与任何 Tab/Block 生命周期无关。

### Phase 4：Top Tab 生产化与旧路径删除

- 当前状态：File、Preview、Git Diff 已迁入生产 Top Tab model，并完成自动化 cutover gate；Electron runtime smoke 仍待人工验收。
- File 已使用 Workspace-owned Monaco model/view-state owner；持久化只包含路径、顺序和选择，不包含 dirty buffer 或 view state。
- Preview 与 Git Diff 使用 active-only 可重建 runtime，切离时卸载，重新激活时重载。
- File Explorer、Preview 和 Diff 打开入口已改走 Workspace Top Tab controller；旧非 Terminal Wave Tab/Block/LayoutState 路径已删除。
- development-only tracing 已覆盖 `top-tab-open`、`top-tab-activate`、`top-tab-first-content` 与 `workspace-checkpoint-error`，仅记录 kind、opaque ID 和 duration。
- Browser Top Tab 与 Browser LRU 延后；URL launcher 继续打开右侧 Browser tool，不创建 Top Tab 或 Wave Tab。本文中的长期 Browser Top Tab/LRU 要求尚未完成。

验收：主内容区不存在任何非 Terminal Wave Tab，重启恢复和资源上限符合本设计。

## 17. 完成标准

同时满足以下条件才认为重构完成：

1. Wave Tab 数据中只存在 Terminal Tab。
2. Terminal Layout 中只存在 Terminal-compatible Block。
3. Agent 没有 backend Tab、Block 或 `staticTabId`。
4. File/Browser/Preview/Diff 不调用 `CreateTabWithBlock` 或 Electron `setActiveTab`。
5. TopBar、LeftPanel、RightToolPanel 只由唯一 Workspace Renderer 渲染。
6. Terminal renderer 只渲染中央 Terminal 内容。
7. Workspace 可在零 Terminal 状态下正常运行。
8. File 路径、Browser URL、Top Tab 顺序和最后选中项可恢复。
9. Browser 页面运行时不承诺跨重启恢复。
10. 非 Terminal 内容切换不会发生顶层 WebContentsView 交换。
11. Agent 可在零 Terminal 状态下独立执行 shell/tool。
12. 所有自动化测试和手工焦点/resize/恢复验证通过。
