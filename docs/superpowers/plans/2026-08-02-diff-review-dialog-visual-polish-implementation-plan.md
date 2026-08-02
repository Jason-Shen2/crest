# Diff Review Dialog Visual Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the shared diff review dialog with the approved magnified shell, compact icon-and-summary header, resizable file pane, and repository-consistent file icons.

**Architecture:** Keep `DiffReviewDialog` as the single Review/Undo/Redo/Revert surface and keep caller-owned actions in its footer. Add local, non-persisted split-pane state inside the dialog, derive header totals only from immutable file preview rows, and update the shared `FileCard` icon rendering so every embedded diff uses the existing file-icon resolver.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Radix Dialog, lucide-react, Testing Library, Vitest.

---

## File Structure

- Modify `frontend/app/agent/assistant-ui/file-card.tsx`: render the repository file icon in shared diff headers.
- Modify `frontend/app/agent/assistant-ui/file-card.test.tsx`: verify basename resolution and `showIcon={false}`.
- Modify `frontend/app/agent/rewind/diff-review-dialog.tsx`: implement Header A, viewport sizing, border removal, aggregate statistics, and the resizable file pane.
- Modify `frontend/app/agent/rewind/diff-review-dialog.test.tsx`: cover shell styling, header states, warnings, and resize clamping.
- Modify `frontend/app/agent/agent-content.tsx`: remove obsolete `description` props from both dialog callers.
- Modify `frontend/app/agent/agent-content.test.tsx`: verify no dialog caller supplies color-explanation copy.

### Task 1: Use Repository File Icons in Shared Diff Headers

**Files:**
- Modify: `frontend/app/agent/assistant-ui/file-card.test.tsx`
- Modify: `frontend/app/agent/assistant-ui/file-card.tsx`

- [ ] **Step 1: Write the failing file-icon tests**

Add a hoisted resolver mock and concrete icon before importing `FileCard`, then verify basename resolution and icon suppression:

```tsx
const getFileIconMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/fileexplorer/file-icon", () => ({ getFileIcon: getFileIconMock }));

function TestFileIcon(props: { className?: string; size?: number }) {
    return <svg data-testid="resolved-file-icon" className={props.className} data-size={props.size} />;
}

beforeEach(() => {
    getFileIconMock.mockReset();
    getFileIconMock.mockReturnValue(TestFileIcon);
});

it("renders the repository file icon resolved from the basename", () => {
    const { container } = render(<FileCard filename="docs/README.md">content</FileCard>);
    expect(getFileIconMock).toHaveBeenCalledWith("README.md", false, false);
    expect(screen.getByTestId("resolved-file-icon").getAttribute("data-size")).toBe("16");
    expect(container.querySelector('[data-slot="file-card-file-badge"]')).toBeNull();
});

it("does not resolve or render an icon when showIcon is false", () => {
    render(<FileCard filename="docs/README.md" showIcon={false}>content</FileCard>);
    expect(getFileIconMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("resolved-file-icon")).toBeNull();
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/file-card.test.tsx
```

Expected: FAIL because `FileCard` renders the extension badge and never calls `getFileIcon`.

- [ ] **Step 3: Implement basename-based icon resolution**

Import `getFileIcon`, remove the extension calculation and badge, then render the resolved component:

```tsx
import { getFileIcon } from "@/app/fileexplorer/file-icon";

const basename = filename.split(/[\\/]/).pop() ?? filename;
const FileIcon = showIcon ? getFileIcon(basename, false, false) : null;

{FileIcon && <FileIcon data-slot="file-card-file-icon" size={16} className="shrink-0" />}
```

