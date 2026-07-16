# README Agent Architecture Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore unredacted README screenshots and make Crest's Pi-based Agent Harness a first-class, visually explained part of the bilingual project landing page.

**Architecture:** Documentation assets remain under `docs/images/readme/`. A standalone theme-aware SVG explains the Crest/Pi ownership boundary and Agent Turn lifecycle; both README files embed the same asset and mirror the same technical narrative. All changes stay documentation-only.

**Tech Stack:** Markdown, SVG 1.1, GitHub-rendered HTML, PNG, ImageMagick/sips-compatible image processing, Git

---

### Task 1: Restore Unredacted Product Screenshots

**Files:**
- Modify: `docs/images/readme/agent-session-panel.png`
- Modify: `docs/images/readme/resume-session-picker.png`
- Modify: `docs/images/readme/source-control-graph.png`
- Modify: `docs/images/readme/hero-overview.png`

- [ ] **Step 1: Verify the original source images**

Run:

```bash
file \
  "/Users/bytedance/Desktop/demo/截屏2026-07-15 22.27.59.png" \
  "/Users/bytedance/Desktop/demo/resume-session-picker.png" \
  "/Users/bytedance/Desktop/demo/source-control-graph.png"
```

Expected: three valid, non-zero PNG images.

- [ ] **Step 2: Rebuild the three product assets from original sources**

Use high-quality Lanczos resampling and preserve the current README dimensions:

- `agent-session-panel.png`: 1600 px wide, proportional height;
- `resume-session-picker.png`: 1600 px wide, proportional height;
- `source-control-graph.png`: 1600 px wide, then retain the current 1600×945 README crop.

Do not add blur, masks, pixelation, synthetic text, or replacement UI.

- [ ] **Step 3: Recompose the hero**

Regenerate `hero-overview.png` as a 1600×690 PNG using the restored Agent image, the existing unredacted Editor image, and the restored Source Control image. Preserve the current three-panel composition and avoid adding new masking.

- [ ] **Step 4: Verify the assets**

Run:

```bash
file docs/images/readme/*.png
git diff --stat -- docs/images/readme
```

Expected: valid PNG assets; only the four specified files changed.

- [ ] **Step 5: Commit**

```bash
git add docs/images/readme/agent-session-panel.png \
  docs/images/readme/resume-session-picker.png \
  docs/images/readme/source-control-graph.png \
  docs/images/readme/hero-overview.png
git commit -m "docs: restore unredacted product screenshots"
```

### Task 2: Create the Agent Harness Architecture SVG

**Files:**
- Create: `docs/images/readme/agent-harness-architecture.svg`

- [ ] **Step 1: Create the standalone SVG**

Create a `1600×1000` responsive SVG with:

- `<title>` and `<desc>`;
- no scripts, external images, external fonts, animation, or remote styles;
- embedded light theme plus `@media (prefers-color-scheme: dark)`;
- editorial technical blueprint styling;
- left-side system layers:
  - Agent Workspace UI;
  - Crest Session Owner + IPC;
  - Pi AgentHarness;
  - Pi AI, Crest Tools, SQLite Sessions;
- right-side lifecycle:
  - Assemble context;
  - Stream the model;
  - Execute tools;
  - Persist events;
  - Reflect and resume;
- a return path showing tool results re-enter context;
- a legend distinguishing Crest-owned integration, Pi adapted in-tree, and the stateful event path.

- [ ] **Step 2: Validate XML and dependencies**

Run:

```bash
xmllint --noout docs/images/readme/agent-harness-architecture.svg
grep -nE 'https?://|<script|<image|@import|animation' docs/images/readme/agent-harness-architecture.svg
```

Expected: `xmllint` exits 0; dependency scan prints no matches.

- [ ] **Step 3: Render-check the SVG**

Render the SVG to a temporary PNG using an available local renderer, verify that the output is non-empty, and inspect it for clipped labels, overlaps, unreadable text, or connector collisions. Delete the temporary PNG after inspection.

- [ ] **Step 4: Commit**

```bash
git add docs/images/readme/agent-harness-architecture.svg
git commit -m "docs: add Agent Harness architecture diagram"
```

