# 模块索引与阅读路线

## 快速定位表

| 需求 | 优先阅读 |
| --- | --- |
| 理解启动流程 | `emain/emain.ts`、`emain/emain-wavesrv.ts`、`cmd/server/main-server.go` |
| 理解 UI 入口 | `frontend/wave.ts`、`frontend/app/app.tsx`、`frontend/app/workspace/workspace.tsx` |
| 理解布局系统 | `frontend/layout/lib/layoutModel.ts`、`frontend/layout/lib/TileLayout.tsx` |
| 理解 Block/View | `frontend/app/block/block.tsx`、`frontend/app/block/blockregistry.ts`、`frontend/types/custom.d.ts` |
| 理解终端渲染 | `frontend/app/term/terminal-model.ts`、`frontend/app/term/engine/`、`frontend/app/term/render/` |
| 理解对象存储 | `pkg/waveobj/waveobj.go`、`pkg/wstore/wstore_dbops.go` |
| 理解 RPC | `pkg/wshrpc/wshrpctypes.go`、`pkg/wshrpc/wshserver/wshserver.go`、`pkg/wshutil/wshrouter.go` |
| 理解事件 | `pkg/wps/wps.go`、`pkg/wps/wpstypes.go`、`frontend/app/store/wps.ts` |
| 理解 HTTP service | `pkg/web/web.go`、`pkg/service/service.go`、`frontend/app/store/wos.ts` |
| 理解 AI provider | `emain/ai/api-registry.ts`、`emain/ai/stream.ts`、`emain/ai/providers/` |
| 理解 Agent | `emain/agent/agent-loop.ts`、`emain/agent/pane-agent-session.ts`、`emain/agent/harness/agent-harness.ts` |
| 理解构建 | `Taskfile.yml`、`package.json`、`electron.vite.config.ts`、`electron-builder.config.cjs` |

## 顶层入口索引

### Renderer

- `frontend/wave.ts`
  - `initBare()`
  - `initWave()`
  - `reinitWave()`
- `frontend/app/app.tsx`
  - `App()`
  - `AppSettingsUpdater()`
  - context menu handling

### Electron main

- `emain/emain.ts`
  - app main lifecycle
- `emain/emain-wavesrv.ts`
  - `wavesrv` child process startup
- `emain/preload.ts`
  - ElectronApi expose
- `emain/emain-ipc.ts`
  - IPC registration

### Go backend

- `cmd/server/main-server.go`
  - `main()`
  - `createMainWshClient()`
  - `grabAndRemoveEnvVars()`
  - `doShutdown()`
- `cmd/wsh/main-wsh.go`
  - `wsh` CLI entry

## 前端模块索引

### Store

| 文件 | 关键符号 | 说明 |
| --- | --- | --- |
| `frontend/app/store/jotaiStore.ts` | `globalStore` | 全局 Jotai store。 |
| `frontend/app/store/global-model.ts` | `GlobalModel` | 全局窗口、workspace、client 相关 model。 |
| `frontend/app/store/global.ts` | `getApi()`、`getSettingsKeyAtom()`、`getBlockMetaKeyAtom()` | 全局 atoms、配置、meta、服务入口。 |
| `frontend/app/store/wos.ts` | `callBackendService()`、`makeORef()` | WaveObjectStore 和 HTTP service 调用。 |
| `frontend/app/store/wps.ts` | `waveEventSubscribeSingle()`、`handleWaveEvent()` | WPS 订阅与分发。 |
| `frontend/app/store/wshclient.ts` | wshrpc client setup | 前端 RPC client。 |
| `frontend/app/store/wshclientapi.ts` | `RpcApi.*Command()` | 生成的 TS RPC API。 |

### Workspace / Tab / Layout

| 文件 | 关键符号 | 说明 |
| --- | --- | --- |
| `frontend/app/workspace/workspace.tsx` | `WorkspaceElem` | 主工作区 UI。 |
| `frontend/app/workspace/workspace-layout-model.ts` | `WorkspaceLayoutModel` | 侧栏/code review 面板状态。 |
| `frontend/app/tab/tabcontent.tsx` | `TabContent` | 当前 tab 内容和 TileLayout 连接。 |
| `frontend/app/tab/tabbar.tsx` | `TabBar` | 横向 tab bar。 |
| `frontend/app/tab/vtabbar.tsx` | `VTabBar` | 纵向 tab bar。 |
| `frontend/layout/lib/TileLayout.tsx` | `TileLayoutComponent` | 通用 tile layout React 组件。 |
| `frontend/layout/lib/layoutModel.ts` | `LayoutModel` | 布局树、拖拽、resize、focus 状态。 |
| `frontend/layout/lib/layoutTree.ts` | layout tree helpers | 布局树操作。 |
| `frontend/layout/lib/layoutNode.ts` | node model | 单个 layout node model。 |

