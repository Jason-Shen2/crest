# Context Overlay Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/tree` and `/session` reference flows, composer draft/pin controls, reliable send recovery, and per-turn projection visibility on top of the backend-authoritative context API.

**Architecture:** `usePiChat` owns the renderer mirror of draft chips, committed pins, budget preview, and Projection Reports. Draft representation/lifecycle choices are local until send; explicit Summary actions and every committed-pin mutation go through Electron main, and artifact content never crosses into the renderer. `agent:send` receives ordered draft choices plus explicitly paused pin IDs and clears drafts only after their transaction commits. `AgentChatHost` exposes typed operations to selectors and `WorkspaceAgentSurface` renders chips/panels without creating a second context state store.

**Tech stack:** React, TypeScript, Jotai-backed AI config, assistant-ui, Electron preload API, Vitest/Testing Library.

**Design:** `docs/specs/2026-07-20-cross-session-context-reference-design.md`

**Backend dependency:** `docs/plans/2026-07-21-context-overlay-backend-plan.md`

## Scope and ownership

This plan owns:

- renderer context state and reducers;
- `usePiChat` context API integration;
- `AgentChatHost` context/session selector commands;
- composer draft/pin controls;
- `/tree` reference buttons and `/session` management/reference flow;
- projection report presentation;
- renderer command registry migration from `/resume` and old `/session` to `/session` and `/info`;
- disabled/config-unavailable presentation, authoritative budget gating, and send recovery without bypass.

The backend plan already owns ambient Electron API types, preload methods, preview stubs, journal persistence, and IPC validation. Do not redefine those contracts here.

## UX contract

### `/tree`

- Keeps its existing navigation behavior on row click and Enter.
- Only user-message rows show an Add reference button.
- Add reference snapshots that turn and creates a default Once + Full draft chip.
- Clicking Add reference never navigates the tree.

### `/session`

- Opens the existing session-selector surface as a session manager.
- Top-level modes are Resume and Reference.
- Resume keeps the current workspace/all scope and session-switch behavior.
- Reference opens a selected source session detail view with:
  - Reference active branch; and
  - user-message turn reference points.
- Active branch and turn selections both default to Once + Full.

### Composer

- Draft chips expose lifecycle and requested representation controls.
- Selecting Summary starts an explicit asynchronous summary action; Send is disabled while it is pending or missing.
- Selecting Metadata is local and never invokes a model.
- Committed pin chips expose representation, Resummarize, pause-for-this-turn, and detach controls, not lifecycle changes.
- A chip preparing/queued for send is locked to the choices captured by that send.
- Drafts disappear only when `agent:send` resolves with their committed turn.
- Send failure leaves drafts intact, marks them retryable, and restores the submitted text through the existing composer text-restore path.
- Budget preview becomes stale whenever model, composer, history/tools, representation, or pin exclusions change; Send stays disabled until a matching `fits` preview arrives.
- Over-budget, unavailable-counter, missing-artifact, duplicate, and projection failures preserve text/references and require the user to adjust references or request; there is no bypass send.

### Turn report

- A compact badge appears before an assistant response when its turn has a Projection Report.
- The badge summarizes Included / Attention / Excluded counts.
- Expanding it shows each source, lifecycle, requested/rendered representation, estimated tokens, and reason.
- Per-item counts are labeled advisory, authoritative totals and count accuracy are shown, and the overlay hash is available in details.

---

### Task 1: Create the renderer context state model

**Files:**

- Create: `frontend/app/store/context-references.ts`
- Create: `frontend/app/store/context-references.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Define renderer-only types that contain views, never artifact message bodies:

```ts
export interface ContextReferenceDraftState {
  view: AgentContextDraftView;
  lifecycle: AgentContextLifecycle;
  requestedRepresentation: AgentContextRepresentation;
  status: "ready" | "summarizing" | "sending" | "error";
  errorMessage?: string;
}

