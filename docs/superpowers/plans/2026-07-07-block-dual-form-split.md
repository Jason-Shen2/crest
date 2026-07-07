# Block 双形态拆分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前统一的 `TerminalView`（shell 时间线 + 全套 agent 装配混在一起）拆成两种形态——纯终端 block（`view: "term"`，无 agent UI）与 agent 会话 block（`view: "agent"`，保留内嵌 shell），二者共享同一个 `TerminalModel` 引擎。

**Architecture:** 从 `terminal-view.tsx` 抽出全部 agent 逻辑到 `useAgentPane` hook + `AgentSurface` 组件。`TerminalView` 变成薄的宿主，接受一个可选的 `agentSlot: AgentSlot | null` 结构（承载 chat host / activity bar / session selector / 输入栏 agent 属性）。`agentSlot == null` → 纯终端；`agentSlot` 存在 → agent 会话。新增 `AgentViewModel`（`view: "agent"`），与 `TermViewModel` 并列注册。后端新增 agent launcher widget，新 tab 默认改为 agent。

**Tech Stack:** React + jotai（frontend），Vitest（测试），Go（wavesrv 后端 widget/layout 配置）。

---

## 设计参考

- 设计文档: [`docs/superpowers/specs/2026-07-07-block-dual-form-split-design.md`](../specs/2026-07-07-block-dual-form-split-design.md)
- 关键事实:
  - 两种形态共享 `TerminalModel`（`frontend/app/term/terminal-model.ts`），底层是自研 cmdblock 引擎，**不重引 xterm.js**。
  - agent 内容存 SQLite session（`agent:session` meta 指向），shell 存 filestore + `db_cmdblock`，**存储天然分离，后端无 schema 变更**。
  - 两种 view 都带 `controller: "shell"`（agent 内嵌 shell 需要真实 PTY）。
  - 形态创建时固定，**不支持运行时切换**。

## 文件结构

**新建:**
- `frontend/app/term/render/agent-pane.tsx` — `useAgentPane` hook + `AgentSurface` 组件 + `AgentSlot` 类型（所有 agent 逻辑与 JSX 的新家）
- `frontend/app/term/render/agent-pane.test.tsx` — `AgentSurface` 挂载测试
- `frontend/app/view/agentblock/agent-model.tsx` — `AgentViewModel`（`view: "agent"`）+ adapter

**修改:**
- `frontend/app/term/render/terminal-view.tsx` — 移除 agent 逻辑，改为接受 `agentSlot` prop
- `frontend/app/view/termblocks/termblocks.tsx` — adapter 传 `agentSlot={null}`（纯终端）
- `frontend/app/view/term/term-model.tsx` — adapter 传 `agentSlot={null}`（纯终端）
- `frontend/app/block/blockregistry.ts` — 注册 `"agent" → AgentViewModel`
- `frontend/app/block/blockutil.tsx` — `blockViewToIcon`/`blockViewToName` 加 `"agent"` 分支
- `frontend/app/term/render/terminal-view-tui.test.tsx` — 更新断言：纯终端渲染无 agent 元素
- `pkg/wconfig/defaultconfig/widgets.json` — 新增 `defwidget@agent`
- `pkg/wcore/layout.go` — `GetNewTabLayout` 默认 view 改为 `agent`

**关键类型契约（贯穿全 plan）:**

```ts
// agent-pane.tsx
export interface AgentSlot {
    // 挂在 FindBar 之后、block list 之前 —— headless，通常 render null
    chatHost: React.ReactNode;
    // 挂在 block list 之后
    commandResults: React.ReactNode;
    // 输入栏上方（!inAltScreen 时）
    activityBar: React.ReactNode;
    // 输入栏容器 —— 含 SessionSelector + 传 agent 属性的 CmdBlockInput
    inputBar: React.ReactNode;
    // 传给 BlockListElement，渲染 agent 时间线块
    agentRunsById: Map<string, PiRun>;
}
```

---

## Task 1: 在 TerminalView 中定义 agentSlot 契约（纯终端仍可渲染）

**Files:**
- Modify: `frontend/app/term/render/terminal-view.tsx`

先让 `TerminalView` 支持"无 agent"渲染路径，但暂时保持现有 agent 代码在原地（Task 3 才搬走）。这样每步都可编译、可测试。

- [ ] **Step 1: 在 TerminalViewProps 增加 agentSlot 字段**

在 `terminal-view.tsx` 的 `TerminalViewProps`（约 L41-57）末尾加入：

```ts
    // Agent 装配。null → 纯终端形态（无 agent UI）；非 null → agent 会话
    // 形态，承载 chat host / activity bar / session selector / agent 输入栏。
    // 由 AgentPaneView 通过 useAgentPane() 构造并传入；TerminalPaneView 传 null。
    agentSlot?: import("./agent-pane").AgentSlot | null;
```

- [ ] **Step 2: 运行现有 TUI 测试确认未破坏**

Run: `npx vitest run frontend/app/term/render/terminal-view-tui.test.tsx`
Expected: PASS（新字段可选，未使用）

- [ ] **Step 3: 提交**

```bash
git add frontend/app/term/render/terminal-view.tsx
git commit -m "refactor(term): add optional agentSlot prop to TerminalView"
```

---

## Task 2: 新建 agent-pane.tsx，承载 useAgentPane hook 与 AgentSurface

**Files:**
- Create: `frontend/app/term/render/agent-pane.tsx`

