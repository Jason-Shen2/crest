# Pi Inline Command Feedback Design

## Goal

Make `/session`, `/copy`, `/compact`, `/export`, `/import`, and `/reload` feedback match Pi's terminal-inline command result behavior instead of Crest's existing toast notification path.

## Scope

- Keep `/model`, `/tree`, `/fork`, and `/resume` as input-anchored selector popovers.
- Change only execution-result feedback for `/session`, `/copy`, `/compact`, `/export`, `/import`, and `/reload`.
- Do not redesign the whole chat area, terminal grid, cursor, or alt-screen behavior.
- Do not use toast/popover UI for these six command results.

## Behavior

- `/copy`, `/export`, `/import`, and `/reload` render a dim inline status line in the agent content area.
- `/session` renders a structured inline info block headed `Session Info`, preserving Pi-style sections for file, messages, tokens, and cost.
- `/compact` renders an inline compaction summary block on success and an inline error/status line on no-op or failure.
- New sessions returned by `/import` still switch the active pane session through the existing `onSessionMinted` callback.

## UI Shape

- Inline command feedback is appended to the agent pane content stream, below existing agent messages.
- Status lines use subdued text and monospace-friendly spacing.
- Structured blocks use the existing foreground/background palette and light borders, but stay inline with content rather than floating above the input.
- The latest approved mock is `docs/superpowers/mockups/pi-command-feedback-mock.html`.

## Testing

- Add unit tests for routing immediate command results into an inline result callback rather than `onUserError`.
- Add render tests for the new inline result component:
  - status command result
  - `/session` structured block
  - `/compact` summary block
  - error/no-op line
- Keep existing selector and slash-routing tests passing.
