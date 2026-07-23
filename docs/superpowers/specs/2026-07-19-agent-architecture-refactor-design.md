# Agent 架构去 Pane 化重构设计

> `WorkspaceAgentSurface -> AgentRuntimeRegistry -> AgentSessionRuntime` 仍然有效；其中 backing block 兼容阶段已被 [`2026-07-23-workspace-surface-tab-architecture-design.md`](./2026-07-23-workspace-surface-tab-architecture-design.md) 取代。新架构直接移除 hidden Agent Tab 和 backing Block。

- 状态: 已确认
- 日期: 2026-07-19
- 决策页面: [`docs/agent-architecture-refactor.html`](../../agent-architecture-refactor.html)
- 适用范围: Agent 固定入口、renderer Agent surface、Electron main session runtime、runtime lifecycle

## 1. 决策

Crest Agent 架构需要去 Pane 化，但不需要重写 Session Runtime。

本次重构采用以下目标模型:

```text
WorkspaceAgentSurface
        |
        | activeSessionPath + IPC
        v
AgentRuntimeRegistry
        |
        +-- AgentSessionRuntime(session A)
        +-- AgentSessionRuntime(session B)
        +-- AgentSessionRuntime(session C)
        |
        v
Session Repository
```

核心决策:

1. `session path` 是 session runtime 的稳定身份。
2. React surface 只管理当前可见会话和临时 UI 状态，不拥有执行生命周期。
3. Electron main 的 Registry 管理 runtime 创建、配置同步、订阅、后台运行和回收。
4. Session Runtime 继续拥有 transcript、turn、queue、status、Harness、extensions 和事件扇出。
5. hidden backing block 暂时保留，只作为 `TerminalModel`、PTY 和 block-scoped tool context 的兼容载体。
6. Phase 4 之前不移除 backing block，不重写 `AgentHarness`。

## 2. 当前问题

### 2.1 `PaneAgentSession` 的名称与身份不一致

`PaneAgentSession` 被 `sessionCache: Map<sessionPath, PaneAgentSession>` 按 session path 唯一缓存。它不按 pane 创建，也不随 React pane 卸载释放。

它实际拥有:

- persisted transcript 的内存镜像;
- `AgentTurn[]`;
- steer/follow-up queue;
- streaming/error/idle status;
- `AgentHarness`;
- session tree 操作;
- subscriber fan-out;
- extension runtime 和交互式 UI request 生命周期。

因此它的正确名称是 `AgentSessionRuntime`。

### 2.2 `AgentPane` 是过渡性装配协议

`useAgentPane` 仍接受 24 个 `AgentPaneDeps` 字段，但当前只读取:

- `workspaceDir`;
- `liveGitBranch`;
- `recentCmds`;
- `liveConnection`;
- `inAltScreen`.

`AgentSlot` 的 `commandResults`、`inputBar` 和 `replacesBlockList` 已退化为常量协议。当前 Agent 内容已经完整替换 terminal block list，因此不再需要为旧的混排形态保留这些字段。

Renderer 应收敛为 `WorkspaceAgentSurface`，并使用最小的 `AgentSurfaceContext`。

### 2.3 Runtime 没有生产回收策略

当前 `sessionCache` 只在 test reset 时整体清空。生产环境不存在:

- idle eviction;
- subscriber reference tracking;
- background-running protection;
- per-runtime dispose;
- stale extension lifecycle cleanup.

切换过的会话会一直留在 Electron main 进程中。

### 2.4 已缓存 runtime 不同步执行配置

已有 session 再发送时只调用 `PaneAgentSession.update(SystemPromptInputs)`。该调用只更新 cwd/system prompt context，没有同步:

- model;
- reasoning level;
- credentials resolver;
- tool allowlist;
- extension/resource configuration.

`AgentHarness` 已提供 `setModel()` 和 `setThinkingLevel()`，Registry 应在每次 send 前统一同步。

### 2.5 Workspace 状态仍借用 block meta

固定 Agent Tab 已经是 workspace 级产品入口，但 active session 和 model selection 仍由 hidden block 的:

- `agent:session`;
- `agent:selection`

持久化。短期保留这些字段作为兼容镜像，长期由 workspace-level Agent model 成为 SSoT。

## 3. 目标组件

### 3.1 `WorkspaceAgentSurface`

Renderer 中唯一的 Agent 可见 surface。

职责:

- 读取和切换 `activeSessionPath`;
- 挂载 assistant-ui runtime;
- 展示 composer、session selector、model picker、extension UI 和 queue;
- 订阅当前 session runtime;
- 将用户操作发送到 Agent IPC client;
- 保存纯 UI 临时状态。

