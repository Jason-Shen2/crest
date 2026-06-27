# Agent Timeline 单一真相源重构

> 2026-06 · branch `agent-timeline-single-source` · base `a785f5a0`
>
> 相关文档：[agent-timeline-architecture.md](agent-timeline-architecture.md)（重构前的问题清单与目标）。
> 本文是重构落地后的权威说明。

---

## TL;DR

**run 的身份 = 启动这一轮的 user message 在 JSONL session 里的 `entry.id`（下称 `userEntryId`）。**

- JSONL session 是**唯一真相源**，cmdblock（SQLite timeline 行）只是对 session entry 的**有序投影**。
- 不再凭空 `uuidv7()` mint runId；不再靠"第 N 个 ref ↔ 第 N 个 user 消息"的位置匹配来 join 两个系统。
- 重建 runs 时按 `agent_user_entry_id`（cmdblock 行上存的锚点）做确定性 entryId-join，和顺序、方向、过滤、compact、fork、late subscribe 全部无关。
- 写入顺序从「先 AppendAgentRun mint id → 再 send prompt」翻转为「先 send → session 返回 userEntryId → 再 AppendAgentRun(userentryid=userEntryId)」。
- 全栈删除 `agent_run_id` / `runid` / `AgentRunID` 字段；新增 DB 迁移 `000016_drop_agent_run_id`。开发阶段，不保留向后兼容。

---

## 一、为什么要重构

### 1.1 症状

刷页（reload / reopen）、`/compact`、`/tree` 切分支、网络抖动晚到 snapshot 等场景下，终端里的 agent block 经常卡在：

```
…loading agent run…
```

根因一直被症状掩盖——有时是顺序 bug，有时是 fallback 失效，有时是 knownRunIds 伪 refs 与真实 refs 互相覆盖。每次修一处、漏一处。

### 1.2 根因：两个系统各自 mint id，靠"位置"对齐

旧架构里 agent 的 run 身份存在**两个独立存储**，它们之间没有任何共享 key：

| 系统 | 角色 | 身份字段 | 谁 mint |
|---|---|---|---|
| **JSONL session**（pi `AgentHarness`） | 真实对话内容（user/assistant/tool 消息，树状分支） | 每条 entry 的 `entry.id`（session 写消息时自己生成） | session 内部 |
| **cmdblock SQLite** | 终端 timeline 上的 agent 锚点行（`kind='agent'`） | `agent_run_id = "run-${uuidv7()}"`，外加自增 `seq` | main 进程在 send 开始时凭空生成 |

两边 id **永不相等**。唯一的"关联"是隐式约定：

> 「按 `seq` 排序的第 k 个 cmdblock agent 行 ↔ session 当前分支里的第 k 条 user 消息」

这就是位置匹配（positional match）。

#### 1.2.1 旧写入链路（agent:send）

旧 [emain/agent-ipc.ts](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent-ipc.ts) `agent:send` handler（重构前，commit `a785f5a0`）：

```ts
// Phase 1: main owns run identity.
const runId = `run-${uuidv7()}`;                 // ① 凭空 mint，和 session 毫无关系
if (opts.blockId) {
  await RpcApi.AppendAgentRunCommand(..., {     // ② 先写 cmdblock 行（agent_run_id=runId, seq=自增）
    blockid: opts.blockId,
    sessionpath: metadata.path,
    runid: runId,
  });
}
session.send(runId, opts.text);                  // ③ 再 prompt；session.appendMessage 给 user
                                                 //    消息分配它自己的 entry.id（≠ runId）
```

落地后两边各有各的 id：

```
cmdblock:  [{agent_run_id:"run-A", seq:1}, {agent_run_id:"run-B", seq:2}]
session:   [user(entry.id=x1), assistant(x2), user(entry.id=x3), assistant(x4)]
```

没有任何列把 `run-A` 指向 `x1`、`run-B` 指向 `x3`。

#### 1.2.2 旧重建链路（reload / compact / navigate）

重建时由 [buildRunsWithReverseMatch](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent/pane-agent-session.ts)（重构前，commit `a785f5a0`）做**倒序位置配对**：

