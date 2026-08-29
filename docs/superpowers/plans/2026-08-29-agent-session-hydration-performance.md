# Agent Session Hydration Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make existing agent sessions display a truthful loading state and hydrate their transcript before expensive context inspection, while reducing persisted branch reconstruction to one branch read and one SQLite query.

**Architecture:** `usePiChat` owns a renderer hydration flag tied to the authoritative subscription epoch. The assistant-ui adapter maps that flag to `thread.isLoading`, while Electron preload forwards initial subscription failures through an optional callback. Main reconstructs a branch once and derives all replay projections from it; SQLite resolves the parent chain with a single recursive CTE.

**Tech Stack:** TypeScript, React 19, Jotai-adjacent hook state, assistant-ui external store runtime, Electron IPC/preload, Node SQLite, Vitest, Testing Library.

---

## File Structure

- `frontend/app/store/use-pi-chat.ts`: own session hydration state, delay existing-session inspection, and handle subscription failure.
- `frontend/app/store/use-pi-chat.test.tsx`: lifecycle regression tests for initial load, switching, stale events, failures, and inspection ordering.
- `frontend/app/agent/agent-runtime-client.ts`: forward the optional subscription error callback through the workspace-bound client.
- `frontend/app/agent/agent-runtime-client.test.ts`: verify workspace identity and error callback forwarding.
- `frontend/types/custom.d.ts`: extend the manually maintained Electron agent subscription signature.
- `emain/preload.ts`: notify renderer subscribers when the initial `agent:subscribe` invoke rejects.
- `emain/preload-agent-subscription.test.ts`: exercise the exposed preload API and rejected subscribe invocation.
- `frontend/app/agent/assistant-ui/runtime-bridge.ts`: map renderer hydration to assistant-ui `isLoading`.
- `frontend/app/agent/assistant-ui/runtime-bridge.test.ts`: verify adapter loading propagation.
- `frontend/app/agent/assistant-ui/registry-thread.tsx`: render a loading placeholder while suppressing Welcome.
- `frontend/app/agent/assistant-ui/thread.integration.test.tsx`: verify loading DOM and Welcome suppression.
- `emain/agent-ipc.ts`: derive replay and runtime seed projections from one branch read.
- `emain/agent-ipc.test.ts`: enforce one branch read for persisted replay and runtime creation.
- `packages/agent/harness/session/sqlite-storage.ts`: replace parent-by-parent reads with one recursive CTE.
- `packages/coding-agent/sqlite-storage.test.ts`: cover query count, ordering, explicit leaf, and corrupted chains.

### Task 1: Renderer Hydration Lifecycle and Inspection Ordering

**Files:**
- Modify: `frontend/app/store/use-pi-chat.test.tsx`
- Modify: `frontend/app/store/use-pi-chat.ts`

- [ ] **Step 1: Extend the hook test client with subscription failures**

Change the test subscriber storage so each record carries both callbacks:

```ts
const subscribers = new Map<
    string,
    Array<{ onEvent: (event: unknown) => void; onError?: (error: unknown) => void }>
>();

subscribe: vi.fn(
    (sessionPath: string, onEvent: (event: unknown) => void, onError?: (error: unknown) => void) => {
        const list = subscribers.get(sessionPath) ?? [];
        list.push({ onEvent, onError });
        subscribers.set(sessionPath, list);
        return () => {
            unsubscribed.push(sessionPath);
        };
    }
),
emit(sessionPath: string, event: unknown) {
    for (const subscriber of subscribers.get(sessionPath) ?? []) {
        subscriber.onEvent(event);
    }
},
failSubscription(sessionPath: string, error: unknown) {
    for (const subscriber of subscribers.get(sessionPath) ?? []) {
        subscriber.onError?.(error);
    }
},
getSubscriber(sessionPath: string, index = 0) {
    return subscribers.get(sessionPath)?.[index]?.onEvent;
},
```

- [ ] **Step 2: Write failing hydration and inspection-order tests**

Add focused tests to `use-pi-chat.test.tsx`:

```ts
it("hydrates an existing session before inspecting its context", async () => {
    const client = makeClient();
    const session = makeSession("/repo/.agent/existing.db");
    const { result } = renderHook(() =>
        usePiChat({
            client,
            initialSession: session,
            executionContext: makeExecutionContext({ sessionPath: session.path }),
            modelSelection: makeModel(),
        })
    );

    expect(result.current.isHydrating).toBe(true);
    expect(client.inspectContext).not.toHaveBeenCalled();

    act(() => {
        client.emit(session.path, {
            type: "session_state",
            messages: [],
            turns: [],
            status: "idle",
            steer: [],
            followUp: [],
            commands: [],
        });
    });

    await waitFor(() => expect(result.current.isHydrating).toBe(false));
    await waitFor(() => expect(client.inspectContext).toHaveBeenCalledOnce());
});

it("keeps the selected session hydrating when the previous subscription emits late", async () => {
    const client = makeClient();
    const sessionA = makeSession("/repo/.agent/a.db");
    const sessionB = makeSession("/repo/.agent/b.db");
    const { result, rerender } = renderHook(
        ({ session }) =>
            usePiChat({
                client,
                initialSession: session,
                controlledSession: { metadata: session },
                executionContext: makeExecutionContext({ sessionPath: session.path }),
                modelSelection: makeModel(),
            }),
        { initialProps: { session: sessionA } }
    );
    await waitFor(() => expect(client.getSubscriber(sessionA.path)).toBeDefined());
    const staleA = client.getSubscriber(sessionA.path)!;
    rerender({ session: sessionB });
    await waitFor(() => expect(client.getSubscriber(sessionB.path)).toBeDefined());

    act(() => client.emitCaptured(staleA, { type: "session_state", messages: [], turns: [] }));

    expect(result.current.isHydrating).toBe(true);
});

it("ends hydration and surfaces an initial subscription failure", async () => {
    const client = makeClient();
    const session = makeSession("/repo/.agent/broken.db");
    const { result } = renderHook(() =>
        usePiChat({
            client,
            initialSession: session,
            executionContext: makeExecutionContext({ sessionPath: session.path }),
            modelSelection: makeModel(),
        })
    );
    await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());

    act(() => client.failSubscription(session.path, new Error("session unavailable")));

    expect(result.current.isHydrating).toBe(false);
    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("session unavailable");
});
```

Extend the existing controlled-session switch test to assert hydration is true before B replay and false after B replay. Extend the controlled clear test to assert `isHydrating` is false.

- [ ] **Step 3: Run the hook tests and verify RED**

Run:

```bash
npx vitest run frontend/app/store/use-pi-chat.test.tsx
```

Expected: FAIL because `UsePiChatReturn` has no `isHydrating`, inspection starts immediately, and subscribe accepts no error callback.

- [ ] **Step 4: Implement the minimal hydration lifecycle**

In `UsePiChatReturn`, add:

```ts
isHydrating: boolean;
```

Update `AgentApiSurface.subscribe`:

```ts
subscribe: (
    sessionPath: string,
    callback: (event: unknown) => void,
    onError?: (error: unknown) => void
) => () => void;
```

Initialize state next to the session state:

```ts
const [isHydrating, setIsHydrating] = useState(!!initialSessionMetadata?.path);
```

Inside the controlled-session layout effect, set the state from the new identity before returning from the reset path:

```ts
setIsHydrating(!!next?.path);
```

In the context-inspection effect, retain pre-session inspection but gate existing sessions:

```ts
if (sessionPath && isHydrating) {
    setContextSnapshot(undefined);
    setContextInspectionError(undefined);
    return;
}
```

Add `isHydrating` to that effect's dependencies.

In the subscription effect, add this handler beside `isCurrentSubscription`:

```ts
const onSubscriptionError = (error: unknown): void => {
    if (!isCurrentSubscription()) return;
    setIsHydrating(false);
    setStatus("error");
    setErrorMessage(getErrorMessage(error));
};

```

