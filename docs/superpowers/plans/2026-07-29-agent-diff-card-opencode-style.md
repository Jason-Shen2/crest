# Agent Diff Card OpenCode-Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Agent conversation diff body's handcrafted renderer with OpenCode's pinned Pierre renderer while preserving crest's header and adding the approved double-chevron collapse control.

**Architecture:** `DiffViewer` keeps its public props and outer variant styling. A focused `DiffViewerFile` component combines crest's existing header with Radix `Collapsible`; patch strings are converted to Pierre `FileDiffMetadata`, while full old/new files use `MultiFileDiff`. Pierre receives the same behavioral options, dimensions, indicator mode, and background blending as the pinned OpenCode source.

**Tech Stack:** React 19, TypeScript, Radix Collapsible, Tailwind v4, lucide-react, `@pierre/diffs@1.2.10`, Vitest, Testing Library.

---

### Task 1: Pin the OpenCode diff renderer

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the exact renderer version**

Run:

```bash
npm install --save-exact @pierre/diffs@1.2.10
```

Expected: `package.json` contains `"@pierre/diffs": "1.2.10"` and the lockfile resolves version `1.2.10`.

- [ ] **Step 2: Verify the installed public API**

Run:

```bash
node -e 'import("@pierre/diffs").then((m) => console.log(typeof m.parsePatchFiles))'
node -e 'import("@pierre/diffs/react").then((m) => console.log(typeof m.FileDiff, typeof m.MultiFileDiff))'
```

Expected:

```text
function
function function
```

- [ ] **Step 3: Commit the dependency pin**

```bash
git add package.json package-lock.json
git commit -m "build: pin Pierre diff renderer"
```

### Task 2: Specify collapse and renderer behavior with failing tests

**Files:**
- Create: `frontend/app/agent/assistant-ui/diff-viewer.test.tsx`

- [ ] **Step 1: Add module spies and the representative patch fixture**

Create a jsdom Vitest test that mocks only Pierre's rendering boundary while exercising crest's real parsing and UI:

```tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const pierreMocks = vi.hoisted(() => ({
    fileDiff: vi.fn((props: any) => <div data-testid="pierre-file-diff" data-name={props.fileDiff.name} />),
    multiFileDiff: vi.fn(() => <div data-testid="pierre-multi-file-diff" />),
}));

vi.mock("@pierre/diffs/react", () => ({
    FileDiff: pierreMocks.fileDiff,
    MultiFileDiff: pierreMocks.multiFileDiff,
}));

import { DiffViewer } from "./diff-viewer";

const Patch = [
    "diff --git a/frontend/app.tsx b/frontend/app.tsx",
    "--- a/frontend/app.tsx",
    "+++ b/frontend/app.tsx",
    "@@ -1 +1 @@",
    "-old line",
    "+new line",
].join("\n");

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});
```

- [ ] **Step 2: Add collapse and icon assertions**

```tsx
it("starts expanded and toggles the diff body from the full header button", () => {
    render(<DiffViewer patch={Patch} />);

    const header = screen.getByRole("button", { name: /frontend\/app\.tsx/i });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("pierre-file-diff")).toBeVisible();
    expect(header.querySelector('[data-slot="diff-viewer-collapse-icon"]')).not.toBeNull();

    fireEvent.click(header);

    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("pierre-file-diff")).toBeNull();
});
```

- [ ] **Step 3: Add OpenCode option assertions**

```tsx
it("passes the pinned OpenCode rendering options and dimensions to Pierre", () => {
    render(<DiffViewer patch={Patch} viewMode="unified" />);

    expect(pierreMocks.fileDiff).toHaveBeenCalledWith(
        expect.objectContaining({
            options: expect.objectContaining({
                diffStyle: "unified",
                diffIndicators: "bars",
                overflow: "wrap",
                disableLineNumbers: false,
                disableBackground: false,
                disableFileHeader: true,
                lineHoverHighlight: "both",
                expansionLineCount: 20,
                hunkSeparators: "line-info-basic",
                lineDiffType: "none",
                maxLineDiffLength: 1000,
                tokenizeMaxLineLength: 1000,
                unsafeCSS: expect.stringContaining("--diffs-bg-deletion-override"),
            }),
            style: expect.objectContaining({
                "--diffs-line-height": "24px",
                "--diffs-min-number-column-width": "4ch",
            }),
        }),
        undefined
    );
});
```

- [ ] **Step 4: Add multi-file and full-file assertions**

Verify that a two-file patch creates two independently collapsible cards and that `oldFile`/`newFile` call `MultiFileDiff` with Pierre's `{ name, contents }` shape.

- [ ] **Step 5: Run the focused test and verify RED**

Run:

```bash
npx vitest run --dir frontend frontend/app/agent/assistant-ui/diff-viewer.test.tsx
```

Expected: FAIL because the current component does not render the double-chevron button or Pierre components.

### Task 3: Implement the OpenCode-style collapsible card

**Files:**
- Modify: `frontend/app/agent/assistant-ui/diff-viewer.tsx`

- [ ] **Step 1: Replace handcrafted diff parsing and line rendering imports**

Use named imports and keep cross-directory aliases:

```tsx
import { parsePatchFiles, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { FileDiff, MultiFileDiff } from "@pierre/diffs/react";
import { ChevronsUpDownIcon } from "lucide-react";
import { useMemo, useState, type CSSProperties, type FC } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shadcn/ui/collapsible";
import { cn } from "@/util/util";
```

- [ ] **Step 2: Define the OpenCode renderer options and dimensions**

Use the pinned source values, with crest theme tokens substituted only for OpenCode token names:

```tsx
const PierreUnsafeCss = `
:host {
    --diffs-bg: var(--color-code-bg);
}
[data-diff] {
    --diffs-bg-deletion-override: light-dark(
        color-mix(in lab, var(--diffs-bg) 33.333%, var(--diffs-deletion-base)),
        color-mix(in lab, var(--diffs-bg) 60%, var(--diffs-deletion-base))
    );
    --diffs-bg-addition-override: light-dark(
        color-mix(in lab, var(--diffs-bg) 33.333%, var(--diffs-addition-base)),
        color-mix(in lab, var(--diffs-bg) 60%, var(--diffs-addition-base))
    );
}
[data-diff-header],
[data-diff] {
    [data-separator] { height: 24px; }
    [data-column-number] {
        background-color: var(--diffs-bg);
        cursor: default !important;
    }
    [data-code] {
        overflow-x: auto !important;
        overflow-y: clip !important;
    }
}
`;

const PierreStyle = {
    "--diffs-font-family": "var(--font-mono)",
    "--diffs-font-size": "inherit",
    "--diffs-line-height": "24px",
    "--diffs-tab-size": 2,
    "--diffs-gap-block": 0,
    "--diffs-min-number-column-width": "4ch",
} as CSSProperties;
```

Create `makePierreOptions(viewMode, showLineNumbers)` returning:

```tsx
{
    themeType: "system",
    disableLineNumbers: !showLineNumbers,
    overflow: "wrap",
    diffStyle: viewMode,
    diffIndicators: "bars",
    lineHoverHighlight: "both",
    disableBackground: false,
    expansionLineCount: 20,
    hunkSeparators: "line-info-basic",
    lineDiffType: viewMode === "split" ? "word-alt" : "none",
    maxLineDiffLength: 1000,
    tokenizeMaxLineLength: 1000,
    disableFileHeader: true,
    unsafeCSS: PierreUnsafeCss,
} satisfies FileDiffOptions<undefined>;
```

- [ ] **Step 3: Convert the crest header into the single collapse trigger**

Render the existing badge, path, and stats inside `CollapsibleTrigger asChild` with:

```tsx
<button
    type="button"
    data-slot="diff-viewer-header"
    aria-expanded={open}
    className="bg-[var(--color-code-header-bg)] text-muted-foreground flex w-full cursor-pointer items-center gap-2 border-b border-border/50 px-3.5 py-1.5 text-left text-xs"
>
    {/* existing badge, path, and stats */}
    <ChevronsUpDownIcon data-slot="diff-viewer-collapse-icon" className="size-4 shrink-0 opacity-60" />
</button>
```

Each `DiffViewerFile` owns `useState(true)`, and `CollapsibleContent` unmounts the Pierre body when closed.

- [ ] **Step 4: Render patch and full-file inputs**

Flatten `parsePatchFiles(diffPatch).flatMap((parsedPatch) => parsedPatch.files)`. For each patch file, pass its `FileDiffMetadata` to `FileDiff`; calculate header counts with:

```tsx
const additions = fileDiff.hunks.reduce((total, hunk) => total + hunk.additionLines, 0);
const deletions = fileDiff.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0);
```

For full-file input, compute header statistics with `diffLines` while passing:

```tsx
oldFile={{ name: oldFile.name ?? "old-file", contents: oldFile.content }}
newFile={{ name: newFile.name ?? oldFile.name ?? "new-file", contents: newFile.content }}
```

to `MultiFileDiff`, while retaining the existing no-content fallback and public props.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run --dir frontend frontend/app/agent/assistant-ui/diff-viewer.test.tsx
```

Expected: all diff-viewer tests PASS.

- [ ] **Step 6: Refactor only after GREEN**

Remove the obsolete `parse-diff`/`diff` helpers and handcrafted line components. Keep `DiffViewer`, `DiffViewerFileBadge`, `DiffViewerStats`, and the public prop shape focused in one file.

- [ ] **Step 7: Commit component and tests**

```bash
git add frontend/app/agent/assistant-ui/diff-viewer.tsx frontend/app/agent/assistant-ui/diff-viewer.test.tsx
git commit -m "feat: match OpenCode agent diff cards"
```

### Task 4: Verify integration, types, and browser behavior

**Files:**
- Test: `frontend/app/agent/assistant-ui/thread.integration.test.tsx`

- [ ] **Step 1: Run focused component and Agent integration tests**

Run:

```bash
npx vitest run --dir frontend \
  frontend/app/agent/assistant-ui/diff-viewer.test.tsx \
  frontend/app/agent/assistant-ui/thread.integration.test.tsx
```

Expected: both test files PASS with zero failed tests.

- [ ] **Step 2: Run TypeScript validation**

Run:

```bash
npx tsc --noEmit --pretty false
```

Expected: exit code 0, or only documented pre-existing errors outside the modified files. No errors may originate from `diff-viewer.tsx` or its test.

- [ ] **Step 3: Inspect the localhost card**

Open the current Agent diff example at `http://localhost:57086/` and verify:

- crest header visual design is unchanged;
- the supplied double-chevron icon sits at the right edge;
- clicking anywhere on the header collapses and expands only that file's body;
- deletion gutter uses the repeating orange/red bar;
- addition gutter uses the solid green bar;
- line height is 24px, line numbers use at least 4ch, and long lines wrap;
- no Pierre file header appears.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git diff --check
git diff -- package.json package-lock.json frontend/app/agent/assistant-ui/diff-viewer.tsx frontend/app/agent/assistant-ui/diff-viewer.test.tsx
```

Expected: no whitespace errors and no unrelated files in the implementation diff.
