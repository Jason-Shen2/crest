# Block 双形态拆分设计

> 把当前"统一 block"（shell 时间线 + agent 会话混在一个 view/ViewModel 里）拆成两种形态：
> **纯终端 block**（`view: "term"`）与 **agent 会话 block**（`view: "agent"`）。
> 二者**共享同一个 `TerminalModel` 引擎**，差异只在 renderer 是否挂载 agent 装配层。

**状态**: 设计已确认 (2026-07-07)
**关联文档**:
- [agent-rendering-architecture.md](../../agent-rendering-architecture.md) — agent 会话跨进程渲染
- [agent-timeline-architecture.md](../../agent-timeline-architecture.md) — 时间线索引 vs 内容存储
- [term-engine-migration.md](../../term-engine-migration.md) — 自研 cmdblock 引擎（xterm.js 已移除）

---

## 1. 背景与动机

agent conversation 的拼图已完成（一次性 shell command + PTY/cli agent 委派）。当前所有终端 pane
都由 [`terminal-view.tsx`](../../../frontend/app/term/render/terminal-view.tsx)（~979 行）统一渲染，
它**无条件**同时挂载：

- shell 块列表（`BlockListElement`，engine 驱动）
- 全套 agent 机关（`AgentChatHost` / `AgentActivityBar` / `SessionSelector` /
  `AgentCommandResultList` / 输入栏 agent 模式）

**动机**（用户确认）：
1. **职责分离 / 代码可维护** — agent 代码与终端代码在同一巨型组件里，难以单独理解和测试。
2. **独立生命周期 / 状态** — 两种形态应各有清晰边界，而非一个组件里靠 flag 分支。

## 2. 关键事实（探索所得）

- **渲染引擎共享**：两种形态底层都是自研 cmdblock DOM-grid 引擎
  （`frontend/app/term/engine/`），xterm.js 已在引擎迁移中删除 —— 因此"纯终端"**复用现有引擎**，
  不重新引入 xterm.js。
- **数据存储天然分离**：
  | 形态 | 存储 | 拥有方 |
  | --- | --- | --- |
  | agent 会话 | SQLite session `.db`（`SqliteSessionRepo`，`PaneAgentSession` 包裹） | emain |
  | shell 终端 | `filestore BlockFile_Term` + 每块 `output_data` blob | Go `wavesrv` |
  | 时间线索引 | `db_cmdblock` 表（`kind=shell` 行 + `kind=agent` marker 行） | Go `wavesrv` |
- agent marker 行只带 `agent_run_id` + `agent_session_path`，是指向 SQLite 会话的**引用**
  （见 [`cbtypes/types.go`](../../../pkg/cmdblock/cbtypes/types.go)）。
- `TerminalModel` 已按 `block.kind` 分派渲染（shell → `BlockElement`，agent → `AgentBlockElement`）。

## 3. 形态边界（用户确认）

**半分离**：
- **纯终端 block**：只有 shell 块。**去掉**所有 agent UI。`block.kind` 恒为 `shell`。
- **agent 会话 block**：shell + agent 混排时间线。**保留** agent 内嵌 shell 命令结果（Warp 风格）。

**默认新建 = agent 会话**。**形态在创建时固定，不支持运行时切换。**

## 4. 架构

```
                    ┌─────────────────────────────┐
                    │   TerminalModel (共享引擎)    │
                    │  blocks / parser / 选区 /    │
                    │  alt-screen / scrollPos      │
                    └──────────────┬──────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              │                                          │
     ┌────────▼─────────┐                     ┌──────────▼──────────┐
     │  TerminalPaneView │                     │    AgentPaneView    │
     │  (view: "term")   │                     │   (view: "agent")   │
     │                   │                     │                     │
     │ BlockList(shell)  │                     │ BlockList(shell+    │
     │ + 命令输入栏       │                     │   agent 混排)        │
     │ ✗ 无 agent import │                     │ + <AgentSurface>    │
     └───────────────────┘                     └─────────────────────┘
                                                          │
                                            ┌─────────────▼─────────────┐
                                            │      AgentSurface         │
                                            │ AgentChatHost /           │
                                            │ AgentActivityBar /        │
                                            │ SessionSelector /         │
                                            │ agent 输入模式 / 命令结果  │
                                            └───────────────────────────┘
```