export interface ContextReferenceRendererState {
  drafts: ContextReferenceDraftState[];
  pins: AgentContextPinView[];
  reportsByTurn: Record<string, AgentContextProjectionReport>;
  excludedPinAttachmentIds: string[];
  budget?: AgentContextBudgetResult;
  budgetPending: boolean;
}
```

Test pure transitions:

- prepared draft appends in selection order and deduplicates by `draftId`;
- draft lifecycle/representation can change only in `ready`/`error`;
- beginning send marks only captured draft IDs as `sending` and freezes captured choices;
- successful send removes only captured IDs;
- failed send keeps those IDs and marks them `error`;
- explicit summary begin/success/failure leaves the prior representation unchanged until a ready summary is returned, then selects Summary;
- changing any attachment choice or exclusion invalidates the current budget revision;
- only a `fits` preview whose revision matches current inputs permits a reference-bearing send;
- a draft prepared while another send is queued is not cleared by that send;
- session-state hydration replaces pins/reports but does not overwrite current drafts for the same target;
- switching target sessions clears old renderer drafts and resets pins/reports;
- projection events upsert by `targetTurnId`;
- committed pin update/detach state is replaced only from an authoritative result/event.
- pausing a pin changes only `excludedPinAttachmentIds` for the next turn and never mutates the committed pin.

- [ ] **Step 2: Implement pure helpers**

Export named functions such as:

```ts
export function contextAttachmentsForSend(drafts: ContextReferenceDraftState[]): AgentContextAttachmentDraftInput[];

export function reduceContextReferenceState(
  state: ContextReferenceRendererState,
  action: ContextReferenceAction
): ContextReferenceRendererState;
```

Avoid a second Jotai atom. State is session-specific and belongs beside `usePiChat`'s session mirror.

- [ ] **Step 3: Run tests**

Run:

```bash
npm test -- --run frontend/app/store/context-references.test.ts
```

Expected: PASS.

---

### Task 2: Integrate context state, hydration, and sends into `usePiChat`

**Files:**

- Modify: `frontend/app/store/use-pi-chat.ts`
- Modify: `frontend/app/store/use-pi-chat.test.tsx`

- [ ] **Step 1: Add failing hook tests**

Extend the fake agent API and cover:

- preparing a draft first creates a target session when none exists, persists that metadata through `onSessionMinted`, then calls `prepareContextDraft`;
- preparation adds only the lightweight view;
- discarding calls main before removing the chip;
- initial `session_state` hydrates pins/reports;
- `context_projection` events upsert reports;
- pin update/detach uses the returned authoritative `AgentContextState`;
- send captures ordered ready/error drafts, marks them sending, and passes their exact choices in `AgentSendOptions.contextAttachments`;
- send passes `excludedPinAttachmentIds` and never sends a policy/bypass field;
- choosing Summary calls `summarizeContextDraft` or `summarizeContextPin` immediately and does not defer work to send;
- Resummarize calls `summarizeContextPin` even when a prior summary is available;
- composer/model/history/tool/reference/exclusion changes debounce `previewContextBudget` and mark the prior result stale immediately;
- a reference-bearing send is rejected locally unless the matching preview status is `fits`; main-process disagreement replaces the preview and preserves text/references;
- successful send removes only the captured drafts;
- queued send keeps its chips in sending state until its own IPC promise resolves;
- transaction rejection retains drafts, records a recovery payload, and rethrows;
- normal sends without drafts omit `contextAttachments`;
- changing `initialSession.path` clears the old target state and hydrates the new target;
- stale events from the old path do not mutate the new target;
- feature-disabled UI helpers do not call prepare/update/detach.

- [ ] **Step 2: Extend the public hook surface**

Add:

```ts
export interface ContextSendRecovery {
  text: string;
  images?: string[];
  draftIds: string[];
  errorMessage: string;
}

