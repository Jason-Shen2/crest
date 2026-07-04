# 后端架构

## 总览

Go 后端由 `cmd/server/main-server.go` 启动，运行时二进制名为 `wavesrv`。它负责：

- 初始化本地数据目录、配置目录、SQLite 数据库和 filestore。
- 管理 WaveObj 持久化对象。
- 暴露 HTTP、WebSocket 和 Unix domain socket。
- 实现 `wshrpc` server。
- 管理终端 block controller、remote connection、WSL/SSH、job manager。
- 发布 WPS 事件给前端和其他 route。

## 后端目录地图

| 路径 | 职责 |
| --- | --- |
| `cmd/server/` | `wavesrv` 入口。 |
| `cmd/wsh/` | `wsh` CLI 命令入口。 |
| `pkg/wavebase/` | 路径、环境、版本、平台基础能力。 |
| `pkg/waveobj/` | WaveObj 协议、ORef、meta、对象注册与 JSON 转换。 |
| `pkg/wstore/` | SQLite store、migrations、WaveObj CRUD、RTInfo。 |
| `pkg/filestore/` | block/file zone 存储。 |
| `pkg/wcore/` | 应用核心协调层，连接 wstore、wps、初始化数据。 |
| `pkg/wshrpc/` | RPC 接口、类型、client/server/remote 实现。 |
| `pkg/wshutil/` | wshrpc router、proxy、adapter、domain socket transport。 |
| `pkg/wps/` | Wave PubSub broker 与事件类型。 |
| `pkg/web/` | HTTP、WebSocket、schema、file/service/vdom routes。 |
| `pkg/service/` | HTTP `/wave/service` 反射 service map。 |
| `pkg/blockcontroller/` | shell/cmd/tsunami block controller 生命周期。 |
| `pkg/cmdblock/` | 命令块 timeline、OSC 16162 parser、cmdblock store。 |
| `pkg/jobcontroller/` | 后端 job lifecycle 与 job metadata。 |
| `pkg/jobmanager/` | durable job 子进程 manager。 |
| `pkg/remote/` | SSH、WSL、远程文件和连接控制。 |
| `pkg/wconfig/` | 配置读取、settings、file watcher。 |
| `pkg/secretstore/` | secret 存储。 |
| `pkg/schema/` | JSON Schema 静态 HTTP handler。 |
| `pkg/vdom/`、`pkg/waveapp/` | VDOM/Wave app 支持。 |

## `wavesrv` 启动

入口：

- `cmd/server/main-server.go`

关键函数：

- `main()`
- `grabAndRemoveEnvVars()`
- `createMainWshClient()`
- `maybeStartPprofServer()`
- `doShutdown()`

核心初始化顺序：

1. 设置 `wavebase.WaveVersion` 和 `wavebase.BuildTime`。
2. 创建 `wshutil.DefaultRouter` 并设置 root router。
3. 读取 auth key 和 Wave 运行环境变量。
4. 校验 `service.ServiceMap`。
5. 确保 data/db/config/presets/cache 目录。
6. 获取单实例锁。
7. 初始化 `filestore.InitFilestore()`。
8. 初始化 `wstore.InitWStore()`。
9. 初始化 shell startup files。
10. 调用 `wcore.EnsureInitialData()`。
11. 清理 temp files。
12. 调用 `wcore.InitMainServer()`。
13. 创建本地 wsh client，注册本地 connection route。
14. 启动 watcher、telemetry、diagnostic、backup cleanup。
15. 初始化 block logger、job controller、block controller、badge store。
16. 创建并启动 HTTP、WebSocket、Unix domain socket listener。

服务启动成功后会打印：

```text
WAVESRV-ESTART ws:<addr> web:<addr> version:<version> buildtime:<buildtime>
```

Electron main 依赖这行获取后端 endpoint。

## WaveObj 对象模型

关键文件：

- `pkg/waveobj/waveobj.go`
- `pkg/waveobj/wtype.go`
- `pkg/waveobj/metamap.go`
- `pkg/waveobj/metaconsts.go`
- `pkg/waveobj/objrtinfo.go`

核心接口：

```go
type WaveObj interface {
    GetOType() string
}
```

对象约束：

- 必须是 pointer type。
- 必须实现 `WaveObj`。
- 必须包含 `OID string`，json tag 为 `oid`。
- 必须包含 `Version int`，json tag 为 `version`。
- 必须包含 `Meta MetaMapType`，json tag 为 `meta`。

核心类型/函数：

