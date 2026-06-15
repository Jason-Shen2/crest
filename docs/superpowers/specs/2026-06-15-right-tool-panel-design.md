# Right Tool Panel Design

## Goal

Introduce a Trae Solo-style right-side tool area in crest. The panel gives users a persistent place to open focused tools such as editor, browser, terminal, and code review, while preserving crest's existing main terminal/block workflow.

## Decisions

- Build the feature as a workspace-level `RightToolPanel`, not as a `TileLayout` block.
- Show the panel by default for first-time users.
- Start with no opened tool tabs and show an "Open Tool" launcher.
- Only show supported tools in the launcher: editor, browser, terminal, and code review.
- Treat each outer tool as a single instance; editor/browser can manage their own inner tabs.
- Move code review into the right tool panel as the `codeReview` tool tab.
- Persist all panel state: visibility, width, opened tools, active tool, and lightweight per-tool state.
- Use the same UI anchor for hide and show.
- Apply `Command+M` / magnify to the whole panel when focus is inside an opened right-side tool.

## Architecture

`RightToolPanel` lives as a sibling of the main tab content inside the workspace layout. `Workspace` continues to own the top-level application chrome and composes the left navigation, main tab content, and right tool panel.

The panel is not part of the tile layout tree. This keeps the product model clear: terminal blocks remain in the main workspace, while right-side tools are a workspace-level utility area. The panel can still behave like a magnifiable work object through workspace-level focus and magnify integration.

`WorkspaceLayoutModel` owns the panel state and persistence. Components read state from the model and dispatch intent-level actions such as `openTool`, `closeTool`, `setActiveTool`, `toggleVisible`, `setWidth`, and `toggleMagnified`.

## Components

- `RightToolPanel`: outer container for the header, tool tabs, launcher, content, resize boundary, hide button, and focus marker.
- `RightToolLauncher`: empty-state launcher that shows the four supported tool cards and calls `openTool(toolId)`.
- `RightToolTabs`: outer tool tab strip that handles single-instance switching and closing.
- `RightToolContent`: renders the active tool implementation.
- `WorkspaceLayoutModel`: source of truth for visible state, width, opened tools, active tool, per-tool shell state, and persistence.
- `Workspace`: integrates the panel into the right side of the layout and renders the collapsed toggle when the panel is hidden.

## State Model

The workspace layout model stores a `RightToolPanelState` shape:

```ts
type RightToolId = "editor" | "browser" | "terminal" | "codeReview";

type RightToolPanelState = {
    visible: boolean;
    width: number;
    openedTools: RightToolId[];
    activeTool?: RightToolId;
    toolState: Partial<Record<RightToolId, unknown>>;
    magnified: boolean;
};
```

Defaults:

- `visible`: `true`
- `width`: a comfortable sidebar width near the current code review sidebar width
- `openedTools`: `[]`
- `activeTool`: empty until the first tool opens
- `magnified`: `false`

State normalization removes unknown tools, deduplicates `openedTools`, clamps width, and repairs `activeTool` if it no longer exists. If all tools are closed, `activeTool` is cleared and the launcher is shown.

## Persistence

Panel state should persist through the same workspace/tab metadata path used for existing layout state. Persistence belongs in `WorkspaceLayoutModel`, not individual React components.

Persisted fields:

- visible or hidden state
- panel width
- opened outer tools
- active outer tool
- lightweight per-tool state needed to restore the shell

The initial version should persist only state that is stable enough to restore safely. Larger tool-specific content, such as editor file buffers or browser history, can be delegated to each tool's internal persistence layer.

## Interaction

First launch:

- Right panel is visible.
- No outer tool tab is open.
- The body shows the launcher with editor, browser, terminal, and code review.

Opening tools:

- Clicking a launcher card opens that tool tab and activates it.
- Clicking an already-open tool card only activates the existing tab.
- Each outer tool appears at most once.

Closing tools:

- Closing the active tool activates a neighboring opened tool.
- Closing the last tool returns the panel body to the launcher.

Hide/show:

- When expanded, the panel header's right-side button hides the panel.
- When hidden, the main content expands and a lightweight button appears at the same right-side anchor.
- Clicking the collapsed button restores the panel with its previous width and tabs.

Resize:

- The panel can be resized within a safe min/max range.
- The last width is persisted.
- Hiding the panel does not reset width.

## Magnify

`Command+M` follows the current focused work object. When focus is inside an opened right-side tool, the magnify target is the entire `RightToolPanel`.

Behavior:

- The full right tool panel, including header and active tool content, expands into the main content area.
- Exiting magnify restores the panel to the right side with the previous width.
- The right-side hide/show toggle remains separate from magnify and does not act as a fullscreen control.
- If the panel is hidden or has no opened tools, `Command+M` should not magnify the launcher.

This preserves the existing crest mental model: magnify means "focus the current work object," not "resize a sidebar in place."

## Code Review Migration

The existing code review sidebar becomes the `codeReview` tool tab. The migration should preserve the existing code review entry point and core display behavior while removing the separate right-sidebar surface.

During migration, if old code review sidebar state exists, map it to the new `codeReview` tab so users do not lose their expected entry point.

## Error Handling

- Unknown persisted tool ids are removed during state normalization.
- Duplicate tools collapse to one instance.
- Invalid active tool falls back to the first opened tool.
- Invalid width is clamped to the safe range.
- A failing tool renders an error state inside its own tab, not a broken panel.
- `Command+M` is ignored for hidden or empty panel states.

## Testing

Model tests:

- `openTool` creates a single instance and activates it.
- Reopening an existing tool only activates it.
- `closeTool` selects the correct fallback active tool.
- Closing the last tool returns to launcher state.
- State normalization repairs invalid persisted state.

Component tests:

- Launcher renders the four supported tools.
- Launcher click opens and activates a tool tab.
- Tool tabs switch and close correctly.
- Hide/show uses the same visual anchor.

Integration tests:

- Workspace renders main content and right panel together.
- Hidden panel lets main content expand and keeps the collapsed toggle visible.
- Persisted state restores visible state, width, opened tools, and active tool.
- Code review renders through the new `codeReview` tab.

Manual verification:

- `Command+M` on a focused right-side tool visually matches terminal block magnify behavior.
- Exiting magnify restores the previous panel state.
- The panel resize, hide/show, and tab interactions feel stable with editor, browser, terminal, and code review.

## Open Scope Boundaries

The initial implementation should not include realtime-follow behavior, unsupported tool entries, multi-instance outer tools, or a separate fullscreen button. These can be added later after the workspace-level panel is stable.