export interface UsePiChatReturn {
  // existing fields
  contextState: ContextReferenceRendererState;
  contextSendRecovery?: ContextSendRecovery;
  prepareContextDraft: (input: UsePiChatPrepareContextInput) => Promise<void>;
  discardContextDraft: (draftId: string) => Promise<void>;
  setContextDraftLifecycle: (draftId: string, value: AgentContextLifecycle) => void;
  setContextDraftRepresentation: (draftId: string, value: AgentContextRepresentation) => void;
  summarizeContextDraft: (draftId: string) => Promise<void>;
  summarizeContextPin: (attachmentEntryId: string, resummarize?: boolean) => Promise<void>;
  setContextPinExcluded: (attachmentEntryId: string, excluded: boolean) => void;
  updateContextPin: (attachmentEntryId: string, value: AgentContextRepresentation) => Promise<void>;
  detachContextPin: (attachmentEntryId: string) => Promise<void>;
  retryContextSend: () => Promise<void>;
}
```

Extend the local `AgentApiSurface` with every section 20 method: `prepareContextDraft`, `summarizeContextDraft`, `summarizeContextPin`, `discardContextDraft`, `listReferencePoints`, `listContextState`, `previewContextBudget`, `updateContextPin`, and `detachContextPin`, using the ambient input/result types created by the backend plan. This local mirror must stay in lockstep with `ElectronApi.agent`.

Factor `ensureSession()` so send and prepare share one session-mint path.

- [ ] **Step 3: Preserve failures for the UI**

The existing hook catches send errors and only sets `errorMessage`. Change it to set status/error/recovery and then rethrow. This lets `AgentChatHost` restore composer text. Do not clear drafts in `finally`.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- --run frontend/app/store/use-pi-chat.test.tsx
```

Expected: PASS, including existing message/turn/abort tests.

---

### Task 3: Extend AgentChatHost without creating a second state owner

**Files:**

- Modify: `frontend/app/term/render/agent-chat-host.tsx`
- Modify: `frontend/app/term/render/agent-chat-host-api.test.ts`

- [ ] **Step 1: Add failing API tests**

Cover:

- `/tree` request includes `prepareTurnReference` while navigation remains available;
- `/session` opens a `session` request, not an immediate backend result;
- `/resume` routes to the same session request as a hidden compatibility alias;
- session request exposes list, resume, active-branch reference, turn-point list, and turn-reference operations;
- `/info` remains an immediate command;
- normal prompt submission returns a promise and propagates send failure;
- send failure calls `onRestoreComposerText` with exact text;
- context API methods delegate to the current `usePiChat` instance;
- selecting a source never sends artifact content from renderer code;
- missing current session is handled by the hook's ensure-session path rather than a “send a prompt first” error.

- [ ] **Step 2: Update host contracts**

Change send/submit return types to support the existing assistant runtime's async contract:

```ts
export interface AgentChatHostApi {
  submit: (text: string, images?: string[]) => boolean | Promise<boolean>;
  send: (text: string, images?: string[]) => Promise<boolean>;
  // existing operations
}
```

Add `onContextStateChange` only if the parent needs a stable render callback; otherwise pass `chat.contextState` through the existing `onStateChange` payload. Prefer one state callback:

```ts
export interface AgentHostState {
  status: UsePiChatStatus;
  queuedMessages: PiAgentMessage[];
  context: ContextReferenceRendererState;
  contextSendRecovery?: ContextSendRecovery;
}
```

Add `onRestoreComposerText?: (text: string) => void` to props.

- [ ] **Step 3: Define selector requests explicitly**

```ts
export type AgentSelectorRequest =
  | {
      type: "tree";
      listTree: () => Promise<AgentTreeResult>;
      navigateTree: (targetId: string) => Promise<AgentNavigateTreeResult>;
      prepareTurnReference: (targetId: string) => Promise<void>;
    }
  | {
      type: "fork";
      listForkPoints: () => Promise<AgentForkPointView[]>;
      forkSession: (entryId: string) => Promise<AgentForkSessionResult>;
    }
  | {
      type: "session";
      cwd: string;
      currentSessionPath?: string;
      listSessions: (cwd?: string) => Promise<AgentSessionDetail[]>;
      resumeSession: (sessionMetadata: AgentSessionMeta) => Promise<AgentNavigateTreeResult>;
      listReferencePoints: (source: AgentSessionMeta) => Promise<AgentReferencePointView[]>;
      prepareSessionReference: (source: AgentSessionMeta) => Promise<void>;
      prepareTurnReference: (source: AgentSessionMeta, turnId: string) => Promise<void>;
    };
```