### Block / View

| 文件 | 关键符号 | 说明 |
| --- | --- | --- |
| `frontend/app/block/block.tsx` | `BlockFull`、`BlockPreview`、`getViewElem()` | Block 渲染入口。 |
| `frontend/app/block/blockregistry.ts` | `BlockRegistry`、`makeViewModel()` | View registry。 |
| `frontend/app/block/blockframe.tsx` | `BlockFrame` | Block 外框/header。 |
| `frontend/app/block/block-model.ts` | block model | Block 状态模型。 |
| `frontend/types/custom.d.ts` | `ViewModel`、`ElectronApi` | 关键前端全局类型。 |

### Terminal

| 文件 | 关键符号 | 说明 |
| --- | --- | --- |
| `frontend/app/view/term/term-model.tsx` | `TermViewModel` | legacy view adapter。 |
| `frontend/app/view/termblocks/termblocks.tsx` | `TermBlocksViewModel` | termblocks adapter。 |
| `frontend/app/term/terminal-model.ts` | `TerminalModel` | 终端 pane orchestrator。 |
| `frontend/app/term/engine/index.ts` | engine exports | Grid/Blocks/AnsiParser/BlockHandler。 |
| `frontend/app/term/engine/handler.ts` | `BlockHandler` | ANSI/VT 序列处理。 |
| `frontend/app/term/render/terminal-view.tsx` | `TerminalView` | 终端顶层 React 视图。 |
| `frontend/app/term/render/block-list-element.tsx` | `BlockListElement` | 终端 block list 渲染。 |

### Views

| View | 路径 |
| --- | --- |
| terminal | `frontend/app/view/term/` |
| termblocks | `frontend/app/view/termblocks/` |
| preview | `frontend/app/view/preview/` |
| webview | `frontend/app/view/webview/` |
| vdom | `frontend/app/view/vdom/` |
| waveconfig | `frontend/app/view/waveconfig/` |
| sysinfo | `frontend/app/view/sysinfo/` |
| processviewer | `frontend/app/view/processviewer/` |
| launcher | `frontend/app/view/launcher/` |
| help | `frontend/app/view/helpview/` |
| quicktips | `frontend/app/view/quicktipsview/` |
| codeeditor | `frontend/app/view/codeeditor/` |
| tsunami | `frontend/app/view/tsunami/` |

## 后端模块索引

### 对象与存储

| 文件 | 关键符号 | 说明 |
| --- | --- | --- |
| `pkg/waveobj/waveobj.go` | `WaveObj`、`ORef`、`RegisterType()` | 对象协议。 |
| `pkg/waveobj/metamap.go` | `MetaMapType` | meta 读写工具。 |
| `pkg/wstore/wstore_dbsetup.go` | `InitWStore()`、`WithTx()` | DB 初始化与事务。 |
| `pkg/wstore/wstore_dbops.go` | `DBGetORef()`、`DBInsert()`、`DBUpdate()` | WaveObj CRUD。 |
| `pkg/wstore/wstore_rtinfo.go` | `GetRTInfo()`、`SetRTInfo()` | runtime info。 |

### Core

| 文件 | 关键符号 | 说明 |
| --- | --- | --- |
| `pkg/wcore/wcore.go` | `EnsureInitialData()`、`InitMainServer()`、`SendWaveObjUpdate()` | 应用核心协调。 |
| `pkg/wcore/workspace.go` | workspace funcs | Workspace 创建/更新。 |
| `pkg/wcore/window.go` | window funcs | Window 创建/管理。 |
| `pkg/wcore/tab.go` | tab funcs | Tab 创建/更新。 |
| `pkg/wcore/block.go` | block funcs | Block 创建/删除。 |

### RPC / Event / Web

| 文件 | 关键符号 | 说明 |
| --- | --- | --- |
| `pkg/wshrpc/wshrpctypes.go` | `WshRpcInterface` | RPC contract。 |
| `pkg/wshrpc/wshserver/wshserver.go` | `WshServer` | 主 RPC 实现。 |
| `pkg/wshrpc/wshclient/wshclient.go` | client helpers | Go RPC client。 |
| `pkg/wshrpc/wshremote/wshremote.go` | remote impl | remote RPC 实现。 |
| `pkg/wshutil/wshrouter.go` | `WshRouter` | RPC route switch。 |
| `pkg/wps/wps.go` | `Broker` | PubSub broker。 |
| `pkg/wps/wpstypes.go` | event constants | 事件类型。 |
| `pkg/web/web.go` | `RunWebServer()` | HTTP server。 |
| `pkg/web/ws.go` | `RunWebSocketServer()`、`HandleWsInternal()` | WebSocket RPC transport。 |
| `pkg/service/service.go` | `ServiceMap`、`CallService()` | `/wave/service` 反射调用。 |

