# Fullscreen TUI Trackpad Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make macOS trackpad scrolling in fullscreen SGR-mouse TUIs such as Codex and Claude Code respond directly and retain fast-swipe velocity without changing ordinary terminal scrollback.

**Architecture:** Add a tested, xterm-independent gesture controller that classifies wheel bursts, accumulates raw pixel deltas, and emits bounded SGR wheel batches once per animation frame. Wrap it with a small xterm public-API installer, then give every renderer-pool Slot one binding whose gesture state is cancelled on release/rebind and whose terminal protocol state is reset whenever xterm itself is reset.

**Tech Stack:** TypeScript, xterm 6 public APIs, Vitest, jsdom, Electron renderer pool

---

## File Structure

- Create `frontend/app/xterm/fullscreen-tui-wheel.ts`: gesture state, SGR encoding, xterm parser/wheel installation, lifecycle API.
- Create `frontend/app/xterm/fullscreen-tui-wheel.test.ts`: pure controller and public-API installation tests.
- Modify `frontend/app/xterm/renderer-pool.ts`: one binding per Slot and lifecycle cancellation/reset.
- Modify `frontend/app/xterm/renderer-pool-bind.test.ts`: extend the xterm fake and verify Slot lifecycle behavior.
- Modify `frontend/app/xterm/xterm-session.ts`: reset adapter protocol state when truncation resets xterm.

### Task 1: Gesture Controller and SGR Encoding

**Files:**
- Create: `frontend/app/xterm/fullscreen-tui-wheel.test.ts`
- Create: `frontend/app/xterm/fullscreen-tui-wheel.ts`

- [ ] **Step 1: Write failing pure-controller tests**

Create tests that construct the controller with fake time, frame scheduling, geometry, tracking mode, and send callbacks:

```ts
const makeWheel = (partial: Partial<WheelEventLike> = {}): WheelEventLike => ({
    deltaMode: 0,
    deltaX: 0,
    deltaY: 6,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    clientX: 50,
    clientY: 50,
    timeStamp: 1,
    ...partial,
});

it("accumulates raw trackpad pixels and sends an SGR report on the next frame", () => {
    const h = makeHarness();
    h.controller.setPrivateModes([1000, 1006], true);
    expect(h.controller.handleWheel(makeWheel({ deltaY: 20 }))).toBe(false);
    h.flushFrame();
    expect(h.sent).toEqual(["\x1b[<65;5;3M"]);
});

it("keeps a fast momentum burst on the trackpad path and caps a frame at four reports", () => {
    const h = makeHarness();
    h.controller.setPrivateModes([1000, 1006], true);
    h.controller.handleWheel(makeWheel({ deltaY: 2, timeStamp: 1 }));
    h.controller.handleWheel(makeWheel({ deltaY: 200, timeStamp: 20 }));
    h.flushFrame();
    expect(h.sent[0]?.match(/\x1b\[<65;/g)).toHaveLength(4);
});

it("clears residual movement when direction reverses", () => {
    const h = makeHarness();
    h.controller.setPrivateModes([1000, 1006], true);
    h.controller.handleWheel(makeWheel({ deltaY: 10, timeStamp: 1 }));
    h.controller.handleWheel(makeWheel({ deltaY: -20, timeStamp: 10 }));
    h.flushFrame();
    expect(h.sent).toEqual(["\x1b[<64;5;3M"]);
});

it("falls back for physical wheels, ctrl gestures, and unsupported encodings", () => {
    const h = makeHarness();
    h.controller.setPrivateModes([1000, 1006], true);
    expect(h.controller.handleWheel(makeWheel({ deltaMode: 1, deltaY: 3 }))).toBe(true);
    expect(h.controller.handleWheel(makeWheel({ ctrlKey: true }))).toBe(true);
    h.controller.setPrivateModes([1016], true);
    expect(h.controller.handleWheel(makeWheel())).toBe(true);
});
```

Add separate `it(...)` cases with these assertions:

```ts
expect(h.controller.handleWheel(makeWheel({ deltaY: 100, timeStamp: 500 }))).toBe(true);
expect(encodeSgrWheel("down", { col: 999, row: -1 }, { alt: true }, 10, 5)).toBe(
    "\x1b[<73;10;1M"
);
h.controller.setPrivateModes([1000, 1006], true);
h.controller.setPrivateModes([1006], false);
expect(h.controller.handleWheel(makeWheel())).toBe(true);
h.controller.resetTerminal();
expect(h.controller.handleWheel(makeWheel())).toBe(true);
h.controller.dispose();
expect(h.pendingFrame()).toBeNull();
```