Pass `onSubscriptionError` as the third argument to the existing `api.subscribe(...)` call. Add `setIsHydrating(false)` as the first statement in its `case "session_state"` block, before `applySessionState(...)`.

Return `isHydrating` from the hook.

- [ ] **Step 5: Run the hook tests and verify GREEN**

Run:

```bash
npx vitest run frontend/app/store/use-pi-chat.test.tsx
```

Expected: PASS with no unhandled errors or warnings.

- [ ] **Step 6: Commit the renderer lifecycle**

```bash
git add frontend/app/store/use-pi-chat.ts frontend/app/store/use-pi-chat.test.tsx
git commit -m "fix: track agent session hydration"
```

### Task 2: Subscription Error Propagation Across Preload

**Files:**
- Create: `emain/preload-agent-subscription.test.ts`
- Modify: `emain/preload.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `frontend/app/agent/agent-runtime-client.ts`
- Modify: `frontend/app/agent/agent-runtime-client.test.ts`

- [ ] **Step 1: Write a failing preload subscription test**

Create `emain/preload-agent-subscription.test.ts` with a hoisted Electron mock that captures `contextBridge.exposeInMainWorld` values and controls `ipcRenderer.invoke`. Import `./preload` after installing the mock, obtain the exposed `api`, subscribe with an error callback, reject the `agent:subscribe` promise, and assert that callback receives the same error:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
    const exposed = new Map<string, unknown>();
    return {
        exposed,
        invoke: vi.fn(),
        on: vi.fn(),
        send: vi.fn(),
    };
});

vi.mock("electron", () => ({
    contextBridge: {
        exposeInMainWorld: (name: string, value: unknown) => electron.exposed.set(name, value),
    },
    ipcRenderer: {
        invoke: electron.invoke,
        on: electron.on,
        send: electron.send,
        removeListener: vi.fn(),
    },
    webUtils: { getPathForFile: vi.fn(() => "") },
}));

beforeAll(async () => {
    await import("./preload");
});

describe("agent preload subscription", () => {
    it("reports an initial subscribe rejection to the renderer", async () => {
        const failure = new Error("subscription rejected");
        electron.invoke.mockImplementation((channel: string) => {
            if (channel === "agent:subscribe") return Promise.reject(failure);
            return Promise.resolve();
        });
        const api = electron.exposed.get("api") as ElectronApi;
        const onError = vi.fn();

        api.agent.subscribe(
            { workspaceId: "workspace-1", generation: 1 },
            "/sessions/a.db",
            vi.fn(),
            onError
        );
        await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    });
});
```

In `agent-runtime-client.test.ts`, pass an `onError` spy to `client.subscribe()` and expect the underlying Electron API to receive it as the fourth argument.

- [ ] **Step 2: Run boundary tests and verify RED**

Run:

```bash
npx vitest run emain/preload-agent-subscription.test.ts frontend/app/agent/agent-runtime-client.test.ts
```

Expected: FAIL because the optional error callback is not accepted or invoked.

- [ ] **Step 3: Forward the optional error callback**

Change `ElectronApi.agent.subscribe` in `frontend/types/custom.d.ts` to:

```ts
subscribe: (
    context: WorkspaceAgentRequestContext,
    sessionPath: string,
    callback: (event: unknown) => void,
    onError?: (error: unknown) => void
) => () => void;
```

Change `AgentRuntimeClient.subscribe` to accept and forward `onError`:

```ts
subscribe(sessionPath: string, callback: (event: unknown) => void, onError?: (error: unknown) => void) {
    return getAgentApi(this).subscribe(this.identity, sessionPath, callback, onError);
}
```

Add an error callback registry beside `agentEventCallbacks`:

```ts
const agentEventErrorCallbacks = new Map<
    string,
    Map<(event: unknown) => void, (error: unknown) => void>
>();

```

Add `onError?: (error: unknown) => void` to preload's subscribe signature. Immediately after `entry.add(callback)`, register it with:

```ts
if (onError) {
    let errors = agentEventErrorCallbacks.get(key);
    if (!errors) {
        errors = new Map();
        agentEventErrorCallbacks.set(key, errors);
    }
    errors.set(callback, onError);
}
```

Replace the `agent:subscribe` rejection handler with:

```ts
.catch((error) => {
    console.error("agent:subscribe failed", error);
    for (const notify of agentEventErrorCallbacks.get(key)?.values() ?? []) {
        notify(error);
    }
});
```

Immediately after `cur.delete(callback)` in the returned cleanup, remove the paired error callback:

```ts
const errors = agentEventErrorCallbacks.get(key);
errors?.delete(callback);
if (errors?.size === 0) {
    agentEventErrorCallbacks.delete(key);
}
```

- [ ] **Step 4: Run boundary tests and verify GREEN**

Run:

```bash
npx vitest run emain/preload-agent-subscription.test.ts frontend/app/agent/agent-runtime-client.test.ts frontend/app/store/use-pi-chat.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the IPC error path**

```bash
git add emain/preload-agent-subscription.test.ts emain/preload.ts frontend/types/custom.d.ts frontend/app/agent/agent-runtime-client.ts frontend/app/agent/agent-runtime-client.test.ts
git commit -m "fix: report agent subscription failures"
```

### Task 3: Assistant-UI Loading State and Placeholder

**Files:**
- Modify: `frontend/app/agent/assistant-ui/runtime-bridge.test.ts`
- Modify: `frontend/app/agent/assistant-ui/runtime-bridge.ts`
- Modify: `frontend/app/agent/assistant-ui/thread.integration.test.tsx`
- Modify: `frontend/app/agent/assistant-ui/registry-thread.tsx`

- [ ] **Step 1: Write failing adapter and thread tests**

Add to `runtime-bridge.test.ts`:

```ts
it("maps session hydration to assistant-ui loading", () => {
    const adapter = createCrestAssistantRuntimeAdapter(makeChat({ isHydrating: true }));
    expect(adapter.isLoading).toBe(true);
});
```

Update `RuntimeProvider` in `thread.integration.test.tsx` to accept an `isLoading` prop and pass it to `useExternalStoreRuntime`. Add:

```ts
function renderLoadingThread(): string {
    return renderToStaticMarkup(
        <RuntimeProvider messages={[]} isLoading>
            <Thread />
        </RuntimeProvider>
    );
}

it("shows session loading without rendering the new-chat welcome", () => {
    const html = renderLoadingThread();
    expect(html).toContain("aui-thread-loading");
    expect(html).not.toContain("aui-thread-welcome-root");
});
```

- [ ] **Step 2: Run assistant-ui tests and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/runtime-bridge.test.ts frontend/app/agent/assistant-ui/thread.integration.test.tsx
```

Expected: FAIL because the adapter omits `isLoading` and no loading placeholder exists.

- [ ] **Step 3: Implement adapter mapping and placeholder**

Add `isHydrating?: boolean` to `CrestAssistantRuntimeBridge`, and include this adapter property:

```ts
isLoading: source.isHydrating ?? false,
```

Add `isHydrating: false` to the `makeChat()` test fixture so its required `UsePiChatReturn` shape remains complete.

Add a loading component in `registry-thread.tsx`:

```tsx
const ThreadLoading: FC = () => (
    <div className="aui-thread-loading flex flex-1 items-center justify-center text-sm text-muted-foreground" role="status">
        Loading conversation…
    </div>
);
```

Render it alongside Welcome with an assistant-ui predicate:

```tsx
<AuiIf condition={(s) => s.thread.isLoading}>
    <ThreadLoading />
</AuiIf>
<AuiIf condition={isNewChatView}>
    <Welcome />
</AuiIf>
```

- [ ] **Step 4: Run assistant-ui tests and verify GREEN**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/runtime-bridge.test.ts frontend/app/agent/assistant-ui/thread.integration.test.tsx frontend/app/agent/agent-content.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the loading UI**