Reference methods call `usePiChat.prepareContextDraft` with only source metadata/kind/turn ID. Main derives the snapshot.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- --run frontend/app/term/render/agent-chat-host-api.test.ts
```

Expected: PASS.

---

### Task 4: Build accessible draft and committed-pin chips

**Files:**

- Create: `frontend/app/term/render/assistant-ui/context-reference-chips.tsx`
- Create: `frontend/app/term/render/assistant-ui/context-reference-chips.test.tsx`
- Modify: `frontend/app/term/render/assistant-ui/index.ts`

- [ ] **Step 1: Write failing component tests**

For draft chips, assert:

- provenance shows source title/preview and Turn/Session kind;
- defaults show Once + Full for turn and active-branch selections;
- lifecycle and representation buttons have pressed state and keyboard labels;
- changing controls calls the matching action with draft ID;
- remove calls discard;
- sending state disables mutation without using `cursor-not-allowed`;
- summarizing state disables Send and representation mutation until the explicit action resolves;
- Summary is selected only after `summarizeContextDraft` returns a ready summary; failure preserves the prior Full/Metadata choice and shows retry;
- Metadata selection is immediate and does not call a summary API;
- error state shows retryable text without deleting the chip.

For committed pins, assert:

- Pin is fixed and there is no Once toggle;
- representation change calls backend update;
- selecting Summary without a stored summary calls the explicit pin summary API before the update becomes authoritative;
- selecting a pin's already-ready Summary reuses it, while Resummarize calls the summary API and appends a new immutable update;
- pause-for-this-turn toggles exclusion locally and leaves the pin committed;
- remove calls backend detach;
- pending update/detach does not optimistically remove authoritative state;
- source provenance remains readable after source deletion because it comes from the stored view.

For the recovery row, assert Retry plus actionable guidance to summarize, choose Metadata, pause, detach, compact, or select a larger-context model as appropriate. Assert there is no send-without-references action.

- [ ] **Step 2: Implement named components**

```ts
export function ContextReferenceBar(props: ContextReferenceBarProps): ReactNode;
export function ContextReferenceDraftChip(props: ContextReferenceDraftChipProps): ReactNode;
export function ContextReferencePinChip(props: ContextReferencePinChipProps): ReactNode;
export function ContextSendRecoveryRow(props: ContextSendRecoveryRowProps): ReactNode;
```

Use real `<button type="button">` elements, `cursor-pointer`, visible focus styles, and `aria-label`/`aria-pressed`. Keep every clickable target at least 28 px high. Do not use `cursor-not-allowed` for disabled states.

- [ ] **Step 3: Run tests**

Run:

```bash
npm test -- --run frontend/app/term/render/assistant-ui/context-reference-chips.test.tsx
```

Expected: PASS.

---

### Task 5: Add reference actions to `/tree`

**Files:**

- Modify: `frontend/app/view/cmdblock/session-selector.tsx`
- Modify: `frontend/app/view/cmdblock/session-selector.test.tsx`

- [ ] **Step 1: Add failing tree interaction tests**

Assert:

- tree rows still load from `listTree` and Enter navigates;
- only rows with `role === "user"` and backend `referenceable === true` render Add reference; abandoned-branch user rows remain navigable without the action;
- clicking Add reference calls `prepareTurnReference(entry.id)` exactly once;
- the click stops propagation and does not navigate or close the selector;
- successful preparation closes the selector and announces “Reference added”;
- failed preparation keeps the selector open and shows the backend error;
- hidden context journal entries never render, relying on backend filtering;
- keyboard focus can reach the Add reference button.

- [ ] **Step 2: Keep navigation and reference semantics separate**

Do not change `commitAgentSelectorPick` for tree navigation. Add a separate `commitAgentTreeReference` helper so tests can prove that selection does not accidentally navigate.

Do not make arbitrary assistant/tool rows selectable as turns.

- [ ] **Step 3: Run tests**

Run:

```bash
npm test -- --run frontend/app/view/cmdblock/session-selector.test.tsx
```

Expected: PASS.

---

### Task 6: Convert Resume selector into `/session` manager

**Files:**

- Modify: `frontend/app/view/cmdblock/session-selector.tsx`
- Modify: `frontend/app/view/cmdblock/session-selector.test.tsx`

- [ ] **Step 1: Add failing manager tests**

Cover:

- title is “Session manager”;
- top-level Resume and Reference controls are visible and keyboard accessible;
- cwd/all scope works in both modes;
- Resume selection preserves existing session switch behavior;
- the active target session cannot be selected as a cross-session source;
- Reference selection opens a source detail view instead of resuming;
- detail view calls `listReferencePoints(source)` and renders only user turns;
- Reference active branch calls `prepareSessionReference(source)`;
- selecting a turn calls `prepareTurnReference(source, entryId)`;
- active branch and turn both use Once + Full through the host API/state defaults;
- Back returns to the same filtered session list and focus;
- errors keep the panel open;
- Escape closes detail first, then the whole manager;
- the old request type `resume` no longer exists in component code.

- [ ] **Step 2: Refactor names and state deliberately**

Rename `resumeScope` to `sessionScope`, `isResume` to `isSession`, and resume-only labels/classes only where they encode behavior. Existing CSS class names may remain if visual-only, but user-visible strings must say Session.

Add a small view state rather than nested booleans:

```ts
type SessionManagerView =
  | { type: "sessions"; action: "resume" | "reference" }
  | { type: "reference-detail"; source: AgentSessionMeta; sourceTitle: string };
