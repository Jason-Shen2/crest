# Agent Observability Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Crest's right-panel Agent Observability skeleton into a Pi-inspired Single Trace timeline and detail dashboard while preserving the Langfuse-compatible TraceGraph as the only data contract.

**Architecture:** Keep history and live updates on the existing `TraceGraph` IPC path. Add pure presentation, metrics, filtering, and view-state modules beneath focused React components; use inline details in normal right-panel mode and a split timeline/detail layout when magnified.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Vitest, React Testing Library/static rendering patterns already used by Crest, `@tanstack/react-virtual`, Electron preload IPC, Node 22 SQLite.

**Design:** `docs/specs/2026-07-19-agent-observability-dashboard-design.md`

---

## File Map

**Create**

- `frontend/app/observability/observation-presentation.ts`: Convert Langfuse observations into semantic timeline rows.
- `frontend/app/observability/observation-presentation.test.ts`: Presentation mapping tests.
- `frontend/app/observability/trace-metrics.ts`: Aggregate run duration, counts, tokens, cost, and final output.
- `frontend/app/observability/trace-metrics.test.ts`: Metric aggregation tests.
- `frontend/app/observability/observability-view-state.ts`: Pure reducer for selected trace/observation, filters, expansion, and live follow.
- `frontend/app/observability/observability-view-state.test.ts`: Reducer and filtering tests.
- `frontend/app/observability/trace-selector.tsx`: Compact Recent Runs selector.
- `frontend/app/observability/run-review.tsx`: Run summary metrics and final output.
- `frontend/app/observability/timeline-toolbar.tsx`: Search, filters, and expansion controls.
- `frontend/app/observability/observation-timeline.tsx`: Virtualized timeline, focus navigation, and live-tail.
- `frontend/app/observability/observation-row.tsx`: Timeline summary row and inline detail host.
- `frontend/app/observability/observation-detail.tsx`: Structured observation inspector.
- `frontend/app/observability/observability-panel.test.tsx`: Panel history/live/responsive behavior tests.

**Modify**

- `frontend/app/observability/observability-panel.tsx`: Compose dashboard components and own IPC lifecycle.
- `frontend/types/custom.d.ts`: Align renderer observation fields with main `LangfuseObservation`.
- `frontend/app/workspace/right-tool-panel.tsx`: Pass `isMagnified` into Observability content.
- `frontend/app/workspace/right-tool-panel.test.tsx`: Verify normal and magnified observability modes.
- `emain/agent/observability/trace-builder.ts`: Only if Task 8 proves a canonical field is missing.
- `emain/agent/observability/trace-builder.test.ts`: Only with Task 8 data additions.
- `emain/agent/observability/types.ts`: Only with Task 8 data additions.
- `emain/agent/observability/trace-store-rows.ts`: Only with Task 8 persisted fields.
- `emain/agent/observability/trace-store-rows.test.ts`: Only with Task 8 persisted fields.

---

### Task 1: Align Renderer Observation Types

**Files:**
- Modify: `frontend/types/custom.d.ts`
- Test: `frontend/app/observability/observation-presentation.test.ts`

- [ ] **Step 1: Add a compile-time fixture that uses the missing fields**

Create `observation-presentation.test.ts` with a shared fixture:

```ts
import { describe, expect, it } from "vitest";

export function makeObservation(
    overrides: Partial<AgentObservabilityObservation> = {}
): AgentObservabilityObservation {
    return {
        id: "obs-1",
        traceId: "trace-1",
        type: "TOOL",
        name: "read",
        startTime: "2026-07-19T00:00:01.000Z",
        endTime: "2026-07-19T00:00:01.042Z",
        parentObservationId: "root-1",
        level: "DEFAULT",
        statusMessage: null,
        version: null,
        model: null,
        input: { path: "README.md" },
        output: "contents",
        metadata: {},
        latency: 0.042,
        timeToFirstToken: null,
        usageDetails: {},
        costDetails: {},
        toolCalls: ["call-1"],
        toolCallNames: ["read"],
        ...overrides,
    };
}

describe("AgentObservabilityObservation renderer contract", () => {
    it("contains the Langfuse observation fields used by the dashboard", () => {
        const observation = makeObservation();
        expect(observation.toolCallNames).toEqual(["read"]);
        expect(observation.latency).toBe(0.042);
    });
});
```

