# Warp Terminal State Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Crest terminal TUI/input/cursor/CLI-agent ownership decisions from React heuristics into model-level state modeled after Warp.

**Architecture:** Add a focused engine state module, move long-running semantics into `Block`, expose `TerminalModel` state APIs, then migrate renderers to consume those APIs. CLI agent session semantics are introduced only after generic terminal state is model-owned, so command names never drive generic TUI takeover.

**Tech Stack:** TypeScript, React, Jotai, Vitest, Crest terminal engine/render modules.

---

## File Structure

- Create `frontend/app/term/engine/terminal-state.ts`: shared model-level state types and pure helpers for terminal capture, input state, surface state, cursor policy, and CLI agent sessions.
- Create `frontend/app/term/engine/terminal-state.test.ts`: pure tests for capture state, surface state, cursor state, and CLI agent command detection.
- Modify `frontend/app/term/engine/index.ts`: export the new state module.
- Modify `frontend/app/term/engine/block.ts`: add Warp-style long-running state and interaction methods.
- Create `frontend/app/term/engine/block-interaction.test.ts`: tests for `Block.isActiveAndLongRunning()` and `wasLongRunning` behavior.
- Modify `frontend/app/term/terminal-model.ts`: expose `getTerminalInputState()`, `getActiveSurfaceState()`, `getCursorRenderState()`, `getCLIAgentSession()`, and `nextLongRunningCheckDelayMs()`.
- Create `frontend/app/term/terminal-model-state.test.ts`: model-level tests for input state priority and surface state.
- Modify `frontend/app/term/render/terminal-view.tsx`: consume `TerminalInputState` instead of local `inAltScreen`/duration scanning.
- Modify `frontend/app/term/render/block-list-element.tsx`: consume `TerminalSurfaceState` for full-height wrapper.
- Modify `frontend/app/term/render/block-element.tsx`: consume surface/cursor state and remove `forceCursorVisible` heuristics.
- Modify `frontend/app/term/render/cursor-overlay.tsx`: remove `forceVisible`; keep it as a pure terminal cursor renderer.
- Modify existing TUI tests under `frontend/app/term/render/*tui*.test.tsx`: update assertions to the new state contracts.
- Retire `frontend/app/term/render/tui-capture.ts`: remove it after all consumers are migrated, or leave a temporary compatibility shim only until the final cleanup task.

## Task 1: Add Engine Terminal State Types And Pure Helpers

**Files:**
- Create: `frontend/app/term/engine/terminal-state.ts`
- Create: `frontend/app/term/engine/terminal-state.test.ts`
- Modify: `frontend/app/term/engine/index.ts`

- [ ] **Step 1: Write the failing pure state tests**

Create `frontend/app/term/engine/terminal-state.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DefaultTermMode, type TermMode } from "./types";
import {
    detectCLIAgent,
    terminalCaptureActive,
    type CursorRenderState,
    type TerminalInputState,
    type TerminalSurfaceState,
} from "./terminal-state";

function mode(overrides: Partial<TermMode> = {}): TermMode {
    return { ...DefaultTermMode, ...overrides };
}

describe("terminal-state", () => {
    it("treats Warp-style terminal capture modes as terminal capture", () => {
        expect(terminalCaptureActive(mode({ appCursor: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ appKeypad: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ focusReport: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ alternateScroll: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ mouseClick: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ kittyKeyboardFlags: 1 }))).toBe(true);
    });

    it("does not treat bracketed paste alone as terminal capture", () => {
        expect(terminalCaptureActive(mode({ bracketedPaste: true }))).toBe(false);
    });

    it("defines serializable input, surface, and cursor states", () => {
        const input: TerminalInputState = { kind: "long-running-command", blockId: "b1" };
        const surface: TerminalSurfaceState = { kind: "long-running-pty", blockId: "b1" };
        const cursor: CursorRenderState = { kind: "suppressed", reason: "parked-cursor" };

        expect(input.kind).toBe("long-running-command");
        expect(surface.kind).toBe("long-running-pty");
        expect(cursor.kind).toBe("suppressed");
    });

    it("detects CLI agent command prefixes without changing generic capture", () => {
        expect(detectCLIAgent("claude")).toBe("claude");
        expect(detectCLIAgent("claude --dangerously-skip-permissions")).toBe("claude");
        expect(detectCLIAgent("codex")).toBe("codex");
        expect(detectCLIAgent("gemini")).toBe("gemini");
        expect(detectCLIAgent("pi")).toBe("pi");
        expect(detectCLIAgent("coco")).toBe("coco");
        expect(detectCLIAgent("echo coco")).toBe(null);
        expect(detectCLIAgent("npm test")).toBe(null);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/engine/terminal-state.test.ts
```