把 `terminal-view.tsx` 里所有 agent 相关的 state / callback / JSX 搬到这里。这是本 plan 的核心搬迁。以下代码**逐字**从 `terminal-view.tsx` 提取（保留注释），封装成 `useAgentPane(outerBlockId, model, deps)` 返回 `AgentSlot`。

- [ ] **Step 1: 创建 agent-pane.tsx 文件骨架与类型**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentPane — all the agent-conversation wiring that used to live inline in
// TerminalView.  A pure-terminal block (view: "term") never imports this
// file; the agent block (view: "agent") mounts it via useAgentPane() and
// hands the resulting AgentSlot to TerminalView.  Sharing the underlying
// TerminalModel keeps the engine (blocks / alt-screen / selection) common
// to both forms; only this agent surface differs.

import { CATALOG } from "@/app/store/ai-catalog";
import { providerModelsMapAtom } from "@/app/store/ai-provider-models";
import { resolveAIConfig } from "@/app/store/ai-resolver";
import { AgentSelection, ResolvedAIConfig, ResolveError } from "@/app/store/ai-types";
import { aiUserConfigAtom } from "@/app/store/ai-user-config";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { ObjectService } from "@/app/store/services";
import { indexRunsById, type PiRun } from "@/app/store/use-pi-chat";
import { CmdBlockInput, InputMode } from "@/app/view/cmdblock/cmdblock-input";
import { SessionSelector } from "@/app/view/cmdblock/session-selector";
import { fileexplorerWorkspaceDirAtom } from "@/app/fileexplorer/file-explorer-atoms";
import { ObjectService as _Obj } from "@/app/store/services";
import { useOrefMetaKeyAtom, WOS } from "@/store/global";
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useRef, useState } from "react";
import type { TerminalModel } from "../terminal-model";
import { AgentActivityBar } from "./agent-activity-bar";
import {
    AgentChatHost,
    type AgentChatHostApi,
    type AgentHostState,
    type AgentInlineCommandResult,
    type AgentSelectorRequest,
} from "./agent-chat-host";
import { AgentCommandResultList } from "./agent-command-result";

export interface AgentSlot {
    chatHost: React.ReactNode;
    commandResults: React.ReactNode;
    activityBar: React.ReactNode;
    inputBar: React.ReactNode;
    agentRunsById: Map<string, PiRun>;
}

