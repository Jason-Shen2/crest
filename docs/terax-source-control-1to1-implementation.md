# Terax Source Control + Commit Graph 1:1 复现实现方案

**日期**: 2026-07-03  
**目标**: 1:1 复现 terax-ai 的 Source Control 和 Commit Graph 功能到 crest，每个改动均标注 terax 参考文件和 crest 对应改动文件

---

## 一、总体架构映射

| 层级 | terax 实现 | crest 对应实现 |
|------|------------|----------------|
| **后端 Git 服务** | Tauri Rust 命令层，封装 git CLI 调用 | Go wsh RPC 命令层，新增 `pkg/gitops/` 模块封装 git CLI |
| **类型定义** | Rust `types.rs` | Go `pkg/wshrpc/wshrpctypes.go` + 生成的 TS 类型 |
| **Source Control 面板** | React 面板组件 + hooks | 替换现有 codereview 面板，新增 `frontend/app/sourcecontrol/` 模块 |
| **Commit Graph** | 独立 tab，SVG graph rail + 虚拟列表 | 新增右侧工具 tab 或新的 view 类型，新增 `frontend/app/githistory/` 模块 |
| **Diff 视图** | CodeMirror merge view 组件 | 替换现有 shiki 渲染的 diff，采用 CodeMirror merge |
| **状态管理** | Zustand + React hooks | Jotai singleton model，遵循 crest 现有 model 模式 |

---

## 二、分阶段实现清单（每个改动对应参考文件）

### 阶段 1: 后端 Go GitOps 模块 + 新增 RPC 命令

