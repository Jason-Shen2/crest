# 前端架构

## 总览

`frontend/` 是 Electron renderer 层，使用 React 19、TypeScript、Jotai、Tailwind v4 和 Vite。它负责：

- 启动 renderer 并等待 preload 初始化。
- 管理 workspace、tab、block 和 view。
- 渲染终端 block stream、命令块、preview、webview、vdom、配置等视图。
- 通过 `wshrpc`、WPS、HTTP service 和 ElectronApi 与后端/main 进程交互。

## 目录结构

| 路径 | 职责 |
| --- | --- |
| `frontend/wave.ts` | Renderer bootstrap 入口。 |
| `frontend/app/app.tsx` | React 应用根组件。 |
| `frontend/app/workspace/` | 顶层工作区 UI、侧栏、code review 面板、toast。 |
| `frontend/app/tab/` | Tab bar、tab 内容、tab model、tab 右键菜单。 |
| `frontend/layout/` | 通用 tile layout 系统。 |
| `frontend/app/block/` | Block frame、block model、view registry。 |
| `frontend/app/view/` | 各类业务 view。 |
| `frontend/app/term/` | 新终端引擎、模型、渲染。 |
| `frontend/app/store/` | Jotai 全局 store、WOS、WPS、wshrpc client/router。 |
| `frontend/app/element/` | 通用 UI 元素。 |
| `frontend/app/theme/` | 主题模型和颜色处理。 |
| `frontend/types/` | 全局类型声明和生成类型。 |
| `frontend/util/` | 通用工具函数。 |
| `frontend/preview/` | 独立组件预览服务。 |
| `frontend/builder/` | Builder 窗口 UI。 |

## 启动入口

关键文件：

- `frontend/wave.ts`
- `frontend/app/app.tsx`

启动流程：

1. `initBare()` 注册 `window.api.onWaveInit()` 和 `window.api.onBuilderInit()`。
2. 设置字体、缩放、窗口 ready 状态。
3. `initWave()` 初始化 `GlobalModel`、全局 atoms、wshrpc、WPS、连接状态、badge、client/window/tab 对象。
4. 创建 React root，渲染 `App`。
5. `App` 注入 Jotai `Provider`、`WaveEnvContext`、`TabModelContext`，再挂载 `Workspace`。

核心函数：

- `initBare()` in `frontend/wave.ts`
- `initWave()` in `frontend/wave.ts`
- `reinitWave()` in `frontend/wave.ts`
- `App()` in `frontend/app/app.tsx`
- `AppSettingsUpdater()` in `frontend/app/app.tsx`

## 状态管理

### Jotai store

全局 Jotai store 定义在：

- `frontend/app/store/jotaiStore.ts`

核心模式：

- 使用 `globalStore = createStore()` 作为统一 store。
- React 组件通过 `useAtomValue()` / `useAtom()` 订阅。
- 非 React model 通过 `globalStore.get()` / `globalStore.set()` 读写 atom。
- 模型通常把 atoms 放在 class 字段或 constructor 中。

### GlobalModel

关键文件：

- `frontend/app/store/global-model.ts`
- `frontend/app/store/global.ts`

职责：

- 持有 `windowId`、`builderId`、平台和环境信息。
- 派生 `windowDataAtom`、`workspaceAtom`。
- 暴露全局配置、block/tab/meta atom 缓存。

常用函数：

- `getApi()`：获取 preload 暴露的 ElectronApi。
- `getSettingsKeyAtom()` / `useSettingsKeyAtom()`：读取配置 key。
- `getBlockMetaKeyAtom()`：按 block + meta key 缓存 atom。
- `getOrefMetaKeyAtom()` / `useOrefMetaKeyAtom()`：按 ORef 读取 meta。

### WaveObjectStore

关键文件：

- `frontend/app/store/wos.ts`

职责：

- 按 `otype:oid` 缓存后端 WaveObj。
- 将后端对象 atom 化。
- 通过 `/wave/service` 调用后端 service。
- 接收 service return 中的 `updates` 并写回前端对象缓存。

关键函数：

- `makeORef()`
- `loadWaveObject()`
- `getWaveObjectAtom()`
- `callBackendService()`

### Wave PubSub

关键文件：

- `frontend/app/store/wps.ts`

职责：

- 维护 event type/scope 订阅。
- 重连后自动恢复订阅。
- 接收后端 WPS 事件并分发到前端 listener。

关键函数：