// 输入栏渲染需要的、来自 TerminalView 的实时上下文。这些值 TerminalView
// 已经算好（cwd/branch/ssh/history 等），通过 deps 传入避免重复计算。
export interface AgentPaneDeps {
    fontSize: number;
    focusRequest: number;
    liveCwd: string;
    home: string;
    branch?: string;
    gitAdded?: number;
    gitRemoved?: number;
    prNumber?: number;
    prTitle?: string;
    kubernetesContext?: string;
    sshHost?: string;
    sshUser?: string;
    workspaceDir: string;
    liveGitBranch?: string;
    recentCmds: string[];
    liveConnection: string;
    commandHistory: string[];
    inputMode: InputMode;
    effectiveMode: InputMode;
    onModeChange: (next: InputMode, currentText?: string) => void;
    onInputTextChange: (next: string) => void;
    isRunning: boolean;
    inAltScreen: boolean;
}
```

> 注意：上面 import 里 `fileexplorerWorkspaceDirAtom` / `_Obj` 是占位，Step 2 会用真实符号替换。先放骨架，Step 2 填充完整实现后即为最终版。

- [ ] **Step 2: 写入 useAgentPane hook 的完整实现**

在 Step 1 文件末尾追加。以下从 `terminal-view.tsx` 逐段搬迁（含 helper `stripVendorPrefix`/`cleanModelLabel`）：

```tsx
export function useAgentPane(outerBlockId: string, model: TerminalModel, deps: AgentPaneDeps): AgentSlot {
    const revision = useAtomValue(model.revisionAtom);
    const [agentCommandResults, setAgentCommandResults] = useState<AgentInlineCommandResult[]>([]);

    // ---- AI model picker / selection（原 terminal-view L214-313）----
    const userConfigState = useAtomValue(aiUserConfigAtom);
    const blockAgentSelection = useOrefMetaKeyAtom(WOS.makeORef("block", outerBlockId), "agent:selection");
    const activeSelection = useMemo<AgentSelection | null>(() => {
        if (blockAgentSelection?.provider && blockAgentSelection?.model) {
            return {
                provider: blockAgentSelection.provider,
                model: blockAgentSelection.model,
                reasoning: blockAgentSelection.reasoning as "low" | "medium" | "high" | undefined,
            };
        }
        const def = userConfigState.config?.default;
        if (def?.provider && def?.model) {
            return {
                provider: def.provider,
                model: def.model,
                reasoning: def.reasoning as "low" | "medium" | "high" | undefined,
            };
        }
        return null;
    }, [blockAgentSelection, userConfigState.config]);

    const providerModelsMap = useAtomValue(providerModelsMapAtom);
    const modelDisplayLabel = useMemo(() => {
        if (!activeSelection) return "Pick model";
        const provider = CATALOG.find((p) => p.id === activeSelection.provider);
        const modelMeta = provider?.models.find((m) => m.id === activeSelection.model);
        const liveMatch = providerModelsMap[activeSelection.provider]?.models.find(
            (m) => m.id === activeSelection.model
        );
        const fallbackId = stripVendorPrefix(activeSelection.model);
        const base = cleanModelLabel(modelMeta?.displayName ?? liveMatch?.name ?? fallbackId);
        return activeSelection.reasoning ? `${base} · ${activeSelection.reasoning}` : base;
    }, [activeSelection, providerModelsMap]);

    const onSelectionChange = useCallback(
        (next: AgentSelection) => {
            void ObjectService.UpdateObjectMeta(WOS.makeORef("block", outerBlockId), {
                "agent:selection": {
                    provider: next.provider,
                    model: next.model,
                    reasoning: next.reasoning ?? "",
                },
            });
        },
        [outerBlockId]
    );

    const { resolvedAIConfig, aiConfigError } = useMemo<{
        resolvedAIConfig: ResolvedAIConfig | null;
        aiConfigError: ResolveError | null;
    }>(() => {
        if (!activeSelection) {
            return {
                resolvedAIConfig: null,
                aiConfigError: {
                    code: "no_default",
                    message: "No model selected. Open the picker or set a default in ai.json.",
                },
            };
        }
        const r = resolveAIConfig(activeSelection, userConfigState.config ?? undefined, CATALOG);
        if (r.ok) return { resolvedAIConfig: r.config, aiConfigError: null };
        const errResult = r as { ok: false; error: ResolveError };
        return { resolvedAIConfig: null, aiConfigError: errResult.error };
    }, [activeSelection, userConfigState.config]);

    const onOpenAIConfigFile = useCallback(() => {
        modalsModel.pushModal("AISetupWizard");
    }, []);

    // ---- agent wiring（原 terminal-view L369-492）----
    const [submitting, setSubmitting] = useState(false);
    const agentApiRef = useRef<AgentChatHostApi | null>(null);
    const onAgentHostReady = useCallback((api: AgentChatHostApi) => {
        agentApiRef.current = api;
    }, []);
    const [modelPickerRequest, setModelPickerRequest] = useState(0);
    const onOpenAgentModelPicker = useCallback(() => {
        setModelPickerRequest((value) => value + 1);
    }, []);
    const [agentSelectorRequest, setAgentSelectorRequest] = useState<AgentSelectorRequest | null>(null);
    const onAgentSelectorRequest = useCallback((request: AgentSelectorRequest) => {
        setAgentSelectorRequest(request);
    }, []);
    const agentSelectorAnchorRef = useRef<HTMLDivElement>(null);
    const [agentRestoredTextRequest, setAgentRestoredTextRequest] = useState<
        { text: string; requestId: number } | undefined
    >(undefined);
    const onAgentEditorText = useCallback((text: string) => {
        setAgentRestoredTextRequest((prev) => ({ text, requestId: (prev?.requestId ?? 0) + 1 }));
    }, []);
    const [agentState, setAgentState] = useState<AgentHostState>({ status: "idle", queuedMessages: [] });
    const onAgentStop = useCallback(() => {
        agentApiRef.current?.abort();
    }, []);
    const persistedAgentSession = useOrefMetaKeyAtom(WOS.makeORef("block", outerBlockId), "agent:session");
    const timelineAgentSessionPath = useMemo(() => model.getFirstAgentSessionPath(), [model, revision]);
    const agentSession = useMemo<AgentSessionMeta | undefined>(() => {
        if (persistedAgentSession?.path) return persistedAgentSession;
        if (!timelineAgentSessionPath) return undefined;
        return { id: "", createdAt: "", cwd: deps.workspaceDir, path: timelineAgentSessionPath };
    }, [persistedAgentSession, timelineAgentSessionPath, deps.workspaceDir]);
    const onSessionMintedHandler = useCallback(
        (meta: AgentSessionMeta) => {
            void ObjectService.UpdateObjectMeta(WOS.makeORef("block", outerBlockId), { "agent:session": meta });
        },
        [outerBlockId]
    );
    const [agentRunsById, setAgentRunsById] = useState<Map<string, PiRun>>(new Map());
    const onAgentRunsUpdate = useCallback(
        (runs: PiRun[]) => {
            setAgentRunsById(indexRunsById(runs));
            model.syncAgentBlocks(new Set(runs.map((r) => r.runId)));
        },
        [model]
    );
    const onAgentCommandResult = useCallback((result: AgentInlineCommandResult) => {
        setAgentCommandResults((prev) => [...prev, result]);
    }, []);

    const onSubmit = useCallback(
        (text: string, mode: InputMode) => {
            if (!text) return;
            if (mode === "agent") {
                const api = agentApiRef.current;
                if (!api) {
                    globalStore.set(model.notificationAtom, "Agent is still starting. Try again in a moment.");
                    return false;
                }
                return api.submit(text);
            }
            setSubmitting(true);
            void model.submitInput(text).finally(() => setSubmitting(false));
        },
        [model]
    );

    const chatHost = (
        <AgentChatHost
            outerBlockId={outerBlockId}
            sessionMetadata={agentSession}
            onSessionMinted={onSessionMintedHandler}
            modelSelection={
                resolvedAIConfig
                    ? {
                          provider: resolvedAIConfig.provider,
                          model: resolvedAIConfig.model,
                          reasoning: resolvedAIConfig.reasoning,
                          token: resolvedAIConfig.token,
                          tokenSecretName: resolvedAIConfig.tokensecretname,
                      }
                    : activeSelection
                      ? {
                            provider: activeSelection.provider,
                            model: activeSelection.model,
                            reasoning: activeSelection.reasoning,
                        }
                      : undefined
            }
            paneContext={{
                cwd: deps.workspaceDir,
                gitBranch: deps.liveGitBranch,
                recentCmds: deps.recentCmds,
                connection: deps.liveConnection,
            }}
            selectionError={aiConfigError}
            onReady={onAgentHostReady}
            onRunsChange={onAgentRunsUpdate}
            onStateChange={setAgentState}
            onUserError={(msg) => globalStore.set(model.notificationAtom, msg)}
            onCommandResult={onAgentCommandResult}
            onOpenModelPicker={onOpenAgentModelPicker}
            onSelectorRequest={onAgentSelectorRequest}
        />
    );

    const commandResults = <AgentCommandResultList results={agentCommandResults} />;

    const activityBar = deps.inAltScreen ? null : (
        <AgentActivityBar status={agentState.status} queuedMessages={agentState.queuedMessages} onStop={onAgentStop} />
    );

    const inputBar = deps.inAltScreen ? null : (
        <div ref={agentSelectorAnchorRef}>
            <SessionSelector
                anchorRef={agentSelectorAnchorRef}
                request={agentSelectorRequest}
                onClose={() => setAgentSelectorRequest(null)}
                onUserMessage={(msg) => globalStore.set(model.notificationAtom, msg)}
                onEditorText={onAgentEditorText}
            />
            <CmdBlockInput
                cwd={deps.liveCwd}
                home={deps.home}
                branch={deps.branch}
                gitAdded={deps.gitAdded}
                gitRemoved={deps.gitRemoved}
                prNumber={deps.prNumber}
                prTitle={deps.prTitle}
                kubernetesContext={deps.kubernetesContext}
                sshHost={deps.sshHost}
                sshUser={deps.sshUser}
                mode={deps.inputMode}
                onModeChange={deps.onModeChange}
                onSubmit={onSubmit}
                submitting={submitting}
                disabled={false}
                fontSize={deps.fontSize}
                focusRequest={deps.focusRequest}
                history={deps.commandHistory}
                onTextChange={deps.onInputTextChange}
                restoredTextRequest={agentRestoredTextRequest}
                effectiveMode={deps.effectiveMode}
                modelDisplayLabel={modelDisplayLabel}
                catalog={CATALOG}
                userConfig={userConfigState.config}
                userConfigStatus={userConfigState.status}
                userConfigError={userConfigState.error}
                selection={activeSelection}
                onSelectionChange={onSelectionChange}
                onOpenAIConfigFile={onOpenAIConfigFile}
                openModelPickerRequest={modelPickerRequest}
                placeholder={
                    deps.isRunning
                        ? "Press Ctrl+C in the running block to interrupt, or type the next command"
                        : undefined
                }
            />
        </div>
    );

    return { chatHost, commandResults, activityBar, inputBar, agentRunsById };
}

