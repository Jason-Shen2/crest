# Terminal Welcome Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the old Crest icon and two-line copy in the xterm empty welcome state.

**Architecture:** Keep `BlockWatermark` and its existing xterm visibility lifecycle. Replace only its centered Terax content with Crest's shared terminal icon and original heading and description, with a focused component regression test.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Vitest, Testing Library

---

### Task 1: Restore the Crest terminal welcome

**Files:**
- Create: `frontend/app/xterm/block/block-watermark.test.tsx`
- Modify: `frontend/app/xterm/block/block-watermark.tsx`

- [ ] **Step 1: Write the failing content test**

Create `frontend/app/xterm/block/block-watermark.test.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockWatermark, type WatermarkState } from "./block-watermark";

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("BlockWatermark", () => {
    it("renders the original Crest terminal welcome", () => {
        render(<BlockWatermark subscribe={() => () => undefined} getState={() => "visible"} />);

        expect(document.querySelector('[data-icon-name="computer-terminal-02"]')).toBeTruthy();
        expect(screen.getByText("Run your first command")).toBeTruthy();
        expect(screen.getByText("Type below to start a terminal session.")).toBeTruthy();
        expect(screen.queryByText("Browse your command history")).toBeNull();
        expect(screen.queryByText("Autocomplete paths and commands")).toBeNull();
        expect(screen.queryByText("Switch between Shell and AI")).toBeNull();
        expect(screen.queryByText("Open the command palette")).toBeNull();
    });

    it("unmounts its content after the dead-state fade", () => {
        vi.useFakeTimers();
        let state: WatermarkState = "visible";
        const listeners = new Set<() => void>();

        render(
            <BlockWatermark
                subscribe={(listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                }}
                getState={() => state}
            />
        );

        act(() => {
            state = "dead";
            for (const listener of listeners) listener();
        });
        expect(screen.getByText("Run your first command")).toBeTruthy();

        act(() => vi.advanceTimersByTime(600));
        expect(screen.queryByText("Run your first command")).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npx vitest run frontend/app/xterm/block/block-watermark.test.tsx
```

Expected: the first test fails because `computer-terminal-02` and the restored copy are absent.

- [ ] **Step 3: Implement the minimal welcome restoration**

In `frontend/app/xterm/block/block-watermark.tsx`:

- Replace the `logo.svg` and `isMacOS` imports with `Icon` from `@/app/icon/Icon`.
- Remove the platform-specific shortcut calculation.
- Replace the image and shortcut grid with:

```tsx
<div data-icon-name="computer-terminal-02" className="mb-3 text-current">
    <Icon name="computer-terminal-02" size={28} strokeWidth={1.75} className="opacity-70" />
</div>
<h1 className="text-lg font-semibold text-current">Run your first command</h1>
<p className="mt-1 text-sm text-current/60">Type below to start a terminal session.</p>
```

- Change the outer layout spacing to match the old Crest welcome state.
- Delete the now-unused `Hint` and `Key` components.
- Preserve `subscribe`, `getState`, `gone`, and the 600 ms dead-state lifecycle unchanged.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
npx vitest run frontend/app/xterm/block/block-watermark.test.tsx
```

Expected: 2 tests pass.

- [ ] **Step 5: Run related xterm tests**

Run:

```bash
npx vitest run frontend/app/xterm/block/block-watermark.test.tsx frontend/app/xterm/xterm-view.test.tsx
```

Expected: all tests pass with no failures.

- [ ] **Step 6: Check formatting and diff**

Run:

```bash
npx prettier --check frontend/app/xterm/block/block-watermark.tsx frontend/app/xterm/block/block-watermark.test.tsx
git diff --check
```

Expected: both commands exit successfully.

- [ ] **Step 7: Commit**

```bash
git add -f docs/superpowers/plans/2026-07-27-terminal-welcome-restoration.md
git add frontend/app/xterm/block/block-watermark.tsx frontend/app/xterm/block/block-watermark.test.tsx
git commit -m "fix(xterm): restore Crest terminal welcome"
```
