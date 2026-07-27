# Workspace Content Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate Agent and File content instances from Workspace navigation commits, retain activated File editors until close, and add the approved Soft Pill Top Tab styling with File Explorer icons.

**Architecture:** `WorkspaceMainContent` becomes a lightweight content coordinator. Stable Agent and File content trees live inside route-controlled `WorkspaceContentSlot` wrappers; Agent activity is delivered through a narrow context to the consumers that need it, while activated File runtime hosts remain mounted until their descriptors close. Cold File, Preview, and Git Diff activation first commits a target-owned loading slot, then mounts heavy content in a later commit, so old Agent content is never the pending UI.

**Tech Stack:** React 19, Jotai, TypeScript, Vitest/Testing Library, Monaco, Tailwind v4.

---

## Scope and execution protocol

- Work only in `/Users/bytedance/Documents/crest/.worktrees/workspace-renderer-phase1`.
- Keep the existing `ActiveContent`, checkpoint, Terminal renderer, Top Tab controller,
  runtime registry, and close coordinator contracts.
- Browser Top Tabs remain excluded.
- Do not use direct DOM mutation, timers, `requestAnimationFrame`, React deferred values,
  or an overlay that covers stale Agent content.
- Do not run `go build`.
- Use a fresh implementation subagent for each numbered task.
- After each task, run a spec-compliance review followed by a code-quality review before
  starting the next task.
- Review agents are read-only. Return every Important or blocking finding to the task's
  implementation agent, require a failing regression test for behavioral fixes, amend
  that task commit, and rerun both reviews before advancing.
- Keep the task commits separate. Do not squash them during implementation.

## Target file structure

Create these focused modules:

```text
frontend/app/agent/
  agent-surface-activity.tsx        Agent-only activity context and hook
  agent-surface-activity.test.tsx

frontend/app/workspace/
  workspace-content-slot.tsx        Lightweight hidden/inert content wrapper
  workspace-content-slot.test.tsx
  workspace-agent-content-slot.tsx  Stable Agent render boundary
  workspace-agent-content-slot.test.tsx
  top-tab-content-deck.tsx          Persistent File slots + ephemeral Preview/Diff
  top-tab-content-deck.test.tsx
  workspace-content-isolation-boundary.test.ts
```

Modify:

```text
frontend/app/agent/agent-content.tsx
frontend/app/agent/agent-content.test.tsx
frontend/app/agent/agent-chat-host.tsx
frontend/app/agent/agent-chat-host.test.tsx
frontend/app/agent/agent-command-card.tsx
frontend/app/agent/agent-command-card.test.tsx
frontend/app/workspace/workspace-main-content.tsx
frontend/app/workspace/workspace-main-content.test.tsx
frontend/app/workspace/workspace-app.test.tsx
frontend/app/workspace/top-tab-strip.tsx
frontend/app/workspace/top-tab-strip.test.tsx
frontend/app/topbar/fixed-agent-entry.tsx
frontend/app/topbar/fixed-agent-entry.test.tsx
docs/superpowers/specs/2026-07-23-workspace-tab-architecture-design.md
docs/superpowers/specs/2026-07-26-workspace-content-isolation-design.md
docs/agent-rendering-architecture.md
```

`TopTabRuntimeHost`, `WorkspaceTopTabRuntimeRegistry`, and
`WorkspaceEditorRegistry` remain the runtime owners. The new content deck composes them;
it does not duplicate their lifecycle logic.

### Task 1: Add the reusable Workspace content slot

**Files:**
- Create: `frontend/app/workspace/workspace-content-slot.tsx`
- Create: `frontend/app/workspace/workspace-content-slot.test.tsx`

- [ ] **Step 1: Write failing active/inactive slot tests**

Create `workspace-content-slot.test.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceContentSlot } from "./workspace-content-slot";

afterEach(cleanup);

describe("WorkspaceContentSlot", () => {
    it("changes only the wrapper activation attributes and preserves its child", () => {
        const view = render(
            <WorkspaceContentSlot active testId="file-slot">
                <div data-testid="content-instance">editor</div>
            </WorkspaceContentSlot>
        );
        const slot = screen.getByTestId("file-slot");
        const content = screen.getByTestId("content-instance");

        expect(slot.getAttribute("aria-hidden")).toBe("false");
        expect(slot.hasAttribute("inert")).toBe(false);
        expect(slot.style.visibility).toBe("visible");
        expect(slot.style.pointerEvents).toBe("auto");

        view.rerender(
            <WorkspaceContentSlot active={false} testId="file-slot">
                <div data-testid="content-instance">editor</div>
            </WorkspaceContentSlot>
        );

        expect(screen.getByTestId("file-slot")).toBe(slot);
        expect(screen.getByTestId("content-instance")).toBe(content);
        expect(slot.getAttribute("aria-hidden")).toBe("true");
        expect(slot.hasAttribute("inert")).toBe(true);
        expect(slot.style.visibility).toBe("hidden");
        expect(slot.style.pointerEvents).toBe("none");
    });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-content-slot.test.tsx --reporter=dot
```

Expected: FAIL because `workspace-content-slot.tsx` does not exist.

- [ ] **Step 3: Implement the slot**

Create `workspace-content-slot.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

export interface WorkspaceContentSlotProps {
    active: boolean;
    children: ReactNode;
    testId: string;
}

export function WorkspaceContentSlot({ active, children, testId }: WorkspaceContentSlotProps) {
    return (
        <section
            aria-hidden={!active}
            className="absolute inset-0 h-full w-full"
            data-testid={testId}
            inert={active ? undefined : true}
            style={{
                visibility: active ? "visible" : "hidden",
                pointerEvents: active ? "auto" : "none",
            }}
        >
            {children}
        </section>
    );
}
```

Do not put content-type logic, runtime creation, focus restoration, or state subscriptions
in this component.