For overflow dropping, send 200 pixels, flush twice without adding another
event, and assert the second flush sends nothing.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run frontend/app/xterm/fullscreen-tui-wheel.test.ts
```

Expected: FAIL because `./fullscreen-tui-wheel` does not exist.

- [ ] **Step 3: Implement the minimal controller**

Create these public types and constants:

```ts
export type WheelEventLike = Pick<
    WheelEvent,
    "deltaMode" | "deltaX" | "deltaY" | "ctrlKey" | "shiftKey" | "altKey" | "clientX" | "clientY" | "timeStamp"
>;

export type TuiWheelGeometry = {
    left: number;
    top: number;
    width: number;
    height: number;
    cols: number;
    rows: number;
};

export type TuiWheelControllerOptions = {
    getTrackingMode: () => "none" | "x10" | "vt200" | "drag" | "any";
    getGeometry: () => TuiWheelGeometry | null;
    send: (data: string) => void;
    requestFrame: (callback: FrameRequestCallback) => number;
    cancelFrame: (handle: number) => void;
};
```

Implement `FullscreenTuiWheelController` with:

- encoding state `default | sgr | sgr-pixels`;
- a 120 ms gesture idle gap;
- trackpad classification only for pixel-mode, predominantly vertical input
  whose first delta is small, fractional, or two-axis;
- one raw cell height per report, derived from `geometry.height / rows`;
- a four-report frame cap;
- direction-reversal residual clearing;
- `setPrivateModes(params, enabled)`, `handleWheel(event)`,
  `cancelGesture()`, `resetTerminal()`, and `dispose()`;
- SGR codes 64/65, modifier bits Shift=4, Alt=8, Control=16, and clamped 1-based
  cell coordinates;
- one concatenated `send` call per frame and no timer-generated inertia.

Export the pure helper used by the controller:

```ts
export function encodeSgrWheel(
    direction: "up" | "down",
    position: { col: number; row: number },
    modifiers: { shift?: boolean; alt?: boolean; ctrl?: boolean },
    cols: number,
    rows: number
): string;
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run frontend/app/xterm/fullscreen-tui-wheel.test.ts
```

Expected: all controller tests PASS.

- [ ] **Step 5: Commit the controller**

```bash
git add frontend/app/xterm/fullscreen-tui-wheel.ts frontend/app/xterm/fullscreen-tui-wheel.test.ts
git commit -m "feat(xterm): add fullscreen TUI wheel controller"
```

### Task 2: Install Through xterm Public APIs

**Files:**
- Modify: `frontend/app/xterm/fullscreen-tui-wheel.test.ts`
- Modify: `frontend/app/xterm/fullscreen-tui-wheel.ts`

- [ ] **Step 1: Write failing installer tests**

Add a fake terminal with captured CSI/ESC handlers and a captured custom wheel
handler. Verify:

```ts
it("observes DECSET without consuming xterm's own parser handler", () => {
    const h = makeTerminalHarness();
    const binding = installFullscreenTuiWheel(h.term, () => true);
    expect(h.csi.get("?h")?.([1000, 1006])).toBe(false);
    expect(h.wheel?.(makeWheel({ deltaY: 20 }))).toBe(false);
    h.flushFrame();
    expect(h.inputs).toEqual([["\x1b[<65;5;3M", false]]);
    binding.dispose();
});

it("returns to native xterm handling when the Slot is inactive", () => {
    const h = makeTerminalHarness();
    const binding = installFullscreenTuiWheel(h.term, () => false);
    h.csi.get("?h")?.([1000, 1006]);
    expect(h.wheel?.(makeWheel({ deltaY: 20 }))).toBe(true);
    binding.dispose();
});
```

Also verify `?l`, ESC `c`, parser disposer cleanup, and pending-frame
cancellation on `dispose`.

- [ ] **Step 2: Run the installer tests and verify RED**

Run:

```bash
npx vitest run frontend/app/xterm/fullscreen-tui-wheel.test.ts
```

Expected: FAIL because `installFullscreenTuiWheel` is not exported.

- [ ] **Step 3: Implement the installer**

Export:

```ts
export type FullscreenTuiWheelBinding = {
    cancelGesture(): void;
    resetTerminal(): void;
    dispose(): void;
};

export function installFullscreenTuiWheel(term: Terminal, isActive: () => boolean): FullscreenTuiWheelBinding;
```

The installer must:

- query `.xterm-screen` and build CSS geometry from its bounding rectangle;
- use `term.modes.mouseTrackingMode`;
- call `term.input(data, false)`;
- register `{ prefix: "?", final: "h" }`,
  `{ prefix: "?", final: "l" }`, and `{ final: "c" }` parser handlers;
- return `false` from parser observers so xterm continues processing;
- attach one custom wheel handler that returns the controller decision;
- dispose parser handlers and controller state when the binding is disposed.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run frontend/app/xterm/fullscreen-tui-wheel.test.ts
```