- `waveEventSubscribeSingle()`
- `waveEventUnsubscribe()`
- `handleWaveEvent()`

## Workspace / Tab / Layout

### Workspace

关键文件：

- `frontend/app/workspace/workspace.tsx`
- `frontend/app/workspace/workspace-layout-model.ts`

职责：

- 组合 `TopBar`、`TabBar` / `VTabBar`、文件树、`TabContent`、code review 侧栏、modal、toast。
- 维护窗口级面板 visibility 和宽度。
- 将部分布局状态通过 `RpcApi.SetMetaCommand` 持久化。

关键类/组件：

- `WorkspaceElem`
- `WorkspaceLayoutModel`

### TabContent

关键文件：

- `frontend/app/tab/tabcontent.tsx`

职责：

- 读取当前 tab WaveObj。
- 将 tab layout state 传入 `TileLayout`。
- 为每个 leaf node 渲染一个 `Block`。
- 关闭 node 时调用 `ObjectService.DeleteBlock()`。

### TileLayout

关键文件：

- `frontend/layout/lib/TileLayout.tsx`
- `frontend/layout/lib/layoutModel.ts`
- `frontend/layout/lib/layoutTree.ts`
- `frontend/layout/lib/layoutNode.ts`
- `frontend/layout/lib/layoutModelHooks.ts`

职责：

- 管理 tab 内多 block 的 tile tree。
- 支持拖拽、resize、focus、magnify、ephemeral node、overlay node。
- 保持布局和业务视图解耦，只通过 render callback 渲染 leaf 内容。

关键类/函数：

- `TileLayoutComponent`
- `LayoutModel`
- `useTileLayout()`
- `useNodeModel()`

## Block / View 系统

### ViewModel 协议

类型定义：

- `frontend/types/custom.d.ts`

`ViewModel` 描述一个 view 的能力：

- `viewType`
- icon/name/header
- search atoms
- focus / keydown
- dispose
- `viewComponent`

### BlockRegistry

关键文件：

- `frontend/app/block/blockregistry.ts`

职责：

- 将 block meta 中的 `view` 映射到 ViewModel class。
- 未知 view fallback 到默认模型。

当前注册的典型 view：

- `term`
- `preview`
- `web`
- `sysinfo`
- `vdom`
- `tips`
- `help`
- `launcher`
- `waveconfig`
- `processviewer`
- `termblocks`
- `tsunami`

关键函数：

- `BlockRegistry.registerViewModel()`
- `makeViewModel()`

### Block 渲染

关键文件：

- `frontend/app/block/block.tsx`
- `frontend/app/block/blockframe.tsx`
- `frontend/app/block/block-model.ts`
- `frontend/app/block/blocktypes.ts`

职责：

- 根据 block 对象创建 ViewModel。
- 渲染 full/preview/subblock 三种形态。
- 处理 focus、mouse enter、focus-follows-cursor、block 尺寸修正。
- 用 `BlockFrame` 包裹实际 view component。

关键组件/函数：

- `BlockFull`
- `BlockPreview`
- `BlockSubBlock`
- `getViewElem()`

## 主要 View

| View | 路径 | 职责 |
| --- | --- | --- |
| `term` | `frontend/app/view/term/` | 兼容旧 BlockRegistry 的终端 view，实际渲染委托给新 `TerminalView`。 |
| `termblocks` | `frontend/app/view/termblocks/` | 兼容 command block timeline 的终端 view。 |
| `preview` | `frontend/app/view/preview/` | 文件、Markdown、CSV、目录、流式内容预览与编辑入口。 |
| `web` | `frontend/app/view/webview/` | 内嵌 WebView。 |
| `vdom` | `frontend/app/view/vdom/` | 渲染 Go/VDOM 产物。 |
| `waveconfig` | `frontend/app/view/waveconfig/` | 设置与 secret 配置 UI。 |
| `sysinfo` | `frontend/app/view/sysinfo/` | 系统信息/CPU 等视图。 |
| `processviewer` | `frontend/app/view/processviewer/` | 进程列表视图。 |
| `launcher` | `frontend/app/view/launcher/` | 启动器视图。 |
| `tsunami` | `frontend/app/view/tsunami/` | Tsunami app bridge。 |
| `codeeditor` | `frontend/app/view/codeeditor/` | 编辑器和 diff viewer。 |

## 终端系统

### 分层

新终端系统位于：

- `frontend/app/term/`

兼容旧 view 的适配层位于：