Preserve renamed-file text, statistics, collapse behavior, and `showIcon={false}`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/file-card.test.tsx frontend/app/agent/assistant-ui/diff-viewer.test.tsx
```

Expected: both files pass with zero failed tests.

- [ ] **Step 5: Format, verify, and commit**

Run:

```bash
npx prettier --write frontend/app/agent/assistant-ui/file-card.tsx frontend/app/agent/assistant-ui/file-card.test.tsx
git diff --check
git add frontend/app/agent/assistant-ui/file-card.tsx frontend/app/agent/assistant-ui/file-card.test.tsx
git commit -m "feat(agent): align diff file icons"
```

Expected: formatting and whitespace checks succeed, then one focused commit is created.

### Task 2: Implement the Magnified Shell and Header A

**Files:**
- Modify: `frontend/app/agent/rewind/diff-review-dialog.test.tsx`
- Modify: `frontend/app/agent/rewind/diff-review-dialog.tsx`
- Modify: `frontend/app/agent/agent-content.test.tsx`
- Modify: `frontend/app/agent/agent-content.tsx`

- [ ] **Step 1: Write failing shell and header tests**

Remove `description` from test props. Add these focused assertions:

```tsx
it("uses the borderless magnified shell while retaining internal separators", () => {
    renderDialog();
    const shell = document.querySelector('[data-slot="dialog-content"]');
    expect(shell?.className).toContain("border-0");
    expect(shell?.className).toContain("h-[calc(100vh-1rem)]");
    expect(shell?.className).toContain("sm:h-[94vh]");
    expect(shell?.className).toContain("sm:max-w-[96vw]");
    expect(document.querySelector('[data-slot="dialog-header"]')?.className).toContain("border-b");
    expect(document.querySelector('[data-slot="dialog-footer"]')?.className).toContain("border-t");
});

it("renders Header A with exact aggregate statistics", () => {
    renderDialog({
        title: "Review turn changes",
        files: [
            makeFile({ additions: 7, deletions: 2 }),
            makeFile({ path: "README.md", additions: 348, deletions: 0 }),
        ],
    });
    expect(screen.getByTestId("diff-review-header-icon")).not.toBeNull();
    expect(screen.getByText("2 files")).not.toBeNull();
    expect(screen.getByText("+355").className).toContain("text-success");
    expect(screen.getByText("-2").className).toContain("text-destructive");
    expect(screen.queryByText(/Red was removed|Green was added|Red will be removed|Green will be restored/i)).toBeNull();
});