- [ ] **Step 4: Run GREEN**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-content-slot.test.tsx --reporter=dot
```

Expected: 1 test PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write frontend/app/workspace/workspace-content-slot.tsx frontend/app/workspace/workspace-content-slot.test.tsx
git add frontend/app/workspace/workspace-content-slot.tsx frontend/app/workspace/workspace-content-slot.test.tsx
git commit -m "refactor: add workspace content slot"
```

### Task 2: Isolate Agent rendering from Workspace navigation

**Files:**
- Create: `frontend/app/agent/agent-surface-activity.tsx`
- Create: `frontend/app/agent/agent-surface-activity.test.tsx`
- Create: `frontend/app/workspace/workspace-agent-content-slot.tsx`
- Create: `frontend/app/workspace/workspace-agent-content-slot.test.tsx`
- Modify: `frontend/app/agent/agent-content.tsx`
- Modify: `frontend/app/agent/agent-content.test.tsx`
- Modify: `frontend/app/agent/agent-chat-host.tsx`
- Modify: `frontend/app/agent/agent-chat-host.test.tsx`
- Modify: `frontend/app/agent/agent-command-card.tsx`
- Modify: `frontend/app/agent/agent-command-card.test.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.test.tsx`

- [ ] **Step 1: Write the failing activity-context test**

Create `agent-surface-activity.test.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSurfaceActivityProvider, useAgentSurfaceActive } from "./agent-surface-activity";

function Consumer() {
    const active = useAgentSurfaceActive();
    return <div data-testid="activity">{String(active)}</div>;
}

afterEach(cleanup);

describe("Agent surface activity", () => {
    it("defaults to active and updates only subscribed consumers", () => {
        const defaultView = render(<Consumer />);
        expect(screen.getByTestId("activity").textContent).toBe("true");
        defaultView.unmount();

        const view = render(
            <AgentSurfaceActivityProvider active>
                <Consumer />
            </AgentSurfaceActivityProvider>
        );
        view.rerender(
            <AgentSurfaceActivityProvider active={false}>
                <Consumer />
            </AgentSurfaceActivityProvider>
        );
        expect(screen.getByTestId("activity").textContent).toBe("false");
    });
});
```

- [ ] **Step 2: Write the failing stable-Agent-slot test**

Create `workspace-agent-content-slot.test.tsx`. Mock `AgentContent` with a render counter,
then prove an activity change preserves the same Agent node and does not call the root
component again:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAgentContentSlot } from "./workspace-agent-content-slot";

const agentRender = vi.hoisted(() => vi.fn());

vi.mock("@/app/agent/agent-content", () => ({
    AgentContent: (props: unknown) => {
        agentRender(props);
        return <div data-testid="stable-agent-content">Agent</div>;
    },
}));

afterEach(() => {
    cleanup();
    agentRender.mockClear();
});

describe("WorkspaceAgentContentSlot", () => {
    it("updates slot activity without rerendering the Agent root", () => {
        const props = {
            mounted: true,
            active: true,
            model: {} as any,
            client: {} as any,
            executionContext: {
                workspaceId: "workspace-1",
                workspaceDir: "/repo",
                connection: "",
                environment: {},
            },
        };
        const view = render(<WorkspaceAgentContentSlot {...props} />);
        const content = screen.getByTestId("stable-agent-content");

        view.rerender(<WorkspaceAgentContentSlot {...props} active={false} />);

        expect(screen.getByTestId("stable-agent-content")).toBe(content);
        expect(agentRender).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("agent-surface").getAttribute("aria-hidden")).toBe("true");
        expect(screen.getByTestId("agent-surface").hasAttribute("inert")).toBe(true);
    });
});
```

- [ ] **Step 3: Run RED**

Run:

```bash
npx vitest run frontend/app/agent/agent-surface-activity.test.tsx frontend/app/workspace/workspace-agent-content-slot.test.tsx --reporter=dot
```

Expected: both test files FAIL because their production modules do not exist.

- [ ] **Step 4: Implement the activity context**

Create `agent-surface-activity.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, type ReactNode } from "react";

const AgentSurfaceActivityContext = createContext(true);

export function AgentSurfaceActivityProvider({ active, children }: { active: boolean; children: ReactNode }) {
    return <AgentSurfaceActivityContext.Provider value={active}>{children}</AgentSurfaceActivityContext.Provider>;
}

export function useAgentSurfaceActive(): boolean {
    return useContext(AgentSurfaceActivityContext);
}
```

- [ ] **Step 5: Move activity consumers below the Agent root**

In `agent-chat-host.tsx`:

1. Import `useAgentSurfaceActive`.
2. Remove `visible?: boolean` from `AgentChatHostProps`.
3. Remove `visible = true` from the function parameters.
4. Insert the activity hook immediately before the existing `effectiveSelection`
   declaration:

```tsx
const visible = useAgentSurfaceActive();
const effectiveSelection: UsePiChatModel = modelSelection ?? {
    provider: "",
    model: "",
};
```

Continue passing `visible` to `usePiChat`; do not change `usePiChat` subscription semantics.

In `agent-command-card.tsx`, replace the function signature and insert the hook before
`useState`:

```tsx
import { useAgentSurfaceActive } from "./agent-surface-activity";

