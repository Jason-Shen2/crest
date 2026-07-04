# File Tree Editor Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a file in the left file explorer opens or activates a main-area `codeeditor` tab instead of opening the right editor panel.

**Architecture:** Reuse the existing single-file `codeeditor` view for rendering and editing. Add a backend workspace service for creating a tab with a single initial block so new editor tabs do not inherit the default terminal block. Add a small frontend helper that dedupes by `block.meta.file`, then switches to the existing tab or creates the editor tab.

**Tech Stack:** React, TypeScript, Jotai, Wave services, WOS objects, Go workspace service, Monaco through existing `CodeEditor` and `FileEditorViewModel`.

---

## File Structure

- Modify `pkg/wcore/workspace.go`
  - Add a reusable tab name/meta helper.
  - Add `CreateTabWithBlock()` for one-block initial tab creation.
  - Keep existing `CreateTab()` behavior for normal new terminal tabs.
- Modify `pkg/service/workspaceservice/workspaceservice.go`
  - Expose `CreateTabWithBlock()` as a workspace service method.
- Modify generated service bindings, usually via `task generate`
  - Expected file: `frontend/app/store/services.ts`.
- Modify `frontend/app/block/blockregistry.ts`
  - Register existing `FileEditorViewModel` under `codeeditor`.
- Create `frontend/app/fileexplorer/open-editor-tab.ts`
  - Own the file-path-to-editor-tab orchestration and dedupe logic.
- Modify `frontend/app/fileexplorer/file-explorer-model.ts`
  - Route file opens through `openFileInEditorTab()`.
  - Preserve directory expansion behavior.
- Modify `frontend/app/fileexplorer/file-explorer-tree.tsx`
  - Make file row click open the editor tab path.
  - Keep explicit right-editor context menu action as separate workflow.
- Modify tests:
  - `frontend/app/fileexplorer/file-explorer-model.test.ts`
  - `frontend/app/fileexplorer/file-explorer-tree.test.tsx`
  - Add `frontend/app/fileexplorer/open-editor-tab.test.ts`
  - Existing `frontend/app/tab/tab-name.test.ts`
  - Existing `frontend/app/tab/workspaceswitcher.test.ts`
- Modify tab display gaps:
  - `frontend/app/tab/workspaceswitcher.tsx`
  - `frontend/app/tab/vtabbar.tsx`
  - `frontend/app/tab/vtab-detail-sidecar.tsx`

---

### Task 1: Register The Existing Code Editor View

**Files:**
- Modify: `frontend/app/block/blockregistry.ts`
- Test: `frontend/app/fileexplorer/open-editor-tab.test.ts` in later tasks verifies `view: "codeeditor"` is the selected view.

- [ ] **Step 1: Import `FileEditorViewModel`**

Add this import near the other view imports in `frontend/app/block/blockregistry.ts`:

```ts
import { FileEditorViewModel } from "@/app/view/codeeditor/file-editor-model";
```

- [ ] **Step 2: Register `codeeditor`**

Add this line after the existing `"preview"` registration:

```ts
BlockRegistry.set("codeeditor", FileEditorViewModel);
```

- [ ] **Step 3: Run a targeted type check filter**

Run:

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "frontend/app/block/blockregistry|frontend/app/view/codeeditor" || true
```

Expected: no output for these files.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/block/blockregistry.ts
git commit -m "feat: register codeeditor block view"
```

---

### Task 2: Add Backend Support For Single-Block Tabs

**Files:**
- Modify: `pkg/wcore/workspace.go`
- Modify: `pkg/service/workspaceservice/workspaceservice.go`
- Generated: `frontend/app/store/services.ts`

- [ ] **Step 1: Refactor tab name/meta preparation in `workspace.go`**

In `pkg/wcore/workspace.go`, add this helper immediately after `defaultTabName()`:

```go
func defaultTabNameAndMeta(tabName string) (string, waveobj.MetaMapType) {
	autoName := tabName == ""
	if autoName {
		tabName = defaultTabName()
	}
	if !autoName {
		return tabName, nil
	}
	return tabName, waveobj.MetaMapType{waveobj.MetaKey_TabAutoName: true}
}
```

