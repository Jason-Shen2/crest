# Context Overlay Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement immutable turn/session snapshots, atomic send-bound attachments, bounded projection, persisted reports and pins, and the Electron API required by the context-reference UI.

**Architecture:** Context artifacts and lifecycle events are existing session `custom` entries. A process-local draft registry captures sources at selection time, while explicit summary APIs are the only path that invokes the summary provider. The existing `agent:send` path supplies a turn-preparation callback to the harness; that callback reserves the user entry ID, validates and projects the exact user-selected representations, authoritatively counts the final provider-ready request, and batch-appends context entries, a transaction manifest, and the user message. The harness then emits the precommitted user entry without appending it twice and sends the exact overlay as a system-prompt suffix.

**Tech stack:** TypeScript, Electron IPC, Vitest, JSONL session storage, `node:sqlite`, pi agent harness.

**Design:** `docs/specs/2026-07-20-cross-session-context-reference-design.md`

## Scope and ownership

This plan owns:

- `emain/agent/context/**`
- session storage batch semantics and context journal records
- harness/runtime prepared-turn support
- Electron main IPC and preload bridge
- global ambient Electron API types and preview stubs
- `ai.json` context-reference config shape and main-process validation
- backend command rename and session/tree reference views

The frontend plan owns React state, composer chips, panels, command routing UI, and user-visible error handling.

## Required implementation order

Do not start IPC or UI integration before Tasks 1–8 pass. The projector and journal are pure modules and must be stable before the prepared-turn handshake changes the live send path.

---

### Task 1: Define domain types and validation

**Files:**

- Create: `emain/agent/context/types.ts`
- Create: `emain/agent/context/validation.ts`
- Create: `emain/agent/context/validation.test.ts`

- [ ] **Step 1: Write failing validation tests**

Cover:

- a turn artifact requires `sourceTurnId` and at least one source message entry ID;
- a session artifact may omit `sourceTurnId` but must record `sourceLeafId`;
- `once` requires `targetTurnId`;
- `pinned` rejects `targetTurnId`;
- enum values reject arbitrary renderer strings;
- artifact validation requires a lowercase SHA-256 snapshot hash;
- a valid config that omits `context_references` defaults only `enabled` to `true`;
- `max_tokens` is optional, has no default, and when present clamps to 0–128,000;
- unknown artifact schema versions produce a diagnostic rather than throwing during fold.

Use public discriminated unions matching the design:

```ts
export type ContextSourceKind = "turn" | "session";
export type ContextLifecycle = "once" | "pinned";
export type ContextRepresentation = "full" | "summary" | "metadata";
export type ContextRenderedRepresentation = ContextRepresentation | "attention" | "excluded";

export interface ContextReferenceConfig {
  enabled: boolean;
  maxTokens?: number;
}
```

Define the remaining artifact, provenance, attachment, report, draft, and journal data interfaces exactly as section 10 and section 18 of the design. Add a stable error:

```ts
export class ContextReferenceError extends Error {
  code:
    | "disabled"
    | "invalid_input"
    | "draft_expired"
    | "source_not_found"
    | "source_too_large"
    | "summary_not_ready"
    | "duplicate_artifact"
    | "artifact_missing"
    | "budget_stale"
    | "budget_exceeded"
    | "counter_unavailable"
    | "projection_failed"
    | "transaction_failed";

  constructor(code: ContextReferenceError["code"], message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ContextReferenceError";
    this.code = code;
  }
}
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```bash
npm test -- --run emain/agent/context/validation.test.ts
```

Expected: FAIL because validation functions do not exist.

- [ ] **Step 3: Implement parsers, not casts**

Export:

```ts
export function parseContextLifecycle(value: unknown): ContextLifecycle;
export function parseContextRepresentation(value: unknown): ContextRepresentation;
export function parseContextReferenceConfig(value: unknown): ContextReferenceConfig;
export function validateContextArtifact(value: unknown): ContextArtifact;
export function validateContextAttachmentData(value: unknown): ContextAttachmentData;
```

Keep journal-decoding helpers non-throwing by returning `{ value?, diagnostic? }`. IPC-bound parsers may throw `ContextReferenceError("invalid_input", ...)`.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- --run emain/agent/context/validation.test.ts
```

Expected: PASS.

---

### Task 2: Capture atomic structured snapshots

**Files:**

- Create: `emain/agent/context/snapshot.ts`
- Create: `emain/agent/context/snapshot.test.ts`
- Modify: `emain/agent/commands/session-views.ts`
- Modify: `emain/agent/commands/session-views.test.ts`

- [ ] **Step 1: Write failing snapshot tests**

Build branches containing:

- user text;
- assistant text plus a `toolCall` block;
- matching `toolResult` text;
- a later user turn;
- user and tool-result images;
- assistant thinking and provider signatures.

Assert that a selected turn captures user/assistant/tool-result messages only until the next user entry; preserves tool IDs, names, arguments, error flags, and text; replaces image data with `{ type: "image_omitted", mimeType, byteLength }`; and omits thinking/signatures/details.

Assert that a session selection captures only the active branch and records its leaf. Assert that selection of an assistant/tool/custom entry is rejected.

Assert that canonical normalized data over 2 MiB is rejected with `source_too_large`, while omitted image bytes do not count toward that limit.

Assert that identical normalized snapshots produce the same `snapshotSha256` and any textual/tool-content change produces a different hash.

Add tests for `getModelVisibleMessageEntryIds(entries)`: without compaction it returns active-branch message IDs; with compaction it mirrors `buildSessionContext`'s latest compaction/`firstKeptEntryId` boundary and excludes compacted message IDs.

- [ ] **Step 2: Add a single backend reference-point helper**

Export from `session-views.ts`:

```ts
export function buildAgentReferencePointViews(entries: SessionTreeEntry[]): AgentReferencePointView[];
```

It receives the active path (not all journal entries), reuses the same user-message predicate as `buildAgentForkPointViews`, and returns active-branch user roots only. Extend `AgentTreeEntryView` with `referenceable` computed from the active path so abandoned tree branches remain navigable but cannot show a reference action. Do not add `owningTurnId` inference for arbitrary rows.

- [ ] **Step 3: Implement snapshot capture**

Export:

```ts
export interface ContextCaptureInput {
  sourceMetadata: JsonlSessionMetadata;
  sourceEntries: SessionTreeEntry[];
  sourceLeafId: string | null;
  sourceTitle?: string;
  sourceKind: ContextSourceKind;
  sourceTurnId?: string;
}

export function captureContextArtifactDraft(input: ContextCaptureInput): ContextArtifactDraft;
```

Use source entry IDs for deduplication and audit. Use the existing structured `estimateTokens` logic as a base, but estimate the normalized canonical JSON rather than flattened text.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- --run emain/agent/context/snapshot.test.ts emain/agent/commands/session-views.test.ts
```

Expected: PASS.

---

### Task 3: Encode and fold the context journal

**Files:**

- Create: `emain/agent/context/journal.ts`
- Create: `emain/agent/context/journal.test.ts`
- Create: `emain/agent/harness/session/entry-transaction.ts`
- Create: `emain/agent/harness/session/entry-transaction.test.ts`
- Modify: `emain/agent/commands/session-views.ts`
- Modify: `emain/agent/commands/session-views.test.ts`

- [ ] **Step 1: Write failing fold tests**

Cover:

- artifact/attach entries do not activate without a complete group and valid `session_tx_manifest`;
- a valid commit activates once and pinned attachments;
- once appears only for its exact target turn;
- pinned representation update and detach fold in order;
- update/detach of once is ignored with a diagnostic;
- missing artifacts and unknown schema versions are diagnostics, not exceptions;
- a commit with an incorrect ordered ID list or digest is ignored;
- branch navigation excludes records on abandoned branches.

- [ ] **Step 2: Implement explicit custom-entry codecs**

Export constants and type guards rather than comparing string literals throughout the codebase:

```ts
export const ContextCustomTypes = {
  artifact: "context_artifact",
  attach: "context_attach",
  update: "context_update",
  detach: "context_detach",
  projection: "context_projection",
  transactionManifest: "session_tx_manifest",
} as const;

export function isContextCustomEntry(entry: SessionTreeEntry): boolean;
export function foldContextJournal(entries: SessionTreeEntry[], targetTurnId?: string): ContextJournalState;
```

Put canonical JSON, generic manifest encoding, digest validation, committed-group filtering, and transaction-boundary lookup in `harness/session/entry-transaction.ts`. The manifest's `orderedMemberEntryIds` and `membersSha256` exclude the manifest itself, avoiding a circular digest, and require the listed user to be the final member. Use recursively sorted object keys and test key-order independence, multiple/missing manifests, missing members after a manifest, extra members, a non-final/mismatched user, bad ordered IDs, bad digests, interleaved non-transaction entries, and before/at boundaries for a transactional user. `journal.ts` consumes this helper and remains responsible only for context record decoding/folding.

- [ ] **Step 3: Hide context control entries from `/tree`**

Update `isHiddenTreeEntry` so every recognized context custom type is structural. Verify that `filterTreeForDisplay` reconnects a transactional user entry past its manifest and preceding hidden context entries while leaving that user as the visible leaf.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- --run emain/agent/context/journal.test.ts emain/agent/commands/session-views.test.ts
npm test -- --run emain/agent/harness/session/entry-transaction.test.ts
```

