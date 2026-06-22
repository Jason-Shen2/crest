# Right Editor Trae-Style Tabs Design

## Problem

The right-side editor currently renders two stacked tab rows:

- A panel-level tool row with `Editor`.
- An editor-level file row with opened files.

This creates a nested-editor feeling, consumes vertical space, and makes the active context harder to scan. The target is closer to Trae's layout: a single top workspace area with tool switching, followed by editor file tabs that visually belong to the same surface.

## Goals

- Replace the standalone `TOOLS` header and small tool chips with a Trae-style top bar.
- Keep tool switching visible for `Terminal`, `Code Review`, `Browser`, and `Editor`.
- Keep editor file tabs as a distinct row, but visually integrate them with the top bar.
- Move panel-level actions to a right-aligned action group.
- Preserve current behavior for opening tools, closing tools, closing files, saving files, hiding the panel, and magnified mode.

## Non-Goals

- Do not change the LSP/editor data model.
- Do not change left file explorer behavior.
- Do not implement a full VS Code workbench shell.
- Do not redesign non-editor tool content beyond the shared top bar.

## Selected Approach

Use the Trae-style two-zone top layout:

- Zone 1: workspace tool bar.
- Zone 2: active tool content tabs, currently editor file tabs.

The important change is visual hierarchy, not a feature rewrite. The top bar becomes the panel's primary navigation surface. The editor file tabs stay in `RightEditorWorkbench`, but their styling becomes flatter and connected to the top bar.

## UI Structure

### Right Tool Top Bar

`RightToolPanel` and `RightToolPanelMagnifiedOverlay` render a new top bar above content:

- Left side: horizontal tool pills.
- Active pill: stronger background, subtle outline, primary text.
- Inactive pills: muted text, hover background.
- Add/open control: compact `+` button using the existing `onOpenTool` flow where available.
- Right side: panel action group for hide/exit magnified and future layout actions.

The old uppercase `TOOLS` label is removed from the normal visual hierarchy.

### Editor File Bar

`RightEditorWorkbench` keeps a file tab row when files are open:

- Active file tab uses the same surface color as the editor body.
- Inactive file tabs use muted text and border separators.
- Each tab shows file name first.
- When there is space, show a shortened path suffix after the file name.
- Dirty files keep the `●` marker.
- Close button remains per file tab.
- Save action moves out of the file tab row to avoid competing with file navigation.

### Empty Editor

When no file is open:

- The Trae-style tool top bar still remains visible.
- The editor body keeps the empty state prompting the user to open a file from the explorer.
- No file tab row is shown.

## Component Changes

### `frontend/app/workspace/right-tool-panel.tsx`

- Introduce `RightToolTopBar`.
- Restyle `RightToolTabs` or replace it with a top-bar-oriented component.
- Remove the standalone `TOOLS` header row in normal and magnified panels.
- Keep `onSelectTool`, `onCloseTool`, `onOpenTool`, `onHide`, and magnified exit behavior.
- Share the same top bar between regular and magnified panel variants.

### `frontend/app/righteditor/right-editor-workbench.tsx`

- Restyle the file tab row to match the Trae-style file bar.
- Add a small path suffix helper for tab subtitles.
- Keep close confirmation behavior for dirty files.
- Keep keyboard shortcuts unchanged.
- Move save affordance to the status/action area while preserving the `model.saveFile()` behavior.

### Tests

Update focused tests rather than snapshot-heavy visual tests:

- Right tool panel renders tool pills and active state.
- Tool close still calls `onCloseTool`.
- Hide and magnified exit actions still work.
- Right editor renders file tabs with active/inactive styling hooks.
- Dirty close confirmation still protects unsaved changes.
- Save action remains reachable.

## Interaction Rules

- Clicking a tool pill switches the active right tool.
- Closing a tool pill closes that tool, not individual editor files.
- Closing a file tab only closes that file.
- `Cmd/Ctrl+S` and `Cmd/Ctrl+W` behavior stays unchanged.
- `Cmd+Shift+W` remains ignored by the right editor shortcut handler.
- File tabs can horizontally scroll or compress when there are many files.

## Accessibility

- Tool buttons keep clear `aria-label` values.
- Active tool uses `aria-current="page"`.
- File close buttons keep file-specific labels.
- Panel hide and magnified exit buttons keep explicit labels.

## Risks

- The top bar can become crowded on narrow right panel widths.
- Path suffixes can add noise if too long.
- Moving the save button may make it less discoverable.

Mitigations:

- Use horizontal overflow for tool and file rows.
- Truncate path suffixes aggressively.
- Keep `Cmd/Ctrl+S` unchanged and show save status in the bottom status bar.

## Verification

- Run focused right panel and right editor tests.
- Run full unit tests with `npm test -- --run`.
- Run `npm run build:dev`.
- Manually inspect the right panel with multiple opened files and magnified mode.
