# Agent Search and Read Tool Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace generic `find`, `grep`, and `read` tool payload cards with compact, grouped Search/Read activity rows whose expanded Read paths open in the current workspace's top-tab editor.

**Architecture:** Keep canonical tool-call parts unchanged and add semantic grouping at `MessagePrimitive.GroupedParts`. Pure helpers validate arguments, format Search rules, normalize/deduplicate Read paths, and aggregate statuses; focused React components render the groups. File navigation is injected from `WorkspaceTopTabController` through the existing workspace-to-Agent component chain.

**Tech Stack:** React 19, TypeScript, assistant-ui grouped parts, Tailwind v4, Radix Collapsible via shadcn, Vitest, Testing Library.

---

## File Map

- Create `frontend/app/agent/assistant-ui/tools/tool-activity-model.ts`: pure validation, formatting, path, deduplication, summary, and aggregate-state helpers.
- Create `frontend/app/agent/assistant-ui/tools/tool-activity-model.test.ts`: unit coverage for every display-model rule.
- Create `frontend/app/agent/assistant-ui/tools/tool-activity.tsx`: Search and Read presentational/group components.
- Create `frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx`: component behavior, collapse, accessibility, running/error, and navigation coverage.
- Modify `frontend/app/agent/assistant-ui/registry-thread.tsx`: semantic group paths, group rendering, and thread navigation props.
- Modify `frontend/app/agent/assistant-ui/thread.integration.test.tsx`: real assistant-ui message grouping and renderer regressions.
- Modify `frontend/app/agent/agent-content.tsx`: pass workspace directory and injected file navigation to `Thread`.
- Modify `frontend/app/workspace/workspace-agent-content-slot.tsx`: carry the file-open callback without coupling Agent UI to workspace models.
- Modify `frontend/app/workspace/workspace-agent-content-slot.test.tsx`: verify callback plumbing preserves the stable Agent surface.
- Modify `frontend/app/workspace/workspace-main-content.tsx`: adapt `WorkspaceTopTabController.openFile` to the Agent callback.
- Modify `frontend/app/workspace/workspace-main-content.test.tsx`: verify the authoritative top-tab controller reaches Agent content.

### Task 1: Build the semantic activity display model

**Files:**
- Create: `frontend/app/agent/assistant-ui/tools/tool-activity-model.test.ts`
- Create: `frontend/app/agent/assistant-ui/tools/tool-activity-model.ts`

- [ ] **Step 1: Write failing tests for Search validation and formatting**

Create `tool-activity-model.test.ts` with these initial tests:

```ts
import { describe, expect, it } from "vitest";

import {
    buildSearchActivityModel,
    getToolActivityKind,
    type ToolActivityPart,
} from "./tool-activity-model";

function part(overrides: Partial<ToolActivityPart>): ToolActivityPart {
    return {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "find",
        args: { pattern: "*.md" },
        status: { type: "complete" },
        ...overrides,
    };
}

describe("Search tool activity model", () => {
    it("formats find with its glob and explicit path", () => {
        const model = buildSearchActivityModel([
            part({ args: { pattern: "*.md", path: "docs", limit: 20 } }),
        ]);

        expect(model.rules).toEqual([{ query: "*.md", scopes: ["docs"] }]);
        expect(model.label).toBe("Searched");
    });

    it("formats grep with query, path, and glob while omitting execution controls", () => {
        const model = buildSearchActivityModel([
            part({
                toolName: "grep",
                args: {
                    pattern: "TODO",
                    path: "frontend",
                    glob: "*.ts",
                    ignoreCase: true,
                    context: 3,
                    limit: 50,
                },
            }),
        ]);

        expect(model.rules).toEqual([{ query: "TODO", scopes: ["frontend", "*.ts"] }]);
    });

    it("groups only valid semantic calls without registered or approval UI", () => {
        expect(getToolActivityKind(part({ toolName: "read", args: { path: "src/app.ts" } }))).toBe("read");
        expect(getToolActivityKind(part({ toolName: "find", args: {} }))).toBeUndefined();
        expect(
            getToolActivityKind(
                part({
                    toolName: "grep",
                    args: { pattern: "TODO" },
                    status: { type: "requires-action" },
                })
            )
        ).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the Search model tests and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/tools/tool-activity-model.test.ts
```

