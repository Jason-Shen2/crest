# Pi GUI Extension Maturity Design

Date: 2026-07-19

## Goal

Crest should support the Pi extension ecosystem as a mature extension mechanism, not as a display-only MVP. Existing Pi extensions should load without source changes, official Pi examples should be certifiable in CI, standard `pi-tui` components should render as mature native Crest GUI, and custom components should fall back to a high-quality terminal surface.

## Design Position

The extension trust model follows Pi: extensions are trusted local code installed or authored by the user. Crest does not need a marketplace-grade sandbox, signature system, or per-permission consent flow as the first maturity milestone.

The product goal is still higher than the current MVP:

- Extension lifecycle must be explicit and recoverable.
- Pi API compatibility must be measurable.
- GUI rendering must preserve behavior, not only visual shape.
- Terminal fallback must be a real interactive backend, not a plain `<pre>`.
- Developers must be able to inspect, reload, diagnose, and disable extensions.

## Current MVP State

The current implementation is an MVP+ technical proof. It proves that the main process can load extensions, invoke registered commands and hooks, serialize semantic UI nodes, send them through IPC, render them in React, and route basic widget events back to live components.

It does not yet prove mature compatibility with the Pi extension ecosystem.

## Runtime Gaps

Current runtime capabilities:

- Discovers project and global extensions.
- Loads TypeScript extensions through `jiti`.
- Registers commands, tools, flags, shortcuts, hooks, message renderers, and entry renderers.
- Wires extension hooks into `AgentHarness`.
- Provides a basic `ctx.ui` bridge.
- Sends extension UI requests through Electron IPC.

Maturity gaps:

- `/reload` clears caches but does not fully rebuild live runtimes, hooks, tools, renderers, widget targets, or sessions.
- There is no explicit `load -> activate -> bind -> run -> unbind -> deactivate -> dispose -> reload` state machine.
- Hook, command, renderer, and custom UI failures are not isolated per extension.
- Slow or broken extensions do not have default deadlines, output limits, failure counters, or quarantine behavior.
- Flags, persistent widgets, header/footer state, enabled state, and active tools do not have a clear persistence model.
- Live pane, headless command, and multi-pane behavior can observe different extension graphs.
- Accepted-but-inert APIs can mislead developers because registration may succeed without observable runtime support.
- API versioning, deprecation, and migration policy are not defined.

## Pi Compatibility Gaps

Current compatibility capabilities:

- The extension runtime loader aliases `@earendil-works/pi-tui` and selected subpaths to vendored `pi-gui`; the matching `tsconfig.json` paths are only a compile-time mirror for extension fixtures and that runtime loader surface, not a general app import contract.
- Supports a subset of Pi commands, tools, hooks, flags, renderers, and `ctx.ui`.
- Uses a vendored Pi TUI source tree and a Crest-specific walker.
- Supports fallback for unknown components.

Maturity gaps:

- There is no full Pi API compatibility matrix.
- There is no Pi official examples certification suite.
- There is no upstream contract snapshot for API shape or behavior.
- There is no clear status taxonomy for each API and component.
- There is no compatibility report when Pi upstream changes.
- Source compatibility is not yet equivalent to behavior compatibility.

## Semantic UI Gaps

Current semantic UI capabilities:

- Defines JSON-safe `WidgetNode` values.
- Serializes common Pi TUI components into widget nodes.
- Registers live root and child widget targets.
- Dispatches basic `select`, `change`, `submit`, `cancel`, and `key` events.
- Re-serializes roots after successful widget interactions.

Maturity gaps:

- The walker reads private component fields and relies on `constructor.name`.
- Widget node IDs are implicit fields attached to component instances.
- Events are loosely typed string values rather than component-specific contracts.
- Updates reserialize roots instead of using a scheduler, batching, or patches.
- Focus, layout, mount, unmount, dispose, stale events, and late events lack a formal lifecycle.
- Widget schema versioning and size limits are not defined.
- Custom UI `done`, host dismiss, cancel, and pending request races need explicit semantics.

## GUI Backend Gaps

Current GUI capabilities:

- Basic rendering exists for Text, Box, SelectList, SettingsList, Input, Markdown, Editor, Image, Loader, TruncatedText, RichTable, DiffView, Chart, and terminal fallback.
- SelectList and Input have basic pointer and form interaction.
- SettingsList routes selection, immediate value changes, activation, cancellation, and basic arrow-key events through native controls.
- Editor uses a textarea-backed GUI for editing, key dispatch, submit, cancel intent, and server-state resynchronization.
- Loader exposes visible state, while CancellableLoader exposes a native cancel control and aborted-state feedback.
- Markdown has initial semantic rendering.