// stripVendorPrefix — 原 terminal-view.tsx L957-964
function stripVendorPrefix(modelId: string): string {
    const i = modelId.lastIndexOf("/");
    if (i < 0 || i === modelId.length - 1) return modelId;
    return modelId.slice(i + 1);
}

// cleanModelLabel — 原 terminal-view.tsx L966-978
function cleanModelLabel(label: string): string {
    let s = label.replace(/\s*\([^)]*\)\s*$/, "");
    const idx = s.indexOf(": ");
    if (idx > 0 && idx < s.length - 2) {
        s = s.slice(idx + 2);
    }
    return s.trim();
}
```

> 修正 Step 1 骨架里的占位 import：删除 `fileexplorerWorkspaceDirAtom` 与 `_Obj` 两行（workspaceDir 由 deps 传入，ObjectService 已单独 import）。

- [ ] **Step 3: 修正 Step 1 的占位 import**

编辑 `agent-pane.tsx` 顶部 import，删掉这两行占位：

```ts
import { fileexplorerWorkspaceDirAtom } from "@/app/fileexplorer/file-explorer-atoms";
import { ObjectService as _Obj } from "@/app/store/services";
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep agent-pane`
Expected: 无 agent-pane.tsx 相关错误（注意 `frontend/wave.ts` 已有 3 个既存无关错误，忽略）

- [ ] **Step 5: 提交**

```bash
git add frontend/app/term/render/agent-pane.tsx
git commit -m "refactor(term): extract agent wiring into useAgentPane/AgentSurface"
```

---

## Task 3: TerminalView 消费 agentSlot，移除内联 agent 代码

**Files:**
- Modify: `frontend/app/term/render/terminal-view.tsx`

现在把 `TerminalView` 里的 agent 代码删掉，改为消费 `agentSlot`。保留所有共享逻辑（引擎、cols 测量、alt-screen、选区、快捷键、NLD 输入模式、chip model）。

- [ ] **Step 1: 删除 agent 专属 import 与 state**

从 `terminal-view.tsx` 删除以下 import（现由 agent-pane 拥有）：`CATALOG`、`providerModelsMapAtom`、`resolveAIConfig`、`ResolvedAIConfig/ResolveError`、`aiUserConfigAtom`、`modalsModel`、`ObjectService`、`indexRunsById/PiRun`、`AgentActivityBar`、`AgentChatHost` 及其类型、`AgentCommandResultList`、`SessionSelector`。保留 `CmdBlockInput, InputMode`（纯终端输入栏仍需要）。

删除组件内所有 agent state / callback（原 L129 `agentCommandResults`、L209-475 的 AI 选择与 agent wiring 整段、L477-492 `onSubmit`）。保留 `useNLDModel`/`useContextChipModel`/chip 逻辑/`liveBlock`/`terminalInputState`。

- [ ] **Step 2: 为纯终端补一个 shell-only onSubmit**

在删掉的 agent `onSubmit` 位置，加入纯终端提交（无 agent 分支）：

```tsx
        const [submitting, setSubmitting] = useState(false);
        const onSubmit = useCallback(
            (text: string) => {
                if (!text) return;
                setSubmitting(true);
                void model.submitInput(text).finally(() => setSubmitting(false));
            },
            [model]
        );