Expected: PASS.

---

### Task 4: Add atomic batch append to every storage backend

**Files:**

- Modify: `emain/agent/harness/types.ts`
- Modify: `emain/agent/harness/session/session.ts`
- Modify: `emain/agent/harness/session/memory-storage.ts`
- Modify: `emain/agent/harness/session/jsonl-storage.ts`
- Modify: `emain/agent/harness/session/sqlite-driver.ts`
- Modify: `emain/agent/harness/session/sqlite-storage.ts`
- Create: `emain/agent/harness/session/batch-storage.test.ts`
- Modify: `emain/agent/harness/session/sqlite-storage.test.ts`
- Modify: `emain/agent/sessions.test.ts`

- [ ] **Step 1: Extend the storage contract**

Add:

```ts
export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
  // existing methods
  appendEntries(entries: SessionTreeEntry[]): Promise<void>;
}
```

Keep `appendEntry` for compatibility and make each implementation delegate it to `appendEntries([entry])`.

- [ ] **Step 2: Write failing all-or-nothing tests**

- Memory: a batch with a duplicate existing ID changes neither entries nor leaf.
- Memory: a duplicate ID inside a batch changes neither entries nor leaf.
- Every backend rejects a programmatic batch with a top-level transaction ID but no valid manifest/complete member list before mutation.
- Memory construction from a fixture filters an interrupted transaction group.
- JSONL: one successful batch calls `appendFile` exactly once with all entries in order; an append failure changes no in-memory state.
- JSONL reopen hides an interrupted transaction containing a valid manifest but a missing or partial user record.
- JSONL reopen ignores only a malformed final fragment without a trailing newline; a newline-terminated malformed record still rejects the session.
- JSONL recovery rewrites header plus visible committed entries before open returns, so the next append cannot concatenate onto a partial tail; rewrite failure rejects open.
- SQLite: a duplicate ID in the second insert rolls back the first insert and leaves the old leaf unchanged.
- Session context: a committed context transaction followed by assistant output still builds the ordinary user/assistant transcript.

- [ ] **Step 3: Implement backend semantics**

- Validate non-empty IDs, duplicates, and complete transaction groups before mutation in every backend.
- JSONL builds one string with one JSON object per line and calls `appendFile` once.
- Add `transactionId?: string` to `SessionTreeEntryBase`. Every entry produced by the context turn preparer, including the manifest and ordinary user message, carries it.
- Reuse the shared session entry-transaction helper so JSONL buffers top-level transaction groups and returns them only after a `session_tx_manifest` validates the complete group, including its later user member. Use it for storage open rather than exposing a prefix of an interrupted send.
- When open filters an incomplete group or partial final fragment, rewrite the canonical header/visible-entry JSONL with the existing `writeFile` capability before constructing writable storage. Do not silently continue if that recovery write fails.
- Add `transaction<T>(callback: () => T): T` to `SqliteDb`. It must use `BEGIN IMMEDIATE`, `COMMIT`, and `ROLLBACK`, preserving the original error if rollback also fails.
- SQLite inserts the complete batch inside that transaction.
- Update labels and leaf only after successful persistence.
- Add `Session.appendEntries(entries)` as the domain-level forwarding method.