export function AgentCommandCard({
    client,
    session,
    snapshot,
}: {
    client: AgentRuntimeClient;
    session: AgentSessionMeta;
    snapshot: AgentPtySnapshot;
}) {
    const visible = useAgentSurfaceActive();
    const [input, setInput] = useState("");
```

Update `agent-chat-host.test.tsx` and `agent-command-card.test.tsx` so inactive cases wrap
their existing component invocation with the provider. The resulting outer shape for the
chat host is:

```tsx
<AgentSurfaceActivityProvider active={false}>
    <AgentChatHost
        runtimeClient={client}
        executionContext={executionContext}
        sessionMetadata={session}
        modelSelection={modelSelection}
    />
</AgentSurfaceActivityProvider>
```

The resulting outer shape for a command card is:

```tsx
<AgentSurfaceActivityProvider active={false}>
    <AgentCommandCard client={client} session={session} snapshot={snapshot} />
</AgentSurfaceActivityProvider>
```

Active/default cases need no provider because the context defaults to `true`.

- [ ] **Step 6: Remove navigation visibility from `AgentContent`**

Change the public props to:

```tsx
export interface AgentContentProps {
    model: WorkspaceAgentModel;
    client: AgentRuntimeClient;
    executionContext: AgentExecutionContext;
}
```

Change the function signature:

```tsx
export function AgentContent({ model, client, executionContext }: AgentContentProps) {
```

Keep its root section mounted. Replace its opening tag with:

```tsx
<section className="h-full w-full" data-testid="agent-content">
```

Delete `aria-hidden`, `visibility`, and `pointerEvents` from that root. Remove
`visible={visible}` from `AgentChatHost` and every `AgentCommandCard`; leave every other
existing callback and child unchanged. Rewrite the existing `agent-content.test.tsx`
hidden-state case to rerender the same three-prop `AgentContent`, then verify the Prompt
DOM node and its `"draft"` value survive. Slot visibility is tested in
`workspace-agent-content-slot.test.tsx`.

- [ ] **Step 7: Implement the stable Agent content slot**

Create `workspace-agent-content-slot.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AgentContent } from "@/app/agent/agent-content";
import type { AgentRuntimeClient } from "@/app/agent/agent-runtime-client";
import { AgentSurfaceActivityProvider } from "@/app/agent/agent-surface-activity";
import { memo } from "react";
import type { WorkspaceAgentModel } from "./workspace-agent-model";
import { WorkspaceContentSlot } from "./workspace-content-slot";

const StableAgentContent = memo(AgentContent);
StableAgentContent.displayName = "StableAgentContent";

export interface WorkspaceAgentContentSlotProps {
    active: boolean;
    mounted: boolean;
    model?: WorkspaceAgentModel;
    client?: AgentRuntimeClient;
    executionContext?: AgentExecutionContext;
}

export function WorkspaceAgentContentSlot({
    active,
    mounted,
    model,
    client,
    executionContext,
}: WorkspaceAgentContentSlotProps) {
    if (!mounted) {
        return null;
    }
    return (
        <WorkspaceContentSlot active={active} testId="agent-surface">
            <AgentSurfaceActivityProvider active={active}>
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

- [ ] **Step 8: Integrate the Agent slot**

In `workspace-main-content.tsx`:

- Remove the direct `AgentContent` import.
- Import `WorkspaceAgentContentSlot`.
- Keep `hasActivatedAgent` and its current activation effect.
- Replace the direct Agent `<section>` with:

```tsx
<WorkspaceAgentContentSlot
    active={activeContent.kind === "agent"}
    mounted={hasActivatedAgent}
    model={agentModel}
    client={agentClient}
    executionContext={agentExecutionContext}
/>
```

Replace the existing “keeps the agent surface mounted while other identities change”
case in `workspace-main-content.test.tsx` with:

```tsx
it("keeps one Agent slot and changes only its activation state", () => {
    const view = render(<WorkspaceMainContent {...makeProps({ activeContent: { kind: "agent" } })} />);
    const agent = screen.getByTestId("agent-surface");

    view.rerender(
        <WorkspaceMainContent
            {...makeProps({ activeContent: { kind: "top-tab", topTabId: "file-a" } })}
        />
    );

    expect(screen.getByTestId("agent-surface")).toBe(agent);
    expect(agent.getAttribute("aria-hidden")).toBe("true");
    expect(agent.hasAttribute("inert")).toBe(true);
});
```

The root render-count guarantee remains owned by
`workspace-agent-content-slot.test.tsx`.

- [ ] **Step 9: Run GREEN**

Run:

```bash
npx vitest run frontend/app/agent/agent-surface-activity.test.tsx frontend/app/agent/agent-chat-host.test.tsx frontend/app/agent/agent-command-card.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/workspace/workspace-content-slot.test.tsx frontend/app/workspace/workspace-agent-content-slot.test.tsx frontend/app/workspace/workspace-main-content.test.tsx --reporter=dot
```

Expected: all listed tests PASS; no unhandled subscription or ResizeObserver errors.

- [ ] **Step 10: Format and commit**

```bash
npx prettier --write frontend/app/agent/agent-surface-activity.tsx frontend/app/agent/agent-surface-activity.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/agent-chat-host.tsx frontend/app/agent/agent-chat-host.test.tsx frontend/app/agent/agent-command-card.tsx frontend/app/agent/agent-command-card.test.tsx frontend/app/workspace/workspace-agent-content-slot.tsx frontend/app/workspace/workspace-agent-content-slot.test.tsx frontend/app/workspace/workspace-main-content.tsx frontend/app/workspace/workspace-main-content.test.tsx
git add frontend/app/agent/agent-surface-activity.tsx frontend/app/agent/agent-surface-activity.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/agent-chat-host.tsx frontend/app/agent/agent-chat-host.test.tsx frontend/app/agent/agent-command-card.tsx frontend/app/agent/agent-command-card.test.tsx frontend/app/workspace/workspace-agent-content-slot.tsx frontend/app/workspace/workspace-agent-content-slot.test.tsx frontend/app/workspace/workspace-main-content.tsx frontend/app/workspace/workspace-main-content.test.tsx
git commit -m "refactor: isolate workspace agent content"
```

### Task 3: Retain activated File content instances

**Files:**
- Create: `frontend/app/workspace/top-tab-content-deck.tsx`
- Create: `frontend/app/workspace/top-tab-content-deck.test.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.test.tsx`
- Modify: `frontend/app/workspace/workspace-app.test.tsx`
- Modify: `frontend/app/workspace/top-tab-runtime-host.test.tsx`

- [ ] **Step 1: Write failing content-deck tests**

Create `top-tab-content-deck.test.tsx` with this setup:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopTabContentDeck, type TopTabContentDeckProps } from "./top-tab-content-deck";
import type { TopTabRuntime } from "./top-tab-runtime-registry";
import { WorkspaceTopTabRuntimeRegistry } from "./top-tab-runtime-registry";
import type { TopTab } from "./workspace-content-state";

const FileTab: TopTab = { id: "file-1", kind: "file", path: "/repo/a.ts", title: "a.ts" };
const PreviewTab: TopTab = { id: "preview-1", kind: "preview", path: "/repo/a.md", title: "a.md" };
const DiffTab: TopTab = {
    id: "diff-1",
    kind: "git-diff",
    repoRoot: "/repo",
    path: "/repo/a.ts",
    mode: "+",
    originalPath: "/repo/a.ts",
    title: "a.ts changes",
};

function runtime(title: string): TopTabRuntime {
    return {
        getSnapshot: () => ({ dirty: false, title, status: "ready" }),
        subscribe: () => () => {},
        dispose: vi.fn(),
    };
}

function factories() {
    return {
        renderFile: (tab: Extract<TopTab, { kind: "file" }>) => <div>file:{tab.id}</div>,
        renderPreview: (tab: Extract<TopTab, { kind: "preview" }>) => <div>preview:{tab.id}</div>,
        renderGitDiff: (tab: Extract<TopTab, { kind: "git-diff" }>) => <div>diff:{tab.id}</div>,
    };
}

function makeDeckProps(overrides: Partial<TopTabContentDeckProps> = {}): TopTabContentDeckProps {
    return {
        topTabs: [FileTab],
        activeTopTabId: "file-1",
        registry: new WorkspaceTopTabRuntimeRegistry(),
        createRuntime: (tab) => runtime(tab.title),
        factories: factories(),
        ...overrides,
    };
}

afterEach(cleanup);
```

Add these independent behaviors:

```tsx
it("shows a cold File loading slot before mounting its runtime host", () => {
    const renderFile = vi.fn(() => <div>file editor</div>);
    const markup = renderToStaticMarkup(
        <TopTabContentDeck
            topTabs={[FileTab]}
            activeTopTabId="file-1"
            registry={new WorkspaceTopTabRuntimeRegistry()}
            createRuntime={() => runtime("a.ts")}
            factories={{ ...factories(), renderFile }}
        />
    );

    expect(markup).toContain("Loading a.ts");
    expect(renderFile).not.toHaveBeenCalled();
});
```

```tsx
it("retains an activated File instance across Agent and File switches", async () => {
    const lifecycle = { mounts: 0, unmounts: 0 };
    function FileSurface() {
        useEffect(() => {
            lifecycle.mounts++;
            return () => {
                lifecycle.unmounts++;
            };
        }, []);
        return <div data-testid="file-instance">editor</div>;
    }
    const props = makeDeckProps({
        topTabs: [FileTab],
        activeTopTabId: "file-1",
        factories: { ...factories(), renderFile: () => <FileSurface /> },
    });
    const view = render(<TopTabContentDeck {...props} />);
    const instance = await screen.findByTestId("file-instance");

    view.rerender(<TopTabContentDeck {...props} activeTopTabId={undefined} />);
    expect(screen.getByTestId("file-instance")).toBe(instance);
    expect(screen.getByTestId("file-top-tab-surface-file-1").getAttribute("aria-hidden")).toBe("true");

    view.rerender(<TopTabContentDeck {...props} activeTopTabId="file-1" />);
    expect(screen.getByTestId("file-instance")).toBe(instance);
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
});
```

```tsx
it("unmounts a File instance only after its descriptor is removed", async () => {
    const onUnmount = vi.fn();
    function FileSurface() {
        useEffect(() => onUnmount, []);
        return <div>editor</div>;
    }
    const props = makeDeckProps({
        topTabs: [FileTab],
        activeTopTabId: "file-1",
        factories: { ...factories(), renderFile: () => <FileSurface /> },
    });
    const view = render(<TopTabContentDeck {...props} />);
    await screen.findByText("editor");

    view.rerender(<TopTabContentDeck {...props} topTabs={[]} activeTopTabId={undefined} />);
    expect(onUnmount).toHaveBeenCalledOnce();
});
```

Add the same target-owned first-paint guarantee for active-only surfaces:

```tsx
it.each([PreviewTab, DiffTab])("shows $kind loading before mounting heavy content", (tab) => {
    const renderPreview = vi.fn(factories().renderPreview);
    const renderGitDiff = vi.fn(factories().renderGitDiff);
    const markup = renderToStaticMarkup(
        <TopTabContentDeck
            {...makeDeckProps({
                topTabs: [tab],
                activeTopTabId: tab.id,
                factories: { ...factories(), renderPreview, renderGitDiff },
            })}
        />
    );

    expect(markup).toContain(`Loading ${tab.title}`);
    expect(renderPreview).not.toHaveBeenCalled();
    expect(renderGitDiff).not.toHaveBeenCalled();
});
```

Use this client-side lifecycle case to prove Preview and Git Diff mount after the loading
commit and unmount as soon as navigation leaves them:

```tsx
it.each([PreviewTab, DiffTab])("keeps $kind active-only", async (tab) => {
    const onUnmount = vi.fn();
    function EphemeralSurface() {
        useEffect(() => onUnmount, []);
        return <div data-testid="ephemeral-instance">ephemeral</div>;
    }
    const tabFactories = factories();
    if (tab.kind === "preview") {
        tabFactories.renderPreview = () => <EphemeralSurface />;
    } else {
        tabFactories.renderGitDiff = () => <EphemeralSurface />;
    }
    const props = makeDeckProps({
        topTabs: [tab],
        activeTopTabId: tab.id,
        factories: tabFactories,
    });
    const view = render(<TopTabContentDeck {...props} />);
    await screen.findByTestId("ephemeral-instance");

    view.rerender(<TopTabContentDeck {...props} activeTopTabId={undefined} />);

    expect(screen.queryByTestId("ephemeral-instance")).toBeNull();
    expect(onUnmount).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run frontend/app/workspace/top-tab-content-deck.test.tsx --reporter=dot
```

Expected: FAIL because `top-tab-content-deck.tsx` does not exist.

- [ ] **Step 3: Implement the content deck**

Create `top-tab-content-deck.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo, useEffect, useMemo, useState } from "react";
import { TopTabRuntimeHost, type TopTabSurfaceFactories } from "./top-tab-runtime-host";
import type { TopTabRuntime, WorkspaceTopTabRuntimeRegistry } from "./top-tab-runtime-registry";
import type { TopTab } from "./workspace-content-state";
import { WorkspaceContentSlot } from "./workspace-content-slot";

type FileTopTab = Extract<TopTab, { kind: "file" }>;

interface StableFileRuntimeHostProps {
    tab: FileTopTab;
    registry: WorkspaceTopTabRuntimeRegistry;
    createRuntime(tab: TopTab): TopTabRuntime;
    factories: TopTabSurfaceFactories;
}

function fileDescriptorEqual(left: FileTopTab, right: FileTopTab): boolean {
    return left.id === right.id && left.path === right.path && left.title === right.title;
}

const StableFileRuntimeHost = memo(
    ({ tab, registry, createRuntime, factories }: StableFileRuntimeHostProps) => (
        <TopTabRuntimeHost activeTab={tab} registry={registry} createRuntime={createRuntime} factories={factories} />
    ),
    (left, right) =>
        fileDescriptorEqual(left.tab, right.tab) &&
        left.registry === right.registry &&
        left.createRuntime === right.createRuntime &&
        left.factories === right.factories
);
StableFileRuntimeHost.displayName = "StableFileRuntimeHost";

export interface TopTabContentDeckProps {
    topTabs: TopTab[];
    activeTopTabId?: string;
    registry: WorkspaceTopTabRuntimeRegistry;
    createRuntime(tab: TopTab): TopTabRuntime;
    factories: TopTabSurfaceFactories;
}

export function TopTabContentDeck({
    topTabs,
    activeTopTabId,
    registry,
    createRuntime,
    factories,
}: TopTabContentDeckProps) {
    const [activatedFileTabIds, setActivatedFileTabIds] = useState<ReadonlySet<string>>(() => new Set());
    const activeTopTab = topTabs.find((tab) => tab.id === activeTopTabId);
    const activeFileTabId = activeTopTab?.kind === "file" ? activeTopTab.id : undefined;
    const liveFileTabIdKey = topTabs
        .filter((tab) => tab.kind === "file")
        .map((tab) => tab.id)
        .join("\u0000");
    const liveFileTabIds = useMemo(
        () => new Set(liveFileTabIdKey.split("\u0000").filter(Boolean)),
        [liveFileTabIdKey]
    );

    useEffect(() => {
        setActivatedFileTabIds((current) => {
            const next = new Set([...current].filter((id) => liveFileTabIds.has(id)));
            if (activeFileTabId) {
                next.add(activeFileTabId);
            }
            if (next.size === current.size && [...next].every((id) => current.has(id))) {
                return current;
            }
            return next;
        });
    }, [activeFileTabId, liveFileTabIds]);

    const mountedFileTabs = topTabs.filter(
        (tab): tab is FileTopTab => tab.kind === "file" && activatedFileTabIds.has(tab.id)
    );
    const pendingFileTab =
        activeTopTab?.kind === "file" && !activatedFileTabIds.has(activeTopTab.id) ? activeTopTab : undefined;
    const activeEphemeralTopTab = activeTopTab?.kind !== "file" ? activeTopTab : undefined;
    const [mountedEphemeralTopTabId, setMountedEphemeralTopTabId] = useState<string>();

    useEffect(() => {
        setMountedEphemeralTopTabId(activeEphemeralTopTab?.id);
    }, [activeEphemeralTopTab?.id]);

    const mountedEphemeralTopTab =
        activeEphemeralTopTab?.id === mountedEphemeralTopTabId ? activeEphemeralTopTab : undefined;
    const pendingEphemeralTopTab =
        activeEphemeralTopTab && !mountedEphemeralTopTab ? activeEphemeralTopTab : undefined;

    return (
        <>
            {mountedFileTabs.map((tab) => (
                <WorkspaceContentSlot
                    active={tab.id === activeTopTabId}
                    key={tab.id}
                    testId={`file-top-tab-surface-${tab.id}`}
                >
                    <StableFileRuntimeHost
                        tab={tab}
                        registry={registry}
                        createRuntime={createRuntime}
                        factories={factories}
                    />
                </WorkspaceContentSlot>
            ))}
            {pendingFileTab ? (
                <WorkspaceContentSlot active testId="file-top-tab-loading-surface">
                    <div className="flex h-full items-center justify-center" role="status">
                        Loading {pendingFileTab.title}…
                    </div>
                </WorkspaceContentSlot>
            ) : null}
            {pendingEphemeralTopTab ? (
                <WorkspaceContentSlot active testId="ephemeral-top-tab-loading-surface">
                    <div className="flex h-full items-center justify-center" role="status">
                        Loading {pendingEphemeralTopTab.title}…
                    </div>
                </WorkspaceContentSlot>
            ) : null}
            {mountedEphemeralTopTab ? (
                <WorkspaceContentSlot active key={mountedEphemeralTopTab.id} testId="ephemeral-top-tab-surface">
                    <TopTabRuntimeHost
                        activeTab={mountedEphemeralTopTab}
                        registry={registry}
                        createRuntime={createRuntime}
                        factories={factories}
                    />
                </WorkspaceContentSlot>
            ) : null}
        </>
    );
}
```

- [ ] **Step 4: Integrate the deck into `WorkspaceMainContent`**

Import `TopTabContentDeck`. Remove the local `activeTopTab` lookup and the keyed
active-only wrapper:

```tsx
<TopTabContentDeck
    topTabs={topTabs}
    activeTopTabId={activeContent.kind === "top-tab" ? activeContent.topTabId : undefined}
    registry={runtimeRegistry}
    createRuntime={createRuntime}
    factories={surfaceFactories}
/>
```

The deck must be a sibling of `WorkspaceAgentContentSlot` and `TerminalPlaceholder` inside
the existing measured content rectangle.

Delete this old shape:

```tsx
<div key={activeTopTab?.id}>
    <TopTabRuntimeHost activeTab={activeTopTab} />
</div>
```

- [ ] **Step 5: Rewrite Workspace lifecycle assertions**

In `workspace-main-content.test.tsx`:

- Replace “top-tab surfaces remount when identity changes” with assertions that File A and
  File B acquire independent stable slots.
- Switch File A → Agent → File A and assert the same File A content node remains.
- Verify Preview/Diff still use `ephemeral-top-tab-surface` and unmount on switch.
- Verify cold File and cold Preview/Diff initially produce their respective loading
  surfaces without invoking heavy factories during server render.

In `workspace-app.test.tsx`, rewrite the production File preservation test:

```tsx
const editor = await screen.findByTestId("workspace-file-editor");
const model = fileEditor.props.model;

fireEvent.click(screen.getByRole("button", { name: "Agent" }));
expect(screen.getByTestId("workspace-file-editor")).toBe(editor);
expect(editor.closest('[data-testid^="file-top-tab-surface-"]')?.getAttribute("aria-hidden")).toBe("true");

fireEvent.click(screen.getByRole("tab", { name: "integration.ts, unsaved changes" }));
expect(screen.getByTestId("workspace-file-editor")).toBe(editor);
expect(fileEditor.props.model).toBe(model);
```

Retain the existing dirty-buffer and workspace replacement disposal assertions.

In `top-tab-runtime-host.test.tsx`, keep runtime registry retention coverage but change any
wording that implies the React File surface is intentionally unmounted during normal
navigation.

- [ ] **Step 6: Run GREEN**

Run:

```bash
npx vitest run frontend/app/workspace/top-tab-content-deck.test.tsx frontend/app/workspace/top-tab-runtime-host.test.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/workspace/workspace-app.test.tsx --reporter=dot
```

Expected: all listed tests PASS. The File editor mount count remains one through
Agent/File switching, and Preview/Diff disposal tests remain green.

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write frontend/app/workspace/top-tab-content-deck.tsx frontend/app/workspace/top-tab-content-deck.test.tsx frontend/app/workspace/workspace-main-content.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/workspace/workspace-app.test.tsx frontend/app/workspace/top-tab-runtime-host.test.tsx
git add frontend/app/workspace/top-tab-content-deck.tsx frontend/app/workspace/top-tab-content-deck.test.tsx frontend/app/workspace/workspace-main-content.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/workspace/workspace-app.test.tsx frontend/app/workspace/top-tab-runtime-host.test.tsx
git commit -m "refactor: retain workspace file content"
```

### Task 4: Add Soft Pill Top Tabs and file-type icons

**Files:**
- Modify: `frontend/app/workspace/top-tab-strip.tsx`
- Modify: `frontend/app/workspace/top-tab-strip.test.tsx`
- Modify: `frontend/app/topbar/fixed-agent-entry.tsx`
- Modify: `frontend/app/topbar/fixed-agent-entry.test.tsx`

- [ ] **Step 1: Write failing icon and visual-state tests**

At the top of `top-tab-strip.test.tsx`, mock the shared icon resolver:

```tsx
const fileIcon = vi.hoisted(() => ({
    get: vi.fn(
        (name: string) =>
            ({ className, size }: { className?: string; size?: number }) => (
                <svg className={className} data-file-icon={name} data-size={size} />
            )
    ),
}));

vi.mock("@/app/fileexplorer/file-icon", () => ({
    getFileIcon: fileIcon.get,
}));
```

Add:

```tsx
it("renders File Explorer icons from descriptor paths", () => {
    const tabs: TopTab[] = [
        { id: "file-ts", kind: "file", path: "/repo/src/agent-ipc.ts", title: "renamed title" },
        { id: "file-tsx", kind: "file", path: "/repo/src/app.tsx", title: "app.tsx" },
        { id: "file-json", kind: "file", path: "/repo/package.json", title: "package.json" },
        { id: "file-md", kind: "file", path: "/repo/README.md", title: "README.md" },
        { id: "file-unknown", kind: "file", path: "/repo/NOTICE.crest", title: "NOTICE.crest" },
    ];
    render(
        <TopTabStrip
            tabs={tabs}
            activeTopTabId="file-ts"
            registry={new WorkspaceTopTabRuntimeRegistry()}
            onActivate={vi.fn()}
            onClose={vi.fn().mockResolvedValue(true)}
            onReorder={vi.fn()}
        />
    );

    expect(fileIcon.get).toHaveBeenCalledWith("agent-ipc.ts", false, false);
    expect(fileIcon.get).toHaveBeenCalledWith("app.tsx", false, false);
    expect(fileIcon.get).toHaveBeenCalledWith("package.json", false, false);
    expect(fileIcon.get).toHaveBeenCalledWith("README.md", false, false);
    expect(fileIcon.get).toHaveBeenCalledWith("NOTICE.crest", false, false);
    expect(document.querySelector('[data-file-icon="agent-ipc.ts"]')?.getAttribute("data-size")).toBe("14");
});
```

Add:

```tsx
it("uses the approved Soft Pill selected and inactive states", () => {
    render(
        <TopTabStrip
            tabs={Tabs}
            activeTopTabId="file-1"
            registry={new WorkspaceTopTabRuntimeRegistry()}
            onActivate={vi.fn()}
            onClose={vi.fn().mockResolvedValue(true)}
            onReorder={vi.fn()}
        />
    );

    const activeItem = screen.getByRole("tab", { name: "app.ts" }).parentElement;
    const inactiveItem = screen.getByRole("tab", { name: "test.ts" }).parentElement;
    expect(activeItem?.className).toContain("h-7");
    expect(activeItem?.className).toContain("rounded-md");
    expect(activeItem?.className).toContain("bg-fg-overlay-2");
    expect(inactiveItem?.className).toContain("hover:bg-fg-overlay-1");
});
```

In `fixed-agent-entry.test.tsx`, assert the fixed entry uses the same 28px geometry and
selected token:

```tsx
expect(entry.className).toContain("h-7");
expect(entry.className).toContain("rounded-md");
expect(entry.className).toContain("bg-fg-overlay-2");
```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run frontend/app/workspace/top-tab-strip.test.tsx frontend/app/topbar/fixed-agent-entry.test.tsx --reporter=dot
```

Expected: FAIL because Top Tabs have no icons or Soft Pill classes and Agent still uses
22px height/legacy selected color.

- [ ] **Step 3: Implement path-based icons and Soft Pill classes**

In `top-tab-strip.tsx`, import:

```tsx
import { getFileIcon } from "@/app/fileexplorer/file-icon";
import { cn } from "@/util/util";
```

Add:

```tsx
function fileNameForTopTab(tab: TopTab): string {
    const normalizedPath = tab.path.replace(/\\/g, "/");
    return normalizedPath.split("/").filter(Boolean).at(-1) ?? tab.title;
}
```

Inside `TopTabButton`, resolve the icon from the descriptor, not the runtime title:

```tsx
const FileIcon = getFileIcon(fileNameForTopTab(tab), false, false);
```

Replace the button group markup with:

```tsx
<div
    className={cn(
        "group flex h-7 min-w-0 max-w-56 shrink-0 items-center rounded-md px-1 text-[13px] transition-colors",
        selected
            ? "bg-fg-overlay-2 text-primary"
            : "text-secondary hover:bg-fg-overlay-1 hover:text-primary"
    )}
    role="presentation"
>
    <button
        aria-label={label}
        aria-selected={selected}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm px-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        draggable={false}
        ref={tabRef}
        role="tab"
        tabIndex={tabStop ? 0 : -1}
        title={snapshot.title}
        type="button"
        onClick={onActivate}
        onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onActivate();
                return;
            }
            onKeyDown(event);
        }}
        onLostPointerCapture={onLostPointerCapture}
        onPointerCancel={onPointerCancel}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
    >
        <FileIcon aria-hidden="true" className="size-3.5 shrink-0" size={14} />
        <span className="truncate">{snapshot.title}</span>
        {snapshot.dirty ? (
            <span aria-hidden="true" className="shrink-0" data-testid={`top-tab-dirty-${tab.id}`}>
                •
            </span>
        ) : null}
    </button>
    <button
        aria-label={`Close ${snapshot.title}`}
        className="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-secondary/70 transition-colors hover:bg-fg-overlay-2 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        type="button"
        onClick={onClose}
    >
        ×
    </button>
