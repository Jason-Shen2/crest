# Crest README Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Crest's compact README into a bilingual, screenshot-led open-source project landing page with accurate product, setup, architecture, status, and attribution information.

**Architecture:** `README.md` remains the canonical English entry point and `README.zh-CN.md` mirrors it in Simplified Chinese. Six current Crest screenshots live under `docs/images/readme/` and are shared by both documents. Product positioning comes first; verified engineering and contributor information follows without claiming unfinished features as stable.

**Tech Stack:** Markdown, GitHub-rendered HTML, Electron, React, Go, Taskfile, repository-relative image assets

---

### Task 1: Add Current Product Screenshots

**Files:**
- Create: `docs/images/readme/agent-session-panel.png`
- Create: `docs/images/readme/code-editor-file-tree.png`
- Create: `docs/images/readme/resume-session-picker.png`
- Create: `docs/images/readme/source-control-graph.png`
- Create: `docs/images/readme/code-review-diff.png`
- Create: `docs/images/readme/embedded-browser.png`

- [ ] **Step 1: Create the README image directory**

Run:

```bash
mkdir -p docs/images/readme
```

Expected: `docs/images/readme/` exists.

- [ ] **Step 2: Copy the selected current-product screenshots**

Run:

```bash
cp /Users/bytedance/Desktop/demo/agent-session-panel.png docs/images/readme/
cp /Users/bytedance/Desktop/demo/code-editor-file-tree.png docs/images/readme/
cp /Users/bytedance/Desktop/demo/resume-session-picker.png docs/images/readme/
cp /Users/bytedance/Desktop/demo/source-control-graph.png docs/images/readme/
cp /Users/bytedance/Desktop/demo/code-review-diff.png docs/images/readme/
cp /Users/bytedance/Desktop/demo/embedded-browser.png docs/images/readme/
```

Expected: all six files exist under `docs/images/readme/`.

- [ ] **Step 3: Verify image dimensions and file types**

Run:

```bash
file docs/images/readme/*
```

Expected: six valid PNG images with non-zero dimensions.

- [ ] **Step 4: Commit the screenshot assets**

```bash
git add docs/images/readme
git commit -m "docs: add Crest product screenshots"
```

### Task 2: Rewrite the English README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the hero**

Use a centered GitHub-compatible HTML hero with:

```html
<h1 align="center">Crest</h1>
<p align="center"><strong>Agent-native development, without losing control.</strong></p>
<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>
```

Add only meaningful badges:

```markdown
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
![Status](https://img.shields.io/badge/status-POC%20%2F%20MVP-orange.svg)
![Desktop](https://img.shields.io/badge/platform-desktop-6e7681.svg)
```

Render the hero screenshot immediately afterward:

```markdown
![Crest Agent workspace](./docs/images/readme/agent-session-panel.png)
```

Add this explicit status notice:

```markdown
> [!IMPORTANT]
> Crest is an unreleased POC/MVP. APIs, product behavior, and internal names are still evolving, and some Wave/WaveTerm legacy naming remains.
```

- [ ] **Step 2: Add the product narrative**

Use these sections and claims:

```markdown
## Why Crest
## Product Principles
```

`Why Crest` must compare editor-first IDEs and agent-only tools, then position Crest as the inspectable, interruptible, reviewable middle ground.

`Product Principles` must contain:

1. `One Space = One Project`
2. `Agent-first workflow`
3. `Human-in-the-loop control`
4. `Focused workspace`
5. `Review-centered development`

The `Focused workspace` paragraph must state that File Tree and Session History are navigation in the left panel, while Browser, Terminal, Code Review, Source Control, and Preview share the tabbed Right Panel. Explain that this keeps the complete toolset available while only one active tool surface occupies attention.

- [ ] **Step 3: Add the screenshot-led Product Tour**

Create `## Product Tour` with six subsections in this order:

```markdown
### Project-scoped Agent Sessions
### File Tree and Code Editor
### Resume Sessions in Context
### Source Control
### Code Review
### Built-in Browser
```

Each subsection must include its corresponding `./docs/images/readme/*.png` image and no more than two concise explanatory sentences.

- [ ] **Step 4: Separate shipped and experimental capabilities**

Create `## What Works Today` with an `Available now` list:

- project-scoped Spaces;
- persisted/resumable Agent Sessions and timelines;
- terminal, file, editor, browser, Source Control, and Code Review surfaces;
- model selection and slash commands;
- file, shell, workspace, web, browser, and MCP tool integration;
- diff viewing and command review surfaces.

Follow it with:

```markdown
> [!WARNING]
> Fine-grained interactive tool approval is still incomplete. In the current v1 flow, tools may be allowed when no explicit allowlist is supplied. Run Crest only in environments where you understand and accept that risk.
```

- [ ] **Step 5: Correct the Quick Start**

Create `## Quick Start` with:

````markdown
### Prerequisites

