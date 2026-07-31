# Context Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Context tab that opens from the composer ring and accurately explains the effective context inherited by the current Agent's next model call.

**Architecture:** A pure coding-agent snapshot builder will turn the same system-prompt manifest, active tools, effective session messages, added-context journal, and provider-ready payload used by the request path into an immutable semantic inventory. The main process owns preview and live snapshot production; `AgentSessionRuntime` transports live lifecycle changes; the renderer stores only the latest identity-matching snapshot in the workspace Agent model. The ring and right-panel tab render that shared snapshot and never infer context from transcript or prior usage.

**Tech Stack:** TypeScript, Electron IPC, React 19, Jotai, Tailwind v4, Vitest, Testing Library, TanStack Virtual.

---

## Implementation constraints

- Keep release one read-only. Do not add exclusion state, mutation controls, disabled action affordances, or transcript deletion.
- Preserve the effective request as the source of truth. Renderer code may format snapshot data but may not tokenize messages, inspect prior usage, or assign semantic categories.
- Treat lifecycle and count accuracy as independent dimensions.
- Clear a snapshot immediately when session, branch, or model identity changes. Retain a prior snapshot only for a same-identity refresh failure, marked `out_of_date`.
- Keep provider calls operational if inspection, counting, transport, or rendering fails.
- Use stable source identities: session entry IDs, tool names and call IDs, resource paths, skill names, attachment/artifact IDs, and compaction entry IDs.
- Follow `.kilocode/skills/electron-api/SKILL.md` for the new preview IPC method, including the preview-environment stub.
- Run all commands from the active Context Inspector worktree root. For this execution that root is `/Users/bytedance/Documents/crest/.worktrees/context-inspector`.

## Snapshot contract

Create the canonical contract in `packages/coding-agent/context/inspector-types.ts`. Renderer ambient declarations in `frontend/types/custom.d.ts` mirror this contract at the process boundary.

```ts
export type ContextSnapshotLifecycle =
    | "ready"
    | "in_use"
    | "waiting_for_tool"
    | "updating"
    | "out_of_date"
    | "unavailable";

export type ContextSnapshotAccuracy = "exact" | "estimated" | "unavailable";

export type ContextSnapshotCategory =
    | "agent_instructions"
    | "tools"
    | "conversation"
    | "added_context";

export type ContextSnapshotItemKind =
    | "base_prompt"
    | "runtime_guidance"
    | "project_instruction"
    | "skill"
    | "tool_definition"
    | "turn"
    | "compaction_summary"
    | "branch_summary"
    | "context_reference";

export interface ContextSnapshotIdentity {
    sessionPath?: string;
    sessionId?: string;
    leafId: string | null;
    modelKey: string;
    revision: number;
}

export interface ContextSnapshotItemSource {
    entryIds?: string[];
    path?: string;
    skillName?: string;
    toolName?: string;
    toolCallId?: string;
    pairedResultEntryId?: string;
    coveredEntryIds?: string[];
    attachmentEntryId?: string;
    artifactEntryId?: string;
}

export interface ContextSnapshotItem {
    id: string;
    category: ContextSnapshotCategory;
    kind: ContextSnapshotItemKind;
    title: string;
    preview: string;
    tokens?: number;
    tokenAccuracy: "estimated" | "unavailable";
    source: ContextSnapshotItemSource;
    children?: ContextSnapshotItem[];
}

export interface ContextSnapshotCategorySummary {
    category: ContextSnapshotCategory;
    tokens?: number;
    itemCount: number;
}

export interface AgentContextSnapshot {
    schemaVersion: 1;
    identity: ContextSnapshotIdentity;
    generatedAt: string;
    lifecycle: ContextSnapshotLifecycle;
    accuracy: ContextSnapshotAccuracy;
    modelLabel: string;
    contextWindow: number;
    outputReserve: number;
    inputCapacity: number;
    effectiveInputTokens?: number;
    remainingInputTokens?: number;
    requestOverheadTokens?: number;
    attributionDeltaTokens?: number;
    categories: ContextSnapshotCategorySummary[];
    items: ContextSnapshotItem[];
    diagnostic?: string;
}
```

