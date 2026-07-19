# Trace Panel Source Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Langfuse Trace Panel 的 Timeline、Trace/Observation Detail 与 desktop layout 按源码模块边界迁入 Crest，并直接消费 `TraceDetail`。

**Architecture:** `TraceDataProvider` 是唯一 observation-to-view projection；Tree、Timeline、Search、Graph 和 Detail 共享 `TraceNode` hierarchy 与 `selectedNodeId`。迁移保留 Langfuse 的 calculation/rendering composition，删除 Crest 无数据源的产品能力，不建立源码岛、shim 或 adapter。

**Tech Stack:** React 19、TypeScript、Tailwind v4、Vitest、Testing Library、`@tanstack/react-virtual`、`react-resizable-panels`

---

## 执行约束

- 工作目录：`/Users/bytedance/Documents/crest/.worktrees/agent-observability-langfuse`
- 上游源码：`/tmp/langfuse-src`，commit `1cb1bbcf6b269fd887a6667796f1a15417cca336`
- 设计文档：`docs/specs/2026-07-20-trace-panel-source-migration-design.md`
- 当前 worktree 包含本任务之前的未提交 observability 改动。
- 每次提交必须精确 `git add <files>`，禁止 `git add .`、`git add -A` 或清理无关改动。
- 每个 production behavior 必须先写测试并观察预期失败，再迁移最小源码使其通过。
- 新文件使用 2026 copyright；源自 Langfuse 的文件保留 MIT attribution。

## 文件结构

### Timeline

```text
frontend/app/observability/trace-panel/
├── timeline-calculations.ts
├── timeline-calculations.test.ts
├── timeline-flattening.ts
├── timeline-flattening.test.ts
├── timeline-types.ts
├── timeline-scale.tsx
├── timeline-bar.tsx
├── timeline-gutter-row.tsx
├── timeline-rows.tsx
├── trace-timeline.tsx
└── trace-timeline.test.tsx
```

### Detail

```text
frontend/app/observability/trace-panel/
├── detail-primitives.tsx
├── detail-value.ts
├── detail-value.test.ts
├── io-preview.tsx
├── trace-detail-view.tsx
├── observation-detail-view.tsx
├── trace-panel-detail.tsx
└── trace-panel-detail.test.tsx
```

### Layout

```text
frontend/app/observability/trace-panel/
├── trace-layout-desktop.tsx
├── trace-panel-navigation-layout-desktop.tsx
├── trace-panel-layout.test.tsx
└── trace-panel.tsx
```

## Task 1：统一 Selection 与 Trace 时间范围

**Files:**
- Modify: `frontend/app/observability/trace-panel/trace-context.tsx`
- Modify: `frontend/app/observability/trace-panel/trace-tree.tsx`
- Modify: `frontend/app/observability/trace-panel/trace-search-list.tsx`
- Modify: `frontend/app/observability/trace-panel/trace-graph.tsx`
- Test: `frontend/app/observability/trace-panel/trace-context.test.tsx`

- [ ] **Step 1: 写 selection 回退和时间范围失败测试**

```tsx
it("uses null for trace selection and clears a removed observation", () => {
    const { rerender } = render(<ContextProbe detail={makeDetail(["generation-1"])} />);
    fireEvent.click(screen.getByRole("button", { name: "select generation-1" }));
    expect(screen.getByTestId("selection")).toHaveTextContent("generation-1");

    rerender(<ContextProbe detail={makeDetail([])} />);
    expect(screen.getByTestId("selection")).toHaveTextContent("trace");
});

it("ignores invalid dates when computing the trace time range", () => {
    render(<ContextProbe detail={makeDetailWithInvalidObservationTime()} />);
    expect(screen.getByTestId("trace-start")).toHaveTextContent("2026-07-20T08:00:00.000Z");
    expect(screen.getByTestId("trace-duration")).toHaveTextContent("4");
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/trace-context.test.tsx
```

Expected: FAIL；removed observation 仍保持 selection，或非法日期使时间范围成为 `Invalid Date/NaN`。

- [ ] **Step 3: 在 context 中加入合法时间边界与 selection reconciliation**

