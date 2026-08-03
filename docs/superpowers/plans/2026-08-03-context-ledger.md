# Context Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Follow strict RED-GREEN-REFACTOR for every behavior change.

**Goal:** Replace the current Composition accordion with an always-visible semantic source ledger whose single expanded row displays the complete model-visible content inline.

**Architecture:** The coding-agent context inventory will transport a dedicated model-visible `content` value on every concrete snapshot item. `ContextComposition` will render fixed semantic group headings and own the one-open-source state. `ContextCategoryItems` will render source disclosures, preserve Conversation virtualization, and delegate exact text/JSON rendering to a focused payload component. Capacity, lifecycle, Context breakdown, request accounting, and provider execution stay unchanged.

**Tech Stack:** TypeScript, React 19, Tailwind CSS v4, `@tanstack/react-virtual`, Testing Library, Vitest.

---

### Task 1: Transport complete model-visible source content

**Files:**
- Modify: `packages/coding-agent/context/inspector-types.ts`
- Modify: `packages/coding-agent/context/inspector.ts`
- Modify: `packages/coding-agent/context/inspector.test.ts`
- Modify: `frontend/types/custom.d.ts`

- [x] **Step 1: Add failing inventory tests**

Add assertions that instruction items retain exact segment text, tool items retain the complete `{ name, description, parameters }` definition, and conversation children retain the complete effective role/content/tool-call/tool-result fragment after historical references are stripped. Add coverage for compacted summaries and the selected Added context representation where fixtures expose one.

- [x] **Step 2: Run the focused backend test and verify RED**

```bash
npx vitest run packages/coding-agent/context/inspector.test.ts --reporter=dot --silent
```

Expected: fail because snapshot items do not expose complete content.

- [x] **Step 3: Add an observational content field**

Add `content?: unknown` to `ContextSnapshotItem` and its frontend view type. Populate it from the effective semantic request values without mutating provider inputs:

- instruction segment `text`;
- complete active tool definition;
- effective conversation message or child fragment;
- exact compacted/branch summary value;
- exact rendered Added context representation when available from the committed journal.

Do not add Crest entry IDs, diagnostics, or request metadata to `content`. Preserve stable source identity/provenance in their existing fields.

- [x] **Step 4: Run the focused backend test and verify GREEN**

Run the Step 2 command and confirm the new exact-content assertions pass.

### Task 2: Specify the ledger and single-open interaction

**Files:**
- Modify: `frontend/app/agent/context-inspector/context-composition.test.tsx`
- Modify: `frontend/app/agent/context-inspector/context-inventory.test.tsx`
- Modify: `frontend/app/agent/context-inspector/context-inspector.test.tsx`

- [x] **Step 1: Replace the old category-accordion expectations**

Assert all four group headings are present without expansion, their source rows are immediately visible, and the UI contains no Composition heading, explanatory copy, column headers, per-source token labels, or request-overhead inventory row.

- [x] **Step 2: Add one-open-source and keyboard tests**

Click an instruction source, then a tool source. Assert the first closes, the second opens, and only one payload region exists. Click the second again to close it. Reopen it, press Escape, assert it closes and focus returns to its button.

- [x] **Step 3: Add exact content rendering tests**

Assert plain instruction text renders verbatim. Assert structured tool/message content renders deterministic formatted JSON with line numbers, while Crest-only provenance is absent. Assert long values use an internally scrollable region without replacing the full string.

- [x] **Step 4: Run the focused frontend tests and verify RED**

```bash
npx vitest run frontend/app/agent/context-inspector/context-composition.test.tsx frontend/app/agent/context-inspector/context-inventory.test.tsx frontend/app/agent/context-inspector/context-inspector.test.tsx --reporter=dot --silent
```

Expected: fail because categories are accordions, rows own independent expansion, and exact content is not rendered.

### Task 3: Implement the source ledger and payload surface

**Files:**
- Modify: `frontend/app/agent/context-inspector/context-composition.tsx`
- Modify: `frontend/app/agent/context-inspector/context-inventory.tsx`
- Modify: `frontend/app/agent/context-inspector/context-item.tsx`
- Create: `frontend/app/agent/context-inspector/context-payload.tsx`

- [x] **Step 1: Make groups structural rather than interactive**

Remove the Composition title, category percentage bar, category disclosure buttons, per-category token totals, request-overhead row, and attribution notice from `ContextComposition`. Render four quiet group headings in fixed order with source counts and immediately render each group's source rows. Keep empty groups visible with `No active sources.`.

- [x] **Step 2: Lift source expansion to one shared owner**

Track `expandedItemId: string | undefined` in `ContextComposition`. Pass the selected ID and a toggle callback through `ContextCategoryItems` to each source row. A toggle closes the current item or replaces it with the selected item. Preserve Conversation virtualization.

- [x] **Step 3: Refine source rows**

Render a native disclosure button with source name, only a useful one-line description, and a chevron. Remove kind labels, token values, provenance lines, nested child cards, and `No additional provenance.`. Use `aria-expanded` and `aria-controls`, clear focus styling, and compact ledger dividers.

- [x] **Step 4: Render complete payload content**

Implement `ContextPayload` to render strings as exact preformatted text and other values as stable indented JSON. Add presentation-only line numbers and lightweight syntax tones, keep the content selectable, and cap the viewport with internal scrolling. Do not truncate the value or add a payload heading.

- [x] **Step 5: Implement Escape close and focus restoration**

When the open payload receives Escape, close it and focus the matching disclosure button. Respect reduced motion by avoiding nonessential animations.

- [x] **Step 6: Run the focused frontend tests and verify GREEN**

Run the Task 2 Step 4 command and confirm the ledger, exact-content, virtualization, and accessibility assertions pass.

### Task 4: Preserve surrounding Context Inspector behavior

**Files:**
- Modify only if required: `frontend/app/agent/context-inspector/context-inspector.tsx`
- Modify: `docs/superpowers/plans/2026-08-03-context-ledger.md`

- [x] **Step 1: Verify no legacy modules remain**

```bash
rg -n "Composition|Why it is here|Included as|No additional provenance|Request overhead" frontend/app/agent/context-inspector
```

Expected: no rendered legacy Composition/inventory labels; lifecycle diagnostics may still mention provider accounting only where they remain outside the ledger.

- [x] **Step 2: Run the Context Inspector and host regression suite**

```bash
npx vitest run packages/coding-agent/context/inspector.test.ts frontend/app/agent/context-inspector frontend/app/agent/agent-content.test.tsx frontend/app/workspace/right-tool-panel.test.tsx frontend/app/workspace/workspace-right-panel-host.test.tsx --reporter=dot --silent
```

Expected: all selected tests pass without unhandled errors.

- [x] **Step 3: Run the production build**

```bash
npm run build:prod
```

Expected: exit code 0. Existing optional optimizer or chunk-size warnings are acceptable; new TypeScript or build errors are not.

- [x] **Step 4: Review the diff against the approved design**

Confirm the Context breakdown and capacity/lifecycle behavior are untouched, the ledger contains no duplicate header chrome, every source has stable identity, and inspector data remains observational.
