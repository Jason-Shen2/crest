# Pi Agent Command Baseline Design

## Purpose

Crest now exposes the first Pi coding-agent command slice: `/tree`, `/fork`, `/clone`, and `/model`.
That is enough for session branch navigation, but it does not yet match the baseline daily workflow of the Pi
coding agent. This design defines the next command-alignment slice before any larger UI redesign.

The goal is to make core Pi command workflows available in Crest without reintroducing inert slash menu rows.
Every command shown in the slash menu must have a real execution path and must not leak into the terminal PTY.

## Scope

In scope for this slice:

- Add `/new`, `/resume`, `/compact`, `/session`, `/copy`, `/export`, `/import`, and `/reload`.
- Keep the existing `/tree`, `/fork`, `/clone`, and `/model` behavior.
- Route all implemented backend commands through the agent command path even when the input is in terminal mode.
- Prefer minimal Crest-native UI for command completion, notifications, and selectors.
- Add tests that lock the exposed command list and prevent command text from falling through to prompt or PTY paths.

Out of scope for this slice:

- Full Pi TUI visual parity.
- Redesigning the command palette, tree selector, or session selector styling.
- Pi account, trust, sharing, changelog, hotkey, and settings workflows.
- Dynamic skill, extension, and prompt-template slash commands.
- HTML export, GitHub gist sharing, or browser-based session publishing.

## Command Baseline

The command registry should expose exactly these built-in commands after the slice:

- `/tree`: navigate the active session tree.
- `/fork`: fork from a previous user message.
- `/clone`: clone the current active branch.
- `/model`: open the model picker.
- `/new`: create a fresh agent session for the current pane/cwd.
- `/resume`: choose and attach an existing session for the current cwd.
- `/compact [instructions]`: manually compact the current session context, with optional extra instructions.
- `/session`: show current session metadata and lightweight stats.
- `/copy`: copy the last assistant message to the clipboard.
- `/export [path]`: export the current session as JSONL.
- `/import <path>`: import a JSONL session and attach it to the current pane.
- `/reload`: refresh command/runtime metadata that Crest can reload safely.

The registry should not expose commands that lack an implementation. Removed or deferred Pi commands must stay
hidden until they have a real backend or frontend action.

## Deferred Pi Commands

The following Pi commands are intentionally deferred:

- `/settings`: depends on a broader Crest settings surface and should be designed with the later UI pass.
- `/scoped-models`: Crest currently has its own model-picker behavior; scoped model cycling needs separate UX.
- `/trust`: Pi project trust does not map directly to Crest's current app model.
- `/login` and `/logout`: authentication semantics are provider-specific and should not be mixed into the baseline.
- `/share`: depends on GitHub CLI and gist publishing, which is higher risk and less central to coding flow.
- `/name`: useful but not required for baseline command parity.
- `/hotkeys` and `/changelog`: informational commands that can wait until command docs/help are designed.
- `/quit`: ambiguous inside an Electron terminal pane and should not close the wrong layer.

## Architecture

The command registry remains the source of truth for renderer slash autocomplete. The renderer must build the
slash menu from `agent:list-commands` and fall back to the same implemented baseline list only when IPC is
unavailable.

Backend commands should use a small generic command execution surface only where no frontend selector is needed.
Selector-first commands such as `/tree`, `/fork`, and `/resume` can keep dedicated list/mutation APIs because
the renderer must display choices before execution.

Recommended split:

- Keep `emain/agent/commands/registry.ts` focused on metadata and parsing.
- Expand `emain/agent/commands/types.ts` with the new backend action names and result shapes.
- Add focused session command helpers near `emain/agent-ipc.ts` or a new `emain/agent/commands/session-commands.ts`.
- Keep renderer routing inside `AgentChatHostApi.submit()` so all slash commands enter the same safety gate.
- Keep `CmdBlockInput` action handling generic: exact implemented slash commands submit through agent mode.

## Command Semantics

### `/new`

Creates a new empty agent session for the pane's current cwd and switches the current agent block to it.

Expected behavior:

- Requires a cwd.
- Does not delete or mutate the previous session.
- Returns new session metadata.
- Clears any queued command text after success.

### `/resume`

Opens a session picker for sessions associated with the current cwd and attaches the selected session.

Expected behavior:

- Lists sessions through the existing session metadata store.
- Shows enough metadata for selection: modified time, session name if present, path basename, and message count when cheap.
- Selecting a session switches the current block to that session.
- Empty state explains that there are no sessions for the cwd.

### `/compact [instructions]`

Runs manual context compaction for the current active session.

Expected behavior:

- Requires an active session.
- Blocks while an agent run is active unless the underlying runtime already queues compaction safely.
- Passes optional instructions to the compaction operation.
- Emits a visible success or failure message.
- Does not expose `/compact` until the backend path is wired.

