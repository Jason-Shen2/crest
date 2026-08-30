# Agent Session Loading Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the persisted-thread spinner placeholder with a delayed, accessible conversation skeleton that reassures users during long hydration without flashing on fast loads.

**Architecture:** Keep `thread.isLoading` and the existing `isHydratingThread` selector as the lifecycle source. Move visual and timer behavior into a focused `ThreadLoading` component, then render it from `registry-thread.tsx`; use deterministic skeleton widths and fake-timer tests so rendering remains stable.

**Tech Stack:** React, TypeScript, assistant-ui, Tailwind CSS, Testing Library, Vitest fake timers.

---

### Task 1: Build the Delayed Conversation Skeleton

**Files:**
- Create: `frontend/app/agent/assistant-ui/thread-loading.tsx`
- Create: `frontend/app/agent/assistant-ui/thread-loading.test.tsx`

- [ ] **Step 1: Write failing timing, content, and cleanup tests**

Create `frontend/app/agent/assistant-ui/thread-loading.test.tsx`:

```tsx
// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadLoading } from "./thread-loading";

describe("ThreadLoading", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it("waits 180ms before showing deterministic conversation skeletons", () => {
        const { container } = render(<ThreadLoading />);

        expect(screen.queryByRole("status")).toBeNull();
        act(() => vi.advanceTimersByTime(179));
        expect(screen.queryByRole("status")).toBeNull();

        act(() => vi.advanceTimersByTime(1));

        expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
        expect(screen.queryByText("Loading conversation…")).not.toBeNull();
        expect(container.querySelectorAll('[data-slot="aui_thread-loading-turn"]')).toHaveLength(2);
        expect(container.querySelectorAll('[data-slot="aui_thread-loading-user"]')).toHaveLength(2);
        expect(container.querySelectorAll('[data-slot="aui_thread-loading-assistant"]')).toHaveLength(2);
        expect(
            container.querySelector('[data-slot="aui_thread-loading-skeletons"]')?.getAttribute("aria-hidden")
        ).toBe("true");
    });

    it("changes the reassurance copy after three seconds", () => {
        render(<ThreadLoading />);

        act(() => vi.advanceTimersByTime(180));
        expect(screen.queryByText("Loading conversation…")).not.toBeNull();

        act(() => vi.advanceTimersByTime(2_820));
        expect(screen.queryByText("Loading a long conversation…")).not.toBeNull();
        expect(screen.queryByText("Loading conversation…")).toBeNull();
    });

    it("clears both pending timers when hydration finishes early", () => {
        const { unmount } = render(<ThreadLoading />);
        expect(vi.getTimerCount()).toBe(2);

        unmount();

        expect(vi.getTimerCount()).toBe(0);
    });
});
```

- [ ] **Step 2: Run the component test and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/thread-loading.test.tsx --exclude '.claude/**'
```

Expected: FAIL because `./thread-loading` does not exist.

- [ ] **Step 3: Implement the focused loading component**

Create `frontend/app/agent/assistant-ui/thread-loading.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState, type FC } from "react";

const SkeletonDelayMs = 180;
const LongWaitDelayMs = 3_000;

interface ThreadLoadingTurnProps {
    userWidthClassName: string;
    assistantWidthClassNames: readonly [string, string];
}

const ThreadLoadingTurn: FC<ThreadLoadingTurnProps> = ({
    userWidthClassName,
    assistantWidthClassNames,
}) => {
    return (
        <div data-slot="aui_thread-loading-turn" className="flex flex-col gap-4">
            <div className="flex justify-end">
                <div
                    data-slot="aui_thread-loading-user"
                    className={cn("bg-muted h-10 rounded-xl", userWidthClassName)}
                />
            </div>
            <div data-slot="aui_thread-loading-assistant" className="flex flex-col gap-2.5">
                <div className={cn("bg-muted h-3 rounded-full", assistantWidthClassNames[0])} />
                <div className={cn("bg-muted h-3 rounded-full", assistantWidthClassNames[1])} />
            </div>
        </div>
    );
};

export const ThreadLoading: FC = () => {
    const [isVisible, setIsVisible] = useState(false);
    const [isLongWait, setIsLongWait] = useState(false);

    useEffect(() => {
        const visibleTimer = window.setTimeout(() => setIsVisible(true), SkeletonDelayMs);
        const longWaitTimer = window.setTimeout(() => {
            setIsVisible(true);
            setIsLongWait(true);
        }, LongWaitDelayMs);

        return () => {
            window.clearTimeout(visibleTimer);
            window.clearTimeout(longWaitTimer);
        };
    }, []);

    if (!isVisible) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            data-slot="aui_thread-loading"
            className="animate-in fade-in flex flex-1 flex-col py-4 duration-200 motion-reduce:animate-none"
        >
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <RefreshCwIcon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                <span>{isLongWait ? "Loading a long conversation…" : "Loading conversation…"}</span>
            </div>
            <div
                aria-hidden="true"
                data-slot="aui_thread-loading-skeletons"
                className="mt-8 flex animate-pulse flex-col gap-10 motion-reduce:animate-none"
            >
                <ThreadLoadingTurn
                    userWidthClassName="w-[38%]"
                    assistantWidthClassNames={["w-[76%]", "w-[52%]"]}
                />
                <ThreadLoadingTurn
                    userWidthClassName="w-[44%]"
                    assistantWidthClassNames={["w-[68%]", "w-[46%]"]}
                />
            </div>
        </div>
    );
};
```

- [ ] **Step 4: Run the component tests and verify GREEN**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/thread-loading.test.tsx --exclude '.claude/**'
```

Expected: PASS with 3 tests.

- [ ] **Step 5: Commit the standalone component**

