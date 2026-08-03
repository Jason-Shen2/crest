# Agent Redo Dock Authoritative Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make conversation Redo count only reverted user messages, publish real snapshot-backed file details, and render the approved compact `Reverted messages` UI.

**Architecture:** Keep the existing rewind marker as the single source of truth. Derive user messages from the persisted pre-rewind branch and derive file rows from marker `currentStates → redoStates` with the existing diff projector; do not call Redo preview or add persistence. `RedoDock` remains presentation-only.

**Tech Stack:** TypeScript, React 19, Tailwind CSS v4, Vitest, Testing Library, existing workspace rewind snapshot store and diff projector.

---

### Task 1: Correct the reverted-message semantic

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/session-state.ts`
- Test: `packages/coding-agent/workspace-rewind/session-state.test.ts`
- Test: `packages/coding-agent/workspace-rewind/rewind-engine.test.ts`

- [ ] **Step 1: Write failing tests that distinguish user messages from assistant messages**

Extend the existing authoritative redo-view test so the original branch contains one reverted user entry followed by multiple assistant entries while the rewind marker points back to the retained boundary:

```ts
const retained = message("retained", null, "assistant");
const reverted = message("reverted", retained.id, "user", "Change README");
const assistantA = message("assistant-a", reverted.id, "assistant");
const assistantB = message("assistant-b", assistantA.id, "assistant");
const rewindData = workspaceState("session-1", "rewind");
rewindData.rewind.fromLeafId = assistantB.id;
rewindData.rewind.targetTurnId = reverted.id;
const rewind = custom("rewind", retained.id, WorkspaceControlCustomTypes.state, rewindData);

expect(view.redo?.messageCount).toBe(1);
```

Add a rewind-engine preview assertion using the same branch shape and expect `preview.messageCount` to equal the number of user entries, not all message entries.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/session-state.test.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts
```

Expected: the new assertions fail because `countRevertedMessages()` currently counts every message role.

- [ ] **Step 3: Filter the branch range to user entries**

Change `countRevertedMessages()` to count only user messages:

```ts
return branch.entries
    .slice(targetIndex)
    .filter((entry) => entry.type === "message" && entry.message.role === "user").length;
```

Do not change the branch range, target inclusion, redo marker semantics, or preview call path.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: both files pass with no failures.

- [ ] **Step 5: Commit the message semantic fix**

```bash
git add packages/coding-agent/workspace-rewind/session-state.ts packages/coding-agent/workspace-rewind/session-state.test.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts
git commit -m "fix(agent): count reverted user messages"
```

### Task 2: Project Redo files from the persisted marker

**Files:**
- Create: `packages/coding-agent/workspace-rewind/redo-view.ts`
- Create: `packages/coding-agent/workspace-rewind/redo-view.test.ts`

- [ ] **Step 1: Write failing projector tests**

Create tests for a marker whose current state is `before\n` and redo state is `after\nextra\n`:

```ts
const marker = makeRewindMarker({
    currentStates: [{ path: "docs/README.md", state: { state: "file", oid: OidBefore, executable: false } }],
    redoStates: [{ path: "docs/README.md", state: { state: "file", oid: OidAfter, executable: false } }],
});

await expect(projectRedoFileRows(marker, readBlob)).resolves.toEqual([
    expect.objectContaining({
        path: "docs/README.md",
        operation: "write",
        additions: 2,
        deletions: 1,
        conflict: "none",
    }),
]);
```

Add a second test that expects `undefined` when a redo path has no same-path entry in `currentStates`. Add a third test proving an unreadable blob still returns the file row with `previewUnavailableReason`.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/redo-view.test.ts
```

Expected: FAIL because `redo-view.ts` and `projectRedoFileRows()` do not exist.

- [ ] **Step 3: Implement the marker projector**

Create `redo-view.ts` with one focused export:

```ts
import type { AgentRewindFileRowView } from "./api-types";
import { projectWorkspacePathDiff, WorkspaceDiffPreviewBudget } from "./diff-preview";
import type { WorkspaceStateV1 } from "./types";

type RewindMarker = Extract<WorkspaceStateV1, { kind: "rewind" }>;

