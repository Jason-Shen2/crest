# Agent Rewind Diff Preview 设计

日期：2026-08-01
状态：已确认

## 与原设计的关系

本文是
[`2026-07-28-agent-workspace-rewind-design.md`](./2026-07-28-agent-workspace-rewind-design.md)
中 “Shared Revert Preview and Force Revert” 的 UI 与预览内容补充设计。

原设计已经要求预览展示每个有效文件操作和支持文件的可展开 diff；安全模型、
checkpoint 格式、确认 token、冲突分类、Force Revert、Redo 和多 Session 隔离均不变。
本文修复实现与该要求之间的缺口，并记录已经确认的双栏布局。后续
[`2026-08-02-agent-turn-file-changes-design.md`](./2026-08-02-agent-turn-file-changes-design.md)
将该布局命名为纯展示组件 `DiffReviewDialog`，并扩展给 Turn Review、Turn Undo 和 Turn Redo
复用；本文其余 Revert/Redo 方向和安全语义不变。

## 问题

当前 `AgentRewindFileRowView` 虽然定义了 `additions`、`deletions` 和 `diff`，但
`WorkspaceRewindEngine.fileRows()` 只映射路径、操作、覆盖状态与冲突，未生成实际
diff。renderer 因而只能显示类似 `WRITE README.md / covered` 的元数据，用户看不到
Revert 将执行的内容变化。

现有弹窗还存在以下视觉问题：

- prompt 和 message count 抢占主要视觉层级；
- 文件行尺寸过大，且使用了与 Git Diff 不一致的自定义样式；
- `covered` 是内部安全状态，正常路径无需暴露；
- diff 即使由后端提供，也隐藏在单文件行的二级 `Show diff` 入口后。

## 目标

- 用户点击消息侧 `Revert` 或通过 `/rewind` 选择目标后，直接看到 Revert 将执行的
  反向文件 diff。
- 使用双栏审阅布局：左侧文件导航，右侧当前文件 diff。
- 左侧视觉与交互参考现有 Git Diff 文件栏，不另造一套设计语言。
- 最大化复用现有 `Dialog`、`Button`、`DiffViewer`、`FileCard`、`getFileIcon` 和主题
  token。
- 保留原有冲突、Force Revert、硬阻断、确认 token 和 apply 重算语义。

## 非目标

- 不迁移历史 Session 或补造历史 checkpoint。
- 不改变 checkpoint 或 workspace-state 的持久化格式。
- 不改变 Rewind/Redo 的路径集合、冲突判定或多 Session 隔离模型。
- 不把 Code Review 的 Git 专用 sidebar 整体抽成通用框架。
- 不为二进制、大文件、目录或其他不支持的类型伪造文本 diff。
- 不在本次实现 rename 检测；现有 restore plan 仍以 create/write/delete 为准。

## 反向 Diff 语义

preview 展示的是即将执行的 Revert 方向，而不是 Agent 当时写入文件的正向 patch。

对每个 `RestorePathPlanV1`：

- diff 的旧侧是 `expectedCurrent`，即该 Session 最后确认写入后的状态；
- diff 的新侧是 `target`，即回退目标 checkpoint 中要恢复的状态；
- `create` 表示 Revert 将恢复一个当前应不存在的文件，左栏状态为 `A`；
- `write` 表示 Revert 将用旧内容替换当前预期内容，左栏状态为 `M`；
- `delete` 表示 Revert 将删除该 Session 创建的文件，左栏状态为 `D`；
- additions/deletions 同样按 Revert 方向计算。

在无冲突路径上，live state 已被 plan 验证为等于 `expectedCurrent`，因此该 diff 就是
实际将发生的文件变化。

对于 `forceable-drift`，磁盘内容已不再等于 `expectedCurrent`。右侧仍展示该 Session
原本要撤销的反向 diff，但必须同时显示红色冲突状态和精确警告：
`files changed on disk since the agent last wrote them`。该 diff 不声称包含其他 Session
或人工修改；用户只能通过明确的 `Force revert` 覆盖冲突路径。apply 前仍重新计算 plan
并校验确认 token，因此预览内容不参与授权。