### `/session`

Shows current session information in a lightweight Crest notification or panel row.

Expected behavior:

- Requires an active session.
- Shows session path, session id or basename, cwd, active leaf id, visible message count, and rough token/cost stats only if available.
- Does not block the editor.

### `/copy`

Copies the last assistant message from the current visible transcript to the clipboard.

Expected behavior:

- Requires an active session with at least one assistant message.
- Copies plain text, not rendered HTML.
- Shows a success message with a short character count.
- Shows a friendly no-op message when no assistant message exists.

### `/export [path]`

Exports the current session as JSONL.

Expected behavior:

- Requires an active session.
- If a path is provided, writes to that path after validation.
- If no path is provided, writes to a deterministic default export path or opens the platform save flow if Crest already has one.
- Returns the written path and shows it to the user.
- HTML export remains deferred.

### `/import <path>`

Imports a JSONL session file and attaches it to the current pane.

Expected behavior:

- Requires a path argument.
- Validates that the file is readable JSONL session data.
- Creates or registers a Crest session metadata record.
- Switches the current block to the imported session.
- Shows a clear error for unreadable, invalid, or unsupported files.

### `/reload`

Refreshes command/runtime metadata that Crest can safely reload without restarting the app.

Expected behavior:

- Refreshes command metadata exposed by `agent:list-commands`.
- Refreshes renderer slash menu state.
- Leaves deeper Pi package, skill, prompt, theme, and extension reloads for later.
- Shows a success message listing what was refreshed.

## UI Guidance

This slice should not attempt full Pi TUI parity. Use existing Crest primitives first:

- Immediate commands use non-blocking notifications for success, no-op, and failure.
- Choice commands must use the same anchor, placement, and visual treatment as `/model`.
- `/tree`, `/fork`, and `/resume` open above the input box, aligned to the input/menu anchor, not as centered dialogs.
- Selector popovers should match `/model`'s surface style: `FloatingPortal`, `useFloating({ placement: "top-end" })`, `offset(6)`, `flip`, `shift`, width near `340px`, rounded border, `bg-fg-overlay-1`, `border-fg-overlay-3`, `shadow-xl`, and backdrop blur.
- Selector keyboard behavior should match `/model`: search or focusable input receives focus on open, arrow keys move rows, Enter selects, Escape dismisses, outside click dismisses.
- `/resume` can reuse the selector-popover shell with a new session-row renderer, but the shell must be model-picker aligned.
- `/session` can start as a compact read-only info card or notification text.
- `/export` and `/import` should prefer explicit paths in this slice; richer file picker UI can be added later.

The later UI pass should compare row content and information hierarchy against Pi TUI components such as
`tree-selector.ts`, `user-message-selector.ts`, `session-selector.ts`, `settings-selector.ts`, and
`model-selector.ts`. The placement and base popover styling should already be consistent with Crest's
`ModelPickerPopover`.

## Error Handling

- Unknown slash commands are not shown in autocomplete and continue to behave as ordinary input.
- Implemented backend commands must be intercepted before terminal PTY submission.
- Commands that require an active session return a friendly user-facing message when no session exists.
- Commands that mutate session state should reject or queue safely while the agent is busy.
- Import/export file failures should include the path and a short reason.
- Clipboard failures should surface a concise error rather than silently failing.

## Testing

Backend tests:

- Registry exposes the exact baseline command list.
- Parser preserves command arguments for `/compact`, `/export`, and `/import`.
- IPC command helpers reject missing session metadata with user-safe messages.
- `/new`, `/resume`, `/copy`, `/export`, `/import`, and `/reload` return typed success/no-op/failure results.

Frontend tests:

- Slash autocomplete lists only implemented baseline commands.
- Exact backend commands call `submitWith("agent", command)` regardless of terminal or agent input mode.
- Slash menu clicks execute implemented commands directly rather than inserting text.
- `/resume` opens a selector instead of sending `/resume` as a prompt.
- `/model` still opens the model picker.
- `/tree`, `/fork`, and `/resume` selector surfaces use the same input-anchored popover contract as `/model`.

Manual checks:

- Run each exposed slash command from agent mode.
- Run each exposed slash command from terminal mode and confirm it never reaches the PTY.
- Verify no deferred commands appear in the slash menu.

## Rollout Order

1. Expand command metadata and routing tests for the full baseline list.
2. Add lightweight backend execution/results for `/new`, `/session`, and `/copy`.
3. Add `/compact` only after the manual compaction backend path is verified.
4. Add `/resume` selector and session attachment behavior.
5. Add JSONL `/export` and `/import`.
6. Add `/reload` metadata refresh.
7. Re-run the slash menu bug regression tests before exposing the new commands.
