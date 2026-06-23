# Pi Agent Commands Design

## Purpose

crest currently embeds the migrated Pi Core/Harness layer, but it does not expose Pi coding-agent's slash-command layer. Inputs such as `/tree`, `/fork`, `/clone`, `/compact`, `/skill:name`, or prompt-template invocations are treated as normal user prompts unless the frontend has a separate ad-hoc handler.

This design adds a crest-owned Pi agent command layer around the existing harness and session infrastructure. The first implementation slice prioritizes `/tree`, `/fork`, and `/clone` because these are core Pi coding-agent session workflows and crest already has most of the underlying session tree primitives.

## Scope

In scope:

- Add a unified agent command registry for command discovery and dispatch.
- Add slash command handling for the Pi coding agent input path.
- Implement `/tree`, `/fork`, and `/clone` with selector-first interactions.
- Reuse existing harness/session primitives for navigation, forking, cloning, and branch summaries.
- Keep `/model` as a command registry entry even though its action is frontend-owned.
- Leave room for `/compact`, `/skill:name`, and prompt-template commands to share the same dispatch path.

Out of scope for the first implementation slice:

- Full Pi TUI command runtime migration.
- Pi package, trust, reload, settings, OAuth, and GitHub gist share workflows.
- EntryId-first power-user command syntax such as `/tree <entryId>` or `/fork <entryId>`.
- Rich branch-summary choice UI beyond the minimal navigation path.

## Existing Capabilities

The required backend foundations already exist:

- `AgentHarness.navigateTree(targetId, options)` supports moving the active session leaf and can generate branch summaries.
- `JsonlSessionRepo.fork(sourceMetadata, options)` supports creating a new JSONL session from a selected entry.
- `Session.getBranch()`, `Session.getLeafId()`, storage labels, and session tree entries are available in the migrated harness/session code.
- `PaneAgentSession` owns the live transcript, run state, queue state, and event fan-out for a session.
- `agent-ipc.ts` already owns the per-session cache and exposes session creation, send, abort, subscribe, and list operations.

The main missing pieces are command dispatch, tree/fork selection data APIs, and frontend selector UI.

## Architecture

Add an agent command layer under `emain/agent/commands/`.

Core modules:

- `types.ts`: defines `AgentCommand`, `AgentCommandSource`, `AgentCommandResult`, command metadata, and execution context.
- `registry.ts`: builds command lists from built-ins plus dynamic resources such as skills and prompt templates.
- `builtins.ts`: registers built-in commands including `/tree`, `/fork`, `/clone`, `/compact`, `/session`, `/clear`, `/new`, `/model`, and `/help`.
- `dispatcher.ts`: parses slash input, resolves the command, and either executes a backend command or returns a frontend action.

Command dispatch should happen before normal prompt submission. If a slash input is unknown, crest should treat it as normal prompt text only after command resolution fails. This preserves Pi's behavior while avoiding accidental interception of ordinary text.

`PaneAgentSession` should remain the owner of per-session state. Command handlers should call through `PaneAgentSession` or the `PaneHarness` it owns rather than opening independent harness instances.

## IPC Design

Extend the existing `window.api.agent` IPC surface.

New read APIs:

- `agent:list-commands`: returns available command metadata for autocomplete and `/help`.
- `agent:list-tree`: returns the active session tree, current leaf id, labels, entry types, and preview text.
- `agent:list-fork-points`: returns user-message entries that can be used as `/fork` targets.

New mutation APIs:

- `agent:run-command`: generic entry point for command execution when no extra frontend selection is needed.
- `agent:navigate-tree`: executes `/tree` after the frontend selector chooses a target entry.
- `agent:fork-session`: executes `/fork` after the frontend selector chooses a user-message entry.
- `agent:clone-session`: executes `/clone` from the current leaf.

All mutation APIs should return the resolved `AgentSessionMeta` when the active block should switch to a new session. `/fork` and `/clone` create a new session and therefore return new metadata. `/tree` keeps the same session metadata but causes the owner to emit a snapshot/update after navigation.

## Frontend Interaction

Slash command input remains in the agent chat input path, not the generic Wave command system.

Selector-first behavior:

- `/tree` opens a session tree selector.
- `/fork` opens a user-message selector.
- `/clone` executes immediately and switches the current block to the cloned session.