```

- [ ] **Step 3: 改写 JSX —— 用 agentSlot 替换内联 agent 元素**

将 `return (...)` 主体（原 L798-951）改为：`FindBar` 后渲染 `{agentSlot?.chatHost}`；`BlockListElement` 的 `agentRunsById` 传 `{agentSlot?.agentRunsById ?? EMPTY_RUNS}`；block list 后渲染 `{agentSlot?.commandResults}`；footer spacer 后渲染 `{agentSlot?.activityBar}`；输入栏区域改为：

```tsx
                    {!inAltScreen &&
                        (agentSlot ? (
                            agentSlot.inputBar
                        ) : (
                            <CmdBlockInput
                                cwd={liveCwd}
                                home={home}
                                branch={liveBlock?.gitBranch || chipValues.gitBranch}
                                gitAdded={liveBlock?.gitDiffAdded ?? chipValues.gitDiffAdded}
                                gitRemoved={liveBlock?.gitDiffRemoved ?? chipValues.gitDiffRemoved}
                                prNumber={chipValues.prNumber}
                                prTitle={chipValues.prTitle}
                                kubernetesContext={chipValues.kubernetesContext}
                                sshHost={sshHost}
                                sshUser={sshUser}
                                mode="terminal"
                                onModeChange={() => {}}
                                onSubmit={onSubmit}
                                submitting={submitting}
                                disabled={false}
                                fontSize={fontSize}
                                focusRequest={focusRequest}
                                history={commandHistory}
                                onTextChange={onInputTextChange}
                                placeholder={
                                    isRunning
                                        ? "Press Ctrl+C in the running block to interrupt, or type the next command"
                                        : undefined
                                }
                            />
                        ))}
```

在组件文件顶部（`TerminalView` 外）加一个稳定空 Map 常量：

```tsx
const EMPTY_RUNS: Map<string, PiRun> = new Map();
```

并保留 `import { type PiRun } from "@/app/store/use-pi-chat";`（仅类型）。

- [ ] **Step 4: 删除文件末尾 stripVendorPrefix/cleanModelLabel**

这两个函数已搬到 agent-pane.tsx，从 terminal-view.tsx 末尾（原 L957-978）删除。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep terminal-view`
Expected: 无 terminal-view.tsx 相关错误

- [ ] **Step 6: 提交**

```bash
git add frontend/app/term/render/terminal-view.tsx
git commit -m "refactor(term): TerminalView consumes agentSlot instead of inline agent"
```

---

## Task 4: 更新 TUI 测试断言纯终端无 agent 元素

**Files:**
- Modify: `frontend/app/term/render/terminal-view-tui.test.tsx`

现有测试渲染 `<TerminalView outerBlockId="outer" />`（无 agentSlot）→ 纯终端。它已经 mock 掉 `AgentChatHost`/`AgentActivityBar`，但现在这些不再由 TerminalView 挂载。加一条明确断言。

- [ ] **Step 1: 加纯终端无 agent 元素的断言**

在 `describe("TerminalView TUI mode", ...)` 内新增一个 `describe`（文件末尾 `it` 之后）：

```tsx
describe("TerminalView pure-terminal form", () => {
    beforeEach(() => {
        installDocumentStub();
        testState.loading = false;
        testState.blocks = null;
        testState.inputStateOverride = { kind: "input-editor" };
    });
    afterEach(() => {
        testState.effectCleanups.forEach((cleanup) => cleanup());
        testState.effectCleanups.length = 0;
        vi.unstubAllGlobals();
    });

    it("renders no agent chat host or activity bar without agentSlot", () => {
        const html = renderTerminalView();
        expect(html).not.toContain('data-testid="agent-chat-host"');
        expect(html).not.toContain('data-testid="agent-activity-bar"');
    });

    it("still renders the command input in terminal mode", () => {
        const html = renderTerminalView();
        expect(html).toContain('data-testid="cmd-input"');
    });
});
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run frontend/app/term/render/terminal-view-tui.test.tsx`
Expected: PASS（所有既有用例 + 2 条新用例）

- [ ] **Step 3: 提交**

```bash
git add frontend/app/term/render/terminal-view-tui.test.tsx
git commit -m "test(term): assert pure-terminal form mounts no agent surface"
```

---

## Task 5: AgentSurface 组件 + agent-pane 测试

**Files:**
- Modify: `frontend/app/term/render/agent-pane.tsx`
- Create: `frontend/app/term/render/agent-pane.test.tsx`

提供一个便捷组件 `AgentSurface`，供 AgentPaneView 使用（也让测试有明确挂载点）。它只是 `useAgentPane` 的一层包装，把 slot 渲染成一组 fragment（供不走 TerminalView 组合路径的场景，但主路径仍由 TerminalView 消费 slot）。实际上 AgentPaneView 走 hook 路径，所以这里只加测试验证 hook 产出。

- [ ] **Step 1: 为 useAgentPane 写测试**

