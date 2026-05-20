# Crest Agent 改造计划 (基于 Warp 分析)

源文档：`docs/warp-agent-analysis.md`
生成日期：2026-05-19

五个阶段的实施排期、子任务、收益、风险与验收标准。P0 是后插入的基础设施前置（详见下方说明）。

## 排期逻辑

五个 phase 按"先基础设施、再小后大、再低风险后高风险"排：

| Phase | 任务 | Effort | 排序理由 |
|---|---|---|---|
| **P0** | Track C — Agent UI 在新引擎上重连 | M (~9d) | **前置基础设施**。term-engine 迁移后 agent UI 不存在，P1.4 / P2 / P3 / P4 都需要一个能渲染 tool-use card 的宿主。详见 `docs/term-engine-migration.md` Track C。 |
| **P1** | Typed Citations | S | 最小，建立 audit-log → SSE → UI 的 pattern。后续几个任务都要走这条管道。**P1.4 已收编到 P0.4**。 |
| **P2** | ask_user_question | S | 复用 P1 的 SSE 消息形态（多了一个 card 类型）。 |
| **P3** | Markdown delta 渲染 | S–M | 纯 FE 改动，跟后端解耦，可以和 P4 并行。必须先 profile 确认瓶颈再动手。 |
| **P4** | 长时间命令工具组 | M | 最大，涉及 PTY 所有权移交。前面 P1/P2 的 UI 管道熟了，做这个的边际成本低。 |

**总工期估算**：P0 ~9d + 3 个 S 周 + 1 个 M 周 ≈ **5 周单人**。P3 和 P4 可并行 → 压缩到 ~4 周。

### 进度状态（2026-05-19）

- **P1.1 / P1.2 / P1.3 / P1.5 已完成** — Citation 类型 + 三工具接入 + audit 拷贝 + Go 单测全部 ship 到 backend，等 P0 落地后 UI 端能直接消费。
- **P1.4 已收编到 P0.4** — citation chip 渲染是 ToolUseCard 的一部分，不再单独成 phase。
- **P0 待启动** — 见下方 `## P0` 章节。

---

## P0 — Track C: Agent UI 在新引擎上重连（~10 天）

源文档：`docs/term-engine-migration.md` § Track C (P19)。

### 背景

Term-engine migration（P1–P16）把旧的 `view/term/term-agent.tsx`（810 LOC）连同 `TermAgentChatProvider`、`term-agent-tool-renderer.tsx` 一起删了。新引擎 (`frontend/app/term/`) 完成了 cell-grid + block 渲染，但 agent UI 没接回来 —— `frontend/app/term/render/terminal-view.tsx:511-516` 显式注明 "Agent overlay is not wired in this engine revision"。

后端（`pkg/agent/` + `pkg/aiusechat/`）完全 ready 并且 P1.1–P1.3 已经把 Citation 字段铺到了 SSE 上，只是没有 FE 消费者。**P0 解决这件事**，P1.4 / P2 / P3 / P4 全部依赖它。

### 设计决策（开工前 lock）

1. **C1 vs C2 → 选 C2（unified blocklist，按创建顺序 append）**
   - C2 = `Block.kind = "agent"` 变体，与 shell block 共用一条 blocklist，**按创建时定位**（默认 append 到末尾），创建之后位置不再改。**不**做 timestamp 后排序。
   - Warp 实际模型：blocklist 是 `BlockList { blocks: Vec<Block>, removable_blocklist_item_positions: HashMap<RemovableBlocklistItem, TotalIndex> }` (`app/src/terminal/model/blocks.rs:234, 239-260`)。Agent block 通过 `RemovableBlocklistItem::RichContent` 变体加入，定位 API 全是显式锚点 (`insert_rich_content_before_block_index` / `insert_rich_content_after_item` / `append_item_to_blocklist`，`blocks.rs:3247, 3263, 1074`)。Agent 会话本身是 `live_conversation_ids_for_terminal_view: Vec<AIConversationId>` 纯 push (`history_model.rs:668, 843`)。`SumTree<BlockHeightItem>` 只服务 O(log N) viewport 查询，不参与排序。
   - `docs/agent-architecture.md` §12 也是 C2。Engine 改动是纯加法。

2. **输入入口 → 复用 `cmdblock-input.tsx`**
   - 已有的 1595 LOC 输入条已经有 `mode: "terminal" | "agent" | "auto"` 三态、NLD 分类器、`onSubmit(text, mode)` 回调。不新建 overlay。`mode === "agent"` 时 `onSubmit` 走 useChat 而非 PTY。

3. **useChat 放哪 → `TerminalView` 组件层**
   - TerminalModel 不直接持有 ai-sdk message 对象（避免 jotai/useChat 双 reactive 撞车，Track C 文档列的最大风险）。TerminalModel 只持稳定引用 atoms，useChat 的 message stream 通过 `useEffect` 同步到 block。

4. **Port strategy（依据用户答 B / B / A）**：
   - **Q1=B (minimum subset)**：v1 port 6 个核心 warp 源文件，多 agent / orchestration / secret_redaction / RAG 卡片留 v2。
   - **Q2=B (crest TS 命名)**：保留 warp 语义但用 crest kebab-case TS 命名。
   - **Q3=A (tight behavior port)**：组件分解 / state shape / props / 状态机 / keybinding 1:1 跟 warp；**视觉常量**（颜色、间距）用 crest Tailwind token 而非 warp `pathfinder_color::ColorU` 字面值（保持与 crest 其他 UI 视觉一致）。

