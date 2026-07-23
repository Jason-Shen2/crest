# File Tree Editor Tab Design

> Superseded by [`2026-07-23-workspace-tab-architecture-design.md`](./2026-07-23-workspace-tab-architecture-design.md). File tabs are now lightweight Top Tabs rather than Wave Tabs.

Date: 2026-07-04

## Goal

Clicking a file in the left file explorer should open that file in a main-area editor tab instead of the right editor panel. The editor tab should use the existing single-file `codeeditor` view, which already mirrors the right panel editor's Monaco, save, model registry, and LSP behavior. The top tab label should derive from the file basename, following the current terax-style tab naming design.

## Confirmed Behavior

- Clicking a directory in the file tree still expands or collapses the directory.
- Clicking or opening a file from the file tree opens an editor tab in the main tab strip.
- If the same file is already open in a `codeeditor` tab, activating the file switches to that existing tab instead of creating a duplicate.
- A newly opened file tab contains one `codeeditor` block with `block.meta.view = "codeeditor"` and `block.meta.file = <absolute file path>`.
- Opening files from the file tree no longer opens the right editor panel by default.
- The right editor panel remains available as a separate explicit tool; this change does not remove `RightEditorWorkbench`.

## Current State

The file explorer currently routes files to the right editor panel:

- `FileExplorerTree` calls `FileExplorerModel.openFile(finfo)` when a file is opened.
- `FileExplorerModel.openFile()` calls `WorkspaceLayoutModel.openRightEditorTool()`.
- It then calls `RightEditorModel.openFile(path, root)`, which reads the file and displays it in `RightEditorWorkbench`.

The repo already has the single-file editor view needed for the main area:

- `FileEditorViewModel` has `viewType = "codeeditor"`.
- It reads the file path from `block.meta.file`.
- It reuses the right editor infrastructure: `CodeEditor`, Monaco model registry, LSP helpers, save state, and file read/write RPC.
- `tab-name.ts` already derives `codeeditor` and `preview` tab labels from `block.meta.file`.

## Architecture

Introduce one focused orchestration path for file-tree-to-tab opening:

1. The file explorer receives a file open request.
2. It asks a workspace-level helper to open that path in an editor tab.
3. The helper scans the current workspace tabs for an existing `codeeditor` block with the same `meta.file`.
4. If found, it activates that tab.
5. If not found, it creates a new auto-named tab and creates a single `codeeditor` block inside that tab.
6. The existing tab naming pipeline displays the tab as the file basename.

This keeps editor rendering in the existing `codeeditor` view and keeps tab naming in `tab-name.ts`.

## Data Flow

```text
FileExplorerTree
  -> FileExplorerModel.openFile(finfo)
  -> openFileInEditorTab(path)
  -> find existing tab by codeeditor block meta.file
  -> existing: setActiveTab(tabId)
  -> missing: create tab + create codeeditor block
  -> tab-name.ts derives basename(file)
```

## Existing Tab Detection

The match key is the normalized file path stored in `block.meta.file`.

The first implementation should compare exact absolute paths because current file explorer `FileInfo.path` is already absolute. If path normalization is needed for Windows separators, it should be implemented as a small local helper and covered by tests.

Only tabs with a block whose `meta.view` is `codeeditor` and whose `meta.file` matches the requested path count as existing editor tabs. `preview` tabs are not reused because this feature explicitly opens the single-file editor view.

## New Tab Creation

The implementation should create an auto-named tab so the existing tab naming code can derive the display label from the editor block. The new tab should contain exactly one `codeeditor` block for the requested file.

The intended block metadata is:

```ts
{
    view: "codeeditor",
    file: path,
    connection: "",
}
```

If the existing backend `CreateTab` flow creates a default terminal layout, the implementation should use the smallest existing layout/block creation API that can replace or create the intended `codeeditor` block without leaving an unwanted terminal block visible.

## Tab Naming

The canonical naming logic remains `frontend/app/tab/tab-name.ts`.

`deriveBlockDisplayName(block)` should continue to map:

- `codeeditor` and `preview` to `basename(block.meta.file)`.
- `term` and `termblocks` to `basename(block.meta["cmd:cwd"])`.
- `web` to `block.meta.url`.

The implementation should also fix nearby display gaps discovered during exploration:

- `workspaceswitcher.tsx` should treat `codeeditor` as a file tab, not only `codeedit`.
- `vtabbar.tsx` and `vtab-detail-sidecar.tsx` should read `block.meta.file` for file-backed views instead of relying on `file:path`.

## File Explorer Menu

The default file open action changes to editor tab.

The context menu should be clarified:

- Keep an explicit "Open in Right Editor" action if the right panel editor remains useful as a separate workflow.
- Change "Open in Main Area" for files to open the same editor tab path, or rename it to avoid duplicating the default behavior.

The implementation plan should choose the smallest menu adjustment that avoids confusing duplicate actions.

## Error Handling

- If file metadata is missing or the file is a directory, preserve the current directory expand behavior.
- If creating the tab fails, leave the existing workspace state unchanged and surface the existing error handling path used by tab/block creation.
- If creating the editor block fails after creating the tab, do not silently fall back to the right editor panel.
- If an existing matching editor tab is found, activation should be the only side effect.

## Testing

Add or update focused tests:

- `FileExplorerModel.openFile()` opens files through the editor-tab path instead of `RightEditorModel.openFile`.
- Opening a directory still toggles expansion.
- Opening a file that already has a matching `codeeditor` tab activates that tab instead of creating a new one.
- Opening a new file creates a `codeeditor` block with `meta.view = "codeeditor"` and `meta.file = path`.
- `tab-name.ts` continues to derive file basenames for `codeeditor`.
- `workspaceswitcher.tsx` recognizes `codeeditor` file tabs.

Manual verification:

- Click a file in the left explorer and confirm a main-area editor tab opens.
- Click the same file again and confirm the existing tab becomes active.
- Confirm the right editor panel does not open as a side effect.
- Confirm the top tab label is the filename.
- Confirm save and edit behavior still matches the right panel editor behavior.

## Non-Goals

- Do not remove the right editor panel.
- Do not redesign Monaco or replace the editor engine.
- Do not implement multi-file editor tabs inside one main tab.
- Do not change terminal tab creation behavior beyond what is necessary for file editor tabs.
- Do not introduce a second tab naming system.

## Open Decisions

All user-facing behavior required for the first implementation is decided:

- Open files in main editor tabs.
- Reuse existing tab for the same file.
- Use the existing `codeeditor` view.
- Derive tab names from file basename.

The implementation plan still needs to pick the exact existing create-tab/create-block API sequence after inspecting the available layout commands in detail.