Expected: FAIL because `./tool-activity-model` does not exist.

- [ ] **Step 3: Implement the minimal Search model**

Create `tool-activity-model.ts` with structural types that work for both assistant-ui leaf parts and component tests:

```ts
import { isAbsoluteLocalPath, joinLocalPath } from "@/util/local-path";
import { normalizeFileTabPath } from "@/app/workspace/workspace-content-state";

export type ToolActivityStatus =
    | { type: "running" }
    | { type: "complete" }
    | { type: "requires-action" }
    | { type: "incomplete"; reason?: string; error?: unknown };

export type ToolActivityPart = {
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    args: unknown;
    status?: ToolActivityStatus;
    result?: unknown;
    isError?: boolean;
};

export type ToolActivityKind = "search" | "read";

export type SearchActivityRule = {
    query: string;
    scopes: string[];
};

export type SearchActivityModel = {
    label: "Searching" | "Searched";
    rules: SearchActivityRule[];
    active: boolean;
    errors: string[];
};

function record(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    return value as Record<string, unknown>;
}

function stringArg(args: unknown, key: string): string | undefined {
    const value = record(args)?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getToolActivityKind(part: ToolActivityPart): ToolActivityKind | undefined {
    if (part.status?.type === "requires-action") return;
    if (part.toolName === "read") return stringArg(part.args, "path") ? "read" : undefined;
    if (part.toolName === "find" || part.toolName === "grep") {
        return stringArg(part.args, "pattern") ? "search" : undefined;
    }
    return;
}

function activityError(part: ToolActivityPart): string | undefined {
    if (part.status?.type === "incomplete") {
        if (typeof part.status.error === "string") return part.status.error;
        return part.status.reason === "cancelled" ? "Cancelled" : "Tool failed";
    }
    if (part.isError) return "Tool failed";
    return;
}

export function buildSearchActivityModel(parts: ToolActivityPart[]): SearchActivityModel {
    const active = parts.some((part) => part.status?.type === "running");
    const rules = parts.map((part) => {
        const query = stringArg(part.args, "pattern") ?? "";
        if (part.toolName === "find") {
            const path = stringArg(part.args, "path");
            return { query, scopes: path && path !== "." ? [path] : [] };
        }
        return {
            query,
            scopes: [stringArg(part.args, "path"), stringArg(part.args, "glob")].filter(
                (value): value is string => !!value && value !== "."
            ),
        };
    });
    return {
        label: active ? "Searching" : "Searched",
        rules,
        active,
        errors: parts.map(activityError).filter((value): value is string => !!value),
    };
}
```

Keep the path imports in place for the Read implementation in the next cycle.

- [ ] **Step 4: Run the Search tests and verify GREEN**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/tools/tool-activity-model.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add failing tests for Read path resolution, deduplication, summaries, and status**

Append:

```ts
import { buildReadActivityModel } from "./tool-activity-model";

describe("Read tool activity model", () => {
    it("resolves paths, deduplicates continuation reads, and uses workspace-relative display paths", () => {
        const model = buildReadActivityModel(
            [
                part({ toolName: "read", args: { path: "src/app.ts" } }),
                part({ toolCallId: "call-2", toolName: "read", args: { path: "./src/app.ts", offset: 201 } }),
                part({ toolCallId: "call-3", toolName: "read", args: { path: "/outside/log.txt" } }),
            ],
            "/repo"
        );

        expect(model.entries).toEqual([
            {
                absolutePath: "/repo/src/app.ts",
                displayPath: "src/app.ts",
                basename: "app.ts",
                failed: false,
            },
            {
                absolutePath: "/outside/log.txt",
                displayPath: "/outside/log.txt",
                basename: "log.txt",
                failed: false,
            },
        ]);
        expect(model.summary).toBe("app.ts and log.txt");
    });

    it("summarizes three or more unique paths using the remaining count", () => {
        const model = buildReadActivityModel(
            [
                part({ toolName: "read", args: { path: "a.ts" } }),
                part({ toolCallId: "call-2", toolName: "read", args: { path: "b.ts" } }),
                part({ toolCallId: "call-3", toolName: "read", args: { path: "c.ts" } }),
            ],
            "/repo"
        );

        expect(model.summary).toBe("a.ts and 2 other files");
    });

    it("marks failed paths inactive and reports running state", () => {
        const model = buildReadActivityModel(
            [
                part({
                    toolName: "read",
                    args: { path: "missing.ts" },
                    status: { type: "incomplete", reason: "error", error: "not found" },
                }),
                part({
                    toolCallId: "call-2",
                    toolName: "read",
                    args: { path: "loading.ts" },
                    status: { type: "running" },
                }),
            ],
            "/repo"
        );

        expect(model.label).toBe("Reading");
        expect(model.entries[0]?.failed).toBe(true);
        expect(model.errors).toEqual(["not found"]);
    });
});
```

- [ ] **Step 6: Run the Read tests and verify RED**

Run the same focused command.

Expected: FAIL because `buildReadActivityModel` is not exported.

- [ ] **Step 7: Implement the minimal Read model**

Add:

```ts
export type ReadActivityEntry = {
    absolutePath: string;
    displayPath: string;
    basename: string;
    failed: boolean;
};

export type ReadActivityModel = {
    label: "Reading" | "Read";
    summary: string;
    entries: ReadActivityEntry[];
    active: boolean;
    errors: string[];
};

function resolveReadPath(path: string, workspaceDir: string): string {
    const normalizedPath = path.replace(/\\/g, "/");
    return normalizeFileTabPath(
        isAbsoluteLocalPath(normalizedPath) ? normalizedPath : joinLocalPath(workspaceDir, normalizedPath)
    );
}

function displayReadPath(absolutePath: string, workspaceDir: string): string {
    const root = normalizeFileTabPath(workspaceDir);
    if (absolutePath === root) return absolutePath.split("/").filter(Boolean).at(-1) ?? absolutePath;
    return absolutePath.startsWith(`${root}/`) ? absolutePath.slice(root.length + 1) : absolutePath;
}

function readSummary(entries: ReadActivityEntry[]): string {
    if (entries.length === 1) return entries[0].basename;
    if (entries.length === 2) return `${entries[0].basename} and ${entries[1].basename}`;
    return `${entries[0].basename} and ${entries.length - 1} other files`;
}

export function buildReadActivityModel(parts: ToolActivityPart[], workspaceDir: string): ReadActivityModel {
    const byPath = new Map<string, ReadActivityEntry>();
    for (const part of parts) {
        const path = stringArg(part.args, "path");
        if (!path) continue;
        const absolutePath = resolveReadPath(path, workspaceDir);
        const previous = byPath.get(absolutePath);
        const failed = !!activityError(part);
        byPath.set(absolutePath, {
            absolutePath,
            displayPath: displayReadPath(absolutePath, workspaceDir),
            basename: absolutePath.split("/").filter(Boolean).at(-1) ?? absolutePath,
            failed: previous ? previous.failed && failed : failed,
        });
    }
    const entries = [...byPath.values()];
    const active = parts.some((part) => part.status?.type === "running");
    return {
        label: active ? "Reading" : "Read",
        summary: readSummary(entries),
        entries,
        active,
        errors: parts.map(activityError).filter((value): value is string => !!value),
    };
}
```