- `ORef`：`otype:oid` 引用。
- `MakeORef()`：创建对象引用。
- `ParseORef()`：解析对象引用并校验类型和 UUID。
- `RegisterType()`：注册对象类型。
- `GetOID()` / `SetOID()`：反射读写对象 ID。
- `GetVersion()` / `SetVersion()`：反射读写版本。
- `GetMeta()` / `SetMeta()`：反射读写 meta。
- `ToJsonMap()` / `FromJson()`：对象与 JSON 的互转。

## wstore 存储层

关键文件：

- `pkg/wstore/wstore_dbsetup.go`
- `pkg/wstore/wstore_dbops.go`
- `pkg/wstore/wstore_rtinfo.go`
- `db/migrations-wstore/`

职责：

- 打开 SQLite 数据库 `waveterm.db`。
- 执行 embedded migrations。
- 提供事务封装。
- 提供泛型 WaveObj CRUD。
- 管理 runtime info。

数据库连接：

```text
file:<data-dir>/db/waveterm.db?mode=rwc&_journal_mode=WAL&_busy_timeout=5000
```

并设置：

```go
SetMaxOpenConns(1)
```

关键函数：

- `InitWStore()`
- `MakeDB()`
- `WithTx()`
- `WithTxRtn()`
- `DBGetSingleton()`
- `DBGetORef()`
- `DBMustGet()`
- `DBInsert()`
- `DBUpdate()`
- `UpdateObjectMeta()`
- `DBGetBlockViewCounts()`
- `DBGetWSCounts()`

事务与事件更新关系：

- `WithTx()` 调用 `waveobj.ContextUpdatesBeginTx(ctx)`。
- 成功时 commit context updates。
- 失败时 rollback context updates。
- 上层通过 `wps.Broker.SendUpdateEvents()` 或 `wcore.SendWaveObjUpdate()` 发布更新。

## wcore 协调层

关键文件：

- `pkg/wcore/wcore.go`
- `pkg/wcore/workspace.go`
- `pkg/wcore/window.go`
- `pkg/wcore/tab.go`
- `pkg/wcore/block.go`
- `pkg/wcore/layout.go`
- `pkg/wcore/badge.go`

职责：

- 创建初始 client/window/workspace。
- 初始化 main server JWT key。
- 发送 WaveObj update 事件。
- 协调 workspace、window、tab、block 的业务创建/更新。

关键函数：

- `EnsureInitialData()`：确保 client、window、starter workspace 存在。
- `CreateClient()`：创建 singleton client。
- `GetClientData()`：读取 client。
- `SendWaveObjUpdate()`：读取对象并发布 `waveobj:update`。
- `ResolveBlockIdFromPrefix()`：按 8 位 prefix 解析 block。
- `InitMainServer()`：初始化/加载 JWT private/public key。

## wshrpc RPC 层

### 接口定义

关键文件：

- `pkg/wshrpc/wshrpctypes.go`

`WshRpcInterface` 定义所有 RPC command。约定：

- 方法名必须以 `Command` 结尾。
- 第一个参数必须是 `context.Context`。
- 可以有 typed input 参数。
- 返回值可以是 `error` 或一个返回值加 `error`。
- 修改后必须运行 `task generate`。

主要 RPC 类别：

- 鉴权和 route control。
- meta/config/object/tab/block 操作。
- block controller input/destroy/resync。
- WPS event publish/subscribe/history。
- file/temp/stream。
- telemetry/activity。
- command block。
- connection/WSL/remote。
- Electron 专属能力。
- secrets。
- terminal and app/builder 相关能力。

### Server 实现

关键文件：

- `pkg/wshrpc/wshserver/wshserver.go`

核心类型：

- `type WshServer struct{}`
- `var WshServerImpl = WshServer{}`

典型方法：

- `GetMetaCommand()`
- `SetMetaCommand()`
- `ResolveIdsCommand()`
- `CreateBlockCommand()`
- `DeleteBlockCommand()`
- `EventSubCommand()`
- `GetCmdBlocksCommand()`
- `AppendAgentRunCommand()`
- `GetCmdBlockOutputCommand()`
- `ConnConnectCommand()`
- `RemoteStartJobCommand()`

### Router

关键文件：

- `pkg/wshutil/wshrouter.go`

核心类型：

- `WshRouter`

职责：

- 管理 route 到 link 的映射。
- 转发 RPC request/response。
- 支持 root router、leaf、router link。
- 支持 control plane。
- 向指定 route 推送 WPS event。