```

Keep `SessionSelector` as the shared anchored panel; do not introduce a second overlay competing for focus.

- [ ] **Step 3: Run tests**

Run:

```bash
npm test -- --run frontend/app/view/cmdblock/session-selector.test.tsx
```

Expected: PASS.

---

### Task 7: Wire chips, recovery, and selectors into AgentSurface

**Files:**

- Modify: `frontend/app/term/render/agent-surface.tsx`
- Modify: `frontend/app/term/render/agent-surface.test.tsx`
- Modify: `frontend/app/term/render/assistant-ui/runtime-bridge.ts`
- Modify: `frontend/app/term/render/assistant-ui/runtime-bridge.test.ts`

- [ ] **Step 1: Add failing surface tests**

Assert:

- host state with drafts/pins renders one `ContextReferenceBar` above the composer;
- draft callbacks invoke the current host API;
- committed pin callbacks invoke update/detach APIs;
- recovery actions invoke retry after the user has adjusted the request; no bypass action is rendered;
- a current `fits` budget is required to enable Send whenever drafts or active pins exist;
- pending/stale preview, pending/missing Summary, duplicate references, missing artifacts, projection errors, over-budget results, and unavailable counters disable Send with specific guidance;
- send rejection restores exact composer text via `AgentComposerTextRestore`;
- selector and model picker remain mutually exclusive under the existing attached-panel reducer;
- switching/resuming a session causes the newly hydrated pins to replace old pins;
- context chips do not appear in terminal mode/alt screen;
- disabled config hides selection entry points and bar controls without deleting hydrated state.

- [ ] **Step 2: Extend surface state and callbacks**

Pass `chat.contextState` and recovery through `AgentHostState`. Add host API methods for chip actions. Render `ContextReferenceBar` in `Thread.beforeComposer` before command results and queue state.

Pass `onRestoreComposerText={onAgentEditorText}` to `AgentChatHost`.

- [ ] **Step 3: Preserve async submit semantics**

`CrestAssistantRuntimeBridge.submit` already accepts a promise. Update tests to ensure `onNew` awaits it and propagates rejection. Do not wrap it in `void` before the runtime adapter sees the promise.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- --run frontend/app/term/render/agent-surface.test.tsx frontend/app/term/render/assistant-ui/runtime-bridge.test.ts
```

Expected: PASS.

---

### Task 8: Render persisted Projection Reports on turns

**Files:**