### Terminal / Command / Job

| 文件 | 关键符号 | 说明 |
| --- | --- | --- |
| `pkg/blockcontroller/blockcontroller.go` | `Controller`、`ResyncController()` | Block controller registry。 |
| `pkg/blockcontroller/shellcontroller.go` | shell controller | Shell PTY 控制。 |
| `pkg/blockcontroller/durableshellcontroller.go` | durable shell | Durable shell 控制。 |
| `pkg/cmdblock/tracker.go` | `Tracker.OnBytes()` | PTY 字节流命令块追踪。 |
| `pkg/cmdblock/parser.go` | `Parser.Feed()` | OSC 16162 parser。 |
| `pkg/cmdblock/store.go` | `MakePromptStarted()`、`MarkCommandDone()` | cmdblock DB 操作。 |
| `pkg/jobcontroller/jobcontroller.go` | job controller | 主服务 job 管理。 |
| `pkg/jobmanager/jobmanager.go` | `JobManager`、`SetupJobManager()` | job 进程 manager。 |

### Remote / Config / File

| 文件 | 关键符号 | 说明 |
| --- | --- | --- |
| `pkg/remote/conncontroller/conncontroller.go` | conn controller | SSH/remote 连接控制。 |
| `pkg/remote/sshclient.go` | SSH client | SSH 客户端。 |
| `pkg/remote/fileshare/wshfs/wshfs.go` | wshfs | 远程文件分享。 |
| `pkg/wslconn/wslconn.go` | WSL conn | WSL connection。 |
| `pkg/filestore/blockstore.go` | `WFS` | block/file zone 存储。 |
| `pkg/wconfig/settingsconfig.go` | settings config | 设置配置。 |
| `pkg/wconfig/filewatcher.go` | config watcher | 配置文件监听。 |
| `pkg/secretstore/secretstore.go` | secrets | secret 存储。 |
| `pkg/schema/schema.go` | `GetSchemaHandler()` | schema 静态服务。 |

## Electron / AI / Agent 模块索引

### Electron

| 文件 | 关键符号 | 说明 |
| --- | --- | --- |
| `emain/emain.ts` | app lifecycle | main 入口。 |
| `emain/emain-wavesrv.ts` | wavesrv process | Go 后端启动。 |
| `emain/emain-window.ts` | `WaveBrowserWindow` | 窗口管理。 |
| `emain/emain-ipc.ts` | IPC registration | IPC 注册入口。 |
| `emain/preload.ts` | `window.api` | preload API。 |
| `emain/emain-wsh.ts` | Electron RPC impl | Electron route RPC。 |

### AI

| 文件 | 关键符号 | 说明 |
| --- | --- | --- |
| `emain/ai/api-registry.ts` | provider registry | AI API 注册中心。 |
| `emain/ai/stream.ts` | `streamSimple()` | provider streaming 入口。 |
| `emain/ai/models.ts` | `getModel()` | model registry。 |
| `emain/ai/models.generated.ts` | generated models | 模型元数据。 |
| `emain/ai/types.ts` | provider/model types | AI 类型定义。 |
| `emain/aiconfig-ipc.ts` | AI config IPC | 配置 IPC。 |
| `emain/aiconfig/user-config.ts` | user config | 用户 AI 配置。 |
| `emain/aiconfig/secrets.ts` | secrets | token secret 解析。 |

### Agent

| 文件 | 关键符号 | 说明 |
| --- | --- | --- |
| `emain/agent-ipc.ts` | `registerAgentIpc()` | Agent IPC bridge。 |
| `emain/agent/agent-loop.ts` | `agentLoop()`、`agentLoopContinue()` | Agent turn loop。 |
| `emain/agent/agent.ts` | `Agent` | Stateful loop wrapper。 |
| `emain/agent/types.ts` | `AgentLoopConfig` | Agent 类型。 |
| `emain/agent/pane-agent-session.ts` | `PaneAgentSession` | pane session owner。 |
| `emain/agent/harness-factory.ts` | `buildPaneHarness()` | pane harness 构造。 |
| `emain/agent/harness/agent-harness.ts` | `AgentHarness` | harness 层。 |
| `emain/agent/sessions.ts` | session paths | session 管理。 |
| `emain/agent/harness/session/jsonl-repo.ts` | JSONL repo | session 持久化。 |
| `emain/agent/tools/index.ts` | `getDefaultTools()` | 默认工具注册。 |
| `emain/agent/permissions.ts` | permissions hook | tool 权限。 |

## 典型扩展任务路线

### 新增一个 View

阅读：

- `frontend/types/custom.d.ts`
- `frontend/app/block/blockregistry.ts`
- `frontend/app/block/block.tsx`
- 相近 view 目录，如 `frontend/app/view/preview/`

