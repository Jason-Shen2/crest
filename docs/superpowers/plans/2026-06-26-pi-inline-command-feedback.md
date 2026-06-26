# Pi Inline Command Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `/session`, `/copy`, `/compact`, `/export`, `/import`, and `/reload` results inline in the agent pane instead of toast notifications.

**Architecture:** Add a small frontend-only inline command result model and renderer. Route successful/no-op command results from `createAgentChatHostApi` to a new `onCommandResult` callback while preserving `onSessionMinted`; reserve `onUserError` for actual execution failures.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, existing Tailwind utility classes.

---

## File Structure

- Create `frontend/app/term/render/agent-command-result.tsx`: render Pi-style inline status lines, session info blocks, and compact summary blocks.
- Modify `frontend/app/term/render/agent-chat-host.tsx`: expose command result callback and stop sending command success messages through `onUserError`.
- Modify `frontend/app/term/render/terminal-view.tsx`: store and render inline command results in the agent content area.
- Test `frontend/app/term/render/agent-command-result.test.tsx`: component behavior.
- Test `frontend/app/term/render/agent-chat-host-api.test.ts`: command result routing.

---

### Task 1: Command Result Routing

**Files:**
- Modify: `frontend/app/term/render/agent-chat-host.tsx`
- Test: `frontend/app/term/render/agent-chat-host-api.test.ts`

- [ ] **Step 1: Write failing routing test**

Add a test that submits `/copy`, returns `{ status: "success", message: "Copied last agent message to clipboard" }`, expects `onCommandResult` called with `{ command: "copy", status: "success", message: ... }`, and expects `onUserError` not called.

- [ ] **Step 2: Run RED**

Run: `npm test -- frontend/app/term/render/agent-chat-host-api.test.ts --run`

Expected: FAIL because `onCommandResult` does not exist and current code calls `onUserError`.

- [ ] **Step 3: Implement routing**

Add `onCommandResult?: (result: AgentInlineCommandResult) => void` to `AgentChatHostApiDeps`. Define `AgentInlineCommandResult` with `command`, `status`, `message`, and optional `sessionMetadata`. In `runImmediateCommand`, call `onCommandResult` for command results and keep `onUserError` only for rejected promises or unavailable runtime.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- frontend/app/term/render/agent-chat-host-api.test.ts --run`

Expected: PASS.

---

### Task 2: Inline Result Renderer

**Files:**
- Create: `frontend/app/term/render/agent-command-result.tsx`
- Test: `frontend/app/term/render/agent-command-result.test.tsx`

- [ ] **Step 1: Write failing renderer tests**

Cover:
- `/copy` status line renders dim inline text.
- `/session` message renders `Session Info`, `Messages`, `Tokens`, and `Cost` headings.
- `/compact` success renders a summary block.
- `noop` renders a warning/error-like inline line.

- [ ] **Step 2: Run RED**

Run: `npm test -- frontend/app/term/render/agent-command-result.test.tsx --run`

Expected: FAIL because the component file does not exist.

- [ ] **Step 3: Implement renderer**

Create a memoized React component that accepts `AgentInlineCommandResult`. Parse known multiline `/session` output into preformatted section lines. Render `/compact` success as a bordered inline block. Render other status results as a single muted line.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- frontend/app/term/render/agent-command-result.test.tsx --run`

Expected: PASS.

---

### Task 3: Terminal Integration

**Files:**
- Modify: `frontend/app/term/render/terminal-view.tsx`
- Test: `frontend/app/term/render/terminal-view-tui.test.tsx` or focused renderer tests if terminal tests are too broad.

- [ ] **Step 1: Write failing integration test**

Assert that a submitted immediate command result appears in the terminal content area and the notification toast is not used for the success message.

- [ ] **Step 2: Run RED**

Run the focused test chosen in Step 1.

Expected: FAIL because terminal still uses `notificationAtom`.

- [ ] **Step 3: Implement integration**

Add local state for inline command results in `TerminalView`, pass `onCommandResult` to `AgentChatHost`, and render `AgentCommandResultList` near the agent content stream. Do not alter `/model`, `/tree`, `/fork`, or `/resume`.

- [ ] **Step 4: Run GREEN**

Run the focused test chosen in Step 1.

Expected: PASS.

---

### Task 4: Final Verification

**Files:**
- All modified files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- frontend/app/term/render/agent-chat-host-api.test.ts frontend/app/term/render/agent-command-result.test.tsx frontend/app/term/render/agent-slash-command-routing.test.ts frontend/app/term/render/agent-selector-popover.test.tsx --run
```

Expected: PASS.

- [ ] **Step 2: Run formatting checks**

Run:

```bash
npx prettier --check frontend/app/term/render/agent-chat-host.tsx frontend/app/term/render/agent-command-result.tsx frontend/app/term/render/agent-command-result.test.tsx frontend/app/term/render/terminal-view.tsx
git diff --check
```

Expected: PASS.

- [ ] **Step 3: Commit**

Run:

```bash
git add frontend/app/term/render/agent-chat-host.tsx frontend/app/term/render/agent-chat-host-api.test.ts frontend/app/term/render/agent-command-result.tsx frontend/app/term/render/agent-command-result.test.tsx frontend/app/term/render/terminal-view.tsx docs/superpowers/specs/2026-06-26-pi-inline-command-feedback-design.md docs/superpowers/plans/2026-06-26-pi-inline-command-feedback.md docs/superpowers/mockups/pi-command-feedback-mock.html
git commit -m "feat: render pi command results inline"
```