- Create: `frontend/app/term/render/assistant-ui/context-projection-badge.tsx`
- Create: `frontend/app/term/render/assistant-ui/context-projection-badge.test.tsx`
- Modify: `frontend/app/store/use-pi-chat.ts`
- Modify: `frontend/app/term/render/assistant-ui/runtime-bridge.ts`
- Modify: `frontend/app/term/render/assistant-ui/runtime-bridge.test.ts`
- Modify: `frontend/app/term/render/assistant-ui/registry-thread.tsx`
- Modify: `frontend/app/term/render/assistant-ui/thread.integration.test.tsx`

- [ ] **Step 1: Add failing report tests**

Cover:

- `PiTurn` receives the report whose `targetTurnId` matches it;
- a report arriving before or after `session_state` converges to the same turn data;
- runtime bridge stores the report in assistant message `metadata.custom.contextProjection`;
- badge counts Full/Summary/Metadata as Included, Attention as Attention, and Excluded as Excluded;
- details show requested/rendered representation, lifecycle, estimate, reason, and source preview/title when present;
- report items use only `selected`, `already_present`, or `user_excluded` reasons;
- missing artifact/projection errors appear in composer validation instead of a persisted report because failed sends commit no report;
- a report containing only explicitly excluded pins remains visible;
- overlay SHA-256 is shown in a copyable monospaced field;
- no report means no badge.

- [ ] **Step 2: Attach report by turn identity**

Extend `PiTurn` with `contextProjection?: AgentContextProjectionReport`. When reducing `context_projection`, update the matching turn or retain the report map until that turn appears. `session_state` already carries persisted reports; merge them deterministically.

- [ ] **Step 3: Render before assistant content**

In `AssistantMessage`, read `s.message.metadata.custom.contextProjection` and render `ContextProjectionBadge` before `MessagePrimitive.GroupedParts`. Do not embed report data as a fake assistant text part.

