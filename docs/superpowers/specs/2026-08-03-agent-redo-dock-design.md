# Agent Redo Dock 视觉优化设计

日期：2026-08-03  
状态：已确认

## 目标

会话 Revert 完成后，Redo Dock 应清楚表达“撤回已经完成，并且可以恢复”，同时保持在输入框上方足够安静。收缩态提供结果摘要和直接操作；展开态补充原始请求与文件范围。

本次只调整 `RedoDock` 的前端呈现和交互，不修改 rewind/redo 状态、预览、确认或执行协议。

## 视觉方向

采用“撤回凭据”而不是普通工具栏：

- 使用中性深色表面和中性边框，不使用左侧橙色强调边；
- 橙色只保留在撤回状态图标中，用于传达状态而不抢占视觉重心；
- `Redo` 是唯一主操作，始终可见；
- 文件 icon、路径层级、状态字母和 diff 数字复用现有文件审阅语言；
- 不展示 `operationId` 等内部实现信息。

已确认的交互式 mockup：`.superpowers/brainstorm/70955-1785723877/content/redo-dock-v1.html`。

## 收缩态

收缩态紧邻 composer，内容顺序为：

1. 撤回状态图标；
2. 标题 `Changes reverted`；
3. 摘要 `<message-count> messages · <file-count> files`；
4. `Redo` 主按钮；
5. 展开按钮。

桌面宽度下内容保持单行。窄宽度下标题区保持第一行，`Redo` 变为下方全宽按钮，避免压缩标题和统计信息。

整个卡片不作为按钮。只有 `Redo` 和展开按钮可点击，避免展开与执行操作的语义混淆。

## 展开态

展开后保留完全相同的头部与 `Redo` 位置，并在下方显示：

- `Reverted request`：被恢复到输入框的目标用户请求；
- `Files`：该次完整会话 Revert 涉及的文件列表；
- 每个文件的现有文件类型 icon、相对路径、增删统计和 `A/M/D` 状态。

文件列表使用淡灰 hover，不使用蓝色选中背景。此处只用于解释 Redo 范围，不新增文件选择、单文件恢复或新的审阅入口。

展开内容设合理最大高度并在内部滚动，避免长文件列表挤压 composer。展开状态只保存在组件内存中；重新挂载时回到收缩态。

## 动效与状态

- 展开和收起使用约 180–220ms 的高度、透明度和箭头旋转过渡；
- 遵循 `prefers-reduced-motion`；
- `busy` 时保持现有安全语义：禁用 `Redo`，防止重复提交；
- 展开按钮仍可用于查看范围，不改变后端 busy/frozen 判定；
- Redo 完成、失效或被新消息替代后，Dock 继续由权威 `rewindState.redo` 的消失负责卸载。

## 组件复用

实现继续保留 `RedoDock` 作为独立组件，并优先复用：

- 现有 `Button`；
- 左侧文件列表使用的 `getFileIcon`；
- Diff Review 中已确定的增删颜色、路径排版和状态字母；
- `cn` 处理状态样式。

不为这次视觉优化新增通用状态框架或新的全局状态。

## 无障碍

- Dock 保留明确的 section label；
- 展开按钮维护 `aria-expanded` 和 `aria-controls`；
- 详情区域保留具名 `region`；
- busy 状态通过禁用按钮和 `aria-busy` 表达；
- 键盘焦点样式与现有 Button、icon button 一致。

## 验收标准

- 收缩态显示 `Changes reverted`、消息数、文件数、`Redo` 和展开入口；
- 左侧没有橙色边；
- `Redo` 在收缩态与展开态位置稳定且始终可见；
- 展开态显示原始请求和文件列表，不显示 `operationId`；
- 文件 icon 与现有文件列表一致，diff 数字沿用成功色与破坏色；
- 窄宽度下 `Redo` 使用全宽第二行布局；
- busy 时不可重复触发 Redo；
- 展开/收起的 ARIA 关联正确；
- 现有权威 Redo 数据流和安全行为保持不变。

## 测试范围

- `redo-dock.test.tsx` 覆盖收缩态内容、展开态内容、无内部 operation id、busy 禁用和 ARIA 关系；
- 覆盖文件 icon、路径、diff 统计与 `A/M/D` 状态；
- 增加布局类断言，锁定中性边框、无左侧强调边和窄宽度全宽 Redo；
- `agent-content.test.tsx` 保留现有权威 Redo 数据流验证。

## 非目标

- 不改变 `/redo`；
- 不改变 Redo 预览弹窗；
- 不改变单 turn 文件卡片的 Undo/Redo；
- 不增加多步 Redo、历史列表或新的后端字段；
- 不允许在 Dock 中选择部分文件执行 Redo。
