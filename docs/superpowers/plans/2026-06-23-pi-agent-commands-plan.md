# Pi Agent Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Pi coding-agent slash command layer to crest, with selector-first `/tree`, `/fork`, and direct `/clone`.

**Architecture:** Main process owns command metadata, session tree reads, and tree/fork/clone mutations through the existing `PaneAgentSession`, `AgentHarness`, and JSONL session repo. The renderer intercepts slash commands in the agent input path, uses new Electron IPC methods for command metadata and session selectors, and only sends ordinary prompts to the model when no command handles the input.

**Tech Stack:** TypeScript, Electron IPC (`ipcRenderer.invoke` / `ipcMain.handle`), React, Vitest, existing Pi harness/session code under `emain/agent`.

---

## Baseline Notes

- Worktree: `/Users/bytedance/Documents/crest/.worktrees/pi-agent-commands`
- Branch: `pi-agent-commands`
- Baseline setup limitation: this shell currently has no `npm` or `go` on `PATH`, so automated test commands may fail with `command not found`. Still write tests and run targeted commands when the environment provides them.
- Relevant local skill guide: `.kilocode/skills/electron-api/SKILL.md`. Adding `window.api.agent.*` methods requires updating `frontend/types/custom.d.ts`, `emain/preload.ts`, `emain/agent-ipc.ts`, and `frontend/preview/mock/preview-electron-api.ts`.

## File Structure

- Create `emain/agent/commands/types.ts`: command metadata, safe tree/fork view types, command parse result types.
- Create `emain/agent/commands/registry.ts`: built-in command metadata and slash input parser.
- Create `emain/agent/commands/session-views.ts`: transforms raw session tree entries into renderer-safe preview rows.
- Create `emain/agent/commands/registry.test.ts`: parser and command metadata tests.
- Create `emain/agent/commands/session-views.test.ts`: tree/fork row conversion tests.
- Modify `emain/agent/pane-agent-session.ts`: expose methods for listing tree/fork points, navigating tree, and reading active leaf state.
- Modify `emain/agent/sessions.ts`: expose a `forkPaneSession()` helper.
- Modify `emain/agent-ipc.ts`: register read/mutation IPC handlers.
- Modify `emain/preload.ts`: expose new async agent IPC methods.
- Modify `frontend/types/custom.d.ts`: add renderer-visible types and `window.api.agent` method signatures.
- Modify `frontend/preview/mock/preview-electron-api.ts`: add preview stubs.
- Modify `frontend/app/store/use-pi-chat.ts`: add typed API surface helpers for command/list operations if needed by renderer code.
- Modify `frontend/app/term/render/agent-chat-host.tsx`: expand `AgentChatHostApi` to expose command helpers or handle slash command execution.
- Create or modify frontend tests near `frontend/app/term/render/agent-chat-host.test.tsx` if the existing test setup can mount the component; otherwise add pure helper tests for slash command routing.

---

### Task 1: Command Metadata And Parser

**Files:**
- Create: `emain/agent/commands/types.ts`
- Create: `emain/agent/commands/registry.ts`
- Create: `emain/agent/commands/registry.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `emain/agent/commands/registry.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getBuiltInAgentCommands, parseAgentCommandInput } from "./registry";