export async function projectRedoFileRows(
    marker: RewindMarker,
    readBlob: (oid: string) => Promise<Buffer>
): Promise<AgentRewindFileRowView[] | undefined> {
    const current = new Map(marker.currentStates.map((item) => [item.path, item.state]));
    const budget = new WorkspaceDiffPreviewBudget();
    const rows: AgentRewindFileRowView[] = [];
    for (const redo of marker.rewind.redoStates) {
        const before = current.get(redo.path);
        if (!before) return undefined;
        rows.push(
            await projectWorkspacePathDiff({
                path: redo.path,
                before,
                after: redo.state,
                readBlob,
                budget,
            })
        );
    }
    return rows;
}
```

- [ ] **Step 4: Run the projector tests and verify GREEN**

Run the command from Step 2. Expected: all projector tests pass.

- [ ] **Step 5: Commit the projector**

```bash
git add packages/coding-agent/workspace-rewind/redo-view.ts packages/coding-agent/workspace-rewind/redo-view.test.ts
git commit -m "feat(agent): project persisted redo file details"
```

### Task 3: Publish authoritative messages and file rows

**Files:**
- Modify: `packages/coding-agent/workspace-rewind/api-types.ts`
- Modify: `packages/coding-agent/workspace-rewind/session-state.ts`
- Modify: `packages/coding-agent/workspace-rewind/session-state.test.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-rewind.e2e.test.ts`
- Modify: `frontend/app/agent/agent-chat-host-api.test.ts`
- Modify: `frontend/app/agent/agent-content.test.tsx`
- Modify: `frontend/app/agent/rewind/use-agent-rewind.test.tsx`
- Modify: `frontend/app/store/use-pi-chat.test.tsx`

- [ ] **Step 1: Write failing authoritative-state assertions**

In `session-state.test.ts`, create a rewind marker with two reverted user entries and one file transition. Provide a blob reader backed by a map, then assert:

```ts
expect(view.redo).toMatchObject({
    messages: ["First request", "Second request"],
    messageCount: 2,
    fileCount: 1,
    files: [
        expect.objectContaining({
            path: "docs/README.md",
            operation: "write",
            additions: 2,
            deletions: 1,
        }),
    ],
});
```

Add an E2E assertion after a real rewind that `rewindState().redo.files` contains the changed path and statistics.

- [ ] **Step 2: Run state and E2E tests and verify RED**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/session-state.test.ts emain/agent-rewind.e2e.test.ts
```

Expected: FAIL because `AgentRedoView` has no `messages`, the probe has no blob reader, and state publishes `files: []`.

- [ ] **Step 3: Update the Redo view contract**

Replace `targetPrompt` with `messages` in both API declarations:

```ts
export interface AgentRedoView {
    operationId: string;
    messages: string[];
    messageCount: number;
    fileCount: number;
    files: AgentRewindFileRowView[];
}
```

Update `frontend/types/custom.d.ts` with the same field. Update all typed test fixtures from `targetPrompt: "..."` to `messages: ["..."]` without adding compatibility fallbacks.

- [ ] **Step 4: Return reverted user message text from session state**

Extract the existing message-content parser into `messageText()` and add:

```ts
export function revertedUserMessages(
    entries: SessionTreeEntry[],
    targetTurnId: string,
    fromLeafId: string | null
): string[] {
    const branch = activeBranch(entries, fromLeafId);
    if (!branch.valid) return [];
    const targetIndex = branch.entries.findIndex((entry) => entry.id === targetTurnId);
    if (targetIndex < 0) return [];
    return branch.entries
        .slice(targetIndex)
        .filter(isUserTurn)
        .map((entry) => messageText(entry.message));
}
```

Make `countRevertedMessages()` return `revertedUserMessages(...).length` so preview and Redo state cannot diverge.

- [ ] **Step 5: Add blob reading to the state probe and publish projected rows**

Extend the probe:

```ts
export interface AgentRewindSessionStateProbe {
    enabled: boolean;
    busy: boolean;
    frozen: boolean;
    verifySnapshot(snapshot: WorkspaceSnapshotRefV1): Promise<void>;
    readBlob(oid: string): Promise<Buffer>;
    getQuota(): Promise<AgentCheckpointQuotaView>;
}
```

Build the view from one message array and the marker projector:

```ts
const messages = revertedUserMessages(entries, state.rewind.targetTurnId, state.rewind.fromLeafId);
const files = await projectRedoFileRows(state, probe.readBlob);
if (!files) throw new Error("rewind marker is missing an expected current path state");
redo = {
    operationId: state.operationId,
    messages,
    messageCount: messages.length,
    fileCount: files.length,
    files,
};
```

Production live and cold probes must use `feature.store.readBlob(oid)`. Disabled probes use a rejecting stub that cannot be reached without a valid marker. Test probes use explicit buffers or a rejecting stub.

- [ ] **Step 6: Run the state, E2E, IPC, and frontend type consumers**

Run:

```bash
npx vitest run packages/coding-agent/workspace-rewind/session-state.test.ts packages/coding-agent/workspace-rewind/redo-view.test.ts emain/agent-rewind.e2e.test.ts emain/agent-ipc.test.ts frontend/app/agent/agent-chat-host-api.test.ts
```

Expected: all tests pass and every `AgentRedoView` fixture provides `messages`.

- [ ] **Step 7: Commit authoritative Redo state**

```bash
git add packages/coding-agent/workspace-rewind/api-types.ts packages/coding-agent/workspace-rewind/session-state.ts packages/coding-agent/workspace-rewind/session-state.test.ts frontend/types/custom.d.ts emain/agent-ipc.ts emain/agent-rewind.e2e.test.ts frontend/app/agent/agent-chat-host-api.test.ts frontend/app/agent/agent-content.test.tsx frontend/app/agent/rewind/use-agent-rewind.test.tsx frontend/app/store/use-pi-chat.test.tsx
git commit -m "fix(agent): publish authoritative redo details"
```

### Task 4: Implement the approved Redo Dock v2 UI

