# Agent Progress Disclosure Design

## Context

The current agent run UI exposes tool-call cards too directly. That is useful for debugging, but it does not match the default user expectation for Crest's built-in agent. Most users want to understand what the agent is doing and whether it is making progress. They do not usually care which low-level tool produced each intermediate result.

This design keeps full technical traceability, but changes the default presentation from "tool log" to "agent work narrative".

## Product Goals

- Show a user-friendly overview while the agent runs, so users are not left wondering what is happening.
- Hide tool names from the default overview.
- Let users expand each step to understand how the agent achieved it.
- Preserve complete tool-call details for debugging, auditing, and trust.
- Keep completed agent runs compact enough for the terminal timeline.
- Make failures, risky actions, and recoverability obvious.

## Non-Goals

- This does not redesign the agent runtime, IPC ownership model, or run slicing model.
- This does not remove tool-call details.
- This does not expose chain-of-thought or internal model reasoning.
- This does not require implementing a full observability product in the first iteration.
- This does not solve all permission and rollback mechanics; it defines the UI hooks they should surface through.

## Current Implementation Constraints

- `frontend/app/term/render/agent-block-element.tsx` renders one `PiRun`.
- `AgentBlockElement` currently walks assistant messages and renders assistant text, thinking blocks, images, and `ToolCallCard` instances.
- `frontend/app/term/render/tool-call-card.tsx` owns the current tool card UI and already understands common tool kinds such as command, modify, read, search, find, list, fetch, and generic.
- Tool results are paired by `toolUseId` / `toolCallId` in `AgentBlockElement`.
- The agent block in the terminal engine is only a timeline marker. The renderer resolves a stable run id into `PiRun` data.

The design should therefore sit primarily in the renderer layer: derive a product-facing progress model from the existing message/tool-call stream, then render that model with progressive disclosure.

## Industry References

The strongest products converge on the same pattern: summarize first, disclose details on demand.

- Cursor and Claude Code use plan modes and permission modes to separate planning, reading, editing, terminal usage, and higher-risk actions.
- Devin exposes progress steps that can be clicked to inspect shell commands, code edits, browser activity, and outputs.
- Replit Agent uses plan mode, task state, work logs, test results, preview, checkpoints, and rollback.
- GitHub Copilot cloud agent makes progress auditable through branches, commits, pull requests, Actions logs, and review.
- ChatGPT Agent emphasizes running narration, pause/stop/take-over controls, and confirmation gates.
- Trace/debug tools such as Langfuse, Datadog, Sentry, GitHub Actions, and browser DevTools use progressive disclosure, failed-node auto-expansion, search/filter, deep links, and large-output folding.

The main lesson for Crest: the default UI should not display more logs. It should display the evidence users need to judge progress, risk, quality, and recoverability.

## Information Architecture

Use four progressively deeper layers.

### Layer 1: Stage Overview

This is the default view inside an agent run.

Each row represents a user-understandable stage, not a tool call. Example stages:

- Understand goal
- Explore implementation
- Design changes
- Modify files
- Verify result
- Summarize outcome

The row contains:

- Status icon: pending, running, done, failed, skipped.
- Stage title: human-readable and stable while the stage runs.
- One-line summary: current action while running, final summary when done.
- Optional badges: plan state, checkpoint number, risk level, approval needed, validation result.
- Expand chevron.

Default overview must not show raw tool names such as `SearchCodebase`, `Read`, `Grep`, `RunCommand`, or MCP tool identifiers.

### Layer 2: Running Stage Activity

The current running stage is expanded enough to show progress without becoming a log.

Use the approved pattern: current stage plus recent actions.

- The stage title remains stable.
- The summary line shows the current user-friendly action, for example "正在确认 tool result 如何和调用配对...".
- A short list shows the most recent 2-3 user-friendly actions.
- As the stage completes, those actions collapse into a final stage summary.

Recent actions are product-facing statements, not tool names. Examples:

- Found the agent message rendering entry point.
- Confirmed how tool results are paired with calls.
- Checked the existing detail expansion structure.

### Layer 3: Stage Detail

When a user expands a completed or running stage, show a second level of explanation. This level still speaks in user-facing terms.

Each stage detail contains action groups. An action group explains what was accomplished and may aggregate multiple tool calls.

Action group fields:

- Title: "Found the rendering entry point".
- Outcome summary: "Confirmed that agent runs are rendered by `AgentBlockElement` and tool calls by `ToolCallCard`."
- Status: success, running, failed, skipped.
- Duration when available.
- Risk label: read-only, file edit, command, network, MCP/external, destructive.
- Tool-call count.
- High-value evidence: changed files, diff summary, command status, validation result, linked preview, error summary.
- A nested "View technical calls" control.

This layer should make the agent's work understandable even if the user never opens raw tool details.

### Layer 4: Technical Trace

This is the full implementation detail layer.

It can show:

- Raw tool name.
- Tool input summary and full input.
- Tool result summary and full output.
- stdout/stderr for commands.
- diff for file modifications.
- error details and stack traces.
- duration and retry count when available.
- copy raw data.

Large output should be folded by default. Raw details should be reachable, but not visually dominant.

## Running-State Design

The running state should optimize for confidence, not verbosity.

Rules:

- Auto-expand the current stage.
- Show exactly one primary current-action line.
- Show at most 3 recent user-friendly actions.
- Keep completed stages collapsed by default.
- Keep pending stages visible but subdued.
- If no visible progress arrives for a while, update the current-action copy to indicate continued work, such as "Still analyzing the current file..." or "Waiting for command output...".
- If the agent is waiting for approval, replace the running action with an explicit call to action.

Recommended visual shape:

- Status icon on the left.
- Bold stage title.
- Optional badges on the title row.
- Summary text below.
- Recent actions below the summary only for the active stage.

## Completed-State Design

After a run completes:

- Keep the stage overview visible.
- Collapse running-only recent actions into final summaries.
- Highlight high-value evidence: files changed, tests run, previews created, errors encountered, checkpoints created.
- Keep technical details available under expansion.
- Do not leave a long list of raw tool cards in the default timeline.

## Failure Design

Failures need stronger treatment than a red tool card.

When a stage fails:

- Mark the stage failed in the overview.
- Auto-expand the failed stage.
- Auto-expand the most relevant failed action group.
- Show a concise failure summary before raw details.
- Show impact: whether the final result is blocked, partially complete, or recoverable.
- Show next actions when possible: retry, continue, edit prompt, approve, inspect trace, revert.

Failure detail should include:

- User-friendly error title.
- Technical error message.
- Failed tool call.
- Relevant input/output excerpts.
- Retry history if any.
- Link or control to view the full technical trace.

## Risk And Permission Semantics

Borrow from mature coding agents: users should know the safety class of what is happening.

Use risk badges at stage and action-group level:

- Read-only: searching, listing, reading local files.
- File edit: applying patches or writing files.
- Command: running shell commands.
- Network: fetching URLs or external web calls.
- External/MCP: calling external integrations.
- Destructive: deleting files, stopping processes, killing sessions, irreversible actions.

The overview should surface only important risk information:

- "Read-only exploration" can be a subtle badge.
- "Needs file edit approval" should be prominent.
- "Command failed" should be prominent and linked to the failed action.

## Checkpoints And Recovery

The UI should make recoverability visible when the runtime supports it.

Checkpoint-related UI hooks:

- A run-level badge such as "Checkpoint 2".
- Stage-level evidence such as "Created checkpoint before editing files".
- Completed-state summary such as "2 files changed · validation passed · checkpoint available".
- Failure-state actions such as "Revert to checkpoint" or "Continue from here".

If checkpoints are not implemented yet, the first implementation can show no checkpoint UI. The component interfaces should still allow stage metadata to carry checkpoint ids later.

## Trace Tooling

The deepest technical layer should borrow from trace and developer-tool UIs.

Useful capabilities:

- Filter by all, errors, slow, edits, commands.
- Search within trace.
- Copy raw tool input/output.
- Copy trace bundle.
- Fold large outputs by default.
- Show durations when available.
- Show failed path first.
- Preserve complete raw details for debugging.

This can be introduced gradually. The first version can keep technical calls inline under the action group and later evolve into a richer trace drawer.

## Deriving Stages From Tool Calls

The first implementation can use heuristic derivation instead of changing the backend event model.

Suggested derivation:

- Search, find, list, read -> Explore implementation.
- Thinking or plan-like assistant text before edits -> Understand goal or Design changes.
- Modify file/apply patch/write -> Modify files.
- Run command with test/lint/typecheck/build keywords -> Verify result.
- Fetch/web/network/MCP -> Gather external context or Use external service, depending on tool kind.
- Error result -> attach to the current stage and mark the action group failed.

The system should group consecutive related tool calls into action groups:

- Multiple searches and reads around the same area become "Found relevant implementation".
- Multiple edits to files become "Updated UI components" or "Changed N files".
- A command plus its output becomes "Ran validation".

Where the heuristic is uncertain, use generic but user-friendly labels such as "Inspecting project files" or "Applying implementation changes".

## Data Model Direction

Introduce a derived view model in the renderer.

Conceptual types:

```ts
type AgentProgressStage = {
    id: string;
    title: string;
    status: "pending" | "running" | "done" | "failed" | "skipped";
    summary: string;
    currentAction?: string;
    recentActions: AgentProgressAction[];
    actionGroups: AgentProgressActionGroup[];
    risk?: AgentRiskLevel;
    checkpointId?: string;
};

type AgentProgressActionGroup = {
    id: string;
    title: string;
    summary: string;
    status: "running" | "done" | "failed" | "skipped";
    risk?: AgentRiskLevel;
    durationMs?: number;
    evidence?: AgentProgressEvidence[];
    toolCalls: AgentTechnicalCall[];
};
```

The exact names can change during implementation, but the key separation should remain:

- Stage overview is product-facing.
- Action groups explain user-understandable work.
- Technical calls preserve raw tool details.

## Component Direction

Recommended components:

- `AgentProgressView`: renders the full stage overview for a run.
- `AgentProgressStageRow`: renders one stage row and running-state recent actions.
- `AgentProgressStageDetail`: renders action groups for an expanded stage.
- `AgentProgressActionGroup`: renders a user-facing action group and evidence.
- `AgentTechnicalCallList`: renders raw tool calls under an action group.
- `AgentTechnicalCallCard`: can initially wrap or reuse the existing `ToolCallCard`.

The existing `ToolCallCard` should not remain the default top-level presentation for tool calls. It should become a technical-detail component, used inside the expanded trace layer.

## Accessibility And Interaction

- Use buttons for expandable rows.
- Preserve `aria-expanded`.
- Keep keyboard navigation predictable.
- Do not rely on color alone for status or risk.
- Use concise labels for screen readers, such as "Explore implementation, running, read-only".
- Do not make hidden technical details impossible to access by keyboard.

## Phased Implementation Plan

### Phase 1: Product-Facing Progress Derivation

- Add a renderer-side function that derives stages/action groups from `PiRun`.
- Render stages in `AgentBlockElement` instead of rendering each `ToolCallCard` directly at the top level.
- Put existing `ToolCallCard` instances under the technical-call expansion.
- Implement running state with current action plus up to 3 recent actions.
- Preserve assistant markdown output around the progress view.

### Phase 2: Evidence And Failure Handling

- Add evidence summaries for file edits, command results, and validation.
- Auto-expand failed stages and failed action groups.
- Add error summaries above technical details.
- Fold large command/tool outputs.

### Phase 3: Risk And Recovery Metadata

- Add risk badges based on tool kind.
- Add placeholders for approval/checkpoint metadata where available.
- Surface checkpoint and revert affordances only when backed by runtime support.

### Phase 4: Trace Tooling

- Add filtering/search inside technical trace.
- Add copy raw input/output and copy trace bundle.
- Add duration and retry metadata when available.
- Consider a richer trace drawer if inline details become too heavy.

## Open Questions

- Should completed runs show all stages by default, or collapse the entire progress section behind "View work summary" when the final answer is long?
- Should assistant text be interleaved with stages, or should progress appear as a single block before the final answer?
- How much checkpoint/revert capability already exists in the runtime, and what should be deferred?
- Which high-risk actions should require explicit approval in Crest's current permission model?
- Should technical trace state be remembered per run, per session, or reset on reload?

## Success Criteria

- During a run, a non-technical user can tell what the agent is doing without reading tool names.
- A technical user can expand a stage and inspect exact tool calls.
- Completed runs are shorter and easier to scan than the current tool-card stream.
- File edits, commands, validation, and failures are easier to understand than before.
- Raw tool details remain available for debugging.
- The design can be implemented incrementally without changing the agent ownership architecture.
