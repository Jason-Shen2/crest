# Pi Agent Command Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align Crest's Pi coding-agent slash command baseline with Pi's core daily workflow before starting UI visual parity work.

**Architecture:** The main process remains the source of truth for command metadata and backend command execution. The renderer keeps one safety gate for slash commands in `CmdBlockInput` and `AgentChatHostApi.submit()`, so implemented commands never fall through to agent prompts or terminal PTY input.

**Tech Stack:** TypeScript, Electron IPC, React, Vitest, existing Crest/Pi agent session infrastructure.

---

## File Structure

- Modify `emain/agent/commands/types.ts`: extend backend command names, add generic command result and session info view types.
- Modify `emain/agent/commands/registry.ts`: expose the full implemented baseline list and argument hints.
- Modify `emain/agent/commands/registry.test.ts`: lock the exact command list and parser behavior.
- Create `emain/agent/commands/session-command-results.ts`: small pure helpers for formatting command success/no-op messages.
- Test `emain/agent/commands/session-command-results.test.ts`: pure result formatting tests.
- Modify `emain/agent-ipc.ts`: add backend IPC handlers for commands that do not need a renderer selector.
- Modify `emain/preload.ts`: expose the new generic command IPC method.
- Modify `frontend/types/custom.d.ts`: add renderer-visible command execution types.
- Modify `frontend/preview/mock/preview-electron-api.ts`: add preview mock for command execution.
- Modify `frontend/app/term/render/agent-slash-command-routing.ts`: route the new command names.
- Modify `frontend/app/term/render/agent-slash-command-routing.test.ts`: verify exact command routing.
- Modify `frontend/app/term/render/agent-chat-host.tsx`: dispatch immediate commands and create selector request for `/resume`.
- Modify `frontend/app/term/render/agent-chat-host-api.test.ts`: verify host routing and no prompt fallthrough.
- Modify `frontend/app/term/render/agent-selector-popover.tsx`: add a session-resume selector mode.
- Modify `frontend/app/view/cmdblock/cmdblock-input.tsx`: update fallback commands and icons.
- Modify `frontend/app/view/cmdblock/cmdblock-input-focus.test.ts`: verify menu action mapping.

---

### Task 1: Registry Baseline

**Files:**
- Modify: `emain/agent/commands/types.ts`
- Modify: `emain/agent/commands/registry.ts`
- Modify: `emain/agent/commands/registry.test.ts`
- Modify: `frontend/app/view/cmdblock/cmdblock-input.tsx`
- Modify: `frontend/app/view/cmdblock/cmdblock-input-focus.test.ts`

- [ ] **Step 1: Write failing registry tests**

Update `emain/agent/commands/registry.test.ts` so the built-in list is exact:

```ts
it("includes the implemented Pi command baseline", () => {
    const names = getBuiltInAgentCommands().map((command) => command.name);
    expect(names).toEqual([
        "tree",
        "fork",
        "clone",
        "model",
        "new",
        "resume",
        "compact",
        "session",
        "copy",
        "export",
        "import",
        "reload",
    ]);
});

it("keeps argument text for commands that need arguments", () => {
    expect(parseAgentCommandInput("/compact keep recent errors")).toEqual({
        commandName: "compact",
        argsText: "keep recent errors",
    });
    expect(parseAgentCommandInput("/export /tmp/session.jsonl")).toEqual({
        commandName: "export",
        argsText: "/tmp/session.jsonl",
    });
    expect(parseAgentCommandInput("/import /tmp/session.jsonl")).toEqual({
        commandName: "import",
        argsText: "/tmp/session.jsonl",
    });
});
```

- [ ] **Step 2: Run registry tests and confirm failure**

Run:

```bash
npm test -- emain/agent/commands/registry.test.ts --run
```

Expected: fails because the registry still only exposes `tree`, `fork`, `clone`, and `model`.

- [ ] **Step 3: Extend backend command types**

Update `AgentCommandAction` in `emain/agent/commands/types.ts`:

```ts
export type AgentBackendCommandName =
    | "tree"
    | "fork"
    | "clone"
    | "new"
    | "resume"
    | "compact"
    | "session"
    | "copy"
    | "export"
    | "import"
    | "reload";

export type AgentCommandAction =
    | { type: "backend"; command: AgentBackendCommandName }
    | { type: "frontend"; action: "openModelPicker" };
```

- [ ] **Step 4: Extend registry metadata**

Update `BuiltInAgentCommands` in `emain/agent/commands/registry.ts` by appending:

```ts
{
    name: "new",
    description: "Create a fresh agent session",
    source: "builtin",
    action: { type: "backend", command: "new" },
},
{
    name: "resume",
    description: "Resume an existing agent session for this workspace",
    source: "builtin",
    action: { type: "backend", command: "resume" },
},
{
    name: "compact",
    description: "Compact the current session context",
    argumentHint: "[instructions]",
    source: "builtin",
    action: { type: "backend", command: "compact" },
},
{
    name: "session",
    description: "Show current agent session information",
    source: "builtin",
    action: { type: "backend", command: "session" },
},
{
    name: "copy",
    description: "Copy the last assistant response",
    source: "builtin",
    action: { type: "backend", command: "copy" },
},
{
    name: "export",
    description: "Export the current session as JSONL",
    argumentHint: "[path]",
    source: "builtin",
    action: { type: "backend", command: "export" },
},
{
    name: "import",
    description: "Import a JSONL session",
    argumentHint: "<path>",
    source: "builtin",
    action: { type: "backend", command: "import" },
},
{
    name: "reload",
    description: "Reload agent command metadata",
    source: "builtin",
    action: { type: "backend", command: "reload" },
},
```

- [ ] **Step 5: Update frontend fallback commands**

Update `FallbackAgentSlashCommands` in `frontend/app/view/cmdblock/cmdblock-input.tsx` with matching command names and `action: "submitAgentCommand"` for all backend commands. Add icon handling:

```ts
if (command.action.command === "new") return "plus";
if (command.action.command === "resume") return "clock-rewind";
if (command.action.command === "compact") return "archive";
if (command.action.command === "session") return "info-circle";
if (command.action.command === "copy") return "copy-01";
if (command.action.command === "export") return "download-01";
if (command.action.command === "import") return "upload-01";
if (command.action.command === "reload") return "refresh-cw-01";
```

- [ ] **Step 6: Run command menu tests**

Run:

```bash
npm test -- emain/agent/commands/registry.test.ts frontend/app/view/cmdblock/cmdblock-input-focus.test.ts --run
```

Expected: tests pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add emain/agent/commands/types.ts emain/agent/commands/registry.ts emain/agent/commands/registry.test.ts frontend/app/view/cmdblock/cmdblock-input.tsx frontend/app/view/cmdblock/cmdblock-input-focus.test.ts
git commit -m "feat: expose pi command baseline metadata"
```

---

### Task 2: Slash Routing Safety

**Files:**
- Modify: `frontend/app/term/render/agent-slash-command-routing.ts`
- Modify: `frontend/app/term/render/agent-slash-command-routing.test.ts`
- Modify: `frontend/app/term/render/agent-chat-host.tsx`
- Modify: `frontend/app/term/render/agent-chat-host-api.test.ts`

- [ ] **Step 1: Write failing route tests**

Add cases to `frontend/app/term/render/agent-slash-command-routing.test.ts`:

```ts
it.each(["new", "resume", "compact", "session", "copy", "export", "import", "reload"])(
    "routes /%s as a handled agent command",
    (command) => {
        expect(resolveAgentSlashCommandRoute(`/${command}`)).toEqual({
            handled: true,
            command,
            argsText: "",
        });
    }
);

it("preserves arguments for command execution", () => {
    expect(resolveAgentSlashCommandRoute("/compact keep the latest failure context")).toEqual({
        handled: true,
        command: "compact",
        argsText: "keep the latest failure context",
    });
});
```

- [ ] **Step 2: Run route tests and confirm failure**

Run:

```bash
npm test -- frontend/app/term/render/agent-slash-command-routing.test.ts --run
```

Expected: fails because the routed command set does not include the new command names.

- [ ] **Step 3: Extend routed command names**

Update `frontend/app/term/render/agent-slash-command-routing.ts`:

```ts
export type AgentSlashCommandName =
    | "tree"
    | "fork"
    | "clone"
    | "model"
    | "new"
    | "resume"
    | "compact"
    | "session"
    | "copy"
    | "export"
    | "import"
    | "reload";

