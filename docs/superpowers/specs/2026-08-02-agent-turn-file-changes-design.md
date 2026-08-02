# Agent Turn 文件改动卡与独立 Undo/Redo 设计

日期：2026-08-02

状态：已确认

## 与现有设计的关系

本文扩展以下两份既有设计：

- [`2026-07-28-agent-workspace-rewind-design.md`](./2026-07-28-agent-workspace-rewind-design.md)
  定义 tool-independent checkpoint、snapshot store、restore plan、冲突检测、确认 token、
  workspace lock、recovery journal、完整会话 Revert/Redo 和多 Session 安全边界。
- [`2026-08-01-agent-rewind-diff-preview-design.md`](./2026-08-01-agent-rewind-diff-preview-design.md)
  定义双栏文件审阅布局和反向 diff 预览。

本文新增的是每个完成 turn 下方的文件改动卡、历史 turn diff 审阅、只撤销该 turn 文件且
保留全部对话的 Undo，以及与之配对的 Redo。它不改变 checkpoint 的 tool-independent
采集原则，也不以 `write`、`edit`、change review operation 或 Git working tree diff
作为权威数据源。

## 参考来源与 Crest 自有设计

本文继续采用原设计的 clean-room 原则，不复制 OpenCode 或 pi-rewind 源码，也不在运行时
依赖它们。

| 设计决策 | OpenCode 参考 | pi-rewind 参考 | Crest 决策与差异 |
| --- | --- | --- | --- |
| checkpoint 与内部 snapshot store | 主要参考。OpenCode 使用内部 Git 对象保存和恢复文件状态。 | pi-rewind 也维护每 Session checkpoint。 | 直接复用 Crest 已实现的 canonical-workspace snapshot store；支持非 Git workspace。 |
| 单 turn 与 checkpoint 的绑定 | OpenCode 的用户消息是 undo 边界，但 step snapshot 与 Crest turn 生命周期不同。 | 主要生命周期参考。pi-rewind 将 before/after checkpoint 绑定到 `userEntryId`/turn。 | 直接使用 Crest 现有 `turnId` 和 terminal checkpoint；不新增工具调用到 turn 的映射。 |
| 只恢复文件、保留对话 | OpenCode 的产品 Undo 同时处理消息和文件，不直接提供本文这种独立 per-turn 文件状态。 | pi-rewind 的 code-only restore 模式提供概念参考。 | 新增 `turn-undo`/`turn-redo`，只应用一个 checkpoint 的文件状态，不移动会话树。实现、安全协议和多 turn 状态折叠均为 Crest 自有。 |
| selective path restore | 主要参考。OpenCode 只恢复计划中的路径。 | 不采用其完整 repository state restore。 | 只处理目标 checkpoint 的 `changes`；绝不执行 workspace-wide checkout/reset/clean。 |
| Turn 文件改动卡 | 无直接采用。 | 无直接采用。 | Crest 产品要求。卡片使用真实 checkpoint 数据，提供 Review、Undo/Redo 和文件入口。 |
| 双栏历史 Review | OpenCode 的 diff/revert UI 提供视觉参考，但不是相同数据流。 | 无直接采用。 | Crest 自有 `DiffReviewDialog`。Review 展示不可变 `before -> after`，Undo 展示 `after -> before`。 |
| 独立历史 diff tab | 无直接采用。 | 无直接采用。 | Crest 自有 `agent-turn-diff` tab；与读取当前 Git 状态的 `git-diff` tab 明确分离。 |
| drift、Force Undo、确认 token、workspace lock 和 crash recovery | OpenCode 没有 Crest 当前这套完整冲突 UX 与 durable protocol。 | 无等价实现。 | 复用 Crest 自有安全内核。普通 Undo 不覆盖 drift；只有精确红名单可明确 Force。Redo 不提供 Force。 |

