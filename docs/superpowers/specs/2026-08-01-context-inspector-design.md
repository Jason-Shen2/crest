# Context Inspector Design

**Status:** Implemented in `codex/context-inspector`

The implementation follows this design without changing its product boundary: the first release is read-only, runtime-owned, and represents the next effective model input rather than cumulative usage or the durable transcript.

## Goal

Give users a clear, trustworthy view of the effective context the current Agent will carry into its next model call.

The first release is read-only. Its value is not another token-usage page; it is a semantic inventory that explains what the Agent currently knows, where that information came from, and how much input capacity it consumes.

## Product Definition

The Context Inspector displays the effective context for the current session's active branch and current model. It does not display the complete transcript and does not treat cumulative provider usage as current context.

The core distinction is:

- **Transcript:** the durable conversation record.
- **Current context:** the subset and transformed representations that will be sent to the model.

The first release does not modify either one. Future management will change the current-context projection without deleting transcript entries. The read-only design must therefore preserve the identity and provenance of every displayed item.

## Scope

### In scope

- Open a dedicated Context tab in the right panel by clicking the existing context ring.
- Show effective input usage against the model's usable input capacity.
- Show semantic context categories and their token contributions.
- Expand categories into concrete sources.
- Expand conversation turns into user, assistant, and tool activity.
- Show compact summaries as context items with the turn range they replace.
- Update the view as the Agent runs.
- Distinguish exact, estimated, waiting, stale, and unavailable data.
- Preserve item identity and provenance so later context-management work can build on the same inventory.

### Out of scope

- Excluding or restoring context items.
- Editing messages, prompts, rules, skills, tools, or attachments.
- Triggering compact or fork actions.
- Deleting transcript data.
- Browsing transcript entries that are not in effective context.
- Showing a raw provider payload or JSON request inspector.
- Counting unsent composer text as current context.

## Chosen Information Architecture

The Inspector uses semantic source categories rather than provider message roles.

Fixed category order:

1. **Agent instructions**
2. **Tools**
3. **Conversation**
4. **Added context**

This structure answers why content is present. A role-only split such as system, user, assistant, and tool would mix tool definitions with tool outputs and would obscure the source of injected context.

Provider roles remain available inside Conversation details where they help explain an individual turn.

### Agent instructions

Includes locally known instructions that shape Agent behavior, such as:

- the Crest base system prompt;
- project instructions and context files;
- active skill instructions;
- runtime-generated environment guidance.

An item remains in this category even when its final provider representation is a system-message fragment.

### Tools

Includes definitions and schemas for tools currently available to the model. Tools may be grouped by source for scanning, while an expanded group identifies concrete tool definitions.

Tool results do not belong here. They belong to the Conversation turn that produced them.

### Conversation

Shows only effective conversation history in chronological order.

- The primary unit is a complete turn, not a raw message part.
- Expanding a turn reveals user content, assistant content, and paired tool calls/results.
- A compact summary is an independent effective item and identifies the turn range it replaces.
- Original turns replaced by compact are not counted or listed as active context.
- Tool call/result relationships remain explicit so the UI and future management cannot leave invalid orphaned pairs.

### Added context

Includes explicit context supplied through attachments, files, selections, images, or cross-session/turn references.

Items are categorized by semantic origin, not final injection location. For example, a cross-session summary remains Added context even if the request builder renders it into the system prompt.

## Panel Structure

The right-panel Context tab contains four levels of information.

### Header

Shows:

- current state and accuracy;
- model identity;
- the snapshot's update status.

### Capacity summary

Shows the same usage represented by the composer ring:

```text
effective input context / effective input capacity
```

Effective input capacity is:

```text
model context window - reserved output capacity
```

The panel also displays the full model window, output reserve, and remaining input capacity.

### Composition

A part-to-whole bar shows the four semantic categories and any separately identified request overhead. Category rows show token count, percentage of used input context, source count, and a concise description.

### Expandable inventory

