# Context Ledger Design

**Status:** Approved for implementation on `codex/context-inspector`

## Goal

Make the Context tab a trustworthy, high-density answer to one question: what effective context will the Agent inherit on its next model call?

The first release remains read-only. It must show the complete model-visible content for every source so the design can later grow into safe context management without changing the inventory model.

## Product Boundary

The panel represents the current session's active branch and selected model. It does not show cumulative usage, the complete durable transcript, unsent composer text, or Crest's internal observation objects.

The source of truth remains the request-construction path. React renders an immutable Context Snapshot and does not reconstruct context from transcript state.

## Information Architecture

The inventory keeps four semantic groups in a fixed order:

1. Agent instructions
2. Tools
3. Conversation
4. Added context

These group headings are always visible. They organize the ledger but are not accordion controls. A heading may show its source count, including zero.

Each concrete source is a disclosure row below its group. A collapsed row contains only:

- the source's human-readable name;
- one concise description when it helps distinguish the source;
- a disclosure chevron.

There is no Composition heading, explanatory paragraph, total source/token summary, table header, `Included as` column, per-source token column, or `Why it is here` block.

The existing Context breakdown bar is separate from this ledger and must not change.

## Disclosure Interaction

- One source may be expanded at a time across the entire ledger.
- Selecting a collapsed source expands it inline below the row.
- Selecting the open source again closes it.
- Selecting another source closes the previous source before opening the new one.
- Escape closes the open source and returns focus to its disclosure.
- Native buttons expose `aria-expanded`; the expanded content is linked with `aria-controls`.
- Group headings stay visible while sources open and close.

Conversation inventories may continue to virtualize collapsed rows, but expansion state must remain globally single-select and must not expose two payloads simultaneously.

## Expanded Content

Expansion begins directly with the actual model-visible content. There is no nested heading or provenance panel.

The displayed value is the complete semantic provider-ready fragment associated with the source:

- instruction source: the exact instruction text;
- tool source: the exact definition and schema exposed to the model;
- conversation source: the exact role/content/tool-call or tool-result fragment retained in effective history;
- compacted history: the exact replacement summary fragment;
- added context: the exact injected representation selected for the request.

The value must not be rewritten, summarized, or truncated. It must not include Crest-only entry IDs, diagnostics, timestamps, token accounting, request lifecycle metadata, or other observer state unless those fields are part of the content sent to the model.

Structured values are serialized deterministically as formatted JSON. Text remains text. Line numbers and syntax color are presentation only and are not part of the copied value.

Large values use an internal scroll area with a bounded height. The complete value remains mounted and selectable; the panel does not silently replace it with a preview.

## Data Model

Each `ContextSnapshotItem` retains its stable identity, semantic category, kind, title, preview, token estimate, and provenance for future management. It also gains a dedicated model-visible content value. This value is transport data, not a UI reconstruction.

The inventory builder attaches content at the point where the effective semantic request inputs are already known:

- system-prompt manifest segment text for instructions;
- active tool definitions for tools;
- effective context messages after history transforms for conversation;
- the exact selected full, summary, or attention representation for added context.

The Context Snapshot is observational and must remain off the provider request's mutation path. Adding inspector content cannot change, block, or reorder the request.

## Visual Direction

The ledger should feel native to a coding agent rather than like a settings table:

- quiet group dividers provide hierarchy;
- source rows use compact vertical rhythm and strong names rather than card chrome;
- the single open payload becomes the focal surface through contrast, monospaced content, line numbers, and syntax color;
- color is semantic and restrained; it does not create decorative category cards;
- hover, focus, chevron rotation, and the inline reveal are the only motion cues.

The design's signature is the live source ledger: the readable inventory and the exact payload occupy one continuous surface instead of switching to a separate inspector pane.

## Empty and Failure States

- A group with no active sources shows a quiet `No active sources.` row.
- A malformed source may show its existing diagnostic as the source description, but must not fabricate content.
- If exact content is unavailable, the disclosure stays disabled or displays an explicit unavailable state; it must not present the preview as though it were the full payload.
- Snapshot-level failure behavior and stale-state handling remain unchanged.

## Acceptance Criteria

- The Context breakdown bar is visually and behaviorally unchanged.
- All four semantic group headings are visible without interaction.
- No Composition title, explanatory copy, aggregate header, column header, `Included as`, per-source token value, or `Why it is here` UI remains.
- Every active source appears as a disclosure row with a clear name.
- At most one source is expanded, including across different groups.
- The expanded source shows its complete model-visible content inline with no intermediate metadata module.
- Long payloads scroll internally without truncating the underlying value.
- Keyboard disclosure, Escape close, focus restoration, and reduced-motion behavior are covered.
- Snapshot observation remains isolated from Agent request execution.
