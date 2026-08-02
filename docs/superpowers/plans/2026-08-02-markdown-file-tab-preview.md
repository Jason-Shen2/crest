# Markdown File Tab Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workspace `.md` file tabs open in Markdown preview by default while preserving in-tab Preview/Edit switching, the existing Monaco buffer, and all file lifecycle behavior.

**Architecture:** Keep `WorkspaceFileRuntime` as the only file and buffer owner. Add a small Markdown preview surface that renders `runtime.value`, then let `FileTopTab` switch between that surface and the existing `CodeEditor`; no tab, RPC, persistence, or registry interfaces change.

**Tech Stack:** React 19, TypeScript, Jotai-compatible existing runtime state, Monaco, the existing Crest `Markdown` renderer, Tailwind v4, Vitest, Testing Library

**Design:** `docs/superpowers/specs/2026-08-02-markdown-file-tab-preview-design.md`

---

## File structure

- Modify `frontend/util/local-path.ts`: add one pure parent-directory helper for normalized local file paths.
- Modify `frontend/util/local-path.test.ts`: cover POSIX, Windows drive, UNC, and basename-only parent paths.
- Create `frontend/app/workspace/markdown-file-preview.tsx`: adapt file path and text into the existing `Markdown` component.
- Create `frontend/app/workspace/markdown-file-preview.test.tsx`: verify text updates and relative-asset resolution inputs.
- Modify `frontend/app/workspace/file-top-tab.tsx`: own the Preview/Edit mode and preserve the current editor lifecycle.
- Modify `frontend/app/workspace/file-top-tab.test.tsx`: verify default preview, switching, live buffer use, extension transitions, and non-Markdown regressions.

### Task 1: Add local parent-path calculation

**Files:**
- Modify: `frontend/util/local-path.test.ts:4-21`
- Modify: `frontend/util/local-path.ts:18-22`

- [ ] **Step 1: Write the failing parent-path test**

Update the import and add the parameterized test to `frontend/util/local-path.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getParentLocalPath, isAbsoluteLocalPath, joinLocalPath } from "./local-path";

describe("local path contracts", () => {
    it.each(["/repo/a.ts", "C:\\repo\\a.ts", "\\\\server\\share\\a.ts"])("accepts absolute local path %s", (path) =>
        expect(isAbsoluteLocalPath(path)).toBe(true)
    );

    it.each(["", "repo/a.ts", "C:repo\\a.ts", "\\\\server", "file:///repo/a.ts", "\0/repo"])(
        "rejects invalid local path %s",
        (path) => expect(isAbsoluteLocalPath(path)).toBe(false)
    );

    it("joins POSIX roots and UNC shares without changing root meaning", () => {
        expect(joinLocalPath("/", "name")).toBe("/name");
        expect(joinLocalPath("\\\\server\\share", "name")).toBe("//server/share/name");
    });

    it.each([
        ["/repo/docs/README.md", "/repo/docs"],
        ["/README.md", "/"],
        ["C:/README.md", "C:/"],
        ["C:\\repo\\README.md", "C:/repo"],
        ["//server/share/README.md", "//server/share"],
        ["README.md", "."],
    ])("gets the parent of %s", (path, expected) => {
        expect(getParentLocalPath(path)).toBe(expected);
    });
});
```

- [ ] **Step 2: Run the path test and verify RED**

Run:

```bash
npx vitest run frontend/util/local-path.test.ts
```

Expected: FAIL because `getParentLocalPath` is not exported by `local-path.ts`.

- [ ] **Step 3: Implement the minimal path helper**

Append this function to `frontend/util/local-path.ts`:

```ts
export function getParentLocalPath(value: string): string {
    const path = value.replace(/\\/g, "/");
    const lastSeparator = path.lastIndexOf("/");
    if (lastSeparator < 0) {
        return ".";
    }
    if (lastSeparator === 0) {
        return "/";
    }
    const prefix = path.slice(0, lastSeparator + 1);
    if (/^[A-Za-z]:\/$/.test(prefix)) {
        return prefix;
    }
    return path.slice(0, lastSeparator);
}
```