Then replace the existing auto-name block at the start of `CreateTab()`:

```go
	tabName, meta := defaultTabNameAndMeta(tabName)
```

The first lines of `CreateTab()` should become:

```go
// returns tabid
func CreateTab(ctx context.Context, workspaceId string, tabName string, activateTab bool, isInitialLaunch bool) (string, error) {
	tabName, meta := defaultTabNameAndMeta(tabName)

	tab, err := createTabObj(ctx, workspaceId, tabName, meta)
	if err != nil {
		return "", fmt.Errorf("error creating tab: %w", err)
	}
```

- [ ] **Step 2: Extract shared new-tab side effects**

Still in `pkg/wcore/workspace.go`, add these helpers near `CreateTab()`:

```go
func applyTabBackground(ctx context.Context, tab *waveobj.Tab) {
	tabBg := getTabBackground()
	if tabBg == "" {
		return
	}
	tabORef := waveobj.ORefFromWaveObj(tab)
	wstore.UpdateObjectMeta(ctx, *tabORef, waveobj.MetaMapType{waveobj.MetaKey_TabBackground: tabBg}, false)
}

func recordCreateTabTelemetry() {
	telemetry.GoUpdateActivityWrap(wshrpc.ActivityUpdate{NewTab: 1}, "createtab")
	telemetry.GoRecordTEventWrap(&telemetrydata.TEvent{
		Event: "action:createtab",
	})
}
```

Update the bottom of `CreateTab()` to call these helpers:

```go
	if !isInitialLaunch {
		err = ApplyPortableLayout(ctx, tab.OID, GetNewTabLayout(), true)
		if err != nil {
			return tab.OID, fmt.Errorf("error applying new tab layout: %w", err)
		}
		applyTabBackground(ctx, tab)
	}
	recordCreateTabTelemetry()
	return tab.OID, nil
```

- [ ] **Step 3: Add `CreateTabWithBlock()` in `workspace.go`**

Add this function after `CreateTab()`:

```go
func CreateTabWithBlock(ctx context.Context, workspaceId string, tabName string, activateTab bool, blockDef waveobj.BlockDef) (string, error) {
	tabName, meta := defaultTabNameAndMeta(tabName)
	tab, err := createTabObj(ctx, workspaceId, tabName, meta)
	if err != nil {
		return "", fmt.Errorf("error creating tab: %w", err)
	}
	if activateTab {
		err = SetActiveTab(ctx, workspaceId, tab.OID)
		if err != nil {
			return "", fmt.Errorf("error setting active tab: %w", err)
		}
	}
	layout := PortableLayout{
		{IndexArr: []int{0}, BlockDef: &blockDef, Focused: true},
	}
	err = ApplyPortableLayout(ctx, tab.OID, layout, true)
	if err != nil {
		return tab.OID, fmt.Errorf("error applying single-block tab layout: %w", err)
	}
	applyTabBackground(ctx, tab)
	recordCreateTabTelemetry()
	return tab.OID, nil
}
```

- [ ] **Step 4: Expose `CreateTabWithBlock` in `workspaceservice.go`**

Add this metadata method near `CreateTab_Meta()`:

```go
func (svc *WorkspaceService) CreateTabWithBlock_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{
		ArgNames:   []string{"workspaceId", "tabName", "activateTab", "blockDef"},
		ReturnDesc: "tabId",
	}
}
```

Add this service method after `CreateTab()`:

```go
func (svc *WorkspaceService) CreateTabWithBlock(workspaceId string, tabName string, activateTab bool, blockDef waveobj.BlockDef) (string, waveobj.UpdatesRtnType, error) {
	ctx, cancelFn := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancelFn()
	ctx = waveobj.ContextWithUpdates(ctx)
	tabId, err := wcore.CreateTabWithBlock(ctx, workspaceId, tabName, activateTab, blockDef)
	if err != nil {
		return "", nil, fmt.Errorf("error creating tab with block: %w", err)
	}
	updates := waveobj.ContextGetUpdatesRtn(ctx)
	go func() {
		defer func() {
			panichandler.PanicHandler("WorkspaceService:CreateTabWithBlock:SendUpdateEvents", recover())
		}()
		wps.Broker.SendUpdateEvents(updates)
	}()
	return tabId, updates, nil
}
```