- [ ] **Step 2: Run the focused type/test command and confirm failure**

Run:

```bash
npx vitest run frontend/app/observability/observation-presentation.test.ts
```

Expected: TypeScript transform fails because `version`, `latency`, `timeToFirstToken`, `toolCalls`, and `toolCallNames` are absent.

- [ ] **Step 3: Align the ambient renderer type**

Add to `AgentObservabilityObservation`:

```ts
version: string | null;
latency: number | null;
timeToFirstToken: number | null;
toolCalls: string[] | null;
toolCallNames: string[] | null;
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
npx vitest run frontend/app/observability/observation-presentation.test.ts
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add frontend/types/custom.d.ts frontend/app/observability/observation-presentation.test.ts
git commit -m "chore: align observability renderer types"
```

### Task 2: Build Observation Presentation

**Files:**
- Create: `frontend/app/observability/observation-presentation.ts`
- Modify: `frontend/app/observability/observation-presentation.test.ts`

- [ ] **Step 1: Add failing semantic mapping tests**

Cover:

```ts
it.each([
    ["GENERATION", "generation"],
    ["TOOL", "tool"],
    ["EVENT", "lifecycle"],
])("maps %s to %s", (type, category) => {
    expect(presentObservation(makeObservation({ type })).category).toBe(category);
});

it("maps errors independently of observation type", () => {
    const result = presentObservation(makeObservation({
        type: "TOOL",
        level: "ERROR",
        statusMessage: "command failed",
    }));
    expect(result.category).toBe("error");
    expect(result.tone).toBe("error");
    expect(result.searchableText).toContain("command failed");
});

it("summarizes tool arguments without dumping the entire payload", () => {
    const result = presentObservation(makeObservation({
        input: { path: "README.md", line_start: 1 },
    }));
    expect(result.summary).toContain("README.md");
    expect(result.summary.length).toBeLessThanOrEqual(160);
});
```

- [ ] **Step 2: Run tests and confirm missing implementation**

Run:

```bash
npx vitest run frontend/app/observability/observation-presentation.test.ts
```

Expected: FAIL because `presentObservation` is not defined.

- [ ] **Step 3: Implement the pure presentation contract**

Export:

```ts
export type ObservationCategory = "generation" | "tool" | "lifecycle" | "error";
export type ObservationTone = "neutral" | "info" | "success" | "warning" | "error";

export interface ObservationBadge {
    label: string;
    tone: ObservationTone;
}

export interface ObservationPresentation {
    category: ObservationCategory;
    label: string;
    summary: string;
    tone: ObservationTone;
    badges: ObservationBadge[];
    searchableText: string;
}

export function presentObservation(
    observation: AgentObservabilityObservation
): ObservationPresentation;
```

Implementation requirements:

- Error level overrides category/tone.
- Tool summary prefers compact `input` values.
- Generation summary prefers textual `output`.
- Event label maps `model_change`, `compaction`, and `branch_nav`.
- Badges include duration, model, token count, cost, and error where available.
- `searchableText` is computed once from label, summary, name, status, input, output, and metadata.
- String summaries are clamped to 160 characters.

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run frontend/app/observability/observation-presentation.test.ts
```

Expected: all presentation tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/observability/observation-presentation.ts frontend/app/observability/observation-presentation.test.ts
git commit -m "feat: add observation presentation model"
```

### Task 3: Aggregate Trace Metrics

**Files:**
- Create: `frontend/app/observability/trace-metrics.ts`
- Create: `frontend/app/observability/trace-metrics.test.ts`