本文没有新增 `/undo` 或 `/redo` 命令。卡片上的 Undo/Redo 是单 turn 文件操作；已有
`/rewind`、`/redo` 和消息侧 Revert 仍表示完整会话 Revert/Redo。两套入口不得共用含义
模糊的命令或 renderer mode。

## 目标

- 一个 user turn 完成且 checkpoint 有文件变化后，在该 turn 的 assistant 输出下方展示
  文件改动卡。
- 卡片展示精确文件数、路径和 `before -> after` 方向的 additions/deletions。
- `Review` 打开双栏历史审阅窗口，显示该 turn 当时产生的精确 diff。
- 点击卡片文件打开持久的历史 diff tab，而不是当前 Git diff。
- `Undo changes` 只恢复该 turn checkpoint 的文件并保留所有对话。
- Undo 后卡片变为 `Redo changes`；Redo 恢复该 turn 的文件改动，同样不修改对话。
- Review、Undo、Redo 和完整会话 Revert/Redo 复用同一个双栏展示组件。
- 复用现有 snapshot、冲突检测、confirmation、workspace lock、journal 和 recovery，避免
  创建第二套不一致的文件写入协议。

## 非目标

- 不为缺失 checkpoint 的历史 Session 补数据或展示不可用卡片。
- 不使用 `changeOutline`、`ChangeOperation` 或工具名称判断 turn 修改了哪些文件。
- 不让 Review 打开或伪装成当前 Git Review panel。
- 不让 `agent-turn-diff` 在 checkpoint 不可用时退化为当前 Git diff。
- 不在 Review 模式执行文件写入或签发 mutation confirmation token。
- 不为 Turn Redo 提供 Force。
- 不新增 rename 检测；snapshot change 仍按现有 create/write/delete 语义展示。
- 不解决同一 turn 时间窗口内多个进程写入的完美 provenance 归因。

## 权威数据语义

每个可用 checkpoint 已保存：

```ts
{
    turnId,
    originSessionId,
    before,
    after,
    changes: [{ path, before: beforePathState, after: afterPathState }],
}
```

卡片、Review、历史 diff tab 和 Undo/Redo 全部从该结构派生：

| 表面 | 旧侧 | 新侧 | 是否检查 live workspace |
| --- | --- | --- | --- |
| 卡片统计 | `before` | `after` | 否 |
| Review | `before` | `after` | 否 |
| 历史 diff tab | `before` | `after` | 否 |
| Turn Undo preview | `after` | `before` | 是 |
| Turn Redo preview | `before` | `after` | 是 |

checkpoint 表达的是该 turn 时间窗口内观察到的 workspace 差异，而不是操作系统级写入者
证明。另一个 Session 或后台进程若在同一 turn 结束前写入文件，其变化可能进入该 checkpoint。
这是 tool-independent workspace snapshot 的已接受边界；checkpoint 结束后的第三方变化由
live drift 检测保护。

## 后端架构

### 共享 Restore Executor

保留 `WorkspaceRewindEngine` 作为完整会话 Revert/Redo facade，并从其现有 apply 流程提取内部
`WorkspaceRestoreExecutor`，统一负责：

- 按 canonical path 排序的 restore plan；
- live path inspection 和 fingerprint；
- normal、forceable drift、hard blocker 分类；
- confirmation token 签发和 apply 前重算；
- safety snapshot；
- workspace lock；
- filesystem apply 和 post-apply verification；
- recovery journal 及崩溃恢复；
- workspace state entry 持久化。

完整会话 Revert、完整会话 Redo、Turn Undo 和 Turn Redo 使用同一个 executor。planner 和
commit coordinator 保持分开，避免用一个 renderer `mode` 混淆不同产品语义。

### Turn Undo Planner

Turn Undo 只读取目标 turn 的 terminal available checkpoint。对每个 change：

```text
target          = change.before
expectedCurrent = change.after
```

planner 必须验证：