- Node.js with npm compatible with the repository-pinned npm 10.9.2
- Go 1.25.6
- [Task](https://taskfile.dev/)

### Run from source

```bash
git clone https://github.com/Jason-Shen2/crest.git
cd crest
npm install
task dev
```
````

Explain that `task dev` is preferred because it prepares the Go backend and required scaffold before Electron/Vite starts. Do not present `npm run dev` as the default full-app setup.

- [ ] **Step 6: Add verified AI provider configuration**

Create `## Configure an AI Provider`. State that Crest uses a BYO-key model and reads `~/.config/crest/ai.json`.

Use this minimal example:

```json
{
    "providers": {
        "openai": {
            "type": "openai",
            "token": "YOUR_API_KEY"
        }
    },
    "default": {
        "provider": "openai",
        "model": "gpt-4.1"
    }
}
```

State that built-in provider entries currently include OpenAI, Anthropic, Google Gemini, minimax, minimax-cn, and OpenRouter. Link to `docs/agent-user-guide.md`. Do not document `crest secret set` as an available command.

- [ ] **Step 7: Add architecture and repository map**

Create `## Architecture` with:

```text
React renderer
  -> Electron preload API
  -> Electron main process
      -> Agent runtime and AI providers
      -> Go backend process
          -> wshrpc / WPS / SQLite / terminal controllers
```

Add a compact table for `frontend/`, `emain/`, `pkg/`, `cmd/wsh/`, `cmd/server/`, `db/`, `docs/`, and `schema/`. Link deeper reading to existing documentation only.

- [ ] **Step 8: Add development, roadmap, origin, credits, and license**

Create these sections:

```markdown
## Development
## Status and Roadmap
## Origin and Acknowledgements
## License
```

`Development` must distinguish:

- `task dev`: full development workflow;
- `npm run dev`: Electron/Vite only;
- `npm run start`: preview a built app;
- `npm run build:dev`;
- `npm run build:prod`;
- `npm run test`.

`Status and Roadmap` must describe directions rather than promises: stronger Session management, complete Review workflows, richer context organization, remote development, and clearer automation/approval/review boundaries.

`Origin and Acknowledgements` must credit Wave Terminal, TRAE, Warp, Terax, and Pi with specific influence, then link `NOTICES.md`.

`License` must link `LICENSE` and state Apache-2.0. Remove the nonexistent `ACKNOWLEDGEMENTS.md` link.

- [ ] **Step 9: Review the English README**

Run:

```bash
grep -nE '^#{1,3} ' README.md
grep -nE 'README.zh-CN|docs/images/readme|agent-user-guide|NOTICES|LICENSE' README.md
```

Expected: complete section hierarchy and only valid relative targets.

- [ ] **Step 10: Commit the English README**

```bash
git add README.md
git commit -m "docs: expand English project README"
```

### Task 3: Create the Simplified Chinese README

**Files:**
- Create: `README.zh-CN.md`

- [ ] **Step 1: Mirror the English structure**

Use the same section order, screenshot order, alerts, code blocks, configuration example, badges, and relative links as `README.md`.

The hero language switcher must be:

```html
<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>
```

- [ ] **Step 2: Translate product copy idiomatically**

Use common English terms where forced translation would be less clear:

- Agent
- Workspace
- Right Panel
- File Tree
- Session History
- Code Review
- Source Control
- Preview
- Runtime
- Human-in-the-loop

Translate meaning rather than sentence structure. Keep the tone concise and product-oriented.

- [ ] **Step 3: Preserve technical truth**

The Chinese version must carry the same disclosures:

- unreleased POC/MVP;
- Wave/WaveTerm legacy naming remains;
- valid `ai.json` is required;
- fine-grained interactive approval is incomplete;
- no claim that `crest secret set` exists.

- [ ] **Step 4: Compare section parity**

Run:

```bash
grep -nE '^#{1,3} ' README.md
grep -nE '^#{1,3} ' README.zh-CN.md
```

Expected: identical section count and corresponding ordering.

- [ ] **Step 5: Commit the Chinese README**

```bash
git add README.zh-CN.md
git commit -m "docs: add Simplified Chinese README"
```

### Task 4: Validate the Complete README Experience

**Files:**
- Verify: `README.md`
- Verify: `README.zh-CN.md`
- Verify: `docs/images/readme/*.png`

- [ ] **Step 1: Check every local Markdown link**

Run a read-only link checker or a short shell/Python validation that extracts relative Markdown links from both README files and confirms each target exists.

Expected: zero missing local targets.

- [ ] **Step 2: Verify documented commands and versions**

Run:

```bash
grep -n '\"packageManager\"\\|\"dev\"\\|\"start\"\\|\"build:dev\"\\|\"build:prod\"\\|\"test\"' package.json
grep -n '^go ' go.mod
grep -n 'task: electron:dev\\|electron:dev' Taskfile.yml
```

Expected: npm 10.9.2, Go 1.25.6, all documented npm scripts, and the Task development flow are present.

- [ ] **Step 3: Verify screenshot references**

Run:

```bash
for image in docs/images/readme/*; do
    test -s "$image" || exit 1
done
grep -c 'docs/images/readme/' README.md
grep -c 'docs/images/readme/' README.zh-CN.md
```

Expected: every image is non-empty and both README files contain all required image references.

- [ ] **Step 4: Review only README-related changes**

Run:

```bash
git status --short
git diff HEAD~3 -- README.md README.zh-CN.md docs/images/readme docs/superpowers/specs/2026-07-15-readme-redesign.md docs/superpowers/plans/2026-07-15-readme-redesign.md
```

Expected: no unrelated source-code changes are included in README commits.

- [ ] **Step 5: Final editorial review**

Confirm:

- the first screen explains Crest without scrolling;
- the Hero uses a current Crest screenshot;
- Product Tour captions do not duplicate the capability list;
- shipped and experimental features are visually distinct;
- English and Chinese claims are equivalent;
- every credit and license link resolves.
