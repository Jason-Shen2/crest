# Right Editor Trae-Style Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the right-side editor's visually awkward two-layer tab UI with a Trae-style top workspace bar and integrated editor file tabs.

**Architecture:** Keep the existing right tool state model and editor/LSP model unchanged. Refactor only the presentation layer: a shared `RightToolTopBar` owns panel-level tool navigation/actions, while `RightEditorWorkbench` owns editor file tabs and save/status affordances.

**Tech Stack:** React, TypeScript, Tailwind utility classes, Jotai-backed state, Vitest server-render tests.

---

## File Structure

- Modify `frontend/app/workspace/right-tool-panel.tsx`
  - Add `RightToolTopBar`.
  - Restyle `RightToolTabs` into Trae-style tool pills.
  - Remove the standalone `TOOLS` header row from regular and magnified panels.
  - Keep `RightToolLauncher`, `RightToolContent`, and focus behavior unchanged.
- Modify `frontend/app/workspace/right-tool-panel.test.tsx`
  - Cover top bar rendering, active tool state, close behavior, hide action, and magnified exit action.
- Modify `frontend/app/righteditor/right-editor-workbench.tsx`
  - Restyle file tabs into a Trae-style editor file bar.
  - Add `getRightEditorTabPathSuffix`.
  - Move save affordance out of the file tab row into the status/action area.
- Modify `frontend/app/righteditor/right-editor-workbench.test.tsx`
  - Cover path suffix helper, file tab rendering, dirty marker, close confirmation, and save reachability.

## Task 1: Add Right Tool Top Bar Tests

**Files:**
- Modify: `frontend/app/workspace/right-tool-panel.test.tsx`
- Modify later: `frontend/app/workspace/right-tool-panel.tsx`

- [ ] **Step 1: Write failing tests for the Trae-style top bar**

In `frontend/app/workspace/right-tool-panel.test.tsx`, update imports to include `RightToolTopBar`:

```tsx
import {
    RightToolContent,
    RightToolLauncher,
    RightToolPanel,
    RightToolPanelMagnifiedOverlay,
    RightToolPanelMagnifiedOverlayView,
    RightToolTabs,
    RightToolTopBar,
} from "./right-tool-panel";
```

Add these tests inside `describe("RightToolPanel parts", () => { ... })`:

```tsx
    it("renders a Trae-style top bar with active tool pills and panel actions", () => {
        const markup = renderToStaticMarkup(
            <RightToolTopBar
                activeTool="editor"
                openedTools={["editor", "browser"]}
                onOpenTool={() => null}
                onSelectTool={() => null}
                onCloseTool={() => null}
                action={
                    <button type="button" aria-label="Hide right tool panel">
                        Hide
                    </button>
                }
            />
        );

        expect(markup).toContain('aria-label="Right tool tabs"');
        expect(markup).toContain('aria-label="Select Editor"');
        expect(markup).toContain('aria-current="page"');
        expect(markup).toContain('aria-label="Close Editor"');
        expect(markup).toContain('aria-label="Open right tool"');
        expect(markup).toContain('aria-label="Hide right tool panel"');
    });

    it("keeps tool select and close actions wired through the top bar", () => {
        const onSelectTool = vi.fn();
        const onCloseTool = vi.fn();
        const topBar = RightToolTopBar({
            activeTool: "browser",
            openedTools: ["editor", "browser"],
            onOpenTool: () => null,
            onSelectTool,
            onCloseTool,
        });
        const selectEditor = findElementByAriaLabel(topBar, "Select Editor");
        const closeBrowser = findElementByAriaLabel(topBar, "Close Browser");

        selectEditor.props.onClick?.();
        closeBrowser.props.onClick?.();

        expect(onSelectTool).toHaveBeenCalledWith("editor");
        expect(onCloseTool).toHaveBeenCalledWith("browser");
    });
```

- [ ] **Step 2: Update panel render tests to expect the new hierarchy**

In `frontend/app/workspace/right-tool-panel.test.tsx`, change the first panel test to assert that the old visual header is gone while the panel action remains:

```tsx
    it("renders the launcher when no tools are open", () => {
        const markup = renderPanel(DefaultRightToolPanelState);

        expect(markup).toContain('aria-label="Right tool panel"');
        expect(markup).toContain("Choose a tool to get started");
        expect(markup).toContain("Editor");
        expect(markup).toContain("Browser");
        expect(markup).toContain("Terminal");
        expect(markup).toContain("Code Review");
        expect(markup).toContain("width:400px");
        expect(markup).toContain('aria-label="Hide right tool panel"');
        expect(markup).not.toContain(">TOOLS<");
    });
```

- [ ] **Step 3: Run focused tests and verify they fail**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH npm test -- --run frontend/app/workspace/right-tool-panel.test.tsx
```

Expected: fail because `RightToolTopBar` is not exported yet.

- [ ] **Step 4: Commit the failing tests**

```bash
git add frontend/app/workspace/right-tool-panel.test.tsx
git commit -m "test: cover right tool trae top bar"
```

## Task 2: Implement Right Tool Top Bar

**Files:**
- Modify: `frontend/app/workspace/right-tool-panel.tsx`
- Test: `frontend/app/workspace/right-tool-panel.test.tsx`

- [ ] **Step 1: Extend `RightToolTabsProps` and add `RightToolTopBarProps`**

In `frontend/app/workspace/right-tool-panel.tsx`, update the React type import:

```tsx
import type { CSSProperties, FocusEvent, ReactNode } from "react";
```

Replace the existing `RightToolTabsProps` type with:

```tsx
export type RightToolTabsProps = {
    activeTool?: RightToolId;
    openedTools: RightToolId[];
    onSelectTool: (tool: RightToolId) => void;
    onCloseTool: (tool: RightToolId) => void;
    className?: string;
};
```

Add this type after `RightToolTabsProps`:

```tsx
export type RightToolTopBarProps = RightToolTabsProps & {
    onOpenTool: (tool: RightToolId) => void;
    action?: ReactNode;
};
```

- [ ] **Step 2: Restyle `RightToolTabs` as tool pills**

Replace `RightToolTabs` in `frontend/app/workspace/right-tool-panel.tsx` with:

```tsx
export function RightToolTabs({ activeTool, openedTools, onSelectTool, onCloseTool, className }: RightToolTabsProps) {
    if (openedTools.length === 0) {
        return null;
    }
    return (
        <div aria-label="Right tool tabs" className={cn("flex min-w-0 items-center gap-2 overflow-x-auto", className)}>
            {openedTools.map((tool) => {
                const metadata = RightToolMetadataById[tool];
                const active = tool === activeTool;
                return (
                    <div
                        key={tool}
                        className={cn(
                            "flex min-w-[7rem] max-w-[10rem] items-center rounded-lg text-sm transition-colors",
                            active
                                ? "border border-border bg-hoverbg text-primary shadow-sm"
                                : "bg-black/10 text-secondary hover:bg-hoverbg hover:text-primary"
                        )}
                    >
                        <button
                            type="button"
                            aria-label={`Select ${metadata.label}`}
                            aria-current={active ? "page" : undefined}
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 truncate px-3 py-2 font-semibold"
                            onClick={() => onSelectTool(tool)}
                        >
                            <i className={cn("shrink-0 text-sm", metadata.icon)} />
                            <span className="truncate">{metadata.label}</span>
                        </button>
                        <button
                            type="button"
                            aria-label={`Close ${metadata.label}`}
                            className="cursor-pointer px-2 py-2 text-muted hover:text-primary"
                            onClick={() => onCloseTool(tool)}
                        >
                            <i className="fa-solid fa-xmark" />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
```

- [ ] **Step 3: Add `RightToolTopBar`**

Add this component after `RightToolTabs`:

```tsx
export function RightToolTopBar({
    activeTool,
    openedTools,
    onOpenTool,
    onSelectTool,
    onCloseTool,
    action,
}: RightToolTopBarProps) {
    return (
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-black/10 px-3 py-2">
            <RightToolTabs
                activeTool={activeTool}
                openedTools={openedTools}
                onSelectTool={onSelectTool}
                onCloseTool={onCloseTool}
                className="flex-1"
            />
            <button
                type="button"
                aria-label="Open right tool"
                className="cursor-pointer rounded-lg bg-black/10 px-3 py-2 text-secondary hover:bg-hoverbg hover:text-primary"
                onClick={() => onOpenTool("editor")}
            >
                <i className="fa-solid fa-plus" />
            </button>
            {action != null ? <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div> : null}
        </div>
    );
}
```

- [ ] **Step 4: Replace the normal panel header with `RightToolTopBar`**

In `RightToolPanel`, replace the header `<div className="flex shrink-0 items-center justify-between...">...</div>` and standalone `<RightToolTabs ... />` with:

```tsx
            <RightToolTopBar
                activeTool={state.activeTool}
                openedTools={state.openedTools}
                onOpenTool={onOpenTool}
                onSelectTool={onSelectTool}
                onCloseTool={onCloseTool}
                action={
                    <button
                        type="button"
                        aria-label="Hide right tool panel"
                        className="cursor-pointer rounded px-2 py-1 text-muted hover:bg-hoverbg hover:text-white"
                        onClick={onHide}
                    >
                        <i className="fa-solid fa-chevron-right" />
                    </button>
                }
            />
```

- [ ] **Step 5: Replace the magnified panel header with `RightToolTopBar`**

In `RightToolPanelMagnifiedOverlayView`, replace the header `<div className="flex shrink-0 items-center justify-between...">...</div>` and standalone `<RightToolTabs ... />` with:

```tsx
                <RightToolTopBar
                    activeTool={state.activeTool}
                    openedTools={state.openedTools}
                    onOpenTool={() => null}
                    onSelectTool={onSelectTool}
                    onCloseTool={onCloseTool}
                    action={
                        <button
                            type="button"
                            aria-label="Exit magnified right tool panel"
                            className="cursor-pointer rounded px-2 py-1 text-muted hover:bg-hoverbg hover:text-white"
                            onClick={onExit}
                        >
                            <i className="fa-solid fa-down-left-and-up-right-to-center" />
                        </button>
                    }
                />
```

- [ ] **Step 6: Run focused tests and verify they pass**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH npm test -- --run frontend/app/workspace/right-tool-panel.test.tsx
```

Expected: pass.

- [ ] **Step 7: Commit the implementation**

```bash
git add frontend/app/workspace/right-tool-panel.tsx frontend/app/workspace/right-tool-panel.test.tsx
git commit -m "feat: add trae style right tool top bar"
```

## Task 3: Add Editor File Bar Tests

**Files:**
- Modify: `frontend/app/righteditor/right-editor-workbench.test.tsx`
- Modify later: `frontend/app/righteditor/right-editor-workbench.tsx`

- [ ] **Step 1: Import the tab path suffix helper**

In `frontend/app/righteditor/right-editor-workbench.test.tsx`, update the import from `./right-editor-workbench`:

```tsx
import {
    acquireRightEditorLspForActiveFile,
    closeRightEditorFileWithConfirmation,
    getRightEditorTabPathSuffix,
    handleRightEditorKeyDown,
    RightEditorWorkbench,
    shouldStartRightEditorLsp,
} from "./right-editor-workbench";
```

- [ ] **Step 2: Add tests for path suffix behavior**

Add this describe block before `describe("RightEditorWorkbench", () => { ... })`:

```tsx
describe("getRightEditorTabPathSuffix", () => {
    it("returns the parent path relative to the workspace root", () => {
        expect(getRightEditorTabPathSuffix("/repo/src/app.ts", "/repo")).toBe("src");
        expect(getRightEditorTabPathSuffix("/repo/src/components/button.tsx", "/repo")).toBe("src/components");
    });

    it("falls back to the immediate parent when the workspace root does not match", () => {
        expect(getRightEditorTabPathSuffix("/other/src/app.ts", "/repo")).toBe("src");
    });

    it("returns an empty suffix for files at the root", () => {
        expect(getRightEditorTabPathSuffix("/repo/app.ts", "/repo")).toBe("");
    });
});
```

- [ ] **Step 3: Update file tab rendering test to expect Trae-style details**

Replace the existing `"renders open file tabs"` test with:

```tsx
    it("renders open file tabs with names, path suffixes, dirty markers, and save action", async () => {
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");
        model.updateText("/repo/src/app.ts", "const x = 2;");

        const markup = renderWithStore(<RightEditorWorkbench model={model} />);

        expect(markup).toContain('aria-label="Right editor file tabs"');
        expect(markup).toContain("app.ts");
        expect(markup).toContain("src");
        expect(markup).toContain("●");
        expect(markup).toContain('aria-label="Save app.ts"');
    });
```

- [ ] **Step 4: Run focused tests and verify they fail**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH npm test -- --run frontend/app/righteditor/right-editor-workbench.test.tsx
```

Expected: fail because `getRightEditorTabPathSuffix` and the new file tab `aria-label` are not implemented yet.

- [ ] **Step 5: Commit the failing tests**

```bash
git add frontend/app/righteditor/right-editor-workbench.test.tsx
git commit -m "test: cover right editor trae file bar"
```

## Task 4: Implement Editor File Bar

**Files:**
- Modify: `frontend/app/righteditor/right-editor-workbench.tsx`
- Test: `frontend/app/righteditor/right-editor-workbench.test.tsx`

- [ ] **Step 1: Add the path suffix helper**

In `frontend/app/righteditor/right-editor-workbench.tsx`, add this helper after `basename`:

```tsx
export function getRightEditorTabPathSuffix(path: string, workspaceRoot: string): string {
    const normalizedPath = path.replaceAll("\\", "/");
    const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
    const fileName = basename(normalizedPath);
    const parentPath = normalizedPath.slice(0, Math.max(0, normalizedPath.length - fileName.length)).replace(/\/+$/, "");
    if (!parentPath) return "";
    if (normalizedRoot && (parentPath === normalizedRoot || parentPath.startsWith(`${normalizedRoot}/`))) {
        return parentPath.slice(normalizedRoot.length).replace(/^\/+/, "");
    }
    const parentName = basename(parentPath);
    return parentName === fileName ? "" : parentName;
}
```

- [ ] **Step 2: Replace the editor file tab row markup**

In `RightEditorWorkbench`, replace the `<div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">...</div>` block with:

```tsx
            <div
                aria-label="Right editor file tabs"
                className="flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-black/30"
            >
                {state.openFiles.map((file) => {
                    const active = file.path === activeFile.path;
                    const name = basename(file.path);
                    const dirty = file.dirtyText != null;
                    const pathSuffix = getRightEditorTabPathSuffix(file.path, file.workspaceRoot);
                    return (
                        <div
                            key={file.path}
                            className={cn(
                                "flex min-w-[9rem] max-w-[16rem] items-center border-r border-border text-xs",
                                active ? "bg-black/20 text-primary" : "text-secondary hover:bg-hoverbg hover:text-primary"
                            )}
                        >
                            <button
                                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 truncate px-3 py-2 text-left"
                                onClick={() => model.selectFile(file.path)}
                            >
                                <span className={cn("shrink-0", dirty ? "text-primary" : "text-muted")}>
                                    {dirty ? "●" : <i className="fa-regular fa-file-code" />}
                                </span>
                                <span className="min-w-0 truncate font-semibold">{name}</span>
                                {pathSuffix ? <span className="min-w-0 truncate text-muted">{pathSuffix}</span> : null}
                            </button>
                            <button
                                type="button"
                                aria-label={`Close ${name}`}
                                className="cursor-pointer px-2 py-2 text-muted hover:text-primary"
                                onClick={() =>
                                    closeRightEditorFileWithConfirmation({
                                        file,
                                        name,
                                        closeFile: (path) => model.closeFile(path),
                                    })
                                }
                            >
                                <i className="fa-solid fa-xmark" />
                            </button>
                        </div>
                    );
                })}
            </div>
```

- [ ] **Step 3: Move save action to the status bar**

Replace the existing status bar block:

```tsx
            <div className="flex h-6 shrink-0 items-center justify-between border-t border-border px-2 text-[11px] text-secondary">
                <span className="truncate">{activeFile.path}</span>
                <span>{activeFile.saveStatus === "error" ? activeFile.error : activeFile.language}</span>
            </div>
```

with:

```tsx
            <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border px-2 text-[11px] text-secondary">
                <span className="min-w-0 flex-1 truncate">{activeFile.path}</span>
                <span className="shrink-0">{activeFile.saveStatus === "error" ? activeFile.error : activeFile.language}</span>
                <button
                    type="button"
                    aria-label={`Save ${displayName}`}
                    className="shrink-0 cursor-pointer rounded px-2 py-1 text-muted hover:bg-hoverbg hover:text-primary"
                    onClick={() => fireAndForget(() => model.saveFile(activeFile.path))}
                >
                    <i className="fa-solid fa-floppy-disk" />
                </button>
            </div>
```

- [ ] **Step 4: Remove the old save button from the file tab row**

Confirm `frontend/app/righteditor/right-editor-workbench.tsx` no longer contains this old row-level save button:

```tsx
                <button
                    type="button"
                    aria-label={`Save ${displayName}`}
                    className="ml-auto cursor-pointer rounded px-2 py-1 text-muted hover:bg-hoverbg hover:text-white"
                    onClick={() => fireAndForget(() => model.saveFile(activeFile.path))}
                >
                    <i className="fa-solid fa-floppy-disk" />
                </button>
```

- [ ] **Step 5: Run focused tests and verify they pass**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH npm test -- --run frontend/app/righteditor/right-editor-workbench.test.tsx
```

Expected: pass.

- [ ] **Step 6: Commit the implementation**

```bash
git add frontend/app/righteditor/right-editor-workbench.tsx frontend/app/righteditor/right-editor-workbench.test.tsx
git commit -m "feat: restyle right editor file tabs"
```

## Task 5: Integration Verification and Polish

**Files:**
- Modify if needed: `frontend/app/workspace/right-tool-panel.tsx`
- Modify if needed: `frontend/app/righteditor/right-editor-workbench.tsx`
- Test if needed: `frontend/app/workspace/right-tool-panel.test.tsx`
- Test if needed: `frontend/app/righteditor/right-editor-workbench.test.tsx`

- [ ] **Step 1: Run focused test suite**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH npm test -- --run frontend/app/workspace/right-tool-panel.test.tsx frontend/app/righteditor/right-editor-workbench.test.tsx
```

Expected: all focused tests pass.

- [ ] **Step 2: Run full unit test suite**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH npm test -- --run
```

Expected: all tests pass.

- [ ] **Step 3: Run development build**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH npm run build:dev
```

Expected: build completes successfully.

- [ ] **Step 4: Manual UI smoke test**

Start the app using the existing project workflow, then verify:

```text
1. Open the right editor from the file explorer.
2. Confirm the top bar shows Trae-style tool pills instead of the old TOOLS header.
3. Open two files and confirm only one editor file tab row appears.
4. Confirm file tabs show file name, truncated path suffix, close button, and dirty marker.
5. Confirm saving works from the status bar button and Cmd/Ctrl+S.
6. Confirm magnified mode uses the same top bar style.
```

- [ ] **Step 5: Commit final polish if any files changed**

If Step 1-4 required fixes:

```bash
git add frontend/app/workspace/right-tool-panel.tsx frontend/app/workspace/right-tool-panel.test.tsx frontend/app/righteditor/right-editor-workbench.tsx frontend/app/righteditor/right-editor-workbench.test.tsx
git commit -m "fix: polish right editor tabs integration"
```

If no files changed, do not create an empty commit.

## Self-Review

- Spec coverage: Task 2 implements the shared Trae-style top bar and removes the `TOOLS` visual header. Task 4 implements the integrated editor file bar, path suffixes, dirty marker, close button, and save relocation. Task 5 covers focused tests, full tests, build, and manual inspection.
- Completeness scan: The plan contains no unresolved fill-ins or unspecified implementation steps.
- Type consistency: `RightToolTopBar`, `RightToolTabsProps`, `RightToolTopBarProps`, and `getRightEditorTabPathSuffix` are defined before use and referenced consistently.
