# 整体架构

## 进程模型

Crest 运行时主要包含三层：

| 层级 | 位置 | 职责 |
| --- | --- | --- |
| Electron renderer | `frontend/` | React UI、终端渲染、布局、状态订阅、用户交互。 |
| Electron main | `emain/` | 桌面窗口、preload/IPC、启动 `wavesrv`、系统能力、AI/Agent runtime。 |
| Go backend | `cmd/server/` + `pkg/` | 对象存储、终端控制、连接、任务、文件、RPC、WPS、HTTP/WebSocket 服务。 |

此外还有：

- `wsh` CLI：位于 `cmd/wsh/`，用于命令行操作 workspace、block、配置、文件、连接等。
- remote/job helper：远程或 durable job 场景下通过 `wshrpc` 接回主服务。
- `tsunami`：可嵌入的 Go/TS VDOM 应用框架和 scaffold。

## 启动链路

### Electron main 启动

入口文件：

- `emain/emain.ts`

主流程由 `appMain()` 执行：

1. 设置 Electron app 生命周期。
2. 启动 Go 后端 `wavesrv`。
3. 解析 `wavesrv` 从 stderr 打印的 `WAVESRV-ESTART ws:<addr> web:<addr> version:<version> buildtime:<time>`。
4. 注册 IPC、AI config IPC、agent IPC。
5. 初始化 ElectronWshClient 和 wshrpc。
6. 创建窗口、菜单、更新器和 tab view。

关键文件：

- `emain/emain.ts`
- `emain/emain-wavesrv.ts`
- `emain/emain-ipc.ts`
- `emain/emain-window.ts`
- `emain/emain-wsh.ts`

### Go `wavesrv` 启动

入口文件：

- `cmd/server/main-server.go`

`main()` 的核心步骤：

1. 加载 `.env` 和 `WAVETERM_ENVFILE`。
2. 初始化 `wshutil.DefaultRouter` 并设置为 root router。
3. 读取并移除认证、客户端、workspace、tab、block 等环境变量。
4. 校验 service map。
5. 确保 data/db/config/presets/cache 等目录存在。
6. 获取单实例锁。
7. 初始化 `filestore`。
8. 初始化 `wstore` SQLite 数据库和 migrations。
9. 初始化 shell integration 文件。
10. 调用 `wcore.EnsureInitialData()` 创建 client/window/workspace 初始数据。
11. 调用 `wcore.InitMainServer()` 初始化 JWT key。
12. 创建主 wsh client 和本地 connection route。
13. 启动配置 watcher、telemetry、diagnostic、backup cleanup。
14. 初始化 block logger、job controller、block controller、badge store。
15. 启动 HTTP listener、WebSocket listener、Unix domain socket listener。
16. 打印 `WAVESRV-ESTART` 供 Electron main 捕获。

关键函数：

- `main()` in `cmd/server/main-server.go`
- `createMainWshClient()` in `cmd/server/main-server.go`
- `wcore.EnsureInitialData()` in `pkg/wcore/wcore.go`
- `wcore.InitMainServer()` in `pkg/wcore/wcore.go`
- `web.RunWebServer()` in `pkg/web/web.go`
- `web.RunWebSocketServer()` in `pkg/web/ws.go`
- `wshutil.RunWshRpcOverListener()` in `pkg/wshutil/`

## 通信架构

### Renderer 到 Electron main

Renderer 通过 `window.api` 访问 preload 暴露的 ElectronApi。

关键文件：

- `emain/preload.ts`
- `frontend/types/custom.d.ts`
- `emain/emain-ipc.ts`
- `emain/agent-ipc.ts`
- `emain/aiconfig-ipc.ts`

主要能力：

- 窗口控制、平台信息、路径、开发状态。
- 目录监听、webview 能力、下载、外链。
- AI config 读取/写入。
- Agent session 创建、发送、终止、订阅。

### Renderer 到 Go backend

Renderer 与 Go 后端有两类主通道：

1. `wshrpc` over WebSocket：用于 typed RPC、事件订阅、路由通信。
2. HTTP `/wave/service`：用于反射调用 Go service map，返回数据和 WaveObj updates。

关键文件：

- `frontend/app/store/wshclient.ts`
- `frontend/app/store/wshclientapi.ts`
- `frontend/app/store/wshrouter.ts`
- `frontend/app/store/wps.ts`
- `frontend/app/store/wos.ts`
- `pkg/web/ws.go`
- `pkg/web/web.go`
- `pkg/service/service.go`

### Electron main 到 Go backend

Electron main 也作为 wshrpc peer 接入后端，route 通常是 `electron`。

关键文件：

- `emain/emain-wsh.ts`
- `pkg/wshrpc/wshrpctypes.go`
- `pkg/wshutil/wshrouter.go`

Electron 专属 RPC 包括：

- Web selector/click/screenshot。
- 系统通知。
- 窗口聚焦。
- safeStorage 加密/解密。
- 网络状态。
- 系统 bell。