Maturity gaps:

- SelectList does not fully implement arrow navigation, enter, escape, filtering, scrolling, focus, and selection change semantics.
- Input does not fully support selection, IME, composition, clipboard, Home/End, word movement, and terminal-style shortcuts.
- SettingsList still lacks certified search, submenu handoff, max-visible scrolling, and full layout parity; selection, value changes, and activation remain `partial` in the behavior matrix.
- Editor cancel remains an intent-only GUI event because the vendored Pi Editor has no supported cancel callback; cursor/selection, IME, and clipboard parity are also incomplete.
- Loader animation cadence and lifecycle still lack timer-backed certification; CancellableLoader cancellation itself is covered.
- Layout is approximate; `paddingx`, `paddingy`, `maxvisible`, width, scroll, and focus are not consistently honored.
- RichTable lacks mature keyboard navigation, selection, optional sorting, and virtualization.
- Chart schema supports more than the current renderer implements.
- Accessibility, focus rings, roles, keyboard-only operation, and screen reader behavior are not defined.

## Terminal Fallback Gaps

The current fallback renders `component.render(width)` lines into a simple visual surface. It is useful for debugging but not enough for compatibility.

A mature fallback must support:

- ANSI colors and styles.
- Cursor marker and cursor positioning.
- Wide characters, emoji, and combining characters.
- OSC hyperlinks.
- Resize.
- Ctrl, Alt, Meta, Home, End, Delete, PageUp, and PageDown.
- Paste, IME, and composition.
- Terminal selection.
- Optional mouse events.
- High-frequency update throttling.
- Shared focus and cancellation lifecycle with the semantic UI host.

## Productization Gaps

The extension mechanism needs developer-facing operations:

- `/extensions` command or extension management panel.
- Extension id, name, version, path, scope, status, commands, tools, hooks, flags, and errors.
- Enable, disable, reload, and open logs.
- Per-extension logs for load, runtime, hook, UI, and exec events.
- Manifest schema with `id`, `version`, `apiVersion`, `engines`, `capabilities`, and `entry`.
- Scaffold for Pi-compatible extensions.
- Developer warnings for inert or unsupported APIs.
- Compatibility report for Pi upstream and Crest API versions.

## Mature Target Architecture

### Pi Compatibility Core

Owns Pi-facing API semantics:

- Extension API type and call behavior.
- Hook fold, chain, and short-circuit semantics.
- Command, tool, flag, renderer, and provider registration.
- Pi upstream version tracking.
- Official examples certification.

It does not own React rendering.

### Extension Lifecycle Manager

Owns runtime lifecycle:

- Discovery, load, activate, deactivate, dispose, and reload.
- Workspace, session, pane, and headless scopes.
- Extension graph as the single source of truth.
- Error boundaries, deadlines, failure counters, and quarantine.
- Persistent flags, enabled state, active tools, and diagnostics.

### Semantic UI Host

Owns component semantics:

- Stable widget schema.
- Adapter registry.
- State snapshot and event dispatch.
- Focus model and layout context.
- Mount, update, unmount, dispose, stale event handling.
- Update scheduling and tree patching.
- Backend selection between GUI and terminal surface.

### Crest GUI Backend

Owns native GUI widgets:

- Mature React components for standard Pi TUI components.
- DOM focus and keyboard navigation.
- IME, clipboard, accessibility, and responsive layout.
- Markdown, editor, table, diff, chart, and status components.
- DOM interaction tests and visual behavior tests.

### Terminal Surface Backend

Owns custom component fallback:

- ANSI rendering.
- Keyboard, paste, IME, resize, and cursor behavior.
- Interactive custom component support.
- Shared lifecycle with the semantic UI host.

## Adapter Contract

The current reflection walker should be replaced by stable adapters.

```ts
interface PiGuiAdapter<TComponent> {
    kind: string;
    matches(component: Component): component is TComponent;
    snapshot(component: TComponent, context: SnapshotContext): WidgetNode;
    dispatch(component: TComponent, event: WidgetEvent, context: DispatchContext): DispatchResult;
    dispose?(component: TComponent): void;
}
```

Standard vendored components should expose stable snapshot or getter APIs. Crest adapters should use those APIs rather than private fields. Upstream field changes should fail type checks or contract tests instead of causing silent runtime drift.

## Compatibility Status Taxonomy

Every Pi API and Pi TUI component must be assigned one status:

