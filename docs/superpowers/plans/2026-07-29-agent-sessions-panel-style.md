# Agent Sessions Panel Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved compact A1 visual treatment to the left Agent Sessions panel without changing any session behavior.

**Architecture:** Keep `AgentSessionsPanel` and its current data flow intact. Add one focused rendering test for the neutral visual-state contract, then replace the panel's ad hoc white backgrounds with existing sidebar tokens and compact inset row styling.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Jotai, Vitest, Testing Library

---

## File Structure

- Modify `frontend/app/agent/agent-sessions-panel.test.tsx` to protect the approved compact, neutral row-state styling.
- Modify `frontend/app/agent/agent-sessions-panel.tsx` to apply the A1 list inset, row geometry, neutral states, timestamp hierarchy, and empty-state spacing.

### Task 1: Protect the A1 Visual Contract

**Files:**
- Test: `frontend/app/agent/agent-sessions-panel.test.tsx`

- [ ] **Step 1: Add the failing visual-state test**

Add this test after `marks the active row from WorkspaceAgentModel state`:

```tsx
it("uses compact neutral styles for active, focused, and default rows", async () => {
    const sessions = [
        makeSession("/sessions/active.sqlite", "session-active"),
        makeSession("/sessions/other.sqlite", "session-other"),
    ];
    const { agentModel } = renderPanel({ sessions });
    globalStore.set(agentModel.stateAtom, {
        activeSession: {
            id: "session-active",
            createdAt: "2026-07-25T10:00:00.000Z",
            cwd: "/repo",
            path: "/sessions/active.sqlite",
        },
        selection: undefined,
        preferredTerminalTabId: "",
    });

    const rows = await screen.findAllByRole("button", { name: /hello/ });
    const activeRow = rows[0];
    const otherRow = rows[1];
    const list = document.querySelector(".aui-thread-list");

    expect(list?.className).toContain("p-2");
    expect(activeRow.className).toContain("min-h-[34px]");
    expect(activeRow.className).toContain("rounded-md");
    expect(activeRow.className).toContain("bg-sidebar-accent");
    expect(activeRow.className).toContain("text-sidebar-accent-foreground");
    expect(activeRow.className).not.toContain("bg-white");

    fireEvent.mouseEnter(otherRow);

    expect(otherRow.className).toContain("bg-sidebar-accent/70");
    expect(otherRow.className).not.toContain("bg-white");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/agent-sessions-panel.test.tsx
```

Expected: FAIL in the new test because the list lacks `p-2` and the active row still uses `bg-white/[0.08]`.

### Task 2: Apply the Compact Neutral Styling

**Files:**
- Modify: `frontend/app/agent/agent-sessions-panel.tsx:226-267`

- [ ] **Step 1: Add list inset and empty-state spacing**

Change the list and state classes to:

```tsx
<div
    ref={listRef}
    tabIndex={0}
    className="aui-thread-list flex-grow overflow-auto p-2 outline-none"
    onKeyDown={handleKeyDown}
>
    {loading && sessions.length === 0 ? (
        <div className="px-3 py-5 text-center text-xs text-muted-foreground">Loading...</div>
    ) : null}
    {!loading && sessions.length === 0 ? (
        <div className="px-3 py-5 text-center text-xs text-muted-foreground">No sessions yet.</div>
    ) : null}
```

- [ ] **Step 2: Replace row geometry and state classes**

Replace the row's class expression with:

```tsx
className={
    "aui-thread-list-item group relative flex min-h-[34px] w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-foreground/85 transition-colors " +
    (isActive
        ? "bg-sidebar-accent text-sidebar-accent-foreground "
        : isFocused
          ? "bg-sidebar-accent/70 "
          : "hover:bg-sidebar-accent/60 ")
}
```

Remove `text-foreground/85` from the title span so the active foreground token can inherit:

```tsx
<span className="min-w-0 flex-1 truncate text-[13px] leading-[1.4]">{title}</span>
```

Reduce timestamp contrast while keeping its existing size:

```tsx
<span className="shrink-0 text-[11px] leading-[1.4] text-muted-foreground/50">{time}</span>
```

- [ ] **Step 3: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run frontend/app/agent/agent-sessions-panel.test.tsx
```

Expected: PASS with all `AgentSessionsPanel` tests green.

- [ ] **Step 4: Run the frontend type check**

Run:

```bash
npx tsc --noEmit --pretty false
```

Expected: exit code 0. If unrelated baseline errors exist, record them and confirm none reference the two modified Agent Sessions files.

- [ ] **Step 5: Review the scoped diff**

Run:

```bash
git diff --check
git diff -- frontend/app/agent/agent-sessions-panel.tsx frontend/app/agent/agent-sessions-panel.test.tsx
```

Expected: no whitespace errors and only the approved styling plus its focused regression test.

- [ ] **Step 6: Commit the implementation**

```bash
git add frontend/app/agent/agent-sessions-panel.tsx frontend/app/agent/agent-sessions-panel.test.tsx
git commit -m "style: polish agent sessions panel"
```

