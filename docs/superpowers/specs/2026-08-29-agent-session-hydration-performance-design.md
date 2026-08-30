# Agent Session Hydration Performance Design

## Objective

Make selecting an existing agent session show the selected transcript promptly and truthfully. A session switch must not render the new-chat welcome state while persisted history is loading, and transcript hydration must not wait for context inspection work.

This iteration covers the core loading path only. Transcript pagination, message virtualization, and renderer-side session caching remain follow-up work.

## Current Behavior

Selecting a session changes the controlled session identity in `usePiChat`. The hook immediately clears the previous session's messages and turns, but it has no hydration state. The assistant-ui adapter therefore exposes an empty, non-loading thread, which satisfies the welcome-state predicate until the main process sends `session_state`.

For a session without a live runtime, the main process opens its SQLite database, calls `buildContext()`, and then calls `getBranch()` again. Because `buildContext()` already calls `getBranch()`, the same branch is reconstructed twice. SQLite branch reconstruction currently follows each `parent_id` with a separate synchronous query and prepends each entry to an array.

At the same time, the renderer starts context inspection. Inspection may create a full runtime, discover skills, load project instructions, rebuild context, construct the system prompt, and count context tokens. This work is useful for the context indicator but is not required to display persisted messages, so it must not be on the transcript's first-display path.

## Chosen Approach: Lightweight Transcript First

The transcript subscription remains the single authoritative source of renderer session state. Session selection starts an explicit hydration lifecycle. The main process reconstructs the persisted branch once and derives every replay projection from that one immutable branch. Context inspection starts only after the selected session's authoritative replay has arrived.

This approach preserves the existing ownership model and stale-event protections. It avoids a second pull API and does not introduce a transcript cache with new invalidation rules.

## Renderer Hydration Lifecycle

`usePiChat` will expose `isHydrating: boolean`.

- An existing initial session starts in hydration.
- Changing the controlled session to a non-empty, different identity starts hydration before paint and clears the previous session-local state.
- Explicitly selecting no session ends hydration and represents a genuine new chat.
- A `session_state` event from the current subscription ends hydration after seeding messages, turns, queues, commands, and context state.
- Events from an obsolete subscription cannot end hydration because the existing subscription epoch and active-path checks remain authoritative.
- An initial subscription failure ends hydration and surfaces the failure through the existing chat error state.

The external-store assistant adapter will pass `isHydrating` as `isLoading`. The thread welcome predicate will therefore remain false while an existing session is loading. The thread will render a compact loading state in the transcript area, while retaining the composer and its existing send gate behavior.

The preload subscription API will accept an optional error callback. A rejected `agent:subscribe` invocation will notify the current renderer subscription instead of only logging to the console. This prevents a permanent loading state without adding a competing `getSessionState` request.

## Transcript Replay Path

For a persisted session replay, main will:

1. Validate and open the session.
2. Read the selected branch once.
3. Call `buildSessionContext(branch)` for messages.
4. Call `buildPersistedTurnsFromSessionEntries(branch)` for UI turns.
5. Call `buildContextStateFromSessionEntries(branch)` for context reports.
6. Send one authoritative `session_state` event.

Runtime construction will use the same pattern: read the initial branch once, derive the seed context and initial turns from it, and pass those projections into `AgentSessionRuntime`.

## SQLite Branch Query

`SqliteSessionStorage.getPathToRoot()` will replace per-parent `getEntry()` calls with one recursive CTE over `entries(id, parent_id, data)`. The query returns the leaf-to-root chain with an explicit depth. The implementation validates the same failure cases as the current traversal:

- a missing requested leaf produces `SessionError("not_found")`;
- a chain whose final ancestor still has a `parent_id` produces an invalid-session error naming the missing parent;
- valid entries are deserialized and returned root-to-leaf.

This changes branch database access from one synchronous query per entry to one synchronous query per branch and removes repeated `Array.unshift()` operations.

## Context Inspection Scheduling

Pre-session context inspection remains immediate because no transcript needs hydration. For an existing session, the inspection effect will wait while `isHydrating` is true. The matching `session_state` event ends hydration and permits inspection on the next render.

This iteration does not redesign snapshot refresh coalescing. Duplicate snapshot refreshes that occur entirely after transcript display can be addressed separately without coupling that lifecycle to transcript correctness.

## Error Handling

- Subscription rejection ends hydration only if the failing subscription still owns the current epoch and session path.
- The failure sets chat status to `error` and stores a user-visible message.
- Switching again clears that error through the existing controlled-session reset.
- Disk parsing and authorization failures continue to reject `agent:subscribe`; preload forwards that rejection to the hook's error callback.
- Context inspection failures remain isolated in `contextInspectionError` and do not remove an already hydrated transcript.

## Testing

Renderer hook tests will prove:

- an existing initial session is hydrating before `session_state`;
- a controlled A-to-B switch clears A and keeps B hydrating until B's replay arrives;
- a stale A event cannot finish B hydration;
- clearing the controlled session ends hydration as a genuine new chat;
- subscription failure ends hydration and exposes an error;
- context inspection for an existing session does not start before replay and starts after replay.

Assistant runtime/thread tests will prove that hydration maps to `thread.isLoading` and suppresses Welcome.

Main-process tests will prove that persisted replay and runtime construction derive context and turns from one branch read. SQLite storage tests will prove root-to-leaf ordering, explicit-leaf reads, missing-leaf failure, broken-parent failure, and that branch reconstruction uses one recursive query rather than per-parent entry lookups.

## Success Criteria

- Clicking an existing session never shows the new-chat Welcome while its history is unresolved.
- Persisted transcript replay does not wait for context inspection.
- Each replay and each runtime seed reads its branch once.
- SQLite branch reconstruction issues one branch query regardless of branch length.
- Existing stale-session, subscription cleanup, active-run, and context-inspection behavior remains covered by passing tests.