- [ ] **Step 5: Generate service bindings**

Run:

```bash
task generate
```

Expected: `frontend/app/store/services.ts` includes:

```ts
CreateTabWithBlock(workspaceId: string, tabName: string, activateTab: boolean, blockDef: BlockDef): Promise<string>
```

- [ ] **Step 6: Build changed Go packages**

Run:

```bash
go build ./pkg/wcore/... ./pkg/service/workspaceservice/...
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add pkg/wcore/workspace.go pkg/service/workspaceservice/workspaceservice.go frontend/app/store/services.ts frontend/types/gotypes.d.ts
git commit -m "feat: create tabs with an initial block"
```

If `task generate` changes additional generated files required by the service method, include only those generated files in this commit.

---

### Task 3: Add Editor-Tab Opening Helper

**Files:**
- Create: `frontend/app/fileexplorer/open-editor-tab.ts`
- Test: `frontend/app/fileexplorer/open-editor-tab.test.ts`

- [ ] **Step 1: Write failing tests for dedupe and creation**

Create `frontend/app/fileexplorer/open-editor-tab.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atoms, WOS } from "@/store/global";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findEditorTabForPath, openFileInEditorTab } from "./open-editor-tab";

const mockServices = vi.hoisted(() => ({
    CreateTabWithBlock: vi.fn(),
    SetActiveTab: vi.fn(),
}));

vi.mock("@/app/store/services", () => ({
    WorkspaceService: mockServices,
}));

vi.mock("@/store/global", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    const wosActual = await vi.importActual<typeof import("@/app/store/wos")>("@/app/store/wos");
    return {
        atoms: {
            workspace: jotaiActual.atom(null),
        },
        WOS: wosActual,
    };
});

describe("open editor tab from file explorer", () => {
    beforeEach(() => {
        mockServices.CreateTabWithBlock.mockReset();
        mockServices.SetActiveTab.mockReset();
        globalStore.set(atoms.workspace as any, {
            oid: "workspace-1",
            tabids: ["tab-1", "tab-2"],
        } as Workspace);
        globalStore.set(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", "tab-1")), {
            oid: "tab-1",
            blockids: ["block-1"],
        } as Tab);
        globalStore.set(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", "tab-2")), {
            oid: "tab-2",
            blockids: ["block-2"],
        } as Tab);
        globalStore.set(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", "block-1")), {
            oid: "block-1",
            meta: { view: "termblocks", "cmd:cwd": "/repo" },
        } as Block);
        globalStore.set(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", "block-2")), {
            oid: "block-2",
            meta: { view: "codeeditor", file: "/repo/src/app.ts" },
        } as Block);
    });

    it("finds an existing codeeditor tab for the same file path", () => {
        expect(findEditorTabForPath("/repo/src/app.ts")).toBe("tab-2");
    });

    it("activates an existing editor tab instead of creating a duplicate", async () => {
        await openFileInEditorTab("/repo/src/app.ts");

        expect(mockServices.SetActiveTab).toHaveBeenCalledWith("workspace-1", "tab-2");
        expect(mockServices.CreateTabWithBlock).not.toHaveBeenCalled();
    });

    it("creates a codeeditor tab when the file is not already open", async () => {
        mockServices.CreateTabWithBlock.mockResolvedValue("tab-3");

        const result = await openFileInEditorTab("/repo/src/new.ts");

        expect(result).toEqual({ tabId: "tab-3", created: true });
        expect(mockServices.CreateTabWithBlock).toHaveBeenCalledWith("workspace-1", "", true, {
            meta: {
                view: "codeeditor",
                file: "/repo/src/new.ts",
                connection: "",
            },
        });
        expect(mockServices.SetActiveTab).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run frontend/app/fileexplorer/open-editor-tab.test.ts
```