5. **v1 范围裁剪（显式不做）**
   - ❌ Voice input wiring（`onVoiceInput` prop 留 stub）
   - ❌ Fast-forward toggle 后端（UI 留 disabled toggle）
   - ❌ Suggestions row 数据接入
   - ❌ Model picker 实际切换（disabled dropdown）
   - ❌ 跨 block 选中 / 复制 agent 文本
   - ❌ Multi-agent orchestration UI (`run_agents_card_view.rs`, `orchestration_pill_bar.rs`, `child_agent_status_card.rs`)
   - ❌ Secret redaction render (`secret_redaction.rs`) — backend 暂未挂这个，留 v2

6. **P1.4 与 P0.4 合并** — citation chip 不另立 phase。

### 许可证 & Attribution

Warp source 在 `/Users/mac/Documents/open-source/warp` 是 MIT (© 2020-2026 Denver Technologies, Inc.)。Port 合规要求：

1. **每个 derived TS 文件顶部加 attribution header**：
   ```ts
   // Copyright 2026, Crest contributors. SPDX-License-Identifier: Apache-2.0
   //
   // <Component name> — structure derived from warp/<source path>.
   // Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
   ```
2. **crest repo 根目录加 `NOTICES.md`**：贴 warp 的 LICENSE-MIT 全文 + 列出衍生文件清单。这是 MIT "include the permission notice in substantial portions" 的合规做法。
3. **Port 限于结构/state/UX**。不直接搬运 warp 源代码到 crest 文件里 — 是用 TS/React/Tailwind 等价实现 warp 描述的行为。

### 排期（v1: 6 个 warp 源文件 → 7 个 phases）

| Phase | Effort | Warp source | Crest target |
|---|---|---|---|
| **P0.1** Engine `Block.kind` + AgentBlock payload | S (~1d) | (engine 层，无直接 UI 对应) | `term/engine/block.ts`, `engine/types.ts`, `engine/blocks.ts` |
| **P0.2** TerminalModel agent atoms | S (~1d) | `app/src/ai/blocklist/history_model.rs:185-200` (`BlocklistAIHistoryModel`) | `term/terminal-model.ts` |
| **P0.3** Agent block element + header | S–M (~1.5d) | `agent_view/agent_view_block.rs` + `inline_agent_view_header.rs` | `term/render/agent-block-element.tsx` |
| **P0.4** Tool action cards (4 子组件) | M (~3.5d) | `inline_action/inline_action_header.rs` + `requested_command.rs` + `code_diff_view.rs` + `requested_command_attribution.rs` + `block/view_impl.rs:655-728` | `term/render/tool-action-header.tsx`, `tool-command-card.tsx`, `tool-diff-card.tsx`, `citation-chips.tsx` |
| **P0.5** useChat host + SSE bridge | S–M (~1.5d) | `controller/response_stream.rs:45-117` (结构参考) | `term/render/terminal-view.tsx` (host); 新方法在 `terminal-model.ts` |
| **P0.6** cmdblock-input mode=agent 路由 | S (~0.5d) | `agent_view/agent_message_bar.rs` (crest 已有更完整的 cmdblock-input.tsx) | `cmdblock-input.tsx` (parent wiring) |
| **P0.7** Smoke + citation jump + polish | S (~1d) | `block/view_impl.rs:655-728` (citation click 行为) | — |

---

### P0.1 — Engine: Block.kind + AgentBlock payload（S, ~1d）

- **Warp 对应**：engine 层无直接 UI 对应文件。语义上 mirror warp 的 `Block::AgentResponse` enum 变体（warp `agent_view_block.rs` 注册 block kind 的方式）。
- **Crest target**：`frontend/app/term/engine/block.ts`、`engine/types.ts`、`engine/blocks.ts`。
- **Port 策略**：纯加法，shell block 路径零变更。AgentPayload 字段名沿用 warp `AIAgentOutput` 语义（exchangeId、status、createdAt）。

#### 子任务

1. `frontend/app/term/engine/block.ts`：加 `kind: "shell" | "agent"` 字段，默认 `"shell"`，构造时可指定。
2. `engine/types.ts`：加 `AgentPayload` 类型 `{ exchangeId, userText, status: "streaming"|"done"|"error", createdAt }`。AgentBlock 通过新字段 `agentPayload?: AgentPayload` 携带。`createdAt` **仅作为 UI metadata**（如 "5s ago" 相对时间显示），**不参与 block 排序**。
3. `Block.appendAgentText(delta)` / `setAgentStatus()` 方法，给渲染层 mutate 用。Bump revision via 现有 `markDirty()`。
4. `engine/blocks.ts`：`appendAgentBlock(exchangeId, userText)` 工厂，**纯 append 到末尾**，不做任何按 timestamp 的位置查找。语义 mirror warp 的 `BlockList::append_item_to_blocklist` (`blocks.rs:1074`) + `live_conversation_ids_for_terminal_view.push` (`history_model.rs:668`)。位置一旦定下就不再改。
5. **Engine 不解析 ANSI** — agent block 跳过 AnsiParser。BlockHandler 看到 `block.kind === "agent"` 时 no-op（防御性）。

#### 收益

- Agent 消息正式进入 timeline，与 shell block **按创建顺序 append**（无 post-hoc 重排）—— warp 实际模型对齐。
- 给后续 P2 (`ask_user_question`) 和 P4 (long-running 命令的 agent 旁注) 提供统一容器。
- Engine 改动是纯加法，shell block 路径零变更，回归风险接近零。

