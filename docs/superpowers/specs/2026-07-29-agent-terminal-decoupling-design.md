# Agent–Terminal Complete Decoupling Design

**Date:** 2026-07-29

## Problem

The Workspace Agent send path currently imports Terminal state into `AgentExecutionContext`:

- `WorkspaceApp` reads `activeTerminalTabId`;
- `useWorkspaceAgentTerminalContext` subscribes to Terminal Tab, Layout, Block, and command-row state;
- the renderer sends `preferredTerminalTabId`, `connection`, and `recentCmds`;
- the main process validates the preferred Terminal before accepting the Agent request.

This makes an Agent message sensitive to Terminal lifecycle. A Workspace with no
Terminal represents the missing active Terminal as an empty string, which caused
the main-process Agent context parser to reject the send. Normalizing that empty
string prevents the immediate exception but preserves the incorrect ownership
boundary.

The existing Workspace architecture requires the Agent to work with zero
Terminal Tabs and forbids Agent execution from depending on a Tab, Layout,
Block, `TerminalModel`, or Terminal inventory.

## Decision

Agent and Terminal will be completely decoupled. Terminal state will not appear
in Agent persistence, renderer context construction, IPC contracts, prompt
inputs, runtime authentication, or backend lifecycle handling.

The invariant is:

> Creating, activating, switching, failing, or closing a Terminal cannot change
> Agent state, Agent revision, Agent prompt, or the validity of an Agent request.

## Ownership Boundaries

### Workspace Agent state

Workspace Agent state owns only Agent presentation state:

- active Agent session;
- selected Agent model.

`preferredTerminalTabId` is removed from the persisted Go type, generated
frontend type, local Agent state, checkpoint reconciliation, and tests. Closing
a Terminal no longer edits Agent state or increments `agentrevision`.

Persisted JSON created by development builds may still contain the removed key.
The current POC does not require backward compatibility; Go and TypeScript
hydration simply stop reading and writing it.

### Agent execution context

The renderer-to-main execution contract contains only Agent- or
Workspace-owned values:

```ts
interface AgentExecutionContext {
    workspaceId: string;
    workspaceDir: string;
    sessionPath?: string;
    environment: Record<string, string>;
    gitBranch?: string;
}
```

The following fields are removed:

- `preferredTerminalTabId`, because it is presentation state with no execution
  consumer;
- `connection`, because its current value comes from the active Terminal Block
  and only decorates the prompt;
- `recentCmds`, because its current value comes from Terminal command rows.

Agent PTY commands continue to use `workspaceDir` and `environment`. Agent
session identity and authenticated Workspace sender validation remain
unchanged.

If future product work needs remote Agent execution or Agent-owned command
history, it must introduce an Agent/Workspace-owned provider and a separately
reviewed contract. It must not read Terminal state through the Agent context
builder.

### Terminal

Terminal inventory, active Terminal selection, Layout, Block metadata, shell
integration, and command rows remain owned by the Terminal subsystem. No Agent
module subscribes to them or imports their context helpers.

## Data Flow

After the change, an Agent send follows this path:

1. `WorkspaceApp` builds Agent context from authenticated Workspace identity and
   `workspace:dir`.
2. `AgentContent` adds the active Agent session path.
3. `usePiChat` sends the Agent-owned context through `AgentRuntimeClient`.
4. The main process authenticates the Workspace renderer and parses the minimal
   context without consulting Terminal membership.
5. The Agent runtime builds its prompt and tool environment from Workspace and
   Agent values only.

There is no Terminal-derived branch in this flow. A zero-Terminal Workspace and
a Workspace containing active Terminals produce the same Agent context for the
same Workspace and Agent session.

## Code Changes

### Renderer

- Remove `useWorkspaceAgentTerminalContext` and its Tab/Layout/Block/cmd-row
  subscriptions.
- Remove Terminal-derived inputs from
  `buildWorkspaceAgentExecutionContext`.
- Stop reading `activeTerminalTabId` for Agent context construction.
- Remove `preferredTerminalTabId` from `WorkspaceAgentModel`,
  `LocalWorkspaceAgentState`, serialization, checkpoint comparison, and sync.
- Delete tests whose purpose is to feed Terminal context into Agent.

### Shared and main-process contract

- Remove the three Terminal-derived fields from the shared
  `AgentExecutionContext`.
- Remove them from the parser allowlist and output.
- Remove preferred-Terminal membership validation from Agent context parsing
  and sender resolution.
- Stop passing Terminal `connection` and `recentCmds` into Agent system-prompt
  inputs.
- Update preload/global TypeScript declarations.

### Backend persistence

- Remove `PreferredTerminalTabId` from `WorkspaceAgentState`.
- Remove validation that binds Agent checkpoints to Terminal inventory.
- Remove Terminal-close mutation of Agent state and `agentrevision`.
- Regenerate derived frontend Go types rather than editing generated files.

## Error Handling

Agent sends may still fail for genuine Agent/Workspace errors, including an
unauthenticated renderer, stale Workspace generation, invalid Workspace
directory, unavailable runtime, or invalid session path.

Missing, stale, or failed Terminal state is not an Agent error and is never
consulted during Agent request validation.

## Testing

The implementation uses test-driven changes at each boundary:

- parser tests reject removed Terminal-derived keys as unexpected input;
- context-builder tests prove its output is identical regardless of Terminal
  inventory or active Terminal selection;
- Workspace integration tests prove a zero-Terminal Agent can send and that
  Terminal changes do not alter Agent context;
- frontend Agent state tests contain no Terminal preference or reconciliation;
- backend checkpoint tests prove Agent state is independent of Terminal
  inventory;
- Terminal-close tests prove closing a Terminal does not mutate Agent state or
  increment `agentrevision`;
- Agent PTY and send tests continue to prove `workspaceDir` and `environment`
  drive execution.

Relevant frontend, main-process, shared-package, and Go service tests must pass.
Generated files must be clean after regeneration, and the final diff must
contain no Terminal-context imports in the Workspace Agent context module.

## Non-Goals

- Changing Terminal navigation or rendering.
- Changing Agent session storage or runtime ownership.
- Adding remote Agent execution.
- Adding a replacement command-history provider.
- Migrating unreleased POC data containing `preferredterminaltabid`.
