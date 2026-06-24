# Warp Terminal State Alignment Design

## Goal

Refactor Crest's terminal runtime state architecture toward Warp's model-driven design so TUI takeover, long-running command input ownership, cursor rendering, and CLI-agent behavior are decided by terminal model state instead of scattered React heuristics.

## Background

Crest currently handles TUI-like behavior with a thin `render/tui-capture.ts` helper and multiple component-local checks in `TerminalView`, `BlockListElement`, and `BlockElement`. This fixed several visible issues for `claude`, `codex`, `pi`, and `coco`, but the approach has reached its limit:

- Runtime input ownership is inferred in React by combining alt-screen, terminal modes, and a long-running timeout.
- Cursor visibility is partly forced in `BlockElement` with `forceCursorVisible`, which can expose parked PTY cursors in the wrong place.
- Long-running command behavior is represented as a boolean surface flag instead of a first-class input state.
- CLI agent concepts are split between shell blocks, agent blocks, `usePiChat`, and renderer-specific logic.

Warp avoids this shape by keeping these concepts in model-level state:

- `TerminalInputState` distinguishes `NotBootstrapped`, `AltScreen`, `LongRunningCommand`, and `InputEditor`.
- `Block::is_active_and_long_running()` owns long-running command semantics.
- Terminal mode and cursor state live in the terminal model/grid layer.
- CLI agent sessions are modeled separately from generic terminal input.
- Rendering reads state and paints; it does not infer ownership from component-local booleans.

## Scope

This design covers a staged refactor of Crest's terminal runtime state for shell/TUI/CLI-agent behavior.

In scope:

- Add model-level terminal input state.
- Move long-running detection into `Block`.
- Replace `activeTuiSurface` boolean usage with a richer surface state.
- Move cursor render decisions out of `BlockElement`.
- Introduce a CLI agent session model inspired by Warp.
- Preserve existing behavior for `claude`, `codex`, `pi`, `coco`, alt-screen TUIs, mouse capture, paste, focus reporting, and normal shell input.

Out of scope for the first implementation pass:

- A full Warp-style rich input UI for every CLI agent.
- Backend protocol changes for CLI plugins or OSC 777 agent events.
- Replacing Crest's DOM grid renderer with Warp's GPU renderer.
- Reworking pre-submit NLD shell-vs-agent classification.

## Current Crest Responsibilities

### TerminalModel

`frontend/app/term/terminal-model.ts` currently owns blocks, terminal mode, parser routing, selection/find atoms, and PTY send methods. It does not expose a single model-level answer for "where should user input go right now?"

### Block

`frontend/app/term/engine/block.ts` tracks lifecycle timestamps and can compute `durationMs()`, but it does not own the long-running threshold or whether a running command has crossed into PTY input ownership.

### Renderer Helpers

`frontend/app/term/render/tui-capture.ts` currently decides capture state from terminal modes and long-running duration. This puts model semantics in the render layer.

### React Components

`TerminalView`, `BlockListElement`, and `BlockElement` currently hide input chrome, choose full-height rendering, forward keyboard/paste, render cursor overlays, and force cursor visibility based on local recomputation. These components should instead consume a model-provided state snapshot.

## Target Architecture

### Terminal Input State

Create a model-level state equivalent to Warp's `TerminalInputState`.

```ts
export type TerminalInputState =
    | { kind: "not-bootstrapped" }
    | { kind: "input-editor" }
    | { kind: "long-running-command"; blockId: BlockId }
    | { kind: "alt-screen"; blockId: BlockId }
    | { kind: "terminal-capture"; blockId: BlockId };
```

State priority:

1. `not-bootstrapped` when the terminal has not received enough shell state to accept normal input.
2. `alt-screen` when an active block owns alt-screen.
3. `terminal-capture` when a running block enables terminal capture modes such as app cursor/keypad, mouse reporting, focus report, alternate scroll, or kitty keyboard flags.
4. `long-running-command` when the active running block crosses the long-running threshold.
5. `input-editor` otherwise.

This state becomes the single source of truth for:

- Whether the bottom command input is visible.
- Whether keyboard/paste should go to the editor or PTY.
- Whether the active block should render as a full-height surface.
- Whether document-level shortcut propagation should be stopped.

### Block Interaction State

Move Warp-style long-running behavior into `Block`.

```ts
export const LONG_RUNNING_COMMAND_DURATION_MS = 50;

export type BlockInteractionMode =
    | "idle"
    | "input-editor"
    | "terminal-capture"
    | "long-running-command"
    | "alt-screen"
    | "cli-agent";
```

`Block` should expose:

- `isRunning()`
- `isActiveAndLongRunning(now?: number)`
- `markWasLongRunning()`
- `interactionMode(mode: TermMode, now?: number)`