- [ ] **Step 8: Run the model tests and verify GREEN**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/tools/tool-activity-model.test.ts
```

Expected: all model tests PASS.

- [ ] **Step 9: Commit the model**

```bash
git add frontend/app/agent/assistant-ui/tools/tool-activity-model.ts frontend/app/agent/assistant-ui/tools/tool-activity-model.test.ts
git commit -m "feat: model agent search and read activity"
```

### Task 2: Render Search and Read activity groups

**Files:**
- Create: `frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx`
- Create: `frontend/app/agent/assistant-ui/tools/tool-activity.tsx`
- Modify: `frontend/app/agent/assistant-ui/registry-thread.tsx`
- Modify: `frontend/app/agent/assistant-ui/thread.integration.test.tsx`

- [ ] **Step 1: Write failing presentational component tests**

Create `tool-activity.test.tsx` using jsdom and Testing Library. Cover these observable contracts:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReadToolActivity, SearchToolActivity } from "./tool-activity";
import type { ToolActivityPart } from "./tool-activity-model";

const complete = { type: "complete" } as const;

function part(toolName: string, args: Record<string, unknown>, id: string): ToolActivityPart {
    return { type: "tool-call", toolCallId: id, toolName, args, status: complete };
}

afterEach(cleanup);

describe("SearchToolActivity", () => {
    it("shows every search rule without a disclosure control or raw payload", () => {
        const { container } = render(
            <SearchToolActivity
                parts={[
                    part("find", { pattern: "*.md" }, "find-1"),
                    part("grep", { pattern: "TODO", glob: "*.ts" }, "grep-1"),
                ]}
            />
        );

        expect(screen.getByText("Searched")).toBeTruthy();
        expect(screen.getByText("*.md")).toBeTruthy();
        expect(screen.getByText("TODO")).toBeTruthy();
        expect(screen.getByText("*.ts")).toBeTruthy();
        expect(container.querySelector('[data-slot="tool-activity-search"] button')).toBeNull();
        expect(container.textContent).not.toContain('"pattern"');
    });
});

describe("ReadToolActivity", () => {
    it("starts collapsed and opens files through the injected callback", () => {
        const onOpenFile = vi.fn();
        render(
            <ReadToolActivity
                parts={[
                    part("read", { path: "src/app.ts" }, "read-1"),
                    part("read", { path: "src/util.ts" }, "read-2"),
                ]}
                workspaceDir="/repo"
                onOpenFile={onOpenFile}
            />
        );

        const trigger = screen.getByRole("button", { name: /Read app\.ts and util\.ts/i });
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByRole("button", { name: /Open src\/app\.ts/i })).toBeNull();

        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole("button", { name: "Open src/app.ts" }));

        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        expect(onOpenFile).toHaveBeenCalledWith("/repo/src/app.ts");
    });

    it("keeps failed read paths visible but inactive and exposes errors outside collapsed content", () => {
        const failed: ToolActivityPart = {
            ...part("read", { path: "missing.ts" }, "read-1"),
            status: { type: "incomplete", reason: "error", error: "not found" },
        };
        render(<ReadToolActivity parts={[failed]} workspaceDir="/repo" onOpenFile={vi.fn()} />);

        expect(screen.getByText("not found")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: /Read missing\.ts/i }));
        expect(screen.queryByRole("button", { name: "Open missing.ts" })).toBeNull();
        expect(screen.getByText("missing.ts")).toBeTruthy();
    });
});
```

- [ ] **Step 2: Run component tests and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx
```

Expected: FAIL because `./tool-activity` does not exist.

- [ ] **Step 3: Implement the minimal presentational components**

Create `tool-activity.tsx` with:

- A shared status icon choosing `LoaderIcon`, `SearchIcon`, or `FileTextIcon`.
- Search markup rooted at `data-slot="tool-activity-search"` with no button or collapsible.
- A controlled Radix `Collapsible` for Read, `defaultOpen={false}`, and a native trigger button.
- Error text outside `CollapsibleContent`.
- Successful file entries as native buttons with `cursor-pointer`; failed entries as non-interactive rows.
- `cn` for class merging and existing foreground/accent tokens.

The public presentational API must be:

```tsx
export function SearchToolActivity({ parts }: { parts: ToolActivityPart[] }): ReactNode;

