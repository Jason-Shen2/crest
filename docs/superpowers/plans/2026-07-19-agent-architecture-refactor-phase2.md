# Agent Runtime Registry Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unbounded session runtime Map with a lifecycle-aware Registry and guarantee that every send uses the current execution configuration.

**Architecture:** A process-level `AgentRuntimeRegistry` deduplicates concurrent runtime creation, tracks renderer subscribers, protects running runtimes, and evicts idle unreferenced runtimes. `AgentSessionRuntime.sendWithExecutionConfig()` serializes config application with send dispatch; `AgentHarnessHost` uses mutable auth and permission-hook closures so credentials and policy can change without rebuilding the Harness.

**Tech Stack:** TypeScript, Electron main process, AgentHarness, Vitest, Node 22 `node:sqlite`

---

## File Map

- Create `emain/agent/agent-runtime-registry.ts`
  - Generic lifecycle-aware registry for `AgentSessionRuntime`.
- Create `emain/agent/agent-runtime-registry.test.ts`
  - Covers reuse, concurrent creation, failure cleanup, acquire/release, running protection, TTL eviction and disposal.
- Modify `emain/agent/harness/agent-harness.ts`
  - Expose read-only `isIdle()`.
- Modify `emain/agent/harness/agent-harness.test.ts`
  - Prove idle state transitions.
- Modify `emain/agent/harness-factory.ts`
  - Add mutable auth resolver and tool hook setters to `AgentHarnessHost`.
- Create `emain/agent/harness-factory.test.ts`
  - Prove auth and permission closures update without rebuilding the Harness.
- Modify `emain/agent/agent-session-runtime.ts`
  - Add `isRunning`, execution config synchronization, and atomic configured send.
- Modify `emain/agent/agent-session-runtime.test.ts`
  - Prove changed config is applied once and concurrent configured sends do not cross models.
- Modify `emain/agent-ipc.ts`
  - Replace `sessionCache`, integrate Registry acquire/release, start idle sweep, and route sends through configured runtime operations.
- Modify `emain/agent-ipc.test.ts`
  - Prove one runtime is built for concurrent sends and current config reaches the runtime.

---

### Task 1: Implement AgentRuntimeRegistry

**Files:**
- Create: `emain/agent/agent-runtime-registry.ts`
- Create: `emain/agent/agent-runtime-registry.test.ts`

- [ ] **Step 1: Write failing Registry lifecycle tests**

Create `emain/agent/agent-runtime-registry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { AgentRuntimeRegistry } from "./agent-runtime-registry"

function makeRuntime(running = false) {
    return {
        isRunning: vi.fn(() => running),
        dispose: vi.fn(),
    }
}

describe("AgentRuntimeRegistry", () => {
    it("deduplicates concurrent runtime creation by session path", async () => {
        let resolve!: (runtime: ReturnType<typeof makeRuntime>) => void
        const runtime = makeRuntime()
        const create = vi.fn(() => new Promise<ReturnType<typeof makeRuntime>>((r) => (resolve = r)))
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => 0 })

        const first = registry.getOrCreate("/a.db", create)
        const second = registry.getOrCreate("/a.db", create)
        resolve(runtime)

        await expect(first).resolves.toBe(runtime)
        await expect(second).resolves.toBe(runtime)
        expect(create).toHaveBeenCalledTimes(1)
    })

    it("does not retain a failed creation promise", async () => {
        const runtime = makeRuntime()
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => 0 })

        await expect(registry.getOrCreate("/a.db", async () => {
            throw new Error("create failed")
        })).rejects.toThrow("create failed")

        await expect(registry.getOrCreate("/a.db", async () => runtime)).resolves.toBe(runtime)
    })

    it("evicts only idle unreferenced runtimes after the TTL", async () => {
        let now = 0
        const idle = makeRuntime(false)
        const running = makeRuntime(true)
        const subscribed = makeRuntime(false)
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now })
        await registry.getOrCreate("/idle.db", async () => idle)
        await registry.getOrCreate("/running.db", async () => running)
        await registry.getOrCreate("/subscribed.db", async () => subscribed)
        registry.acquire("/subscribed.db", "renderer:1")
        now = 101

        expect(registry.evictIdle()).toEqual(["/idle.db"])
        expect(idle.dispose).toHaveBeenCalledOnce()
        expect(running.dispose).not.toHaveBeenCalled()
        expect(subscribed.dispose).not.toHaveBeenCalled()
    })

    it("touches an entry when its last subscriber releases it", async () => {
        let now = 0
        const runtime = makeRuntime(false)
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100, now: () => now })
        await registry.getOrCreate("/a.db", async () => runtime)
        registry.acquire("/a.db", "renderer:1")
        now = 80
        registry.release("/a.db", "renderer:1")
        now = 150
        expect(registry.evictIdle()).toEqual([])
        now = 181
        expect(registry.evictIdle()).toEqual(["/a.db"])
    })

    it("disposes every runtime during shutdown", async () => {
        const first = makeRuntime()
        const second = makeRuntime()
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 })
        await registry.getOrCreate("/a.db", async () => first)
        await registry.getOrCreate("/b.db", async () => second)

        registry.disposeAll()

        expect(first.dispose).toHaveBeenCalledOnce()
        expect(second.dispose).toHaveBeenCalledOnce()
        expect(registry.get("/a.db")).toBeUndefined()
    })
})
```