- Expanding a category shows concrete source items.
- Expanding a Conversation turn shows user, assistant, and tool activity.
- Each item exposes enough preview and provenance to explain why it is present without defaulting to raw JSON.

## Context Ring Semantics

The ring must no longer combine the previous call's input, output, cached input, and reasoning usage.

Its percentage is:

```text
current effective input tokens
-----------------------------------------------
model context window - reserved output tokens
```

Rules:

- Output and reasoning from the previous call are not current input context.
- Cached input is a cache property of existing input tokens and is not counted a second time.
- The ring and panel use the same Context Snapshot and therefore cannot disagree.
- The ring becomes available as soon as a model and initial snapshot are ready. A new session already has instructions and tools before the first user message.

## Snapshot Time Semantics

The Inspector follows the Agent in real time.

### Idle

Show the effective base context inherited by the next call. Do not include unsent composer text or pending attachments that have not been submitted.

### Provider request in flight

Show the provider-ready context for the active request and mark it `In use`. This is the most authoritative snapshot available before the provider responds.

### Tool execution

Completed tool results become part of the Conversation context. A tool that has not returned is not counted. While a result is pending, the panel shows `Waiting for tool result`.

### After compact or model change

Rebuild immediately against the compacted branch or new model limits and tokenizer behavior.

## Source of Truth and Data Flow

The React UI must not reconstruct context by reading transcript messages or the last assistant usage block.

The request-construction path produces two outputs from the same semantic inputs:

```text
instructions + tools + effective turns + added context
                         |
                         v
             context/request construction
                         |
             +-----------+-----------+
             |                       |
             v                       v
      provider-ready request    Context Snapshot
```

If an item is in the provider-ready request, it has a corresponding semantic item or accounted request overhead in the Context Snapshot. If it is absent from the request, it cannot be presented as active context.

The UI only renders the latest matching snapshot. It does not tokenize or infer category ownership.

## Future Management Compatibility

The first release implements no context actions, disabled controls, exclusion journal, or projection editor.

It must still retain enough identity to support later management safely:

- each displayed source maps to a durable source identity rather than a list index;
- turns retain their message-entry identities;
- tool calls and results retain pairing relationships;
- compact summaries identify the source range they cover;
- attachments retain their artifact/reference identity;
- semantic category and provenance survive provider transformation.

Later context management can add an independent projection policy that excludes or restores these identified units while leaving the transcript untouched. That future policy is not part of this implementation.

## Token Counting and Accuracy

The total input count must be taken from the final provider-ready request whenever a compatible counter exists.

User-visible accuracy states:

- **Exact:** a reliable model-compatible counter measured the provider-ready request.
- **Estimated:** a local tokenizer or documented approximation was used.
- **Waiting:** the request is not yet complete, such as while a tool result is pending.
- **Unavailable:** the request inventory is known but a token count cannot be produced.

Semantic item attribution may be less precise than the final total because provider envelopes, message framing, JSON schemas, and token boundaries add overhead. The design must not silently rescale semantic categories to manufacture exact agreement.

Any unassigned difference is represented explicitly as **Request overhead**. The sum of semantic categories and request overhead must match the displayed effective input total within the declared counting accuracy.

If a provider adds hidden server-side input that Crest cannot inspect, the product may show a provider-reported unknown difference after the fact, but it must not attribute that difference to a known local source.

## Snapshot Lifecycle

Rebuild or invalidate the Context Snapshot when:

- a session is opened or switched;
- the active branch changes;
- the selected model changes;
- instructions, context files, skills, tools, or runtime prompt inputs change;
- a user message is submitted;
- a provider request is finalized;
- a tool result returns;
- compact completes.

Do not recalculate context on every composer keystroke.

Snapshot identity includes the session, active branch/leaf, model, and revision needed to reject mismatched results.

## User-Visible States

Lifecycle and counting accuracy are independent. The UI combines one lifecycle state with the best available accuracy label rather than assuming that every idle preview is estimated or every in-flight request is exact.

