# Terminal Welcome Restoration

## Goal

Restore the empty terminal welcome state from Crest while keeping xterm as the terminal renderer.

## Chosen Approach

Use Crest's shared `Icon` component with the `computer-terminal-02` icon and restore the original two-line message:

- `Run your first command`
- `Type below to start a terminal session.`

Remove the Terax-style Crest logo and the four shortcut hints from the empty state. This is preferred over only fixing the logo URL because the user asked to restore the previous terminal identity and adjust the copy, and the old Crest welcome state already provides the intended design.

## Component Behavior

`BlockWatermark` remains responsible for the xterm empty state:

- It appears only while the terminal has no command blocks.
- It retains the existing fade-out lifecycle when the first command starts.
- It remains non-interactive and does not affect terminal focus or input.
- Only the centered visual content changes; xterm session state and rendering are unchanged.

## Visual Design

The content is centered vertically and horizontally:

1. `computer-terminal-02`, rendered at 28 px with the same muted treatment as the old Crest welcome.
2. A semibold `Run your first command` heading.
3. A smaller, lower-contrast `Type below to start a terminal session.` description.

The implementation should reuse the old Crest typography and spacing rather than introducing new assets or styles.

## Testing

Add a focused component test that verifies:

- The terminal icon is rendered.
- Both restored text strings are present.
- The Terax shortcut hints are absent.
- Existing visible, hidden, and dead watermark lifecycle behavior remains intact.

No backend, PTY, block segmentation, or xterm data-flow changes are part of this design.