修改：

- 新建 `frontend/app/view/<viewname>/`
- 实现 ViewModel。
- 在 `blockregistry.ts` 注册。
- 如需后端数据，新增 service 或 RPC。

### 新增一个 RPC

阅读：

- `pkg/wshrpc/wshrpctypes.go`
- `pkg/wshrpc/wshserver/wshserver.go`
- `frontend/app/store/wshclientapi.ts`

修改：

- 在 `WshRpcInterface` 添加 `*Command` 方法。
- 在 `WshServer` 或对应 impl 添加实现。
- 运行 `task generate`。
- 前端通过 `RpcApi.*Command()` 调用。

### 新增一个 HTTP Service 方法

阅读：

- `pkg/service/service.go`
- 现有 `pkg/service/*service/*.go`
- `frontend/app/store/wos.ts`

修改：

- 在对应 service struct 添加方法。
- 确认参数/返回值可被 reflection converter 支持。
- 前端调用 `callBackendService()`。

### 新增一个配置项

阅读：

- `pkg/wconfig/`
- `schema/settings.json`
- `frontend/app/store/global.ts`
- `frontend/app/view/waveconfig/`

修改：

- 更新 Go config 类型。
- 更新 schema。
- 更新 UI。
- 运行 `task generate` 或相关 schema build。

### 新增 Agent Tool

阅读：

- `emain/agent/tools/index.ts`
- 现有 tool 文件。
- `emain/agent/permissions.ts`
- `emain/agent/agent-loop.ts`

修改：

- 添加 tool 实现。
- 注册到 `getDefaultTools()`。
- 如有副作用，接入权限。
- 添加 tool 测试。

### 新增 Electron API

阅读：

- `emain/preload.ts`
- `frontend/types/custom.d.ts`
- `emain/emain-ipc.ts`

修改：

- 注册 IPC handler。
- preload 暴露函数。
- 类型声明同步。
- Renderer 通过 `getApi()` 使用。

## 代码生成依赖索引

| 源 | 生成/消费 |
| --- | --- |
| `pkg/wshrpc/wshrpctypes.go` | `frontend/types/gotypes.d.ts`、`frontend/app/store/wshclientapi.ts` |
| `schema/*.json` + `pkg/wconfig/*.go` | `dist/schema` |
| `cmd/generatets/main-generatets.go` | TypeScript 类型与 API |
| `cmd/generatego/main-generatego.go` | Go 生成代码 |

运行：

```bash
task generate
```

## 测试文件索引

### Frontend / Electron

- `frontend/app/tab/vtab.test.tsx`
- `frontend/app/view/term/term-focus.test.ts`
- `frontend/app/view/webview/webview.test.tsx`
- `frontend/layout/tests/utils.test.ts`
- `emain/agent/tools/tools.test.ts`
- `emain/agent/permissions.test.ts`
- `emain/agent/sessions.test.ts`

### Go

- `cmd/wsh/cmd/setmeta_test.go`
- `cmd/wsh/cmd/wshcmd-ssh_test.go`
- `pkg/cmdblock/parser_test.go`
- `pkg/filestore/blockstore_test.go`
- `pkg/gogen/gogen_test.go`
- `pkg/ijson/ijson_test.go`
- `pkg/streamclient/stream_test.go`
- `pkg/tsgen/tsgenevent_test.go`
- `pkg/vdom/vdom_test.go`

## 初次阅读建议

### 只想跑起来

1. `package.json`
2. `Taskfile.yml`
3. `electron.vite.config.ts`
4. `cmd/server/main-server.go`

### 想改 UI

1. `frontend/wave.ts`
2. `frontend/app/app.tsx`
3. `frontend/app/workspace/workspace.tsx`
4. `frontend/app/block/blockregistry.ts`
5. 对应 `frontend/app/view/<view>/`

### 想改终端

1. `frontend/app/view/term/term-model.tsx`
2. `frontend/app/term/terminal-model.ts`
3. `frontend/app/term/engine/`
4. `frontend/app/term/render/`
5. `pkg/blockcontroller/`
6. `pkg/cmdblock/`

### 想改后端数据和 RPC

1. `pkg/waveobj/waveobj.go`
2. `pkg/wstore/wstore_dbops.go`
3. `pkg/wshrpc/wshrpctypes.go`
4. `pkg/wshrpc/wshserver/wshserver.go`
5. `frontend/app/store/wshclientapi.ts`

### 想改 AI / Agent

1. `emain/ai/stream.ts`
2. `emain/ai/api-registry.ts`
3. `emain/agent/agent-loop.ts`
4. `emain/agent/pane-agent-session.ts`
5. `emain/agent/tools/index.ts`
6. `emain/agent-ipc.ts`