`effectiveInputTokens` is the final provider-ready input count when available. Item/category counts are independently attributed and retain their own estimated status. `requestOverheadTokens` is only a non-negative unassigned difference. If estimated item attribution exceeds an exact total, keep the exact total, set `attributionDeltaTokens` to the signed difference, and expose a diagnostic; never rescale category values.

## Task 1: Build the pure snapshot schema and reconciliation rules

**Files:**

- Create: `packages/coding-agent/context/inspector-types.ts`
- Create: `packages/coding-agent/context/inspector.ts`
- Create: `packages/coding-agent/context/inspector.test.ts`
- Modify: `packages/coding-agent/context/types.ts`

- [x] Write failing tests for capacity and total semantics:

```ts
it("subtracts output reserve from usable input capacity", () => {
    const snapshot = buildContextSnapshot(fixture({ contextWindow: 200_000, outputReserve: 16_000 }));
    expect(snapshot.inputCapacity).toBe(184_000);
});

it("uses provider input without adding cache, output, or reasoning usage", () => {
    const snapshot = buildContextSnapshot(fixture({ providerInputTokens: 25_053 }));
    expect(snapshot.effectiveInputTokens).toBe(25_053);
});
```

- [x] Run `npx vitest run packages/coding-agent/context/inspector.test.ts` and verify failure because the module does not exist.
- [x] Add the contract shown above and export it from `packages/coding-agent/context/types.ts`; the package wildcard export already exposes `context/inspector-types` directly.
- [x] Implement `buildContextSnapshot`, `summarizeContextCategories`, `reconcileContextAttribution`, and `markContextSnapshotLifecycle` as pure functions.
- [x] Add tests proving fixed category order, stable IDs, non-negative request overhead, explicit attribution delta, estimated fallback, unavailable counts, and `remainingInputTokens = max(0, inputCapacity - effectiveInputTokens)`.
- [x] Run `npx vitest run packages/coding-agent/context/inspector.test.ts` and expect all tests to pass.
- [ ] Commit:

```bash
git add packages/coding-agent/context/inspector-types.ts packages/coding-agent/context/inspector.ts packages/coding-agent/context/inspector.test.ts packages/coding-agent/context/types.ts
git commit -m "feat: define agent context snapshots"
```

## Task 2: Produce a provenance-preserving system-prompt manifest

**Files:**

- Modify: `packages/coding-agent/build-system-prompt.ts`
- Create: `packages/coding-agent/build-system-prompt.test.ts`
- Modify: `packages/coding-agent/harness-factory.ts`
- Modify: `packages/coding-agent/harness-factory.test.ts`
- Modify: `packages/agent/harness/types.ts`
- Modify: `packages/agent/harness/agent-harness.ts`
- Modify: `packages/agent/harness/agent-harness.test.ts`
- Modify: `packages/agent/harness/system-prompt.ts`

- [x] Add failing prompt tests for separate base prompt, runtime guidance, each project file, each skill, custom/append prompt content, and deterministic source IDs.
- [x] Run `npx vitest run packages/coding-agent/build-system-prompt.test.ts packages/coding-agent/harness-factory.test.ts` and verify the manifest assertions fail.
- [x] Add this focused prompt return type:

```ts
export interface SystemPromptSegment {
    id: string;
    kind: "base_prompt" | "runtime_guidance" | "project_instruction" | "skill";
    title: string;
    text: string;
    path?: string;
    skillName?: string;
}

export interface SystemPromptManifest {
    text: string;
    segments: SystemPromptSegment[];
}
```

- [x] Implement `buildSystemPromptManifest(inputs)` by assembling the final text from the same segment strings used for provenance; retain `buildSystemPrompt(inputs)` as `return buildSystemPromptManifest(inputs).text`.
- [x] Add `AgentHarnessSystemPrompt { text: string; metadata?: unknown }` to the harness contract and allow the system-prompt callback to return either a string or that object.
- [x] Normalize both forms in `AgentHarness.createTurnState`; carry `systemPromptMetadata` in turn state while continuing to pass only `text` to the model.
- [x] Make `harness-factory.ts` return `{ text: manifest.text, metadata: manifest }` from the callback.
- [x] Add a harness regression test proving string callbacks still work and structured callbacks retain metadata without changing the provider-visible prompt.
- [x] Run `npx vitest run packages/coding-agent/build-system-prompt.test.ts packages/coding-agent/harness-factory.test.ts packages/agent/harness/agent-harness.test.ts` and expect all tests to pass.
- [ ] Commit:

```bash
git add packages/coding-agent/build-system-prompt.ts packages/coding-agent/build-system-prompt.test.ts packages/coding-agent/harness-factory.ts packages/coding-agent/harness-factory.test.ts packages/agent/harness/types.ts packages/agent/harness/agent-harness.ts packages/agent/harness/agent-harness.test.ts packages/agent/harness/system-prompt.ts
git commit -m "feat: preserve system prompt provenance"
```

## Task 3: Convert effective session context into semantic inventory

**Files:**

- Modify: `packages/coding-agent/context/inspector.ts`
- Modify: `packages/coding-agent/context/inspector.test.ts`
- Modify: `packages/coding-agent/context/history.ts`
- Modify: `packages/coding-agent/context/history.test.ts`
- Modify: `packages/agent/harness/agent-harness.ts`
- Modify: `packages/agent/harness/types.ts`
- Modify: `packages/agent/harness/agent-harness.test.ts`

- [x] Write failing fixtures for a normal turn, an assistant tool call paired with its tool result, a compacted branch, a branch summary, a conversation-scoped context reference, and a message-scoped context reference.
- [x] Assert that Conversation groups complete turns, tool call/result pairs remain children of the same turn, compacted source turns disappear, and the compaction item records its covered entry IDs.
- [x] Assert that both reference scopes remain `added_context` even when `decorateContextHistory` renders their text into a user or system representation.
- [x] Run `npx vitest run packages/coding-agent/context/inspector.test.ts packages/coding-agent/context/history.test.ts` and verify the new cases fail.
- [x] Consume `SessionContext.messageEntryIds` and active branch entries instead of reducing durable provenance to message array positions. Provider observation carries the leaf ID in Task 4.
- [x] Implement `buildConversationItems` against the effective `SessionContext`, using entry IDs to resolve durable metadata from the active branch.
- [x] Use the committed context journal to create Added context items keyed by `attachmentEntryId` and `artifactEntryId`; do not classify by final message role.
- [x] Add malformed-source handling that emits an item diagnostic and unavailable attribution without dropping the remaining inventory.
- [x] Run `npx vitest run packages/coding-agent/context/inspector.test.ts packages/coding-agent/context/history.test.ts packages/agent/harness/agent-harness.test.ts` and expect all tests to pass.
- [x] Commit:

```bash
git add packages/coding-agent/context/inspector.ts packages/coding-agent/context/inspector.test.ts packages/coding-agent/context/history.ts packages/coding-agent/context/history.test.ts packages/agent/harness/agent-harness.ts packages/agent/harness/types.ts packages/agent/harness/agent-harness.test.ts
git commit -m "feat: inventory effective agent context"
```

## Task 4: Observe provider-ready context without changing request behavior

**Files:**

- Modify: `packages/agent/harness/types.ts`
- Modify: `packages/agent/harness/agent-harness.ts`
- Modify: `packages/agent/harness/agent-harness.test.ts`
- Modify: `packages/coding-agent/harness-factory.ts`
- Modify: `packages/coding-agent/harness-factory.test.ts`

- [x] Add failing harness tests proving inspection occurs after the `context` and `before_provider_payload` transformations and sees exactly the model, system prompt, messages, tools, request options, and final payload used by `streamSimple`.
- [x] Add a failure-isolation test proving an inspection callback exception does not prevent the provider stream from starting.
- [x] Run `npx vitest run packages/agent/harness/agent-harness.test.ts packages/coding-agent/harness-factory.test.ts` and verify failure.
- [x] Add an optional non-blocking `observeProviderContext` callback to `AgentHarnessOptions`:

```ts
export interface AgentHarnessProviderContextObservation {
    model: Model<any>;
    sessionId: string;
    leafId: string | null;
    systemPrompt: string;
    systemPromptMetadata?: unknown;
    messages: AgentMessage[];
    messageEntryIds: Array<string | undefined>;
    activeTools: AgentTool[];
    requestOptions: AgentHarnessStreamOptions;
    payload: unknown;
}
```