- [ ] **Step 1: Write failing aggregation tests**

Use a graph with two generations, two tools, one error, and mixed usage:

```ts
expect(computeTraceMetrics(graph)).toMatchObject({
    durationMs: 5000,
    generationCount: 2,
    toolCount: 2,
    errorCount: 1,
    usage: {
        input: 30,
        output: 12,
        cacheRead: 8,
        cacheWrite: 2,
    },
    totalCost: 0.015,
    finalOutput: "Finished",
});
```

Also test:

- Running trace uses the latest observation end/start as provisional duration.
- Null/missing usage and cost contribute zero.
- Final output falls back from `trace.output` to the last generation output.
- AGENT root is excluded from event counts.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run frontend/app/observability/trace-metrics.test.ts
```

Expected: FAIL because `computeTraceMetrics` is missing.

- [ ] **Step 3: Implement metrics**

Export:

```ts
export interface TraceMetrics {
    durationMs: number;
    generationCount: number;
    toolCount: number;
    lifecycleCount: number;
    errorCount: number;
    usage: Record<"input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens", number>;
    totalCost: number;
    finalOutput: string;
}

export function computeTraceMetrics(graph: AgentObservabilityTraceGraph): TraceMetrics;
```

Sum numeric values only. For cost, sum every numeric entry in each observation's `costDetails`; do not invent exchange rates or provider-specific normalization.

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run frontend/app/observability/trace-metrics.test.ts
```

Expected: all metric tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/observability/trace-metrics.ts frontend/app/observability/trace-metrics.test.ts
git commit -m "feat: add trace review metrics"
```

### Task 4: Add Dashboard View State

**Files:**
- Create: `frontend/app/observability/observability-view-state.ts`
- Create: `frontend/app/observability/observability-view-state.test.ts`

- [ ] **Step 1: Write failing reducer and filtering tests**

Test these transitions:

```ts
state = reduceObservabilityViewState(state, { type: "select-trace", traceId: "trace-2" });
expect(state.selectedTraceId).toBe("trace-2");
expect(state.selectedObservationId).toBeUndefined();

state = reduceObservabilityViewState(state, { type: "toggle-expanded", observationId: "obs-2" });
expect(state.expandedObservationIds.has("obs-2")).toBe(true);

state = reduceObservabilityViewState(state, { type: "pause-follow-live" });
expect(state.followLive).toBe(false);
```

Test `filterTimelineRows()` with search plus category filters using AND semantics.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run frontend/app/observability/observability-view-state.test.ts
```

Expected: FAIL because reducer/filter functions are missing.

- [ ] **Step 3: Implement immutable state**

Define:

```ts
export interface ObservabilityViewState {
    selectedTraceId?: string;
    selectedObservationId?: string;
    query: string;
    categories: Set<ObservationCategory>;
    expandedObservationIds: Set<string>;
    followLive: boolean;
}
```

Actions:

- `select-trace`
- `select-observation`
- `set-query`
- `toggle-category`
- `toggle-expanded`
- `expand-all`
- `collapse-all`
- `pause-follow-live`
- `resume-follow-live`

Keep this reducer independent of React and IPC.

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run frontend/app/observability/observability-view-state.test.ts
```

Expected: reducer and filter tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/observability/observability-view-state.ts frontend/app/observability/observability-view-state.test.ts
git commit -m "feat: add observability dashboard state"
```

### Task 5: Implement Recent Runs and Run Review

**Files:**
- Create: `frontend/app/observability/trace-selector.tsx`
- Create: `frontend/app/observability/run-review.tsx`
- Modify: `frontend/app/observability/observability-panel.tsx`
- Create: `frontend/app/observability/observability-panel.test.tsx`

- [ ] **Step 1: Write failing component tests**

Render with injected API data and assert:

- Latest Trace is selected initially.
- Recent Runs can select an older Trace.
- A stale `getTrace(oldId)` response cannot overwrite a newer selection.
- Live update to another Trace updates Recent Runs but does not replace a selected historical graph.
- Run Review renders status, duration, tools, generations, errors, tokens, cost, and final output.

Use a deferred Promise helper for the stale-response test:

```ts
const first = deferred<AgentObservabilityTraceGraph>();
const second = deferred<AgentObservabilityTraceGraph>();
api.getTrace.mockImplementation((id) => id === "trace-1" ? first.promise : second.promise);
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npx vitest run frontend/app/observability/observability-panel.test.tsx
```

Expected: FAIL because selector/review UI and guarded selection do not exist.

- [ ] **Step 3: Implement focused components**

`TraceSelector` props:

```ts
interface TraceSelectorProps {
    traces: AgentObservabilityTrace[];
    selectedTraceId?: string;
    onSelectTrace: (traceId: string) => void;
}
```

`RunReview` props:

```ts
interface RunReviewProps {
    graph: AgentObservabilityTraceGraph;
}
```

Refactor `ObservabilityPanel` so:

- `listTraces()` initializes the selected id.
- `loadTrace(traceId)` captures the requested id and ignores stale responses.
- Live events update the matching graph only when it is currently selected.
- Live events always update the Recent Runs collection.
- API unavailability, loading, empty, and rejected Promise states have distinct UI.

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run frontend/app/observability/observability-panel.test.tsx
```

Expected: all history/live/Run Review tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/observability/trace-selector.tsx frontend/app/observability/run-review.tsx frontend/app/observability/observability-panel.tsx frontend/app/observability/observability-panel.test.tsx
git commit -m "feat: add observability run review"
```

### Task 6: Implement Timeline, Search, Filters, and Live Tail

**Files:**
- Create: `frontend/app/observability/timeline-toolbar.tsx`
- Create: `frontend/app/observability/observation-timeline.tsx`
- Create: `frontend/app/observability/observation-row.tsx`
- Modify: `frontend/app/observability/observability-panel.tsx`
- Modify: `frontend/app/observability/observability-panel.test.tsx`

- [ ] **Step 1: Add failing timeline tests**

Assert:

- AGENT root is absent from Timeline.
- Rows display relative time, summary, duration, and badges.
- Search and category filters compose.
- Errors appear under Errors regardless of TOOL/GENERATION type.
- Expand All and Collapse All update visible details.
- `j/k`, Enter, Escape, `g/G`, and `/` affect focus/expansion/search.
- User scroll away pauses follow-live; “Back to live” resumes and scrolls to the last row.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run frontend/app/observability/observability-panel.test.tsx
```

Expected: timeline assertions fail.

- [ ] **Step 3: Implement toolbar and virtualized timeline**

Use `useVirtualizer`:

```ts
const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 8,
});
```

Requirements:

- Build rows with `presentObservation`.
- Compute relative time from `trace.timestamp`.
- Give each row stable key `observation.id`.
- Re-measure rows after expansion.
- Do not force scroll when `followLive` is false.
- Respect `prefers-reduced-motion` for live insertion.
- Keep buttons `cursor-pointer` and use theme tokens only.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx vitest run frontend/app/observability/observability-panel.test.tsx frontend/app/observability/observation-presentation.test.ts frontend/app/observability/observability-view-state.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/observability/timeline-toolbar.tsx frontend/app/observability/observation-timeline.tsx frontend/app/observability/observation-row.tsx frontend/app/observability/observability-panel.tsx frontend/app/observability/observability-panel.test.tsx
git commit -m "feat: add observability timeline"
```

### Task 7: Implement Structured Detail and Magnified Split Layout

**Files:**
- Create: `frontend/app/observability/observation-detail.tsx`
- Modify: `frontend/app/observability/observation-row.tsx`
- Modify: `frontend/app/observability/observation-timeline.tsx`
- Modify: `frontend/app/observability/observability-panel.tsx`
- Modify: `frontend/app/workspace/right-tool-panel.tsx`
- Modify: `frontend/app/workspace/right-tool-panel.test.tsx`
- Modify: `frontend/app/observability/observability-panel.test.tsx`

