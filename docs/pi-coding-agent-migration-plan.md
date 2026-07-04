# pi-coding-agent 行为层迁移方案

> 策略：**尽量 in-tree 原样拷贝 pi-coding-agent，只剥离 pi-tui 渲染层，不自己重写逻辑。**
> crest 已有的 `node:fs` 手写工具描述、3 行手写 system prompt 等"自实现"全部用 pi 的对应实现替换。

---

## 0. 背景结论（与早期审计的修正）

`emain/agent/harness/` 已经是 **pi-agent-core 的 in-tree 拷贝**，且能力完整：

- `AgentHarness.systemPrompt` 回调签名已支持 `{ env, session, model, thinkingLevel, activeTools, resources }`（[agent-harness.ts](file:///Users/bytedance/Documents/crest/emain/agent/harness/agent-harness.ts#L325-L333)）。
- `resources.skills` 已贯通到 turn state，`skills.ts` / `prompt-templates.ts` 加载器已就位。
- 7 个工具（read/write/edit/ls/bash/find/grep）已是 pi 工具的移植版。

**真正缺的是 pi-coding-agent（消费方/CLI 层）**，即"告诉 LLM 怎么用工具"的全部逻辑。crest 目前用三处"自实现"顶替了它，正是 agent 变蠢的根因：

| crest 当前自实现 | pi 对应实现（应拷贝） |
|---|---|
| [build-system-prompt.ts](file:///Users/bytedance/Documents/crest/emain/agent/build-system-prompt.ts#L15-L17) 3 行静态 prompt | `core/system-prompt.ts` 的 `buildSystemPrompt`（动态工具列表 + guidelines + 项目上下文 + 日期） |
| 工具丢失 `promptSnippet`/`promptGuidelines` 元数据 | `core/tools/*.ts` 的 `createXToolDefinition` 携带元数据 |
| harness-factory 零参闭包 `() => buildSystemPrompt(inputs)` 丢弃 `activeTools` | pi `_rebuildSystemPrompt(toolNames)` 收集 snippet/guideline |
| 无 AGENTS.md/CLAUDE.md 加载 | `core/resource-loader.ts` 的 `loadProjectContextFiles` |
| read description 被改成 "text file" + "When uncertain, ask" 反模式 | pi 原文 description + guidelines |

---

## 1. 迁移边界：拷贝 vs 剥离

pi-coding-agent 的工具/prompt 文件深度耦合 pi-tui（`theme`、`keybinding-hints`、`Component`、`image-process`）。这是当初 crest 剥渲染层的原因，**该决策保留**。

对每个拷贝文件统一执行：

**拷贝（逐行搬运，不重写逻辑）**
- `buildSystemPrompt` 主体 prompt 文本、工具列表/guidelines 组装算法、项目上下文注入、日期/cwd 注入。
- `ToolDefinition` 的 `promptSnippet` / `promptGuidelines` 字段值（原文照搬）。
- `loadProjectContextFiles`（AGENTS.md/CLAUDE.md 三层加载）。
- `wrapToolDefinition` / `createToolDefinitionFromAgentTool` 封装器。
- `formatSkillsForPrompt`（crest 已有 `formatSkillsForSystemPrompt`，复用即可，仅需对齐函数名调用）。

**剥离（crest 已有自己的渲染层，删掉即可）**
- `renderCall` / `renderResult` / `renderShell`。
- `import ... from "pi-tui"`、`theme.ts`、`keybinding-hints.ts`、`render-utils.ts`。
- read 工具的图片分支（`image-process` / `mime`）—— 维持现状 deferred。
- pi 文档路径段（`getReadmePath/getDocsPath/getExamplesPath` 那段 "Pi documentation..." 文本），替换为 crest 自己的产品名与上下文，**或直接删除该段**（crest 不是 pi CLI）。

---

## 2. 任务拆解（TDD 顺序，每个任务独立可验证）

### T1 — 引入 `ToolDefinition` 元数据层（promptSnippet/promptGuidelines）
- 在 [emain/agent/types.ts](file:///Users/bytedance/Documents/crest/emain/agent/types.ts#L361) 的 `AgentTool` 增加可选字段 `promptSnippet?: string`、`promptGuidelines?: string[]`（照搬 pi `ToolDefinition` 435-445 行的字段定义与注释）。
- **不新建 ToolDefinition 类型**：crest 已无 pi-tui，`AgentTool` 即可承载这两个元数据字段，避免引入 wrapper 双层结构。
- 验证：类型编译通过；现有工具不传该字段不报错。

### T2 — 每个工具补回 pi 的 snippet/guidelines（逐工具原文照搬）
对 `emain/agent/tools/{read,write,edit,ls,bash,find,grep}.ts`，从 pi `core/tools/*.ts` 拷贝其 `promptSnippet` / `promptGuidelines` 原文：

| 工具 | promptSnippet（pi 原文） | promptGuidelines |
|---|---|---|
| read | `Read file contents` | `Use read to examine files instead of cat or sed.` |
| ls | `List directory contents` | — |
| bash | `Execute bash commands (ls, grep, find, etc.)` | — |
| edit | `Make precise file edits with exact text replacement, including multiple disjoint edits in one call` | 4 条（oldText 精确匹配 / 同文件多编辑合并 / 不重叠 / oldText 尽量小） |
| write | `Create or overwrite files` | `Use write only for new files or complete rewrites.` |
| find | `Find files by glob pattern (respects .gitignore)` | — |
| grep | `Search file contents for patterns (respects .gitignore)` | — |

- 同时**修正 read description**：把 [read.ts:56](file:///Users/bytedance/Documents/crest/emain/agent/tools/read.ts#L56) 的 "text file" 改回 pi 原文 "Read the contents of a file."（图片分支仍 deferred，但 description 不得撒谎说只能读 text）。
- 验证：在 [tools.test.ts](file:///Users/bytedance/Documents/crest/emain/agent/tools/tools.test.ts) 增加断言：每个默认工具都带 `promptSnippet`。

### T3 — 拷贝 pi 的 `buildSystemPrompt`（替换手写 3 行版）
- 用 pi `core/system-prompt.ts` 的实现**替换** [build-system-prompt.ts](file:///Users/bytedance/Documents/crest/emain/agent/build-system-prompt.ts) 主体。
- 新签名（融合 pi 的 `BuildSystemPromptOptions` + crest 的 pane 上下文）：
  ```ts
  buildSystemPrompt({
    cwd, selectedTools, toolSnippets, promptGuidelines,
    contextFiles, skills,
    // crest pane 扩展：gitBranch / connection / recentCmds 作为附加段
    gitBranch, connection, recentCmds,
  })
  ```
- 拷贝 pi 的：默认主体 prompt、Available tools 列表、Guidelines 去重组装、`<project_context>` 注入、skills 注入（read 工具存在时）、日期 + cwd。
- 删除 pi 的 "Pi documentation..." 段（crest 非 pi CLI）。
- 删除 crest 旧的 "When uncertain, ask one clarifying question" 反模式句。
- crest pane 上下文（git/connection/recentCmds）作为附加段拼到主体之后，保留现有能力。
- 验证：改写 [sessions.test.ts](file:///Users/bytedance/Documents/crest/emain/agent/sessions.test.ts#L163) 既有 6 个用例 + 新增：工具列表出现、guidelines 出现、无 "When uncertain"。

### T4 — 拷贝 `loadProjectContextFiles`（AGENTS.md / CLAUDE.md）
- 从 pi `core/resource-loader.ts` 拷贝 `loadContextFileFromDir` + `loadProjectContextFiles`（50-122 行）。
- 落点：`emain/agent/resource-loader.ts`（新文件，带 LICENSE.pi 头）。
- 验证：临时目录写 AGENTS.md → 断言出现在 contextFiles；三层（global/ancestor/cwd）顺序与去重正确。

### T5 — 在 harness-factory / IPC 接通 snippet/guideline/context 收集
- 修正 [harness-factory.ts:86](file:///Users/bytedance/Documents/crest/emain/agent/harness-factory.ts#L86) 的零参闭包，改为接收 pi 传入的 `{ activeTools, ... }`：
  ```ts
  systemPrompt: ({ activeTools }) => buildSystemPrompt({
    ...inputs,
    selectedTools: activeTools.map(t => t.name),
    toolSnippets: collectSnippets(activeTools),
    promptGuidelines: collectGuidelines(activeTools),
    contextFiles: loadProjectContextFiles({ cwd: inputs.cwd, agentDir }),
    skills: opts.skills,
  })
  ```
  `collectSnippets/collectGuidelines` 照搬 pi `_rebuildSystemPrompt`（agent-session.ts 908-941）的收集逻辑。
- 在 [agent-ipc.ts:428](file:///Users/bytedance/Documents/crest/emain/agent-ipc.ts#L428) 把 contextFiles/skills 资源接到 `buildPaneHarness`（skills 走已有的 `resources.skills` 通道）。
- 验证：集成测试断言一次 turn 的 systemPrompt 含工具列表 + AGENTS.md 内容。

### T6 — eval 回归基线对齐
- [run-regression.ts:84](file:///Users/bytedance/Documents/crest/emain/agent/eval/run-regression.ts#L84) 的 `systemPrompt` 改为新签名。
- 复核 [scenarios.ts](file:///Users/bytedance/Documents/crest/emain/agent/eval/scenarios.ts)：移除/新增不显式说 "use the X tool" 的场景，验证 agent 能自主选工具（two_sum.py 类场景）。

---

## 3. 暂不迁移（明确 out-of-scope）

保持 deferred，避免 scope 膨胀：

- **Extensions 系统**（`core/extensions/*`）：registerTool/钩子框架，crest 暂无需求。
- **Skills 运行时自动发现目录**：加载器已在，但"从哪些目录发现"是产品决策，本次只接通 `resources.skills` 注入通道。
- **read 图片分支**、**bash temp-file 回退**、**Prompt Templates UI**、**Project Trust**：维持现状。

---

## 4. 拷贝来源对照

| pi 源文件 | crest 落点 | 处理 |
|---|---|---|
| `core/system-prompt.ts` | `emain/agent/build-system-prompt.ts` | 拷贝主体，删 pi-docs 段，融合 pane 上下文 |
| `core/skills.ts::formatSkillsForPrompt` | 复用已有 `harness/system-prompt.ts::formatSkillsForSystemPrompt` | 对齐调用 |
| `core/resource-loader.ts`（context 部分） | `emain/agent/resource-loader.ts`（新建） | 拷贝 `loadProjectContextFiles` |
| `core/tools/*.ts`（snippet/guidelines 字段） | `emain/agent/tools/*.ts` | 逐工具搬元数据 + 修 read description |
| `core/agent-session.ts::_rebuildSystemPrompt`（收集逻辑） | `emain/agent/harness-factory.ts` | 拷贝 snippet/guideline 收集 |
| `extensions/types.ts::ToolDefinition`（promptSnippet/promptGuidelines 字段） | `emain/agent/types.ts::AgentTool` | 仅加 2 个字段 |

---

## 5. 验收

- [ ] systemPrompt 实际输出含：默认主体、Available tools 列表、Guidelines、AGENTS.md（如存在）、日期、cwd。
- [ ] 不含 "When uncertain, ask"。
- [ ] read description 不再声称仅支持 text file。
- [ ] 全部默认工具携带 promptSnippet。
- [ ] eval 中"不显式指名工具"的场景能自主选对工具。
- [ ] 既有测试套件全绿。
