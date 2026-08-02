# Markdown File Tab Preview Design

日期：2026-08-02
状态：已完成交互确认，待用户复核书面设计

## 背景

Workspace file tab 当前统一由 `FileTopTab` 渲染为 Monaco 编辑器。仓库已经有成熟的
`Markdown` 组件，支持 GFM、代码高亮、Mermaid、目录锚点、安全的 HTML 清洗以及相对
图片解析，但这套渲染能力尚未接入 workspace file tab。

本设计让 `.md` 文件在原有 file tab 内默认显示 Markdown 预览，同时保留源码编辑能力。

## 用户体验

- 打开扩展名为 `.md` 的文件时，tab 默认进入 `Preview` 模式。
- 文件内容区顶部显示 `Preview / Edit` 模式切换；其他文件不显示该控件。
- `Preview` 使用现有 Crest Markdown 样式渲染当前编辑缓冲区。
- `Edit` 使用当前 Monaco 编辑器，不改变编辑、dirty、保存、关闭确认或 view state 行为。
- 在 `Edit` 中产生未保存修改后切回 `Preview`，预览显示最新的内存内容，无需先保存。
- 切换到其他 tab 再返回时，当前 file tab 保留自己的模式；关闭并重新打开 `.md` 文件后
  再次默认进入 `Preview`。
- 文件被迁移或重命名为非 Markdown 扩展名时自动回到普通编辑器；从非 Markdown 变为
  `.md` 时进入默认预览。

第一版只识别大小写不敏感的 `.md` 扩展名，不扩展到 `.markdown`、MDX 或其他 Markdown
变体。

## 方案比较

### 采用：单 file runtime、双视图

`FileTopTab` 继续持有同一个 `WorkspaceFileRuntime`，仅在展示层切换 `Markdown` 与
`CodeEditor`。`runtime.value` 是两种视图唯一的数据源。

优点：不改变 tab 模型、RPC 或持久化格式；dirty/save/rename/delete 行为天然共享；切换
成本小且符合“同一个文件 tab”的交互预期。

### 不采用：复用独立 preview tab

把 `.md` 同时建模为 preview tab 和 file tab。这样可以最大化复用现有 preview view，
但会产生两个 tab 生命周期、两个加载入口和编辑内容同步问题，不符合已确认的单 tab
切换体验。

### 不采用：编辑与预览分屏

同时挂载 Monaco 和 Markdown。实时性最强，但持续占用更多渲染资源，也挤压终端主内容
区域；当前需求不需要并排编辑。

## 组件边界

### `FileTopTab`

负责：

- 订阅 `WorkspaceFileRuntime` snapshot。
- 判断当前路径是否是 Markdown。
- 持有 `preview | edit` 本地展示状态。
- 渲染模式工具栏、错误界面和相应内容视图。
- 保留现有 Monaco attach、detach、model migration 与 view state 恢复逻辑。

所有 React hooks 继续位于错误或内容分支之前，符合仓库 hook 约束。

### Markdown 预览表面

增加一个聚焦的 workspace Markdown 预览组件，输入只包含当前文本与文件路径。它负责：

- 把 `runtime.value` 传给现有 `Markdown` 组件。
- 从规范化文件路径计算父目录。
- 使用本地连接和父目录构造 `MarkdownResolveOpts`，让相对图片与 `srcset` 通过现有
  `FileJoinCommand` 和 stream-file 机制加载。
- 提供与现有 preview view 一致的可滚动内容间距。

它不读取文件、不维护副本，也不负责保存。

### 本地路径父目录辅助函数

在本地路径工具中增加可测试的父目录计算，覆盖 POSIX 根目录、Windows drive root 和
UNC share。workspace runtime 已将分隔符规范化，但辅助函数仍应对这些根路径保持正确。

## 数据流

1. `WorkspaceEditorRegistry` 按现有流程读取文件并更新 `WorkspaceFileRuntime.value`。
2. `.md` file tab ready 后默认渲染 Markdown 预览。
3. 用户点击 `Edit`，同一 runtime 的 Monaco model 被挂载并恢复之前的 view state。
4. Monaco 变化继续调用 `runtime.setValue()`；runtime 更新 dirty、value 和 snapshot。
5. 用户点击 `Preview`，Monaco detach 保存 view state，Markdown 使用最新
   `runtime.value` 重新渲染。
6. 保存、关闭确认、重命名和删除继续由现有 registry/controller 流程处理。

本功能不增加文件读取、不创建第二份 buffer，也不改变 runtime snapshot 接口。

## 错误与边界行为

- 初次读取失败继续显示现有 Retry / Close / Locate 错误界面，模式切换不覆盖错误状态。
- 保存失败沿用现有 save error 行为；预览仍展示内存中的最新文本。
- Markdown 语法错误由现有渲染器做容错展示，不阻止切换回编辑模式。
- 相对图片解析失败沿用现有 `[img]` fallback 和 warning，不让整个 tab 崩溃。
- 非 `.md` 文件完全沿用当前 Monaco 路径。
- Markdown 中的外部链接、HTML 清洗、Mermaid 错误和代码复制继续使用现有 `Markdown`
  行为，不在本功能中分叉实现。

## 视觉与交互

- 模式切换位于文件内容区顶部右侧，左侧保留文件 breadcrumb。
- 使用有文字标签的 `Preview` 和 `Edit` 按钮，避免只靠图标表达状态。
- 激活模式使用现有主题 token；工具栏不引入独立主题或新的全局样式体系。
- Markdown 内容保持适合阅读的水平留白，窄窗口时收紧边距。
- 第一版不增加分屏、目录开关、键盘快捷键、全局默认模式设置或模式持久化配置。

## 测试策略

遵循测试先行，先增加失败测试，再实现最小行为：

- `.md` runtime ready 后默认渲染 Markdown，而不是 Monaco。
- 点击 `Edit` 后挂载现有 `CodeEditor`，传递相同 model、text、readonly、language 和
  onChange，并执行 attach/view state 流程。
- 从 `Edit` 切回 `Preview` 后渲染最新的 `runtime.value`，包括未保存修改。
- 多次切换不会丢失 Monaco view state，也不会重复持有已卸载 editor。
- `.ts` 等非 Markdown 文件仍直接渲染 Monaco，且不出现模式切换。
- 读取失败界面的 Retry / Close / Locate 行为保持不变。
- 路径辅助函数覆盖 `/repo/README.md`、`/README.md`、`C:/README.md` 和
  `//server/share/README.md`。
- 运行现有 `file-top-tab`、workspace file slot、editor registry 和本地路径测试，确认
  没有回归。

## 预计改动范围

- `frontend/app/workspace/file-top-tab.tsx`
- 新的 workspace Markdown 预览组件及其测试
- `frontend/util/local-path.ts`
- `frontend/util/local-path.test.ts`
- `frontend/app/workspace/file-top-tab.test.tsx`

不修改 Go、RPC、生成类型、tab 持久化结构或现有独立 preview view。

## 验收标准

- 任意本地 `.md` 文件从文件树或其他入口打开时默认显示 Markdown 预览。
- 用户可在同一 tab 内可靠切换 `Preview / Edit`。
- 编辑内容、dirty 状态、保存与关闭确认行为与普通 file tab 一致。
- 未保存内容能在预览中显示，Monaco 光标和滚动状态在切换后恢复。
- 相对图片以 Markdown 文件所在目录为基准解析。
- 非 Markdown file tab 行为无变化，相关测试全部通过。
