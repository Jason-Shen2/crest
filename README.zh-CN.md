<h1 align="center">Crest</h1>

<p align="center"><strong>Agent 原生开发，始终尽在掌控。</strong></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="./LICENSE"><img alt="许可证：Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="状态：POC / MVP" src="https://img.shields.io/badge/status-POC%20%2F%20MVP-orange.svg">
  <img alt="平台：桌面端" src="https://img.shields.io/badge/platform-desktop-6e7681.svg">
</p>

![Crest Workspace 概览](./docs/images/readme/hero-overview.png)

> [!IMPORTANT]
> Crest 是尚未发布的 POC/MVP。API、产品行为和内部命名仍在演进，部分 Wave/WaveTerm 历史命名尚有保留。

## 为什么选择 Crest

如今，Coding Agent 已能检查、编辑、运行并验证软件项目中有实质意义的环节，但配套工具往往走向两个极端。以编辑器为中心的 IDE 把 Agent 限制在侧边栏中，开发者仍要在文件、终端、浏览器和对话间来回搬运上下文。纯 Agent 工具虽然更快，却常常让本地状态更难检查、过程更难精准干预、变更更难审阅。

Crest 探索的是中间路径：一个以 Agent 为先的开发 Workspace，同时让执行过程保持可见、可中断、可审阅。Agent 可以在整个项目中工作，开发者则始终掌控上下文、风险与最终决策。

## 产品原则

1. **一个 Space 对应一个项目。** 每个 Space 都绑定一个工作目录，让文件、终端、预览、Git 状态和 Agent Session 始终限定在所属项目内。
2. **Agent-first 工作流。** Agent 可以收集上下文、编辑文件、运行命令、使用工具并汇报结果，无需开发者跨多个应用手动拼装工作流。
3. **Human-in-the-loop 控制。** Crest 持续展示工具活动、命令输出和 diff，让开发者能够调整方向、评估风险并决定接受哪些变更。
4. **专注的 Workspace。** 左侧面板通过 File Tree 和 Session History 提供导航，Editor、Browser、Terminal、Code Review 与 Source Control 则共享带标签页的 Right Panel。Browser 既支持网页研究，也能打开本地应用 URL；完整工具集始终可用，但一次只展示一个工具界面，避免多个界面同时分散注意力。
5. **以审阅为中心的开发。** 核心循环是讨论、执行、验证与审阅，而不是把生成代码视为任务终点。

## 产品导览

### 项目级 Agent Session

![项目级 Agent Session](./docs/images/readme/agent-session-panel.png)

在持久化 Session 中集中保留 Agent 工作、工具调用、进度与项目上下文。

### File Tree 与代码编辑器

![Crest File Tree 与代码编辑器](./docs/images/readme/code-editor-file-tree.png)

无需离开当前 Workspace，即可浏览仓库并检查或编辑代码。

### 在上下文中恢复 Session

![恢复 Agent Session](./docs/images/readme/resume-session-picker.png)

在当前项目内恢复此前的 Agent Session，并保留完整对话历史继续工作。

### Source Control

![Crest Source Control 图谱](./docs/images/readme/source-control-graph.png)

在共享的 Right Panel 中检查分支、提交和仓库状态。

### Code Review

![Crest Code Review diff](./docs/images/readme/code-review-diff.png)

通过聚焦的 diff 审阅变更，再决定哪些内容应进入项目。

### 内置 Browser

![Crest 内置 Browser](./docs/images/readme/embedded-browser.png)

无需离开 Workspace，即可浏览网页和查阅文档。需要检查正在运行的项目时，Browser 也可以打开本地应用 URL。

## 当前可用能力

现已支持：

- 项目级 Space。
- 可持久化、可恢复的 Agent Session 与时间线。
- Terminal、File Tree、Editor、Browser、Source Control、Preview 和 Code Review 界面。
- 模型选择与斜杠命令。
- 已注册用于读取、写入和编辑文件、列出目录、运行 shell 命令、查找文件、搜索文本与抓取网页内容的 Agent 工具（`read`、`write`、`edit`、`ls`、`bash`、`find`、`grep` 和 `web_fetch`）。
- diff 查看与命令审阅界面。

> [!WARNING]
> 细粒度交互式工具审批仍未完成。在当前 v1 流程中，如果未提供明确的 allowlist，工具可能会被允许执行。请仅在你理解并接受该风险的环境中运行 Crest。

