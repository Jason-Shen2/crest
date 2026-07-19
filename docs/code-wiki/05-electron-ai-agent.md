# Electron 与 AI Agent

## 总览

`emain/` 是 Electron main 进程层，负责桌面外壳、窗口、IPC、preload、启动 `wavesrv`、连接 Go 后端、AI provider 和本地 Agent runtime。

主要职责：

- 管理 Electron app 生命周期。
- 启动并监控 Go `wavesrv`。
- 暴露 `window.api` 给 renderer。
- 注册 IPC channels。
- 为 Go 后端实现 Electron 专属 wshrpc。
- 管理 AI model/provider registry 和 streaming。
- 管理 pane-level agent session、tool execution、permission gating 和 JSONL 持久化。

## 目录结构

| 路径 | 职责 |
| --- | --- |
| `emain/emain.ts` | Electron main 入口。 |
| `emain/emain-wavesrv.ts` | 启动和解析 Go `wavesrv`。 |
| `emain/emain-window.ts` | BrowserWindow 和 workspace/window/tab view 管理。 |
| `emain/emain-ipc.ts` | 通用 IPC 注册入口。 |
| `emain/preload.ts` | contextBridge 暴露 ElectronApi。 |
| `emain/preload-webview.ts` | webview preload。 |
| `emain/emain-wsh.ts` | Electron 侧 wshrpc 实现。 |
| `emain/aiconfig-ipc.ts` | AI 配置 IPC。 |
| `emain/aiconfig/` | AI user config 与 secrets。 |
| `emain/ai/` | AI provider registry、模型表、streaming、OAuth、工具函数。 |
| `emain/agent/` | Agent loop、session、tools、permissions、harness。 |
| `emain/agent-ipc.ts` | Renderer 与 Agent runtime 的 IPC bridge。 |

## Electron main 启动

入口：

- `emain/emain.ts`

核心流程：

1. Electron app ready 后执行主初始化。
2. 通过 `emain-wavesrv.ts` 启动 Go `wavesrv`。
3. 等待 `WAVESRV-ESTART`，拿到 ws/web endpoint。
4. 注册 IPC。
5. 初始化 ElectronWshClient。
6. 创建窗口与菜单。
7. 初始化 updater 和窗口生命周期。

关键文件：

- `emain/emain.ts`
- `emain/emain-wavesrv.ts`
- `emain/emain-menu.ts`
- `emain/updater.ts`
- `emain/launchsettings.ts`

## wavesrv 启动管理

关键文件：

- `emain/emain-wavesrv.ts`

职责：

- 定位 `wavesrv` 二进制。
- 设置 `WAVETERM_*` 环境变量。
- 注入 auth/data/config 信息。
- 启动 child process。
- 解析 stderr 中的 `WAVESRV-ESTART`。
- 处理 `WAVESRV-EVENT`。
- 将后端日志接入 Electron logging。

Go 后端启动后 main 进程会知道：

- WebSocket endpoint。
- HTTP web endpoint。
- version。
- build time。

这些 endpoint 会被 renderer 初始化和 wshrpc client 使用。

## Window 管理

关键文件：

- `emain/emain-window.ts`
- `emain/emain-tabview.ts`
- `emain/emain-platform.ts`

核心类：

- `WaveBrowserWindow`

职责：

- 创建和管理 BrowserWindow。
- 持有 workspace/window/tab view 信息。
- 处理 close、relaunch、focus、快捷键。
- 管理窗口状态、透明/模糊/背景等 desktop 属性。
- 和后端 window object 保持同步。

## Preload 与 ElectronApi

关键文件：

- `emain/preload.ts`
- `frontend/types/custom.d.ts`

`preload.ts` 通过：

```ts
contextBridge.exposeInMainWorld("api", ...)
```

暴露 `window.api`。

主要 API 领域：

- 平台和环境：是否 dev、平台、路径、版本。
- 窗口控制：聚焦、关闭、重启、ready、tab view。
- 文件/目录监听。
- WebView。
- AI config。
- Agent runtime。

`frontend/types/custom.d.ts` 中的 `ElectronApi` 必须与 preload surface 保持一致。

## IPC

### 通用 IPC

关键文件：

- `emain/emain-ipc.ts`

职责：

- 统一注册 Electron IPC。
- 调用 `registerAgentIpc()` 和 `registerAiConfigIpc()`。
- 注册外链、webview、下载、窗口、目录监听等 channels。

### AI config IPC

关键文件：

- `emain/aiconfig-ipc.ts`
- `emain/aiconfig/user-config.ts`
- `emain/aiconfig/secrets.ts`

channels：