it("uses singular grammar and keeps an unknown aggregate side unknown", () => {
    renderDialog({ files: [makeFile({ additions: null, deletions: 4 })] });
    expect(screen.getByText("1 file")).not.toBeNull();
    expect(screen.getAllByLabelText("Additions unavailable").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-4").length).toBeGreaterThan(0);
});

it("shows the loading summary instead of totals while files load", () => {
    renderDialog({ loading: true });
    expect(screen.getByText("Loading files…")).not.toBeNull();
    expect(screen.queryByText("1 file")).toBeNull();
});
```

In `agent-content.test.tsx`, stop rendering `props.description` in the dialog mock. Replace its three description assertions with `not.toHaveProperty("description")`, and verify the four removed color phrases are absent from the rendered preview.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/rewind/diff-review-dialog.test.tsx frontend/app/agent/agent-content.test.tsx
```

Expected: FAIL because old dimensions, border, description props, and header are still present.

- [ ] **Step 3: Implement aggregate statistics and Header A**

Remove `description` from `DiffReviewDialogProps`, arguments, and imports. Import `FileDiffIcon` and add independent totals:

```tsx
function aggregateStats(files: AgentRewindFileRowView[]): { additions: number | null; deletions: number | null } {
    return files.reduce(
        (total, file) => ({
            additions: total.additions == null || file.additions == null ? null : total.additions + file.additions,
            deletions: total.deletions == null || file.deletions == null ? null : total.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 } as { additions: number | null; deletions: number | null }
    );
}
```

Render this compact group before warnings and errors:

```tsx
<div className="flex items-center gap-3">
    <div
        data-testid="diff-review-header-icon"
        className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted/40 text-muted-foreground"
    >
        <FileDiffIcon className="size-4.5" />
    </div>
    <div className="min-w-0">
        <DialogTitle className="truncate text-base leading-tight">{title}</DialogTitle>
        {loading ? (
            <p className="mt-1 text-xs text-muted-foreground">Loading files…</p>
        ) : (
            <div className="mt-1 flex items-center gap-1.5 text-xs tabular-nums">
                <span className="text-muted-foreground">{files.length === 1 ? "1 file" : `${files.length} files`}</span>
                <Addition value={aggregate.additions} />
                <Deletion value={aggregate.deletions} />
            </div>
        )}
    </div>
</div>
```

Header `Addition` and `Deletion` render `+—` and `-—` with the corresponding unavailable aria-label when `null`.
Compute `const aggregate = aggregateStats(files)` before rendering the header.

- [ ] **Step 4: Apply the magnified shell and remove caller descriptions**

Use these classes only on `DiffReviewDialog` content, and set `aria-describedby={undefined}` because the approved dialog intentionally has no description element:

```tsx
aria-describedby={undefined}
className="grid h-[calc(100vh-1rem)] max-h-[calc(100vh-1rem)] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden border-0 p-0 shadow-2xl sm:h-[94vh] sm:max-h-[94vh] sm:w-[96vw] sm:max-w-[96vw]"
```

Retain the header/footer separators. Remove both `description={...}` props in `agent-content.tsx` without adding replacement copy.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run frontend/app/agent/rewind/diff-review-dialog.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/assistant-ui/file-card.test.tsx frontend/app/agent/assistant-ui/diff-viewer.test.tsx
```

Expected: all four files pass with zero failed tests.

- [ ] **Step 6: Format, typecheck, and commit**

Run:

```bash
npx prettier --write frontend/app/agent/rewind/diff-review-dialog.tsx frontend/app/agent/rewind/diff-review-dialog.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx
npx tsc --noEmit
git diff --check
git add frontend/app/agent/rewind/diff-review-dialog.tsx frontend/app/agent/rewind/diff-review-dialog.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx
git commit -m "feat(agent): polish diff review dialog"
```

Expected: tests, TypeScript, and whitespace checks pass before the commit is created.

### Task 3: Add the Code Review–Style Resizable File Pane

**Files:**
- Modify: `frontend/app/agent/rewind/diff-review-dialog.test.tsx`
- Modify: `frontend/app/agent/rewind/diff-review-dialog.tsx`

- [ ] **Step 1: Write the failing resize behavior test**

Use a deterministic body rectangle and verify every approved bound:

```tsx
it("resizes the desktop file pane within the Code Review bounds", () => {
    renderDialog();
    const body = screen.getByTestId("diff-review-body");
    let bodyWidth = 1000;
    vi.spyOn(body, "getBoundingClientRect").mockImplementation(() => ({
        left: 100,
        width: bodyWidth,
        right: 100 + bodyWidth,
        top: 0,
        bottom: 600,
        height: 600,
        x: 100,
        y: 0,
        toJSON: vi.fn(),
    }));
    const handle = screen.getByRole("separator", { name: "Resize file list" });

    fireEvent.mouseDown(handle);
    fireEvent.mouseMove(window, { clientX: 900 });
    expect(body.style.getPropertyValue("--diff-review-file-pane-width")).toBe("480px");
    fireEvent.mouseMove(window, { clientX: 0 });
    expect(body.style.getPropertyValue("--diff-review-file-pane-width")).toBe("160px");
    bodyWidth = 300;
    fireEvent.mouseMove(window, { clientX: 500 });
    expect(body.style.getPropertyValue("--diff-review-file-pane-width")).toBe("180px");
    fireEvent.mouseUp(window);
});
```

Also assert the handle has `hidden md:block`, while file rows retain `hover:bg-muted/40` and selected `bg-muted/40` classes.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/rewind/diff-review-dialog.test.tsx
```

Expected: FAIL because there is no resize CSS variable or accessible separator.

- [ ] **Step 3: Implement local resize state and drag lifecycle**

Add the Code Review bounds:

```tsx
const FilePaneDefaultWidth = 250;
const FilePaneMinWidth = 160;
const FilePaneMaxWidth = 480;
```

Create a focused handle that installs listeners only during dragging:

```tsx
function FilePaneResizeHandle({ onResize }: { onResize(clientX: number): void }) {
    const [dragging, setDragging] = useState(false);
    useEffect(() => {
        if (!dragging) return;
        const onMove = (event: MouseEvent) => onResize(event.clientX);
        const onUp = () => setDragging(false);
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, [dragging, onResize]);

    return (
        <div
            role="separator"
            aria-label="Resize file list"
            aria-orientation="vertical"
            onMouseDown={() => setDragging(true)}
            className="absolute right-0 top-0 hidden h-full w-1 cursor-col-resize bg-transparent hover:bg-fg-overlay-2 md:block"
        />
    );
}
```

Measure from the review body and clamp local state:

```tsx
const [filePaneWidth, setFilePaneWidth] = useState(FilePaneDefaultWidth);
const reviewBodyRef = useRef<HTMLDivElement>(null);
const resizeFilePane = useCallback((clientX: number) => {
    const rect = reviewBodyRef.current?.getBoundingClientRect();
    if (!rect) return;
    const maximum = Math.min(FilePaneMaxWidth, rect.width * 0.6);
    setFilePaneWidth(Math.max(FilePaneMinWidth, Math.min(clientX - rect.left, maximum)));
}, []);
```

Convert the body to `flex flex-col md:flex-row`. Set `--diff-review-file-pane-width` on it, use `w-full md:w-[var(--diff-review-file-pane-width)]` on the relative pane, and use `min-w-0 flex-1` for the diff. Keep the narrow layout stacked and the handle hidden below `md`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run frontend/app/agent/rewind/diff-review-dialog.test.tsx
```

Expected: the entire dialog test file passes, including resize and prior behavior.

- [ ] **Step 5: Run affected tests, typecheck, and commit**

Run:

```bash
npx prettier --write frontend/app/agent/rewind/diff-review-dialog.tsx frontend/app/agent/rewind/diff-review-dialog.test.tsx
npx vitest run frontend/app/agent/rewind/diff-review-dialog.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/assistant-ui/file-card.test.tsx frontend/app/agent/assistant-ui/diff-viewer.test.tsx
npx tsc --noEmit
git diff --check
git add frontend/app/agent/rewind/diff-review-dialog.tsx frontend/app/agent/rewind/diff-review-dialog.test.tsx
git commit -m "feat(agent): resize diff review file pane"
```

Expected: all affected tests, TypeScript, and whitespace checks pass before the commit.

### Task 4: Final Regression Verification and Review

**Files:**
- Verify: `frontend/app/agent/assistant-ui/file-card.tsx`
- Verify: `frontend/app/agent/rewind/diff-review-dialog.tsx`
- Verify: `frontend/app/agent/agent-content.tsx`

- [ ] **Step 1: Run the complete affected test set**

Run:

```bash
npx vitest run frontend/app/agent/rewind/diff-review-dialog.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/assistant-ui/file-card.test.tsx frontend/app/agent/assistant-ui/diff-viewer.test.tsx frontend/app/agent/rewind/turn-file-changes-card.test.tsx frontend/app/agent/assistant-ui/tools/file-tool-cards.test.tsx
```

Expected: all six files pass with zero failed tests.

- [ ] **Step 2: Run static verification**

Run:

```bash
npx prettier --check frontend/app/agent/assistant-ui/file-card.tsx frontend/app/agent/assistant-ui/file-card.test.tsx frontend/app/agent/rewind/diff-review-dialog.tsx frontend/app/agent/rewind/diff-review-dialog.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx
npx tsc --noEmit
git diff --check
git status --short
```

Expected: Prettier and TypeScript exit successfully, whitespace is clean, and no source or test changes remain uncommitted.

- [ ] **Step 3: Inspect every design requirement**

Confirm from code and tests:

```text
- only DiffReviewDialog overrides global dialog border and viewport sizing;
- Header A shows icon, caller title, file grammar, and exact or unavailable totals;
- no color-explanation description prop or copy remains;
- warnings and errors remain below the summary;
- file pane starts at 250px and clamps to 160px, 480px, and 60%;
- narrow layouts stay stacked and hide the resize handle;
- both file-list and diff-header icons call getFileIcon with the basename;
- Review, Undo, Redo, Revert, and conversation Redo keep existing actions and safety behavior.
```

Expected: each item is supported by the final diff and at least one focused test.