## 快速开始

### 环境要求

- Node.js >= 22.12
- npm 10.9.2
- Go 1.25.6
- [Task](https://taskfile.dev/)

### 从源码运行

```bash
git clone https://github.com/Jason-Shen2/crest.git
cd crest
npm install
task dev
```

`task dev` 是启动完整应用的推荐入口，因为它会先准备 Go 后端和必要的 Tsunami 构建产物，再启动 Electron/Vite。仅当这些依赖已经就绪、且只需运行 Electron/Vite 开发进程时，才使用 `npm run dev`。

## 配置 AI Provider

Crest 采用自带密钥模式。通过 `task dev` 启动时，Crest 默认从 `~/.config/crest-dev/ai.json` 读取 Provider 凭据与默认模型配置；发行版默认读取 `~/.config/crest/ai.json`。两种环境均可通过 `WAVETERM_CONFIG_HOME` 覆盖 config home，此时 Crest 会读取 `$WAVETERM_CONFIG_HOME/ai.json`。Agent 必须获得有效配置后才能发送消息。

```json
{
    "providers": {
        "openai": {
            "token": "YOUR_API_KEY"
        }
    },
    "default": {
        "provider": "openai",
        "model": "gpt-4.1"
    }
}
```

目前内置的 Provider 包括 OpenAI、Anthropic、Google Gemini、minimax、minimax-cn 和 OpenRouter。上面的内联 `token` 形式便于首次运行，但会以明文存储密钥；如需了解基于钥匙串的凭据、Profile、自定义模型和自定义端点，请参阅 [Agent 用户指南](./docs/agent-user-guide.md)。

## Agent Harness 架构

Crest 将 Agent loop 移入 Electron main，是为了让本地 Provider 凭据、Tool 执行、Session 所有权和桌面集成留在渲染进程之外，同时让 UI 只作为实时、可检查的镜像。Runtime 基于 `earendil-works/pi v0.75.5` 改造并内置于仓库中；Crest 不是通过已发布的 Pi npm package 使用它，也不是完整复用 Pi CLI/TUI。

![Crest Agent Harness architecture](./docs/images/readme/agent-harness-architecture.svg)

Pi 提供有状态的 `AgentHarness`、AI Provider 抽象、类型化事件流、steering 与 follow-up 队列、hooks、Tool loop 机制、compaction 和 Session primitives。Crest 则提供外围桌面集成：assistant-ui bridge、`usePiChat`、结构化 preload/IPC API、`PaneAgentSession`、项目 Context 组装、Crest 专属 tools，以及基于 SQLite 的 Session 持久化。

职责边界如下：

| 层级 | 归属 | 职责 |
| --- | --- | --- |
| Agent Workspace UI | Crest | 渲染 thread、composer、tool 状态、diff 和项目界面，但不作为状态真相源。 |
| Session owner + IPC | Crest | 按 session path 路由一条 `agent:event` stream，并通过 `PaneAgentSession` 持有 authoritative messages、turns、queues 和 status。 |
| Agent Harness | Pi adapted in-tree | 运行有状态 turn loop、流式输出 typed events、执行 hooks、管理队列、调用 tools 并压缩 Context。 |
| Runtime foundations | Crest + Pi | Pi 通过 Provider 抽象进行 streaming；Crest 绑定项目 tools，并把 Session 持久化为 SQLite-backed `.db` 文件。 |

一次 Agent Turn 包含五个阶段：Crest 将当前 cwd、项目指令、skills、history 和 active tools 组装为 Context；Pi 流式输出 thinking、文本和结构化 Tool Call；Crest 在权限边界内校验并执行所需 tools；Session 将持久事件追加到 SQLite `.db` carrier；随后 UI 反映实时事件流，并能在之后从持久化状态重建同一条 timeline。Tool results 会重新进入 Context，直到 Harness 完成该 turn。JSONL 仍可用于 Session import/export，但它是交换格式，不是磁盘上的 Session carrier。

这个设计让 Agent 工作保持可检查、项目级隔离、重启后可恢复，并适配 Human-in-the-loop 控制：渲染进程展示已经发生的事，Electron main 持有正在发生的事，持久化 Session 状态承载可以恢复的事。

## 架构

Crest 是一款桌面应用，分为渲染进程、Electron main 和本地 Go 后端。渲染进程负责 Workspace UI，Electron main 负责桌面集成与 Agent Runtime 编排，Go 进程负责终端控制、Workspace 持久化、RPC、事件和远程 Session 基础设施。深入了解请参阅[项目代码 Wiki](./docs/code-wiki/README.md)、[Agent 架构](./docs/agent-architecture.md)和 [Agent Runtime 架构](./docs/agent-runtime-architecture.md)。

| 路径 | 方向 | 用途 |
| --- | --- | --- |
| React renderer | UI surface | File Tree、Editor、Browser、Terminal、Source Control、Code Review、Agent thread 和审阅界面。 |
| Electron preload/IPC | Renderer to Electron main | 桌面 API、Agent Session 操作、实时 `agent:event` streaming、模型/Provider 访问和 Tool 编排。 |
| Electron main | Control plane | 运行 Agent Runtime，避免 Provider 凭据进入渲染进程，启动 Go 后端，并协调桌面能力。 |
| `wshrpc` WebSocket | Renderer to Go backend | Workspace、block、terminal、connection 和 service 操作的结构化 RPC。 |
| `/wave/service` HTTP | Renderer to Go backend | 面向历史 Wave/WaveTerm 后端能力的 HTTP service path。 |
| Go backend (`wavesrv`) | Local backend | Terminal controllers、WPS events、SQLite-backed Workspace 数据、remote sessions、config 和 services。 |

| 路径 | 职责 |
| --- | --- |
| `frontend/` | 基于 React 和 TypeScript 的渲染层，负责 Workspace 界面、状态和各项产品功能。 |
| `emain/` | Electron 主进程，负责 preload API、进程间通信（IPC）、AI Provider 和 Agent Runtime。 |
| `pkg/` | 用于存储、RPC、终端控制、事件、连接、配置和服务的 Go 库。 |
| `cmd/wsh/` | `wsh` CLI 入口及命令实现。 |
| `cmd/server/` | 本地 Go 后端入口，在历史代码中仍名为 `wavesrv`。 |
| `db/` | 内嵌的 SQLite 数据库迁移。 |
| `docs/` | 架构、产品、Runtime 和实现文档。 |
| `schema/` | 构建应用时复制的配置 Schema。 |

## 开发

| 命令 | 用途 |
| --- | --- |
| `task dev` | 运行完整开发流程：安装依赖、构建 Go 后端和 Tsunami 构建产物，然后启动 Electron/Vite。 |
| `npm run dev` | 仅启动 Electron/Vite。 |
| `npm run start` | 预览已构建的应用。 |
| `npm run build:dev` | 以开发模式构建 Electron 应用。 |
| `npm run build:prod` | 以生产模式构建 Electron 应用。 |
| `npm run test` | 运行 Vitest 测试套件。 |

## 状态与路线图

Crest 是尚未发布的 POC/MVP，并非稳定发行版。API 和产品行为可能变化，部分 Wave/WaveTerm 命名仍有保留，AI 功能需要有效的本地 Provider 配置，细粒度交互式审批也仍在完善。

当前方向，并非发布承诺：

- 增强 Agent Session 的创建、组织与恢复能力。
- 完善命令、diff 和 Review 工作流。
- 提供更丰富的项目上下文组织能力。
- 支持远程开发工作流。
- 探索用于 Agent 工作流的 Browser automation。
- 探索基于 MCP 的 Agent tool execution。
- 更清晰地区分自动化、审批与审阅的边界。

## 起源与致谢

Crest 最初基于 [Wave Terminal](https://github.com/wavetermdev/waveterm) 分叉开发，并保留了其部分终端引擎、Go 后端、`wsh` 工具和 Workspace 架构。Crest 的 Agent 原生方向也受到以下项目启发：

- **TRAE**：产品探索与 AI 辅助工程工作流。
- **Warp**：AI 原生终端交互、block 与可检查的工具执行。
- **Terax**：Agent-first 界面模式，以及 Source Control 和审阅工作流。
- **Pi**：仓库内改造的 Agent runtime、AI Provider 抽象和部分 Coding Agent 行为。

第三方归属与许可证声明请参阅 [NOTICES.md](./NOTICES.md)。

## 许可证

Crest 采用 [Apache License 2.0](./LICENSE)。