- `ai:list-provider-models`
- `ai:get-user-config`
- `ai:write-user-config`

特点：

- user config 存在本地配置目录。
- token 可引用 secret name。
- main 进程负责解析真实 key，避免明文暴露给 renderer。

### Agent IPC

关键文件：

- `emain/agent-ipc.ts`

channels：

- `agent:create-session`
- `agent:list-sessions-for-cwd`
- `agent:send`
- `agent:abort`
- `agent:subscribe`
- `agent:unsubscribe`

事件 channel：

- `agent:event`

设计要点：

- 不为每个 session 动态创建 channel。
- payload 带 `sessionPath`。
- preload 侧按 `sessionPath` fan-out。
- late subscriber 会收到 persisted snapshot。

## Electron 侧 wshrpc

关键文件：

- `emain/emain-wsh.ts`
- `pkg/wshrpc/wshrpctypes.go`

Electron main 作为 route `electron` 接入 wshrpc，提供 Go 后端无法直接完成的桌面能力。

主要 RPC：

- `WebSelectorCommand`
- `WebClickCommand`
- `WebScreenshotCommand`
- `NotifyCommand`
- `FocusWindowCommand`
- `ElectronEncryptCommand`
- `ElectronDecryptCommand`
- `NetworkOnlineCommand`
- `ElectronSystemBellCommand`

依赖：

- BrowserWindow / webContents。
- Electron safeStorage。
- Electron native notification。
- 网络状态 API。

## AI Provider 架构

关键目录：

- `emain/ai/`

关键文件：

- `emain/ai/index.ts`
- `emain/ai/api-registry.ts`
- `emain/ai/models.ts`
- `emain/ai/models.generated.ts`
- `emain/ai/stream.ts`
- `emain/ai/types.ts`
- `emain/ai/providers/`

### Provider Registry

`api-registry.ts` 以 `api` 字符串注册 provider 实现。

核心能力：

- `stream`
- `streamSimple`

AI 请求入口：

- `streamSimple()` in `emain/ai/stream.ts`

流程：

```text
model api string
  -> api registry lookup
  -> provider stream implementation
  -> normalized stream events
```

### Model Registry

关键文件：

- `emain/ai/models.generated.ts`
- `emain/ai/models.ts`

职责：

- 维护 provider/model 元数据。
- 根据 provider 和 modelId 查找 model。
- 初始化内置 provider models。

### Provider 类型

关键文件：

- `emain/ai/types.ts`

支持的选项包括：

- reasoning。
- cache retention。
- transport。
- sessionId。
- custom headers。
- timeout/retry。
- diagnostics callbacks。

### 内置 Provider

目录：

- `emain/ai/providers/`

当前主要包括：

- Anthropic。
- Google / Google shared。
- OpenAI compatible / Responses。
- Cloudflare 等 provider 支撑文件。

## Agent Runtime 总览

关键目录：

- `emain/agent/`

Agent runtime 是 main 进程内的 agent 系统，负责：

- 管理对话 transcript。
- 调用 AI streaming。
- 执行工具。
- 管理并行 tool call。
- 维护 abort/steering/follow-up queue。
- 记录 timeline。
- 持久化 JSONL session。
- 将状态通过 IPC 推给 renderer。

## Agent Loop

关键文件：

- `emain/agent/agent-loop.ts`
- `emain/agent/agent.ts`
- `emain/agent/types.ts`

核心函数：

- `agentLoop()`
- `agentLoopContinue()`

核心类：

- `Agent`

职责：

- 持有当前 transcript。
- 管理 streaming 状态。
- 管理 pending tool calls。
- 管理 steering/follow-up queue。
- 管理 abort controller。
- 分发事件 listeners。

`AgentLoopConfig` 描述：

- LLM stream function。
- context transform。
- system prompt。
- API key。
- tool execution mode。
- queue hooks。
- before/after tool call hooks。

## Harness 层

关键文件：

- `emain/agent/harness-factory.ts`
- `emain/agent/harness/agent-harness.ts`
- `emain/agent/harness/env/nodejs.ts`

职责：

- 将低层 agent loop 包装成 pane 可用运行环境。
- 绑定 cwd。
- 注入 system prompt closure。
- 注入 provider stream options。
- 注入 tools。
- 注入 permissions hook。
- 管理 active tools、resources、queue 和 event handlers。

关键函数：

- `buildAgentHarnessHost()`
- `AgentHarness.run()`
- `AgentHarness.update()`

## AgentSessionRuntime

关键文件：

- `emain/agent/agent-session-runtime.ts`

职责：