## Diff 生成

`WorkspaceRewindEngine.preview()` 在 restore plan 完成后，为每个 path 构建展示行：

1. 从 `WorkspaceSnapshotStore.readBlob()` 读取 `expectedCurrent` 与 `target` 引用的 blob；
   `absent` 映射为空内容。
2. 仅当两侧都是 absent 或普通文本文件时生成 unified patch。
3. 文本采用严格 UTF-8 解码；包含 NUL、UTF-8 解码失败、symlink、excluded 或其他不支持
   状态时，不生成 patch，并返回简短的 `previewUnavailableReason`。
4. 单侧文本超过 1 MiB，或加入该文件会使一次 preview 的文本输入总量超过 8 MiB 时，
   不再生成该文件 diff。Revert 本身仍可继续；限制只保护 renderer/IPC。
5. 使用仓库现有 `diff` 依赖生成 unified patch 和反向 additions/deletions。
6. 单个文件的 diff 生成失败只影响该展示行，不改变 restore plan、confirmation token 或
   apply 能力。

`fileRows()` 改为异步的 display enrichment；它不写 snapshot、journal、Session 或工作区。
确认仍只签发并校验 restore plan，diff 文本不是安全协议的一部分。

## 双栏 UI

### `DiffReviewDialog`

- 提取纯展示组件 `DiffReviewDialog`，由 conversation Revert/Redo controller 提供数据、状态
  和 footer actions；组件本身不调用 IPC 或理解 mutation 语义。
- 使用现有 shadcn `Dialog`、`DialogContent`、`DialogHeader`、`DialogFooter` 与 `Button`。
- 标题为 `Revert changes?` 或 `Redo changes?`。
- 描述只说明 `Review the file changes that will be reverted.`，不重复展示 target prompt、
  message count 或 `Conversation` 卡片。
- 弹窗使用大尺寸审阅布局，主体具有稳定高度；header/footer 固定，文件区域独立滚动。

### 左侧文件栏

左栏参考 `frontend/app/codereview/git-panel.tsx` 的 `FileSidebar`：

- header 使用 `Changed files` 和计数 pill；
- 每行使用 `getFileIcon()`、文件 basename、可选目录、Revert 方向统计和 `A/M/D` 状态；
- 使用 Git Diff 相同的紧凑行高、hover、选中边框、背景和主题 token；
- 默认选择第一项，点击切换右侧 diff；
- forceable conflict 行使用 destructive/red 变体；hard blocker 同样显示阻断状态；
- 不显示 `Restore previous content`、`covered` 或大面积 accent 描边；
- 固定宽度即可，不复用 Git Diff 的拖拽 resize，因为 modal 无需保存 sidebar 宽度。

Git Diff 的 `FileSidebar` 目前是 `git-panel.tsx` 内部函数，依赖 `GitChangedFile`、Git status、
resize 与面板状态。本次不直接抽取它，以免为一个小列表扩大 Code Review 改动面。新增的
`RewindFileList` 只实现文件选择，视觉 class 和 `getFileIcon` 与 Git Diff 对齐。

### 右侧 Diff

- 直接使用现有 `DiffViewer patch={selected.diff}`；它内部继续使用 OpenCode 风格的
  `FileCard`、Pierre diff、行号、语法高亮、bar indicators 和折叠行为。
- 选中文本文件时默认展开反向 diff。
- 无文本 diff 时显示现有文件 header 和明确原因，例如 `Binary file preview unavailable`、
  `File is too large to preview` 或 `Symlink preview unavailable`，不显示假的空 diff。
- conflict 时在 diff 上方显示红色 canonical warning。
- coverage warning 和 hard blocker 在右侧状态区显示，不恢复 `covered` 标签。

