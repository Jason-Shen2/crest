# Fullscreen TUI Trackpad Scroll Optimization

## Goal

Make macOS trackpad scrolling in fullscreen terminal applications such as Codex
and Claude Code respond promptly and preserve fast-swipe velocity, while keeping
their fullscreen layout and leaving ordinary terminal scrollback unchanged.

The target is a materially more direct, follow-the-finger interaction. Fullscreen
TUIs still repaint a character-cell grid, so this design does not promise true
sub-pixel motion identical to a web page.

## Root Cause

xterm 6 handles wheel input differently when a terminal application enables
mouse tracking:

1. Pixel deltas smaller than 50 are classified as likely trackpad input.
2. Those deltas are multiplied by `0.3`.
3. Fractional movement is accumulated until it reaches a whole terminal row.
4. The browser terminal sends only one mouse-wheel report for that browser
   event, even when the accumulated amount represents multiple rows.

Codex and Claude Code use fullscreen TUI renderers and SGR mouse encoding. Their
conversation view therefore receives delayed, quantized, and velocity-limited
wheel input. Renderer benchmarks and the successful inline-mode experiment show
that Crest's WebGL renderer and ordinary scrollback are not the bottleneck.

## Chosen Approach

Add a Crest-owned SGR TUI wheel adapter using only xterm's public APIs:

- `Terminal.attachCustomWheelEventHandler` intercepts supported gestures before
  xterm applies its damping and quantization.
- `Terminal.parser.registerCsiHandler` observes mouse protocol and encoding mode
  changes without consuming them.
- `Terminal.input(sequence, false)` sends generated SGR wheel reports through
  the existing `onData -> PTY` path.

The adapter consumes raw trackpad pixel deltas, drains them once per animation
frame, and emits a bounded batch of SGR wheel reports. It preserves momentum
events supplied by macOS and never creates its own inertia.

This is preferred over changing `scrollSensitivity`, which cannot remove the
one-report-per-event limit, and over patching xterm internals, which would make
xterm upgrades fragile.

## Activation and Fallback

The adapter takes over a wheel event only when all of the following are true:

1. xterm reports an active mouse tracking mode other than `none`.
2. The last observed mouse encoding is SGR (`DECSET 1006`).
3. The event belongs to a likely trackpad gesture using pixel deltas.
4. The event is predominantly vertical and is not a Control/pinch gesture.
5. The Slot is active, attached to the same leaf, and not disposed.

All other input returns `true` from the custom handler and follows xterm's
existing path. In particular, the following remain unchanged:

- ordinary main-buffer scrollback;
- physical mouse wheel input;
- TUIs using default mouse encoding;
- SGR pixel encoding (`DECSET 1016`);
- alternate-buffer applications without mouse tracking;
- horizontal or Shift-wheel gestures;
- browser pinch/zoom gestures.

The first version targets the SGR protocol used by Codex and Claude Code. It
does not add application-name detection or special cases for their screen
layouts.

## Protocol State

The adapter tracks an encoding enum with three states:

- `default`
- `sgr`
- `sgr-pixels`

CSI handlers observe private mode set/reset sequences:

- `?1000`, `?1002`, and `?1003` are left to xterm; the adapter uses the public
  `term.modes.mouseTrackingMode` value as the protocol source of truth.
- `?1006h` selects `sgr`.
- `?1016h` selects `sgr-pixels`.
- Resetting `1006` or `1016` selects `default`, matching xterm's behavior.

Handlers return `false`, allowing xterm's built-in handlers to continue.
An ESC `c` observer resets adapter state for a full terminal reset.

Multiple private modes in one CSI sequence are processed individually.

## Gesture Classification

Classification is gesture-scoped rather than event-scoped so a fast trackpad
swipe does not fall back to xterm when momentum deltas grow beyond 50 pixels.

- A new gesture begins after an idle gap.
- The first event is considered trackpad-like when it uses pixel deltas and has
  a small, fractional, or two-axis delta.
- Subsequent events within the same burst retain that classification.
- A physical-wheel classification remains on xterm's native path for the whole
  burst.
- Direction changes clear the accumulated residual before accepting movement in
  the new direction.