- [x] Invoke the observer in `createStreamFn` after the final payload transformation and before dispatch, catching and reporting inspection failure through a dedicated diagnostic callback rather than the harness hook chain.
- [x] Preserve message-entry identity when context transforms replace message objects: entry IDs remain aligned for unchanged messages, while injected messages receive `undefined` and the inventory builder assigns a stable synthetic position identity.
- [x] Wire the optional observer through `buildAgentHarnessHost` without importing coding-agent snapshot types into the generic harness.
- [x] Run the targeted tests and expect all to pass.
- [x] Commit:

```bash
git add packages/agent/harness/types.ts packages/agent/harness/agent-harness.ts packages/agent/harness/agent-harness.test.ts packages/coding-agent/harness-factory.ts packages/coding-agent/harness-factory.test.ts
git commit -m "feat: observe provider context requests"
```

## Task 5: Count provider-ready input and own snapshot lifecycle in the runtime

**Files:**

- Modify: `packages/coding-agent/context/inspector.ts`
- Modify: `packages/coding-agent/context/inspector.test.ts`
- Modify: `packages/coding-agent/context/provider-adapter.ts`
- Modify: `packages/coding-agent/context/provider-adapter.test.ts`
- Modify: `packages/coding-agent/agent-session-runtime.ts`
- Modify: `packages/coding-agent/agent-session-runtime.test.ts`
- Modify: `packages/coding-agent/harness-factory.ts`

- [x] Add failing runtime tests for these transitions: `updating → ready`, `ready → in_use`, `in_use → waiting_for_tool`, tool result completion back to `in_use`, settled run back to `ready`, same-identity failure to `out_of_date`, and identity-changing failure to `unavailable`.
- [x] Add tests proving cached input, provider output, and reasoning usage never enter `effectiveInputTokens`.
- [x] Add an adapter test proving a provider-compatible counter receives the already-finalized payload rather than rebuilding a second payload.
- [x] Run `npx vitest run packages/coding-agent/context/inspector.test.ts packages/coding-agent/context/provider-adapter.test.ts packages/coding-agent/agent-session-runtime.test.ts` and verify failure.
- [x] Add `contextSnapshot?: AgentContextSnapshot` and a monotonic `contextSnapshotRevision` to `AgentSessionRuntimeState`.
- [x] Implement `refreshContextSnapshot(config, reason)` for idle previews using the harness's effective branch context, current prompt manifest, tools, and current model without a user draft.
- [x] Build live `in_use` snapshots from the provider observer's final payload; call `countFinalRequest` only when the provider adapter supports it, otherwise use the documented estimator and mark accuracy `estimated`.
- [x] On `tool_execution_start`, publish `waiting_for_tool` from the last matching snapshot; on completed tool result, allow the next provider observation to include that result exactly once.
- [x] Rebuild after compact, tree navigation, model selection, resource reload, and settled runs. Coalesce duplicate idle refresh requests by identity and revision.
- [x] Catch all inspector failures outside the send promise and preserve runtime execution. Same-identity failures retain the prior snapshot with `out_of_date`; model/session/leaf changes clear it first.
- [x] Include `contextSnapshot` in `getSessionState()` and emitted `session_state` events.
- [x] Run the targeted tests and expect all to pass.
- [x] Commit:

```bash
git add packages/coding-agent/context/inspector.ts packages/coding-agent/context/inspector.test.ts packages/coding-agent/context/provider-adapter.ts packages/coding-agent/context/provider-adapter.test.ts packages/coding-agent/agent-session-runtime.ts packages/coding-agent/agent-session-runtime.test.ts packages/coding-agent/harness-factory.ts
git commit -m "feat: maintain live context snapshots"
```

## Task 6: Add authenticated preview IPC, including the pre-session case

**Files:**

- Modify: `frontend/types/custom.d.ts`
- Modify: `emain/preload.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `frontend/preview/mock/preview-electron-api.ts`
- Modify: `frontend/app/agent/agent-runtime-client.ts`
- Modify: `frontend/app/agent/agent-runtime-client.test.ts`

- [ ] Add failing IPC tests for an empty pre-session preview, an existing persisted session, a live runtime, workspace authorization failure, model change, branch change, and unavailable counting.
- [ ] Run `npx vitest run emain/agent-ipc.test.ts frontend/app/agent/agent-runtime-client.test.ts` and verify the new cases fail.
- [ ] Add renderer boundary inputs that reuse the send configuration without message content:

```ts
type AgentInspectContextOptions = Omit<AgentSendOptions, "text" | "images" | "contextAttachments"> & {
    sessionMetadata?: AgentSessionMeta;
};

