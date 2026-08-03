# Context Composition Disclosures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the duplicate Composition and Sources UI into one Composition card whose category rows expand their source inventory inline.

**Architecture:** `ContextComposition` will own category grouping and multi-expand disclosure state. The existing inventory module will be reduced to a focused category-detail renderer that preserves Conversation virtualization and `ContextItem` rendering. `ContextInspector` will render only the combined Composition surface; snapshot data and runtime behavior remain unchanged.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Testing Library, Vitest, `@tanstack/react-virtual`.

---

### Task 1: Specify the combined disclosure behavior with failing UI tests

**Files:**
- Create: `frontend/app/agent/context-inspector/context-composition.test.tsx`
- Modify: `frontend/app/agent/context-inspector/context-inspector.test.tsx`

- [x] **Step 1: Add a test fixture with sources in two categories and one empty category**

Build an `AgentContextSnapshotView` containing Agent instructions, Tools, Conversation, and Added context summaries plus concrete instruction, tool, and conversation items.

- [x] **Step 2: Assert the wished-for interaction**

The test must assert that:

```tsx
expect(screen.queryByRole("heading", { name: "Sources" })).toBeNull();
const instructions = screen.getByRole("button", { name: /Agent instructions, 1 sources/ });
const tools = screen.getByRole("button", { name: /Tools, 1 sources/ });
fireEvent.click(instructions);
fireEvent.click(tools);
expect(instructions.getAttribute("aria-expanded")).toBe("true");
expect(tools.getAttribute("aria-expanded")).toBe("true");
expect(screen.getByText("Base prompt source")).toBeTruthy();
expect(screen.getByText("read_file")).toBeTruthy();
```

Also expand Added context and assert `No active sources.` is shown.

- [x] **Step 3: Run the tests and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/context-inspector/context-composition.test.tsx frontend/app/agent/context-inspector/context-inspector.test.tsx --reporter=dot --silent
```

Expected: FAIL because Composition rows are not disclosure buttons and the standalone Sources heading still exists.

### Task 2: Move source expansion into Composition

**Files:**
- Modify: `frontend/app/agent/context-inspector/context-composition.tsx`
- Modify: `frontend/app/agent/context-inspector/context-inventory.tsx`
- Modify: `frontend/app/agent/context-inspector/context-inspector.tsx`

- [x] **Step 1: Reduce the inventory module to a category-detail renderer**

Export a component with this interface:

```tsx
export function ContextCategoryItems({
    category,
    items,
}: {
    category: AgentContextSnapshotCategoryView;
    items: AgentContextSnapshotItemView[];
})
```

It renders `No active sources.` for an empty category, keeps `ConversationItems` virtualization for Conversation, adds `data-testid="context-conversation-items"` to that virtualized scroll container, and maps all other categories through `ContextItem`. It owns no heading, card, summaries, or expansion state.

- [x] **Step 2: Make each Composition category row a disclosure**

In `ContextComposition`, group `snapshot.items` by category with `useMemo`, track a `Set<AgentContextSnapshotCategoryView>` with `useState`, and render each category as:

```tsx
<div className="border-b border-border/50 last:border-b-0">
    <button type="button" aria-expanded={expanded} aria-label={`${label}, ${itemCount} sources`}>
        <Icon name="chevron-right" />
        {/* existing dot, description, tokens, percentage, and source count */}
    </button>
    {expanded ? <ContextCategoryItems category={category} items={categoryItems} /> : null}
</div>
```

The expansion setter copies the current set and toggles only the clicked category so multiple categories remain open.

- [x] **Step 3: Remove the standalone Sources surface**

Delete the `ContextInventory` import and render call from `ContextInspector`. Keep Request overhead as the final non-button row in the Composition card and keep attribution diagnostics below the card.

- [x] **Step 4: Run the disclosure tests and verify GREEN**

Run the Task 1 command. Expected: both files pass.

### Task 3: Preserve virtualization and accessibility regressions

**Files:**
- Modify: `frontend/app/agent/context-inspector/context-inventory.test.tsx`
- Modify: `frontend/app/agent/context-inspector/context-composition.test.tsx`

- [x] **Step 1: Retarget the long Conversation test to `ContextComposition`**

Render a snapshot with 1,000 Conversation sources, expand its Composition row, and assert:

```tsx
expect(screen.getByText(/1,000 sources/)).toBeTruthy();
expect(screen.getByTestId("context-conversation-items").getAttribute("data-virtualized")).toBe("conversation");
expect(screen.getAllByTestId("context-inventory-item").length).toBeLessThan(100);
```

- [x] **Step 2: Verify disclosure accessibility and independent expansion**

Assert every semantic category is a native button with `aria-expanded`, chevrons rotate only for expanded rows, and opening a second category does not close the first.

- [x] **Step 3: Run all Context Inspector UI tests**

```bash
npx vitest run frontend/app/agent/context-inspector/context-format.test.ts frontend/app/agent/context-inspector/context-composition.test.tsx frontend/app/agent/context-inspector/context-inspector.test.tsx frontend/app/agent/context-inspector/context-inventory.test.tsx --reporter=dot --silent
```

Expected: all tests pass with no unhandled errors.

### Task 4: Verify and commit the refinement

**Files:**
- Modify: `docs/superpowers/plans/2026-08-02-context-composition-disclosures.md`

- [x] **Step 1: Scan for duplicate Sources UI and placeholders**

```bash
rg -n "Sources|TODO|TBD|placeholder" frontend/app/agent/context-inspector docs/superpowers/plans/2026-08-02-context-composition-disclosures.md
```

Expected: no rendered standalone Sources heading, no new placeholders, and any test reference to Sources asserts its absence.

- [x] **Step 2: Run the broader renderer regression**

```bash
npx vitest run frontend/app/agent/context-inspector frontend/app/agent/agent-content.test.tsx frontend/app/workspace/right-tool-panel.test.tsx frontend/app/workspace/workspace-right-panel-host.test.tsx --reporter=dot --silent
```

Expected: all selected files pass.

- [x] **Step 3: Run the production build**

```bash
npm run build:prod
```

Expected: exit code 0; existing chunk and optional image-optimizer warnings may remain.

- [x] **Step 4: Commit the implementation**

```bash
git add frontend/app/agent/context-inspector docs/superpowers/plans/2026-08-02-context-composition-disclosures.md
git commit -m "refactor: merge context composition and sources"
```