Expected: fails because `./terminal-state` does not exist.

- [ ] **Step 3: Add the minimal terminal state module**

Create `frontend/app/term/engine/terminal-state.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mouseReportingActive, type BlockId, type TermMode } from "./types";

export type TerminalInputState =
    | { kind: "not-bootstrapped" }
    | { kind: "input-editor" }
    | { kind: "long-running-command"; blockId: BlockId }
    | { kind: "alt-screen"; blockId: BlockId }
    | { kind: "terminal-capture"; blockId: BlockId };

export type CLIAgent = "claude" | "codex" | "gemini" | "pi" | "coco" | "unknown";

export type TerminalSurfaceState =
    | { kind: "normal-output"; blockId: BlockId }
    | { kind: "alt-screen"; blockId: BlockId }
    | { kind: "terminal-capture"; blockId: BlockId }
    | { kind: "long-running-pty"; blockId: BlockId }
    | { kind: "cli-agent"; blockId: BlockId; agent: CLIAgent };

export type CursorRenderState =
    | { kind: "hidden" }
    | { kind: "terminal" }
    | { kind: "suppressed"; reason: "cli-soft-cursor" | "rich-input-open" | "parked-cursor" }
    | { kind: "cli-owned"; agent: CLIAgent };

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

export function terminalCaptureActive(mode: TermMode | null | undefined): boolean {
    if (!mode) return false;
    return (
        mode.appCursor ||
        mode.appKeypad ||
        mode.focusReport ||
        mode.alternateScroll ||
        mouseReportingActive(mode) ||
        mode.kittyKeyboardFlags !== 0
    );
}

export function detectCLIAgent(command: string | undefined): CLIAgent | null {
    const first = command?.trim().split(/\s+/)[0];
    switch (first) {
        case "claude":
        case "codex":
        case "gemini":
        case "pi":
        case "coco":
            return first;
        default:
            return null;
    }
}
```

Modify `frontend/app/term/engine/index.ts`:

```ts
export * from "./terminal-state";
```

Add it after the existing exports.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/engine/terminal-state.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add frontend/app/term/engine/terminal-state.ts frontend/app/term/engine/terminal-state.test.ts frontend/app/term/engine/index.ts
git commit -m "feat(term): add terminal state primitives"
```

## Task 2: Move Long-Running Semantics Into Block

**Files:**
- Modify: `frontend/app/term/engine/block.ts`
- Create: `frontend/app/term/engine/block-interaction.test.ts`

- [ ] **Step 1: Write the failing block interaction tests**

Create `frontend/app/term/engine/block-interaction.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { Block } from "./block";
import { DefaultTermMode } from "./types";
import { LONG_RUNNING_COMMAND_DURATION_MS } from "./block";

function makeRunningBlock(startTs: number): Block {
    const block = new Block({ id: "b1", seq: 1, cols: 80 });
    block.startCommand();
    block.startTs = startTs;
    return block;
}