The frontend should request command metadata for autocomplete. Built-ins and dynamic commands should appear in one list, but command sources should be visible enough for debugging and future UI grouping.

For `/model`, the registry result should return a frontend action such as `openModelPicker`. This keeps `/model` discoverable as an agent command while preserving crest's existing model-picker behavior.

## Command Semantics

### `/tree`

`/tree` lists entries in the current session tree and lets the user choose a target.

Initial behavior:

- Show current leaf.
- Show user message previews and useful entry types.
- Selecting the current leaf is a no-op.
- Selecting another entry calls `agent:navigate-tree`.
- Default to no branch summary for the first implementation slice.

Follow-up behavior:

- Add an optional prompt asking whether to summarize the abandoned branch.
- Support custom branch-summary instructions later.

### `/fork`

`/fork` lists forkable user messages and lets the user choose one.

Behavior:

- Default selection should be the most recent user message.
- Backend calls JSONL session fork with the selected `entryId`.
- New session metadata is returned to the frontend.
- The current agent block switches to the new session.
- The editor may be prefilled with the selected user message text if that matches the existing Pi behavior cleanly; otherwise this can be deferred.

### `/clone`

`/clone` duplicates the current active branch into a new session.

Behavior:

- Backend reads the current leaf id.
- Backend forks with `position: "at"`.
- New session metadata is returned.
- The current agent block switches to the cloned session.
- If the session has no leaf yet, show a friendly no-op status.

## Data Shape

Tree list rows should be renderer-safe structural objects, not raw internal session entries.

Proposed shape:

```ts
interface AgentTreeEntryView {
    id: string;
    parentId?: string;
    type: string;
    role?: string;
    label?: string;
    preview: string;
    timestamp?: string;
    isLeaf: boolean;
    isCurrent: boolean;
}
```

Fork point rows can reuse a narrower shape:

```ts
interface AgentForkPointView {
    entryId: string;
    preview: string;
    timestamp?: string;
}
```

The backend should truncate previews before sending them to the renderer.

## Error Handling

- Unknown slash command: fall through to normal prompt submission or show a non-blocking command-not-found message once autocomplete is in place.
- Busy harness: command handlers that mutate session tree should report that the current agent run must finish or be aborted first.
- Missing session metadata: `/tree`, `/fork`, and `/clone` should show a friendly "No active agent session" status.
- Missing fork target: backend returns an error from `SessionError("invalid_fork_target", ...)`, surfaced as a user-visible command failure.
- Branch-summary generation failure: navigation should not corrupt the active leaf; the command should show the failure and keep the current session unchanged.

## Testing

Backend tests:

- Command parser recognizes built-ins and rejects unknown commands.
- `/tree` command path calls `navigateTree` with the selected target.
- `/fork` command path creates a new session from a user-message entry.
- `/clone` command path forks at the current leaf.
- Busy sessions block tree mutation commands.
- List APIs return safe preview rows and mark the current leaf.

Frontend tests:

- Slash command input opens the correct selector for `/tree` and `/fork`.
- `/clone` invokes the clone API and updates session metadata.
- Command autocomplete includes built-ins, skills, and prompt templates.
- Selector cancellation does not submit the command as a prompt.

Integration checks:

- Navigate to an earlier point with `/tree`, then send a new prompt and confirm a new branch is created.
- Fork from a previous user message and confirm the original session remains unchanged.
- Clone the current leaf and confirm the new session has the same visible transcript branch.

## Migration Order

1. Add command types, registry, and parser with unit tests.
2. Add `agent:list-commands` and expose command metadata to the renderer.
3. Add backend tree/fork/clone list and mutation IPC APIs.
4. Add frontend slash-command interception and selector-first UI.
5. Implement `/tree`, `/fork`, and `/clone`.
6. Wire `/model` into the same registry as a frontend action.
7. Add `/compact`, `/skill:name`, and prompt-template dispatch on the same command path.

## Open Decisions

- Branch summary UI should be added after basic `/tree` navigation works.
- EntryId argument support should be added after selector-first behavior ships.
- Session labels can be displayed in `/tree` if existing storage labels are easy to surface; editing labels is not part of the first slice.