```tsx
function finiteTimestamp(value: string | null | undefined): number | null {
    const timestamp = value == null ? Number.NaN : Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function calculateTraceTimeRange(detail: TraceDetail): { traceStartTime: Date; traceDuration: number } {
    const starts = [
        finiteTimestamp(detail.trace.timestamp),
        ...detail.observations.map((observation) => finiteTimestamp(observation.startTime)),
    ].filter((value): value is number => value != null);
    const fallbackStart = finiteTimestamp(detail.trace.timestamp) ?? 0;
    const start = starts.length > 0 ? Math.min(...starts) : fallbackStart;
    const ends = [
        finiteTimestamp(detail.trace.endedAt),
        ...detail.observations.map(
            (observation) => finiteTimestamp(observation.endTime) ?? finiteTimestamp(observation.startTime)
        ),
    ].filter((value): value is number => value != null);
    const end = ends.length > 0 ? Math.max(start, ...ends) : start;
    return { traceStartTime: new Date(start), traceDuration: Math.max(0.001, (end - start) / 1000) };
}
```

在 provider 中使用 `observationMap` 校验 `selectedNodeId`；当 ID 不存在时向 consumers 暴露 `null`。Tree 的 trace root、Timeline 的 TRACE row、Search 的 trace item 和 Graph root 都必须调用 `setSelectedNodeId(null)`。

- [ ] **Step 4: 运行 context 与现有 Tree interaction tests**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/trace-context.test.tsx frontend/app/observability/observability-interactions.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 精确提交**

```bash
git add frontend/app/observability/trace-panel/trace-context.tsx frontend/app/observability/trace-panel/trace-context.test.tsx frontend/app/observability/trace-panel/trace-tree.tsx frontend/app/observability/trace-panel/trace-search-list.tsx frontend/app/observability/trace-panel/trace-graph.tsx
git commit -m "refactor: unify trace panel selection"
```

## Task 2：迁移 Timeline 纯计算

**Files:**
- Create: `frontend/app/observability/trace-panel/timeline-calculations.ts`
- Create: `frontend/app/observability/trace-panel/timeline-calculations.test.ts`
- Create: `frontend/app/observability/trace-panel/timeline-types.ts`
- Modify: `frontend/app/observability/trace-panel/types.ts`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/TraceTimeline/timeline-calculations.ts`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/TraceTimeline/timeline-calculations.clienttest.ts`

- [ ] **Step 1: 移植上游 calculation tests，先指向尚不存在的 Crest API**

测试必须覆盖：

```ts
expect(findEarliestStartTime([root])?.toISOString()).toBe("2026-07-20T08:00:00.000Z");
expect(calculateTraceDuration([root], origin)).toBe(10);
expect(calculateTimelineOffset(node.startTime, origin, 10, 1000)).toBe(200);
expect(calculateTimelineWidth(2, 10, 1000)).toBe(200);
expect(calculateStepSize(8, 900)).toBe(1);
expect(
    computeSelectionScrollTarget({
        index: 20,
        rowHeight: 26,
        scrollTop: 0,
        scrollLeft: 0,
        clientHeight: 260,
        clientWidth: 400,
        barStart: 800,
        isInitial: false,
    })
).toEqual({ top: 286, left: 720 });
```

额外增加 Crest 边界：

```ts
expect(calculateTimelineOffset(invalidDate, origin, 0, 900)).toBe(0);
expect(calculateTimelineWidth(0, 0, 900)).toBe(0);
```

- [ ] **Step 2: 运行测试并确认模块缺失或 assertions 失败**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/timeline-calculations.test.ts
```

Expected: FAIL，因为 calculation 模块尚未实现。

- [ ] **Step 3: 从 Langfuse 迁移纯函数并替换 `TreeNode` 为 `TraceNode`**

保留以下 exports：

```ts
export const ScaleWidth = 900;
export const StepSize = 100;
export const RevealMarginPx = 16;
export const RevealLeftFraction = 0.2;