const RoutedAgentSlashCommands = new Set<AgentSlashCommandName>([
    "tree",
    "fork",
    "clone",
    "model",
    "new",
    "resume",
    "compact",
    "session",
    "copy",
    "export",
    "import",
    "reload",
]);
```

- [ ] **Step 4: Add host tests for no prompt fallthrough**

In `frontend/app/term/render/agent-chat-host-api.test.ts`, add a table-driven test that calls `api.submit(commandText)` and asserts `sendPrompt` is not called for the new commands.

```ts
it.each(["/new", "/compact keep errors", "/session", "/copy", "/export /tmp/a.jsonl", "/import /tmp/a.jsonl", "/reload"])(
    "does not send %s as a normal prompt",
    (commandText) => {
        const sendPrompt = vi.fn();
        const runCommand = vi.fn().mockResolvedValue({ kind: "message", message: "ok" });
        const api = createAgentChatHostApi({
            ...baseDeps,
            sendPrompt,
            runCommand,
        });

        expect(api.submit(commandText)).toBe(true);
        expect(sendPrompt).not.toHaveBeenCalled();
    }
);
```

- [ ] **Step 5: Add `runCommand` dependency to host API**

Extend `AgentChatHostApiDeps` with:

```ts
runCommand?: (command: AgentSlashCommandName, argsText: string) => Promise<AgentCommandExecutionResult>;
```

Then add a helper inside `createAgentChatHostApi`:

```ts
const runImmediateCommand = (command: AgentSlashCommandName, argsText: string): boolean => {
    if (!deps.runCommand) {
        deps.onUserError?.(`Agent command /${command} is not available yet.`);
        return true;
    }
    reportAsyncError(
        deps.runCommand(command, argsText).then((result) => {
            if (result.message) deps.onUserError?.(result.message);
            if (result.sessionMetadata) deps.onSessionMinted?.(result.sessionMetadata);
        })
    );
    return true;
};
```

- [ ] **Step 6: Route immediate commands through the helper**

In `submit`, keep existing selector actions for `model`, `tree`, `fork`, and `clone`, then add:

```ts
return runImmediateCommand(route.command, route.argsText);
```

for `/new`, `/compact`, `/session`, `/copy`, `/export`, `/import`, and `/reload`.

- [ ] **Step 7: Run routing tests**

Run:

```bash
npm test -- frontend/app/term/render/agent-slash-command-routing.test.ts frontend/app/term/render/agent-chat-host-api.test.ts --run
```

Expected: tests pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add frontend/app/term/render/agent-slash-command-routing.ts frontend/app/term/render/agent-slash-command-routing.test.ts frontend/app/term/render/agent-chat-host.tsx frontend/app/term/render/agent-chat-host-api.test.ts
git commit -m "feat: route pi baseline slash commands"
```

---

### Task 3: Immediate Backend Command IPC

**Files:**
- Create: `emain/agent/commands/session-command-results.ts`
- Create: `emain/agent/commands/session-command-results.test.ts`
- Modify: `emain/agent/commands/types.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/preload.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `frontend/preview/mock/preview-electron-api.ts`

- [ ] **Step 1: Add execution result types**

Add to `emain/agent/commands/types.ts`:

```ts
export type AgentCommandExecutionStatus = "success" | "noop";

export interface AgentCommandExecutionResult {
    status: AgentCommandExecutionStatus;
    message: string;
    sessionMetadata?: import("../../agent-types").JsonlSessionMetadata;
}

export interface AgentRunCommandInput {
    sessionMetadata?: import("../../agent-types").JsonlSessionMetadata;
    cwd: string;
    command: AgentBackendCommandName;
    argsText: string;
}
```

- [ ] **Step 2: Write pure result tests**

Create `emain/agent/commands/session-command-results.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { commandNoop, commandSuccess } from "./session-command-results";