创建 `agent-pane.test.tsx`。参照 tui 测试的 mock 风格，mock 掉 agent 子组件与 store，断言 `useAgentPane` 返回的 slot 各字段非空、agentRunsById 是 Map：

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/ai-catalog", () => ({ CATALOG: [] }));
vi.mock("@/app/store/ai-provider-models", () => ({ providerModelsMapAtom: { read: () => ({}) } }));
vi.mock("@/app/store/ai-resolver", () => ({ resolveAIConfig: () => ({ ok: false, error: { code: "x", message: "x" } }) }));
vi.mock("@/app/store/ai-user-config", () => ({ aiUserConfigAtom: { read: () => ({ config: null, status: "loaded", error: null }) } }));
vi.mock("@/app/store/jotaiStore", () => ({ globalStore: { set: vi.fn() } }));
vi.mock("@/app/store/modalmodel", () => ({ modalsModel: { pushModal: vi.fn() } }));
vi.mock("@/app/store/services", () => ({ ObjectService: { UpdateObjectMeta: vi.fn() } }));
vi.mock("@/app/store/use-pi-chat", () => ({ indexRunsById: () => new Map() }));
vi.mock("@/app/view/cmdblock/cmdblock-input", () => ({
    CmdBlockInput: () => <div data-testid="cmd-input" />,
}));
vi.mock("@/app/view/cmdblock/session-selector", () => ({
    SessionSelector: () => <div data-testid="session-selector" />,
}));
vi.mock("./agent-activity-bar", () => ({ AgentActivityBar: () => <div data-testid="agent-activity-bar" /> }));
vi.mock("./agent-chat-host", () => ({ AgentChatHost: () => <div data-testid="agent-chat-host" /> }));
vi.mock("./agent-command-result", () => ({ AgentCommandResultList: () => <div data-testid="agent-cmd-results" /> }));
vi.mock("jotai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("jotai")>();
    return { ...actual, useAtomValue: (a: { read?: () => unknown }) => (typeof a?.read === "function" ? a.read() : undefined) };
});
vi.mock("@/store/global", () => ({
    useOrefMetaKeyAtom: () => null,
    WOS: { makeORef: (type: string, id: string) => ({ type, id }) },
}));

import { useAgentPane, type AgentPaneDeps } from "./agent-pane";

