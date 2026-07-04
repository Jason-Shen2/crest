# 项目总览

## 项目定位

Crest 当前包名为 `crest`、产品名为 `Crest`，README 仍保留 Wave Terminal 的产品描述。它是一个 AI-Native Terminal / 图形化终端应用，支持终端 block、动态布局、workspace、SSH/WSL 连接、文件预览、配置管理、命令块、AI 助手和本地 agent。

核心目标可以概括为：

- 提供跨平台桌面终端体验，覆盖 macOS、Linux、Windows。
- 将终端输出、文件、远程连接、Web/Preview/Editor 等能力统一放入可拖拽布局。
- 通过 `wsh` 与 `wshrpc` 将命令行、前端、后端、远程连接和 Electron 能力接到同一套路由系统。
- 在 Electron main 进程内提供 AI provider 与 Agent runtime，让 AI 可以读取上下文、执行工具、持久化 session。

## 仓库顶层结构

| 路径 | 职责 |
| --- | --- |
| `frontend/` | Electron renderer 前端，React + TypeScript + Jotai。 |
| `emain/` | Electron main/preload/IPC、窗口管理、AI provider、Agent runtime。 |
| `pkg/` | Go 后端核心库，包含存储、RPC、事件、终端控制、连接、任务、配置、Web 服务。 |
| `cmd/server/` | Go `wavesrv` 入口。 |
| `cmd/wsh/` | `wsh` CLI 入口和命令实现。 |
| `cmd/generatets/`、`cmd/generatego/` | Go/TS 代码生成入口。 |
| `db/` | SQLite migration embedded FS。 |
| `schema/` | 配置 JSON Schema 源文件，构建后复制到 `dist/schema`。 |
| `tsunami/` | 内置 VDOM/Go UI 子项目和 scaffold 系统。 |
| `docs/` | 架构设计、Agent、AI 配置、迁移等文档。 |
| `aiprompts/` | 历史设计 prompt 和特性说明。 |
| `tests/` | Shell/copy 等测试用例。 |
| `training/` | NLD/classifier 训练相关脚本和数据。 |

## 核心概念

### WaveObj

`WaveObj` 是后端持久化对象协议，定义在 `pkg/waveobj/waveobj.go`。对象以 `otype:oid` 的 `ORef` 形式引用，统一包含：

- `otype`：对象类型，如 client、workspace、window、tab、block。
- `oid`：UUID。
- `version`：版本号。
- `meta`：可扩展元数据。

相关核心函数：

- `waveobj.RegisterType()`：注册 Go struct 与 `otype` 的映射。
- `waveobj.MakeORef()` / `waveobj.ParseORef()`：创建和解析对象引用。
- `waveobj.ToJsonMap()` / `waveobj.FromJson()`：对象与 JSON 的互转。

### Workspace / Tab / Block / View

前端 UI 以 Workspace 为窗口级容器，Workspace 内有 Tab，Tab 内用 tile layout 管理多个 Block，每个 Block 根据 meta 中的 `view` 创建对应 ViewModel 和 React 视图。

典型链路：

```text
Workspace -> TabContent -> TileLayout -> Block -> BlockRegistry -> ViewModel -> viewComponent
```

关键文件：

- `frontend/app/workspace/workspace.tsx`
- `frontend/app/tab/tabcontent.tsx`
- `frontend/layout/lib/TileLayout.tsx`
- `frontend/app/block/block.tsx`
- `frontend/app/block/blockregistry.ts`
- `frontend/types/custom.d.ts`

### wshrpc

`wshrpc` 是项目的自定义 RPC 协议，支持 WebSocket、Unix domain socket、本地路由和远程路由。RPC 接口定义在 `pkg/wshrpc/wshrpctypes.go` 的 `WshRpcInterface`，服务端实现主要在 `pkg/wshrpc/wshserver/wshserver.go`，前端 TypeScript client 由代码生成得到。

### WPS

WPS 是 Wave PubSub 事件系统，Go 侧 broker 在 `pkg/wps/wps.go`，前端订阅分发在 `frontend/app/store/wps.ts`。它用于：

- WaveObj 更新通知。
- Block close、cmdblock row/chunk、终端输出等事件。
- 带 scope 的事件订阅和有限历史事件读取。

### BlockController

BlockController 是后端对 block 运行时的控制层，定义在 `pkg/blockcontroller/blockcontroller.go`。不同 controller 负责 shell、cmd、tsunami 等不同 block 运行模式。

### Agent Runtime

Agent runtime 位于 `emain/agent/`，运行在 Electron main 进程中。它持有 session、timeline、tool calls、权限、streaming 状态和 JSONL 持久化，renderer 通过 preload 暴露的 `window.api.agent.*` 访问。

## 主要依赖关系

```text
Renderer React UI
  -> preload ElectronApi
  -> Electron main IPC / agent / AI provider
  -> wavesrv process
  -> wshrpc / WPS / HTTP service
  -> wstore SQLite + filestore + blockcontroller + remote/job systems
```

```text
Go wshrpc interface
  -> cmd/generatets
  -> frontend/types/gotypes.d.ts
  -> frontend/app/store/wshclientapi.ts
  -> Renderer RpcApi calls
```

```text
PTY / shell output
  -> blockcontroller
  -> filestore BlockFile_Term
  -> cmdblock tracker/parser
  -> wstore db_cmdblock
  -> WPS cmdblock events
  -> TerminalModel / terminal renderer
```

## 生成文件与不要手改的文件

- `frontend/types/gotypes.d.ts`：Go 类型生成的 TS 声明。
- `frontend/app/store/wshclientapi.ts`：Go RPC 接口生成的 TS client。
- 修改 Go RPC 类型后执行 `task generate`。

## 命名现状

仓库存在 Crest 与 Wave 两套命名：

- `package.json`：`name=crest`，`productName=Crest`。
- README、很多包名和环境变量仍使用 Wave/WaveTerm。
- 二进制后端仍叫 `wavesrv`，CLI 叫 `wsh`。
- 数据目录、配置目录、环境变量多以 `WAVETERM_*` 命名。