**terax 参考文件**:
- [commands.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/commands.rs#L24-L311) - Tauri 命令层注册
- [operations.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/operations.rs#L22-L1148) - 所有 git 操作实现
- [parser.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/parser.rs#L13-L67) - porcelain v2 解析器
- [types.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/types.rs#L10-L132) - Git 数据类型
- [process.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/process.rs#L53-L91) - Git 进程封装与版本检查
- [utils.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/utils.rs#L53-L94) - 路径安全校验与仓库授权
- [errors.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/errors.rs) - Git 错误类型

**crest 改动文件**:

1. **新建** `pkg/gitops/gitops.go` - Git 操作核心实现
   - 参考: [operations.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/operations.rs)
   - 实现所有 git 命令：resolveRepo、panelSnapshot、status、diff、stage、unstage、discard、commit、fetch、pullFfOnly、push、log、showCommit、commitFiles、commitFileDiff、remoteUrl、listBranches、checkoutBranch

2. **新建** `pkg/gitops/parser.go` - porcelain v2 解析器
   - 参考: [parser.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/parser.rs)
   - 解析 `git status --porcelain=v2 --branch -z` 输出
   - 解析 `git log --shortstat` 输出
   - 解析 `git diff-tree --name-status --numstat -z` 输出

3. **新建** `pkg/gitops/types.go` - Go 侧 Git 数据类型
   - 参考: [types.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/types.rs)
   - 定义所有 RPC 请求/响应结构体，JSON tag 全部小写无下划线（遵循 crest 规范）

4. **新建** `pkg/gitops/process.go` - Git 进程封装
   - 参考: [process.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/process.rs)
   - git 可用性检查、最低版本要求、命令执行、超时处理、输出截断

5. **新建** `pkg/gitops/utils.go` - 工具函数
   - 参考: [utils.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/utils.rs)
   - 仓库 root 解析、路径安全校验、pathspec 解析、cwd 规范化

6. **新建** `pkg/gitops/errors.go` - 错误类型
   - 参考: [errors.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/errors.rs)
   - 定义所有 Git 相关错误类型：路径越权、无上游分支、空提交信息、超时、二进制文件等

7. **修改** [wshrpctypes.go](file:///Users/bytedance/Documents/crest/pkg/wshrpc/wshrpctypes.go#L37-L219) - RPC 接口定义
   - 参考: [native.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/ai/lib/native.ts#L261-L384)
   - 新增以下 Command 方法（全部以 Command 结尾）:
     - `GitPanelSnapshotCommand(ctx context.Context, cwd string) (*GitPanelSnapshotResponse, error)`
     - `GitStatusCommand(ctx context.Context, repoRoot string) (*GitStatusSnapshotResponse, error)`
     - `GitDiffCommand(ctx context.Context, data GitDiffData) (*GitDiffResultResponse, error)`
     - `GitDiffContentCommand(ctx context.Context, data GitDiffContentData) (*GitDiffContentResultResponse, error)`
     - `GitStageCommand(ctx context.Context, data GitStageData) error`
     - `GitUnstageCommand(ctx context.Context, data GitStageData) error`
     - `GitDiscardCommand(ctx context.Context, data GitDiscardData) error`
     - `GitCommitCommand(ctx context.Context, data GitCommitData) (*GitCommitResultResponse, error)`
     - `GitFetchCommand(ctx context.Context, repoRoot string) error`
     - `GitPullFfOnlyCommand(ctx context.Context, repoRoot string) error`
     - `GitPushCommand(ctx context.Context, repoRoot string) (*GitPushResultResponse, error)`
     - `GitLogCommand(ctx context.Context, data GitLogData) ([]GitLogEntryResponse, error)`
     - `GitShowCommitCommand(ctx context.Context, data GitShowCommitData) (*GitDiffResultResponse, error)`
     - `GitCommitFilesCommand(ctx context.Context, data GitCommitFilesData) ([]GitCommitFileChangeResponse, error)`
     - `GitCommitFileDiffCommand(ctx context.Context, data GitCommitFileDiffData) (*GitDiffContentResultResponse, error)`
     - `GitRemoteUrlCommand(ctx context.Context, data GitRemoteUrlData) (*string, error)`
     - `GitListBranchesCommand(ctx context.Context, repoRoot string) (*GitBranchListResultResponse, error)`
     - `GitCheckoutBranchCommand(ctx context.Context, data GitCheckoutBranchData) error`
   - 同时在文件下方新增对应 Data 和 Response 结构体

8. **修改** [wshserver.go](file:///Users/bytedance/Documents/crest/pkg/wshrpc/wshserver/wshserver.go#L1607-L1668) - RPC 实现
   - 参考: [commands.rs](file:///Users/bytedance/Documents/terax-ai/src-tauri/src/modules/git/commands.rs#L24-L311)
   - 实现上述所有新增 Command 方法，每个方法调用 pkg/gitops 对应函数
   - 保留现有 `RunLocalCmdCommand` 和 `GetGitInfoCommand` 用于兼容（状态栏仍可使用轻量的 GetGitInfo）

9. **运行** `task generate` 生成 TypeScript 绑定
   - 参考: [add-rpc/SKILL.md](file:///Users/bytedance/Documents/crest/.kilocode/skills/add-rpc/SKILL.md#L80-L93)
   - 更新 `frontend/types/gotypes.d.ts` 和 `frontend/app/store/wshclientapi.ts`

---

### 阶段 2: Source Control 前端模块

**terax 参考文件**:
- [SourceControlPanel.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/source-control/SourceControlPanel.tsx#L344-L998) - 主面板 UI
- [useSourceControl.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/source-control/useSourceControl.ts#L149-L496) - 仓库状态加载与刷新 hook
- [useSourceControlPanel.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/source-control/useSourceControlPanel.ts#L356-L1029) - 面板业务逻辑（stage/unstage/commit/push 等）
- [useSourceControlContext.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/source-control/useSourceControlContext.ts#L31-L110) - 仓库上下文解析（根据当前 cwd/tab）
- [index.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/source-control/index.ts#L1-L7) - 模块出口
- [SidebarRail.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/sidebar/SidebarRail.tsx#L21-L72) - 侧栏入口与 badge

**crest 改动文件**:

1. **新建** `frontend/app/sourcecontrol/source-control-model.ts` - Jotai singleton model
   - 参考: [useSourceControl.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/source-control/useSourceControl.ts) + [git-model.ts](file:///Users/bytedance/Documents/crest/frontend/app/codereview/git-model.ts#L138-L553)（遵循现有 model 模式）
   - 按 crest 规范实现 singleton `SourceControlModel`，使用 Jotai atoms
   - Atoms: repoAtom、statusAtom、isLoadingAtom、localErrorAtom、busyActionAtom、lastRemoteErrorAtom、commitMessageAtom
   - 方法: refresh()、runRemoteAction()、stage()、unstage()、discard()、commit()、fetch()、pull()、push()
   - 自动刷新逻辑：使用 Electron `watchDir` 监听 `.git` 和 cwd 变化（复用现有模式）
   - TTL、请求去重、auto-fetch throttle 对齐 terax 逻辑

2. **新建** `frontend/app/sourcecontrol/source-control-panel.tsx` - Source Control 主面板
   - 参考: [SourceControlPanel.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/source-control/SourceControlPanel.tsx)
   - 1:1 实现 UI 结构：header（分支选择、fetch/pull/push/refresh按钮）、commit message 输入框、变更虚拟列表（staged/unstaged 分组）
   - 使用 `@tanstack/react-virtual`（crest 已在依赖中）渲染长列表
   - 右键菜单：使用 crest 现有 ContextMenuModel 实现
   - 入口按钮：添加 "Commit Graph" 按钮打开历史视图
   - 样式：使用 Tailwind v4，对齐 crest 现有设计系统

3. **新建** `frontend/app/sourcecontrol/source-control-context.ts` - 仓库上下文解析
   - 参考: [useSourceControlContext.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/source-control/useSourceControlContext.ts)
   - 从 `focusedCwdAtom` 获取当前 cwd，解析 repo root，提供给面板使用

4. **新建** `frontend/app/sourcecontrol/index.ts` - 模块出口

5. **修改** [right-tool-panel.tsx](file:///Users/bytedance/Documents/crest/frontend/app/workspace/right-tool-panel.tsx#L32-L53) - 替换 Code Review 为 Source Control
   - 参考: [SidebarRail.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/sidebar/SidebarRail.tsx)
   - 将 `codeReview` 工具 id 重命名为 `sourceControl`，icon 保持 `git-branch-01`
   - 渲染组件替换为 `SourceControlPanel`
   - badge 显示 changedCount（从 SourceControlModel 获取）
   - 移除/废弃旧 `GitReviewSidebar`

6. **废弃** `frontend/app/codereview/` 目录下的旧文件
   - 可先保留文件但不引用，后续清理
   - 旧 [git-model.ts](file:///Users/bytedance/Documents/crest/frontend/app/codereview/git-model.ts) 逻辑迁移到新的 source-control-model

---

### 阶段 3: Commit Graph (Git History) 前端模块

**terax 参考文件**:
- [GitHistoryPane.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/git-history/GitHistoryPane.tsx#L192-L677) - 历史面板主组件
- [graph.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/git-history/lib/graph.ts#L1-L200) - Lane 图布局算法（纯函数，可直接移植）
- [GraphRail.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/git-history/GraphRail.tsx#L99-L155) - SVG 图轨渲染
- [GitHistoryStack.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/git-history/GitHistoryStack.tsx#L20-L38) - 历史 tab stack
- [remoteWebUrl.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/git-history/lib/remoteWebUrl.ts#L20-L82) - 远端 web URL 解析（GitHub/GitLab/Bitbucket）
- [index.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/git-history/index.ts) - 模块出口
- [commands.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/command-palette/commands.ts#L213-L219) - 命令面板注册

**crest 改动文件**:

1. **新建** `frontend/app/githistory/lib/graph.ts` - 图布局算法（直接移植，仅调整类型引用）
   - 参考: [graph.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/git-history/lib/graph.ts)
   - 纯 TS 函数，无依赖，几乎可以 1:1 复制，仅将 GitLogEntry 类型改为 crest 生成的类型

2. **新建** `frontend/app/githistory/lib/remote-web-url.ts` - 远端 URL 解析
   - 参考: [remoteWebUrl.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/git-history/lib/remoteWebUrl.ts)
   - 解析 GitHub/GitLab/Bitbucket remote，生成 commit/file web 链接

3. **新建** `frontend/app/githistory/graph-rail.tsx` - SVG graph rail 组件
   - 参考: [GraphRail.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/git-history/GraphRail.tsx)
   - 1:1 实现 SVG 渲染：直线、merge 贝塞尔曲线、branch 贝塞尔曲线、commit 节点
   - 颜色使用 crest 主题色变量，LANE_COLORS 可以微调匹配 crest 调色板

4. **新建** `frontend/app/githistory/git-history-model.ts` - Jotai model
   - 参考: [GitHistoryPane.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/git-history/GitHistoryPane.tsx#L197-L451) 中的状态逻辑
   - Atoms: commitsAtom、loadStatusAtom、errorAtom、endReachedAtom、searchQueryAtom
   - 方法: loadInitial()、loadMore()、fetchCommitFiles()、refresh()
   - 缓存逻辑：graph layout 缓存、commit files LRU 缓存对齐 terax

5. **新建** `frontend/app/githistory/git-history-pane.tsx` - 历史面板主组件
   - 参考: [GitHistoryPane.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/git-history/GitHistoryPane.tsx)
   - 1:1 实现：
     - 顶部搜索栏
     - 虚拟列表（@tanstack/react-virtual）
     - 每一行：GraphRail + short sha + author + 相对时间 + commit message + +/- stats
     - 点击行打开 popover 显示该 commit 的文件变更列表
     - 文件点击打开该提交的文件 diff
     - 无限滚动加载更多
     - 空状态/加载状态/错误状态

6. **修改** 右侧工具面板 - 新增 Git History 工具入口，或在 Source Control 面板中点击按钮时动态打开
   - 参考: [SourceControlPanel.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/source-control/SourceControlPanel.tsx#L720-L740) 的 Open Git Graph 按钮
   - 方案：在右侧工具面板新增 `gitHistory` 工具，Source Control 面板的 "Commit Graph" 按钮点击时切换到该工具
   - 修改 [right-tool-panel-state.ts](file:///Users/bytedance/Documents/crest/frontend/app/workspace/right-tool-panel-state.ts) 新增 RightToolId

7. **新建** `frontend/app/githistory/index.ts` - 模块出口

---

### 阶段 4: Git Diff 视图（CodeMirror Merge View）

**terax 参考文件**:
- [GitDiffPane.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/editor/GitDiffPane.tsx#L127-L324) - Diff 面板，使用 CodeMirror merge view
- [GitDiffStack.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/editor/GitDiffStack.tsx#L13-L53) - Diff tab stack

**crest 改动文件**:

1. **添加依赖** `@codemirror/merge` 和 `@codemirror/view`、`@codemirror/state`、`@codemirror/language`
   - 注意：terax 使用 CodeMirror 6 做 diff 渲染，crest 现有 diff 使用 shiki 直接渲染 HTML，需要切换
   - 如果 crest 已有 CodeMirror 相关依赖（检查现有 monaco 之外的编辑器依赖），补齐缺失的即可

2. **新建** `frontend/app/gitdiff/git-diff-pane.tsx` - CodeMirror merge diff 组件
   - 参考: [GitDiffPane.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/editor/GitDiffPane.tsx)
   - 支持 working tree diff（staged/unstaged）和 commit diff 两种模式
   - 二进制文件/大文件 fallback 到 patch 文本显示
   - 重命名文件显示 originalPath

3. **新建** `frontend/app/gitdiff/git-diff-stack.tsx` - Diff 栈组件（支持在右侧工具中打开）
   - 参考: [GitDiffStack.tsx](file:///Users/bytedance/Documents/terax-ai/src/modules/editor/GitDiffStack.tsx)
   - Source Control 点击文件时打开 diff 视图
   - Commit Graph 点击文件时打开 commit 级 diff

4. 集成到 Source Control 和 Git History 面板的文件点击回调中

---

### 阶段 5: 上下文解析与自动刷新

**terax 参考文件**:
- [useSourceControlContext.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/source-control/useSourceControlContext.ts)
- 监听 focus/visibility 变化自动刷新
- TTL 缓存与请求去重

**crest 改动文件**:

1. **修改** `frontend/app/sourcecontrol/source-control-model.ts` 集成自动刷新
   - 复用现有 Electron `watchDir` API（监听 `.git` 目录和工作区根目录），参考现有 [git-model.ts#L186-L213](file:///Users/bytedance/Documents/crest/frontend/app/codereview/git-model.ts#L186-L213) 的模式
   - 窗口 focus 时延迟刷新（对齐 terax 400ms debounce）
   - 实现 inflight 请求去重，避免重复刷新
   - auto-fetch 节流：仅当上游存在且距离上次 fetch 超过阈值时自动 fetch

2. **修改** cwd 同步逻辑：当 focusedCwdAtom 变化时，重新解析 repo root，重置状态

---

### 阶段 6: 命令面板集成（可选，对齐 terax 体验）

**terax 参考文件**:
- [commands.ts](file:///Users/bytedance/Documents/terax-ai/src/modules/command-palette/commands.ts#L213-L219) - 注册 `git.graph` 命令

**crest 改动文件**:
- 如果 crest 已有命令面板/omnibar，新增：
  - `Source Control: Open` 命令
  - `Source Control: Commit Graph` 命令
  - `Source Control: Refresh` 命令
  - `Source Control: Pull` / `Push` 命令

---

## 三、文件清单总览

### 新增文件

**后端 (Go)**:
- `pkg/gitops/gitops.go`
- `pkg/gitops/parser.go`
- `pkg/gitops/types.go`
- `pkg/gitops/process.go`
- `pkg/gitops/utils.go`
- `pkg/gitops/errors.go`

**前端 Source Control**:
- `frontend/app/sourcecontrol/source-control-model.ts`
- `frontend/app/sourcecontrol/source-control-panel.tsx`
- `frontend/app/sourcecontrol/source-control-context.ts`
- `frontend/app/sourcecontrol/index.ts`

**前端 Git History**:
- `frontend/app/githistory/lib/graph.ts`
- `frontend/app/githistory/lib/remote-web-url.ts`
- `frontend/app/githistory/graph-rail.tsx`
- `frontend/app/githistory/git-history-model.ts`
- `frontend/app/githistory/git-history-pane.tsx`
- `frontend/app/githistory/index.ts`

**前端 Git Diff**:
- `frontend/app/gitdiff/git-diff-pane.tsx`
- `frontend/app/gitdiff/git-diff-stack.tsx`
- `frontend/app/gitdiff/index.ts`

### 修改文件

- `pkg/wshrpc/wshrpctypes.go` - 新增所有 Git RPC 定义和类型
- `pkg/wshrpc/wshserver/wshserver.go` - 实现所有 Git RPC
- `frontend/app/workspace/right-tool-panel.tsx` - 替换 codeReview 为 sourceControl，新增 gitHistory 入口
- `frontend/app/workspace/right-tool-panel-state.ts` - 新增 RightToolId 类型
- `package.json` - 添加 @codemirror/merge 等依赖（如需要）
- 运行 `task generate` 自动更新生成的 TS 类型文件

### 废弃/清理文件（后续阶段）
- `frontend/app/codereview/git-model.ts` - 被 source-control-model 替代
- `frontend/app/codereview/git-panel.tsx` - 被 source-control-panel 替代
- `frontend/app/codereview/` 下其他旧文件

---

## 四、实现顺序建议（最小可用路径）

1. **第一步**: 先做后端 `pkg/gitops/` 模块 + 3 个核心 RPC (`GitPanelSnapshotCommand`、`GitStatusCommand`、`GitLogCommand`)，跑通数据获取
2. **第二步**: 移植 `graph.ts` + `GraphRail.tsx`，做一个纯前端的 Commit Graph 静态 demo
3. **第三步**: 实现 Git History 面板对接真实 RPC，完成无限滚动和搜索
4. **第四步**: 实现 Source Control 面板的只读状态展示，对接 GitPanelSnapshot
5. **第五步**: 实现 stage/unstage/discard/commit 等 mutation RPC 和前端乐观更新
6. **第六步**: 实现 fetch/pull/push 远端操作
7. **第七步**: 替换 diff 为 CodeMirror merge view，对接 commit diff 和 working diff
8. **第八步**: 自动刷新、watchDir、上下文解析、badge 更新
9. **第九步**: 命令面板集成、快捷键、右键菜单等交互细节
10. **第十步**: 清理旧 codereview 代码，移除废弃功能

---

## 五、对齐 terax 细节 checklist

- [ ] 状态解析使用 `git status --porcelain=v2 --branch -z` 正确处理重命名、未合并、未跟踪文件
- [ ] Commit graph 使用 lane 布局算法，支持分页加载时保持 lane 颜色稳定
- [ ] Graph rail SVG 正确渲染 merge/branch 贝塞尔曲线
- [ ] 乐观更新：stage/unstage/discard 后立即更新 UI，失败回滚
- [ ] 请求去重：同一时间只有一个 refresh 请求，支持升级 inflight 请求的 remote 模式
- [ ] Auto-fetch LRU 缓存，按 repo root 节流
- [ ] 虚拟列表使用 @tanstack/react-virtual，overscan 合理设置
- [ ] Commit files popover 有 LRU 缓存，避免重复请求
- [ ] 远端操作正确处理 no-upstream、behind、diverged 状态
- [ ] Discard 操作区分 untracked（直接删除）和 tracked（checkout --）
- [ ] Commit message 为空时禁用提交按钮
- [ ] 大 diff / 二进制文件有 fallback 处理
- [ ] 路径安全校验：所有 repo root 和 path 都要校验在授权工作区内
- [ ] 超时处理：本地操作短超时，网络操作长超时，超时返回明确错误
- [ ] 输出截断：git 命令输出限制大小，避免大 diff 撑爆内存