- [ ] **Step 4: Run the path test and verify GREEN**

Run:

```bash
npx vitest run frontend/util/local-path.test.ts
```

Expected: all `local path contracts` tests PASS.

- [ ] **Step 5: Commit the path helper**

```bash
git add frontend/util/local-path.ts frontend/util/local-path.test.ts
git commit -m "feat: add local parent path helper"
```

### Task 2: Add the workspace Markdown preview adapter

**Files:**
- Create: `frontend/app/workspace/markdown-file-preview.test.tsx`
- Create: `frontend/app/workspace/markdown-file-preview.tsx`

- [ ] **Step 1: Write the failing preview-adapter test**

Create `frontend/app/workspace/markdown-file-preview.test.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownFilePreview } from "./markdown-file-preview";

const markdownProps = vi.hoisted(() => ({ current: null as any }));

vi.mock("@/app/element/markdown", () => ({
    Markdown: (props: any) => {
        markdownProps.current = props;
        return <div>Rendered Markdown</div>;
    },
}));

afterEach(() => {
    cleanup();
    markdownProps.current = null;
});

describe("MarkdownFilePreview", () => {
    it("renders current text and resolves relative assets from the file directory", () => {
        const view = render(<MarkdownFilePreview path="/repo/docs/README.md" text="# First" />);

        expect(screen.getByText("Rendered Markdown")).toBeTruthy();
        expect(markdownProps.current.text).toBe("# First");
        expect(markdownProps.current.resolveOpts).toEqual({ connName: "local", baseDir: "/repo/docs" });

        view.rerender(<MarkdownFilePreview path="/repo/docs/README.md" text="# Edited" />);
        expect(markdownProps.current.text).toBe("# Edited");
    });

    it("updates the resolution base when the file path changes", () => {
        const view = render(<MarkdownFilePreview path="C:/docs/README.md" text="![asset](asset.png)" />);

        expect(markdownProps.current.resolveOpts).toEqual({ connName: "local", baseDir: "C:/docs" });

        view.rerender(<MarkdownFilePreview path="//server/share/README.md" text="![asset](asset.png)" />);
        expect(markdownProps.current.resolveOpts).toEqual({
            connName: "local",
            baseDir: "//server/share",
        });
    });
});
```

- [ ] **Step 2: Run the adapter test and verify RED**

Run:

```bash
npx vitest run frontend/app/workspace/markdown-file-preview.test.tsx
```

Expected: FAIL because `./markdown-file-preview` does not exist.

- [ ] **Step 3: Implement the preview adapter**

Create `frontend/app/workspace/markdown-file-preview.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Markdown } from "@/app/element/markdown";
import { getParentLocalPath } from "@/util/local-path";
import { useMemo } from "react";

export interface MarkdownFilePreviewProps {
    path: string;
    text: string;
}

export function MarkdownFilePreview({ path, text }: MarkdownFilePreviewProps) {
    const resolveOpts = useMemo<MarkdownResolveOpts>(
        () => ({ connName: "local", baseDir: getParentLocalPath(path) }),
        [path]
    );

    return (
        <div className="h-full min-h-0 overflow-hidden">
            <Markdown text={text} resolveOpts={resolveOpts} contentClassName="px-6 py-5" />
        </div>
    );
}
```

- [ ] **Step 4: Run the adapter and path tests and verify GREEN**

Run:

```bash
npx vitest run frontend/app/workspace/markdown-file-preview.test.tsx frontend/util/local-path.test.ts
```

Expected: both suites PASS, with no unhandled errors.

- [ ] **Step 5: Commit the preview adapter**

```bash
git add frontend/app/workspace/markdown-file-preview.tsx frontend/app/workspace/markdown-file-preview.test.tsx
git commit -m "feat: add workspace markdown preview surface"
```

### Task 3: Add Preview/Edit switching to file tabs

**Files:**
- Modify: `frontend/app/workspace/file-top-tab.test.tsx:5-138`
- Modify: `frontend/app/workspace/file-top-tab.tsx:4-92`