```text
refs = GetCmdBlocksCommand() 按 seq 升序  → [run-A, run-B]
msgs = session.getBranch() 抽出 user 消息 → [u1(x1), u2(x3)]

倒序配对：
  最后一个 ref (run-B) ←→ 最后一个 user (u2)
  倒数第二 ref (run-A) ←→ 倒数第二 user (u1)
把 ref.agentrunid 贴到对应 user → 该 run.runId = agentrunid
```

renderer 侧 [applyAgentTimelineRow](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/frontend/app/term/terminal-model.ts) 读 `row.agentrunid` 创建 Block，再由 `syncAgentBlocks(activeRunIds)` 按 runId 显隐——**整个 block↔run 的映射完全以这个 mint 出来的 id 为锚**，而这个 id 是靠位置"贴"到 user 消息上的。

#### 1.2.3 位置匹配的所有崩溃点

只要某一侧 user 消息条数和 cmdblock 行数不再一致、或顺序被重排，倒序配对就整体错位一格，runId 贴错消息，block 直接 `…loading agent run…`：

| 场景 | 错位原因 |
|---|---|
| **session-path 过滤** | fork / clone 后 session 分支混入别的 session 路径的消息，过滤后计数变化。 |
| **`/compact` 重写** | 多轮历史压成 summary，user 消息数骤减，但 cmdblock 行还在；旧代码用 `knownRunIds` 造"伪 refs"兜底，仍然是位置逻辑。 |
| **异步到达** | snapshot / cmdblock 行 / 流式事件到达时序不同，重建瞬间两边数量不一致。 |
| **late subscribe** | 新订阅者收到的 initial snapshot 可能已经包含未来消息，和初始 cmdblock 行数不一致。 |
| **branch/fork** | 切换分支后 user 消息集合完全不同，但 cmdblock 行是持久在 block 上的。 |
| **非 message entry** | session 里插 custom/internal 条目被过滤后，"第 k 个 user" 的索引平移。 |
| **方向假设** | 倒序匹配假设"末尾对齐"，任何中间插入都会偏移。 |

### 1.3 核心洞察

> **run 的身份本就应该是启动它的那一条 user message 的 id。**

既然每条 user message 在 session 写入时天然就有一个稳定的 entry id，那 runId 就不该是额外 mint 的东西——直接用 `userEntryId` 当 runId，重建时按 entry id 精确 join，位置/过滤/方向/异步全无关。

cmdblock 不再"拥有"身份，它只是把「这个 terminal block 位置上发生过哪些 session entry」按时间顺序记下来——**有序投影**，不是真相源。

---

## 二、新架构

### 2.1 核心不变量（Invariants）

1. **Single Source of Truth**：`PaneAgentSession` 里 `runs[i].runId` 恒等于启动该 run 的 user message 的 session entry id。
2. **身份只 mint 一次**：user message 的 `entry.id` 在 session 调 `appendMessage(user)` 时产生，run 身份直接复用它，没有第二个 mint 点。
3. **cmdblock 是投影**：cmdblock `kind='agent'` 行上的 `agent_user_entry_id` 只是对 session entry 的外键式引用；它**不创造**身份、只**锚定**身份。
4. **确定性 join**：重建时 `Set<userEntryId>` 来自 cmdblock 行（按 `agentsessionpath` 过滤），遍历 session 分支时 user entry id 在 Set 中就开 run——结果 100% 确定，与顺序/过滤/到达时序无关。
5. **session-first write**：写入顺序翻转——先 prompt 让 session 产生 entry id，再把这个 id 持久到 cmdblock。保证 cmdblock 上存的 id 一定是 session 里真实存在的 entry。

### 2.2 数据模型变化

**CmdBlock（Go）**

```go
// 删除
AgentRunID       *string `db:"agent_run_id"       json:"agentrunid,omitempty"`

// 保留并作为唯一锚点
AgentSessionPath *string `db:"agent_session_path" json:"agentsessionpath,omitempty"`
AgentUserEntryID *string `db:"agent_user_entry_id" json:"agentuserentryid,omitempty"`
```

