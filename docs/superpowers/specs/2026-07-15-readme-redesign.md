# Crest README Redesign

## Goal

Replace the current compact README with a mature open-source project landing page that serves two audiences without mixing their paths:

1. New visitors should understand what Crest is, why it exists, and what the product looks like within 30 seconds.
2. Users and contributors should find accurate setup, configuration, architecture, development, status, and attribution information without searching the repository.

The primary README is English. A complete Simplified Chinese version mirrors the same structure and content.

## Design Direction

Use a product-and-engineering balanced structure.

- The top of the page establishes product identity with a concise tagline, language switcher, a small set of meaningful badges, a clear development-status notice, and a real product screenshot.
- The middle explains the problem, product principles, and current product surfaces with a screenshot-led tour.
- The lower half provides verified setup, AI provider configuration, architecture, project structure, development commands, limitations, roadmap, acknowledgements, and licensing.
- The README must remain honest about the unreleased POC/MVP status and incomplete fine-grained tool approval.

Avoid decorative badge walls, legacy Wave screenshots, aspirational claims presented as shipped features, and duplicate prose between adjacent sections.

## Files

- `README.md`: canonical English README.
- `README.zh-CN.md`: complete Simplified Chinese translation.
- `docs/images/readme/agent-session-panel.png`: hero image and Agent session feature.
- `docs/images/readme/code-editor-file-tree.png`: editor and file-tree feature.
- `docs/images/readme/resume-session-picker.png`: project-scoped session recovery.
- `docs/images/readme/source-control-graph.png`: source-control feature.
- `docs/images/readme/code-review-diff.png`: review feature.
- `docs/images/readme/embedded-browser.png`: browser and preview feature.

The screenshots come from the current Crest product and replace all Wave legacy imagery in the README.

## Information Architecture

### 1. Hero

- Centered project name.
- One-line positioning: an agent-native development workspace for vibe coding.
- `English | 简体中文` switcher linking between both README files.
- Minimal badges: license, development status, Electron/desktop positioning. Do not show CI or release badges unless a real public workflow or release exists.
- Hero screenshot: Agent Session list plus the main Agent tab because it communicates the central product idea better than a generic editor view.
- Short status alert explaining that Crest is an unreleased POC/MVP.

### 2. Why Crest

Explain the gap between editor-first IDE products and agent-only products. Position Crest as the middle ground: the Agent drives execution while the developer retains local visibility, intervention, and review.

### 3. Product Principles

Use five concise principles:

- One Space = One Project.
- Agent-first workflow.
- Human-in-the-loop control.
- Focused workspace.
- Review-centered development.

The focused-workspace principle must explain the layout:

- Left panel contains navigation surfaces such as File Tree and Session History.
- Browser, Terminal, Code Review, Source Control, and Preview are unified in the Right Panel and switched through tabs.
- This preserves access to a complete toolset while keeping only one active tool surface visible, reducing context switching and visual noise.

### 4. Product Tour

Use the six real screenshots. Each screenshot gets a short heading and no more than two sentences:

1. Project-scoped Agent Sessions.
2. File Tree and Code Editor.
3. Resume Session picker.
4. Source Control graph.
5. Code Review diff.
6. Built-in Browser.

Avoid repeating the same feature list before and after the gallery.

### 5. Current Capabilities

Split features by maturity:

- Available now: project-scoped spaces, Agent sessions, persisted timelines, terminal blocks, file/editor/browser/source-control surfaces, slash commands, model selection, tool execution, diff viewing, MCP integration.
- Experimental/in progress: fine-grained interactive approval, broader packaging/distribution, remaining Wave naming cleanup.

### 6. Quick Start

State verified prerequisites:

- Node.js and npm 10.9.2-compatible tooling.
- Go 1.25.6.
- Task.

Use this primary flow:

```bash
git clone https://github.com/Jason-Shen2/crest.git
cd crest
npm install
task dev
```

Explain that `task dev` is preferred because it builds the Go backend and scaffold before starting Electron/Vite. Keep `npm run dev` in the development-command reference, not as the primary setup path.

### 7. Configure an AI Provider

Document the BYO-key model and `~/.config/crest/ai.json`. Include one minimal configuration example and link to the detailed Agent user guide.

Mention currently built-in provider entries: OpenAI, Anthropic, Google Gemini, minimax, minimax-cn, and OpenRouter. Do not claim that the forthcoming `crest secret set` command is available.

### 8. Architecture and Repository Map

Provide:

- A compact text diagram covering React renderer, Electron preload/main, Agent runtime/providers, Go backend, wshrpc/WPS/SQLite/terminal controllers.
- A repository table for `frontend/`, `emain/`, `pkg/`, `cmd/wsh/`, `cmd/server/`, `db/`, `docs/`, and `schema/`.

Keep architecture explanation concise and link to deeper repository docs.

### 9. Development

List verified commands:

- `task dev`
- `npm run dev`
- `npm run start`
- `npm run build:dev`
- `npm run build:prod`
- `npm run test`

Clarify the difference between the full development workflow and Electron/Vite-only commands.

### 10. Status, Limitations, and Roadmap

State explicitly:

- Crest is an unreleased POC/MVP.
- APIs and internal naming are changing.
- Some Wave/WaveTerm legacy names remain.
- AI requires a valid local provider configuration.
- Fine-grained interactive tool approval is incomplete, and current v1 behavior may permit all tools when no allowlist is supplied.

The roadmap should describe directions, not promises:

- stronger Agent Session management;
- complete Review workflow;
- richer context organization;
- remote development;
- clearer automation/approval/review boundaries.

### 11. Origin, Acknowledgements, and License

Explain that Crest originated from Wave Terminal and retains parts of its architecture and terminal engine.

Credit:

- TRAE for product exploration and engineering workflow;
- Warp for AI-native terminal and block-based interaction inspiration;
- Terax for Agent-first interface inspiration;
- Pi for Agent runtime and coding-agent foundations.

Link to `NOTICES.md` and the Apache-2.0 `LICENSE`. Do not link to a nonexistent acknowledgement or contributing file.

## Language Synchronization

`README.md` and `README.zh-CN.md` must:

- use identical section ordering;
- use the same screenshots and relative links;
- contain equivalent status and limitation disclosures;
- link to each other at the top;
- keep code blocks and configuration examples identical.

English copy should be concise and idiomatic. Chinese copy should use common English product and engineering terms when forced translations would be awkward, including Agent, Workspace, Right Panel, Code Review, Source Control, Preview, Session, Runtime, and Human-in-the-loop.

## Validation

- Verify every relative link resolves to an existing repository file.
- Verify all six screenshots render through relative paths.
- Verify all documented commands exist in `package.json` or `Taskfile.yml`.
- Verify prerequisites match `go.mod` and `package.json`.
- Compare both READMEs section by section for parity.
- Inspect `git diff` and ensure only README-related files and the design/plan documents are included.

## Out of Scope

- Creating releases, installers, CI workflows, contribution policies, or a project website.
- Rebranding all Wave legacy assets or internal symbols.
- Implementing missing product capabilities mentioned in the roadmap.
- Adding decorative logos or generated marketing artwork.
