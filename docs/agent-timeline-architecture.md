# Agent Timeline Architecture

This document describes the current relationship between terminal timeline
blocks, agent session state, and agent run rendering. It also defines the
architecture problem we need to solve before continuing UI work on agent/tool
cards.

Related docs:

- `docs/agent-rendering-architecture.md`
- `docs/agent-runtime-architecture.md`
- `docs/warp-agent-analysis.md`

## Summary

The timeline abstraction is reasonable: shell commands, agent turns, and future
interactive events are all ordered user-visible items in the terminal history.
The problem is not the timeline. The problem is that agent timeline blocks and
agent session messages currently live in separate stores with no single owner
responsible for creating and binding them.

Today, a timeline agent block is a marker. The actual content is recovered from
agent session messages, then the renderer derives "runs" from those messages and
matches the marker to a derived run id. That makes persistent identity depend on
a renderer algorithm. Changes to that algorithm, message order, compaction, or
subscribe timing can break old blocks and leave them stuck on
`...loading agent run...`.

The target architecture should make agent runs first-class objects owned in the
main process. The timeline should store ordered references to those runs. The
agent session should store transcript/content. A single main-side coordinator
should create both the agent run and the timeline item so identity never has to
be re-derived in the renderer.

## Current Architecture

### Main Pieces

`db_cmdblock`

- Persistent table for terminal timeline rows.
- Originally shell-command oriented.
- Now also stores agent marker rows with `kind = "agent"`.
- Agent rows carry `agent_run_id` and `agent_session_path`.

`TerminalModel`

- Renderer-side model for the terminal block list.
- Rehydrates cmdblock rows through `GetCmdBlocksCommand`.
- Creates in-memory `Block` objects.
- For `kind = "agent"`, stores only `block.agentRef.runId` and
  `block.agentRef.sessionPath`.

`PaneAgentSession`

- Main-side owner for one agent session.
- Wraps the pi `AgentHarness`.
- Maintains the authoritative transcript mirror, queue state, status, and event
  subscription.
- Replays snapshots to the renderer on subscribe.

`usePiChat`

- Renderer-side mirror of one `PaneAgentSession`.
- Receives snapshot and delta events over Electron IPC.
- Holds flat `messages`.

`slicePiRuns`

- Renderer-side function that turns flat `messages` into per-user-send runs.
- Produces `PiRun` objects used by `AgentBlockElement`.
- Historically used positional ids like `run-0`.
- Later changed to timestamp ids like `run-171...` to avoid index drift.

`AgentChatHost`

- Renderer-side bridge between `usePiChat`, `TerminalView`, and cmdblock
  persistence.
- Watches derived runs.
- Calls `AppendAgentRunCommand` to persist new agent marker rows.

## Current Flow

Live send:

1. User submits an agent prompt from the terminal input.
2. Renderer calls `usePiChat.send()`.
3. Electron main creates or opens a `PaneAgentSession`.
4. `PaneAgentSession` starts the agent run and streams message events.
5. Renderer receives a session snapshot/deltas and stores flat messages.
6. Renderer calls `slicePiRuns(messages)`.
7. `AgentChatHost` sees a new derived run and calls `AppendAgentRunCommand`.
8. Go writes a `db_cmdblock` row with `kind = "agent"` and `agent_run_id`.
9. `TerminalModel` receives or later rehydrates that row.
10. `BlockListElement` renders the marker by looking up the run in
    `agentRunsById`.

Reopen:

1. `TerminalModel` loads `db_cmdblock` rows and reconstructs timeline order.
2. Agent marker rows become `Block(kind = "agent")`.
3. `AgentChatHost` subscribes to the persisted agent session.
4. Main sends a snapshot of the agent session messages.
5. Renderer slices messages into runs.
6. `BlockListElement` matches each agent block marker to a derived run id.

## Problems

### Derived Identity Is Being Persisted

The current `agent_run_id` is not a true domain id. It is produced by a
renderer-side grouping function. That means the database stores an implementation
detail of `slicePiRuns`.

This already caused a compatibility break:

- Old marker rows stored positional ids such as `run-0` and `run-2`.
- Newer `slicePiRuns` produces timestamp ids such as `run-171...`.
- Existing marker rows can no longer match newly derived run ids without a
  compatibility fallback.

The fallback is useful for repair, but it should not become the architecture.

### Ownership Is Split Across Stores

The timeline owns ordering and marker persistence. The agent session owns
messages and context. The renderer currently owns the binding between the two.
That is the wrong layer: the renderer should render state, not mint persistent
cross-store identity.

The architecture currently has two sources of truth:

- `db_cmdblock` says an agent item exists at this position.
- Agent session JSONL says which messages exist.

No single owner can answer: "This timeline item corresponds to this exact agent
run."

### Renderer Reconstructs Semantic Runs

`slicePiRuns` turns flat messages into runs by scanning for user messages. That
is convenient for display, but it is not a stable persistence boundary. It can
break when:

- message ordering changes;
- late snapshots include more history than the live renderer had;
- compaction inserts summary messages;
- future branch/fork flows reuse or omit parts of history;
- the run grouping definition changes.

The run boundary should be recorded when the user sends the prompt, not inferred
later from transcript shape.

### Agent Marker Persistence Starts From the Renderer

Currently the renderer observes a derived run and then asks Go to append an
agent marker row. This reverses ownership:

```text
renderer derives run -> renderer appends timeline marker
```

The owner of the run is main. The timeline item should be created at the same
time as the run, by main-side code:

```text
main creates run -> main appends timeline marker -> renderer displays both
```

## What Should Stay