#### 风险

- Block ID 命名冲突：agent block 也走 `BlockId` 类型。Mitigation：用 UUID（前缀 `agent_`）便于日志区分。
- Find（Cmd+F）目前只索引 shell block。v1 让 agent block 也参与（`Block.text()` 拼 `agentPayload.userText` + agent response），~10 LOC。

#### 验收

- 单测：`appendAgentBlock` append 到末尾，不影响已有 block 位置。
- 单测：连续混合 append (shell, agent, shell, agent) 后，顺序严格 = 调用顺序。
- 单测：`Block.kind === "agent"` 时 `AnsiParser.feed()` 不修改 grid。

---

### P0.2 — TerminalModel agent atoms（S, ~1d）

- **Warp 对应**：`app/src/ai/blocklist/history_model.rs:185-200` (`BlocklistAIHistoryModel`)。Atom 命名跟 warp field 对齐：
  - `agentChatStatusAtom` ↔ `AIAgentOutput.status`
  - `agentChatIdAtom` ↔ `AIConversationId` (history_model.rs:42)
  - `agentModelOverrideAtom` ↔ `OrchestrationConfig.model_id` (`orchestration_config.rs:12`)
  - `agentPostureAtom` 是 crest 特有（warp 用 BlocklistAIPermissions）
- **Crest target**：`frontend/app/term/terminal-model.ts`。
- **Port 策略**：方法签名跟 warp event handler 对齐。`applyAgentDelta` 等价 warp `UpdatedStreamingExchange` event (`history_model.rs:2177-2203`) 的 handler。

#### 子任务

1. `frontend/app/term/terminal-model.ts` 加 atoms：
   ```ts
   agentVisibleAtom: PrimitiveAtom<boolean>
   agentPostureAtom: PrimitiveAtom<string>  // "default" | "strict" | "bench"
   agentChatStatusAtom: PrimitiveAtom<"idle" | "streaming" | "error">
   agentChatIdAtom: PrimitiveAtom<string>
   agentModelOverrideAtom: PrimitiveAtom<string | null>
   ```
2. 方法 `submitAgentMessage(text)`：生成 exchangeId、`blocks.appendAgentBlock()`、把 exchangeId 暴露给 useChat 作 `id`。
3. 方法 `applyAgentDelta(exchangeId, delta)` / `applyAgentStatus(exchangeId, status)`：useChat 的 onChunk 调这两个把 message 同步到 block。
4. 方法 `getRecentCommands(n)`：从 `commandHistoryAtom` 拉，给 agent system prompt 用。

#### 收益

- TerminalModel 是 agent 状态的唯一真源（除 useChat 的 transient message buffer）。
- 后续 P2 直接复用 agentVisibleAtom + 新增 askCardAtom，模式一致。
- Trajectory 复原变可能：用 `agentChatIdAtom` 从 chatstore 拉历史 block 回放进 timeline。

#### 风险

- 跟 cmdblock-input.tsx 的 NLDModel.modeAtom 重复状态。Mitigation：cmdblock-input 用 NLDModel 决定路由，TerminalModel 跟踪"已选 agent"之后的事。分工明确。

#### 验收

- 单测：`submitAgentMessage` 创建一个 agent block + 返回稳定 exchangeId。
- 单测：`applyAgentDelta` 累加文本（不是覆盖）。

---

### P0.3 — Agent block element + header（S–M, ~1.5d）

- **Warp 对应**：
  - `app/src/ai/blocklist/agent_view/agent_view_block.rs` — 主视图（status icon + title + body）
  - `app/src/ai/blocklist/agent_view/inline_agent_view_header.rs` — block header sub
- **Crest target**：`frontend/app/term/render/agent-block-element.tsx` (header 内联为局部组件)。
- **Attribution header**（文件顶部）：
  ```ts
  // Copyright 2026, Crest contributors. SPDX-License-Identifier: Apache-2.0
  //
  // AgentBlockElement — structure derived from warp:
  //   app/src/ai/blocklist/agent_view/agent_view_block.rs
  //   app/src/ai/blocklist/agent_view/inline_agent_view_header.rs
  // Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
  ```
- **Port 策略**：
  - 组件层级跟 warp 一致（主 view → header sub + body）
  - Status 状态机 1:1 跟 warp：InProgress / Success / Error / Blocked
  - Status icon 4 种颜色语义跟 warp，但色值用 crest Tailwind 调色板（如 `text-rose-400` 而非 warp `pathfinder_color` 字面值）
  - Markdown：用 `react-markdown` + `remark-gfm`（warp 用 `crates/markdown_parser`，TS 等价物）

#### 子任务

1. 新文件 `frontend/app/term/render/agent-block-element.tsx`。
2. 结构：用户消息 chip（右对齐淡背景）+ 分隔线 + agent response (markdown via `react-markdown` + remark-gfm) + status 指示（streaming 时尾部光标点，error 红色）。
3. `BlockListElement.tsx` dispatch：`block.kind === "agent" ? <AgentBlockElement> : <BlockElement>`。
4. 样式：复用 Tailwind + 现有 cmdblock 色板，不引新 scss。
5. 代码块语法高亮：v1 用 react-markdown 原生 pre/code（无 highlight）。Shiki/Prism 留 P3 markdown delta 阶段一起处理。

#### 收益

- 用户能看到 agent 回答 —— 最 visible 的进展。
- 给 P0.4 ToolUseCard 提供宿主容器（嵌在 markdown stream 里）。
- markdown 就位后，代码块、表格、列表立刻 work。