DB 列：
- `000015_agent_user_entry`：新增 `agent_user_entry_id TEXT` + 唯一索引 `cmdblock_blockid_agentuserentryid_uindex(blockid, agent_user_entry_id)`。
- `000016_drop_agent_run_id`：DROP `agent_run_id` 列与 `idx_cmdblock_agent_run` 索引。
  - Go 用 `SELECT *` + sqlx 扫入 struct，删 struct 字段必须同步 drop 列，否则未映射列会报错。

**RPC `CommandAppendAgentRunData`**

```go
// 删除
RunID       string `json:"runid"`
// 保留
BlockID     string `json:"blockid"`
SessionPath string `json:"sessionpath"`
UserEntryID string `json:"userentryid"`   // 必填，即 run 身份
```

**TS 类型**

- `AgentTimelineRef` 简化为 `{ agentsessionpath?: string; agentuserentryid?: string }`（删除 `agentrunid?` / `seq?`）。
- `AgentTimelineStorageRow` 同理，只保留 `agentuserentryid?: string`。
- renderer 读 key 从 `row.agentuserentryid || row.agentrunid` → `row.agentuserentryid`。

### 2.3 PaneAgentSession 的 send()：fire-and-forget → Promise&lt;string&gt;

旧 `send(runId, text): void` → 新 `send(text): Promise<string>`，返回值即 `userEntryId`（= runId）。

机制（FIFO resolver 队列，在 [pane-agent-session.ts](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent/pane-agent-session.ts)）：

1. 调 `send(text)` 时同步 push `{resolve, reject}` 到 `pendingEntryIdResolvers` FIFO。
2. harness 事件流里 user `message_end` 到达（事件上带 `entryId`，见下节）时：
   - 用这个 entryId `ensureRun(entryId)` 开 run、置 `activeRunId`；
   - `shift()` 队头 resolver 并 `resolve(entryId)`。
3. `prompt`/`followUp` 失败、`abort`、`dispose` 时 drain 队列：队头单个 reject 或整队列 reject（`rejectPendingSends`），避免 IPC promise 永久挂起。
   - 修复 commit `e4b98373`：最初只在成功路径 resolve，abort/dispose 未 drain 导致挂起。

**为什么需要队列。** `send(text)` 调用时 user 消息还没写入 session、entryId 还不存在，所以 `send()` 必须等到 user `message_end` 事件到达（那时 entryId 才可用）才能返回值——FIFO 队列 `pendingEntryIdResolvers` 就是"每个还在等 entryId 的 send 调用"的登记表：send 时 push 一对 `{resolve, reject}`，user `message_end` 到达时 shift 队头 resolve 出 entryId。之所以用队列而不是单个变量，是因为 send 可被连续调用（`/followUp`：上一轮在跑时用户又发第 2、3 条），FIFO 保证"第 N 个 send ↔ 第 N 个 user message_end"一一对应，不会错配。

### 2.4 Harness 事件携带 entryId

[emain/agent/types.ts](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent/types.ts) 的 `AgentEvent.message_end` 变体新增可选字段 `entryId?: string`。`message_start` / `message_update` 不变，**不带 entryId**。

[emain/agent/harness/agent-harness.ts](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent/harness/agent-harness.ts) `handleAgentEvent` 的 `message_end` 分支：

```ts
case "message_end":
  const entryId = await this.session.appendMessage(event.message);
  await this.emitAny({ ...event, entryId }, signal);
```