- 作为 renderer 和 harness 之间的 owner。
- 维护 authoritative messages、runs、status。
- 管理 steer/follow-up queue。
- 向 IPC subscribers replay snapshot。
- 根据 `runId` route 一次 agent run。

它不改变 agent loop 行为，主要处理跨进程 UI 一致性和订阅 fan-out。

## Session 持久化

关键文件：

- `emain/agent/sessions.ts`
- `emain/agent/harness/session/jsonl-repo.ts`

默认路径：

```text
{WAVETERM_CONFIG_HOME or ~/.config/crest{-dev}}/sessions/{encodedCwd}/{timestamp}_{id}.jsonl
```

能力：

- create。
- open。
- openPath。
- list。
- delete。
- fork。
- 按 cwd 分组列历史会话。

Agent IPC 在 `agent:send` 时会：

1. 确保 session 存在。
2. 创建或复用 `AgentSessionRuntime`。
3. 生成 `runId`。
4. 持久化 timeline marker。
5. 异步执行 `session.send(runId, text)`。

## Agent Tools

关键目录：

- `emain/agent/tools/`

默认工具注册：

- `emain/agent/tools/index.ts`

默认工具：

- `read`
- `write`
- `edit`
- `ls`
- `bash`
- `find`
- `grep`
- `web_fetch`

特点：

- 每个 pane 绑定 cwd。
- `find` / `grep` 使用纯 Node 实现，避免运行期依赖下载外部二进制。
- 文件编辑工具来自 pi coding-agent 思路。
- 通过 permissions hook 做 approval/allowlist gating。

关键文件：

- `read.ts`
- `write.ts`
- `edit.ts`
- `bash.ts`
- `find.ts`
- `grep.ts`
- `ls.ts`
- `web-fetch.ts`

## 权限系统

关键文件：

- `emain/agent/permissions.ts`
- `emain/agent/permissions.test.ts`

职责：

- 在 tool call 前做权限判断。
- 支持 allowlist。
- 支持 bench mode 或自动允许场景。
- 通过 `beforeToolCall` / `afterToolCall` hook 接入 agent loop。

## Renderer 交互

Renderer 侧类型：

- `frontend/types/custom.d.ts`

Renderer 调用：

```text
window.api.agent.createSession()
window.api.agent.listSessionsForCwd()
window.api.agent.send()
window.api.agent.abort()
window.api.agent.subscribe()
window.api.agent.unsubscribe()
```

事件流：

```text
emain agent runtime
  -> ipcMain emits agent:event
  -> preload receives one channel
  -> fan-out by sessionPath
  -> renderer agent UI updates
```

## 测试与评估

相关文件：

- `emain/agent/tools/tools.test.ts`
- `emain/agent/permissions.test.ts`
- `emain/agent/sessions.test.ts`
- `emain/agent/eval/`

评估目录：

- `emain/agent/eval/providers.ts`
- `emain/agent/eval/run-regression.ts`
- `emain/agent/eval/scenarios.ts`
- `emain/agent/eval/scenarios.test.ts`

## 常见扩展入口

### 新增 AI provider

1. 在 `emain/ai/providers/` 添加 provider 实现。
2. 在 registry 中注册 `api`。
3. 更新 model metadata。
4. 确认 `streamSimple()` 可找到 provider。
5. 更新 AI config UI 或 model resolver。

### 新增 Agent tool

1. 在 `emain/agent/tools/` 添加工具文件。
2. 在 `emain/agent/tools/index.ts` 注册。
3. 明确 cwd、输入 schema、输出格式和错误处理。
4. 如涉及危险操作，接入 permissions hook。
5. 添加 focused tests。

### 新增 preload API

1. 在 `emain/preload.ts` 暴露 API。
2. 在 `frontend/types/custom.d.ts` 更新 `ElectronApi`。
3. 在 `emain/emain-ipc.ts` 或独立 IPC 文件注册 handler。
4. Renderer 通过 `getApi()` 或 `window.api` 调用。

### 新增 Agent IPC

1. 修改 `emain/agent-ipc.ts` 注册 channel。
2. 修改 `preload.ts` agent API surface。
3. 修改 `custom.d.ts`。
4. 确保事件仍使用统一 `agent:event` channel，避免动态 channel 爆炸。

## 风险点

- Agent runtime 在 Electron main 进程中运行，长任务、shell、文件工具需要避免阻塞 UI 主流程。
- API key 和 secret 应在 main 进程解析，不应明文回传 renderer。
- `agent:event` 是单 channel fan-out 设计，新增事件时要保留 `sessionPath`。
- Agent JSONL session 是状态恢复基础，修改 timeline/event 结构时要考虑兼容读取。
- Electron preload surface 和 `custom.d.ts` 必须同步。
