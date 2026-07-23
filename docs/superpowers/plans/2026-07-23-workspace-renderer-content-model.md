# Workspace Renderer 与当前内容模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个 Crest window 建立一个常驻 Workspace Renderer，并用本地 `ActiveContent`/`TopTab` 模型完成 Agent、Terminal 占位和轻量 Top Tab mock 的稳定切换。

**Architecture:** Electron main 为每个 `WaveBrowserWindow` 创建一个不带 `tabId` 的 `WorkspaceView`，它在整个 window 生命周期中保持同一个 `webContents.id`。Workspace Renderer 使用 `workspace:<workspaceId>` route，拥有 Workspace chrome、左侧三态 Panel 和当前内容模型；本阶段不连接真实 Terminal Renderer、File、Browser 或 Agent runtime，只建立后续 Phase 共用的边界、checkpoint 和可验证 mock。

**Tech Stack:** Electron `BaseWindow`/`WebContentsView`/preload IPC、React 19、Jotai、Wave WSH RPC/WOS、Go workspace service、Vitest、Go test。

---

## 范围边界

本计划只实现总设计的 Phase 1：

- Workspace Renderer 的创建、初始化、常驻与销毁；
- `WorkspaceContentState`、`ActiveContent`、`TopTab` descriptor 和 fallback；
- workspace checkpoint 的 typed backend schema、revision 与保存 RPC；
- Files/Sessions/Terminals 三态左侧 Panel 状态；
- Agent、Terminal 和 Top Tab 的 mock 内容切换；
- window-level Workspace command IPC 的最小路由。

本计划不实现：

- Terminal Renderer 覆盖中央区域、bounds、z-order、focus 或 overlay occlusion；
- 现有 `VTabBar` 到 `TerminalTabList` 的迁移；
- Agent 去 Tab/Block 化；
- File/Browser/Preview/Diff 的真实 runtime；
- 旧混合 Tab 数据迁移。

完成本计划后，当前 `WaveTabView` 代码仍保留，但普通 workspace window 以新的 Workspace Renderer 为入口。真实 Terminal 与非 Terminal 内容在后续三个计划中逐项接入。

## 文件结构

### 新建

- `frontend/app/workspace/workspace-content-state.ts`：纯类型、校验、fallback 和 reducer。
- `frontend/app/workspace/workspace-content-state.test.ts`：当前内容状态的单元测试。
- `frontend/app/workspace/workspace-model.ts`：Jotai owner、checkpoint debounce/flush 和 workspace command。
- `frontend/app/workspace/workspace-model.test.ts`：本地同步切换、revision 和保存失败测试。
- `frontend/app/workspace/workspace-app.tsx`：Workspace Renderer 的 React 根组件。
- `frontend/app/workspace/workspace-app.test.tsx`：renderer ID 不参与切换、三类 mock 内容和左侧三态交互测试。
- `frontend/app/workspace/workspace-main-content.tsx`：按 `ActiveContent` 渲染 Agent/Terminal/Top Tab 占位内容。
- `frontend/app/workspace/workspace-left-panel.tsx`：Files/Sessions/Terminals 的单槽位容器。
- `frontend/app/workspace/workspace-right-panel-host.tsx`：从当前 Workspace 提取右侧工具面板接线。
- `emain/emain-workspaceview.ts`：`WorkspaceView` 生命周期、ready/init promise 和 webContents 映射。
- `emain/emain-workspaceview.test.ts`：不依赖真实 Electron window 的 init option 与 lookup 行为测试。
- `pkg/service/workspaceservice/contentstate_test.go`：snapshot 校验、fallback 和 revision 测试。

### 修改

- `pkg/waveobj/wtype.go`：在 `Workspace` 上增加 typed `ContentState`、`ActiveTerminalTabId` 和 `NavigationRevision`。
- `pkg/wshrpc/wshrpctypes.go`：增加 workspace checkpoint RPC 类型和接口。
- `pkg/service/workspaceservice/workspaceservice.go`：实现 revision-guarded checkpoint 保存。
- `frontend/types/custom.d.ts`：增加 Workspace init、command 和 Electron API 类型。
- `frontend/types/gotypes.d.ts`：由 `task generate` 生成，禁止手工修改。
- `frontend/app/store/wshclientapi.ts`：由 `task generate` 生成，禁止手工修改。
- `frontend/app/store/wshrouter.ts`：增加 `makeWorkspaceRouteId()`。
- `frontend/app/store/wshrpcutil.ts`：将 tab-specific client 名改为通用 renderer client。
- `frontend/app/store/global-atoms.ts`：允许 Workspace Renderer 没有 `staticTabId`。
- `frontend/wave.ts`：增加 `workspace-init` bootstrap 分支。
- `emain/preload.ts`：暴露 Workspace init/command IPC。
- `emain/emain-ipc.ts`：处理 Workspace ready 和 command。
- `emain/emain-window.ts`：创建、挂载和销毁唯一 `WorkspaceView`。
- `frontend/preview/mock/preview-electron-api.ts`：补齐 Electron API stub。
- `frontend/app/workspace/workspace-layout-model.ts`：将左侧三个 boolean/两份 width 收敛为 `LeftPanelState`。
- `frontend/app/workspace/workspace-layout-model.test.ts`：替换旧左侧布局断言。
- `frontend/app/topbar/topbar.tsx`：保留 Files/Agent，新增 Terminal 按钮。
- `frontend/app/topbar/topbar.test.tsx`：验证三个按钮的互斥切换和重复点击收起。