**为什么 entryId 只在 message_end 上带。** [session.appendMessage](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent/harness/session/session.ts#L128-L136) 内部调 `storage.createEntryId()` 生成 id 并把消息挂到 session 树 leaf——这是 entryId 的唯一 mint 点。`message_start`/`message_update` 时消息还在流、是半成品，不写入 session，entryId 尚未出生；只有 `message_end` 代表"消息定稿、已被 session 收录"，此刻才能 append 并拿到 entryId。所以 harness 在这里 append、把返回的 entryId 塞进事件再 emit 给上层（PaneAgentSession）。assistant 的 message_end 也会 append 拿到 entryId，但 PaneSession 不用它当 runId——run 的身份永远是启动它的那条 **user** 消息的 entryId。

这是"session 是单一真相源"的直接体现：**身份不是谁 mint 的，是 session 写入时自然产生的**，harness 只是在 message_end 这个生命周期点把 id 夹带出来，交给上层去 resolve send() 的 Promise、去开 run。

#### 2.4.1 一次 send 的事件流时序

以 `session.send("hello")` 为例，从调用到 cmdblock 落盘的完整时序：

| 时刻 | 发生的事 | 关键动作 |
|---|---|---|
| T0 | IPC 调 `session.send("hello")` | ① `pendingEntryIdResolvers.push({resolve,reject})` 登记<br/>② `harness.prompt("hello")` 启动（异步）<br/>③ 立即返回 Promise |
| T1 | harness emit `message_start`（user） | PaneSess 收到，只追加 transcript，**不开 run**（applyMessageStartToRun 对 user 直接 return） |
| T2 | harness 调 `session.appendMessage(userMsg)` | session 内部 `createEntryId()` → `"x17a..."`，挂到 session 树 leaf |
| T3 | harness emit `message_end`（user, **entryId="x17a..."**） | PaneSess 收到：<br/>① `ensureRun("x17a...")` 开 run，置 activeRunId<br/>② `shift()` 队头 resolver，`resolve("x17a...")`——send() Promise 兑现 |
| T3+ | IPC 的 `await userEntryId` 恢复 | 拿到 `"x17a..."` → `AppendAgentRunCommand({userentryid:"x17a..."})` 写 cmdblock |
| T4… | harness 流式 emit assistant 的 `message_start`/`message_update`/`message_end` | PaneSess 按 activeRunId 追加到当前 run 的 responseMessages；assistant 自己的 entryId 不影响 run 身份 |

关键不变量：**user `message_start` 只攒 transcript，不开 run；user `message_end`（带 entryId）才是 run 身份确立的时刻**——见 [applyMessageStartToRun](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent/pane-agent-session.ts#L436-L449) 对 `role === "user"` 直接 return。

### 2.5 确定性 entryId-join

[buildRunsFromEntryIdJoin](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent/pane-agent-session.ts) 是唯一的 run 重建逻辑：

```text
buildPersistedRunsFromSessionEntries(entries, timelineRefs, sessionPath):
  anchored = Set(ref.agentuserentryid for ref in timelineRefs
                 if ref.agentuserentryid
                    and (!sessionPath || !ref.agentsessionpath
                         || ref.agentsessionpath === sessionPath))

  return buildRunsFromEntryIdJoin(entries, anchored)

buildRunsFromEntryIdJoin(entries, anchored):
  runs = []; current = null
  for entry in entries (按 session 分支顺序):
    if entry.type !== 'message': continue
    role = entry.message.role
    if role === 'user':
      if anchored.has(entry.id):
        current = { runId: entry.id, userMessage: entry.message, responseMessages: [], status: 'done' }
        runs.push(current)
      else:
        current = null      // 不是锚定 run 起点的 user 消息，跳过（及之后的 assistant 也不收）
    else if role in (assistant|tool|toolResult) and current:
      current.responseMessages.push(entry.message)
      if assistant error: current.status = 'error'
  return runs
```

- 一个 anchored user entry id → 精确开一个 run，之后的非 user 消息都进这个 run。
- 任何顺序/过滤/方向变化都不影响结果，因为判断条件是"entry.id 在不在 Set 里"，和位置无关。
- 旧的 `buildPersistedRunsFromTimeline` / `buildRunsLegacyPositional` / `buildRunsFromMessagesForward` / `buildRunsWithReverseMatch` 四个函数全部删除。

### 2.6 IPC 写入顺序翻转

[emain/agent-ipc.ts](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent-ipc.ts) `agent:send`：

```ts
// session-first write
const userEntryId = await session.send(opts.text);    // ① 先 send，拿 session 自然产生的 entryId
if (opts.blockId) {
  await RpcApi.AppendAgentRunCommand(ElectronWshClient, {
    blockid: opts.blockId,
    sessionpath: metadata.path,
    userentryid: userEntryId,                         // ② 只传 userentryid；runid 字段已删除
  });
}
return { sessionMetadata: metadata, runId: userEntryId };
```

`uuidv7` 的 import 一并删除——main 不再 mint id。

幂等：Go 侧 AppendAgentRun 用 `WHERE blockid = ? AND kind = 'agent' AND agent_user_entry_id = ?` 做 upsert，重复写入安全。

### 2.7 重建入口统一

`PaneAgentSession` 所有需要重建 runs 的路径全部收敛到：

```ts
this.runs = buildPersistedRunsFromSessionEntries(entries, timelineRefs, this.path);
```

- `compact(timelineRefs, customInstructions)`：renderer 传 blockId，main 从 `GetCmdBlocksCommand` 拿 rows 作为 refs 传入。
- `rebuildFromCurrentBranch(timelineRefs)`：默认 `[]`，所有调用方必须显式传 refs（不再有 `knownRunIds` 造伪 refs）。
- `navigateTree(targetId, timelineRefs)`：切分支时由调用方传当前 block 的 cmdblock rows。
- 初始化（`ensurePaneSession`）、首次订阅（`sendPersistedSnapshot`）都从 `GetCmdBlocksCommand` 拿 rows 传入。

**删除的历史兜底**：

- 类字段 `private knownRunIds: string[] = []`。
- `rebuildFromCurrentBranch` 里用 knownRunIds 合成伪 refs + 回填过滤的大段逻辑。
- `/compact` 无 blockId 时的"伪 refs 降级"行为（现传 `[]`，无锚定 refs 则不产生 runs）。

### 2.8 Renderer：只读投影，不再派生身份

- [applyAgentTimelineRow](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/frontend/app/term/terminal-model.ts) 只读 `row.agentuserentryid` 作为 `runId`。
- `AgentTimelineStorageRow` 类型删除 `agentrunid?`。
- `data-agent-block-runid={runId}` DOM 属性保留——它用的是 `run.runId`（现在值就是 userEntryId），和字段名无关。
- renderer 不再调用 `AppendAgentRunCommand`（这个调用一直就只在 main 侧，确认无误）。

---

## 三、改动链路总览（新）

### 3.1 写入（agent:send）

```
┌────────────┐  IPC agent:send   ┌────────────────────────┐
│  Renderer  │ ────────────────► │  Main (agent-ipc.ts)   │
│  send()    │                   │                        │
└────────────┘                   │ ① ensureSession()      │
                                 │ ② ensurePaneSession()  │
                                 │ ③ session.send(text) ──┐
                                 └────────────────────────│
                                                          ▼
                                                ┌─────────────────────┐
                                                │ PaneAgentSession    │
                                                │  push FIFO resolver │
                                                │  harness.prompt()   │
                                                └─────────┬───────────┘
                                                          ▼
                                                ┌─────────────────────┐
                                                │ pi AgentHarness     │
                                                │  → session.append-  │
                                                │    Message(user)    │
                                                │    returns entryId  │
                                                │  emit message_end   │
                                                │    with entryId     │
                                                └─────────┬───────────┘
                                                          ▼ event
                                                ┌─────────────────────┐
                                                │ PaneAgentSession    │
                                                │  ensureRun(entryId) │
                                                │  resolve(entryId)   │──┐
                                                └─────────────────────┘  │
                                                          ▲              │
                                                          │ userEntryId  │
                                 ┌────────────────────────│              │
                                 │ ④ await userEntryId ◄──┘              │
                                 │ ⑤ AppendAgentRunCommand ──────────────┼──┐
                                 │    { userentryid }                    │  │
                                 └───────────────────────────────────────┘  │
                                                                            ▼
                                                                  ┌──────────────────┐
                                                                  │ Go cmdblock      │
                                                                  │ INSERT kind=agent│
                                                                  │ agent_user_entry │
                                                                  │   _id=userEntryId│
                                                                  │ (upsert 幂等)    │
                                                                  └──────────────────┘
```

关键点：**id 是从 session 往上"回流"到 main 的**，而不是 main 往下 mint。所以 cmdblock 里存的 id 永远是 session 里真实存在的 entry。

### 3.2 重建（reopen / reload / compact / navigate）

```
┌────────────┐                     ┌────────────────────┐
│  Renderer  │ subscribe/navigate  │  Main              │
│            │ ──────────────────► │ GetCmdBlocksCommand│──┐
└────────────┘                     │ (拿 cmdblock rows) │  │
                                   │ session.getBranch()│  │ (两个独立读取)
                                   └─────────┬──────────┘  │
                                             ▼             ▼
                                   ┌──────────────────────────────┐
                                   │ buildPersistedRunsFrom-      │
                                   │   SessionEntries(entries,    │
                                   │                    refs,path)│
                                   │                              │
                                   │  anchored = Set of            │
                                   │    ref.agentuserentryid      │
                                   │    (sessionPath 过滤后)       │
                                   │                              │
                                   │  → buildRunsFromEntryIdJoin: │
                                   │    user.id ∈ anchored ⇒ 开run │
                                   └──────────────┬───────────────┘
                                                  │ snapshot {messages, runs}
                                                  ▼
                                   ┌──────────────────────────────┐
                                   │ Renderer:                    │
                                   │  applyAgentTimelineRow       │
                                   │    runId = row.agentuser-    │
                                   │            entryid           │
                                   │  syncAgentBlocks(activeIds)  │
                                   │  AgentBlockElement 显示内容   │
                                   └──────────────────────────────┘
```

关键点：**两个读取之间没有顺序耦合**——rows 里写了哪个 entry id 就锚定哪个，session 返回什么 entries 就遍历什么，位置变化不影响结果。

---

## 四、分层改动清单

按从底到顶顺序列出：

| 层 | 文件 | 改动 |
|---|---|---|
| DB 迁移 | [db/migrations-wstore/000015_agent_user_entry.up.sql](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/db/migrations-wstore/000015_agent_user_entry.up.sql) | 新增列 `agent_user_entry_id` + 唯一索引 |
| DB 迁移 | [000016_drop_agent_run_id.up.sql](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/db/migrations-wstore/000016_drop_agent_run_id.up.sql) | 删除 `agent_run_id` 列与 `idx_cmdblock_agent_run` 索引 |
| Go types | [pkg/cmdblock/cbtypes/types.go](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/pkg/cmdblock/cbtypes/types.go) | 删除 `CmdBlock.AgentRunID` |
| Go store | [pkg/cmdblock/store.go](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/pkg/cmdblock/store.go) | `AppendAgentRun` 签名去 `runID`；INSERT 只写 `agent_user_entry_id`；幂等键改为 `agent_user_entry_id` |
| Go RPC types | [pkg/wshrpc/wshrpctypes.go](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/pkg/wshrpc/wshrpctypes.go) | `CommandAppendAgentRunData` 删 `RunID` |
| Go RPC server | [pkg/wshrpc/wshserver/wshserver.go](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/pkg/wshrpc/wshserver/wshserver.go) | handler 校验 `UserEntryID` 非空；调用新签名 |
| TS types (生成) | [frontend/types/gotypes.d.ts](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/frontend/types/gotypes.d.ts) | `CmdBlock` / `CommandAppendAgentRunData` 同步删字段 |
| Harness event | [emain/agent/types.ts](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent/types.ts) | `message_end` 加 `entryId?` |
| Harness emit | [emain/agent/harness/agent-harness.ts](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent/harness/agent-harness.ts) | `appendMessage` 返回值 enrich 到事件 |
| PaneSession | [emain/agent/pane-agent-session.ts](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent/pane-agent-session.ts) | `send(): Promise<string>` + FIFO；entryId-join；删 4 个 legacy 函数 + knownRunIds；`compact/rebuild/navigate` 签名统一 |
| IPC | [emain/agent-ipc.ts](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent-ipc.ts) | `agent:send` 顺序翻转；删 uuidv7 import；`runCompactSessionCommand` 传 rows |
| 命令类型 | [emain/agent/commands/types.ts](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/emain/agent/commands/types.ts), [frontend/types/custom.d.ts](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/frontend/types/custom.d.ts) | `AgentRunCommandInput.blockId?` |
| Renderer bridge | [frontend/app/term/render/agent-chat-host.tsx](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/frontend/app/term/render/agent-chat-host.tsx) | runCommand 带上 `blockId: outerBlockId` |
| Renderer model | [frontend/app/term/terminal-model.ts](file:///Users/bytedance/Documents/crest/.worktrees/agent-timeline-single-source/frontend/app/term/terminal-model.ts) | 只读 `agentuserentryid`；删 `agentrunid?` 类型 |

---

## 五、Review 中发现并修复的问题

### BLOCKER（e4b98373）：pendingEntryIdResolvers 在 abort/dispose 未 drain

Task 7 引入的 FIFO 队列在异常路径没有清空：followUp 还在 harness 队列里未被 drain 就被 abort 清掉时，对应 resolver 永远不会 resolve，`send()` 返回的 promise 永久挂起；且队头残留的 stale resolver 会让后续 send 错配。

修复：新增 `rejectPendingSends(err)` 在 `abort` 事件处理和 `dispose()` 中调用，整队列 reject 并清空。加回归测试覆盖。

---

## 六、验证

- `go build ./...` 通过
- `go test ./pkg/cmdblock/...` 通过
- `npx vitest run emain/agent frontend/app/term/terminal-model.test.ts emain/agent-ipc.test.ts`：178 tests passed
- `npm run build:dev` exit 0

---

## 七、兼容与边界

开发阶段，**不保留旧数据兼容**：

- 迁移 `000016` 直接 drop `agent_run_id` 列；未迁移的旧行数据随列删除丢弃。
- 重建不再有 positional 回退；所有 cmdblock 行必须带 `agent_user_entry_id` 才能被锚定。
- renderer 不再 `|| row.agentrunid` 回退。
- 位置匹配 4 个函数整体删除，不保留"只读但未用"的死代码。

如后续要给存量用户做正式迁移，可在 base 与本分支之间插入一个一次性 migration：遍历所有 `agent_run_id` 非空但 `agent_user_entry_id` 为空的行，通过 session 反查并补上 user entry id（需要历史 session 分支仍然可访问，这在开发分支不是必需）。

---

## 八、设计原则（保留给未来改动）

> **不要持久化"从呈现状态派生出来的身份"。** 如果一个值需要在重启后把两个 store join 起来，它必须由领域对象的 owner 一次性 mint 出来，并在数据流里全程不改地传递。

具体到 agent timeline：

1. user message 的 entry id 是天然的 run 身份——它由 session 这个 owner 在消息落盘时产生。
2. 其他所有地方（cmdblock、renderer Block、snapshot、IPC 返回值）都只是**引用**这个 id，绝不自己再造一个。
3. 重建是确定性函数：输入 (session entries, anchored entry ids) → 输出 runs。没有隐式状态（`knownRunIds`）、没有顺序启发式。
4. 写 cmdblock 在 session 写**之后**，保证引用完整性（外键式约束在应用层成立）。

---

## 九、后续可做（不在本次范围）

- **steer / nextTurn 消费 resolver**：当前 steer 类 user 消息也会触发 user `message_end`，会错误消费队头 resolver（renderer 未调用 steer，暂不影响；未来接入要处理）。
- **onSendError 的 burst 语义**：错误路径 `shift()` 只 reject 队头，burst 场景下可能 reject 错的 resolver（主路径不受影响）。
- **陈旧注释**：少数注释还在用 "mint synthetic runId" 等旧措辞，可顺手清理。
- **cmdblock 表重命名**：概念上 cmdblock 已经是 timeline，但物理表名未改；属于命名清理，不是必须。
- **custom entry 规范化**：session 里的 `agent_run` custom entry（早期版本用 data.runId 记 run）还存在于 listTreeEntries 隐藏链路上；现在 runId 就是 user entry id，未来可考虑清理这层 custom 包装。