- [ ] **Step 1: Add failing responsive detail tests**

Assert:

- `ObservabilityPanel magnified={false}` renders selected Detail inline.
- `ObservabilityPanel magnified` renders `aria-label="Observation detail"` in a sibling split pane.
- Input, Output, Usage, Metadata, and Raw sections render only when data exists.
- Copy action writes the complete observation JSON.
- Raw wrap toggle changes `whitespace-pre` to `whitespace-pre-wrap`.
- RightToolPanel passes `magnified={state.magnified}` only to Observability.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run frontend/app/observability/observability-panel.test.tsx frontend/app/workspace/right-tool-panel.test.tsx
```

Expected: responsive detail assertions fail.

- [ ] **Step 3: Pass magnified state through the right-panel boundary**

Change:

```ts
export type RightToolContentProps = {
    activeTool?: RightToolId;
    magnified?: boolean;
};
```

Render:

```tsx
if (activeTool === "observability") {
    return <ObservabilityPanel magnified={magnified} />;
}
```

Pass `state.magnified` from `RightToolPanelContent`.

- [ ] **Step 4: Implement structured detail**

`ObservationDetail` props:

```ts
interface ObservationDetailProps {
    observation: AgentObservabilityObservation;
}
```

Requirements:

- Overview includes status, name, type, model, timing, and status message.
- Input/Output use safe React text rendering, never `dangerouslySetInnerHTML`.
- Usage lists numeric `usageDetails` and `costDetails`.
- Metadata and Raw use deterministic `JSON.stringify(value, null, 2)`.
- Copy uses `navigator.clipboard.writeText`.
- Inline and split layouts reuse the same component.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run frontend/app/observability/observability-panel.test.tsx frontend/app/workspace/right-tool-panel.test.tsx
```

