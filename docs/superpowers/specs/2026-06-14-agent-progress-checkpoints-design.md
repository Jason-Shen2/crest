# Agent Progress Checkpoints Design

## Context

The current agent progress UI derives summaries from tool calls. This made the surface more compact than raw tool cards, but the words still feel mechanical: `Updated files.` describes a tool category, not what the agent achieved.

Mature coding agents such as Trae Code feel better because the progress text is owned by the agent. The agent describes meaningful checkpoints in the work, while the UI presents those checkpoints with a lightweight activity rail. Tool calls remain useful evidence, but they are not the primary narrative.

This design changes the source of progress summaries from renderer-inferred captions to agent-owned checkpoints.

## Product Principle

Progress summary is an agent-owned checkpoint, not a renderer-generated caption.

It must improve task continuity and user alignment without forcing verbose narration, exposing private reasoning, or turning the UI into a log viewer.

## Goals

- Let the agent produce short, concrete progress notes at meaningful stage boundaries.
- Make progress notes useful to both the user and the agent's future context.
- Keep the default UI simple, with no raw tool names, status clutter, or low-value metrics.
- Preserve deterministic rule-derived summaries as fallback when no checkpoint exists.
- Keep system state authoritative for running, failed, blocked, and permission states.
- Avoid extra model calls for progress summarization in the default path.

## Non-Goals

- Do not expose chain-of-thought or hidden reasoning.
- Do not require a progress note after every tool call.
- Do not add a separate LLM request solely to summarize each tool result.
- Do not make the renderer responsible for inventing semantic summaries.
- Do not turn progress notes into final answer text.
- Do not replace technical trace; keep raw tool evidence available behind deeper disclosure.

## Mental Model

There are three different layers:

- **Checkpoint**: agent-authored, short, semantic, useful in the transcript.
- **Evidence**: system-derived facts from tools, files, commands, validation, and failures.
- **Trace**: raw technical details for debugging and audit.

The default progress UI prioritizes checkpoints. Evidence appears only when it clarifies an action. Trace stays hidden unless the user asks for details.

## Message Shape

Add a progress content block to assistant messages:

```ts
interface AgentProgressContent {
    type: "progress";
    id?: string;
    stage?: "understand" | "explore" | "modify" | "verify" | "summarize" | "blocked" | "generic";
    summary: string;
    actions?: Array<{
        id?: string;
        summary: string;
        detail?: string;
        evidenceKind?: "file" | "diff" | "command" | "validation" | "link" | "error";
    }>;
}
```

Field rules:

- `summary` is required and should be one sentence.
- `summary` should state a completed or current checkpoint, not internal reasoning.
- `actions` are optional and should only include high-value user-facing evidence.
- `detail` is optional and should be used only when it adds information beyond the action summary.
- `stage` is a hint for UI grouping; runtime tool state can still override status.

## Authoring Rules

The agent should emit progress notes only at meaningful boundaries:

- After understanding the request enough to proceed.
- After discovering a key implementation path.
- After completing a meaningful file edit.
- After validation passes or fails.
- When blocked by permissions, missing context, or a recoverable failure.
- Before a long-running operation if the user would otherwise see no progress.

The agent should not emit progress notes for routine tool plumbing:

- Reading one file.
- Running a small search.
- Applying a tiny intermediate edit.
- Retrying an internal command with no user-relevant outcome.
- Restating the final answer.

## Copy Guidelines

Progress notes should be short, factual, and result-oriented.

Good examples:

- `Found the agent progress renderer and confirmed summaries are currently rule-derived.`
- `Recreated two_sum.py with the requested implementation.`
- `Verified the focused render tests pass.`
- `Validation failed because the expected status text is no longer rendered.`

Bad examples:

- `I am now going to use the Read tool to inspect a file.`
- `Done.`
- `Updated files.`
- `I think the issue might be caused by...`
- `Let me check the codebase.`

## Intelligence Safety

Progress checkpoints must help the agent, not distract it.

Rules:

- Do not ask the model to narrate every operation.
- Do not ask for hidden reasoning or chain-of-thought.
- Do not require progress notes before tool calls that need quick iteration.
- Do not let progress notes determine truth. Tool execution state remains authoritative.
- Do not penalize the agent for skipping a progress note when the next action is obvious.
- Keep notes concise enough that they improve context recovery instead of bloating context.

The system prompt should frame progress as a checkpoint habit:

> When you reach a meaningful stage boundary, emit a short progress checkpoint that records what changed or what you learned. Do not narrate routine tool use. Do not include private reasoning.

## Context Strategy

Progress notes should remain in the conversation transcript because they are useful task memory. However, they should be compacted differently from raw assistant prose:

- In normal rendering, show them in the progress rail.
- In final assistant content, do not duplicate them as regular markdown.
- In `convertToLlm`, preserve progress notes as short factual context.
- During compaction, keep the latest high-value checkpoints and drop repetitive low-value ones.
- Never compact progress notes into reasoning-style text.

## Renderer Behavior

`deriveAgentProgress` should prefer agent-authored progress content over rule templates.

Priority order:

1. Agent progress content block summary.
2. Agent progress content block actions.
3. System-derived evidence from tool calls.
4. Rule-derived fallback summary.

Status remains system-derived:

- A progress note cannot mark a failed tool as successful.
- A running tool keeps the stage running even if the note sounds complete.
- A failed tool or run error can override the visual state and auto-expand the affected stage.

Default rendering:

- Show checkpoint summaries in the cardless activity rail.
- Keep chevrons next to the stage title.
- Hide status words like `Done`, `Completed`, and `Not run` unless they change user action.
- Show child actions only when they add useful evidence.
- Do not render progress content again in final markdown.

## Fallback Behavior

Rule-derived summaries remain necessary:

- Older runs do not have progress content.
- Some models may not emit progress notes consistently.
- Tool-only flows can still need progress UI.
- Tests need deterministic fallback coverage.

Fallback text should stay conservative and clearly generic. It should never pretend to know semantic intent that the agent did not provide.

## Implementation Boundaries

The first implementation should support the protocol and renderer behavior without adding a second model call.

Expected changes:

- Extend shared agent message typing to include `progress` content.
- Update agent prompt instructions so models can emit progress checkpoints.
- Update message-to-LLM conversion to preserve progress notes as compact factual context.
- Update `AgentBlockElement` so progress blocks are consumed by `AgentProgressView` and not duplicated as markdown.
- Update `deriveAgentProgress` so progress blocks override descriptor summaries.
- Add tests for progress block grouping, fallback behavior, non-duplication, failure override, and legacy runs.

## Open Questions For Implementation Plan

- Whether progress content should be emitted by model-native structured output or by plain assistant content blocks transformed by provider adapters.
- Whether multiple progress notes in one assistant message should create multiple stage rows or update the latest compatible stage.
- How aggressively compaction should keep or drop older progress checkpoints.

These are implementation details. The product requirement is fixed: progress summaries should be agent-owned checkpoints, with renderer rules as fallback.
