# Agent Tool-Driven File Cards

## Goal

Make Agent file cards appear from structured file-edit tool calls, matching OpenCode's behavior instead of relying on the final assistant response to contain a fenced Markdown diff.

## Scope

- Render a diff file card for successful `edit` tool calls.
- Render a full-file content card for `write` tool calls.
- Keep fenced `diff` and `patch` Markdown rendering as a compatibility path.
- Keep all other tools on the existing generic tool renderer.
- Preserve the existing OpenCode-style file header and collapse interaction.

This change does not infer changes from the filesystem and does not create cards for shell commands or external file modifications.

## Architecture

`getCrestToolRenderer(toolName)` will select a specialized renderer for `edit` and `write`. Other tool names will return `ToolFallback`.

The specialized renderers will live with the existing assistant tool UI:

- `EditToolCard` reads the completed tool result's `details.patch` and the path from `details.changeOperation.path`, falling back to `args.path` for the label. It passes a valid patch to `DiffViewer`.
- `WriteToolCard` reads `args.path` and `args.content` and renders the complete file in a collapsible code card. Its header uses the same visual language as the diff card but omits addition and deletion statistics.

The runtime bridge remains responsible only for pairing tool calls with tool results. It will not convert tool results into Markdown or synthetic message parts.

## States and Fallbacks

- While a tool is running or awaiting approval, use `ToolFallback` so the current status and approval controls remain available.
- If an `edit` call fails, lacks a patch, or contains an unparseable patch, use `ToolFallback`.
- If a `write` call lacks a string path or content value, use `ToolFallback`.
- Completed, valid specialized cards are collapsed or expanded through their file header and do not show the generic arguments/result payload.

## Data Flow

1. The coding-agent `edit` or `write` tool executes.
2. The tool result is paired with its originating tool call by `runtime-bridge.ts`.
3. The assistant message asks `getCrestToolRenderer()` for the tool-specific component.
4. The specialized component validates the structured arguments/result.
5. Valid data renders the file card; invalid or incomplete data renders `ToolFallback`.

## Testing

Tests will be written before production changes and will cover:

- Renderer selection for `edit`, `write`, and an unrelated tool.
- A completed `edit` result rendering `DiffViewer` with the edited path and patch.
- A completed `write` result rendering the complete file content and filename.
- Running, failed, missing-data, and malformed-patch cases falling back safely.
- Existing fenced Markdown diff rendering continuing to work.

## Non-Goals

- Detecting arbitrary filesystem changes.
- Generating diffs for shell commands.
- Adding an `apply_patch` UI before Crest exposes an `apply_patch` tool.
- Changing the coding-agent tool result schema.
