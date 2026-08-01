# Read File Theme and Hover Polish

## Goal

Polish the clickable file rows inside expanded Read tool activity so their chip colors follow the active application theme and the whole row gains a clear, coordinated hover state.

## Scope

Only successful, clickable Read file entries change. Search activity chips, collapsed Read summaries, failed Read entries, layout, spacing, typography, navigation, and focus behavior remain unchanged.

## Visual Behavior

- The file chip uses theme semantic colors: `bg-muted` with `text-foreground/85`.
- The row label remains muted at rest.
- Hovering anywhere on the clickable row changes the row label to `text-foreground`.
- The same hover changes the file chip to `bg-accent` and `text-foreground`.
- Color changes use the existing short transition treatment.
- Light and dark themes derive their appearance entirely from semantic theme tokens; no fixed cyan, white, or dark color values remain on the clickable file chip.

## Component Approach

`ReadToolActivity` keeps its existing native file button. The button becomes a named Tailwind group so the nested code chip can react to the button's hover state. No state, event, model, or navigation changes are needed.

## Accessibility and States

- The existing button, accessible name, focus ring, and click target stay intact.
- Keyboard focus behavior is unchanged.
- Failed and non-clickable file entries keep their current inactive presentation.
- Running and error behavior is unchanged.

## Testing

Extend the Read activity component test to assert that a successful file button uses a named hover group and that its file chip uses semantic theme classes plus coordinated group-hover classes. Existing interaction tests continue to verify collapse and file navigation.

## Non-Goals

- Restyling Search activity or summary chips.
- Changing Read grouping, deduplication, or file opening.
- Adding new theme variables or configuration.