**Files:**
- Modify: `frontend/app/agent/rewind/redo-dock.tsx`
- Modify: `frontend/app/agent/rewind/redo-dock.test.tsx`
- Modify: `frontend/app/agent/agent-content.test.tsx`

- [ ] **Step 1: Write failing UI tests for the approved content and hierarchy**

Update `makeRedo()` to use `messages: ["First request", "Second request"]`. Assert the collapsed summary and expanded sections:

```tsx
expect(screen.getByText("2 messages · 2 files")).not.toBeNull();
fireEvent.click(screen.getByRole("button", { name: "Show reverted details" }));
expect(screen.getByText("Reverted messages")).not.toBeNull();
expect(screen.getByText("First request")).not.toBeNull();
expect(screen.getByText("Second request")).not.toBeNull();
expect(screen.getByText("2 changed")).not.toBeNull();
expect(screen.queryByText("File details are available in the Redo preview.")).toBeNull();
```

Assert the message body has no border/background request card, each message has an orange quote marker, file rows retain `hover:bg-muted/40`, and the compact header uses fixed 13px/11px typography and a `rounded-xl` shell. Preserve all existing ARIA, animation, responsive and busy assertions.

- [ ] **Step 2: Run Redo Dock and AgentContent tests and verify RED**

Run:

```bash
npx vitest run frontend/app/agent/rewind/redo-dock.test.tsx frontend/app/agent/agent-content.test.tsx
```

Expected: FAIL because the component still renders `Reverted request`, `targetPrompt`, the placeholder file notice, and the previous spacing.

- [ ] **Step 3: Render messages and real files with the compact visual hierarchy**

Implement the approved structure:

```tsx
<div className="summary-copy min-w-0">
    <p className="truncate text-[13px] font-semibold text-foreground">Changes reverted</p>
    <p className="mt-0.5 text-[11px] text-muted-foreground">
        {countLabel(redo.messageCount, "message")} · {countLabel(redo.fileCount, "file")}
    </p>
</div>
```

Render `Reverted messages` as a list with a lightweight orange quote mark and no bordered blockquote:

```tsx
<ol className="grid gap-2">
    {redo.messages.map((message, index) => (
        <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 text-xs leading-relaxed" key={index}>
            <span aria-hidden="true" className="text-lg font-semibold leading-none text-orange-400">“</span>
            <span className="text-foreground/85">{message}</span>
        </li>
    ))}
</ol>
```

Always render `redo.files`; use `<count> changed` in the Files header and remove the placeholder notice. Match the mockup with `rounded-xl`, compact 56px header proportions, `pl-[3.375rem] pr-5 py-4` details spacing, and the existing container-query mobile fallback.

- [ ] **Step 4: Run UI tests and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Format and commit the UI**

Run:

```bash
npx prettier --write frontend/app/agent/rewind/redo-dock.tsx frontend/app/agent/rewind/redo-dock.test.tsx frontend/app/agent/agent-content.test.tsx
```

Then commit:

```bash
git add frontend/app/agent/rewind/redo-dock.tsx frontend/app/agent/rewind/redo-dock.test.tsx frontend/app/agent/agent-content.test.tsx
git commit -m "feat(agent): render authoritative redo details"
```

### Task 5: Final integration verification

**Files:**
- Verify all files changed by Tasks 1–4

- [ ] **Step 1: Run the focused regression suite**

```bash
npx vitest run packages/coding-agent/workspace-rewind/redo-view.test.ts packages/coding-agent/workspace-rewind/session-state.test.ts packages/coding-agent/workspace-rewind/rewind-engine.test.ts emain/agent-rewind.e2e.test.ts emain/agent-ipc.test.ts frontend/app/agent/agent-chat-host-api.test.ts frontend/app/agent/rewind/redo-dock.test.tsx frontend/app/agent/agent-content.test.tsx
```

Expected: all selected test files pass with zero failures.

- [ ] **Step 2: Run formatting and diff checks**

```bash
npx prettier --check packages/coding-agent/workspace-rewind/redo-view.ts packages/coding-agent/workspace-rewind/redo-view.test.ts packages/coding-agent/workspace-rewind/session-state.ts packages/coding-agent/workspace-rewind/session-state.test.ts packages/coding-agent/workspace-rewind/api-types.ts frontend/types/custom.d.ts emain/agent-ipc.ts emain/agent-rewind.e2e.test.ts frontend/app/agent/rewind/redo-dock.tsx frontend/app/agent/rewind/redo-dock.test.tsx frontend/app/agent/agent-content.test.tsx
git diff --check
```

Expected: Prettier reports all matched files formatted and `git diff --check` emits no output.

- [ ] **Step 3: Run the development build**

```bash
npm run build:dev
```

Expected: exit code 0. Existing chunk-cycle and optional `sharp` image optimizer warnings are acceptable; no new TypeScript or bundling error is acceptable.

- [ ] **Step 4: Validate the original report**

In a session with one reverted user message, assistant/tool traffic, and one changed file, confirm:

- collapsed summary reads `1 message · 1 file`;
- expanded heading reads `Reverted messages` and lists the one user request;
- Files shows the actual path, diff statistics and status rather than a preview placeholder;
- Redo still opens the existing authoritative preview and conflict handling.