- `native-gui`: Rendered by mature Crest GUI with behavior-equivalent callbacks.
- `terminal-surface`: Rendered through the high-quality terminal backend.
- `accepted-inert`: Accepted for source compatibility but intentionally inert, with dev warning.
- `unsupported`: Rejected or warned with actionable diagnostics.
- `not-applicable`: Pi feature does not apply to Crest.

Behavior-level requirements inside the component matrix must use one status:

- `covered`: A focused test already exercises the behavior.
- `partial`: A focused test covers the happy path, but Pi parity still has known gaps.
- `planned`: The behavior is required for M2/M3 parity but not implemented yet.
- `not-applicable`: The behavior does not apply to the component.

Component certification status summarizes whether the behavior matrix is ready to count as certified:

- `passing`: All listed behavior requirements are covered by focused tests.
- `planned`: At least one listed behavior is partial or planned.
- `unsupported`: The component is intentionally outside the current certification scope.

## Behavior-Level Component Matrix

`PiTuiComponentCompatibilityMatrix` is the source of truth for component parity. Each standard component must list behavior requirements, not only an overall compatibility status.

| Component | Certification | Required behavior groups |
| --- | --- | --- |
| Text | `passing` | Text snapshot |
| Box | `planned` | Child layout |
| Spacer | `passing` | Spacing |
| SelectList | `planned` | Snapshot items; pointer select; keyboard navigation; filtering; scrolling; focus |
| SettingsList | `planned` | Snapshot values; selection; immediate value change; activate; cancel; search/submenu/layout parity |
| Input | `planned` | Value snapshot; text editing; submit; cancel; selection, IME, clipboard |
| Markdown | `planned` | Source rendering |
| Editor | `planned` | Content snapshot; text editing; cursor and selection; submit; cancel |
| Image | `passing` | Image metadata |
| Loader / CancellableLoader | `planned` | State snapshot; animation cadence; cancel |
| TruncatedText | `passing` | Truncation |
| Custom Component | `unsupported` | Terminal surface fallback |

This matrix is intentionally behavior-oriented: a component can have `native-gui` source/snapshot support while individual behaviors remain `partial` or `planned`. The optional `plannedBehavior` field lists requirement ids that still block a `passing` certification status.

## Roadmap

### Phase 0: Compatibility Baseline

Deliver:

- Pi API compatibility matrix.
- Pi TUI component compatibility matrix.
- Official Pi examples certification harness.
- Status taxonomy and reporting format.

Acceptance:

- Every known Pi API and standard TUI component has a status.
- MVP gaps are recorded explicitly.
- Future work can update a measurable matrix.

### Phase 1: Extension Lifecycle Manager

Deliver:

- `ExtensionGraph`.
- `ExtensionScope`.
- `ExtensionRuntimeHost`.
- Real `reloadExtensions()` behavior.
- Runtime diagnostics and failure records.

Acceptance:

- Reload removes old hooks, tools, renderers, and widget targets.
- Extension load failure does not block other extensions.
- Multi-pane and headless/live behavior are deterministic.
- Dispose and stale-event tests pass.

### Phase 2: Pi Compatibility Core

Deliver:

- API version.
- Pi API contract tests.
- Unsupported/inert API warning system.
- Upstream sync workflow.

Acceptance:

- Official examples can run as compatibility tests.
- API drift is detected in CI.
- Developers do not see silent no-op compatibility failures.

### Phase 3: Semantic UI Host

Deliver:

- Adapter registry.
- Widget schema version.
- Typed widget event schema.
- Focus model.
- Update scheduler.
- Mount/update/unmount/dispose lifecycle.

Acceptance:

- Standard components no longer depend on private-field reflection.
- Each adapter has snapshot and dispatch tests.
- Custom UI lifecycle races have deterministic behavior.

### Phase 4: Mature Crest GUI Backend

Deliver:

- Mature controls for Input, SelectList, SettingsList, Confirm, and Editor.
- Mature renderers for Markdown, RichTable, DiffView, Chart, Image, Loader, and layout nodes.
- Keyboard, focus, IME, clipboard, and accessibility behavior.

Acceptance:

- Every standard interactive component has DOM interaction tests.
- Keyboard-only operation works.
- Pi callbacks observe behavior-equivalent results.

### Phase 5: Terminal Surface Backend

Deliver:

- `TerminalWidgetSurface`.
- ANSI rendering.
- Input translator.
- Resize and cursor support.
- Fallback certification tests.

Acceptance:

- Unknown custom components remain interactive.
- ANSI escape sequences are not shown as raw text.
- Resize and keyboard behavior match Pi TUI expectations closely enough for official examples.

### Phase 6: Developer Productization

Deliver:

- `/extensions` command or GUI panel.
- Enable, disable, reload, and logs.
- Manifest schema.
- Scaffold and examples.
- Developer documentation.

Acceptance:

- Developers can diagnose load, runtime, hook, UI, and compatibility failures without inspecting source code.
- Bad extensions can be disabled without restarting Crest.

## Recommended Milestones

### M1: Baseline and Lifecycle

Includes Phase 0 and Phase 1. This is the first implementation milestone because runtime instability makes all GUI work harder to validate.

### M2: Pi TUI GUI Parity and Official Examples Certification

Includes the Pi API compatibility core, the adapter contract, and mature GUI behavior for standard interactive `pi-tui` components. This milestone is complete only when component-level parity tests and official example certification both pass.

### M3: Terminal Surface Fallback

Includes Phase 5. This is required for unknown or custom components that cannot be represented as standard semantic GUI widgets.

### M4: Developer Experience

Includes Phase 6. This makes the mechanism maintainable and usable by real extension authors.

## Immediate Next Step

Implement M2 next:

- [x] Add behavior-level parity requirements to the component matrix.
- [x] Add official examples certification fixtures and tests.
- [x] Introduce adapter registry and typed widget event dispatch.
- [ ] Implement mature GUI parity for standard interactive components.
- [x] Upgrade showcase scenarios to visible behavior certification.
- [x] Run the M2 verification gate and document remaining typecheck baseline failures.

M1 runtime lifecycle is implemented, so widget-specific GUI behavior can now move forward under M2. Do not prioritize custom terminal fallback until standard component GUI parity is complete.

## M1 Status

Status: implemented

- Compatibility matrices exist for Pi API and Pi TUI components.
- Extension lifecycle host owns graph generation, owner-scoped dispose callbacks, and load diagnostics.
- Reload disposes live extension registrations before reloading, invalidates stale runtimes, and avoids duplicate graph hosts.
- Extension graph diagnostics are available through main, preload, and frontend API types.
- Read-only discovery, persisted replay, and list APIs do not pollute the live extension graph.
- This does not claim full Pi ecosystem compatibility; official examples certification, adapter replacement, mature GUI parity, and terminal fallback remain M2-M5 work.

### M1 Verification Gate: 2026-07-19

Environment:

- Worktree: `/Users/bytedance/Documents/crest/.worktrees/agent-extension-integration`.
- Node: `v22.23.1` via `/Users/bytedance/.nvm/versions/node/v22.23.1/bin`.
- npm/npx: `10.9.8`.

Commands:

- `PATH=/Users/bytedance/.nvm/versions/node/v22.23.1/bin:$PATH npx vitest run emain/agent-ipc.test.ts emain/agent/agent-session-runtime.test.ts emain/agent/extensions/extensions.test.ts emain/agent/harness-factory.test.ts emain/agent/prompt-loader.test.ts emain/agent/skills-loader.test.ts emain/agent/extensions/pi-gui/crest/walker.test.ts frontend/app/store/use-pi-chat.test.tsx frontend/app/term/render/agent-chat-host-api.test.ts frontend/app/term/render/agent-ext-ui.test.tsx frontend/app/term/render/agent-slash-command-routing.test.ts frontend/app/term/render/assistant-ui/runtime-bridge.test.ts`
- `PATH=/Users/bytedance/.nvm/versions/node/v22.23.1/bin:$PATH npx tsc --noEmit -p tsconfig.json`

Results:

- Targeted Node 22 Vitest passed: 12 test files, 234 tests.
- TypeScript gate failed with exit code 2. A branch-local `UsePiChatReturn.extUi` fixture gap found during review was fixed in `runtime-bridge.test.ts`; the remaining failures are repo-wide type drift outside the M1 verification target.

Observed TypeScript failure groups, representative and non-exhaustive:

- Agent session repo mismatch: `_spike.ts` still passes `JsonlSessionRepo` where `SqliteSessionRepo` is required.
- Agent tests drift: change-review `Model<TApi>` generic arity, `SessionTreeEntry.message`, and type-only `AssistantMessageEventStream` value usage.
- Generated/client model drift: `Client` no longer exposes older `oid`, `windowids`, `tosagreed`, or `meta` fields expected by several Electron, modal, onboarding, and `frontend/wave.ts` call sites.
- Git diff/source-control metadata drift: `ViewComponentProps`, `MonacoTypes`, and `"gitdiff:repo"` / `"gitdiff:file"` style metadata are not present in the current exported types.
- AI resolver typing drift: `ResolveResult.error`, `ApiType`, `Capability`, and `ReasoningLevel` expectations are inconsistent with current resolver/model types.
- Renderer test and UI type drift: theme `TermThemeType.id`, topbar writable atom, workspace layout metadata, and missing `agent-sessions-panel` import fail typecheck.
- Preview/mock drift: mock full config, mock wave env atoms, process viewer preview `numthreads`, and `middleEllipsis` export expectations are stale.

## M2 Target: Pi TUI GUI Parity and Certification

Status: partially verified; M2 remains incomplete because planned component certification blockers and repo-wide typecheck failures remain.

M2 raises the bar from runtime maturity to behavior-equivalent GUI support. A standard `pi-tui` interactive extension should run in Crest without source changes and present as native GUI, not as a TUI-shaped debug surface.

M2 runs two tracks in parallel:

- Component parity matrix: every standard `pi-tui` component gets an explicit GUI behavior contract, adapter tests, dispatch tests, DOM interaction tests, and showcase scenario.
- Official examples certification: Pi official examples become repeatable compatibility tests, and any unsupported behavior is recorded as a compatibility report entry instead of being silently accepted.

M2 acceptance:

- `Input`, `SelectList`, `SettingsList`, `Editor`, `Loader`, `CancellableLoader`, `Markdown`, and layout nodes have mature GUI behavior tests.
- Standard component snapshots no longer depend on private-field reflection or `constructor.name` as the primary contract.
- Widget events are typed per component and map to Pi callbacks or state mutations with visible GUI feedback.
- Showcase scenarios display explicit outcomes such as `Selected: <value>`, `Submitted: <value>`, and `Cancelled`.
- A component only counts toward M2 acceptance when its behavior matrix has `certification: "passing"`; `planned` entries remain explicit M2 blockers.
- Official examples run through certification harnesses and produce pass/fail/unsupported reports.
- `custom-component` remains `unsupported` or debug fallback until M3 terminal surface is complete.

M2 non-goals:

- Do not implement marketplace-grade sandboxing or permission prompts.
- Do not claim full Pi ecosystem compatibility until official examples pass and custom fallback is covered by M3.
- Do not prioritize custom terminal fallback over standard component GUI parity.

### M2 Verification Gate: 2026-07-19

Environment:

- Worktree: `/Users/bytedance/Documents/crest/.worktrees/agent-extension-integration`.
- Node: `v22.23.1` via `/Users/bytedance/.nvm/versions/node/v22.23.1/bin`.
- npm/npx: `10.9.8`.

Commands:

- `PATH=/Users/bytedance/.nvm/versions/node/v22.23.1/bin:$PATH npx vitest run emain/agent/extensions/certification/pi-official-examples.test.ts emain/agent/extensions/extensions.test.ts emain/agent/extensions/pi-gui/crest/walker.test.ts frontend/app/term/render/agent-ext-ui.test.tsx`
- `PATH=/Users/bytedance/.nvm/versions/node/v22.23.1/bin:$PATH npx vitest run emain/agent-ipc.test.ts emain/agent/agent-session-runtime.test.ts emain/agent/extensions/extensions.test.ts emain/agent/harness-factory.test.ts emain/agent/prompt-loader.test.ts emain/agent/skills-loader.test.ts emain/agent/extensions/pi-gui/crest/walker.test.ts frontend/app/store/use-pi-chat.test.tsx frontend/app/term/render/agent-chat-host-api.test.ts frontend/app/term/render/agent-ext-ui.test.tsx frontend/app/term/render/agent-slash-command-routing.test.ts frontend/app/term/render/assistant-ui/runtime-bridge.test.ts`
- `PATH=/Users/bytedance/.nvm/versions/node/v22.23.1/bin:$PATH npx tsc --noEmit -p tsconfig.json`

Results:

- M2 targeted Node 22 Vitest passed: 4 test files, 112 tests.
- Expanded M1/M2 regression Node 22 Vitest passed: 12 test files, 257 tests.
- TypeScript gate failed with exit code 2 due to remaining repo-wide type drift. This is not a full-compatibility pass.

Task9 TypeScript path resolution:

- Resolved for the M2 official example fixtures by adding TypeScript `paths` entries that mirror the extension runtime loader's `jiti` aliases for `@earendil-works/pi-tui` and its subpaths.
- The `tsconfig.json` paths are a compile-time alias for extension fixtures and the runtime loader surface only; they are not a general app import contract for frontend or eMain code.
- Source-compatible fixture imports remain unchanged; runtime loading still goes through the existing loader alias.