Do not change the JSONL header version. Context records remain normal v3 custom entries.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- --run emain/agent/harness/session/batch-storage.test.ts emain/agent/harness/session/sqlite-storage.test.ts emain/agent/sessions.test.ts
```

Expected: PASS.

---

### Task 5: Verify fork, export, import, and detail behavior

**Files:**

- Modify: `emain/agent/harness/session/jsonl-repo.ts`
- Modify: `emain/agent/harness/session/sqlite-repo.ts`
- Modify: `emain/agent/harness/session/repo-utils.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent/harness/session/sqlite-storage.test.ts`
- Modify: `emain/agent/sessions.test.ts`
- Modify: `emain/agent-ipc.test.ts`

- [ ] **Step 1: Add persistence round-trip tests**

Create a committed transaction containing artifact, pinned attach, report, manifest, and user message. Verify:

- a fork at/after that user turn includes the complete context transaction;
- a fork before the user turn resolves to the parent before the transaction's first entry and excludes the whole group;
- SQLite export contains the custom entries;
- SQLite import reconstructs the same fold;
- `/export` and `/import` preserve the context entries;
- session detail `messageCount`, first message, and preview ignore context custom entries;
- an uncommitted orphan transaction does not create a pin after reopen;
- an uncommitted transaction's user message is absent from history, tree, detail, export, and SQLite import;
- JSONL detail, `/export`, SQLite `importFromJsonl`, and pane `/import` all reuse the committed-record loader rather than parsing raw transaction entries independently.

- [ ] **Step 2: Fix only proven gaps**

Update `getEntriesToFork` to use the shared transaction-boundary helper: `position: "before"` on a transactional user cuts before the first member, while `position: "at"` ends at the user and includes its manifest ancestors. Change JSONL/SQLite fork and SQLite import replay to call `appendEntries` with complete committed groups rather than looping through transaction members with `appendEntry`. Do not add a sidecar copy path.

- [ ] **Step 3: Run tests**

Run:

```bash
npm test -- --run emain/agent/harness/session/sqlite-storage.test.ts emain/agent/sessions.test.ts emain/agent-ipc.test.ts
```

Expected: PASS.

---

### Task 6: Implement the process-local draft registry

**Files:**

- Create: `emain/agent/context/draft-registry.ts`
- Create: `emain/agent/context/draft-registry.test.ts`

- [ ] **Step 1: Write failing registry tests**

Cover:

- ownership is keyed by canonical target session path;
- a different target cannot read or consume a draft ID;
- `peek` does not consume;
- `consumeMany` is all-or-nothing;
- expired drafts return `draft_expired` and identify every affected ID;
- a failed callback leaves drafts retryable;
- successful commit consumes them;
- explicit discard and target-session clear work;
- TTL refreshes on valid access and defaults to 30 minutes.

Use an injected clock and ID factory; do not use sleeps in tests.

- [ ] **Step 2: Implement the registry**

The registry stores full `ContextArtifactDraft` values but returns only `ContextDraftView`. Provide a commit-safe API:

```ts
export async function withContextDrafts<TResult>(
  registry: ContextDraftRegistry,
  targetSessionPath: string,
  draftIds: string[],
  commit: (drafts: ContextArtifactDraft[]) => Promise<TResult>
): Promise<TResult>;
```

Only delete drafts after `commit` resolves.

- [ ] **Step 3: Run tests**

Run:

```bash
npm test -- --run emain/agent/context/draft-registry.test.ts
```

Expected: PASS.

---

### Task 7: Implement explicit summary generation

**Files:**

- Create: `emain/agent/context/summary.ts`
- Create: `emain/agent/context/summary.test.ts`

- [ ] **Step 1: Write failing tests around a fake completion function**

Assert:

- the prompt contains canonical structured messages, including tool calls/results;
- system instructions identify the snapshot as untrusted data;
- max output tokens are 2,048;
- successful text is trimmed and stored;
- empty, error, and aborted completions return a typed failure;
- provider failure never mutates the draft, artifact, or pin;
- large input is split into chronological bounded chunks, keeps a fitting tool call/result pair together, and recursively reduces partial summaries;
- a single oversized text block is split with stable continuation markers;
- input requiring more than 16 map chunks returns a typed failure without issuing provider calls;
- failure of any map or reduce call returns one typed summary failure and no partial artifact summary;
- the provider runs only when `summarizeContextDraft`, `summarizeContextPin`, or explicit Resummarize invokes it;
- selecting Full or Metadata, preparing a turn, previewing a budget, and sending never invoke the provider;
- a successful draft summary is retained in the draft registry and later committed with the immutable artifact;
- a successful pin summary appends an immutable `context_update` containing the summary and changes the pin only after append succeeds;
- selecting Summary on a pin reuses its latest successful summary, while Resummarize appends a replacement update;
- any map/reduce failure leaves the prior representation and ready summary unchanged.

- [ ] **Step 2: Implement a provider adapter**

Inject `completeSimple` through a small function type for testability. Accept the resolved summary model, API key/headers, and abort signal from the explicit summary handler. Return `Result<ContextGeneratedSummary, ContextSummaryError>`; do not throw expected provider failures. The returned record includes `text`, `summarySha256`, `modelKey`, `promptVersion`, and `generatedAt`.

Do not call branch summarization with fabricated session entries. Reuse only stable utilities such as the system summarization prompt where appropriate.

- [ ] **Step 3: Run tests**

Run:

```bash
npm test -- --run emain/agent/context/summary.test.ts
```

Expected: PASS.

---

### Task 8: Implement deterministic exact projection and authoritative budgeting

**Files:**

- Create: `emain/agent/context/projector.ts`
- Create: `emain/agent/context/projector.test.ts`

- [ ] **Step 1: Write the projector and budget matrix as failing tests**

At minimum cover:

1. the final request includes system prompt, tools, history, current user content/images, exact overlay, provider transforms, and the same effective output reserve later sent to the provider;
2. unknown context window, unresolved output reserve, or unavailable authoritative counter returns `counter_unavailable` and cannot authorize send;
3. an exact count or documented conservative upper bound can authorize send;
4. optional `maxTokens` limits overlay tokens when present and imposes no limit when absent;
5. `base_over_budget` and `references_over_budget` are distinct and report exact `excessTokens`;
6. new once references precede pins, while order never changes budget priority;
7. Full, Summary, and Metadata serialize exactly as selected; Summary without a ready summary rejects with `summary_not_ready`;
8. same-session content still visible emits Attention, while compacted/absent IDs serialize the requested representation;
9. explicitly paused pins appear only as Excluded report items and never enter the overlay;
10. missing/corrupt artifacts, duplicate snapshot hashes, invalid ownership/lifecycle, and serialization errors reject the whole projection;
11. source text containing XML/Markdown delimiters remains a JSON string value;
12. repeated identical input produces byte-identical overlay and report ordering;
13. every successful report item has reason `selected`, `already_present`, or `user_excluded` and renders as Full/Summary/Metadata/Attention/Excluded;
14. no failed projection returns an overlay or Projection Report, commits entries, or invokes the model.

- [ ] **Step 2: Implement pure functions**

Export:

```ts
export async function validateAndProjectContext(input: ContextProjectionInput): Promise<ContextProjectionResult>;
export function renderContextOverlay(items: ContextRenderedItem[]): string;
export async function countContextBudget(input: ContextBudgetInput): Promise<ContextBudgetResult>;
```

Keep summary/provider completion calls and storage out of this module. Inject `ContextTokenCounter`; it counts the final provider-ready payload only after every token-affecting provider transform. Unexpected projection/serialization errors become typed non-committing failures in orchestration.

Use the exact representation and report rules in design sections 15–18. Do not allocate, pack, downgrade, omit, or change a requested representation. A Projection Report exists only for a successful validated send and includes every included or explicitly paused attachment.

- [ ] **Step 3: Run tests**

Run:

```bash
npm test -- --run emain/agent/context/projector.test.ts
```

Expected: PASS.

---

### Task 9: Build the context turn preparer

**Files:**

- Create: `emain/agent/context/turn-preparer.ts`
- Create: `emain/agent/context/turn-preparer.test.ts`

- [ ] **Step 1: Write orchestration tests with fakes**

Test the ordered behavior:

- reserve transaction/user/context entry IDs;
- fold existing pins from the active branch;
- derive same-session visible source entry IDs from the target branch's compaction boundary;
- reject Summary attachments whose explicit summary action has not produced a ready summary;
- create immutable artifacts from drafts;
- bind once attachments to the reserved user ID;
- project explicit attachments plus existing pins, minus only `excludedPinAttachmentIds` supplied for this turn;
- build the final provider-ready request, run authoritative counting, and reject stale/over-budget/uncountable requests before append;
- create `context_projection` before the user entry;
- create `session_tx_manifest` immediately before the user entry with the complete ordered IDs/digest;
- append the normal user message last so it remains the physical session leaf;
- call `session.appendEntries` exactly once;
- return `userEntryId`, suffix, and report;
- consume drafts only after append succeeds;
- never invoke summary generation from preparation;
- on duplicate hashes, missing/corrupt artifacts, invalid attachment data, projector throw, or serialization failure, append nothing and make no provider request;
- on `base_over_budget`, `references_over_budget`, or `counter_unavailable`, append nothing, preserve drafts, and return the typed budget result;
- on append failure, do not consume drafts and throw `transaction_failed`;
- re-invoking the same preparation closure after commit returns the same result without a second append.

- [ ] **Step 2: Implement a linear transaction builder**

Use full UUIDv7 values for new context transaction entries. Set parents in exact append order from the target's current leaf. The user message is a normal `message` entry created from the same `UserMessage` object the harness will emit. Its parent is the manifest and it is appended last. Every entry in the generated batch has the same top-level `transactionId`; the manifest already knows the later user ID/payload, and JSONL recovery hides the group unless all listed members validate.

Do not use `INSERT OR REPLACE`, mutate an existing artifact, create an artifact table, or add a ContextItem Registry/Resolver/Assembler. Refresh is detach plus a fresh selection that creates a new artifact.

- [ ] **Step 3: Run tests**

Run:

```bash
npm test -- --run emain/agent/context/turn-preparer.test.ts
```

Expected: PASS.

---

### Task 10: Add the prepared-turn handshake to AgentHarness

**Files:**

- Modify: `emain/agent/harness/types.ts`
- Modify: `emain/agent/harness/agent-harness.ts`
- Modify: `emain/agent/harness/agent-harness.test.ts`

- [ ] **Step 1: Add failing harness tests**

Cover an initial prompt and a queued prepared follow-up:

- preparation receives the ordinary system prompt, active history, current user message, model, and active tools;
- the returned suffix is present in the provider system prompt exactly once;
- the user `message_end` event carries the prepared entry ID;
- storage contains only one user message;
- assistant/tool-result persistence remains unchanged;
- a preparation failure makes no provider request;
- a failed prepared follow-up is returned to the follow-up queue;
- prepared follow-ups remain one-at-a-time even if follow-up mode is `all`;
- an unprepared prompt/follow-up follows the existing path unchanged.

- [ ] **Step 2: Add public preparation types**

```ts
export interface AgentHarnessTurnPreparationInput {
  userMessage: UserMessage;
  systemPrompt: string;
  messages: AgentMessage[];
  model: Model<Api>;
  activeTools: AgentTool[];
}