Lifecycle states:

- **Ready:** idle preview of the next call's inherited context.
- **In use:** provider-ready request currently in flight.
- **Waiting for tool result:** the next request cannot yet be finalized.
- **Updating:** session, branch, model, or resources changed and a replacement snapshot is being built.
- **Out of date:** the same session's refresh failed and a previous snapshot is still being shown with its timestamp.
- **Unavailable:** no trustworthy inventory can currently be produced.

Where a count is present, the lifecycle state is accompanied by **Exact** or **Estimated**. A missing count is labeled **Token count unavailable** without hiding the known semantic inventory.

On session, branch, or model identity changes, the old snapshot is cleared immediately rather than displayed under the new identity.

For a refresh failure within the same identity, the last valid snapshot may remain visible only with an explicit `Out of date` label and timestamp.

## Failure Isolation

- Token-counter failure degrades counts to estimated or unavailable while preserving the semantic inventory where possible.
- Inspector construction or rendering failure must not block message submission, provider calls, tool execution, or session persistence.
- Unknown provider-side content remains unknown; it is never fabricated as a local item.
- A malformed individual source should produce a source-level diagnostic or accounted unknown contribution rather than corrupt the entire session UI.

## Performance

- Tokenization and snapshot construction belong outside React rendering.
- The UI subscribes to immutable snapshots and performs formatting and expansion only.
- Lifecycle updates may be coalesced, but a provider-ready snapshot must correspond to the actual dispatched request.
- Long Conversation inventories use incremental rendering or virtualization.
- Category totals are computed for the complete snapshot and do not depend on which rows are currently rendered.

## Architectural Boundaries

The likely boundaries in the existing codebase are:

- the Agent harness/request path owns semantic request inputs and provider-ready construction;
- the coding-agent context layer owns Context Snapshot modeling, provenance, validation, and token-accounting policy;
- the Agent host/runtime transports current snapshot state to the frontend;
- the workspace/right-panel model owns opening and selecting the Context tab;
- React components own only presentation, expansion state, and accessibility.

The exact file-level implementation belongs in the implementation plan. The design constraint is that provider request construction and Context Snapshot construction share one semantic source of truth.

## Testing

### Unit tests

- effective input capacity subtracts the configured output reserve;
- cached input, output, and reasoning are not double-counted as current input;
- semantic categories plus Request overhead reconcile with total input within declared accuracy;
- items retain stable source identity and category provenance;
- complete turns group user, assistant, and tool activity correctly;
- tool calls remain paired with their results;
- compact summaries identify covered turns and replace them in effective context;
- stale snapshots are rejected after session, branch, or model identity changes.

### Integration tests

- a new session shows instructions and tools before its first prompt;
- a normal multi-turn session updates Conversation after each completed turn;
- repeated model calls during a tool loop update the active snapshot;
- a completed tool result appears exactly once;
- compact replaces covered turns with its summary and reduces the active inventory;
- Added context retains semantic category across provider rendering;
- session, branch, and model switching never leaks the previous snapshot;
- unavailable token counting leaves Agent execution operational.

### UI tests

- clicking the context ring opens the right panel and selects Context;
- the ring and panel display the same usage;
- category and turn expansion work with mouse and keyboard;
- status and accuracy labels reflect snapshot state;
- narrow layouts reflow without clipping essential values;
- long Conversation lists render incrementally without changing totals.

## Acceptance Criteria

- A user can quickly identify current usage, remaining input capacity, the largest context source, and whether counts are exact or estimated.
- Every displayed semantic item can be traced to a real rule, skill, tool, turn, compact summary, attachment, or explicitly unknown overhead.
- The ring, category totals, and effective input total are internally consistent.
- New sessions, tool loops, compact, branch changes, model changes, and failure states update without showing mislabeled stale data.
- Context Inspector failures never block Agent work.
- The first release contains no context mutation behavior while preserving source identity needed for a later projection-management layer.