type AgentInspectContextResult = {
    snapshot: AgentContextSnapshotView;
};
```

- [ ] Add `ElectronApi.agent.inspectContext`, preload channel `agent:inspect-context`, and the preview stub required by the Electron API guide.
- [ ] Authenticate the workspace and validate the execution context exactly as `agent:send` does.
- [ ] For an existing session, acquire or create its runtime, synchronize model/resources, call `refreshContextSnapshot`, and return the matching immutable snapshot.
- [ ] For no session, build a stateless base preview from current prompt inputs, resource manager snapshot, default tool definitions, and selected model. Do not mint or persist a session.
- [ ] Extend session-state payloads and live event fan-out with `contextSnapshot`.
- [ ] Add `AgentRuntimeClient.inspectContext(options)` and type it as `Promise<AgentInspectContextResult>`.
- [ ] Run the targeted tests and expect all to pass.
- [ ] Commit:

```bash
git add frontend/types/custom.d.ts emain/preload.ts emain/agent-ipc.ts emain/agent-ipc.test.ts frontend/preview/mock/preview-electron-api.ts frontend/app/agent/agent-runtime-client.ts frontend/app/agent/agent-runtime-client.test.ts
git commit -m "feat: expose agent context inspection"
```

## Task 7: Transport snapshots through the renderer and reject stale identities

**Files:**

- Modify: `frontend/app/store/use-pi-chat.ts`
- Modify: `frontend/app/store/use-pi-chat.test.tsx`
- Modify: `frontend/app/agent/agent-chat-host.tsx`
- Modify: `frontend/app/agent/agent-chat-host.test.tsx`
- Modify: `frontend/app/agent/agent-content.tsx`
- Modify: `frontend/app/agent/agent-content.test.tsx`
- Modify: `frontend/app/workspace/workspace-agent-model.ts`
- Modify: `frontend/app/workspace/workspace-agent-model.test.ts`

- [ ] Add failing reducer and model tests proving session-state/live snapshots are accepted only when session path, model key, leaf ID, and revision match the current identity.
- [ ] Add tests that a selected session/model change immediately sets the view to `updating` with no old inventory, while a same-identity refresh failure keeps the prior inventory as `out_of_date`.
- [ ] Run `npx vitest run frontend/app/store/use-pi-chat.test.tsx frontend/app/agent/agent-chat-host.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/workspace/workspace-agent-model.test.ts` and verify failure.
- [ ] Add `contextSnapshot?: AgentContextSnapshotView` to `PiAgentEvent`, `UsePiChatReturn`, and `AgentHostState`.
- [ ] On session/model/execution-context changes, call `client.inspectContext` through an abortable effect keyed by the complete identity. Do not call it on composer keystrokes.
- [ ] Add a transient `contextSnapshotAtom` to `WorkspaceAgentModel`. Do not add it to `AgentStateFields`, serialization, or checkpoint persistence.
- [ ] Add model methods `beginContextSnapshotUpdate(identity)`, `publishContextSnapshot(snapshot)`, and `failContextSnapshotUpdate(identity, message)` using `globalStore.get/set` and strict identity matching.
- [ ] Publish host snapshots into the workspace model from `AgentContent`; clear them on controlled-session generation changes and invalid model selection.
- [ ] Remove `getLatestAgentContextUsage` and `mapPiUsageToContextUsage` from the ring data path after snapshot transport is complete.
- [ ] Run the targeted tests and expect all to pass.
- [ ] Commit:

```bash
git add frontend/app/store/use-pi-chat.ts frontend/app/store/use-pi-chat.test.tsx frontend/app/agent/agent-chat-host.tsx frontend/app/agent/agent-chat-host.test.tsx frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx frontend/app/workspace/workspace-agent-model.ts frontend/app/workspace/workspace-agent-model.test.ts
git commit -m "feat: mirror current context snapshots"
```

## Task 8: Register the Context right-panel tool and open it from the ring

**Files:**

- Modify: `frontend/app/workspace/right-tool-panel-state.ts`
- Modify: `frontend/app/workspace/right-tool-panel-state.test.ts`
- Modify: `frontend/app/workspace/right-tool-panel.tsx`
- Modify: `frontend/app/workspace/right-tool-panel.test.tsx`
- Modify: `frontend/app/workspace/workspace-right-panel-host.tsx`
- Create: `frontend/app/workspace/workspace-right-panel-host.test.tsx`
- Modify: `frontend/app/agent/assistant-ui/context-display.tsx`
- Modify: `frontend/app/agent/assistant-ui/context-display.test.tsx`
- Modify: `frontend/app/agent/assistant-ui/registry-thread.tsx`
- Modify: `frontend/app/agent/assistant-ui/thread.integration.test.tsx`
- Modify: `frontend/app/agent/agent-content.tsx`

- [ ] Add failing tests that `context` is a valid persisted right-tool ID, metadata labels it `Context`, and clicking the ring calls `WorkspaceLayoutModel.openRightTool("context")`.
- [ ] Add ring tests for `effectiveInputTokens / inputCapacity`, first-prompt visibility, exact/estimated labeling, and no output/cache/reasoning rows.
- [ ] Run `npx vitest run frontend/app/workspace/right-tool-panel-state.test.ts frontend/app/workspace/right-tool-panel.test.tsx frontend/app/workspace/workspace-right-panel-host.test.tsx frontend/app/agent/assistant-ui/context-display.test.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx` and verify failure.
- [ ] Add `context` to `RightToolId`, `RightToolIds`, metadata, normalization, launcher menu, and `RightToolContent` routing.
- [ ] Pass `agentModel` or its snapshot atom into `RightToolPanel` so the Context content subscribes directly to the same immutable snapshot used by AgentContent.
- [ ] Replace `CrestContextUsage` with a focused ring value derived from `AgentContextSnapshotView`:

```ts
export type CrestContextDisplayValue = Pick<
    AgentContextSnapshotView,
    "effectiveInputTokens" | "inputCapacity" | "accuracy" | "lifecycle"
