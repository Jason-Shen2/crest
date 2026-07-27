# Workspace Activity Isolation Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Agent UI work from Agent → File navigation commits and keep cold File activation on a File-owned loading surface until its runtime is ready.

**Architecture:** Replace the changing boolean Agent activity Context with one stable workspace-scoped lifecycle controller. Agent resource owners subscribe to that controller imperatively without turning activity back into React render state. A dedicated File content slot creates its runtime after the loading slot mounts and does not mount the File/Monaco surface until the runtime reports `ready` or `error`.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Jotai, Monaco, Tailwind v4.

---

## Scope and execution protocol

- Work only in `/Users/bytedance/Documents/crest/.worktrees/workspace-renderer-phase1`.
- Preserve `ActiveContent`, Workspace checkpointing, Terminal renderer ownership, Top Tab
  descriptors, close coordinator, runtime registry, and editor registry contracts.
- Browser Top Tabs remain excluded.
- Do not add direct DOM mutation, `setTimeout`, `requestAnimationFrame`, deferred visibility,
  an overlay, a second renderer, or another React root.
- Do not expose activity through React state, Jotai, `useSyncExternalStore`, or a changing
  boolean Context value.
- Do not run `go build`; use `npm run build:dev`.
- Follow TDD for every behavioral task: add the focused failing test, run it and confirm the
  expected failure, implement the smallest production change, then rerun focused and related
  tests.
- Keep each numbered task as a separate commit. Do not squash during implementation.

## Target file structure

Create:

```text
frontend/app/workspace/workspace-file-content-slot.tsx
frontend/app/workspace/workspace-file-content-slot.test.tsx
```

Modify:

```text
frontend/app/agent/agent-surface-activity.tsx
frontend/app/agent/agent-surface-activity.test.tsx
frontend/app/agent/agent-chat-host.tsx
frontend/app/agent/agent-chat-host.test.tsx
frontend/app/agent/agent-command-card.tsx
frontend/app/agent/agent-command-card.test.tsx
frontend/app/store/use-pi-chat.ts
frontend/app/store/use-pi-chat.test.tsx
frontend/app/workspace/workspace-agent-content-slot.tsx
frontend/app/workspace/workspace-agent-content-slot.test.tsx
frontend/app/workspace/top-tab-content-deck.tsx
frontend/app/workspace/top-tab-content-deck.test.tsx
frontend/app/workspace/workspace-main-content.test.tsx
frontend/app/workspace/workspace-content-isolation-boundary.test.ts
docs/superpowers/specs/2026-07-26-workspace-content-isolation-design.md
docs/agent-rendering-architecture.md
```

Responsibilities:

- `agent-surface-activity.tsx`: stable controller, stable Context object, controller hook.
- `use-pi-chat.ts`: session event subscription resource lifecycle; no Workspace routing state.
- `agent-command-card.tsx`: PTY observer and command input lifecycle.
- `workspace-agent-content-slot.tsx`: lightweight visual slot plus post-commit controller update.
- `workspace-file-content-slot.tsx`: cold/loading/ready/error File runtime gate.
- `top-tab-content-deck.tsx`: retained File slot inventory and active-only Preview/Diff inventory.

### Task 1: Replace boolean activity Context with a stable controller

**Files:**
- Modify: `frontend/app/agent/agent-surface-activity.tsx`
- Modify: `frontend/app/agent/agent-surface-activity.test.tsx`
- Modify: `frontend/app/workspace/workspace-content-isolation-boundary.test.ts`

- [ ] **Step 1: Replace the activity test with controller-first failing tests**

Use this complete test body:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    AgentSurfaceActivityProvider,
    makeAgentSurfaceActivityController,
    useAgentSurfaceActivityController,
} from "./agent-surface-activity";

afterEach(cleanup);