export function ReadToolActivity({
    parts,
    workspaceDir,
    onOpenFile,
}: {
    parts: ToolActivityPart[];
    workspaceDir: string;
    onOpenFile?: (path: string) => void;
}): ReactNode;
```

Use `buildSearchActivityModel` and `buildReadActivityModel`; do not parse arguments in JSX.

- [ ] **Step 4: Run component tests and verify GREEN**

Run the focused component command.

Expected: PASS.

- [ ] **Step 5: Write failing grouping integration tests**

Append tests to `thread.integration.test.tsx` with real `ThreadMessageLike` content:

```tsx
it("coalesces adjacent read calls into one semantic Read activity", () => {
    const html = renderThread(
        { workspaceDir: "/repo", onOpenFile: () => {} },
        [{
            role: "assistant",
            content: [
                {
                    type: "tool-call",
                    toolCallId: "read-1",
                    toolName: "read",
                    args: { path: "src/app.ts" },
                    argsText: "{}",
                },
                {
                    type: "tool-call",
                    toolCallId: "read-2",
                    toolName: "read",
                    args: { path: "src/util.ts" },
                    argsText: "{}",
                },
            ],
            status: { type: "complete", reason: "stop" },
        } as ThreadMessageLike]
    );

    expect(html.match(/data-slot="tool-activity-read"/g)).toHaveLength(1);
    expect(html).toContain("app.ts and util.ts");
    expect(html).not.toContain("Used tool: <b>read</b>");
});

it("coalesces adjacent find and grep calls but text splits Search groups", () => {
    const html = renderThread(undefined, [{
        role: "assistant",
        content: [
            { type: "tool-call", toolCallId: "find-1", toolName: "find", args: { pattern: "*.md" }, argsText: "{}" },
            { type: "tool-call", toolCallId: "grep-1", toolName: "grep", args: { pattern: "TODO", glob: "*.ts" }, argsText: "{}" },
            { type: "text", text: "Checking another area." },
            { type: "tool-call", toolCallId: "find-2", toolName: "find", args: { pattern: "*.json" }, argsText: "{}" },
        ],
        status: { type: "complete", reason: "stop" },
    } as ThreadMessageLike]);

    expect(html.match(/data-slot="tool-activity-search"/g)).toHaveLength(2);
    expect(html).toContain("*.md");
    expect(html).toContain("TODO");
    expect(html).toContain("*.json");
});

it("leaves malformed and registered tool UI calls on their existing renderer path", () => {
    expect(registryThreadTesting.groupCrestAssistantPart({
        type: "tool-call",
        toolCallId: "bad",
        toolName: "read",
        args: {},
        status: { type: "complete" },
    } as any)).not.toContain("group-read-activity");
});
```

Also extend `registryThreadTesting` to export `groupCrestAssistantPart` for the direct grouping assertion.

- [ ] **Step 6: Run integration tests and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/assistant-ui/thread.integration.test.tsx
```

Expected: FAIL because semantic group keys and renderers are not wired.

- [ ] **Step 7: Implement semantic group components and registry wiring**

In `tool-activity.tsx`, add group adapters:

```tsx
export function SearchToolActivityGroup({ indices }: { indices: readonly number[] }) {
    const parts = useAuiState(
        useShallow((state) =>
            indices
                .map((index) => state.message.parts[index])
                .filter((part): part is ToolActivityPart => part?.type === "tool-call")
        )
    );
    return <SearchToolActivity parts={parts} />;
}

export function ReadToolActivityGroup({
    indices,
    workspaceDir,
    onOpenFile,
}: {
    indices: readonly number[];
    workspaceDir: string;
    onOpenFile?: (path: string) => void;
}) {
    const parts = useAuiState(
        useShallow((state) =>
            indices
                .map((index) => state.message.parts[index])
                .filter((part): part is ToolActivityPart => part?.type === "tool-call")
        )
    );
    return <ReadToolActivity parts={parts} workspaceDir={workspaceDir} onOpenFile={onOpenFile} />;
}
```

