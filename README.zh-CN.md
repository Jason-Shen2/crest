<p align="center">
  <img src="./docs/images/readme/logo.png" width="120" height="120" alt="Crest logo">
</p>

<h1 align="center">Crest</h1>

<p align="center"><strong>Agent 原生开发 Workspace，始终尽在掌控。</strong></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="./LICENSE"><img alt="许可证：Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="状态：POC / MVP" src="https://img.shields.io/badge/status-POC%20%2F%20MVP-orange.svg">
  <img alt="平台：macOS" src="https://img.shields.io/badge/platform-macOS-lightgrey.svg">
</p>

Crest 是一个 Agent 原生的开发 Workspace，将代码编辑器、终端、浏览器、Source Control 和 AI Agent 整合到同一个桌面应用中。Agent 可以在你的项目中读取、编辑和运行代码，而你对所有变更保持完全的可见性和控制权。

- **本地优先 & 隐私保护** — 自带 API Key，无需账号，无云端同步，无遥测。会话和凭据全部保存在本地。
- **项目级隔离** — 每个 Workspace 绑定一个工作目录，文件、终端、Git 状态和 Agent Session 均按项目隔离。
- **持久化会话** — Agent 对话在重启后仍然保留，可随时恢复任意会话继续工作。
- **内置 Agent Runtime** — 基于 in-tree 适配的 Pi (`earendil-works/pi v0.75.5`) 构建，提供有状态的 Turn 循环、工具执行、队列管理和上下文压缩。

> [!IMPORTANT]
> Crest 是尚未发布的 POC/MVP，API 和产品行为仍在演进中。

## 截图展示

<table>
  <tr>
    <td align="center">
      <img src="./docs/images/readme/code-editor-file-tree.png" alt="代码编辑器和文件树" />
      <br />
      <sub>代码编辑器和文件树</sub>
    </td>
    <td align="center">
      <img src="./docs/images/readme/code-review-diff.png" alt="AI Code Review 与 diff" />
      <br />
      <sub>AI Code Review 与 diff</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="./docs/images/readme/embedded-browser.png" alt="内置浏览器预览" />
      <br />
      <sub>内置浏览器预览</sub>
    </td>
    <td align="center">
      <img src="./docs/images/readme/source-control-graph.png" alt="Git 图谱与 Source Control" />
      <br />
      <sub>Git 图谱与 Source Control</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="./docs/images/readme/agent-session-panel.png" alt="Agent Session 与 AI 对话" />
      <br />
      <sub>Agent Session 与 AI 对话</sub>
    </td>
    <td align="center">
      <img src="./docs/images/readme/resume-session-picker.png" alt="恢复此前的 Agent Session" />
      <br />
      <sub>恢复此前的 Agent Session</sub>
    </td>
  </tr>
</table>

## 功能特性

### Agent Session

- 按项目隔离、可持久化和恢复的 Agent 对话
- 内置工具集：`read`、`write`、`edit`、`ls`、`bash`、`find`、`grep`、`web_fetch`
- 斜杠命令：`/new`、`/fork`、`/clone`、`/tree`、`/model` 等
- 支持 OpenAI、Anthropic、Google Gemini、MiniMax、OpenRouter 等模型 Provider
- 实时流式输出 Agent 思考过程、文本和工具调用

### 代码编辑器 & 文件浏览器

- 项目文件树导航
- 语法高亮代码编辑器
- 多标签页切换
- 集成的文件创建、重命名、删除操作

### 终端

- 内置终端模拟器，支持 PTY
- 多标签页终端会话
- 命令输出始终可见可检查
- Shell 工作目录追踪集成

### AI Code Review

- Agent 提议变更的并排 diff 视图
- 变更文件列表，显示增删行数
- 接受变更前可先行审阅

### Source Control

- Commit 图谱可视化
- 分支和提交历史
- 未提交变更面板
- 每个提交的作者、日期和变更统计

### 内置浏览器

- 用于网页搜索和查阅文档的内置浏览器
- 无需离开 Workspace 即可预览本地开发服务器
- 多标签页浏览，支持标准导航操作

## 快速开始

### 环境要求

- Node.js >= 22.12
- npm 10.9.2
- Go 1.25.6
- [Task](https://taskfile.dev/)

### 从源码运行

```bash
git clone https://github.com/crynta/crest.git
cd crest
npm install
task dev
```

推荐使用 `task dev` 作为启动入口，它会先构建 Go 后端和脚手架产物，再启动 Electron/Vite。

### 配置 AI Provider

Crest 采用自带密钥模式。首次运行时，创建 `~/.config/crest-dev/ai.json`（发行版使用 `~/.config/crest/ai.json`）：

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

支持的 Provider：OpenAI、Anthropic、Google Gemini、MiniMax、MiniMax-CN、OpenRouter。

## Agent Harness 架构

Crest 将 Agent 循环运行在 Electron 主进程中，确保凭据、工具执行和 Session 所有权不暴露给渲染进程，同时 UI 保持实时可检查的镜像状态。

![Agent Harness 架构图](./docs/images/readme/agent-harness-architecture.svg)

Pi 提供有状态的 `AgentHarness`：AI Provider 抽象、类型化事件流、指令队列、Hook、工具循环机制、上下文压缩和 Session 原语。Crest 提供桌面集成层：assistant-ui bridge、结构化 preload/IPC API、项目上下文组装、Crest 专属工具以及基于 SQLite `.db` 的 Session 持久化。

更多细节请参阅 [Agent 用户指南](./docs/agent-user-guide.md) 和 [Agent 架构文档](./docs/agent-architecture.md)。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React、TypeScript、Tailwind CSS、assistant-ui、Jotai |
| 桌面 | Electron（主进程 + 渲染进程） |
| 后端 | Go (wavesrv)、SQLite、WPS events、wsh RPC |
| Agent Runtime | Pi v0.75.5（in-tree 适配） |
| 构建 | Vite、Task、esbuild |

## 开发

| 命令 | 用途 |
| --- | --- |
| `task dev` | 完整开发流程：构建 Go 后端 + 启动 Electron/Vite |
| `npm run dev` | 仅启动 Electron/Vite（需预先构建后端） |
| `npm run build:dev` | 以开发模式构建 Electron 应用 |
| `npm run build:prod` | 以生产模式构建 Electron 应用 |
| `npm run test` | 运行 Vitest 测试套件 |

## 路线图

- [ ] MCP（Model Context Protocol）工具支持
- [ ] Agent 工作流的 Browser automation
- [ ] 交互式逐工具审批 UI
- [ ] 基于 `wsh` 的远程开发
- [ ] 更丰富的 Agent Session 组织和搜索
- [ ] 基于系统钥匙串的凭据存储

## 起源与致谢

Crest 最初基于 [Wave Terminal](https://github.com/wavetermdev/waveterm) 分叉开发，同时受到以下项目启发：

- **TRAE** — AI 辅助工程工作流探索
- **Warp** — AI 原生终端交互与可检查的工具执行
- **Terax** — Agent-first 界面模式与审阅工作流
- **Pi** — in-tree 适配的 Agent Runtime

第三方归属与许可证声明请参阅 [NOTICES.md](./NOTICES.md)。

## 许可证

[Apache License 2.0](./LICENSE)