Expected: all responsive detail tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/observability/observation-detail.tsx frontend/app/observability/observation-row.tsx frontend/app/observability/observation-timeline.tsx frontend/app/observability/observability-panel.tsx frontend/app/workspace/right-tool-panel.tsx frontend/app/workspace/right-tool-panel.test.tsx frontend/app/observability/observability-panel.test.tsx
git commit -m "feat: add observation detail dashboard"
```

### Task 8: Audit Real Trace Data and Add Only Proven Canonical Fields

**Files:**
- Inspect: `.tmp/obs-config/observability/traces.db`
- Modify only if evidence requires it:
  - `emain/agent/harness/types.ts`
  - `emain/agent/harness/agent-harness.ts`
  - `emain/agent/observability/types.ts`
  - `emain/agent/observability/trace-builder.ts`
  - `emain/agent/observability/trace-store-rows.ts`
  - `frontend/types/custom.d.ts`
- Test only with matching implementation files.

- [x] **Step 1: Run a representative Agent trace**

The run must include:

- At least two generations.
- At least two tools.
- One failed tool invocation or controlled error.
- A completed success/error/aborted trace state.

- [x] **Step 2: Query the persisted graph**

Run with Node 22:

```bash
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(".tmp/obs-config/observability/traces.db");
console.log(JSON.stringify({
  traces: db.prepare("select id,status,timestamp,ended_at,input,output from traces order by timestamp desc limit 1").all(),
  observations: db.prepare("select type,name,start_time,end_time,level,status_message,model,input,output,metadata,usage_details,cost_details from observations where trace_id=(select id from traces order by timestamp desc limit 1) order by start_time").all()
}, null, 2));
'
```

Expected: enough data to fill Run Review, Timeline summary, Tool Detail, and Generation Usage.

- [x] **Step 3: Make an evidence-based gap table**

For every missing UI field, record:

| Desired field | Existing source | Langfuse target | Required? |
|---|---|---|---|
| tool args | `tool_execution_start.args` | `Observation.input` | yes |
| tool result | `tool_execution_end.result` | `Observation.output` | yes |
| model | none in subscriber-visible generation events | `Observation.model` | only if diagnostics require |

If no required field is missing, do not modify harness or storage.

- [x] **Step 4: N/A — no required canonical field was missing**

The audit found only optional per-generation input context missing. The current UI conditionally hides that section, while Trace/AGENT input, Generation output, model, timing, usage, and cost cover the required review flow. No failing builder test was needed.

The new event must be broadcast through `emitOwn`, for example:

```ts
expect(builder.applyEvent({
    sessionPath,
    event: { type: "generation_context", model: { id: "model-id", provider: "provider" } },
})?.observations.at(-1)).toMatchObject({
    model: "model-id",
    metadata: { provider: "provider" },
});
```

Do not subscribe to `before_provider_request`, `tool_call`, or other hook-only events.

- [x] **Step 5: N/A — no canonical field addition was implemented**

Add one explicit `AgentHarnessOwnEvent`, emit it from the harness, map it in the builder, persist it, and expose it through the renderer type. Do not introduce an Adapter or `ObsEvent`.

- [x] **Step 6: Run data-layer tests**

Run:

```bash
npx vitest run emain/agent/observability emain/agent-ipc.test.ts
```

Expected: all tests pass.

- [x] **Step 7: Commit only if code changed**

```bash
git add emain/agent/harness emain/agent/observability frontend/types/custom.d.ts
git commit -m "feat: enrich canonical observability events"
```

### Task 9: Full Verification and Documentation Sync

**Files:**
- Modify: `docs/specs/2026-07-19-agent-observability-dashboard-design.md`
- Modify: `docs/plans/2026-07-19-agent-observability-dashboard.md`

- [ ] **Step 1: Run all targeted tests**

```bash
npx vitest run \
  emain/agent/observability \
  emain/agent-ipc.test.ts \
  frontend/app/observability \
  frontend/app/workspace/right-tool-panel.test.tsx \
  frontend/app/workspace/right-tool-panel-state.test.ts
```

Expected: zero failures.

- [ ] **Step 2: Run filtered type verification**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "frontend/app/observability|frontend/app/workspace/right-tool-panel|emain/agent/observability|emain/agent-ipc"
```

Expected: no output. Repository-wide pre-existing TypeScript failures must be reported separately rather than attributed to this feature.

- [ ] **Step 3: Verify normal and magnified UI**

Start with Node 22 and isolated data:

```bash
WAVETERM_CONFIG_HOME="$PWD/.tmp/obs-config" \
WAVETERM_DATA_HOME="$PWD/.tmp/obs-data" \
ELECTRON_DISABLE_SANDBOX=1 \
npm run dev -- -- --no-sandbox --disable-gpu --user-data-dir="$PWD/.tmp/electron-user-data"
```

Verify:

- Recent Runs changes the selected Trace.
- Run Review values match SQLite.
- Timeline search and filters work.
- Live tail pauses and resumes.
- Normal panel expands detail inline.
- Magnified panel shows split detail.
- A completed run moves from running to success/error/aborted.

- [ ] **Step 4: Run a 1,000-observation fixture**

Render a generated graph in the panel test and assert:

- Only a bounded number of DOM rows are mounted.
- Search returns the expected matching row.
- Expanding a row re-measures without overlap.

- [ ] **Step 5: Update progress in design and plan**

Mark only completed phases and record exact test counts/commands. Do not claim swimlane/race completion.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/observability frontend/app/workspace/right-tool-panel.tsx frontend/app/workspace/right-tool-panel.test.tsx frontend/types/custom.d.ts emain/agent/observability docs/specs/2026-07-19-agent-observability-dashboard-design.md docs/plans/2026-07-19-agent-observability-dashboard.md
git commit -m "feat: complete single trace observability dashboard"
```