- checkpoint 位于当前 active branch 且唯一、terminal、可解码；
- `originSessionId` 等于当前 Session；
- workspace identity/incarnation 匹配；
- before/after snapshot 和所需 blob 可读；
- 每条待恢复路径 canonical，且该 change 的 before/after 均具有完整 coverage；checkpoint 中其他具有
  canonical path 的显式排除项只作为 coverage warning 展示，不阻断已覆盖 change；
- semantic leaf 与调用方预期一致。

live 状态等于 `expectedCurrent` 时可普通 Undo；live 已等于 `target` 时该路径作为已恢复
no-op 排除；其他普通文件状态属于 `forceable-drift`，显示精确警告
`files changed on disk since the agent last wrote them`。unsafe 类型、目录碰撞、意外 symlink、
无法定位到 canonical path 的 coverage 缺口（例如 workspace-root capture budget、non-UTF-8 path）、
待恢复 change 自身被排除，或无法稳定读取，均为 hard blocker。

### Turn Redo Planner

Turn Redo 只对当前 active branch 上最后状态为 `turn-undo` 的 source turn 可用：

```text
target          = checkpoint change.after
expectedCurrent = checkpoint change.before
```

Redo 发生任何 drift 时转为 hard blocker，不提供 Force。Redo 成功后追加 `turn-redo` marker，
卡片重新显示 Undo。

### Confirmation Binding

confirmation binding 扩展 target union，明确区分：

```ts
{ kind: "rewind"; targetTurnId: string }
{ kind: "redo" }
{ kind: "turn-undo"; sourceTurnId: string }
{ kind: "turn-redo"; sourceTurnId: string; undoOperationId: string }
```

token 同时绑定 workspace identity/incarnation、Session、semantic leaf、有效路径集合、live
fingerprint 和 conflict class。token 短时有效且一次性消费；apply 在 workspace lock 下重算
plan，与 binding 不一致就拒绝执行。

### Durable State 与会话保持

Turn Undo/Redo 不调用 `moveTo()`，不接到历史 conversation boundary，也不恢复 composer。
文件验证成功后，只在当前 raw semantic leaf 后追加隐藏的 workspace state entry：

```ts
{
    kind: "turn-undo" | "turn-redo",
    sourceTurnId,
    operationId,
    currentSnapshot,
    currentStates,
    forcedPaths,
}
```

raw semantic leaf 因 compare-and-swap 状态 entry 而前进；`displayLeafId` 继续指向原来的最后
一条可见消息。user/assistant 消息、活动 conversation branch、composer 和被放弃分支均不变。

session state 从当前 active branch 折叠全部 `turn-undo`/`turn-redo` marker。每个 source turn
最后一个 marker 决定卡片动作，因此多个 turn 可以分别处于 undone 状态。切换分支后只折叠
新 active branch 上的 marker。

完整会话 Revert planner 必须把 turn mutation marker 作为 workspace timeline 的一部分。
例如 `0 -> 1 -> 2` 后 Undo 第二个 turn 得到 live `1`，完整 Revert 到第一个 turn 之前必须
从 `1` 正确恢复为 `0`，不能假设 live 仍是 `2`。

### Recovery Journal

journal kind 扩展到 `turn-undo`/`turn-redo`，继续使用现有阶段：

```text
prepared -> applying_files -> files_verified -> committing_session -> completed
```

- `prepared` 崩溃且文件未动：清理 operation；
- `applying_files` 或 `files_verified` 崩溃：按 safety snapshot 恢复 pre-state；
- `committing_session`：根据 exact operation leaf 完成提交或回滚；
- 发现未知第三方状态：freeze recovery，不猜测覆盖。

## API 与数据加载

API 语义保持分离，并固定为以下调用边界：

```text
agent:get-turn-change-summary
agent:get-turn-file-diff
agent:review-turn-changes
agent:preview-turn-undo
agent:apply-turn-undo
agent:preview-turn-redo
agent:apply-turn-redo
```