```bash
git add frontend/app/agent/assistant-ui/runtime-bridge.ts frontend/app/agent/assistant-ui/runtime-bridge.test.ts frontend/app/agent/assistant-ui/registry-thread.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx
git commit -m "fix: show agent session hydration state"
```

### Task 4: Single Branch Read for Replay and Runtime Seed

**Files:**
- Modify: `emain/agent-ipc.test.ts`
- Modify: `emain/agent-ipc.ts`

- [ ] **Step 1: Write failing branch-read count tests**

Import `Session` from `@crest/agent/harness/session/session`. In the persisted replay test, install a spy immediately before subscription and assert one call:

```ts
const getBranch = vi.spyOn(Session.prototype, "getBranch");
await subscribeAgentSessionForIpc(sender, aliasPath);
expect(getBranch).toHaveBeenCalledOnce();
getBranch.mockRestore();
```

In `"reuses one runtime and applies refreshed model metadata on the next send"`, install this spy after creating `metadata`:

```ts
const getBranch = vi.spyOn(Session.prototype, "getBranch");
```

After the two sends, assert runtime creation read the branch once and the cached second send did not reread it:

```ts
expect(getBranch).toHaveBeenCalledOnce();
```

Restore `getBranch` in the test's `finally` block.

- [ ] **Step 2: Run main IPC tests and verify RED**

Run:

```bash
npx vitest run emain/agent-ipc.test.ts
```

Expected: FAIL with two branch reads: one through `buildContext()` and one explicit `getBranch()`.

- [ ] **Step 3: Derive all projections from one branch**

Import `buildSessionContext`:

```ts
import { buildSessionContext } from "@crest/agent/harness/session/session";
```

In `sendPersistedSessionState`, replace the two reads with:

```ts
const branch = await session.getBranch();
const context = buildSessionContext(branch);
const contextState = buildContextStateFromSessionEntries(branch);
```

In `createAgentRuntimeFromSession`, replace the seed reads with:

```ts
const initialEntries = await piSession.getBranch();
const seed = buildSessionContext(initialEntries);
const initialTurns = buildPersistedTurnsFromSessionEntries(initialEntries);
```

- [ ] **Step 4: Run main IPC tests and verify GREEN**

Run:

```bash
npx vitest run emain/agent-ipc.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the replay optimization**

```bash
git add emain/agent-ipc.ts emain/agent-ipc.test.ts
git commit -m "perf: reuse agent session branch projections"
```

### Task 5: Single-Query SQLite Branch Reconstruction

**Files:**
- Modify: `packages/coding-agent/sqlite-storage.test.ts`
- Modify: `packages/agent/harness/session/sqlite-storage.ts`

- [ ] **Step 1: Write failing query-count and corruption tests**

Extend the existing `getPathToRoot` test:

```ts
const all = vi.spyOn(sqliteDb(storage), "all");
const path0 = await storage.getPathToRoot(b);
expect(path0.map((entry) => entry.id)).toEqual([a, b]);
expect(historyReadCalls(all.mock.calls)).toHaveLength(1);
```

Update the test helper so multiline CTE SQL is recognized:

```ts
function historyReadCalls(calls: unknown[][]): unknown[][] {
    return calls.filter(([sql]) => /SELECT\b[\s\S]*\bdata\b[\s\S]*\bFROM entries\b/i.test(String(sql)));
}
```

Add explicit error cases:

```ts
it("getPathToRoot rejects a missing leaf and a broken parent chain", async () => {
    const storage = SqliteSessionStorage.create(dbPath(), { cwd: "/c", sessionId: "s1" });
    await expect(storage.getPathToRoot("missing")).rejects.toThrow(/Entry missing not found/);
    sqliteDb(storage).run(
        "INSERT INTO entries (id, parent_id, type, timestamp, target_id, data) VALUES (?, ?, ?, ?, ?, ?)",
        "child",
        "missing-parent",
        "message",
        new Date().toISOString(),
        null,
        JSON.stringify(messageEntry("child", "missing-parent"))
    );
    await expect(storage.getPathToRoot("child")).rejects.toThrow(/Entry missing-parent not found/);
    storage.close();
});
```

- [ ] **Step 2: Run SQLite tests and verify RED**

Run:

```bash
npx vitest run packages/coding-agent/sqlite-storage.test.ts
```

Expected: FAIL because the current traversal performs `getEntry()` once per ancestor and never issues the expected recursive branch query.

- [ ] **Step 3: Implement one recursive CTE**

Replace `getPathToRoot` with:

```ts
async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const rows = this.db.all<{ data: string; parent_id: string | null; depth: number }>(
        `WITH RECURSIVE branch(data, parent_id, depth) AS (
            SELECT data, parent_id, 0 FROM entries WHERE id = ?
            UNION ALL
            SELECT entries.data, entries.parent_id, branch.depth + 1
            FROM entries
            JOIN branch ON entries.id = branch.parent_id
        )
        SELECT data, parent_id, depth FROM branch ORDER BY depth`,
        leafId
    );
    if (rows.length === 0) {
        throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    const oldest = rows[rows.length - 1];
    if (oldest.parent_id) {
        throw invalidSession(this.location, `Entry ${oldest.parent_id} not found`);
    }
    rows.reverse();
    return rows.map((row) => deserializeEntry(row, this.location));
}
```

- [ ] **Step 4: Run SQLite and session integration tests and verify GREEN**

Run:

```bash
npx vitest run packages/coding-agent/sqlite-storage.test.ts packages/coding-agent/sessions.test.ts packages/coding-agent/agent-session-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the SQLite optimization**