## Task 1：定义并校验 workspace content checkpoint

**Files:**

- Modify: `pkg/waveobj/wtype.go`
- Create: `pkg/service/workspaceservice/contentstate_test.go`

- [ ] **Step 1: 写失败的 schema 与 fallback 测试**

在 `pkg/service/workspaceservice/contentstate_test.go` 覆盖以下表格，不使用旧 `workspace.activetabid` 作为 fallback：

```go
func TestNormalizeWorkspaceContentState(t *testing.T) {
    tests := []struct {
        name       string
        state      waveobj.WorkspaceContentState
        terminalID string
        wantKind   string
        wantID     string
        wantTabs   int
    }{
        {
            name: "keeps valid file active",
            state: waveobj.WorkspaceContentState{
                ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: "file-1"},
                TopTabs: []waveobj.TopTabDescriptor{
                    {Id: "file-1", Kind: waveobj.TopTabKindFile, Path: "/tmp/a.ts", Title: "a.ts"},
                },
            },
            wantKind: waveobj.ActiveContentKindTopTab,
            wantID: "file-1",
            wantTabs: 1,
        },
        {
            name: "drops invalid descriptor and falls back to terminal",
            state: waveobj.WorkspaceContentState{
                ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: "missing"},
                TopTabs: []waveobj.TopTabDescriptor{
                    {Id: "", Kind: waveobj.TopTabKindBrowser, Url: "https://example.com"},
                },
            },
            terminalID: "term-1",
            wantKind: waveobj.ActiveContentKindTerminal,
            wantID: "term-1",
            wantTabs: 0,
        },
        {
            name: "falls back to agent without tabs or terminal",
            state: waveobj.WorkspaceContentState{
                ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: "missing"},
            },
            wantKind: waveobj.ActiveContentKindAgent,
            wantTabs: 0,
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            got := workspaceservice.NormalizeWorkspaceContentState(tc.state, tc.terminalID)
            require.Equal(t, tc.wantKind, got.ActiveContent.Kind)
            require.Equal(t, tc.wantID, got.ActiveContent.ContentId())
            require.Len(t, got.TopTabs, tc.wantTabs)
        })
    }
}
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
go test ./pkg/service/workspaceservice -run TestNormalizeWorkspaceContentState -count=1
```

Expected: FAIL，提示 `WorkspaceContentState` 或 `NormalizeWorkspaceContentState` 未定义。

- [ ] **Step 3: 添加 typed schema 和字符串常量**

在 `pkg/waveobj/wtype.go` 的 `Workspace` 前定义以下类型；遵循项目规则，不创建自定义 string enum：

```go
const (
    ActiveContentKindAgent    = "agent"
    ActiveContentKindTerminal = "terminal"
    ActiveContentKindTopTab   = "top-tab"

    TopTabKindFile    = "file"
    TopTabKindBrowser = "browser"
    TopTabKindPreview = "preview"
    TopTabKindGitDiff = "git-diff"
)

type ActiveContent struct {
    Kind          string `json:"kind"`
    TerminalTabId string `json:"terminaltabid,omitempty"`
    TopTabId      string `json:"toptabid,omitempty"`
}

func (active ActiveContent) ContentId() string {
    if active.Kind == ActiveContentKindTerminal {
        return active.TerminalTabId
    }
    if active.Kind == ActiveContentKindTopTab {
        return active.TopTabId
    }
    return ""
}

type TopTabDescriptor struct {
    Id       string `json:"id"`
    Kind     string `json:"kind"`
    Path     string `json:"path,omitempty"`
    Url      string `json:"url,omitempty"`
    Title    string `json:"title"`
    RepoRoot string `json:"reporoot,omitempty"`
    OldPath  string `json:"oldpath,omitempty"`
    NewPath  string `json:"newpath,omitempty"`
}

type WorkspaceContentState struct {
    ActiveContent     ActiveContent      `json:"activecontent"`
    TopTabs           []TopTabDescriptor `json:"toptabs"`
    LastActiveTopTabId string            `json:"lastactivetoptabid,omitempty"`
}
```

给 `Workspace` 增加：

```go
ContentState        WorkspaceContentState `json:"contentstate"`
ActiveTerminalTabId string                `json:"activeterminaltabid,omitempty"`
NavigationRevision int64                 `json:"navigationrevision"`
```

在 `pkg/service/workspaceservice/workspaceservice.go` 实现 descriptor 独立校验和 `last top tab -> terminal -> agent` fallback。File 必须有 `path`，Browser 必须是 `http`/`https` URL，Preview 必须有 `path`，Git Diff 必须有 `reporoot`、`oldpath`、`newpath`。

- [ ] **Step 4: 运行 schema 测试**

Run:

```bash
go test ./pkg/service/workspaceservice -run TestNormalizeWorkspaceContentState -count=1
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add pkg/waveobj/wtype.go pkg/service/workspaceservice/workspaceservice.go pkg/service/workspaceservice/contentstate_test.go
git commit -m "feat: add workspace content state schema"
```

## Task 2：增加 revision-guarded workspace checkpoint RPC

**Files:**

- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/service/workspaceservice/workspaceservice.go`
- Modify: `pkg/service/workspaceservice/workspaceservice_test.go`
- Regenerate: `frontend/types/gotypes.d.ts`
- Regenerate: `frontend/app/store/wshclientapi.ts`

- [ ] **Step 1: 写 stale revision 失败测试**

在 `pkg/service/workspaceservice/workspaceservice_test.go` 新增：

```go
func TestSaveWorkspaceCheckpointRejectsStaleRevision(t *testing.T) {
    ctx := context.Background()
    workspace := makeTestWorkspace(t, ctx)
    svc := &WorkspaceService{}

    first := wshrpc.CommandSaveWorkspaceCheckpointData{
        WorkspaceId: workspace.OID,
        Revision: 2,
        ContentState: waveobj.WorkspaceContentState{
            ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
        },
    }
    require.NoError(t, svc.SaveWorkspaceCheckpoint(ctx, first))

    stale := first
    stale.Revision = 1
    stale.ContentState.ActiveContent = waveobj.ActiveContent{
        Kind: waveobj.ActiveContentKindTerminal,
        TerminalTabId: "term-stale",
    }
    require.ErrorIs(t, svc.SaveWorkspaceCheckpoint(ctx, stale), workspaceservice.ErrStaleWorkspaceCheckpoint)

    saved := mustGetWorkspace(t, ctx, workspace.OID)
    require.Equal(t, int64(2), saved.NavigationRevision)
    require.Equal(t, waveobj.ActiveContentKindAgent, saved.ContentState.ActiveContent.Kind)
}
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
go test ./pkg/service/workspaceservice -run TestSaveWorkspaceCheckpointRejectsStaleRevision -count=1
```

Expected: FAIL，提示 RPC data 或方法未定义。

- [ ] **Step 3: 定义并实现 RPC**

在 `pkg/wshrpc/wshrpctypes.go` 增加：

```go
type CommandSaveWorkspaceCheckpointData struct {
    WorkspaceId        string                        `json:"workspaceid"`
    Revision           int64                         `json:"revision"`
    ContentState       waveobj.WorkspaceContentState `json:"contentstate"`
    ActiveTerminalTabId string                       `json:"activeterminaltabid,omitempty"`
}
```

并在 `WshRpcInterface` 增加：

```go
SaveWorkspaceCheckpointCommand(ctx context.Context, data CommandSaveWorkspaceCheckpointData) error
```

在 `WorkspaceService` 中使用同一个 DB transaction 比较 revision 并写入 `ContentState`、`ActiveTerminalTabId`、`NavigationRevision`。`revision <= saved revision` 返回 `ErrStaleWorkspaceCheckpoint`；不要先写 content state 再单独写 terminal active ID。

- [ ] **Step 4: 生成绑定**

Run:

```bash
task generate
```

Expected: `frontend/types/gotypes.d.ts` 出现 `WorkspaceContentState` 和 `CommandSaveWorkspaceCheckpointData`，`frontend/app/store/wshclientapi.ts` 出现 `SaveWorkspaceCheckpointCommand`。

- [ ] **Step 5: 运行后端测试**

Run:

```bash
go test ./pkg/service/workspaceservice ./pkg/wcore -count=1
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/service/workspaceservice/workspaceservice.go pkg/service/workspaceservice/workspaceservice_test.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
git commit -m "feat: persist workspace navigation checkpoints"
```

## Task 3：建立 Workspace Renderer 的 init contract 与 route

**Files:**

- Modify: `frontend/types/custom.d.ts`
- Modify: `frontend/app/store/wshrouter.ts`
- Modify: `frontend/app/store/wshrpcutil.ts`
- Modify: `frontend/app/store/global-atoms.ts`
- Modify: `frontend/app/store/global-model.ts`
- Modify: `frontend/preview/mock/preview-electron-api.ts`
- Test: `frontend/app/store/wshrouter.test.ts`
- Test: `frontend/app/store/global-atoms.test.ts`

- [ ] **Step 1: 写 route 和无 tab 初始化失败测试**

新增断言：

```ts
it("builds a workspace-scoped renderer route", () => {
    expect(makeWorkspaceRouteId("workspace-1")).toBe("workspace:workspace-1");
});

