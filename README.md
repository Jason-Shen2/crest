# Crest

Crest is an AI-native development workspace for vibe coding.

It brings the terminal, files, editor, browser previews, agent sessions, tool execution, and human review into one project-scoped workspace. The goal is not to add another chat sidebar to a traditional IDE. Crest treats the AI agent as a first-class development actor while keeping the human developer in control of direction, risk, and review.

> Status: Crest is an unreleased POC / MVP. The codebase is actively changing, and some internal names still carry Wave / WaveTerm legacy naming.

## Why Crest

Modern coding workflows are changing. Agents now write, edit, run, and validate a meaningful portion of software work. The developer's role is shifting toward problem framing, context design, decision making, risk control, and code review.

Most tools still sit at one of two extremes:

- Traditional IDEs keep the editor at the center and place the agent in a side panel. The user still has to copy context around, switch between terminal, browser, files, and chat, then manually verify the result.
- Agent-only tools let the agent drive the task, but often remove the IDE-like sense of control: reading code, inspecting diffs, watching terminal output, opening previews, and intervening locally.

Crest explores the middle ground: an agent-first development workspace that still feels inspectable, interruptible, and reviewable.

## Core Ideas

- **Project-scoped spaces** - A Space maps to one working directory. Files, terminals, browser previews, git state, and agent conversations stay isolated per project.
- **Agent-first workflow** - The agent can understand project context, inspect files, run commands, edit code, and summarize progress inside the same workspace.
- **Human-in-the-loop control** - High-impact actions go through permission checks, command review, and diff preview before they are accepted.
- **Unified development surface** - Terminal blocks, editors, web views, previews, and agent conversations live in a drag-and-drop workspace instead of separate windows.
- **Review-centered development** - Crest is designed around the loop of discussion, execution, validation, and review rather than only around manual code editing.

## Current Capabilities

- Agent sessions with persisted timelines, tool calls, streaming state, and resumable history.
- Terminal blocks backed by the existing Wave/WaveTerm terminal engine and `wshrpc` backend.
- File explorer, editor, web/preview blocks, and source-control surfaces inside the same workspace layout.
- Tool execution for reading files, editing files, observing terminal state, running shell commands, and asking the user for decisions.
- Permission and review flows for sensitive operations, including command approval and diff review.
- Space = Project direction, where each workspace is anchored to one working directory and agent sessions are grouped by project.

## Getting Started

Clone the repository:

```bash
git clone https://github.com/Jason-Shen2/crest.git
cd crest
```

Install dependencies:

```bash
npm install
```

Run the Electron development app:

```bash
npm run dev
```

Build the app:

```bash
npm run build:prod
```

Useful scripts:

- `npm run dev` - start the Electron/Vite development app.
- `npm run start` - preview the built Electron app.
- `npm run build:dev` - build in development mode.
- `npm run build:prod` - build in production mode.
- `npm run test` - run Vitest tests.

## Project Structure

| Path | Purpose |
| --- | --- |
| `frontend/` | Electron renderer UI built with React, TypeScript, Jotai, Tailwind, assistant-ui, and Monaco. |
| `emain/` | Electron main process, preload APIs, IPC, window management, AI providers, and agent runtime. |
| `pkg/` | Go backend libraries for storage, RPC, terminal control, events, connections, jobs, config, and web services. |
| `cmd/wsh/` | The `wsh` CLI entry point and command implementations. |
| `cmd/server/` | The local backend server entry point, still named `wavesrv` in legacy code. |
| `db/` | SQLite migrations embedded into the backend. |
| `docs/` | Architecture notes, agent runtime docs, implementation plans, and design records. |
| `schema/` | Configuration JSON schemas copied into the app bundle during builds. |
| `tsunami/` | Internal UI/scaffolding subsystem inherited from the Wave codebase. |

## Architecture

Crest is a hybrid Electron + Go desktop app:

```text
React renderer
  -> Electron preload API
  -> Electron main process
  -> Agent runtime and AI providers
  -> Go backend process
  -> wshrpc / WPS / SQLite / terminal controllers
```

The renderer owns the workspace UI. The Electron main process owns local desktop integration and the agent runtime. The Go backend owns the terminal engine, persisted workspace objects, RPC surface, filesystem-backed block data, and remote/session infrastructure.

## Agent Runtime

The native agent runtime lives under `emain/agent/`. It manages:

- sessions and timeline persistence;
- model/provider access;
- streaming responses;
- tool calls;
- user approvals;
- command and file-operation review;
- communication with renderer UI through preload IPC.

The UI is being moved toward assistant-ui primitives while keeping Crest's project-scoped session model and local runtime behavior.

## Origin

Crest began as a fork of Wave Terminal and still uses parts of the Wave/WaveTerm architecture, naming, terminal engine, `wsh` CLI, and Go backend structure. The product direction has shifted toward an AI-native development workspace centered on agent execution, project isolation, and human review.

Several agent-related modules also reference behavior and UX patterns from Warp Terminal. See [NOTICES.md](./NOTICES.md) for third-party notices and attribution details.

## License

Crest is licensed under the Apache-2.0 License. Dependency acknowledgements are listed in [ACKNOWLEDGEMENTS.md](./ACKNOWLEDGEMENTS.md), and additional third-party notices are listed in [NOTICES.md](./NOTICES.md).