>;
```

- [ ] Add `onOpen` to `ContextDisplayRing`, preserve tooltip behavior, and use an accessible label such as `Open Context Inspector, 13 percent used`.
- [ ] Wire the ring click to `WorkspaceLayoutModel.getInstance().openRightTool("context")` through an explicit callback supplied by `AgentContent`.
- [ ] Run the targeted tests and expect all to pass.
- [ ] Commit:

```bash
git add frontend/app/workspace/right-tool-panel-state.ts frontend/app/workspace/right-tool-panel-state.test.ts frontend/app/workspace/right-tool-panel.tsx frontend/app/workspace/right-tool-panel.test.tsx frontend/app/workspace/workspace-right-panel-host.tsx frontend/app/workspace/workspace-right-panel-host.test.tsx frontend/app/agent/assistant-ui/context-display.tsx frontend/app/agent/assistant-ui/context-display.test.tsx frontend/app/agent/assistant-ui/registry-thread.tsx frontend/app/agent/assistant-ui/thread.integration.test.tsx frontend/app/agent/agent-content.tsx
git commit -m "feat: open context inspector from composer"
```

## Task 9: Build the read-only capacity and composition panel

**Files:**

- Create: `frontend/app/agent/context-inspector/context-inspector.tsx`
- Create: `frontend/app/agent/context-inspector/context-inspector.test.tsx`
- Create: `frontend/app/agent/context-inspector/context-composition.tsx`
- Create: `frontend/app/agent/context-inspector/context-format.ts`
- Create: `frontend/app/agent/context-inspector/context-format.test.ts`
- Modify: `frontend/app/workspace/right-tool-panel.tsx`

- [ ] Write failing UI tests for ready, in-use, waiting, updating, out-of-date, unavailable, exact, estimated, and token-count-unavailable combinations.
- [ ] Add assertions for model label, used/capacity, full window, output reserve, remaining input, four fixed categories, request overhead, and signed attribution diagnostic.
- [ ] Run `npx vitest run frontend/app/agent/context-inspector/context-inspector.test.tsx frontend/app/agent/context-inspector/context-format.test.ts` and verify failure.
- [ ] Implement pure format helpers for token counts, percentages, timestamps, lifecycle labels, and accuracy labels.
- [ ] Implement `ContextInspector` with a compact sticky header, capacity card, semantic composition bar, category summary rows, and explicit empty/unavailable states.
- [ ] Use category colors consistently between the composition bar, rows, and ring tooltip. Ensure color is not the only carrier of meaning.
- [ ] Render request overhead as a separate neutral segment only when positive; render `attributionDeltaTokens` as an explanatory diagnostic rather than changing category values.
- [ ] Add narrow-panel tests at 320 px-equivalent container width and keyboard-focus assertions for interactive disclosure controls.
- [ ] Run the targeted tests and expect all to pass.
- [ ] Commit:

```bash
git add frontend/app/agent/context-inspector/context-inspector.tsx frontend/app/agent/context-inspector/context-inspector.test.tsx frontend/app/agent/context-inspector/context-composition.tsx frontend/app/agent/context-inspector/context-format.ts frontend/app/agent/context-inspector/context-format.test.ts frontend/app/workspace/right-tool-panel.tsx
git commit -m "feat: render context capacity and composition"
```

## Task 10: Build the expandable semantic inventory

**Files:**

- Create: `frontend/app/agent/context-inspector/context-inventory.tsx`
- Create: `frontend/app/agent/context-inspector/context-inventory.test.tsx`
- Create: `frontend/app/agent/context-inspector/context-item.tsx`
- Modify: `frontend/app/agent/context-inspector/context-inspector.tsx`
- Modify: `frontend/app/agent/context-inspector/context-inspector.test.tsx`

- [ ] Write failing tests for category expansion, turn expansion, user/assistant/tool labels, paired tool call/result display, compact summary coverage, instruction provenance, tool schema preview, Added context provenance, and source diagnostics.
- [ ] Add a long-list test with 1,000 conversation items proving only the visible window plus overscan is mounted while category totals remain unchanged.
- [ ] Run `npx vitest run frontend/app/agent/context-inspector/context-inventory.test.tsx frontend/app/agent/context-inspector/context-inspector.test.tsx` and verify failure.
- [ ] Implement native button-based disclosure rows with `aria-expanded`, visible focus, keyboard activation, and stable keys from `item.id`.
- [ ] Render category-specific detail without exposing raw provider payload JSON by default:

```ts
const ItemLabels: Record<ContextSnapshotItemKindView, string> = {
    base_prompt: "Base instructions",
    runtime_guidance: "Runtime guidance",
    project_instruction: "Project instructions",
    skill: "Skill",
    tool_definition: "Tool definition",
    turn: "Conversation turn",
    compaction_summary: "Compacted history",
    branch_summary: "Branch summary",
    context_reference: "Added context",
};
```

- [ ] Use `@tanstack/react-virtual` only for the Conversation item list; keep category and detail state outside the virtual rows so expansion survives scrolling.
- [ ] Display compaction coverage using durable entry IDs resolved to concise turn labels. Never include replaced turns in active item or token totals.
- [ ] Display tool result status and pairing but do not create standalone top-level tool-result items.
- [ ] Run the targeted tests and expect all to pass.
- [ ] Commit:

```bash
git add frontend/app/agent/context-inspector/context-inventory.tsx frontend/app/agent/context-inspector/context-inventory.test.tsx frontend/app/agent/context-inspector/context-item.tsx frontend/app/agent/context-inspector/context-inspector.tsx frontend/app/agent/context-inspector/context-inspector.test.tsx
git commit -m "feat: render context source inventory"
```

## Task 11: Cover end-to-end lifecycle and failure isolation

**Files:**

- Modify: `packages/coding-agent/agent-session-runtime.test.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `frontend/app/store/use-pi-chat.test.tsx`
- Modify: `frontend/app/agent/agent-content.test.tsx`
- Modify: `frontend/app/workspace/workspace-app.test.tsx`
- Modify: `frontend/app/agent/context-inspector/context-inspector.test.tsx`

