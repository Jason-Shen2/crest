# Agent Diff Card OpenCode-Style Design

Date: 2026-07-28

## Goal

Update the Agent conversation diff card so its diff body matches OpenCode's source implementation while preserving crest's existing header design. Add header-controlled collapse behavior using the approved double-chevron icon.

## Approved Visual Direction

- Keep the existing crest header background, file-type badge, path typography, spacing, border, and addition/deletion statistics.
- Add `ChevronsUpDownIcon` from `lucide-react` at the right edge of the header.
- Make the whole header a keyboard-accessible collapse trigger.
- Default the card to expanded. Collapsing hides only the diff body.
- Use OpenCode's diff body behavior and styling:
  - unified view by default;
  - line numbers enabled;
  - 24px line height;
  - minimum 4ch line-number gutter;
  - wrapping overflow;
  - syntax highlighting;
  - no library-provided file header;
  - `bars` diff indicators;
  - 4px indicator width;
  - deletion indicator rendered as a 2px repeating horizontal pattern;
  - addition indicator rendered as a solid bar;
  - OpenCode-equivalent addition/deletion background blending.

## Source Baseline

The implementation is pinned to OpenCode dev commit `017a5977d2107092007623e507fc5c6eb337d3b2`:

- `packages/session-ui/src/components/session-turn.tsx`
- `packages/session-ui/src/components/session-turn.css`
- `packages/session-ui/src/pierre/index.ts`
- OpenCode dependency `@pierre/diffs@1.2.10`

Using the same pinned renderer is preferred over hand-copying its DOM and CSS because the bar indicators, syntax highlighting, partial patch handling, and gutter layout are coupled inside the renderer.

## Component Design

`frontend/app/agent/assistant-ui/diff-viewer.tsx` remains the public crest component and retains its current props.

- Patch input is parsed with `parsePatchFiles` from `@pierre/diffs`.
- Each parsed file renders in its own crest card using the React `FileDiff` renderer.
- `oldFile` and `newFile` input renders through the React `MultiFileDiff` renderer.
- A small internal card component owns its expanded state and renders the existing crest header plus the double-chevron control.
- The existing split-view prop remains supported by mapping it to Pierre's `diffStyle`.
- Existing display props continue to control line numbers, file badge, and statistics where applicable.
- Empty or invalid input keeps the existing fallback behavior.

## Styling

Pierre receives the same functional options used by OpenCode:

```ts
{
    diffStyle,
    diffIndicators: "bars",
    overflow: "wrap",
    disableLineNumbers: !showLineNumbers,
    disableBackground: false,
    disableFileHeader: true,
    lineHoverHighlight: "both",
    expansionLineCount: 20,
    hunkSeparators: "line-info-basic",
    lineDiffType: diffStyle === "split" ? "word-alt" : "none",
    maxLineDiffLength: 1000,
    tokenizeMaxLineLength: 1000,
}
```

The renderer's CSS variables map to crest theme tokens rather than hard-coded colors. The OpenCode dimensions and blend ratios remain unchanged.

## Interaction and Accessibility

- Each card uses the existing Radix `Collapsible` primitives. `CollapsibleTrigger asChild` wraps one native header button, so the full header is the single keyboard and pointer target.
- `aria-expanded` reflects the current state.
- The file path remains visible while collapsed.
- The double-chevron icon remains visually consistent with the supplied reference and receives no separate focus target.
- Collapse state is local to each file card.

## Testing

- Component test verifies cards default to expanded.
- Interaction test verifies clicking the header toggles the body and `aria-expanded`.
- Rendering test verifies the approved double-chevron icon is present.
- Renderer-option test verifies `bars`, 24px line height mapping, wrapping, line numbers, and disabled library header.
- Patch test verifies multi-file patches create separate collapsible cards.
- Existing unified, split, empty, filename, and stats behavior remains covered.

## Out of Scope

- Replacing crest's existing header styling with OpenCode's header.
- Adding OpenCode's changed-files summary group.
- Persisting collapse state across messages or sessions.
- Changing the standalone Git diff pane.