</div>
```

Keep the existing pointer reorder, keyboard navigation, close coordinator, runtime title,
and dirty subscriptions unchanged.

- [ ] **Step 4: Align the fixed Agent entry**

In `fixed-agent-entry.tsx`, use the same height and state tokens:

```tsx
className={cn(
    "mx-0.5 flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[13px] font-medium transition-colors",
    active ? "bg-fg-overlay-2 text-primary" : "text-secondary hover:bg-fg-overlay-1 hover:text-primary"
)}
```

Do not move Agent into `TopTab[]` and do not add close/reorder behavior.

- [ ] **Step 5: Run GREEN**

Run:

```bash
npx vitest run frontend/app/workspace/top-tab-strip.test.tsx frontend/app/topbar/fixed-agent-entry.test.tsx frontend/app/topbar/topbar.test.tsx --reporter=dot
```

Expected: all listed tests PASS. Existing activate/close/reorder/dirty/keyboard tests remain
green.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write frontend/app/workspace/top-tab-strip.tsx frontend/app/workspace/top-tab-strip.test.tsx frontend/app/topbar/fixed-agent-entry.tsx frontend/app/topbar/fixed-agent-entry.test.tsx
git add frontend/app/workspace/top-tab-strip.tsx frontend/app/workspace/top-tab-strip.test.tsx frontend/app/topbar/fixed-agent-entry.tsx frontend/app/topbar/fixed-agent-entry.test.tsx
git commit -m "feat: style workspace file tabs"
```