重要 route：

- `wavesrv`
- `electron`
- `$control`
- `$control:root`
- `conn:<conn>`
- `controller:<blockid>`
- `job:<jobid>`
- `tab:<tabid>`
- `feblock:<blockid>`
- `builder:<builderid>`

## WPS 事件系统

关键文件：

- `pkg/wps/wps.go`
- `pkg/wps/wpstypes.go`

核心类型：

- `BrokerType`
- `BrokerSubscription`
- `WaveEvent`
- `SubscriptionRequest`

功能：

- 按 event type 订阅。
- 按 scope 订阅。
- 支持 wildcard scope。
- 支持有限历史持久化，最大 `MaxPersist = 4096`。
- 通过 `Client.SendEvent(routeId, event)` 发回 wshrpc route。

关键函数：

- `Broker.Subscribe()`
- `Broker.Unsubscribe()`
- `Broker.UnsubscribeAll()`
- `Broker.ReadEventHistory()`
- `Broker.Publish()`
- `Broker.SendUpdateEvents()`

常见事件：

- `waveobj:update`
- `blockclose`
- `cmdblock:row`
- `cmdblock:chunk`
- `cmdblock:altscreen`
- `cmdblock:clear`
- `cmdblock:notify`

## HTTP 与 WebSocket

### HTTP

关键文件：

- `pkg/web/web.go`

主要 route：

- `/wave/file`
- `/wave/service`
- `/wave/stream-file`
- `/wave/stream-local-file`
- `/vdom/{uuid}/{path}`
- `/schema/`

关键函数：

- `MakeTCPListener()`
- `MakeUnixListener()`
- `RunWebServer()`
- `handleService()`
- `handleWaveFile()`
- `handleStreamFile()`

### WebSocket

关键文件：

- `pkg/web/ws.go`

主要 route：

- `/ws`

关键函数：

- `RunWebSocketServer()`
- `HandleWs()`
- `HandleWsInternal()`
- `ReadLoop()`
- `WriteLoop()`
- `processWSCommand()`
- `registerConn()` / `unregisterConn()`

WebSocket 消息中 `webcmd.WSRpcCommand` 会被解析为 RPC message，并送入 router。

## Service 反射调用层

关键文件：

- `pkg/service/service.go`

`ServiceMap`：

```go
var ServiceMap = map[string]any{
    "block":     blockservice.BlockServiceInstance,
    "object":    &objectservice.ObjectService{},
    "client":    &clientservice.ClientService{},
    "window":    &windowservice.WindowService{},
    "workspace": &workspaceservice.WorkspaceService{},
    "userinput": &userinputservice.UserInputService{},
}
```

职责：

- 接收 `/wave/service` 的 `WebCallType`。
- 按 `service` 和 `method` 查找 Go method。
- 将 JSON 参数转换为 Go typed 参数。
- 支持 `context.Context`、`UIContext`、`ORef`、`WaveObj` 等特殊类型。
- 返回 `WebReturnType`，包含 `data` 和 `updates`。

关键类型：

- `WebCallType`
- `WebReturnType`

关键函数：

- `CallService()`
- `ValidateServiceMap()`
- `convertArgument()`
- `convertSpecial()`
- `convertSpecialForReturn()`

## BlockController

关键文件：

- `pkg/blockcontroller/blockcontroller.go`
- `pkg/blockcontroller/shellcontroller.go`
- `pkg/blockcontroller/durableshellcontroller.go`
- `pkg/blockcontroller/tsunamicontroller.go`

核心接口：

```go
type Controller interface {
    Start(ctx context.Context, blockMeta waveobj.MetaMapType, rtOpts *waveobj.RuntimeOpts, force bool) error
    Stop(graceful bool, newStatus string, destroy bool)
    GetRuntimeStatus() *BlockControllerRuntimeStatus
    GetConnName() string
    SendInput(input *BlockInputUnion) error
}
```

Controller 类型：

- `shell`
- `cmd`
- `tsunami`

关键函数：

- `InitBlockController()`
- `ResyncController()`
- `DestroyBlockController()`
- `StopAllBlockControllersForShutdown()`

`ResyncController()` 会根据 block meta 中的 controller 和 connection 判断：

- 是否需要启动 controller。
- 是否连接变化需要销毁重建。
- 是否 controller 类型变化需要替换。
- durable shell 是否应该使用 `DurableShellController`。

## Command Block

关键目录：

- `pkg/cmdblock/`
- `pkg/cmdblock/cbtypes/`