Expected: all controller and installer tests PASS.

- [ ] **Step 5: Commit the installer**

```bash
git add frontend/app/xterm/fullscreen-tui-wheel.ts frontend/app/xterm/fullscreen-tui-wheel.test.ts
git commit -m "feat(xterm): bind TUI scrolling through public APIs"
```

### Task 3: Renderer-Pool Slot Lifecycle

**Files:**
- Modify: `frontend/app/xterm/renderer-pool-bind.test.ts`
- Modify: `frontend/app/xterm/renderer-pool.ts`
- Modify: `frontend/app/xterm/xterm-session.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Extend the fake `Terminal` in `renderer-pool-bind.test.ts` with:

```ts
modes = { mouseTrackingMode: "none" as const };
element = document.createElement("div");
parser = {
    registerOscHandler: () => ({ dispose: () => {} }),
    registerCsiHandler: () => ({ dispose: () => {} }),
    registerEscHandler: () => ({ dispose: () => {} }),
};
attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
    this.wheelHandler = handler;
}
input(data: string, wasUserInput?: boolean) {
    this.inputs.push([data, wasUserInput]);
}
```

Add tests proving that acquiring a Slot installs a binding, releasing it cancels
pending gesture input, stealing/rebinding resets terminal protocol state, and
disposing the Slot disposes the binding.

- [ ] **Step 2: Run renderer-pool tests and verify RED**

Run:

```bash
npx vitest run frontend/app/xterm/renderer-pool-bind.test.ts frontend/app/xterm/renderer-pool.test.ts
```

Expected: FAIL because `Slot` has no fullscreen TUI wheel binding and lifecycle
methods are not called.

- [ ] **Step 3: Integrate the binding**

In `renderer-pool.ts`:

```ts
import {
    installFullscreenTuiWheel,
    type FullscreenTuiWheelBinding,
} from "./fullscreen-tui-wheel";
```

Add `tuiWheel: FullscreenTuiWheelBinding | null` to `Slot`, initialize it after
the Slot object exists, and make `isActive` require:

```ts
slot.currentLeafId !== null && !slot.parked && !slot.disposed
```

Call:

- `cancelGesture()` at the start of bind/rewire and when detaching or parking;
- `resetTerminal()` immediately before every `slot.term.reset()` in
  `renderer-pool.ts`;
- `dispose()` before `slot.term.dispose()`.

In `xterm-session.ts`, call `slot.tuiWheel?.resetTerminal()` immediately before
the truncate path calls `slot.term.reset()`.

- [ ] **Step 4: Run lifecycle and focused xterm tests**

Run:

```bash
npx vitest run \
  frontend/app/xterm/fullscreen-tui-wheel.test.ts \
  frontend/app/xterm/renderer-pool-bind.test.ts \
  frontend/app/xterm/renderer-pool.test.ts \
  frontend/app/xterm/xterm-session.test.ts
```

Expected: all focused tests PASS with no warnings.

- [ ] **Step 5: Commit renderer integration**

```bash
git add frontend/app/xterm/renderer-pool.ts frontend/app/xterm/renderer-pool-bind.test.ts frontend/app/xterm/xterm-session.ts
git commit -m "feat(xterm): enable responsive scrolling in fullscreen TUIs"
```

### Task 4: Regression Verification

**Files:**
- Verify only; no planned production changes.

- [ ] **Step 1: Run the complete xterm test group**

```bash
npx vitest run frontend/app/xterm
```

Expected: all xterm tests PASS.

- [ ] **Step 2: Run TypeScript validation**

```bash
npx tsc --noEmit
```

Expected: no new TypeScript errors. If the repository has pre-existing errors,
record them and verify none reference the files changed by this plan.

- [ ] **Step 3: Run formatting checks on changed files**

```bash
npx prettier --check \
  frontend/app/xterm/fullscreen-tui-wheel.ts \
  frontend/app/xterm/fullscreen-tui-wheel.test.ts \
  frontend/app/xterm/renderer-pool.ts \
  frontend/app/xterm/renderer-pool-bind.test.ts \
  frontend/app/xterm/xterm-session.ts
```

Expected: all listed files use Prettier formatting.

- [ ] **Step 4: Inspect the final diff**

```bash
git diff --check
git status --short
git log --oneline -5
```

Expected: no whitespace errors; unrelated pre-existing changes remain untouched;
the implementation is represented by focused commits.

- [ ] **Step 5: Perform macOS manual smoke testing**

Run default fullscreen Codex and Claude Code in Crest and verify slow response,
fast swipe velocity, reversal, stopping behavior, TUI exit/re-entry, and ordinary
scrollback as specified in the design document.