describe("Agent surface activity controller", () => {
    it("notifies listeners only when activity changes and stops after unsubscribe", () => {
        const controller = makeAgentSurfaceActivityController(true);
        const listener = vi.fn();
        const unsubscribe = controller.subscribe(listener);

        controller.setActive(true);
        controller.setActive(false);
        controller.setActive(false);
        unsubscribe();
        controller.setActive(true);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(false);
        expect(controller.getActive()).toBe(true);
    });

    it("keeps the Context value stable while controller activity changes", () => {
        const controller = makeAgentSurfaceActivityController(true);
        const renderProbe = vi.fn();
        const activityEvents = vi.fn();

        function Probe() {
            renderProbe();
            const activity = useAgentSurfaceActivityController();
            useEffect(() => activity.subscribe(activityEvents), [activity]);
            return null;
        }

        render(
            <AgentSurfaceActivityProvider controller={controller}>
                <Probe />
            </AgentSurfaceActivityProvider>
        );
        expect(renderProbe).toHaveBeenCalledTimes(1);

        act(() => controller.setActive(false));

        expect(activityEvents).toHaveBeenCalledWith(false);
        expect(renderProbe).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Add the failing boolean-Context boundary**

Add this test to `workspace-content-isolation-boundary.test.ts`:

```ts
test("keeps Agent activity out of React render state", () => {
    const activity = source("frontend/app/agent/agent-surface-activity.tsx");

    expect(activity).not.toMatch(/createContext\(\s*(true|false)\s*\)/);
    expect(activity).not.toContain("useSyncExternalStore");
});
```

- [ ] **Step 3: Run the controller tests and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/agent-surface-activity.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts --reporter=dot
```

Expected: FAIL because `makeAgentSurfaceActivityController`,
`useAgentSurfaceActivityController`, and the `controller` Provider prop do not exist, and
the current source still creates a boolean Context.

- [ ] **Step 4: Implement the stable controller and Context**

Replace `agent-surface-activity.tsx` with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, type ReactNode } from "react";

export interface AgentSurfaceActivityController {
    getActive(): boolean;
    setActive(active: boolean): void;
    subscribe(listener: (active: boolean) => void): () => void;
}

export function makeAgentSurfaceActivityController(initialActive: boolean): AgentSurfaceActivityController {
    let active = initialActive;
    const listeners = new Set<(active: boolean) => void>();
    return {
        getActive: () => active,
        setActive: (nextActive) => {
            if (nextActive === active) {
                return;
            }
            active = nextActive;
            [...listeners].forEach((listener) => listener(active));
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

const DefaultAgentSurfaceActivityController = makeAgentSurfaceActivityController(true);
const AgentSurfaceActivityContext = createContext<AgentSurfaceActivityController>(
    DefaultAgentSurfaceActivityController
);

export function AgentSurfaceActivityProvider({
    controller,
    children,
}: {
    controller: AgentSurfaceActivityController;
    children: ReactNode;
}) {
    return <AgentSurfaceActivityContext.Provider value={controller}>{children}</AgentSurfaceActivityContext.Provider>;
}

export function useAgentSurfaceActivityController(): AgentSurfaceActivityController {
    return useContext(AgentSurfaceActivityContext);
}
```

- [ ] **Step 5: Run GREEN**

Run:

```bash
npx vitest run frontend/app/agent/agent-surface-activity.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts --reporter=dot
```

Expected: both files PASS.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write frontend/app/agent/agent-surface-activity.tsx frontend/app/agent/agent-surface-activity.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts
git add frontend/app/agent/agent-surface-activity.tsx frontend/app/agent/agent-surface-activity.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts
git commit -m "refactor: add stable agent activity controller"
```

### Task 2: Keep activity changes outside the Agent React subtree

**Files:**
- Modify: `frontend/app/workspace/workspace-agent-content-slot.tsx`
- Modify: `frontend/app/workspace/workspace-agent-content-slot.test.tsx`
- Modify: `frontend/app/workspace/workspace-content-isolation-boundary.test.ts`
- Test: `frontend/app/workspace/workspace-main-content.test.tsx`

- [ ] **Step 1: Write the failing zero-consumer-render regression**

Replace the mock and the stable-slot test in
`workspace-agent-content-slot.test.tsx` with this complete file:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { useAgentSurfaceActivityController } from "@/app/agent/agent-surface-activity";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAgentContentSlot } from "./workspace-agent-content-slot";

const agentContentMock = vi.hoisted(() => ({
    rootRenderCount: 0,
    consumerRenderCount: 0,
    activityEvents: vi.fn(),
}));

vi.mock("@/app/agent/agent-content", () => ({
    AgentContent: () => {
        agentContentMock.rootRenderCount++;
        return <ActivityLifecycleProbe />;
    },
}));

function ActivityLifecycleProbe() {
    agentContentMock.consumerRenderCount++;
    const controller = useAgentSurfaceActivityController();
    useEffect(() => controller.subscribe(agentContentMock.activityEvents), [controller]);
    return <div data-testid="mock-agent-content">Agent</div>;
}

afterEach(() => {
    cleanup();
    agentContentMock.rootRenderCount = 0;
    agentContentMock.consumerRenderCount = 0;
    agentContentMock.activityEvents.mockClear();
});

describe("WorkspaceAgentContentSlot", () => {
    it("renders nothing until the Agent surface has been mounted", () => {
        render(<WorkspaceAgentContentSlot active={true} mounted={false} />);
        expect(screen.queryByTestId("agent-surface")).toBeNull();
    });

    it("commits slot visibility without rerendering Agent activity consumers", async () => {
        const props = {
            mounted: true,
            model: {} as any,
            client: {} as any,
            executionContext: {
                workspaceId: "workspace-1",
                workspaceDir: "/repo",
                connection: "",
                environment: {},
            },
        };
        const view = render(<WorkspaceAgentContentSlot {...props} active={true} />);
        const slot = screen.getByTestId("agent-surface");
        const content = screen.getByTestId("mock-agent-content");

        view.rerender(<WorkspaceAgentContentSlot {...props} active={false} />);

        expect(screen.getByTestId("agent-surface")).toBe(slot);
        expect(screen.getByTestId("mock-agent-content")).toBe(content);
        expect(slot.style.visibility).toBe("hidden");
        expect(slot.getAttribute("aria-hidden")).toBe("true");
        expect(slot.hasAttribute("inert")).toBe(true);
        expect(agentContentMock.rootRenderCount).toBe(1);
        expect(agentContentMock.consumerRenderCount).toBe(1);
        await waitFor(() => expect(agentContentMock.activityEvents).toHaveBeenCalledWith(false));
        expect(agentContentMock.consumerRenderCount).toBe(1);
    });

    it("renders a fallback label when Agent dependencies are not ready", () => {
        render(<WorkspaceAgentContentSlot active={true} mounted={true} />);
        expect(screen.getByTestId("agent-surface").textContent).toBe("Agent");
    });
});
```

Add this boundary test:

```ts
test("keeps the changing activity boolean out of the Agent Provider", () => {
    const agentSlot = source("frontend/app/workspace/workspace-agent-content-slot.tsx");

    expect(agentSlot).not.toContain("AgentSurfaceActivityProvider active=");
    expect(agentSlot).toContain("AgentSurfaceActivityProvider controller=");
});
```

- [ ] **Step 2: Run the slot test and verify RED**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-agent-content-slot.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts --reporter=dot
```

Expected: FAIL because the current Provider requires a changing `active` boolean and the
activity consumer renders twice.

- [ ] **Step 3: Give the slot one stable controller**

Replace `workspace-agent-content-slot.tsx` with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AgentContent } from "@/app/agent/agent-content";
import type { AgentRuntimeClient } from "@/app/agent/agent-runtime-client";
import {
    AgentSurfaceActivityProvider,
    makeAgentSurfaceActivityController,
} from "@/app/agent/agent-surface-activity";
import { memo, useEffect, useState } from "react";
import type { WorkspaceAgentModel } from "./workspace-agent-model";
import { WorkspaceContentSlot } from "./workspace-content-slot";

export interface WorkspaceAgentContentSlotProps {
    active: boolean;
    mounted: boolean;
    model?: WorkspaceAgentModel;
    client?: AgentRuntimeClient;
    executionContext?: AgentExecutionContext;
}

const StableAgentContent = memo(AgentContent);
StableAgentContent.displayName = "StableAgentContent";

export function WorkspaceAgentContentSlot({
    active,
    mounted,
    model,
    client,
    executionContext,
}: WorkspaceAgentContentSlotProps) {
    const [activityController] = useState(() => makeAgentSurfaceActivityController(active));

    useEffect(() => {
        activityController.setActive(active);
    }, [active, activityController]);

    if (!mounted) {
        return null;
    }
    return (
        <WorkspaceContentSlot active={active} testId="agent-surface">
            <AgentSurfaceActivityProvider controller={activityController}>
                {model && client && executionContext ? (
                    <StableAgentContent model={model} client={client} executionContext={executionContext} />
                ) : (
                    "Agent"
                )}
            </AgentSurfaceActivityProvider>
        </WorkspaceContentSlot>
    );
}
```

The effect is a resource-lifecycle notification after the DOM commit. Visual correctness
must depend only on `WorkspaceContentSlot`, never on listener completion.

- [ ] **Step 4: Run focused and coordinator tests**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-agent-content-slot.test.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts --reporter=dot
```

Expected: both files PASS; the Agent root and activity probe remain at one render.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write frontend/app/workspace/workspace-agent-content-slot.tsx frontend/app/workspace/workspace-agent-content-slot.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts
git add frontend/app/workspace/workspace-agent-content-slot.tsx frontend/app/workspace/workspace-agent-content-slot.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts
git commit -m "refactor: isolate agent activity from navigation"
```

### Task 3: Move session subscription activity out of React render state

**Files:**
- Modify: `frontend/app/store/use-pi-chat.ts`
- Modify: `frontend/app/store/use-pi-chat.test.tsx`
- Modify: `frontend/app/agent/agent-chat-host.tsx`
- Modify: `frontend/app/agent/agent-chat-host.test.tsx`
- Modify: `frontend/app/workspace/workspace-content-isolation-boundary.test.ts`

- [ ] **Step 1: Add the failing no-render subscription lifecycle test**

Import `makeAgentSurfaceActivityController` in `use-pi-chat.test.tsx` and replace the
existing “hiding releases” test with:

```tsx
it("changes session subscription activity without rerendering the chat hook", async () => {
    const client = makeClient();
    const session = makeSession("/repo/.agent/a.jsonl");
    const activity = makeAgentSurfaceActivityController(true);
    let renderCount = 0;
    const { result } = renderHook(() => {
        renderCount++;
        return usePiChat({
            client,
            initialSession: session,
            executionContext: makeExecutionContext({ sessionPath: session.path }),
            modelSelection: makeModel(),
            activity,
        });
    });

    await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());
    act(() => {
        client.emit(session.path, {
            type: "session_state",
            messages: [{ role: "user", content: [{ type: "text", text: `snapshot:${session.path}` }] }],
            turns: [],
            status: "idle",
            steer: [],
            followUp: [],
            commands: [],
        });
    });
    const rendersAfterSnapshot = renderCount;

    act(() => activity.setActive(false));
    await waitFor(() => expect(client.unsubscribed).toContain(session.path));
    expect(result.current.messages[0]?.content?.[0]?.text).toBe(`snapshot:${session.path}`);
    expect(renderCount).toBe(rendersAfterSnapshot);

    act(() => activity.setActive(true));
    await waitFor(() => expect(client.subscribe).toHaveBeenCalledTimes(2));
    expect(renderCount).toBe(rendersAfterSnapshot);
});
```

Update the hidden abort test to create an inactive controller and pass `activity`:

```tsx
const activity = makeAgentSurfaceActivityController(false);
const { result } = renderHook(() =>
    usePiChat({
        client,
        initialSession: session,
        executionContext: makeExecutionContext({ sessionPath: session.path }),
        modelSelection: makeModel(),
        activity,
    })
);
```

Replace the existing “mirrors hosted PTY command snapshots” visibility rerender with a
controller transition:

```tsx
const activity = makeAgentSurfaceActivityController(true);
const { result } = renderHook(() =>
    usePiChat({
        client,
        initialSession: session,
        executionContext: makeExecutionContext({ sessionPath: session.path }),
        modelSelection: makeModel(),
        activity,
    })
);

await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());
act(() => {
    client.emit(session.path, {
        type: "session_state",
        messages: [],
        turns: [],
        status: "idle",
        steer: [],
        followUp: [],
        commands: [snapshot],
    });
});
expect(result.current.commands[0]?.commandId).toBe("cmd-1");

act(() => activity.setActive(false));

expect(result.current.commands).toEqual([snapshot]);
expect(client.unsubscribed).toContain(session.path);
```

Remove the `visible: true` property from every other `usePiChat` invocation; omitted
activity means always active. Also update the usage example at the top of
`use-pi-chat.ts` so it no longer shows a `visible` option.

Add this boundary test:

```ts
test("keeps Agent session activity out of hook render inputs", () => {
    const chatHost = source("frontend/app/agent/agent-chat-host.tsx");
    const piChat = source("frontend/app/store/use-pi-chat.ts");

    expect(chatHost).not.toContain("useAgentSurfaceActive");
    expect(piChat).not.toMatch(/\bvisible\s*:\s*boolean/);
    expect(piChat).toContain("activity?: UsePiChatActivity");
});
```

- [ ] **Step 2: Run the hook test and verify RED**

Run:

```bash
npx vitest run frontend/app/store/use-pi-chat.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts --reporter=dot
```

Expected: FAIL because `UsePiChatOptions` has no `activity` contract and activity changes
cannot release or reacquire the subscription without rerendering.

- [ ] **Step 3: Replace `visible` with the narrow activity contract**

Add beside `UsePiChatOptions`:

```ts
export interface UsePiChatActivity {
    getActive(): boolean;
    subscribe(listener: (active: boolean) => void): () => void;
}

const AlwaysActivePiChatActivity: UsePiChatActivity = {
    getActive: () => true,
    subscribe: () => () => {},
};
```

Replace the `visible` field in `UsePiChatOptions` with:

```ts
/**
 * Renderer-local resource lifecycle. Activity changes must not be represented
 * as hook render state.
 */
activity?: UsePiChatActivity;
```

Inside `usePiChat`, add:

```ts
const activity = opts.activity ?? AlwaysActivePiChatActivity;
```

Replace the current session subscription effect with:

```tsx
useEffect(() => {
    let unsubscribeSession: (() => void) | undefined;
    let cancelled = false;

    const stopSubscription = () => {
        if (!unsubscribeSession) {
            return;
        }
        const unsubscribe = unsubscribeSession;
        unsubscribeSession = undefined;
        subscriptionEpochRef.current++;
        unsubscribe();
    };
    const startSubscription = () => {
        if (cancelled || unsubscribeSession || !sessionPath || !activity.getActive()) {
            return;
        }
        const api = runtimeClientRef.current;
        if (!api) {
            return;
        }
        const epoch = ++subscriptionEpochRef.current;
        const isCurrentSubscription = (): boolean =>
            !cancelled &&
            unsubscribeSession != null &&
            subscriptionEpochRef.current === epoch &&
            activeSessionPathRef.current === sessionPath;
        unsubscribeSession = api.subscribe(sessionPath, (raw) => {
            if (!isCurrentSubscription()) {
                return;
            }
            const event = raw as PiAgentEvent;
            setMessages((prev) => reducePiChatEvent(prev, event));
            setTurns((prev) => reducePiTurnsEvent(prev, event));
            switch (event.type) {
                case "session_state":
                    applySessionState(event, setStatus, setErrorMessage, setQueuedMessages, setCommands);
                    break;
                case "queue_update":
                    setQueuedMessages([...(event.steer ?? []), ...(event.followUp ?? [])]);
                    break;
                case "agent_start":
                case "turn_start":
                    setStatus("streaming");
                    setErrorMessage(undefined);
                    break;
                case "message_end":
                    if (event.message.role === "assistant" && event.message.stopReason === "error") {
                        setStatus("error");
                        setErrorMessage(event.message.errorMessage ?? "agent error");
                    }
                    break;
                case "agent_end":
                    setStatus((current) => (current === "error" ? current : "idle"));
                    break;
                case "abort":
                    setStatus("idle");
                    setErrorMessage(undefined);
                    break;
            }
        });
    };

    startSubscription();
    const unsubscribeActivity = activity.subscribe((active) => {
        if (active) {
            startSubscription();
            return;
        }
        stopSubscription();
    });
    return () => {
        cancelled = true;
        unsubscribeActivity();
        stopSubscription();
    };
}, [activity, sessionPath, controlledSessionRevision]);
```

- [ ] **Step 4: Pass the stable controller from `AgentChatHost`**

Replace `useAgentSurfaceActive` with `useAgentSurfaceActivityController` and change the
hook call to:

```tsx
const activity = useAgentSurfaceActivityController();
const chat = usePiChat({
    client: runtimeClient ?? UnavailableAgentRuntimeClient,
    executionContext: executionContext ?? MissingAgentExecutionContext,
    initialSession: sessionMetadata,
    controlledSession: { metadata: sessionMetadata, revision: sessionRevision },
    onSessionChange,
    modelSelection: effectiveSelection,
    activity,
    allowedTools,
});
```

In `agent-chat-host.test.tsx`, create a controller, wrap the host with
`<AgentSurfaceActivityProvider controller={controller}>`, and assert:

```tsx
expect(piChatMock.latestOptions.activity).toBe(controller);
expect(piChatMock.latestOptions).not.toHaveProperty("visible");
```

- [ ] **Step 5: Run hook and host tests**

Run:

```bash
npx vitest run frontend/app/store/use-pi-chat.test.tsx frontend/app/agent/agent-chat-host.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts --reporter=dot
```

Expected: both files PASS; activity toggles unsubscribe/resubscribe without increasing the
hook render count.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write frontend/app/store/use-pi-chat.ts frontend/app/store/use-pi-chat.test.tsx frontend/app/agent/agent-chat-host.tsx frontend/app/agent/agent-chat-host.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts
git add frontend/app/store/use-pi-chat.ts frontend/app/store/use-pi-chat.test.tsx frontend/app/agent/agent-chat-host.tsx frontend/app/agent/agent-chat-host.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts
git commit -m "refactor: decouple agent subscription activity"
```

### Task 4: Make PTY command lifecycle activity-driven without rendering

**Files:**
- Modify: `frontend/app/agent/agent-command-card.tsx`
- Modify: `frontend/app/agent/agent-command-card.test.tsx`
- Modify: `frontend/app/workspace/workspace-content-isolation-boundary.test.ts`

- [ ] **Step 1: Add failing controller lifecycle assertions**

Replace the hidden command test with:

```tsx
it("changes PTY resource activity without rerendering the command card", () => {
    const client = makeClient();
    const activity = makeAgentSurfaceActivityController(true);
    const renderProbe = vi.fn();

    function Probe() {
        renderProbe();
        return <AgentCommandCard client={client} session={session} snapshot={makeSnapshot()} />;
    }

    render(
        <AgentSurfaceActivityProvider controller={activity}>
            <Probe />
        </AgentSurfaceActivityProvider>
    );
    expect(renderProbe).toHaveBeenCalledTimes(1);

    act(() => activity.setActive(false));
    expect(renderProbe).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Command input"), { target: { value: "yes" } });
    fireEvent.keyDown(screen.getByLabelText("Command input"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Stop command" }));

    expect(client.commandWrite).not.toHaveBeenCalled();
    expect(client.commandStop).not.toHaveBeenCalled();
    expect(renderProbe).toHaveBeenCalledTimes(1);
});
```

Add the imports:

```tsx
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
    AgentSurfaceActivityProvider,
    makeAgentSurfaceActivityController,
} from "./agent-surface-activity";
```

Add this focused observer lifecycle test:

```tsx
it("disconnects and reconnects PTY measurement without rerendering", () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const instances: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
    class MockResizeObserver {
        observe = vi.fn();
        disconnect = vi.fn();

        constructor(_callback: ResizeObserverCallback) {
            instances.push(this);
        }
    }
    globalThis.ResizeObserver = MockResizeObserver as any;
    const activity = makeAgentSurfaceActivityController(true);
    const renderProbe = vi.fn();
    const client = makeClient();

    function Probe() {
        renderProbe();
        return <AgentCommandCard client={client} session={session} snapshot={makeSnapshot()} />;
    }

    try {
        render(
            <AgentSurfaceActivityProvider controller={activity}>
                <Probe />
            </AgentSurfaceActivityProvider>
        );
        expect(instances).toHaveLength(1);

        act(() => activity.setActive(false));
        expect(instances[0].disconnect).toHaveBeenCalledOnce();

        act(() => activity.setActive(true));
        expect(instances).toHaveLength(2);
        expect(renderProbe).toHaveBeenCalledTimes(1);
    } finally {
        globalThis.ResizeObserver = originalResizeObserver;
    }
});
```

Add this boundary test:

```ts
test("keeps PTY activity out of command-card render state", () => {
    const commandCard = source("frontend/app/agent/agent-command-card.tsx");

    expect(commandCard).not.toContain("useAgentSurfaceActive");
    expect(commandCard).toContain("useAgentSurfaceActivityController");
});
```

- [ ] **Step 2: Run the command card test and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/agent-command-card.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts --reporter=dot
```

Expected: FAIL because the component still consumes a rendered boolean and the Provider API
has changed.

- [ ] **Step 3: Replace rendered visibility with controller reads**

In `AgentCommandCard`, replace the activity hook and observer lifecycle with:

```tsx
const activity = useAgentSurfaceActivityController();
const [input, setInput] = useState("");
const screenMeasureRef = useRef<HTMLDivElement>(null);
const observerRef = useRef<ResizeObserver>(null);
const lastResizeRef = useRef("");

const reportMeasuredSize = useCallback(() => {
    if (!activity.getActive() || !snapshot.running) {
        return;
    }
    const element = screenMeasureRef.current;
    if (!element) {
        return;
    }
    const size = measureAgentCommandSize(element);
    const resizeKey = `${session.path}:${snapshot.commandId}:${size.cols}x${size.rows}`;
    if (lastResizeRef.current === resizeKey) {
        return;
    }
    lastResizeRef.current = resizeKey;
    void client.commandResize(session, snapshot.commandId, size.cols, size.rows);
}, [activity, client, session, snapshot.commandId, snapshot.running]);

const disconnectObserver = useCallback(() => {
    observerRef.current?.disconnect();
    observerRef.current = null;
}, []);

const connectObserver = useCallback(() => {
    if (!activity.getActive() || !snapshot.running) {
        return;
    }
    reportMeasuredSize();
    const element = screenMeasureRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
        return;
    }
    disconnectObserver();
    const observer = new ResizeObserver(reportMeasuredSize);
    observer.observe(element);
    observerRef.current = observer;
}, [activity, disconnectObserver, reportMeasuredSize, snapshot.running]);

useLayoutEffect(() => {
    connectObserver();
    const unsubscribe = activity.subscribe((active) => {
        if (active) {
            connectObserver();
            return;
        }
        disconnectObserver();
    });
    return () => {
        unsubscribe();
        disconnectObserver();
    };
}, [activity, connectObserver, disconnectObserver]);
```

Change input and command handlers to sample the controller:

```tsx
const submitInput = () => {
    if (!activity.getActive() || !snapshot.running || !input) {
        return;
    }
    void client.commandWrite(session, snapshot.commandId, `${input}\n`);
    setInput("");
};

const stopCommand = () => {
    if (!activity.getActive() || !snapshot.running) {
        return;
    }
    void client.commandStop(session, snapshot.commandId);
};
```

Change the input props to:

```tsx
disabled={!snapshot.running}
onChange={(event) => {
    if (!activity.getActive()) {
        return;
    }
    setInput(event.target.value);
}}
```

- [ ] **Step 4: Run command card and Agent content tests**

Run:

```bash
npx vitest run frontend/app/agent/agent-command-card.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/workspace/workspace-agent-content-slot.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts --reporter=dot
```

Expected: all files PASS; controller activity changes do not rerender the command card.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write frontend/app/agent/agent-command-card.tsx frontend/app/agent/agent-command-card.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts
git add frontend/app/agent/agent-command-card.tsx frontend/app/agent/agent-command-card.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts
git commit -m "refactor: decouple agent pty activity"
```

### Task 5: Gate cold File content on runtime readiness

**Files:**
- Create: `frontend/app/workspace/workspace-file-content-slot.tsx`
- Create: `frontend/app/workspace/workspace-file-content-slot.test.tsx`
- Modify: `frontend/app/workspace/top-tab-content-deck.tsx`
- Modify: `frontend/app/workspace/top-tab-content-deck.test.tsx`
- Modify: `frontend/app/workspace/workspace-content-isolation-boundary.test.ts`

- [ ] **Step 1: Write the failing cold/loading/ready slot tests**

Create `workspace-file-content-slot.test.tsx` with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TopTabSurfaceFactories } from "./top-tab-runtime-host";
import { WorkspaceTopTabRuntimeRegistry, type TopTabRuntimeSnapshot } from "./top-tab-runtime-registry";
import { WorkspaceFileContentSlot } from "./workspace-file-content-slot";

const Tab = { id: "file-a", kind: "file" as const, path: "/repo/a.ts", title: "a.ts" };

function makeRuntime() {
    let snapshot: TopTabRuntimeSnapshot = { dirty: false, title: "a.ts", status: "loading" };
    const listeners = new Set<() => void>();
    return {
        runtime: {
            getSnapshot: () => snapshot,
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            dispose: vi.fn(),
        },
        setStatus(status: TopTabRuntimeSnapshot["status"]) {
            snapshot = { ...snapshot, status };
            [...listeners].forEach((listener) => listener());
        },
    };
}

afterEach(cleanup);

describe("WorkspaceFileContentSlot", () => {
    it("renders File-owned loading without creating a runtime during static render", () => {
        const createRuntime = vi.fn();
        const factories = { renderFile: vi.fn() } as unknown as TopTabSurfaceFactories;

        const html = renderToString(
            <WorkspaceFileContentSlot
                active={true}
                tab={Tab}
                registry={new WorkspaceTopTabRuntimeRegistry()}
                createRuntime={createRuntime}
                factories={factories}
            />
        );

        expect(html).toContain("Loading a.ts");
        expect(createRuntime).not.toHaveBeenCalled();
        expect(factories.renderFile).not.toHaveBeenCalled();
    });

    it("keeps loading until runtime ready and then retains one content instance", async () => {
        const controlled = makeRuntime();
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const createRuntime = vi.fn(() => controlled.runtime);
        const fileBody = vi.fn(() => <div data-testid="file-editor">editor</div>);
        const factories = { renderFile: fileBody } as unknown as TopTabSurfaceFactories;
        const view = render(
            <WorkspaceFileContentSlot
                active={true}
                tab={Tab}
                registry={registry}
                createRuntime={createRuntime}
                factories={factories}
            />
        );

        expect(screen.getByRole("status").textContent).toBe("Loading a.ts");
        expect(fileBody).not.toHaveBeenCalled();

        act(() => controlled.setStatus("ready"));
        expect(await screen.findByTestId("file-editor")).toBeTruthy();
        expect(fileBody).toHaveBeenCalledTimes(1);
        const editor = screen.getByTestId("file-editor");

        view.rerender(
            <WorkspaceFileContentSlot
                active={false}
                tab={Tab}
                registry={registry}
                createRuntime={createRuntime}
                factories={factories}
            />
        );
        expect(screen.getByTestId("file-editor")).toBe(editor);
    });
});
```

Also add this test to `workspace-content-isolation-boundary.test.ts`:

```ts
test("keeps cold File loading separate from Monaco mounting", () => {
    const fileSlot = source("frontend/app/workspace/workspace-file-content-slot.tsx");

    expect(fileSlot).toContain('status === "ready" || status === "error"');
    expect(fileSlot).toContain("<LoadingFileSurface");
    expect(fileSlot).not.toMatch(/\b(setTimeout|requestAnimationFrame|useDeferredValue|startTransition)\b/);
});
```

- [ ] **Step 2: Run the File slot test and verify RED**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-file-content-slot.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts --reporter=dot
```

Expected: FAIL because `WorkspaceFileContentSlot` and its production source file do not
exist.

- [ ] **Step 3: Implement the File runtime gate**

Create `workspace-file-content-slot.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo, useEffect, useState } from "react";
import { TopTabRuntimeHost, type TopTabSurfaceFactories } from "./top-tab-runtime-host";
import type {
    TopTabRuntime,
    TopTabRuntimeSnapshot,
    WorkspaceTopTabRuntimeRegistry,
} from "./top-tab-runtime-registry";
import type { TopTab } from "./workspace-content-state";
import { WorkspaceContentSlot } from "./workspace-content-slot";

type FileTopTab = Extract<TopTab, { kind: "file" }>;

export interface WorkspaceFileContentSlotProps {
    active: boolean;
    tab: FileTopTab;
    registry: WorkspaceTopTabRuntimeRegistry;
    createRuntime(tab: TopTab): TopTabRuntime;
    factories: TopTabSurfaceFactories;
}

function LoadingFileSurface({ title }: { title: string }) {
    return (
        <div className="flex h-full items-center justify-center" role="status">
            {`Loading ${title}`}
        </div>
    );
}

const StableFileRuntimeHost = memo(function StableFileRuntimeHost({
    tab,
    registry,
    createRuntime,
    factories,
}: Omit<WorkspaceFileContentSlotProps, "active">) {
    return (
        <TopTabRuntimeHost
            activeTab={tab}
            registry={registry}
            createRuntime={createRuntime}
            factories={factories}
        />
    );
});
StableFileRuntimeHost.displayName = "StableFileRuntimeHost";

export function WorkspaceFileContentSlot({
    active,
    tab,
    registry,
    createRuntime,
    factories,
}: WorkspaceFileContentSlotProps) {
    const [runtimeSnapshot, setRuntimeSnapshot] = useState<TopTabRuntimeSnapshot>();

    useEffect(() => {
        const runtime = registry.getOrCreate(tab.id, () => createRuntime(tab));
        const update = () => setRuntimeSnapshot(runtime.getSnapshot());
        update();
        return runtime.subscribe(update);
    }, [createRuntime, registry, tab]);

    const status = runtimeSnapshot?.status;
    const showRuntime = status === "ready" || status === "error";
    return (
        <WorkspaceContentSlot active={active} testId={`file-top-tab-surface-${tab.id}`}>
            {showRuntime ? (
                <StableFileRuntimeHost
                    tab={tab}
                    registry={registry}
                    createRuntime={createRuntime}
                    factories={factories}
                />
            ) : (
                <LoadingFileSurface title={tab.title} />
            )}
        </WorkspaceContentSlot>
    );
}
```

Do not close the runtime in this component. Descriptor close and Workspace disposal remain
owned by the existing close coordinator and runtime registry.

- [ ] **Step 4: Compose the new slot in `TopTabContentDeck`**

Remove `StableFileRuntimeHost` and its comparator from `top-tab-content-deck.tsx`. Import
`WorkspaceFileContentSlot` and replace the File map body with:

```tsx
{fileTabs.map((tab) => {
    const active = activeFileTab?.id === tab.id;
    const mounted = activatedFileTabIds.has(tab.id);
    if (!active && !mounted) {
        return null;
    }
    return (
        <WorkspaceFileContentSlot
            active={active}
            key={tab.id}
            tab={tab}
            registry={registry}
            createRuntime={createRuntime}
            factories={factories}
        />
    );
})}
```

Delete `activeFileTabIsPending` and its unreachable extra branch. Keep the Preview/Git Diff
active-only path unchanged.

- [ ] **Step 5: Add deck-level cold File assertions**

In `top-tab-content-deck.test.tsx`, add:

```tsx
it("renders a cold File loading slot without creating runtime content during static render", () => {
    const factories = makeFactories();
    const createRuntime = vi.fn((tab: TopTab) => makeRuntime(tab.title));
    const html = renderToString(
        <TopTabContentDeck
            topTabs={[FileA]}
            activeTopTabId={FileA.id}
            registry={new WorkspaceTopTabRuntimeRegistry()}
            createRuntime={createRuntime}
            factories={factories}
        />
    );

    expect(html).toContain("Loading a.ts");
    expect(createRuntime).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run File deck and main content tests**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-file-content-slot.test.tsx frontend/app/workspace/top-tab-content-deck.test.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts --reporter=dot
```

Expected: all files PASS; cold/loading runtime states never call the File surface factory,
and retained ready editors keep their identity.

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write frontend/app/workspace/workspace-file-content-slot.tsx frontend/app/workspace/workspace-file-content-slot.test.tsx frontend/app/workspace/top-tab-content-deck.tsx frontend/app/workspace/top-tab-content-deck.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts
git add frontend/app/workspace/workspace-file-content-slot.tsx frontend/app/workspace/workspace-file-content-slot.test.tsx frontend/app/workspace/top-tab-content-deck.tsx frontend/app/workspace/top-tab-content-deck.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts
git commit -m "refactor: gate cold file content on runtime"
```

### Task 6: Strengthen architecture boundaries and verify the correction

**Files:**
- Modify: `docs/superpowers/specs/2026-07-26-workspace-content-isolation-design.md`
- Modify: `docs/agent-rendering-architecture.md`

- [ ] **Step 1: Update architecture status**

In `2026-07-26-workspace-content-isolation-design.md`, change the status to:

```markdown
- 状态：方案 A 已实现，待桌面运行时验收
```

In `docs/agent-rendering-architecture.md`, replace the Phase 4A activity paragraph with:

```markdown
Agent and activated File content live in isolated Workspace content slots.
Navigation changes update only slot activation. Agent resource activity is
delivered through one stable lifecycle controller whose listeners acquire or
release subscriptions and observers without becoming React render state.
Cold File slots retain their own loading surface and do not mount the
File/Monaco surface until the runtime reports ready.
```

- [ ] **Step 2: Run focused architecture suites**

Run:

```bash
npx vitest run frontend/app/agent/agent-surface-activity.test.tsx frontend/app/agent/agent-chat-host.test.tsx frontend/app/agent/agent-command-card.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/store/use-pi-chat.test.tsx frontend/app/workspace/workspace-agent-content-slot.test.tsx frontend/app/workspace/workspace-file-content-slot.test.tsx frontend/app/workspace/top-tab-content-deck.test.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts --reporter=dot
```

Expected: all listed files PASS with no unhandled subscription or ResizeObserver errors.

- [ ] **Step 3: Run the complete affected frontend suites**

Run:

```bash
npx vitest run frontend/app/agent frontend/app/store/use-pi-chat.test.tsx frontend/app/workspace frontend/app/topbar --reporter=dot
```

Expected: all affected test files PASS. Existing malformed-descriptor fixture logs and the
Browserslist age warning may remain; no new runtime exception is allowed.

- [ ] **Step 4: Run build and repository checks**

Run:

```bash
npm run build:dev
git diff --check
git status --short
```

Expected:

- `npm run build:dev` exits 0;
- existing Rollup circular-chunk, Vite browser-externalization, Browserslist, and optional
  `sharp` warnings may remain;
- `git diff --check` prints nothing;
- `git status --short` lists only the intended Task 6 documentation changes before commit.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write docs/superpowers/specs/2026-07-26-workspace-content-isolation-design.md docs/agent-rendering-architecture.md
git add -f docs/superpowers/specs/2026-07-26-workspace-content-isolation-design.md docs/agent-rendering-architecture.md
git commit -m "docs: record corrected workspace isolation"
```

## Desktop acceptance checklist

The automated work is complete only after the user validates the Electron runtime:

1. Open Agent with a long conversation and at least one running/completed command card.
2. Open two File tabs and wait for both editors to become ready.
3. Switch Agent → already loaded File ten times; no Agent text may remain for a frame.
4. Switch Agent → a never-opened File; File loading/content must replace Agent immediately.
5. Switch File A → Agent → File A; editor instance, unsaved text, cursor, selection, and
   scroll position must remain.
6. Let Agent continue in main while a File is active; returning to Agent must reacquire the
   session stream and display the authoritative state.
7. Close File through Tab close, close-active command, and File error Close; runtime/editor
   disposal must remain exact once.