The timeline concept should stay. It gives the terminal one ordered history that
can mix shell blocks, agent turns, and future item types. It also keeps
scrolling, selection, historical rehydration, and block-level actions in one
place.

The agent session JSONL should also stay. It is the transcript/context store for
the agent runtime and should not be replaced by terminal output blobs.

The important change is not physical storage consolidation. The important change
is logical ownership consolidation: one owner creates and binds the timeline item
and the agent run.

## Target Architecture

### Timeline As Ordered Index, Agent Session As Content Store

Model the terminal history as a timeline of items:

```ts
interface TimelineItem {
    id: string;
    parentBlockId: string;
    kind: "shell" | "agent";
    createdAt: number;
    status: string;
    payloadRef: ShellPayloadRef | AgentPayloadRef;
}

interface AgentPayloadRef {
    sessionPath: string;
    runId: string;
}
```

Model agent turns as first-class runs owned by main:

```ts
interface AgentRun {
    id: string;
    sessionPath: string;
    userMessage: AgentMessage;
    responseMessages: AgentMessage[];
    status: "streaming" | "done" | "error";
    errorMessage?: string;
}
```

The timeline item stores order and a reference. The agent run stores semantic
agent content. The renderer joins them by stable `runId`, but it does not create
that id.

### Main-Side Coordinator

Introduce a main-side coordinator around `PaneAgentSession` and cmdblock/timeline
persistence. Its job is to handle the lifecycle of a single agent turn:

1. Receive prompt.
2. Generate a stable run id (`uuid`, `nanoid`, or session-scoped monotonic id).
3. Create an `AgentRun` in the `PaneAgentSession` owner.
4. Append a timeline item with `kind = "agent"` and `{sessionPath, runId}`.
5. Stream messages into that run.
6. Publish timeline and agent-session updates to the renderer.

The renderer should never call `AppendAgentRunCommand` based on `slicePiRuns`.

### Renderer Responsibilities

The renderer should:

- render timeline order from timeline rows;
- subscribe to agent run snapshots/deltas;
- look up `AgentRun` by stable id;
- render loading only while the run snapshot is genuinely not available yet;
- never derive persistent run identity.

`slicePiRuns` can remain temporarily as a compatibility/read model, but it
should not be the persistence source for new runs.

## Storage Options

### Option A: Logical Unification, Separate Physical Stores

Keep `db_cmdblock` as the timeline index and keep JSONL as the agent transcript
store. Add a main-side owner/coordinator that writes both.

Pros:

- Smallest migration.
- Preserves the agent runtime's native session model.
- Keeps timeline ordering in the existing table.
- Avoids stuffing large agent transcripts into terminal output rows.

Cons:

- Still has two physical stores.
- Requires careful recovery if timeline write succeeds but session write fails,
  or vice versa.

This is the recommended next step.

### Option B: Store Agent Transcript In Cmdblock Rows

Make the cmdblock/timeline table contain agent message content directly.

Pros:

- One physical store for timeline and displayed content.
- Reopen path is simple for display.

Cons:

- Mixes terminal timeline concerns with agent context persistence.
- Duplicates or replaces JSONL session semantics.
- Makes compaction, branching, provider replay, and external agent tooling
  harder.
- Turns cmdblock into a large generic object store without a clear boundary.

This is not recommended.

### Option C: New Event-Sourced Timeline Store

Create a new timeline/event store that records shell events, agent run events,
and future interactive events uniformly.

Pros:

- Clean long-term model.
- Can represent rich lifecycle events instead of static rows.
- Avoids overloading the cmdblock name and schema.

Cons:

- Larger migration.
- Needs a compatibility layer for existing shell cmdblocks.
- Higher risk while agent runtime is still moving quickly.

This may be the long-term shape, but it is too large for the immediate fix.

## Recommended Migration Path

### Phase 1: Move Agent Marker Creation To Main

- Generate stable `runId` in main at prompt start.
- Append the agent timeline row from main, not from `AgentChatHost`.
- Keep using `db_cmdblock` and existing `kind = "agent"` rows.
- Keep renderer compatibility fallback for old `run-0`/`run-2` rows.
- Stop persisting new renderer-derived run ids.

### Phase 2: Make Runs First-Class In `PaneAgentSession`

- Add explicit `AgentRun` state to `PaneAgentSession`.
- Map incoming `message_start/update/end` events into the active run.
- Expose `getSnapshot()` with both flat messages and runs during transition.
- Change renderer to consume `runsById` from main snapshots instead of
  `slicePiRuns`.

### Phase 3: Rename Concepts At The Code Boundary

- Keep the database table name if changing it is not worth the migration yet.
- Introduce TypeScript/Go names that describe the domain:
  - `TimelineItem`
  - `TimelineStore`
  - `AgentTimelineItem`
  - `ShellTimelineItem`
- Treat `cmdblock` as the legacy storage implementation, not the conceptual
  model.

### Phase 4: Clean Up Compatibility

- Keep reading old positional ids.
- Write only stable main-generated ids.
- Once old data is either migrated or old enough to ignore, remove the
  renderer-side legacy fallback.

## Open Questions

- Should `runId` be globally unique (`uuid`) or session-scoped monotonic
  (`run-1`, `run-2`)?
- Should the agent run metadata be stored in JSONL as custom entries, in a new
  DB table, or only in memory plus timeline rows?
- How should partial failure be handled if timeline row creation succeeds but
  agent session startup fails?
- Should shell command rows also be exposed through a `TimelineItem` API before
  agent migration, or after?
- How should branch/fork/compaction affect timeline items that point into agent
  session history?

## Design Principle

Do not persist identity that is derived from presentation state. If a value must
join two stores after restart, it must be minted once by the owner of the domain
object and carried through the data model unchanged.