describe("agent command registry", () => {
    it("includes session-tree commands", () => {
        const names = getBuiltInAgentCommands().map((command) => command.name);
        expect(names).toContain("tree");
        expect(names).toContain("fork");
        expect(names).toContain("clone");
    });

    it("parses slash command input", () => {
        expect(parseAgentCommandInput("/tree")).toEqual({ commandName: "tree", argsText: "" });
        expect(parseAgentCommandInput("/fork   entry text")).toEqual({
            commandName: "fork",
            argsText: "entry text",
        });
    });

    it("ignores non-command input and bare slash", () => {
        expect(parseAgentCommandInput("hello")).toBeUndefined();
        expect(parseAgentCommandInput("/")).toBeUndefined();
        expect(parseAgentCommandInput(" /tree")).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- emain/agent/commands/registry.test.ts --run
```

Expected: FAIL because `emain/agent/commands/registry.ts` does not exist. If `npm` is unavailable, record `zsh: command not found: npm` in the task notes and continue.

- [ ] **Step 3: Add command types**

Create `emain/agent/commands/types.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type AgentCommandSource = "builtin" | "skill" | "prompt";

export type AgentCommandAction =
    | { type: "backend"; command: "tree" | "fork" | "clone" | "compact" | "session" | "clear" | "new" | "help" }
    | { type: "frontend"; action: "openModelPicker" };

export interface AgentCommandInfo {
    name: string;
    description: string;
    argumentHint?: string;
    source: AgentCommandSource;
    action: AgentCommandAction;
}

export interface ParsedAgentCommandInput {
    commandName: string;
    argsText: string;
}
```

- [ ] **Step 4: Add built-in registry and parser**

Create `emain/agent/commands/registry.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentCommandInfo, ParsedAgentCommandInput } from "./types";

const BuiltInAgentCommands: AgentCommandInfo[] = [
    {
        name: "tree",
        description: "Navigate the current agent session tree",
        source: "builtin",
        action: { type: "backend", command: "tree" },
    },
    {
        name: "fork",
        description: "Fork a new agent session from a previous user message",
        source: "builtin",
        action: { type: "backend", command: "fork" },
    },
    {
        name: "clone",
        description: "Clone the current agent session branch",
        source: "builtin",
        action: { type: "backend", command: "clone" },
    },
    {
        name: "compact",
        description: "Compact the current agent session context",
        argumentHint: "[instructions]",
        source: "builtin",
        action: { type: "backend", command: "compact" },
    },
    {
        name: "model",
        description: "Open the model picker",
        source: "builtin",
        action: { type: "frontend", action: "openModelPicker" },
    },
    {
        name: "help",
        description: "Show available agent commands",
        source: "builtin",
        action: { type: "backend", command: "help" },
    },
];

export function getBuiltInAgentCommands(): AgentCommandInfo[] {
    return BuiltInAgentCommands.map((command) => ({ ...command, action: { ...command.action } }));
}

export function parseAgentCommandInput(input: string): ParsedAgentCommandInput | undefined {
    if (!input.startsWith("/") || input === "/") {
        return undefined;
    }
    const trimmed = input.trimEnd();
    const spaceIndex = trimmed.search(/\s/);
    if (spaceIndex === -1) {
        return { commandName: trimmed.slice(1), argsText: "" };
    }
    const commandName = trimmed.slice(1, spaceIndex);
    if (!commandName) {
        return undefined;
    }
    return {
        commandName,
        argsText: trimmed.slice(spaceIndex + 1).trim(),
    };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm test -- emain/agent/commands/registry.test.ts --run
```

Expected: PASS when `npm` is available.

- [ ] **Step 6: Commit**

```bash
git add emain/agent/commands/types.ts emain/agent/commands/registry.ts emain/agent/commands/registry.test.ts
git commit -m "feat: add agent command registry"
```

---

### Task 2: Session Tree And Fork View Helpers

**Files:**
- Modify: `emain/agent/commands/types.ts`
- Create: `emain/agent/commands/session-views.ts`
- Create: `emain/agent/commands/session-views.test.ts`

- [ ] **Step 1: Write failing view helper tests**

Create `emain/agent/commands/session-views.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildAgentForkPointViews, buildAgentTreeEntryViews, previewSessionEntry } from "./session-views";
import type { SessionTreeEntry } from "../harness/types";

function messageEntry(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: `2026-06-23T00:00:0${id}.000Z`,
        message: { role, content: [{ type: "text", text }] },
    } as unknown as SessionTreeEntry;
}

describe("session view helpers", () => {
    it("builds safe tree rows with current leaf marker", () => {
        const entries = [messageEntry("1", null, "user", "first question"), messageEntry("2", "1", "assistant", "answer")];
        const rows = buildAgentTreeEntryViews(entries, "2", new Map([["1", "Start"]]));
        expect(rows).toEqual([
            expect.objectContaining({ id: "1", label: "Start", preview: "first question", isCurrent: false }),
            expect.objectContaining({ id: "2", preview: "answer", isCurrent: true }),
        ]);
    });

    it("builds fork points only from user messages", () => {
        const entries = [messageEntry("1", null, "user", "fork here"), messageEntry("2", "1", "assistant", "no")];
        expect(buildAgentForkPointViews(entries)).toEqual([
            expect.objectContaining({ entryId: "1", preview: "fork here" }),
        ]);
    });

    it("truncates long previews", () => {
        const long = "x".repeat(140);
        expect(previewSessionEntry(messageEntry("1", null, "user", long))).toHaveLength(121);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- emain/agent/commands/session-views.test.ts --run
```

Expected: FAIL because `session-views.ts` does not exist. If `npm` is unavailable, record that limitation.

- [ ] **Step 3: Extend command view types**

Append to `emain/agent/commands/types.ts`:

```ts
export interface AgentTreeEntryView {
    id: string;
    parentId?: string;
    type: string;
    role?: string;
    label?: string;
    preview: string;
    timestamp?: string;
    isLeaf: boolean;
    isCurrent: boolean;
}

export interface AgentForkPointView {
    entryId: string;
    preview: string;
    timestamp?: string;
}
```

- [ ] **Step 4: Implement view helpers**

Create `emain/agent/commands/session-views.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SessionTreeEntry } from "../harness/types";
import type { AgentForkPointView, AgentTreeEntryView } from "./types";

const MaxPreviewLength = 120;

function truncatePreview(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= MaxPreviewLength) {
        return normalized;
    }
    return `${normalized.slice(0, MaxPreviewLength)}…`;
}

function textFromContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .filter((part): part is { type: string; text?: string } => part?.type === "text")
        .map((part) => part.text ?? "")
        .join("");
}

export function previewSessionEntry(entry: SessionTreeEntry): string {
    if (entry.type === "message") {
        return truncatePreview(textFromContent(entry.message.content));
    }
    if (entry.type === "custom_message") {
        return truncatePreview(textFromContent(entry.content));
    }
    if (entry.type === "branch_summary") {
        return truncatePreview(entry.summary);
    }
    if (entry.type === "compaction") {
        return truncatePreview(entry.summary);
    }
    return entry.type;
}

export function buildAgentTreeEntryViews(
    entries: SessionTreeEntry[],
    leafId: string | null,
    labels: Map<string, string | undefined> = new Map(),
): AgentTreeEntryView[] {
    return entries.map((entry) => ({
        id: entry.id,
        ...(entry.parentId != null ? { parentId: entry.parentId } : {}),
        type: entry.type,
        ...(entry.type === "message" ? { role: entry.message.role } : {}),
        ...(labels.get(entry.id) ? { label: labels.get(entry.id) } : {}),
        preview: previewSessionEntry(entry),
        timestamp: entry.timestamp,
        isLeaf: entry.id === leafId,
        isCurrent: entry.id === leafId,
    }));
}

export function buildAgentForkPointViews(entries: SessionTreeEntry[]): AgentForkPointView[] {
    return entries
        .filter((entry) => entry.type === "message" && entry.message.role === "user")
        .map((entry) => ({
            entryId: entry.id,
            preview: previewSessionEntry(entry),
            timestamp: entry.timestamp,
        }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm test -- emain/agent/commands/session-views.test.ts --run
```

Expected: PASS when `npm` is available.

- [ ] **Step 6: Commit**

```bash
git add emain/agent/commands/types.ts emain/agent/commands/session-views.ts emain/agent/commands/session-views.test.ts
git commit -m "feat: add agent session command views"
```

---

### Task 3: Pane Session Tree Operations

**Files:**
- Modify: `emain/agent/pane-agent-session.ts`
- Modify: `emain/agent/pane-agent-session.test.ts`

- [ ] **Step 1: Write failing PaneAgentSession tests**

Add to `emain/agent/pane-agent-session.test.ts`:

```ts
describe("PaneAgentSession — command operations", () => {
    it("lists session tree entries through the pane harness session", async () => {
        const fake = makeFakeHarness();
        const entry = { type: "message", id: "1", parentId: null, timestamp: "t", message: user("hello") };
        fake.pane.session = {
            getEntries: vi.fn().mockResolvedValue([entry]),
            getLeafId: vi.fn().mockResolvedValue("1"),
            getLabel: vi.fn().mockResolvedValue(undefined),
        } as any;
        const owner = new PaneAgentSession("/s", fake.pane);
        const result = await owner.listTreeEntries();
        expect(result.entries[0].id).toBe("1");
        expect(result.leafId).toBe("1");
    });
});
```

If the current `PaneHarness` interface does not expose `session`, adjust the test after Step 2 by adding a minimal method on `PaneHarness` instead of assigning `fake.pane.session`.

- [ ] **Step 2: Extend PaneHarness to expose session operations**

Modify `emain/agent/harness-factory.ts` if needed:

```ts
export interface PaneHarness {
    readonly harness: AgentHarness;
    readonly session: Session;
    appendCustomEntry(customType: string, data?: unknown): Promise<void>;
    promptWithCustomEntry(customType: string, data: unknown, text: string): Promise<unknown>;
    update(inputs: SystemPromptInputs): void;
}
```

In the returned object:

```ts
return {
    harness,
    session: opts.session,
    appendCustomEntry: ...
};
```

- [ ] **Step 3: Add PaneAgentSession methods**

Add public methods to `PaneAgentSession`:

```ts
async listTreeEntries(): Promise<{ entries: SessionTreeEntry[]; leafId: string | null; labels: Map<string, string | undefined> }> {
    const entries = await this.pane.session.getEntries();
    const leafId = await this.pane.session.getLeafId();
    const labels = new Map<string, string | undefined>();
    for (const entry of entries) {
        labels.set(entry.id, await this.pane.session.getLabel(entry.id));
    }
    return { entries, leafId, labels };
}

async navigateTree(targetId: string): Promise<{ editorText?: string }> {
    const result = await this.pane.harness.navigateTree(targetId, { summarize: false });
    if (result.cancelled) {
        return {};
    }
    return { editorText: result.editorText };
}

async getLeafId(): Promise<string | null> {
    return this.pane.session.getLeafId();
}
```

Update imports to include `SessionTreeEntry`.

- [ ] **Step 4: Run targeted test**

Run:

```bash
npm test -- emain/agent/pane-agent-session.test.ts --run
```

Expected: PASS when `npm` is available.

- [ ] **Step 5: Commit**

```bash
git add emain/agent/harness-factory.ts emain/agent/pane-agent-session.ts emain/agent/pane-agent-session.test.ts
git commit -m "feat: expose agent session tree operations"
```

---

### Task 4: Session Fork Helper

**Files:**
- Modify: `emain/agent/sessions.ts`
- Create or modify: `emain/agent/sessions.test.ts`

- [ ] **Step 1: Write failing fork helper test**

Add to `emain/agent/sessions.test.ts`:

```ts
it("forkPaneSession delegates to the sessions repo", async () => {
    const fork = vi.fn().mockResolvedValue({
        getMetadata: vi.fn().mockResolvedValue({ id: "forked", cwd: "/repo", path: "/tmp/forked.jsonl", createdAt: "2026-06-23T00:00:00.000Z" }),
    });
    _setSessionsRepoForTests({ fork } as any);
    const result = await forkPaneSession(
        { id: "source", cwd: "/repo", path: "/tmp/source.jsonl", createdAt: "2026-06-23T00:00:00.000Z" },
        { cwd: "/repo", entryId: "entry-1" },
    );
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ id: "source" }), expect.objectContaining({ entryId: "entry-1" }));
    expect(result.metadata.id).toBe("forked");
});
```

- [ ] **Step 2: Add fork helper**

Modify `emain/agent/sessions.ts`:

```ts
export async function forkPaneSession(
    source: JsonlSessionMetadata,
    options: { cwd: string; entryId?: string; position?: "before" | "at" },
): Promise<{ session: Session<JsonlSessionMetadata>; metadata: JsonlSessionMetadata }> {
    const session = await getSessionsRepo().fork(source, {
        cwd: options.cwd,
        parentSessionPath: source.path,
        entryId: options.entryId,
        position: options.position,
    });
    const metadata = await session.getMetadata();
    return { session, metadata };
}
```

- [ ] **Step 3: Run targeted test**

Run:

```bash
npm test -- emain/agent/sessions.test.ts --run
```

Expected: PASS when `npm` is available.

- [ ] **Step 4: Commit**

```bash
git add emain/agent/sessions.ts emain/agent/sessions.test.ts
git commit -m "feat: add agent session fork helper"
```

---

### Task 5: Agent IPC Methods

**Files:**
- Modify: `emain/agent-ipc.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `emain/preload.ts`
- Modify: `frontend/preview/mock/preview-electron-api.ts`

- [ ] **Step 1: Add renderer-visible types**

In `frontend/types/custom.d.ts`, add types near `AgentSendOptions`:

```ts
type AgentCommandInfo = {
    name: string;
    description: string;
    argumentHint?: string;
    source: "builtin" | "skill" | "prompt";
    action:
        | { type: "backend"; command: string }
        | { type: "frontend"; action: string };
};

type AgentTreeEntryView = {
    id: string;
    parentId?: string;
    type: string;
    role?: string;
    label?: string;
    preview: string;
    timestamp?: string;
    isLeaf: boolean;
    isCurrent: boolean;
};

type AgentForkPointView = {
    entryId: string;
    preview: string;
    timestamp?: string;
};
```

Extend `ElectronApi.agent`:

```ts
listCommands: () => Promise<AgentCommandInfo[]>;
listTree: (sessionMetadata: AgentSessionMeta) => Promise<{ entries: AgentTreeEntryView[]; leafId: string | null }>;
listForkPoints: (sessionMetadata: AgentSessionMeta) => Promise<AgentForkPointView[]>;
navigateTree: (opts: { sessionMetadata: AgentSessionMeta; targetId: string }) => Promise<{ sessionMetadata: AgentSessionMeta; editorText?: string }>;
forkSession: (opts: { sessionMetadata: AgentSessionMeta; cwd: string; entryId: string }) => Promise<{ sessionMetadata: AgentSessionMeta; selectedText?: string }>;
cloneSession: (opts: { sessionMetadata: AgentSessionMeta; cwd: string }) => Promise<{ sessionMetadata?: AgentSessionMeta; message?: string }>;
```

- [ ] **Step 2: Expose preload methods**

In `emain/preload.ts`, add under `agent`:

```ts
listCommands: () => ipcRenderer.invoke("agent:list-commands"),
listTree: (sessionMetadata: unknown) => ipcRenderer.invoke("agent:list-tree", sessionMetadata),
listForkPoints: (sessionMetadata: unknown) => ipcRenderer.invoke("agent:list-fork-points", sessionMetadata),
navigateTree: (opts: unknown) => ipcRenderer.invoke("agent:navigate-tree", opts),
forkSession: (opts: unknown) => ipcRenderer.invoke("agent:fork-session", opts),
cloneSession: (opts: unknown) => ipcRenderer.invoke("agent:clone-session", opts),
```

- [ ] **Step 3: Add preview stubs**

In `frontend/preview/mock/preview-electron-api.ts`, add under `agent`:

```ts
listCommands: () => Promise.resolve([]),
listTree: () => Promise.resolve({ entries: [], leafId: null }),
listForkPoints: () => Promise.resolve([]),
navigateTree: () => Promise.reject(new Error("agent not available in preview env")),
forkSession: () => Promise.reject(new Error("agent not available in preview env")),
cloneSession: () => Promise.reject(new Error("agent not available in preview env")),
```

- [ ] **Step 4: Implement main IPC handlers**

In `emain/agent-ipc.ts`, import:

```ts
import { getBuiltInAgentCommands } from "./agent/commands/registry";
import { buildAgentForkPointViews, buildAgentTreeEntryViews } from "./agent/commands/session-views";
import { forkPaneSession } from "./agent/sessions";
```

Add handlers in `registerAgentIpcHandlers()`:

```ts
electron.ipcMain.handle("agent:list-commands", async () => getBuiltInAgentCommands());

electron.ipcMain.handle("agent:list-tree", async (_event, metadata: JsonlSessionMetadata) => {
    const owner = await ensurePaneSession(metadata, makeCommandSendOptions(metadata));
    const tree = await owner.listTreeEntries();
    return { entries: buildAgentTreeEntryViews(tree.entries, tree.leafId, tree.labels), leafId: tree.leafId };
});
```

If `ensurePaneSession` cannot be called without model/provider data, add a small `openOwnerForCommand(metadata)` helper that opens `openPaneSession(metadata)`, builds a `PaneAgentSession` only when already cached, or reads directly from `openPaneSession(metadata)` for list APIs. For mutation APIs that need harness methods, require the session to be cached and return `"No active agent session"` when missing.

Implement `agent:navigate-tree`, `agent:fork-session`, and `agent:clone-session` using the cached owner for active sessions and `forkPaneSession()` for new sessions.

- [ ] **Step 5: Run type/test command**

Run:

```bash
npm test -- emain/agent/commands/registry.test.ts emain/agent/commands/session-views.test.ts --run
```

Expected: PASS when `npm` is available.

- [ ] **Step 6: Commit**

```bash
git add emain/agent-ipc.ts emain/preload.ts frontend/types/custom.d.ts frontend/preview/mock/preview-electron-api.ts
git commit -m "feat: expose agent command ipc"
```

---

### Task 6: Frontend Slash Command Routing

**Files:**
- Modify: `frontend/app/store/use-pi-chat.ts`
- Modify: `frontend/app/term/render/agent-chat-host.tsx`
- Create: `frontend/app/term/render/agent-command-routing.test.ts`

- [ ] **Step 1: Write failing pure routing tests**

Create `frontend/app/term/render/agent-command-routing.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { classifyAgentSlashCommand } from "./agent-command-routing";

describe("agent command routing", () => {
    it("routes selector-first commands", () => {
        expect(classifyAgentSlashCommand("/tree")).toEqual({ type: "selector", command: "tree" });
        expect(classifyAgentSlashCommand("/fork")).toEqual({ type: "selector", command: "fork" });
    });

    it("routes clone as immediate command", () => {
        expect(classifyAgentSlashCommand("/clone")).toEqual({ type: "immediate", command: "clone" });
    });

    it("does not route unknown slash commands", () => {
        expect(classifyAgentSlashCommand("/unknown")).toBeUndefined();
        expect(classifyAgentSlashCommand("hello")).toBeUndefined();
    });
});
```

- [ ] **Step 2: Add routing helper**

Create `frontend/app/term/render/agent-command-routing.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type AgentSlashRoute =
    | { type: "selector"; command: "tree" | "fork" }
    | { type: "immediate"; command: "clone" }
    | { type: "frontend"; action: "openModelPicker" };

export function classifyAgentSlashCommand(input: string): AgentSlashRoute | undefined {
    const trimmed = input.trim();
    if (trimmed === "/tree") return { type: "selector", command: "tree" };
    if (trimmed === "/fork") return { type: "selector", command: "fork" };
    if (trimmed === "/clone") return { type: "immediate", command: "clone" };
    if (trimmed === "/model") return { type: "frontend", action: "openModelPicker" };
    return undefined;
}
```

- [ ] **Step 3: Extend AgentChatHostApi**

Modify `frontend/app/term/render/agent-chat-host.tsx`:

```ts
export interface AgentChatHostApi {
    send: (text: string) => boolean;
    abort: () => void;
    getRuns: () => PiRun[];
    listTree: () => Promise<{ entries: AgentTreeEntryView[]; leafId: string | null }>;
    listForkPoints: () => Promise<AgentForkPointView[]>;
    navigateTree: (targetId: string) => Promise<{ editorText?: string }>;
    forkSession: (entryId: string) => Promise<AgentSessionMeta>;
    cloneSession: () => Promise<AgentSessionMeta | undefined>;
}
```

Use `getApi().agent.*` or the local `getAgentApi()` helper pattern from `use-pi-chat.ts` to implement these methods. Use `sessionMetadataRef.current` so calls operate on the latest active session.

- [ ] **Step 4: Ensure slash commands do not submit as prompts**

In the parent input submit path that calls `AgentChatHostApi.send`, call `classifyAgentSlashCommand(text)` first. For `/tree` and `/fork`, open the selector UI. For `/clone`, call `api.cloneSession()` and update block session metadata. For `/model`, open the existing model picker.

If the parent input path is not in `agent-chat-host.tsx`, locate it with:

```bash
grep -R "agentHostApi" -n frontend/app/term frontend/app/store
grep -R "onReady" -n frontend/app/term/render
```

- [ ] **Step 5: Run targeted routing test**

Run:

```bash
npm test -- frontend/app/term/render/agent-command-routing.test.ts --run
```

Expected: PASS when `npm` is available.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/term/render/agent-command-routing.ts frontend/app/term/render/agent-command-routing.test.ts frontend/app/term/render/agent-chat-host.tsx frontend/app/store/use-pi-chat.ts
git commit -m "feat: route agent slash commands"
```

---

### Task 7: Tree And Fork Selectors

**Files:**
- Create: `frontend/app/term/render/agent-session-selectors.tsx`
- Modify: parent agent input component discovered in Task 6
- Test: add focused tests if existing component test harness supports it

- [ ] **Step 1: Create selector components**

Create `frontend/app/term/render/agent-session-selectors.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";

import { cn } from "@/util/util";

export function AgentTreeSelector({
    entries,
    onSelect,
    onCancel,
}: {
    entries: AgentTreeEntryView[];
    onSelect: (entryId: string) => void;
    onCancel: () => void;
}) {
    const [filter, setFilter] = useState("");
    const filtered = useMemo(
        () => entries.filter((entry) => `${entry.label ?? ""} ${entry.preview}`.toLowerCase().includes(filter.toLowerCase())),
        [entries, filter],
    );
    return (
        <div className="rounded border border-border bg-panel p-2">
            <input className="w-full rounded bg-input px-2 py-1" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search session tree" />
            <div className="mt-2 max-h-80 overflow-auto">
                {filtered.map((entry) => (
                    <button key={entry.id} className={cn("block w-full cursor-pointer rounded px-2 py-1 text-left hover:bg-accent/20", entry.isCurrent && "bg-accent/10")} onClick={() => onSelect(entry.id)}>
                        <span className="font-medium">{entry.label || entry.role || entry.type}</span>
                        <span className="ml-2 text-muted">{entry.preview}</span>
                    </button>
                ))}
            </div>
            <button className="mt-2 cursor-pointer text-muted hover:text-primary" onClick={onCancel}>Cancel</button>
        </div>
    );
}

export function AgentForkSelector({
    points,
    onSelect,
    onCancel,
}: {
    points: AgentForkPointView[];
    onSelect: (entryId: string) => void;
    onCancel: () => void;
}) {
    return (
        <div className="rounded border border-border bg-panel p-2">
            <div className="max-h-80 overflow-auto">
                {points.map((point) => (
                    <button key={point.entryId} className="block w-full cursor-pointer rounded px-2 py-1 text-left hover:bg-accent/20" onClick={() => onSelect(point.entryId)}>
                        {point.preview}
                    </button>
                ))}
            </div>
            <button className="mt-2 cursor-pointer text-muted hover:text-primary" onClick={onCancel}>Cancel</button>
        </div>
    );
}
```

If the project has an existing modal/popover pattern for agent input overlays, adapt this component to that pattern instead of adding a new visual container.

- [ ] **Step 2: Wire `/tree` selector**

In the parent input component:

```ts
const tree = await agentApi.listTree();
setAgentSelector({
    type: "tree",
    entries: tree.entries,
});
```

On select:

```ts
const result = await agentApi.navigateTree(entryId);
if (result.editorText) {
    setInputText(result.editorText);
}
closeSelector();
```

- [ ] **Step 3: Wire `/fork` selector**

In the parent input component:

```ts
const points = await agentApi.listForkPoints();
setAgentSelector({
    type: "fork",
    points,
});
```

On select:

```ts
const nextSession = await agentApi.forkSession(entryId);
onSessionMinted(nextSession);
closeSelector();
```

- [ ] **Step 4: Wire `/clone` immediate action**

In the slash command submit path:

```ts
const nextSession = await agentApi.cloneSession();
if (nextSession) {
    onSessionMinted(nextSession);
}
```

- [ ] **Step 5: Manual static verification**

Run:

```bash
grep -R "classifyAgentSlashCommand" -n frontend/app
grep -R "AgentTreeSelector" -n frontend/app
```

Expected: command routing and selector components are referenced by the input flow.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/term/render/agent-session-selectors.tsx <modified-parent-input-file>
git commit -m "feat: add agent tree and fork selectors"
```

---

### Task 8: Final Verification And Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-06-23-pi-agent-commands-design.md` only if implementation discovers a needed clarification.
- Modify: implementation files only for fixes found by verification.

- [ ] **Step 1: Run available targeted tests**

Run:

```bash
npm test -- emain/agent/commands/registry.test.ts emain/agent/commands/session-views.test.ts emain/agent/pane-agent-session.test.ts frontend/app/term/render/agent-command-routing.test.ts --run
```

Expected: PASS when `npm` is available. If `npm` is unavailable, document the environment limitation and rely on static review.

- [ ] **Step 2: Run static checks available in this shell**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; status shows only intended files.

- [ ] **Step 3: Self-review command behavior**

Check:

- `/tree` does not submit a model prompt.
- `/fork` does not submit a model prompt.
- `/clone` switches session metadata when a leaf exists.
- `/model` still opens the existing model picker path.
- Unknown slash text still reaches normal prompt submission.

- [ ] **Step 4: Commit final fixes**

If Step 1 or Step 2 required fixes:

```bash
git add <fixed-files>
git commit -m "fix: stabilize agent command flow"
```

If no fixes were needed, do not create an empty commit.