export interface AgentHarnessPreparedTurn {
  userEntryId: string;
  systemPromptSuffix: string;
  projectionReport?: ContextProjectionReport;
}

export type AgentHarnessTurnPreparation = (
  input: AgentHarnessTurnPreparationInput
) => Promise<AgentHarnessPreparedTurn>;
```

Add `prepare?: AgentHarnessTurnPreparation` to prompt options and change follow-up preparation from `() => Promise<void>` to the same semantic callback.

- [ ] **Step 3: Implement without duplicating event paths**

- Build the normal turn state first.
- Run preparation before the provider request.
- For follow-ups, drain one message and its preparation together; on success keep the prepared turn state for `prepareFollowUpTurn`; on failure requeue both.
- Pass the suffix only in that turn's `AgentContext.systemPrompt`.
- Keep a FIFO of prepared user IDs aligned with user events.
- In `handleAgentEvent`, when the next user `message_end` has a prepared ID, emit that ID and skip `session.appendMessage`.
- Never suppress assistant or tool-result writes.

Avoid changing low-level provider adapters.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- --run emain/agent/harness/agent-harness.test.ts
```

Expected: PASS, including all pre-existing harness tests.

---

### Task 11: Integrate prepared sends and authoritative context state in runtime

**Files:**

- Modify: `emain/agent/agent-session-runtime.ts`
- Modify: `emain/agent/agent-session-runtime.test.ts`
- Modify: `emain/agent/harness-factory.ts`
- Modify: `emain/agent/harness-factory.test.ts`