The long-running threshold should not live in `render/`. Components should not call `durationMs()` directly to decide input ownership.

### Terminal Surface State

Replace `activeTuiSurface: boolean` with a richer state.

```ts
export type TerminalSurfaceState =
    | { kind: "normal-output"; blockId: BlockId }
    | { kind: "alt-screen"; blockId: BlockId }
    | { kind: "terminal-capture"; blockId: BlockId }
    | { kind: "long-running-pty"; blockId: BlockId }
    | { kind: "cli-agent"; blockId: BlockId; agent: CLIAgent };
```

The surface state answers rendering questions without losing why the surface is active:

- `alt-screen` can use the alt-screen grid and respect TUI cursor modes.
- `terminal-capture` can use the output grid but still behave as a terminal-owned capture surface.
- `long-running-pty` can hide Crest input without pretending it knows the CLI's soft cursor.
- `cli-agent` can later choose between PTY rendering and a Crest-owned rich input surface.

### Cursor Render State

Move cursor rendering policy out of `BlockElement`.

```ts
export type CursorRenderState =
    | { kind: "hidden" }
    | { kind: "terminal"; forceVisible?: false }
    | { kind: "suppressed"; reason: "cli-soft-cursor" | "rich-input-open" | "parked-cursor" }
    | { kind: "cli-owned"; agent: CLIAgent };
```

Rules:

- Standard terminal capture and alt-screen surfaces use terminal cursor state directly.
- Long-running PTY surfaces do not force a hidden cursor visible by default.
- Parked cursors on blank rows are suppressed.
- CLI-owned soft cursors are represented explicitly instead of being guessed by `BlockElement`.
- `CursorOverlay` remains a pure renderer of a terminal cursor. It should not decide whether a hidden cursor should become visible.

### CLI Agent Session Model

Add a small Crest equivalent of Warp's CLI agent session layer.

```ts
export type CLIAgent = "claude" | "codex" | "gemini" | "pi" | "coco" | "unknown";

export type CLIAgentSessionStatus = "starting" | "in-progress" | "idle" | "stopped" | "error";

export type CLIAgentInputState =
    | { kind: "closed" }
    | { kind: "pty-owned" }
    | { kind: "crest-rich-input-open"; entrypoint: "footer" | "shortcut" | "agent-event" };

export interface CLIAgentSession {
    blockId: BlockId;
    agent: CLIAgent;
    status: CLIAgentSessionStatus;
    inputState: CLIAgentInputState;
}
```

Initial detection should be conservative:

- Use command prefix detection only for CLI agent session semantics.
- Do not add CLI names to the NLD one-off shell command whitelist as a generic solution.
- Do not use command names to decide generic TUI takeover when terminal modes or long-running state already provide the answer.

The first version can recognize `claude`, `codex`, `gemini`, `pi`, and `coco` sessions from `block.commandText()`. Later versions can add OSC/plugin event support.

## Component Responsibilities After Refactor

### TerminalModel

Owns:

- `getTerminalInputState(now?: number): TerminalInputState`
- `getActiveSurfaceState(now?: number): TerminalSurfaceState | null`
- `getCursorRenderState(blockId: BlockId, now?: number): CursorRenderState`
- `getCLIAgentSession(blockId: BlockId): CLIAgentSession | null`

Also owns the timer invalidation contract for crossing the 50ms long-running threshold. `TerminalView` can still schedule a lightweight re-render, but it should ask the model when the next threshold check is needed.

### TerminalView

Consumes `TerminalInputState`.

- Shows `CmdBlockInput` only when input state is `input-editor`.
- Sends document-level keydown/paste to PTY for `alt-screen`, `terminal-capture`, and `long-running-command`.
- Sends normal editor input through existing submit paths when state is `input-editor`.
- Does not scan blocks itself to decide active TUI ownership.

### BlockListElement

Consumes `TerminalSurfaceState`.

- Gives the active surface wrapper `h-full min-h-full` when the surface state refers to that block.
- Does not call `blockIsActiveTuiSurface()`.

### BlockElement

Consumes `TerminalSurfaceState` and `CursorRenderState`.

- Hides block header/snackbar for full terminal surfaces.
- Selects output grid vs alt-screen grid based on surface kind.
- Renders `CursorOverlay` only when cursor state says `terminal`.
- Does not compute `forceCursorVisible`.

### CursorOverlay

Stays simple.

- Draws terminal cursor shape from grid state.
- Respects `grid.cursorState.visible`.
- Does not infer CLI soft cursors or long-running cursor policy.

## Migration Plan

### Phase 1: Model Input State

Add `TerminalInputState`, terminal capture helpers, and `TerminalModel.getTerminalInputState()`. Keep existing rendering behavior but route decisions through the model. Existing tests should be updated to assert model state directly.