- [ ] Add an integration fixture that opens a new Agent with a selected model and verifies instructions/tools appear before the first prompt without creating a session.
- [ ] Add a two-turn fixture and verify Conversation updates after each completed turn.
- [ ] Add a tool-loop fixture and verify `waiting_for_tool`, one completed tool result, and the subsequent `in_use` snapshot.
- [ ] Add compact and branch-navigation fixtures and verify replaced turns disappear and stale inventory never crosses leaf identity.
- [ ] Add model-switch and session-switch fixtures and verify the prior snapshot clears before the replacement arrives.
- [ ] Add counter rejection and snapshot-builder rejection fixtures and verify send, tool execution, persistence, and final assistant rendering still complete.
- [ ] Run:

```bash
npx vitest run packages/coding-agent/agent-session-runtime.test.ts emain/agent-ipc.test.ts frontend/app/store/use-pi-chat.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/workspace/workspace-app.test.tsx frontend/app/agent/context-inspector/context-inspector.test.tsx
```

- [ ] Expect all integration tests to pass with no unhandled promise rejections.
- [ ] Commit:

```bash
git add packages/coding-agent/agent-session-runtime.test.ts emain/agent-ipc.test.ts frontend/app/store/use-pi-chat.test.tsx frontend/app/agent/agent-content.test.tsx frontend/app/workspace/workspace-app.test.tsx frontend/app/agent/context-inspector/context-inspector.test.tsx
git commit -m "test: cover context inspector lifecycle"
```