- [ ] **Step 2: Run tests and verify RED**

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx vitest run emain/agent/agent-runtime-registry.test.ts
```

Expected: FAIL because `agent-runtime-registry.ts` does not exist.

- [ ] **Step 3: Implement the minimal Registry**

Create `emain/agent/agent-runtime-registry.ts`:

```ts
export interface ManagedAgentRuntime {
    isRunning(): boolean
    dispose(): void
}

interface AgentRuntimeEntry<TRuntime extends ManagedAgentRuntime> {
    runtime: TRuntime
    subscriberKeys: Set<string>
    lastUsedAt: number
}

export interface AgentRuntimeRegistryOptions {
    idleTtlMs: number
    now?: () => number
}

export class AgentRuntimeRegistry<TRuntime extends ManagedAgentRuntime> {
    entries = new Map<string, AgentRuntimeEntry<TRuntime>>()
    pendingCreates = new Map<string, Promise<TRuntime>>()
    idleTtlMs: number
    now: () => number

    constructor(options: AgentRuntimeRegistryOptions) {
        this.idleTtlMs = options.idleTtlMs
        this.now = options.now ?? Date.now
    }

    get(path: string): TRuntime | undefined {
        const entry = this.entries.get(path)
        if (!entry) return undefined
        entry.lastUsedAt = this.now()
        return entry.runtime
    }

    async getOrCreate(path: string, create: () => Promise<TRuntime>): Promise<TRuntime> {
        const existing = this.get(path)
        if (existing) return existing
        const pending = this.pendingCreates.get(path)
        if (pending) return pending
        const creation = create()
            .then((runtime) => {
                this.entries.set(path, {
                    runtime,
                    subscriberKeys: new Set(),
                    lastUsedAt: this.now(),
                })
                return runtime
            })
            .finally(() => this.pendingCreates.delete(path))
        this.pendingCreates.set(path, creation)
        return creation
    }

    acquire(path: string, subscriberKey: string): void {
        const entry = this.entries.get(path)
        if (!entry) return
        entry.subscriberKeys.add(subscriberKey)
        entry.lastUsedAt = this.now()
    }

    release(path: string, subscriberKey: string): void {
        const entry = this.entries.get(path)
        if (!entry) return
        entry.subscriberKeys.delete(subscriberKey)
        entry.lastUsedAt = this.now()
    }

    evictIdle(now = this.now()): string[] {
        const evicted: string[] = []
        for (const [path, entry] of this.entries) {
            if (entry.subscriberKeys.size > 0) continue
            if (entry.runtime.isRunning()) continue
            if (now - entry.lastUsedAt < this.idleTtlMs) continue
            entry.runtime.dispose()
            this.entries.delete(path)
            evicted.push(path)
        }
        return evicted
    }