职责：

- 从 PTY 字节流解析 OSC 16162 命令生命周期事件。
- 维护命令块 row。
- 捕获命令输出快照。
- 发布实时 chunk 和 row 更新。

核心类型：

- `cbtypes.CmdBlock`
- `cbtypes.CmdBlockChunkEvent`
- `cbtypes.CmdBlockAltScreenEvent`
- `cbtypes.CmdBlockClearEvent`
- `cbtypes.CmdBlockNotifyEvent`
- `Tracker`
- `Parser`

关键函数：

- `MakePromptStarted()`
- `MarkCommandSubmitted()`
- `MarkCommandDone()`
- `GetByBlockID()`
- `SetOutputData()`
- `GetOutputData()`
- `Tracker.OnBytes()`
- `Parser.Feed()`

相关 migrations：

- `db/migrations-wstore/000012_cmdblock.up.sql`
- `db/migrations-wstore/000013_cmdblock_output.up.sql`
- `db/migrations-wstore/000014_agent_cmdblock.up.sql`

事件：

- `cmdblock:row`
- `cmdblock:chunk`
- `cmdblock:altscreen`
- `cmdblock:clear`
- `cmdblock:notify`

## Job 与 durable session

关键目录：

- `pkg/jobcontroller/`
- `pkg/jobmanager/`

`jobcontroller` 负责主服务侧 job 生命周期和状态，`jobmanager` 是 durable job 进程侧 manager。

`jobmanager.JobManager` 字段：

- `ClientId`
- `JobId`
- `Cmd`
- `JwtPublicKey`
- `JobAuthToken`
- `StreamManager`
- `InputQueue`
- attached/stream client connection

关键函数：

- `SetupJobManager()`
- `processInputQueue()`
- `sendJobExited()`
- `GetJobAuthInfo()`

Job 与 command block 的区别：

- Job 更偏进程和 durable stream 生命周期。
- CmdBlock 更偏终端 timeline 和命令输出历史。
- 两者都可能通过 block/file/stream/RPC 体系和前端关联。

## Remote / SSH / WSL

关键目录：

- `pkg/remote/`
- `pkg/wsl/`
- `pkg/wslconn/`
- `pkg/genconn/`

职责：

- 解析 connection 配置。
- 建立 SSH/WSL 连接。
- 远程安装和更新 `wsh`。
- 远程文件分享和文件操作。
- 维护 connection route。

相关 RPC：

- `ConnStatusCommand`
- `ConnEnsureCommand`
- `ConnConnectCommand`
- `ConnDisconnectCommand`
- `ConnListCommand`
- `WslStatusCommand`
- `WslListCommand`
- `RemoteStartJobCommand`
- `RemoteProcessListCommand`
- `RemoteProcessSignalCommand`

## 配置、Secret 与 Schema

关键目录：

- `pkg/wconfig/`
- `pkg/secretstore/`
- `pkg/schema/`
- `schema/`

职责：

- `wconfig` 读取 settings、connections、widgets 等配置。
- `filewatcher` 监听配置文件变化。
- `secretstore` 管理 secret。
- `schema` 通过 `/schema/` 暴露 JSON Schema。

相关命令：

```bash
task build:schema
task generate
```

## 后端扩展入口

### 新增 RPC

1. 修改 `pkg/wshrpc/wshrpctypes.go` 的 `WshRpcInterface`。
2. 在 `pkg/wshrpc/wshserver/wshserver.go` 或对应 impl 中实现。
3. 运行 `task generate`。
4. 前端通过生成的 `RpcApi.<Name>Command()` 调用。

### 新增 HTTP service

1. 在 `pkg/service/<domain>service/` 中添加 service 方法。
2. 若是新 service，注册到 `ServiceMap`。
3. 确认参数和返回类型符合 `ValidateServiceMap()` 约束。
4. 前端通过 `callBackendService()` 调用。

### 新增 WaveObj 类型

1. 在 `pkg/waveobj/` 或业务包中定义 struct。
2. 满足 `OID`、`Version`、`Meta` 字段约束。
3. 实现 `GetOType()`。
4. 注册类型。
5. 添加 migration 表。
6. 使用 `wstore` 泛型 CRUD。

### 新增 WPS 事件

1. 在 `pkg/wps/wpstypes.go` 添加事件类型。
2. 后端通过 `wps.Broker.Publish()` 发布。
3. 前端通过 `waveEventSubscribeSingle()` 订阅。
