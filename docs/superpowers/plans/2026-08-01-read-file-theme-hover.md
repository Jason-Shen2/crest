# Read File Theme and Hover Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make successful Read file chips follow the active theme and highlight the full clickable row coherently on hover.

**Architecture:** Keep the existing `ReadToolActivity` structure and behavior. Add a named Tailwind group to the existing file button and replace fixed cyan chip colors with semantic theme classes plus named group-hover classes; lock the contract with the existing component test.

**Tech Stack:** React 19, TypeScript, Tailwind v4, Testing Library, Vitest.

---

## File Map

- Modify `frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx`: assert semantic theme and coordinated hover classes on a successful Read file entry.
- Modify `frontend/app/agent/assistant-ui/tools/tool-activity.tsx`: apply the named hover group and semantic theme classes.

### Task 1: Polish clickable Read file colors

**Files:**
- Modify: `frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx`
- Modify: `frontend/app/agent/assistant-ui/tools/tool-activity.tsx`

- [ ] **Step 1: Extend the successful Read interaction test with the visual contract**

After expanding the Read group, select the successful file button and chip, then assert the required semantic and hover classes:

```tsx
const fileButton = screen.getByRole("button", { name: "Open src/app.ts" });
const fileChip = screen.getByText("src/app.ts");

expect(fileButton.className).toContain("group/read-file");
expect(fileButton.className).toContain("hover:text-foreground");
expect(fileChip.className).toContain("bg-muted");
expect(fileChip.className).toContain("text-foreground/85");
expect(fileChip.className).toContain("group-hover/read-file:bg-accent");
expect(fileChip.className).toContain("group-hover/read-file:text-foreground");

fireEvent.click(fileButton);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx
```

Expected: FAIL because the successful file button lacks `group/read-file` and the chip still uses fixed cyan classes.

- [ ] **Step 3: Apply the minimal semantic theme and hover classes**

Change the successful file button to a named group while retaining its existing interaction, focus, and inherited label hover behavior:

```tsx
className="group/read-file flex w-fit cursor-pointer items-center gap-1.5 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
```

Replace the successful file chip classes with:

```tsx
className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground/85 transition-colors group-hover/read-file:bg-accent group-hover/read-file:text-foreground"
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx
```

Expected: 3 tests pass with no failures.

- [ ] **Step 5: Check formatting and the affected integration surface**

Run:

```bash
npx prettier --check frontend/app/agent/assistant-ui/tools/tool-activity.tsx frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx
npx vitest run frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx
```

Expected: Prettier reports both files formatted and both test files pass.

- [ ] **Step 6: Commit the implementation**

```bash
git add frontend/app/agent/assistant-ui/tools/tool-activity.tsx frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx
git commit -m "fix: theme read file activity hover"
```
