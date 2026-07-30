# Agent Search and Read Tool Activity

## Goal

Replace generic `find`, `grep`, and `read` tool payload cards with compact semantic activity rows inspired by Windsurf:

- Search activity states what was searched without an expandable raw payload.
- Read activity states which files were read, collapses by default, and expands to a list of files that open in the current workspace's top-tab editor.
- Consecutive calls of the same semantic kind are coalesced without changing the canonical assistant message or tool-call data.

## Confirmed Product Decisions

- Use assistant-ui's render-time grouping rather than rewriting messages in the runtime bridge.
- Coalesce adjacent `read` calls into a Read group and adjacent `find`/`grep` calls into a Search group.
- Reasoning, text, or another tool kind ends the current semantic group.
- Search activity is never expandable.
- A `grep` summary shows both the search pattern and its file scope.
- A Read group deduplicates repeated reads of the same normalized path, including offset/limit continuation reads.
- Clicking a successfully read file opens it in the current workspace's top file tab, matching file-tree navigation.
- `edit`, `write`, and unrelated tools keep their existing renderers.

## User Experience

### Search

Completed `find` calls render:

```text
Searched  *.md
```

Completed `grep` calls render:

```text
Searched  "TODO"  in  *.ts
```

The values are rendered as compact code-style chips. A consecutive Search group uses one activity row and renders every rule in call order, wrapping onto additional visual lines when needed. Rules are not truncated into an undisclosed "other searches" count because the row has no expansion affordance.

Search formatting follows these rules:

- `find`: the primary chip is `args.pattern`; an explicit non-default `args.path` is shown as the scope.
- `grep`: the primary chip is `args.pattern`; the scope uses `args.glob`, `args.path`, or both when both constrain the search.
- Optional execution controls such as `limit`, `ignoreCase`, `literal`, and `context` are omitted from the compact summary.

While any contained call is running, the label is `Searching` and the row displays the existing animated running treatment. When all calls settle successfully, the label becomes `Searched`.

### Read

A Read group starts collapsed. Its summary uses basenames for compactness:

```text
Read  app.ts and 2 other files
```

For one file, the row shows only that basename. For two files, it names both. For three or more files, it names the first file and reports the remaining unique-file count.

Expanding the row reveals one entry per normalized file path:

```text
Read  frontend/app.ts
Read  frontend/util.ts
```

Expanded entries use workspace-relative paths when the file is under the current workspace root and normalized absolute paths otherwise. Repeated calls for the same path are listed once even when their `offset` or `limit` differs.

While any contained call is running, the label is `Reading` and the row displays the existing animated running treatment. When all calls settle successfully, the label becomes `Read`.

## Grouping Architecture

`groupCrestAssistantPart` remains the single grouping decision point for assistant message parts. It will add semantic subgroup keys beneath the existing chain-of-thought group:

- `read` -> `group-chainOfThought / group-read-activity`
- `find` and `grep` -> `group-chainOfThought / group-search-activity`

assistant-ui coalesces only adjacent parts that share the path, so reasoning, text, `edit`, `write`, or any other tool automatically closes the current semantic subgroup. `edit` and `write` remain ungrouped as they are today so their file cards are unchanged.

The grouping function assigns a semantic subgroup only when the required arguments can be validated and the call does not require approval. Malformed and `requires-action` calls stay on the existing generic tool path.

The grouped-parts renderer receives a group part containing `indices`. Dedicated Search and Read group components use those indices to select the original message parts from assistant-ui state. The components derive their display model from the original tool name, arguments, result, and status. The runtime bridge continues to expose individual tool calls and results unchanged.

Pure helpers perform:

- Tool argument validation.
- Search rule formatting.
- Local-path normalization.
- Workspace-relative display-path derivation.
- Read-path deduplication.
- Aggregate status calculation.

Keeping these transformations outside JSX makes their behavior directly testable.

## File Navigation

The workspace already owns file-tab navigation through `WorkspaceTopTabController.openFile`. The navigation dependency will be threaded through the existing component boundary:

```text
WorkspaceMainContent
  -> WorkspaceAgentContentSlot
  -> AgentContent
  -> Thread
  -> Read activity file button
```

`AgentContent` already receives `executionContext.workspaceDir`. A navigation helper resolves a Read argument as follows:

1. Normalize slash direction.
2. Preserve an absolute local path.
3. Resolve a relative path against `executionContext.workspaceDir`.
4. Pass the normalized absolute path to the injected top-tab open callback.

This keeps the semantic activity component independent of workspace models and makes its navigation behavior injectable in tests. No global `RightEditorModel` access is introduced.

## States and Errors

- Running groups use a spinner and present-tense label.
- Completed groups use the past-tense label.
- Search remains non-expandable in every state.
- Read remains collapsible and defaults closed.
- Error details are never hidden only inside the Read collapsible region.
- A failed or cancelled call retains its semantic summary and displays a short error outside the collapsed content.
- A failed Read path is visible but not an active file button because the file may not exist or be readable.
- A mixed group retains successful entries and marks failed entries without discarding either.
- If a semantic renderer cannot validate the required arguments, that call uses the existing `ToolFallback` rather than displaying a misleading summary.
- Tool approval UI is not reimplemented. If one of these read-only tools ever enters `requires-action`, it uses `ToolFallback` so the existing approval controls remain available.

## Accessibility

- The Read group trigger is a native button with `aria-expanded`.
- File entries are native buttons with visible focus treatment and descriptive accessible names containing the display path.
- Search rows are status content, not fake buttons.
- Running state is exposed through the existing busy/status semantics rather than icon color alone.
- Decorative icons are hidden from assistive technology.

## Component Boundaries

The feature adds focused assistant UI modules rather than extending the generic fallback:

- Semantic activity display-model helpers.
- A non-collapsible Search activity group.
- A collapsible Read activity group and file-entry button.
- A small navigation callback/context on `ThreadProps`.

The existing generic `ToolFallback`, tool approval controls, file edit/write cards, and runtime bridge remain unchanged.

## Testing

Tests are written before production changes and cover:

### Pure helpers

- `find` renders its glob and optional path scope.
- `grep` renders its query and glob/path scope.
- Optional execution controls do not leak into the compact summary.
- Read paths normalize and deduplicate across repeated offset/limit calls.
- Summary grammar for one, two, and three-or-more files.
- Workspace-relative and external absolute display paths.

### Components

- Search has no collapse trigger or raw payload.
- Search wraps multiple rules without hiding any.
- Read starts collapsed and toggles from the full summary row.
- Expanded Read entries are keyboard-focusable.
- Clicking a successful Read entry invokes the injected open-file callback with the normalized absolute path.
- Running, successful, failed, cancelled, malformed, and `requires-action` states use the intended presentation or fallback.

### Integration

- Adjacent `read` calls form one Read group.
- Adjacent `find` and `grep` calls form one Search group.
- Reasoning, text, and other tool calls split semantic groups.
- Tool-call data in the runtime adapter is not rewritten.
- Existing `edit` and `write` file-card tests continue to pass.
- Unrelated tools continue through the generic renderer.

## Expected File Impact

- `frontend/app/agent/assistant-ui/registry-thread.tsx`
- New semantic tool-activity components and tests under `frontend/app/agent/assistant-ui/tools/`
- `frontend/app/agent/agent-content.tsx`
- `frontend/app/workspace/workspace-agent-content-slot.tsx`
- `frontend/app/workspace/workspace-main-content.tsx`
- Focused tests for the affected component boundaries

## Non-Goals

- Changing `find`, `grep`, or `read` tool schemas or output.
- Rewriting or compacting persisted assistant messages.
- Showing raw search results or file contents inside the activity rows.
- Adding line-range navigation for offset/limit reads.
- Changing `edit`, `write`, shell, web, or MCP tool presentation.
- Opening files in the right-side editor or an external editor.