it("initializes workspace atoms without a static tab", () => {
    initGlobalAtoms({
        clientId: "client-1",
        windowId: "window-1",
        workspaceId: "workspace-1",
        rendererKind: "workspace",
        platform: "darwin",
        environment: "renderer",
    });

    expect(globalStore.get(atoms.workspaceId)).toBe("workspace-1");
    expect(atoms.staticTabId).toBeNull();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run frontend/app/store/wshrouter.test.ts frontend/app/store/global-atoms.test.ts
```

Expected: FAIL，提示 `makeWorkspaceRouteId` 或新的 init fields 未定义。

- [ ] **Step 3: 添加 renderer init 类型**

在 `frontend/types/custom.d.ts` 定义：

```ts
type RendererKind = "workspace" | "terminal" | "builder" | "preview";

type WorkspaceInitOpts = {
    clientId: string;
    windowId: string;
    workspaceId: string;
};

type GlobalInitOptions = {
    tabId?: string;
    workspaceId?: string;
    rendererKind: RendererKind;
    windowId: string;
    clientId: string;
    environment: "electron" | "renderer";
    primaryTabStartup?: boolean;
    builderId?: string;
    isPreview?: boolean;
};
```

将 `GlobalAtomsType.staticTabId` 改为可选 atom；Workspace 组件不得读取它。Terminal 旧入口在构造 `GlobalInitOptions` 时显式传 `rendererKind: "terminal"`。

- [ ] **Step 4: 添加 workspace route 和通用 RPC client 名**

在 `frontend/app/store/wshrouter.ts` 增加：

```ts
function makeWorkspaceRouteId(workspaceId: string): string {
    return `workspace:${workspaceId}`;
}
```

在 `frontend/app/store/wshrpcutil.ts` 将模块级 `TabRpcClient` 改名为 `RendererRpcClient`；临时导出 `const TabRpcClient = RendererRpcClient` 只供尚未迁移的 Terminal 代码使用，并在 Phase 4 删除 alias。

- [ ] **Step 5: 运行前端测试与类型检查**

Run:

```bash
npx vitest run frontend/app/store/wshrouter.test.ts frontend/app/store/global-atoms.test.ts
npx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add frontend/types/custom.d.ts frontend/app/store/wshrouter.ts frontend/app/store/wshrouter.test.ts frontend/app/store/wshrpcutil.ts frontend/app/store/global-atoms.ts frontend/app/store/global-atoms.test.ts frontend/app/store/global-model.ts frontend/preview/mock/preview-electron-api.ts
git commit -m "refactor: add workspace renderer identity"
```

## Task 4：创建并常驻唯一 WorkspaceView

**Files:**

- Create: `emain/emain-workspaceview.ts`
- Create: `emain/emain-workspaceview.test.ts`
- Modify: `emain/emain-window.ts`
- Modify: `emain/emain-ipc.ts`
- Modify: `emain/preload.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `frontend/preview/mock/preview-electron-api.ts`

- [ ] **Step 1: 写 WorkspaceView registry 失败测试**

测试工厂注入的 fake `WebContentsView`：

```ts
it("keeps one workspace view for the lifetime of a window", () => {
    const first = getOrCreateWorkspaceView("window-1", makeOptions());
    const second = getOrCreateWorkspaceView("window-1", makeOptions());

    expect(second).toBe(first);
    expect(getWorkspaceViewByWebContentsId(first.webContents.id)).toBe(first);

    removeWorkspaceView("window-1");
    expect(getWorkspaceViewByWebContentsId(first.webContents.id)).toBeUndefined();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run emain/emain-workspaceview.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 WorkspaceView**

`WorkspaceView` 与 `WaveTabView` 分离，不接受 `tabId`：

```ts
export class WorkspaceView extends WebContentsView {
    readonly waveWindowId: string;
    readonly workspaceId: string;
    readonly initPromise: Promise<void>;
    readonly workspaceReadyPromise: Promise<void>;
    initResolve: () => void;
    workspaceReadyResolve: () => void;

    constructor(init: WorkspaceInitOpts, fullConfig: FullConfigType) {
        super({
            webPreferences: {
                preload: path.join(getElectronAppBasePath(), "preload", "index.cjs"),
                webviewTag: true,
            },
        });
        this.waveWindowId = init.windowId;
        this.workspaceId = init.workspaceId;
        this.setBackgroundColor(computeWorkspaceBackgroundColor(fullConfig));
        this.initPromise = new Promise((resolve) => (this.initResolve = resolve));
        this.workspaceReadyPromise = new Promise((resolve) => (this.workspaceReadyResolve = resolve));
        loadWorkspaceFrontend(this.webContents);
    }
}
```

registry 必须同时按 `windowId` 和 `webContents.id` 索引；destroy 时从两个 map 删除。

- [ ] **Step 4: 增加 preload event listener**

四处同步增加以下 API：

```ts
onWorkspaceInit: (callback: (opts: WorkspaceInitOpts) => void) => void; // workspace-init
onWorkspaceCommand: (callback: (command: WorkspaceCommand) => void) => void; // workspace-command
```

preload 使用：

```ts
onWorkspaceInit: (callback) =>
    ipcRenderer.on("workspace-init", (_event, opts) => callback(opts)),
onWorkspaceCommand: (callback) =>
    ipcRenderer.on("workspace-command", (_event, command) => callback(command)),
```

- [ ] **Step 5: 让 WaveBrowserWindow 持有唯一 WorkspaceView**

在 `WaveBrowserWindow` 增加：

```ts
workspaceView: WorkspaceView;
```

constructor 中创建、设为 `{x: 0, y: 0, width, height}`、首先加入 `contentView`，发送一次 `workspace-init` 并等待 `workspace-ready`。resize/fullscreen 只把 WorkspaceView 调整为完整 content bounds；`removeAllChildViews()` 同时销毁它。

本阶段不要把 `WorkspaceView` 塞进 `allLoadedTabViews`，不要给它 `isActiveTab` 或 fake tab ID。

- [ ] **Step 6: 运行 Electron 单元测试**

Run:

```bash
npx vitest run emain/emain-workspaceview.test.ts
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add emain/emain-workspaceview.ts emain/emain-workspaceview.test.ts emain/emain-window.ts emain/emain-ipc.ts emain/preload.ts frontend/types/custom.d.ts frontend/preview/mock/preview-electron-api.ts
git commit -m "feat: add persistent workspace view"
```

## Task 5：实现纯 `WorkspaceContentState` reducer

**Files:**

- Create: `frontend/app/workspace/workspace-content-state.ts`
- Create: `frontend/app/workspace/workspace-content-state.test.ts`

- [ ] **Step 1: 写完整状态转换测试**

测试至少覆盖：

```ts
describe("workspace content state", () => {
    it("activates exactly one content branch", () => {
        const initial = makeDefaultWorkspaceContentState();
        const withFile = reduceWorkspaceContent(initial, {
            type: "open-top-tab",
            tab: { id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" },
        });
        const terminal = reduceWorkspaceContent(withFile, {
            type: "activate-terminal",
            terminalTabId: "term-1",
        });

        expect(terminal.activeContent).toEqual({ kind: "terminal", terminalTabId: "term-1" });
        expect(terminal.lastActiveTopTabId).toBe("file-1");
    });

    it("deduplicates files by normalized absolute path", () => {
        const once = reduceWorkspaceContent(makeDefaultWorkspaceContentState(), {
            type: "open-top-tab",
            tab: { id: "file-1", kind: "file", path: "/tmp/dir/../a.ts", title: "a.ts" },
        });
        const twice = reduceWorkspaceContent(once, {
            type: "open-top-tab",
            tab: { id: "file-2", kind: "file", path: "/tmp/a.ts", title: "a.ts" },
        });

        expect(twice.topTabs).toHaveLength(1);
        expect(twice.activeContent).toEqual({ kind: "top-tab", topTabId: "file-1" });
    });

    it("falls back from a closed active top tab", () => {
        const state = hydrateWorkspaceContentState(snapshotWithTwoTabs(), "term-1");
        const closed = reduceWorkspaceContent(state, { type: "close-top-tab", topTabId: "file-2" });
        expect(closed.activeContent).toEqual({ kind: "top-tab", topTabId: "file-1" });
    });

    it("restores last top tab then terminal then agent", () => {
        expect(resolveActiveContent(snapshotWithMissingActive(), "term-1")).toEqual({
            kind: "top-tab",
            topTabId: "file-1",
        });
        expect(resolveActiveContent(snapshotWithoutTopTabs(), "term-1")).toEqual({
            kind: "terminal",
            terminalTabId: "term-1",
        });
        expect(resolveActiveContent(snapshotWithoutTopTabs(), "")).toEqual({ kind: "agent" });
    });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-content-state.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 discriminated unions 与 reducer**

导出：

```ts
export type ActiveContent =
    | { kind: "agent" }
    | { kind: "terminal"; terminalTabId: string }
    | { kind: "top-tab"; topTabId: string };

export type TopTab =
    | { id: string; kind: "file"; path: string; title: string }
    | { id: string; kind: "browser"; url: string; title: string }
    | { id: string; kind: "preview"; path: string; title: string }
    | {
          id: string;
          kind: "git-diff";
          repoRoot: string;
          oldPath: string;
          newPath: string;
          title: string;
      };

export interface WorkspaceContentState {
    activeContent: ActiveContent;
    topTabs: TopTab[];
    lastActiveTopTabId: string;
}
```

reducer 每次返回新对象；File 使用下列纯字符串 helper 归一化后去重，Browser 不按 URL 去重；关闭 active Top Tab 优先选相邻 Top Tab，没有时选有效 Terminal，最后选 Agent：

```ts
export function normalizeFileTabPath(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    const prefix = normalized.startsWith("/") ? "/" : "";
    const segments: string[] = [];
    for (const segment of normalized.split("/")) {
        if (!segment || segment === ".") {
            continue;
        }
        if (segment === "..") {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return prefix + segments.join("/");
}
```

- [ ] **Step 4: 运行测试**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-content-state.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add frontend/app/workspace/workspace-content-state.ts frontend/app/workspace/workspace-content-state.test.ts
git commit -m "feat: add workspace content reducer"
```

## Task 6：实现 WorkspaceModel 与 checkpoint 调度

**Files:**

- Create: `frontend/app/workspace/workspace-model.ts`
- Create: `frontend/app/workspace/workspace-model.test.ts`

- [ ] **Step 1: 写同步导航与异步保存测试**

使用 fake saver 和 fake clock：

```ts
it("updates navigation before checkpoint resolves", async () => {
    const save = vi.fn(() => new Promise<void>(() => {}));
    const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint: save });

    model.activateTerminal("term-1");

    expect(globalStore.get(model.contentStateAtom).activeContent).toEqual({
        kind: "terminal",
        terminalTabId: "term-1",
    });
    expect(globalStore.get(model.activeTerminalTabIdAtom)).toBe("term-1");
    expect(save).not.toHaveBeenCalled();
});

it("writes content and terminal selection in one revision", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint: save });

    model.activateTerminal("term-1");
    await vi.advanceTimersByTimeAsync(300);

    expect(save).toHaveBeenCalledWith({
        workspaceid: "ws-1",
        revision: 1,
        contentstate: expect.objectContaining({
            activecontent: { kind: "terminal", terminaltabid: "term-1" },
        }),
        activeterminaltabid: "term-1",
    });
});