In `registry-thread.tsx`:

- Extend the grouped-part key union with `group-search-activity` and `group-read-activity`.
- Add `workspaceDir?: string` and `onOpenFile?: (path: string) => void` to `ThreadProps` and `ThreadExtrasContext`.
- Before semantic grouping, preserve standalone/registered UIs: if `context?.toolUIs?.[part.toolName]?.length`, delegate to `DefaultAssistantPartGrouping`.
- Use `getToolActivityKind` to return:

```ts
["group-chainOfThought", "group-search-activity"]
["group-chainOfThought", "group-read-activity"]
```

- Render semantic group cases before the generic `group-tool` case, passing `part.indices`.
- Keep `edit` and `write` ungrouped exactly as today.

- [ ] **Step 8: Run component and integration tests and verify GREEN**

Run:

```bash
npx vitest run \
  frontend/app/agent/assistant-ui/tools/tool-activity-model.test.ts \
  frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx \
  frontend/app/agent/assistant-ui/thread.integration.test.tsx \
  frontend/app/agent/assistant-ui/tools/file-tool-cards.test.tsx \
  frontend/app/agent/assistant-ui/tools/tool-fallback.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit semantic rendering**

```bash
git add \
  frontend/app/agent/assistant-ui/tools/tool-activity.tsx \
  frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx \
  frontend/app/agent/assistant-ui/registry-thread.tsx \
  frontend/app/agent/assistant-ui/thread.integration.test.tsx
git commit -m "feat: render grouped agent search and read activity"
```

### Task 3: Inject workspace top-tab file navigation

**Files:**
- Modify: `frontend/app/agent/agent-content.tsx`
- Modify: `frontend/app/workspace/workspace-agent-content-slot.tsx`
- Modify: `frontend/app/workspace/workspace-agent-content-slot.test.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.tsx`
- Modify: `frontend/app/workspace/workspace-main-content.test.tsx`

- [ ] **Step 1: Write a failing slot plumbing test**

Change the AgentContent mock to capture props:

```tsx
const agentContentMock = vi.hoisted(() => ({
    props: undefined as Record<string, unknown> | undefined,
    rootRenderCount: 0,
    consumerRenderCount: 0,
    activityEvents: vi.fn(),
}));

vi.mock("@/app/agent/agent-content", () => ({
    AgentContent: (props: Record<string, unknown>) => {
        agentContentMock.props = props;
        agentContentMock.rootRenderCount++;
        return <ActivityLifecycleProbe />;
    },
}));
```

Add:

```tsx
it("passes the workspace file callback into AgentContent", () => {
    const onOpenFile = vi.fn();
    render(
        <WorkspaceAgentContentSlot
            active={true}
            mounted={true}
            model={{} as any}
            client={{} as any}
            executionContext={{
                workspaceId: "workspace-1",
                workspaceDir: "/repo",
                environment: {},
            }}
            onOpenFile={onOpenFile}
        />
    );

    expect(agentContentMock.props?.onOpenFile).toBe(onOpenFile);
});
```

- [ ] **Step 2: Run the slot test and verify RED**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-agent-content-slot.test.tsx
```

Expected: FAIL because `WorkspaceAgentContentSlotProps` does not accept or forward `onOpenFile`.

- [ ] **Step 3: Thread the callback through slot and Agent content**

Add optional `onOpenFile` props:

```ts
export interface WorkspaceAgentContentSlotProps {
    // existing props...
    onOpenFile?: (path: string) => void;
}

export interface AgentContentProps {
    model: WorkspaceAgentModel;
    client: AgentRuntimeClient;
    executionContext: AgentExecutionContext;
    onOpenFile?: (path: string) => void;
}
```