- [ ] **Step 1: Add a mock and runtime helper for the switching tests**

In `frontend/app/workspace/file-top-tab.test.tsx`, keep the existing `CodeEditor` mock and add the following block after it:

```tsx
const markdownPreviewProps = vi.hoisted(() => ({ current: null as any }));

vi.mock("./markdown-file-preview", () => ({
    MarkdownFilePreview: (props: any) => {
        markdownPreviewProps.current = props;
        return <div data-testid="markdown-file-preview">Markdown file preview</div>;
    },
}));

function makeControlledRuntime(path: string, value: string) {
    const listeners = new Set<() => void>();
    let snapshot = { dirty: false, title: path.split("/").at(-1), status: "ready", operation: "idle" };
    const emit = () => listeners.forEach((listener) => listener());
    const runtime = {
        id: "file-markdown",
        path,
        value,
        readonly: false,
        model: { id: "markdown-model" },
        viewState: undefined,
        get language() {
            return this.path.toLowerCase().endsWith(".md") ? "markdown" : "typescript";
        },
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setValue: vi.fn((nextValue: string) => {
            runtime.value = nextValue;
            snapshot = { ...snapshot, dirty: true };
            emit();
        }),
        attach: vi.fn(),
        detach: vi.fn(),
    } as any;
    return { runtime, emit };
}
```

Extend the existing `afterEach` so captured preview props do not leak between tests:

```tsx
afterEach(() => {
    cleanup();
    markdownPreviewProps.current = null;
});
```

- [ ] **Step 2: Write the failing default-preview and live-buffer test**

Add this test inside `describe("FileTopTab", ...)`:

```tsx
it("opens Markdown in preview and switches views over the same live buffer", () => {
    const { runtime } = makeControlledRuntime("/repo/docs/README.md", "# Draft");

    render(<FileTopTab runtime={runtime} />);

    expect(screen.getByTestId("markdown-file-preview")).toBeTruthy();
    expect(screen.queryByText("Monaco file editor")).toBeNull();
    expect(markdownPreviewProps.current).toMatchObject({ path: "/repo/docs/README.md", text: "# Draft" });

    screen.getByRole("button", { name: "Edit" }).click();
    expect(screen.getByText("Monaco file editor")).toBeTruthy();
    expect(screen.queryByTestId("markdown-file-preview")).toBeNull();

    act(() => editorProps.current.onChange("# Edited"));
    screen.getByRole("button", { name: "Preview" }).click();

    expect(screen.getByTestId("markdown-file-preview")).toBeTruthy();
    expect(markdownPreviewProps.current.text).toBe("# Edited");
    expect(runtime.setValue).toHaveBeenCalledWith("# Edited");
});
```

- [ ] **Step 3: Write the failing extension-transition test**

Add this async test in the same describe block:

```tsx
it("uses editor for non-Markdown paths and resets to preview when a path becomes Markdown", async () => {
    const { runtime, emit } = makeControlledRuntime("/repo/README.md", "# Draft");
    render(<FileTopTab runtime={runtime} />);

    screen.getByRole("button", { name: "Edit" }).click();
    act(() => {
        runtime.path = "/repo/README.ts";
        emit();
    });

    expect(screen.getByText("Monaco file editor")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();

    act(() => {
        runtime.path = "/repo/README.MD";
        emit();
    });

    expect(await screen.findByTestId("markdown-file-preview")).toBeTruthy();
    expect(screen.queryByText("Monaco file editor")).toBeNull();
});
```

- [ ] **Step 4: Run the file-tab test and verify RED**

Run:

```bash
npx vitest run frontend/app/workspace/file-top-tab.test.tsx
```

Expected: the new tests FAIL because Markdown files still render only `CodeEditor` and no Preview/Edit buttons exist. Existing tests should remain green.

- [ ] **Step 5: Implement the mode switch without changing editor lifecycle**