`get-turn-change-summary` 只返回卡片数据；`review-turn-changes` 返回一个 turn 的完整 forward
review rows；`get-turn-file-diff` 返回一个路径的历史 diff tab 数据。三个只读 endpoint 不签发
mutation confirmation。Undo/Redo preview 与 apply 保持独立 endpoint。

数据分三层加载：

1. Session state 只发布有效 checkpoint turn 和每个 turn 当前 `undo`/`redo` action 状态；
2. 文件卡按 turn 请求轻量 summary，包括路径、operation 和行数统计；
3. 打开 Review 或历史 diff tab 时才读取 blob 和完整 diff 文本。

summary 和历史 diff 以 immutable snapshot/tree/path 作为 cache key。IPC 沿用既有单文件
1 MiB、一次预览 8 MiB 等展示预算；diff 预算不能影响 checkpoint 或 mutation 能力。

## Turn 文件改动卡

卡片位于该 turn 最后一条 assistant message 下方。仅当 turn terminal、checkpoint available
且 `changes.length > 0` 时显示。历史缺失 checkpoint、unavailable checkpoint 和零变化 turn
不显示卡片。

卡片包含：

- `Edited N files`；
- 总计 `+A -D`；
- `Undo changes` 或 `Redo changes`；
- `Review`；
- 使用 `getFileIcon()` 的文件行、路径和逐文件 `+A -D`。

按钮在 Agent 正运行、checkpoint/session mutation busy 或 recovery frozen 时禁用。Undo 成功后
卡片保留原始 `before -> after` 统计，只把 action 切换为 Redo；Redo 成功后切回 Undo。

点击卡片文件打开 `agent-turn-diff` tab。点击 `Review` 打开 `DiffReviewDialog`，不再调用
`WorkspaceLayoutModel.openRightTool("codeReview")`。

## `DiffReviewDialog`

`DiffReviewDialog` 是纯展示组件，不调用 IPC、不读取 Session、不签发 token，也不判断具体
业务操作。它接收：

- 标题与描述；
- 文件 rows；
- 当前选中文件及选择回调；
- diff、统计和 preview-unavailable reason；
- warning/conflict 状态；
- loading/error 状态；
- footer actions。

组件复用现有 shadcn `Dialog`、`Button`、`getFileIcon()`、`DiffViewer`/`FileCard`、Git Diff
颜色、密度和主题 token。左侧为紧凑文件导航，右侧为选中 diff；Dialog 内点击文件只切换
右侧内容，不打开 tab。

不同 controller 提供不同数据和 footer：

| controller | diff 方向 | live 检查 | footer |
| --- | --- | --- | --- |
| Turn Review | `before -> after` | 无 | `Close` |
| Turn Undo | `after -> before` | 有 | `Cancel` + `Undo N files` 或 `Force undo` |
| Turn Redo | `before -> after` | 有 | `Cancel` + `Redo N files` |
| Conversation Revert | restore plan 当前态到目标态 | 有 | 原有 Revert/Force Revert |
| Conversation Redo | rewind 后状态到 redo target | 有 | 原有 Redo |

Review 是 immutable historical view，不显示 live drift、不签发 confirmation token，也不提供
Undo/Redo 按钮。mutation 仍从卡片对应 action 进入，防止 Review 和确认授权混在一起。

## `agent-turn-diff` Tab

现有 `git-diff` tab 会读取当前 HEAD/index/working tree，不能表示历史 turn。新增独立 top tab
kind `agent-turn-diff`。持久化 descriptor 包含 `sessionId`、`sessionPath`、workspace
identity/incarnation、`turnId`、`path` 和 before/after captured path state；tab identity key 使用
workspace identity、Session、turn、path 和 before/after state fingerprint，保证同一路径在不同
turn 中打开不同 tab。

tab 固定显示 `checkpoint.before -> checkpoint.after`，复用现有 top tab strip、文件图标和
Monaco diff body。重启后按 descriptor 重新读取 checkpoint blob；snapshot 缺失或损坏时显示
明确错误，不回退为当前 Git diff。