## Task 12: Verify the complete feature and documentation

**Files:**

- Modify: `docs/superpowers/specs/2026-08-01-context-inspector-design.md`
- Modify: `docs/agent-runtime-architecture.md`
- Modify: `docs/superpowers/plans/2026-08-01-context-inspector.md`

- [ ] Update the runtime architecture with the preview path, provider observation boundary, runtime ownership, session-state transport, and renderer identity rejection.
- [ ] Check the implementation against every acceptance criterion in the design spec and mark this plan's completed checkboxes as tasks finish.
- [ ] Scan for forbidden placeholders and accidental mutation UI:

```bash
rg -n "TODO|TBD|placeholder|exclude|restore|delete context|edit context" packages/coding-agent/context frontend/app/agent/context-inspector frontend/app/agent/assistant-ui emain/agent-ipc.ts
```

- [ ] Review every hit. Existing unrelated comments may remain; new Context Inspector code must contain no placeholder behavior or context mutation controls.
- [ ] Run focused Context Inspector coverage:

```bash
npx vitest run packages/coding-agent/context/inspector.test.ts packages/coding-agent/build-system-prompt.test.ts packages/agent/harness/agent-harness.test.ts packages/coding-agent/agent-session-runtime.test.ts emain/agent-ipc.test.ts frontend/app/store/use-pi-chat.test.tsx frontend/app/workspace/right-tool-panel-state.test.ts frontend/app/agent/assistant-ui/context-display.test.tsx frontend/app/agent/context-inspector/context-inspector.test.tsx frontend/app/agent/context-inspector/context-inventory.test.tsx
```

- [ ] Run the full test suite with `npm test -- --run` and expect exit code 0.
- [ ] Run the production type/build check with `npm run build:prod` and expect exit code 0.
- [ ] Manually verify in the desktop app: no-session preview, first send, normal second turn, tool call pending/completed, model switch, session switch, compact, narrow panel, and keyboard-only disclosure.
- [ ] Confirm the ring and panel show identical numerator, denominator, lifecycle, and accuracy.
- [ ] Commit documentation and any verification-only test corrections:

```bash
git add docs/superpowers/specs/2026-08-01-context-inspector-design.md docs/agent-runtime-architecture.md docs/superpowers/plans/2026-08-01-context-inspector.md
git commit -m "docs: finalize context inspector architecture"
```

## Completion checklist

- [ ] The Context tab is read-only and opens from the context ring.
- [ ] Ring usage is effective input divided by model window minus output reserve.
- [ ] A no-session Agent shows instructions and tools before the first prompt.
- [ ] The panel inventories Agent instructions, Tools, Conversation, and Added context in fixed order.
- [ ] Conversation uses complete turns, paired tool activity, and effective compact summaries.
- [ ] Added context remains semantically Added context across provider rendering.
- [ ] Exact, estimated, waiting, updating, out-of-date, and unavailable states are distinguishable.
- [ ] Request overhead and attribution discrepancy are explicit; category counts are never silently rescaled.
- [ ] Session, leaf, model, and revision identity prevent stale cross-session display.
- [ ] Inspector failures never block Agent execution.
- [ ] Long Conversation inventories virtualize rows without changing totals.
- [ ] All targeted tests, full tests, and production build pass.
