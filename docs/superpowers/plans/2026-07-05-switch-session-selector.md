# Switch Session Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the terminal slash-command selector to the newer `SessionSelector` implementation.

**Architecture:** `terminal-view.tsx` owns the production mounting point for `/tree`, `/fork`, and `/resume`. Replace the old local `AgentSelectorPopover` import with the newer `SessionSelector` from `frontend/app/view/cmdblock/session-selector.tsx`; props are already shape-compatible.

**Tech Stack:** React, TypeScript, Vitest.

---

### Task 1: Switch Terminal Selector Mount

**Files:**
- Modify: `frontend/app/term/render/terminal-view.tsx`
- Test: `frontend/app/term/render/terminal-view-selector-import.test.ts`
- Verify: `frontend/app/term/render/agent-chat-host-api.test.ts`, `frontend/app/view/cmdblock/session-selector.test.tsx`, `frontend/app/term/render/agent-selector-popover.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/term/render/terminal-view-selector-import.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("terminal view selector implementation", () => {
    it("uses the shared cmdblock SessionSelector instead of the legacy term popover", () => {
        const source = readFileSync(join(process.cwd(), "frontend/app/term/render/terminal-view.tsx"), "utf8");

        expect(source).toContain('import { SessionSelector } from "@/app/view/cmdblock/session-selector";');
        expect(source).toContain("<SessionSelector");
        expect(source).not.toContain('import { AgentSelectorPopover } from "./agent-selector-popover";');
        expect(source).not.toContain("<AgentSelectorPopover");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- frontend/app/term/render/terminal-view-selector-import.test.ts --run --exclude '**/.worktrees/**'`

Expected: FAIL because `terminal-view.tsx` still imports and renders `AgentSelectorPopover`.

- [ ] **Step 3: Write minimal implementation**

In `frontend/app/term/render/terminal-view.tsx`, replace:

```ts
import { AgentSelectorPopover } from "./agent-selector-popover";
```

with:

```ts
import { SessionSelector } from "@/app/view/cmdblock/session-selector";
```

Then replace:

```tsx
<AgentSelectorPopover
    anchorRef={agentSelectorAnchorRef}
    request={agentSelectorRequest}
    onClose={() => setAgentSelectorRequest(null)}
    onUserMessage={(msg) => globalStore.set(model.notificationAtom, msg)}
    onEditorText={onAgentEditorText}
/>
```

with:

```tsx
<SessionSelector
    anchorRef={agentSelectorAnchorRef}
    request={agentSelectorRequest}
    onClose={() => setAgentSelectorRequest(null)}
    onUserMessage={(msg) => globalStore.set(model.notificationAtom, msg)}
    onEditorText={onAgentEditorText}
/>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- frontend/app/term/render/terminal-view-selector-import.test.ts frontend/app/term/render/agent-chat-host-api.test.ts frontend/app/view/cmdblock/session-selector.test.tsx frontend/app/term/render/agent-selector-popover.test.tsx --run --exclude '**/.worktrees/**'`

Expected: PASS. The legacy popover tests remain passing because the file still exists, but production mounting now uses `SessionSelector`.

- [ ] **Step 5: Check relevant TypeScript errors**

Run: `npx tsc --noEmit --pretty false 2>&1 | grep -E 'frontend/app/term/render/terminal-view|frontend/app/view/cmdblock/session-selector' || true`

Expected: no output for these touched files.