### Task 5: Add architecture guards, documentation, and final verification

**Files:**
- Create: `frontend/app/workspace/workspace-content-isolation-boundary.test.ts`
- Modify: `docs/superpowers/specs/2026-07-23-workspace-tab-architecture-design.md`
- Modify: `docs/superpowers/specs/2026-07-26-workspace-content-isolation-design.md`
- Modify: `docs/agent-rendering-architecture.md`

- [ ] **Step 1: Write the failing source-boundary test**

Create `workspace-content-isolation-boundary.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(join(process.cwd(), path), "utf8");
}

describe("Workspace content isolation boundary", () => {
    it("keeps navigation visibility out of the Agent root", () => {
        const agentContent = source("frontend/app/agent/agent-content.tsx");
        expect(agentContent).not.toMatch(/\bvisible\s*:\s*boolean/);
        expect(agentContent).not.toMatch(/\bvisible=\{/);
    });

    it("contains no imperative or deferred navigation workaround", () => {
        const files = [
            "frontend/app/workspace/workspace-content-slot.tsx",
            "frontend/app/workspace/workspace-agent-content-slot.tsx",
            "frontend/app/workspace/top-tab-content-deck.tsx",
            "frontend/app/workspace/workspace-main-content.tsx",
        ];
        for (const file of files) {
            const content = source(file);
            expect(content, file).not.toMatch(
                /querySelector|requestAnimationFrame|setTimeout|useDeferredValue|startTransition/
            );
        }
    });

    it("keeps Top Tab chrome outside the central content coordinator", () => {
        const mainContent = source("frontend/app/workspace/workspace-main-content.tsx");
        expect(mainContent).not.toContain("TopTabStrip");
    });
});
```

