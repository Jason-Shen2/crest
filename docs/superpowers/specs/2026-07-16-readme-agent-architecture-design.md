# README Agent Architecture Upgrade Design

**Status:** Approved direction

## Goal

Upgrade Crest's bilingual README so the Agent runtime becomes a first-class part of the product story. Replace redacted product screenshots with their original unredacted source images, and add a polished architecture diagram that explains how Crest adapts Pi as an in-tree native Agent Harness.

## Scope

This change updates documentation assets only:

- Restore the selected README screenshots from original Demo sources without pixelation or masking.
- Regenerate the composite hero from the restored sources.
- Add one GitHub-compatible Agent architecture SVG.
- Expand the Agent architecture narrative in `README.md`.
- Mirror the same structure and meaning in `README.zh-CN.md`.

Runtime code, Agent behavior, permissions, providers, and tool registration are out of scope.

## Screenshot Restoration

The README must use the original, unredacted product screenshots. Do not attempt to reverse existing pixelation; recreate optimized assets from the original Demo files.

Restore:

- `agent-session-panel.png` from `截屏2026-07-15 22.27.59.png`
- `resume-session-picker.png` from the original file of the same name
- `source-control-graph.png` from the original file of the same name
- `hero-overview.png` by recomposing the restored Agent, Editor, and Source Control images

Keep the current README-oriented optimization:

- PNG output
- approximately 1600 px wide
- high-quality Lanczos resampling
- no masking, pixelation, blur, or synthetic replacement content

Existing screenshots that were only resized or intentionally cropped may remain unchanged unless recomposition requires their source.

## Agent Architecture Narrative

The README must describe Pi accurately:

- Crest does not consume Pi through published npm packages.
- Crest adapts Pi in-tree, based on `earendil-works/pi v0.75.5`.
- Pi provides the stateful `AgentHarness`, AI provider abstractions, typed event stream, tool loop, queues, compaction, hooks, and session primitives.
- Crest provides the desktop workspace integration: assistant-ui bridge, renderer hook, structured Electron IPC, `PaneAgentSession`, project context assembly, Crest tools, and SQLite-backed session persistence.
- The renderer is a UI mirror, not the source of truth.
- `PaneAgentSession` owns authoritative messages, turns, queues, and status for a session.
- SQLite entries make sessions resumable and reconstruct the timeline after restart.

The wording must not imply:

- a direct dependency on official Pi npm packages;
- reuse of the complete Pi CLI or TUI;
- unchanged vendoring;
- currently available Browser automation or MCP Agent tools;
- completed fine-grained interactive approval.

## Diagram Information Architecture

The selected direction is a hybrid diagram:

- **Left side:** system layers and ownership boundaries.
- **Right side:** one Agent Turn lifecycle.

### Left: System Layers

1. **Agent Workspace UI**
   - assistant-ui rendering
   - `usePiChat`
   - inspectable thread, composer, and live tool state

2. **Crest Session Owner + IPC**
   - `PaneAgentSession`
   - structured preload API
   - one `agent:event` stream routed by session path
   - authoritative turns, queues, messages, and status

3. **Pi AgentHarness**
   - stateful Agent loop
   - typed events
   - hooks
   - steering and follow-up queues
   - compaction and branching primitives

4. **Runtime Foundations**
   - Pi AI provider streaming
   - Crest tools
   - append-only SQLite session tree

### Right: One Agent Turn

1. Assemble context
   - current cwd
   - project instructions
   - skills
   - history
   - active tools

2. Stream the model
   - thinking deltas
   - text deltas
   - structured tool-call deltas

3. Execute tools
   - argument validation
   - hooks and permission boundary
   - sequential or parallel execution
   - typed tool results

4. Persist events
   - append messages to SQLite
   - use the user entry ID as `turnId`

5. Reflect and resume
   - stream live events to the UI
   - rebuild the same timeline from SQLite later

The diagram must show that tool results re-enter context until the Harness settles the turn.

## Visual Direction

Use the approved **editorial technical blueprint** style:

- neutral paper-like canvas;
- precise grid and hairline rules;
- serif editorial display title paired with compact technical labels;
- dark Pi `AgentHarness` block as the primary focal point;
- restrained indigo for the stateful event path;
- no purple gradient, glow, glassmorphism, or decorative AI imagery;
- clear legend for Crest-owned integration, Pi adapted in-tree, and the event path;
- balanced density suitable for a repository landing page.

The production asset must be a standalone SVG under `docs/images/readme/`, not an HTML screenshot and not an ASCII or Mermaid diagram.

The SVG must:

- render correctly on GitHub;
- remain readable at typical README width;
- include embedded styles only;
- support light and dark themes with `prefers-color-scheme`;
- avoid external fonts, scripts, or remote assets;
- use accessible text and a descriptive `<title>` and `<desc>`;
- contain no animation that could distract in documentation.

## README Placement

Add a dedicated `## Agent Harness Architecture` section before the general application `## Architecture` section.

The section should:

1. introduce why Crest chose an in-tree Pi foundation instead of maintaining a custom Agent loop;
2. embed the architecture SVG;
3. explain the ownership boundary between Crest and Pi;
4. describe the five-stage Agent Turn lifecycle;
5. explain why this design matters to users: inspectability, project-scoped context, resumability, and control.

Keep the general application architecture section for React, Electron, and the Go backend, but replace its ASCII diagram with concise prose or a compact table. The README must contain no ASCII architecture diagram after this change.

The Chinese README must mirror the same section order, image, technical facts, warnings, and links. Keep established terms such as Agent Harness, Agent Runtime, Workspace, Session, Tool Call, Context, Runtime, and Human-in-the-loop where they are clearer than forced translations.

## Validation

Before completion:

- confirm no README screenshot contains pixelation or masking introduced by this branch;
- confirm all screenshot and SVG assets decode or parse successfully;
- confirm the SVG contains no external dependencies;
- confirm both README files embed the same architecture asset;
- confirm the English and Chinese section structures remain aligned;
- confirm all local links exist;
- confirm forbidden capability claims are absent;
- run `git diff --check`;
- verify the diff remains documentation-only.

## Out of Scope

- Changing the Agent runtime implementation
- Adding new tools or providers
- Implementing Browser automation
- Implementing MCP Agent tools
- Completing interactive tool approval
- Rewriting the internal Agent architecture documents