不负责:

- 持有 `AgentHarness`;
- 决定 runtime 是否释放;
- 保证后台任务继续运行;
- 缓存多个 session 的完整 runtime state.

### 3.2 `AgentRuntimeClient`

Renderer 的 typed IPC adapter。它替代 `AgentChatHost` 中分散的 `window.api.agent.*` 访问。

最小接口:

```ts
interface AgentRuntimeClient {
    getSessionState(metadata: AgentSessionMeta): Promise<PiAgentEvent>
    subscribe(sessionPath: string, listener: (event: PiAgentEvent) => void): () => void
    send(input: AgentSendOptions): Promise<{ sessionMetadata: AgentSessionMeta; turnId: string }>
    abort(sessionPath: string): void
}
```

命令、tree、fork、clone、extension UI 等接口继续存在，但从 surface 中通过 client 调用。

### 3.3 `AgentRuntimeRegistry`

Electron main 的 process-level runtime owner。

最小接口:

```ts
interface AgentRuntimeRegistry {
    get(sessionPath: string): AgentSessionRuntime | undefined
    getOrCreate(input: AgentRuntimeCreateInput): Promise<AgentSessionRuntime>
    acquire(sessionPath: string, subscriberKey: string): void
    release(sessionPath: string, subscriberKey: string): void
    evictIdle(now?: number): string[]
    disposeAll(): void
}
```

每个 registry entry 记录:

```ts
interface AgentRuntimeEntry {
    runtime: AgentSessionRuntime
    subscriberKeys: Set<string>
    lastUsedAt: number
}
```

回收规则:

1. `runtime.isRunning()` 为 true 时禁止回收。
2. 有 subscriber 时禁止回收。
3. 无 subscriber 且 idle 超过 TTL 时允许回收。
4. app shutdown/test reset 调用 `disposeAll()`。
5. runtime 被重新 acquire/send 时更新 `lastUsedAt`。

### 3.4 `AgentSessionRuntime`

由现有 `PaneAgentSession` 重命名而来，保持其 owner 语义。

必须保留:

- `messages`, `turns`, queue 和 status;
- `send`, `abort`, `compact`, tree navigation;
- `subscribe` 和 snapshot;
- turn completion hooks;
- extension commands、flags、widget/UI requests;
- observability 所需的 canonical event stream.

新增:

```ts
isRunning(): boolean
syncExecutionConfig(input: AgentExecutionConfig): Promise<void>
```

`syncExecutionConfig` 必须在 send 前完成，且只在实际值变化时调用 Harness setter。

### 3.5 `AgentHarnessHost`

由现有 `PaneHarness` 重命名而来。

它仍是轻量 adapter，只提供:

- `AgentHarness`;
- persisted `Session`;
- mutable execution context;
- extension runtime/context;
- prompt/system resource wiring.

它不重新实现 Harness 的 prompt、queue、subscribe 或 storage。

## 4. 数据和状态所有权

| 状态 | 唯一所有者 | 持久化 |
| --- | --- | --- |
| Session transcript/tree | Session Repository | SQLite session DB |
| Live turns/queue/status | `AgentSessionRuntime` | 可由 session 重建 |
| Runtime cache/lifecycle | `AgentRuntimeRegistry` | 不持久化 |
| Active session | Workspace Agent model | Workspace meta |
| Model selection | Workspace Agent model | Workspace meta |
| Composer focus/picker/open panel | `WorkspaceAgentSurface` | 不持久化 |
| PTY/block tool target | Backing block compatibility context | WStore/block |
| Observability traces | Observability store | `traces.db` |

迁移期间:

- workspace Agent model 写入 active session/selection;
- 同时镜像到 backing block 的 `agent:session`/`agent:selection`;
- 读取时 workspace meta 优先，block meta 仅作旧数据 fallback;
- Phase 3 完成后禁止其他模块直接把 block meta 当 Agent SSoT。

## 5. Send 数据流

```text
WorkspaceAgentSurface.submit(text)
  -> AgentRuntimeClient.send(...)
  -> AgentRuntimeRegistry.getOrCreate(sessionPath)
  -> AgentSessionRuntime.syncExecutionConfig(input)
  -> AgentSessionRuntime.send(text)
  -> AgentHarness.prompt/followUp
  -> AgentSessionRuntime updates owned state
  -> Registry subscribers receive event/snapshot
  -> WorkspaceAgentSurface mirrors into assistant-ui
```

切换 session:

```text
Session List select B
  -> workspace activeSessionPath = B
  -> Surface unsubscribe A
  -> Registry.release(A, rendererKey)
  -> Surface subscribe B
  -> Registry.acquire(B, rendererKey)
  -> snapshot B
```

A 如果仍在 running，继续后台执行; A 如果 idle 且超过 TTL，可由 Registry 回收。

## 6. 与活跃功能分支的兼容

### 6.1 `agent-extension-integration`

Extension runtime、commands、flags、ctx.ui requests 和 widget events 必须归属 `AgentSessionRuntime`。

迁移约束:

- 不把 extension lifecycle 放回 React surface;
- `ExtensionUiBridge.attach()` 的 host 改为 `AgentSessionRuntime`;
- Registry dispose runtime 时必须释放 extension lifecycle 和 pending UI requests;
- background runtime 的 extension UI event 可以继续产生，由当前 subscriber 决定是否显示。

### 6.2 `agent-observability-langfuse`

Observability 必须以 session path/turn 为稳定身份，不依赖 pane/block 可见性。

迁移约束:

- canonical trace 采集接入 `AgentSessionRuntime` 或其底层 Harness event bus;
- Registry dispose 不能丢失已完成 trace;
- background runtime 继续被采集;
- UI observability panel 与 active Agent surface 解耦。

## 7. 分阶段实施

### Phase 1: 命名和 Surface 协议收敛

- `PaneAgentSession` -> `AgentSessionRuntime`;
- `PaneHarness` -> `AgentHarnessHost`;
- `AgentPane`/`useAgentPane` -> `WorkspaceAgentSurface`/`useAgentSurface`;
- 删除退化的 `AgentSlot` 字段;
- 将 `AgentPaneDeps` 收敛为最小 context;
- 行为保持不变。

### Phase 2: Runtime Registry

- 新增 `AgentRuntimeRegistry`;
- 替换 `sessionCache`;
- 添加 acquire/release/TTL eviction;
- send 前同步 execution config;
- app shutdown/test reset 完整 dispose.

### Phase 3: Workspace Agent SSoT

- 新增 workspace-level active session/selection atoms;
- Session List 和 fixed Agent entry 只调用 workspace Agent model;
- backing block meta 作为兼容镜像;
- renderer surface 与 tab/block identity 解耦。

### Phase 4: Backing block 评估

只有满足以下条件才移除 backing block:

- `AgentExecutionContext` 可独立提供 workspace cwd、connection 和 tool target;
- shell/PTY 工具有非 block 宿主;
- focus、restart restore、extension UI 和 terminal embedding 均有替代实现;
- Phase 1-3 已稳定。

Phase 4 不属于当前实现计划。

## 8. 错误处理

- Registry create 失败不写入半初始化 entry。
- Config sync 失败时不调用 `send()`，错误返回 renderer。
- Runtime dispose 必须 reject pending send 和 extension UI request。
- Registry eviction 对 dispose error 做日志记录并继续处理其他 entry。
- Session path 始终经过现有 canonical path validation。
- 同一 session path 的并发 get-or-create 必须共享同一个 pending promise，禁止创建两个 Harness。

## 9. 测试策略

### Unit

- `AgentRuntimeRegistry`: reuse、concurrent create、acquire/release、running protection、TTL eviction、disposeAll。
- `AgentSessionRuntime`: config sync、send routing、dispose、extension lifecycle。
- Surface context: 只暴露 5 个实际依赖，不重新引入 TerminalView 全量状态。

### Integration

- IPC send 通过 Registry 获取 runtime。
- 切换 active session 不 abort 旧 runtime。
- model/reasoning 切换在下一次 send 前到达 Harness。
- extension UI 和 observability 在 background runtime 中继续收到事件。

### Regression

- fixed Agent Tab 仍只有一个可见入口;
- Session List 点击切换会话;
- starter backing Agent tab 不出现在普通 tab strip;
- ordinary new tab 仍为 `termblocks`;
- existing agent session/tree/command tests 全部通过。

## 10. 完成标准

Phase 1-3 完成时:

1. 生产代码不存在 `PaneAgentSession`、`PaneHarness`、`AgentPaneDeps` 命名。
2. `sessionCache` 被 `AgentRuntimeRegistry` 替代。
3. 每次 send 前完成 execution config sync。
4. runtime 有明确 acquire/release/eviction/dispose 生命周期。
5. active session 和 selection 的 SSoT 位于 workspace Agent model。
6. hidden backing block 只承担文档列出的兼容职责。
7. extension 与 observability 分支功能通过迁移测试。
8. 针对性 Vitest、ESLint、TypeScript 检查通过。
