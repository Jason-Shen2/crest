# CLI Subagent 设计 Spec

> **状态**：设计定稿，待实现。
> **日期**：2026-07-01
> **来源**：由 [`docs/agent-cli-subagent-design.md`](file:///Users/bytedance/Documents/crest/docs/agent-cli-subagent-design.md) 定稿整理为正式 spec。
> **相关设计依据**：[`agent-dual-mode-design.html`](file:///Users/bytedance/Documents/crest/docs/agent-dual-mode-design.html) §8（双层模型 / context 边界）、[`warp-agent-analysis.md`](file:///Users/bytedance/Documents/crest/docs/warp-agent-analysis.md)、[`term-engine-migration.md`](file:///Users/bytedance/Documents/crest/docs/term-engine-migration.md)。

---

## 1. 概述

主 agent 不直接跟长运行 / 交互式 PTY 命令打交道。它下达一个自然语言任务，把 PTY 的脏活（写输入、读输出、判断状态、容错重试）全部委派给一个专职的 **CLI subagent**，最后只收回一段自然语言总结。

CLI subagent 就是**第二个 [`AgentHarness`](file:///Users/bytedance/Documents/crest/emain/agent/harness/agent-harness.ts) 实例**，跑在 emain（Node main 进程），拥有独立 session、独立 context，只挂 PTY 工具三件套。设计对齐 Warp 的 `triggers_server_subagent` 路由模式。

**当前 crest 完全缺失 subagent / sub-task 委派机制**（已确认）。`spawn_cli_agent` 是第一个引入嵌套 harness 的地方。

---

## 2. 目标与非目标

### 目标
- 让主 agent 能把长运行 / 交互式 PTY 命令委派出去，自身 context 只收自然语言总结。
- 委派的命令走 Go blockcontroller 真实 PTY，天然在 UI 可见、可被用户接管。
- `pty_read` 默认读后端 transcript tail，稳定可用；alt-screen / TUI 时按需增强为 renderer screen snapshot。
- 复用现有 `AgentHarness` / wshrpc / emain↔renderer 通道，不新造跨进程范式。

### 非目标（YAGNI）
- 不在 main 侧用 node-pty 自建 PTY（违反"命令必须 UI 可见可接管"）。
- 不把 harness 搬进 renderer。
- 第一阶段不做 emain headless grid（长期方向，需抽 shared engine）。
- 不做自动接管用户手动运行的 PTY（仅主 agent 主动委派时启动）。

---

## 3. 定位与边界

主 agent 的 shell 能力已存在（[`bash` 工具](file:///Users/bytedance/Documents/crest/emain/agent/tools/bash.ts#L131-L261)），适合**会自然结束的一次性命令**。CLI subagent 只在命令**不会自行退出**（长运行 / 交互式）时介入。

| 命令类型 | 例子 | 谁执行 | 进主 agent context | 使用工具 |
| --- | --- | --- | --- | --- |
| 一次性（会自然结束） | `ls`、`git status`、`npm run build` | 主 agent 亲自跑 | output 原文进 context | [`bash`](file:///Users/bytedance/Documents/crest/emain/agent/tools/bash.ts#L131-L261) |
| 长运行 / 交互式 | `npm run dev`、`vim`、`top`、`ssh` 会话 | **委派 CLI subagent** | 只回自然语言总结 | `spawn_cli_agent` → pty 三件套 |

**判定信号**：沿用 Warp `RequestCommandOutput` 的 `wait_until_completion`（[action/mod.rs#L43-47](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action/mod.rs#L43-L47)）。主 agent 决定"这条命令我等不到它结束"时，调 `spawn_cli_agent` 而非 `bash`。辅助字段 `is_read_only` / `is_risky`（同 enum，[action/mod.rs#L37-41](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action/mod.rs#L37-L41)）与 `uses_pager`（[#L49-50](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action/mod.rs#L49-L50)）可用于门控。

### 3.1 触发规则

CLI subagent **只在主 agent 主动委派时启动**。用户手动运行 PTY 命令不自动启动 CLI subagent。

| 场景 | 是否启动 | 处理 |
| --- | --- | --- |
| 主 agent 决定执行长运行 / 交互式命令 | ✅ 是 | 主 agent 调 `spawn_cli_agent`，subagent 负责启动/观察/交互/总结 |
| 主 agent 执行一次性命令 | ❌ 否 | 继续使用 [`bash`](file:///Users/bytedance/Documents/crest/emain/agent/tools/bash.ts#L131-L261) |
| 用户手动运行 PTY 命令 | ❌ 否 | 用户是操作者，只记录命令与输出，不自动接管 |
| 用户要求 agent 分析/接管已有 PTY | ✅ 可选 | 需明确用户意图或确认，可通过 `attach_to_block_id` 扩展接管 |

这个边界避免权限混乱：用户手动输入命令时，agent 不应后台观察、判断、替用户按键。未来若要接管已有命令，应显式调用 `spawn_cli_agent { task, attach_to_block_id }`，而不是自动发生。

### 3.2 Context 边界

已在 [HTML §8.3](file:///Users/bytedance/Documents/crest/docs/agent-dual-mode-design.html) 敲定：
- 主 agent 亲自跑的一次性命令 → output **原文**进 context。
- 委派 subagent 的交互 / 长运行命令 → `pty_read` 的原始输出全程只在 subagent 内部循环，**不进主 agent context**；主 agent 只拿总结。
- 命令输出可按需落 SQLite session 供 UI replay / 审计，不进任何 agent 的长期 context。

---

## 4. 架构

```
主 agent (PaneHarness)
   │  tool_call: spawn_cli_agent { task, initial_command, cwd }
   ▼
spawn_cli_agent.execute()          ← 新建①：挂在主 agent 上的委派工具
   │  new AgentHarness(独立 session + 独立 context)
   ▼
CLI subagent (CliSubagentHarness)  ← 新建②：仿 buildPaneHarness 的 factory
   │  循环: pty_read → 判断 → pty_write → ...      ← 新建③：pty 工具三件套
   │  PTY 输出只在此 harness 的 turn 内流转
   ▼
返回自然语言总结 → 作为 AgentToolResult.content 回主 agent
```

### 4.1 架构选型结论：方案 A + fallback（已定）

**跨进程 emain↔Go↔renderer 的 RPC 编排（方案 A）是落地路线**：

| 方案 | 概述 | 结论 |
| --- | --- | --- |
| **A. emain 跨进程编排** ✅ **采用** | subagent 在 emain 跑 harness，pty_write 走 wshrpc→Go [`ControllerInput`](file:///Users/bytedance/Documents/crest/frontend/app/term/terminal-model.ts#L434-L443)，pty_read 默认读 Go transcript tail、TUI 时问 renderer 要 screen snapshot | 通道骨架已存在（[`ElectronWshClient`](file:///Users/bytedance/Documents/crest/emain/emain-wsh.ts#L13-L158) / [emain→renderer 请求-响应](file:///Users/bytedance/Documents/crest/emain/emain-web.ts#L7-L25)），只需补两个 handler；命令天然在 UI 可见 |
| B. 把 harness 搬进 renderer | 让 agent 循环跟 PTY 同进程 | harness 深度依赖 Node（fs/child_process/LLM SDK），搬迁代价过大，弃 |
| C. main 用 node-pty 自建 PTY | 绕开 Go，emain 自起 PTY | 违反决策 1（命令必须在 UI 可见、可被用户接管），弃 |
| D. 快照渲染改到 Go 侧 | Go 重建 grid 供 screen snapshot | 需重写一套 grid 渲染器，代价远大于加 IPC handler，弃 |

**为什么跨进程可接受**：Electron 本质多进程，[`emain-web.ts`](file:///Users/bytedance/Documents/crest/emain/emain-web.ts) / [`emain-wsh.ts`](file:///Users/bytedance/Documents/crest/emain/emain-wsh.ts) 已证明项目大量做 emain↔renderer↔Go 的 RPC，非新范式；LLM 轮次延迟（数百 ms~数 s）让 IPC 的几 ms 不构成瓶颈。

**唯一真实痛点 = renderer 不可用**。解法是给 `pty_read` 加 fallback（决策 3 的 `mode:"auto"` 即此 fallback 的落地形态）：
- 普通命令（build/log/server）→ 走 **transcript tail**，不惊动 renderer。
- 全屏 TUI（alt-screen，如 `vim`/`top`）→ **优先问 renderer 要 screen snapshot**；renderer 超时/销毁时降级到 transcript tail 并标 `degraded:true`。
- 降级下全屏 TUI 会失真，但这是**退化而非不可用**。

> 统一了一处早期表述矛盾：方案 A 原始草稿是"pty_read 一律 renderer-first、失败降级 transcript"；后续几轮把默认翻转为 transcript-first。最终定稿用 `mode:"auto"` 收敛为——**默认 transcript-first，仅在 alt-screen/TUI 时 renderer-first，且 renderer 失败一律降级 transcript**。主/备关系不再随命令类型摇摆，由 `mode` 显式决定。

### 4.2 复用（零改动）
- [`AgentHarness`](file:///Users/bytedance/Documents/crest/emain/agent/harness/agent-harness.ts)：CLI subagent 就是第二个实例，独立 session、独立 context。turn / tool-call 循环、`setActiveTools`、tool_call gate 全部复用。
- [`AgentTool` / `AgentToolResult`](file:///Users/bytedance/Documents/crest/emain/agent/types.ts#L344-L394)：pty 三件套与 `spawn_cli_agent` 都实现这个接口。
- [`runAgentLoop`](file:///Users/bytedance/Documents/crest/emain/agent/agent-loop.ts)：subagent 的 tool 执行直接复用。
- [permissions gate](file:///Users/bytedance/Documents/crest/emain/agent/permissions.ts)：subagent 可挂自己的 `ToolCallHook`（如 `is_risky` 门控）。

### 4.3 新建
| # | 产物 | 位置（建议） | 仿照 |
| --- | --- | --- | --- |
| ① | `spawn_cli_agent` 工具 | `emain/agent/tools/spawn-cli-agent.ts` | [`bash.ts`](file:///Users/bytedance/Documents/crest/emain/agent/tools/bash.ts#L131-L261) 的工具结构 |
| ② | `buildCliSubagentHarness()` | `emain/agent/cli-subagent-factory.ts` | [`buildPaneHarness`](file:///Users/bytedance/Documents/crest/emain/agent/harness-factory.ts#L83-L135) |
| ③ | pty 三件套 | `emain/agent/tools/pty-*.ts` | [`bash.ts`](file:///Users/bytedance/Documents/crest/emain/agent/tools/bash.ts) + typebox schema |

---

## 5. 关键实现决策

最核心的约束：**agent harness 跑在 emain（Node main 进程），但 PTY 执行与终端渲染跨在 frontend renderer + Go blockcontroller**。现有 [`bash` 工具用 node `spawn` 直接在 main 侧起子进程](file:///Users/bytedance/Documents/crest/emain/agent/tools/bash.ts#L59-L119)，没有真实 PTY、不能中途交互、要求命令自行结束——对长运行/交互式命令不适用。以下六个决策据此展开。

### 决策 1：PTY 命令由 blockcontroller 托管（不 main 自建）

| 方案 | 说明 | 取舍 |
| --- | --- | --- |
| **A. 复用 Go blockcontroller** ✅ | 命令作为真实 cmd controller 跑在 [`shellcontroller`](file:///Users/bytedance/Documents/crest/pkg/blockcontroller/shellcontroller.go#L525-L590)，UI 经既有 `BlockFile_Term` 通道实时渲染 | 命令天然在 UI 可见；复用成熟的输入/尺寸/信号通道；subagent 只是"自动化的用户" |
| B. main 用 node-pty 自建 | main 侧起 PTY + 自跑 engine 渲染 | UI 不可见（要再镜像一遍），重复造轮子，弃用 |

**采用 A**。与既定设计"用户直跑 vs agent 发起，用 `source` 标记区分同一套 tool_call/toolResult"吻合——subagent 发起的命令就是 `source:"agent"` 的 cmdblock。控制器生命周期见 [`blockcontroller-lifecycle.md`](file:///Users/bytedance/Documents/crest/aiprompts/blockcontroller-lifecycle.md)。

### 决策 2：pty_write 走 ControllerInput RPC，不碰 node 子进程

写输入复用现成的 [`ControllerInputCommand`](file:///Users/bytedance/Documents/crest/frontend/app/term/terminal-model.ts#L434-L443) → Go [`SendInput`](file:///Users/bytedance/Documents/crest/pkg/blockcontroller/blockcontroller.go)。`BlockInputUnion` 已支持原样字节输入，三种 mode 的字节装饰**严格对齐 Warp [`AIAgentPtyWriteMode::decorate_bytes`](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action/mod.rs#L779-L822)**：

| pty_write mode | 字节装饰（对齐 Warp） | 用途 |
| --- | --- | --- |
| `raw` | 原样透传 `bytes` | 控制键，如 Ctrl-C = `\x03`（对齐 [`sendInterrupt`](file:///Users/bytedance/Documents/crest/frontend/app/term/terminal-model.ts#L441-L443)） |
| `line` | `SOH(\x01)` + `bytes` + 提交符：POSIX 用 `LF(\n)`、Windows 用 `CR(\r)` | 回答交互式 prompt；`^A` 是 readline/prompt-toolkit 的"行首"，先归位再输入再回车（Warp [action/mod.rs#L791-807](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action/mod.rs#L791-L807)） |
| `block` | 仅当 `is_bracketed_paste_enabled` 为真时用 `\x1b[200~` … `\x1b[201~` 包裹，否则原样透传 | 多行粘贴不触发自动执行（Warp [action/mod.rs#L808-819](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action/mod.rs#L808-L819)） |

> Warp `decorate_bytes` 的第二个参数 `is_bracketed_paste_enabled` 由终端当前状态决定；crest 侧该状态可从 [`cmdblock/tracker`](file:///Users/bytedance/Documents/crest/pkg/cmdblock/tracker.go) 的终端模式位取得（若尚未跟踪，第一阶段可保守地在 `block` 模式默认启用 bracketed-paste，与 Warp 的常见路径一致）。

> emain 已有 [`ElectronWshClient`](file:///Users/bytedance/Documents/crest/emain/emain-wsh.ts#L13-L158) / `RpcApi.*Command` 这条 wshrpc 通道；本设计不是从零打通跨进程通信，而是在现有通道上补齐"agent 发起 cmd block"与"向 block controller 写输入"这两类能力。

### 决策 3：pty_read 默认读后端 transcript tail，renderer screen snapshot 只是增强

CLI subagent 多数时候只需要"命令最近输出了什么"，不需要 Warp-style 当前屏幕。因此 `pty_read` 的默认来源是 Go 后端已有的 PTY 输出（`BlockFile_Term` / cmdblock output tail），而非 renderer grid。

| 读取层级 | 来源 | 适用场景 | 取舍 |
| --- | --- | --- | --- |
| **transcript tail** ✅ 默认 | Go 后端 `BlockFile_Term` / cmdblock output | `npm run dev`、build/test/install/server log | 不依赖 renderer；能读最近 N 行和 exit code；不是精确屏幕 |
| screen snapshot | renderer 的 [frontend terminal engine](file:///Users/bytedance/Documents/crest/frontend/app/term/engine/types.ts) grid | `vim`、`top`、`less`、`lazygit`、alt-screen TUI | 精确表达当前屏幕；依赖 renderer 存活 |
| emain headless grid | emain 订阅 PTY bytes 自建 grid | 长期方向 | 可摆脱 renderer；但要抽 shared engine，第一阶段不做 |

**采用分层读取**：`pty_read(mode:"auto")` 先读 transcript tail；只有检测到 alt-screen / TUI，或 subagent 明确要求 `mode:"screen"` 时，才问 renderer 要 screen snapshot。renderer 不可用时返回 transcript tail 并标记 `degraded:true`。这把 renderer 从基础依赖降级为增强能力。

#### 3a. `auto` 如何区分 transcript vs screen（不靠猜）

判定依据 **Go 服务端已有的 alt-screen 状态位**，不是前端 renderer，也不是 subagent 主观判断：

- [`cmdblock/tracker.go` 的 `detectAltScreen`](file:///Users/bytedance/Documents/crest/pkg/cmdblock/tracker.go#L177-L208) 已在 PTY 读循环里扫描 `CSI ?1049h`（进）/ `CSI ?1049l`（出），维护 `t.altScreen` 布尔，并广播 [`cmdblock:altscreen` 事件](file:///Users/bytedance/Documents/crest/pkg/cmdblock/cbtypes/types.go#L32-L41)（带 `Enter bool`）。
- 因此 emain 侧读 block output tail 的那个 RPC（落地清单步骤 2b）**顺带回传当前 `altScreen` 状态**，`auto` 据此分流：

| 后端 `altScreen` | `mode:"auto"` 行为 |
| --- | --- |
| `false`（普通命令） | 只读 transcript tail，**不惊动 renderer** |
| `true`（vim/top/lazygit 等 alt-screen TUI） | 先问 renderer 要 screen snapshot；超时/renderer 销毁 → 降级 transcript tail + `degraded:true` |

> "是不是 TUI"的判断在 Go 一侧就有权威答案，`auto` 不需要"控制序列多不多"之类启发式，也不需要 renderer 参与判定。`is_alt_screen_active` 字段直接来自这个后端状态位；仅当真的走了 screen snapshot 分支时，才用 renderer 的 [`Block.altScreen.active`](file:///Users/bytedance/Documents/crest/frontend/app/term/engine/block.ts#L270-L276) 校准。
>
> 已知边界：`detectAltScreen` 注释说明——若 `?1049h/l` 序列**恰好跨两个 chunk 被劈开**会漏检，但 app 通常会在下一次 toggle 重新发出。对 subagent 影响可接受（最坏一次 read 走错分支），必要时可在 emain 侧对 tail 内容做二次 `?1049` 兜底扫描。

#### 3b. transcript tail 的数据必须稳定可用（避开循环文件坑）

`BlockFile_Term` 是**循环文件**：shell 重启会 reset、写入超过 `MaxSize` 会 wrap（见 [`filestore` 的 `DataStartIdx`/`DataLength`](file:///Users/bytedance/Documents/crest/pkg/filestore/blockstore.go#L66-L83)）。历史上正因直接按绝对 offset 切这个共享文件，导致 shell 重启后 offset 串位、渲染出别的会话字节——[migration 000013](file:///Users/bytedance/Documents/crest/db/migrations-wstore/000013_cmdblock_output.up.sql) 为此给每个 cmdblock 加了独立 `output_data` BLOB 快照。transcript tail 必须绕开同样的坑，按命令**是否已结束**分两条取法：

| 命令状态 | 数据来源 | 稳定性保证 |
| --- | --- | --- |
| **运行中**（subagent 主循环里最常见） | 从 `BlockFile_Term` **尾部**倒读最近 N 行：`ReadFile` 拿 `(offset, data)` 后从末尾切；用 [`filestore.ReadAt`](file:///Users/bytedance/Documents/crest/pkg/filestore/blockstore.go#L380-L388) 按 `DataStartIdx()`~`Size` 的**有效区间**读，绝不用陈旧绝对 offset | 只读"当前有效窗口的尾部"，天然对 wrap/reset 免疫；读的是最新字节 |
| **已结束**（拿到 exit code） | 优先读该 cmdblock 的独立 [`output_data` 快照](file:///Users/bytedance/Documents/crest/pkg/wshrpc/wshserver/wshserver.go#L1525-L1540)（`GetCmdBlockOutputCommand`，capped 256KB，命令完成时抓存） | 与共享循环文件的生命周期解耦，shell 重启也不失真 |

落地要点（写进步骤 2b）：
- emain 侧 output-tail RPC **不接受 caller 传绝对 offset**，只接受 `max_lines` / `max_bytes`，offset 计算全在 Go 端基于当前 `DataStartIdx()`~`Size` 完成，不把循环文件的坑暴露给 subagent。
- 返回结构里的 `exit_code` / `is_running` 来自 controller 的 `ProcStatus`/`ProcExitCode`（见 [`shellcontroller` wait 循环](file:///Users/bytedance/Documents/crest/pkg/blockcontroller/shellcontroller.go#L525-L590)），让 subagent 可靠判断"命令是否已结束"从而切到 `output_data` 快照。
- tail 文本按需去 ANSI（subagent 读的是语义文本，不是渲染帧）。

> transcript tail 的"稳定可用"不是新造轮子——运行中走 filestore 有效区间尾读、结束后走 `output_data` 快照，都是复用 crest 已踩过坑、已存在的机制。

### 决策 4：subagent 用临时 session，只有总结落主会话

主会话是 `SqliteSessionRepo`。subagent 的 transcript（内部 pty_read/pty_write 往返）对用户价值低、量大。

- subagent → **内存/临时 session**，不落主 SQLite 会话文件，随委派结束销毁。
- 进主会话 SQLite 的核心结果是 `spawn_cli_agent` 的 **toolResult = 那段自然语言总结**。命令输出 / snapshot 是否额外落库，只服务 UI replay / 审计，不进任何 agent context（见 [HTML §8.1](file:///Users/bytedance/Documents/crest/docs/agent-dual-mode-design.html)）。

### 决策 5：spawn_cli_agent 自带首命令，subagent 只围绕已有 block_id

Warp 的 `WriteToLongRunningShellCommand` / `ReadShellCommandOutput` 都带 `block_id`——即命令已启动。crest 对齐：`spawn_cli_agent` 参数带 `initial_command`，`execute` 内**先启动 cmd block、拿到 blockId**，再进 subagent 循环。这样 subagent 三件套都围绕一个已存在的 blockId，**不需要第 4 个 `pty_start` 工具**。

```ts
// spawn-cli-agent.ts —— 主 agent 挂载的委派工具
const schema = Type.Object({
  task: Type.String({ description: "自然语言目标，如：启动 dev server 并确认监听 3000" }),
  initial_command: Type.String({ description: "启动这条长运行/交互式命令" }),
  cwd: Type.String(),
});

async execute(_id, { task, initial_command, cwd }, signal) {
  // 1. 经 RPC 让 blockcontroller 起一个 cmd controller，拿 blockId（source:"agent"）
  const blockId = await startAgentCommandBlock(cwd, initial_command);

  // 2. 建独立 subagent harness：只挂 pty 三件套 + 更小 model + 独立 system prompt
  const sub = buildCliSubagentHarness({ model: SMALL_MODEL, blockId, cwd });

  // 3. abort 透传：主 agent 中止 → 停 subagent + 停命令
  signal?.addEventListener("abort", () => { sub.harness.abort(); stopBlock(blockId); });

  // 4. 驱动 subagent 跑到收敛（agent_end / terminate / 步数上限），提取总结
  const summary = await runSubagentToCompletion(sub, task, { maxTurns: 20, signal });

  // 5. 只回自然语言总结；PTY 原始输出不冒泡到主 agent context
  return { content: [{ type: "text", text: summary }], details: { blockId } };
}
```

`runSubagentToCompletion` 复用 harness 的 [`prompt` / `subscribe` / `abort`](file:///Users/bytedance/Documents/crest/emain/agent/harness/agent-harness.ts) 驱动（与 [`PaneAgentSession`](file:///Users/bytedance/Documents/crest/emain/agent/pane-agent-session.ts#L379-L387) 的 `startPromptTurn` 同构）：`prompt(task)` → 监听事件流至 `agent_end` → 从最终 assistant 消息取总结文本。

### 决策 6：终止与容错

| 情形 | 处理 |
| --- | --- |
| 命令自然退出（拿到 exit code） | 对齐 Warp `CommandFinished`；subagent 读到后产出总结并 `terminate` |
| subagent 完成 task | `AgentToolResult.terminate` 停止（[types.ts L350-354](file:///Users/bytedance/Documents/crest/emain/agent/types.ts#L350-L354)） |
| 步数超 `maxTurns` | 强制要求 subagent 产出"当前进展总结"后返回，防死循环 |
| subagent 卡住（等密码/需决策） | 调 `pty_transfer_to_user`：spawn_cli_agent 提前返回，blockId 留给用户在 UI 继续操作 |
| 主 agent abort | signal 透传 → `sub.harness.abort()` + 停 block |

---

## 6. PTY 工具三件套（subagent 私有）

每个工具实现 [`AgentTool`](file:///Users/bytedance/Documents/crest/emain/agent/types.ts#L361-L394) 接口，`execute` 返回 [`AgentToolResult`](file:///Users/bytedance/Documents/crest/emain/agent/types.ts#L344-L355)。`pty_read` 默认返回最近输出 tail；需要精确 TUI 屏幕时才返回 renderer screen snapshot。

| 工具 | Warp action 对应 | 作用 |
| --- | --- | --- |
| `pty_write` | `WriteToLongRunningShellCommand`（[action/mod.rs#L59-63](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action/mod.rs#L59-L63)） | 往运行中的 PTY 写输入 |
| `pty_read` | `ReadShellCommandOutput`（[action/mod.rs#L124-127](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action/mod.rs#L124-L127)） | 读 PTY 输出（默认 transcript tail，按需 screen snapshot） |
| `pty_transfer_to_user` | `TransferShellCommandControlToUser`（[action/mod.rs#L161-165](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action/mod.rs#L161-L165)） | 卡住时交还控制权给用户 |

### 6.1 `pty_write` 参数
对应 Warp `AIAgentPtyWriteMode` + `decorate_bytes`（[action/mod.rs#L771-822](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action/mod.rs#L771-L822)）：

```ts
Type.Object({
  block_id: Type.String({ description: "The running PTY command to write to" }),
  input: Type.String({ description: "Bytes / text to send" }),
  mode: Type.Union([
    Type.Literal("raw"),   // 原样透传 bytes（发控制键，如 Ctrl-C = \x03）
    Type.Literal("line"),  // SOH(\x01) + input + 提交符（POSIX 用 \n，Windows 用 \r）
    Type.Literal("block"), // is_bracketed_paste_enabled 时 bracketed-paste 包裹，否则原样
  ]),
})
```

> **严格对齐 Warp（勿简化）**：`line` **不是**简单追加 `\r`——Warp 先发 `SOH(^A,\x01)` 归到行首、再发 input、再发提交符（POSIX `LF`，Windows `CR`）；`block` 的 bracketed-paste 受 `is_bracketed_paste_enabled` 门控。实现按平台与终端状态分支，见决策 2 表。

### 6.2 `pty_read` 参数 / 返回
参数含 `delay`（读之前等多久让输出落定，对应 Warp `ShellCommandDelay` [action/mod.rs#L765-769](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action/mod.rs#L765-L769)，含 `Duration` / `OnCompletion` 两态）和 `mode`：

```ts
Type.Object({
  block_id: Type.String(),
  delay_ms: Type.Optional(Type.Number()),
  mode: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("transcript"),
    Type.Literal("screen"),
  ])),
  max_lines: Type.Optional(Type.Number()),
})
```

默认返回 transcript tail：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `block_id` | `string` | 关联的运行块 |
| `source` | `"transcript_tail"` | 表明这是后端输出尾部，不是当前屏幕 |
| `text` | `string` | 最近 N 行去 ANSI 后文本 |
| `is_running` | `boolean` | 命令是否仍在运行 |
| `exit_code` | `number?` | 命令已结束时返回 |
| `approximate` | `true` | transcript tail 不是精确屏幕状态 |
| `degraded` | `boolean?` | 请求 screen 但 renderer 不可用时置 true |

按需返回 screen snapshot 时，对齐 Warp `ReadShellCommandOutputResult::LongRunningCommandSnapshot`（[action_result/mod.rs#L561-568](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action_result/mod.rs#L561-L568)）：

| 字段 | 类型 | 说明 | Warp 源 |
| --- | --- | --- | --- |
| `grid_contents` | `string` | 屏幕渲染后的纯文本（**非** ANSI 字节流 / 连续帧） | [#L564](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action_result/mod.rs#L564) |
| `cursor` | `string` | 光标位置描述 | [#L565](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action_result/mod.rs#L565) |
| `is_alt_screen_active` | `bool` | 是否处于 alt-screen（vim/top 等全屏 TUI） | [#L566](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action_result/mod.rs#L566) |
| `block_id` | `BlockId` | 关联的运行块 | [#L563](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action_result/mod.rs#L563) |

> Warp 还带 `is_preempted`（[#L567](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action_result/mod.rs#L567)）与 `command`（[#L562](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action_result/mod.rs#L562)）字段；crest 第一阶段可省略 `is_preempted`（无抢占语义），`command` 由 blockId 侧已知。

> **不进主 context**：无论 transcript tail 还是 screen snapshot，都只喂给 CLI subagent 当前循环。主 agent 只收到总结。

### 6.3 输出来源（crest 侧）
默认 transcript tail 来自 Go 后端已有 PTY 输出链路：[`shellcontroller`](file:///Users/bytedance/Documents/crest/pkg/blockcontroller/shellcontroller.go#L525-L590) 读 PTY bytes 并 append 到 `BlockFile_Term`。screen snapshot 来自已渲染的 frontend grid（逐行拼 `Cell.char`），不重新解析字节流。第一阶段只要求 transcript tail 跑通；screen snapshot 是 TUI 增强。

---

## 7. 委派契约

```
主 agent ──task(自然语言)──▶ CLI subagent
                                  │ 独立 context（不含主会话历史，只有 task + system prompt）
                                  │ 循环: pty_read → 判断 → pty_write → ...
                                  │ PTY 输出全程只在 subagent turn 内
主 agent ◀──总结(自然语言)──────┘ 关键错误 / 报错原文照抄
```

- **输入**：`spawn_cli_agent { task, initial_command, cwd }`。`task` 是目标描述（"启动 dev server 并确认监听在 3000 端口"），不是命令行。
- **输出**：`AgentToolResult.content` = 一段自然语言总结。这段总结（且仅这段）进主 agent context。
- **输出隔离**：subagent 内部的 `pty_read` 输出喂给它自己的下一轮推理，**不**冒泡到主 agent。主会话只记录总结；必要时另存输出供 replay。

---

## 8. Subagent system prompt 要点

1. **目标导向**：完成 `task` 即调用 `terminate` 停止（[`AgentToolResult.terminate`](file:///Users/bytedance/Documents/crest/emain/agent/types.ts#L350-L354)），不做额外探索。
2. **先看后动**：每步操作前先 `pty_read` 确认当前输出 / 屏幕状态，不盲发输入。
3. **错误原文照抄**：总结里遇到报错 / 关键 file:line **必须逐字引用**，不许有损概括——主 agent 靠这段总结定位问题。
4. **卡住即移交**：无法判断下一步（等待密码、需要人工决策）时调 `pty_transfer_to_user`（对应 Warp `TransferShellCommandControlToUserResult` [action_result/mod.rs#L1352-1369](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action_result/mod.rs#L1352-L1369)），不要瞎猜。
5. **步数上限**：设最大 turn 数，超限即移交，防死循环。

---

## 9. 模型选择

CLI subagent 干的是机械的"读输出 / 看屏幕—敲键—判断"活，可用**更小 / 更快模型**（成本、延迟双优）。model 是 [`AgentHarness`](file:///Users/bytedance/Documents/crest/emain/agent/harness/agent-harness.ts) 构造参数，`buildCliSubagentHarness()` 独立配置即可，与主 agent 模型解耦。

---

## 10. 落地清单

按依赖顺序。第一阶段优先跑通 Go 侧 transcript tail；renderer screen snapshot 作为 TUI 增强延后。

| 步骤 | 文件 / 位置 | 动作 | 依据 |
| --- | --- | --- | --- |
| 1 | `emain/agent/tools/pty-write.ts` `pty-read.ts` `pty-transfer.ts` | 新增三件套（typebox schema + `execute`），围绕已有 `blockId`；`pty_read` 默认 transcript tail | §6 |
| 2a | emain → Go RPC | 打通 emain 调 `ControllerInput`（发 raw/line/block 字节）与"起 cmd block 拿 blockId" | 决策 2 / 5 |
| 2b | emain → Go output tail | 加"按 blockId 返回最近 N 行输出 + running/exit_code + **当前 altScreen 状态**"的读取接口；**只收 max_lines/max_bytes 不收绝对 offset**，运行中走 filestore 有效区间尾读、已结束走 `output_data` 快照 | 决策 3（3a/3b） |
| 2c | renderer 查询接口（增强） | 加"按 blockId 返回渲染文本 + cursor + is_alt_screen_active"的查询，用于 TUI / alt-screen；仅在 2b 回传 `altScreen=true` 或 `mode:"screen"` 时调用，失败降级 transcript + `degraded` | 决策 3（3a） |
| 3 | `emain/agent/cli-subagent-factory.ts` | 新增 `buildCliSubagentHarness()`（仿 [`buildPaneHarness`](file:///Users/bytedance/Documents/crest/emain/agent/harness-factory.ts#L83-L135)，tools 只挂三件套，独立 system prompt + 更小 model，临时 session） | 决策 4 / 6 |
| 4 | `emain/agent/tools/spawn-cli-agent.ts` | 新增委派工具：起 block → new subagent harness → `runSubagentToCompletion` → 返回总结。透传 abort | 决策 5 / 6 |
| 5 | 主 agent 工具注册处 | 把 `spawn_cli_agent` 加入主 agent tools（与 `bash` 并列） | §3 |
| 6 | subagent system prompt | 写 §8 五条要点 | §8 |
| 7 | 测试 | 见 §11 | 决策 6 |

> **最小可行切片**：先只实现 transcript tail（最近 N 行 `BlockFile_Term` 的纯文本近似），把三件套 + 委派链路跑通；screen snapshot 后续作为 TUI 增强补齐。

---

## 11. 测试策略

| 测试点 | 验证内容 |
| --- | --- |
| subagent 循环收敛 | 给定 task + initial_command，subagent 能 pty_read→判断→pty_write→…→`terminate`，返回非空总结 |
| abort 透传 | 主 agent abort → `sub.harness.abort()` 被调用 + block 被停 |
| context 隔离 | `pty_read` 原始输出**不**出现在主 agent context；主 agent 只收总结 |
| 超步移交 | 步数超 `maxTurns` 时强制产出进展总结并返回，不死循环 |
| pty_write 三 mode | `raw` / `line`（追加 `\r`）/ `block`（bracketed-paste 包裹）字节正确 |
| transcript tail 稳定性 | 运行中从 filestore 有效区间尾读、命令结束后读 `output_data` 快照；shell 重启 / wrap 后不串位 |
| auto 分流 | `altScreen=false` 只走 transcript 不调 renderer；`altScreen=true` 走 screen snapshot，renderer 不可用时降级 transcript + `degraded:true` |

---

## 12. 未解决 / 长期项

- **Renderer Lease / pin renderer 机制**：保证走 screen snapshot 时 renderer 不被销毁的细化方案，待定。
- **emain headless grid**：第二阶段抽 shared headless terminal engine 到 emain，摆脱 renderer 依赖。
- **`degraded` 语义细节**：降级返回的字段约定与主 agent 提示措辞待细化。
- **`attach_to_block_id` 接管已有 PTY**：触发规则里预留的扩展，未来支持。

---

## 附：Warp 源码引用清单

> 引用基于本地 Warp checkout：`/Users/bytedance/Documents/warp`（Warp 非公开仓库，不用 GitHub 链接；行号以此 checkout 为准，随版本可能漂移，实现前请复核符号名而非仅行号）。

- action 枚举：[`crates/ai/src/agent/action/mod.rs`](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action/mod.rs)
  - `AIAgentActionType` enum L30-31 · `RequestCommandOutput`（含 `is_read_only`/`is_risky`/`wait_until_completion`/`uses_pager` 字段）L34-57 · `WriteToLongRunningShellCommand` L59-63 · `ReadShellCommandOutput` L124-127 · `TransferShellCommandControlToUser` L161-165 · `ShellCommandDelay` L765-769 · `AIAgentPtyWriteMode` L771-777 · `decorate_bytes` L779-822
- result 枚举：[`crates/ai/src/agent/action_result/mod.rs`](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action_result/mod.rs)
  - `RequestCommandOutputResult::LongRunningCommandSnapshot` L187-193 · `ReadShellCommandOutputResult`（`CommandFinished` L553-560 / `LongRunningCommandSnapshot` L561-568）· `triggers_server_subagent` L910-923 · `TransferShellCommandControlToUserResult` L1352-1369
