# Agent Turn Undo 加载与完成反馈设计

## 目标

缩短从 Turn 文件卡片点击“撤销”到 Diff Review 可用的等待时间，并为预览加载、撤销执行、成功完成三个阶段提供稳定且明确的反馈。

## 问题

Turn 文件卡片出现前，后端已经读取 checkpoint 并完整校验 before/after 两份不可变快照。用户随后打开撤销预览时，后端又对相同快照执行一次完整 workspace tree 校验，然后才检查当前磁盘、生成 diff 和 confirmation token。重复的全量快照校验是主要的可避免耗时。

当前前端还存在两个体验问题：首次加载只显示零散文字，像空白窗口；点击 Undo 后 diff 内容消失或按钮缺少持续状态，完成后也没有独立成功反馈。

## 方案 A

### 性能

复用 `WorkspaceSnapshotStore.verifyUntrustedSnapshot()` 已有的进程内信任缓存：

- Turn summary 第一次加载 checkpoint 时完整校验 before/after 快照，并将不可变快照标记为可信。
- 同一 engine 实例随后打开 Turn Review、Undo 或 Redo 时，可信快照直接通过，避免再次遍历整棵 workspace tree 和全部 blob。
- 每次预览仍重新检查当前磁盘状态、重新生成精确 diff、重新签发 confirmation token。
- Conversation Revert 的校验路径保持不变，本次不扩大改动范围。

这不是缓存预览结果，也不缓存磁盘冲突，因此不会使用过期的文件状态或过期 token。

### 首次加载

`DiffReviewDialog` 保持完整双栏布局，使用安静的结构化 skeleton：

- Header 显示简短的 `Loading changes…` 状态。
- 左侧显示与文件行高度、层级一致的骨架行。
- 右侧显示接近代码 diff 的行骨架与变更色块。
- 加载时不显示空文件提示。
- 不显示 `Preparing safe undo…`。

### 执行中

点击 `Undo N files` 或 `Redo N files` 后：

- 已加载的文件列表和 diff 保留，避免窗口跳变。
- 内容区域增加轻量遮罩和 `Undoing N files…` / `Redoing N files…` 状态。
- 主按钮变为带 spinner 的 `Undoing…` / `Redoing…`，所有关闭和重复提交入口锁定。

### 完成

只有在 apply RPC 成功且新的权威 Turn 状态已经到达后，才关闭窗口并发送一次成功 toast：

- Undo：`Changes undone`，正文为 `N files restored.`
- Redo：`Changes redone`，正文为 `N files reapplied.`

RPC 返回但权威状态尚未更新时继续保留执行中状态，避免误报成功。

## 不做的事情

- 不增加新的 checkpoint、journal 或 recovery 状态。
- 不增加跨进程 preview cache。
- 不复用 confirmation token。
- 不跳过当前磁盘冲突检查。
- 不改变完整会话 Revert/Redo 的行为。

## 验收标准

1. Turn summary 已完成后，打开 Turn Undo/Redo 不再重复执行完整快照校验。
2. 加载态有双栏 skeleton，且页面不存在 `Preparing safe undo…`。
3. 执行期间 diff 保持可见，按钮与遮罩明确显示执行中且无法重复提交。
4. 只有权威状态确认后窗口才关闭，并且仅出现一次成功 toast。
5. 错误、冲突、force undo 和会话切换的既有安全行为不变。