describe("session command results", () => {
    it("formats success messages", () => {
        expect(commandSuccess("Copied 120 characters.")).toEqual({
            status: "success",
            message: "Copied 120 characters.",
        });
    });

    it("formats noop messages", () => {
        expect(commandNoop("No assistant response to copy yet.")).toEqual({
            status: "noop",
            message: "No assistant response to copy yet.",
        });
    });
});
```

- [ ] **Step 3: Implement pure result helpers**

Create `emain/agent/commands/session-command-results.ts`:

```ts
import type { AgentCommandExecutionResult } from "./types";

export function commandSuccess(message: string): AgentCommandExecutionResult {
    return { status: "success", message };
}

export function commandNoop(message: string): AgentCommandExecutionResult {
    return { status: "noop", message };
}
```

- [ ] **Step 4: Add IPC handler shell**

In `emain/agent-ipc.ts`, add:

```ts
export async function runAgentCommandForIpc(input: unknown): Promise<AgentCommandExecutionResult> {
    const parsed = validateRunCommandInput(input);
    switch (parsed.command) {
        case "new":
            return await runNewAgentSessionCommand(parsed.cwd);
        case "session":
            return await runSessionInfoCommand(parsed.sessionMetadata);
        case "copy":
            return await runCopyLastAssistantMessageCommand(parsed.sessionMetadata);
        case "reload":
            return commandSuccess("Reloaded agent command metadata.");
        default:
            return commandNoop(`Agent command /${parsed.command} is not implemented yet.`);
    }
}
```

The first implementation must only register commands in the registry after their switch branch is implemented.

- [ ] **Step 5: Wire IPC/preload/types**

Add `agent:run-command` to `registerAgentIpcHandlers`, `emain/preload.ts`, `frontend/types/custom.d.ts`, and `frontend/preview/mock/preview-electron-api.ts` using the same pattern as `agent:clone-session`.

- [ ] **Step 6: Run IPC type tests**

Run:

```bash
npm test -- emain/agent-ipc.test.ts emain/agent/commands/session-command-results.test.ts --run
```

Expected: tests pass or existing unrelated failures are reported with exact file names.

- [ ] **Step 7: Commit**

Run:

```bash
git add emain/agent/commands/types.ts emain/agent/commands/session-command-results.ts emain/agent/commands/session-command-results.test.ts emain/agent-ipc.ts emain/preload.ts frontend/types/custom.d.ts frontend/preview/mock/preview-electron-api.ts
git commit -m "feat: add agent command execution ipc"
```

---

### Task 4: Lightweight `/new`, `/session`, And `/copy`

**Files:**
- Modify: `emain/agent-ipc.ts`
- Modify: `frontend/app/term/render/agent-chat-host.tsx`
- Modify: `frontend/app/term/render/agent-chat-host-api.test.ts`

- [ ] **Step 1: Write host tests for session metadata updates**

Add tests that verify `/new` calls `onSessionMinted` when `runCommand` returns `sessionMetadata`, and `/session` or `/copy` only reports a message.

```ts
it("switches to a new session after /new", async () => {
    const onSessionMinted = vi.fn();
    const runCommand = vi.fn().mockResolvedValue({
        status: "success",
        message: "Created a new agent session.",
        sessionMetadata: { path: "/tmp/session.jsonl", cwd: "/tmp" },
    });
    const api = createAgentChatHostApi({ ...baseDeps, onSessionMinted, runCommand });

    api.submit("/new");
    await vi.waitFor(() => expect(onSessionMinted).toHaveBeenCalledWith({ path: "/tmp/session.jsonl", cwd: "/tmp" }));
});
```

- [ ] **Step 2: Implement `/new` backend**

Use existing `createPaneSession(cwd)` in `emain/agent-ipc.ts`:

```ts
async function runNewAgentSessionCommand(cwd: string): Promise<AgentCommandExecutionResult> {
    const { metadata } = await createPaneSession(cwd);
    return {
        status: "success",
        message: "Created a new agent session.",
        sessionMetadata: metadata,
    };
}
```

- [ ] **Step 3: Implement `/session` backend**

Use the validated metadata and existing session read helpers:

```ts
async function runSessionInfoCommand(sessionMetadata: JsonlSessionMetadata | undefined): Promise<AgentCommandExecutionResult> {
    if (!sessionMetadata?.path) return commandNoop("No active agent session yet.");
    const { session } = await validateTreeInput(sessionMetadata);
    const entries = await session.getEntries();
    const leafId = await session.getLeafId();
    return commandSuccess(
        `Session ${path.basename(sessionMetadata.path)}: ${entries.length} entries, current leaf ${leafId ?? "none"}.`
    );
}
```

- [ ] **Step 4: Implement `/copy` backend or renderer bridge**

Prefer renderer clipboard access if the current transcript is easiest to read in the renderer. If using backend data, read visible session entries and copy the latest assistant text via Electron clipboard:

```ts
async function runCopyLastAssistantMessageCommand(
    sessionMetadata: JsonlSessionMetadata | undefined
): Promise<AgentCommandExecutionResult> {
    if (!sessionMetadata?.path) return commandNoop("No active agent session yet.");
    const { session } = await validateTreeInput(sessionMetadata);
    const entries = await session.getEntries();
    const assistant = [...entries].reverse().find((entry) => entry.type === "message" && entry.role === "assistant");
    const text = assistant ? previewSessionEntry(assistant) : "";
    if (!text) return commandNoop("No assistant response to copy yet.");
    electron.clipboard.writeText(text);
    return commandSuccess(`Copied ${text.length} characters.`);
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm test -- emain/agent-ipc.test.ts frontend/app/term/render/agent-chat-host-api.test.ts --run
```

Expected: tests pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add emain/agent-ipc.ts frontend/app/term/render/agent-chat-host.tsx frontend/app/term/render/agent-chat-host-api.test.ts
git commit -m "feat: implement lightweight agent session commands"
```

---

### Task 5: `/resume` Selector

**Files:**
- Modify: `frontend/app/term/render/agent-selector-popover.tsx`
- Modify: `frontend/app/term/render/agent-chat-host.tsx`
- Modify: `frontend/types/custom.d.ts`
- Modify: `emain/agent-ipc.ts`

- [ ] **Step 1: Add resume request type**

Extend the selector request union with:

```ts
type AgentSelectorRequest =
    | ExistingTreeRequest
    | ExistingForkRequest
    | {
          type: "resume";
          listSessions: () => Promise<JsonlSessionMetadata[]>;
          resumeSession: (sessionMetadata: JsonlSessionMetadata) => Promise<{ sessionMetadata: JsonlSessionMetadata }>;
      };
```

- [ ] **Step 2: Route `/resume` to selector**

In `createAgentChatHostApi.submit()`, handle `route.command === "resume"` by calling `deps.onSelectorRequest?.({ type: "resume", listSessions, resumeSession })`.

- [ ] **Step 3: Implement list and resume helpers**

Use existing `listSessionsForCwd(cwd)` through `agent:list-sessions-for-cwd`, and implement resume by returning selected metadata to `onSessionMinted`.

```ts
const listSessions = async (): Promise<JsonlSessionMetadata[]> => {
    return await requireRuntimeApi().listSessionsForCwd(deps.getPaneCwd());
};

const resumeSession = async (sessionMetadata: JsonlSessionMetadata): Promise<{ sessionMetadata: JsonlSessionMetadata }> => {
    deps.onSessionMinted?.(sessionMetadata);
    return { sessionMetadata };
};
```

- [ ] **Step 4: Render resume rows**

In `AgentSelectorPopover`, render `request.type === "resume"` rows with session basename and modified time if present. Empty state text:

```ts
"No saved agent sessions for this workspace."
```

- [ ] **Step 5: Run selector tests**

Run:

```bash
npm test -- frontend/app/term/render/agent-selector-popover.test.tsx frontend/app/term/render/agent-chat-host-api.test.ts --run
```

Expected: tests pass. If `agent-selector-popover.test.tsx` does not exist, add focused tests for the new pure row formatting helper.

- [ ] **Step 6: Commit**

Run:

```bash
git add frontend/app/term/render/agent-selector-popover.tsx frontend/app/term/render/agent-chat-host.tsx frontend/types/custom.d.ts emain/agent-ipc.ts
git commit -m "feat: add resume agent session command"
```

---

### Task 6: `/compact`, `/export`, `/import`, And `/reload`

**Files:**
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent/commands/types.ts`
- Modify: `frontend/app/term/render/agent-chat-host-api.test.ts`

- [ ] **Step 1: Add command argument validation tests**

Add tests that `/import` rejects an empty path and `/export` accepts empty path:

```ts
it("requires an import path", async () => {
    await expect(runAgentCommandForIpc({ command: "import", cwd: "/tmp", argsText: "" })).rejects.toThrow(
        "Import path is required"
    );
});

it("allows export without a path", async () => {
    await expect(runAgentCommandForIpc(validExportInputWithoutPath)).resolves.toMatchObject({
        status: "success",
    });
});
```

- [ ] **Step 2: Implement `/compact` only after locating the existing compaction entry point**

Use the existing session runtime compaction method instead of duplicating Pi internals. The switch branch should return:

```ts
return commandSuccess(argsText ? `Compacted session with instructions: ${argsText}` : "Compacted session context.");
```

after the compaction promise resolves.

- [ ] **Step 3: Implement JSONL `/export`**

Read the current session file path from metadata and copy it to the requested path or a deterministic default:

```ts
const exportPath = argsText || path.join(os.tmpdir(), `${path.basename(sessionMetadata.path, ".jsonl")}-export.jsonl`);
await fs.promises.copyFile(sessionMetadata.path, exportPath);
return commandSuccess(`Exported session to ${exportPath}.`);
```

- [ ] **Step 4: Implement JSONL `/import`**

Validate the path and create a session metadata record using the existing session manager import/session registration path. If the codebase only supports direct session paths, return selected metadata for that path:

```ts
if (!argsText) throw new Error("Import path is required.");
await fs.promises.access(argsText, fs.constants.R_OK);
const metadata = await importJsonlSessionForCwd(argsText, cwd);
return {
    status: "success",
    message: `Imported session ${path.basename(argsText)}.`,
    sessionMetadata: metadata,
};
```

- [ ] **Step 5: Implement `/reload` metadata refresh**

For this slice, return a precise message after command metadata is rebuilt:

```ts
return commandSuccess(`Reloaded ${getBuiltInAgentCommands().length} agent commands.`);
```

- [ ] **Step 6: Run focused backend tests**

Run:

```bash
npm test -- emain/agent-ipc.test.ts emain/agent/commands/registry.test.ts --run
```

Expected: tests pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add emain/agent-ipc.ts emain/agent/commands/types.ts frontend/app/term/render/agent-chat-host-api.test.ts
git commit -m "feat: implement pi command baseline actions"
```

---

### Task 7: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run slash command regression suite**

Run:

```bash
npm test -- emain/agent/commands/registry.test.ts frontend/app/view/cmdblock/cmdblock-input-focus.test.ts frontend/app/term/render/agent-chat-host-api.test.ts frontend/app/term/render/agent-slash-command-routing.test.ts --run
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run formatting**

Run:

```bash
npx prettier --check emain/agent/commands/types.ts emain/agent/commands/registry.ts emain/agent-ipc.ts emain/preload.ts frontend/types/custom.d.ts frontend/preview/mock/preview-electron-api.ts frontend/app/term/render/agent-chat-host.tsx frontend/app/term/render/agent-slash-command-routing.ts frontend/app/term/render/agent-selector-popover.tsx frontend/app/view/cmdblock/cmdblock-input.tsx
```

Expected: Prettier reports all files are formatted.

- [ ] **Step 3: Run diff check**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 4: Confirm exposed command list manually**

In Crest, type `/` in the agent input and verify only implemented commands appear:

```text
/tree
/fork
/clone
/model
/new
/resume
/compact
/session
/copy
/export
/import
/reload
```

- [ ] **Step 5: Commit verification-only fixes if any**

If formatting changed files, commit:

```bash
git add .
git commit -m "style: format pi command baseline"
```

If no files changed, do not create an empty commit.

