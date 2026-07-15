<h1 align="center">Crest</h1>

<p align="center"><strong>Agent-native development, without losing control.</strong></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="Status: POC / MVP" src="https://img.shields.io/badge/status-POC%20%2F%20MVP-orange.svg">
  <img alt="Platform: Desktop" src="https://img.shields.io/badge/platform-desktop-6e7681.svg">
</p>

![Crest workspace overview](./docs/images/readme/hero-overview.png)

> [!IMPORTANT]
> Crest is an unreleased POC/MVP. APIs, product behavior, and internal names are still evolving, and some Wave/WaveTerm legacy naming remains.

## Why Crest

Coding agents can now inspect, edit, run, and validate meaningful parts of a software project, but the surrounding tools still tend toward one of two extremes. Editor-first IDEs confine the agent to a sidebar and leave developers to shuttle context between files, terminals, browsers, and chat. Agent-only tools move faster, but often make it harder to inspect local state, intervene precisely, or review what changed.

Crest explores the middle ground: an agent-first development workspace where execution remains visible, interruptible, and reviewable. The Agent can work across the project while the developer keeps control of context, risk, and final decisions.

## Product Principles

1. **One Space = One Project.** Each Space is anchored to one working directory, keeping files, terminals, previews, Git state, and Agent Sessions scoped to the project that owns them.
2. **Agent-first workflow.** The Agent can gather context, edit files, run commands, use tools, and report results without forcing the developer to assemble the workflow across separate applications.
3. **Human-in-the-loop control.** Crest keeps tool activity, command output, and diffs visible so developers can redirect work, inspect risk, and decide what to accept.
4. **Focused workspace.** File Tree and Session History provide navigation in the left panel, while Editor, Browser, Terminal, Code Review, and Source Control share the tabbed Right Panel. The Browser supports web research and can also open a local app URL, while the full toolset stays available with only one active tool surface competing for attention.
5. **Review-centered development.** The core loop is discuss, execute, validate, and review, rather than treating generated code as the end of the task.

## Product Tour

### Project-scoped Agent Sessions

![Project-scoped Agent Sessions](./docs/images/readme/agent-session-panel.png)

Keep Agent work, tool calls, progress, and project context together in a persistent session.

### File Tree and Code Editor

![Crest File Tree and code editor](./docs/images/readme/code-editor-file-tree.png)

Navigate the repository and inspect or edit code without leaving the active workspace.

### Resume Sessions in Context

![Resume an Agent Session](./docs/images/readme/resume-session-picker.png)

Return to earlier Agent Sessions from the current project and continue with their conversation history intact.

### Source Control

![Crest Source Control graph](./docs/images/readme/source-control-graph.png)

Inspect branches, commits, and repository state from the shared Right Panel.

### Code Review

![Crest Code Review diff](./docs/images/readme/code-review-diff.png)

Review changes as a focused diff before deciding what belongs in the project.

### Built-in Browser

![Crest built-in Browser](./docs/images/readme/embedded-browser.png)

Browse the web and consult documentation without leaving the workspace. The Browser can also open a local app URL when you need to inspect a running project.

## What Works Today

Available now:

- Project-scoped Spaces.
- Persisted, resumable Agent Sessions and timelines.
- Terminal, File Tree, editor, Browser, Source Control, Preview, and Code Review surfaces.
- Model selection and slash commands.
- Registered Agent tools for reading, writing, and editing files, listing directories, running shell commands, finding files, searching text, and fetching web content (`read`, `write`, `edit`, `ls`, `bash`, `find`, `grep`, and `web_fetch`).
- Diff viewing and command review surfaces.

> [!WARNING]
> Fine-grained interactive tool approval is still incomplete. In the current v1 flow, tools may be allowed when no explicit allowlist is supplied. Run Crest only in environments where you understand and accept that risk.

## Quick Start

### Prerequisites