### Phase 2: Block Long-Running

Move the long-running threshold to `Block`. Add `Block.isActiveAndLongRunning(now)` and a `wasLongRunning` cache similar to Warp. Remove long-running duration checks from `render/tui-capture.ts`.

### Phase 3: Surface State

Add `TerminalSurfaceState` and replace `activeTuiSurface` booleans in `TerminalView`, `BlockListElement`, and `BlockElement`. The renderer should know whether the active surface is alt-screen, terminal-capture, or long-running PTY.

### Phase 4: Cursor State

Add `CursorRenderState`. Remove `forceCursorVisible` from component logic. Preserve correct terminal cursor rendering for alt-screen and terminal capture. Suppress hidden/parked cursors for long-running PTY surfaces rather than drawing them in guessed positions.

### Phase 5: CLI Agent Sessions

Introduce `cli-agent.ts` and `cli-agent-session.ts`. Detect sessions from command prefixes and associate them with blocks. Expose session state through `TerminalModel`. Keep rich input closed by default; use the model only to distinguish CLI-owned behavior from generic PTY behavior.

### Phase 6: Cleanup And Regression

Delete `render/tui-capture.ts` or reduce it to compatibility exports if needed during migration. Remove component-local active-surface heuristics. Keep tests focused on model state and then renderer consumption.

## Testing Strategy

### Unit Tests

- `terminal-input-state.test.ts`
  - input editor when no command is running
  - alt-screen wins over long-running
  - terminal capture wins over long-running
  - long-running after 50ms
  - no long-running before 50ms

- `block-interaction.test.ts`
  - running block crosses threshold
  - `wasLongRunning` stays true after crossing while block remains active
  - done blocks are not long-running

- `terminal-surface-state.test.ts`
  - active alt-screen maps to alt-screen surface
  - capture mode maps to terminal-capture surface
  - long-running command maps to long-running PTY surface

- `cursor-render-state.test.ts`
  - alt-screen respects terminal cursor visibility
  - terminal capture respects terminal cursor visibility
  - long-running PTY suppresses hidden parked cursor
  - CLI session can mark cursor as CLI-owned

- `cli-agent-session.test.ts`
  - command prefixes create expected agent sessions
  - unknown commands do not create sessions
  - CLI session semantics do not affect generic shell keyword classification

### Component Tests

- `terminal-view-tui.test.tsx`
  - bottom input hidden for model states `alt-screen`, `terminal-capture`, and `long-running-command`
  - bottom input visible for `input-editor`
  - keydown/paste forwarding follows model input state

- `block-list-element-tui.test.tsx`
  - wrapper full height follows surface state

- `block-element-tui.test.tsx`
  - header/snackbar hidden for full terminal surfaces
  - cursor overlay renders only for terminal cursor state
  - long-running PTY does not force hidden cursor visible

### Manual Verification

Verify:

- `claude` enters TUI-like state, hides Crest input, forwards keys, and respects cursor.
- `codex` enters TUI-like state and does not crash on sparse rows.
- `pi` hides Crest input and forwards keys.
- `coco` hides Crest input, keeps correct sizing, and does not show a fake parked cursor.
- Standard shell prompts still show Crest input.
- Alt-screen programs such as `vim`, `less`, and `htop` keep existing behavior.
- Mouse reporting, bracketed paste, focus reporting, and shortcut suppression still work.

## Risks

- Long-running state can hide Crest input for commands that are slow but not interactive. This matches Warp's threshold behavior but should be validated against common commands.
- CLI agent command prefix detection can become stale. It should only drive CLI session semantics, not generic shell/TUI routing.
- Suppressing guessed cursors can leave some CLIs without a visible caret until CLI soft-cursor support is added.
- React components and tests may temporarily need adapters while model state replaces old helper functions.

## Non-Goals

- Do not hardcode `coco` or `pi` into the generic shell input classifier.
- Do not build a universal soft-cursor detector without captured evidence.
- Do not implement Warp's full CLI agent rich input UI in the first pass.
- Do not change backend PTY protocol unless model-state migration proves frontend-only state is insufficient.

## Success Criteria

- `TerminalView`, `BlockListElement`, and `BlockElement` no longer compute their own TUI ownership from raw mode and block duration.
- `TerminalModel` exposes a single input-state API and surface-state API used by renderers.
- Long-running threshold and state live in model/engine code, not `render/`.
- Cursor rendering policy is explicit and testable.
- `claude`, `codex`, `pi`, and `coco` keep current working TUI takeover behavior.
- `coco` no longer shows a fake lower-left cursor from a forced parked PTY cursor.
- Tests cover state derivation and renderer consumption separately.