### Footer

- 左侧说明 `Red will be removed · Green will be restored`。
- clean Rewind：`Cancel` + `Revert N files`。
- forceable conflict：`Cancel` + destructive `Force revert`；不显示普通 Revert。
- hard blocker：只显示 `Cancel`。
- Redo：沿用原设计，发生 drift 时阻断且不提供 Force Redo。

### 无文件变化

当 conversation rewind 不会修改工作区时，不显示空的双栏。主体显示简洁 empty state：
`No workspace files will change.`；确认按钮仍可执行 conversation rewind。该状态不重新加入
prompt 或 message count。

## 数据流

1. 消息侧 `Revert` 或 `/rewind` 选择 turn。
2. renderer 调用现有 `agent:preview-rewind`。
3. engine 在 workspace lock 下计算权威 restore plan。
4. engine 从 plan 的 `expectedCurrent -> target` 生成非权威 display diff rows。
5. renderer 打开双栏 dialog，左侧选择文件，右侧渲染 `DiffViewer`。
6. 用户确认后提交原 confirmation token；backend 在 mutation lease 与 workspace lock 下重新
   计算 plan，检查 leaf、workspace incarnation、冲突集合和 live fingerprints。
7. apply、Redo marker、prompt restoration 和 session navigation 均沿用现有实现。

## 错误与安全语义

- 生成 diff 失败不能降低或绕过 hard blocker，也不能创建 Force 权限。
- diff 缺失不能阻止本来安全的 Revert；用户仍能根据文件路径与操作类型确认。
- renderer 只消费 backend display rows，不能提交或修改 restore path 集合。
- conflict 的 canonical warning 必须保留原精确文案。
- confirmation token 不包含 diff 文本，避免显示限制或格式变化影响安全协议。
- apply 继续重新计算 plan；preview 与确认之间的任何磁盘漂移都会使确认失效或重新分类。

## 测试

### Backend

- `write` diff 验证旧侧为 expected current、新侧为 checkpoint target，即反向 patch。
- `create` 和 `delete` 验证 Revert 方向的内容、统计及 `A/D` 状态。
- 多 turn 合并后的 plan 只为最终有效 path 生成一次 diff。
- 二进制、非法 UTF-8、symlink、excluded、单文件超限和总预算超限均返回可解释的无 diff 行。
- 单文件 blob/diff 失败不改变 confirmation 与 apply 能力。
- forceable conflict 保留反向 Agent diff，同时返回 canonical red warning。
- Redo 使用同一 enrichment，但方向为当前 rewind state 到 redo target。

### Renderer

- 不再渲染 target prompt、message count、`Conversation` 或 `covered`。
- 左栏呈现 Git Diff 风格 header、计数、文件图标、basename/dir、统计与 `A/M/D`。
- 默认选择第一项；点击另一文件只切换右侧 diff，不重新请求 preview。
- `DiffViewer` 收到所选文件的 backend patch。
- conflict 行与 warning 标红，footer 只显示 `Force revert`。
- hard blocker 只显示 `Cancel`。
- 空文件集合显示 empty state。

### E2E

- 创建真实 checkpoint，点击消息侧 Revert，断言预览中出现实际反向删除/恢复内容。
- 从 `/rewind` 打开同一 turn，断言得到相同文件集合与 diff。
- 确认后验证文件字节、conversation leaf、composer prompt 与 Redo dock。
- 两 Session 重叠修改继续验证普通 Revert 不覆盖 drift；Force Revert 仅处理预览标红路径。

## 验收标准

- 用户无需展开二级元数据行即可看到所选文件的反向 diff。
- clean path 的预览内容与实际 Revert 后字节一致。
- 左侧文件栏在密度、图标、选中态和统计上与 Git Diff 一致。
- 正常预览不显示 `covered`、target prompt 或 conversation summary。
- 所有原有安全、冲突、Redo 与多 Session 测试继续通过。