Remaining baseline TypeScript failure groups, representative and non-exhaustive:

- Agent session repo mismatch: `_spike.ts` still passes `JsonlSessionRepo` where `SqliteSessionRepo` is required.
- Agent tests drift: change-review `Model<TApi>` generic arity, `SessionTreeEntry.message`, and type-only `AssistantMessageEventStream` value usage.
- Generated/client model drift: `Client` no longer exposes older `oid`, `windowids`, `tosagreed`, or `meta` fields expected by several Electron, modal, onboarding, and `frontend/wave.ts` call sites.
- Git diff/source-control metadata drift: `ViewComponentProps`, `MonacoTypes`, and `"gitdiff:repo"` style metadata are not present in the current exported types.
- AI resolver typing drift: `ResolveResult.error`, `ApiType`, `Capability`, and `ReasoningLevel` expectations are inconsistent with current resolver/model types.
- Renderer and UI type drift: right editor LSP support, theme `TermThemeType.id`, topbar writable atom, workspace layout metadata, and missing `agent-sessions-panel` import fail typecheck.
- Preview/mock drift: mock full config, mock wave env atoms, process viewer preview `numthreads`, and `middleEllipsis` export expectations are stale.

Compatibility note:

- The official examples certification harness currently reports unsupported examples when planned component blockers or M3 terminal-surface blockers remain. Passing the targeted tests only verifies the report shape, visible behavior assertions, adapter dispatch coverage, and expanded M1/M2 regression set; it does not certify full Pi ecosystem compatibility.

### Task 7 Verification: 2026-07-20

Status: implementation baseline verified; Task 7 does not make M2 complete because the component matrix still records planned and partial certification requirements.

Environment:

- Worktree: `/Users/bytedance/Documents/crest/.worktrees/agent-extension-integration`.
- Node: `v22.23.1` via `/Users/bytedance/.nvm/versions/node/v22.23.1/bin`.
- Vitest: `v3.2.4`.

Commands:

- Plan command, run verbatim: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx vitest run emain/agent/extensions/pi-gui/crest/walker.test.ts frontend/app/term/render/agent-ext-ui.test.tsx -t "settingslist|editor|loader"`.
- Corrected focused command: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx vitest run emain/agent/extensions/pi-gui/crest/walker.test.ts frontend/app/term/render/agent-ext-ui.test.tsx -t "SettingsList|Editor|Loader|settingslist|editor|loader"`.
- Expanded command: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx vitest run emain/agent/extensions/pi-gui/crest/walker.test.ts frontend/app/term/render/agent-ext-ui.test.tsx`.
- TypeScript command: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npx tsc --noEmit -p tsconfig.json --pretty false`.
- Diff command: `git diff --check`.
- Untracked-file whitespace command, run once per Task 7 path and this document: `git diff --no-index --check -- /dev/null <path>`.

Results:

- The plan command exited `0` but executed no tests: 2 files skipped and all 38 collected tests skipped because the title filter is case-sensitive. It is not counted as a passing gate.
- The corrected focused command passed: 2 files, 7 tests passed, 31 tests skipped.
- The expanded command passed: 2 files, all 38 tests passed.
- The latest TypeScript command exited `2` with 76 diagnostics across 31 files. The two branch-local `agent-ipc.test.ts` spy typing diagnostics were fixed by retaining each spied method's exact `MockInstance` signature.
- The TypeScript failures remain in existing repo-wide groups, including agent test/repository drift, generated Client model drift, source-control metadata, AI resolver types, workspace/UI metadata, and preview/mock fixtures.
- `git diff --check` exited `0` for tracked changes.
- Task 7 files and this document are currently untracked. Their per-file no-index checks produced no whitespace-error output; exit `1` only indicates that each file differs from `/dev/null`.

Remaining Task 7 and M2 blockers:

- SettingsList search, submenu, scrolling, and layout parity remain uncertified; selection, value-change, and activation requirements remain partial.
- Editor cancel is emitted by the GUI but intentionally remains unhandled at the adapter boundary until Pi Editor exposes a supported cancel callback.
- Loader animation cadence still lacks timer-backed behavior tests.
- Repo-wide TypeScript failures prevent a clean repository-level typecheck claim.

### M2.1B UI Lifecycle Closure: 2026-07-20