export function findEarliestStartTime(roots: TraceNode[]): Date | null;
export function calculateTraceDuration(roots: TraceNode[], origin: Date): number;
export function calculateTimelineOffset(
    nodeStartTime: Date,
    traceStartTime: Date,
    totalScaleSpan: number,
    scaleWidth?: number
): number;
export function calculateTimelineWidth(duration: number, totalScaleSpan: number, scaleWidth?: number): number;
export function calculateStepSize(traceDuration: number, scaleWidth?: number): number;
export function computeSelectionScrollTarget(args: SelectionScrollArgs): { top: number; left: number };
```

对非法时间、非正 scale span 和非有限计算结果统一返回 `0`，避免 chart style 出现 `NaNpx`。

- [ ] **Step 4: 运行 calculation tests**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/timeline-calculations.test.ts
```

Expected: PASS。

- [ ] **Step 5: 精确提交**

```bash
git add frontend/app/observability/trace-panel/timeline-calculations.ts frontend/app/observability/trace-panel/timeline-calculations.test.ts frontend/app/observability/trace-panel/timeline-types.ts frontend/app/observability/trace-panel/types.ts
git commit -m "feat: migrate trace timeline calculations"
```

## Task 3：迁移 Timeline Flattening

**Files:**
- Create: `frontend/app/observability/trace-panel/timeline-flattening.ts`
- Create: `frontend/app/observability/trace-panel/timeline-flattening.test.ts`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/TraceTimeline/timeline-flattening.ts`
- Reference: `frontend/app/observability/trace-panel/tree-flattening.ts`

- [ ] **Step 1: 写 hierarchy/collapse/geometry 失败测试**

```ts
it("flattens the same visible hierarchy as the trace tree", () => {
    const rows = flattenTimelineRows([agentNode], new Set(["turn-2"]), origin, 10);
    expect(rows.map((row) => [row.node.id, row.depth])).toEqual([
        ["agent", 0],
        ["turn-1", 1],
        ["generation-1", 2],
        ["tool-1", 2],
        ["turn-2", 1],
    ]);
});