```bash
git add packages/agent/harness/session/sqlite-storage.ts packages/coding-agent/sqlite-storage.test.ts
git commit -m "perf: load sqlite session branches in one query"
```

### Task 6: Full Verification

**Files:**
- Verify all modified files from Tasks 1-5.

- [ ] **Step 1: Run the focused regression suite**

```bash
npx vitest run \
    frontend/app/store/use-pi-chat.test.tsx \
    frontend/app/agent/agent-runtime-client.test.ts \
    frontend/app/agent/assistant-ui/runtime-bridge.test.ts \
    frontend/app/agent/assistant-ui/thread.integration.test.tsx \
    frontend/app/agent/agent-content.test.tsx \
    emain/preload-agent-subscription.test.ts \
    emain/agent-ipc.test.ts \
    packages/coding-agent/sqlite-storage.test.ts \
    packages/coding-agent/sessions.test.ts \
    packages/coding-agent/agent-session-runtime.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run TypeScript checking**

```bash
npx tsc --noEmit
```

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 3: Inspect the final diff and repository state**

```bash
git diff --check
git status --short
git log -n 6 --oneline
```

Expected: no whitespace errors; only pre-existing unrelated untracked files remain; the design and task commits are visible.

- [ ] **Step 4: Manually verify the interaction in development mode**

Start Crest with `npm run dev`, select a long existing agent session, and confirm:

1. Welcome never appears after clicking the existing session.
2. `Loading conversation…` appears only until its transcript arrives.
3. The transcript appears before the context usage indicator finishes updating.
4. Switching A→B→A never displays messages from the wrong session.
5. A new chat still displays Welcome.

- [ ] **Step 5: Commit any verification-only test corrections**

If verification required test-only corrections, stage only affected files from this exact test set:

```bash
git add \
    frontend/app/store/use-pi-chat.test.tsx \
    frontend/app/agent/agent-runtime-client.test.ts \
    frontend/app/agent/assistant-ui/runtime-bridge.test.ts \
    frontend/app/agent/assistant-ui/thread.integration.test.tsx \
    frontend/app/agent/agent-content.test.tsx \
    emain/preload-agent-subscription.test.ts \
    emain/agent-ipc.test.ts \
    packages/coding-agent/sqlite-storage.test.ts \
    packages/coding-agent/sessions.test.ts \
    packages/coding-agent/agent-session-runtime.test.ts
git commit -m "test: cover agent session hydration regression"
```

If no corrections were required, do not create an empty commit.
