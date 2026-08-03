# Agent Redo Dock 权威详情与视觉修正设计

日期：2026-08-04  
状态：已确认

## 背景

会话 Revert 完成后的 Redo Dock 存在三个直接影响理解的问题：

1. 顶部 `messageCount` 统计了 user、assistant 等所有 message entries。用户只回退一个 user message 时，界面可能显示 `6 messages`。
2. 权威 session state 将 `AgentRedoView.files` 固定为 `[]`，即使 `fileCount > 0`，展开态也只能显示“去 Redo preview 查看”的占位提示。
3. 展开态使用带边框的 request 卡片和偏大的间距，与已确认的轻量审阅样式不一致。

## 目标

- Redo Dock 的 message 数量只表示被回退的 user messages。
- 展开态以 `Reverted messages` 展示所有被回退的 user messages。
- Files 直接展示本次 Redo 会恢复的文件路径、增删统计和 A/M/D 状态。
- UI 与已确认的 `redo-dock-v2.html` 一致：更紧凑、无多余 request 卡片、文件列表使用审阅样式。
- 不新增 preview 请求、confirmation token、workspace lock、持久化字段或全局状态。

## 根因与数据边界

### User message 统计

现有 `countRevertedMessages()` 从 `targetTurnId` 到 `fromLeafId` 的原分支中统计所有 `entry.type === "message"` 的 entries。修正后，这个范围保持不变，但只保留 `entry.message.role === "user"`。

`AgentRedoView` 将 `targetPrompt` 替换为 `messages: string[]`。数组按原分支顺序保存被回退的 user message 文本；`messageCount` 必须等于 `messages.length`。Redo preview 的 `messageCount` 复用同一统计口径。

### Files 投影

Rewind marker 已经持久化了生成 Redo 文件范围所需的全部状态：

- `currentStates`：Revert 完成后的路径状态；
- `rewind.redoStates`：Redo 需要恢复到的路径状态；
- snapshot store blobs：文本内容与 diff 统计来源。

权威 session state 构建时，按 `rewind.redoStates` 的顺序，将同路径的 `currentStates` 作为 before、`redoStates` 作为 after，复用现有 `projectWorkspacePathDiff()` 生成 `AgentRewindFileRowView`。

该过程只读取私有 snapshot store，不检查 live disk，因此：

- 不获取 workspace lock；
- 不创建 confirmation token；
- 不进行冲突判定，file row 的 `conflict` 保持 `none`；
- 不改变真正执行 Redo 前的 preview 和磁盘漂移校验。

若 marker 缺少对应的 current path state，权威 Redo view 不应被发布，因为真正的 `planRedo()` 也会将其 hard block。若单个 blob 无法读取，仍展示文件路径与操作类型，同时沿用 `previewUnavailableReason`，不让整个 Dock 消失。

## API 与组件

### `AgentRedoView`

```ts
interface AgentRedoView {
    operationId: string;
    messages: string[];
    messageCount: number;
    fileCount: number;
    files: AgentRewindFileRowView[];
}
```

`operationId` 继续用于内部执行身份，但 UI 不展示。

### Session state probe

`AgentRewindSessionStateProbe` 增加只读 `readBlob(oid)`，生产调用直接委托给当前 workspace 的 `WorkspaceSnapshotStore.readBlob()`。它不引入新的服务或 IPC。

### Redo Dock v2

收缩态：

- 左侧保留柔和橙色 Undo 状态 icon；
- 标题 `Changes reverted`；
- 第二层显示 `<user-message-count> messages · <file-count> files`；
- Redo 和 disclosure 独立、始终可见。

展开态：

- 第一节标题改为 `Reverted messages`，右侧显示 user message 数量；
- 每条消息使用轻量 quote 标记，不使用有边框、有背景的 request 卡片；
- 第二节标题为 `Files`，右侧显示 `<count> changed`；
- 文件行展示现有文件 icon、muted 目录、foreground basename、diff 数字和 A/M/D；
- hover 仅使用淡灰背景。

保持现有 disclosure 动效、内部滚动、reduced-motion、ARIA 和 busy 时只禁用 Redo 的行为。

## 错误处理

- 无有效 rewind marker：不发布 Redo Dock，行为不变。
- snapshot descriptor 无效：不发布 Redo Dock，行为不变。
- marker 的 current/redo 路径关系不完整：不发布 Redo Dock。
- 单文件 diff blob 不可读、二进制或超限：显示文件行但省略统计，现有 `previewUnavailableReason` 保留给审阅语义。
- live disk 已变化：Dock 仍描述“当时被回退的内容”；用户点击 Redo 后由现有 preview 检测并阻止有冲突的执行。

## 测试

- session state 单测证明一个 user message 加多个 assistant message 仍只计为 `1 message`；多 user turns 按顺序生成 `messages`。
- session state 单测用真实 diff projector 验证 current → redo 文件行、操作类型和增删统计。
- IPC/live/cold state 测试验证 snapshot store 的 `readBlob` 正确接线。
- Redo Dock 单测覆盖 v2 文案、消息列表、真实 Files、紧凑样式、响应式、ARIA 和 busy。
- AgentContent 集成测试继续验证 Redo Dock 的权威卸载和 `/redo` 共用控制器。

## 非目标

- 不修改 Revert 或 Redo 的执行语义。
- 不把 live-disk 冲突检查提前到 Dock 展开阶段。
- 不在 Dock 内增加单文件选择、diff tab 或 Review 按钮。
- 不增加多步 Redo 历史。
