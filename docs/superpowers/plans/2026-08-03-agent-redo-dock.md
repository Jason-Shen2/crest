# Agent Redo Dock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current generic Redo Dock with the approved compact “revert receipt” UI in both collapsed and expanded states.

**Architecture:** Keep `RedoDock` as a presentation-only component driven by the existing authoritative `AgentRedoView`. Reuse the existing Button and file icon system; keep expansion local, keep Redo execution caller-owned, and make no backend or API changes.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Radix-backed Crest Button, Lucide icons, Vitest, Testing Library.

---

### Task 1: Implement the approved Redo Dock states

**Files:**
- Modify: `frontend/app/agent/rewind/redo-dock.tsx`
- Test: `frontend/app/agent/rewind/redo-dock.test.tsx`

- [ ] **Step 1: Replace the old behavior assertions with failing tests for the approved UI**

Update `redo-dock.test.tsx` to mock and assert the existing file icon system:

```tsx
const getFileIconMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/fileexplorer/file-icon", () => ({
    getFileIcon: getFileIconMock,
}));

function TestFileIcon(props: { className?: string; size?: number }) {
    return <svg data-testid="redo-file-icon" className={props.className} data-size={props.size} />;
}
```

Reset the mock before each test and return `TestFileIcon`. Cover these exact behaviors:

```tsx
it("renders the compact reverted summary with a persistent Redo action and neutral shell", () => {
    render(<RedoDock redo={makeRedo()} busy={false} onRedo={vi.fn()} />);

    expect(screen.getByText("Changes reverted")).not.toBeNull();
    expect(screen.getByText("3 messages · 2 files")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Redo" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Show reverted details" })).not.toBeNull();
    expect(screen.getByRole("region", { name: "Reverted workspace changes" }).className).not.toMatch(
        /border-l|before:/
    );
    expect(screen.queryByText("Operation operation-1")).toBeNull();
});

it("expands the reverted prompt and review-style file rows without exposing operation metadata", () => {
    render(<RedoDock redo={makeRedo()} busy={false} onRedo={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show reverted details" }));

    expect(screen.getByText("Reverted request")).not.toBeNull();
    expect(screen.getByText("Restore the original implementation")).not.toBeNull();
    expect(screen.getByText("Files")).not.toBeNull();
    expect(getFileIconMock).toHaveBeenCalledWith("new.ts", false, false);
    expect(getFileIconMock).toHaveBeenCalledWith("removed.ts", false, false);
    expect(screen.getAllByText("src/")[0].className).toContain("text-muted-foreground");
    expect(screen.getByText("+4").className).toContain("text-success");
    expect(screen.getByText("-1").className).toContain("text-destructive");
    expect(screen.getByText("M")).not.toBeNull();
    expect(screen.getByText("D")).not.toBeNull();
    expect(screen.queryByText(/operation-1/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Redo" })).not.toBeNull();
});
```

Keep the existing tests that prove `onRedo` fires once, the disclosure has correct `aria-controls`, details are internally scrollable, and busy disables duplicate Redo. Add a layout assertion that the action uses `max-sm:col-span-3 max-sm:row-start-2 max-sm:w-full` and the disclosure uses `max-sm:col-start-3 max-sm:row-start-1`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/rewind/redo-dock.test.tsx
```

Expected: FAIL because the current component still renders `Reverted 3 messages · 2 files`, exposes `Operation operation-1`, uses text operation pills instead of `getFileIcon`, and lacks the approved responsive structure.

- [ ] **Step 3: Implement the compact summary and reusable file rows**

In `redo-dock.tsx`:

1. Import `getFileIcon`, `cn`, `Undo2Icon`, `Redo2Icon`, and `ChevronDownIcon`.
2. Add a local path splitter that returns muted directory and emphasized basename.
3. Map operations to `A`, `M`, and `D`.
4. Render file rows with the existing file icon, directory/basename hierarchy, `text-success` additions, `text-destructive` deletions, and muted operation status.
5. Replace the old shell with a neutral `border-border` card. Do not add a left accent border or pseudo-element.
6. Use this summary hierarchy:

```tsx
<div className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto_auto] items-center gap-2.5 px-3 py-2.5 max-sm:grid-cols-[2.25rem_minmax(0,1fr)_auto]">
    <div className="grid size-9 place-items-center rounded-lg bg-accent/10 text-accent">
        <Undo2Icon className="size-[18px]" />
    </div>
    <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">Changes reverted</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
            {countLabel(redo.messageCount, "message")} · {countLabel(redo.fileCount, "file")}
        </p>
    </div>
    <Button className="cursor-pointer max-sm:col-span-3 max-sm:row-start-2 max-sm:w-full" disabled={busy} onClick={onRedo} size="sm">
        <Redo2Icon className="size-3.5" />
        Redo
    </Button>
    <button className="max-sm:col-start-3 max-sm:row-start-1" aria-expanded={expanded} aria-controls={detailsId} aria-label={expanded ? "Hide reverted details" : "Show reverted details"}>
        <ChevronDownIcon className={cn("size-4 transition-transform", expanded && "rotate-180")} />
    </button>
</div>
```

On narrow widths, keep the disclosure in the first row and move Redo to a full-width second row. Preserve visible keyboard focus styles on the icon button.

Render the expanded body with `Reverted request`, the prompt, a `Files` heading, the file count, and the file rows. Keep `max-h-64 overflow-y-auto`; remove all rendering of `redo.operationId`. Keep the non-interactive details mounted inside a `grid` transition wrapper and switch between `grid-rows-[0fr] opacity-0 pointer-events-none` and `grid-rows-[1fr] opacity-100`; set `aria-hidden={!expanded}` and expose `role="region"` only while expanded. Use `duration-200 motion-reduce:transition-none` so both expand and collapse animate without leaving hidden interactive controls focusable.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run frontend/app/agent/rewind/redo-dock.test.tsx frontend/app/agent/agent-content.test.tsx
```

Expected: PASS with no failures.

- [ ] **Step 5: Run the development build**

Run:

```bash
npm run build:dev
```

Expected: exit code 0. Existing Vite chunk and optional image optimizer warnings are acceptable; no new TypeScript or bundling error is acceptable.

- [ ] **Step 6: Review the implementation against the approved mockup**

Confirm all of the following in the local app or component preview:

- neutral outer border with no orange left edge;
- compact collapsed hierarchy;
- Redo visible in both states;
- expanded prompt and file list;
- no operation id;
- file icon and diff colors match existing Review UI;
- narrow layout moves Redo to a full-width second row;
- hover remains muted gray rather than blue.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/agent/rewind/redo-dock.tsx frontend/app/agent/rewind/redo-dock.test.tsx
git commit -m "feat(agent): polish conversation redo dock"
```