## 错误与安全语义

- Review 加载失败只影响历史审阅，不冻结 workspace。
- 单文件 diff 不可生成时显示明确原因，不伪造空 diff。
- preview/apply 错误保留 Dialog 和错误信息，不把失败显示为成功。
- preview 后发生磁盘或 semantic leaf 变化，confirmation 失效并要求重新预览。
- Undo 只有普通文件 drift 可 Force；Force 只覆盖 preview 红名单中的精确路径。
- Redo 的任何 drift 都是 hard blocker。
- symlink、目录碰撞、unsafe path、缺失 snapshot、错误 workspace incarnation 和 unknown
  recovery state 永远不能 Force。
- 不同路径上的其他 Session 变化不进入 plan；同路径后续变化被 drift 检测阻止普通 Undo。

## 测试

### Backend

- Review、Undo、Redo 分别验证 `before -> after`、`after -> before`、`before -> after`。
- create/write/delete 的 operation、diff、additions/deletions 和 blob 字节正确。
- live 等于 expected 可普通执行；live 等于 target 为 no-op；其他普通文件为 forceable drift。
- unsafe、symlink、目录碰撞、不完整 coverage 和 unreadable snapshot 为 hard blocker。
- confirmation 绑定 kind、source turn、undo operation、leaf、路径和 fingerprint，并拒绝 stale。
- 多个 turn 独立 Undo/Redo 后，active branch 状态折叠正确。
- 完整 Revert 正确组合 checkpoint、turn mutation marker 和 conversation workspace marker。
- journal 各阶段在 Turn Undo/Redo 中均能回滚、完成或 freeze。
- 多 Session 不同路径互不影响；同路径 drift 不静默覆盖；Force 仅覆盖确认红名单。

### Renderer

- checkpoint committed 后才显示卡片；零变化、missing/unavailable checkpoint 不显示。
- 卡片展示文件数、总统计、文件图标、路径和逐文件统计。
- Review 打开 `DiffReviewDialog`，显示 forward diff 且 footer 只有 Close。
- Undo/Redo 复用同一个 Dialog，但方向、warning 和 footer 正确。
- 卡片文件打开 `agent-turn-diff`；Dialog 文件选择只切换右侧内容。
- Undo 后卡片变 Redo，Redo 后恢复 Undo；多个卡片状态互不覆盖。
- conflict 精确显示 canonical warning 和 Force/hard-blocker 按钮规则。

### E2E

- 通过 bash 或未来非 write/edit 工具修改文件后仍出现 turn 卡片。
- Review 和历史 tab 均展示 checkpoint 的精确 forward diff。
- Undo 恢复文件但保留全部消息、display leaf 和 composer；Redo 恢复 turn 文件状态。
- preview 后外部修改使普通确认失败，不覆盖新内容。
- 单 Turn Undo/Redo 与完整会话 Revert/Redo 连续组合得到正确字节和 Session 状态。
- 两个 Session 在同一 workspace 的不同路径操作互不影响；重叠路径进入显式冲突流程。

## 验收标准

- 用户在完成 turn 下方直接看到该 turn 的真实 workspace 文件变化。
- Review、卡片统计和历史 tab 始终使用 immutable checkpoint，而不是当前 Git diff。
- Undo/Redo 只修改目标 turn 的 checkpoint 路径，不删除、编辑或移动任何可见对话。
- 普通 Undo 不覆盖 checkpoint 后的同路径变化；Force 只处理明确标红路径。
- Turn Redo 可恢复已 Undo 的 turn，发生 drift 时安全阻断。
- `DiffReviewDialog` 被 Review、Turn Undo/Redo 和完整会话 Revert/Redo 共用，且保持纯展示边界。
- 完整会话 Revert 能正确理解此前发生的多个 Turn Undo/Redo marker。
- 缺少历史 checkpoint 的 Session 不展示虚假或不可操作的文件卡。