### Go backend 内部路由

`pkg/wshutil/wshrouter.go` 中的 `WshRouter` 类似网络交换机：

- `wavesrv` 是默认 route。
- `electron` 是 Electron main route。
- `conn:<name>` 表示远程/本地连接 route。
- `controller:<blockid>` 表示 block controller route。
- `job:<jobid>` 表示 job manager route。
- `$control` / `$control:root` 是控制平面 route。

关键函数：

- `wshutil.NewWshRouter()`
- `WshRouter.SetAsRootRouter()`
- `WshRouter.SendEvent()`
- `wshutil.MakeConnectionRouteId()`
- `wshutil.MakeControllerRouteId()`
- `wshutil.MakeJobRouteId()`

## 数据流

### WaveObj 更新流

```text
Go service / wshserver mutates object
  -> wstore transaction records updates
  -> wcore.SendWaveObjUpdate or wps.Broker.SendUpdateEvents
  -> WPS event waveobj:update
  -> frontend/app/store/wps.ts
  -> frontend/app/store/wos.ts updates object atoms
  -> React components re-render
```

关键文件：

- `pkg/wstore/wstore_dbops.go`
- `pkg/wcore/wcore.go`
- `pkg/wps/wps.go`
- `frontend/app/store/wps.ts`
- `frontend/app/store/wos.ts`

### 终端输出流

```text
Shell/PTY output
  -> blockcontroller shell read loop
  -> filestore BlockFile_Term append
  -> cmdblock Tracker.OnBytes
  -> cmdblock Parser.Feed for OSC 16162
  -> cmdblock store / db_cmdblock
  -> WPS cmdblock:* events
  -> TerminalModel subscription
  -> ANSI parser / Blocks model
  -> React terminal renderer
```

关键文件：

- `pkg/blockcontroller/blockcontroller.go`
- `pkg/blockcontroller/shellcontroller.go`
- `pkg/filestore/blockstore.go`
- `pkg/cmdblock/tracker.go`
- `pkg/cmdblock/parser.go`
- `pkg/cmdblock/store.go`
- `frontend/app/term/terminal-model.ts`
- `frontend/app/term/engine/`
- `frontend/app/term/render/`

### Agent 运行流

```text
Renderer agent UI
  -> window.api.agent.send
  -> emain/agent-ipc.ts
  -> AgentSessionRuntime
  -> AgentHarness
  -> agentLoop
  -> AI provider stream
  -> tool execution
  -> JSONL session persistence
  -> agent:event fan-out to renderer
```

关键文件：

- `emain/agent-ipc.ts`
- `emain/agent/agent-session-runtime.ts`
- `emain/agent/harness/agent-harness.ts`
- `emain/agent/agent-loop.ts`
- `emain/agent/tools/`
- `emain/ai/stream.ts`

## HTTP 服务

`pkg/web/web.go` 暴露：

- `/wave/file`：读取 filestore 文件。
- `/wave/service`：调用 `pkg/service` 中注册的 service。
- `/wave/stream-file`、`/wave/stream-local-file`：流式文件输出。
- `/vdom/{uuid}/{path}`：VDOM 静态或资源处理。
- `/schema/`：配置 JSON Schema。

WebSocket 服务在 `pkg/web/ws.go`：

- `/ws`：升级为 WebSocket。
- 使用 `stableid` 和 auth key 验证连接。
- 解析 `webcmd.WSRpcCommand` 后将 RPC message 放入 router input channel。
- 维护 ping/pong 和 stable route registration。

## 依赖方向

高层依赖关系：

```text
frontend
  depends on generated gotypes + wshclientapi + preload ElectronApi

emain
  depends on Electron, Node APIs, AI SDKs, generated runtime types
  launches and connects to wavesrv

pkg/wshrpc
  defines shared Go RPC contracts
  feeds code generation for frontend

pkg/wstore + pkg/waveobj
  provide persistent object model

pkg/wcore
  coordinates wstore + wps + app-level object changes

pkg/blockcontroller/jobcontroller/remote
  depend on wstore, filestore, wshrpc, WPS and route system

pkg/web
  exposes service, file, schema, websocket surfaces
```

## 安全与认证

- `wavesrv` 启动时从环境变量读取 auth key，并从进程环境中移除敏感变量。
- WebSocket 和 HTTP 请求通过 `authkey.ValidateIncomingRequest()` 校验。
- Electron main 使用 safeStorage 提供加密/解密 RPC。
- Agent API key 可通过 secret name 在 main 进程解析，避免明文回传 renderer。
- JobManager 使用 JWT public key 和 job auth token 认证 durable job 连接。

## 配置与 schema

- 配置逻辑在 `pkg/wconfig/`。
- JSON Schema 源文件在 `schema/`。
- `task build:schema` 生成并复制 schema 到 `dist/schema`。
- 后端通过 `/schema/` 静态暴露 schema。
- 前端通过配置 service、wshrpc 和 atoms 获取配置项。