#### 风险

- 长 agent 回答的 re-render 性能 —— 正是 P3 要解决的。v1 先全量重渲染，profile 数据用来支撑 P3 决策。
- 用户消息和 agent response 间距 / 视觉层次 —— 预留 0.5 天 polish。

#### 验收

- 视觉冒烟："hello" 看到 user msg + agent reply 都渲染。
- 视觉冒烟："show me a code block" 看到 ``` fence 正确渲染。
- profile：500 行流式 markdown，记 commit 时间作为 P3 baseline。

---

### P0.4 — Tool action cards (4 子组件)（M, ~3.5d）

- **Warp 对应 → Crest target**（1:1 文件映射）：
  | Warp source | Crest target | LOC est |
  |---|---|---|
  | `inline_action/inline_action_header.rs` | `term/render/tool-action-header.tsx` | ~50 |
  | `inline_action/requested_command.rs` | `term/render/tool-command-card.tsx` | ~150 |
  | `inline_action/code_diff_view.rs` | `term/render/tool-diff-card.tsx` | ~150 |
  | `inline_action/requested_command_attribution.rs` + `block/view_impl.rs:655-728` | `term/render/citation-chips.tsx` | ~80 |
- **Attribution header**（每个 derived 文件）：参考 P0.3 模板，替换 `<source path>` 行。
- **Port 策略**：
  - 文件拆分 = warp 文件拆分。不合并、不细分。
  - Props shape = `UIMessageDataToolUse`（aitypes.ts 已有）。
  - 状态机 pending → needs-approval → completed/error 跟 warp ToolUseCard 一致。
  - Approval keybinding：Cmd+Enter accept / Esc reject，跟 warp `ACCEPT_PROMPT_SUGGESTION_KEYBINDING`（`view_impl.rs:78`）。
  - Citation chip 规则（icon-by-kind, ≤30 字符截断, click → open）：跟 `view_impl.rs:655-728` 一致。
  - 视觉常量：crest Tailwind tokens。

#### 子任务

1. 新文件 `frontend/app/term/render/tool-use-card.tsx`。Props 消费 SSE `data-tooluse` 出来的 `UIMessageDataToolUse`（aitypes.ts 镜像）。
2. 状态布局：
   - **pending**: tool 名 + desc + 转圈
   - **needs-approval**: approve/deny 按钮 + Suggestions radio（"remember this"）
   - **completed**: tool 名 + desc + "see output" 折叠区
   - **error**: tool 名 + 红色 error 文本
3. **Diff preview**（restore from `docs/agent-architecture.md:179-203`）：`originalcontent` + `modifiedcontent` 都存在时，jsdiff 渲染 unified diff（3 行 context）。npm 已有 jsdiff。
4. **Citation chips（P1.4）**：card 底部渲染 `citations[]`：
   - icon: web→`globe`, file→`file`, history→`clock`, doc→`book`（`@/app/element/ui-icon`，缺的补 SVG）
   - title 截断 ≤30 字符
   - click: web/doc → `getApi().openExternal(url)`；file → 跳到对应 block 滚到 `LineStart`（P0.7 实现）；history → 复制到剪贴板
5. Approval 提交走 wshrpc `UpdateToolApproval(toolCallId, approval, content)`。后端 `pkg/aiusechat/toolapproval.go` 已支持。
6. 嵌入位置：作为 AgentBlockElement 的 message-parts 数组里的 inline block —— text part 走 markdown，tool-use part 走 ToolUseCard。

#### 收益

- **P1.4 在此完成 —— citation chip 渲染出来**。
- 用户看到工具调用 + diff + approval —— 整个 agent flow 闭环。
- 复用 `Suggestions` 字段 → permissions engine 的 "remember this" UX 直接可用。
- 给 P2 (`ask_user_question`) 一个参考实现 —— 同样的 card pattern，换 payload。

#### 风险

- **最复杂 phase**。半 day buffer 预留 polish + diff edge case（new file、empty diff、binary）。
- ai-sdk message part 顺序：text 和 tool-use 怎么交错。Mitigation：渲染 `WaveUIMessage.parts` 数组按顺序 map，不重排。
- Diff 在 needs-approval 时显示更有用（用户决定批准前看变更）；务必确保 diff 数据在 approval card 上出现，不是只在 completed 时。

#### 验收

- `read_file` → pending → completed，无 approval。
- `write_file` → needs-approval → diff visible → approve → completed。
- `web_fetch` → 1 个 web citation chip，click 打开浏览器。
- `search` → ≤10 个 file citation chips，click 暂时 console.log path:line。
- `cmd_history` → history citation chips。
- Trajectory 文件包含 citations 字段（P1 已验过）。

---

### P0.5 — useChat host + SSE 同步（S–M, ~1.5d）

- **Warp 对应**：结构参考 `app/src/ai/blocklist/controller/response_stream.rs:45-117`（`ResponseStream` async task）+ `history_model.rs:2177-2203`（`UpdatedStreamingExchange` event）。
- **Crest target**：`frontend/app/term/render/terminal-view.tsx`（useChat host），`terminal-model.ts`（applyAgentDelta etc.）。
- **Port 策略**：结构 reference only。React 用 `@ai-sdk/react`'s `useChat` hook，warp 是 Rust async task，实现完全不同。但 mirror 这些：
  - 3-retry backoff (warp:145 `MAX_RETRIES=3`)
  - 每 chunk → `applyAgentDelta`（等价 `UpdatedStreamingExchange`）
  - `Finished` event → status=done
  - `ClientActions` → tool-use card

#### 子任务

1. `TerminalView.tsx` 顶层加 useChat hook（`@ai-sdk/react`），endpoint `/api/post-agent-message`（`pkg/agent/http.go` 已有）。
2. message stream 同步：
   ```tsx
   const { messages, sendMessage, status } = useChat({ id: chatId, api: ... });
   useEffect(() => {
       const exchangeId = messages[messages.length - 1]?.id;
       model.applyAgentDelta(exchangeId, lastDelta);
   }, [messages]);
   ```
3. `agentChatStatusAtom` ← useChat.status (mapped: streaming/idle/error)。
4. `data-tooluse` part 路由：useChat 当 message part 透出，AgentBlockElement 渲染时调 ToolUseCard。
5. Posture / cwd / connection / lastCommand 上下文：从 TerminalModel 拉 → useChat `body` 字段每次请求带上（HTTP handler 已认这些字段，见 `agent/http.go` PostAgentMessageRequest）。

#### 收益

- 整个 agent 链路通：用户输入 → POST → SSE 流回 → block 渲染 → tool use → approval → 继续。
- ai-sdk 的 retry / 错误处理白送（`messages.status === "error"` 直接显示）。
- 后续 P3 markdown delta 可直接 hook 到 useChat 的 onChunk。

#### 风险

- useChat 的 chat session lifecycle：换 model / 换 chatId 时 message buffer 重置。Mitigation：chatId 做成稳定 jotai atom (`agentChatIdAtom`)，切换时显式 reset。
- SSE 中断恢复：网络抖断 → useChat 内部 retry 或 manual？v1 先依赖默认；status=error 时显示 "Retry" 按钮（手动）。

#### 验收

- 完整 turn：发消息 → 流式回 → tool call → approval → tool result → 继续 → done。
- 刷新页面后 chatId 持久（chatstore 拉）。

---

### P0.6 — cmdblock-input mode=agent 路由（S, ~0.5d）

- **Warp 对应**：`agent_view/agent_message_bar.rs`（warp 的 input bar）+ `app/src/ai/blocklist/input_model.rs:50-121`（`InputConfig` mode 切换）。
- **Crest 状态**：cmdblock-input.tsx 已经是更完整的 input bar，NLD mode 切换已经在 `frontend/app/term/nld/nld-model.ts` port 过。这一步只是 parent wiring。
- **Crest target**：`frontend/app/view/cmdblock/cmdblock-input.tsx` 的 parent (`TerminalView`)。
- **Port 策略**：crest 特有的连接层，无 warp 源码 port。

#### 子任务

1. `frontend/app/view/cmdblock/cmdblock-input.tsx`：onSubmit 接 `mode` 参数已有。在 parent (TerminalView)：
   ```tsx
   const onSubmit = (text, mode) => {
       if (mode === "agent") {
           sendMessage({ text });  // useChat
       } else {
           model.writeToShell(text);
       }
   };
   ```
2. agentVisibleAtom 控制：v1 始终 visible（cmdblock-input 是 inline 的，本来就在底部）。可隐藏的 overlay 形态留后续。
3. NLDModel 的 effectiveMode → 决定 mode="auto" 时实际走哪边。已有 wiring，只是 parent 没在用。

#### 收益

- 输入框 → agent 链路接通。前面 phase 的工作终于能键盘触发。
- 复用现有 NLD（terminal 还是 agent 自动判别）—— 跟 warp 行为一致。

#### 风险

- 几乎无。半天估算包含端到端测试。

#### 验收

- mode=agent → 进 agent flow。
- mode=terminal → 进 shell（与今天行为一致）。
- mode=auto + "list all files" → NLD 判 agent → 走 agent。
- mode=auto + "ls -la" → NLD 判 terminal → 走 shell。

---

### P0.7 — Smoke + citation jump + polish（S, ~1d）

- **Warp 对应**：`block/view_impl.rs:655-728`（citation click 行为）。
  - WarpDocumentation / WarpDriveObject → open in workspace
  - WebPage → open external
- **Crest 简化版**：
  - web/doc → `getApi().openExternal(url)`
  - file → 跳到对应 block + 滚到 `LineStart` 行
  - history → 复制到剪贴板
- **Port 策略**：click handler logic 跟 warp 对齐，但 crest 没有 WarpDrive 概念，simplify 成 web/file/history/doc 四种 kind。

#### 子任务

1. 跑 `docs/term-engine-migration.md` § "Testing plan" 的 1–11 —— 确保 shell flow 无回归。
2. 新增 agent smoke：
   - 普通对话往返
   - `read_file` 一次工具调用
   - `write_file` 一次 approval
   - `web_fetch` 验证 citation chip
3. File citation chip 的"跳转到 block + 滚到行"实现（P0.4 留的 TODO）。
4. AgentBlockElement 视觉 polish：streaming cursor、间距、字号、与 shell block 视觉区分度。
5. 已知 bug 修复 buffer。

#### 收益

- 用户可真用 agent 干活，不是 demo 状态。
- File citation 跳转闭环 → 后续 P2 引用文件做澄清也直接 work。

#### 风险

- 跳转到 block + 滚到行需要 `BlockListElement.scrollToBlock(blockId, line)`。可能多 1-2 小时。

#### 验收

- 端到端：开终端 → 跑几个 shell 命令 → 切 agent → 让 agent 找一个文件 → 点 citation chip → 跳到对应 block 高亮目标行。

---

### P0 横向

- 每 phase 完成跑 `npx tsc --noEmit` + 相关单测。
- P0 结束更新 `docs/term-engine-migration.md` Track C 从 📋 改 ✅，加 P19 完成记录。
- P0 结束在 `docs/agent-architecture.md` 加 §13 "Agent UI reconnection on new engine"，沿用现有 1–12 章节的五段式（问题/方案/文件/数据流/取舍）。
- Citation chip click 行为（web→外部，file→跳转，history→剪贴板）写进 `docs/agent-user-guide.md`。

### P0 完成后解锁

```
P0 完成 → 解锁所有 P1.4 / P2 / P3 / P4
├─ P1.1 / P1.2 / P1.3 / P1.5 → ✅ 已完成（backend）
├─ P1.4 chip 渲染              → ✅ 在 P0.4 里完成
├─ P2 ask_user_question         → 解锁，~3 天（card pattern 已有）
├─ P3 Markdown delta            → 解锁，先用 P0.3 的 profile 数据判断是否真瓶颈
└─ P4 长命令工具组              → 解锁
```

---

## P1 — Typed Citations（~3 天）

### 子任务

1. `pkg/aiusechat/uctypes/uctypes.go` 加 `Citation` 类型：`{ kind: "web"|"doc"|"history"|"file"; url?: string; title: string; line_range?: [int,int] }`。挂到 `UIMessageDataToolUse` 上（让 SSE 自然带出来），同时复制一份进 `ToolAuditEvent` 以便 trajectory 回放。
2. 三个产生引用的工具填字段：`pkg/agent/tools/web_fetch.go`（web）、`pkg/agent/tools/search.go`（file+line_range）、`pkg/agent/tools/cmd_history.go`（history）。
3. `frontend/app/view/term/term-agent.tsx` 加 `TermAgentCitationChips` 组件：icon + 截断后的 title + click → open URL / 打开文件到指定行。
4. 单测：types round-trip、各工具 citation 填充正确。

### 收益

- **信任**：用户能验证 agent 命令的来源（"这个 grep 命令是基于 README 的哪一行"）。
- **管道铺路**：P2、P4 都要往 SSE 消息上挂新结构，这一次把 pattern 走通。
- **审计可追溯**：trajectory 文件里能复原 agent 的引用依据，eval 框架可以拿来打分。

### 风险

- 几乎为零。增量字段、向后兼容（旧消息无 citation 不影响渲染）。

### 验收

- web_fetch / search / cmd_history 三个工具的输出在 inline-agent block 下方显示可点击的 citation chip。
- `.crest-trajectories/<chatid>.json` 里 audit event 含 citation 字段。
- chip click 行为：web → 浏览器；file → 跳转到 block + 滚到 line。

---

## P2 — `ask_user_question` 工具（~3 天）

### 子任务

1. `pkg/agent/tools/ask_user_question.go`（新）。Schema：`questions: [{ question: string; header: string; options: [{ label, description }]; multiSelect: bool }]`。最多 4 个问题、每问题 2–4 选项（对齐 Claude Code 的 `AskUserQuestion` 工具）。
2. `pkg/aiusechat/uctypes/uctypes.go` 加 `AskUserQuestionPayload` 到 `UIMessageDataToolUse`。工具的 `ToolVerifyInput` 永远返回 `NeedsApproval`（"approval" 即"用户作答"）。
3. `frontend/app/view/term/term-agent.tsx` 加 `TermAgentAskCard`：按钮网格 + 可选 "Other" 自由输入。键盘驱动（1–9 选 option，Enter 提交）。
4. 回写：用户提交后把 answers 作为 `tool_result` 内容塞回，进入下一步。

### 收益

- **少走弯路**：消除 "agent 猜 → 走错 → 用户回滚" 的浪费轮次。粗估 20–30% 多步任务存在歧义点。
- **token 省**：一个 multi-choice card ≈ 50 token，比 agent 自己 generate 三段澄清话术省得多。
- **质量信号**：agent 学会"在不确定时问"比"硬猜"更可靠，长期可能拉高整体成功率。

### 风险

- agent 滥用：什么都问一下。Mitigation：在 system prompt 里加约束 "只在确实存在分歧路径时使用"，且 `ask_user_question` 不计 `MaxSteps` 中的 LLM 调用（不然 50 步预算里塞满问题就废了）。

### 验收

- agent 在 ambiguous 场景（如 "fix the bug" — 但 repo 里有 3 个 bug）能调起 card。
- 键盘 1–9 + Enter 完成作答，焦点回归 cmdblock。
- 选 "Other" 时弹出 free-form 输入框。
- 作答记录写入 audit log。

---

## P3 — Markdown delta 渲染（~3–5 天）

### 子任务

1. **先 profile**（半天）：在 `frontend/app/view/term/term-agent.tsx` 当前的 markdown 渲染路径下，用 React DevTools Profiler 跑一个 500 行 + 5 个代码块的流式回答。**如果 commit 时间没明显问题，本任务直接关闭**。
2. 端口 Warp 的 `compute_formatted_text_delta`：纯 TS function，输入是新旧两个 `FormattedTextLine[]`，输出 `{ commonPrefix: number; oldSuffix: Line[]; newSuffix: Line[] }`。位置：`frontend/app/view/term/term-agent-markdown.tsx`（新）。
3. 用 stable key + memoization 包裹 `commonPrefix` 部分，只重渲染 `newSuffix`。代码块走 React.memo + 深比较 props（代码块内容不变就别重 highlight）。
4. 单测：delta 算法、prefix 匹配、空 case。

### 收益

- **流式体感**：长回答 + 大代码块时，丝滑度可见提升（前提是 P3.1 profile 确认了瓶颈）。
- **CPU 省**：每来一个 token 不重新 parse + highlight 整篇 markdown。
- **可量化**：profile 数据可以变成 PR 描述里的 before/after 截图。

### 风险

- **可能是个伪问题**：React reconciliation + 现有 key 策略已经够好。这就是为什么先 profile。
- 代码块的 syntax highlighter（Shiki/Prism）本身可能是瓶颈而不是 markdown parse，这种情况下 delta 算法不解决问题，得换 highlight 策略。

### 验收

- profile 显示 commit 时间下降（具体阈值留给 profile 结果定）。
- 视觉无回归（diff 一下 before/after 截屏）。
- 单测覆盖 delta 算法 ≥3 个 case。

---

## P4 — 长时间命令工具组（~1 周）

### 子任务

1. **扩 shell_exec**：`pkg/agent/tools/shell_exec.go` 加 `wait_until_completion: bool` 输入字段。`false` 时不阻塞，立刻返回 `{ block_id, snapshot, status: "running" }`。
2. **`read_long_running` 工具**：`pkg/agent/tools/long_running_read.go`（新）。输入 `{ block_id, delay_ms?: number }`，从 `pkg/jobmanager` 的 cirbuf 拉当前 snapshot，返回最后 N 行 + 是否还在 running。
3. **`write_long_running` 工具**：`pkg/agent/tools/long_running_write.go`(新)。输入 `{ block_id, input: string, mode: "stdin"|"control" }`。control 模式发 `^C`/`^D`/`^Z`。
4. **`transfer_to_user` 工具**：`pkg/agent/tools/transfer_to_user.go`（新）。输入 `{ block_id, reason: string }`。后端把 PTY 所有权切到前端，agent turn 结束。
5. **UI**：`frontend/app/view/cmdblock/cmdblock-status.tsx` 加 "agent watching" 徽章；右上角 "take over" 按钮（手动触发，等价 agent 调 transfer_to_user）。
6. **PTY 所有权**：仔细测 `vim`、`top`、`python -i`、`npm run dev`、`tail -f`。所有权移交后 stdin 路由要改（不能再走 LLM tool call）。
7. **Approval policy**：transfer_to_user 走自动 approve（agent 主动让权是好行为，不卡用户）；write_long_running 的 control 模式（发 ^C）要走 NeedsApproval（杀进程是破坏性的）。

### 收益

- **解锁新工作流**：今天 agent 跑 dev server 必须等到天荒地老或者根本跑不了。有了这组工具后能"agent 启服务 → 看日志 → 验证 endpoint → 报告 + 让用户接管"完整闭环。
- **能力对齐 Warp/Claude Code**：用户从那两个工具切过来不会觉得 crest 少根筋。
- **长期价值**：这组工具是后续做 "browser/E2E 测试 agent"、"daemon 调试 agent" 的基础设施。

### 风险

- **最大风险：PTY 所有权移交的边界**。FD 谁拥有、信号谁收、stdin 路由切换的时机 —— 这些错了会出现"用户敲键盘 agent 收到"或者"agent 想发 ^C 但 PTY 已经给用户了"。测试矩阵必须覆盖前面列的 5 类交互式程序。
- **状态泄露**：agent 启动的 long-running 进程在 agent turn 结束后不能自动 kill，但也不能永远活着。需要明确"block 关闭即 kill" 或者"用户显式 kill"。建议前者，对齐现有 cmdblock 生命周期。

### 验收

- agent 能跑 `npm run dev` 并在不阻塞当前 turn 的情况下继续后续工作。
- agent 能读取 long-running 块的最新 N 行输出。
- agent 能发 ^C 终止（走 approval）。
- agent 能调 `transfer_to_user`，块顶部出现"控制权已交还"提示，stdin 路由到用户。
- vim/top/python -i 三个交互式 case 不出现按键路由混乱。

---

## 横向工程项（贯穿四个 phase）

- **类型生成**：每个 phase 新增的 Go 类型（Citation、AskUserQuestionPayload、LongRunningSnapshot）改完跑 `task generate`，对齐 `frontend/types/gotypes.d.ts`。
- **trajectory 字段**：四个 phase 都会扩 `ToolAuditEvent`。保持向后兼容（旧 trajectory 缺字段时 frontend 能优雅降级）。
- **eval harness**：每个 phase 写至少 1 个 golden transcript 进 `pkg/agent/eval/`，防回归。
- **`docs/agent-architecture.md` 增章节**：每个 phase 完成后追加一个编号小节（# 13、14、15、16），跟现有 1–12 章节保持同样的"问题/方案/文件/数据流/取舍"五段式。

---

## 不在计划内（参考 warp-agent-analysis.md §3 "Dropped from roadmap"）

- 不做：per-call `rationale` / `is_read_only` / `is_risky`、ancestor `CREST.md` 扫描、跨厂商 `~/.<vendor>/skills/` 约定。
- 推迟（Honorable mentions）：Codebase RAG、Conversation/task DAG、read-only session mode。这些在 P4 之后再视用户反馈决定是否进入下一轮。

---

## Audit findings (2026-05-20) — strict-port pass

After P1 / P2 / P4 landed, a comparison pass was done against the
relevant warp source files to verify the implementations actually
mirror warp's data shapes (rather than being invented loosely on a
warp-shaped skeleton).  Findings classified A (必改) / B (合理偏差) /
C (保留 — 有 crest 侧的具体理由).  A-class fixes are applied; C-class
decisions are recorded here as the long-form rationale.

### A-class (fixed)

| Fix | Files | Warp reference |
|---|---|---|
| **A1** AskUserQuestion type discriminator + drop `description`/`header` | `pkg/aiusechat/uctypes/uctypes.go`, `pkg/agent/tools/ask_user_question.go`, `pkg/agent/tools/ask_user_question_test.go`, `frontend/app/store/aitypes.ts` | `crates/ai/src/agent/action/mod.rs:611-631` |
| **A2** FE Tab → Left/Right nav + `ToolAskSummary` completed-state | `frontend/app/term/render/tool-ask-card.tsx`, `frontend/app/term/render/tool-use-card.tsx` | `app/src/ai/blocklist/inline_action/ask_user_question_view.rs:1400-1401` (left/right keys); `:1251-1310` (completed renders) |
| **A3** OnCompletion delay mode on `long_running_read` | `pkg/agent/tools/long_running_read.go`, `pkg/agent/tools/long_running_test.go` | `crates/ai/src/agent/action/mod.rs:126-129, 756-760` |
| **A4** Raw/Line/Block modes on `long_running_write` + drop signal-sending | `pkg/agent/tools/long_running_write.go`, `pkg/agent/tools/long_running_test.go`, `pkg/agent/registry.go` | `crates/ai/src/agent/action/mod.rs:61-65, 762-812` |

Test result after A-class: `go test ./pkg/agent/tools/ ./pkg/aiusechat/uctypes/` all green (~50 cases).

### C-class (deliberate crest extensions / retentions)

Each is a divergence from warp's source.  Kept rather than fixed
because the divergence has a real crest-side justification.  In-code
comments at the divergence point also reference this section.

1. **`Citation.kind = "file" | "history"` + `LineStart` / `LineEnd` fields**
   - Warp's `AIAgentCitation` (`crates/ai/src/agent/citation.rs:5-11`) has three variants only: `WarpDriveObject` / `WarpDocumentation` / `WebPage`.
   - Crest adds `file` and `history` kinds plus line-range fields because crest's `search` tool emits `file:line` citations and `cmd_history` emits prior-command citations — neither tool surface exists on warp's side, so warp's enum genuinely doesn't cover the use case.
   - Source note: `pkg/aiusechat/uctypes/uctypes.go` Citation type comment.

2. **`long_running_read.tail_bytes` parameter**
   - Warp's `ReadShellCommandOutput` (`action/mod.rs:126-129`) takes `{ block_id, delay }` only — no return-size cap.
   - Crest's agent runs against an LLM context window; an unbounded read can wreck the next turn's budget.  The `tail_bytes` cap (default 4 KB, max 32 KB) is the LLM-context guard warp doesn't need.
   - Source note: `pkg/agent/tools/long_running_read.go` const block comment.

3. **`transfer_to_user.block_id` parameter**
   - Warp's `TransferShellCommandControlToUser` (`action/mod.rs:161-165`) carries only `{ reason }` — the warp agent loop maintains implicit "current block" session state, so an explicit block reference isn't needed.
   - Crest's Go-side tool system has no implicit session-block context; an agent may have started multiple background blocks in one turn.  Explicit `block_id` is required for disambiguation.
   - Source note: `pkg/agent/tools/transfer_to_user.go` file-level comment (already in place).

4. **`tool-ask-card` cancel key = Esc (vs warp's Ctrl-C)**
   - Warp uses Ctrl-C (`ask_user_question_view.rs:759`) because that's the terminal-environment convention for cancel.
   - Crest's card lives inside an Electron surface where Esc is the universal "dismiss dialog" key; Ctrl-C is reserved for the surrounding shell.
   - Source note: `frontend/app/term/render/tool-ask-card.tsx` keyboard handler comment.

5. **`long_running_write` does NOT send signals**
   - This was the inverse of a divergence: my v1 invented `mode=control` + signal-sending, which warp's `WriteToLongRunningShellCommand` does NOT have.  Fixed in A4 — signals dropped, modes match warp's `AIAgentPtyWriteMode` (raw / line / block).
   - Open question: how should the agent kill a runaway background process if needed?  Warp's source doesn't seem to expose a kill-signal action to the agent at all; that's a deliberate safety scope.  If crest later wants to expose it, do it as a separate `signal_block` tool with explicit approval, not as a mode of `long_running_write`.

### Non-strict areas not yet audited

- **`ask_user_question` FE UX details** beyond the keyboard-binding decision.  Warp's view file is ~1700 LOC with multiple render branches (active / unavailable / completed / finished — `ask_user_question_view.rs:1183-1450`).  Crest implements active + completed (via `ToolAskSummary`); unavailable / finished states are deferred.
- **`long_running_write.line` mode LF vs CR on Windows hosts.**  Warp picks per-platform (`action/mod.rs:790-797`); crest v1 always uses LF.  Acceptable for POSIX hosts (the bulk of crest users today); revisit if a Windows-host user reports trouble.
- **`long_running_write.block` mode `is_bracketed_paste_enabled` gate.**  Warp checks this state before wrapping (`action/mod.rs:799-810`); crest v1 always wraps.  Worst case: a shell without bracketed-paste support shows the markers as literal text — recoverable noise, not data loss.