Replace `frontend/app/workspace/file-top-tab.tsx` with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { cn } from "@/util/util";
import type * as monaco from "monaco-editor";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MarkdownFilePreview } from "./markdown-file-preview";
import type { WorkspaceFileRuntime } from "./workspace-editor-registry";

type FileViewMode = "preview" | "edit";

export function FileTopTab({
    runtime,
    onClose,
    onLocate,
}: {
    runtime: WorkspaceFileRuntime;
    onClose?: () => void;
    onLocate?: () => void;
}) {
    const snapshot = useSyncExternalStore(
        (listener) => runtime.subscribe(listener),
        () => runtime.getSnapshot(),
        () => runtime.getSnapshot()
    );
    const isMarkdown = runtime.language === "markdown";
    const [viewMode, setViewMode] = useState<FileViewMode>(isMarkdown ? "preview" : "edit");
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor>(null);
    const attachedModelRef = useRef<monaco.editor.ITextModel>(runtime.model);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor || attachedModelRef.current === runtime.model) {
            return;
        }
        runtime.detach(editor);
        if (runtime.viewState) {
            editor.restoreViewState(runtime.viewState);
        }
        runtime.attach(editor);
        attachedModelRef.current = runtime.model;
    }, [runtime, runtime.model]);

    useEffect(() => {
        setViewMode(isMarkdown ? "preview" : "edit");
    }, [isMarkdown]);

    if (snapshot.status === "error" && snapshot.operation !== "save") {
        return (
            <div className="flex h-full items-center justify-center p-6" role="alert">
                <div className="flex max-w-lg flex-col gap-3">
                    <div className="font-medium">Unable to open {snapshot.title}</div>
                    <div className="text-secondary">{snapshot.error}</div>
                    <div className="flex gap-2">
                        <button
                            className="cursor-pointer rounded bg-accent/80 px-3 py-1 text-primary"
                            onClick={() => void runtime.reload()}
                            type="button"
                        >
                            Retry
                        </button>
                        {onClose ? (
                            <button className="cursor-pointer rounded px-3 py-1" onClick={onClose} type="button">
                                Close
                            </button>
                        ) : null}
                        {onLocate ? (
                            <button className="cursor-pointer rounded px-3 py-1" onClick={onLocate} type="button">
                                Locate
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>
        );
    }

    const editor = (
        <CodeEditor
            blockId={`workspace-file:${runtime.id}`}
            fileName={runtime.path}
            language={runtime.language}
            model={runtime.model}
            onChange={(value) => runtime.setValue(value)}
            onMount={(mountedEditor) => {
                editorRef.current = mountedEditor;
                attachedModelRef.current = runtime.model;
                if (runtime.viewState) {
                    mountedEditor.restoreViewState(runtime.viewState);
                }
                runtime.attach(mountedEditor);
                return () => {
                    runtime.detach(mountedEditor);
                    editorRef.current = null;
                };
            }}
            readonly={runtime.readonly}
            text={runtime.value}
        />
    );

    if (!isMarkdown) {
        return editor;
    }

    const pathSegments = runtime.path.split("/").filter(Boolean);
    const breadcrumb = pathSegments.slice(-2).join(" / ");
    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
                <div className="min-w-0 truncate text-xs text-muted-foreground" title={runtime.path}>
                    {breadcrumb}
                </div>
                <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Markdown view mode">
                    <button
                        aria-pressed={viewMode === "preview"}
                        className={cn(
                            "cursor-pointer rounded px-2 py-1 text-xs transition-colors",
                            viewMode === "preview"
                                ? "bg-fg-overlay-2 text-foreground"
                                : "text-muted-foreground hover:bg-fg-overlay-1 hover:text-foreground"
                        )}
                        onClick={() => setViewMode("preview")}
                        type="button"
                    >
                        Preview
                    </button>
                    <button
                        aria-pressed={viewMode === "edit"}
                        className={cn(
                            "cursor-pointer rounded px-2 py-1 text-xs transition-colors",
                            viewMode === "edit"
                                ? "bg-fg-overlay-2 text-foreground"
                                : "text-muted-foreground hover:bg-fg-overlay-1 hover:text-foreground"
                        )}
                        onClick={() => setViewMode("edit")}
                        type="button"
                    >
                        Edit
                    </button>
                </div>
            </div>
            <div className="min-h-0 flex-1">
                {viewMode === "preview" ? (
                    <MarkdownFilePreview path={runtime.path} text={runtime.value} />
                ) : (
                    editor
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 6: Run the file-tab tests and verify GREEN**

Run:

```bash
npx vitest run frontend/app/workspace/file-top-tab.test.tsx
```

Expected: all existing and new `FileTopTab` tests PASS. The read-error test still exposes Retry, Close, and Locate; the existing Monaco attach/model-migration tests remain unchanged.

- [ ] **Step 7: Commit the file-tab integration**

```bash
git add frontend/app/workspace/file-top-tab.tsx frontend/app/workspace/file-top-tab.test.tsx
git commit -m "feat: preview markdown workspace files"
```

### Task 4: Verify the complete feature

**Files:**
- Verify: `frontend/util/local-path.ts`
- Verify: `frontend/util/local-path.test.ts`
- Verify: `frontend/app/workspace/markdown-file-preview.tsx`
- Verify: `frontend/app/workspace/markdown-file-preview.test.tsx`
- Verify: `frontend/app/workspace/file-top-tab.tsx`
- Verify: `frontend/app/workspace/file-top-tab.test.tsx`
- Regression: `frontend/app/workspace/workspace-file-content-slot.test.tsx`
- Regression: `frontend/app/workspace/top-tab-content-deck.test.tsx`
- Regression: `frontend/app/workspace/workspace-editor-registry.test.ts`

- [ ] **Step 1: Run all focused and adjacent suites together**

Run:

```bash
npx vitest run frontend/util/local-path.test.ts frontend/app/workspace/markdown-file-preview.test.tsx frontend/app/workspace/file-top-tab.test.tsx frontend/app/workspace/workspace-file-content-slot.test.tsx frontend/app/workspace/top-tab-content-deck.test.tsx frontend/app/workspace/workspace-editor-registry.test.ts
```

Expected: all suites PASS with no warnings, unhandled rejections, or React `act(...)` messages.

- [ ] **Step 2: Check formatting**

Run:

```bash
npx prettier --check frontend/util/local-path.ts frontend/util/local-path.test.ts frontend/app/workspace/markdown-file-preview.tsx frontend/app/workspace/markdown-file-preview.test.tsx frontend/app/workspace/file-top-tab.tsx frontend/app/workspace/file-top-tab.test.tsx
```

Expected: all six files pass Prettier. If the check reports differences, run the same command with `--write`, inspect the diff, and rerun all Task 4 Step 1 tests.

- [ ] **Step 3: Check the final diff**

Run:

```bash
git diff --check
git status --short
git diff -- frontend/util/local-path.ts frontend/util/local-path.test.ts frontend/app/workspace/markdown-file-preview.tsx frontend/app/workspace/markdown-file-preview.test.tsx frontend/app/workspace/file-top-tab.tsx frontend/app/workspace/file-top-tab.test.tsx
```

Expected: no whitespace errors. The scoped diff contains only the parent-path helper, Markdown adapter, mode switch, and their tests; unrelated dirty-worktree files remain untouched.

- [ ] **Step 4: Perform a manual application check**

Run the existing development app command:

```bash
npm run dev
```

Expected behavior:

1. Open a local `README.md` from the file explorer; Preview is selected and rendered Markdown is visible.
2. Click Edit, type without saving, then click Preview; the new text is rendered.
3. Select Edit, switch to another top tab, then return; Edit remains selected for the mounted file tab.
4. Click Preview and then Edit again; the Monaco cursor and scroll state restore.
5. Open a non-Markdown file; it opens directly in Monaco with no mode toolbar.
6. Open a Markdown file containing `![asset](./asset.png)`; the image resolves relative to the Markdown file directory.

Stop the development process after the manual check. Do not change Go code, generated files, tab persistence, or the independent preview view.
