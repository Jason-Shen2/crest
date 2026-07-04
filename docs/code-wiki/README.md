# Crest Code Wiki

本文档集是对当前仓库的结构化 Code Wiki，面向需要快速理解、维护或扩展 Crest/Wave Terminal 的开发者。

## 文档导航

- [项目总览](./01-project-overview.md)：产品定位、技术栈、仓库结构、核心概念。
- [整体架构](./02-system-architecture.md)：进程模型、启动链路、通信链路、数据流和依赖关系。
- [前端架构](./03-frontend-architecture.md)：React/Jotai、Workspace、Tab/Layout、Block/View、终端渲染。
- [后端架构](./04-backend-architecture.md)：Go `wavesrv`、WaveObj、SQLite、wshrpc、WPS、BlockController、JobManager。
- [Electron 与 AI Agent](./05-electron-ai-agent.md)：Electron main/preload/IPC、AI provider、agent runtime、tools、sessions。
- [运行构建与测试](./06-running-build-testing.md)：开发运行、构建打包、测试、代码生成、环境变量。
- [模块索引](./07-module-index.md)：关键目录、关键类/函数、常见扩展入口和阅读路线。

## 一句话架构

Crest 是一个 Electron 跨平台终端应用：渲染进程使用 React + TypeScript + Jotai 构建图形化终端界面，Electron main 进程负责窗口、IPC、本地 AI Agent 与系统能力，Go `wavesrv` 后端负责对象存储、终端/连接/任务控制、RPC、事件和本地 Web 服务，前后端通过 `wshrpc`、WebSocket、Unix domain socket、HTTP service 和 WPS 事件协同。

## 主要技术栈

- 前端：React 19、TypeScript、Jotai、Vite、Tailwind v4、Monaco、Mermaid、Shiki。
- Electron：electron-vite、Electron main/preload/renderer 三进程打包模型、electron-builder。
- 后端：Go、SQLite、gorilla/websocket、gorilla/mux、sqlx、cobra、fsnotify、gopsutil。
- 通信：自定义 `wshrpc`、WebSocket、Unix domain socket、HTTP `/wave/service`、Wave PubSub。
- AI：Anthropic、Google GenAI、OpenAI SDK、自定义 provider registry、main 进程内 agent runtime。
- 子项目：`tsunami` Go/TS VDOM 应用框架与 scaffold 系统。

## 建议阅读顺序

1. 先读 [项目总览](./01-project-overview.md) 建立术语和目录地图。
2. 再读 [整体架构](./02-system-architecture.md) 理解进程、通信和数据流。
3. 做 UI/终端相关开发时读 [前端架构](./03-frontend-architecture.md)。
4. 做 RPC、对象、命令块、连接、任务相关开发时读 [后端架构](./04-backend-architecture.md)。
5. 做 AI、agent、provider、IPC 或窗口能力相关开发时读 [Electron 与 AI Agent](./05-electron-ai-agent.md)。
6. 开始本地运行、测试、打包或代码生成前读 [运行构建与测试](./06-running-build-testing.md)。
7. 需要定位文件或入口时查 [模块索引](./07-module-index.md)。

## 维护约定

- 文档内容基于当前仓库源码生成，路径均相对仓库根目录。
- 修改 `pkg/wshrpc/wshrpctypes.go` 后需要运行 `task generate` 更新生成的 TypeScript 绑定。
- 不要手动编辑 `frontend/types/gotypes.d.ts`、`frontend/app/store/wshclientapi.ts` 等生成文件。
- `frontend/app/term/nld/` 使用 `edgeFlow.js`；集成时若写 workaround，需要按仓库规则记录到 sibling repo 的集成日志。