Use a native `<details>` or an accessible popover. Every interactive element uses `cursor-pointer` and an explicit label.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- --run frontend/app/term/render/assistant-ui/context-projection-badge.test.tsx frontend/app/term/render/assistant-ui/runtime-bridge.test.ts frontend/app/term/render/assistant-ui/thread.integration.test.tsx
```

Expected: PASS.

---

### Task 9: Complete the `/session`, `/info`, and hidden `/resume` migration

**Files:**

- Modify: `frontend/app/term/render/agent-slash-command-routing.ts`
- Modify: `frontend/app/term/render/agent-slash-command-routing.test.ts`
- Modify: `frontend/app/term/render/agent-chat-host.tsx`
- Modify: `frontend/app/term/render/agent-chat-host-api.test.ts`
- Modify: `frontend/app/term/render/agent-command-result.tsx`
- Modify: `frontend/app/term/render/agent-command-result.test.tsx`
- Modify: `frontend/app/view/cmdblock/cmdblock-input.tsx`
- Modify: `frontend/app/view/cmdblock/cmdblock-input.test.tsx`
- Modify: `frontend/app/term/render/assistant-ui/registry-thread.tsx`
- Modify: `frontend/app/term/render/assistant-ui/thread.integration.test.tsx`

- [ ] **Step 1: Write the migration tests first**

Assert across both slash command menus:

- `/session` is visible with Session manager description and History icon;
- `/info` is visible with current-session information description and Info icon;
- `/resume` is absent from discovery/fallback menus;
- manually typed `/resume` still resolves to the session manager;
- `/session` never renders an inline session-info result;
- `/info` uses `renderSessionInfo`;
- no `AgentBackendCommandName`/icon mapping expects the old visible resume command.

- [ ] **Step 2: Update routing and result rendering**

The routing union may retain `resume` only as an accepted input alias. Normalize it immediately:

```ts
if (command === "resume") {
  return { handled: true, command: "session", argsText: "" };
}
```

Make `AgentCommandResult` use `result.command === "info"` for session information.

- [ ] **Step 3: Update both command registries**

There are two user-visible fallback lists:

- `FallbackAgentSlashCommands` in `cmdblock-input.tsx`;
- `SLASH_COMMANDS` in `assistant-ui/registry-thread.tsx`.

Update both, even though backend discovery normally replaces one list. Update icons in `iconForAgentCommand` and `SLASH_ICON_MAP`.

- [ ] **Step 4: Run all rename tests**

Run:

```bash
npm test -- --run frontend/app/term/render/agent-slash-command-routing.test.ts frontend/app/term/render/agent-chat-host-api.test.ts frontend/app/term/render/agent-command-result.test.tsx frontend/app/view/cmdblock/cmdblock-input.test.tsx frontend/app/term/render/assistant-ui/thread.integration.test.tsx
```

Expected: PASS.

---

### Task 10: Honor enabled and optional operator limit in presentation

**Files:**

- Modify: `frontend/app/store/context-references.ts`
- Modify: `frontend/app/store/context-references.test.ts`
- Modify: `frontend/app/term/render/agent-surface.tsx`
- Modify: `frontend/app/term/render/agent-surface.test.tsx`
- Modify: `frontend/app/view/cmdblock/session-selector.tsx`
- Modify: `frontend/app/view/cmdblock/session-selector.test.tsx`
- Modify: `frontend/app/term/render/assistant-ui/context-reference-chips.tsx`
- Modify: `frontend/app/term/render/assistant-ui/context-reference-chips.test.tsx`

- [ ] **Step 1: Add failing config-view tests**

Cover:

- a valid config with no `context_references` field means enabled with no `max_tokens` limit;
- missing AI config disables reference controls through the existing setup-required state;
- `enabled: false` hides Add reference and the Reference tab but leaves Resume available;
- disabled mode renders already-hydrated pin chips read-only with a “References disabled” explanation, so data does not appear deleted;
- disabled mode keeps unsent drafts visible/read-only with discard available; a send carrying those drafts surfaces the backend `disabled` error and keeps text/references until the user explicitly discards them;
- Full, Summary, and Metadata remain available whenever the feature is enabled; configuration never rewrites a requested representation;
- absent `max_tokens` displays no operator cap; `max_tokens: 0` remains enabled but makes a non-empty overlay over budget and disables Send;
- malformed config state disables reference controls and points the user to the existing AI config error instead of silently assuming normal mode.

- [ ] **Step 2: Add one pure resolver**

Create or export:

```ts
export function resolveContextReferenceUiConfig(state: AIUserConfigState): ContextReferenceUiConfig;
```

Use it in surface, selector, and chips. Do not duplicate default logic in components.

- [ ] **Step 3: Run tests**

Run:

```bash
npm test -- --run frontend/app/term/render/agent-surface.test.tsx frontend/app/view/cmdblock/session-selector.test.tsx frontend/app/term/render/assistant-ui/context-reference-chips.test.tsx
```

Expected: PASS.

---

### Task 11: Add end-to-end renderer integration tests

**Files:**

- Create: `frontend/app/term/render/context-reference-flow.integration.test.tsx`
- Modify only production files proven necessary by failures.

- [ ] **Step 1: Test same-session turn flow**

With a fake Electron API:

1. Open `/tree`.
2. Add a user turn reference.
3. Verify Once + Full chip.
4. Send text.
5. Verify `agent.send` receives that draft ID/choices.
6. Resolve send and emit report.
7. Verify draft disappears and report badge appears on the matching assistant turn.

- [ ] **Step 2: Test cross-session pinned flow**

1. Open `/session` Reference.
2. Select a source session and Reference active branch.
3. Change lifecycle to Pin, explicitly select Summary, and wait for `summarizeContextDraft` to return ready.
4. Send.
5. Resolve and emit authoritative pin state.
6. Remount/reopen target session.
7. Verify pin hydrates and detach calls backend before disappearing.

- [ ] **Step 3: Test transaction recovery**

1. Create a draft and submit text.
2. Reject send with `transaction_failed`.
3. Verify chip remains in error state and text restore callback receives the exact text.
4. Retry and resolve; verify draft clears.
5. Repeat with an over-budget authoritative result; verify Send remains disabled until the user changes a reference to Metadata or pauses a pin, a fresh `fits` preview arrives, and retry succeeds.

- [ ] **Step 4: Test queued isolation**

Queue two sends with different drafts. Resolve the first and verify only its chip clears. Resolve the second and verify its own chip clears. Reports must bind to their separate turn IDs.

- [ ] **Step 5: Run integration test**

Run:

```bash
npm test -- --run frontend/app/term/render/context-reference-flow.integration.test.tsx
```

Expected: PASS.

---

### Task 12: Frontend regression, build, and manual verification

**Files:**

- Modify only files proven necessary by failures from this task.

- [ ] **Step 1: Run focused context tests**

Run:

```bash
npm test -- --run frontend/app/store/context-references.test.ts frontend/app/store/use-pi-chat.test.tsx frontend/app/term/render/assistant-ui/context-reference-chips.test.tsx frontend/app/term/render/assistant-ui/context-projection-badge.test.tsx frontend/app/term/render/context-reference-flow.integration.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run selector/host/command tests**