describe("Block interaction state", () => {
    it("does not become long-running before the Warp threshold", () => {
        const block = makeRunningBlock(1_000);
        expect(block.isActiveAndLongRunning(1_000 + LONG_RUNNING_COMMAND_DURATION_MS)).toBe(false);
    });

    it("becomes long-running after the Warp threshold and stays cached while active", () => {
        const block = makeRunningBlock(1_000);
        expect(block.isActiveAndLongRunning(1_000 + LONG_RUNNING_COMMAND_DURATION_MS + 1)).toBe(true);
        expect(block.wasLongRunning).toBe(true);
        expect(block.isActiveAndLongRunning(1_010)).toBe(true);
    });

    it("does not report done blocks as active long-running commands", () => {
        const block = makeRunningBlock(1_000);
        expect(block.isActiveAndLongRunning(1_000 + LONG_RUNNING_COMMAND_DURATION_MS + 1)).toBe(true);
        block.finishCommand(0);
        expect(block.isActiveAndLongRunning(1_000 + LONG_RUNNING_COMMAND_DURATION_MS + 2)).toBe(false);
    });

    it("maps block interaction mode with alt-screen and terminal capture priority", () => {
        const block = makeRunningBlock(1_000);
        block.enterAltScreen();
        expect(block.interactionMode(DefaultTermMode, 2_000)).toBe("alt-screen");
        block.exitAltScreen();
        expect(block.interactionMode({ ...DefaultTermMode, appCursor: true }, 2_000)).toBe("terminal-capture");
        expect(block.interactionMode(DefaultTermMode, 2_000)).toBe("long-running-command");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/engine/block-interaction.test.ts
```

Expected: fails because `LONG_RUNNING_COMMAND_DURATION_MS`, `wasLongRunning`, `isActiveAndLongRunning()`, and `interactionMode()` are missing.

- [ ] **Step 3: Implement Block long-running state**

Modify `frontend/app/term/engine/block.ts` imports:

```ts
import { terminalCaptureActive } from "./terminal-state";
import type { TermMode } from "./types";
```

Add near the top of `block.ts`:

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

Add to `Block` fields:

```ts
wasLongRunning = false;
```

Add methods to `Block`:

```ts
isRunning(): boolean {
    return this.state === "running";
}

isActiveAndLongRunning(now: number = Date.now()): boolean {
    if (!this.isRunning()) return false;
    if (this.wasLongRunning) return true;
    if (this.startTs == null) return false;
    if (now - this.startTs > LONG_RUNNING_COMMAND_DURATION_MS) {
        this.wasLongRunning = true;
        return true;
    }
    return false;
}

interactionMode(mode: TermMode, now: number = Date.now()): BlockInteractionMode {
    if (this.altScreen.active) return "alt-screen";
    if (!this.isRunning()) return "idle";
    if (terminalCaptureActive(mode)) return "terminal-capture";
    if (this.isActiveAndLongRunning(now)) return "long-running-command";
    return "input-editor";
}
```

- [ ] **Step 4: Run the block interaction tests**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/engine/block-interaction.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run terminal state tests**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/engine/terminal-state.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add frontend/app/term/engine/block.ts frontend/app/term/engine/block-interaction.test.ts
git commit -m "feat(term): move long-running state into block"
```

## Task 3: Add TerminalModel State APIs

**Files:**
- Modify: `frontend/app/term/terminal-model.ts`
- Create: `frontend/app/term/terminal-model-state.test.ts`

- [ ] **Step 1: Write failing TerminalModel state tests**

Create `frontend/app/term/terminal-model-state.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { Block } from "./engine/block";
import { LONG_RUNNING_COMMAND_DURATION_MS } from "./engine/block";
import { TerminalModel } from "./terminal-model";

function addBlock(model: TerminalModel, block: Block): void {
    model.getBlocks().push(block);
}

function runningBlock(id: string, startTs: number): Block {
    const block = new Block({ id, seq: 1, cols: 80 });
    block.startCommand();
    block.startTs = startTs;
    return block;
}

describe("TerminalModel terminal state", () => {
    it("returns input-editor when no running block owns input", () => {
        const model = new TerminalModel("outer");
        expect(model.getTerminalInputState(1_000)).toEqual({ kind: "input-editor" });
        expect(model.getActiveSurfaceState(1_000)).toBe(null);
    });

    it("gives alt-screen priority over terminal capture and long-running", () => {
        const model = new TerminalModel("outer");
        const block = runningBlock("b1", 1_000);
        block.enterAltScreen();
        addBlock(model, block);
        model.setModeForTest({ appCursor: true });

        expect(model.getTerminalInputState(2_000)).toEqual({ kind: "alt-screen", blockId: "b1" });
        expect(model.getActiveSurfaceState(2_000)).toEqual({ kind: "alt-screen", blockId: "b1" });
    });

    it("returns terminal-capture for running capture modes", () => {
        const model = new TerminalModel("outer");
        addBlock(model, runningBlock("b1", 1_000));
        model.setModeForTest({ appCursor: true });

        expect(model.getTerminalInputState(1_010)).toEqual({ kind: "terminal-capture", blockId: "b1" });
        expect(model.getActiveSurfaceState(1_010)).toEqual({ kind: "terminal-capture", blockId: "b1" });
    });

    it("returns long-running-command after the Warp threshold", () => {
        const model = new TerminalModel("outer");
        addBlock(model, runningBlock("b1", 1_000));

        expect(model.getTerminalInputState(1_000 + LONG_RUNNING_COMMAND_DURATION_MS)).toEqual({ kind: "input-editor" });
        expect(model.getTerminalInputState(1_000 + LONG_RUNNING_COMMAND_DURATION_MS + 1)).toEqual({
            kind: "long-running-command",
            blockId: "b1",
        });
        expect(model.getActiveSurfaceState(1_000 + LONG_RUNNING_COMMAND_DURATION_MS + 1)).toEqual({
            kind: "long-running-pty",
            blockId: "b1",
        });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/terminal-model-state.test.ts
```

Expected: fails because the model APIs and `setModeForTest()` do not exist.

- [ ] **Step 3: Add TerminalModel state APIs**

Modify `frontend/app/term/terminal-model.ts` imports:

```ts
import {
    detectCLIAgent,
    terminalCaptureActive,
    type CLIAgentSession,
    type CursorRenderState,
    type TerminalInputState,
    type TerminalSurfaceState,
} from "./engine/terminal-state";
import { LONG_RUNNING_COMMAND_DURATION_MS } from "./engine/block";
```

Add public methods near the read-side API section:

```ts
private activeRuntimeBlock(): Block | null {
    const all = this.blocks.all();
    for (let i = all.length - 1; i >= 0; i--) {
        const block = all[i];
        if (block.id === "__sentinel__") continue;
        if (block.altScreen.active || block.state === "running") return block;
    }
    return null;
}

getTerminalInputState(now: number = Date.now()): TerminalInputState {
    const block = this.activeRuntimeBlock();
    if (!block) return { kind: "input-editor" };
    if (block.altScreen.active) return { kind: "alt-screen", blockId: block.id };
    if (block.state === "running" && terminalCaptureActive(this.mode)) {
        return { kind: "terminal-capture", blockId: block.id };
    }
    if (block.isActiveAndLongRunning(now)) {
        return { kind: "long-running-command", blockId: block.id };
    }
    return { kind: "input-editor" };
}

getActiveSurfaceState(now: number = Date.now()): TerminalSurfaceState | null {
    const inputState = this.getTerminalInputState(now);
    switch (inputState.kind) {
        case "alt-screen":
            return { kind: "alt-screen", blockId: inputState.blockId };
        case "terminal-capture":
            return { kind: "terminal-capture", blockId: inputState.blockId };
        case "long-running-command":
            return { kind: "long-running-pty", blockId: inputState.blockId };
        default:
            return null;
    }
}

getCursorRenderState(blockId: BlockId, now: number = Date.now()): CursorRenderState {
    const surface = this.getActiveSurfaceState(now);
    if (!surface || surface.blockId !== blockId) return { kind: "terminal" };
    if (surface.kind === "long-running-pty") return { kind: "suppressed", reason: "parked-cursor" };
    return { kind: "terminal" };
}

getCLIAgentSession(blockId: BlockId): CLIAgentSession | null {
    const block = this.blocks.findById(blockId);
    const agent = detectCLIAgent(block?.commandText());
    if (!block || !agent) return null;
    return {
        blockId,
        agent,
        status: block.state === "running" ? "in-progress" : "idle",
        inputState: { kind: "pty-owned" },
    };
}

nextLongRunningCheckDelayMs(now: number = Date.now()): number | null {
    const block = this.activeRuntimeBlock();
    if (!block || block.state !== "running" || block.startTs == null || block.wasLongRunning) return null;
    const remaining = LONG_RUNNING_COMMAND_DURATION_MS - (now - block.startTs) + 1;
    return remaining > 0 ? remaining : 0;
}

setModeForTest(patch: Partial<TermMode>): void {
    if (process.env.NODE_ENV !== "test") {
        throw new Error("setModeForTest is test-only");
    }
    this.applyModePatch(patch);
}
```

- [ ] **Step 4: Run the TerminalModel state tests**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/terminal-model-state.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run engine state tests**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/engine/terminal-state.test.ts frontend/app/term/engine/block-interaction.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add frontend/app/term/terminal-model.ts frontend/app/term/terminal-model-state.test.ts
git commit -m "feat(term): expose terminal input state from model"
```

## Task 4: Migrate TerminalView And BlockListElement To Model State

**Files:**
- Modify: `frontend/app/term/render/terminal-view.tsx`
- Modify: `frontend/app/term/render/block-list-element.tsx`
- Modify: `frontend/app/term/render/terminal-view-tui.test.tsx`
- Modify: `frontend/app/term/render/block-list-element-tui.test.tsx`

- [ ] **Step 1: Update tests to assert model-state-driven behavior**

In `frontend/app/term/render/terminal-view-tui.test.tsx`, keep existing test names but ensure each test model mock exposes:

```ts
getTerminalInputState: () => ({ kind: "terminal-capture", blockId: "block-capture" }),
getActiveSurfaceState: () => ({ kind: "terminal-capture", blockId: "block-capture" }),
nextLongRunningCheckDelayMs: () => null,
```

Add a focused test:

```tsx
it("uses TerminalModel input state to hide the command input", () => {
    testState.blocks = [
        {
            id: "block-model-state",
            state: "running",
            altScreen: { active: false },
            commandText: () => "coco",
        },
    ];
    testState.inputStateOverride = { kind: "long-running-command", blockId: "block-model-state" };
    const html = renderToStaticMarkup(<TerminalView outerBlockId="outer" />);

    expect(html).not.toContain('data-testid="cmd-input"');
});
```

In `frontend/app/term/render/block-list-element-tui.test.tsx`, add:

```tsx
it("lets the active surface wrapper fill the pane from TerminalSurfaceState", () => {
    const html = renderToStaticMarkup(
        <BlockListElement
            model={{
                ...makeModel({
                    id: "block-surface",
                    kind: "shell",
                    hidden: false,
                    state: "running",
                    isBackground: false,
                    isStatic: false,
                    altScreen: { active: false },
                    commandText: () => "coco",
                } as any),
                getActiveSurfaceState: () => ({ kind: "long-running-pty", blockId: "block-surface" }),
                getMode: () => DefaultTermMode,
            } as any}
        />
    );

    expect(html).toMatch(/data-block-oid="block-surface"[^>]*class="[^"]*h-full/);
});
```

- [ ] **Step 2: Run updated component tests to verify they fail**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/render/terminal-view-tui.test.tsx frontend/app/term/render/block-list-element-tui.test.tsx
```

Expected: fails because components still use `blockIsActiveTuiSurface()`.

- [ ] **Step 3: Migrate TerminalView**

In `frontend/app/term/render/terminal-view.tsx`, replace local `activeAltScreenBlock`/`inAltScreen` derivation with:

```ts
const terminalInputState = useMemo(
    () => model.getTerminalInputState(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, revision, longRunningTick]
);
const activeSurfaceState = useMemo(
    () => model.getActiveSurfaceState(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, revision, longRunningTick]
);
const inAltScreen = terminalInputState.kind !== "input-editor";
```

Replace the long-running timeout effect with:

```ts
useEffect(() => {
    const delay = model.nextLongRunningCheckDelayMs();
    if (delay == null) return;
    const timeout = setTimeout(() => setLongRunningTick((tick) => tick + 1), delay);
    return () => clearTimeout(timeout);
}, [model, revision]);
```

Keep keydown/paste/focus routing tied to `inAltScreen` for this task so behavior remains unchanged while the source of truth moves.

- [ ] **Step 4: Migrate BlockListElement**

In `frontend/app/term/render/block-list-element.tsx`, replace:

```ts
const activeTuiSurface = blockIsActiveTuiSurface(block, model.getMode());
```

with:

```ts
const activeSurfaceState = model.getActiveSurfaceState?.() ?? null;
const activeTuiSurface = activeSurfaceState?.blockId === block.id;
```

Remove the `blockIsActiveTuiSurface` import from this file.

- [ ] **Step 5: Run component tests**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/render/terminal-view-tui.test.tsx frontend/app/term/render/block-list-element-tui.test.tsx
```

Expected: all tests pass.

- [ ] **Step 6: Run model tests**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/terminal-model-state.test.ts frontend/app/term/engine/block-interaction.test.ts frontend/app/term/engine/terminal-state.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit Task 4**

Run:

```bash
git add frontend/app/term/render/terminal-view.tsx frontend/app/term/render/block-list-element.tsx frontend/app/term/render/terminal-view-tui.test.tsx frontend/app/term/render/block-list-element-tui.test.tsx
git commit -m "feat(term): drive terminal view from model input state"
```

## Task 5: Migrate BlockElement And CursorOverlay To Surface/Cursor State

**Files:**
- Modify: `frontend/app/term/render/block-element.tsx`
- Modify: `frontend/app/term/render/cursor-overlay.tsx`
- Modify: `frontend/app/term/render/block-element-tui.test.tsx`
- Modify: `frontend/app/term/render/cursor-overlay.test.tsx`

- [ ] **Step 1: Write failing cursor ownership tests**

In `frontend/app/term/render/cursor-overlay.test.tsx`, replace the force-visible test with:

```tsx
it("does not force a hidden terminal cursor visible", () => {
    const html = renderToStaticMarkup(
        <CursorOverlay grid={grid(false)} charWidth={8} lineHeight={16} />
    );

    expect(html).toBe("");
});
```

In `frontend/app/term/render/block-element-tui.test.tsx`, add:

```tsx
it("does not render a cursor for long-running PTY when model suppresses parked cursor", () => {
    const block = makeBlock(false) as any;
    block.outputGrid.cursorState.visible = false;
    const html = renderToStaticMarkup(
        <BlockElement
            block={block}
            revision={1}
            model={{
                getMode: () => DefaultTermMode,
                getActiveSurfaceState: () => ({ kind: "long-running-pty", blockId: block.id }),
                getCursorRenderState: () => ({ kind: "suppressed", reason: "parked-cursor" }),
            } as any}
        />
    );

    expect(html).not.toContain('data-testid="cursor"');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/render/block-element-tui.test.tsx frontend/app/term/render/cursor-overlay.test.tsx
```

Expected: fails because `forceVisible` still exists and `BlockElement` does not consume `getCursorRenderState()`.

- [ ] **Step 3: Simplify CursorOverlay**

In `frontend/app/term/render/cursor-overlay.tsx`, remove `forceVisible` from props and remove this branch:

```ts
if (!forceVisible && !grid.cursorState.visible) return null;
```

Replace it with:

```ts
if (!grid.cursorState.visible) return null;
```

- [ ] **Step 4: Migrate BlockElement surface and cursor decisions**

In `frontend/app/term/render/block-element.tsx`, remove `hasVisibleCursorAnchor()` and remove imports from `./tui-capture`.

Replace active surface derivation with:

```ts
const activeSurfaceState = model?.getActiveSurfaceState?.() ?? null;
const activeTuiSurface = activeSurfaceState?.blockId === block.id;
const surfaceKind = activeTuiSurface ? activeSurfaceState.kind : "normal-output";
```

Replace alt-screen/grid selection with:

```ts
const showAltScreen = surfaceKind === "alt-screen" || frozenAltScreen;
const liveGrid = showAltScreen ? block.altScreen.grid : block.outputGrid.raw();
```

Replace cursor derivation with:

```ts
const cursorState = model?.getCursorRenderState?.(block.id) ?? { kind: "terminal" as const };
const showCursor = (block.state === "running" || inAltScreen) && cursorState.kind === "terminal";
```

Render `CursorOverlay` without `forceVisible`:

```tsx
{showCursor && !showCollapsed && (
    <CursorOverlay
        grid={liveGrid}
        charWidth={effCharWidth}
        lineHeight={lineHeight}
        revision={revision}
    />
)}
```

- [ ] **Step 5: Run block and cursor tests**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/render/block-element-tui.test.tsx frontend/app/term/render/cursor-overlay.test.tsx
```

Expected: all tests pass.

- [ ] **Step 6: Run all TUI renderer tests**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/render/terminal-view-tui.test.tsx frontend/app/term/render/block-list-element-tui.test.tsx frontend/app/term/render/block-element-tui.test.tsx frontend/app/term/render/cursor-overlay.test.tsx
```

Expected: all tests pass.

- [ ] **Step 7: Commit Task 5**

Run:

```bash
git add frontend/app/term/render/block-element.tsx frontend/app/term/render/cursor-overlay.tsx frontend/app/term/render/block-element-tui.test.tsx frontend/app/term/render/cursor-overlay.test.tsx
git commit -m "feat(term): render cursor from model cursor state"
```

## Task 6: Add CLI Agent Session Tests And Model Wiring

**Files:**
- Modify: `frontend/app/term/terminal-model.ts`
- Modify: `frontend/app/term/terminal-model-state.test.ts`
- Modify: `frontend/app/term/engine/terminal-state.test.ts`

- [ ] **Step 1: Add failing CLI session tests**

Append to `frontend/app/term/terminal-model-state.test.ts`:

```ts
it("creates CLI agent session semantics from command prefix without changing input takeover", () => {
    const model = new TerminalModel("outer");
    const block = runningBlock("b1", 1_000);
    block.cmd = "coco";
    addBlock(model, block);

    expect(model.getCLIAgentSession("b1")).toEqual({
        blockId: "b1",
        agent: "coco",
        status: "in-progress",
        inputState: { kind: "pty-owned" },
    });
    expect(model.getTerminalInputState(1_010)).toEqual({ kind: "input-editor" });
});
```

- [ ] **Step 2: Run tests to verify the new assertion fails if session behavior is missing**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/terminal-model-state.test.ts
```

Expected: fails only if `getCLIAgentSession()` is not complete or command fallback does not read `block.cmd`.

- [ ] **Step 3: Complete `getCLIAgentSession()` command fallback**

In `frontend/app/term/terminal-model.ts`, ensure the command fallback uses both `commandText()` and `cmd`:

```ts
getCLIAgentSession(blockId: BlockId): CLIAgentSession | null {
    const block = this.blocks.findById(blockId);
    if (!block) return null;
    const agent = detectCLIAgent(block.commandText() || block.cmd);
    if (!agent) return null;
    return {
        blockId,
        agent,
        status: block.state === "running" ? "in-progress" : "idle",
        inputState: { kind: "pty-owned" },
    };
}
```

- [ ] **Step 4: Run TerminalModel tests**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/terminal-model-state.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run NLD heuristic tests to verify no shell keyword hardcoding was added**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/nld/heuristic-tier1.test.ts
```

Expected: existing tests pass; no new `coco`/`pi` one-off shell keyword assertions are added.

- [ ] **Step 6: Commit Task 6**

Run:

```bash
git add frontend/app/term/terminal-model.ts frontend/app/term/terminal-model-state.test.ts frontend/app/term/engine/terminal-state.test.ts
git commit -m "feat(term): model CLI agent sessions"
```

## Task 7: Remove Render-Layer TUI Capture Helper And Run Full Regression

**Files:**
- Delete or reduce: `frontend/app/term/render/tui-capture.ts`
- Modify: `frontend/app/term/render/tui-capture.test.ts`
- Modify imports in any remaining consumers found by search.

- [ ] **Step 1: Search for remaining render-layer capture consumers**

Run:

```bash
rg "tui-capture|blockIsActiveTuiSurface|terminalCaptureActive|LONG_RUNNING_COMMAND_DURATION_MS|forceVisible|forceCursorVisible" frontend/app/term
```

Expected: remaining references are only tests being migrated or compatibility exports being removed.

- [ ] **Step 2: Delete stale tests or migrate them to engine tests**

If `frontend/app/term/render/tui-capture.test.ts` still exists, move any assertions not already covered into `frontend/app/term/engine/terminal-state.test.ts` and `frontend/app/term/engine/block-interaction.test.ts`, then delete the render test file.

Expected final search:

```bash
rg "tui-capture|blockIsActiveTuiSurface|forceVisible|forceCursorVisible" frontend/app/term
```

prints no matches.

- [ ] **Step 3: Delete the stale helper**

Use the file deletion tool for:

```text
/Users/bytedance/Documents/crest/frontend/app/term/render/tui-capture.ts
/Users/bytedance/Documents/crest/frontend/app/term/render/tui-capture.test.ts
```

Only delete these files after Step 2 confirms all tests migrated.

- [ ] **Step 4: Run focused terminal regression**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npm test -- frontend/app/term/engine/terminal-state.test.ts frontend/app/term/engine/block-interaction.test.ts frontend/app/term/terminal-model-state.test.ts frontend/app/term/render/terminal-view-tui.test.tsx frontend/app/term/render/block-list-element-tui.test.tsx frontend/app/term/render/block-element-tui.test.tsx frontend/app/term/render/cursor-overlay.test.tsx frontend/app/term/render/grid-element.test.tsx frontend/app/term/nld/heuristic-tier1.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 6: Run TypeScript check with known-project caveat**

Run:

```bash
PATH="/opt/homebrew/Cellar/node@22/22.22.3/bin:$PATH" npx tsc --noEmit
```

Expected: the repository may still have existing unrelated type errors. If errors appear, verify there are no new errors in:

```text
frontend/app/term/engine/terminal-state.ts
frontend/app/term/engine/block.ts
frontend/app/term/terminal-model.ts
frontend/app/term/render/terminal-view.tsx
frontend/app/term/render/block-list-element.tsx
frontend/app/term/render/block-element.tsx
frontend/app/term/render/cursor-overlay.tsx
```

- [ ] **Step 7: Commit Task 7**

Run:

```bash
git add frontend/app/term
git commit -m "refactor(term): remove render-layer tui capture heuristics"
```

## Manual Verification Checklist

- [ ] Start `claude`; verify Crest bottom input hides, keyboard input goes to PTY, and cursor behavior is unchanged.
- [ ] Start `codex`; verify TUI behavior works and sparse row rendering does not crash.
- [ ] Start `pi`; verify bottom input hides and typed characters go to the PTY.
- [ ] Start `coco`; verify bottom input hides, sizing remains correct, and no fake lower-left cursor appears.
- [ ] Start `vim`, `less`, or `htop`; verify alt-screen behavior is unchanged.
- [ ] Run a normal short command such as `echo hi`; verify Crest input remains available after command completion.
- [ ] Paste into a bracketed-paste app; verify paste is wrapped and routed to PTY.
- [ ] Use a mouse-reporting TUI; verify mouse press/drag/release still routes correctly unless Shift is held for selection.

## Self-Review

- Spec coverage: Tasks 1-7 cover model input state, block long-running, surface state, cursor state, CLI session model, renderer migration, cleanup, and regression.
- Placeholder scan: No implementation step relies on unspecified behavior; each file change lists concrete code or exact commands.
- Type consistency: `TerminalInputState`, `TerminalSurfaceState`, `CursorRenderState`, `CLIAgentSession`, and `CLIAgent` names match the approved spec.