- `frontend/app/view/term/term-model.tsx`
- `frontend/app/view/termblocks/termblocks.tsx`

职责分层：

```text
TermViewModel / TermBlocksViewModel
  -> TerminalView
  -> TerminalModel
  -> Blocks + AnsiParser + BlockHandler
  -> render components
```

### TerminalModel

关键文件：

- `frontend/app/term/terminal-model.ts`

职责：

- 管理一个终端 pane 的核心状态。
- 创建 `Blocks`、`AnsiParser`、`BlockHandler`、`TerminalContext`。
- 订阅 WPS/后端事件。
- 维护 selection、find、palette、bell、notification、history、agent marker。
- 用 `revisionAtom` 驱动 React 重新拉取 mutable block snapshot。

关键字段/atoms：

- `revisionAtom`
- `selectedBlockIdAtom`
- `scrollPositionAtom`
- `selectionAtom`
- find 相关 atoms
- `titleAtom`
- `notificationAtom`
- `paletteAtom`
- `bellAtom`
- agent run/session 相关 atoms

### 终端引擎

关键目录：

- `frontend/app/term/engine/`

主要类型：

- `Grid`
- `BlockGrid`
- `HeaderGrid`
- `AltScreen`
- `Block`
- `Blocks`
- `AnsiParser`
- `BlockHandler`

`BlockHandler` 处理 ANSI/VT/xterm 序列，并通过 `TerminalContext` 回调宿主模型执行：

- 写 PTY。
- 设置 title。
- 触发 notification。
- 更新 palette。
- 响铃。

### 终端渲染

关键目录：

- `frontend/app/term/render/`

关键组件：

- `TerminalView`
- `BlockListElement`
- block/grid/header/input/find/palette 相关组件。

渲染链路：

```text
TerminalView
  -> useTerminalModel()
  -> model.revisionAtom changes
  -> BlockListElement obtains blocks snapshot
  -> render terminal blocks and agent blocks
```

## 前端 RPC 与服务调用

### wshrpc

关键文件：

- `frontend/app/store/wshclient.ts`
- `frontend/app/store/wshclientapi.ts`
- `frontend/app/store/wshrouter.ts`
- `frontend/app/store/wshrpcutil.ts`

`wshclientapi.ts` 是生成文件，来源是 Go `pkg/wshrpc/wshrpctypes.go`。

### HTTP service

关键文件：

- `frontend/app/store/wos.ts`
- `pkg/service/service.go`
- `pkg/web/web.go`

前端通过 `callBackendService()` 请求 `/wave/service`，后端按 service/method 反射调用注册 service，并返回：

- `success`
- `error`
- `data`
- `updates`

## WaveEnv

关键文件：

- `frontend/app/waveenv/waveenv.ts`
- `frontend/app/waveenv/waveenvimpl.ts`

`WaveEnv` 用于把环境依赖注入组件树，便于 preview/test server 或 mock 环境复用 UI。

## Preview 系统

关键目录：

- `frontend/preview/`

用途：

- 启动独立 Vite preview server。
- 无 Electron 和 Go 后端时预览组件。
- 配合 mock `WaveEnv` 调试 UI。

运行命令：

```bash
task preview
```

默认端口：

```text
7007
```

## 前端扩展入口

### 新增 view

通常涉及：

- 新建 `frontend/app/view/<name>/`。
- 实现符合 `ViewModel` 协议的 model。
- 在 `frontend/app/block/blockregistry.ts` 注册。
- 如需后端数据，新增 service 或 wshrpc。

### 新增配置项

通常涉及：

- `pkg/wconfig/`
- `schema/settings.json`
- 前端 `getSettingsKeyAtom()` 使用点。
- 可能需要运行 schema/code generation。

### 新增 wshrpc

通常涉及：

- `pkg/wshrpc/wshrpctypes.go`
- `pkg/wshrpc/wshserver/wshserver.go`
- `task generate`
- 前端调用生成的 `RpcApi.*Command()`。

## 常见风险点

- React hooks 必须在组件顶层调用，不能在 JSX 内联调用。
- `frontend/types/gotypes.d.ts` 和 `frontend/app/store/wshclientapi.ts` 是生成文件，不要手改。
- Jotai atoms 若需要写入，应明确为可写 atom 类型。
- `TileLayout` 与业务 view 解耦，不应把终端或业务逻辑塞进 layout 层。
- `TerminalModel` 使用 mutable blocks + `revisionAtom` 驱动渲染，修改终端数据时要保证 revision 更新。