Run:

```bash
npm test -- --run frontend/app/view/cmdblock/session-selector.test.tsx frontend/app/term/render/agent-chat-host-api.test.ts frontend/app/term/render/agent-slash-command-routing.test.ts frontend/app/term/render/agent-command-result.test.tsx frontend/app/view/cmdblock/cmdblock-input.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run surface/runtime/thread tests**

Run:

```bash
npm test -- --run frontend/app/term/render/agent-surface.test.tsx frontend/app/term/render/assistant-ui/runtime-bridge.test.ts frontend/app/term/render/assistant-ui/thread.integration.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run the full suite once**

Run:

```bash
npm test -- --run
```

Expected: PASS. Do not pipe output through `head`, `tail`, or any command that can mask the exit code.

- [ ] **Step 5: Build**

Run:

```bash
npm run build:dev
```

Expected: PASS.

- [ ] **Step 6: Check exact changes**

Run:

```bash
git status --short
git diff --check
git diff -- frontend/app frontend/types/custom.d.ts frontend/preview/mock/preview-electron-api.ts emain/preload.ts
```

Expected: intended files only, no whitespace errors, no stale `/resume` discovery entry, and no direct renderer mutation of committed pins.

## Manual UX acceptance matrix

Verify in the development build:

1. `/tree`: navigate by row/Enter; add a reference with the row button without navigation.
2. `/session` Resume: switch sessions in cwd and all scopes.
3. `/session` Reference: reference an active branch and a specific user turn.
4. Edit draft lifecycle/representation; send and inspect the report badge.
5. Queue two referenced messages; confirm chips and reports remain isolated by turn.
6. Pin a reference, reload the renderer, close/reopen the session, and detach it.
7. Force explicit summary failure and confirm the prior representation remains selected and Send stays disabled if Summary was requested but is not ready.
8. Force budget exhaustion and confirm Send is disabled with the exact reduction required until the user explicitly adjusts references.
9. Force transaction failure; verify the draft remains and submitted text is restored.
10. Disable references in `ai.json`; verify entry points disappear, old pins appear disabled/read-only, and sending still works.
11. Remove `max_tokens`; verify there is no synthetic operator cap, then set it to 0 and verify a non-empty overlay cannot send.
12. Type `/resume` manually; verify the Session manager opens while `/resume` is absent from menus.

## Accessibility and interaction checklist

- All chip actions, selector tabs, row reference actions, report toggles, and Retry controls are real buttons.
- All clickable elements have `cursor-pointer`.
- Disabled elements do not use `cursor-not-allowed`.
- Icon-only controls have `aria-label`.
- Lifecycle/representation toggles expose `aria-pressed` or native selection semantics.
- Reference actions are reachable without triggering row navigation.
- Focus returns to the composer after successful selection and to the originating session row when backing out of detail.
- Loading/error text is announced and the panel stays open on failure.

## Completion conditions

Frontend work is complete only when:

- all Task 12 commands pass;
- `/tree` reference and navigation semantics coexist;
- `/session` owns Resume and Reference while `/info` owns information;
- draft chips clear only after the corresponding committed send;
- queued sends cannot consume each other's drafts;
- committed pins hydrate and mutate only from backend-authoritative state;
- transaction failures retain references and recover the submitted text;
- Projection Reports are visible on the correct turns;
- disabling the feature hides injection controls without implying stored data was deleted.