- [ ] **Step 1: Add failing runtime tests**

Cover:

- send resolves when its context transaction commits, with that user entry ID;
- a queued send resolves only when its own preparation commits;
- two queued sends bind different draft lists to different user IDs;
- the normal live user events still build turns keyed by the same IDs;
- preparation rejection rejects only the affected send and does not leave a stale FIFO resolver;
- abort rejects queued uncommitted sends;
- reopen hydrates pinned views and projection reports from journal entries;
- tree navigation/rebuild recomputes pins and active-branch reports, so rewinding before an attach/update/detach changes authoritative state correctly;
- detach/update changes state only after backend append succeeds.

- [ ] **Step 2: Replace event-derived send resolution**

Extend runtime send options with a preparation callback factory. Resolve the per-send promise from the preparer's successful commit callback, not from a later user `message_end`. Continue using the event entry ID for `AgentTurn` reconstruction.

Add to `AgentSessionRuntimeState`:

```ts
contextPins: ContextPinView[];
contextReports: ContextProjectionReport[];
```

Keep artifact bodies out of runtime state.

- [ ] **Step 3: Emit projection events**

Add a harness-own `context_projection` event and make runtime apply it before notifying listeners. `session_state` must replay pins and reports to late subscribers.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- --run emain/agent/agent-session-runtime.test.ts emain/agent/harness-factory.test.ts
```

Expected: PASS.

---

### Task 12: Add `ai.json` configuration and Electron API contracts

**Files:**

- Modify: `frontend/app/store/ai-types.ts`
- Modify: `emain/aiconfig/user-config.ts`
- Create: `emain/aiconfig/user-config.test.ts`
- Modify: `frontend/types/custom.d.ts`
- Modify: `emain/preload.ts`
- Modify: `frontend/preview/mock/preview-electron-api.ts`
- Modify: `docs/ai-config-architecture.md`
- Modify: `docs/agent-user-guide.md`

- [ ] **Step 1: Add config tests**

Extend `AIUserConfig` with:

```ts
context_references?: {
    enabled?: boolean;
    max_tokens?: number;
};
```

Main-process validation must accept absence, reject non-finite max tokens, and preserve unknown forward-compatible top-level fields. Runtime parsing defaults only `enabled` to true for an otherwise valid config, leaves `max_tokens` absent when omitted, and clamps a present value to 0–128,000; file validation must not silently rewrite values.

This setting belongs in `ai.json`. Do not add it to `pkg/wconfig/settingsconfig.go`, because Crest's current agent configuration explicitly replaced legacy `ai:*` Wave settings.

Update `docs/ai-config-architecture.md` with the optional schema/defaults and `docs/agent-user-guide.md` with enabled, disabled, and optional max-token examples plus the fact that disabling preserves pins and never changes the user's representation.

- [ ] **Step 2: Define Electron API input/view types**

Add ambient types for:

- `AgentPrepareContextDraftInput/Result`
- `AgentSummarizeContextDraftInput/Result`
- `AgentSummarizeContextPinInput/Result`
- `AgentDiscardContextDraftInput`
- `AgentContextAttachmentDraftInput`
- `AgentPreviewContextBudgetInput/Result`
- `AgentContextState`
- `AgentUpdateContextPinInput`
- `AgentDetachContextPinInput`
- report and pin views
- `AgentListReferencePointsInput` and `AgentReferencePointView`
- `referenceable?: boolean` on the existing `AgentTreeEntryView`

Extend `AgentSendOptions` with ordered `contextAttachments?: AgentContextAttachmentDraftInput[]` and `excludedPinAttachmentIds?: string[]`. There is no send policy or budget bypass field.

- [ ] **Step 3: Update preload and preview in lockstep**

Add all methods from design section 20 to `emain/preload.ts` and matching rejecting/no-op stubs to `frontend/preview/mock/preview-electron-api.ts`: `prepareContextDraft`, `summarizeContextDraft`, `summarizeContextPin`, `discardContextDraft`, `listReferencePoints`, `listContextState`, `previewContextBudget`, `updateContextPin`, and `detachContextPin`. Keep argument types `unknown` in preload and validation in main.

- [ ] **Step 4: Run type/config tests**

Run:

```bash
npm test -- --run emain/aiconfig/user-config.test.ts
npm run build:dev
```

Expected: test and build PASS.

---

### Task 13: Implement validated context IPC and extend `agent:send`

**Files:**

- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `emain/agent/commands/types.ts`
- Modify: `emain/agent/commands/session-views.ts`

- [ ] **Step 1: Write failing IPC tests**

Cover:

- prepare accepts only canonical source/target paths under managed session roots;
- target session must exist before selection;
- turn selection accepts only a user message on the source active branch;
- tree/reference-point views mark or return only active-branch user roots as referenceable;
- a session selection snapshots the active branch;
- renderer cannot provide artifact bodies;
- feature-disabled prepare/update/detach reject with `disabled`;
- explicit draft summary stores a ready summary only after the provider succeeds; failure preserves the old draft state;
- explicit pin summary appends an immutable `context_update`, and Resummarize appends another update without mutating the artifact;
- preview returns a revision-bound budget breakdown and never commits or summarizes;
- feature-disabled list state still returns stored pins/reports for read-only UI and future re-enable;
- discard is target-owned and idempotent;
- list state returns lightweight pins/reports only;
- update/detach reject once attachments;
- send rejects draft IDs owned by another target;
- disabled send with draft IDs rejects before the model call and retains drafts; a disabled context-free send uses the existing fast path and ignores stored pins;
- send with two drafts preserves selection order;
- send with no drafts but an active pin still uses prepared projection and injects that pin;
- `excludedPinAttachmentIds` pauses only those pins for the target turn and reports them as Excluded;
- duplicate snapshots, missing/corrupt artifacts, missing summaries, projection errors, stale previews, over-budget requests, and unavailable authoritative counters all reject before commit/model call and retain drafts;
- send transaction failure makes no provider request and retains drafts;
- projection failure returns a typed error with no overlay/report transaction;
- normal sends without context remain byte-for-byte compatible at the IPC result boundary;
- event payload includes `context_projection` and replayed `session_state` fields.

- [ ] **Step 2: Add handlers**

Register:

```text
agent:prepare-context-draft
agent:summarize-context-draft
agent:summarize-context-pin
agent:discard-context-draft
agent:list-reference-points
agent:list-context-state
agent:preview-context-budget
agent:update-context-pin
agent:detach-context-pin
```

Use the existing `validateSessionPath`, `openValidatedSessionMetadata`, runtime registry, and sender subscription routing. Instantiate one process-level `ContextDraftRegistry` beside the runtime registry and sweep it with the existing runtime sweep timer or a dedicated non-blocking interval.

Read context configuration in Electron main via `readAIUserConfig`; do not trust a renderer-supplied enabled/budget value.

- [ ] **Step 3: Extend send through the existing boundary**

`agent:send` remains the only commit boundary. Build a per-send idempotent turn-preparation closure using:

- validated draft IDs and attachment choices;
- runtime model/auth from `AgentExecutionConfig`;
- target session and draft registry;
- parsed `ai.json` context config;
- exact `excludedPinAttachmentIds` for this send;
- a fingerprint of the current model, composer payload, history/tools, attachments, pin representations, and exclusions for stale-preview detection.

Pass that callback to `runtime.sendWithExecutionConfig`. Return the committed user entry ID as `turnId`.

Create a prepared callback when the send has draft attachments or the target branch has active pins. A context-free send with no drafts/pins keeps the existing unprepared fast path. Send repeats authoritative counting even when the renderer supplied a current preview revision.

- [ ] **Step 4: Run IPC tests**

Run:

```bash
npm test -- --run emain/agent-ipc.test.ts
```

Expected: PASS.

---

### Task 14: Rename backend commands and expose reference views

**Files:**

- Modify: `emain/agent/commands/registry.ts`
- Modify: `emain/agent/commands/registry.test.ts`
- Modify: `emain/agent/commands/types.ts`
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`