Status: focused and expanded lifecycle suites pass; this closes the M2.1B UI lifecycle scope but does not mark mature component parity or full M2 complete.

- `AgentSessionRuntime` owns the authoritative `ExtensionUiSnapshot`: `statuses`, `widgets`, `widgetnodes`, `header`, and `footer`.
- A live `session_state` replays the complete owner snapshot. The renderer replaces extension UI state and clears runtime-bound requests instead of merging stale state from a previous owner.
- `/reload` hands recoverable UI and compatible flag values to the replacement owner. Interactive requests and live component targets are terminated or disposed rather than replayed.
- Pending requests terminate with typed reasons `abort`, `reload`, or `dispose`; resolved renderer cancellation remains a normal `undefined` result.
- Session-bound flag lookup and mutation use the canonical path returned by `validateSessionPath()`. Reload restores only values accepted by the newly registered flag type; removed or type-changed flags keep the new graph's defaults.
- Focused Node 22 suite passed: 4 test files, 209 tests.
- Expanded Node 22 suite passed: 13 test files, 298 tests.
- Both suites used the exact commands and file order from `docs/m2.1b-extension-ui-lifecycle-subagent-plan.md` Task 7.
- After the mock typing fix and snapshot retry regression coverage, the focused `agent-ipc.test.ts` run passed: 1 test file, 48 tests.
- The post-fix expanded Node 22 suite passed again: 13 test files, 298 tests.
- The post-fix TypeScript reporting gate exited `2` with 76 diagnostics across 31 files, down from 78 diagnostics across 32 files.
- Task 1-6 files have zero TypeScript diagnostics: `emain/agent/agent-session-runtime.ts`, `emain/agent/agent-session-runtime.test.ts`, `emain/agent/extensions/bridge.ts`, `emain/agent/extensions/extensions.test.ts`, `emain/agent-ipc.ts`, `emain/agent-ipc.test.ts`, `frontend/app/store/use-pi-chat.ts`, and `frontend/app/store/use-pi-chat.test.tsx`.
- Remaining diagnostics belong to the previously documented repo-wide baseline groups outside the M2.1B Task 1-6 file set.

### M2.1A Adapter Closure: 2026-07-20

Status: adapter contract closed; mature component behavior and full M2 certification remain incomplete.

- Every standard vendored component publishes a stable global-symbol kind and a public semantic snapshot.
- Every standard component resolves through a concrete `PiGuiAdapter`; standard serialization no longer uses private fields, method-shape matching, or `constructor.name`.
- Nested `Box` targets are discovered through adapter-owned child enumeration.
- Standard `change`, `submit`, and `select` events cannot reach unmarked lookalikes.
- Unknown custom components retain debug terminal rendering and key input pending M3.
- M2.1C behavior blockers remain recorded in the component matrix.
- Focused suite: 2 files, 165 tests passed.
- Certification and renderer regression: 3 files, 23 tests passed.
- Expanded suite: 14 files, 389 tests passed.
- Source invariants: 1 file, 53 selected tests passed with 31 skipped.
- TypeScript reporting gate: exited `2` with 70 existing diagnostics across 28 files; Task 1-7 changed files produced 0 diagnostics and no new failure group.
- Diff scope: `git diff --check` exited `0`; dirty files remain within the Task 1-7 plan scope; `observation-timeline.tsx` was ignored and not touched.

### Architecture Rebase Verification: 2026-07-20

- Rebasing onto the Runtime/Registry architecture preserves `AgentRuntimeRegistry` as the only live runtime owner; the old `sessionCache` was not restored.
- Runtime disposal is asynchronous and serialized per session path. Idle eviction, reload, shutdown, and pending creation all wait for teardown before replacement.
- Sessionless `/reload` invalidates every cached runtime and hands recoverable UI/compatible flags to the next runtime build.
- Live snapshot replay checks runtime identity before sending, so an old runtime cannot overwrite replacement state after reload.
- Headless shortcut/command execution uses discovery-only extension loading and does not retain lifecycle graph hosts.
- Extension controls refresh on canonical session changes, successful reloads, and the first streaming state after runtime rebuild.
- Flag writes validate declarations/types, serialize per flag, ignore stale-session queues, and converge from authoritative list results.
- Final Node 22 gate passed: 19 test files, 369 tests.
- Changed-scope ESLint passed without warnings, `git diff --check` passed, and changed-scope TypeScript filtering produced no diagnostics.
- Repo-wide TypeScript still exits `2` only in the previously documented baseline groups outside this integration scope.

### Architecture Rebase Verification: 2026-07-20