function fakeModel() {
    return {
        revisionAtom: { read: () => 1 },
        notificationAtom: { read: () => "" },
        getFirstAgentSessionPath: () => "",
        syncAgentBlocks: vi.fn(),
        submitInput: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("../terminal-model").TerminalModel;
}

const deps: AgentPaneDeps = {
    fontSize: 16, focusRequest: 0, liveCwd: "/x", home: "/home", workspaceDir: "/x",
    recentCmds: [], liveConnection: "", commandHistory: [], inputMode: "agent",
    effectiveMode: "agent", onModeChange: () => {}, onInputTextChange: () => {},
    isRunning: false, inAltScreen: false,
};

// 用一个探针组件调用 hook（hook 必须在组件内调用）
function Probe({ onSlot }: { onSlot: (slot: ReturnType<typeof useAgentPane>) => void }) {
    const slot = useAgentPane("outer", fakeModel(), deps);
    onSlot(slot);
    return <>{slot.chatHost}{slot.activityBar}{slot.inputBar}{slot.commandResults}</>;
}

describe("useAgentPane", () => {
    it("produces a full agent slot with all surfaces", () => {
        let captured: ReturnType<typeof useAgentPane> | null = null;
        const html = renderToStaticMarkup(<Probe onSlot={(s) => (captured = s)} />);
        expect(html).toContain('data-testid="agent-chat-host"');
        expect(html).toContain('data-testid="agent-activity-bar"');
        expect(html).toContain('data-testid="cmd-input"');
        expect(html).toContain('data-testid="session-selector"');
        expect(captured!.agentRunsById instanceof Map).toBe(true);
    });

    it("omits activity bar and input bar in alt-screen", () => {
        const altDeps = { ...deps, inAltScreen: true };
        function AltProbe() {
            const slot = useAgentPane("outer", fakeModel(), altDeps);
            return <>{slot.activityBar}{slot.inputBar}</>;
        }
        const html = renderToStaticMarkup(<AltProbe />);
        expect(html).not.toContain('data-testid="cmd-input"');
        expect(html).not.toContain('data-testid="agent-activity-bar"');
    });
});
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run frontend/app/term/render/agent-pane.test.tsx`
Expected: PASS（2 用例）

- [ ] **Step 3: 提交**

```bash
git add frontend/app/term/render/agent-pane.test.tsx
git commit -m "test(term): cover useAgentPane slot construction"
```

---

## Task 6: 新建 AgentViewModel 并注册 view: "agent"

**Files:**
- Create: `frontend/app/view/agentblock/agent-model.tsx`
- Modify: `frontend/app/block/blockregistry.ts`

- [ ] **Step 1: 创建 agent-model.tsx**

参照 `TermBlocksViewModel` 结构，adapter 里用 `useAgentPane` 组装 slot 并传给 `TerminalView`。因为 hook 必须在组件里调用，把组装放进一个 `AgentSurfaceHost` 内联组件：

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentViewModel — the "agent" block form.  Same TerminalModel engine as the
// pure-terminal "term"/"termblocks" forms, but mounts the agent surface
// (chat host / activity bar / session selector / agent input mode) via
// useAgentPane.  Created explicitly by the launcher's Agent widget and as the
// default block in new tabs.  See docs/superpowers/specs/2026-07-07-block-dual-form-split-design.md.

import { TerminalView } from "@/app/term/render/terminal-view";
import { useAgentPane, type AgentPaneDeps } from "@/app/term/render/agent-pane";
import { getBlockMetaKeyAtom, getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";

export class AgentViewModel implements ViewModel {
    readonly viewType = "agent";
    readonly blockId: string;

    readonly viewIcon = jotai.atom("sparkles");
    readonly viewName = jotai.atom("Agent");
    readonly noPadding = jotai.atom(true);

    readonly termFontSizeAtom: jotai.Atom<number>;
    readonly focusRequestAtom = jotai.atom(0);

    disposed = false;

    constructor({ blockId }: ViewModelInitType) {
        this.blockId = blockId;
        const metaAtom = getBlockMetaKeyAtom(blockId, "term:fontsize");
        const settingAtom = getSettingsKeyAtom("term:fontsize");
        this.termFontSizeAtom = jotai.atom((get) => {
            const override = get(metaAtom);
            if (typeof override === "number") return override;
            const fallback = get(settingAtom);
            return typeof fallback === "number" ? fallback : 16;
        });
    }

    get viewComponent(): ViewComponent {
        return AgentViewAdapter as unknown as ViewComponent;
    }

    giveFocus(): boolean {
        globalStore.set(this.focusRequestAtom, (prev) => prev + 1);
        return true;
    }

    dispose(): void {
        this.disposed = true;
    }
}

const AgentViewAdapter: React.FC<{ model: AgentViewModel }> = ({ model }) => {
    const fontSize = useAtomValue(model.termFontSizeAtom);
    const focusRequest = useAtomValue(model.focusRequestAtom);
    return <AgentSurfaceHost blockId={model.blockId} fontSize={fontSize} focusRequest={focusRequest} />;
};
AgentViewAdapter.displayName = "AgentViewAdapter";
```

- [ ] **Step 2: 在同文件加 AgentSurfaceHost**

`useAgentPane` 需要来自引擎的实时上下文（liveCwd/branch/inputMode 等）。这些当前由 `TerminalView` 内部计算，`AgentSurfaceHost` 无法直接拿到。为避免把 TerminalView 内部状态外泄，采用**回调注入**：给 `TerminalView` 增加一个 `renderAgentSlot?: (ctx: AgentPaneDeps) => AgentSlot` prop，让 TerminalView 在自己算好 deps 后回调构造 slot。

先在此文件写 host：

```tsx
import type { AgentSlot } from "@/app/term/render/agent-pane";

const AgentSurfaceHost: React.FC<{ blockId: string; fontSize: number; focusRequest: number }> = ({
    blockId,
    fontSize,
    focusRequest,
}) => {
    const renderAgentSlot = (ctx: AgentPaneDeps): AgentSlot => {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        return useAgentPane(blockId, ctx.model, ctx);
    };
    return (
        <TerminalView
            outerBlockId={blockId}
            fontSize={fontSize}
            focusRequest={focusRequest}
            renderAgentSlot={renderAgentSlot}
        />
    );
};
AgentSurfaceHost.displayName = "AgentSurfaceHost";
```

> 这引入了 `renderAgentSlot` prop 与 deps 里需带 `model`。下一步在 TerminalView + AgentPaneDeps 里落实，保证 hook 在 TerminalView 组件体内调用（合法）。

- [ ] **Step 3: 在 AgentPaneDeps 增加 model 字段**

编辑 `agent-pane.tsx` 的 `AgentPaneDeps`，在开头加：

```ts
    model: TerminalModel;
```

并把 `useAgentPane(outerBlockId, model, deps)` 保持签名不变（model 也在 deps 里，二者一致；host 传 `ctx.model`）。

- [ ] **Step 4: 在 TerminalView 落实 renderAgentSlot**

编辑 `terminal-view.tsx`：
1. `TerminalViewProps` 增加：

```ts
    // Agent 会话形态用此回调构造 slot —— TerminalView 在算好实时上下文
    // (cwd/branch/inputMode/…) 后调用，交给 useAgentPane 生成 AgentSlot。
    // 纯终端形态不传此 prop，agentSlot 保持 null。
    renderAgentSlot?: (deps: import("./agent-pane").AgentPaneDeps) => import("./agent-pane").AgentSlot;
```

2. 在组件体内（`onSubmit` 定义之后、`return` 之前）计算 slot：

```tsx
        const agentSlot = renderAgentSlot
            ? renderAgentSlot({
                  model,
                  fontSize,
                  focusRequest,
                  liveCwd,
                  home,
                  branch: liveBlock?.gitBranch || chipValues.gitBranch,
                  gitAdded: liveBlock?.gitDiffAdded ?? chipValues.gitDiffAdded,
                  gitRemoved: liveBlock?.gitDiffRemoved ?? chipValues.gitDiffRemoved,
                  prNumber: chipValues.prNumber,
                  prTitle: chipValues.prTitle,
                  kubernetesContext: chipValues.kubernetesContext,
                  sshHost,
                  sshUser,
                  workspaceDir,
                  liveGitBranch: liveBlock?.gitBranch ?? chipValues.gitBranch,
                  recentCmds,
                  liveConnection,
                  commandHistory,
                  inputMode,
                  effectiveMode,
                  onModeChange: setInputMode,
                  onInputTextChange,
                  isRunning,
                  inAltScreen,
              })
            : null;
```

3. 把 Task 1 加的 `agentSlot?` prop 从 props 列表移除（改为内部计算），或保留 props 版本作为覆盖。**统一为内部计算**：从 `TerminalViewProps` 删掉 Task 1 的 `agentSlot` 字段，改用上面 `renderAgentSlot`。JSX 中 `agentSlot?.xxx` 引用保持不变（现在指向本地变量）。

> 说明：`renderAgentSlot` 内部调用 `useAgentPane`（含多个 hooks）。因为 `renderAgentSlot` 在 `TerminalView` 组件体同步执行且调用顺序稳定（纯终端始终不传→始终 0 个；agent 始终传→始终固定数量），符合 hooks 规则。为消除 lint 噪音，在 `renderAgentSlot` 定义处（agent-model.tsx）已加 eslint-disable。

- [ ] **Step 5: 注册到 blockregistry**

编辑 `frontend/app/block/blockregistry.ts`：

```ts
import { AgentViewModel } from "@/app/view/agentblock/agent-model";
```

在 `BlockRegistry.set("term", TermViewModel);` 之后加：

```ts
BlockRegistry.set("agent", AgentViewModel);
```

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "agent-model|agent-pane|terminal-view|blockregistry"`
Expected: 无相关错误

- [ ] **Step 7: 提交**

```bash
git add frontend/app/view/agentblock/agent-model.tsx frontend/app/block/blockregistry.ts frontend/app/term/render/agent-pane.tsx frontend/app/term/render/terminal-view.tsx
git commit -m "feat(agent): add AgentViewModel and view:agent registration"
```

---

## Task 7: blockutil 图标/名称支持 agent

**Files:**
- Modify: `frontend/app/block/blockutil.tsx`

- [ ] **Step 1: 加 agent 分支**

在 `blockViewToIcon`（L27）的 `if (view == "term")` 之后加：

```ts
    if (view == "agent") {
        return "sparkles";
    }
```

在 `blockViewToName`（L49）的 `if (view == "term")` 之后加：

```ts
    if (view == "agent") {
        return "Agent";
    }
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep blockutil`
Expected: 无相关错误

- [ ] **Step 3: 提交**

```bash
git add frontend/app/block/blockutil.tsx
git commit -m "feat(agent): map view:agent to sparkles icon and Agent name"
```

---

## Task 8: 后端 launcher widget + 默认新 tab 改为 agent

**Files:**
- Modify: `pkg/wconfig/defaultconfig/widgets.json`
- Modify: `pkg/wcore/layout.go`

- [ ] **Step 1: 新增 agent widget**

编辑 `pkg/wconfig/defaultconfig/widgets.json`，在 `defwidget@terminal` 之前插入（`display:order` 更小 → 更靠前）：

```json
    "defwidget@agent": {
        "display:order": -6,
        "icon": "sparkles",
        "label": "agent",
        "blockdef": {
            "meta": {
                "view": "agent",
                "controller": "shell"
            }
        }
    },
```

- [ ] **Step 2: 新 tab 默认 view 改为 agent**

编辑 `pkg/wcore/layout.go` 的 `GetNewTabLayout`（L63-79），把 `MetaKey_View` 值从 `"termblocks"` 改为 `"agent"`：

```go
	termMeta := waveobj.MetaMapType{
		waveobj.MetaKey_View:       "agent",
		waveobj.MetaKey_Controller: "shell",
	}
```

> 保留 `controller: "shell"`：agent 内嵌 shell 命令需要真实 PTY。变量名 `termMeta` 可保持不变（局部命名，无外部依赖）。

- [ ] **Step 3: 构建后端确认编译**

Run: `go build ./pkg/wcore/... ./pkg/wconfig/...`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add pkg/wconfig/defaultconfig/widgets.json pkg/wcore/layout.go
git commit -m "feat(agent): add agent launcher widget and default new tabs to agent"
```

---

## Task 9: 全量验证

**Files:** 无（验证任务）

- [ ] **Step 1: 前端相关测试**

Run: `npx vitest run frontend/app/term/render/ frontend/app/view/term/`
Expected: 全部 PASS（含 terminal-view-tui / agent-pane / term-focus）

- [ ] **Step 2: 全量类型检查（对比基线）**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "wave.ts"`
Expected: 无新增错误（`frontend/wave.ts` 的 3 个 `Client does not satisfy WaveObj` 是既存无关错误）

- [ ] **Step 3: 后端构建**

Run: `go build ./...`
Expected: 无错误

- [ ] **Step 4: 手动冒烟（可选，需运行 app）**

启动后验证：
1. 新 tab 默认是 agent 会话 block（有输入栏 agent/auto 切换 + model chip）。
2. launcher 菜单出现 "agent" 图标，点击创建 agent block。
3. launcher "terminal" 创建纯终端 block —— 无 agent 输入模式切换、无 activity bar。
4. 纯终端里跑 `vim` 进 alt-screen 正常；agent 里 `!ls` 内嵌 shell 结果正常。

---

## Self-Review 结论

- **Spec 覆盖**：§4 架构（Task 2/3/6）、§5 组件拆分（Task 2/3）、§6 ViewModel 注册（Task 6/7）、§7 入口与默认（Task 8）、§8 后端零改动（Task 8 仅配置）、§9 测试（Task 4/5/9）—— 全部有对应任务。
- **形态固定不切换**：无运行时切换代码，符合 §3。
- **类型一致性**：`AgentSlot` / `AgentPaneDeps`（含 `model`）/ `useAgentPane` 签名 / `renderAgentSlot` 回调在 Task 2/3/6 间保持一致。
- **无占位符**：所有步骤给出完整代码与命令。