it("keeps dirty state after a failed save and retries on flush", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint: save });

    model.activateAgent();
    await expect(model.flush()).rejects.toThrow("offline");
    await expect(model.flush()).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-model.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 singleton model**

`WorkspaceModel` 按 window 初始化一次，拥有：

```ts
contentStateAtom: jotai.PrimitiveAtom<WorkspaceContentState>;
activeTerminalTabIdAtom: jotai.PrimitiveAtom<string>;
checkpointStatusAtom: jotai.PrimitiveAtom<"clean" | "dirty" | "saving" | "error">;
```

公开方法：

```ts
activateAgent(): void;
activateTerminal(terminalTabId: string): void;
activateTopTab(topTabId: string): void;
openTopTab(tab: TopTab): void;
closeTopTab(topTabId: string): void;
reorderTopTabs(sourceId: string, targetId: string): void;
flush(): Promise<void>;
```

所有视觉状态先同步写 atom，再把同一 snapshot 标记 dirty。结构和 URL 变化 debounce 300ms；`visibilitychange`、window blur 和 beforeunload 调用 `flush()`。保存失败写 `checkpointStatusAtom = "error"`，保留相同 revision 和 snapshot 供下一次 flush 重试。

- [ ] **Step 4: 运行 model 测试**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-model.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add frontend/app/workspace/workspace-model.ts frontend/app/workspace/workspace-model.test.ts
git commit -m "feat: own workspace navigation state"
```

## Task 7：收敛左侧 Panel 为三种互斥模式

**Files:**

- Modify: `frontend/app/workspace/workspace-layout-model.ts`
- Modify: `frontend/app/workspace/workspace-layout-model.test.ts`
- Create: `frontend/app/workspace/workspace-left-panel.tsx`
- Modify: `frontend/app/topbar/topbar.tsx`
- Modify: `frontend/app/topbar/topbar.test.tsx`

- [ ] **Step 1: 替换旧 boolean 测试**

删除针对 `vtabVisibleAtom`、`fileExplorerVisibleAtom`、`sessionsPanelVisibleAtom`、`vtabWidthAtom` 和 `fileExplorerWidthAtom` 的布局测试，改为：

```ts
it("switches one shared left panel from the top bar", () => {
    const model = WorkspaceLayoutModel.getInstance();

    model.toggleLeftPanel("files");
    expect(globalStore.get(model.leftPanelAtom)).toEqual({ visible: true, mode: "files", width: 260 });

    model.toggleLeftPanel("terminals");
    expect(globalStore.get(model.leftPanelAtom)).toEqual({ visible: true, mode: "terminals", width: 260 });

    model.toggleLeftPanel("terminals");
    expect(globalStore.get(model.leftPanelAtom)).toEqual({ visible: false, mode: "terminals", width: 260 });
});