## 5. 组件拆分（frontend）

把 `terminal-view.tsx` 按归属拆成三部分：

### A. 共享核心（两形态都要）→ `useTerminalPane` hook + `TerminalCore` 骨架
- `TerminalModel` 创建/生命周期、cols 测量、focus、revision 订阅
- `BlockListElement`、`FindBar`、alt-screen 按键路由、选区、OSC8 链接点击
- 命令输入栏的 shell 部分（`CmdBlockInput` 的 `terminal` 模式）

### B. Agent 装配 → 新组件 `AgentSurface`（仅 `AgentPaneView` 挂载）
- `AgentChatHost`（usePiChat）、`AgentActivityBar`、`SessionSelector`、`AgentCommandResultList`
- 输入栏 `agent`/`auto` 模式、`!` shell 前缀、model picker
- `agent:session` meta 读写、`onSubmit` 的 `mode === "agent"` 分支
- agent runs 状态、`syncAgentBlocks`

### C. 两个薄壳
- `TerminalPaneView`：`TerminalCore` + 输入栏（`mode` 固定 `terminal`，无 `onModeChange`）。
  **组件树中不 import 任何 agent 模块。**
- `AgentPaneView`：`TerminalCore` + `<AgentSurface>`，输入栏支持模式切换。

## 6. ViewModel / 注册

- 新增 `AgentViewModel`（`frontend/app/view/agentblock/agent-model.tsx`）：
  `viewType = "agent"`，`viewComponent → AgentPaneView`，专属 icon。
- `TermBlocksViewModel` / `TermViewModel` 保留，`viewComponent → TerminalPaneView`（去 agent）。
- [`blockregistry.ts`](../../../frontend/app/block/blockregistry.ts) 注册 `"agent" → AgentViewModel`。

## 7. 创建入口与默认

- **launcher**：[`widgets.json`](../../../pkg/wconfig/defaultconfig/widgets.json) 新增 `defwidget@agent`
  （`view: "agent"`, `controller: "shell"`, 专属 icon），`display:order` 排在 terminal 之前。
- **默认新建**：[`layout.go`](../../../pkg/wcore/layout.go) 新 tab 默认 block 从 `termblocks`
  改为 `agent`（`controller` 仍 `shell`）。

## 8. 数据与后端

- **无 schema 变更**。agent 内容仍在 SQLite session（`agent:session` meta 指向），
  shell 仍走 filestore + `db_cmdblock`。
- 纯终端 block 的时间线**永不写** `kind=agent` 行 —— `TerminalModel` 已按 `block.kind`
  分派，天然兼容。
- **两种 view 都带 `controller: "shell"`**，都有真实 PTY（agent 内嵌 shell 需要）。
  差异纯在 renderer 装配层，**后端零改动**。

## 9. 测试策略

- `TerminalPaneView` 快照测试：断言渲染树中**无** agent 元素（复用
  [`terminal-view-tui.test.tsx`](../../../frontend/app/term/render/terminal-view-tui.test.tsx) 模式）。
- `AgentPaneView` 测试：agent 机关正常挂载、shell 混排保留。
- 提取的 `useTerminalPane` / `AgentSurface` 各自独立单测。
- blockregistry 解析测试：`"agent"` → `AgentViewModel`、`"term"` → `TermViewModel`。

## 10. 非目标（YAGNI）

- 不重新引入 xterm.js / 不回退到扁平滚屏。
- 不支持形态运行时切换。
- 不做 `db_cmdblock` 物理存储拆分（逻辑已分离，物理统一无需动）。
- 不改 agent runtime / PaneAgentSession / IPC 层。
- 不做 agent block 脱离 shell PTY（仍复用 engine 的内嵌 shell 块）。

## 11. 风险

- **拆分纪律**：979 行组件的拆分需保证共享核心行为不回归（focus / alt-screen / 选区）。
  依赖现有 TUI 快照测试兜底。
- **默认形态变更**：新 tab 默认变 agent，需确认 agent 未配置（无 API key）时纯 shell
  使用路径仍顺畅（输入栏 `!` 前缀或切 `terminal` 模式）。