- Extension ownership now uses `AgentSessionRuntime`, `AgentHarnessHost`, and `AgentRuntimeRegistry`; no parallel session cache was reintroduced.
- Runtime disposal is awaited for idle eviction, explicit invalidation, shutdown, and pending creates. Replacement runtimes wait for prior disposal.
- Session and global reload invalidate affected runtimes, preserve recoverable UI/compatible flags, and keep renderer subscriptions pending for rebuilt owners.
- Live snapshot replay ignores superseded runtimes and degrades extension-entry rendering without dropping the authoritative conversation/UI snapshot.
- Headless command and shortcut discovery does not retain lifecycle graph hosts.
- Extension controls refresh on canonical session changes, successful reloads, and replacement runtime startup. Flag writes validate declarations/types, serialize per flag, and reconcile from authoritative state.
- Final Node 22 Agent/Extension/Workspace gate passed: 19 test files, 364 tests.
- Changed-scope ESLint passed with zero warnings.
- Changed-scope TypeScript diagnostics are empty. Repo-wide TypeScript still exits `2` only for the previously documented baseline groups outside this integration scope.

### M2.1C Behavior Closure: 2026-07-21

Status: standard-component behavior closure verified against automated event/state coverage; M3 terminal fallback remains unfinished.

- Authority boundary is hybrid: the browser owns native DOM editing/undo/clipboard/IME, Pi owns semantic state via authoritative snapshots and acknowledgements, and the certification matrix owns the aggregate behavior gate. These three authorities do not overlap.
- Standard components expose public complete-edit/focus/selection methods; the renderer maps raw DOM UTF-16 offsets to normalized UTF-16 offsets before dispatching, so selection metadata stays consistent across snapshot echoes.
- Adapter registration invariants hold: initial registration is atomic; a failed replacement retains the prior widget; factory/external ownership is rejection-only; the published lifecycle is uniform across components; root invalidation runs in order; dynamic target revision is honored; and child pairing is explicit.
- A standard adapter's `cancel` never falls through to the root `done`; the adapterless terminal fallback path is unchanged and still closes unknown terminal widgets with `done(undefined)`.
- SelectList, SettingsList, Input, Editor, Box, Markdown, Loader, and CancellableLoader each reach behavior closure through their focused tests.
- Editor `cancel` is `not-applicable`: no standard Editor cancel control is rendered and no Editor cancel event is emitted; outer editor-request dismissal is kept separate from the standard Editor component.
- The matrix closure statement is exact: `evaluateM21CBehaviorClosureGate` uses a shared blocker predicate over the standard component matrix and fails if any matrix row is a blocker, independent of forged fixture counts.
- The certification aggregate has exactly five unique fixture ids with fixed statuses, `results.length === 5`, and empty `unsupportedReasons` for passed fixtures; forged `5/3/2/0` aggregates that violate identity/reasons still fail the gate.
- The Input fixture uses complete `change`/`submit` payloads (value plus `selectionstart`/`selectionend`), migrated away from partial payloads; multi-instance behavior targets by stable label rather than latest target kind.
- The generic report contract stays free of `gateStatus` and carries generic `status: failed` for unsupported fixtures; the milestone gate reports `gateStatus: passed` only through the separate evaluator.
- Observed counts (Node v22.23.1):
  - Focused behavior gate: 4 files, 373 tests passed, exit `0`.
  - Certification gate: 2 files, 20 tests passed, exit `0`.
  - Expanded M1/M2 regression gate: 15 files, 601 tests passed, exit `0`.
  - Source/scope invariants (filtered): 2 files, 42 selected tests passed with 182 skipped, exit `0`; `git diff --check` exit `0`; no generated file, package dependency, or M3 terminal implementation changed; both terminal fixtures still contain their terminal node; all pre-existing dirty files remain; no commit created.
- TypeScript reporting gate exited `2` with 73 diagnostics across 31 files, all within the previously documented repo-wide baseline (e.g. `Client`/`WaveObj` drift, `ai-resolver`, preview mocks, gitdiff, themes). Every Task 1-9 implementation/test file produced 0 diagnostics and no new diagnostic group; the only changed files with diagnostics (`emain/agent-ipc.ts`, `frontend/app/term/render/agent-surface.tsx`) are outside Task 1-9 scope and belong to the existing baseline.
- JSDOM evidence boundary: the automated tests cover event wiring and state reconciliation only. They do not cover real browser undo, OS clipboard, IME candidate behavior, grapheme navigation, visual caret, or layout. M3 terminal fallback is NOT marked complete.