it("restores one width for every left panel mode", () => {
    setWorkspace("ws-a", {
        "layout:leftpanel": { visible: true, mode: "sessions", width: 312 },
    });
    const model = WorkspaceLayoutModel.getInstance();
    expect(globalStore.get(model.leftPanelAtom)).toEqual({
        visible: true,
        mode: "sessions",
        width: 312,
    });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-layout-model.test.ts frontend/app/topbar/topbar.test.tsx
```

Expected: FAIL，`leftPanelAtom` 和 Terminal button 不存在。

- [ ] **Step 3: 实现共享 Panel state**

在 `workspace-layout-model.ts` 导出：

```ts
export type LeftPanelMode = "files" | "sessions" | "terminals";

export interface LeftPanelState {
    visible: boolean;
    mode: LeftPanelMode;
    width: number;
}

export const LeftPanelMetaKey = "layout:leftpanel";
```

model 只保留一个 `leftPanelAtom`、一个 300ms width persist 和以下操作：

```ts
toggleLeftPanel(mode: LeftPanelMode): void;
setLeftPanelWidth(width: number): void;
previewLeftPanelWidth(width: number): void;
```

`toggleLeftPanel` 在相同 mode 时切 visible，在不同 mode 时设 `visible: true` 并切 mode。删除旧三组 visibility 和两份 width 的生产引用，不读取旧 meta key。

- [ ] **Step 4: 实现 TopBar 三按钮**

`LeftChrome` 读取一次 `leftPanelAtom`，渲染：

```tsx
<ToolbarButton
    icon="list-tree"
    label="Files"
    active={leftPanel.visible && leftPanel.mode === "files"}
    onClick={() => model.toggleLeftPanel("files")}
/>
<ToolbarButton
    icon="message-01"
    label="Agent"
    active={leftPanel.visible && leftPanel.mode === "sessions"}
    onClick={() => model.toggleLeftPanel("sessions")}
/>
<ToolbarButton
    icon="terminal"
    label="Terminal"
    active={leftPanel.visible && leftPanel.mode === "terminals"}
    onClick={() => model.toggleLeftPanel("terminals")}
/>
```

- [ ] **Step 5: 实现单槽位 WorkspaceLeftPanel**

本阶段三个 mode 使用可区分的 mock：

```tsx
export function WorkspaceLeftPanel({ mode }: { mode: LeftPanelMode }) {
    if (mode === "files") {
        return <FileExplorer />;
    }
    if (mode === "sessions") {
        return <AgentSessionsPanel />;
    }
    return <div data-testid="terminal-list-placeholder">Terminal list connects in Phase 2</div>;
}
```

- [ ] **Step 6: 运行布局和 TopBar 测试**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-layout-model.test.ts frontend/app/topbar/topbar.test.tsx
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add frontend/app/workspace/workspace-layout-model.ts frontend/app/workspace/workspace-layout-model.test.ts frontend/app/workspace/workspace-left-panel.tsx frontend/app/topbar/topbar.tsx frontend/app/topbar/topbar.test.tsx
git commit -m "refactor: unify the left workspace panel"
```

## Task 8：启动 WorkspaceApp 并验证 renderer 常驻

**Files:**

- Create: `frontend/app/workspace/workspace-app.tsx`
- Create: `frontend/app/workspace/workspace-app.test.tsx`
- Create: `frontend/app/workspace/workspace-main-content.tsx`
- Create: `frontend/app/workspace/workspace-right-panel-host.tsx`
- Modify: `frontend/wave.ts`
- Modify: `frontend/app/app.tsx`
- Modify: `emain/emain-ipc.ts`

- [ ] **Step 1: 写 WorkspaceApp 切换测试**

```tsx
it("keeps one workspace root while content changes", async () => {
    render(<WorkspaceApp init={makeWorkspaceInit()} />);
    const root = screen.getByTestId("workspace-renderer-root");

    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByTestId("agent-placeholder")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Terminal mock" }));
    expect(screen.getByTestId("terminal-placeholder")).toBeVisible();

    await userEvent.click(screen.getByRole("tab", { name: "README.md" }));
    expect(screen.getByTestId("top-tab-placeholder")).toHaveTextContent("README.md");
    expect(screen.getByTestId("workspace-renderer-root")).toBe(root);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-app.test.tsx
```

Expected: FAIL，`WorkspaceApp` 不存在。

- [ ] **Step 3: 实现 WorkspaceApp**

`WorkspaceApp` 只创建一次 `WorkspaceModel`，顶层结构固定为：

```tsx
<Provider store={globalStore}>
    <div data-testid="workspace-renderer-root" className="flex h-full w-full flex-col overflow-hidden">
        <TopBar workspace={workspace} />
        <div className="flex min-h-0 flex-1">
            {leftPanel.visible ? <WorkspaceLeftPanel mode={leftPanel.mode} /> : null}
            <WorkspaceMainContent activeContent={contentState.activeContent} topTabs={contentState.topTabs} />
            <WorkspaceRightPanelHost />
        </div>
        <StatusBar />
        <ModalsRenderer />
    </div>
</Provider>
```

`WorkspaceMainContent` 保持 Agent mock 挂载并用 `hidden` 控制可见性；Terminal 与 Top Tab 使用占位组件。不要引入 `TabModelContext`、`LayoutModel` 或 `staticTabId`。

- [ ] **Step 4: 提取右侧工具面板 host**

`workspace-right-panel-host.tsx` 读取 `WorkspaceLayoutModel.rightToolPanelAtom`，把当前 `workspace.tsx` 中已有的 callbacks 原样收拢到一个组件：

```tsx
export function WorkspaceRightPanelHost() {
    const model = WorkspaceLayoutModel.getInstance();
    const workspace = useAtomValue(atoms.workspace);
    const hydrated = useAtomValue(model.rightToolPanelAtom);
    const state = model.getRightToolPanelStateForWorkspace(workspace.oid, hydrated);

    return (
        <>
            {state.visible ? (
                <RightToolPanel
                    state={state}
                    onOpenTool={(tool) => model.openRightTool(tool)}
                    onSelectTool={(tool) => model.selectRightTool(tool)}
                    onCloseTool={(tool) => model.closeRightTool(tool)}
                    onMagnify={() => model.setRightToolPanelMagnified(!state.magnified)}
                    onFocusPanel={() => model.setRightToolPanelFocused(true)}
                    onBlurPanel={() => model.setRightToolPanelFocused(false)}
                />
            ) : null}
            <RightToolPanelMagnifiedOverlay
                state={state}
                onExit={() => model.setRightToolPanelMagnified(false)}
            />
        </>
    );
}
```

Phase 1 不传 `sessionId`；Phase 3 在 Agent 已有稳定 session identity 后接入。

- [ ] **Step 5: 增加 workspace bootstrap**

`frontend/wave.ts` 的 `initBare()` 同时注册 `onWorkspaceInit(initWorkspace)`。`initWorkspace()`：

1. 使用 `rendererKind: "workspace"` 初始化 globals；
2. 使用 `makeWorkspaceRouteId(workspaceId)` 初始化 WSH RPC；
3. load/pin client、window、workspace；
4. hydrate `WorkspaceModel`；
5. render `WorkspaceApp`；
6. 发送 `set-window-init-status("workspace-ready")`。

将 status union 扩展为：

```ts
type WindowInitStatus = "ready" | "wave-ready" | "workspace-ready";
```

`emain-ipc.ts` 必须通过 `event.sender.id` 区分 `WorkspaceView` 与 `WaveTabView`，不能根据最后创建的 view 猜测。

- [ ] **Step 6: 运行 WorkspaceApp 测试与类型检查**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-app.test.tsx frontend/app/workspace/workspace-content-state.test.ts frontend/app/workspace/workspace-model.test.ts
npx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add frontend/app/workspace/workspace-app.tsx frontend/app/workspace/workspace-app.test.tsx frontend/app/workspace/workspace-main-content.tsx frontend/app/workspace/workspace-right-panel-host.tsx frontend/wave.ts frontend/app/app.tsx emain/emain-ipc.ts
git commit -m "feat: boot the workspace renderer"
```

## Task 9：增加 workspace command router

**Files:**

- Modify: `frontend/types/custom.d.ts`
- Modify: `emain/preload.ts`
- Modify: `emain/emain-ipc.ts`
- Modify: `frontend/preview/mock/preview-electron-api.ts`
- Create: `frontend/app/workspace/workspace-command-router.ts`
- Create: `frontend/app/workspace/workspace-command-router.test.ts`

- [ ] **Step 1: 写 command dispatch 失败测试**

```ts
it.each([
    ["activate-agent", () => model.activateAgent()],
    ["new-terminal", () => terminalCommands.create()],
    ["close-active", () => model.closeActive()],
])("dispatches %s to the workspace owner", (type, invoke) => {
    router.dispatch({ type } as WorkspaceCommand);
    invoke();
    expectExpectedSingleCall(type);
});
```

测试 `close-active` 对 Agent 为 no-op，对 Top Tab 调 `closeTopTab`，对 Terminal 调 Terminal command adapter；本阶段 Terminal adapter 是可注入 fake。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-command-router.test.ts
```

Expected: FAIL，router 不存在。

- [ ] **Step 3: 定义最小 command union 并实现 router**

```ts
type WorkspaceCommand =
    | { type: "activate-agent" }
    | { type: "activate-terminal"; terminalTabId: string }
    | { type: "activate-top-tab"; topTabId: string }
    | { type: "new-terminal" }
    | { type: "close-active" }
    | { type: "next-content" }
    | { type: "previous-content" };
```

Electron menu/shortcut 只把 command 发送给该 window 的 WorkspaceView。Workspace Renderer 是唯一 dispatch owner；Terminal Renderer 收到快捷键时，在 Phase 2 将 workspace-level command 转发给 main。

- [ ] **Step 4: 运行测试**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-command-router.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add frontend/types/custom.d.ts emain/preload.ts emain/emain-ipc.ts frontend/preview/mock/preview-electron-api.ts frontend/app/workspace/workspace-command-router.ts frontend/app/workspace/workspace-command-router.test.ts
git commit -m "feat: route workspace navigation commands"
```

## Task 10：Phase 1 集成验证

**Files:**

- Modify: `frontend/app/workspace/workspace-app.test.tsx`
- Modify: `emain/emain-workspaceview.test.ts`
- Modify: `docs/superpowers/specs/2026-07-23-workspace-tab-architecture-design.md`

- [ ] **Step 1: 增加 renderer identity 回归测试**

在 fake Electron integration 中记录 workspace webContents ID：

```ts
const workspaceId = window.workspaceView.webContents.id;
await activateMock("agent");
await activateMock("file-1");
await activateMock("browser-1");
expect(window.workspaceView.webContents.id).toBe(workspaceId);
expect(createdWorkspaceViews).toHaveLength(1);
```

- [ ] **Step 2: 运行 Phase 1 自动化测试**

Run:

```bash
go test ./pkg/service/workspaceservice ./pkg/wcore -count=1
npx vitest run \
  emain/emain-workspaceview.test.ts \
  frontend/app/store/wshrouter.test.ts \
  frontend/app/store/global-atoms.test.ts \
  frontend/app/workspace/workspace-content-state.test.ts \
  frontend/app/workspace/workspace-model.test.ts \
  frontend/app/workspace/workspace-layout-model.test.ts \
  frontend/app/workspace/workspace-command-router.test.ts \
  frontend/app/workspace/workspace-app.test.tsx \
  frontend/app/topbar/topbar.test.tsx
npx tsc --noEmit
git diff --check
```

Expected: 全部 PASS，`git diff --check` 无输出。

- [ ] **Step 3: 手工验证**

Run:

```bash
npm run dev
```

验证：

1. window 打开后只创建一个 Workspace Renderer；
2. Agent、Terminal mock、多个 Top Tab mock 切换时 `webContents.id` 不变；
3. TopBar、StatusBar、左侧 Panel 不卸载或闪白；
4. Files/Agent/Terminal 按钮只显示一个共享左侧 Panel，再点当前按钮收起；
5. 调整左侧宽度，切换三种 mode 后宽度不变，重启后恢复；
6. checkpoint 保存失败时 UI 仍可切换，恢复连接后 flush 成功；
7. 关闭 window 后 WorkspaceView registry 没有残留。

- [ ] **Step 4: 更新架构文档状态**

Phase 1 验收通过后，将总设计的状态改为“Phase 1 complete”，并记录实际 checkpoint RPC、Workspace route 和 renderer init 名称；若实现名与本文不同，先统一代码和计划，不保留两套术语。

- [ ] **Step 5: 提交**

```bash
git add frontend/app/workspace/workspace-app.test.tsx emain/emain-workspaceview.test.ts docs/superpowers/specs/2026-07-23-workspace-tab-architecture-design.md
git commit -m "test: verify persistent workspace renderer"
```

## Phase 1 完成标准

- 每个普通 Crest window 恰好存在一个 Workspace Renderer。
- Agent、Terminal mock、File mock、Browser mock 切换期间 Workspace `webContents.id` 不变。
- Workspace Renderer 初始化不依赖 `tabId`、`staticTabId`、`TabModelContext` 或 `LayoutModel`。
- `ActiveContent` 三个分支只能有一个 active。
- Files/Sessions/Terminals 共用一个左侧 Panel state、宽度和 resize handle。
- TopBar 保留 Files/Agent 并新增 Terminal 按钮。
- content state 与 `activeTerminalTabId` 使用同一 revision checkpoint。
- stale revision 不能覆盖较新的 workspace checkpoint。
- 非法 descriptor 独立丢弃，恢复 fallback 为 last Top Tab、Terminal、Agent。
- 所列 Go、Vitest、TypeScript 检查全部通过。

## 后续计划边界

- Phase 2：`TerminalApp`、Terminal-only `WaveTabView`、中央 bounds/z-order/focus、`VTabBar` 专门化为 `TerminalTabList`。
- Phase 3：`AgentContent` 接入 Workspace、移除 Agent Tab/Block、增加 workspace-level `AgentExecutionContext`。
- Phase 4：真实 File/Browser/Preview/Diff runtime、Top Tab 恢复、Browser LRU、删除旧混合 Tab 路径。