- [ ] **Step 2: Run the boundary test**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-content-isolation-boundary.test.ts --reporter=dot
```

Expected before all production cleanup is complete: FAIL on any remaining `visible` prop or
forbidden switching mechanism. Remove the remaining violation at its source; do not weaken
the regular expressions to make the test pass.

- [ ] **Step 3: Update architecture documentation**

In `2026-07-23-workspace-tab-architecture-design.md`:

- Replace the File lifecycle sentence “React editor component 可卸载” with:
  “File editor 在当前 Workspace renderer session 首次激活后保留到 Tab close；重启只
  恢复 descriptor 和最后选择，不恢复 editor DOM。”
- Clarify Agent hiding as `AgentContentSlot` wrapper activation, not an
  `AgentContent.visible` prop.
- Keep Preview/Git Diff active-only and Browser deferred.

In `2026-07-26-workspace-content-isolation-design.md`, change:

```text
- 状态：待实施计划
```

to:

```text
- 状态：已实现，待桌面运行时验收
```

In `docs/agent-rendering-architecture.md`, extend the Phase 4A update with:

```text
Agent and activated File content now live in isolated Workspace content slots.
Navigation changes update only slot activation; they do not rerender AgentContent or
recreate an activated Monaco editor. Agent activity subscribers remain independent from
the mounted Agent UI.
```

- [ ] **Step 4: Run focused suites**

Run:

```bash
npx vitest run frontend/app/agent frontend/app/workspace frontend/app/topbar --reporter=dot
```

Expected: every test file PASS. Existing stderr fixtures for malformed descriptor logging
may remain; there must be no new unhandled rejection or React hook warning.

- [ ] **Step 5: Run the development build**

Run:

```bash
npm run build:dev
```

Expected: exit code 0. Existing Rollup circular-chunk and missing optional `sharp` image
optimizer warnings may remain; no new TypeScript, React, or bundling error is allowed.

- [ ] **Step 6: Check formatting and the final diff**

Run:

```bash
npx prettier --write frontend/app/agent/agent-surface-activity.tsx frontend/app/agent/agent-surface-activity.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx frontend/app/agent/agent-chat-host.tsx frontend/app/agent/agent-chat-host.test.tsx frontend/app/agent/agent-command-card.tsx frontend/app/agent/agent-command-card.test.tsx frontend/app/workspace/workspace-content-slot.tsx frontend/app/workspace/workspace-content-slot.test.tsx frontend/app/workspace/workspace-agent-content-slot.tsx frontend/app/workspace/workspace-agent-content-slot.test.tsx frontend/app/workspace/top-tab-content-deck.tsx frontend/app/workspace/top-tab-content-deck.test.tsx frontend/app/workspace/workspace-main-content.tsx frontend/app/workspace/workspace-main-content.test.tsx frontend/app/workspace/workspace-app.test.tsx frontend/app/workspace/top-tab-runtime-host.test.tsx frontend/app/workspace/top-tab-strip.tsx frontend/app/workspace/top-tab-strip.test.tsx frontend/app/workspace/workspace-content-isolation-boundary.test.ts frontend/app/topbar/fixed-agent-entry.tsx frontend/app/topbar/fixed-agent-entry.test.tsx
git diff --check
git status --short
```

Expected: Prettier succeeds, `git diff --check` prints nothing, and status contains only
the Task 5 documentation/boundary changes.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/workspace/workspace-content-isolation-boundary.test.ts docs/superpowers/specs/2026-07-23-workspace-tab-architecture-design.md docs/superpowers/specs/2026-07-26-workspace-content-isolation-design.md docs/agent-rendering-architecture.md
git commit -m "docs: record workspace content isolation"
```