```bash
git add frontend/app/agent/assistant-ui/thread-loading.tsx frontend/app/agent/assistant-ui/thread-loading.test.tsx
git commit -m "feat: add agent conversation loading skeleton"
```

### Task 2: Integrate the Skeleton into the Assistant Thread

**Files:**
- Modify: `frontend/app/agent/assistant-ui/registry-thread.tsx:35-65,146-258`
- Modify: `frontend/app/agent/assistant-ui/thread.integration.test.tsx:5-110`

- [ ] **Step 1: Convert the loading integration test to a client render**

Update the imports in `frontend/app/agent/assistant-ui/thread.integration.test.tsx`:

```tsx
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
```

Add cleanup near the helpers:

```tsx
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
```

Replace `renderLoadingThread` with:

```tsx
function loadingThread(props?: ThreadProps) {
    return (
        <RuntimeProvider messages={[]} isLoading>
            <Thread {...props} />
        </RuntimeProvider>
    );
}
```

Replace the existing loading test with:

```tsx
it("renders conversation skeletons instead of the welcome view while history hydrates", () => {
    vi.useFakeTimers();
    const { container } = render(loadingThread());

    expect(container.querySelector('[data-slot="aui_thread-loading"]')).toBeNull();
    expect(container.textContent).not.toContain("How can I help you today?");

    act(() => vi.advanceTimersByTime(180));

    expect(container.querySelector('[data-slot="aui_thread-loading"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-slot="aui_thread-loading-turn"]')).toHaveLength(2);
    expect(container.textContent).toContain("Loading conversation…");
    expect(container.textContent).not.toContain("How can I help you today?");
    expect(container.querySelector('[data-slot="aui_message-group"]')?.textContent).toBe("");
});
```

- [ ] **Step 2: Run the integration test and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/thread.integration.test.tsx --exclude '.claude/**'
```

Expected: FAIL because the current inline `ThreadLoading` renders immediately and has no skeleton turns.

- [ ] **Step 3: Wire the new component into the registry thread**

In `frontend/app/agent/assistant-ui/registry-thread.tsx`, remove `RefreshCwIcon` from the `lucide-react` imports and add:

```tsx
import { ThreadLoading } from "./thread-loading";
```

Keep the existing selector and render point unchanged:

```tsx
const isHydratingThread = (s: AssistantState) => s.thread.isLoading && !s.threads.isLoading;
```

```tsx
<AuiIf condition={isHydratingThread}>
    <ThreadLoading />
</AuiIf>
```

Delete the old inline `ThreadLoading` implementation that contains the centered spinner and `Loading conversation…` copy.

- [ ] **Step 4: Run component and integration tests and verify GREEN**

Run:

```bash
npx vitest run \
    frontend/app/agent/assistant-ui/thread-loading.test.tsx \
    frontend/app/agent/assistant-ui/thread.integration.test.tsx \
    --exclude '.claude/**'
```

Expected: PASS with no fake-timer leakage or React act warnings.

- [ ] **Step 5: Run adjacent assistant UI regressions**

Run:

```bash
npx vitest run \
    frontend/app/agent/assistant-ui/runtime-bridge.test.ts \
    frontend/app/agent/agent-content.test.tsx \
    frontend/app/workspace/workspace-agent-content-slot.test.tsx \
    --exclude '.claude/**'
```

Expected: PASS. Loaded messages, composer content, and workspace agent surfaces remain unchanged.

- [ ] **Step 6: Commit the integration**

```bash
git add frontend/app/agent/assistant-ui/registry-thread.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx
git commit -m "feat: show conversation skeleton during hydration"
```

### Task 3: Final Verification

**Files:**
- Verify all files modified in Tasks 1–2.

- [ ] **Step 1: Run the focused hydration and assistant UI suite**

Run:

```bash
npx vitest run \
    frontend/app/store/use-pi-chat.test.tsx \
    frontend/app/agent/assistant-ui/thread-loading.test.tsx \
    frontend/app/agent/assistant-ui/runtime-bridge.test.ts \
    frontend/app/agent/assistant-ui/thread.integration.test.tsx \
    frontend/app/agent/agent-content.test.tsx \
    frontend/app/workspace/workspace-agent-content-slot.test.tsx \
    --exclude '.claude/**'
```

Expected: PASS. Hydration lifecycle, delayed skeleton, loaded thread, and embedding surfaces remain covered.

- [ ] **Step 2: Check TypeScript diagnostics for changed files**

Run:

```bash
npx tsc --noEmit --pretty false
```

The repository currently has unrelated baseline diagnostics, so this command may exit non-zero. Expected for this change: no diagnostic references these files:

```text
frontend/app/agent/assistant-ui/thread-loading.tsx
frontend/app/agent/assistant-ui/thread-loading.test.tsx
frontend/app/agent/assistant-ui/registry-thread.tsx
frontend/app/agent/assistant-ui/thread.integration.test.tsx
```

- [ ] **Step 3: Audit formatting and repository state**

Run:

```bash
git diff --check
git status --short
git log -3 --oneline
```

Expected: `git diff --check` emits nothing; only the user's pre-existing untracked files remain; the two implementation commits are at the tip of `main`.

- [ ] **Step 4: Perform a manual visual check when an app window is available**

Open a persisted thread with enough history to exceed 180ms and verify:

1. The welcome heading never appears.
2. The skeleton aligns with the real message column and composer.
3. Animation is subtle in light and dark themes.
4. Real history replaces the skeleton without jumping outside the message area.
5. With reduced motion enabled, the layout remains visible without rotation, pulse, or fade.

If no app window is available, report the manual visual check as not performed rather than inferring it from automated tests.