- [ ] **Step 1: Write command-contract tests**

Assert:

- discovered commands contain `session` and `info`;
- discovered commands do not contain `resume`;
- `/session` returns the command result that opens the session manager;
- `/info` returns the old session-information text;
- `/resume` is accepted as a hidden deprecated alias of `/session`;
- `agent:list-reference-points` returns only user-message entries.

- [ ] **Step 2: Implement the migration**

Split the current `/session` information handler into `/info`. Route `/session` to the existing session-selector opening result with a new manager mode. Keep the alias only in execution routing, not `getBuiltInAgentCommands()`.

Add `agent:list-reference-points` or extend the session-detail IPC with the typed user-turn list. Do not use the unfiltered `/tree` result as reference input.

- [ ] **Step 3: Run command tests**

Run:

```bash
npm test -- --run emain/agent/commands/registry.test.ts emain/agent-ipc.test.ts
```

Expected: PASS.

---

### Task 15: Backend integration and regression verification

**Files:**

- Modify only files proven necessary by failures from this task.

- [ ] **Step 1: Run focused context tests**

Run:

```bash
npm test -- --run emain/agent/context/validation.test.ts emain/agent/context/snapshot.test.ts emain/agent/context/journal.test.ts emain/agent/harness/session/entry-transaction.test.ts emain/agent/context/draft-registry.test.ts emain/agent/context/summary.test.ts emain/agent/context/projector.test.ts emain/agent/context/turn-preparer.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run storage/harness/runtime tests**

Run:

```bash
npm test -- --run emain/agent/harness/session/batch-storage.test.ts emain/agent/harness/session/sqlite-storage.test.ts emain/agent/sessions.test.ts emain/agent/harness/agent-harness.test.ts emain/agent/agent-session-runtime.test.ts emain/agent/harness-factory.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run IPC/command/config tests**