it("keeps invalid-time nodes in the gutter with zero geometry", () => {
    const [row] = flattenTimelineRows([invalidNode], new Set(), origin, 10);
    expect(row).toMatchObject({ startOffset: 0, width: 0, duration: 0 });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/timeline-flattening.test.ts
```

Expected: FAIL，因为 `flattenTimelineRows` 尚未存在。

- [ ] **Step 3: 迁移 flattening，复用 Tree 的 visibility 规则**

```ts
export function flattenTimelineRows(
    roots: TraceNode[],
    collapsedNodes: Set<string>,
    traceStartTime: Date,
    traceDuration: number
): TimelineTraceNode[] {
    return flattenTraceTree(roots, collapsedNodes).map((flatNode) => {
        const duration = validDurationSeconds(flatNode.node);
        return {
            ...flatNode,
            duration,
            startOffset: calculateTimelineOffset(
                flatNode.node.startTime,
                traceStartTime,
                traceDuration
            ),
            width: calculateTimelineWidth(duration, traceDuration),
        };
    });
}
```

不得重新实现 parent traversal；必须使用 `flattenTraceTree` 产出的 `depth/treeLines/isLastSibling`。

- [ ] **Step 4: 运行 flattening 与 Tree tests**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/timeline-flattening.test.ts frontend/app/observability/observability-interactions.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 精确提交**

```bash
git add frontend/app/observability/trace-panel/timeline-flattening.ts frontend/app/observability/trace-panel/timeline-flattening.test.ts
git commit -m "feat: migrate trace timeline flattening"
```

## Task 4：迁移 Timeline Scale、Bar、Gutter 与 Rows

**Files:**
- Create: `frontend/app/observability/trace-panel/timeline-scale.tsx`
- Create: `frontend/app/observability/trace-panel/timeline-bar.tsx`
- Create: `frontend/app/observability/trace-panel/timeline-gutter-row.tsx`
- Create: `frontend/app/observability/trace-panel/timeline-rows.tsx`
- Test: `frontend/app/observability/trace-panel/trace-timeline.test.tsx`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/TraceTimeline/TimelineScale.tsx`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/TraceTimeline/TimelineBar.tsx`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/TraceTimeline/TimelineGutterRow.tsx`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/TraceTimeline/TimelineRows.tsx`

- [ ] **Step 1: 写 row composition 失败测试**

```tsx
it("renders matching gutter and chart rows with Crest-supported badges", () => {
    render(<TimelineRowsHarness />);
    expect(screen.getAllByTestId("timeline-gutter-row")).toHaveLength(4);
    expect(screen.getAllByTestId("timeline-chart-row")).toHaveLength(4);
    expect(screen.getByText("TTFT 610ms")).toBeVisible();
    expect(screen.getByText("2,418 tokens")).toBeVisible();
    expect(screen.queryByText(/comment/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/score/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试并确认缺少组件**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/trace-timeline.test.tsx -t "matching gutter"
```

Expected: FAIL，因为 timeline row components 尚不存在。

- [ ] **Step 3: 迁移 Scale 和 Bar**

`TimelineScale` 使用 `calculateStepSize()` 生成 ticks；所有 tick、bar 和 selection reveal 使用相同 `ScaleWidth`。

`TimelineBar` 保留上游绝对定位结构，并裁剪为：

```tsx
<div
    data-testid="timeline-bar"
    className={cn("absolute h-3 rounded-sm", toneClass)}
    style={{ left: row.startOffset, width: Math.max(MinimumBarWidth, row.width) }}
>
    {ttftWidth > 0 ? <span className="absolute inset-y-0 left-0 bg-accent/35" style={{ width: ttftWidth }} /> : null}
</div>
```

标签仅允许 duration、TTFT、model、tokens、cost 和 error。

- [ ] **Step 4: 迁移 Gutter 和 Rows**

`TimelineGutterRow` 复用 `VirtualizedTreeNodeWrapper`、`ItemBadge` 和 connector metadata。`TimelineRows` 接收同一批 virtual items，同时输出 gutter/chart rows，不创建第二个 virtualizer。

- [ ] **Step 5: 运行 row tests**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/trace-timeline.test.tsx -t "matching gutter"
```

Expected: PASS。

- [ ] **Step 6: 精确提交**

```bash
git add frontend/app/observability/trace-panel/timeline-scale.tsx frontend/app/observability/trace-panel/timeline-bar.tsx frontend/app/observability/trace-panel/timeline-gutter-row.tsx frontend/app/observability/trace-panel/timeline-rows.tsx frontend/app/observability/trace-panel/trace-timeline.test.tsx
git commit -m "feat: migrate trace timeline rows"
```

## Task 5：替换 Timeline 主容器

**Files:**
- Modify: `frontend/app/observability/trace-panel/trace-timeline.tsx`
- Modify: `frontend/app/observability/trace-panel/trace-context.tsx`
- Modify: `frontend/app/observability/trace-panel/trace-timeline.test.tsx`
- Modify: `frontend/app/observability/observability-interactions.test.tsx`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/TraceTimeline/index.tsx`

- [ ] **Step 1: 写滚动同步、collapse 和 selection reveal 失败测试**

```tsx
it("uses the chart as the only scroll source and synchronizes gutter and scale", () => {
    render(<TraceTimelineHarness />);
    const chart = screen.getByTestId("timeline-scroll");
    fireEvent.scroll(chart, { target: { scrollTop: 78, scrollLeft: 240 } });
    expect(screen.getByTestId("timeline-gutter-content")).toHaveStyle("transform: translateY(-78px)");
    expect(screen.getByTestId("timeline-scale-content")).toHaveStyle("transform: translateX(-240px)");
});

it("reveals a selection made from the tree", () => {
    render(<TracePanelHarness />);
    fireEvent.click(screen.getByRole("treeitem", { name: /read_file/i }));
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(screen.getByTestId("timeline-scroll").scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ top: expect.any(Number), left: expect.any(Number) })
    );
});
```

- [ ] **Step 2: 运行测试并确认当前固定 900px 实现失败**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/trace-timeline.test.tsx frontend/app/observability/observability-interactions.test.tsx
```

Expected: FAIL；当前 Timeline 没有上游 scroll/reveal contract。

- [ ] **Step 3: 迁移 `TraceTimeline` 主 composition**

必须保留：

```tsx
const rows = useMemo(
    () => flattenTimelineRows(roots, collapsedNodes, traceStartTime, traceDuration),
    [roots, collapsedNodes, traceStartTime, traceDuration]
);
const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TimelineRowHeight,
    overscan: TimelineOverscan,
});
```

chart scroll handler只写 gutter/scale DOM transform。selection effect 使用 `computeSelectionScrollTarget()`，单次调用 `scrollTo({ top, left })`。

- [ ] **Step 4: 删除旧内联 geometry 和双滚动逻辑**

移除 `trace-timeline.tsx` 中固定 `ScaleWidth`、内联 `startOffset/width` 与独立 gutter scroll container。保留组件文件名作为正式入口。

- [ ] **Step 5: 运行 Timeline 与 interaction tests**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/trace-timeline.test.tsx frontend/app/observability/observability-interactions.test.tsx frontend/app/observability/observability-virtualization.test.tsx
```

Expected: PASS。

- [ ] **Step 6: 精确提交**

```bash
git add frontend/app/observability/trace-panel/trace-timeline.tsx frontend/app/observability/trace-panel/trace-context.tsx frontend/app/observability/trace-panel/trace-timeline.test.tsx frontend/app/observability/observability-interactions.test.tsx
git commit -m "feat: replace trace timeline workspace"
```

## Task 6：迁移 Detail Value 与 I/O Primitives

**Files:**
- Create: `frontend/app/observability/trace-panel/detail-value.ts`
- Create: `frontend/app/observability/trace-panel/detail-value.test.ts`
- Create: `frontend/app/observability/trace-panel/detail-primitives.tsx`
- Create: `frontend/app/observability/trace-panel/io-preview.tsx`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/IOPreview.tsx`
- Reference: `frontend/app/observability/observation-detail.tsx`

- [ ] **Step 1: 写 bounded preview 与完整 copy 失败测试**

```ts
it("bounds preview serialization without changing the copied value", () => {
    const value = { output: "x".repeat(20_000) };
    const preview = formatDetailPreview(value, { maxCharacters: 1_000 });
    expect(preview.text.length).toBeLessThanOrEqual(1_001);
    expect(preview.truncated).toBe(true);
    expect(serializeDetailValue(value)).toContain("x".repeat(20_000));
});
```

```tsx
it("reports clipboard failure", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<IOPreview label="Output" value={{ ok: true }} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy Output" }));
    expect(await screen.findByText("Copy failed")).toBeVisible();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/detail-value.test.ts frontend/app/observability/trace-panel/trace-panel-detail.test.tsx
```

Expected: FAIL，因为 primitives 尚不存在。

- [ ] **Step 3: 实现纯值格式化**

```ts
export function serializeDetailValue(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function formatDetailPreview(
    value: unknown,
    options: { maxCharacters: number }
): { text: string; truncated: boolean } {
    const serialized = serializeDetailValue(value);
    if (serialized.length <= options.maxCharacters) {
        return { text: serialized, truncated: false };
    }
    return { text: `${serialized.slice(0, options.maxCharacters)}…`, truncated: true };
}
```

- [ ] **Step 4: 迁移 Detail primitives 与 IOPreview**

`IOPreview` 必须：

- 空值不渲染 section。
- Preview 使用 bounded text。
- Copy 使用 `serializeDetailValue(value)` 的完整结果。
- Copy promise 以 operation token 防止切换 selection 后旧结果覆盖新状态。
- 不引入 worker、media、comments 或 JSON beta preference。

- [ ] **Step 5: 运行 primitive tests**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/detail-value.test.ts frontend/app/observability/trace-panel/trace-panel-detail.test.tsx
```

Expected: PASS。

- [ ] **Step 6: 精确提交**

```bash
git add frontend/app/observability/trace-panel/detail-value.ts frontend/app/observability/trace-panel/detail-value.test.ts frontend/app/observability/trace-panel/detail-primitives.tsx frontend/app/observability/trace-panel/io-preview.tsx frontend/app/observability/trace-panel/trace-panel-detail.test.tsx
git commit -m "feat: migrate trace detail primitives"
```

## Task 7：迁移 Trace 与 Observation Detail Views

**Files:**
- Create: `frontend/app/observability/trace-panel/trace-detail-view.tsx`
- Create: `frontend/app/observability/trace-panel/observation-detail-view.tsx`
- Create: `frontend/app/observability/trace-panel/trace-panel-detail.tsx`
- Modify: `frontend/app/observability/trace-panel/trace-panel-detail.test.tsx`
- Delete: `frontend/app/observability/trace-panel/trace-detail-panel.tsx`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/_layout/TracePanelDetail.tsx`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/TraceDetailView/TraceDetailView.tsx`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/ObservationDetailView/ObservationDetailView.tsx`

- [ ] **Step 1: 写 Detail 分发、Tabs 与 section visibility 失败测试**

```tsx
it("shows trace detail when selection is null or stale", () => {
    const { rerender } = render(<DetailHarness selectedNodeId={null} />);
    expect(screen.getByRole("heading", { name: "agent_run" })).toBeVisible();

    rerender(<DetailHarness selectedNodeId="missing-observation" />);
    expect(screen.getByRole("heading", { name: "agent_run" })).toBeVisible();
});

it("shows only observation sections backed by real data", async () => {
    render(<DetailHarness selectedNodeId="generation-1" />);
    expect(screen.getByRole("heading", { name: "assistant_response" })).toBeVisible();
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
    expect(screen.getByText("Output")).toBeVisible();
    expect(screen.getByText("Usage")).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Scores" })).not.toBeInTheDocument();
});

it("switches between Preview and JSON", async () => {
    render(<DetailHarness selectedNodeId="generation-1" />);
    await userEvent.click(screen.getByRole("tab", { name: "JSON" }));
    expect(screen.getByText(/"id": "generation-1"/)).toBeVisible();
});
```

- [ ] **Step 2: 运行 tests 并确认当前简化 Detail 不满足 contract**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/trace-panel-detail.test.tsx
```

Expected: FAIL；当前 `TraceDetailPanel` 没有上游分发和完整 Tabs contract。

- [ ] **Step 3: 迁移 `TraceDetailView`**

保持结构：

```tsx
<DetailView>
    <TraceDetailHeader trace={trace} metrics={metrics} />
    <DetailTabs value={tab} onValueChange={setTab} tabs={["preview", "json"]} />
    {tab === "preview" ? (
        <>
            <IOPreview label="Input" value={trace.input} />
            <IOPreview label="Output" value={trace.output} />
            <IOPreview label="Metadata" value={trace.metadata} />
        </>
    ) : (
        <JsonView value={trace} />
    )}
</DetailView>
```

Header 只显示 status、duration、observation count、tokens 和 cost。

- [ ] **Step 4: 迁移 `ObservationDetailView`**

Header 只显示 type、name、level/status、latency、TTFT、model、tokens 和 cost。Preview sections 条件渲染 input/output/metadata/usage/cost，不从 trace 补 generation input。

- [ ] **Step 5: 迁移 `TracePanelDetail` 分发并删除旧文件**

```tsx
export function TracePanelDetail() {
    const { detail, observationMap } = useTraceData();
    const { selectedNodeId } = useTraceSelection();
    const observation = selectedNodeId == null ? null : observationMap.get(selectedNodeId);

    return observation == null ? (
        <TraceDetailView detail={detail} />
    ) : (
        <ObservationDetailView trace={detail.trace} observation={observation} />
    );
}
```

- [ ] **Step 6: 运行 Detail 与旧 Observation regression tests**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/trace-panel-detail.test.tsx frontend/app/observability/observability-panel.test.tsx frontend/app/observability/observability-interactions.test.tsx
```

Expected: PASS。

- [ ] **Step 7: 精确提交**

```bash
git add frontend/app/observability/trace-panel/trace-detail-view.tsx frontend/app/observability/trace-panel/observation-detail-view.tsx frontend/app/observability/trace-panel/trace-panel-detail.tsx frontend/app/observability/trace-panel/trace-panel-detail.test.tsx frontend/app/observability/trace-panel/trace-detail-panel.tsx
git commit -m "feat: migrate trace panel detail views"
```

## Task 8：迁移 Desktop Layout

**Files:**
- Create: `frontend/app/observability/trace-panel/trace-layout-desktop.tsx`
- Create: `frontend/app/observability/trace-panel/trace-panel-navigation-layout-desktop.tsx`
- Create: `frontend/app/observability/trace-panel/trace-panel-layout.test.tsx`
- Modify: `frontend/app/observability/trace-panel/trace-panel.tsx`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/_layout/TraceLayoutDesktop.tsx`
- Reference: `/tmp/langfuse-src/web/src/components/trace/components/_layout/TracePanelNavigationLayoutDesktop.tsx`

- [ ] **Step 1: 写 resize/collapse/窄宽失败测试**

```tsx
it("collapses and restores navigation, detail, and graph panels", async () => {
    render(<TracePanel detail={detail} />);
    await userEvent.click(screen.getByRole("button", { name: "Collapse graph" }));
    expect(screen.queryByTestId("trace-graph-content")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expand graph" }));
    expect(screen.getByTestId("trace-graph-content")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Collapse detail" }));
    expect(screen.getByRole("button", { name: "Expand detail" })).toBeVisible();
});

it("keeps both desktop panels addressable in a narrow host", () => {
    render(<NarrowTracePanel width={540} />);
    expect(screen.getByLabelText("Trace navigation panel")).toBeInTheDocument();
    expect(screen.getByLabelText("Trace detail panel")).toBeInTheDocument();
    expect(screen.getByTestId("trace-layout-scroll")).toHaveClass("overflow-x-auto");
});
```

- [ ] **Step 2: 运行 tests 并确认当前 inline layout 失败**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/trace-panel-layout.test.tsx
```

Expected: FAIL，因为当前 layout 没有 navigation/detail rails 和完整 collapse contract。

- [ ] **Step 3: 迁移 `TraceLayoutDesktop`**

保留 compound composition：

```tsx
<TraceLayoutDesktop>
    <TraceLayoutDesktop.NavigationPanel>{navigation}</TraceLayoutDesktop.NavigationPanel>
    <TraceLayoutDesktop.ResizeHandle />
    <TraceLayoutDesktop.DetailPanel>{detail}</TraceLayoutDesktop.DetailPanel>
</TraceLayoutDesktop>
```

Navigation min width 260px，Detail min width 360px。窄宿主外层使用 `min-w-[621px] overflow-x-auto`，不依赖 solver 自动折叠。

- [ ] **Step 4: 迁移 Navigation/Graph vertical layout**

Graph collapse 使用 React state 条件 composition，不调用 panel imperative `collapse()/expand()`：

```tsx
return graphCollapsed ? (
    <>
        <div className="min-h-0 flex-1">{children}</div>
        <GraphRail onExpand={expandGraph} />
    </>
) : (
    <PanelGroup direction="vertical">
        <Panel>{children}</Panel>
        <PanelResizeHandle />
        <Panel><GraphPanel onCollapse={collapseGraph} /></Panel>
    </PanelGroup>
);
```

- [ ] **Step 5: 重新组合 `TracePanel`**

`trace-panel.tsx` 只保留 providers 和上游式 composition，不再内联 panel 实现。Detail import 改为 `TracePanelDetail`。

- [ ] **Step 6: 运行 layout 与 magnified integration tests**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel/trace-panel-layout.test.tsx frontend/app/observability/observability-panel.test.tsx frontend/app/observability/observability-virtualization.test.tsx
```

Expected: PASS。

- [ ] **Step 7: 精确提交**

```bash
git add frontend/app/observability/trace-panel/trace-layout-desktop.tsx frontend/app/observability/trace-panel/trace-panel-navigation-layout-desktop.tsx frontend/app/observability/trace-panel/trace-panel-layout.test.tsx frontend/app/observability/trace-panel/trace-panel.tsx
git commit -m "feat: migrate trace panel desktop layout"
```

## Task 9：源码映射、许可与清理

**Files:**
- Modify: `NOTICE`
- Modify: `NOTICES.md`
- Modify: `frontend/app/observability/trace-panel/LICENSE.langfuse`
- Modify: `docs/specs/2026-07-20-trace-panel-source-migration-design.md`
- Test: `electron-builder.config.test.ts`

- [ ] **Step 1: 写迁移产物与打包许可检查**

在 `electron-builder.config.test.ts` 中断言：

```ts
expect(packagedFiles).toEqual(
    expect.arrayContaining([
        "NOTICE",
        "NOTICES.md",
        "frontend/app/observability/trace-panel/LICENSE.langfuse",
    ])
);
```

- [ ] **Step 2: 运行测试确认许可文件映射**

Run:

```bash
npx vitest run electron-builder.config.test.ts
```

Expected: PASS；若失败，先修正打包白名单再继续。

- [ ] **Step 3: 检查禁止残留**

Run:

```bash
npx prettier --check frontend/app/observability/trace-panel
```

Run:

```bash
git diff --check
```

使用项目 Grep 工具检查以下 patterns，期望 trace-panel production files 无匹配：

```text
trace-panel/langfuse/
@/src
LangfuseTrace
LangfuseObservation
Adapter
shim
useQueryParam
PostHog
Comment
Dataset
Annotation
```

许可文本和设计文档中用于描述删除范围的单词不计入 production 残留。

- [ ] **Step 4: 更新 attribution 和设计状态**

`NOTICE` / `NOTICES.md` 明确 Timeline、Detail、Desktop Layout 源自 Langfuse MIT。设计文档状态改为“已实施，等待最终验证”，不得声称未运行的测试已通过。

- [ ] **Step 5: 精确提交**

```bash
git add NOTICE NOTICES.md frontend/app/observability/trace-panel/LICENSE.langfuse docs/specs/2026-07-20-trace-panel-source-migration-design.md electron-builder.config.test.ts
git commit -m "docs: record trace panel source migration"
```

## Task 10：最终验证

**Files:**
- Verify only; fix only files responsible for any observed failure.

- [ ] **Step 1: 运行 Trace Panel 与 Observability tests**

Run:

```bash
npx vitest run frontend/app/observability/trace-panel frontend/app/observability
```

Expected: all test files pass，0 failures。

- [ ] **Step 2: 运行 main observability regression tests**

Run:

```bash
npx vitest run emain/agent/observability/trace-builder.test.ts emain/agent-observability-ipc.test.ts emain/agent/observability/trace-store-rows.test.ts electron-builder.config.test.ts
```

Expected: all tests pass，0 failures。

- [ ] **Step 3: 运行类型契约**

Run:

```bash
npm run test:observability-types
```

Expected: `Type Errors no errors`。

- [ ] **Step 4: 运行格式与 diff 检查**

Run:

```bash
npx prettier --check frontend/app/observability/trace-panel docs/specs/2026-07-20-trace-panel-source-migration-design.md
```

Expected: all matched files use Prettier code style。

Run:

```bash
git diff --check
```

Expected: exit 0。

- [ ] **Step 5: 运行 development build**

Run:

```bash
npm run build:dev
```

Expected: exit 0。允许记录仓库既有 Vite dynamic import、Browserslist、missing `sharp` optimizer warnings，但不得忽略新增 compile/runtime errors。

- [ ] **Step 6: 运行真实 UI 验收**

在可启动环境中打开 magnified Observability Panel，使用至少包含两个 turn、一个 generation、一个成功 tool、一个失败 tool 的 trace，验证：

```text
Tree: agent -> turn -> generation/tool hierarchy
Timeline: hierarchy、bars、scroll sync、selection reveal
Detail: trace/observation dispatch、Preview/JSON、copy feedback
Layout: horizontal resize、graph vertical resize、three collapse/restore paths
Narrow host: navigation 与 detail 均可访问
```

若 Electron sandbox 阻止启动，记录精确错误和未完成的视觉验收，不得用单测替代并声称已完成视觉验证。

- [ ] **Step 7: 检查最终变更范围**

Run:

```bash
git status --short
```

确认未 stage 或提交进入本计划之外的历史 worktree 改动。计划任务产生的所有 commits 应只包含其精确文件列表。

