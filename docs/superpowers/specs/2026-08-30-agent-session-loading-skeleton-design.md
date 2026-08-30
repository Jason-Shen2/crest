# Agent Session Loading Skeleton Design

## Problem

Opening a persisted agent thread can take several seconds while its history is reconstructed. The current hydration UI prevents the welcome screen from flashing, but it leaves most of the thread empty and shows only a centered spinner with `Loading conversation…`. For waits longer than about one second, this reads as a generic placeholder and provides little visual continuity with the conversation that will replace it.

## Goals

- Make persisted-thread hydration visibly belong to the conversation surface.
- Avoid flashing a loading UI for sessions that hydrate almost immediately.
- Reassure users during unusually long hydration without claiming measurable progress.
- Preserve the existing thread width, composer position, theme tokens, and restrained visual style.
- Keep the loading view deterministic, accessible, and straightforward to test.

## Non-goals

- No backend progress percentage or new IPC event.
- No pagination, incremental message rendering, or session cache.
- No fabricated message text, avatars, timestamps, tool calls, or reasoning blocks.
- No redesign of the welcome screen, composer, or loaded message presentation.

## Interaction and Timing

The thread continues to use `thread.isLoading` as the single source of truth for persisted-session hydration.

1. From 0–180ms, `ThreadLoading` is mounted but returns no visible or announced content. The welcome view remains suppressed. This prevents a skeleton flash when replay is fast.
2. At 180ms, the loading view fades in. It contains a compact status row followed by deterministic conversation-shaped skeletons.
3. At 3 seconds, the visible status changes from `Loading conversation…` to `Loading a long conversation…`. This is a time-based reassurance only; it does not imply progress measurement.
4. When hydration ends, `thread.isLoading` becomes false and the complete persisted messages replace the loading view. Pending timers are cancelled when the component unmounts.

The composer stays in its normal docked position. Assistant UI's loading state continues to prevent submission while history is unresolved.

## Visual Design

The loading content uses the same `--thread-max-width` column as real messages and is aligned near the top of the viewport rather than centered in the empty canvas.

The status row uses small muted text and a subtle rotating icon. Below it are two repeated turn groups:

- A right-aligned user bubble skeleton, approximately 35–45% of the content width.
- A left-aligned assistant skeleton with two lines, approximately 65–80% and 45–60% width.

Widths are fixed per row rather than randomized, so server rendering and tests remain deterministic. Surfaces use existing `muted` and `muted-foreground` theme tokens. A low-intensity pulse communicates activity without a high-contrast shimmer. The skeleton container fades in once after the initial delay and does not repeatedly move.

The skeleton must remain clearly abstract: rounded blocks have no text-like glyphs, avatars, timestamps, or controls that could be mistaken for restored content.

## Component Boundaries

`registry-thread.tsx` retains the existing `isHydratingThread` selector and conditional placement. `ThreadLoading` owns only the loading presentation and the two timers needed for delayed visibility and long-wait copy.

To keep rendering readable, the repeated visual pieces are split into small local components:

- `ThreadLoading`: status, timing state, accessibility, and skeleton group container.
- `ThreadLoadingTurn`: one user/assistant skeleton pair. It receives explicit, fixed width classes from `ThreadLoading` so the two rendered turns differ without randomness.

No loading state is duplicated in `usePiChat`; the renderer hook remains responsible for lifecycle, and the assistant-ui adapter remains responsible for mapping `isHydrating` to `isLoading`.

## Accessibility

The status container remains `role="status"` with `aria-live="polite"`. The spinner and decorative skeleton blocks are `aria-hidden="true"`, so assistive technology announces only the status copy and does not traverse placeholder shapes. The change at 3 seconds is announced politely once.

Reduced-motion users receive the same layout without rotation, pulsing, or fade animation through the existing `motion-reduce` utilities.

## Failure Behavior

Subscription errors continue to end hydration through the existing error callback. Once `thread.isLoading` becomes false, the skeleton unmounts and the existing error state can render. The skeleton itself introduces no retry path and must not remain visible after an error.

## Testing

Extend the real assistant-ui thread integration coverage to verify:

- A loading thread renders the skeleton root and abstract user/assistant blocks.
- The welcome message and real message group content are absent during hydration.
- The visible status has the expected accessibility attributes.
- The initial copy is `Loading conversation…`.

Add a timer-aware component test to verify:

- The skeleton becomes visible only after 180ms.
- The copy changes after 3 seconds.
- Unmounting clears timers without warnings or late updates.

Existing runtime-bridge and `usePiChat` tests continue to verify that hydration maps to `thread.isLoading` and ends on replay or subscription failure.

## Success Criteria

- Fast hydration does not visibly flash the skeleton or welcome UI.
- Slow hydration presents a conversation-shaped, theme-consistent placeholder.
- Long waits communicate continued activity without fake progress.
- Loaded history replaces the skeleton without intermediate welcome content.
- Focused assistant-ui, hydration, and agent-content regression suites pass.