- Node.js >= 22.12
- npm 10.9.2
- Go 1.25.6
- [Task](https://taskfile.dev/)

### Run from Source

```bash
git clone https://github.com/Jason-Shen2/crest.git
cd crest
npm install
task dev
```

`task dev` is the preferred full-app entry point because it prepares the Go backend and required scaffold before starting Electron/Vite. Use `npm run dev` only when those dependencies are already prepared and you need the Electron/Vite development process by itself.

## Configure an AI Provider

Crest uses a bring-your-own-key model. When started with `task dev`, it reads provider credentials and the default model selection from `~/.config/crest-dev/ai.json`; a packaged release reads `~/.config/crest/ai.json`. Set `WAVETERM_CONFIG_HOME` to override the config home in either environment, in which case Crest reads `$WAVETERM_CONFIG_HOME/ai.json`. A valid configuration is required before the Agent can send a message.

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

Built-in provider entries currently include OpenAI, Anthropic, Google Gemini, minimax, minimax-cn, and OpenRouter. The inline `token` form above is convenient for a first run but stores the key as plaintext; see the [Agent User Guide](./docs/agent-user-guide.md) for keychain-backed credentials, profiles, custom models, and custom endpoints.

## Architecture

Crest is a desktop application with a React renderer, an Electron control plane, and a Go backend:

```text
React renderer
  |-> Electron preload API
  |     -> Electron main process
  |          -> Agent runtime and AI providers
  |          -> launches and connects to the Go backend
  |
  |-> wshrpc over WebSocket ---------\
  `-> HTTP /wave/service -------------+-> Go backend (wavesrv)
                                           -> WPS / SQLite / terminal controllers
```

The renderer owns the workspace UI. It uses the preload API for Electron capabilities and the Agent runtime, while connecting directly to the Go backend through `wshrpc` over WebSocket and `/wave/service` over HTTP. Electron provides desktop integration and launches the backend; the Go process owns terminal control, persisted workspace data, RPC, events, and remote-session infrastructure. For deeper reading, see the [project code wiki](./docs/code-wiki/README.md), [Agent architecture](./docs/agent-architecture.md), and [Agent runtime architecture](./docs/agent-runtime-architecture.md).

| Path | Responsibility |
| --- | --- |
| `frontend/` | React and TypeScript renderer, workspace UI, state, and product surfaces. |
| `emain/` | Electron main process, preload APIs, IPC, AI providers, and Agent runtime. |
| `pkg/` | Go libraries for storage, RPC, terminal control, events, connections, config, and services. |
| `cmd/wsh/` | `wsh` CLI entry point and command implementations. |
| `cmd/server/` | Local Go backend entry point, still named `wavesrv` in legacy code. |
| `db/` | Embedded SQLite migrations. |
| `docs/` | Architecture, product, runtime, and implementation documentation. |
| `schema/` | Configuration schemas copied into application builds. |

## Development

| Command | Purpose |
| --- | --- |
| `task dev` | Run the full development workflow: install dependencies, build the Go backend and scaffold, then start Electron/Vite. |
| `npm run dev` | Start Electron/Vite only. |
| `npm run start` | Preview an already built application. |
| `npm run build:dev` | Build the Electron application in development mode. |
| `npm run build:prod` | Build the Electron application in production mode. |
| `npm run test` | Run the Vitest test suite. |

## Status and Roadmap

Crest is an unreleased POC/MVP, not a stable distribution. APIs and product behavior may change, some Wave/WaveTerm names still remain, AI features require a valid local provider configuration, and fine-grained interactive approval is still being completed.

Current directions, not release promises:

- Stronger Agent Session creation, organization, and recovery.
- Complete command, diff, and Review workflows.
- Richer project-context organization.
- Remote development workflows.
- Browser automation for Agent workflows.
- MCP-based Agent tool execution.
- Clearer boundaries between automation, approval, and review.

## Origin and Acknowledgements

Crest began as a fork of [Wave Terminal](https://github.com/wavetermdev/waveterm) and retains parts of its terminal engine, Go backend, `wsh` tooling, and workspace architecture. Its Agent-native direction also draws on:

- **TRAE** for product exploration and an AI-assisted engineering workflow.
- **Warp** for AI-native terminal interaction, blocks, and inspectable tool execution.
- **Terax** for Agent-first interface patterns and Source Control and review workflows.
- **Pi** for coding-agent and Agent runtime foundations.

See [NOTICES.md](./NOTICES.md) for third-party attributions and license notices.

## License

Crest is licensed under the [Apache License 2.0](./LICENSE).