Run:

```bash
npm test -- --run emain/agent-ipc.test.ts emain/agent/commands/registry.test.ts emain/agent/commands/session-views.test.ts emain/aiconfig/user-config.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the full test suite once**

Run:

```bash
npm test -- --run
```

Expected: PASS. Do not pipe output through `head`, `tail`, or another command that can hide the test exit code.

- [ ] **Step 5: Build the Electron application**

Run:

```bash
npm run build:dev
```

Expected: PASS.

- [ ] **Step 6: Inspect the exact diff**

Run:

```bash
git status --short
git diff --check
git diff -- emain frontend/types/custom.d.ts frontend/app/store/ai-types.ts frontend/preview/mock/preview-electron-api.ts docs/ai-config-architecture.md docs/agent-user-guide.md
```

Expected: only intended files, no whitespace errors, no generated-file edits, and no `INSERT OR REPLACE` artifact mutation.

## Manual backend acceptance matrix

After automated tests, use the development build to verify:

1. Create A and B; prepare a turn draft from B for A; delete B before sending; A still sends from the captured draft.
2. Queue two sends in A with different once drafts; reports show different target turn IDs and no cross-binding.
3. Pin a B session summary, close/reopen A, and confirm the pin is hydrated.
4. Disable `context_references.enabled`, send in A, and confirm no overlay is injected while the pin remains stored.
5. Re-enable, export A, import it, and confirm the pin/report fold matches.
6. Corrupt an artifact reference in a test fixture and confirm session opening succeeds, exposes the pin as invalid, and disables referenced Send until the user pauses or detaches it.

## Completion conditions

Backend work is complete only when:

- all Task 15 commands pass;
- normal sends and queued follow-ups still pass existing tests;
- no draft is consumed before transaction commit;
- no user message is persisted twice;
- every considered attachment is represented in a persisted report;
- JSONL remains version 3 and context data round-trips as normal custom entries;
- interrupted JSONL transactions cannot expose a partial user turn through any reader or interchange path;
- feature disablement stops injection without deleting journal records.