### Task 3: Expand the Bilingual Agent Architecture Narrative

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Add the English Agent Harness section**

Insert `## Agent Harness Architecture` before the general `## Architecture` section. Explain:

- why Crest moved the Agent loop to Electron main;
- that Pi is adapted in-tree from `earendil-works/pi v0.75.5`, not consumed as published npm packages;
- what Pi supplies: `AgentHarness`, AI provider abstractions, typed events, queues, hooks, tool loop, compaction, and session primitives;
- what Crest supplies: assistant-ui bridge, `usePiChat`, structured IPC, `PaneAgentSession`, project context, tools, and SQLite persistence;
- why the design matters: inspectability, project context, resumability, and Human-in-the-loop control.

Embed:

```markdown
![Crest Agent Harness architecture](./docs/images/readme/agent-harness-architecture.svg)
```

Describe the five lifecycle stages shown in the diagram without repeating every node label.

- [ ] **Step 2: Replace the general ASCII architecture**

Keep `## Architecture`, but remove the fenced ASCII diagram. Replace it with concise prose and a compact Markdown table covering:

- React renderer;
- Electron main;
- Go backend;
- renderer-to-main preload/IPC;
- renderer-to-Go `wshrpc` WebSocket and `/wave/service` HTTP paths.

- [ ] **Step 3: Mirror the Chinese README**

Add `## Agent Harness 架构` in the corresponding position and mirror the same image, facts, caveats, and lifecycle. Keep common terms such as Agent Harness, Agent Runtime, Workspace, Session, Tool Call, Context, Runtime, and Human-in-the-loop.

Remove the Chinese ASCII application architecture diagram and replace it with the matching prose/table structure.

- [ ] **Step 4: Tighten Pi acknowledgement**

Update the acknowledgement in both languages to say that Crest adapts Pi's Agent runtime, AI provider abstractions, and selected coding-agent behavior in-tree. Do not imply a direct npm package dependency, complete Pi CLI/TUI reuse, or unchanged vendoring.

- [ ] **Step 5: Validate parity and forbidden claims**

Run:

```bash
grep -nE '^#{1,3} ' README.md
grep -nE '^#{1,3} ' README.zh-CN.md
grep -n 'agent-harness-architecture.svg' README.md README.zh-CN.md
grep -nE 'Browser automation.*available|MCP.*available|depends on Pi packages|uses pi-coding-agent' README.md README.zh-CN.md
```

Expected: matching section order, one architecture image reference per README, and no forbidden-claim matches.

- [ ] **Step 6: Validate local links**

Run the repository-local link validation used for the initial README redesign and confirm every relative Markdown and HTML target exists.

- [ ] **Step 7: Commit**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: explain the Pi-based Agent Harness"
```

### Task 4: Final Documentation Validation and Main Push

**Files:**
- Verify: `README.md`
- Verify: `README.zh-CN.md`
- Verify: `docs/images/readme/*.png`
- Verify: `docs/images/readme/agent-harness-architecture.svg`

- [ ] **Step 1: Check documentation diff**

Run:

```bash
git diff --check origin/main...HEAD
git diff --name-only origin/main...HEAD
git status --short
```

Expected: clean diff; only README, documentation design/plan files, and README image assets are changed.

- [ ] **Step 2: Run README-specific validation**

Confirm:

- all local links exist;
- all PNGs decode;
- SVG parses and has no external dependencies;
- both README files use the same architecture asset;
- no ASCII architecture diagram remains;
- no branch-introduced pixelation or masking remains in the four restored assets.

- [ ] **Step 3: Record baseline test status**

Run:

```bash
npm test -- --run
```

Expected: document the existing Node 20 / `node:sqlite`, Electron mock, Jotai, and `middleEllipsis` failures if unchanged. Do not modify runtime code for documentation-only failures.

- [ ] **Step 4: Push the reviewed HEAD directly to main**

Fetch first and require a fast-forward relationship:

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git push origin HEAD:main
```

Expected: `origin/main` advances to the reviewed HEAD without force-push.
