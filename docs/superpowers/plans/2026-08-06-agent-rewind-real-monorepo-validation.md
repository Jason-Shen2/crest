# Agent Rewind 真实 Monorepo 验证与收益报告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** 用 Crest 生产配置下的真实 rewind engine 验证本机大型 monorepo 的 cold baseline、增量捕获、Undo/Redo、并发 Session 和极端失败边界，并生成一份基于实测结果的中文单页 HTML。

**Architecture:** 新增一个只面向验证的 CLI。它先对原仓库做只读 capture，再只对 baseline 成功的仓库创建 `/private/tmp` 隔离 clone，并通过现有 `WorkspaceTrackerRegistry`、`WorkspaceSnapshotStore`、`SqliteSessionRepo` 和 `WorkspaceRewindEngine` 运行真实工作流。每个仓库的结果原子写入 JSON；独立 renderer 只消费该 JSON 生成静态 HTML，支持量级由证据推导，不由页面硬编码。

**Tech Stack:** TypeScript、Node.js、Vitest、现有 workspace-rewind engine、SQLite session repo、Git CLI、standalone HTML/CSS/vanilla JS。

---

## 实施约束

- 原仓库 `/Users/bytedance/Documents/{fe-poi-mono,fe_ls_tobias_goods_mono,lina-mono,fe-canal-mono}` 永远只读。
- 所有 mutation、Undo、Redo、rename、delete、binary、symlink、drift 只在 `/private/tmp` 的明确子目录执行。
- 不访问网络、不安装依赖、不运行目标仓库业务脚本；clone 设置 `GIT_LFS_SKIP_SMUDGE=1`、`--no-tags`、`--no-recurse-submodules`。
- 不调整 `WorkspaceCheckpointLimits`、生产 timeout、entry budget、worker 上限或 ignore 规则。
- 单仓库串行执行；临时数据超过 15 GB、单阶段超过 15 分钟或磁盘可用空间不足 30 GB 时 fail closed。
- “支持 N files”只有在 cold baseline 和真实 Undo/Redo 都成功时成立；算法测试或 baseline-unavailable 不计入产品上限。
- `docs/superpowers/**` 被 Git ignore，提交计划、JSON 和 HTML 时使用精确路径 `git add -f <path>`，不得 force-add 整个目录。

### Task 1: 定义稳定的结果合同和判定规则

**Files:**
- Create: `scripts/agent-rewind-real-workspace/contracts.ts`
- Create: `scripts/agent-rewind-real-workspace/contracts.test.ts`

**Step 1: Write the failing tests**

覆盖以下行为：

```ts
it("does not call a baseline-only repository supported", () => {
    const result = makeRepositoryResult({ cold: "completed", undo: "baseline-unavailable" });
    expect(classifyRepositorySupport(result)).toBe("baseline-only");
});

it("requires cold capture, undo, redo, exact bytes, and clean git", () => {
    const result = makeCompletedRepositoryResult();
    expect(classifyRepositorySupport(result)).toBe("end-to-end-supported");
});

it("preserves timeout and budget as different fail-closed outcomes", () => {
    expect(normalizeCaptureFailure(captureTimeoutError)).toMatchObject({ outcome: "capture-timeout" });
    expect(normalizeCaptureFailure(captureBudgetError)).toMatchObject({ outcome: "capture-budget" });
});
```

结果 schema 至少包含：环境、仓库输入 fingerprint、scope 统计、cold/warm capture 指标、场景状态、耗时、资源峰值、cleanup/source-integrity 结果、失败码与人类可读说明。所有 JSON field 使用项目要求的小写无下划线命名。

**Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/agent-rewind-real-workspace/contracts.test.ts`

Expected: FAIL because the contract and classifiers do not exist.

**Step 3: Write minimal implementation**

实现版本化 `RealWorkspaceValidationResultV1`、`RepositoryValidationResultV1`、capture/scenario outcome union，以及纯函数：

- `classifyRepositorySupport()`
- `computeVerifiedProductCeiling()`
- `normalizeCaptureFailure()`
- `validateResultDocument()`

不要让 renderer 自己推断业务规则。

**Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/agent-rewind-real-workspace/contracts.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/agent-rewind-real-workspace/contracts.ts scripts/agent-rewind-real-workspace/contracts.test.ts
git commit -m "test(agent): define real workspace validation contract"
```

### Task 2: 实现原仓库只读保护与隔离 clone 生命周期

**Files:**
- Create: `scripts/agent-rewind-real-workspace/workspace-fixture.ts`
- Create: `scripts/agent-rewind-real-workspace/workspace-fixture.test.ts`

**Step 1: Write the failing tests**

使用测试临时目录创建小型 Git repo，验证：

- `fingerprintSourceWorkspace()` 对 `HEAD` 和 `git status --porcelain=v1 -z --untracked-files=all` 取稳定 fingerprint；
- `assertSourceWorkspaceUnchanged()` 能发现 tracked/untracked 状态变化；
- clone 目标必须是所分配 temp root 的后代，且不能等于 source；
- clone 命令禁止网络/LFS/submodule recursion，并只接受明确绝对路径；
- callback 抛错时也释放 watcher、session、snapshot store 并删除 clone；多个 cleanup 错误保留为 `AggregateError`；
- 磁盘不足、临时数据超 15 GB、阶段超 15 分钟返回结构化 safety stop。

**Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/agent-rewind-real-workspace/workspace-fixture.test.ts`

Expected: FAIL because fixture lifecycle is missing.

**Step 3: Write minimal implementation**

实现：

- `fingerprintSourceWorkspace()` / `assertSourceWorkspaceUnchanged()`；
- `makeIsolatedWorkspaceClone()`，内部使用 `mkdtemp()` 与 `spawn()` 参数数组，不使用 shell 拼接；
- `withValidationResources()`，用 `try/finally` 逆序清理；
- `ValidationSafetyGuard`，检查 `statfs`、阶段 deadline 和 temp tree 大小。

真实 source 绝不作为 cleanup target；删除前必须再次确认 target 位于 fixture temp root 内。

**Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/agent-rewind-real-workspace/workspace-fixture.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/agent-rewind-real-workspace/workspace-fixture.ts scripts/agent-rewind-real-workspace/workspace-fixture.test.ts
git commit -m "test(agent): isolate real workspace validation fixtures"
```

### Task 3: 实现生产配置下的只读 cold/warm capture 验证器

**Files:**
- Create: `scripts/agent-rewind-real-workspace/capture-validator.ts`
- Create: `scripts/agent-rewind-real-workspace/capture-validator.test.ts`

**Step 1: Write the failing tests**

在小型 fixture repo 中验证：

- cold capture 通过 `resolveCanonicalWorkspaceIdentity()`、真实 scope discovery、`WorkspaceTrackerRegistry.acquire()` 和真实 snapshot store 完成；
- snapshot data root 位于 fixture temp root，不写 source；
- warm no-change 返回相同 ref，`enumeratedentries=0`、`workerpeak=0`；
- 一处外部写入后只报告 dirty path 工作，而不是重新创建 tracker；
- 1/2/4 leases 共用同一个 workspace tracker，baseline 和 enumeration 不按 Session 倍增；
- `WorkspaceSnapshotStoreError` 的 `capture_timeout` / `capture_budget` 被原样记录，禁止自动扩大 budget 重试；
- 所有 lease 和 registry 都在成功、失败路径释放。

**Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/agent-rewind-real-workspace/capture-validator.test.ts`

Expected: FAIL because validator and observations are missing.

**Step 3: Write minimal implementation**

复用 `scripts/benchmark-agent-rewind-snapshots.ts` 的 metrics hook 和错误归类方式，但不复制 snapshot 算法。导出：

- `captureReadOnlyWorkspaceBaseline()`
- `captureWarmWorkspaceState()`
- `validateSharedTrackerSessions()`

记录 scope eligible/excluded/ignored/nested 数量、duration、ref、enumeration、worker peak、new objects、newly hashed bytes 和 store bytes。

**Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/agent-rewind-real-workspace/capture-validator.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/agent-rewind-real-workspace/capture-validator.ts scripts/agent-rewind-real-workspace/capture-validator.test.ts
git commit -m "test(agent): validate production workspace capture"
```

### Task 4: 用真实 rewind engine 验证精确 Undo/Redo

**Files:**
- Create: `scripts/agent-rewind-real-workspace/restore-validator.ts`
- Create: `scripts/agent-rewind-real-workspace/restore-validator.test.ts`

**Step 1: Write the failing tests**

基于小型隔离 repo，使用真实 `SqliteSessionRepo`、`WorkspaceSnapshotStore`、`WorkspaceRecovery`、`RewindConfirmationRegistry` 和 `WorkspaceRewindEngine`，覆盖：

1. pre-turn capture；
2. append user message；
3. 修改 tracked text；
4. terminal capture + `WorkspaceCheckpointV1`；
5. preview turn Undo 显示精确 path/diff；
6. apply Undo 后 bytes 等于 before；
7. preview/apply Redo 后 bytes 等于 after；
8. 最终恢复 before 并确认 `git diff --exit-code`；
9. apply 前外部 drift 必须得到 conflict，force 必须要求新的 confirmation token，force 后 bytes 正确。

测试同时断言 Undo/Redo 不调用 `moveTo()`，消息树不变化。

**Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/agent-rewind-real-workspace/restore-validator.test.ts`

Expected: FAIL because the real workflow adapter is missing.

**Step 3: Write minimal implementation**

从 `packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts` 提取同样的生产对象装配方式到验证脚本，不修改 production engine。实现：

- `createValidationSessionRuntime()`
- `recordValidationTurnCheckpoint()`
- `validateTextUndoRedo()`
- `validateDriftAndForce()`

每一步保存 preview path/state、confirmation token 使用结果和 SHA-256 byte digest，禁止只比较文件数量。

**Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/agent-rewind-real-workspace/restore-validator.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/agent-rewind-real-workspace/restore-validator.ts scripts/agent-rewind-real-workspace/restore-validator.test.ts
git commit -m "test(agent): exercise real rewind engine on workspace clones"
```

### Task 5: 增加文件类型、批量 dirty path 和失效边界场景

**Files:**
- Modify: `scripts/agent-rewind-real-workspace/restore-validator.ts`
- Modify: `scripts/agent-rewind-real-workspace/restore-validator.test.ts`
- Create: `scripts/agent-rewind-real-workspace/extreme-validator.ts`
- Create: `scripts/agent-rewind-real-workspace/extreme-validator.test.ts`

**Step 1: Write the failing tests**

覆盖：

- rename、delete、binary、symlink 的 preview state 与最终 bytes/target；
- 从不同目录选择 100 个 tracked text files，capture worker peak 不超过生产上限 8，Undo/Redo 后逐文件 digest 正确；
- same-size rewrite 不被漏掉；
- anchored read 期间替换文件得到等价 snapshot 或 unavailable；
- dirty directory rename/delete；
- ignored file delete 不污染 checkpoint；
- nested repository boundary 不进入 restore plan；
- cursor gap、scope invalidation 触发 reconcile 或 unavailable，绝不产生 available empty checkpoint；
- 100 dirty paths + 4 leases 只执行一次共享 capture 工作。

测试 fixture 小于 200 个文件，注入 hook 模拟 race/gap，不依赖机器速度。

**Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/agent-rewind-real-workspace/restore-validator.test.ts scripts/agent-rewind-real-workspace/extreme-validator.test.ts`

Expected: FAIL on missing scenarios.

**Step 3: Write minimal implementation**

新增场景函数并统一返回 `ScenarioObservationV1`。文件候选只从 Git tracked files 中确定性选择；若真实仓库缺少 symlink/binary 候选，在隔离 clone 中创建受控 fixture 并明确标记 `fixtureadded=true`。

**Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/agent-rewind-real-workspace/restore-validator.test.ts scripts/agent-rewind-real-workspace/extreme-validator.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/agent-rewind-real-workspace/restore-validator.ts scripts/agent-rewind-real-workspace/restore-validator.test.ts scripts/agent-rewind-real-workspace/extreme-validator.ts scripts/agent-rewind-real-workspace/extreme-validator.test.ts
git commit -m "test(agent): cover rewind workspace extremes"
```

### Task 6: 实现可恢复的真实仓库验证 CLI

**Files:**
- Create: `scripts/agent-rewind-real-workspace/matrix.ts`
- Create: `scripts/agent-rewind-real-workspace/matrix.test.ts`
- Create: `scripts/validate-agent-rewind-real-workspaces.ts`
- Create: `scripts/validate-agent-rewind-real-workspaces.test.ts`
- Modify: `package.json`

**Step 1: Write the failing tests**

验证 CLI：

- 必须显式传入 `name=/absolute/path`，拒绝相对路径、重复名称和 source/temporary path 重叠；
- 仓库串行执行；原仓库只运行 read-only capture；只有 baseline completed 才进入 isolated workflow；
- `--readonlyonly fe-canal-mono` 永远不 clone 该仓库；
- 每完成一个 repo 就通过同目录 temp file + rename 原子更新 JSON，进程中断后保留已完成结果；
- safety stop、capture timeout/budget、场景失败只终止当前 repo，不伪造成功；
- source fingerprint before/after 不一致使该 repo 总结失败；
- SIGINT 触发 cleanup 并以非零退出。

**Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/agent-rewind-real-workspace/matrix.test.ts scripts/validate-agent-rewind-real-workspaces.test.ts`

Expected: FAIL because orchestration and CLI are missing.

**Step 3: Write minimal implementation**

添加 package scripts：

```json
"validate:agent-rewind-real-workspaces": "tsx scripts/validate-agent-rewind-real-workspaces.ts"
```

CLI 只负责编排现有验证器，不实现第二套 capture/restore 逻辑。默认顺序按规模从小到大；所有 child process 使用参数数组并继承离线环境。

**Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/agent-rewind-real-workspace/matrix.test.ts scripts/validate-agent-rewind-real-workspaces.test.ts`

Expected: PASS.

**Step 5: Run the complete validation harness test suite**

Run: `npx vitest run scripts/agent-rewind-real-workspace/*.test.ts scripts/validate-agent-rewind-real-workspaces.test.ts`

Expected: PASS with no writes outside test temp roots.

**Step 6: Commit**

```bash
git add package.json scripts/agent-rewind-real-workspace/matrix.ts scripts/agent-rewind-real-workspace/matrix.test.ts scripts/validate-agent-rewind-real-workspaces.ts scripts/validate-agent-rewind-real-workspaces.test.ts
git commit -m "test(agent): add real monorepo rewind validator"
```

### Task 7: 在 Documents 的真实 monorepo 上执行生产验证

**Files:**
- Create: `docs/superpowers/results/2026-08-06-agent-rewind-real-monorepo-validation.json`
- Modify: `docs/superpowers/specs/2026-08-06-agent-rewind-real-monorepo-validation-design.md`

**Step 1: Record source state before execution**

Run:

```bash
git -C /Users/bytedance/Documents/fe-poi-mono status --porcelain=v1 --untracked-files=all
git -C /Users/bytedance/Documents/fe_ls_tobias_goods_mono status --porcelain=v1 --untracked-files=all
git -C /Users/bytedance/Documents/lina-mono status --porcelain=v1 --untracked-files=all
git -C /Users/bytedance/Documents/fe-canal-mono status --porcelain=v1 --untracked-files=all
```