- [ ] **Step 8: Hand off desktop runtime acceptance**

Do not launch or control the GUI. Ask the user to verify:

1. Agent → previously opened File has no Agent residual frame.
2. Agent → new File immediately shows File loading/content.
3. File → Agent → same File preserves text, selection, scroll, and editor identity.
4. Agent continues running while File is active.
5. `.ts`, `.tsx`, `.json`, `.md`, and unknown files show the expected icons.
6. selected/inactive/hover/focus/dirty/close Soft Pill states are correct.
7. Keyboard switching never leaves focus inside an inactive slot; returning to Agent and
   File restores the expected composer/editor focus and File view state.
8. Record renderer RSS with 1, 5, and 10 activated File slots for the future resource
   policy; do not add an LRU eviction limit in this phase.

Record any failure with the exact navigation path and whether the target File was cold or
already activated.

## Final review gate

After Task 5:

1. Run a spec-compliance review against
   `docs/superpowers/specs/2026-07-26-workspace-content-isolation-design.md`.
2. Run a code-quality review focused on React render boundaries, runtime disposal,
   accessibility, and hidden Monaco focus.
3. Resolve every Important or blocking finding with a failing regression test.
4. Re-run the focused suites and `npm run build:dev`.
5. Report the five task commits and the remaining user-owned desktop acceptance step.