Forward the callback from `WorkspaceAgentContentSlot` to `AgentContent`, then pass:

```tsx
<Thread
    // existing props...
    workspaceDir={executionContext.workspaceDir}
    onOpenFile={onOpenFile}
/>
```

- [ ] **Step 4: Run the slot test and verify GREEN**

Run the focused slot test.

Expected: PASS, including the existing stable-render assertions.

- [ ] **Step 5: Write a failing WorkspaceMainContent controller-adapter test**

In `workspace-main-content.test.tsx`, use the existing AgentContentSlot mock/capture and add:

```tsx
it("opens Agent Read files through the authoritative top-tab controller", () => {
    const openFile = vi.fn(() => "file-tab-1");
    renderWorkspaceMainContent({
        activeContent: { kind: "agent" },
        topTabController: { openFile } as any,
    });

    capturedAgentSlotProps.onOpenFile("/repo/src/app.ts");

    expect(openFile).toHaveBeenCalledWith("/repo/src/app.ts");
});
```

Adapt the helper names to the existing capture object in that test file; do not introduce a second renderer harness.

- [ ] **Step 6: Run the WorkspaceMainContent test and verify RED**

Run:

```bash
npx vitest run frontend/app/workspace/workspace-main-content.test.tsx
```

Expected: FAIL because `onOpenFile` is not passed to the Agent slot.

- [ ] **Step 7: Implement the stable top-tab adapter**

In `WorkspaceMainContent`, create a top-level hook before conditional returns:

```ts
const openAgentFile = useCallback(
    (path: string) => {
        topTabController?.openFile(path);
    },
    [topTabController]
);
```

Pass `onOpenFile={topTabController ? openAgentFile : undefined}` to `WorkspaceAgentContentSlot`.

- [ ] **Step 8: Run navigation boundary tests and verify GREEN**

Run:

```bash
npx vitest run \
  frontend/app/workspace/workspace-agent-content-slot.test.tsx \
  frontend/app/workspace/workspace-main-content.test.tsx \
  frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit navigation plumbing**

```bash
git add \
  frontend/app/agent/agent-content.tsx \
  frontend/app/workspace/workspace-agent-content-slot.tsx \
  frontend/app/workspace/workspace-agent-content-slot.test.tsx \
  frontend/app/workspace/workspace-main-content.tsx \
  frontend/app/workspace/workspace-main-content.test.tsx
git commit -m "feat: open agent read files in workspace tabs"
```

### Task 4: Verify the complete feature and regressions

**Files:**
- Modify tests only if verification exposes an actual uncovered behavior; any fix starts with a reproducing failing test.

- [ ] **Step 1: Run the focused Agent and workspace suite**

```bash
npx vitest run \
  frontend/app/agent/assistant-ui/tools/tool-activity-model.test.ts \
  frontend/app/agent/assistant-ui/tools/tool-activity.test.tsx \
  frontend/app/agent/assistant-ui/thread.integration.test.tsx \
  frontend/app/agent/assistant-ui/tools/file-tool-cards.test.tsx \
  frontend/app/agent/assistant-ui/tools/tool-fallback.test.tsx \
  frontend/app/workspace/workspace-agent-content-slot.test.tsx \
  frontend/app/workspace/workspace-main-content.test.tsx
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run TypeScript validation through the project build**

Run:

```bash
npm run build:dev
```

Expected: exit code 0. Do not run `go build`.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff --check main...HEAD
git status --short
```

Expected:

- No whitespace errors.
- Only the planned Search/Read activity files and any pre-existing user changes are present.
- Pre-existing user changes remain unstaged and unmodified.

- [ ] **Step 4: Commit any test-only corrections**

Only if Step 1 or 2 required a test-first correction:

```bash
git add <exact corrected feature files>
git commit -m "test: cover agent search and read activity"
```

- [ ] **Step 5: Prepare branch completion**

Invoke `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`. Report the focused tests, build result, branch name, and commit list before offering merge/PR/keep choices.