Expected: FAIL because `open-editor-tab.ts` does not exist.

- [ ] **Step 3: Implement `open-editor-tab.ts`**

Create `frontend/app/fileexplorer/open-editor-tab.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WorkspaceService } from "@/app/store/services";
import { atoms, globalStore, WOS } from "@/store/global";

export type OpenFileInEditorTabResult = {
    tabId: string;
    created: boolean;
};

function getBlockForId(blockId: string): Block | null {
    return globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId))) ?? null;
}

function getTabForId(tabId: string): Tab | null {
    return globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId))) ?? null;
}

export function findEditorTabForPath(path: string): string | null {
    const workspace = globalStore.get(atoms.workspace);
    const tabIds = workspace?.tabids ?? [];
    for (const tabId of tabIds) {
        const tab = getTabForId(tabId);
        for (const blockId of tab?.blockids ?? []) {
            const block = getBlockForId(blockId);
            if (block?.meta?.view === "codeeditor" && block.meta.file === path) {
                return tabId;
            }
        }
    }
    return null;
}

export async function openFileInEditorTab(path: string): Promise<OpenFileInEditorTabResult> {
    const workspace = globalStore.get(atoms.workspace);
    if (!workspace?.oid) {
        throw new Error("cannot open editor tab without an active workspace");
    }
    const existingTabId = findEditorTabForPath(path);
    if (existingTabId) {
        await WorkspaceService.SetActiveTab(workspace.oid, existingTabId);
        return { tabId: existingTabId, created: false };
    }
    const tabId = await WorkspaceService.CreateTabWithBlock(workspace.oid, "", true, {
        meta: {
            view: "codeeditor",
            file: path,
            connection: "",
        },
    });
    return { tabId, created: true };
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
npx vitest run frontend/app/fileexplorer/open-editor-tab.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/fileexplorer/open-editor-tab.ts frontend/app/fileexplorer/open-editor-tab.test.ts
git commit -m "feat: open files in editor tabs"
```

---

### Task 4: Route File Explorer File Opens To Editor Tabs

**Files:**
- Modify: `frontend/app/fileexplorer/file-explorer-model.ts`
- Modify: `frontend/app/fileexplorer/file-explorer-model.test.ts`
- Modify: `frontend/app/fileexplorer/file-explorer-tree.tsx`
- Modify: `frontend/app/fileexplorer/file-explorer-tree.test.tsx`

- [ ] **Step 1: Update `file-explorer-model.test.ts` for new behavior**

Replace the existing test named `"opens non-directory files in the right editor before the panel renders"` with:

```ts
it("opens non-directory files in a main editor tab", async () => {
    const model = FileExplorerModel.getInstance();
    globalStore.set(model.rootAtom, "/repo");
    mockFileExplorer.openFileInEditorTab.mockResolvedValue({ tabId: "tab-editor", created: true });

    await model.openFile({
        path: "/repo/src/app.ts",
        name: "app.ts",
        isdir: false,
    });

    expect(mockFileExplorer.openFileInEditorTab).toHaveBeenCalledWith("/repo/src/app.ts");
    expect(mockFileExplorer.layoutModel.openRightTool).not.toHaveBeenCalled();
    expect(vi.mocked(RpcApi.FileReadCommand)).not.toHaveBeenCalled();
    expect(RightEditorModel.hasInstance()).toBe(false);
});
```

Update the hoisted mock object at the top of the file:

```ts
const mockFileExplorer = vi.hoisted(() => ({
    createBlock: vi.fn(),
    openFileInEditorTab: vi.fn(),
    layoutModel: {
        openRightTool: vi.fn(),
        openRightEditorTool: vi.fn(),
    },
    settingsAtoms: new Map<string, any>(),
}));
```

Add this mock:

```ts
vi.mock("./open-editor-tab", () => ({
    openFileInEditorTab: mockFileExplorer.openFileInEditorTab,
}));
```

