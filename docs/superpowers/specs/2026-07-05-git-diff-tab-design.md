# Git Diff Tab Design

> Superseded by [`2026-07-23-workspace-tab-architecture-design.md`](./2026-07-23-workspace-tab-architecture-design.md). Git diff tabs are now lightweight Top Tabs rather than Wave Tabs.

## Goal

Bring Terax's Source Control diff-tab behavior into Crest.

When a user clicks a changed file in the Source Control panel, Crest opens a Git diff tab in the main workspace tab area. The diff tab is a peer of normal editor tabs and is not rendered inside the right panel.

## Scope

In scope:

- Open working-tree Git diff tabs from Source Control file rows.
- Match Terax's tab behavior: reuse an existing tab for the same repo, path, and diff mode; otherwise create a new tab and activate it.
- Render diff content with a dedicated `gitdiff` module modeled after Terax's `GitDiffStack` and `GitDiffPane`.
- Use Crest's Git RPC layer instead of Terax's Tauri native bridge.
- Extend the existing Git diff content RPC to carry `originalpath` so renamed files can match Terax behavior.
- Support staged and unstaged modes.
- Provide fallback rendering for binary files, large files, or unavailable structured content.

Out of scope for this first pass:

- Commit graph UI.
- Commit-file diff tabs from history.
- Inline diff rendering inside Source Control.
- Editing or applying hunks from the diff tab.

## Architecture

The feature is split into three boundaries:

1. `sourcecontrol`
   - Owns Source Control list state and row interactions.
   - Keeps `selectedpathAtom` for visual selection.
   - Calls a workspace-level diff-tab opener when a changed file is selected.
   - Does not render diff content.

2. Workspace tab model
   - Adds a Git diff tab type that is separate from normal file editor tabs.
   - Stores `repoRoot`, `path`, `mode`, and `originalPath`.
   - Reuses existing tabs by `(repoRoot, path, mode)`.
   - Activates the existing or newly created tab.

3. `gitdiff`
   - Contains `GitDiffStack` and `GitDiffPane`.
   - Loads diff content through `RpcApi.GitGetDiffContentCommand`.
   - Renders CodeMirror merge view when structured content is available.
   - Falls back to patch text for binary, oversized, or unsupported content.

4. Git RPC
   - Keeps the existing `GitGetDiffContentCommand` command name.
   - Extends `GitDiffFileData` with optional `originalpath`.
   - Uses `originalpath` when reading the original side of a renamed file.

## User Flow

1. User opens Source Control in the right panel.
2. User clicks a changed file row.
3. Source Control updates its selected path.
4. Source Control calls `openGitDiffTab({ repoRoot, path, mode, originalPath })`.
5. Workspace tab model checks for an existing matching Git diff tab.
6. If found, Crest activates that tab.
7. If not found, Crest creates a new main workspace tab with `kind: "git-diff"`.
8. Workspace rendering routes `git-diff` tabs to `GitDiffStack`.
9. `GitDiffPane` fetches and renders the diff.

## Diff Modes

Use Terax's mode convention:

- `"-"` means unstaged working-tree diff.
- `"+"` means staged index diff.

Mapping to Crest RPC:

- `mode === "+"` maps to `staged: true`.
- `mode === "-"` maps to `staged: false`.

For files that have both staged and unstaged changes, Source Control should open the unstaged diff by default if the row represents the combined file entry and `entry.unstaged` is true. This matches Terax's current `selectFile()` behavior.

## Data Flow

The diff pane requests:

```ts
RpcApi.GitGetDiffContentCommand(TabRpcClient, {
    cwd: repoRoot,
    path,
    staged: mode === "+",
    originalpath,
})
```

The generated frontend result uses the existing lowercase Go JSON field names:

- `originalcontent`
- `modifiedcontent`
- `isbinary`
- `fallbackpatch`
- `truncated`

The `gitdiff` module should normalize these fields to camelCase at its boundary so UI components can use Terax-like names internally.

Backend behavior:

- For staged diffs, original content comes from `HEAD:<originalpath || path>` and modified content comes from `:<path>`.
- For unstaged diffs, original content comes from `:<originalpath || path>` and modified content comes from the worktree `path`.
- The fallback patch still comes from the existing file diff command.

## Rendering

Primary rendering should follow Terax:

- Use CodeMirror 6 merge support for a unified diff view.
- Render read-only content.
- Show syntax highlighting based on file path when available.
- Collapse unchanged sections.
- Highlight changed text and gutters.

Fallback rendering:

- If `isBinary` is true, show a binary fallback badge and render `fallbackPatch` if present.
- If either side exceeds the size threshold, show a large-file fallback badge and render `fallbackPatch`.
- If loading fails, show the error message in the tab body.
- If no patch is available, show a clear empty fallback message.

## Placement

The diff tab opens in the main workspace tab area.

It must not be added to or rendered inside:

- the Source Control panel
- the right tool panel
- sidecar panels

The right panel remains only the launcher and selection surface.

## Testing

Unit tests should cover:

- Source Control file click calls the diff-tab opener with the expected repo, path, mode, and original path.
- Clicking the same repo/path/mode reuses an existing Git diff tab.
- Clicking the same file with another mode opens or activates a separate tab.
- Workspace rendering routes `kind: "git-diff"` to `GitDiffStack`.
- `GitDiffPane` calls `GitGetDiffContentCommand` with the correct `staged` mapping.
- Binary and large-file results use fallback rendering.

Manual verification should cover:

- Source Control remains in the right panel.
- Git diff tab opens in the main tab bar.
- Existing normal file tabs still open and render normally.
- Staging or unstaging a file updates subsequent diff opens.

## Migration Notes

Crest already has Git RPC commands for diff content. The implementation should adapt Terax's frontend structure but avoid copying Terax's native bridge layer.

The first pass should not introduce commit-history tabs. The data model can leave room for a future `git-commit-file` tab, but only `git-diff` is required now.