Expected: capture exact initial state; do not require repositories to be clean, only unchanged after validation.

**Step 2: Run the real matrix sequentially**

Run:

```bash
npm run validate:agent-rewind-real-workspaces -- \
  --workspace fe-poi-mono=/Users/bytedance/Documents/fe-poi-mono \
  --workspace fe_ls_tobias_goods_mono=/Users/bytedance/Documents/fe_ls_tobias_goods_mono \
  --workspace lina-mono=/Users/bytedance/Documents/lina-mono \
  --workspace fe-canal-mono=/Users/bytedance/Documents/fe-canal-mono \
  --readonlyonly fe-canal-mono \
  --output docs/superpowers/results/2026-08-06-agent-rewind-real-monorepo-validation.json
```

Expected: each repository produces a completed or explicit fail-closed row; no implicit retry with expanded limits. The command may take minutes and should emit per-stage progress at least once per minute.

**Step 3: Verify evidence and safety invariants**

Run:

```bash
npx tsx scripts/validate-agent-rewind-real-workspaces.ts --verify-result docs/superpowers/results/2026-08-06-agent-rewind-real-monorepo-validation.json
git -C /Users/bytedance/Documents/fe-poi-mono status --porcelain=v1 --untracked-files=all
git -C /Users/bytedance/Documents/fe_ls_tobias_goods_mono status --porcelain=v1 --untracked-files=all
git -C /Users/bytedance/Documents/lina-mono status --porcelain=v1 --untracked-files=all
git -C /Users/bytedance/Documents/fe-canal-mono status --porcelain=v1 --untracked-files=all
```

Expected: JSON schema/invariants pass; all four source fingerprints match Step 1; recorded temp roots no longer exist; no repository is promoted to supported without successful exact Undo/Redo.

**Step 4: Append measured conclusions to the design document**

增加“实测结果”章节，只陈述 JSON 中已有证据：最高 cold baseline、最高 exact Undo/Redo、各失败原因、steady-state entry reduction、cleanup/source-integrity。不得手工修饰失败状态。

**Step 5: Commit**

```bash
git add -f docs/superpowers/results/2026-08-06-agent-rewind-real-monorepo-validation.json docs/superpowers/specs/2026-08-06-agent-rewind-real-monorepo-validation-design.md
git commit -m "docs(agent): record real monorepo rewind results"
```

### Task 8: 从 JSON 生成中文收益 HTML

**Files:**
- Create: `scripts/render-agent-rewind-benefits.ts`
- Create: `scripts/render-agent-rewind-benefits.test.ts`
- Create: `docs/superpowers/reports/2026-08-06-agent-rewind-optimization-benefits.html`
- Modify: `package.json`

**Step 1: Write the failing tests**

用固定 JSON fixture 验证：

- HTML 包含 `summary`、`scan-model`、`session-example`、`real-repositories`、`capacity-ladder`、`extreme-evidence`、`conclusion` 七个 section；
- Hero 的“已验证产品上限”来自 `computeVerifiedProductCeiling()`；
- baseline-only/timeout/budget 仓库不会显示为 supported；
- no-change 为 0 entries 时显示“全仓 N 次访问 → 0 次访问”和实测延迟，不显示“无限倍”；
- 50k/200k 合成结果只显示为历史失败边界，不出现“已支持 200k”；
- 表格包含四个真实仓库及其 cold、warm、Undo/Redo、100 dirty、4 Session、drift、source/cleanup 状态；
- 生成结果无外部 URL、外部字体或运行时 fetch；嵌入 JSON 转义 `<`，不能闭合 script；
- 键盘操作、focus visible、移动端和 reduced-motion CSS 存在。

**Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/render-agent-rewind-benefits.test.ts`

Expected: FAIL because renderer is missing.

**Step 3: Write minimal implementation**

添加 package script：

```json
"render:agent-rewind-benefits": "tsx scripts/render-agent-rewind-benefits.ts"
```

视觉按设计文档的“工程测量台”实现：graphite 背景、单一 workspace entry matrix 签名、completed/dirty/failure 三种状态色，不使用通用 KPI 卡片堆叠。交互仅用于切换无改动/1 文件/100 文件/4 Sessions，核心结论无 JavaScript 也可读。

10k/4 Session 示例必须明确标注为算法工作量模型：旧机制每 turn 两个 boundary × 四个 Session 的重复全仓访问，对比共享 tracker 的 0/1/100 dirty path；不能伪装成真实耗时。

**Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/render-agent-rewind-benefits.test.ts`

Expected: PASS.

**Step 5: Generate the final standalone HTML**

Run:

```bash
npm run render:agent-rewind-benefits -- \
  --input docs/superpowers/results/2026-08-06-agent-rewind-real-monorepo-validation.json \
  --output docs/superpowers/reports/2026-08-06-agent-rewind-optimization-benefits.html
```

Expected: one standalone HTML file with no external asset dependency.

**Step 6: Inspect desktop and mobile rendering**

Open the local HTML in the in-app browser. Check 1440px and 390px widths, keyboard tab order, long repository/error text wrapping, no horizontal overflow, and reduced-motion behavior. Fix the renderer, not the generated HTML, then regenerate.

**Step 7: Commit**

```bash
git add package.json scripts/render-agent-rewind-benefits.ts scripts/render-agent-rewind-benefits.test.ts
git add -f docs/superpowers/reports/2026-08-06-agent-rewind-optimization-benefits.html
git commit -m "docs(agent): visualize measured rewind scalability"
```

### Task 9: 全量回归、独立审阅和最终证据

**Files:**
- Modify only if failures reveal a real issue in the new validation/report code.

**Step 1: Run targeted validation and existing rewind regression tests**

Run:

```bash
npx vitest run \
  scripts/agent-rewind-real-workspace/*.test.ts \
  scripts/validate-agent-rewind-real-workspaces.test.ts \
  scripts/render-agent-rewind-benefits.test.ts \
  scripts/benchmark-agent-rewind-snapshots.test.ts \
  packages/coding-agent/workspace-rewind/workspace-snapshot-tracker.test.ts \
  packages/coding-agent/workspace-rewind/workspace-tracker-registry.test.ts \
  packages/coding-agent/workspace-rewind/rewind-engine.integration.test.ts \
  packages/coding-agent/workspace-rewind/multi-session.integration.test.ts
```

Expected: PASS.

**Step 2: Build Crest**

Run: `npm run build:dev`

Expected: exit 0.

**Step 3: Re-verify generated artifacts**

Run:

```bash
npx tsx scripts/validate-agent-rewind-real-workspaces.ts --verify-result docs/superpowers/results/2026-08-06-agent-rewind-real-monorepo-validation.json
npm run render:agent-rewind-benefits -- --input docs/superpowers/results/2026-08-06-agent-rewind-real-monorepo-validation.json --output /private/tmp/agent-rewind-benefits-regenerated.html
cmp /private/tmp/agent-rewind-benefits-regenerated.html docs/superpowers/reports/2026-08-06-agent-rewind-optimization-benefits.html
```

Expected: schema verification succeeds and generated HTML is deterministic.

**Step 4: Review for safety and claims**

审阅以下问题：

- 是否存在任何写入原 Documents repo 的代码路径；
- cleanup 是否在每个异常路径执行；
- Session 数是否错误地扩大工作量；
- timeout/budget 是否被吞掉或自动扩大限制；
- HTML 是否把 baseline-only 或合成规模宣传为产品支持；
- JSON 与 HTML 的最高支持量级是否完全一致。

修复发现的问题后重复 Steps 1–3。

**Step 5: Confirm a clean feature branch**

Run: `git status --short --branch && git log --oneline -10`

Expected: no uncommitted changes; commits remain on `codex/agent-workspace-rewind`; do not merge to main unless the user asks again.