The idle-gap and classifier constants live in the pure adapter module and are
covered by tests.

## Frame-Paced Mapping

Supported wheel events add their raw vertical pixel delta to an accumulator and
return `false` so xterm does not also generate a report.

At most one drain is scheduled per animation frame:

1. Determine CSS cell height from the terminal screen rectangle and row count.
2. Convert accumulated pixels to discrete reports using a threshold derived
   from cell height.
3. Emit up to four reports per frame as one concatenated input string.
4. Retain only the sub-threshold remainder; discard overflow beyond the frame
   cap so the terminal does not keep scrolling after the OS gesture stops.

The initial threshold will be calibrated around one report per cell of raw
trackpad travel. This removes xterm's `0.3` damping without inventing a separate
acceleration curve. A small bounded adjustment may be made during manual testing
with Codex and Claude Code.

Wheel-up uses SGR button code 64 and wheel-down uses 65. Shift, Alt, and Control
modifier bits and the pointer's clamped 1-based terminal cell coordinates are
preserved in each generated report.

## Lifecycle and Integration

The pure logic lives in a new module under `frontend/app/xterm/`, separate from
the renderer pool. It owns:

- protocol/encoding state transitions;
- gesture classification;
- pixel accumulation and frame draining;
- SGR report encoding.

`renderer-pool.ts` creates one controller per Slot after opening the Terminal.
The Slot owns the controller and resets it when:

- the Slot is released or rebound to another leaf;
- mouse mode or encoding leaves the supported state;
- direction changes;
- the terminal receives a full reset;
- the Slot is parked or disposed.

Any pending animation frame is cancelled during reset/disposal. A scheduled
drain verifies that the Slot still belongs to the leaf that originated the
gesture before sending data.

No backend, PTY protocol, block segmentation, or xterm dependency patch is
required.

## Error and Safety Behavior

- Invalid or unavailable screen dimensions cause native xterm fallback.
- Coordinates are clamped to `1..cols` and `1..rows`.
- A zero delta is ignored.
- Unsupported encoding changes immediately cancel pending custom input.
- The per-frame cap bounds PTY traffic during large momentum events.
- The adapter adds no timer-driven movement after wheel events end.

## Testing

### Unit Tests

Add focused tests for:

- SGR, SGR-pixel, default, and reset state transitions;
- multi-parameter DECSET/DECRST handling;
- trackpad versus physical-wheel gesture classification;
- classification retention during large momentum deltas;
- idle-gap gesture reset;
- small-delta accumulation;
- direction reversal clearing residual movement;
- report threshold conversion and four-report frame cap;
- overflow dropping without post-gesture movement;
- SGR up/down encoding, modifiers, and coordinate clamping;
- fallback decisions for ordinary scrollback and unsupported protocols.

### Renderer-Pool Integration Tests

Verify that:

- supported SGR trackpad events suppress xterm's native wheel path;
- unsupported events return to xterm unchanged;
- a frame drain calls `term.input(..., false)`;
- Slot release, rebind, park, and disposal cancel pending input;
- a stale frame cannot write into a newly bound leaf.

### Manual Acceptance

In the Electron app on macOS:

1. Run Codex in its default fullscreen mode.
2. Run Claude Code in its default fullscreen mode.
3. Confirm a slow upward gesture responds within roughly one cell of trackpad
   travel.
4. Confirm a fast swipe advances substantially faster than the current build.
5. Confirm direction reversal responds immediately.
6. Confirm scrolling stops when macOS momentum events stop, with no synthetic
   tail.
7. Confirm a physical mouse wheel remains unchanged.
8. Confirm a large ordinary shell scrollback remains unchanged.
9. Confirm exiting and reopening a TUI does not carry residual movement.

## Deferred Alternatives

The inline/main-screen experiment produced ordinary scrollback behavior that
already feels responsive. It remains a viable future opt-in mode, but is
deferred because the current priority is preserving fullscreen TUI layout.

Sub-pixel compositor animation, terminal-frame snapshots, and application-
specific screen parsing are out of scope. They can move fixed TUI chrome,
require expensive WebGL readback, and cannot reliably infer how many rows an
application scrolls per wheel report.