In `beforeEach()`, reset the mock:

```ts
mockFileExplorer.openFileInEditorTab.mockReset();
```

- [ ] **Step 2: Verify model test fails**

Run:

```bash
npx vitest run frontend/app/fileexplorer/file-explorer-model.test.ts
```

Expected: FAIL because `FileExplorerModel.openFile()` still opens the right editor.

- [ ] **Step 3: Update `FileExplorerModel.openFile()`**

In `frontend/app/fileexplorer/file-explorer-model.ts`, remove these imports if they are no longer used by the file open path:

```ts
import { RightEditorProductionRpc } from "@/app/righteditor/right-editor-rpc";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
```

Keep `RightEditorModel` because rename/delete sync still uses `RightEditorModel.getExistingInstance()`.

Add:

```ts
import { openFileInEditorTab } from "./open-editor-tab";
```

Replace `openFile()` with:

```ts
async openFile(finfo: FileInfo): Promise<void> {
    if (finfo.isdir) {
        await this.toggleExpand(finfo.path);
        return;
    }
    await openFileInEditorTab(finfo.path);
}
```

- [ ] **Step 4: Run model test and verify pass**

Run:

```bash
npx vitest run frontend/app/fileexplorer/file-explorer-model.test.ts
```

Expected: PASS.

- [ ] **Step 5: Update file tree click behavior test**

In `frontend/app/fileexplorer/file-explorer-tree.test.tsx`, update the context menu test labels after deciding menu wording. Keep the explicit right editor action:

```ts
expect(menuLabels).toContain("Open in Right Editor");
expect(menuLabels).toContain("Open in Editor Tab");
```

Update the implementation in `buildFileExplorerContextMenu()` so the file main-area action label is `"Open in Editor Tab"` and calls `model.openFile(finfo)`:

```ts
menu.push({
    label: isDir ? "Open in New Tab" : "Open in Editor Tab",
    click: () =>
        fireAndForget(() =>
            isDir ? model.openInNewTab(path) : model.openFile(finfo)
        ),
});
```

- [ ] **Step 6: Update row click in `file-explorer-tree.tsx`**

Find the row click handler that currently selects and only expands directories. Change it to:

```ts
onClick={() => {
    model.setSelected(path);
    if (finfo.isdir) {
        fireAndForget(() => model.toggleExpand(path));
        return;
    }
    fireAndForget(() => model.openFile(finfo));
}}
```

Keep the file double-click handler harmless. It can continue calling `model.openFile(finfo)` because `openFileInEditorTab()` dedupes existing editor tabs.

- [ ] **Step 7: Run file explorer tests**

Run:

```bash
npx vitest run frontend/app/fileexplorer/
```