    disposeAll(): void {
        for (const entry of this.entries.values()) entry.runtime.dispose()
        this.entries.clear()
        this.pendingCreates.clear()
    }
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run the command from Step 2.

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add emain/agent/agent-runtime-registry.ts emain/agent/agent-runtime-registry.test.ts
git commit -m "feat(agent): add runtime registry"
```

---

### Task 2: Expose Harness Idle State

**Files:**
- Modify: `emain/agent/harness/agent-harness.ts`
- Modify: `emain/agent/harness/agent-harness.test.ts`
- Modify: `emain/agent/agent-session-runtime.ts`
- Modify: `emain/agent/agent-session-runtime.test.ts`

- [ ] **Step 1: Write failing idle-state tests**

Add to `emain/agent/harness/agent-harness.test.ts`:

```ts
describe("AgentHarness — lifecycle state", () => {
    it("reports idle before and after a prompt", async () => {
        const { harness } = await buildHarness()
        expect(harness.isIdle()).toBe(true)
        const prompt = harness.prompt("hello")
        expect(harness.isIdle()).toBe(false)
        await prompt
        expect(harness.isIdle()).toBe(true)
    })
})
```

Add to `emain/agent/agent-session-runtime.test.ts`:

```ts
it("reports running from the Harness lifecycle", () => {
    const fake = makeFakeHarness()
    fake.pane.harness.isIdle = vi.fn(() => false)
    const runtime = new AgentSessionRuntime("/s", fake.pane)
    expect(runtime.isRunning()).toBe(true)
})
```

- [ ] **Step 2: Run tests and verify RED**

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx vitest run \
    emain/agent/harness/agent-harness.test.ts \
    emain/agent/agent-session-runtime.test.ts \
    -t "lifecycle state|reports running"
```

Expected: FAIL because `isIdle` and `isRunning` do not exist.

- [ ] **Step 3: Implement lifecycle readers**

In `AgentHarness`:

```ts
isIdle(): boolean {
    return this.phase === "idle"
}
```

In `AgentSessionRuntime`:

```ts
isRunning(): boolean {
    return !this.host.harness.isIdle()
}
```

Update the fake Harness with `isIdle: vi.fn(() => true)`.

- [ ] **Step 4: Run complete Harness/runtime tests**

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx vitest run \
    emain/agent/harness/agent-harness.test.ts \
    emain/agent/agent-session-runtime.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add emain/agent/harness/agent-harness.ts emain/agent/harness/agent-harness.test.ts emain/agent/agent-session-runtime.ts emain/agent/agent-session-runtime.test.ts
git commit -m "feat(agent): expose runtime lifecycle state"
```

---

### Task 3: Add Mutable Execution Configuration

**Files:**
- Modify: `emain/agent/harness-factory.ts`
- Create: `emain/agent/harness-factory.test.ts`
- Modify: `emain/agent/agent-session-runtime.ts`
- Modify: `emain/agent/agent-session-runtime.test.ts`

- [ ] **Step 1: Write failing Host closure test**

Create `emain/agent/harness-factory.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import type { Model } from "../ai"
import { InMemorySessionRepo } from "./harness/session/memory-repo"
import type { ToolCallEvent } from "./harness/types"
import { buildAgentHarnessHost } from "./harness-factory"

function fakeModel(): Model<any> {
    return {
        id: "model-1",
        name: "Model 1",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "http://localhost",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 1000,
    }
}

it("updates auth and tool hooks without rebuilding the Harness", async () => {
    const session = await new InMemorySessionRepo().create({})
    const model = fakeModel()
    const toolEvent: ToolCallEvent = {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "bash",
        input: {},
    }
    const firstAuth = vi.fn(async () => ({ apiKey: "first" }))
    const secondAuth = vi.fn(async () => ({ apiKey: "second" }))
    const firstHook = vi.fn(async () => undefined)
    const secondHook = vi.fn(async () => ({ block: true, reason: "blocked" }))
    const host = buildAgentHarnessHost({
        session,
        model,
        promptInputs: { cwd: "/a" },
        getApiKeyAndHeaders: firstAuth,
        toolCallHook: firstHook,
    })

    host.setAuthResolver(secondAuth)
    host.setToolCallHook(secondHook)

    await expect(host.resolveAuth(model)).resolves.toEqual({ apiKey: "second" })
    await expect(host.runToolCallHook(toolEvent)).resolves.toEqual({ block: true, reason: "blocked" })
    expect(firstAuth).not.toHaveBeenCalled()
    expect(firstHook).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run test and verify RED**

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx vitest run emain/agent/harness-factory.test.ts
```

Expected: FAIL because Host mutation methods do not exist.

- [ ] **Step 3: Implement mutable closures**

Export:

```ts
export type AgentAuthResolver = (
    model: Model<Api>
) => Promise<{ apiKey: string; headers?: Record<string, string> } | undefined>
```

Extend `AgentHarnessHost`:

```ts
setAuthResolver(resolver?: AgentAuthResolver): void
setToolCallHook(hook?: ToolCallHook): void
resolveAuth(model: Model<Api>): ReturnType<AgentAuthResolver>
runToolCallHook(event: ToolCallEvent): ReturnType<ToolCallHook>
```

Inside `buildAgentHarnessHost`, keep mutable `authResolver` and `toolCallHook`, pass stable delegating closures to `AgentHarness`, and always register one stable `tool_call` handler.

- [ ] **Step 4: Write failing runtime configured-send tests**

In `makeFakeHarness`, add:

```ts
const model = {
    id: "model-1",
    name: "Model 1",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "http://localhost",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
} as Model<any>
let currentModel = model
let thinkingLevel: ThinkingLevel = "off"

Object.assign(harness, {
    isIdle: vi.fn(() => true),
    getModel: vi.fn(() => currentModel),
    setModel: vi.fn(async (next: Model<any>) => {
        currentModel = next
    }),
    getThinkingLevel: vi.fn(() => thinkingLevel),
    setThinkingLevel: vi.fn(async (next: ThinkingLevel) => {
        thinkingLevel = next
    }),
})
```

Extend the returned `pane` Host:

```ts
setAuthResolver: vi.fn(),
setToolCallHook: vi.fn(),
resolveAuth: vi.fn(),
runToolCallHook: vi.fn(),
```

Return `model` beside `pane` from `makeFakeHarness` so the test can construct `nextModel`.

Add the runtime test:

```ts
it("applies changed execution config before sending", async () => {
    const fake = makeFakeHarness()
    const runtime = new AgentSessionRuntime("/s", fake.pane)
    const nextModel = { ...fake.model, id: "next-model" }
    const send = vi.spyOn(runtime, "send").mockResolvedValue("entry-1")

    await runtime.sendWithExecutionConfig("hello", {
        promptInputs: { cwd: "/next" },
        model: nextModel,
        thinkingLevel: "high",
        authResolver: vi.fn(),
        toolCallHook: vi.fn(),
    })

    expect(fake.pane.update).toHaveBeenCalledWith({ cwd: "/next" })
    expect(fake.pane.harness.setModel).toHaveBeenCalledWith(nextModel)
    expect(fake.pane.harness.setThinkingLevel).toHaveBeenCalledWith("high")
    expect(send).toHaveBeenCalledWith("hello")
})
```

- [ ] **Step 5: Run runtime test and verify RED**

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx vitest run emain/agent/agent-session-runtime.test.ts -t "execution config"
```

Expected: FAIL because `sendWithExecutionConfig` does not exist.

- [ ] **Step 6: Implement atomic configured send**

Add `AgentExecutionConfig` and a promise queue:

```ts
export interface AgentExecutionConfig {
    promptInputs: SystemPromptInputs
    model: Model<Api>
    thinkingLevel: ThinkingLevel
    authResolver?: AgentAuthResolver
    toolCallHook?: ToolCallHook
}

configQueue = Promise.resolve()

sendWithExecutionConfig(text: string, config: AgentExecutionConfig): Promise<string> {
    const operation = this.configQueue.then(async () => {
        await this.syncExecutionConfig(config)
        return this.send(text)
    })
    this.configQueue = operation.then(() => undefined, () => undefined)
    return operation
}
```

Implement:

```ts
async syncExecutionConfig(config: AgentExecutionConfig): Promise<void> {
    this.host.update(config.promptInputs)
    this.host.setAuthResolver(config.authResolver)
    this.host.setToolCallHook(config.toolCallHook)
    const currentModel = this.host.harness.getModel()
    const sameModel =
        currentModel.provider === config.model.provider &&
        currentModel.id === config.model.id &&
        currentModel.api === config.model.api &&
        currentModel.baseUrl === config.model.baseUrl
    if (!sameModel) await this.host.harness.setModel(config.model)
    if (this.host.harness.getThinkingLevel() !== config.thinkingLevel) {
        await this.host.harness.setThinkingLevel(config.thinkingLevel)
    }
}
```

- [ ] **Step 7: Run Host/runtime tests and verify GREEN**

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx vitest run \
    emain/agent/harness-factory.test.ts \
    emain/agent/agent-session-runtime.test.ts
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add emain/agent/harness-factory.ts emain/agent/harness-factory.test.ts emain/agent/agent-session-runtime.ts emain/agent/agent-session-runtime.test.ts
git commit -m "feat(agent): sync runtime execution config"
```

---

### Task 4: Migrate Agent IPC to Registry

**Files:**
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`

- [ ] **Step 1: Write failing IPC reuse/config test**

Add a test named `"reuses one runtime and applies current execution config"` beside the existing `agent:send` test. Call the registered handler twice for the same metadata, change the mocked model from `m1` to `m2`, and spy on `AgentSessionRuntime.prototype.sendWithExecutionConfig`:

```ts
expect(buildAgentHarnessHost).toHaveBeenCalledTimes(1)
expect(sendConfiguredSpy).toHaveBeenNthCalledWith(
    2,
    "second",
    expect.objectContaining({
        model: expect.objectContaining({ id: "m2" }),
        thinkingLevel: "high",
        promptInputs: expect.objectContaining({ cwd: "/tmp/agent-ipc-send" }),
    })
)
```

- [ ] **Step 2: Run test and verify RED**

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx vitest run emain/agent-ipc.test.ts -t "reuses one runtime and applies current execution config"
```

Expected: FAIL because IPC still uses `sessionCache` and `send`.

- [ ] **Step 3: Replace sessionCache with Registry**

Add:

```ts
const AgentRuntimeIdleTtlMs = 5 * 60 * 1000
const AgentRuntimeSweepIntervalMs = 60 * 1000
const runtimeRegistry = new AgentRuntimeRegistry<AgentSessionRuntime>({
    idleTtlMs: AgentRuntimeIdleTtlMs,
})
```

Rename `ensurePaneSession` to `ensureAgentRuntime`. Extract the current runtime construction body into `createAgentRuntime(metadata, opts, config)`. Resolve model, auth, permissions and prompt inputs on every invocation:

```ts
async function ensureAgentRuntime(
    metadata: JsonlSessionMetadata,
    opts: SendOptions,
): Promise<{ runtime: AgentSessionRuntime; config: AgentExecutionConfig }> {
    const apiKey = await resolveApiKey(opts)
    const model = resolveModelOrThrow(opts.provider, opts.model)
    const config: AgentExecutionConfig = {
        promptInputs: buildPromptInputs(opts),
        model,
        thinkingLevel: opts.reasoning ?? "off",
        authResolver: apiKey == null ? undefined : async () => ({ apiKey }),
        toolCallHook: buildPermissionsHook(
            isBenchMode()
                ? { allowAll: true }
                : opts.allowedTools
                  ? { allowAll: false, allowedTools: opts.allowedTools }
                  : { allowAll: true },
        ),
    }
    const runtime = await runtimeRegistry.getOrCreate(
        metadata.path,
        () => createAgentRuntime(metadata, opts, config),
    )
    return { runtime, config }
}
```

`createAgentRuntime` opens the persisted session, loads skills/context files, creates default tools and `spawn_cli_agent`, calls `buildAgentHarnessHost` with `config`, seeds persisted messages/turns, constructs `AgentSessionRuntime`, attaches pending subscribers, and returns the runtime. It must not read `sessionCache`.

The send handler calls:

```ts
const { runtime, config } = await ensureAgentRuntime(metadata, opts)
const userEntryId = await runtime.sendWithExecutionConfig(opts.text, config)
```

Replace every `sessionCache.get()` with `runtimeRegistry.get()`.

- [ ] **Step 4: Integrate subscriber ownership**

Change subscription records to:

```ts
const subscriptions = new Map<SubKey, {
    unsubscribe: () => void
    sessionPath: string
}>()
```

After subscribing:

```ts
runtimeRegistry.acquire(sessionPath, key)
```

During release:

```ts
runtimeRegistry.release(record.sessionPath, key)
```

Pending subscriptions acquire only after attached to a live runtime.

- [ ] **Step 5: Add idle sweep lifecycle**

Start one unref'ed interval from `registerAgentIpcHandlers()` and clear it in `_resetAgentIpcForTests()`. The callback invokes `runtimeRegistry.evictIdle()`. Replace manual cache disposal in reset with `runtimeRegistry.disposeAll()`.

- [ ] **Step 6: Run IPC tests and verify GREEN**

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx vitest run emain/agent-ipc.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add emain/agent-ipc.ts emain/agent-ipc.test.ts
git commit -m "refactor(agent): manage runtimes through registry"
```

---

### Task 5: Phase 2 Verification

- [ ] **Step 1: Run Agent tests**

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx vitest run \
    emain/agent/agent-runtime-registry.test.ts \
    emain/agent/harness/agent-harness.test.ts \
    emain/agent/harness-factory.test.ts \
    emain/agent/agent-session-runtime.test.ts \
    emain/agent-ipc.test.ts \
    frontend/app/term/render/agent-surface.test.tsx \
    frontend/app/workspace/workspace.test.tsx
```

- [ ] **Step 2: Run ESLint**

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx eslint \
    emain/agent/agent-runtime-registry.ts \
    emain/agent/harness/agent-harness.ts \
    emain/agent/harness-factory.ts \
    emain/agent/agent-session-runtime.ts \
    emain/agent-ipc.ts
```

- [ ] **Step 3: Run scoped TypeScript diagnostics**

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx tsc --noEmit 2>&1 | \
  rg "agent-runtime-registry|agent-session-runtime|harness-factory|agent-ipc" || true
```

Expected: no output.

- [ ] **Step 4: Verify diff and active worktrees**

```bash
git diff --check
git status --short --branch
git -C ../agent-extension-integration status --short
git -C ../agent-observability-langfuse status --short
```

Expected: refactor branch clean; both active worktrees remain untouched.