Expected: all file explorer tests pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/fileexplorer/file-explorer-model.ts frontend/app/fileexplorer/file-explorer-model.test.ts frontend/app/fileexplorer/file-explorer-tree.tsx frontend/app/fileexplorer/file-explorer-tree.test.tsx
git commit -m "feat: route file explorer opens to editor tabs"
```

---

### Task 5: Fix File-Backed Tab Label Consumers

**Files:**
- Modify: `frontend/app/tab/workspaceswitcher.tsx`
- Modify: `frontend/app/tab/vtabbar.tsx`
- Modify: `frontend/app/tab/vtab-detail-sidecar.tsx`
- Tests: `frontend/app/tab/workspaceswitcher.test.ts`, `frontend/app/tab/tab-name.test.ts`

- [ ] **Step 1: Update workspace switcher file view detection**

In `frontend/app/tab/workspaceswitcher.tsx`, update the comment:

```ts
// File-type badge for the preview/codeeditor view.
```

Update the file-backed branch:

```ts
if (file && (view === "preview" || view === "codeeditor")) {
```

- [ ] **Step 2: Update vtabbar file path metadata**

In `frontend/app/tab/vtabbar.tsx`, replace:

```ts
const filePath = (block?.meta?.["file:path"] as string) || "";
```

with:

```ts
const filePath = ((block?.meta?.["file"] || block?.meta?.["file:path"]) as string) || "";
```

Update the preview branch so `codeeditor` shares the same file label path:

```ts
} else if (view === "preview" || view === "codeeditor") {
    primaryName = fileBase || blockViewToName(view) || "File";
    expandedSubtitle = filePath !== fileBase ? filePath : "";
    compactLineTwo = "";
```

- [ ] **Step 3: Update vtab detail sidecar file path metadata**

In `frontend/app/tab/vtab-detail-sidecar.tsx`, replace:

```ts
const filePath = (effectiveBlock?.meta?.["file:path"] as string) || "";
```

with:

```ts
const filePath = ((effectiveBlock?.meta?.["file"] || effectiveBlock?.meta?.["file:path"]) as string) || "";
```

Update the pane-mode header branch:

```ts
} else if (view === "preview" || view === "codeeditor") {
    headerTitle = fileBase || viewToName(view);
```

Update any preview-only JSX guard for file path display:

```tsx
{isPaneMode && (view === "preview" || view === "codeeditor") && filePath && (
```

- [ ] **Step 4: Run tab tests**

Run:

```bash
npx vitest run frontend/app/tab/tab-name.test.ts frontend/app/tab/workspaceswitcher.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run TypeScript filter**

Run:

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "frontend/app/tab/workspaceswitcher|frontend/app/tab/vtabbar|frontend/app/tab/vtab-detail-sidecar" || true
```

Expected: no output for these files.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/tab/workspaceswitcher.tsx frontend/app/tab/vtabbar.tsx frontend/app/tab/vtab-detail-sidecar.tsx
git commit -m "fix: derive file labels for codeeditor tabs"
```

---

### Task 6: End-To-End Verification

**Files:**
- No new files.
- Verify the implementation from UI and tests.

- [ ] **Step 1: Run focused frontend tests**

Run:

```bash
npx vitest run frontend/app/fileexplorer/ frontend/app/tab/
```

Expected: all tests pass.

- [ ] **Step 2: Run Go build for touched packages**

Run:

```bash
go build ./pkg/wcore/... ./pkg/service/workspaceservice/...
```

Expected: exit 0.

- [ ] **Step 3: Run TypeScript filter for touched areas**

Run:

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "frontend/app/fileexplorer|frontend/app/block/blockregistry|frontend/app/tab/workspaceswitcher|frontend/app/tab/vtabbar|frontend/app/tab/vtab-detail-sidecar|frontend/app/store/services" || true
```

Expected: no output for these files.

- [ ] **Step 4: Manual UI verification**

Start the app using the existing project workflow, then verify:

```text
1. Open the left file explorer.
2. Click a file.
3. Confirm a main-area tab opens with the editor UI.
4. Confirm the right editor panel does not open.
5. Confirm the top tab label is the file basename.
6. Click the same file again.
7. Confirm the existing editor tab becomes active and no duplicate tab appears.
8. Edit and save the file with Cmd/Ctrl+S.
9. Confirm save behavior matches the right panel editor behavior.
```

- [ ] **Step 5: Final commit if verification required small fixes**

If verification required fixes, commit only those files:

```bash
git status --short
git add <only-files-touched-for-this-feature>
git commit -m "fix: stabilize editor tab file opening"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review

- Spec coverage:
  - File tree opens editor tab: Task 4.
  - Same file activates existing tab: Task 3.
  - New tab contains one `codeeditor` block: Task 2 and Task 3.
  - Right editor panel remains explicit only: Task 4.
  - Tab name derives from file basename: existing `tab-name.ts`, protected in Task 5/6.
  - Workspace switcher/vtab display gaps: Task 5.
- Placeholder scan:
  - No unspecified implementation placeholders remain.
- Type consistency:
  - `CreateTabWithBlock` is defined in Go service and called from `WorkspaceService.CreateTabWithBlock`.
  - `openFileInEditorTab()` returns `{ tabId, created }` consistently in tests and implementation.
  - File-backed view checks use `codeeditor`, matching `FileEditorViewModel.viewType`.
